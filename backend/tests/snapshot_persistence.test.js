const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CollectorServer } = require('../src/collector/server');

test('restores room metrics and product data after a backend restart', async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-monitor-snapshot-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    const firstServer = new CollectorServer({ dataDir, port: 0, host: '127.0.0.1' });
    await new Promise((resolve, reject) => firstServer.start(err => err ? reject(err) : resolve()));
    firstServer.calculator.handleHeartbeat({ roomId: 'room_restore', shopName: '恢复测试店铺' });
    firstServer.calculator.handleEvent({
        eventId: 'metrics_before_restart',
        roomId: 'room_restore',
        eventType: 'CORE_METRICS',
        gmv_amount_yuan: 9527.36,
        online_viewers_count: 88
    });
    firstServer.calculator.handleEvent({
        eventId: 'products_before_restart',
        roomId: 'room_restore',
        eventType: 'PRODUCT_LIST',
        products: [{
            productId: 'product_internal_1',
            productName: '重启后仍保留的商品',
            cartIndex: 1,
            product_pay_amount_yuan: 3999.64
        }],
        productCollectionStartedAtIso: '2026-11-26T03:00:00.000Z',
        productDataObservedAtIso: '2026-11-26T04:00:00.000Z',
        productReportIntervalMinutes: 60,
        productReportSequence: 2
    });
    firstServer.calculator.rooms.get('room_restore').latestMetrics.gmv_amount_yuan = 10000;
    await new Promise(resolve => firstServer.stop(resolve));

    const snapshotFile = path.join(dataDir, 'room_snapshots.json');
    assert.equal(fs.existsSync(snapshotFile), true);
    assert.equal(fs.readdirSync(dataDir).some(name => name.endsWith('.tmp')), false);

    const secondServer = new CollectorServer({ dataDir });
    const restoredInternal = secondServer.calculator.rooms.get('room_restore');
    assert.ok(restoredInternal);
    assert.equal(restoredInternal.isOnline, false);
    assert.equal(restoredInternal.latestMetrics.gmv_amount_yuan, 10000);
    assert.equal(restoredInternal.productList.products[0].productId, 'product_internal_1');
    assert.equal(restoredInternal.productList.products[0].productName, '重启后仍保留的商品');
    assert.equal(restoredInternal.productList.collection.observedAtIso, '2026-11-26T04:00:00.000Z');

    const dashboardRoom = secondServer.calculator.getDashboardSnapshot().rooms[0];
    assert.equal(dashboardRoom.isOnline, false);
    assert.equal(dashboardRoom.productList.products[0].productName, '重启后仍保留的商品');
    assert.equal(Object.hasOwn(dashboardRoom.productList.products[0], 'productId'), false);

    secondServer.calculator.handleHeartbeat({ roomId: 'room_restore', shopName: '恢复测试店铺' });
    assert.equal(secondServer.calculator.rooms.get('room_restore').isOnline, true);
});

test('recovers recent event history when upgrading without an existing snapshot', (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-monitor-events-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const events = [
        {
            eventId: 'history_metric',
            roomId: 'history_room',
            shopName: '日志恢复店铺',
            eventType: 'CORE_METRICS',
            gmv_amount_yuan: 6188
        },
        {
            eventId: 'history_product',
            roomId: 'history_room',
            eventType: 'PRODUCT_LIST',
            products: [{ productName: '日志恢复商品', cartIndex: 1 }],
            productDataObservedAtIso: '2026-11-26T05:00:00.000Z'
        }
    ];
    fs.writeFileSync(path.join(dataDir, 'stream_events.jsonl'),
        events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');

    const server = new CollectorServer({ dataDir });
    const room = server.calculator.rooms.get('history_room');
    assert.ok(room);
    assert.equal(room.isOnline, false);
    assert.equal(room.latestMetrics.gmv_amount_yuan, 6188);
    assert.equal(room.productList.products[0].productName, '日志恢复商品');
    assert.equal(fs.existsSync(path.join(dataDir, 'room_snapshots.json')), true);
});

test('event-log fallback restores only rooms seen within twelve hours of the newest event', (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-monitor-recent-events-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const events = [
        {
            eventId: 'stale_room_metric',
            roomId: 'stale_room',
            shopName: '上一天旧直播间',
            eventType: 'CORE_METRICS',
            timestampIso: '2026-11-25T04:00:00.000Z',
            gmv_amount_yuan: 100
        },
        {
            eventId: 'current_room_a_metric',
            roomId: 'current_room_a',
            shopName: '当前直播间一',
            eventType: 'CORE_METRICS',
            timestampIso: '2026-11-26T03:30:00.000Z',
            gmv_amount_yuan: 200
        },
        {
            eventId: 'current_room_b_metric',
            roomId: 'current_room_b',
            shopName: '当前直播间二',
            eventType: 'CORE_METRICS',
            timestampIso: '2026-11-26T04:00:00.000Z',
            gmv_amount_yuan: 300
        }
    ];
    fs.writeFileSync(path.join(dataDir, 'stream_events.jsonl'),
        events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');

    const server = new CollectorServer({ dataDir });
    assert.equal(server.calculator.rooms.has('stale_room'), false);
    assert.equal(server.calculator.rooms.has('current_room_a'), true);
    assert.equal(server.calculator.rooms.has('current_room_b'), true);
});
