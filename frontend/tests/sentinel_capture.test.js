const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../src/douyin_sentinel.user.js');
const script = new vm.Script(fs.readFileSync(scriptPath, 'utf8'), { filename: scriptPath });
const roomId = '1234567890123456789';
const pageUrl = 'https://compass.jinritemai.com/shop/live/live_screen';
const metricsUrl = new URL(`/compass_api/shop/live/live_screen/core_data?room_id=${roomId}`, pageUrl).href;
const metrics = JSON.stringify({
    data: {
        pay_amt: { value: 12345 },
        display_label: '早场\u00B7活动',
        core_data: [{ index_name: 'current_cnt', value: { value: 32 } }]
    }
});

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

function startSentinel({ inlineScript = true, unsafeWindowAvailable = false } = {}) {
    const intervals = new Map();
    const timeouts = new Map();
    let nextTimeout = 0;
    const pageMessages = [];
    const windowListeners = new Map();
    const submittedEvents = [];

    class MockXhr extends EventTarget {
        static DONE = 4;
        DONE = 4;
        readyState = 0;

        open() {
            this.readyState = 1;
            this.dispatchEvent(new Event('readystatechange'));
        }

        get responseText() {
            if (this.responseType === 'json') {
                throw new DOMException('responseText is unavailable with a JSON response type', 'InvalidStateError');
            }
            return this.readyState === this.DONE ? this.body : '';
        }

        get response() {
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

    const pageWindow = {
        location: new URL(pageUrl),
        EventTarget,
        XMLHttpRequest: MockXhr,
        addEventListener(type, listener) {
            if (!windowListeners.has(type)) windowListeners.set(type, []);
            windowListeners.get(type).push(listener);
        },
        postMessage(data) {
            pageMessages.push({ data: structuredClone(data), source: window, origin: window.location.origin });
        }
    };
    const window = unsafeWindowAvailable ? { ...pageWindow } : pageWindow;
    function deliverPageMessages() {
        for (const message of pageMessages.splice(0)) {
            for (const listener of windowListeners.get('message') || []) listener(message);
        }
    }

    const console = { log() {}, error() {}, warn() {} };
    const body = new TestElement();
    const pageDocument = { currentScript: null };
    const pageContext = vm.createContext({ window: pageWindow, document: pageDocument, XMLHttpRequest: MockXhr, URL, console });
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
        XMLHttpRequest: MockXhr,
        URL,
        console,
        setInterval: (callback, delay) => intervals.set(delay, callback),
        setTimeout(callback) {
            const id = ++nextTimeout;
            timeouts.set(id, callback);
            return id;
        },
        clearTimeout: id => timeouts.delete(id),
        GM_getValue: (_key, fallback) => fallback,
        GM_xmlhttpRequest({ data, onload }) {
            const events = JSON.parse(data).events ?? [];
            submittedEvents.push(...events);
            onload({ status: 200, responseText: JSON.stringify({ status: 'ok', received: events.length, applied: events.length }) });
        }
    });
    deliverPageMessages();
    for (const [id, callback] of [...timeouts]) {
        if (timeouts.delete(id)) callback();
    }
    deliverPageMessages();

    const hud = document.getElementById('douyin-sentinel-hud');
    assert.ok(hud);
    const root = hud.shadowRoot || hud;
    const element = name => {
        const result = root.querySelector(`#douyin-sentinel-${name}`);
        assert.ok(result, `Missing ${name} in the capture panel`);
        return result;
    };

    return {
        element,
        metricsRow() {
            const row = element('events').children.find(child => child.dataset?.route === 'coreData');
            assert.ok(row, 'Missing the core metrics response');
            return row;
        },
        openPanel() {
            element('toggle').dispatchEvent(new Event('click'));
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
        sendBatch() {
            intervals.get(1000)();
            return submittedEvents.splice(0);
        }
    };
}

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

test('an XHR load notification still updates the panel and sends the metrics', () => {
    const sentinel = startSentinel();
    sentinel.capture(metrics, { notifyDone: false });
    assert.equal(sentinel.element('toggle-status').textContent, '响应 1');
    sentinel.openPanel();

    assert.equal(sentinel.element('response-count').textContent.trim(), '1');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '1');
    assert.equal(sentinel.element('sent-count').textContent.trim(), '0');
    assert.equal(sentinel.element('empty').hidden, true);
    const row = sentinel.metricsRow();
    assert.equal(row.dataset.status, 'parsed');
    assert.match(row.querySelector('.data-summary').textContent, /成交金额\s+\S*123\.45\s+在线 32 人/);
    const payload = JSON.parse(row.querySelector('.parsed').textContent);
    assert.equal(payload.gmv_amount_yuan, 123.45);
    assert.equal(payload.online_viewers_count, 32);
    assert.equal(row.querySelector('.raw pre').textContent, metrics.replace('\u00B7', ' '));

    sentinel.sendBatch();
    assert.equal(sentinel.element('sent-count').textContent.trim(), '1');
});

test('the panel distinguishes an invalid target response from a captured event', () => {
    const sentinel = startSentinel();
    sentinel.openPanel();
    sentinel.capture('<html>not JSON</html>');

    assert.equal(sentinel.element('response-count').textContent.trim(), '1');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '0');
    assert.equal(sentinel.element('sent-count').textContent.trim(), '0');
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
    const row = sentinel.metricsRow();
    assert.equal(row.dataset.status, 'empty');
    assert.equal(row.querySelector('.status').textContent, '无可用数据');
});

function assertSingleMetricSubmission(sentinel) {
    sentinel.openPanel();
    assert.equal(sentinel.element('response-count').textContent.trim(), '1');
    assert.equal(sentinel.element('captured-count').textContent.trim(), '1');
    const events = sentinel.sendBatch();
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'CORE_METRICS');
    assert.equal(events[0].roomId, roomId);
    assert.equal(events[0].gmv_amount_yuan, 123.45);
    assert.equal(events[0].online_viewers_count, 32);
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
