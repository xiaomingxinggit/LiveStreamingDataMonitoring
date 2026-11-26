const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../src/douyin_sentinel.user.js');
const script = new vm.Script(fs.readFileSync(scriptPath, 'utf8'), { filename: scriptPath });
const roomId = '1234567890123456789';
const otherRoomId = '1234567890123456790';
const compassOrigin = 'https://compass.jinritemai.com';
const shopScreenUrl = `${compassOrigin}/screen/live/shop`;
const pageUrl = `${shopScreenUrl}?live_room_id=${roomId}`;
const metricsUrl = new URL(`/compass_api/shop/live/live_screen/core_data?room_id=${roomId}`, pageUrl).href;
const productListUrl = new URL(
    `/compass_api/shop/live/live_screen/product_list?room_id=${roomId}` +
    '&page_no=0&page_size=20&sort_field=pay_amt&is_asc=false',
    pageUrl
).href;
const signedMetricsUrl = `${metricsUrl}&index_selected=stat_cost%2ccurrent_cnt&version=qc` +
    '&msToken=example%20token~&a_bogus=example%2bsignature%3d';

function metricsResponse(gmvCents = 12345) {
    return JSON.stringify({
        data: {
            pay_amt: { value: gmvCents },
            display_label: '早场\u00B7活动',
            core_data: [{ index_name: 'current_cnt', value: { value: 32 } }]
        }
    });
}

const metrics = metricsResponse();

function productListResponse(payCents = 139915) {
    const indexSelected = [
        'pay_amt',
        'product_show_ucnt',
        'product_click_ucnt',
        'product_show_click_ucnt_ratio',
        'product_click_pay_ucnt_ratio',
        'gpm'
    ];
    return JSON.stringify({
        st: 0,
        data: {
            data_head: indexSelected.map(index_name => ({ index_name })),
            data_result: [{
                product_id: '3783122488695848970',
                product_name: 'chikoku雪球猫爪棉靴\u00b7热销款',
                product_img: 'https://p26-item.ecombdimg.com/product.jpeg',
                product_rank: 1,
                index_data: [
                    { index_name: 'pay_amt', value: { unit: 'price', value: payCents } },
                    { index_name: 'product_show_ucnt', value: { unit: 'number', value: 728 } },
                    { index_name: 'product_click_ucnt', value: { unit: 'number', value: 46 } },
                    { index_name: 'product_show_click_ucnt_ratio', value: { unit: 'ratio', value: 0.0632 } },
                    { index_name: 'product_click_pay_ucnt_ratio', value: { unit: 'ratio', value: 0.0166 } },
                    { index_name: 'gpm', value: { unit: 'price', value: 17970 } }
                ]
            }],
            page_result: { page_no: 0, page_size: 20, total: 42 }
        }
    });
}

class TestElement extends EventTarget {
    children = [];
    dataset = {};
    attributes = new Map();
    hidden = false;
    disabled = false;
    #text = '';

    constructor(tagName = '') {
        super();
        this.tagName = tagName;
    }

