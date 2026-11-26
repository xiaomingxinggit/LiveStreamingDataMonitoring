const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererPath = path.resolve(__dirname, '../src/presentation/renderer/index.html');

test('product rows use their own hourly collection timestamp', () => {
    const html = fs.readFileSync(rendererPath, 'utf8');

    assert.match(html,
        /const productTimeStr = formatOptionalTime\(room\.productList\?\.collection\?\.observedAtIso\);/);
    assert.match(html,
        /<div class="val-time">\$\{productTimeStr\}<\/div>/);
});

test('top bar exposes backend-controlled immediate refresh with visible request states', () => {
    const html = fs.readFileSync(rendererPath, 'utf8');

    assert.match(html, /id="refreshNowBtn"[^>]*onclick="requestImmediateRefresh\(\)"/);
    assert.match(html, /<span id="refreshNowLabel">立即刷新<\/span>/);
    assert.match(html, /fetch\('\/api\/control\/refresh'/);
    assert.match(html, /setRefreshButtonState\('loading', '下发中'\)/);
    assert.match(html, /async function waitForRefreshCompletion\(refreshRequestId, targetCount\)/);
    assert.match(html, /fetch\('\/api\/control\/refresh', \{ cache: 'no-store' \}\)/);
    assert.match(html, /setRefreshButtonState\('success', '刷新完成'\)/);
    assert.match(html, /showRefreshToast\('success', '刷新完成'\)/);
    assert.match(html, /仍有 \$\{pendingCount\} 个直播间未响应/);
    assert.match(html, /暂无在线直播间可刷新/);
    assert.match(html, /setRefreshButtonState\('error', '刷新失败'\)/);
    assert.match(html, /setRefreshButtonState\('idle', '立即刷新'\)/);
});

test('product row hover does not animate the rebuilt outer card background', () => {
    const html = fs.readFileSync(rendererPath, 'utf8');
    const outerRowRule = html.match(/table\.monitoring-table > tbody > tr \{([^}]*)\}/s);

    assert.ok(outerRowRule);
    assert.doesNotMatch(outerRowRule[1], /transition/);
    assert.doesNotMatch(html, /table\.monitoring-table tbody tr:hover/);
    assert.match(html, /\.main-row \{[^}]*transition: border-left-color 0\.2s ease;/s);
    assert.match(html, /table\.product-subtable > tbody > tr:hover/);
});
