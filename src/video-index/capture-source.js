/**
 * capture-source.js — 显式启动的抓播会话（CDP 时间轴 + 可选 loopback）。
 * URL 可用时 URL 为权威内容源；capture 仅作画面/即时锚点，系统混音需显式标记。
 */

import { createTimeMapping } from './time-mapping.js';
import { createCdpBridge } from './cdp-bridge.js';
import { assertSafeBilibiliUrl } from './url-allowlist.js';

export function validateManualRegion(region) {
  if (!region || typeof region !== 'object') {
    const err = new Error('manual region required for capture MVP');
    err.code = 'REGION';
    throw err;
  }
  const x = Math.floor(Number(region.x));
  const y = Math.floor(Number(region.y));
  const width = Math.floor(Number(region.width));
  const height = Math.floor(Number(region.height));
  if (![x, y, width, height].every(Number.isFinite)) {
    const err = new Error('region fields must be integers');
    err.code = 'REGION';
    throw err;
  }
  if (width <= 0 || height <= 0) {
    const err = new Error('region size must be positive');
    err.code = 'REGION';
    throw err;
  }
  if (width * height > 40_000_000) {
    const err = new Error('region area too large');
    err.code = 'REGION';
    throw err;
  }
  return { x, y, width, height };
}

export function createCaptureSession({
  url = null,
  region = null,
  cdpEndpoint = null,
  cdpTransport = null,
  sourceMode = null,
  clock = () => Date.now(),
  recorder = null,
} = {}) {
  let pageUrl = null;
  if (url) pageUrl = assertSafeBilibiliUrl(url);
  const manualRegion = region ? validateManualRegion(region) : null;
  const mode = sourceMode
    || (pageUrl ? 'url' : 'capture');
  const audioScope = mode === 'capture' ? 'system_mix' : 'none_default';
  const mapping = createTimeMapping({ clock });
  const cdp = createCdpBridge({ endpoint: cdpEndpoint, transport: cdpTransport, clock });
  const gaps = [];
  let sessionId = `cap_${clock().toString(36)}`;
  let running = false;
  let lastSample = null;

  async function start() {
    if (running) return { ok: true, sessionId, already: true };
    if (cdpEndpoint) {
      const c = await cdp.connect();
      if (!c.ok && mode === 'url') {
        // URL 模式可无 CDP：时间源降级，不伪造采样
      }
    }
    if (recorder && typeof recorder.start === 'function') {
      await recorder.start({ region: manualRegion, sessionId });
    }
    running = true;
    return {
      ok: true,
      sessionId,
      sourceMode: mode,
      audioScope,
      region: manualRegion,
      pageUrl,
      timeSource: cdp.connected ? 'cdp' : 'wallclock',
    };
  }

  async function tick() {
    if (!running) return { ok: false, reason: 'not_running' };
    let sample = null;
    let seekEvent = null;
    if (cdp.connected) {
      sample = await cdp.sample();
      if (sample.ok) {
        const wallMs = sample.sampledAtMonotonicMs;
        // 推断 seek：相对上一样本，视频时间跳变超过墙钟推进 × rate + 容差
        if (lastSample?.ok && !sample.paused && !sample.ended) {
          const dWall = Math.max(0, wallMs - (lastSample.sampledAtMonotonicMs || wallMs));
          const rate = Number(sample.playbackRate) || 1;
          const expected = (lastSample.currentTimeMs || 0) + dWall * rate;
          const delta = sample.currentTimeMs - expected;
          const tol = Math.max(2500, dWall * rate + 1500);
          if (delta < -tol) {
            seekEvent = 'seek_back';
            mapping.onPlayerSample({
              currentTimeMs: sample.currentTimeMs,
              paused: sample.paused,
              ended: sample.ended,
              playbackRate: sample.playbackRate,
              wallMs,
              event: 'seek',
            });
          } else if (delta > tol) {
            seekEvent = 'seek_forward';
            mapping.onPlayerSample({
              currentTimeMs: sample.currentTimeMs,
              paused: sample.paused,
              ended: sample.ended,
              playbackRate: sample.playbackRate,
              wallMs,
              event: 'seek',
            });
          } else {
            mapping.onPlayerSample({
              currentTimeMs: sample.currentTimeMs,
              paused: sample.paused,
              ended: sample.ended,
              playbackRate: sample.playbackRate,
              wallMs,
            });
          }
        } else {
          mapping.onPlayerSample({
            currentTimeMs: sample.currentTimeMs,
            paused: sample.paused,
            ended: sample.ended,
            playbackRate: sample.playbackRate,
            wallMs,
          });
        }
        lastSample = sample;
      }
    }
    return {
      ok: true,
      sample,
      seekEvent,
      mapping: mapping.snapshotIncludingOpen({
        wallEndMs: sample?.sampledAtMonotonicMs,
        videoEndMs: sample?.currentTimeMs,
      }),
      // visibilityState 不单独等于暂停
      visualUnavailable: sample?.visibilityState === 'hidden',
    };
  }

  function noteDiscontinuity({ fromVideoMs, toVideoMs, reason }) {
    const gap = mapping.recordGap({ fromVideoMs, toVideoMs, reason });
    gaps.push(gap);
    // 新 session 语义：中断后从当前时间重新开始，不承诺无缝
    sessionId = `cap_${clock().toString(36)}`;
    return gap;
  }

  async function stop() {
    running = false;
    mapping.closeSegment({ reason: 'stop' });
    cdp.disconnect();
    if (recorder && typeof recorder.stop === 'function') {
      await recorder.stop();
    }
    return {
      ok: true,
      sessionId,
      sourceMode: mode,
      audioScope,
      gaps: [...gaps],
      mapping: mapping.snapshot(),
      lastSample,
    };
  }

  return {
    start,
    tick,
    stop,
    noteDiscontinuity,
    mapping,
    get sessionId() { return sessionId; },
    get sourceMode() { return mode; },
    get audioScope() { return audioScope; },
    get gaps() { return [...gaps]; },
    get region() { return manualRegion; },
  };
}
