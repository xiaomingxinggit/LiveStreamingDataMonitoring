const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rendererPath = path.resolve(__dirname, '../src/presentation/renderer/index.html');

function loadRendererRuntime() {
    const html = fs.readFileSync(rendererPath, 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    const tableBody = { addEventListener() {} };
    const context = {
        document: {
            documentElement: { setAttribute() {} },
            getElementById(id) {
                return id === 'tableBody' ? tableBody : null;
            },
            querySelectorAll() {
                return [];
            }
        },
        window: { addEventListener() {} },
        localStorage: {
            getItem() { return null; },
            setItem() {}
        },
        console,
        setTimeout,
        clearTimeout,
        encodeURIComponent,
        decodeURIComponent
    };

    assert.ok(scripts.length > 0);
    vm.createContext(context);
    vm.runInContext(scripts.at(-1)[1], context);
    return context;
}

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

test('product list defaults to cumulative payment descending without mutating source data', () => {
    const runtime = loadRendererRuntime();
    const products = [
        { productName: '低', product_pay_amount_yuan: 10 },
        { productName: '高', product_pay_amount_yuan: 30 },
        { productName: '中', product_pay_amount_yuan: 20 }
    ];

    const sorted = runtime.sortProducts(products);

    assert.deepEqual(Array.from(sorted, product => product.productName), ['高', '中', '低']);
    assert.deepEqual(products.map(product => product.productName), ['低', '高', '中']);
});

test('custom product sorting keeps missing values last and equal values stable', () => {
    const runtime = loadRendererRuntime();
    const products = [
        { productName: '缺失一', product_click_users_count: null },
        { productName: '相等一', product_click_users_count: 2 },
        { productName: '相等二', product_click_users_count: '2' },
        { productName: '最低', product_click_users_count: 1 },
        { productName: '缺失二' },
        { productName: '无效', product_click_users_count: Number.POSITIVE_INFINITY }
    ];

    const sorted = runtime.sortProducts(products, {
        key: 'product_click_users_count',
        direction: 'asc'
    });

    assert.deepEqual(Array.from(sorted, product => product.productName), [
        '最低', '相等一', '相等二', '缺失一', '缺失二', '无效'
    ]);
});

test('product sort toggles the active column and starts a new column descending', () => {
    const runtime = loadRendererRuntime();

    const ascending = runtime.getNextProductSort({
        key: 'product_pay_amount_yuan',
        direction: 'desc'
    }, 'product_pay_amount_yuan');
    const newColumn = runtime.getNextProductSort(ascending, 'product_click_users_count');

    assert.deepEqual(JSON.parse(JSON.stringify(ascending)), {
        key: 'product_pay_amount_yuan',
        direction: 'asc'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(newColumn)), {
        key: 'product_click_users_count',
        direction: 'desc'
    });
});

test('all six product metrics expose accessible sort controls', () => {
    const html = fs.readFileSync(rendererPath, 'utf8');
    const sortKeys = [
        'product_pay_amount_yuan',
        'product_show_users_count',
        'product_click_users_count',
        'product_show_click_users_ratio',
        'product_click_pay_users_ratio',
        'product_gpm_amount_yuan'
    ];

    assert.match(html, /key: 'product_pay_amount_yuan',[\s\S]*direction: 'desc'/);
    assert.match(html, /aria-sort="\$\{ariaSort\}"/);
    assert.match(html, /class="product-sort-button \$\{isActive \? 'is-active' : ''\}"/);
    for (const key of sortKeys) {
        assert.match(html, new RegExp(`renderProductSortHeader\\(room\\.roomId, '${key}'`));
    }
});
