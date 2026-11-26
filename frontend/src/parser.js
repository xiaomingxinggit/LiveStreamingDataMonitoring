/**
 * 抖音电商罗盘数据解析与清洗模块 (Compass Data Parser)
 * 供油猴哨兵与测试套件共用
 */

function sanitizeText(value) {
    if (typeof value !== 'string') return value || '';
    // 按照规范：使用普通空格作为分隔符，替换 middle dots (U+00B7)
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
            roomId: currentContext.roomId || '',
            shopName: currentContext.shopName || '',
            // 8 个重点指标 (显式单位)
            gpm_amount_yuan: gpmCents !== null ? parsePriceCentsToYuan(gpmCents) : null,
            watch_pay_ucnt_ratio: formatRatio(watchPayRatio),
            watch_to_pay_ratio: formatRatio(watchPayRatio),
            avg_watch_duration_seconds: getOptionalNum('avg_watch_duration') !== null ? Math.round(getOptionalNum('avg_watch_duration')) : null,
            ad_cost_yuan: statCostCents !== null ? parsePriceCentsToYuan(statCostCents) : null,
            old_fans_pay_ucnt_ratio: formatRatio(getOptionalNum('old_fans_pay_ucnt_ratio')),
            interact_watch_ucnt_ratio: formatRatio(getOptionalNum('interact_watch_ucnt_ratio')),
            follow_anchor_watch_ucnt_ratio: formatRatio(getOptionalNum('follow_anchor_watch_ucnt_ratio')),
            real_refund_amt_ratio: formatRatio(getOptionalNum('real_refund_amt_ratio')),
            // 其他大盘辅助指标
            gmv_amount_yuan: parsePriceCentsToYuan(totalPayCents),
            gmv_amount_all_yuan: parsePriceCentsToYuan(totalPayAllCents),
            online_viewers_count: getNum('current_cnt') || 0,
            pay_users_count: getNum('pay_ucnt') || 0,
            pay_combo_orders_count: getNum('pay_combo_cnt') || 0
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

    // 4. 商品列表及其配置指标解析
    parseProductList: function (url, json, currentContext = {}) {
        if (!json || typeof json !== 'object') return null;
        const data = json.data;
        const rows = data && (data.data_result ?? data.product_list ?? data.products);
        if (!Array.isArray(rows) || rows.length === 0) return null;

        let query;
        try {
            query = new URL(url).searchParams;
        } catch {
            query = new URLSearchParams();
        }
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
        const pageResult = data.page_result || {};
        const headSelected = Array.isArray(data.data_head) ? data.data_head
            .map(item => item?.index_name ?? item?.field ?? item?.key)
            .filter(Boolean) : [];
        const selectedValue = data.index_selected ??
            (headSelected.length > 0 ? headSelected : query.get('index_selected') ?? '');
        const indexSelected = Array.isArray(selectedValue) ? selectedValue.map(String) :
            String(selectedValue).split(',').map(item => item.trim()).filter(Boolean);
        const sortField = String(data.sort_field ?? query.get('sort_field') ?? '');
        const rawAscending = data.is_asc ?? query.get('is_asc');
        const order = sortField ? (rawAscending === true || rawAscending === 1 ||
            String(rawAscending).toLowerCase() === 'true' || String(rawAscending) === '1' ? 'asc' : 'desc') : '';

        return {
            eventType: 'PRODUCT_LIST',
            roomId: currentContext.roomId || extractRoomId(url, data),
            shopName: currentContext.shopName || '',
            products,
            page: {
                current: Number(pageResult.page_no ?? pageResult.current ?? data.page_no ?? query.get('page_no') ?? 0),
                size: Number(pageResult.page_size ?? pageResult.size ?? data.page_size ?? query.get('page_size') ?? products.length),
                total: Number(pageResult.total ?? pageResult.total_cnt ?? data.total_cnt ?? products.length)
            },
            sort: { field: sortField, order },
            indexSelected
        };
    },

    // 5. 实时公屏弹幕解析
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

    // 6. 弹幕聚类关键词解析
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
