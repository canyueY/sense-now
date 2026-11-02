/**
 * subtitle-stream-source.js — 真正流式 ROI rawvideo 读取。
 * 禁止 spawnBounded 收集完整 stdout（5 分钟 ROI 远超 64MB 硬顶）。
 */

import { spawn } from 'node:child_process';
import { killProcessTree } from './bounded-stdio.js';

const HARD = Object.freeze({
  maxFramesScannedPerChunk: 400,
  maxOcrCallsPerMinute: 30,
  maxOcrCallsPerChunk: 120,
  maxTotalOcrCalls: 2000,
  maxOcrRuntimeMsPerChunk: 120_000,
  maxOcrCandidatesPerMinute: 60,
  maxStoredSubtitleFrames: 64,
  scanFps: 4,
  maxResidualBufFrames: 2,
  maxStderrBytes: 2 * 1024 * 1024,
  fallbackMaxFfmpegStarts: 60,
});

export { HARD as STREAM_OCR_HARD };

function clampInt(v, fallback, { min, max }) {
  const n = Number(v);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeOcrBudgets(policy = {}) {
  const sf = policy?.subtitleFirst || {};
  const b = policy?.budgets || {};
  return {
    scanFps: clampInt(sf.scanFps, 1, { min: 0.25, max: HARD.scanFps }),
    maxFramesScannedPerChunk: clampInt(
      b.maxFramesScannedPerChunk ?? sf.maxFramesScannedPerChunk,
      300,
      { min: 1, max: HARD.maxFramesScannedPerChunk },
    ),
    maxOcrCallsPerMinute: clampInt(
      b.maxOcrCallsPerMinute ?? sf.maxOcrCallsPerMinute,
      20,
      { min: 1, max: HARD.maxOcrCallsPerMinute },
    ),
    maxOcrCallsPerChunk: clampInt(
      b.maxOcrCallsPerChunk ?? sf.maxOcrCallsPerChunk,
      90,
      { min: 1, max: HARD.maxOcrCallsPerChunk },
    ),
    maxTotalOcrCalls: clampInt(
      b.maxTotalOcrCalls ?? sf.maxTotalOcrCalls,
      HARD.maxTotalOcrCalls,
      { min: 1, max: HARD.maxTotalOcrCalls },
    ),
    maxOcrRuntimeMsPerChunk: clampInt(
      b.maxOcrRuntimeMsPerChunk ?? sf.maxOcrRuntimeMsPerChunk,
      90_000,
      { min: 1000, max: HARD.maxOcrRuntimeMsPerChunk },
    ),
    maxOcrCandidatesPerMinute: clampInt(
      sf.maxOcrCandidatesPerMinute,
      12,
      { min: 1, max: HARD.maxOcrCandidatesPerMinute },
    ),
    maxStoredSubtitleFrames: clampInt(
      b.maxStoredSubtitleFrames ?? sf.maxStoredSubtitleFrames,
      32,
      { min: 0, max: HARD.maxStoredSubtitleFrames },
    ),
    fallbackRoiHeightRatio: (() => {
      const n = Number(sf.fallbackRoiHeightRatio);
      if (!Number.isFinite(n) || n <= 0 || n > 0.9) return 0.45;
      return n;
    })(),
  };
}

export function roiCropFilter(width, height, roi, fallbackRatio) {
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  if (roi && typeof roi === 'object' && Number.isFinite(roi.width)) {
    x = Math.max(0, Math.floor(roi.x || 0));
    y = Math.max(0, Math.floor(roi.y || 0));
    w = Math.min(width - x, Math.floor(roi.width));
    h = Math.min(height - y, Math.floor(roi.height));
  } else {
    h = Math.max(1, Math.floor(height * fallbackRatio));
    y = Math.max(0, height - h);
    w = width;
    x = 0;
  }
  w = Math.max(2, Math.min(width, w) & ~1);
  h = Math.max(2, Math.min(height, h) & ~1);
  x = Math.min(x, Math.max(0, width - w));
  y = Math.min(y, Math.max(0, height - h));
  return {
    filter: `crop=${w}:${h}:${x}:${y},fps=FPS_PLACEHOLDER,scale=${w}:${h}:flags=area`,
    rect: { x, y, width: w, height: h },
  };
}

/**
 * 从 FFmpeg child 流式消费 rawvideo 帧。
 * 只保留不完整帧残片；完整帧立即交给 onFrame，不累积整 chunk。
 * onFrame 可返回 { stop: true, reason } 以中止。
 */
export async function consumeSubtitleFrames({
  child,
  frameSize,
  startMs = 0,
  fps = 1,
  budgets = {},
  signal,
  onFrame,
  maxResidualBytes = null,
} = {}) {
  if (!child?.stdout || !Number.isFinite(frameSize) || frameSize <= 0) {
    throw new Error('consumeSubtitleFrames: invalid child/frameSize');
  }
  const maxFrames = budgets.maxFramesScannedPerChunk || HARD.maxFramesScannedPerChunk;
  const residualCap = maxResidualBytes
    ?? frameSize * HARD.maxResidualBufFrames;
  const t0 = Date.now();
  let residual = Buffer.alloc(0);
  let frameIndex = 0;
  let framesScanned = 0;
  let truncated = false;
  const limitReasons = [];
  let stopReason = null;
  let stderr = '';
  let stderrBytes = 0;
  let settled = false;
  let abortError = null;

  const kill = () => {
    try { killProcessTree(child.pid); } catch { /* ignore */ }
  };

  return new Promise((resolve, reject) => {
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      resolve(payload);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      reject(err);
    };

    const onAbort = () => {
      abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
      kill();
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }

    const timeoutMs = budgets.maxOcrRuntimeMsPerChunk || HARD.maxOcrRuntimeMsPerChunk;
    const timer = setTimeout(() => {
      truncated = true;
      limitReasons.push('maxOcrRuntimeMsPerChunk');
      stopReason = 'maxOcrRuntimeMsPerChunk';
      kill();
    }, timeoutMs);

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (d) => {
      const chunk = typeof d === 'string' ? Buffer.byteLength(d) : d.length;
      stderrBytes += chunk;
      if (stderrBytes <= HARD.maxStderrBytes) {
        stderr += typeof d === 'string' ? d : d.toString('utf8');
      }
    });

    const processBuf = async () => {
      while (residual.length >= frameSize) {
        if (abortError) {
          clearTimeout(timer);
          fail(abortError);
          return false;
        }
        if (Date.now() - t0 > timeoutMs) {
          truncated = true;
          limitReasons.push('maxOcrRuntimeMsPerChunk');
          stopReason = 'maxOcrRuntimeMsPerChunk';
          kill();
          return false;
        }
        if (framesScanned >= maxFrames) {
          truncated = true;
          limitReasons.push('maxFramesScannedPerChunk');
          stopReason = 'maxFramesScannedPerChunk';
          kill();
          return false;
        }
        const frame = Buffer.from(residual.subarray(0, frameSize));
        residual = residual.subarray(frameSize);
        const localOffsetMs = Math.round((frameIndex / fps) * 1000);
        const meta = {
          timestampMs: startMs + localOffsetMs,
          localOffsetMs,
          frameIndex,
          buf: frame,
          framesScanned: framesScanned + 1,
        };
        frameIndex += 1;
        framesScanned += 1;
        let cmd = null;
        try {
          cmd = await onFrame?.(meta);
        } catch (e) {
          if (e?.name === 'AbortError') {
            abortError = e;
            kill();
            clearTimeout(timer);
            fail(e);
            return false;
          }
          throw e;
        }
        if (cmd?.stop) {
          truncated = true;
          if (cmd.reason) limitReasons.push(cmd.reason);
          stopReason = cmd.reason || 'onFrame_stop';
          kill();
          return false;
        }
      }
      if (residual.length > residualCap) {
        truncated = true;
        limitReasons.push('residual_overflow');
        stopReason = 'residual_overflow';
        kill();
        return false;
      }
      return true;
    };

    let pump = Promise.resolve();
    child.stdout.on('data', (chunk) => {
      pump = pump.then(async () => {
        if (settled || stopReason || abortError) return;
        residual = residual.length
          ? Buffer.concat([residual, chunk])
          : Buffer.from(chunk);
        await processBuf();
      }).catch((e) => {
        clearTimeout(timer);
        kill();
        fail(e);
      });
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      pump.then(async () => {
        if (abortError) {
          fail(abortError);
          return;
        }
        // 排空残片中的完整帧
        if (!stopReason && residual.length >= frameSize) {
          await processBuf();
        }
        if (abortError) {
          fail(abortError);
          return;
        }
        finish({
          framesScanned,
          truncated: truncated || Boolean(stopReason),
          limitReasons: [...new Set(limitReasons)],
          stopReason,
          code,
          stderr: stderr.slice(0, 500),
        });
      }).catch((e) => fail(e));
    });
  });
}

