/**
 * 数据采集接收服务 (Collector Server)
 * 职责：
 * 1. 监听本地 127.0.0.1:28888 端口
 * 2. 接收来自多个油猴哨兵的 events 与 heartbeat
 * 3. 驱动计算引擎与本地存储
 * 4. 提供 SSE (Server-Sent Events) 实时推送大屏数据
 * 5. 托管弹性大屏 Web UI 页面
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { MetricsCalculator } = require('../calculator/engine');
const { LocalStore } = require('../storage/store');

class CollectorServer {
    constructor(options = {}) {
        this.port = options.port ?? 28888;
        this.host = options.host || '127.0.0.1';
        this.calculator = options.calculator || new MetricsCalculator();
        this.store = options.store || new LocalStore(options.dataDir);
        this.serverInstanceId = options.serverInstanceId || randomUUID();
        this.server = null;
        this.sseClients = new Set();
        this.broadcastInterval = null;
        this.refreshRequest = {
            id: '',
            requestedAtIso: '',
            targetRoomIds: new Set(),
            acknowledgedRoomIds: new Set()
        };
        this._restoreLatestSnapshot();
    }

    _getRefreshRequestStatus() {
        const request = this.refreshRequest;
        const requestedRoomCount = request.targetRoomIds.size;
        const acknowledgedRoomCount = request.acknowledgedRoomIds.size;
        return {
            status: !request.id ? 'idle' :
                (acknowledgedRoomCount >= requestedRoomCount ? 'complete' : 'pending'),
            refreshRequestId: request.id,
            requestedAtIso: request.requestedAtIso,
            requestedRoomCount,
            acknowledgedRoomCount,
            pendingRoomCount: Math.max(0, requestedRoomCount - acknowledgedRoomCount)
        };
    }

    _buildPersistenceSnapshot() {
        return {
            schemaVersion: 1,
            savedAtIso: new Date().toISOString(),
            rooms: Array.from(this.calculator.rooms.values())
        };
    }

    _saveSnapshot() {
        if (typeof this.store.saveSnapshot === 'function') {
            this.store.saveSnapshot(this._buildPersistenceSnapshot());
        }
    }

    _restoreLatestSnapshot() {
        if (typeof this.store.loadLatestSnapshot !== 'function') return;
        const snapshot = this.store.loadLatestSnapshot();
        if (snapshot && Array.isArray(snapshot.rooms)) {
            this.calculator.restoreRooms(snapshot.rooms);
            return;
        }

        if (typeof this.store.loadRecentEvents === 'function') {
            const events = this.store.loadRecentEvents();
            const eventTimes = events
                .map(event => Date.parse(event?.timestampIso || ''))
                .filter(Number.isFinite);
            const latestEventTime = eventTimes.reduce((latest, eventTime) => Math.max(latest, eventTime), 0);
            const recoveryCutoff = latestEventTime - 12 * 60 * 60 * 1000;
            const recoverableEvents = latestEventTime > 0 ? events.filter(event => {
                const eventTime = Date.parse(event?.timestampIso || '');
                return Number.isFinite(eventTime) && eventTime >= recoveryCutoff;
            }) : events;
            for (const event of recoverableEvents) {
                this.calculator.handleEvent(event);
            }
            if (recoverableEvents.length > 0) {
                for (const room of this.calculator.rooms.values()) {
                    room.isOnline = false;
                    room.lastHeartbeatTs = 0;
                }
                this._saveSnapshot();
            }
        }
    }

    start(callback) {
        this.server = http.createServer((req, res) => {
            this._handleRequest(req, res);
        });

        // 定时向所有 SSE 客户端广播最新快照
        this.broadcastInterval = setInterval(() => {
            this.broadcastSnapshot();
        }, 1000);

        this.server.listen(this.port, this.host, () => {
            const address = this.server.address();
            const actualPort = address?.port ?? this.port;
            console.log(`[CollectorServer] 本地总控服务已启动: http://${this.host}:${actualPort}`);
            if (callback) callback(null, { host: this.host, port: actualPort });
        });

        this.server.on('error', (err) => {
            console.error('[CollectorServer] 启动失败:', err);
            if (callback) callback(err);
        });
    }

    stop(callback) {
        this._saveSnapshot();
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
            this.broadcastInterval = null;
        }
        for (const client of this.sseClients) {
            try { client.end(); } catch {}
        }
        this.sseClients.clear();

        if (this.server) {
            this.server.close(callback);
        } else if (callback) {
            callback();
        }
    }

    broadcastSnapshot() {
        if (this.sseClients.size === 0) return;
        const snapshot = this.calculator.getDashboardSnapshot();
        const data = `data: ${JSON.stringify(snapshot)}\n\n`;
        for (const client of this.sseClients) {
            try {
                client.write(data);
            } catch {
                this.sseClients.delete(client);
            }
        }
    }

    _handleRequest(req, res) {
        // 设置跨域头 (允许油猴脚本和本地前端任意访问)
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        const pathname = url.pathname;

        // 路由分发
        if (req.method === 'POST' && pathname === '/api/stream/events') {
            this._handleEvents(req, res);
        } else if (req.method === 'POST' && pathname === '/api/sentinel/heartbeat') {
            this._handleHeartbeat(req, res);
        } else if (req.method === 'POST' && pathname === '/api/control/refresh') {
            this._handleRefreshRequest(req, res);
        } else if (req.method === 'GET' && pathname === '/api/control/refresh') {
            this._handleGetRefreshRequest(req, res);
        } else if (req.method === 'GET' && pathname === '/api/rooms') {
            this._handleGetRooms(req, res);
        } else if (req.method === 'GET' && pathname === '/api/stream/subscribe') {
            this._handleSseSubscribe(req, res);
        } else if (req.method === 'GET' && pathname === '/api/export/csv') {
            this._handleExportCsv(req, res);
        } else if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
            this._serveDashboardHtml(req, res);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Endpoint not found' }));
        }
    }

    _readJsonBody(req, callback) {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 5 * 1024 * 1024) { // 5MB 保护限制
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body || '{}');
                callback(null, parsed);
            } catch (err) {
                callback(err);
            }
        });
    }

    _handleEvents(req, res) {
        this._readJsonBody(req, (err, payload) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
                return;
            }

            const events = Array.isArray(payload.events) ? payload.events : (payload ? [payload] : []);
            let appliedCount = 0;

            for (const event of events) {
                const result = this.calculator.handleEvent(event);
                if (result && !result.skipped) {
                    appliedCount++;
                }
            }

            // 写入本地持久化
            if (events.length > 0) {
                this.store.appendEvents(events);
            }
            if (appliedCount > 0) {
                this._saveSnapshot();
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', received: events.length, applied: appliedCount }));

            // 立即向大屏推流
            this.broadcastSnapshot();
        });
    }

    _handleHeartbeat(req, res) {
        this._readJsonBody(req, (err, heartbeat) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid heartbeat JSON' }));
                return;
            }

            const existingRoom = heartbeat?.roomId ? this.calculator.rooms.get(String(heartbeat.roomId)) : null;
            const previousShopName = existingRoom?.shopName;
            this.calculator.handleHeartbeat(heartbeat);
            const heartbeatRoomId = heartbeat?.roomId ? String(heartbeat.roomId) : '';
            const refreshAcknowledged = heartbeat?.refreshRequestAckId &&
                heartbeat.refreshRequestAckId === this.refreshRequest.id &&
                this.refreshRequest.targetRoomIds.has(heartbeatRoomId);
            if (refreshAcknowledged) {
                this.refreshRequest.acknowledgedRoomIds.add(heartbeatRoomId);
            }
            if (!existingRoom || (heartbeat?.shopName && heartbeat.shopName !== previousShopName)) {
                this._saveSnapshot();
            }

            const refreshRequestId = this.refreshRequest.targetRoomIds.has(heartbeatRoomId) &&
                !this.refreshRequest.acknowledgedRoomIds.has(heartbeatRoomId) ? this.refreshRequest.id : '';

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                serverInstanceId: this.serverInstanceId,
                refreshRequestId,
                serverTimeIso: new Date().toISOString(),
                activeRoomsCount: this.calculator.rooms.size
            }));

            this.broadcastSnapshot();
        });
    }

    _handleRefreshRequest(req, res) {
        this._readJsonBody(req, (err) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid refresh JSON' }));
                return;
            }

            this.calculator.checkTimeouts();
            const targetRoomIds = new Set(Array.from(this.calculator.rooms.values())
                .filter(room => room.isOnline)
                .map(room => String(room.roomId)));
            this.refreshRequest = {
                id: randomUUID(),
                requestedAtIso: new Date().toISOString(),
                targetRoomIds,
                acknowledgedRoomIds: new Set()
            };

            res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(this._getRefreshRequestStatus()));
        });
    }

    _handleGetRefreshRequest(req, res) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(this._getRefreshRequestStatus()));
    }

    _handleGetRooms(req, res) {
        const snapshot = this.calculator.getDashboardSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(snapshot));
    }

    _handleSseSubscribe(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // 首次连接推送当前快照
        const snapshot = this.calculator.getDashboardSnapshot();
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

        this.sseClients.add(res);

        req.on('close', () => {
            this.sseClients.delete(res);
        });
    }

    _handleExportCsv(req, res) {
        const snapshot = this.calculator.getDashboardSnapshot();
        const csvContent = this.store.exportRoomsToCsv(snapshot.rooms);
        const fileName = `douyin_live_monitoring_${Date.now()}.csv`;

        res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${fileName}"`
        });
        res.end(csvContent);
    }

    _serveDashboardHtml(req, res) {
        const htmlPath = path.resolve(__dirname, '../presentation/renderer/index.html');
        if (fs.existsSync(htmlPath)) {
            const html = fs.readFileSync(htmlPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>LiveStreamingDataMonitoring 本地服务运行中</h1><p>UI 模板载入中...</p>');
        }
    }
}

module.exports = {
    CollectorServer
};
