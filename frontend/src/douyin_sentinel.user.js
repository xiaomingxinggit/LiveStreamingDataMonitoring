// ==UserScript==
// @name         抖音电商罗盘大屏数据监控哨兵 (Douyin Live Sentinel)
// @namespace    https://github.com/livestreaming-monitoring/sentinel
// @version      1.1.0
// @description  实时监听拦截抖音电商罗盘大屏数据（基础信息、核心指标、讲解商品、弹幕互动），清洗后安全回传本地总控客户端
// @author       LiveStreamingDataMonitoring
// @match        https://compass.jinritemai.com/screen/*
// @match        https://compass.jinritemai.com/shop/live/*
// @match        https://compass.jinritemai.com/*
// @match        https://buyin.jinritemai.com/dashboard/*
// @match        https://buyin.jinritemai.com/screen/*
// @match        https://live.douyin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // 1. 系统配置与运行时状态
    // =========================================================================
    const CONFIG = {
        backendUrl: GM_getValue('backend_url', 'http://127.0.0.1:28888'),
        batchIntervalMs: 1000,
        heartbeatIntervalMs: 5000,
        maxQueueSize: 500,
        debug: true
    };

    const state = {
        connected: false,
        roomId: '',
        shopName: '',
        capturedCount: 0,
        sentCount: 0,
        pendingQueue: [],
        lastHeartbeatTs: 0
    };

    function log(...args) {
        if (CONFIG.debug) {
            console.log('[Sentinel 哨兵]', ...args);
        }
    }

    // =========================================================================
    // 2. 数据清洗与规范化工具 (清洗 U+00B7 中圆点，统一单位)
    // =========================================================================
    function sanitizeText(value) {
        if (typeof value !== 'string') return value || '';
        // 按照仓库规范：使用普通空格作为分隔符，替换 middle dots (U+00B7)
        return value.replace(/\u00B7/g, ' ').trim();
    }

    function parsePriceCentsToYuan(centsVal) {
        if (typeof centsVal !== 'number') {
            centsVal = Number(centsVal) || 0;
        }
        return Number((centsVal / 100).toFixed(2));
    }

    function extractRoomId(url, data) {
        if (data && (data.room_id || data.roomId)) {
            return String(data.room_id || data.roomId);
        }
        if (url && typeof url === 'string') {
            const match = url.match(/[?&](?:room_id|live_room_id|roomId)=([0-9]+)/i) || url.match(/\/([0-9]{15,22})/);
            if (match && match[1]) return match[1];
        }
        return '';
    }

    // =========================================================================
    // 3. 抖音电商罗盘专属协议解析器
    // =========================================================================
    const CompassParser = {
        // 3.1 基础信息解析
        parseLiveBaseInfo: function (url, json) {
            const data = json.data;
            if (!data) return null;

            const roomId = extractRoomId(url, data);
            if (roomId) state.roomId = roomId;
            const shopName = sanitizeText(data.nickname || '');
            if (shopName) state.shopName = shopName;

            return {
                eventType: 'ROOM_BASE_INFO',
                roomId: roomId,
                shopName: shopName,
                appPlatform: sanitizeText(data.app_platform || '抖音'),
                isEcomRoom: Boolean(data.is_ecom_room),
                liveStartTime: data.live_start_time || '',
                liveStartTs: Number(data.live_start_ts || 0),
                liveStatus: Number(data.live_status || 0),
                liveStatusText: data.live_status === 2 ? '正在直播' : '未开播',
                avatarUri: data.avatar_uri || '',
                serverCurTime: data.server_cur_time || ''
            };
        },

        // 3.2 核心大盘指标解析 (GMV、流速、人货场转化率)
        parseCoreData: function (url, json) {
            const data = json.data;
            if (!data) return null;

            const items = Array.isArray(data.core_data) ? data.core_data : [];
            const findItem = (name) => items.find(item => item.index_name === name);
            const getNum = (name) => {
                const item = findItem(name);
                return item && item.value && typeof item.value.value === 'number' ? item.value.value : 0;
            };

            // GMV 优先从顶层 pay_amt 读取，以分为单位转元
            const totalPayCents = data.pay_amt?.value ?? getNum('pay_amt');
            const totalPayAllCents = data.pay_amt_all?.value ?? totalPayCents;
            const statCostCents = getNum('stat_cost');
            const gpmCents = getNum('gpm');

            return {
                eventType: 'CORE_METRICS',
                roomId: state.roomId,
                shopName: state.shopName,
                // 金额明确单位为 yuan (元)
                gmv_amount_yuan: parsePriceCentsToYuan(totalPayCents),
                gmv_amount_all_yuan: parsePriceCentsToYuan(totalPayAllCents),
                ad_cost_yuan: parsePriceCentsToYuan(statCostCents),
                gpm_amount_yuan: parsePriceCentsToYuan(gpmCents),
                // 人数、件数与流速
                online_viewers_count: getNum('current_cnt'),
                pay_users_count: getNum('pay_ucnt'),
                pay_combo_orders_count: getNum('pay_combo_cnt'),
                // 转化率与人均停留
                watch_to_pay_ratio: Number(getNum('watch_pay_ucnt_ratio').toFixed(6)),
                product_click_to_pay_ratio: Number(getNum('product_click_pay_ucnt_ratio').toFixed(6)),
                exposure_to_watch_ratio: Number(getNum('watch_cnt_show_ratio').toFixed(6)),
                avg_watch_duration_seconds: Math.round(getNum('avg_watch_duration'))
            };
        },

        // 3.3 正在讲解商品详情解析
        parseProductExplainDetail: function (url, json) {
            const data = json.data;
            if (!data) return null;

            const payCents = data.pay_amt?.value || 0;
            const clickTrend = Array.isArray(data.click_data?.trend) ? data.click_data.trend.map(point => ({
                timeDisplay: point.horizontal || '',
                timestamp: point.date_time || 0,
                clickCount: point.vertical || 0
            })) : [];

            return {
                eventType: 'EXPLAINING_PRODUCT',
                roomId: state.roomId,
                productId: String(data.product_id || ''),
                productName: sanitizeText(data.product_name || ''),
                productImg: data.product_img || '',
                isExplaining: Boolean(data.explaining),
                product_pay_amount_yuan: parsePriceCentsToYuan(payCents),
                product_pay_orders_count: Number(data.pay_combo_cnt?.value || 0),
                product_stock_count: Number(data.stock_cnt?.value || 0),
                recentFiveMinClickCount: Number(data.click_data?.product_click_cnt?.value || 0),
                clickTrend: clickTrend
            };
        },

        // 3.4 实时公屏弹幕解析
        parseComments: function (url, json) {
            const data = json.data;
            if (!data || !Array.isArray(data.comments) || data.comments.length === 0) return null;

            const comments = data.comments.map(c => ({
                commentId: String(c.id || c.cid || ''),
                userNickname: sanitizeText(c.user?.nickname || c.nickname || '神秘观众'),
                content: sanitizeText(c.content || c.text || ''),
                timestampMs: Number(c.create_time || Date.now())
            }));

            return {
                eventType: 'LIVE_COMMENTS',
                roomId: state.roomId,
                comments: comments
            };
        },

        // 3.5 弹幕聚类关键词解析
        parseCommentCluster: function (url, json) {
            const data = json.data;
            if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;

            const clusters = data.items.map(item => ({
                keyword: sanitizeText(item.keyword || item.word || ''),
                count: Number(item.count || 0),
                ratio: Number(item.ratio || 0)
            }));

            return {
                eventType: 'COMMENT_CLUSTER',
                roomId: state.roomId,
                clusters: clusters
            };
        }
    };

    // =========================================================================
    // 4. 统一路由与报文分发中心
    // =========================================================================
    function processApiResponse(url, rawText, channel) {
        if (!rawText || typeof rawText !== 'string') return;

        let json;
        try {
            json = JSON.parse(rawText);
        } catch (e) {
            return;
        }

        let parsedPayload = null;

        // 根据 URL 匹配罗盘对应的解析器
        if (url.includes('/live_screen/live_base_info')) {
            parsedPayload = CompassParser.parseLiveBaseInfo(url, json);
        } else if (url.includes('/live_screen/core_data')) {
            parsedPayload = CompassParser.parseCoreData(url, json);
        } else if (url.includes('/live_screen/product_explain_detail')) {
            parsedPayload = CompassParser.parseProductExplainDetail(url, json);
        } else if (url.includes('/live_screen/professional/comment')) {
            parsedPayload = CompassParser.parseComments(url, json);
        } else if (url.includes('/live_screen/comment_cluster')) {
            parsedPayload = CompassParser.parseCommentCluster(url, json);
        }

        if (parsedPayload) {
            const envelope = {
                eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                timestampIso: new Date().toISOString(),
                sourceChannel: channel,
                pageUrl: window.location.href,
                ...parsedPayload
            };
            enqueueEvent(envelope);
        }
    }

    // =========================================================================
    // 5. 消息队列与本地回传传输层 (GM_xmlhttpRequest)
    // =========================================================================
    function enqueueEvent(event) {
        state.capturedCount++;
        state.pendingQueue.push(event);

        if (state.pendingQueue.length > CONFIG.maxQueueSize) {
            state.pendingQueue.shift(); // 丢弃过久事件，防内存泄漏
        }
        updateHud();
    }

    function sendToBackend(endpoint, data, onSuccess, onError) {
        if (typeof GM_xmlhttpRequest !== 'function') {
            console.error('[Sentinel 哨兵] 错误: GM_xmlhttpRequest 不可用，请检查油猴权限');
            return;
        }

        GM_xmlhttpRequest({
            method: 'POST',
            url: `${CONFIG.backendUrl}${endpoint}`,
            headers: {
                'Content-Type': 'application/json'
            },
            data: JSON.stringify(data),
            timeout: 4000,
            onload: function (res) {
                if (res.status >= 200 && res.status < 300) {
                    if (onSuccess) onSuccess(res.responseText);
                } else {
                    if (onError) onError(new Error(`Server error: HTTP ${res.status}`));
                }
            },
            onerror: function (err) {
                if (onError) onError(err);
            },
            ontimeout: function () {
                if (onError) onError(new Error('Request timed out'));
            }
        });
    }

    // 定时批量上报队列
    setInterval(() => {
        if (state.pendingQueue.length === 0) return;

        const batch = state.pendingQueue.splice(0, 30);
        sendToBackend(
            '/api/stream/events',
            { events: batch },
            () => {
                state.sentCount += batch.length;
                state.connected = true;
                updateHud();
            },
            (err) => {
                state.connected = false;
                // 失败时将前 15 条保留重新放入队首重试
                state.pendingQueue.unshift(...batch.slice(0, 15));
                updateHud();
                log('回传本地总控失败:', err.message || err);
            }
        );
    }, CONFIG.batchIntervalMs);

    // 哨兵与总控心跳检测
    setInterval(() => {
        sendToBackend(
            '/api/sentinel/heartbeat',
            {
                sentinelVersion: '1.1.0',
                roomId: state.roomId || 'unknown',
                shopName: state.shopName || '',
                capturedCount: state.capturedCount,
                sentCount: state.sentCount,
                timestampIso: new Date().toISOString()
            },
            () => {
                state.connected = true;
                state.lastHeartbeatTs = Date.now();
                updateHud();
            },
            () => {
                state.connected = false;
                updateHud();
            }
        );
    }, CONFIG.heartbeatIntervalMs);

    // =========================================================================
    // 6. 网络底层被动拦截 (Fetch & XHR Sniffing)
    // =========================================================================

    // 6.1 拦截 window.fetch
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (isTargetScreenApi(url)) {
                // 使用 clone 避免消耗原始 response 流
                const clone = response.clone();
                clone.text().then(text => {
                    processApiResponse(url, text, 'fetch');
                }).catch(() => {});
            }
        } catch (e) {
            log('Fetch Hook Exception:', e);
        }
        return response;
    };

    // 6.2 拦截 XMLHttpRequest
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._sentinelUrl = url;
        return originalXhrOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', function () {
            try {
                if (this._sentinelUrl && isTargetScreenApi(this._sentinelUrl)) {
                    processApiResponse(this._sentinelUrl, this.responseText, 'xhr');
                }
            } catch (e) {
                log('XHR Hook Exception:', e);
            }
        });
        return originalXhrSend.apply(this, args);
    };

    function isTargetScreenApi(url) {
        if (!url) return false;
        return url.includes('compass_api') && (
            url.includes('live_base_info') ||
            url.includes('core_data') ||
            url.includes('product_explain_detail') ||
            url.includes('professional/comment') ||
            url.includes('comment_cluster')
        );
    }

    // =========================================================================
    // 7. 页面浮动状态指示栏 (HUD)
    // =========================================================================
    let hudElement = null;

    function createHud() {
        if (hudElement || !document.body) return;

        hudElement = document.createElement('div');
        hudElement.id = 'douyin-sentinel-hud';
        hudElement.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 2147483647;
            background: rgba(17, 24, 39, 0.94);
            color: #f3f4f6;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            font-size: 12px;
            line-height: 1.5;
            padding: 8px 14px;
            border-radius: 8px;
            box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
            border: 1px solid rgba(255, 255, 255, 0.12);
            display: flex;
            align-items: center;
            gap: 10px;
            cursor: pointer;
            user-select: none;
            backdrop-filter: blur(6px);
            transition: all 0.2s ease;
        `;
        document.body.appendChild(hudElement);

        hudElement.addEventListener('mouseenter', () => {
            hudElement.style.transform = 'translateY(-2px)';
            hudElement.style.boxShadow = '0 6px 22px rgba(0, 0, 0, 0.55)';
        });
        hudElement.addEventListener('mouseleave', () => {
            hudElement.style.transform = 'translateY(0)';
            hudElement.style.boxShadow = '0 4px 18px rgba(0, 0, 0, 0.45)';
        });

        hudElement.addEventListener('click', () => {
            const current = CONFIG.backendUrl;
            const newUrl = prompt('设置本地总控服务地址 (默认 http://127.0.0.1:28888):', current);
            if (newUrl && newUrl.trim() !== '') {
                CONFIG.backendUrl = newUrl.trim();
                GM_setValue('backend_url', CONFIG.backendUrl);
                alert(`已更新总控地址为: ${CONFIG.backendUrl}`);
                updateHud();
            }
        });

        updateHud();
    }

    function updateHud() {
        if (!hudElement) return;

        const statusColor = state.connected ? '#10b981' : '#ef4444';
        const statusText = state.connected ? '总控已连接' : '等待总控软件';
        const roomInfo = state.shopName || state.roomId || '正在检测大屏';

        hudElement.innerHTML = `
            <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${statusColor};box-shadow:0 0 8px ${statusColor};"></span>
            <span><strong>电商罗盘哨兵</strong>: ${statusText}</span>
            <span style="color:rgba(255,255,255,0.25);">|</span>
            <span style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#93c5fd;">${roomInfo}</span>
            <span style="color:rgba(255,255,255,0.25);">|</span>
            <span>捕获: <strong>${state.capturedCount}</strong></span>
            <span>回传: <strong>${state.sentCount}</strong></span>
        `;
    }

    // 注册油猴管理菜单命令
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('配置总控后端地址', () => {
            const newUrl = prompt('设置本地总控服务地址:', CONFIG.backendUrl);
            if (newUrl && newUrl.trim() !== '') {
                CONFIG.backendUrl = newUrl.trim();
                GM_setValue('backend_url', CONFIG.backendUrl);
                alert(`已更新总控地址为: ${CONFIG.backendUrl}`);
                updateHud();
            }
        });
    }

    // 页面加载完成后挂载 HUD
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', createHud);
    } else {
        createHud();
    }
    setTimeout(createHud, 1500);

    log('抖音电商罗盘哨兵脚本已注入，等待大屏数据...');
})();
