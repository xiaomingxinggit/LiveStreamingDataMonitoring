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
const { MetricsCalculator } = require('../calculator/engine');
const { LocalStore } = require('../storage/store');

class CollectorServer {
    constructor(options = {}) {
        this.port = options.port || 28888;
        this.host = options.host || '127.0.0.1';
        this.calculator = options.calculator || new MetricsCalculator();
        this.store = options.store || new LocalStore(options.dataDir);
        this.server = null;
        this.sseClients = new Set();
        this.broadcastInterval = null;
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
            console.log(`[CollectorServer] 本地总控服务已启动: http://${this.host}:${this.port}`);
            if (callback) callback(null, { host: this.host, port: this.port });
        });

        this.server.on('error', (err) => {
            console.error('[CollectorServer] 启动失败:', err);
            if (callback) callback(err);
        });
    }

    stop(callback) {
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
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

            this.calculator.handleHeartbeat(heartbeat);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                serverTimeIso: new Date().toISOString(),
                activeRoomsCount: this.calculator.rooms.size
            }));

            this.broadcastSnapshot();
        });
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
