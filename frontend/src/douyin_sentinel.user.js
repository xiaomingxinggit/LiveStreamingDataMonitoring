// ==UserScript==
// @name         抖音电商罗盘大屏数据监控哨兵 (Douyin Live Sentinel)
// @namespace    https://github.com/xiaomingxinggit/LiveStreamingDataMonitoring
// @version      1.15.0
// @description  实时监听抖音电商罗盘大屏数据（基础信息、核心指标、商品列表、讲解商品、弹幕互动），清洗后安全回传本地总控客户端
// @author       LiveStreamingDataMonitoring
// @match        https://compass.jinritemai.com/screen/live/shop*
// @noframes
// @updateURL    https://raw.githubusercontent.com/xiaomingxinggit/LiveStreamingDataMonitoring/main/frontend/src/douyin_sentinel.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaomingxinggit/LiveStreamingDataMonitoring/main/frontend/src/douyin_sentinel.user.js
// @resource     vueRuntimeJs https://cdn.jsdelivr.net/npm/vue@3.5.46/dist/vue.global.prod.js
// @resource     elementPlusJs https://cdn.jsdelivr.net/npm/element-plus@2.14.8/dist/index.full.min.js
// @resource     elementPlusCss https://cdn.jsdelivr.net/npm/element-plus@2.14.8/dist/index.css
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_getResourceText
// @grant        GM_addStyle
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
        version: '1.13.1',
        backendUrl: GM_getValue('backend_url', 'http://127.0.0.1:28888'),
        heartbeatIntervalMs: 3000,
        retryDelayMs: 1000,
        maxBatchSize: 30,
        maxQueueSize: 500,
        productReportIntervalMs: 60 * 60 * 1000,
        debug: true
    };

    const state = {
        connected: false,
        heartbeatInFlight: false,
        shopName: '',
        responseCount: 0,
        capturedCount: 0,
        sentCount: 0,
        latestResponses: new Map(),
        latestParsedPayloads: new Map(),
        pendingQueue: [],
        lastHeartbeatTs: 0,
        serverInstanceId: '',
        refreshRequestId: '',
        refreshRequestAckId: '',
        productCollection: {
            active: false,
            startedAt: 0,
            nextReportAt: 0,
            awaitingInitial: false,
            reportSequence: 0,
            configurationReady: false,
            latestEnvelope: null
        }
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

    function firstNonEmptyValue(...values) {
        return values.find(value => value !== null && value !== undefined && String(value).trim() !== '') ?? '';
    }

    function parsePriceCentsToYuan(centsVal) {
        if (typeof centsVal !== 'number') {
            centsVal = Number(centsVal) || 0;
        }
        return Number((centsVal / 100).toFixed(2));
    }

    function unwrapMetricValue(value) {
        let current = value;
        for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
            if (Object.prototype.hasOwnProperty.call(current, 'value')) current = current.value;
            else if (Object.prototype.hasOwnProperty.call(current, 'num_value')) current = current.num_value;
            else break;
        }
        const numeric = Number(current);
        return current !== '' && current !== null && current !== undefined && Number.isFinite(numeric) ? numeric : null;
    }

    function productMetricValue(row, name) {
        const collections = [row.index_data, row.metric_data, row.metrics, row.data];
        const direct = [row[name], ...collections.map(collection =>
            collection && !Array.isArray(collection) ? collection[name] : undefined
        )];
        for (const candidate of direct) {
            const value = unwrapMetricValue(candidate);
            if (value !== null) return value;
        }
        for (const collection of collections.filter(Array.isArray)) {
            const item = collection.find(entry =>
                [entry?.index_name, entry?.field, entry?.key, entry?.name].includes(name)
            );
            const value = unwrapMetricValue(item);
            if (value !== null) return value;
        }
        return null;
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
                indexSelected: items.map(item => String(item?.index_name || '')).filter(Boolean),
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

        parseProductList: function (json, requestUrl) {
            const data = json.data;
            if (!data) return null;
            const rows = data.data_result ?? data.product_list ?? data.products;
            if (!Array.isArray(rows) || rows.length === 0) return null;

            const ratio = value => value === null ? null : Number(value.toFixed(6));
            const products = rows.map((row, index) => {
                const info = row.product_info ?? row.product ?? row.base_info ?? {};
                const payCents = productMetricValue(row, 'pay_amt');
                const gpmCents = productMetricValue(row, 'gpm');
                return {
                    productId: String(row.product_id ?? row.id ?? info.product_id ?? info.id ?? ''),
                    productName: sanitizeText(firstNonEmptyValue(
                        row.product_name, row.name, row.title, row.product_title, row.goods_name,
                        info.product_name, info.name, info.title, info.product_title, info.goods_name
                    )),
                    productImg: firstNonEmptyValue(
                        row.product_img, row.image_url, row.image_uri, row.img,
                        info.product_img, info.image_url, info.image_uri, info.img
                    ),
                    cartIndex: Number(firstNonEmptyValue(
                        row.shop_cart_num, row.room_cart_num, row.cart_index, row.product_rank,
                        info.shop_cart_num, info.room_cart_num, info.cart_index, info.product_rank, index + 1
                    )),
                    product_pay_amount_yuan: payCents === null ? null : parsePriceCentsToYuan(payCents),
                    product_show_users_count: productMetricValue(row, 'product_show_ucnt'),
                    product_click_users_count: productMetricValue(row, 'product_click_ucnt'),
                    product_show_click_users_ratio: ratio(productMetricValue(row, 'product_show_click_ucnt_ratio')),
                    product_click_pay_users_ratio: ratio(productMetricValue(row, 'product_click_pay_ucnt_ratio')),
                    product_gpm_amount_yuan: gpmCents === null ? null : parsePriceCentsToYuan(gpmCents)
                };
            });

            const query = requestUrl?.searchParams;
            const pageResult = data.page_result || {};
            const headSelected = Array.isArray(data.data_head) ? data.data_head
                .map(item => item?.index_name ?? item?.field ?? item?.key)
                .filter(Boolean) : [];
            const selectedValue = data.index_selected ??
                (headSelected.length > 0 ? headSelected : query?.get('index_selected') ?? '');
            const indexSelected = Array.isArray(selectedValue) ? selectedValue.map(String) :
                String(selectedValue).split(',').map(item => item.trim()).filter(Boolean);
            const sortField = String(data.sort_field ?? query?.get('sort_field') ?? '');
            const rawAscending = data.is_asc ?? query?.get('is_asc');
            const order = sortField ? (rawAscending === true || rawAscending === 1 ||
                String(rawAscending).toLowerCase() === 'true' || String(rawAscending) === '1' ? 'asc' : 'desc') : '';

            return {
                eventType: 'PRODUCT_LIST',
                roomId,
                shopName: state.shopName,
                products,
                page: {
                    current: Number(pageResult.page_no ?? pageResult.current ?? data.page_no ?? query?.get('page_no') ?? 0),
                    size: Number(pageResult.page_size ?? pageResult.size ?? data.page_size ?? query?.get('page_size') ?? products.length),
                    total: Number(pageResult.total ?? pageResult.total_cnt ?? data.total_cnt ?? products.length)
                },
                sort: { field: sortField, order },
                indexSelected
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
        { id: 'productList', label: '商品列表', path: '/live_screen/product_list', parse: CompassParser.parseProductList },
        { id: 'product', label: '讲解商品', path: '/live_screen/product_explain_detail', parse: CompassParser.parseProductExplainDetail },
        { id: 'comments', label: '互动评论', path: '/live_screen/professional/comment', parse: CompassParser.parseComments },
        { id: 'commentCluster', label: '评论聚类', path: '/live_screen/comment_cluster', parse: CompassParser.parseCommentCluster }
    ];
    const responsePreviewLimit = 12000;

    function processApiResponse(url, rawText, channel, readError = false) {
        if (!isActiveLivePage() || typeof url !== 'string') return;
        const requestUrl = new URL(url);
        const { pathname, searchParams } = requestUrl;
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

            const responseCode = Number(json?.st ?? json?.code ?? 0);
            if (Number.isFinite(responseCode) && responseCode !== 0) {
                observation.status = 'apiError';
                observation.responseCode = responseCode;
                return;
            }

            const parsedPayload = json && typeof json === 'object' ? route.parse(json, requestUrl) : null;
            if (!parsedPayload) return;

            observation.status = 'parsed';
            observation.payload = parsedPayload;
            state.latestParsedPayloads.set(route.id, parsedPayload);
            const envelope = {
                eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                timestampIso: new Date().toISOString(),
                sourceChannel: channel,
                pageUrl: window.location.href,
                ...parsedPayload
            };
            if (route.id === 'productList') {
                handleProductListEnvelope(envelope);
            } else {
                log(`[捕获成功] ${parsedPayload.eventType} | 房间: ${roomId}`);
                enqueueEvent(envelope);
            }
        } catch (error) {
            observation.status = 'parseError';
            log('解析目标接口失败:', route.id, error.message);
        } finally {
            updateHud();
        }
    }

    const requiredProductFields = [
        'pay_amt',
        'product_show_ucnt',
        'product_click_ucnt',
        'product_show_click_ucnt_ratio',
        'product_click_pay_ucnt_ratio',
        'gpm'
    ];

    function completeProductPayload(payload) {
        if (!payload || !Array.isArray(payload.products) || payload.products.length === 0) return false;
        const selected = new Set(Array.isArray(payload.indexSelected) ? payload.indexSelected : []);
        return requiredProductFields.every(field => selected.has(field));
    }

    function startProductCollectionCycle() {
        const collection = state.productCollection;
        if (collection.active) return false;
        const now = Date.now();
        collection.active = true;
        collection.startedAt = now;
        collection.nextReportAt = now + CONFIG.productReportIntervalMs;
        collection.awaitingInitial = true;
        collection.reportSequence = 0;
        return true;
    }

    function updateProductReportStatus() {
        const collection = state.productCollection;
        if (!collection.active || !collection.configurationReady) return;
        if (collection.awaitingInitial) {
            setProductPresetStatus('ready', '已启动  等待首次商品接口');
            return;
        }
        const minutes = Math.max(0, Math.ceil((collection.nextReportAt - Date.now()) / 60000));
        setProductPresetStatus('ready', `已回传 ${collection.reportSequence} 次  下次自动约 ${minutes} 分钟`);
    }

    function publishProductReport(envelope) {
        const collection = state.productCollection;
        const now = Date.now();
        collection.reportSequence++;
        collection.awaitingInitial = false;
        while (collection.nextReportAt <= now) {
            collection.nextReportAt += CONFIG.productReportIntervalMs;
        }
        enqueueEvent({
            ...envelope,
            eventId: `evt_${now}_${Math.random().toString(36).substring(2, 8)}`,
            timestampIso: new Date(now).toISOString(),
            productDataObservedAtIso: envelope.timestampIso,
            productCollectionStartedAtIso: new Date(collection.startedAt).toISOString(),
            productReportIntervalMinutes: 60,
            productReportSequence: collection.reportSequence,
            productReportTrigger: 'automatic'
        });
        log(`[商品回传] 第 ${collection.reportSequence} 次 | 房间: ${roomId}`);
        updateProductReportStatus();
    }

    function flushDueProductReport() {
        const collection = state.productCollection;
        const envelope = collection.latestEnvelope;
        if (!collection.active || !collection.configurationReady || !completeProductPayload(envelope)) return false;
        if (!collection.awaitingInitial && Date.now() < collection.nextReportAt) return false;
        publishProductReport(envelope);
        return true;
    }

    function handleProductListEnvelope(envelope) {
        if (completeProductPayload(envelope)) {
            state.productCollection.latestEnvelope = envelope;
        }
        flushDueProductReport();
    }

    function createReplayEnvelope(payload) {
        const now = Date.now();
        return {
            eventId: `evt_${now}_${Math.random().toString(36).substring(2, 8)}`,
            timestampIso: new Date(now).toISOString(),
            sourceChannel: 'reconnect',
            pageUrl: window.location.href,
            ...payload
        };
    }

    function replayLatestState(trigger = 'reconnect', refreshRequestId = '') {
        const replayEvents = ['baseInfo', 'coreData', 'product']
            .map(routeId => state.latestParsedPayloads.get(routeId))
            .filter(Boolean)
            .map(createReplayEnvelope);
        const collection = state.productCollection;
        if (collection.active && completeProductPayload(collection.latestEnvelope)) {
            const now = Date.now();
            replayEvents.push({
                ...collection.latestEnvelope,
                eventId: `evt_${now}_${Math.random().toString(36).substring(2, 8)}`,
                timestampIso: new Date(now).toISOString(),
                sourceChannel: 'reconnect',
                productDataObservedAtIso: collection.latestEnvelope.timestampIso,
                productCollectionStartedAtIso: new Date(collection.startedAt).toISOString(),
                productReportIntervalMinutes: 60,
                productReportSequence: collection.reportSequence,
                productReportTrigger: trigger
            });
        }
        for (const event of replayEvents) {
            enqueueEvent(trigger === 'control_refresh' ? {
                ...event,
                sourceChannel: 'control_refresh',
                controlRefreshRequestId: refreshRequestId
            } : event);
        }
        if (trigger === 'control_refresh' && replayEvents.length === 0) {
            state.refreshRequestAckId = refreshRequestId;
        }
        if (replayEvents.length > 0) {
            const reason = trigger === 'control_refresh' ? '总控立即刷新' : '总控重启补发';
            log(`[${reason}] ${replayEvents.length} 条最新数据 | 房间: ${roomId}`);
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
                const completedRefreshIds = new Set(batch
                    .map(event => event.controlRefreshRequestId)
                    .filter(Boolean));
                activeBatch = null;
                state.sentCount += batch.length;
                state.connected = true;
                updateHud();
                flushPendingEvents();
                let refreshCompleted = false;
                for (const requestId of completedRefreshIds) {
                    const stillPending = activeBatch?.some(event => event.controlRefreshRequestId === requestId) ||
                        state.pendingQueue.some(event => event.controlRefreshRequestId === requestId);
                    if (!stillPending) {
                        state.refreshRequestAckId = requestId;
                        refreshCompleted = true;
                    }
                }
                if (refreshCompleted) sendHeartbeat();
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

    function sendHeartbeat() {
        if (!isActiveLivePage()) {
            updateHud();
            return;
        }
        if (state.heartbeatInFlight) return;

        state.heartbeatInFlight = true;
        sendToBackend(
            '/api/sentinel/heartbeat',
            {
                sentinelVersion: CONFIG.version,
                roomId,
                shopName: state.shopName || '',
                capturedCount: state.capturedCount,
                sentCount: state.sentCount,
                refreshRequestAckId: state.refreshRequestAckId,
                timestampIso: new Date().toISOString()
            },
            (responseText) => {
                state.heartbeatInFlight = false;
                let response = {};
                try {
                    response = JSON.parse(responseText || '{}');
                } catch {}
                let nextServerInstanceId = '';
                nextServerInstanceId = String(response.serverInstanceId || '');
                const nextRefreshRequestId = String(response.refreshRequestId || '');
                const serverRestarted = Boolean(state.serverInstanceId && nextServerInstanceId &&
                    state.serverInstanceId !== nextServerInstanceId);
                const refreshRequested = Boolean(nextRefreshRequestId &&
                    nextRefreshRequestId !== state.refreshRequestId);
                if (nextServerInstanceId) state.serverInstanceId = nextServerInstanceId;
                if (nextRefreshRequestId) state.refreshRequestId = nextRefreshRequestId;
                state.connected = true;
                state.lastHeartbeatTs = Date.now();
                updateHud();
                if (refreshRequested) replayLatestState('control_refresh', nextRefreshRequestId);
                else if (serverRestarted) replayLatestState('reconnect');
            },
            () => {
                state.heartbeatInFlight = false;
                state.connected = false;
                updateHud();
            }
        );
    }

    setInterval(sendHeartbeat, CONFIG.heartbeatIntervalMs);

    // =========================================================================
    // 6. 页面网络响应监听
    // =========================================================================

    function installNetworkHooks(pageWindow, paths, canCapture, notify) {
        const xhrPrototype = pageWindow.XMLHttpRequest.prototype;
        const { open, send } = xhrPrototype;
        const eventPrototype = pageWindow.EventTarget?.prototype || xhrPrototype;
        const { addEventListener, removeEventListener } = eventPrototype;
        const observers = new WeakMap();

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
            const result = open.apply(this, [method, url, ...args]);
            observers.get(this)?.();
            // 在页面注册后续回调前开始监听，防止响应被同步清空。
            if (canCapture()) observeXhr(this, targetUrl(url));
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
    // 7. 使用罗盘原生配置应用八项指标
    // =========================================================================
    const compassPreset = [
        { label: '千次观看用户支付金额', field: 'gpm_amount_yuan', indexName: 'gpm' },
        { label: '观看-成交率(人数)', field: 'watch_pay_ucnt_ratio', indexName: 'watch_pay_ucnt_ratio' },
        { label: '人均观看时长', field: 'avg_watch_duration_seconds', indexName: 'avg_watch_duration' },
        { label: '投放消耗(店铺绑定)', field: 'ad_cost_yuan', indexName: 'stat_cost' },
        { label: '成交老粉占比', field: 'old_fans_pay_ucnt_ratio', indexName: 'old_fans_pay_ucnt_ratio' },
        { label: '观看-互动率(人数)', field: 'interact_watch_ucnt_ratio', indexName: 'interact_watch_ucnt_ratio' },
        { label: '观看-关注率(人数)', field: 'follow_anchor_watch_ucnt_ratio', indexName: 'follow_anchor_watch_ucnt_ratio' },
        { label: '退款金额占比', field: 'real_refund_amt_ratio', indexName: 'real_refund_amt_ratio' }
    ];
    const minMetricCount = 6;
    const maxMetricCount = 12;
    const presetLabels = new Set(compassPreset.map(metric => metric.label));
    let presetState = 'idle';
    let presetMessage = '等待开始';

    function setPresetStatus(status, message) {
        presetState = status;
        presetMessage = message;
        updateHud();
    }

    function findMetricDialog() {
        return [...document.querySelectorAll('[class*="checkboxModalWrap"]')]
            .find(dialog => dialog.getClientRects().length > 0);
    }

    function readMetricOptions(dialog) {
        return [...dialog.querySelectorAll('input[type="checkbox"]')]
            .map(input => ({ input, label: input.closest('label')?.textContent.trim() }));
    }

    function findDialogButton(dialog, label) {
        return [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === label);
    }

    function invalidMetricCount(count) {
        return count < minMetricCount || count > maxMetricCount;
    }

    function hasExactIndexSelection(payload, requiredFields) {
        const selected = Array.isArray(payload?.indexSelected) ? payload.indexSelected.map(String) : [];
        const required = new Set(requiredFields);
        return selected.length === required.size && selected.every(field => required.has(field));
    }

    function hasCurrentCompassPreset() {
        const latest = state.latestResponses.get('coreData');
        return latest?.status === 'parsed' && hasExactIndexSelection(
            latest.payload,
            compassPreset.map(metric => metric.indexName)
        );
    }

    function metricDialogProblem() {
        const dialog = findMetricDialog();
        if (!dialog) return '罗盘指标配置未打开';
        const options = readMetricOptions(dialog);
        if (!options.length) return '罗盘指标选项未加载';
        if (compassPreset.some(metric => !options.some(item => item.label === metric.label))) {
            return '当前罗盘缺少预设指标';
        }
        if (invalidMetricCount(options.filter(item => item.input.checked).length)) {
            return '罗盘选中项须保持在 6 至 12 项';
        }
        return '';
    }

    async function waitForPreset(check, timeoutMs, message) {
        const stepMs = 80;
        for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
            if (!isActiveLivePage()) throw new Error('房间已切换');
            const result = check();
            if (result) return result;
            await new Promise(resolve => setTimeout(resolve, stepMs));
        }
        throw new Error(typeof message === 'function' ? message() : message);
    }

    async function applyCompassPreset() {
        if (!isActiveLivePage() || presetState === 'configuring' || presetState === 'waiting') return;
        if (hasCurrentCompassPreset()) {
            setPresetStatus('ready', '已检测到八项指标  无需重新配置');
            if (typeof showHudMessage === 'function') showHudMessage('success', '已配置');
            return;
        }
        setPresetStatus('configuring', '正在选择罗盘指标');

        let ownsOpenDialog = false;
        try {
            if (!findMetricDialog()) {
                const gear = await waitForPreset(
                    () => document.querySelector('[class*="topBtn--"] > [class*="config--"]'),
                    2400, '找不到罗盘核心指标设置'
                );
                if (!findMetricDialog()) {
                    ownsOpenDialog = true;
                    gear.click();
                }
            }

            // 罗盘可能先渲染弹窗，再异步填入复选框及当前勾选状态。
            setPresetStatus('configuring', '等待罗盘加载指标选项');
            await waitForPreset(() => !metricDialogProblem(), 4800, metricDialogProblem);

            const currentOptions = () => {
                const dialog = findMetricDialog();
                return dialog ? readMetricOptions(dialog) : [];
            };
            const option = label => currentOptions().find(item => item.label === label)?.input;
            const selectedOptions = () => currentOptions().filter(item => item.input.checked);
            const checkSelectedCount = (selected) => {
                if (invalidMetricCount(selected.length)) {
                    throw new Error('罗盘选中项须保持在 6 至 12 项');
                }
            };
            const missing = compassPreset.filter(metric => !option(metric.label)?.checked);
            let selectionChanged = false;
            setPresetStatus('configuring', '正在选择罗盘指标');

            for (const { label } of missing) {
                if (!isActiveLivePage()) throw new Error('房间已切换');
                const selected = selectedOptions();
                checkSelectedCount(selected);
                const target = option(label);
                if (!target) throw new Error('罗盘指标选项已变化，请重试');
                if (target.checked) continue;
                if (target.disabled || selected.length === maxMetricCount) {
                    if (selected.length === minMetricCount) throw new Error('当前仅选中 6 项，所需指标暂不可选');
                    const replaceable = selected
                        .filter(item => !item.input.disabled && item.label && !presetLabels.has(item.label));
                    const removed = replaceable[0];
                    if (!removed) throw new Error('罗盘没有可替换的指标位置');
                    removed.input.click();
                    selectionChanged = true;
                    await waitForPreset(() => option(removed.label)?.checked === false && option(label)?.disabled === false,
                        1200, '罗盘未释放指标位置');
                }
                const enabledTarget = option(label);
                if (!enabledTarget || enabledTarget.disabled) throw new Error('罗盘指标暂不可选');
                enabledTarget.click();
                selectionChanged = true;
                await waitForPreset(() => option(label)?.checked, 1200, '罗盘未勾选指标');
            }

            // 项目只消费这八项。补齐目标项后清掉所有其他项，避免“包含八项”被误判成“仅有八项”。
            for (const extra of selectedOptions().filter(item => item.label && !presetLabels.has(item.label))) {
                const current = option(extra.label);
                if (!current || current.disabled) throw new Error('罗盘多余指标暂不可取消');
                current.click();
                selectionChanged = true;
                await waitForPreset(() => option(extra.label)?.checked === false, 1200, '罗盘未取消多余指标');
            }

            if (!isActiveLivePage()) throw new Error('房间已切换');
            const finalSelection = selectedOptions();
            if (finalSelection.length !== compassPreset.length ||
                compassPreset.some(metric => !option(metric.label)?.checked) ||
                finalSelection.some(item => !presetLabels.has(item.label))) {
                throw new Error('罗盘指标未严格配置为目标八项');
            }
            const dialog = findMetricDialog();
            const action = dialog && findDialogButton(dialog, selectionChanged || !ownsOpenDialog ? '确认' : '取消');
            if (!action || action.disabled) throw new Error('罗盘指标配置暂时无法提交');

            const previousResponse = state.latestResponses.get('coreData');
            setPresetStatus('waiting', '已选定八项，等待罗盘返回');
            action.click();
            await waitForPreset(() => !findMetricDialog(), 2400, '罗盘指标配置未关闭');
            ownsOpenDialog = false;

            await waitForPreset(() => {
                const response = state.latestResponses.get('coreData');
                return response && response !== previousResponse && response.status === 'parsed' &&
                    compassPreset.every(metric => Number.isFinite(response.payload?.[metric.field]));
            }, 16000, '等待八项指标超时，可重新配置');
            setPresetStatus('ready', '八项指标配置完成');
        } catch (error) {
            if (ownsOpenDialog && isActiveLivePage()) {
                const dialog = findMetricDialog();
                if (dialog) findDialogButton(dialog, '取消')?.click();
            }
            setPresetStatus('error', sanitizeText(error.message) || '罗盘指标配置失败');
        }
    }

    const productPreset = [
        { label: '累计用户支付金额', field: 'pay_amt' },
        { label: '商品曝光人数', field: 'product_show_ucnt' },
        { label: '商品点击人数', field: 'product_click_ucnt' },
        { label: '曝光-点击转化率', field: 'product_show_click_ucnt_ratio' },
        { label: '点击-成交转化率', field: 'product_click_pay_ucnt_ratio' },
        { label: '商品千次曝光成交', field: 'gpm' }
    ];
    const productPresetLabels = new Set(productPreset.map(metric => metric.label));
    let productPresetState = 'idle';
    let productPresetMessage = '等待配置';

    function setProductPresetStatus(status, message) {
        productPresetState = status;
        productPresetMessage = message;
        updateHud();
    }

    function visibleElementByText(selector, label) {
        return [...document.querySelectorAll(selector)].find(element =>
            element.getClientRects().length > 0 && element.textContent.trim() === label
        );
    }

    function findProductTab() {
        return [...document.querySelectorAll('a[href="#product"], a[href$="#product"], [role="tab"]')]
            .find(element => element.getAttribute('href')?.endsWith('#product') || element.textContent.includes('商品'));
    }

    function findProductPaymentHeader() {
        return visibleElementByText('th, [role="columnheader"]', '累计用户支付金额');
    }

    function hasCurrentProductPreset() {
        const envelope = state.productCollection.latestEnvelope;
        return hasExactIndexSelection(envelope, productPreset.map(metric => metric.field)) &&
            envelope?.sort?.field === 'pay_amt' && envelope?.sort?.order === 'desc';
    }

    async function applyProductPreset() {
        if (!isActiveLivePage() || productPresetState === 'configuring') return;
        startProductCollectionCycle();
        if (hasCurrentProductPreset()) {
            state.productCollection.configurationReady = true;
            setProductPresetStatus('ready', '已检测到六项指标  支付金额倒序');
            if (typeof showHudMessage === 'function') showHudMessage('success', '已配置');
            flushDueProductReport();
            updateProductReportStatus();
            return;
        }
        state.productCollection.configurationReady = false;
        setProductPresetStatus('configuring', '正在打开商品列表');

        let ownsOpenDialog = false;
        try {
            const productTab = findProductTab();
            if (!productTab) throw new Error('找不到罗盘商品列表');
            const tabActive = window.location.hash === '#product' || productTab.getAttribute('aria-selected') === 'true';
            if (!tabActive) productTab.click();

            const configButton = await waitForPreset(
                () => visibleElementByText('button', '配置列表'),
                4000, '找不到商品配置列表按钮'
            );
            if (!findMetricDialog()) {
                ownsOpenDialog = true;
                configButton.click();
            }

            setProductPresetStatus('configuring', '等待商品指标选项');
            await waitForPreset(() => {
                const dialog = findMetricDialog();
                const options = dialog ? readMetricOptions(dialog) : [];
                return options.length > 0 && productPreset.every(metric =>
                    options.some(item => item.label === metric.label)
                );
            }, 4800, '当前商品列表缺少所需指标');

            const currentOptions = () => {
                const dialog = findMetricDialog();
                return dialog ? readMetricOptions(dialog) : [];
            };
            const option = label => currentOptions().find(item => item.label === label)?.input;
            const selectedOptions = () => currentOptions().filter(item => item.input.checked);
            let selectionChanged = false;
            setProductPresetStatus('configuring', '正在选择六项商品指标');

            for (const { label } of productPreset) {
                if (option(label)?.checked) continue;
                const selected = selectedOptions();
                if (selected.length >= productPreset.length || option(label)?.disabled) {
                    const removable = selected.find(item =>
                        item.label && !productPresetLabels.has(item.label) && !item.input.disabled
                    );
                    if (!removable) throw new Error('商品列表没有可替换的指标位置');
                    removable.input.click();
                    selectionChanged = true;
                    await waitForPreset(() => option(removable.label)?.checked === false && option(label)?.disabled === false,
                        1200, '商品列表未释放指标位置');
                }
                const target = option(label);
                if (!target || target.disabled) throw new Error('商品指标暂不可选');
                target.click();
                selectionChanged = true;
                await waitForPreset(() => option(label)?.checked, 1200, '商品指标未勾选');
            }

            for (const extra of selectedOptions().filter(item => item.label && !productPresetLabels.has(item.label))) {
                const current = option(extra.label);
                if (!current || current.disabled) throw new Error('商品多余指标暂不可取消');
                current.click();
                selectionChanged = true;
                await waitForPreset(() => option(extra.label)?.checked === false, 1200, '商品多余指标未取消');
            }

            const finalSelection = selectedOptions();
            if (finalSelection.length !== productPreset.length ||
                productPreset.some(metric => !option(metric.label)?.checked) ||
                finalSelection.some(item => !productPresetLabels.has(item.label))) {
                throw new Error('商品指标未严格配置为目标六项');
            }

            const dialog = findMetricDialog();
            const action = dialog && findDialogButton(dialog, selectionChanged || !ownsOpenDialog ? '确认' : '取消');
            if (!action || action.disabled) throw new Error('商品指标配置暂时无法提交');
            action.click();
            await waitForPreset(() => !findMetricDialog(), 2400, '商品指标配置未关闭');
            ownsOpenDialog = false;

            setProductPresetStatus('configuring', '正在设置支付金额倒序');
            await waitForPreset(findProductPaymentHeader, 4000, '找不到累计用户支付金额表头');
            for (let attempt = 0; attempt < 3; attempt++) {
                const header = findProductPaymentHeader();
                if (!header) throw new Error('累计用户支付金额表头已变化');
                const direction = header.getAttribute('aria-sort');
                if (direction === 'descending') break;
                header.click();
                await waitForPreset(() => {
                    const current = findProductPaymentHeader();
                    return current && current.getAttribute('aria-sort') !== direction;
                }, 1600, '商品列表排序状态未更新');
            }
            if (findProductPaymentHeader()?.getAttribute('aria-sort') !== 'descending') {
                throw new Error('累计用户支付金额未设置为倒序');
            }
            state.productCollection.configurationReady = true;
            setProductPresetStatus('ready', '六项商品指标  支付金额倒序');
            flushDueProductReport();
            updateProductReportStatus();
        } catch (error) {
            state.productCollection.configurationReady = false;
            if (ownsOpenDialog && isActiveLivePage()) {
                const dialog = findMetricDialog();
                if (dialog) findDialogButton(dialog, '取消')?.click();
            }
            setProductPresetStatus('error', sanitizeText(error.message) || '商品指标配置失败');
        }
    }

    // =========================================================================
    // 8. 罗盘控制面板
    // =========================================================================
    const captureStatus = {
        parsed: '已解析',
        empty: '无可用数据',
        apiError: '接口返回错误',
        readError: '响应读取失败',
        invalidJson: '响应不是有效 JSON',
        parseError: '解析失败'
    };
    const panelMoney = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
    const panelTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    let hud = null;
    let elementPlusStylesInstalled = false;
    let fallbackToastTimer = null;
    let uiFrameworkLoadAttempted = false;
    let vueRuntime = null;
    let elementPlusRuntime = null;

    function loadUiFrameworks() {
        if (globalThis.Vue && globalThis.ElementPlus) {
            vueRuntime = globalThis.Vue;
            elementPlusRuntime = globalThis.ElementPlus;
            return true;
        }
        if (uiFrameworkLoadAttempted || typeof GM_getResourceText !== 'function') return false;
        uiFrameworkLoadAttempted = true;

        try {
            const vueSource = GM_getResourceText('vueRuntimeJs');
            const elementPlusSource = GM_getResourceText('elementPlusJs');
            if (!vueSource || !elementPlusSource) throw new Error('框架资源未加载');

            // Tampermonkey 在部分 Edge 环境中会隔离多个 @require 的全局变量。
            // 将两个固定版本资源放进同一个沙箱全局执行，确保 Element Plus 能读取 globalThis.Vue。
            (0, eval)(`${vueSource}\n;globalThis.Vue = Vue;\n${elementPlusSource}\n//# sourceURL=douyin-sentinel-ui-frameworks.js`);
        } catch (error) {
            log('Vue 面板依赖加载失败，使用原生面板:', error?.message || error);
            return false;
        }

        vueRuntime = globalThis.Vue || null;
        elementPlusRuntime = globalThis.ElementPlus || null;
        return Boolean(vueRuntime && elementPlusRuntime);
    }

    function showHudMessage(type, message) {
        const safeMessage = sanitizeText(String(message || ''));
        if (!safeMessage) return;
        const messageApi = elementPlusRuntime?.ElMessage || globalThis.ElementPlus?.ElMessage;
        if (typeof messageApi === 'function') {
            messageApi({ type, message: safeMessage, duration: 1800, showClose: false });
            return;
        }
        if (!hud?.root) return;
        let toast = hud.root.querySelector('#douyin-sentinel-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'douyin-sentinel-toast';
            if (toast.style) Object.assign(toast.style, {
                position: 'absolute',
                right: '12px',
                bottom: '54px',
                zIndex: '5',
                padding: '8px 16px',
                border: '1px solid rgba(255, 255, 255, 0.16)',
                borderRadius: '9999px',
                background: 'linear-gradient(180deg, rgba(28, 30, 38, 0.88) 0%, rgba(14, 15, 20, 0.96) 100%)',
                backdropFilter: 'blur(18px) saturate(180%)',
                webkitBackdropFilter: 'blur(18px) saturate(180%)',
                color: '#30d158',
                boxShadow: '0 14px 34px rgba(0, 0, 0, 0.55), inset 0 1px 1px rgba(255, 255, 255, 0.28)',
                fontSize: '12px',
                fontWeight: '600'
            });
            hud.root.appendChild(toast);
        }
        toast.textContent = safeMessage;
        toast.hidden = false;
        if (fallbackToastTimer) clearTimeout(fallbackToastTimer);
        fallbackToastTimer = setTimeout(() => { toast.hidden = true; }, 1800);
    }

    function createHud() {
        if (hud || !document.body || !isActiveLivePage()) return;
        if (loadUiFrameworks()) {
            try {
                createVueHud();
                return;
            } catch (error) {
                log('Vue 面板挂载失败，使用原生面板:', error?.message || error);
                try { hud?.app?.unmount?.(); } catch {}
                hud?.host?.remove?.();
                hud = null;
            }
        }
        createLegacyHud();
    }

    function createVueHud() {
        const Vue = vueRuntime;
        const ElementPlus = elementPlusRuntime;
        if (!Vue || !ElementPlus) throw new Error('Vue 面板运行时不可用');
        const host = document.createElement('div');
        host.id = 'douyin-sentinel-hud';
        const root = host.attachShadow({ mode: 'open' });
        const elementPlusCss = typeof GM_getResourceText === 'function' ?
            GM_getResourceText('elementPlusCss') : '';
        if (elementPlusCss) {
            const libraryStyle = document.createElement('style');
            libraryStyle.textContent = elementPlusCss;
            root.appendChild(libraryStyle);
            if (!elementPlusStylesInstalled && typeof GM_addStyle === 'function') {
                GM_addStyle(`${elementPlusCss}\n.el-message{background:linear-gradient(180deg, rgba(28,30,38,0.9), rgba(14,15,20,0.96))!important;border:1px solid rgba(255,255,255,0.16)!important;border-radius:999px!important;backdrop-filter:blur(18px) saturate(180%)!important;-webkit-backdrop-filter:blur(18px) saturate(180%)!important;color:#f5f5f7!important;box-shadow:0 14px 34px rgba(0,0,0,0.55),inset 0 1px 1px rgba(255,255,255,0.28)!important}.el-message__content{color:inherit!important}`);
                elementPlusStylesInstalled = true;
            }
        }
        const style = document.createElement('style');
        style.textContent = `
            :host {
                position: fixed;
                right: 18px;
                bottom: 18px;
                z-index: 2147483647;
                width: min(416px, calc(100vw - 36px));
                font: 13px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
                color: #f5f5f7;
                color-scheme: dark;
                --el-color-primary: #30d158;
                --el-color-primary-light-3: #52dc74;
                --el-color-primary-light-5: #77e592;
                --el-color-primary-dark-2: #24a946;
                --el-bg-color: rgba(18, 20, 26, 0.85);
                --el-bg-color-overlay: rgba(26, 28, 36, 0.92);
                --el-fill-color-blank: rgba(18, 20, 26, 0.72);
                --el-fill-color-light: rgba(255, 255, 255, 0.05);
                --el-border-color: rgba(255, 255, 255, 0.14);
                --el-border-color-light: rgba(255, 255, 255, 0.08);
                --el-text-color-primary: #f5f5f7;
                --el-text-color-regular: #d1d1d6;
                --el-text-color-secondary: #8e8e93;
                --mint: #30d158;
                --mint-glow: rgba(48, 209, 88, 0.32);
                --amber: #ff9f0a;
                --muted: #8e8e93;
                --line: rgba(255, 255, 255, 0.08);
                --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
                --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
                --ease-spring: cubic-bezier(0.22, 1, 0.36, 1);
            }
            *, *::before, *::after { box-sizing: border-box; }
            :host([hidden]), [hidden] { display: none !important; }
            .sentinel-frame { width: 100%; }
            .sentinel-card {
                max-height: min(620px, calc(100dvh - 88px));
                overflow: hidden;
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 20px;
                background: linear-gradient(180deg, rgba(24, 26, 32, 0.82) 0%, rgba(12, 13, 17, 0.92) 100%);
                backdrop-filter: blur(28px) saturate(185%);
                -webkit-backdrop-filter: blur(28px) saturate(185%);
                box-shadow: 0 28px 64px rgba(0, 0, 0, 0.65),
                            inset 0 1px 1px 0 rgba(255, 255, 255, 0.34),
                            inset 0 -1px 2px 0 rgba(0, 0, 0, 0.45);
                transform-origin: bottom right;
                transition: transform 0.34s var(--ease-spring), opacity 0.22s var(--ease-out);
            }
            @starting-style {
                .sentinel-card {
                    opacity: 0;
                    transform: translateY(10px) scale(0.92);
                }
            }
            .sentinel-card > .el-card__body { padding: 0; }
            .panel-head { padding: 16px 18px 14px; border-bottom: 1px solid var(--line); }
            .head-line { display: flex; align-items: center; gap: 8px; }
            h2 { margin: 0 auto 0 0; font-size: 16px; font-weight: 600; line-height: 1.3; letter-spacing: -0.015em; color: #f5f5f7; }
            .room { margin: 6px 0 0; color: var(--muted); overflow-wrap: anywhere; font-size: 12px; letter-spacing: 0.01em; }
            .connection.el-tag {
                --el-tag-bg-color: rgba(255, 159, 10, 0.12);
                --el-tag-border-color: rgba(255, 159, 10, 0.32);
                --el-tag-text-color: var(--amber);
                border-radius: 9999px;
                letter-spacing: 0.015em;
            }
            .connection.connected.el-tag {
                --el-tag-text-color: var(--mint);
                --el-tag-border-color: rgba(48, 209, 88, 0.38);
                --el-tag-bg-color: rgba(48, 209, 88, 0.14);
            }
            .settings.el-button {
                padding-inline: 10px;
                color: #d1d1d6;
                border-radius: 9999px;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.12);
                transition: transform 100ms var(--ease-out), background-color 0.16s ease, color 0.16s ease;
            }
            .settings.el-button:active { transform: scale(0.95); }
            @media (hover: hover) and (pointer: fine) {
                .settings.el-button:hover { background: rgba(255, 255, 255, 0.12); color: #ffffff; }
            }
            .preset {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 12px 18px;
                border-bottom: 1px solid var(--line);
                background: rgba(255, 255, 255, 0.02);
            }
            .preset strong { display: block; font-size: 13px; font-weight: 600; color: #f5f5f7; }
            .preset-status { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; letter-spacing: 0.015em; }
            .preset-status[data-state="ready"] { color: var(--mint); }
            .preset-status[data-state="error"] { color: var(--amber); }
            .start.el-button {
                min-width: 88px;
                font-weight: 600;
                border-radius: 9999px;
                background: var(--mint);
                border: none;
                color: #06180b;
                transition: transform 100ms var(--ease-out), background-color 0.16s ease, box-shadow 0.16s ease;
            }
            .start.el-button:active:not(:disabled) { transform: scale(0.95); }
            @media (hover: hover) and (pointer: fine) {
                .start.el-button:hover:not(:disabled) {
                    background: #42df6a;
                    box-shadow: 0 4px 14px var(--mint-glow);
                }
            }
            .counters {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                border-bottom: 1px solid var(--line);
                background: rgba(0, 0, 0, 0.28);
            }
            .counter { padding: 10px 12px 11px 18px; }
            .counter + .counter { border-left: 1px solid var(--line); }
            .counter-label { color: var(--muted); font-size: 11px; letter-spacing: 0.02em; }
            .counter-value { margin-top: 2px; font: 600 21px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: #f5f5f7; }
            .counter:first-child .counter-value { color: var(--mint); }
            .body { min-height: 0; padding: 12px 18px 16px; }
            .body h3 { margin: 0 0 8px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
            .empty {
                margin: 0;
                padding: 16px 14px;
                color: var(--muted);
                border: 1px dashed rgba(255, 255, 255, 0.16);
                border-radius: 12px;
                background: rgba(255, 255, 255, 0.025);
                font-size: 12px;
                text-align: center;
            }
            .event { border-bottom: 1px solid var(--line); }
            .event:last-child { border-bottom: none; }
            .event > summary { cursor: pointer; list-style: none; padding: 9px 0; transition: transform 100ms var(--ease-out); }
            .event > summary:active { transform: scale(0.99); }
            .event > summary::-webkit-details-marker { display: none; }
            .row-line { display: flex; align-items: center; gap: 8px; }
            .row-line > strong { margin-right: auto; font-size: 12px; color: #f5f5f7; }
            .row-line::after { content: "+"; width: 12px; text-align: center; color: var(--muted); }
            .event[open] .row-line::after { content: "−"; }
            .meta { color: var(--muted); font: 11px/1.5 var(--mono); font-variant-numeric: tabular-nums; }
            .status { color: var(--amber); font-size: 11px; letter-spacing: 0.015em; }
            .event[data-status="parsed"] .status { color: var(--mint); }
            .data-summary { display: block; color: #d1d1d6; font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
            .raw { margin: 0 0 11px; color: var(--muted); font-size: 11px; }
            .raw > summary { cursor: pointer; }
            pre {
                max-height: 225px;
                overflow: auto;
                padding: 10px;
                margin: 4px 0 8px;
                border: 1px solid var(--line);
                border-radius: 10px;
                background: rgba(0, 0, 0, 0.45);
                color: #d1d1d6;
                font: 11px/1.55 var(--mono);
                white-space: pre-wrap;
                overflow-wrap: anywhere;
                user-select: text;
            }
            .toggle-row { display: flex; justify-content: flex-end; margin-top: 10px; }
            #douyin-sentinel-toggle.el-button {
                height: 40px;
                padding-inline: 18px;
                border-radius: 9999px;
                border: 1px solid rgba(255, 255, 255, 0.18);
                background: linear-gradient(180deg, rgba(28, 30, 38, 0.86) 0%, rgba(14, 15, 20, 0.94) 100%);
                backdrop-filter: blur(22px) saturate(185%);
                -webkit-backdrop-filter: blur(22px) saturate(185%);
                color: #f5f5f7;
                box-shadow: 0 12px 30px rgba(0, 0, 0, 0.52),
                            inset 0 1px 1px rgba(255, 255, 255, 0.34),
                            inset 0 -1px 1px rgba(0, 0, 0, 0.35);
                transition: transform 110ms var(--ease-out), border-color 0.18s ease, box-shadow 0.18s ease;
            }
            #douyin-sentinel-toggle.el-button:active { transform: scale(0.95); }
            @media (hover: hover) and (pointer: fine) {
                #douyin-sentinel-toggle.el-button:hover {
                    border-color: rgba(255, 255, 255, 0.28);
                    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.6),
                                inset 0 1px 1px rgba(255, 255, 255, 0.42);
                    color: #ffffff;
                }
            }
            .toggle-status { margin-left: 5px; color: var(--mint); font-size: 12px; font-weight: 500; }
            .chevron { margin-left: 4px; color: var(--muted); font-size: 11px; transition: transform 0.26s var(--ease-spring); }
            [aria-expanded="true"] .chevron { transform: rotate(180deg); }
            @media (prefers-reduced-motion: reduce) {
                *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
            }
            @media (prefers-reduced-transparency: reduce) {
                .sentinel-card, #douyin-sentinel-toggle.el-button { backdrop-filter: none; -webkit-backdrop-filter: none; background: #16181f; }
            }
        `;
        root.appendChild(style);
        const mountNode = document.createElement('div');
        mountNode.id = 'douyin-sentinel-vue-root';
        root.appendChild(mountNode);

        const model = Vue.reactive({
            active: true,
            expanded: false,
            connected: false,
            roomText: `房间 ${roomId}`,
            toggleStatus: '等待响应',
            presetState: 'idle',
            presetMessage: '等待开始',
            productPresetState: 'idle',
            productPresetMessage: '等待配置',
            responseCount: 0,
            capturedCount: 0,
            sentCount: 0,
            rows: []
        });
        const component = {
            setup() {
                const togglePanel = () => {
                    model.expanded = !model.expanded;
                    updateHud();
                };
                const openSettings = () => {
                    const newUrl = prompt('设置本地总控服务地址', CONFIG.backendUrl);
                    if (newUrl && newUrl.trim()) {
                        CONFIG.backendUrl = newUrl.trim();
                        GM_setValue('backend_url', CONFIG.backendUrl);
                        showHudMessage('success', `已更新总控地址为 ${CONFIG.backendUrl}`);
                    }
                };
                return {
                    model,
                    togglePanel,
                    openSettings,
                    applyCompassPreset,
                    applyProductPreset
                };
            },
            template: `
                <div class="sentinel-frame" v-show="model.active">
                    <el-card v-show="model.expanded" class="sentinel-card" id="douyin-sentinel-panel" shadow="never" aria-labelledby="douyin-sentinel-title">
                        <header class="panel-head">
                            <div class="head-line">
                                <h2 id="douyin-sentinel-title">罗盘控制面板</h2>
                                <el-tag class="connection" :class="{ connected: model.connected }" size="small" effect="plain" id="douyin-sentinel-connection">{{ model.connected ? '总控已连接' : '等待总控连接' }}</el-tag>
                                <el-button class="settings" id="douyin-sentinel-settings" size="small" text @click="openSettings">总控设置</el-button>
                            </div>
                            <p class="room" id="douyin-sentinel-room">{{ model.roomText }}</p>
                        </header>
                        <div class="preset">
                            <div>
                                <strong>核心指标预设</strong>
                                <span class="preset-status" id="douyin-sentinel-preset-status" role="status" :data-state="model.presetState">{{ model.presetMessage }}</span>
                            </div>
                            <el-button class="start" id="douyin-sentinel-start" type="primary" size="small" :loading="model.presetState === 'configuring'" :disabled="model.presetState === 'waiting'" @click="applyCompassPreset">{{ model.presetState === 'ready' ? '重新配置' : '开始采集' }}</el-button>
                        </div>
                        <div class="preset">
                            <div>
                                <strong>商品列表采集</strong>
                                <span class="preset-status" id="douyin-sentinel-product-status" role="status" :data-state="model.productPresetState">{{ model.productPresetMessage }}</span>
                            </div>
                            <el-button class="start" id="douyin-sentinel-product-start" type="primary" size="small" :loading="model.productPresetState === 'configuring'" @click="applyProductPreset">{{ model.productPresetState === 'ready' ? '重新配置商品' : '开始商品采集' }}</el-button>
                        </div>
                        <div class="counters">
                            <div class="counter"><div class="counter-label">监听响应</div><div class="counter-value" id="douyin-sentinel-response-count">{{ model.responseCount }}</div></div>
                            <div class="counter"><div class="counter-label">成功解析</div><div class="counter-value" id="douyin-sentinel-captured-count">{{ model.capturedCount }}</div></div>
                            <div class="counter"><div class="counter-label">已回传</div><div class="counter-value" id="douyin-sentinel-sent-count">{{ model.sentCount }}</div></div>
                        </div>
                        <el-scrollbar max-height="300px">
                            <div class="body">
                                <h3>各接口最新响应</h3>
                                <div id="douyin-sentinel-events">
                                    <p v-if="model.rows.length === 0" class="empty" id="douyin-sentinel-empty">等待罗盘页面返回目标接口数据</p>
                                    <details v-for="row in model.rows" :key="row.id" class="event" :data-route="row.id" :data-status="row.status">
                                        <summary>
                                            <span class="row-line"><strong>{{ row.label }}</strong><span class="meta">{{ row.meta }}</span><span class="status">{{ row.statusText }}</span></span>
                                            <span v-show="row.hasPayload" class="data-summary">{{ row.summary }}</span>
                                        </summary>
                                        <pre v-show="row.hasPayload" class="parsed" aria-label="解析数据">{{ row.parsedText }}</pre>
                                        <details v-show="row.hasPreview" class="raw"><summary>{{ row.rawLabel }}</summary><pre>{{ row.rawPreview }}</pre></details>
                                    </details>
                                </div>
                            </div>
                        </el-scrollbar>
                    </el-card>
                    <div class="toggle-row">
                        <el-button id="douyin-sentinel-toggle" type="default" :aria-expanded="String(model.expanded)" aria-controls="douyin-sentinel-panel" @click="togglePanel">
                            <strong>罗盘哨兵</strong><span class="toggle-status" id="douyin-sentinel-toggle-status">{{ model.toggleStatus }}</span><span class="chevron" aria-hidden="true">⌃</span>
                        </el-button>
                    </div>
                </div>
            `
        };
        const app = Vue.createApp(component);
        app.use(ElementPlus);
        app.mount(mountNode);
        hud = { host, root, model, app, vue: true };
        root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && model.expanded) {
                event.stopPropagation();
                model.expanded = false;
                Vue.nextTick(() => root.querySelector('#douyin-sentinel-toggle')?.focus());
            }
        });
        document.body.appendChild(host);
        updateHud();
    }

    function createLegacyHud() {

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
                    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
                    color: #f5f5f7;
                    color-scheme: dark;
                    --muted: #8e8e93;
                    --line: rgba(255, 255, 255, 0.08);
                    --mint: #30d158;
                    --mint-glow: rgba(48, 209, 88, 0.32);
                    --amber: #ff9f0a;
                    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
                    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
                    --ease-spring: cubic-bezier(0.22, 1, 0.36, 1);
                }
                *, *::before, *::after { box-sizing: border-box; }
                :host([hidden]), [hidden] { display: none !important; }
                button { font: inherit; cursor: pointer; color: inherit; touch-action: manipulation; }
                button:focus-visible, summary:focus-visible { outline: 2px solid var(--mint); outline-offset: 3px; }
                #douyin-sentinel-toggle {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin: 10px 0 0 auto;
                    padding: 10px 18px;
                    border-radius: 9999px;
                    border: 1px solid rgba(255, 255, 255, 0.18);
                    background: linear-gradient(180deg, rgba(28, 30, 38, 0.86) 0%, rgba(14, 15, 20, 0.94) 100%);
                    backdrop-filter: blur(22px) saturate(185%);
                    -webkit-backdrop-filter: blur(22px) saturate(185%);
                    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.52),
                                inset 0 1px 1px rgba(255, 255, 255, 0.34),
                                inset 0 -1px 1px rgba(0, 0, 0, 0.35);
                    color: #f5f5f7;
                    transition: transform 110ms var(--ease-out), border-color 0.18s ease, box-shadow 0.18s ease;
                }
                #douyin-sentinel-toggle:active, .settings:active { transform: scale(0.95); }
                @media (hover: hover) and (pointer: fine) {
                    #douyin-sentinel-toggle:hover {
                        border-color: rgba(255, 255, 255, 0.28);
                        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.42);
                        color: #ffffff;
                    }
                    .settings:hover { background: rgba(255, 255, 255, 0.12); color: #ffffff; }
                }
                .toggle-status { color: var(--mint); font-size: 12px; font-weight: 500; }
                .chevron {
                    width: 7px;
                    height: 7px;
                    margin: 4px 1px 0 2px;
                    border-top: 1.5px solid var(--muted);
                    border-right: 1.5px solid var(--muted);
                    transform: rotate(-45deg);
                    transition: transform 0.26s var(--ease-spring);
                }
                [aria-expanded="true"] .chevron { margin-top: -3px; transform: rotate(135deg); }
                .panel {
                    display: flex;
                    flex-direction: column;
                    width: min(404px, calc(100vw - 36px));
                    max-height: min(600px, calc(100dvh - 88px));
                    overflow: hidden;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    border-radius: 20px;
                    background: linear-gradient(180deg, rgba(24, 26, 32, 0.82) 0%, rgba(12, 13, 17, 0.92) 100%);
                    backdrop-filter: blur(28px) saturate(185%);
                    -webkit-backdrop-filter: blur(28px) saturate(185%);
                    box-shadow: 0 28px 64px rgba(0, 0, 0, 0.65),
                                inset 0 1px 1px 0 rgba(255, 255, 255, 0.34),
                                inset 0 -1px 2px 0 rgba(0, 0, 0, 0.45);
                    transform-origin: bottom right;
                    transition: transform 0.34s var(--ease-spring), opacity 0.22s var(--ease-out);
                }
                @starting-style {
                    .panel {
                        opacity: 0;
                        transform: translateY(10px) scale(0.92);
                    }
                }
                .panel-head { padding: 16px 18px 14px; border-bottom: 1px solid var(--line); }
                .head-line, .row-line { display: flex; align-items: center; gap: 8px; }
                h2 { margin: 0 auto 0 0; font-size: 16px; font-weight: 600; line-height: 1.3; letter-spacing: -0.015em; color: #f5f5f7; }
                .connection {
                    flex: none;
                    font-size: 11px;
                    font-weight: 600;
                    letter-spacing: 0.015em;
                    color: var(--amber);
                    padding: 3px 9px;
                    border-radius: 9999px;
                    border: 1px solid rgba(255, 159, 10, 0.32);
                    background: rgba(255, 159, 10, 0.12);
                }
                .connection[data-connected="true"] {
                    color: var(--mint);
                    border-color: rgba(48, 209, 88, 0.38);
                    background: rgba(48, 209, 88, 0.14);
                }
                .settings {
                    padding: 4px 10px;
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    border-radius: 9999px;
                    background: rgba(255, 255, 255, 0.06);
                    color: #d1d1d6;
                    font-size: 11px;
                    transition: transform 100ms var(--ease-out), background-color 0.16s ease, color 0.16s ease;
                }
                .room { margin: 6px 0 0; color: var(--muted); overflow-wrap: anywhere; font-size: 12px; letter-spacing: 0.01em; }
                .preset {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    padding: 12px 18px;
                    border-bottom: 1px solid var(--line);
                    background: rgba(255, 255, 255, 0.02);
                }
                .preset strong { display: block; font-size: 13px; font-weight: 600; color: #f5f5f7; }
                .preset-status { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; letter-spacing: 0.015em; }
                .preset-status[data-state="ready"] { color: var(--mint); }
                .preset-status[data-state="error"] { color: var(--amber); }
                .start {
                    flex: none;
                    min-width: 88px;
                    padding: 7px 14px;
                    border: none;
                    border-radius: 9999px;
                    background: var(--mint);
                    color: #06180b;
                    font-weight: 600;
                    font-size: 12px;
                    transition: transform 100ms var(--ease-out), background-color 0.16s ease, box-shadow 0.16s ease;
                }
                .start:active:not(:disabled) { transform: scale(0.95); }
                @media (hover: hover) and (pointer: fine) {
                    .start:hover:not(:disabled) {
                        background: #42df6a;
                        box-shadow: 0 4px 14px var(--mint-glow);
                    }
                }
                .start:disabled { opacity: .62; cursor: wait; }
                .counters {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    margin: 0;
                    border-bottom: 1px solid var(--line);
                    background: rgba(0, 0, 0, 0.28);
                }
                .counters > div { padding: 10px 12px 11px 18px; }
                .counters > div + div { border-left: 1px solid var(--line); }
                dt { color: var(--muted); font-size: 11px; letter-spacing: 0.02em; }
                dd { margin: 2px 0 0; font: 600 21px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: #f5f5f7; }
                .counters > div:first-child dd { color: var(--mint); }
                .body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 12px 18px 16px; }
                h3 { margin: 0 0 8px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
                .empty {
                    margin: 0;
                    padding: 16px 14px;
                    color: var(--muted);
                    border: 1px dashed rgba(255, 255, 255, 0.16);
                    border-radius: 12px;
                    background: rgba(255, 255, 255, 0.025);
                    font-size: 12px;
                    text-align: center;
                }
                .event { border-bottom: 1px solid var(--line); }
                .event:last-child { border-bottom: none; }
                .event > summary { cursor: pointer; list-style: none; padding: 9px 0; transition: transform 100ms var(--ease-out); }
                .event > summary:active { transform: scale(0.99); }
                .event > summary::-webkit-details-marker { display: none; }
                .row-line > strong { margin-right: auto; font-size: 12px; color: #f5f5f7; }
                .row-line::after { content: "+"; width: 12px; text-align: center; color: var(--muted); }
                .event[open] .row-line::after { content: "−"; }
                .meta { color: var(--muted); font: 11px/1.5 var(--mono); font-variant-numeric: tabular-nums; }
                .status { color: var(--amber); font-size: 11px; letter-spacing: 0.015em; }
                .event[data-status="parsed"] .status { color: var(--mint); }
                .data-summary { display: block; color: #d1d1d6; font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
                .raw { margin: 0 0 11px; color: var(--muted); font-size: 11px; }
                .raw > summary { cursor: pointer; }
                pre {
                    max-height: 225px;
                    overflow: auto;
                    padding: 10px;
                    margin: 4px 0 8px;
                    border: 1px solid var(--line);
                    border-radius: 10px;
                    background: rgba(0, 0, 0, 0.45);
                    color: #d1d1d6;
                    font: 11px/1.55 var(--mono);
                    white-space: pre-wrap;
                    overflow-wrap: anywhere;
                    user-select: text;
                }
                @media (prefers-reduced-motion: reduce) {
                    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
                }
                @media (prefers-reduced-transparency: reduce) {
                    .panel, #douyin-sentinel-toggle { backdrop-filter: none; -webkit-backdrop-filter: none; background: #16181f; }
                }
            </style>
            <section class="panel" id="douyin-sentinel-panel" aria-labelledby="douyin-sentinel-title" hidden>
                <header class="panel-head">
                    <div class="head-line">
                        <h2 id="douyin-sentinel-title">罗盘控制面板</h2>
                        <span class="connection" id="douyin-sentinel-connection"></span>
                        <button class="settings" id="douyin-sentinel-settings" type="button">总控设置</button>
                    </div>
                    <p class="room" id="douyin-sentinel-room"></p>
                </header>
                <div class="preset">
                    <div>
                        <strong>核心指标预设</strong>
                        <span class="preset-status" id="douyin-sentinel-preset-status" role="status">等待开始</span>
                    </div>
                    <button class="start" id="douyin-sentinel-start" type="button">开始采集</button>
                </div>
                <div class="preset">
                    <div>
                        <strong>商品列表采集</strong>
                        <span class="preset-status" id="douyin-sentinel-product-status" role="status">等待配置</span>
                    </div>
                    <button class="start" id="douyin-sentinel-product-start" type="button">开始商品采集</button>
                </div>
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
            root,
            panel: find('panel'),
            toggle: find('toggle'),
            toggleStatus: find('toggle-status'),
            connection: find('connection'),
            room: find('room'),
            start: find('start'),
            presetStatus: find('preset-status'),
            productStart: find('product-start'),
            productStatus: find('product-status'),
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
        hud.start.addEventListener('click', applyCompassPreset);
        hud.productStart.addEventListener('click', applyProductPreset);
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
            case 'PRODUCT_LIST':
                return `${payload.products.length} 个商品  ${payload.sort.field === 'pay_amt' && payload.sort.order === 'desc' ? '累计支付金额倒序' : '等待支付金额倒序'}`;
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
        row.status.textContent = [captureStatus[observation.status], observation.responseCode].filter(Boolean).join(' ');
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

        if (hud.vue) {
            const model = hud.model;
            model.active = true;
            model.toggleStatus = state.responseCount > 0 ? `响应 ${state.responseCount}` : '等待响应';
            if (!model.expanded) return;
            model.connected = state.connected;
            model.presetState = presetState;
            model.presetMessage = presetMessage;
            model.productPresetState = productPresetState;
            model.productPresetMessage = productPresetMessage;
            model.roomText = sanitizeText([state.shopName, `房间 ${roomId}`].filter(Boolean).join('  '));
            model.responseCount = state.responseCount;
            model.capturedCount = state.capturedCount;
            model.sentCount = state.sentCount;
            model.rows = captureRoutes.flatMap(route => {
                const observation = state.latestResponses.get(route.id);
                if (!observation) return [];
                const channel = observation.channel === 'fetch' ? 'Fetch' : 'XHR';
                const payload = observation.payload;
                return [{
                    id: route.id,
                    label: route.label,
                    status: observation.status,
                    meta: `${panelTime.format(observation.observedAt)}  ${channel}`,
                    statusText: [captureStatus[observation.status], observation.responseCode].filter(Boolean).join(' '),
                    hasPayload: Boolean(payload),
                    summary: payload ? sanitizeText(describePayload(payload)) : '',
                    parsedText: payload ? sanitizeText(JSON.stringify(payload, null, 2)) : '',
                    hasPreview: Boolean(observation.preview),
                    rawLabel: observation.truncated ? '原始响应（前 12,000 字符）' : '原始响应',
                    rawPreview: sanitizeText(observation.preview)
                }];
            });
            return;
        }

        hud.toggleStatus.textContent = state.responseCount > 0 ? `响应 ${state.responseCount}` : '等待响应';
        if (hud.panel.hidden) return;

        hud.connection.textContent = state.connected ? '总控已连接' : '等待总控连接';
        hud.connection.dataset.connected = String(state.connected);
        hud.start.disabled = presetState === 'configuring' || presetState === 'waiting';
        hud.start.textContent = presetState === 'ready' ? '重新配置' : '开始采集';
        if (hud.presetStatus.dataset.state !== presetState || hud.presetStatus.textContent !== presetMessage) {
            hud.presetStatus.dataset.state = presetState;
            hud.presetStatus.textContent = presetMessage;
        }
        hud.productStart.disabled = productPresetState === 'configuring';
        hud.productStart.textContent = productPresetState === 'ready' ? '重新配置商品' : '开始商品采集';
        if (hud.productStatus.dataset.state !== productPresetState || hud.productStatus.textContent !== productPresetMessage) {
            hud.productStatus.dataset.state = productPresetState;
            hud.productStatus.textContent = productPresetMessage;
        }
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
