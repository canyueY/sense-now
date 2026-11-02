/**
 * subtitle-segment-builder.js — OCR/多源字幕规范化、多帧确认、去重合并。
 */

import { contentHash, evidenceIdOf } from './ids.js';

export function normalizeSubtitleText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[，,。.!！？?；;：:、]+$/g, '')
    .trim()
    .toLowerCase();
}

export function textSimilarity(a, b) {
  const x = normalizeSubtitleText(a);
  const y = normalizeSubtitleText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    return Math.min(x.length, y.length) / Math.max(x.length, y.length);
  }
  const setX = new Set([...x]);
  const setY = new Set([...y]);
  let inter = 0;
  for (const ch of setX) if (setY.has(ch)) inter += 1;
  return (2 * inter) / (setX.size + setY.size || 1);
}

/**
 * 多帧候选 → 确认字幕段（至少跨 2 个候选；排除长期固定水印）。
 */
export function buildSubtitleSegments(candidates = [], {
  videoKey,
  chunkId = null,
  source = 'ocr',
  minConfirmFrames = 2,
  mergeSimilarity = 0.86,
  watermarkMinOccurrences = 8,
  clock = () => new Date().toISOString(),
} = {}) {
  const sorted = [...(candidates || [])]
    .filter((c) => c?.text && Number.isFinite(c.tMs))
    .sort((a, b) => a.tMs - b.tMs);

  // 长期固定文字（水印）：同一规范化文本在大量时间点出现 → 排除
  const normCounts = new Map();
  for (const c of sorted) {
    const n = normalizeSubtitleText(c.text);
    if (!n) continue;
    normCounts.set(n, (normCounts.get(n) || 0) + 1);
  }
  const watermarks = new Set(
    [...normCounts.entries()]
      .filter(([, n]) => n >= watermarkMinOccurrences)
      .map(([k]) => k),
  );

  const groups = [];
  for (const c of sorted) {
    const norm = normalizeSubtitleText(c.text);
    if (!norm || watermarks.has(norm)) continue;
    const last = groups[groups.length - 1];
    if (last && textSimilarity(last.text, c.text) >= mergeSimilarity
      && c.tMs - last.endMs <= 2500) {
      last.endMs = Math.max(last.endMs, c.tMs);
      last.frames += 1;
      last.confidence = Math.max(last.confidence, Number(c.confidence) || 0);
      last.samples.push(c);
    } else {
      groups.push({
        text: String(c.text).trim(),
        startMs: c.tMs,
        endMs: c.tMs + 800,
        frames: 1,
        confidence: Number(c.confidence) || 0.5,
        language: c.language || null,
        roi: c.roi || null,
        samples: [c],
      });
    }
  }

  const segments = [];
  for (const g of groups) {
    if (g.frames < minConfirmFrames && source === 'ocr') continue;
    const startMs = Math.round(g.startMs);
    const endMs = Math.round(Math.max(g.endMs, startMs + 200));
    const norm = normalizeSubtitleText(g.text);
    const ch = contentHash(`${norm}:${startMs}:${endMs}:${source}`);
    const evidenceId = evidenceIdOf({
      videoKey,
      kind: 'subtitle',
      startMs,
      endMs,
      contentHash: ch,
    });
    const segmentId = `SUB_${ch.slice(0, 12)}`;
    segments.push({
      segmentId,
      startMs,
      endMs,
      text: g.text,
      confidence: g.confidence,
      language: g.language,
      source,
      roi: g.roi,
      evidenceId,
      chunkId,
      provenance: {
        adapter: 'subtitle-segment-builder',
        generatedAt: typeof clock === 'function' ? clock() : clock,
        confirmFrames: g.frames,
      },
    });
  }
  return segments;
}

export function mergeSubtitleSources(parts = [], { videoKey } = {}) {
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    for (const s of part.segments || []) {
      const key = `${normalizeSubtitleText(s.text)}|${Math.round((s.startMs || 0) / 200)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...s,
        videoKey: s.videoKey || videoKey,
        source: s.source || part.source,
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
