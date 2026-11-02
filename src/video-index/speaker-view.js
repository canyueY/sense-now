/**
 * speaker-view.js — 从 audioIndex / entityOverview 生成受限、可进模型的 speaker/person 视图。
 * 不输出 embedding、声纹、人脸向量等原始生物特征。
 */

import { chapterIdOf } from './ids.js';
import { validateChapter } from './schema.js';

export const SPEAKER_VIEW_HARD = Object.freeze({
  maxSpeakers: 8,
  maxRangesPerSpeaker: 6,
  maxOverlaps: 8,
  maxSpeakerIdLen: 64,
  maxPersons: 8,
  maxIdsPerPerson: 4,
  maxPersonRanges: 6,
  maxPersonEvidence: 8,
});

function clampId(raw, maxLen = SPEAKER_VIEW_HARD.maxSpeakerIdLen) {
  const s = raw == null ? '' : String(raw);
  if (!s || s.length > maxLen) return null;
  return s;
}

function rangeOf(item) {
  const startMs = Number(item?.startMs);
  const endMs = Number(item?.endMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return { startMs, endMs };
}

function overlapsRange(r, startMs, endMs) {
  if (startMs == null && endMs == null) return true;
  const a = startMs == null ? -Infinity : startMs;
  const b = endMs == null ? Infinity : endMs;
  return r.endMs >= a && r.startMs <= b;
}

function clipRange(r, startMs, endMs) {
  const a = startMs == null ? r.startMs : Math.max(r.startMs, startMs);
  const b = endMs == null ? r.endMs : Math.min(r.endMs, endMs);
  if (b < a) return null;
  return { startMs: a, endMs: b };
}

/**
 * 从 audioIndex 生成受限 speaker 视图。
 * @param {Array} audioIndex
 * @param {{ startMs?: number, endMs?: number, maxSpeakers?: number, maxRangesPerSpeaker?: number }} opts
 */
export function buildSpeakerViews(audioIndex = [], opts = {}) {
  const hard = SPEAKER_VIEW_HARD;
  const maxSpeakers = Math.min(
    Number.isFinite(Number(opts.maxSpeakers)) && Number(opts.maxSpeakers) > 0
      ? Math.floor(Number(opts.maxSpeakers))
      : hard.maxSpeakers,
    hard.maxSpeakers,
  );
  const maxRanges = Math.min(
    Number.isFinite(Number(opts.maxRangesPerSpeaker)) && Number(opts.maxRangesPerSpeaker) > 0
      ? Math.floor(Number(opts.maxRangesPerSpeaker))
      : hard.maxRangesPerSpeaker,
    hard.maxRangesPerSpeaker,
  );
  const startMs = opts.startMs;
  const endMs = opts.endMs;
  const items = Array.isArray(audioIndex) ? audioIndex : [];

  /** @type {Map<string, { speakerClusterId: string, totalMs: number, segmentCount: number, timeRanges: Array, overlapMs: number }>} */
  const byId = new Map();

  for (const row of items) {
    if (row?.kind === 'speaker') {
      const id = clampId(row.speakerClusterId || row.speakerId);
      if (!id) continue;
      const cur = byId.get(id) || {
        speakerClusterId: id,
        totalMs: 0,
        segmentCount: 0,
        timeRanges: [],
        overlapMs: 0,
      };
      if (Number.isFinite(Number(row.totalMs))) cur.totalMs = Math.max(cur.totalMs, Number(row.totalMs));
      if (Number.isFinite(Number(row.segmentCount))) {
        cur.segmentCount = Math.max(cur.segmentCount, Number(row.segmentCount));
      }
      // chunked 索引只存 speaker 行（没有 active_segment），其 timeRanges 也要保留
      for (const tr of Array.isArray(row.timeRanges) ? row.timeRanges : []) {
        const r = rangeOf(tr);
        if (!r || !overlapsRange(r, startMs, endMs)) continue;
        const clipped = clipRange(r, startMs, endMs);
        if (clipped) cur.timeRanges.push(clipped);
      }
      byId.set(id, cur);
    }
  }

  for (const row of items) {
    if (row?.kind !== 'active_segment') continue;
    const id = clampId(row.speakerClusterId || row.speakerId);
    if (!id) continue;
    const r = rangeOf(row);
    if (!r || !overlapsRange(r, startMs, endMs)) continue;
    const clipped = clipRange(r, startMs, endMs);
    if (!clipped) continue;
    const cur = byId.get(id) || {
      speakerClusterId: id,
      totalMs: 0,
      segmentCount: 0,
      timeRanges: [],
      overlapMs: 0,
    };
    cur.timeRanges.push(clipped);
    byId.set(id, cur);
  }

  for (const row of items) {
    if (row?.kind !== 'overlap') continue;
    const r = rangeOf(row);
    if (!r || !overlapsRange(r, startMs, endMs)) continue;
    const clipped = clipRange(r, startMs, endMs);
    if (!clipped) continue;
    const dur = clipped.endMs - clipped.startMs;
    const ids = [
      ...(Array.isArray(row.speakerClusterIds) ? row.speakerClusterIds : []),
      row.speakerClusterId,
      row.speakerId,
    ].map((x) => clampId(x)).filter(Boolean);
    if (!ids.length) {
      // 无 speaker 标注的 overlap：均摊不到具体簇，跳过
      continue;
    }
    for (const id of ids) {
      const cur = byId.get(id);
      if (!cur) continue;
      cur.overlapMs += dur;
    }
  }

  // 补全 totalMs / segmentCount（若 speaker 行缺失）
  for (const cur of byId.values()) {
    if (!cur.timeRanges.length) continue;
    cur.timeRanges.sort((a, b) => a.startMs - b.startMs);
    if (!cur.segmentCount) cur.segmentCount = cur.timeRanges.length;
    if (!cur.totalMs) {
      cur.totalMs = cur.timeRanges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
    }
    cur.timeRanges = cur.timeRanges.slice(0, maxRanges);
  }

  const sorted = [...byId.values()].sort((a, b) => b.totalMs - a.totalMs || a.speakerClusterId.localeCompare(b.speakerClusterId));
  const truncated = sorted.length > maxSpeakers;
  const speakers = sorted.slice(0, maxSpeakers).map((s) => ({
    speakerClusterId: s.speakerClusterId,
    totalMs: s.totalMs,
    segmentCount: s.segmentCount,
    timeRanges: s.timeRanges,
    overlapMs: s.overlapMs,
  }));

  return { speakers, truncated };
}

/**
 * 匿名人物卡（无 embedding / 声纹 / 原始人脸特征）。
 */
export function buildPersonCards(entityOverview = [], audioIndex = [], opts = {}) {
  const hard = SPEAKER_VIEW_HARD;
  const maxPersons = Math.min(
    Number.isFinite(Number(opts.maxPersons)) && Number(opts.maxPersons) > 0
      ? Math.floor(Number(opts.maxPersons))
      : hard.maxPersons,
    hard.maxPersons,
  );
  const speakerViews = buildSpeakerViews(audioIndex, opts).speakers;
  const rangesBySpeaker = new Map(speakerViews.map((s) => [s.speakerClusterId, s.timeRanges]));

  const cards = [];
  for (const raw of entityOverview || []) {
    if (!raw?.personId) continue;
    const personId = clampId(raw.personId, 128);
    if (!personId) continue;

    const speakerClusterIds = [...new Set(
      (raw.speakerClusterIds || []).map((x) => clampId(x)).filter(Boolean),
    )].slice(0, hard.maxIdsPerPerson);

    const faceTrackIds = [...new Set(
      (raw.faceTrackIds || []).map((x) => clampId(x)).filter(Boolean),
    )].slice(0, hard.maxIdsPerPerson);

    const timeRanges = [];
    for (const sp of speakerClusterIds) {
      for (const r of rangesBySpeaker.get(sp) || []) {
        timeRanges.push({ ...r });
        if (timeRanges.length >= hard.maxPersonRanges) break;
      }
      if (timeRanges.length >= hard.maxPersonRanges) break;
    }

    // label：仅保留安全字段；「疑似主讲人/旁白」允许（非 UP 主本人断言）
    let label = null;
    if (raw.labelSource === 'user-confirmed' && raw.label) label = String(raw.label).slice(0, 64);
    else if (raw.labelSource === 'adapter' && raw.label) label = String(raw.label).slice(0, 64);
    else if (typeof raw.label === 'string' && /疑似主讲人|旁白/.test(raw.label)) {
      label = raw.label.slice(0, 32);
    }

    const evidenceIds = [...new Set(
      (raw.evidenceIds || []).map((x) => clampId(x, 128)).filter(Boolean),
    )].slice(0, hard.maxPersonEvidence);

    cards.push({
      personId,
      label,
      bindingState: raw.bindingState || 'unbound',
      confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0,
      speakerClusterIds,
      faceTrackIds,
      timeRanges,
      evidenceIds,
    });
    if (cards.length >= maxPersons) break;
  }

  return {
    persons: cards,
    truncated: (entityOverview || []).length > cards.length,
  };
}

/**
 * identityBinding 能力判定：ready 必须有至少一人同时含 face + speaker。
 */
export function classifyIdentityBindingCapability({
  requested = false,
  ranResolver = false,
  persons = [],
  observationsCount = 0,
} = {}) {
  if (!requested && !ranResolver && !persons.length && !observationsCount) {
    return 'unavailable';
  }
  if (!ranResolver) {
    return requested || observationsCount ? 'unavailable' : 'unavailable';
  }
  const hasFaceSpeaker = (persons || []).some(
    (p) => (p.faceTrackIds || []).length > 0 && (p.speakerClusterIds || []).length > 0,
  );
  if (hasFaceSpeaker) return 'ready';
  if ((persons || []).length > 0 || observationsCount > 0) return 'degraded';
  return 'degraded';
}

/**
 * 从 ASR utterances 生成轻量章节（仅真实原文，不编造摘要）。
 */
export function buildAsrChapterSkeleton(utterances = [], {
  videoKey,
  indexVersion,
  gapMs = 12_000,
  maxChapterMs = 90_000,
  maxUtterancesPerChapter = 24,
  maxChapters = 12,
  maxEvidencePerChapter = 16,
  maxTitleChars = 48,
} = {}) {
  const list = (utterances || []).filter((u) => u && Number.isFinite(u.startMs) && Number.isFinite(u.endMs));
  if (!list.length) return [];
  const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
  const chapters = [];
  let buf = [];
  let start = sorted[0].startMs;
  let prevEnd = sorted[0].endMs;

  const flush = (endMs) => {
    if (!buf.length || chapters.length >= maxChapters) {
      buf = [];
      return;
    }
    const evidenceIds = [...new Set(
      buf.flatMap((u) => [u.evidenceId, ...(u.evidenceIds || [])]).filter(Boolean),
    )].slice(0, maxEvidencePerChapter);
    const firstText = String(buf[0].text || '').trim();
    const title = firstText.slice(0, maxTitleChars);
    chapters.push(validateChapter({
      chapterId: chapterIdOf({ videoKey, indexVersion, startMs: start, endMs, title }),
      title,
      startMs: start,
      endMs,
      summary: '',
      topicTags: [],
      eventIds: [],
      evidenceIds,
      summaryMethod: 'asr-rules',
      confidence: evidenceIds.length ? 0.35 : 0,
    }));
    buf = [];
  };

  for (const u of sorted) {
    const wouldGap = buf.length && u.startMs - prevEnd >= gapMs;
    const wouldDur = buf.length && (u.endMs - start) > maxChapterMs;
    const wouldCount = buf.length >= maxUtterancesPerChapter;
    if (wouldGap || wouldDur || wouldCount) {
      flush(prevEnd);
      start = u.startMs;
    }
    if (chapters.length >= maxChapters) break;
    buf.push(u);
    prevEnd = u.endMs;
  }
  flush(prevEnd);
  return chapters;
}
