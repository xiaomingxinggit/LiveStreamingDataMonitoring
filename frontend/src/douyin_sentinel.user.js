// ==UserScript==
// @name         抖音电商罗盘大屏数据监控哨兵 (Douyin Live Sentinel)
// @namespace    https://github.com/livestreaming-monitoring/sentinel
// @version      1.2.0
// @description  实时监听拦截抖音电商罗盘大屏数据（基础信息、核心指标、讲解商品、弹幕互动），清洗后安全回传本地总控客户端
// @author       LiveStreamingDataMonitoring
// @match        https://compass.jinritemai.com/screen/*
// @match        https://compass.jinritemai.com/shop/live/*
// @match        https://compass.jinritemai.com/*
// @match        https://buyin.jinritemai.com/dashboard/*
// @match        https://buyin.jinritemai.com/screen/*
// @match        https://live.douyin.com/*
// @grant        unsafeWindow
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
        heartbeatIntervalMs: 3000,
        maxQueueSize: 500,
        debug: true
    };

    function extractRoomId(url, data) {
        if (data && (data.room_id || data.roomId || data.live_room_id)) {
            return String(data.room_id || data.roomId || data.live_room_id);
        }
        if (url && typeof url === 'string') {
            const match = url.match(/[?&](?:room_id|live_room_id|roomId)=([0-9]+)/i) || url.match(/\/([0-9]{15,22})/);
            if (match && match[1]) return match[1];
        }
        return '';
    }

    const initialRoomId = extractRoomId(window.location.href);

    const state = {
        connected: false,
        roomId: initialRoomId || '',
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
        return value.replace(/\u00B7/g, ' ').trim();
    }

    function parsePriceCentsToYuan(centsVal) {
        if (typeof centsVal !== 'number') {
            centsVal = Number(centsVal) || 0;
        }
        return Number((centsVal / 100).toFixed(2));
    }

    // =========================================================================
    // 3. 抖音电商罗盘专属协议解析器
    // =========================================================================
    const CompassParser = {
        parseLiveBaseInfo: function (url, json) {
            const data = json.data;
            if (!data) return null;

            const roomId = extractRoomId(url, data) || state.roomId;
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

        parseCoreData: function (url, json) {
            const data = json.data;
            if (!data) return null;

            const roomId = extractRoomId(url, data) || state.roomId;
            if (roomId) state.roomId = roomId;

            const items = Array.isArray(data.core_data) ? data.core_data : [];
            const findItem = (name) => items.find(item => item.index_name === name);
            const getNum = (name) => {
                const item = findItem(name);
                return item && item.value && typeof item.value.value === 'number' ? item.value.value : 0;
            };

            const totalPayCents = data.pay_amt?.value ?? getNum('pay_amt');
            const totalPayAllCents = data.pay_amt_all?.value ?? totalPayCents;
            const statCostCents = getNum('stat_cost');
            const gpmCents = getNum('gpm');

            return {
                eventType: 'CORE_METRICS',
                roomId: state.roomId,
                shopName: state.shopName,
                gmv_amount_yuan: parsePriceCentsToYuan(totalPayCents),
                gmv_amount_all_yuan: parsePriceCentsToYuan(totalPayAllCents),
                ad_cost_yuan: parsePriceCentsToYuan(statCostCents),
                gpm_amount_yuan: parsePriceCentsToYuan(gpmCents),
                online_viewers_count: getNum('current_cnt'),
                pay_users_count: getNum('pay_ucnt'),
                pay_combo_orders_count: getNum('pay_combo_cnt'),
                watch_to_pay_ratio: Number(getNum('watch_pay_ucnt_ratio').toFixed(6)),
                product_click_to_pay_ratio: Number(getNum('product_click_pay_ucnt_ratio').toFixed(6)),
                exposure_to_watch_ratio: Number(getNum('watch_cnt_show_ratio').toFixed(6)),
                avg_watch_duration_seconds: Math.round(getNum('avg_watch_duration'))
            };
        },

        parseProductExplainDetail: function (url, json) {
            const data = json.data;
            if (!data) return null;

            const roomId = extractRoomId(url, data) || state.roomId;
            if (roomId) state.roomId = roomId;

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
            log(`[捕获成功] ${parsedPayload.eventType} | 房间: ${state.roomId || '待解析'}`);
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
            state.pendingQueue.shift();
        }
        updateHud();
    }

    function sendToBackend(endpoint, data, onSuccess, onError) {
        if (typeof GM_xmlhttpRequest !== 'function') {
            console.error('[Sentinel 哨兵] 错误: GM_xmlhttpRequest 不可用');
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
                state.pendingQueue.unshift(...batch.slice(0, 15));
                updateHud();
                log('回传本地总控失败:', err.message || err);
            }
        );
    }, CONFIG.batchIntervalMs);

    setInterval(() => {
        // 如果当前没有从请求捕获到 roomId，再次从当前页面 URL 提取
        if (!state.roomId) {
            state.roomId = extractRoomId(window.location.href);
        }

        sendToBackend(
            '/api/sentinel/heartbeat',
            {
                sentinelVersion: '1.2.0',
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
    // 6. 双通道注入拦截：主页面 (Main World) + unsafeWindow 代理
    // =========================================================================

    // 6.1 监听主页面派发的原生网络事件
    window.addEventListener('message', function (event) {
        if (event.data && event.data.source === 'DOUYIN_SENTINEL_RAW') {
            const { url, text, channel } = event.data;
            processApiResponse(url, text, channel);
        }
    });

    // 6.2 往主页面环境注入脚本（直接劫持网页原生 XHR 与 Fetch，破除沙箱隔离）
    function injectMainWorldHook() {
        const scriptCode = `
        (function() {
            if (window.__douyin_sentinel_injected__) return;
            window.__douyin_sentinel_injected__ = true;

            function isTargetUrl(url) {
                if (!url || typeof url !== 'string') return false;
                return url.includes('compass_api') && (
                    url.includes('live_base_info') ||
                    url.includes('core_data') ||
                    url.includes('product_explain_detail') ||
                    url.includes('professional/comment') ||
                    url.includes('comment_cluster')
                );
            }

            function notifySentinel(url, text, channel) {
                window.postMessage({
                    source: 'DOUYIN_SENTINEL_RAW',
                    url: url,
                    text: text,
                    channel: channel
                }, '*');
            }

            // 1. Hook 原生 XMLHttpRequest
            const originalXhrOpen = XMLHttpRequest.prototype.open;
            const originalXhrSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                this._sentinelUrl = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
                return originalXhrOpen.apply(this, [method, url, ...rest]);
            };

            XMLHttpRequest.prototype.send = function(...args) {
                this.addEventListener('load', function() {
                    try {
                        if (this._sentinelUrl && isTargetUrl(this._sentinelUrl)) {
                            notifySentinel(this._sentinelUrl, this.responseText, 'xhr');
                        }
                    } catch(e) {}
                });
                return originalXhrSend.apply(this, args);
            };

            // 2. Hook 原生 window.fetch
            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function') {
                window.fetch = async function(...args) {
                    const response = await originalFetch.apply(this, args);
                    try {
                        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                        if (isTargetUrl(url)) {
                            const clone = response.clone();
                            clone.text().then(text => {
                                notifySentinel(url, text, 'fetch');
                            }).catch(() => {});
                        }
                    } catch(e) {}
                    return response;
                };
            }

            console.log('[Sentinel] 主世界网络拦截钩子已注入成功');
        })();
        `;

        try {
            const script = document.createElement('script');
            script.textContent = scriptCode;
            (document.head || document.documentElement).appendChild(script);
            script.remove();
        } catch (e) {
            log('主页面脚本注入异常:', e);
        }
    }

    // 立即执行主世界注入
    injectMainWorldHook();

    // 6.3 兜底：同步劫持 unsafeWindow
    const targetWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (targetWin && targetWin !== window) {
        try {
            const origXhrOpen = targetWin.XMLHttpRequest.prototype.open;
            const origXhrSend = targetWin.XMLHttpRequest.prototype.send;
            targetWin.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this._sentinelUrl = url;
                return origXhrOpen.apply(this, [method, url, ...rest]);
            };
            targetWin.XMLHttpRequest.prototype.send = function (...args) {
                this.addEventListener('load', function () {
                    if (this._sentinelUrl && String(this._sentinelUrl).includes('compass_api')) {
                        processApiResponse(String(this._sentinelUrl), this.responseText, 'xhr');
                    }
                });
                return origXhrSend.apply(this, args);
            };
        } catch (e) {}
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
        const roomInfo = state.shopName || (state.roomId ? `房间 ${state.roomId}` : '正在检测大屏');

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

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', createHud);
    } else {
        createHud();
    }
    setTimeout(createHud, 1000);

    log('抖音电商罗盘哨兵 v1.2.0 已注入就绪');
})();