    set innerHTML(markup) {
        this.textContent = '';
        const openElements = [this];
        const skeleton = markup.replace(/<style>[\s\S]*?<\/style>/g, '');
        for (const token of skeleton.match(/<[^>]+>|[^<]+/g) ?? []) {
            if (token.startsWith('</')) {
                openElements.pop();
                continue;
            }
            const parent = openElements.at(-1);
            const tag = token.match(/^<([\w-]+)([^>]*)>$/);
            if (!tag) {
                parent.append(token);
                continue;
            }
            const element = new TestElement(tag[1]);
            for (const [, name, value] of tag[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
                element.setAttribute(name, value ?? '');
            }
            parent.append(element);
            openElements.push(element);
        }
    }

    get textContent() {
        return this.#text + this.children.map(child => child.textContent ?? child).join('');
    }

    set textContent(text) {
        this.#text = String(text);
        this.children = [];
    }

    append(...children) {
        this.children.push(...children);
    }

    appendChild(child) {
        this.append(child);
        return child;
    }

    attachShadow() {
        this.shadowRoot = new TestElement();
        return this.shadowRoot;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'id') this.id = value;
        if (name === 'class') this.className = value;
        if (name === 'hidden') this.hidden = true;
        if (name === 'disabled') this.disabled = true;
        if (name === 'data-state') this.dataset.state = value;
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    querySelector(selector) {
        const [current, descendant] = selector.split(' ', 2);
        for (const child of this.children) {
            if (!(child instanceof TestElement)) continue;
            const matches = current === child.tagName || current === `#${child.id}` ||
                (current.startsWith('.') && child.className?.split(' ').includes(current.slice(1)));
            if (matches) {
                if (!descendant) return child;
                const nested = child.querySelector(descendant);
                if (nested) return nested;
            }
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }

    remove() {}
}

function startSentinel({
    address = pageUrl,
    inlineScript = true,
    unsafeWindowAvailable = false,
    topLevel = true,
    pageFetch,
    nativePicker
} = {}) {
    const intervals = new Map();
    const timeouts = new Map();
    let nextTimeout = 0;
    let now = 0;
    class TestDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [now]));
        }

        static now() {
            return now;
        }
    }
    const pageMessages = [];
    const windowListeners = new Map();
    const eventRequests = [];
    const heartbeatRequests = [];
    let responseBodyReads = 0;

    class MockXhr extends EventTarget {
        static DONE = 4;
        DONE = 4;
        readyState = 0;

        open(method, url) {
            this.method = method;
            this.openedUrl = url;
            this.readyState = 1;
            this.dispatchEvent(new Event('readystatechange'));
        }

        get responseText() {
            responseBodyReads++;
            if (this.responseType === 'json') {
                throw new DOMException('responseText is unavailable with a JSON response type', 'InvalidStateError');
            }
            return this.readyState === this.DONE ? this.body : '';
        }

        get response() {
            responseBodyReads++;
            if (this.readyState !== this.DONE) return null;
            return this.responseType === 'json' ? JSON.parse(this.body) : this.body;
        }

        abort() {
            this.readyState = 0;
            this.status = 0;
            this.responseURL = '';
            this.body = '';
        }

        send() {
            this.readyState = 2;
            this.dispatchEvent(new Event('readystatechange'));
            this.readyState = this.DONE;
            if (this.notifyDone) this.dispatchEvent(new Event('readystatechange'));
            if (this.notifyLoad && this.readyState === this.DONE) this.dispatchEvent(new Event('load'));
        }
    }

    const location = new URL(address);
    const originalXhrOpen = MockXhr.prototype.open;
    const originalXhrSend = MockXhr.prototype.send;
    const pageWindow = {
        location,
        EventTarget,
        XMLHttpRequest: MockXhr,
        fetch: pageFetch,
        addEventListener(type, listener) {
            if (!windowListeners.has(type)) windowListeners.set(type, []);
            windowListeners.get(type).push(listener);
        },
        postMessage(data) {
            pageMessages.push({ data: structuredClone(data), source: window, origin: window.location.origin });
        }
    };
    const window = unsafeWindowAvailable ? { ...pageWindow } : pageWindow;
    const parentWindow = {};
    pageWindow.self = pageWindow;
    pageWindow.top = topLevel ? pageWindow : parentWindow;
    window.self = window;
    window.top = topLevel ? window : parentWindow;
    function deliverPageMessages() {
        for (const message of pageMessages.splice(0)) {
            for (const listener of windowListeners.get('message') || []) listener(message);
        }
    }

    const console = { log() {}, error() {}, warn() {} };
    const body = new TestElement();
    const pageDocument = { currentScript: null };
    const pageContext = vm.createContext({
        window: pageWindow,
        document: pageDocument,
        location,
        XMLHttpRequest: MockXhr,
        URL,
        Date: TestDate,
        console
    });
    const document = {
        readyState: 'complete',
        body,
        createElement: tagName => new TestElement(tagName),
        head: {
            appendChild(element) {
                if (!inlineScript) return;
                pageDocument.currentScript = element;
                try {
                    vm.runInContext(element.textContent, pageContext);
                } finally {
                    pageDocument.currentScript = null;
                }
            }
        },
        getElementById: id => body.querySelector(`#${id}`),
        querySelectorAll: selector => nativePicker?.querySelectorAll(selector) ?? [],
        querySelector(selector) {
            return this.querySelectorAll(selector)[0] ?? null;
        }
    };

    script.runInNewContext({
        window,
        unsafeWindow: unsafeWindowAvailable ? pageWindow : undefined,
        document,
        location,
        XMLHttpRequest: MockXhr,
        URL,
        Date: TestDate,
        console,
        setInterval: (callback, delay) => intervals.set(delay, callback),
        setTimeout(callback, delay) {
            const id = ++nextTimeout;
            timeouts.set(id, { callback, due: now + delay });
            return id;
        },
        clearTimeout: id => timeouts.delete(id),
        GM_getValue: (_key, fallback) => fallback,
        GM_xmlhttpRequest({ url, data, onload }) {
            const route = new URL(url).pathname;
            const payload = JSON.parse(data);
            if (route === '/api/sentinel/heartbeat') {
                heartbeatRequests.push(payload);
                onload({ status: 200, responseText: '{"status":"ok"}' });
                return;
            }
            assert.equal(route, '/api/stream/events');
            const { events } = payload;
            eventRequests.push({
                events,
                reply(status = 200) {
                    const response = { status: 'ok', received: events.length, applied: events.length };
                    onload({ status, responseText: JSON.stringify(response) });
                }
            });
        }
    });
    deliverPageMessages();

    const hud = document.getElementById('douyin-sentinel-hud');
    const root = hud?.shadowRoot || hud;
    const element = name => {
        const result = root?.querySelector(`#douyin-sentinel-${name}`);
        assert.ok(result, `Missing ${name} in the capture panel`);
        return result;
    };

    return {
        pageWindow,
        element,
        eventRequests,
        heartbeatRequests,
        get now() {
            return now;
        },
        get responseBodyReads() {
            return responseBodyReads;
        },
        hasHud: Boolean(hud),
        hasNetworkHook: pageWindow.XMLHttpRequest !== MockXhr ||
            MockXhr.prototype.open !== originalXhrOpen || MockXhr.prototype.send !== originalXhrSend,
        metricsRow() {
            const row = element('events').children.find(child => child.dataset?.route === 'coreData');
            assert.ok(row, 'Missing the core metrics response');
            return row;
        },
        openPanel() {
            element('toggle').dispatchEvent(new Event('click'));
        },
        navigate(address) {
            location.href = new URL(address, location.href).href;
        },
        capture(body, {
            requestUrl = metricsUrl,
            responseUrl = requestUrl,
            responseType = '',
            notifyDone = true,
            notifyLoad = true,
            beforeSend
        } = {}) {
            const xhr = new pageWindow.XMLHttpRequest();
            xhr.open('GET', requestUrl);
            Object.assign(xhr, { status: 200, responseURL: responseUrl, body, responseType, notifyDone, notifyLoad });
            beforeSend?.(xhr);
            xhr.send();
            deliverPageMessages();
        },
        async fetchTarget(requestUrl = metricsUrl) {
            const response = await pageWindow.fetch(requestUrl);
            deliverPageMessages();
            return response;
        },
        heartbeat() {
            intervals.get(3000)?.();
        },
        advanceTime(milliseconds) {
            const end = now + milliseconds;
            while (true) {
                const next = [...timeouts.entries()].sort((a, b) => a[1].due - b[1].due)[0];
                if (!next || next[1].due > end) break;
                const [id, { callback, due }] = next;
                now = due;
                timeouts.delete(id);
                callback();
            }
            now = end;
        }
    };
}

const presetMetrics = [
    ['gpm', '千次观看用户支付金额', 182345],
    ['watch_pay_ucnt_ratio', '观看-成交率(人数)', 0.0582],
    ['avg_watch_duration', '人均观看时长', 53],
    ['stat_cost', '投放消耗(店铺绑定)', 237600],
    ['old_fans_pay_ucnt_ratio', '成交老粉占比', 0.0625],
    ['interact_watch_ucnt_ratio', '观看-互动率(人数)', 0.03125],
    ['follow_anchor_watch_ucnt_ratio', '观看-关注率(人数)', 0.0075],
    ['real_refund_amt_ratio', '退款金额占比', 0.095]
];

