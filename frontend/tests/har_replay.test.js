const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CompassParser } = require('../src/parser');

test('replay actual entries from compass.jinritemai.com.har', () => {
    const harPath = path.resolve(__dirname, '../../compass.jinritemai.com.har');
    assert.ok(fs.existsSync(harPath), 'HAR file must exist in workspace root');

    const rawHar = fs.readFileSync(harPath, 'utf8');
    const har = JSON.parse(rawHar);
    const entries = har.log.entries;

    let baseInfoCount = 0;
    let coreDataCount = 0;
    let productDetailCount = 0;
    let lastRoomId = '';

    for (const entry of entries) {
        const url = entry.request.url;
        const text = entry.response.content.text;
        if (!text) continue;

        let json;
        try {
            json = JSON.parse(text);
        } catch {
            continue;
        }

        if (url.includes('/live_screen/live_base_info')) {
            const parsed = CompassParser.parseLiveBaseInfo(url, json);
            if (parsed) {
                baseInfoCount++;
                lastRoomId = parsed.roomId;
                assert.equal(parsed.roomId, '7711536474121833267');
                assert.equal(parsed.shopName, 'chikoku官方旗舰店');
                assert.equal(parsed.liveStatus, 2);
            }
        } else if (url.includes('/live_screen/core_data')) {
            const parsed = CompassParser.parseCoreData(url, json, { roomId: lastRoomId });
            if (parsed) {
                coreDataCount++;
                assert.ok(parsed.gmv_amount_yuan >= 5600, 'GMV should be valid and positive');
                assert.ok(parsed.online_viewers_count >= 30 && parsed.online_viewers_count <= 50, 'Online viewers should fluctuate between 30 and 50');
                assert.equal(parsed.ad_cost_yuan, 2006.75);
                assert.equal(parsed.pay_users_count, 102);
            }
        } else if (url.includes('/live_screen/product_explain_detail')) {
            const parsed = CompassParser.parseProductExplainDetail(url, json, { roomId: lastRoomId });
            if (parsed) {
                productDetailCount++;
                if (parsed.isExplaining) {
                    assert.equal(parsed.productId, '3783122488695848970');
                    assert.equal(parsed.product_pay_amount_yuan, 1937.08);
                    assert.equal(parsed.product_stock_count, 35949);
                } else {
                    assert.equal(parsed.productId, '0');
                    assert.equal(parsed.isExplaining, false);
                }
            }
        }
    }

    assert.ok(baseInfoCount > 0, `Must parse base info events, got ${baseInfoCount}`);
    assert.ok(coreDataCount > 0, `Must parse core data events, got ${coreDataCount}`);
    assert.ok(productDetailCount > 0, `Must parse product explain events, got ${productDetailCount}`);
});
