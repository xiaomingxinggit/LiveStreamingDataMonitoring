/**
 * 本地数据持久化与导出模块 (Storage & Export Store)
 * 职责：
 * 1. 保存多房间快照与事件历史
 * 2. 导出 CSV 汇总报告与事件明细 (遵循无 middle dot 规范)
 */

const fs = require('fs');
const path = require('path');

class LocalStore {
    constructor(dataDir) {
        this.dataDir = dataDir || path.resolve(__dirname, '../../data');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        this.eventsLogFile = path.join(this.dataDir, 'stream_events.jsonl');
        this.snapshotsFile = path.join(this.dataDir, 'room_snapshots.json');
    }

    /**
     * 保存单条/批量事件到 JSONL 日志文件
     */
    appendEvents(events) {
        if (!events || events.length === 0) return;
        const list = Array.isArray(events) ? events : [events];
        const lines = list.map(e => JSON.stringify(e)).join('\n') + '\n';
        fs.appendFile(this.eventsLogFile, lines, 'utf8', (err) => {
            if (err) console.error('[LocalStore] 写入事件日志失败:', err);
        });
    }

    /**
     * 保存最新多房间大盘快照
     */
    saveSnapshot(snapshot) {
        const tempFile = `${this.snapshotsFile}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2), 'utf8');
            fs.renameSync(tempFile, this.snapshotsFile);
        } catch (err) {
            console.error('[LocalStore] 保存快照失败:', err);
            try {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            } catch {}
        }
    }

    /**
     * 读取最新保存的大盘快照
     */
    loadLatestSnapshot() {
        if (!fs.existsSync(this.snapshotsFile)) return null;
        try {
            const raw = fs.readFileSync(this.snapshotsFile, 'utf8');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /**
     * 首次升级没有快照时，从事件日志尾部恢复近期状态。
     */
    loadRecentEvents(maxBytes = 64 * 1024 * 1024) {
        if (!fs.existsSync(this.eventsLogFile)) return [];
        let fileHandle;
        try {
            const size = fs.statSync(this.eventsLogFile).size;
            const start = Math.max(0, size - maxBytes);
            const length = size - start;
            const buffer = Buffer.alloc(length);
            fileHandle = fs.openSync(this.eventsLogFile, 'r');
            fs.readSync(fileHandle, buffer, 0, length, start);
            let raw = buffer.toString('utf8');
            if (start > 0) {
                const firstLineEnd = raw.indexOf('\n');
                raw = firstLineEnd >= 0 ? raw.slice(firstLineEnd + 1) : '';
            }
            const events = [];
            for (const line of raw.split(/\r?\n/)) {
                if (!line.trim()) continue;
                try {
                    events.push(JSON.parse(line));
                } catch {}
            }
            return events;
        } catch (err) {
            console.error('[LocalStore] 读取事件日志失败:', err);
            return [];
        } finally {
            if (fileHandle !== undefined) fs.closeSync(fileHandle);
        }
    }

    /**
     * 导出多房间汇总报表为标准 CSV 格式
     */
    exportRoomsToCsv(rooms) {
        const headers = [
            '房间ID',
            '店铺名称',
            '直播状态',
            '是否在线',
            'GMV金额(元)',
            '在线人数',
            '成交人数',
            '成交件数',
            '投放消耗(元)',
            'GPM(元)',
            '人均观看时长(秒)',
            '当前讲解商品',
            '商品讲解销售额(元)',
            '商品剩余库存'
        ];

        const rows = rooms.map(room => {
            const m = room.latestMetrics || {};
            const p = room.explainingProduct || {};
            return [
                `"${room.roomId}"`,
                `"${(room.shopName || '').replace(/"/g, '""')}"`,
                `"${room.liveStatusText || ''}"`,
                room.isOnline ? '在线' : '离线',
                m.gmv_amount_yuan || 0,
                m.online_viewers_count || 0,
                m.pay_users_count || 0,
                m.pay_combo_orders_count || 0,
                m.ad_cost_yuan || 0,
                m.gpm_amount_yuan || 0,
                m.avg_watch_duration_seconds || 0,
                `"${(p.productName || '').replace(/"/g, '""')}"`,
                p.product_pay_amount_yuan || 0,
                p.product_stock_count || 0
            ].join(',');
        });

        // 统一使用 UTF-8 BOM 以兼容 Excel 中文显示
        const bom = '\uFEFF';
        return bom + [headers.join(','), ...rows].join('\r\n');
    }
}

module.exports = {
    LocalStore
};