function presetMetricsResponse() {
    const coreData = presetMetrics.map(([index_name,, value]) => ({ index_name, value: { value } }));
    return JSON.stringify({ st: 0, data: { core_data: coreData } });
}

function createNativePicker({
    initialSelection,
    missingMetric,
    maximumSelection = 8,
    alreadyOpen = false,
    delayedMount = false
} = {}) {
    const targetLabels = presetMetrics.map(([, label]) => label);
    const otherLabels = [
        '成交金额', '在线人数', '成交人数', '商品点击率',
        '实时在线人数', '直播间用户支付金额', '成交件数', '直播间曝光人数'
    ];
    const minimumSelection = 6;
    let selected = new Set(initialSelection ?? [
        ...targetLabels.slice(0, 4), ...otherLabels.slice(0, maximumSelection - 4)
    ]);
    let draft = new Set(selected);
    let modalOpen = alreadyOpen;
    let optionsState = delayedMount ? 'empty' : 'ready';
    const actions = [];

    function control(textContent, click) {
        return { textContent, disabled: false, click };
    }

    const checkboxes = [...targetLabels, ...otherLabels].filter(label => label !== missingMetric).map(label => {
        function isDisabled() {
            if (optionsState !== 'ready') return true;
            return draft.has(label) ? draft.size <= minimumSelection : draft.size >= maximumSelection;
        }

        const wrapper = control(label, () => {
            if (isDisabled()) {
                actions.push(['blocked', label, draft.size]);
            } else if (draft.delete(label)) {
                actions.push(['uncheck', label, draft.size]);
            } else {
                draft.add(label);
                actions.push(['check', label, draft.size]);
            }
        });
        return {
            get checked() { return optionsState === 'ready' && draft.has(label); },
            get disabled() { return isDisabled(); },
            closest: () => wrapper,
            click: wrapper.click
        };
    });

    const cancel = control('取消', () => {
        actions.push(['cancel']);
        modalOpen = false;
        draft = new Set(selected);
    });
    const confirm = control('确认', () => {
        actions.push(['confirm']);
        selected = new Set(draft);
        modalOpen = false;
    });
    const trigger = control('', () => {
        actions.push(['open']);
        modalOpen = true;
    });
    const otherTrigger = control('', () => actions.push(['other']));
    const modal = {
        getClientRects: () => [{ width: 100, height: 25 }],
        querySelectorAll(selector) {
            if (selector === 'input[type="checkbox"]') return optionsState === 'empty' ? [] : checkboxes;
            if (selector === 'button') return [cancel, confirm];
            return [];
        }
    };

    return {
        actions,
        get selected() { return [...selected]; },
        mountOptions() { optionsState = 'unchecked'; },
        loadSelection() { optionsState = 'ready'; },
        querySelectorAll(selector) {
            if (selector === '[class*="topBtn--"] > [class*="config--"]') return [trigger, otherTrigger];
            if (selector === '[class*="checkboxModalWrap"]' && modalOpen) return [modal];
            return [];
        }
    };
}

const productPresetLabels = [
    '累计用户支付金额',
    '商品曝光人数',
    '商品点击人数',
    '曝光-点击转化率',
    '点击-成交转化率',
    '商品千次曝光成交'
];

function createProductPicker({
    initialSelection = [
        '库存', '近5分钟商品点击次数', '曝光-成交转化率',
        '累计用户支付金额', '分钟最高用户支付金额', '未支付订单数'
    ],
    initialSort = 'none'
} = {}) {
    const otherLabels = [
        '库存', '近5分钟商品点击次数', '曝光-成交转化率',
        '分钟最高用户支付金额', '未支付订单数', '近5分钟用户支付金额', '累计成交件数'
    ];
    let selected = new Set(initialSelection);
    let draft = new Set(selected);
    let productSectionActive = false;
    let modalOpen = false;
    let sortDirection = initialSort;
    const actions = [];

    function control(textContent, click) {
        return {
            textContent,
            disabled: false,
            click,
            getClientRects: () => [{ width: 100, height: 25 }]
        };
    }

    const productTab = control('商品', () => {
        actions.push(['open-product']);
        productSectionActive = true;
    });
    productTab.getAttribute = name => {
        if (name === 'href') return '#product';
        if (name === 'aria-selected') return String(productSectionActive);
        return null;
    };

    const config = control('配置列表', () => {
        actions.push(['open-config']);
        modalOpen = true;
        draft = new Set(selected);
    });

    const checkboxes = [...new Set([...productPresetLabels, ...otherLabels])].map(label => {
        function isDisabled() {
            return draft.has(label) ? draft.size <= 1 : draft.size >= 6;
        }

        const wrapper = control(label, () => {
            if (isDisabled()) {
                actions.push(['blocked', label, draft.size]);
            } else if (draft.delete(label)) {
                actions.push(['uncheck', label, draft.size]);
            } else {
                draft.add(label);
                actions.push(['check', label, draft.size]);
            }
        });
        return {
            get checked() { return draft.has(label); },
            get disabled() { return isDisabled(); },
            closest: () => wrapper,
            click: wrapper.click
        };
    });

    const cancel = control('取消', () => {
        actions.push(['cancel']);
        modalOpen = false;
        draft = new Set(selected);
    });
    const confirm = control('确认', () => {
        actions.push(['confirm']);
        selected = new Set(draft);
        modalOpen = false;
    });
    const modal = {
        getClientRects: () => [{ width: 100, height: 25 }],
        querySelectorAll(selector) {
            if (selector === 'input[type="checkbox"]') return checkboxes;
            if (selector === 'button') return [cancel, confirm];
            return [];
        }
    };

    const paymentHeader = control('累计用户支付金额', () => {
        sortDirection = sortDirection === 'none' ? 'ascending' :
            sortDirection === 'ascending' ? 'descending' : 'none';
        actions.push(['sort', sortDirection]);
    });
    paymentHeader.getAttribute = name => name === 'aria-sort' ? sortDirection : null;

    return {
        actions,
        get selected() { return [...selected]; },
        get sortDirection() { return sortDirection; },
        querySelectorAll(selector) {
            if (selector.includes('href="#product"') || selector.includes('[role="tab"]')) return [productTab];
            if (selector === '[class*="checkboxModalWrap"]' && modalOpen) return [modal];
            if (selector.includes('button') && productSectionActive && !modalOpen) return [config];
            if ((selector.includes('th') || selector.includes('columnheader')) && productSectionActive && !modalOpen) {
                return [paymentHeader];
            }
            return [];
        }
    };
}

