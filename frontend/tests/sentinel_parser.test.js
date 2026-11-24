const test = require('node:test');
const assert = require('node:assert/strict');
const { CompassParser, sanitizeText, parsePriceCentsToYuan } = require('../src/parser');

test('sanitizeText replaces middle dots (U+00B7) with standard spaces', () => {
    const raw = '旗舰店·热销爆款·现货秒发';
    const cleaned = sanitizeText(raw);
    assert.equal(cleaned, '旗舰店 热销爆款 现货秒发');
    assert.equal(cleaned.includes('\u00B7'), false);
});

test('parsePriceCentsToYuan converts cents to standard two decimal yuan', () => {
    assert.equal(parsePriceCentsToYuan(569810), 5698.10);
    assert.equal(parsePriceCentsToYuan(200675), 2006.75);
    assert.equal(parsePriceCentsToYuan(0), 0);
    assert.equal(parsePriceCentsToYuan('invalid'), 0);
});

test('parseLiveBaseInfo parses live room base information correctly', () => {
    const fixture = {
        st: 0,
        msg: 'success',
        data: {
            room_id: '7711536474121833267',
            nickname: 'chikoku官方旗舰店·直播专场',
            app_platform: '抖音',
            is_ecom_room: true,
            live_start_time: '2026-11-24 09:00:43',
            live_start_ts: 1795482043,
            live_status: 2,
            avatar_uri: 'https://p11.douyinpic.com/avatar.jpeg',
            server_cur_time: '2026-11-24 10:22:46'
        }
    };

    const parsed = CompassParser.parseLiveBaseInfo('https://compass.jinritemai.com/live_screen/live_base_info', fixture);
    assert.ok(parsed);
    assert.equal(parsed.eventType, 'ROOM_BASE_INFO');
    assert.equal(parsed.roomId, '7711536474121833267');
    assert.equal(parsed.shopName, 'chikoku官方旗舰店 直播专场'); // middle dot replaced
    assert.equal(parsed.liveStatus, 2);
    assert.equal(parsed.liveStatusText, '正在直播');
    assert.equal(parsed.isEcomRoom, true);
});

test('parseCoreData extracts GMV and viewers with accurate units', () => {
    const fixture = {
        data: {
            pay_amt: { unit: 'price', value: 569810 },
            pay_amt_all: { unit: 'price', value: 579789 },
            core_data: [
                { index_name: 'stat_cost', value: { unit: 'price', value: 200675 } },
                { index_name: 'gpm', value: { unit: 'price', value: 148836.1053 } },
                { index_name: 'pay_ucnt', value: { unit: 'number', value: 102 } },
                { index_name: 'pay_combo_cnt', value: { unit: 'number', value: 109 } },
                { index_name: 'current_cnt', value: { unit: 'number', value: 39 } },
                { index_name: 'watch_pay_ucnt_ratio', value: { unit: 'ratio', value: 0.044137 } },
                { index_name: 'product_click_pay_ucnt_ratio', value: { unit: 'ratio', value: 0.113586 } },
                { index_name: 'watch_cnt_show_ratio', value: { unit: 'ratio', value: 0.03792 } },
                { index_name: 'avg_watch_duration', value: { unit: 'time', value: 48 } }
            ]
        }
    };

    const parsed = CompassParser.parseCoreData(
        'https://compass.jinritemai.com/live_screen/core_data',
        fixture,
        { roomId: '7711536474121833267', shopName: 'chikoku官方旗舰店' }
    );

    assert.ok(parsed);
    assert.equal(parsed.eventType, 'CORE_METRICS');
    assert.equal(parsed.gmv_amount_yuan, 5698.10);
    assert.equal(parsed.ad_cost_yuan, 2006.75);
    assert.equal(parsed.gpm_amount_yuan, 1488.36);
    assert.equal(parsed.online_viewers_count, 39);
    assert.equal(parsed.pay_users_count, 102);
    assert.equal(parsed.pay_combo_orders_count, 109);
    assert.equal(parsed.avg_watch_duration_seconds, 48);
});

test('parseProductExplainDetail extracts currently explained product detail', () => {
    const fixture = {
        data: {
            product_id: '3783122488695848970',
            product_name: 'chikoku雪球猫爪棉靴·加绒保暖',
            product_img: 'https://p26-item.ecombdimg.com/item.jpeg',
            explaining: true,
            pay_amt: { unit: 'priceV2', value: 193708 },
            pay_combo_cnt: { unit: 'number', value: 42 },
            stock_cnt: { unit: 'number', value: 35949 },
            click_data: {
                product_click_cnt: { unit: 'number', value: 37 },
                trend: [
                    { horizontal: '10:20', vertical: 9, date_time: 1795486800 },
                    { horizontal: '10:21', vertical: 16, date_time: 1795486860 }
                ]
            }
        }
    };

    const parsed = CompassParser.parseProductExplainDetail(
        'https://compass.jinritemai.com/live_screen/product_explain_detail',
        fixture,
        { roomId: '7711536474121833267' }
    );

    assert.ok(parsed);
    assert.equal(parsed.eventType, 'EXPLAINING_PRODUCT');
    assert.equal(parsed.productId, '3783122488695848970');
    assert.equal(parsed.productName, 'chikoku雪球猫爪棉靴 加绒保暖'); // middle dot replaced
    assert.equal(parsed.isExplaining, true);
    assert.equal(parsed.product_pay_amount_yuan, 1937.08);
    assert.equal(parsed.product_pay_orders_count, 42);
    assert.equal(parsed.product_stock_count, 35949);
    assert.equal(parsed.recentFiveMinClickCount, 37);
    assert.equal(parsed.clickTrend.length, 2);
    assert.equal(parsed.clickTrend[1].clickCount, 16);
});

test('handles missing or malformed data gracefully without throwing', () => {
    assert.equal(CompassParser.parseLiveBaseInfo('url', null), null);
    assert.equal(CompassParser.parseLiveBaseInfo('url', {}), null);
    assert.equal(CompassParser.parseCoreData('url', {}), null);
    assert.equal(CompassParser.parseProductExplainDetail('url', { data: null }), null);
    assert.equal(CompassParser.parseComments('url', { data: { comments: [] } }), null);
});
