/**
 * subtitle-band-scanner.js — chunk 窗口内真正流式 ROI + 变化门控 OCR。
 * 每帧：变化检测 →（变化才）encodePng → OCR；不攒整 chunk raw frames。
 */

import { encodePng } from '../png.js';
import {
  streamSubtitleBandFrames,
  fallbackSampleFrames,
  normalizeOcrBudgets,
} from './subtitle-stream-source.js';
import { buildSubtitleSegments } from './subtitle-segment-builder.js';
import { makeEvidence } from './evidence-factory.js';

function rgbDiffRatio(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let diff = 0;
  const step = 12;
  for (let i = 0; i < a.length; i += step) {
    if (Math.abs(a[i] - b[i]) > 18) diff += 1;
  }
  return diff / Math.max(1, Math.floor(a.length / step));
}

/**
 * @param {{
 *   videoKey, startMs, endMs, mediaPath?, extractFrameAt?,
 *   ocr, policy, signal, detectRoi?, ffmpegPath?, streamRunner?,
 *   preferStream?: boolean, clock?, width?, height?,
 *   ocrCallCounter?: { count:number, max:number }
 * }} opts
 */
export async function scanBurnedSubtitles({
  videoKey,
  durationMs = null,
  startMs = 0,
  endMs = null,
  mediaPath = null,
  extractFrameAt = null,
  ocr,
  policy,
  signal,
  detectRoi = null,
  ffmpegPath = 'ffmpeg',
  streamRunner = null,
  preferStream = true,
  clock = () => new Date().toISOString(),
  width = 640,
  height = 360,
  ocrCallCounter = null,
  chunkId = null,
} = {}) {
  const windowEnd = endMs != null ? endMs : (Number(durationMs) || 0);
  const windowStart = Math.max(0, Number(startMs) || 0);
  const budgets = normalizeOcrBudgets(policy);

  if (!ocr?.available?.().ok) {
    return {
      ok: false,
      reason: 'unavailable',
      candidates: [],
      segments: [],
      evidence: [],
      ocrCalls: 0,
      framesScanned: 0,
      ffmpegStarts: 0,
      capability: 'unavailable',
      truncated: false,
      limitReasons: [],
      sampledRanges: [],
      budgets,
    };
  }

  const candidates = [];
  let prevBand = null;
  let ocrCalls = 0;
  const t0 = Date.now();
  const maxPerMin = budgets.maxOcrCallsPerMinute;
  const maxPerChunk = budgets.maxOcrCallsPerChunk;
  const maxCandPerMin = budgets.maxOcrCandidatesPerMinute;
  const windowMinForCand = Math.max(1 / 60, (windowEnd - windowStart) / 60_000);
  const maxCand = Math.max(1, Math.ceil(windowMinForCand * maxCandPerMin));
  const callBudgetForRate = Math.max(1, Math.ceil(maxPerMin * windowMinForCand));
  const limitReasons = [];
  let stopReason = null;

  const onFrame = async (fr) => {
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (Date.now() - t0 > budgets.maxOcrRuntimeMsPerChunk) {
      stopReason = 'maxOcrRuntimeMsPerChunk';
      limitReasons.push(stopReason);
      return { stop: true, reason: stopReason };
    }
    if (ocrCalls >= maxPerChunk) {
      stopReason = 'maxOcrCallsPerChunk';
      limitReasons.push(stopReason);
      return { stop: true, reason: stopReason };
    }
    if (ocrCallCounter && ocrCallCounter.count >= (ocrCallCounter.max || budgets.maxTotalOcrCalls)) {
      stopReason = 'maxTotalOcrCalls';
      limitReasons.push(stopReason);
      return { stop: true, reason: stopReason };
    }
    if (ocrCalls >= callBudgetForRate) {
      stopReason = 'maxOcrCallsPerMinute';
      limitReasons.push(stopReason);
      return { stop: true, reason: stopReason };
    }
    if (candidates.length >= maxCand) {
      stopReason = 'maxOcrCandidatesPerMinute';
      limitReasons.push(stopReason);
      return { stop: true, reason: stopReason };
    }
    if (budgets.maxStoredSubtitleFrames > 0
      && candidates.length >= budgets.maxStoredSubtitleFrames) {
      stopReason = 'maxStoredSubtitleFrames';
      limitReasons.push(stopReason);
      return { stop: true, reason: stopReason };
    }

    const band = fr.buf;
    const changed = prevBand == null || rgbDiffRatio(prevBand, band) > 0.04;
    // 只保留上一帧供变化检测；丢弃未变化 raw
    prevBand = band;
    if (!changed) return null;

    const png = encodePng(band, fr.width, fr.height, { level: 1 });
    ocrCalls += 1;
    if (ocrCallCounter) ocrCallCounter.count += 1;

    const ocrOut = await ocr.analyze({
      videoKey,
      imagePng: png,
      width: fr.width,
      height: fr.height,
      timestampMs: fr.timestampMs,
    }, { signal });
    if (!ocrOut?.ok) return null;
    const lines = ocrOut.lines || ocrOut.texts || ocrOut.regions || [];
    for (const line of lines) {
      const text = typeof line === 'string' ? line : line.text;
      if (!text || text.trim().length < 2) continue;
      candidates.push({
        tMs: fr.timestampMs,
        text: String(text).trim(),
        confidence: Number(line.confidence) || 0.6,
        language: line.language || null,
        roi: fr.roi || null,
      });
    }
    return null;
  };

  let stream;
  if (preferStream && mediaPath) {
    stream = await streamSubtitleBandFrames({
      mediaPath,
      startMs: windowStart,
      endMs: windowEnd,
      width,
      height,
      roi: policy?.subtitleFirst?.roi || 'auto',
      policy,
      ffmpegPath,
      signal,
      runner: streamRunner,
      detectRoi,
      onFrame,
    });
  } else if (extractFrameAt) {
    stream = await fallbackSampleFrames({
      extractFrameAt,
      startMs: windowStart,
      endMs: windowEnd,
      policy,
      signal,
      onFrame,
    });
  } else {
    return {
      ok: false,
      reason: 'unavailable',
      candidates: [],
      segments: [],
      evidence: [],
      ocrCalls: 0,
      framesScanned: 0,
      ffmpegStarts: 0,
      capability: 'unavailable',
      truncated: true,
      limitReasons: ['no_frame_source'],
      sampledRanges: [],
      budgets,
    };
  }

  const allReasons = [...new Set([...(stream.limitReasons || []), ...limitReasons])];
  const truncated = Boolean(stream.truncated || stopReason);

  const segments = buildSubtitleSegments(candidates, {
    videoKey,
    chunkId,
    source: 'ocr',
    clock,
  });
  const evidence = [];
  for (const s of segments) {
    try {
      evidence.push(makeEvidence({
        videoKey,
        kind: 'subtitle',
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        chunkId,
        confidence: s.confidence,
        sourceType: 'ocr',
        provenance: { adapter: 'subtitle-band-scanner', source: 'ocr' },
        clock,
      }));
    } catch { /* skip invalid */ }
  }

  return {
    ok: segments.length > 0 || candidates.length > 0,
    reason: segments.length ? null : 'no_text',
    candidates,
    segments: segments.map((s, i) => ({
      ...s,
      evidenceId: evidence[i]?.evidenceId || s.evidenceId,
      source: 'ocr',
      chunkId,
    })),
    evidence,
    ocrCalls,
    framesScanned: stream.framesScanned || 0,
    ffmpegStarts: stream.ffmpegStarts || 0,
    capability: stream.capability === 'degraded'
      ? 'degraded'
      : (segments.length ? 'ready' : 'degraded'),
    degradeReason: stream.degradeReason || null,
    truncated,
    limitReasons: allReasons,
    sampledRanges: stream.sampledRanges || [],
    budgets,
    provenance: {
      adapter: 'subtitle-band-scanner',
      generatedAt: typeof clock === 'function' ? clock() : clock,
      ffmpegStarts: stream.ffmpegStarts || 0,
    },
  };
}

/** 兼容旧全片 API：包装为 [0, durationMs) */
export async function scanBurnedSubtitlesFull(opts = {}) {
  return scanBurnedSubtitles({
    ...opts,
    startMs: 0,
    endMs: opts.durationMs || 0,
  });
}
