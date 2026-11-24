const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CompassParser } = require('../src/parser');

const captures = [
    'compass.jinritemai.com-官方.har',
    'compass.jinritemai.com-女鞋.har',
    'compass.jinritemai.com-鞋类.har'
];

for (const capture of captures) {
    const harPath = path.resolve(__dirname, '../..', capture);
    const skip = fs.existsSync(harPath) ? false : 'Local HAR capture unavailable';
    test(`replay Compass responses from ${capture}`, { skip }, () => {
        const { log: { entries } } = JSON.parse(fs.readFileSync(harPath, 'utf8'));
        const context = {};
        const counts = { live_base_info: 0, core_data: 0, product_explain_detail: 0 };

        for (const { request, response } of entries) {
            const url = new URL(request.url);
            if (url.hostname !== 'compass.jinritemai.com' || !url.pathname.startsWith('/compass_api/shop/live/live_screen/')) continue;
            const endpoint = url.pathname.split('/').at(-1);
            if (!Object.hasOwn(counts, endpoint) || !response.content.text) continue;

            const json = JSON.parse(response.content.text);
            const data = json.data;
            const roomId = url.searchParams.get('room_id');
            assert.match(roomId, /^\d{15,22}$/);
            counts[endpoint]++;

            if (endpoint === 'live_base_info') {
                const parsed = CompassParser.parseLiveBaseInfo(request.url, json);
                assert.equal(parsed.roomId, roomId);
                assert.equal(parsed.shopName, data.nickname.replace(/\u00B7/g, ' ').trim());
                assert.equal(parsed.liveStatus, 2);
                context.roomId = roomId;
                context.shopName = parsed.shopName;
            } else if (endpoint === 'core_data') {
                const parsed = CompassParser.parseCoreData(request.url, json, context);
                const metricValue = name => data.core_data.find(item => item.index_name === name).value.value;
                assert.equal(parsed.roomId, roomId);
                assert.equal(parsed.shopName, context.shopName);
                assert.equal(parsed.gmv_amount_yuan, data.pay_amt.value / 100);
                assert.ok(parsed.gmv_amount_yuan > 0);
                assert.equal(parsed.online_viewers_count, metricValue('current_cnt'));
                assert.ok(parsed.online_viewers_count > 0);
                assert.equal(parsed.ad_cost_yuan, metricValue('stat_cost') / 100);
                assert.equal(parsed.pay_users_count, metricValue('pay_ucnt'));
            } else {
                const parsed = CompassParser.parseProductExplainDetail(request.url, json, context);
                assert.equal(parsed.roomId, roomId);
                assert.equal(parsed.productId, String(data.product_id));
                assert.equal(parsed.isExplaining, Boolean(data.explaining));
                assert.equal(parsed.product_pay_amount_yuan, (data.pay_amt?.value ?? 0) / 100);
                assert.equal(parsed.product_stock_count, data.stock_cnt?.value ?? 0);
            }
        }

        for (const [endpoint, count] of Object.entries(counts)) {
            assert.ok(count > 0, `No responses parsed for ${endpoint} in ${capture}`);
        }
    });
}
