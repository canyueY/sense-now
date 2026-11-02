import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebSocketCdpTransport } from '../src/video-index/cdp-websocket.js';
import { createCdpBridge } from '../src/video-index/cdp-bridge.js';

class FakeWebSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = new Map();
    FakeWebSocket.last = this;
    setTimeout(() => this.#emit('open', {}), 0);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  #emit(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
  send(raw) {
    const msg = JSON.parse(raw);
    queueMicrotask(() => this.#emit('message', {
      data: JSON.stringify({
        id: msg.id,
        result: { result: { value: { ok: true, currentTimeMs: 1200, pageUrl: 'https://www.bilibili.com/video/BV1x' } } },
      }),
    }));
  }
  close() {
    this.readyState = 3;
    this.#emit('close', {});
  }
}

test('cdp websocket transport：/json 选 bilibili page，evaluate 返回 byValue', async () => {
  const calls = [];
  const transport = createWebSocketCdpTransport({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => [
          { type: 'page', url: 'chrome://newtab', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/0' },
          { type: 'page', url: 'https://www.bilibili.com/video/BV1x', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/1' },
        ],
      };
    },
  });
  const connected = await transport.connect('http://127.0.0.1:9223');
  assert.equal(connected.ok, true);
  assert.match(FakeWebSocket.last.url, /page\/1$/);
  const sample = await transport.evaluate('1+1');
  assert.equal(sample.ok, true);
  assert.equal(sample.currentTimeMs, 1200);
  assert.deepEqual(calls, ['http://127.0.0.1:9223/json']);
  transport.close();
});

test('cdp websocket transport 接受 bridge 传入的 {href} 对象，并可 disconnect', async () => {
  const t = createWebSocketCdpTransport({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ type: 'page', url: 'https://www.bilibili.com/video/BV1x', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/1' }],
    }),
  });
  const bridge = createCdpBridge({ endpoint: 'http://127.0.0.1:9223', transport: t });
  assert.equal((await bridge.connect()).ok, true);
  const sample = await bridge.sample();
  assert.equal(sample.ok, true);
  bridge.disconnect();
  assert.equal(FakeWebSocket.last.readyState, 3);
});

test('cdp websocket transport 拒绝非 localhost ws 和 page', async () => {
  const badWs = createWebSocketCdpTransport({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ type: 'page', url: 'https://www.bilibili.com/', webSocketDebuggerUrl: 'ws://example.com/devtools/page/1' }],
    }),
  });
  await assert.rejects(() => badWs.connect('http://127.0.0.1:9223'), /localhost/);

  const noPage = createWebSocketCdpTransport({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  await assert.rejects(() => noPage.connect('http://127.0.0.1:9223'), /no cdp page/);
});
