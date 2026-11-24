/**
 * 实时多直播间指标计算与聚合引擎 (Metrics Calculation Engine)
 * 职责：
 * 1. 事件去重 (Deduplication)
 * 2. 多直播间状态维护 (Multi-Room State Registry)
 * 3. 动态流速与滑动窗口计算 (Velocity Calculation)
 * 4. 离线/延迟更新检测 (Timeout & Delayed Update Detection)
 * 5. 全局聚合指标计算 (Cross-Room Aggregates)
 */

function sanitizeText(value) {
    if (typeof value !== 'string') return value || '';
    // 替换 middle dots (U+00B7)，使用普通空格
    return value.replace(/\u00B7/g, ' ').trim();
}

class MetricsCalculator {
    constructor(options = {}) {
        this.heartbeatTimeoutMs = options.heartbeatTimeoutMs || 15000; // 15秒无心跳判定离线
        this.historyWindowSize = options.historyWindowSize || 720; // 保持最多 1 小时 (按 5 秒采样可存 720 点)
        this.processedEventIds = new Set();
        this.maxProcessedCache = options.maxProcessedCache || 5000;
        this.rooms = new Map(); // roomId -> RoomData
    }

    /**
     * 检查事件是否重复 (去重)
     */
    isDuplicateEvent(eventId) {
        if (!eventId) return false;
        if (this.processedEventIds.has(eventId)) {
            return true;
        }
        this.processedEventIds.add(eventId);
        if (this.processedEventIds.size > this.maxProcessedCache) {
            const first = this.processedEventIds.values().next().value;
            this.processedEventIds.delete(first);
        }
        return false;
    }

    /**
     * 获取或创建直播间状态记录
     */
    getOrCreateRoom(roomId, initialShopName = '') {
        const id = String(roomId || 'unknown');
        // 当真正房间ID到来时，清理掉临时占位的 unknown 记录
        if (id !== 'unknown' && this.rooms.has('unknown')) {
            this.rooms.delete('unknown');
        }

        if (!this.rooms.has(id)) {
            const defaultName = (id === 'unknown' || id === 'unknown_room') ? '正在接入大屏...' : `直播间 ${id.slice(-4)}`;
            this.rooms.set(id, {
                roomId: id,
                shopName: sanitizeText(initialShopName) || defaultName,
                liveStatusText: '未开播',
                lastHeartbeatTs: Date.now(),
                latestMetrics: {
                    gmv_amount_yuan: 0,
                    gmv_amount_all_yuan: 0,
                    ad_cost_yuan: 0,
                    gpm_amount_yuan: 0,
                    online_viewers_count: 0,
                    pay_users_count: 0,
                    pay_combo_orders_count: 0,
                    avg_watch_duration_seconds: 0,
                    watch_to_pay_ratio: 0,
                    product_click_to_pay_ratio: 0
                },
                explainingProduct: null,
                recentComments: [],
                metricHistory: [], // [{ timestamp, gmv_amount_yuan, online_viewers_count }]
                velocity: {
                    gmv_per_minute_yuan: 0,
                    orders_per_minute_count: 0
                }
            });
        }
        return this.rooms.get(id);
    }

    /**
     * 处理哨兵心跳包
     */
    handleHeartbeat(heartbeat) {
        if (!heartbeat || !heartbeat.roomId) return null;
        const room = this.getOrCreateRoom(heartbeat.roomId, heartbeat.shopName);
        room.isOnline = true;
        room.lastHeartbeatTs = Date.now();
        if (heartbeat.shopName) {
            room.shopName = sanitizeText(heartbeat.shopName);
        }
        return room;
    }

