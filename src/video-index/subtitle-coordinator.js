/**
 * subtitle-coordinator.js — 同步 index 与后台 chunk 共用的字幕优先协调器。
 * 视频级字幕只解析/下载一次；chunk 只裁剪自身半开区间。
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { normalizeSubtitles, loadSubtitleFile, sliceSubtitlesByRange } from './adapters/subtitle-adapter.js';
import { scanBurnedSubtitles } from './subtitle-band-scanner.js';
import { extractEmbeddedSubtitles } from './native-subtitle.js';
import { materializeYtSubtitles } from './subtitle-download.js';
import { mayRunAsr } from './analysis-policy.js';
import { buildCoverageReport } from './coverage.js';

/** @type {Map<string, { value, expiresAt }>} 视频级字幕轨缓存（不含 OCR） */
const videoTrackCache = new Map();
/** @type {Map<string, { value, expiresAt }>} chunk OCR 缓存 */
const chunkOcrCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

export function clearSubtitleCache() {
  videoTrackCache.clear();
  chunkOcrCache.clear();
}

function cacheKeyOf({
  videoKey, mediaRevision, subtitlePath, language, policyHash, sourceFingerprint,
}) {
  return createHash('sha256')
    .update(JSON.stringify({
      videoKey, mediaRevision, subtitlePath, language, policyHash, sourceFingerprint,
    }))
    .digest('hex')
    .slice(0, 32);
}

function policyHashOf(policy) {
  if (!policy) return 'legacy';
  return createHash('sha256')
    .update(JSON.stringify({
      sf: policy.subtitleFirst,
      asr: policy.asr,
      lang: policy.language,
    }))
    .digest('hex')
    .slice(0, 16);
}

function aborted(signal) {
  if (signal?.aborted) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }
}

/**
 * 视频级：探测并物化字幕轨（B站/内嵌/外部）。
 * ocrMode:
 *   - 'none'（默认，长视频后台）：不跑 OCR，留给 chunk
 *   - 'whole_video'：同步短片可显式全片 OCR
 */
