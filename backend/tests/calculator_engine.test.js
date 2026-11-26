const test = require('node:test');
const assert = require('node:assert/strict');
const { MetricsCalculator, sanitizeText } = require('../src/calculator/engine');

test('sanitizeText replaces middle dots (U+00B7) with standard spaces', () => {
    const raw = '官方旗舰店·双11爆款·专场直播';
    const cleaned = sanitizeText(raw);
    assert.equal(cleaned, '官方旗舰店 双11爆款 专场直播');
    assert.equal(cleaned.includes('\u00B7'), false);
});

test('deduplicates identical events using eventId', () => {
    const calc = new MetricsCalculator();
    const event = {
        eventId: 'evt_1001',
        roomId: '7001',
        eventType: 'CORE_METRICS',
        gmv_amount_yuan: 100
    };

    const first = calc.handleEvent(event);
    assert.equal(first.skipped, undefined);

    const duplicate = calc.handleEvent(event);
    assert.equal(duplicate.skipped, true);
    assert.equal(duplicate.reason, 'duplicate event');
});

test('manages multiple rooms dynamically and calculates cross-room aggregates', () => {
    const calc = new MetricsCalculator();

    // 模拟同时接收 3 个不同直播间的事件
    calc.handleEvent({
        eventId: 'e1',
        roomId: 'room_01',
        shopName: '旗舰店 A',
        eventType: 'CORE_METRICS',
        gmv_amount_yuan: 12000.50,
        online_viewers_count: 50,
        pay_combo_orders_count: 120,
        ad_cost_yuan: 3000.00
    });

    calc.handleEvent({
        eventId: 'e2',
        roomId: 'room_02',
        shopName: '专卖店 B',
        eventType: 'CORE_METRICS',
        gmv_amount_yuan: 8500.00,
        online_viewers_count: 35,
        pay_combo_orders_count: 80,
        ad_cost_yuan: 1500.00
    });

    calc.handleEvent({
        eventId: 'e3',
        roomId: 'room_03',
        shopName: '折扣店 C',
        eventType: 'CORE_METRICS',
        gmv_amount_yuan: 4500.25,
        online_viewers_count: 20,
        pay_combo_orders_count: 45,
        ad_cost_yuan: 800.00
    });

    const snapshot = calc.getDashboardSnapshot();
    assert.equal(snapshot.summary.total_rooms_count, 3);
    assert.equal(snapshot.summary.active_rooms_count, 3);
    assert.equal(snapshot.summary.total_gmv_amount_yuan, 25000.75); // 12000.50 + 8500 + 4500.25
    assert.equal(snapshot.summary.total_online_viewers_count, 105); // 50 + 35 + 20
    assert.equal(snapshot.summary.total_pay_orders_count, 245); // 120 + 80 + 45
    assert.equal(snapshot.summary.total_ad_cost_yuan, 5300.00); // 3000 + 1500 + 800
});

test('dynamically expands to 4 or 5 rooms as new streams connect', () => {
    const calc = new MetricsCalculator();

    // 动态模拟 5 个房间
    for (let i = 1; i <= 5; i++) {
        calc.handleEvent({
            eventId: `evt_batch_${i}`,
            roomId: `stream_00${i}`,
            shopName: `店铺 ${i}`,
            eventType: 'CORE_METRICS',
            gmv_amount_yuan: i * 1000,
            online_viewers_count: i * 10,
            pay_combo_orders_count: i * 5
        });
    }

    const snapshot = calc.getDashboardSnapshot();
    assert.equal(snapshot.summary.total_rooms_count, 5);
    assert.equal(snapshot.rooms.length, 5);
    assert.equal(snapshot.summary.total_gmv_amount_yuan, 15000); // (1+2+3+4+5)*1000
});

test('stores the latest product list with explicit units and list metadata', () => {
    const calc = new MetricsCalculator();
    const selected = [
        'pay_amt',
        'product_show_ucnt',
        'product_click_ucnt',
        'product_show_click_ucnt_ratio',
        'product_click_pay_ucnt_ratio',
        'gpm'
    ];

    calc.handleEvent({
        eventId: 'product_list_001',
        roomId: 'room_products',
        eventType: 'PRODUCT_LIST',
        products: [{
            productId: '3783122488695848970',
            productName: 'chikoku雪球猫爪棉靴 热销款',
            productImg: 'https://p26-item.ecombdimg.com/product.jpeg',
            cartIndex: 1,
            product_pay_amount_yuan: 1399.15,
            product_show_users_count: 728,
            product_click_users_count: 46,
            product_show_click_users_ratio: 0.0632,
            product_click_pay_users_ratio: 0.0166,
            product_gpm_amount_yuan: 179.70
        }],
        page: { current: 0, size: 20, total: 42 },
        sort: { field: 'pay_amt', order: 'desc' },
        indexSelected: selected,
        productCollectionStartedAtIso: '2026-11-25T01:00:00.000Z',
        productDataObservedAtIso: '2026-11-25T01:00:01.000Z',
        productReportIntervalMinutes: 60,
        productReportSequence: 1
    });

    const room = calc.getDashboardSnapshot().rooms.find(item => item.roomId === 'room_products');
    assert.ok(room);
    assert.deepEqual(room.productList.page, { current: 0, size: 20, total: 42 });
    assert.deepEqual(room.productList.sort, { field: 'pay_amt', order: 'desc' });
    assert.deepEqual(room.productList.indexSelected, selected);
    assert.deepEqual(room.productList.collection, {
        startedAtIso: '2026-11-25T01:00:00.000Z',
        observedAtIso: '2026-11-25T01:00:01.000Z',
        intervalMinutes: 60,
        reportSequence: 1
    });
    assert.equal(room.productList.products.length, 1);
    assert.deepEqual(room.productList.products[0], {
        productId: '3783122488695848970',
        productName: 'chikoku雪球猫爪棉靴 热销款',
        productImg: 'https://p26-item.ecombdimg.com/product.jpeg',
        cartIndex: 1,
        product_pay_amount_yuan: 1399.15,
        product_show_users_count: 728,
        product_click_users_count: 46,
        product_show_click_users_ratio: 0.0632,
        product_click_pay_users_ratio: 0.0166,
        product_gpm_amount_yuan: 179.70
    });
});

test('detects delayed updates and marks room offline after heartbeat timeout', () => {
    const calc = new MetricsCalculator({ heartbeatTimeoutMs: 5000 });
    const roomId = 'room_timeout_test';

    // 初始接收心跳
    calc.handleHeartbeat({ roomId: roomId, shopName: '超时测试直播间' });
    let snapshot = calc.getDashboardSnapshot();
    let room = snapshot.rooms.find(r => r.roomId === roomId);
    assert.equal(room.isOnline, true);

    // 模拟时间流逝 6 秒 (超过 5 秒超时时间)
    const futureTime = Date.now() + 6000;
    calc.checkTimeouts(futureTime);

    snapshot = calc.getDashboardSnapshot();
    room = snapshot.rooms.find(r => r.roomId === roomId);
    assert.equal(room.isOnline, false);
    assert.equal(room.liveStatusText, '离线 未连接');
});

test('handles missing or malformed data gracefully without throwing', () => {
    const calc = new MetricsCalculator();
    assert.equal(calc.handleEvent(null), null);
    assert.equal(calc.handleHeartbeat(null), null);

    // 缺少指标的空事件
    const res = calc.handleEvent({ roomId: 'empty_room' });
    assert.ok(res);
    assert.equal(res.roomId, 'empty_room');
    assert.equal(res.latestMetrics.gmv_amount_yuan, 0);
});
