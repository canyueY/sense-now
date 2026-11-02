/**
 * cdp-websocket.js — 基于 Node 全局 WebSocket 的最小 CDP transport。
 *
 * 只连 localhost；先 GET /json 找 bilibili page target，再对 page 的
 * webSocketDebuggerUrl 发 Runtime.evaluate。只用于采样，不下载/不执行页面脚本。
 */

import { assertLocalCdpEndpoint } from './cdp-bridge.js';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function assertLocalWs(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('invalid cdp websocket url'); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('invalid cdp websocket protocol');
  if (!LOCAL_HOSTS.has(u.hostname)) throw new Error('cdp websocket must be localhost');
  return u;
}

export function createWebSocketCdpTransport({
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  connectTimeoutMs = 10_000,
  evaluateTimeoutMs = 10_000,
} = {}) {
  let ws = null;
  let nextId = 0;
  const pending = new Map();

  function rejectAll(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function handleMessage(event) {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (!msg || !Number.isFinite(msg.id)) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) {
      waiter.reject(new Error(`cdp ${msg.error.message || 'error'}`));
      return;
    }
    waiter.resolve(msg.result);
  }

  return {
    async connect(endpoint) {
      const raw = endpoint && typeof endpoint === 'object' && endpoint.href ? endpoint.href : endpoint;
      const ep = assertLocalCdpEndpoint(raw);
      if (!WebSocketImpl) throw new Error('WebSocket not available in this Node runtime');
      if (!fetchImpl) throw new Error('fetch not available in this Node runtime');
      const base = new URL(ep.href);
      const httpOrigin = base.protocol === 'ws:' ? `http://${base.host}` : base.origin;
      const res = await fetchImpl(`${httpOrigin}/json`, { signal: AbortSignal.timeout(connectTimeoutMs) });
      if (!res.ok) throw new Error(`cdp /json HTTP ${res.status}`);
      const targets = await res.json();
      const page = (Array.isArray(targets) ? targets : [])
        .filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl)
        .sort((a, b) => Number(/bilibili\.com/.test(b.url || '')) - Number(/bilibili\.com/.test(a.url || '')))[0];
      if (!page) throw new Error('no cdp page target');
      const wsUrl = assertLocalWs(page.webSocketDebuggerUrl);

      await new Promise((resolve, reject) => {
        const sock = new WebSocketImpl(wsUrl.href);
        const timer = setTimeout(() => {
          try { sock.close(); } catch { /* ignore */ }
          reject(new Error('cdp websocket connect timeout'));
        }, connectTimeoutMs);
        sock.addEventListener('open', () => {
          clearTimeout(timer);
          ws = sock;
          resolve();
        }, { once: true });
        sock.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('cdp websocket error'));
        }, { once: true });
        sock.addEventListener('message', handleMessage);
        sock.addEventListener('close', () => {
          ws = null;
          rejectAll(new Error('cdp websocket closed'));
        });
      });
      return { ok: true, pageUrl: page.url || null };
    },

    async evaluate(expression) {
      if (!ws || ws.readyState !== 1) throw new Error('cdp not connected');
      const id = (nextId += 1);
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('cdp evaluate timeout'));
        }, evaluateTimeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        try {
          ws.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }));
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(e);
        }
      });
      if (result?.exceptionDetails) {
        throw new Error(`cdp evaluate exception: ${result.exceptionDetails.text || 'unknown'}`);
      }
      return result?.result?.value;
    },

    close() {
      rejectAll(new Error('cdp transport closed'));
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    },

    // capture-source/cdp-bridge calls disconnect() on session.stop()
    disconnect() {
      this.close();
    },
  };
}