async function waitForPreset(sentinel, condition) {
    for (let attempt = 0; attempt < 65 && !condition(); attempt++) {
        sentinel.advanceTime(80);
        await new Promise(setImmediate);
    }
    assert.ok(condition(), 'The native metric selection did not reach the expected state');
}

test('the sentinel leaves pages outside the Compass shop screen scope untouched', () => {
    const outsideScope = [
        ['another host', `https://live.douyin.com/screen/live/shop?live_room_id=${roomId}`],
        ['a look-alike host', `https://compass.jinritemai.com.example.test/screen/live/shop?live_room_id=${roomId}`],
        ['another path', `${shopScreenUrl}/other?live_room_id=${roomId}`],
        ['HTTP', `http://compass.jinritemai.com/screen/live/shop?live_room_id=${roomId}`],
        ['another port', `https://compass.jinritemai.com:9443/screen/live/shop?live_room_id=${roomId}`],
        ['a missing room ID', shopScreenUrl],
        ['an empty room ID', `${shopScreenUrl}?live_room_id=`],
        ['a nonnumeric room ID', `${shopScreenUrl}?live_room_id=123x`],
        ['a zero room ID', `${shopScreenUrl}?live_room_id=0`],
        ['a repeated room ID key', `${pageUrl}&live_room_id=${otherRoomId}`],
        ['a different room ID key', `${shopScreenUrl}?room_id=${roomId}`],
        ['an embedded shop screen', pageUrl, false]
    ];

    for (const [label, address, topLevel] of outsideScope) {
        const sentinel = startSentinel({ address, topLevel });
        sentinel.capture(metrics);
        sentinel.heartbeat();
        sentinel.advanceTime(3000);
        assert.equal(sentinel.hasHud, false, label);
        assert.equal(sentinel.hasNetworkHook, false, label);
        assert.equal(sentinel.eventRequests.length, 0, label);
        assert.equal(sentinel.heartbeatRequests.length, 0, label);
    }
});

test('the shop screen accepts other query parameters and its data fragment', () => {
    const sentinel = startSentinel({ address: `${shopScreenUrl}?source=workspace&live_room_id=${roomId}&from_page=list#data` });
    assert.equal(sentinel.hasHud, true);
    assert.equal(sentinel.hasNetworkHook, true);
    sentinel.capture(metrics);
    assertSingleMetricSubmission(sentinel);
    sentinel.heartbeat();
    assert.equal(sentinel.heartbeatRequests[0].roomId, roomId);
});

test('navigation off the shop screen prevents new captures, queued sends and heartbeats', () => {
    const sentinel = startSentinel();
    sentinel.capture(metrics);
    sentinel.capture(metricsResponse(24567));
    assert.equal(sentinel.eventRequests.length, 1);

    sentinel.navigate(`/screen/live/review?live_room_id=${roomId}`);
    const priorResponseBodyReads = sentinel.responseBodyReads;
    sentinel.capture(metricsResponse(37890));
    assert.equal(sentinel.responseBodyReads, priorResponseBodyReads);
    sentinel.eventRequests[0].reply();
    sentinel.heartbeat();
    sentinel.advanceTime(3000);
    assert.equal(sentinel.eventRequests.length, 1);
    assert.equal(sentinel.heartbeatRequests.length, 0);
});

test('Fetch returns the page response without reading it after navigation off the shop screen', async () => {
    const pendingResponses = [];
    const sentinel = startSentinel({
        pageFetch: () => new Promise(resolve => pendingResponses.push(resolve))
    });
    let clones = 0;
    const response = {
        url: metricsUrl,
        clone() {
            clones++;
            return { text: async () => metrics };
        }
    };

    const activeRequest = sentinel.fetchTarget();
    pendingResponses.shift()(response);
    assert.equal(await activeRequest, response);
    assert.equal(clones, 1);
    assert.equal(sentinel.eventRequests[0].events[0].sourceChannel, 'fetch');
    sentinel.eventRequests[0].reply();

    const pendingRequest = sentinel.fetchTarget();
    sentinel.navigate('/screen/live/review');
    pendingResponses.shift()(response);
    assert.equal(await pendingRequest, response);
    assert.equal(clones, 1);
    assert.equal(sentinel.eventRequests.length, 1);
});

test('the sentinel skips an XHR for another room and pauses when the page switches rooms', () => {
    const sentinel = startSentinel();
    const otherMetricsUrl = new URL(metricsUrl);
    otherMetricsUrl.searchParams.set('room_id', otherRoomId);
    sentinel.capture(metrics, { requestUrl: otherMetricsUrl.href });
    assert.equal(sentinel.eventRequests.length, 0);

    sentinel.capture(metrics);
    assertSingleMetricSubmission(sentinel);

    sentinel.navigate(`${shopScreenUrl}?live_room_id=${otherRoomId}`);
    const priorResponseBodyReads = sentinel.responseBodyReads;
    sentinel.capture(metrics, { requestUrl: otherMetricsUrl.href });
    sentinel.heartbeat();
    assert.equal(sentinel.responseBodyReads, priorResponseBodyReads);
    assert.equal(sentinel.eventRequests.length, 1);
    assert.equal(sentinel.heartbeatRequests.length, 0);
});

test('a scheduled retry sends nothing after the shop screen loses its room ID', () => {
    const sentinel = startSentinel();
    sentinel.capture(metrics);
    assert.equal(sentinel.eventRequests.length, 1);
    sentinel.eventRequests[0].reply(503);

    sentinel.navigate(shopScreenUrl);
    sentinel.advanceTime(1000);
    sentinel.heartbeat();
    assert.equal(sentinel.eventRequests.length, 1);
    assert.equal(sentinel.heartbeatRequests.length, 0);
});