    /**
     * 处理业务事件 (核心指标、基础信息、商品等)
     */
    handleEvent(event) {
        if (!event) return null;
        if (event.eventId && this.isDuplicateEvent(event.eventId)) {
            return { skipped: true, reason: 'duplicate event' };
        }

        const roomId = event.roomId || 'unknown_room';
        const room = this.getOrCreateRoom(roomId, event.shopName);
        room.isOnline = true;
        room.lastHeartbeatTs = Date.now();

        if (event.shopName) {
            room.shopName = sanitizeText(event.shopName);
        }

        switch (event.eventType) {
            case 'ROOM_BASE_INFO':
                this._applyBaseInfo(room, event);
                break;
            case 'CORE_METRICS':
                this._applyCoreMetrics(room, event);
                break;
            case 'EXPLAINING_PRODUCT':
                this._applyProductExplain(room, event);
                break;
            case 'LIVE_COMMENTS':
                this._applyComments(room, event);
                break;
            default:
                // 通用指标填充
                if (event.metrics && typeof event.metrics === 'object') {
                    Object.assign(room.latestMetrics, event.metrics);
                }
                break;
        }

        return room;
    }

    _applyBaseInfo(room, event) {
        if (event.liveStatusText) {
            room.liveStatusText = sanitizeText(event.liveStatusText);
        } else if (event.liveStatus !== undefined) {
            room.liveStatusText = event.liveStatus === 2 ? '正在直播' : '未开播';
        }
        if (event.shopName) room.shopName = sanitizeText(event.shopName);
        if (event.avatarUri) room.avatarUri = event.avatarUri;
        if (event.liveStartTime) room.liveStartTime = event.liveStartTime;
    }

    _applyCoreMetrics(room, event) {
        // 更新当前各项指标 (单位明确)
        room.latestMetrics.gmv_amount_yuan = Number(event.gmv_amount_yuan ?? room.latestMetrics.gmv_amount_yuan);
        room.latestMetrics.gmv_amount_all_yuan = Number(event.gmv_amount_all_yuan ?? room.latestMetrics.gmv_amount_all_yuan);
        room.latestMetrics.ad_cost_yuan = Number(event.ad_cost_yuan ?? room.latestMetrics.ad_cost_yuan);
        room.latestMetrics.gpm_amount_yuan = Number(event.gpm_amount_yuan ?? room.latestMetrics.gpm_amount_yuan);
        room.latestMetrics.online_viewers_count = Number(event.online_viewers_count ?? room.latestMetrics.online_viewers_count);
        room.latestMetrics.pay_users_count = Number(event.pay_users_count ?? room.latestMetrics.pay_users_count);
        room.latestMetrics.pay_combo_orders_count = Number(event.pay_combo_orders_count ?? room.latestMetrics.pay_combo_orders_count);
        room.latestMetrics.avg_watch_duration_seconds = Number(event.avg_watch_duration_seconds ?? room.latestMetrics.avg_watch_duration_seconds);
        room.latestMetrics.watch_to_pay_ratio = Number(event.watch_to_pay_ratio ?? room.latestMetrics.watch_to_pay_ratio);
        room.latestMetrics.product_click_to_pay_ratio = Number(event.product_click_to_pay_ratio ?? room.latestMetrics.product_click_to_pay_ratio);

        // 追加历史采样点并维护窗口大小 (记录 GPM 与 观看-成交率)
        const now = Date.now();
        const dateObj = new Date(now);
        const timeDisplay = `${String(dateObj.getHours()).padStart(2, '0')}:${String(dateObj.getMinutes()).padStart(2, '0')}`;

        room.metricHistory.push({
            timestamp: now,
            timeDisplay: timeDisplay,
            gmv_amount_yuan: room.latestMetrics.gmv_amount_yuan,
            gpm_amount_yuan: room.latestMetrics.gpm_amount_yuan,
            watch_to_pay_ratio_percent: Number((room.latestMetrics.watch_to_pay_ratio * 100).toFixed(2)),
            online_viewers_count: room.latestMetrics.online_viewers_count,
            pay_combo_orders_count: room.latestMetrics.pay_combo_orders_count
        });

        if (room.metricHistory.length > this.historyWindowSize) {
            room.metricHistory.shift();
        }

        // 计算流速 (GMV/分, 订单/分)
        this._calculateVelocity(room);
    }

