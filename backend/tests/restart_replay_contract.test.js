const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CollectorServer } = require('../src/collector/server');
const { MetricsCalculator } = require('../src/calculator/engine');

function postHeartbeat(port) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ roomId: 'restart_room', shopName: '重启恢复测试店' });
        const request = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/sentinel/heartbeat',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, response => {
            let responseBody = '';
            response.on('data', chunk => responseBody += chunk);
            response.on('end', () => resolve(JSON.parse(responseBody)));
        });
        request.on('error', reject);
        request.end(body);
    });
}

test('heartbeat identifies the backend process instance so sentinels can replay after a restart', async (t) => {
    const port = 29017;
    const store = {
        loadLatestSnapshot: () => null,
        saveSnapshot() {},
        appendEvents() {},
        exportRoomsToCsv: () => ''
    };
    const server = new CollectorServer({ port, host: '127.0.0.1', store });
    await new Promise((resolve, reject) => server.start(error => error ? reject(error) : resolve()));
    t.after(() => new Promise(resolve => server.stop(resolve)));

    const heartbeat = await postHeartbeat(port);
    assert.equal(typeof heartbeat.serverInstanceId, 'string');
    assert.ok(heartbeat.serverInstanceId.length >= 8);
});

test('the default heartbeat timeout tolerates background Chrome throttling', () => {
    const calculator = new MetricsCalculator();
    assert.equal(calculator.heartbeatTimeoutMs, 90_000);
});
