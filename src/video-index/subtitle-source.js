/**
 * subtitle-source.js — 字幕来源协调：bilibili → native → external → ocr → asr_generated。
 */

import { normalizeSubtitles, loadSubtitleFile } from './adapters/subtitle-adapter.js';
import { buildSubtitleSegments, mergeSubtitleSources } from './subtitle-segment-builder.js';
import { scanBurnedSubtitles } from './subtitle-band-scanner.js';
import { buildCoverageReport } from './coverage.js';

export const SUBTITLE_SOURCES = Object.freeze([
  'bilibili', 'native', 'external', 'ocr', 'asr_generated',
]);

/**
 * 统一收集字幕。可靠时间戳字幕存在时跳过 OCR。
 */
export async function resolveSubtitleSources({
  videoKey,
  indexVersion,
  bilibiliSubtitles = null,
  nativeSubtitles = null,
  subtitlePath = null,
  durationMs = 0,
  policy = null,
  ocr = null,
  extractFrameAt = null,
  detectRoi = null,
  signal,
  clock = () => new Date().toISOString(),
} = {}) {
  const parts = [];
  const skipped = [];

  const pushTrack = (raw, source) => {
    if (!raw?.length) return false;
    const pack = normalizeSubtitles(raw, { videoKey, indexVersion, clock });
    const segments = (pack.subtitles || pack.utterances || []).map((u) => ({
      segmentId: u.utteranceId || u.segmentId,
      startMs: u.startMs,
      endMs: u.endMs,
      text: u.text,
      confidence: u.confidence ?? 0.9,
      language: u.language || null,
      source,
      roi: null,
      evidenceId: u.evidenceId,
      chunkId: u.chunkId || null,
      provenance: { ...(u.provenance || {}), source },
    }));
    parts.push({
      source,
      segments,
      utterances: pack.utterances,
      evidence: pack.evidence,
      chapters: pack.chapters,
    });
    return segments.length > 0;
  };

  if (pushTrack(bilibiliSubtitles, 'bilibili')) {
    skipped.push('ocr');
  } else if (pushTrack(nativeSubtitles, 'native')) {
    skipped.push('ocr');
  } else if (subtitlePath) {
    try {
      const loaded = loadSubtitleFile(subtitlePath, { videoKey, indexVersion, clock });
      if (loaded?.utterances?.length) {
        parts.push({
          source: 'external',
          segments: loaded.utterances.map((u) => ({
            ...u,
            source: 'external',
            segmentId: u.utteranceId || u.segmentId,
          })),
          utterances: loaded.utterances,
          evidence: loaded.evidence,
          chapters: loaded.chapters,
        });
        skipped.push('ocr');
      }
    } catch {
      /* fall through to OCR */
    }
  }

  const hasReliableTrack = parts.some((p) => ['bilibili', 'native', 'external'].includes(p.source)
    && (p.segments || []).length > 0);

  let ocrCapability = 'skipped';
  if (!hasReliableTrack && policy?.subtitleFirst?.enabled !== false) {
    if (!extractFrameAt || !ocr) {
      ocrCapability = 'unavailable';
    } else {
      const scan = await scanBurnedSubtitles({
        videoKey,
        durationMs,
        extractFrameAt,
        ocr,
        policy,
        signal,
        detectRoi,
        clock,
      });
      ocrCapability = scan.capability || (scan.ok ? 'ready' : 'unavailable');
      if (scan.ok && scan.candidates?.length) {
        const segments = buildSubtitleSegments(scan.candidates, {
          videoKey,
          source: 'ocr',
          clock,
        });
        parts.push({
          source: 'ocr',
          segments,
          utterances: segments.map((s) => ({
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
            evidenceId: s.evidenceId,
            source: 'ocr',
          })),
          evidence: segments.map((s) => ({
            evidenceId: s.evidenceId,
            kind: 'subtitle',
            startMs: s.startMs,
            endMs: s.endMs,
            provenance: s.provenance,
          })),
          chapters: [],
          scan,
        });
      }
    }
  } else if (hasReliableTrack) {
    ocrCapability = 'skipped';
  }

  const segments = mergeSubtitleSources(parts, { videoKey });
  const utterances = parts.flatMap((p) => p.utterances || []);
  const evidence = parts.flatMap((p) => p.evidence || []);

  return {
    ok: segments.length > 0,
    segments,
    utterances,
    evidence,
    chapters: parts.flatMap((p) => p.chapters || []).slice(0, 24),
    sourcesUsed: [...new Set(parts.map((p) => p.source))],
    skippedOcr: skipped.includes('ocr'),
    capabilities: {
      subtitleText: segments.length ? 'ready' : 'unavailable',
      subtitleOcr: ocrCapability,
    },
    coverage: buildCoverage(segments, durationMs),
  };
}

export function buildCoverage(segments = [], durationMs = 0, extras = {}) {
  return buildCoverageReport({
    durationMs,
    textRanges: segments,
    sampledRanges: extras.sampledRanges
      || (segments?.length ? [{ startMs: 0, endMs: durationMs }] : []),
    truncated: Boolean(extras.truncated),
    limitReasons: extras.limitReasons || [],
    failedRanges: extras.failedRanges || [],
    sourceCoverage: extras.sourceCoverage || {},
    vadAuthorized: extras.vadAuthorized,
    vadRan: extras.vadRan,
    speechRanges: extras.speechRanges,
  });
}