test('the capture panel opens and shows an empty state before observing an API response', () => {
    const sentinel = startSentinel();
    assert.equal(sentinel.element('panel').hidden, true);
    sentinel.openPanel();
    assert.equal(sentinel.element('panel').hidden, false);
    assert.equal(sentinel.element('toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(sentinel.element('response-count').textContent.trim(), '0');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '0');
    assert.equal(sentinel.element('sent-count').textContent.trim(), '0');
    assert.equal(sentinel.element('empty').hidden, false);
    assert.match(sentinel.element('empty').textContent, /等待罗盘页面返回目标接口数据/);
});

test('the capture panel exposes a Start button', () => {
    const sentinel = startSentinel();
    sentinel.openPanel();
    const start = sentinel.element('start');
    assert.equal(start.tagName, 'button');
    assert.equal(start.getAttribute('type'), 'button');
    assert.match(start.textContent, /开始/);
});

test('the capture panel exposes an independent product collection button', () => {
    const sentinel = startSentinel();
    sentinel.openPanel();
    const start = sentinel.element('product-start');
    assert.equal(start.tagName, 'button');
    assert.equal(start.getAttribute('type'), 'button');
    assert.match(start.textContent, /商品/);
});

test('Product collection selects exactly six metrics and sorts cumulative payment descending', async () => {
    const nativePicker = createProductPicker();
    const sentinel = startSentinel({ nativePicker });
    sentinel.openPanel();
    sentinel.element('product-start').dispatchEvent(new Event('click'));

    await waitForPreset(sentinel, () => sentinel.element('product-status').dataset.state === 'ready');
    assert.deepEqual(nativePicker.selected.toSorted(), productPresetLabels.toSorted());
    assert.equal(nativePicker.sortDirection, 'descending');
    assert.deepEqual(nativePicker.actions.slice(0, 2).map(([type]) => type), ['open-product', 'open-config']);
    assert.equal(nativePicker.actions.filter(([type]) => type === 'confirm').length, 1);
    assert.deepEqual(nativePicker.actions.filter(([type]) => type === 'sort'), [
        ['sort', 'ascending'],
        ['sort', 'descending']
    ]);
});

test('Product collection preserves an existing descending order after applying its six metrics', async () => {
    const nativePicker = createProductPicker({
        initialSelection: productPresetLabels,
        initialSort: 'descending'
    });
    const sentinel = startSentinel({ nativePicker });
    sentinel.openPanel();
    sentinel.element('product-start').dispatchEvent(new Event('click'));

    await waitForPreset(sentinel, () => sentinel.element('product-status').dataset.state === 'ready');
    assert.deepEqual(nativePicker.selected.toSorted(), productPresetLabels.toSorted());
    assert.equal(nativePicker.sortDirection, 'descending');
    assert.equal(nativePicker.actions.some(([type]) => type === 'sort'), false);
});

test('Start replaces a mixed twelve-metric selection with exactly the required eight and captures the next response', async () => {
    const nativePicker = createNativePicker({ maximumSelection: 12 });
    const sentinel = startSentinel({ nativePicker });
    const initialSelection = nativePicker.selected;
    sentinel.openPanel();
    assert.deepEqual(nativePicker.actions, []);
    assert.deepEqual(nativePicker.selected, initialSelection);
    assert.equal(sentinel.element('preset-status').dataset.state, 'idle');

    sentinel.capture(presetMetricsResponse());
    assert.equal(sentinel.eventRequests.length, 1);
    sentinel.eventRequests[0].reply();
    assert.equal(sentinel.element('preset-status').dataset.state, 'idle');

    sentinel.element('start').dispatchEvent(new Event('click'));
    await waitForPreset(sentinel, () => sentinel.element('preset-status').dataset.state === 'waiting');
    assert.equal(nativePicker.actions[0][0], 'open');
    assert.equal(nativePicker.actions.some(([type]) => type === 'other'), false);
    assert.equal(nativePicker.actions.filter(([type]) => type === 'confirm').length, 1);
    assert.deepEqual(nativePicker.selected.toSorted(), presetMetrics.map(([, label]) => label).toSorted());
    assert.equal(sentinel.eventRequests.length, 1);

    sentinel.capture(metrics);
    assert.equal(sentinel.element('preset-status').dataset.state, 'waiting');
    assert.equal(sentinel.eventRequests.length, 2);
    sentinel.eventRequests[1].reply();

    sentinel.capture(presetMetricsResponse());
    await waitForPreset(sentinel, () => sentinel.element('preset-status').dataset.state === 'ready');
    assert.equal(sentinel.element('start').textContent.trim(), '重新配置');
    assert.equal(sentinel.eventRequests.length, 3);
    const [event] = sentinel.eventRequests[2].events;
    assert.equal(event.eventType, 'CORE_METRICS');
    assert.equal(event.roomId, roomId);
    assert.equal(event.gpm_amount_yuan, 1823.45);
    assert.equal(event.watch_pay_ucnt_ratio, 0.0582);
    assert.equal(event.avg_watch_duration_seconds, 53);
    assert.equal(event.ad_cost_yuan, 2376);
    assert.equal(event.old_fans_pay_ucnt_ratio, 0.0625);
    assert.equal(event.interact_watch_ucnt_ratio, 0.03125);
    assert.equal(event.follow_anchor_watch_ucnt_ratio, 0.0075);
    assert.equal(event.real_refund_amt_ratio, 0.095);
});

test('Start adds two missing metrics in an already-open dialog with six required metrics selected', async () => {
    const labels = presetMetrics.map(([, label]) => label);
    const nativePicker = createNativePicker({ initialSelection: labels.slice(0, 6), maximumSelection: 12, alreadyOpen: true });
    const sentinel = startSentinel({ nativePicker });
    sentinel.openPanel();
    sentinel.element('start').dispatchEvent(new Event('click'));

    await waitForPreset(sentinel, () => sentinel.element('preset-status').dataset.state === 'waiting');
    assert.deepEqual(nativePicker.actions, [
        ['check', labels[6], 7],
        ['check', labels[7], 8],
        ['confirm']
    ]);
    assert.deepEqual(nativePicker.selected.toSorted(), labels.toSorted());
});

test('Reconfigure removes unrelated metrics when all eight required metrics are already selected', async () => {
    const labels = presetMetrics.map(([, label]) => label);
    const extraLabels = ['实时在线人数', '直播间用户支付金额', '成交人数', '成交件数'];
    const nativePicker = createNativePicker({
        initialSelection: [...labels, ...extraLabels],
        maximumSelection: 12
    });
    const sentinel = startSentinel({ nativePicker });
    sentinel.openPanel();
    sentinel.element('start').dispatchEvent(new Event('click'));

    await waitForPreset(sentinel, () => sentinel.element('preset-status').dataset.state === 'waiting');
    assert.equal(nativePicker.actions.filter(([type]) => type === 'confirm').length, 1);
    assert.deepEqual(nativePicker.selected.toSorted(), labels.toSorted());
    assert.ok(extraLabels.every(label => !nativePicker.selected.includes(label)));
});

test('Start waits for a visible native dialog to mount its options and restore its selections', async () => {
    const nativePicker = createNativePicker({ maximumSelection: 12, delayedMount: true });
    const sentinel = startSentinel({ nativePicker });
    sentinel.openPanel();
    const status = sentinel.element('preset-status');
    sentinel.element('start').dispatchEvent(new Event('click'));

    await waitForPreset(sentinel, () => nativePicker.actions.length > 0);
    assert.equal(status.dataset.state, 'configuring');
    assert.deepEqual(nativePicker.actions, [['open']]);

    nativePicker.mountOptions();
    sentinel.advanceTime(160);
    await new Promise(setImmediate);
    assert.equal(status.dataset.state, 'configuring');
    assert.deepEqual(nativePicker.actions, [['open']]);

    nativePicker.loadSelection();
    await waitForPreset(sentinel, () => status.dataset.state === 'waiting');
    assert.equal(nativePicker.actions.some(([type]) => type === 'cancel'), false);
    assert.equal(nativePicker.actions.filter(([type]) => type === 'confirm').length, 1);
    assert.deepEqual(nativePicker.selected.toSorted(), presetMetrics.map(([, label]) => label).toSorted());
});

test('Start uses free slots before replacing other metrics at the native maximum', async () => {
    const labels = presetMetrics.map(([, label]) => label);
    const nativePicker = createNativePicker({ initialSelection: [...labels.slice(0, 4), '成交金额', '在线人数'] });
    const sentinel = startSentinel({ nativePicker });
    sentinel.openPanel();
    sentinel.element('start').dispatchEvent(new Event('click'));

    await waitForPreset(sentinel, () => sentinel.element('preset-status').dataset.state === 'waiting');
    assert.deepEqual(nativePicker.actions.slice(1, -1).map(([type,, count]) => [type, count]), [
        ['check', 7], ['check', 8], ['uncheck', 7], ['check', 8], ['uncheck', 7], ['check', 8]
    ]);
    assert.deepEqual(nativePicker.selected.toSorted(), labels.toSorted());
});

test('Start never changes or saves a native dialog with fewer than six initial selections', async () => {
    const initialSelection = presetMetrics.slice(0, 5).map(([, label]) => label);
    const nativePicker = createNativePicker({ initialSelection, maximumSelection: 12 });
    const sentinel = startSentinel({ nativePicker });
    sentinel.openPanel();
    sentinel.element('start').dispatchEvent(new Event('click'));

    const status = sentinel.element('preset-status');
    await waitForPreset(sentinel, () => status.dataset.state === 'error' || status.dataset.state === 'waiting');
    assert.equal(status.dataset.state, 'error');
    assert.equal(nativePicker.actions[0][0], 'open');
    assert.ok(nativePicker.actions.every(([type]) => type === 'open' || type === 'cancel'));
    assert.deepEqual(nativePicker.selected, initialSelection);
    assert.equal(sentinel.element('start').disabled, false);
    assert.equal(sentinel.eventRequests.length, 0);
});

test('Start leaves the native selection uncommitted when a required option is missing', async () => {
    const nativePicker = createNativePicker({ missingMetric: '退款金额占比' });
    const sentinel = startSentinel({ nativePicker });
    const initialSelection = nativePicker.selected;
    sentinel.openPanel();
    sentinel.element('start').dispatchEvent(new Event('click'));

    await waitForPreset(sentinel, () => sentinel.element('preset-status').dataset.state === 'error');
    assert.equal(nativePicker.actions[0][0], 'open');
    assert.equal(nativePicker.actions.some(([type]) => type === 'confirm'), false);
    assert.deepEqual(nativePicker.selected, initialSelection);
    assert.equal(sentinel.element('start').disabled, false);
    assert.equal(sentinel.eventRequests.length, 0);
});

test('a product list XHR returns product information and all six configured metrics after product collection starts', async () => {
    const nativePicker = createProductPicker({
        initialSelection: productPresetLabels,
        initialSort: 'descending'
    });
    const sentinel = startSentinel({ nativePicker });

    sentinel.openPanel();
    sentinel.element('product-start').dispatchEvent(new Event('click'));
    await waitForPreset(sentinel, () => sentinel.element('product-status').dataset.state === 'ready');

    sentinel.capture(productListResponse(), { requestUrl: productListUrl });

    assert.equal(sentinel.eventRequests.length, 1);
    const [event] = sentinel.eventRequests[0].events;
    assert.equal(event.eventType, 'PRODUCT_LIST');
    assert.equal(event.sourceChannel, 'xhr');
    assert.equal(event.roomId, roomId);
    assert.deepEqual(event.page, { current: 0, size: 20, total: 42 });
    assert.deepEqual(event.sort, { field: 'pay_amt', order: 'desc' });
    assert.deepEqual(event.indexSelected, [
        'pay_amt',
        'product_show_ucnt',
        'product_click_ucnt',
        'product_show_click_ucnt_ratio',
        'product_click_pay_ucnt_ratio',
        'gpm'
    ]);
    assert.deepEqual(event.products, [{
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
    }]);
});

test('an incomplete response during configuration does not replace the first complete product response', async () => {
    const nativePicker = createProductPicker({
        initialSelection: productPresetLabels,
        initialSort: 'descending'
    });
    const sentinel = startSentinel({ nativePicker });
    const incomplete = JSON.parse(productListResponse(120000));
    incomplete.data.data_head.pop();

    sentinel.openPanel();
    sentinel.element('product-start').dispatchEvent(new Event('click'));
    sentinel.capture(productListResponse(110000), { requestUrl: productListUrl });
    sentinel.capture(JSON.stringify(incomplete), { requestUrl: productListUrl });
    await waitForPreset(sentinel, () => sentinel.element('product-status').dataset.state === 'ready');

    assert.equal(sentinel.eventRequests.length, 1);
    assert.equal(sentinel.eventRequests[0].events[0].products[0].product_pay_amount_yuan, 1100);
});

test('product collection starts its hourly reporting clock on the first click without resetting it on reconfigure', async () => {
    const nativePicker = createProductPicker({
        initialSelection: productPresetLabels,
        initialSort: 'descending'
    });
    const sentinel = startSentinel({ nativePicker });

    sentinel.openPanel();
    sentinel.capture(productListResponse(100000), { requestUrl: productListUrl });
    assert.equal(sentinel.eventRequests.length, 0, 'responses before the first click are observed but not reported');
    assert.equal(sentinel.element('response-count').textContent.trim(), '1');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '0');

    sentinel.element('product-start').dispatchEvent(new Event('click'));
    const firstClickAt = sentinel.now;
    await waitForPreset(sentinel, () => sentinel.element('product-status').dataset.state === 'ready');
    assert.equal(sentinel.eventRequests.length, 0, 'a response observed before configuration is not replayed');

    sentinel.capture(productListResponse(110000), { requestUrl: productListUrl });
    assert.equal(sentinel.eventRequests.length, 1, 'the first complete response after configuration is reported immediately');
    assert.equal(sentinel.eventRequests[0].events[0].products[0].product_pay_amount_yuan, 1100);
    assert.equal(sentinel.eventRequests[0].events[0].productCollectionStartedAtIso, new Date(firstClickAt).toISOString());
    assert.equal(sentinel.eventRequests[0].events[0].productReportSequence, 1);
    sentinel.eventRequests[0].reply();

    sentinel.advanceTime(firstClickAt + 30 * 60 * 1000 - sentinel.now);
    sentinel.capture(productListResponse(120000), { requestUrl: productListUrl });
    assert.equal(sentinel.eventRequests.length, 1, 'responses inside the first hour only refresh the cached product data');
    const productRow = sentinel.element('events').children.find(child => child.dataset?.route === 'productList');
    assert.ok(productRow, 'the latest product response remains visible in the observation cache');
    assert.equal(JSON.parse(productRow.querySelector('.parsed').textContent).products[0].product_pay_amount_yuan, 1200);

    sentinel.element('product-start').dispatchEvent(new Event('click'));
    await waitForPreset(sentinel, () => sentinel.element('product-status').dataset.state === 'ready');

    sentinel.advanceTime(firstClickAt + 60 * 60 * 1000 - sentinel.now - 1);
    sentinel.capture(productListResponse(130000), { requestUrl: productListUrl });
    assert.equal(sentinel.eventRequests.length, 1, 'reconfiguring does not move the original hourly boundary');

    sentinel.advanceTime(1);
    assert.equal(sentinel.eventRequests.length, 1, 'reaching the boundary does not report until a new response arrives');
    sentinel.capture(productListResponse(140000), { requestUrl: productListUrl });
    assert.equal(sentinel.eventRequests.length, 2, 'the first response at the original one-hour boundary is reported');
    assert.equal(sentinel.eventRequests[1].events[0].products[0].product_pay_amount_yuan, 1400);
    assert.equal(sentinel.eventRequests[1].events[0].productCollectionStartedAtIso, new Date(firstClickAt).toISOString());
    assert.equal(sentinel.eventRequests[1].events[0].productReportSequence, 2);
});

test('a metric captured on XHR load immediately starts an event request', () => {
    const sentinel = startSentinel();
    sentinel.capture(metrics, { notifyDone: false });
    assert.equal(sentinel.element('toggle-status').textContent, '响应 1');
    sentinel.openPanel();

    assert.equal(sentinel.element('response-count').textContent.trim(), '1');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '1');
    assert.equal(sentinel.element('sent-count').textContent.trim(), '0');
    assert.equal(sentinel.eventRequests.length, 1);
    assert.equal(sentinel.eventRequests[0].events.length, 1);
    assert.equal(sentinel.element('empty').hidden, true);
    const row = sentinel.metricsRow();
    assert.equal(row.dataset.status, 'parsed');
    assert.match(row.querySelector('.data-summary').textContent, /成交金额\s+\S*123\.45\s+在线 32 人/);
    const payload = JSON.parse(row.querySelector('.parsed').textContent);
    assert.equal(payload.gmv_amount_yuan, 123.45);
    assert.equal(payload.online_viewers_count, 32);
    assert.equal(row.querySelector('.raw pre').textContent, metrics.replace('\u00B7', ' '));

    sentinel.eventRequests[0].reply();
    assert.equal(sentinel.element('sent-count').textContent.trim(), '1');
});