/**
 * 一次 FFmpeg：流式解码 ROI；onFrame 逐帧回调。
 * 兼容旧调用：若未传 onFrame，则仅统计帧数（不攒 raw）。
 */
export async function streamSubtitleBandFrames({
  mediaPath,
  startMs = 0,
  endMs = 0,
  width = 640,
  height = 360,
  roi = 'auto',
  policy = null,
  ffmpegPath = 'ffmpeg',
  signal,
  runner = null,
  detectRoi = null,
  onFrame = null,
} = {}) {
  const budgets = normalizeOcrBudgets(policy);
  const limitReasons = [];
  const durMs = Math.max(0, endMs - startMs);
  if (!mediaPath || durMs <= 0) {
    return {
      frames: [],
      framesScanned: 0,
      truncated: true,
      limitReasons: ['no_media_or_window'],
      ffmpegStarts: 0,
      sampledRanges: [],
      capability: 'unavailable',
      budgets,
    };
  }

  let roiHint = roi;
  if ((!roiHint || roiHint === 'auto') && typeof detectRoi === 'function') {
    try { roiHint = await detectRoi({ startMs, endMs }) || 'auto'; } catch { roiHint = 'auto'; }
  }
  const { filter, rect } = roiCropFilter(
    width, height, roiHint === 'auto' ? null : roiHint, budgets.fallbackRoiHeightRatio,
  );
  const fps = budgets.scanFps;
  const maxFrames = Math.min(
    budgets.maxFramesScannedPerChunk,
    Math.ceil((durMs / 1000) * fps) + 2,
  );
  const vf = filter.replace('FPS_PLACEHOLDER', String(fps));
  const args = [
    '-hide_banner', '-v', 'error', '-nostdin',
    '-ss', String(Math.max(0, startMs / 1000)),
    '-t', String(Math.max(0.05, durMs / 1000)),
    '-i', mediaPath,
    '-vf', vf,
    '-frames:v', String(maxFrames),
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ];

  const frameSize = rect.width * rect.height * 3;
  if (signal?.aborted) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }

  // 测试注入：可模拟逐帧推送
  if (typeof runner === 'function') {
    const r = await runner({
      args, signal, timeoutMs: budgets.maxOcrRuntimeMsPerChunk, frameSize, rect, fps, startMs, endMs,
    });
    if (r?.streamFrames && typeof r.streamFrames[Symbol.asyncIterator] === 'function') {
      let framesScanned = 0;
      let truncated = false;
      const reasons = [];
      let lastTs = startMs;
      for await (const fr of r.streamFrames) {
        if (signal?.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        framesScanned += 1;
        lastTs = fr.timestampMs ?? lastTs;
        const cmd = onFrame ? await onFrame({
          ...fr,
          width: fr.width ?? rect.width,
          height: fr.height ?? rect.height,
          roi: rect,
          framesScanned,
        }) : null;
        if (cmd?.stop) {
          truncated = true;
          if (cmd.reason) reasons.push(cmd.reason);
          break;
        }
        if (framesScanned >= budgets.maxFramesScannedPerChunk) {
          truncated = true;
          reasons.push('maxFramesScannedPerChunk');
          break;
        }
      }
      return {
        frames: [],
        framesScanned,
        truncated,
        limitReasons: reasons,
        ffmpegStarts: 1,
        sampledRanges: framesScanned
          ? [{ startMs, endMs: lastTs + Math.round(1000 / fps) }]
          : [],
        capability: framesScanned ? 'ready' : 'degraded',
        budgets,
        roi: rect,
      };
    }
    // 旧 runner 返回整段 stdout：仅小测试夹具；生产禁止（超硬顶即 degraded）
    const buf = Buffer.isBuffer(r?.stdout) ? r.stdout : Buffer.from(r?.stdout || []);
    const maxAllowed = frameSize * Math.min(8, maxFrames); // 仅允许极小夹具
    if (buf.length > maxAllowed && buf.length > frameSize * 2) {
      return {
        frames: [],
        framesScanned: 0,
        truncated: true,
        limitReasons: ['buffered_stdout_rejected'],
        ffmpegStarts: 1,
        sampledRanges: [],
        capability: 'degraded',
        degradeReason: 'runner returned buffered stdout; use streamFrames',
        budgets,
        roi: rect,
      };
    }
    let framesScanned = 0;
    let truncated = false;
    const reasons = [];
    let lastTs = startMs;
    for (let offset = 0; offset + frameSize <= buf.length; offset += frameSize) {
      const slice = Buffer.from(buf.subarray(offset, offset + frameSize));
      const localOffsetMs = Math.round((framesScanned / fps) * 1000);
      const timestampMs = startMs + localOffsetMs;
      framesScanned += 1;
      lastTs = timestampMs;
      const cmd = onFrame ? await onFrame({
        timestampMs,
        localOffsetMs,
        frameIndex: framesScanned - 1,
        buf: slice,
        width: rect.width,
        height: rect.height,
        roi: rect,
        framesScanned,
      }) : null;
      if (cmd?.stop) {
        truncated = true;
        if (cmd.reason) reasons.push(cmd.reason);
        break;
      }
    }
    return {
      frames: [],
      framesScanned,
      truncated,
      limitReasons: reasons,
      ffmpegStarts: 1,
      sampledRanges: framesScanned
        ? [{ startMs, endMs: lastTs + Math.round(1000 / fps) }]
        : [],
      capability: framesScanned ? 'ready' : (r?.code ? 'degraded' : 'degraded'),
      budgets,
      roi: rect,
    };
  }

  const child = spawn(ffmpegPath, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lastTs = startMs;
  try {
    const consumed = await consumeSubtitleFrames({
      child,
      frameSize,
      startMs,
      fps,
      budgets: { ...budgets, maxFramesScannedPerChunk: maxFrames },
      signal,
      onFrame: async (fr) => {
        lastTs = fr.timestampMs;
        if (!onFrame) return null;
        return onFrame({
          ...fr,
          width: rect.width,
          height: rect.height,
          roi: rect,
        });
      },
    });

    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }

    const failed = consumed.code != null && consumed.code !== 0 && consumed.framesScanned === 0;
    return {
      frames: [],
      framesScanned: consumed.framesScanned,
      truncated: consumed.truncated || failed,
      limitReasons: failed
        ? [...consumed.limitReasons, 'ffmpeg_failed']
        : consumed.limitReasons,
      ffmpegStarts: 1,
      sampledRanges: consumed.framesScanned
        ? [{ startMs, endMs: lastTs + Math.round(1000 / fps) }]
        : [],
      capability: failed
        ? 'degraded'
        : (consumed.framesScanned ? 'ready' : 'degraded'),
      degradeReason: failed ? String(consumed.stderr || consumed.code).slice(0, 200) : null,
      budgets,
      roi: rect,
    };
  } catch (e) {
    try { killProcessTree(child.pid); } catch { /* ignore */ }
    if (e.name === 'AbortError') throw e;
    return {
      frames: [],
      framesScanned: 0,
      truncated: true,
      limitReasons: ['stream_failed', ...(limitReasons)],
      ffmpegStarts: 1,
      sampledRanges: [],
      capability: 'degraded',
      degradeReason: e.message,
      budgets,
      roi: rect,
    };
  }
}

