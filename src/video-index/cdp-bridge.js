/**
 * cdp-bridge.js — 仅 localhost CDP；内置固定脚本，不执行用户 JS。
 */

import { assertSafeBilibiliUrl } from './url-allowlist.js';

const MAX_SAMPLE_JSON = 64 * 1024;

export function assertLocalCdpEndpoint(raw) {
  const s = String(raw || '').trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    const err = new Error('invalid cdp endpoint');
    err.code = 'BAD_CDP';
    throw err;
  }
  const okProto = u.protocol === 'http:' || u.protocol === 'ws:';
  if (!okProto) {
    const err = new Error('cdp endpoint must be http:// or ws:// on localhost');
    err.code = 'BAD_CDP';
    throw err;
  }
  const host = u.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    const err = new Error('cdp endpoint must be localhost/127.0.0.1');
    err.code = 'BAD_CDP';
    throw err;
  }
  const port = Number(u.port || (u.protocol === 'http:' ? 80 : 80));
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    const err = new Error('invalid cdp port');
    err.code = 'BAD_CDP';
    throw err;
  }
  return { href: u.href, host, port };
}

/** 内置只读采样表达式（字符串常量，不接受用户注入）。 */
export const BUILTIN_VIDEO_SAMPLE_EXPRESSION = `(() => {
  const v = document.querySelector('video');
  if (!v) return { ok: false, reason: 'no_video' };
  const r = v.getBoundingClientRect();
  return {
    ok: true,
    currentTimeMs: Math.round((v.currentTime || 0) * 1000),
    durationMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null,
    paused: !!v.paused,
    ended: !!v.ended,
    playbackRate: Number(v.playbackRate) || 1,
    readyState: Number(v.readyState) || 0,
    visibilityState: document.visibilityState || 'unknown',
    pageUrl: String(location.href || '').slice(0, 500),
    videoRect: { x: r.x, y: r.y, width: r.width, height: r.height },
    devicePixelRatio: Number(window.devicePixelRatio) || 1,
  };
})()`;

export function validateCdpSample(raw, { sampledAtMonotonicMs = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') {
    const err = new Error('invalid cdp sample');
    err.code = 'BAD_SAMPLE';
    throw err;
  }
  const text = JSON.stringify(raw);
  if (Buffer.byteLength(text, 'utf8') > MAX_SAMPLE_JSON) {
    const err = new Error('cdp sample too large');
    err.code = 'BAD_SAMPLE';
    throw err;
  }
  if (raw.ok === false) {
    return {
      ok: false,
      reason: String(raw.reason || 'unknown').slice(0, 64),
      sampledAtMonotonicMs,
    };
  }
  const pageUrl = String(raw.pageUrl || '').slice(0, 500);
  if (pageUrl) {
    try { assertSafeBilibiliUrl(pageUrl); } catch {
      const err = new Error('cdp pageUrl not an allowed bilibili page');
      err.code = 'BAD_SAMPLE';
      throw err;
    }
  }
  const rate = Number(raw.playbackRate);
  const sample = {
    ok: true,
    sampledAtMonotonicMs,
    currentTimeMs: Math.max(0, Math.floor(Number(raw.currentTimeMs) || 0)),
    durationMs: raw.durationMs == null ? null : Math.max(0, Math.floor(Number(raw.durationMs))),
    paused: Boolean(raw.paused),
    ended: Boolean(raw.ended),
    playbackRate: Number.isFinite(rate) && rate > 0 && rate <= 16 ? rate : 1,
    readyState: Math.max(0, Math.min(4, Math.floor(Number(raw.readyState) || 0))),
    visibilityState: String(raw.visibilityState || 'unknown').slice(0, 32),
    pageUrl,
    videoRect: sanitizeRect(raw.videoRect),
    devicePixelRatio: Math.min(8, Math.max(0.25, Number(raw.devicePixelRatio) || 1)),
  };
  return sample;
}

function sanitizeRect(r) {
  if (!r || typeof r !== 'object') return null;
  const nums = ['x', 'y', 'width', 'height'].map((k) => Number(r[k]));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = nums.map((n) => Math.floor(n));
  if (width <= 0 || height <= 0 || width * height > 80_000_000) return null;
  return { x, y, width, height };
}

/**
 * 可注入 transport 的 CDP bridge。默认不连真实浏览器。
 */
export function createCdpBridge({
  endpoint,
  transport = null,
  clock = () => Date.now(),
} = {}) {
  const ep = endpoint ? assertLocalCdpEndpoint(endpoint) : null;
  let connected = false;
  let lastError = null;

  async function connect() {
    if (!ep) {
      return { ok: false, reason: 'unavailable', detail: 'no cdpEndpoint' };
    }
    if (!transport || typeof transport.connect !== 'function') {
      return {
        ok: false,
        reason: 'unavailable',
        detail: 'cdp transport not configured (inject in tests; see README for helper profile)',
      };
    }
    try {
      await transport.connect(ep);
      connected = true;
      lastError = null;
      return { ok: true, endpoint: ep.href };
    } catch (e) {
      connected = false;
      lastError = e.message;
      return { ok: false, reason: 'unavailable', detail: e.message };
    }
  }

  async function sample() {
    if (!connected || !transport?.evaluate) {
      return {
        ok: false,
        reason: 'disconnected',
        sampledAtMonotonicMs: clock(),
        timeSource: 'degraded',
      };
    }
    try {
      const raw = await transport.evaluate(BUILTIN_VIDEO_SAMPLE_EXPRESSION);
      return {
        ...validateCdpSample(raw, { sampledAtMonotonicMs: clock() }),
        timeSource: 'cdp',
      };
    } catch (e) {
      connected = false;
      lastError = e.message;
      return {
        ok: false,
        reason: 'sample_failed',
        detail: e.message,
        sampledAtMonotonicMs: clock(),
        timeSource: 'degraded',
      };
    }
  }

  function disconnect() {
    connected = false;
    try { transport?.disconnect?.(); } catch { /* ignore */ }
  }

  return {
    endpoint: ep,
    connect,
    sample,
    disconnect,
    get connected() { return connected; },
    get lastError() { return lastError; },
  };
}