test('the panel distinguishes an invalid target response from a captured event', () => {
    const sentinel = startSentinel();
    sentinel.openPanel();
    sentinel.capture('<html>not JSON</html>');

    assert.equal(sentinel.element('response-count').textContent.trim(), '1');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '0');
    assert.equal(sentinel.element('sent-count').textContent.trim(), '0');
    assert.equal(sentinel.eventRequests.length, 0);
    const row = sentinel.metricsRow();
    assert.equal(row.dataset.status, 'invalidJson');
    assert.equal(row.querySelector('.status').textContent, '响应不是有效 JSON');
    assert.equal(row.querySelector('.parsed').hidden, true);
    assert.equal(row.querySelector('.raw pre').textContent, '<html>not JSON</html>');
});

test('the panel identifies a valid response with no business data', () => {
    const sentinel = startSentinel();
    sentinel.openPanel();
    sentinel.capture('{"data":null}');

    assert.equal(sentinel.element('response-count').textContent.trim(), '1');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '0');
    assert.equal(sentinel.eventRequests.length, 0);
    const row = sentinel.metricsRow();
    assert.equal(row.dataset.status, 'empty');
    assert.equal(row.querySelector('.status').textContent, '无可用数据');
});

test('a Compass business error is kept in the panel without submitting a metrics event', () => {
    const sentinel = startSentinel();
    const errorResponse = JSON.stringify({ st: 11001, code: 11001, data: null, msg: 'Example request rejected' });
    sentinel.capture(errorResponse, { requestUrl: signedMetricsUrl });
    sentinel.openPanel();

    assert.equal(sentinel.element('response-count').textContent.trim(), '1');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '0');
    assert.equal(sentinel.element('sent-count').textContent.trim(), '0');
    assert.equal(sentinel.eventRequests.length, 0);
    const row = sentinel.metricsRow();
    assert.equal(row.dataset.status, 'apiError');
    assert.equal(row.querySelector('.status').textContent, '接口返回错误 11001');
    assert.equal(row.querySelector('.parsed').hidden, true);
    assert.equal(row.querySelector('.raw pre').textContent, errorResponse);
});

