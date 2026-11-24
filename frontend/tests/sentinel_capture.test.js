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

class TestElement extends EventTarget {
    children = [];
    dataset = {};
    attributes = new Map();
    hidden = false;
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
    pageFetch
} = {}) {
    const intervals = new Map();
    const timeouts = new Map();
    let nextTimeout = 0;
    let now = 0;
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
    const pageContext = vm.createContext({ window: pageWindow, document: pageDocument, location, XMLHttpRequest: MockXhr, URL, console });
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
        getElementById: id => body.querySelector(`#${id}`)
    };

    script.runInNewContext({
        window,
        unsafeWindow: unsafeWindowAvailable ? pageWindow : undefined,
        document,
        location,
        XMLHttpRequest: MockXhr,
        URL,
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
        async fetchTarget() {
            const response = await pageWindow.fetch(metricsUrl);
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

test('transparently injects all 8 required metrics into core_data request URL on xhr open', () => {
    const sentinel = startSentinel();
    const xhr = new sentinel.pageWindow.XMLHttpRequest();
    const originalUrl = `${compassOrigin}/compass_api/shop/live/live_screen/core_data?room_id=${roomId}&index_selected=stat_cost%2Ccurrent_cnt`;
    xhr.open('GET', originalUrl);

    assert.ok(xhr.openedUrl, 'xhr.openedUrl should be recorded');
    const parsed = new URL(xhr.openedUrl);
    const selected = parsed.searchParams.get('index_selected').split(',');
    const expected = [
        'stat_cost',
        'current_cnt',
        'gpm',
        'watch_pay_ucnt_ratio',
        'avg_watch_duration',
        'old_fans_pay_ucnt_ratio',
        'interact_watch_ucnt_ratio',
        'follow_anchor_watch_ucnt_ratio',
        'real_refund_amt_ratio'
    ];
    for (const key of expected) {
        assert.ok(selected.includes(key), `Missing expected metric in URL: ${key}`);
    }
});