export async function resolveVideoSubtitles({
  videoKey,
  indexVersion = '1',
  mediaPath = null,
  mediaRevision = null,
  sourceDescriptor = null,
  bilibiliSubtitles = null,
  bilibiliSubtitleMap = null,
  nativeSubtitles = null,
  subtitlePath = null,
  language = null,
  policy = null,
  durationMs = 0,
  signal,
  ocr = null,
  extractFrameAt = null,
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  outDir = null,
  clock = () => new Date().toISOString(),
  adapters = {},
  ocrMode = 'none',
  probeOnly = null,
} = {}) {
  aborted(signal);
  const effectiveOcrMode = probeOnly === true
    ? 'none'
    : (ocrMode === 'whole_video' ? 'whole_video' : 'none');
  const key = cacheKeyOf({
    videoKey,
    mediaRevision: mediaRevision || sourceDescriptor?.contentFingerprint || mediaPath || '',
    subtitlePath,
    language,
    policyHash: `${policyHashOf(policy)}|ocr:${effectiveOcrMode}`,
    sourceFingerprint: sourceDescriptor?.bvid || sourceDescriptor?.url || '',
  });
  const hit = videoTrackCache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return { ...hit.value, cacheHit: true };
  }

  const parts = [];
  const sourcesUsed = [];
  let subtitleOcr = 'skipped';
  let subtitleText = 'unavailable';
  const scannedRanges = [];
  const failedRanges = [];
  const limitReasons = [];
  let truncated = false;
  const ocrCallCounter = { count: 0, max: policy?.budgets?.maxTotalOcrCalls || 2000 };

  const pushEntries = (entries, sourceType) => {
    if (!entries?.length) return false;
    parts.push(...entries.map((e) => ({ ...e, sourceType: e.sourceType || sourceType })));
    sourcesUsed.push(sourceType);
    return true;
  };

  // 1) B站已物化 / map
  if (Array.isArray(bilibiliSubtitles) && bilibiliSubtitles.length) {
    pushEntries(bilibiliSubtitles, 'bilibili');
  } else if (bilibiliSubtitleMap || sourceDescriptor?.subtitleMap) {
    aborted(signal);
    try {
      const rows = await materializeYtSubtitles(
        bilibiliSubtitleMap || sourceDescriptor.subtitleMap,
        {
          signal,
          preferredLangs: language ? [language, 'zh-CN', 'zh', 'en'] : undefined,
          fetchUrl: adapters.fetchSubtitleUrl || undefined,
        },
      );
      pushEntries(rows, 'bilibili');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      failedRanges.push({ startMs: 0, endMs: durationMs, reason: `bilibili:${e.message}` });
    }
  } else if (Array.isArray(sourceDescriptor?.subtitles) && sourceDescriptor.subtitles.length) {
    // resolveStreams 可能已带 data 行
    const hasText = sourceDescriptor.subtitles.some((s) => s.text);
    if (hasText) pushEntries(sourceDescriptor.subtitles, 'bilibili');
  }

  // 2) 调用方 native / inline
  if (!parts.length && Array.isArray(nativeSubtitles) && nativeSubtitles.length) {
    pushEntries(nativeSubtitles, 'native');
  }

  // 3) 外挂文件
  if (!parts.length && subtitlePath) {
    aborted(signal);
    try {
      const loaded = loadSubtitleFile(subtitlePath);
      pushEntries(loaded.map((e) => ({ ...e, sourceType: 'external' })), 'external');
    } catch (e) {
      failedRanges.push({ startMs: 0, endMs: durationMs, reason: `external:${e.message}` });
    }
  }

  // 4) 媒体内嵌轨
  if (!parts.length && mediaPath) {
    aborted(signal);
    const emb = await extractEmbeddedSubtitles(mediaPath, {
      ffmpegPath,
      ffprobePath,
      outDir: outDir || join(process.cwd(), '.tmp'),
      signal,
      language,
      runner: adapters.ffmpegSubtitle || null,
      probeRunner: adapters.ffprobeSubtitle || null,
    });
    if (emb.ok) {
      pushEntries(emb.entries, 'native');
    } else if (emb.skipToOcr) {
      subtitleOcr = 'pending';
    } else if (emb.capability === 'degraded') {
      subtitleText = 'degraded';
    }
  }

  // 5) OCR：仅 whole_video；长视频后台路径必须 none，交给 resolveChunkSubtitles
  const hasReliable = parts.length > 0
    && parts.some((p) => ['bilibili', 'native', 'external'].includes(p.sourceType));

  let ocrScan = null;
  if (hasReliable) {
    subtitleOcr = 'skipped';
    scannedRanges.push({ startMs: 0, endMs: durationMs || 0, kind: 'track' });
  } else if (effectiveOcrMode === 'whole_video'
    && policy?.subtitleFirst?.enabled !== false && mediaPath && ocr) {
    aborted(signal);
    ocrScan = await scanBurnedSubtitles({
      videoKey,
      startMs: 0,
      endMs: durationMs || 0,
      mediaPath,
      extractFrameAt,
      ocr,
      policy,
      signal,
      ffmpegPath,
      streamRunner: adapters.streamOcrFfmpeg || null,
      preferStream: true,
      clock,
      ocrCallCounter,
    });
    subtitleOcr = ocrScan.capability || 'unavailable';
    truncated = truncated || ocrScan.truncated;
    limitReasons.push(...(ocrScan.limitReasons || []));
    scannedRanges.push(...(ocrScan.sampledRanges || []));
    if (ocrScan.segments?.length) {
      pushEntries(ocrScan.segments.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        confidence: s.confidence,
        sourceType: 'ocr',
        evidenceId: s.evidenceId,
      })), 'ocr');
    }
  } else if (!hasReliable) {
    subtitleOcr = 'pending'; // 等待 chunk OCR
  }

  subtitleText = parts.length ? 'ready' : subtitleText;

  const pack = normalizeSubtitles(parts, { videoKey, indexVersion, clock });
  // 标注 source
  for (let i = 0; i < pack.utterances.length; i += 1) {
    const src = parts[i]?.sourceType || 'native';
    pack.utterances[i] = {
      ...pack.utterances[i],
      source: src === 'ocr' ? 'ocr' : 'subtitle',
      sourceType: src,
    };
  }

  const coverage = buildCoverageReport({
    durationMs,
    textRanges: pack.utterances.map((u) => ({ startMs: u.startMs, endMs: u.endMs })),
    sampledRanges: scannedRanges,
    missingRanges: [],
    truncated,
    limitReasons,
    failedRanges,
    sourceCoverage: Object.fromEntries(
      sourcesUsed.map((s) => [s, pack.utterances.filter((u) => u.sourceType === s).length]),
    ),
  });

  const value = {
    ok: pack.utterances.length > 0,
    entries: parts,
    utterances: pack.utterances,
    evidence: pack.evidence,
    chapters: pack.chapters,
    subtitles: pack.subtitles,
    sourcesUsed: [...new Set(sourcesUsed)],
    capabilities: {
      subtitleText,
      subtitleOcr,
    },
    coverage,
    ocrScan,
    ocrCallCounter,
    cacheKey: key,
  };
  videoTrackCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return { ...value, cacheHit: false, ocrMode: effectiveOcrMode };
}