function assertSingleMetricSubmission(sentinel) {
    sentinel.openPanel();
    assert.equal(sentinel.element('response-count').textContent.trim(), '1');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '1');
    assert.equal(sentinel.eventRequests.length, 1);
    const { events } = sentinel.eventRequests[0];
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'CORE_METRICS');
    assert.equal(events[0].roomId, roomId);
    assert.equal(events[0].gmv_amount_yuan, 123.45);
    assert.equal(events[0].online_viewers_count, 32);
    sentinel.eventRequests[0].reply();
    assert.equal(sentinel.element('sent-count').textContent.trim(), '1');
}

test('an XHR is captured at readyState DONE even when load is never delivered', () => {
    const sentinel = startSentinel();
    sentinel.capture(metrics, { notifyLoad: false });
    assertSingleMetricSubmission(sentinel);
});

test('captures DONE before a page listener registered after open clears the response', () => {
    const sentinel = startSentinel();
    let pageAborted = false;
    sentinel.capture(metrics, {
        beforeSend(xhr) {
            xhr.addEventListener('readystatechange', () => {
                if (xhr.readyState !== xhr.DONE) return;
                xhr.abort();
                pageAborted = true;
            });
        }
    });
    assert.equal(pageAborted, true);
    assertSingleMetricSubmission(sentinel);
});

