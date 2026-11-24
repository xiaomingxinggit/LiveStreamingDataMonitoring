// ==UserScript==
// @name         抖音电商罗盘大屏数据监控哨兵 (Douyin Live Sentinel)
// @namespace    https://github.com/livestreaming-monitoring/sentinel
// @version      1.5.0
// @description  实时监听拦截抖音电商罗盘大屏数据（基础信息、核心指标、讲解商品、弹幕互动），清洗后安全回传本地总控客户端
// @author       LiveStreamingDataMonitoring
// @match        https://compass.jinritemai.com/screen/live/shop*
// @noframes
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

    function getLivePageRoomId(href) {
        const url = new URL(href);
        if (url.origin !== 'https://compass.jinritemai.com' || url.pathname !== '/screen/live/shop') return '';

        const roomIds = url.searchParams.getAll('live_room_id');
        return roomIds.length === 1 && /^[1-9]\d*$/.test(roomIds[0]) ? roomIds[0] : '';
    }

    const browserWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    const roomId = getLivePageRoomId(window.location.href);
    if (!roomId || browserWindow.self !== browserWindow.top) return;

    function isActiveLivePage() {
        return getLivePageRoomId(window.location.href) === roomId;
    }

    // =========================================================================
    // 1. 系统配置与运行时状态
    // =========================================================================
    const CONFIG = {
        version: '1.5.0',
        backendUrl: GM_getValue('backend_url', 'http://127.0.0.1:28888'),
        heartbeatIntervalMs: 3000,
        retryDelayMs: 1000,
        maxBatchSize: 30,
        maxQueueSize: 500,
        debug: true
    };

    const state = {
        connected: false,
        shopName: '',
        responseCount: 0,
        capturedCount: 0,
        sentCount: 0,
        latestResponses: new Map(),
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
        parseLiveBaseInfo: function (json) {
            const data = json.data;
            if (!data) return null;

            const shopName = sanitizeText(data.nickname || '');
            if (shopName) state.shopName = shopName;

            return {
                eventType: 'ROOM_BASE_INFO',
                roomId,
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

        parseCoreData: function (json) {
            const data = json.data;
            if (!data) return null;

            const items = Array.isArray(data.core_data) ? data.core_data : [];
            const findItem = (name) => items.find(item => item.index_name === name);
            const getNum = (name) => {
                const item = findItem(name);
                return item && item.value && typeof item.value.value === 'number' ? item.value.value : 0;
            };
            const getOptionalNum = (name) => {
                const item = findItem(name);
                return item && item.value && typeof item.value.value === 'number' ? item.value.value : null;
            };

            const totalPayCents = data.pay_amt?.value ?? getNum('pay_amt');
            const totalPayAllCents = data.pay_amt_all?.value ?? totalPayCents;
            const statCostCents = getOptionalNum('stat_cost');
            const gpmCents = getOptionalNum('gpm');

            const formatRatio = (val) => val !== null && val !== undefined ? Number(val.toFixed(6)) : null;
            const watchPayRatio = getOptionalNum('watch_pay_ucnt_ratio');

            return {
                eventType: 'CORE_METRICS',
                roomId,
                shopName: state.shopName,
                // 用户要求的 8 个指标 (显式单位)
                gpm_amount_yuan: gpmCents !== null ? parsePriceCentsToYuan(gpmCents) : null,
                watch_pay_ucnt_ratio: formatRatio(watchPayRatio),
                watch_to_pay_ratio: formatRatio(watchPayRatio),
                avg_watch_duration_seconds: getOptionalNum('avg_watch_duration') !== null ? Math.round(getOptionalNum('avg_watch_duration')) : null,
                ad_cost_yuan: statCostCents !== null ? parsePriceCentsToYuan(statCostCents) : null,
                old_fans_pay_ucnt_ratio: formatRatio(getOptionalNum('old_fans_pay_ucnt_ratio')),
                interact_watch_ucnt_ratio: formatRatio(getOptionalNum('interact_watch_ucnt_ratio')),
                follow_anchor_watch_ucnt_ratio: formatRatio(getOptionalNum('follow_anchor_watch_ucnt_ratio')),
                real_refund_amt_ratio: formatRatio(getOptionalNum('real_refund_amt_ratio')),
                // 基础大盘字段
                gmv_amount_yuan: parsePriceCentsToYuan(totalPayCents),
                gmv_amount_all_yuan: parsePriceCentsToYuan(totalPayAllCents),
                online_viewers_count: getNum('current_cnt') || 0,
                pay_users_count: getNum('pay_ucnt') || 0,
                pay_combo_orders_count: getNum('pay_combo_cnt') || 0
            };
        },

        parseProductExplainDetail: function (json) {
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
                roomId,
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

        parseComments: function (json) {
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
                roomId,
                comments: comments
            };
        },

        parseCommentCluster: function (json) {
            const data = json.data;
            if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;

            const clusters = data.items.map(item => ({
                keyword: sanitizeText(item.keyword || item.word || ''),
                count: Number(item.count || 0),
                ratio: Number(item.ratio || 0)
            }));

            return {
                eventType: 'COMMENT_CLUSTER',
                roomId,
                clusters: clusters
            };
        }
    };

    // =========================================================================
    // 4. 统一路由与报文分发中心
    // =========================================================================
    const captureRoutes = [
        { id: 'coreData', label: '核心指标', path: '/live_screen/core_data', parse: CompassParser.parseCoreData },
        { id: 'baseInfo', label: '直播间信息', path: '/live_screen/live_base_info', parse: CompassParser.parseLiveBaseInfo },
        { id: 'product', label: '讲解商品', path: '/live_screen/product_explain_detail', parse: CompassParser.parseProductExplainDetail },
        { id: 'comments', label: '互动评论', path: '/live_screen/professional/comment', parse: CompassParser.parseComments },
        { id: 'commentCluster', label: '评论聚类', path: '/live_screen/comment_cluster', parse: CompassParser.parseCommentCluster }
    ];
    const responsePreviewLimit = 12000;

    function processApiResponse(url, rawText, channel, readError = false) {
        if (!isActiveLivePage() || typeof url !== 'string') return;
        const { pathname, searchParams } = new URL(url);
        const path = pathname.replace(/\/$/, '');
        const route = captureRoutes.find(candidate => path.endsWith(candidate.path));
        if (!route) return;

        const requestRoomIds = ['room_id', 'live_room_id', 'roomId'].flatMap(name => searchParams.getAll(name));
        if (requestRoomIds.some(id => id !== roomId)) return;

        const text = typeof rawText === 'string' ? rawText : '';
        const observation = {
            observedAt: Date.now(),
            channel,
            status: readError ? 'readError' : 'empty',
            preview: text.slice(0, responsePreviewLimit),
            truncated: text.length > responsePreviewLimit,
            payload: null
        };
        state.responseCount++;
        state.latestResponses.set(route.id, observation);

        try {
            if (!text) return;

            let json;
            try {
                json = JSON.parse(text);
            } catch {
                observation.status = 'invalidJson';
                return;
            }

            const parsedPayload = json && typeof json === 'object' ? route.parse(json) : null;
            if (!parsedPayload) return;

            observation.status = 'parsed';
            observation.payload = parsedPayload;
            const envelope = {
                eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                timestampIso: new Date().toISOString(),
                sourceChannel: channel,
                pageUrl: window.location.href,
                ...parsedPayload
            };
            log(`[捕获成功] ${parsedPayload.eventType} | 房间: ${roomId}`);
            enqueueEvent(envelope);
        } catch (error) {
            observation.status = 'parseError';
            log('解析目标接口失败:', route.id, error.message);
        } finally {
            updateHud();
        }
    }

    // =========================================================================
    // 5. 消息队列与本地回传传输层 (GM_xmlhttpRequest)
    // =========================================================================
    let activeBatch = null;

    function enqueueEvent(event) {
        state.capturedCount++;
        state.pendingQueue.push(event);

        if (state.pendingQueue.length + (activeBatch?.length || 0) > CONFIG.maxQueueSize) {
            state.pendingQueue.shift();
        }
        flushPendingEvents();
    }

    function sendToBackend(endpoint, data, onSuccess, onError) {
        if (typeof GM_xmlhttpRequest !== 'function') {
            onError(new Error('GM_xmlhttpRequest 不可用'));
            return;
        }

        let settled = false;
        function finish(callback, value) {
            if (settled) return;
            settled = true;
            callback(value);
        }

        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${CONFIG.backendUrl}${endpoint}`,
                headers: {
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify(data),
                timeout: 4000,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        finish(onSuccess, response.responseText);
                    } else {
                        finish(onError, new Error(`Server error: HTTP ${response.status}`));
                    }
                },
                onerror: error => finish(onError, error),
                ontimeout: () => finish(onError, new Error('Request timed out')),
                onabort: () => finish(onError, new Error('Request aborted'))
            });
        } catch (error) {
            finish(onError, error);
        }
    }

    function flushPendingEvents() {
        if (!isActiveLivePage() || activeBatch || state.pendingQueue.length === 0) return;
        activeBatch = state.pendingQueue.splice(0, CONFIG.maxBatchSize);
        sendActiveBatch();
    }

    function sendActiveBatch() {
        const batch = activeBatch;
        if (!isActiveLivePage()) {
            state.pendingQueue.unshift(...batch);
            activeBatch = null;
            return;
        }

        sendToBackend(
            '/api/stream/events',
            { events: batch },
            () => {
                activeBatch = null;
                state.sentCount += batch.length;
                state.connected = true;
                updateHud();
                flushPendingEvents();
            },
            (error) => {
                state.connected = false;
                updateHud();
                log('回传本地总控失败:', error?.message || error);
                // 保留整批事件和原有事件 ID，避免重试时丢数据或改变顺序。
                setTimeout(sendActiveBatch, CONFIG.retryDelayMs);
            }
        );
    }

    setInterval(() => {
        if (!isActiveLivePage()) {
            updateHud();
            return;
        }

        sendToBackend(
            '/api/sentinel/heartbeat',
            {
                sentinelVersion: CONFIG.version,
                roomId,
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
    // 6. 页面网络响应监听
    // =========================================================================

    function installNetworkHooks(pageWindow, paths, canCapture, notify) {
        const xhrPrototype = pageWindow.XMLHttpRequest.prototype;
        const { open, send } = xhrPrototype;
        const eventPrototype = pageWindow.EventTarget?.prototype || xhrPrototype;
        const { addEventListener, removeEventListener } = eventPrototype;
        const observers = new WeakMap();

        const requiredCoreMetrics = [
            'gpm',
            'watch_pay_ucnt_ratio',
            'avg_watch_duration',
            'stat_cost',
            'old_fans_pay_ucnt_ratio',
            'interact_watch_ucnt_ratio',
            'follow_anchor_watch_ucnt_ratio',
            'real_refund_amt_ratio'
        ];

        function enhanceCoreDataUrl(value) {
            if (!value || typeof value !== 'string') return value;
            if (!value.includes('/live_screen/core_data')) return value;
            try {
                const url = new URL(value, pageWindow.location.href);
                const current = (url.searchParams.get('index_selected') || '').split(',').filter(Boolean);
                let changed = false;
                for (const m of requiredCoreMetrics) {
                    if (!current.includes(m)) {
                        current.push(m);
                        changed = true;
                    }
                }
                if (changed) {
                    url.searchParams.set('index_selected', current.join(','));
                    return url.href;
                }
            } catch {
                // 原样返回
            }
            return value;
        }

        function targetUrl(value) {
            if (!value) return '';
            try {
                const url = new URL(value, pageWindow.location.href);
                const path = url.pathname.replace(/\/$/, '');
                if (path.includes('/compass_api/') && paths.some(endpoint => path.endsWith(endpoint))) {
                    return url.href;
                }
            } catch {
                // 无法识别的地址交给页面原有网络代码。
            }
            return '';
        }

        function observeXhr(xhr, requestedUrl) {
            let handled = false;
            const listeners = [
                ['readystatechange', onReadyState],
                ['load', captureResponse],
                ['loadend', captureResponse]
            ];

            function cleanup() {
                if (handled) return;
                handled = true;
                observers.delete(xhr);
                for (const [type, listener] of listeners) {
                    try {
                        removeEventListener.call(xhr, type, listener, true);
                    } catch {
                        try {
                            xhr.removeEventListener(type, listener, true);
                        } catch {
                            // 清理监听器失败时仍保留页面原有的请求行为。
                        }
                    }
                }
            }

            function onReadyState() {
                // 在页面回调可能取消或复用请求前读取已完成的响应。
                if (xhr.readyState === 4) captureResponse();
            }

            function captureResponse() {
                if (handled) return;
                cleanup();
                if (!canCapture()) return;

                const url = targetUrl(xhr.responseURL) || requestedUrl;
                if (!url || xhr.status === 0) return;

                let text;
                try {
                    text = xhr.responseType === 'json' ? JSON.stringify(xhr.response) : xhr.responseText;
                } catch {
                    notify(url, '', 'xhr', true);
                    return;
                }
                notify(url, text, 'xhr');
            }

            observers.set(xhr, cleanup);
            try {
                for (const [type, listener] of listeners) {
                    try {
                        addEventListener.call(xhr, type, listener, true);
                    } catch {
                        xhr.addEventListener(type, listener, true);
                    }
                }
            } catch {
                cleanup();
            }
        }

        xhrPrototype.open = function (method, url, ...args) {
            const finalUrl = enhanceCoreDataUrl(url);
            const result = open.apply(this, [method, finalUrl, ...args]);
            observers.get(this)?.();
            // 在页面注册后续回调前开始监听，防止响应被同步清空。
            if (canCapture()) observeXhr(this, targetUrl(finalUrl));
            return result;
        };

        xhrPrototype.send = function (...args) {
            if (canCapture() && !observers.has(this)) observeXhr(this, '');
            try {
                return send.apply(this, args);
            } catch (error) {
                observers.get(this)?.();
                throw error;
            }
        };

        const originalFetch = pageWindow.fetch;
        if (typeof originalFetch === 'function') {
            pageWindow.fetch = async function (...args) {
                const capture = canCapture();
                if (args[0] && typeof args[0] === 'string') {
                    args[0] = enhanceCoreDataUrl(args[0]);
                }
                const response = await originalFetch.apply(this, args);
                if (!capture || !canCapture()) return response;
                const input = args[0];
                const url = targetUrl(response.url) || targetUrl(input?.url || input);
                if (!url) return response;

                try {
                    response.clone().text().then(
                        text => notify(url, text, 'fetch'),
                        () => notify(url, '', 'fetch', true)
                    );
                } catch {
                    notify(url, '', 'fetch', true);
                }
                return response;
            };
        }
    }

    const capturePaths = captureRoutes.map(route => route.path);
    const captureSource = `DOUYIN_SENTINEL_RAW_${Math.random().toString(36).slice(2)}`;

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin || event.data?.source !== captureSource) return;
        const { url, text, channel, readError } = event.data;
        processApiResponse(url, text, channel, readError);
    }, true);

    function injectMainWorldHook() {
        const parent = document.head || document.documentElement;
        if (!parent) return false;

        const script = document.createElement('script');
        script.textContent = `(() => {
            const script = document.currentScript;
            const post = window.postMessage.bind(window);
            const origin = window.location.origin;
            const getLivePageRoomId = ${getLivePageRoomId.toString()};
            const canCapture = () => getLivePageRoomId(window.location.href) === ${JSON.stringify(roomId)};
            (${installNetworkHooks.toString()})(window, ${JSON.stringify(capturePaths)}, canCapture, (url, text, channel, readError) => {
                post({ source: ${JSON.stringify(captureSource)}, url, text, channel, readError }, origin);
            });
            script.dataset.sentinelCaptureReady = 'true';
        })();`;

        try {
            parent.appendChild(script);
            return script.dataset.sentinelCaptureReady === 'true';
        } finally {
            script.remove();
        }
    }

    function startNetworkCapture() {
        try {
            if (injectMainWorldHook()) {
                log('主页面网络监听已就绪');
                return;
            }
        } catch (error) {
            log('主页面网络监听未能安装:', error.message);
        }

        try {
            installNetworkHooks(browserWindow, capturePaths, isActiveLivePage, processApiResponse);
            log('备用网络监听已就绪');
        } catch (error) {
            log('备用网络监听未能安装:', error.message);
        }
    }

    startNetworkCapture();

    // =========================================================================
    // 7. 页面浮动状态指示栏 (HUD)
    // =========================================================================
    const captureStatus = {
        parsed: '已解析',
        empty: '无可用数据',
        readError: '响应读取失败',
        invalidJson: '响应不是有效 JSON',
        parseError: '解析失败'
    };
    const panelMoney = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
    const panelTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    let hud = null;

    function createHud() {
        if (hud || !document.body || !isActiveLivePage()) return;

        const host = document.createElement('div');
        host.id = 'douyin-sentinel-hud';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host {
                    position: fixed;
                    right: 18px;
                    bottom: 18px;
                    z-index: 2147483647;
                    font: 13px/1.5 "Microsoft YaHei", "PingFang SC", sans-serif;
                    color: #e8f4f3;
                    color-scheme: dark;
                    --muted: #a4bdc1;
                    --line: #2b424a;
                    --mint: #76e2bb;
                    --mono: "Cascadia Mono", "Consolas", monospace;
                }
                *, *::before, *::after { box-sizing: border-box; }
                :host([hidden]), [hidden] { display: none !important; }
                button { font: inherit; cursor: pointer; color: inherit; }
                button:focus-visible, summary:focus-visible { outline: 2px solid var(--mint); outline-offset: 3px; }
                #douyin-sentinel-toggle {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin: 8px 0 0 auto;
                    padding: 9px 13px;
                    border-radius: 8px;
                    border: 1px solid #35565e;
                    background: #10242c;
                    box-shadow: 0 8px 26px #040d1255;
                }
                #douyin-sentinel-toggle:hover, .settings:hover { background: #213c47; }
                .toggle-status { color: var(--mint); font-size: 12px; }
                .chevron {
                    width: 7px;
                    height: 7px;
                    margin: 4px 1px 0 2px;
                    border-top: 1.5px solid var(--muted);
                    border-right: 1.5px solid var(--muted);
                    transform: rotate(-45deg);
                }
                [aria-expanded="true"] .chevron { margin-top: -3px; transform: rotate(135deg); }
                .panel {
                    display: flex;
                    flex-direction: column;
                    width: min(410px, calc(100vw - 36px));
                    max-height: min(590px, calc(100dvh - 88px));
                    overflow: hidden;
                    border: 1px solid #35565e;
                    border-top: 2px solid var(--mint);
                    border-radius: 12px;
                    background: #102129;
                    box-shadow: 0 18px 46px #030b12a6;
                }
                .panel-head { padding: 15px 16px 13px; }
                .head-line, .row-line { display: flex; align-items: center; gap: 8px; }
                h2 { margin: 0 auto 0 0; font-size: 17px; line-height: 1.35; letter-spacing: .03em; }
                .connection { flex: none; font-size: 11px; color: #edbf84; }
                .connection[data-connected="true"] { color: var(--mint); }
                .settings {
                    padding: 3px 7px;
                    border: 1px solid var(--line);
                    border-radius: 5px;
                    background: #142b35;
                    font-size: 11px;
                }
                .room { margin: 7px 0 0; color: var(--muted); overflow-wrap: anywhere; font-size: 12px; }
                .counters {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    margin: 0;
                    border-block: 1px solid var(--line);
                    background: #0c1c24;
                }
                .counters > div { padding: 8px 10px 9px 16px; }
                .counters > div + div { border-left: 1px solid var(--line); }
                dt { color: var(--muted); font-size: 11px; }
                dd { margin: 2px 0 0; font: 600 22px/1.2 var(--mono); font-variant-numeric: tabular-nums; }
                .counters > div:first-child dd { color: var(--mint); }
                .body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 12px 16px 15px; }
                h3 { margin: 0 0 8px; color: var(--muted); font-size: 11px; font-weight: 600; }
                .empty { margin: 0; padding: 13px 12px; color: var(--muted); border: 1px dashed #38545b; border-radius: 7px; }
                .event { border-bottom: 1px solid var(--line); }
                .event > summary { cursor: pointer; list-style: none; padding: 8px 0; }
                .event > summary::-webkit-details-marker { display: none; }
                .row-line > strong { margin-right: auto; font-size: 12px; }
                .row-line::after { content: "+"; width: 10px; text-align: center; color: var(--muted); }
                .event[open] .row-line::after { content: "−"; }
                .meta { color: var(--muted); font: 11px/1.5 var(--mono); }
                .status { color: #edbf84; font-size: 11px; }
                .event[data-status="parsed"] .status { color: var(--mint); }
                .data-summary { display: block; color: #d0e4e3; font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
                .raw { margin: 0 0 11px; color: var(--muted); font-size: 11px; }
                .raw > summary { cursor: pointer; }
                pre {
                    max-height: 225px;
                    overflow: auto;
                    padding: 9px;
                    margin: 2px 0 8px;
                    border: 1px solid var(--line);
                    border-radius: 6px;
                    background: #0a171e;
                    color: #d8ede9;
                    font: 11px/1.6 var(--mono);
                    white-space: pre-wrap;
                    overflow-wrap: anywhere;
                    user-select: text;
                }
            </style>
            <section class="panel" id="douyin-sentinel-panel" aria-labelledby="douyin-sentinel-title" hidden>
                <header class="panel-head">
                    <div class="head-line">
                        <h2 id="douyin-sentinel-title">罗盘采集</h2>
                        <span class="connection" id="douyin-sentinel-connection"></span>
                        <button class="settings" id="douyin-sentinel-settings" type="button">总控设置</button>
                    </div>
                    <p class="room" id="douyin-sentinel-room"></p>
                </header>
                <dl class="counters">
                    <div><dt>监听响应</dt><dd id="douyin-sentinel-response-count">0</dd></div>
                    <div><dt>成功解析</dt><dd id="douyin-sentinel-captured-count">0</dd></div>
                    <div><dt>已回传</dt><dd id="douyin-sentinel-sent-count">0</dd></div>
                </dl>
                <div class="body">
                    <h3>各接口最新响应</h3>
                    <div id="douyin-sentinel-events">
                        <p class="empty" id="douyin-sentinel-empty">等待罗盘页面返回目标接口数据</p>
                    </div>
                </div>
            </section>
            <button id="douyin-sentinel-toggle" type="button" aria-controls="douyin-sentinel-panel" aria-expanded="false">
                <strong>罗盘哨兵</strong>
                <span class="toggle-status" id="douyin-sentinel-toggle-status"></span>
                <span class="chevron" aria-hidden="true"></span>
            </button>
        `;
        const find = name => root.querySelector(`#douyin-sentinel-${name}`);
        hud = {
            host,
            panel: find('panel'),
            toggle: find('toggle'),
            toggleStatus: find('toggle-status'),
            connection: find('connection'),
            room: find('room'),
            responseCount: find('response-count'),
            capturedCount: find('captured-count'),
            sentCount: find('sent-count'),
            events: find('events'),
            empty: find('empty'),
            rows: new Map()
        };

        function setExpanded(expanded) {
            hud.toggle.setAttribute('aria-expanded', String(expanded));
            hud.panel.hidden = !expanded;
            updateHud();
        }

        hud.toggle.addEventListener('click', () => setExpanded(hud.panel.hidden));
        root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !hud.panel.hidden) {
                event.stopPropagation();
                setExpanded(false);
                hud.toggle.focus();
            }
        });
        find('settings').addEventListener('click', () => {
            const newUrl = prompt('设置本地总控服务地址', CONFIG.backendUrl);
            if (newUrl && newUrl.trim()) {
                CONFIG.backendUrl = newUrl.trim();
                GM_setValue('backend_url', CONFIG.backendUrl);
                alert(`已更新总控地址为 ${CONFIG.backendUrl}`);
            }
        });

        document.body.appendChild(host);
        updateHud();
    }

    function describePayload(payload) {
        switch (payload.eventType) {
            case 'CORE_METRICS': {
                const amount = panelMoney.format(payload.gmv_amount_yuan);
                return `成交金额 ${amount}  在线 ${payload.online_viewers_count} 人  成交 ${payload.pay_combo_orders_count} 件`;
            }
            case 'ROOM_BASE_INFO':
                return [payload.shopName, payload.liveStatusText, payload.liveStartTime].filter(Boolean).join('  ');
            case 'EXPLAINING_PRODUCT':
                return payload.isExplaining ? payload.productName || '正在讲解' : '当前未讲解商品';
            case 'LIVE_COMMENTS':
                return `${payload.comments.length} 条评论`;
            case 'COMMENT_CLUSTER':
                return `${payload.clusters.length} 个评论关键词`;
            default:
                return '';
        }
    }

    function renderResponse(route, observation) {
        let row = hud.rows.get(route.id);
        if (!row) {
            const element = document.createElement('details');
            element.className = 'event';
            element.dataset.route = route.id;
            element.innerHTML = `
                <summary>
                    <span class="row-line"><strong></strong><span class="meta"></span><span class="status"></span></span>
                    <span class="data-summary"></span>
                </summary>
                <pre class="parsed" aria-label="解析数据"></pre>
                <details class="raw"><summary>原始响应</summary><pre></pre></details>
            `;
            element.querySelector('strong').textContent = route.label;
            hud.events.appendChild(element);
            row = {
                element,
                meta: element.querySelector('.meta'),
                status: element.querySelector('.status'),
                summary: element.querySelector('.data-summary'),
                parsed: element.querySelector('.parsed'),
                raw: element.querySelector('.raw'),
                rawLabel: element.querySelector('.raw summary'),
                rawPreview: element.querySelector('.raw pre'),
                observation: null
            };
            hud.rows.set(route.id, row);
        }
        if (row.observation === observation) return;

        row.observation = observation;
        row.element.dataset.status = observation.status;
        const channel = observation.channel === 'fetch' ? 'Fetch' : 'XHR';
        row.meta.textContent = `${panelTime.format(observation.observedAt)}  ${channel}`;
        row.status.textContent = captureStatus[observation.status];
        row.summary.hidden = !observation.payload;
        row.summary.textContent = observation.payload ? sanitizeText(describePayload(observation.payload)) : '';
        row.parsed.hidden = !observation.payload;
        row.parsed.textContent = observation.payload ? sanitizeText(JSON.stringify(observation.payload, null, 2)) : '';
        row.raw.hidden = !observation.preview;
        row.rawLabel.textContent = observation.truncated ? '原始响应（前 12,000 字符）' : '原始响应';
        row.rawPreview.textContent = sanitizeText(observation.preview);
    }

    function updateHud() {
        if (!hud) return;
        hud.host.hidden = !isActiveLivePage();
        if (hud.host.hidden) return;

        hud.toggleStatus.textContent = state.responseCount > 0 ? `响应 ${state.responseCount}` : '等待响应';
        if (hud.panel.hidden) return;

        hud.connection.textContent = state.connected ? '总控已连接' : '等待总控连接';
        hud.connection.dataset.connected = String(state.connected);
        const room = `房间 ${roomId}`;
        hud.room.textContent = sanitizeText([state.shopName, room].filter(Boolean).join('  '));
        hud.responseCount.textContent = String(state.responseCount);
        hud.capturedCount.textContent = String(state.capturedCount);
        hud.sentCount.textContent = String(state.sentCount);
        hud.empty.hidden = state.responseCount > 0;
        for (const route of captureRoutes) {
            const observation = state.latestResponses.get(route.id);
            if (observation) renderResponse(route, observation);
        }
    }

    function refreshHudForLocation() {
        if (hud) updateHud();
        else createHud();
    }

    window.addEventListener('popstate', refreshHudForLocation);
    browserWindow.navigation?.addEventListener('currententrychange', refreshHudForLocation);

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', createHud);
    } else {
        createHud();
    }
    setTimeout(createHud, 1000);

    log(`抖音电商罗盘哨兵 v${CONFIG.version} 已注入就绪`);
})();