/** 兼容 fallback：受限逐点采样；FFmpeg 启动次数硬顶 */
export async function fallbackSampleFrames({
  extractFrameAt,
  startMs,
  endMs,
  policy,
  signal,
  onFrame = null,
} = {}) {
  const budgets = normalizeOcrBudgets(policy);
  const step = Math.max(250, Math.round(1000 / budgets.scanFps));
  const limitReasons = ['compat_per_seek_fallback'];
  let ffmpegStarts = 0;
  let framesScanned = 0;
  let truncated = true;
  let lastTs = startMs;
  const hardStarts = Math.min(HARD.fallbackMaxFfmpegStarts, budgets.maxFramesScannedPerChunk);

  for (let t = startMs; t < endMs && framesScanned < budgets.maxFramesScannedPerChunk; t += step) {
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (ffmpegStarts >= hardStarts) {
      limitReasons.push('fallback_ffmpeg_cap');
      break;
    }
    ffmpegStarts += 1;
    const fr = await extractFrameAt({ atMs: t, signal });
    if (!fr?.buf) continue;
    framesScanned += 1;
    lastTs = t;
    const meta = {
      timestampMs: t,
      localOffsetMs: t - startMs,
      frameIndex: framesScanned - 1,
      buf: fr.buf,
      width: fr.width,
      height: fr.height,
      sourceWindow: { startMs, endMs },
      framesScanned,
    };
    if (onFrame) {
      const cmd = await onFrame(meta);
      if (cmd?.stop) {
        if (cmd.reason) limitReasons.push(cmd.reason);
        break;
      }
    }
  }
  return {
    frames: [],
    framesScanned,
    truncated,
    limitReasons,
    ffmpegStarts,
    sampledRanges: framesScanned ? [{ startMs, endMs: lastTs }] : [],
    capability: 'degraded',
    degradeReason: 'compat_per_seek_fallback',
    budgets,
  };
}

export function killFfmpegTree(pid) {
  killProcessTree(pid);
}