test('DONE and load deliver one event when inline and unsafeWindow hooks are both accessible', () => {
    const sentinel = startSentinel({ unsafeWindowAvailable: true });
    sentinel.capture(metrics);
    assertSingleMetricSubmission(sentinel);
});

test('JSON XHR responses are captured using their response object', () => {
    const sentinel = startSentinel();
    sentinel.capture(metrics, { responseType: 'json' });
    assertSingleMetricSubmission(sentinel);
});

test('XHR matching uses the final response URL when the original URL differs', () => {
    const sentinel = startSentinel();
    sentinel.capture(metrics, { requestUrl: '/redirect-to-live-metrics', responseUrl: metricsUrl });
    assertSingleMetricSubmission(sentinel);
});

test('the unsafeWindow fallback captures DONE using the open URL when responseURL is empty', () => {
    const sentinel = startSentinel({ inlineScript: false, unsafeWindowAvailable: true });
    sentinel.capture(metrics, { responseUrl: '', notifyLoad: false });
    assertSingleMetricSubmission(sentinel);
});

test('later captures wait for the active request and drain in order on acknowledgement', () => {
    const sentinel = startSentinel();
    const { eventRequests, heartbeatRequests } = sentinel;
    sentinel.capture(metricsResponse(10000));
    assert.equal(eventRequests.length, 1);
    assert.deepEqual(eventRequests[0].events.map(event => event.gmv_amount_yuan), [100]);

    sentinel.capture(metricsResponse(20000));
    sentinel.capture(metricsResponse(30000));
    sentinel.heartbeat();
    assert.equal(eventRequests.length, 1);
    assert.equal(heartbeatRequests[0].capturedCount, 3);
    assert.equal(heartbeatRequests[0].sentCount, 0);

    eventRequests[0].reply();
    assert.equal(eventRequests.length, 2);
    assert.deepEqual(eventRequests[1].events.map(event => event.gmv_amount_yuan), [200, 300]);
    eventRequests[1].reply();
    sentinel.openPanel();
    assert.equal(sentinel.element('sent-count').textContent.trim(), '3');
});

test('a failed full batch retains its order and IDs until the delayed retry', () => {
    const sentinel = startSentinel();
    const { eventRequests } = sentinel;
    sentinel.capture(metrics);
    assert.equal(eventRequests.length, 1);

    const amounts = Array.from({ length: 30 }, (_, index) => 500 + index);
    for (const amount of amounts) sentinel.capture(metricsResponse(amount * 100));
    eventRequests[0].reply();
    assert.equal(eventRequests.length, 2);
    const failedEvents = eventRequests[1].events;
    assert.deepEqual(failedEvents.map(event => event.gmv_amount_yuan), amounts);

    eventRequests[1].reply(503);
    sentinel.capture(metricsResponse(99900));
    sentinel.heartbeat();
    sentinel.advanceTime(999);
    assert.equal(eventRequests.length, 2);

    sentinel.advanceTime(1);
    assert.equal(eventRequests.length, 3);
    assert.deepEqual(eventRequests[2].events, failedEvents);
    eventRequests[2].reply();
    assert.equal(eventRequests.length, 4);
    assert.deepEqual(eventRequests[3].events.map(event => event.gmv_amount_yuan), [999]);

    eventRequests[3].reply();
    sentinel.openPanel();
    assert.equal(sentinel.element('sent-count').textContent.trim(), '32');
});

test('XHR opens a signed core metrics request with the original URL bytes', () => {
    const sentinel = startSentinel();
    const relativeUrl = signedMetricsUrl.slice(compassOrigin.length);
    sentinel.capture(metrics, {
        requestUrl: relativeUrl,
        responseUrl: signedMetricsUrl,
        beforeSend(xhr) {
            assert.equal(xhr.openedUrl, relativeUrl);
        }
    });
    assertSingleMetricSubmission(sentinel);
});

test('Fetch receives the original signed core metrics URL and returns its response', async () => {
    const response = {
        url: signedMetricsUrl,
        clone: () => ({ text: async () => metrics })
    };
    const sentinel = startSentinel({
        pageFetch: async (requestUrl) => {
            assert.equal(requestUrl, signedMetricsUrl);
            return response;
        }
    });
    assert.equal(await sentinel.fetchTarget(signedMetricsUrl), response);
    assertSingleMetricSubmission(sentinel);
});
