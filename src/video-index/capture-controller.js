/**
 * capture-controller.js — 调度 CDP tick + loopback + region 帧 → capture chunk。
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCaptureSession } from './capture-source.js';
import { createLoopbackRecorderAdapter } from './adapters/loopback-recorder.js';
import { encodePng } from '../png.js';

/**
 * @param {{ every: (ms:number, fn:Function) => { stop: Function } }} scheduler
 */
export function createCaptureController({
  rootDir,
  videoKey,
  jobId,
  attempt = 1,
  url = null,
  region = null,
  cdpEndpoint = null,
  cdpTransport = null,
  recorder = null,
  frameSource = null,
  captureCapabilities = {},
  captureSpeakerMerge = null,
  scheduler = createDefaultScheduler(),
  clock = () => Date.now(),
  indexChunk = null,
  commitCaptureChunk = null,
  allocateChunkId = null,
  mayContinue = null,
  onProgress = () => {},
  log = () => {},
  chunkTargetMs = 5 * 60_000,
} = {}) {
  const session = createCaptureSession({
    url,
    region,
    cdpEndpoint,
    cdpTransport,
    clock,
    recorder: null,
  });

  const rec = recorder || createLoopbackRecorderAdapter();
  const tempDir = join(rootDir, encodeSafe(videoKey), 'tmp', `capture-${jobId || 'x'}`);
  mkdirSync(tempDir, { recursive: true });

  let timer = null;
  let tickBusy = false;
  let flushBusy = false;
  let running = false;
  let cancelRequested = false;
  let frameChild = null;
  let unsubscribeSegment = null;
  const audioById = new Map();
  const retainedFrames = [];
  const mappingSnapshot = [];
  const gaps = [];
  let lastVideoMs = null;
  let chunkStartVideoMs = null;
  let openChunkWallStart = null;
  let sessionWallOriginMs = null;
  let capabilities = {
    cdp: 'unavailable',
    audioCapture: 'unavailable',
    frameCapture: 'unavailable',
  };
  let cdpSamples = 0;
  let cdpFailures = 0;
  let stopCalls = { recorder: 0, frame: 0 };

  function guardContinue() {
    if (cancelRequested) return false;
    if (typeof mayContinue === 'function') {
      try {
        const r = mayContinue({ jobId, attempt });
        if (r === false || r?.ok === false) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  function ingestSegment(seg, audioDir) {
    if (!seg || cancelRequested) return;
    const file = seg.file || seg.path;
    if (!file) return;
    const path = file.includes('/') || file.includes('\\')
      ? file
      : join(audioDir, file);
    const id = seg.segmentId || seg.id || path;
    const next = {
      segmentId: id,
      path,
      wallStartMs: Math.round((seg.wallStartMs ?? (seg.wallStart || 0) * 1000)),
      wallEndMs: Math.round((seg.wallEndMs ?? (seg.wallEnd || 0) * 1000)),
      sampleCount: seg.sampleCount || 0,
      sampleRate: seg.sampleRate || 16000,
    };
    // 合并同一 segmentId（事件 + stop 尾段）
    const prev = audioById.get(id);
    if (prev) {
      audioById.set(id, {
        ...prev,
        ...next,
        wallStartMs: Math.min(prev.wallStartMs || next.wallStartMs, next.wallStartMs),
        wallEndMs: Math.max(prev.wallEndMs || next.wallEndMs, next.wallEndMs),
        sampleCount: Math.max(prev.sampleCount || 0, next.sampleCount || 0),
      });
    } else {
      audioById.set(id, next);
    }
  }

  function takeAudioSegments() {
    const list = [...audioById.values()].sort(
      (a, b) => (a.wallStartMs || 0) - (b.wallStartMs || 0),
    );
    audioById.clear();
    return list;
  }

  async function start() {
    if (running) return { ok: true, already: true, capabilities };
    const started = await session.start();
    capabilities.cdp = started.timeSource === 'cdp' ? 'ready'
      : (cdpEndpoint ? 'degraded' : 'unavailable');

    const audioDir = join(tempDir, 'audio');
    mkdirSync(audioDir, { recursive: true });

    // R1.5: 在 start 之前注册 onSegment，避免启动瞬间丢段
    unsubscribeSegment = rec.onSegment?.((seg) => {
      if (cancelRequested) return;
      ingestSegment(seg, audioDir);
    }) || null;

    const recStart = await rec.start({ outDir: audioDir, continuous: true });
    if (recStart.ok) {
      capabilities.audioCapture = 'ready';
    } else {
      capabilities.audioCapture = 'unavailable';
      try { unsubscribeSegment?.(); } catch { /* ignore */ }
      unsubscribeSegment = null;
    }

    if (frameSource && region) {
      try {
        frameChild = frameSource.start({
          region,
          outDir: join(tempDir, 'frames'),
          onFrame: (fr) => {
            if (cancelRequested || !running) return;
            const sample = session.mapping?.open || null;
            const videoMs = sample
              ? session.mapping.wallToVideo(clock())
              : (lastVideoMs ?? 0);
            const last = retainedFrames[retainedFrames.length - 1];
            if (last && videoMs != null && Math.abs(videoMs - last.videoMs) < 30_000) return;

            // 保留闸门之后才编码 PNG；frame source 只应提供 raw buf
            mkdirSync(join(tempDir, 'frames'), { recursive: true });
            let pngPath = null;
            try {
              let png = fr.png || null;
              if (!png && fr.buf && fr.width && fr.height) {
                png = encodePng(fr.buf, fr.width, fr.height, { level: 1 });
              }
              if (png) {
                pngPath = join(tempDir, 'frames', `keep_${String(retainedFrames.length).padStart(5, '0')}.png`);
                if (!existsSync(pngPath)) writeFileSync(pngPath, png, { flag: 'wx' });
              } else if (fr.path && String(fr.path).endsWith('.png')) {
                pngPath = fr.path;
              }
            } catch { /* ignore encode */ }

            retainedFrames.push({
              path: pngPath,
              wallMs: clock(),
              videoMs: videoMs ?? lastVideoMs ?? 0,
              width: fr.width,
              height: fr.height,
            });
          },
        });
        capabilities.frameCapture = 'ready';
      } catch (e) {
        capabilities.frameCapture = 'unavailable';
        log(`frame capture unavailable: ${e.message}`);
      }
    } else if (region) {
      capabilities.frameCapture = 'unavailable';
    }

    if (capabilities.audioCapture !== 'ready' && capabilities.frameCapture !== 'ready') {
      await session.stop();
      return {
        ok: false,
        reason: 'unavailable',
        detail: 'audio and frame capture both unavailable',
        capabilities,
      };
    }

    running = true;
    cancelRequested = false;
    chunkStartVideoMs = 0;
    openChunkWallStart = clock();
    sessionWallOriginMs = openChunkWallStart;
    timer = scheduler.every(1000, () => tick());
    return {
      ok: true,
      sessionId: started.sessionId,
      sourceMode: started.sourceMode,
      audioScope: started.audioScope,
      capabilities,
      tempDir,
    };
  }

  async function tick() {
    if (!running || cancelRequested || tickBusy) return { skipped: true };
    if (!guardContinue()) {
      cancelRequested = true;
      return { skipped: true, cancelled: true };
    }
    tickBusy = true;
    try {
      const t = await session.tick();
      if (t.sample?.ok) {
        cdpSamples += 1;
        const prevVideoMs = lastVideoMs;
        lastVideoMs = t.sample.currentTimeMs;
        if (chunkStartVideoMs == null) chunkStartVideoMs = lastVideoMs;
        // 向前/向后 seek：切 mapping + chunk（capture-source 已推 event:seek）
        if (t.seekEvent === 'seek_back' || t.seekEvent === 'seek_forward'
          || (prevVideoMs != null && lastVideoMs + 2000 < prevVideoMs)) {
          gaps.push(session.noteDiscontinuity({
            fromVideoMs: prevVideoMs ?? chunkStartVideoMs,
            toVideoMs: lastVideoMs,
            reason: t.seekEvent === 'seek_forward' ? 'seek_forward' : 'seek_or_rewind',
          }));
          await flushChunk({ reason: 'seek' });
        } else if (lastVideoMs != null && chunkStartVideoMs != null
          && lastVideoMs - chunkStartVideoMs >= chunkTargetMs) {
          await flushChunk({ reason: 'duration' });
        }
      } else {
        cdpFailures += 1;
        capabilities.cdp = 'degraded';
      }
      onProgress({
        cdpSamples, cdpFailures, audioSegments: audioById.size,
        frames: retainedFrames.length, lastVideoMs,
      });
      return t;
    } catch (e) {
      cdpFailures += 1;
      capabilities.cdp = 'degraded';
      log(`tick error: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      tickBusy = false;
    }
  }

  async function flushChunk({ reason = 'flush' } = {}) {
    if (!guardContinue()) return null;
    if (flushBusy) return null;
    flushBusy = true;
    try {
      if (!guardContinue()) return null;

      const audioSegments = takeAudioSegments();
      const frames = retainedFrames.splice(0);
      // 必须含 open 段，否则连续播放周期性 flush 的 mapping 为空
      const maps = typeof session.mapping.snapshotIncludingOpen === 'function'
        ? session.mapping.snapshotIncludingOpen({
          wallEndMs: clock(),
          videoEndMs: lastVideoMs,
        })
        : session.mapping.snapshot();

      // 无 CDP：用实际音频/帧时长，禁止 1ms 假 chunk
      let startMs = chunkStartVideoMs ?? 0;
      let endMs = lastVideoMs ?? chunkStartVideoMs ?? 0;
      if ((!Number.isFinite(endMs) || endMs <= startMs) && audioSegments.length) {
        const maxWall = Math.max(...audioSegments.map((s) => s.wallEndMs || 0));
        const minWall = Math.min(...audioSegments.map((s) => s.wallStartMs || 0));
        const origin = sessionWallOriginMs ?? minWall;
        startMs = Math.max(0, minWall - origin);
        endMs = Math.max(startMs + 1, maxWall - origin);
      }
      if (endMs <= startMs && !audioSegments.length && !frames.length) {
        return null;
      }
      if (endMs <= startMs) endMs = startMs + 1;

      const bundle = {
        audioSegments,
        frames,
        mappingSegments: maps,
        gaps: [...gaps],
        reason,
        sessionWallOriginMs,
      };
      mappingSnapshot.push(...bundle.mappingSegments);

      let chunkId = null;
      if (typeof allocateChunkId === 'function') {
        chunkId = await allocateChunkId({ videoKey, jobId, attempt });
      }
      if (!guardContinue()) return null;

      const chunk = {
        chunkId,
        startMs,
        endMs,
        inputStartMs: startMs,
        inputEndMs: endMs,
      };
      chunkStartVideoMs = lastVideoMs ?? endMs;
      openChunkWallStart = clock();

      if (typeof commitCaptureChunk === 'function') {
        if (!guardContinue()) return null;
        return commitCaptureChunk({
          videoKey,
          chunk,
          sourceMode: 'capture',
          sourceDescriptor: { captureBundle: bundle },
          capabilities: captureCapabilities,
          speakerMerge: captureSpeakerMerge,
        });
      }
      if (typeof indexChunk === 'function') {
        if (!guardContinue()) return null;
        return indexChunk({
          videoKey,
          chunk,
          sourceMode: 'capture',
          sourceDescriptor: { captureBundle: bundle },
        });
      }
      return { chunk, bundle };
    } finally {
      flushBusy = false;
    }
  }

  async function stopExternal() {
    if (timer) {
      try { timer.stop(); } catch { /* ignore */ }
      timer = null;
    }
    for (let i = 0; i < 50 && (tickBusy || flushBusy); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (frameChild?.stop) {
      stopCalls.frame += 1;
      try { await frameChild.stop(); } catch { /* ignore */ }
      frameChild = null;
    }
    stopCalls.recorder += 1;
    let recStop = { segments: [] };
    try {
      recStop = await rec.stop();
    } catch { /* ignore */ }
    try { unsubscribeSegment?.(); } catch { /* ignore */ }
    unsubscribeSegment = null;

    const audioDir = join(tempDir, 'audio');
    for (const seg of recStop.segments || []) {
      ingestSegment(seg, audioDir);
    }
    return recStop;
  }

  async function stop({ cancel = false } = {}) {
    cancelRequested = cancel || cancelRequested;
    running = false;
    const recStop = await stopExternal();
    const sess = await session.stop();
    let last = null;
    if (!cancelRequested) {
      if (guardContinue()) {
        last = await flushChunk({ reason: 'stop' });
      }
    } else {
      // cancel：丢弃未提交内容，零 commit
      audioById.clear();
      retainedFrames.length = 0;
    }
    return {
      ok: true,
      cancelled: cancelRequested,
      capabilities,
      gaps: [...gaps, ...(sess.gaps || [])],
      stats: {
        cdpSamples,
        cdpFailures,
        audioSegments: recStop.segments?.length ?? audioById.size,
        retainedFrames: retainedFrames.length,
        lastVideoMs,
        stopCalls: { ...stopCalls },
      },
      lastChunk: last,
    };
  }

  async function requestCancel() {
    cancelRequested = true;
    running = false;
    return stop({ cancel: true });
  }

  return {
    start,
    stop,
    tick,
    requestCancel,
    flushChunk,
    get capabilities() { return { ...capabilities }; },
    get running() { return running; },
    get cancelRequested() { return cancelRequested; },
    get tempDir() { return tempDir; },
    get stopCalls() { return { ...stopCalls }; },
    session,
  };
}

function createDefaultScheduler() {
  return {
    every(ms, fn) {
      const id = setInterval(() => {
        Promise.resolve(fn()).catch(() => {});
      }, ms);
      return { stop: () => clearInterval(id) };
    },
  };
}

/** 测试用：手动推进的 scheduler */
export function createFakeScheduler() {
  const timers = [];
  return {
    every(ms, fn) {
      const entry = { ms, fn, stopped: false };
      timers.push(entry);
      return {
        stop: () => { entry.stopped = true; },
      };
    },
    async advance(times = 1) {
      for (let i = 0; i < times; i += 1) {
        for (const t of timers) {
          if (!t.stopped) await t.fn();
        }
      }
    },
    get active() { return timers.filter((t) => !t.stopped).length; },
  };
}

function encodeSafe(videoKey) {
  return String(videoKey || 'cap').replace(/[^\w.=-]+/g, '_').slice(0, 80);
}

/**
 * 简易 fake frame source（测试）。
 */
export function createFakeFrameSource({ width = 64, height = 36 } = {}) {
  let timer = null;
  let n = 0;
  let stopped = false;
  return {
    start({ outDir, onFrame }) {
      mkdirSync(outDir, { recursive: true });
      stopped = false;
      timer = setInterval(() => {
        if (stopped) return;
        const buf = Buffer.alloc(width * height * 3, (n * 40) % 255);
        onFrame?.({ buf, width, height, t: n });
        n += 1;
      }, 500);
      return {
        stop: async () => {
          stopped = true;
          if (timer) clearInterval(timer);
          timer = null;
        },
      };
    },
  };
}