    _calculateVelocity(room) {
        const hist = room.metricHistory;
        if (hist.length < 2) {
            room.velocity.gmv_per_minute_yuan = 0;
            room.velocity.orders_per_minute_count = 0;
            return;
        }

        const newest = hist[hist.length - 1];
        const oldest = hist[0];
        const timeDiffMinutes = (newest.timestamp - oldest.timestamp) / 60000;

        if (timeDiffMinutes > 0.05) { // 至少间隔 3 秒以上计算有效流速
            const gmvDiff = Math.max(0, newest.gmv_amount_yuan - oldest.gmv_amount_yuan);
            const orderDiff = Math.max(0, newest.pay_combo_orders_count - oldest.pay_combo_orders_count);
            room.velocity.gmv_per_minute_yuan = Number((gmvDiff / timeDiffMinutes).toFixed(2));
            room.velocity.orders_per_minute_count = Number((orderDiff / timeDiffMinutes).toFixed(1));
        }
    }

    _applyProductExplain(room, event) {
        room.explainingProduct = {
            productId: String(event.productId || ''),
            productName: sanitizeText(event.productName || ''),
            productImg: event.productImg || '',
            isExplaining: Boolean(event.isExplaining),
            product_pay_amount_yuan: Number(event.product_pay_amount_yuan || 0),
            product_pay_orders_count: Number(event.product_pay_orders_count || 0),
            product_stock_count: Number(event.product_stock_count || 0),
            recentFiveMinClickCount: Number(event.recentFiveMinClickCount || 0),
            clickTrend: Array.isArray(event.clickTrend) ? event.clickTrend : []
        };
    }

    _applyComments(room, event) {
        if (Array.isArray(event.comments) && event.comments.length > 0) {
            const sanitizedComments = event.comments.map(c => ({
                commentId: c.commentId,
                userNickname: sanitizeText(c.userNickname),
                content: sanitizeText(c.content),
                timestampMs: c.timestampMs
            }));
            room.recentComments.unshift(...sanitizedComments);
            if (room.recentComments.length > 50) {
                room.recentComments = room.recentComments.slice(0, 50);
            }
        }
    }

    /**
     * 周期性检测房间在线状态与延迟更新
     */
    checkTimeouts(currentTime = Date.now()) {
        for (const [id, room] of this.rooms.entries()) {
            const timeSinceLastHeartbeat = currentTime - room.lastHeartbeatTs;
            if (timeSinceLastHeartbeat > this.heartbeatTimeoutMs) {
                room.isOnline = false;
                room.liveStatusText = '离线 未连接';
            }
        }
    }

    /**
     * 获得全大盘汇总聚合指标及各房间列表
     */
    getDashboardSnapshot() {
        this.checkTimeouts();

        const roomList = Array.from(this.rooms.values());
        let totalGmv = 0;
        let totalViewers = 0;
        let totalOrders = 0;
        let totalAdCost = 0;
        let activeRoomCount = 0;

        for (const room of roomList) {
            if (room.isOnline) {
                activeRoomCount++;
            }
            totalGmv += room.latestMetrics.gmv_amount_yuan;
            totalViewers += room.latestMetrics.online_viewers_count;
            totalOrders += room.latestMetrics.pay_combo_orders_count;
            totalAdCost += room.latestMetrics.ad_cost_yuan;
        }

        return {
            summary: {
                total_rooms_count: roomList.length,
                active_rooms_count: activeRoomCount,
                total_gmv_amount_yuan: Number(totalGmv.toFixed(2)),
                total_online_viewers_count: totalViewers,
                total_pay_orders_count: totalOrders,
                total_ad_cost_yuan: Number(totalAdCost.toFixed(2)),
                timestampIso: new Date().toISOString()
            },
            rooms: roomList
        };
    }
}

module.exports = {
    MetricsCalculator,
    sanitizeText
};
