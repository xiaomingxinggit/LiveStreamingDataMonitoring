/**
 * 抖音电商罗盘数据解析与清洗模块 (Compass Data Parser)
 * 供油猴哨兵与测试套件共用
 */

function sanitizeText(value) {
    if (typeof value !== 'string') return value || '';
    // 按照规范：使用普通空格作为分隔符，替换 middle dots (U+00B7)
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
        const match = url.match(/[?&](?:room_id|live_room_id|roomId)=([0-9]+)/i);
        if (match && match[1]) return match[1];
    }
    return '';
}

const CompassParser = {
    // 1. 基础信息解析
    parseLiveBaseInfo: function (url, json) {
        if (!json || typeof json !== 'object') return null;
        const data = json.data;
        if (!data) return null;

        const roomId = extractRoomId(url, data);

        return {
            eventType: 'ROOM_BASE_INFO',
            roomId: roomId,
            shopName: sanitizeText(data.nickname || ''),
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

    // 2. 核心大盘指标解析 (GMV、流速、人货场转化率)
    parseCoreData: function (url, json, currentContext = {}) {
        if (!json || typeof json !== 'object') return null;
        const data = json.data;
        if (!data) return null;

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
            roomId: currentContext.roomId || '',
            shopName: currentContext.shopName || '',
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

    // 3. 正在讲解商品详情解析
    parseProductExplainDetail: function (url, json, currentContext = {}) {
        if (!json || typeof json !== 'object') return null;
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
            roomId: currentContext.roomId || '',
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

    // 4. 实时公屏弹幕解析
    parseComments: function (url, json, currentContext = {}) {
        if (!json || typeof json !== 'object') return null;
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
            roomId: currentContext.roomId || '',
            comments: comments
        };
    },

    // 5. 弹幕聚类关键词解析
    parseCommentCluster: function (url, json, currentContext = {}) {
        if (!json || typeof json !== 'object') return null;
        const data = json.data;
        if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;

        const clusters = data.items.map(item => ({
            keyword: sanitizeText(item.keyword || item.word || ''),
            count: Number(item.count || 0),
            ratio: Number(item.ratio || 0)
        }));

        return {
            eventType: 'COMMENT_CLUSTER',
            roomId: currentContext.roomId || '',
            clusters: clusters
        };
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        sanitizeText,
        parsePriceCentsToYuan,
        CompassParser
    };
}
