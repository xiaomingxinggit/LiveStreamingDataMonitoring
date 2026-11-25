const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { CollectorServer } = require('../src/collector/server');

function makeRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

test('CollectorServer starts, receives events, heartbeats and serves CSV export', async (t) => {
    const testPort = 28999;
    const server = new CollectorServer({
        port: testPort,
        host: '127.0.0.1'
    });

    await new Promise((resolve, reject) => {
        server.start((err) => err ? reject(err) : resolve());
    });

    t.after(() => {
        return new Promise(resolve => server.stop(resolve));
    });

    // 1. 测试发送心跳 (注册一个房间)
    const hbRes = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/sentinel/heartbeat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, {
        roomId: 'test_room_101',
        shopName: '旗舰店 A',
        sentinelVersion: '1.1.0'
    });

    assert.equal(hbRes.status, 200);
    const hbJson = JSON.parse(hbRes.body);
    assert.equal(hbJson.status, 'ok');
    assert.equal(hbJson.activeRoomsCount, 1);

    // 2. 测试发送业务核心事件
    const evRes = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/stream/events',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, {
        events: [
            {
                eventId: 'test_evt_1',
                roomId: 'test_room_101',
                eventType: 'CORE_METRICS',
                gmv_amount_yuan: 8888.88,
                online_viewers_count: 66,
                pay_combo_orders_count: 99
            }
        ]
    });

    assert.equal(evRes.status, 200);
    const evJson = JSON.parse(evRes.body);
    assert.equal(evJson.received, 1);
    assert.equal(evJson.applied, 1);

    // 3. 测试获取全大盘快照 GET /api/rooms
    const roomsRes = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/rooms',
        method: 'GET'
    });

    assert.equal(roomsRes.status, 200);
    const roomsJson = JSON.parse(roomsRes.body);
    assert.equal(roomsJson.summary.total_rooms_count, 1);
    assert.equal(roomsJson.summary.total_gmv_amount_yuan, 8888.88);
    assert.equal(roomsJson.summary.total_online_viewers_count, 66);

    // 4. 测试导出 CSV GET /api/export/csv
    const csvRes = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/export/csv',
        method: 'GET'
    });

    assert.equal(csvRes.status, 200);
    assert.ok(csvRes.headers['content-type'].includes('text/csv'));
    assert.ok(csvRes.body.includes('test_room_101'));
    assert.ok(csvRes.body.includes('8888.88'));
});