/**
 * Chunk 级：裁剪视频级字幕；缺口时局部 OCR / ASR fallback。
 */
export async function resolveChunkSubtitles({
  videoKey,
  indexVersion = '1',
  chunk,
  videoSubtitles = null,
  mediaPath = null,
  policy = null,
  signal,
  ocr = null,
  asr = null,
  extractAudio = null,
  audioPath = null,
  ffmpegPath = 'ffmpeg',
  clock = () => new Date().toISOString(),
  adapters = {},
  ocrCallCounter = null,
} = {}) {
  aborted(signal);
  const startMs = Number(chunk.startMs) || 0;
  const endMs = Number(chunk.endMs) || startMs;
  const chunkId = chunk.chunkId;

  let base = videoSubtitles;
  if (!base) {
    base = await resolveVideoSubtitles({
      videoKey,
      indexVersion,
      mediaPath,
      policy,
      durationMs: endMs,
      signal,
      ocr: null,
      ffmpegPath,
      clock,
      adapters,
      ocrMode: 'none',
      probeOnly: true,
    });
  }

  let sliced = sliceSubtitlesByRange(base.entries || base.utterances || [], startMs, endMs);
  // 视频级 whole_video OCR 产物不得当作「可靠轨」冒充整片；仅裁剪非 OCR 源
  sliced = sliced.filter((s) => s.sourceType !== 'ocr' || base.ocrMode === 'whole_video');
  const sourcesUsed = [...(base.sourcesUsed || [])].filter((s) => s !== 'ocr' || base.ocrMode === 'whole_video');
  let subtitleOcr = 'skipped';
  const limitReasons = [];
  let truncated = false;
  const scannedRanges = [];
  let ocrEvidence = [];
  let asrUtterances = [];
  let asrEvidence = [];
  let asrCap = 'skipped';
  let ocrCacheHit = false;
  let ffmpegStarts = 0;

  const hasReliableText = sliced.some((s) => ['bilibili', 'native', 'external'].includes(s.sourceType)
    || (!s.sourceType && s.text));
  if (!hasReliableText && policy?.subtitleFirst?.enabled !== false && mediaPath && ocr) {
    aborted(signal);
    const ocrKey = createHash('sha256').update(JSON.stringify({
      videoKey,
      mediaRevision: base.cacheKey || '',
      chunkId,
      startMs,
      endMs,
      roi: policy?.subtitleFirst?.roi || 'auto',
      scanFps: policy?.subtitleFirst?.scanFps,
      ocrName: ocr?.name,
      ocrVersion: ocr?.version,
      policyHash: policyHashOf(policy),
    })).digest('hex').slice(0, 32);
    const ocrHit = chunkOcrCache.get(ocrKey);
    let scan;
    if (ocrHit && ocrHit.expiresAt > Date.now()) {
      scan = ocrHit.value;
      ocrCacheHit = true;
    } else {
      scan = await scanBurnedSubtitles({
        videoKey,
        startMs,
        endMs,
        mediaPath,
        ocr,
        policy,
        signal,
        ffmpegPath,
        streamRunner: adapters.streamOcrFfmpeg || null,
        preferStream: true,
        clock,
        chunkId,
        ocrCallCounter: ocrCallCounter || base.ocrCallCounter,
      });
      chunkOcrCache.set(ocrKey, { value: scan, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    subtitleOcr = scan.capability || 'unavailable';
    truncated = scan.truncated;
    limitReasons.push(...(scan.limitReasons || []));
    scannedRanges.push(...(scan.sampledRanges || []));
    ffmpegStarts = ocrCacheHit ? 0 : (scan.ffmpegStarts || 0);
    if (scan.segments?.length) {
      sliced = scan.segments.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        confidence: s.confidence,
        sourceType: 'ocr',
        evidenceId: s.evidenceId,
      }));
      ocrEvidence = scan.evidence || [];
      sourcesUsed.push('ocr');
    }
  }

  // ASR fallback：仅缺口且 mode 允许
  const gate = mayRunAsr(policy, { reason: sliced.length ? 'index' : 'subtitle_gap' });
  if (policy && gate.ok && !sliced.length
    && (policy.asr.mode === 'full' || policy.asr.mode === 'fallback')) {
    aborted(signal);
    if (asr?.available?.().ok) {
      let wav = audioPath;
      if (!wav && extractAudio && mediaPath) {
        wav = (await extractAudio({
          inputPath: mediaPath,
          startMs,
          endMs,
          signal,
        }))?.path;
      }
      if (wav) {
        const asrOut = await asr.analyze({
          videoKey, audioPath: wav, offsetMs: startMs, chunkId,
        }, { signal });
        if (asrOut.ok) {
          asrCap = 'ready';
          asrUtterances = (asrOut.utterances || []).map((u) => ({
            ...u,
            source: 'asr_generated',
            sourceType: 'asr_generated',
            chunkId,
          }));
          asrEvidence = asrOut.evidence || [];
          sourcesUsed.push('asr_generated');
        } else {
          asrCap = asrOut.reason === 'unavailable' ? 'unavailable' : 'degraded';
        }
      } else {
        asrCap = 'unavailable';
      }
    } else {
      asrCap = 'unavailable';
    }
  } else if (policy?.asr?.mode === 'off') {
    asrCap = 'skipped';
  }

  const pack = normalizeSubtitles(sliced, { videoKey, indexVersion, clock });
  const utterances = [
    ...pack.utterances.map((u) => ({ ...u, chunkId })),
    ...asrUtterances,
  ];
  const evidence = [
    ...pack.evidence,
    ...ocrEvidence,
    ...asrEvidence,
  ];

  const coverage = buildCoverageReport({
    durationMs: endMs - startMs,
    targetStartMs: startMs,
    targetEndMs: endMs,
    textRanges: utterances.map((u) => ({ startMs: u.startMs, endMs: u.endMs })),
    sampledRanges: scannedRanges.length
      ? scannedRanges
      : (sliced.length ? [{ startMs, endMs }] : []),
    truncated,
    limitReasons,
    sourceCoverage: Object.fromEntries(
      [...new Set(sourcesUsed)].map((s) => [
        s,
        utterances.filter((u) => (u.sourceType || u.source) === s).length,
      ]),
    ),
  });

  return {
    ok: utterances.length > 0,
    utterances,
    evidence,
    chapters: pack.chapters,
    subtitles: pack.subtitles,
    sourcesUsed: [...new Set(sourcesUsed)],
    capabilities: {
      subtitleText: utterances.length ? 'ready' : 'unavailable',
      subtitleOcr,
      asr: asrCap,
    },
    coverage,
    truncated,
    limitReasons,
    videoCacheHit: Boolean(videoSubtitles?.cacheHit),
    ocrCacheHit,
    ffmpegStarts,
  };
}
