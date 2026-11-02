/**
 * evidence-package.js — Minimal Index / Full Evidence 包。
 */

import { estimateTextTokens } from './token-gate.js';
import { buildSpeakerViews, buildPersonCards, SPEAKER_VIEW_HARD } from './speaker-view.js';

/** Full Evidence 不可绕过的硬上限。 */
export const FULL_EVIDENCE_HARD = Object.freeze({
  utterances: 40,
  events: 24,
  storyboard: 8,
  subtitles: 40,
  timeline: 40,
  evidence: 64,
  identity: 8,
  speakers: SPEAKER_VIEW_HARD.maxSpeakers,
  maxTextTokens: 8_000,
  maxEvidenceIds: 64,
  maxEvidenceIdLen: 128,
  maxSingleFieldChars: 8_000,
});

const FULL_EVIDENCE_DEFAULTS = Object.freeze({
  maxUtterances: 20,
  maxEvents: 12,
  maxStoryboardUnits: 4,
  maxSubtitles: 40,
  maxTimeline: 40,
  maxEvidence: 64,
  maxIdentity: 8,
  maxSpeakers: SPEAKER_VIEW_HARD.maxSpeakers,
  maxTextTokens: 6_000,
});

/**
 * 安全解析预算数字：NaN / Infinity / 负数 / 非数字 → 默认；再夹到硬上限。
 */
export function clampBudgetInt(raw, def, hard) {
  const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), hard);
}

/**
 * 去重、限量、限长的 evidenceIds。
 */
export function sanitizeEvidenceIds(raw, {
  maxIds = FULL_EVIDENCE_HARD.maxEvidenceIds,
  maxLen = FULL_EVIDENCE_HARD.maxEvidenceIdLen,
} = {}) {
  if (raw == null) return { ids: null, truncated: false, omittedCount: 0 };
  if (!Array.isArray(raw)) return { ids: null, truncated: true, omittedCount: 0 };
  const out = [];
  const seen = new Set();
  let omittedCount = 0;
  for (const item of raw) {
    const s = item == null ? '' : String(item);
    if (!s || s.length > maxLen) {
      omittedCount += 1;
      continue;
    }
    if (seen.has(s)) {
      omittedCount += 1;
      continue;
    }
    if (out.length >= maxIds) {
      omittedCount += 1;
      continue;
    }
    seen.add(s);
    out.push(s);
  }
  return {
    ids: out,
    truncated: omittedCount > 0 || raw.length !== out.length,
    omittedCount,
  };
}

function timelineEvidenceIds(t, eventsById) {
  if (Array.isArray(t.evidenceIds) && t.evidenceIds.length) return t.evidenceIds;
  if (t.evidenceId != null) return [t.evidenceId];
  if (t.eventId != null && eventsById) {
    const ev = eventsById.get(t.eventId);
    if (ev?.evidenceIds?.length) return ev.evidenceIds;
  }
  return null;
}

export function buildMinimalIndexPackage(index) {
  const m = index.manifest;
  return {
    kind: 'minimal',
    schemaVersion: m.schemaVersion,
    indexVersion: m.indexVersion,
    videoKey: m.videoKey,
    source: m.source,
    metadata: index.metadata || {},
    chapters: (index.chapters || []).map((c) => ({
      chapterId: c.chapterId,
      title: c.title || '',
      startMs: c.startMs,
      endMs: c.endMs,
      topicTags: c.topicTags || [],
      evidenceIds: c.evidenceIds || [],
      summary: c.summary || '',
    })),
    topics: index.topics || [],
    keyMoments: index.keyMoments || [],
    entities: buildPersonCards(index.entityOverview || [], index.audioIndex || [], {
      maxPersons: SPEAKER_VIEW_HARD.maxPersons,
    }).persons.map((e) => ({
      personId: e.personId,
      label: e.label,
      bindingState: e.bindingState,
      confidence: e.confidence,
      speakerClusterIds: e.speakerClusterIds,
      faceTrackIds: e.faceTrackIds,
      timeRanges: e.timeRanges,
      evidenceIds: e.evidenceIds,
    })),
    persons: buildPersonCards(index.entityOverview || [], index.audioIndex || [], {
      maxPersons: SPEAKER_VIEW_HARD.maxPersons,
    }).persons,
    speakers: buildSpeakerViews(index.audioIndex || [], {
      maxSpeakers: SPEAKER_VIEW_HARD.maxSpeakers,
      maxRangesPerSpeaker: Math.min(4, SPEAKER_VIEW_HARD.maxRangesPerSpeaker),
    }).speakers,
    events: (index.events || []).slice(0, 50).map((e) => ({
      eventId: e.eventId,
      startMs: e.startMs,
      endMs: e.endMs,
      kind: e.kind,
      summary: e.summary || '',
      evidenceIds: e.evidenceIds || [],
    })),
    storyboardRefs: (index.storyboardIndex || []).map((s) => ({
      frameId: s.frameId,
      timestampMs: s.timestampMs,
      imageRef: s.imageRef,
      evidenceIds: s.evidenceIds || [],
    })),
    evidenceCount: (index.evidenceIndex || []).length,
    versions: m.versions,
    capabilities: m.capabilities,
  };
}

/**
 * 仅展开请求范围；不得因单个知识点展开整部视频。
 */
export function buildFullEvidencePackage(index, {
  startMs = 0,
  endMs = Number.POSITIVE_INFINITY,
  evidenceIds = null,
  includeIdentity = false,
} = {}) {
  const sanitized = sanitizeEvidenceIds(evidenceIds);
  const idList = sanitized.ids;
  const idSet = idList && idList.length ? new Set(idList) : (evidenceIds ? new Set() : null);
  // evidenceIds 传入但全部非法 → 空集合，不得展开整片
  const forceIdFilter = evidenceIds != null && Array.isArray(evidenceIds);

  const inRange = (x) => {
    const a = x.startMs ?? x.timestampMs ?? 0;
    const b = x.endMs ?? a;
    return b >= startMs && a <= endMs;
  };
  const matchEv = (ids) => {
    if (!forceIdFilter && !idSet) return true;
    if (!idSet || idSet.size === 0) return false;
    return (ids || []).some((id) => idSet.has(id));
  };

  const eventsById = new Map();
  for (const e of index.events || []) {
    if (e?.eventId != null) eventsById.set(e.eventId, e);
  }

  const subtitles = (index.subtitles || []).filter((s) => inRange(s) && matchEv(s.evidenceIds || [s.evidenceId]));
  const utterances = (index.utterances || []).filter((u) => inRange(u) && matchEv(u.evidenceIds || [u.evidenceId]));
  const events = (index.events || []).filter((e) => inRange(e) && matchEv(e.evidenceIds));
  const timeline = (index.timeline || []).filter((t) => {
    if (!inRange(t)) return false;
    if (!forceIdFilter && !idSet) return true;
    const ids = timelineEvidenceIds(t, eventsById);
    if (!ids || !ids.length) return false;
    return matchEv(ids);
  });
  const storyboard = (index.storyboardIndex || []).filter((s) => inRange(s) && matchEv(s.evidenceIds));
  const evidence = (index.evidenceIndex || []).filter((e) => {
    if (!inRange(e)) return false;
    if ((forceIdFilter || idSet) && (!idSet || !idSet.has(e.evidenceId))) return false;
    return true;
  });

  const identity = includeIdentity
    ? (index.entityTracks || index.entityOverview || []).filter((p) => inRange(p) && matchEv(p.evidenceIds))
    : [];

  // speakers：按时间范围裁剪；evidenceIds 模式不因此展开整片（仍受 range）
  const speakerPack = buildSpeakerViews(index.audioIndex || [], {
    startMs: Number.isFinite(startMs) ? startMs : undefined,
    endMs: Number.isFinite(endMs) ? endMs : undefined,
    maxSpeakers: FULL_EVIDENCE_HARD.speakers,
  });
  // evidenceIds 存在时：只保留与命中 utterance/event 相交的 speaker
  let speakers = speakerPack.speakers;
  if (forceIdFilter) {
    const allowedSpeakers = new Set();
    for (const u of utterances) {
      const sp = u.speakerClusterId || u.speakerId;
      if (sp) allowedSpeakers.add(sp);
    }
    speakers = speakers.filter((s) => allowedSpeakers.has(s.speakerClusterId));
  }

  return {
    kind: 'full',
    schemaVersion: index.manifest.schemaVersion,
    indexVersion: index.manifest.indexVersion,
    videoKey: index.manifest.videoKey,
    range: { startMs, endMs: Number.isFinite(endMs) ? endMs : null },
    evidenceIds: forceIdFilter ? (idList || []) : null,
    evidenceIdsSanitized: sanitized.truncated,
    subtitles,
    utterances,
    events,
    timeline,
    storyboard,
    evidence,
    identity,
    speakers,
    audio: { speakers },
    versions: index.manifest.versions,
    note: 'scoped full evidence; not entire video unless range covers all',
  };
}

function itemEvidenceIds(item) {
  const out = [];
  if (item?.evidenceId != null) out.push(item.evidenceId);
  if (Array.isArray(item?.evidenceIds)) out.push(...item.evidenceIds);
  return out;
}

function collectText(item, fields) {
  const parts = [];
  for (const f of fields) {
    const v = item?.[f];
    if (typeof v === 'string' && v) parts.push(v);
  }
  return parts.join('\n');
}

function truncateToTokens(text, maxTokens, measure) {
  if (!text) return { text: '', tokens: 0, truncated: false };
  const full = measure(text);
  if (full <= maxTokens) return { text, tokens: full, truncated: false };
  if (maxTokens <= 0) return { text: '', tokens: 0, truncated: true };
  // 保守：按字符比例切，再微调
  let lo = 0;
  let hi = text.length;
  let best = '';
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const slice = text.slice(0, mid);
    const t = measure(slice);
    if (t <= maxTokens) {
      best = slice;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { text: best, tokens: measure(best), truncated: true };
}

function applyFieldTruncation(item, fields, maxChars) {
  let changed = false;
  const out = { ...item };
  for (const f of fields) {
    if (typeof out[f] === 'string' && out[f].length > maxChars) {
      out[f] = out[f].slice(0, maxChars);
      changed = true;
    }
  }
  return { item: out, changed };
}

/**
 * 对 Full Evidence 包执行数组硬顶 + maxTextTokens 文本预算。
 */
export function applyFullEvidenceBudget(pack, budgetInput = {}, {
  measureText = estimateTextTokens,
} = {}) {
  const hard = FULL_EVIDENCE_HARD;
  const b = budgetInput && typeof budgetInput === 'object' ? budgetInput : {};

  const maxU = clampBudgetInt(b.maxUtterances, FULL_EVIDENCE_DEFAULTS.maxUtterances, hard.utterances);
  const maxE = clampBudgetInt(b.maxEvents, FULL_EVIDENCE_DEFAULTS.maxEvents, hard.events);
  const maxS = clampBudgetInt(b.maxStoryboardUnits, FULL_EVIDENCE_DEFAULTS.maxStoryboardUnits, hard.storyboard);
  const maxSub = clampBudgetInt(b.maxSubtitles, FULL_EVIDENCE_DEFAULTS.maxSubtitles, hard.subtitles);
  const maxTl = clampBudgetInt(b.maxTimeline, FULL_EVIDENCE_DEFAULTS.maxTimeline, hard.timeline);
  const maxEv = clampBudgetInt(b.maxEvidence, FULL_EVIDENCE_DEFAULTS.maxEvidence, hard.evidence);
  const maxId = clampBudgetInt(b.maxIdentity, FULL_EVIDENCE_DEFAULTS.maxIdentity, hard.identity);
  const maxSp = clampBudgetInt(b.maxSpeakers, FULL_EVIDENCE_DEFAULTS.maxSpeakers, hard.speakers);
  const maxText = clampBudgetInt(b.maxTextTokens, FULL_EVIDENCE_DEFAULTS.maxTextTokens, hard.maxTextTokens);

  const fieldsByKey = {
    subtitles: ['text'],
    utterances: ['text'],
    events: ['summary', 'text', 'title'],
    identity: ['label', 'note', 'displayName'],
    evidence: ['text', 'snippet', 'label', 'sourceFile', 'imageRef'],
    storyboard: ['imageRef', 'label'],
    timeline: [],
  };

  const countTrunc = {
    utterances: (pack.utterances || []).length > maxU,
    events: (pack.events || []).length > maxE,
    storyboard: (pack.storyboard || []).length > maxS,
    subtitles: (pack.subtitles || []).length > maxSub,
    timeline: (pack.timeline || []).length > maxTl,
    evidence: (pack.evidence || []).length > maxEv,
    identity: (pack.identity || []).length > maxId,
    speakers: (pack.speakers || []).length > maxSp,
  };

  const omittedEvidenceIds = [];
  const pushOmitted = (items, kept) => {
    const keepSet = new Set(kept);
    for (const it of items) {
      if (keepSet.has(it)) continue;
      for (const id of itemEvidenceIds(it)) omittedEvidenceIds.push(id);
    }
  };

  let subtitles = (pack.subtitles || []).slice(0, maxSub);
  let utterances = (pack.utterances || []).slice(0, maxU);
  let events = (pack.events || []).slice(0, maxE);
  let timeline = (pack.timeline || []).slice(0, maxTl);
  let storyboard = (pack.storyboard || []).slice(0, maxS);
  let evidence = (pack.evidence || []).slice(0, maxEv);
  let identity = (pack.identity || []).slice(0, maxId);
  let speakers = (pack.speakers || []).slice(0, maxSp).map((s) => ({
    speakerClusterId: s.speakerClusterId,
    totalMs: s.totalMs,
    segmentCount: s.segmentCount,
    timeRanges: (s.timeRanges || []).slice(0, SPEAKER_VIEW_HARD.maxRangesPerSpeaker),
    overlapMs: s.overlapMs || 0,
  }));

  pushOmitted(pack.subtitles || [], subtitles);
  pushOmitted(pack.utterances || [], utterances);
  pushOmitted(pack.events || [], events);
  pushOmitted(pack.storyboard || [], storyboard);
  pushOmitted(pack.evidence || [], evidence);
  pushOmitted(pack.identity || [], identity);

  // 单字段字符硬顶（防单条爆体积）
  const fieldTrunc = {
    subtitles: false,
    utterances: false,
    events: false,
    identity: false,
    evidence: false,
    storyboard: false,
  };
  const capFields = (arr, key) => arr.map((it) => {
    const { item, changed } = applyFieldTruncation(it, fieldsByKey[key], hard.maxSingleFieldChars);
    if (changed) fieldTrunc[key] = true;
    return item;
  });
  subtitles = capFields(subtitles, 'subtitles');
  utterances = capFields(utterances, 'utterances');
  events = capFields(events, 'events');
  identity = capFields(identity, 'identity');
  evidence = capFields(evidence, 'evidence');
  storyboard = capFields(storyboard, 'storyboard');

  // 文本 token 预算：按优先级保留，超限则截断字段或省略记录
  let remaining = maxText;
  let textTruncated = false;
  const enforceList = (arr, key) => {
    const fields = fieldsByKey[key];
    const kept = [];
    for (const it of arr) {
      if (!fields.length) {
        kept.push(it);
        continue;
      }
      const rawText = collectText(it, fields);
      const need = measureText(rawText);
      if (need <= remaining) {
        remaining -= need;
        kept.push(it);
        continue;
      }
      if (remaining <= 0) {
        textTruncated = true;
        for (const id of itemEvidenceIds(it)) omittedEvidenceIds.push(id);
        continue;
      }
      // 尝试截断字段塞进剩余预算
      const copy = { ...it };
      let localTrunc = false;
      for (const f of fields) {
        if (typeof copy[f] !== 'string' || !copy[f]) continue;
        const other = fields.filter((x) => x !== f).map((x) => copy[x] || '').join('\n');
        const otherTok = measureText(other);
        const allow = Math.max(0, remaining - otherTok);
        const { text, truncated } = truncateToTokens(copy[f], allow, measureText);
        if (truncated || text !== copy[f]) localTrunc = true;
        copy[f] = text;
      }
      const after = measureText(collectText(copy, fields));
      if (after <= 0 && need > 0) {
        textTruncated = true;
        for (const id of itemEvidenceIds(it)) omittedEvidenceIds.push(id);
        continue;
      }
      if (localTrunc) {
        textTruncated = true;
        fieldTrunc[key] = true;
      }
      remaining -= after;
      kept.push(copy);
    }
    return kept;
  };

  // 优先保留 evidence 索引元数据（通常短），再事件/话语/字幕
  evidence = enforceList(evidence, 'evidence');
  storyboard = enforceList(storyboard, 'storyboard');
  events = enforceList(events, 'events');
  utterances = enforceList(utterances, 'utterances');
  subtitles = enforceList(subtitles, 'subtitles');
  identity = enforceList(identity, 'identity');
  // timeline 无长文本，仅保留数量已切

  const measurePack = (subs, utts, evs, ids, evd, story) => measureText([
    ...subs.map((s) => s.text || ''),
    ...utts.map((u) => u.text || ''),
    ...evs.map((e) => `${e.summary || ''} ${e.text || ''}`),
    ...ids.map((p) => `${p.label || ''} ${p.note || ''}`),
    ...evd.map((e) => `${e.text || ''} ${e.snippet || ''} ${e.label || ''}`),
    ...story.map((s) => s.imageRef || ''),
  ].join('\n'));

  let finalSubtitles = subtitles;
  let finalUtterances = utterances;
  let finalEvents = events;
  let usedTokens = measurePack(finalSubtitles, finalUtterances, finalEvents, identity, evidence, storyboard);

  // 二次保险：仍超预算则截断最长项；再不行就丢弃长文本记录
  if (usedTokens > maxText) {
    textTruncated = true;
    const lists = [
      { key: 'subtitles', arr: finalSubtitles, fields: fieldsByKey.subtitles },
      { key: 'utterances', arr: finalUtterances, fields: fieldsByKey.utterances },
      { key: 'events', arr: finalEvents, fields: fieldsByKey.events },
    ];
    let target = null;
    let targetList = null;
    let targetIdx = -1;
    let targetKey = null;
    for (const L of lists) {
      L.arr.forEach((it, i) => {
        const len = collectText(it, L.fields).length;
        if (!target || len > collectText(target, targetList.fields).length) {
          target = it;
          targetList = L;
          targetIdx = i;
          targetKey = L.key;
        }
      });
    }
    if (target && targetIdx >= 0) {
      const othersTok = usedTokens - measureText(collectText(target, targetList.fields));
      const allow = Math.max(0, maxText - othersTok);
      const copy = { ...target };
      for (const f of targetList.fields) {
        if (typeof copy[f] !== 'string') continue;
        copy[f] = truncateToTokens(copy[f], allow, measureText).text;
      }
      targetList.arr[targetIdx] = copy;
      fieldTrunc[targetKey] = true;
      usedTokens = measurePack(finalSubtitles, finalUtterances, finalEvents, identity, evidence, storyboard);
    }
  }

  while (usedTokens > maxText && (finalSubtitles.length || finalUtterances.length || finalEvents.length)) {
    textTruncated = true;
    const dropFrom = finalSubtitles.length
      ? finalSubtitles
      : (finalUtterances.length ? finalUtterances : finalEvents);
    const drop = dropFrom.pop();
    for (const id of itemEvidenceIds(drop)) omittedEvidenceIds.push(id);
    usedTokens = measurePack(finalSubtitles, finalUtterances, finalEvents, identity, evidence, storyboard);
  }

  const idsSanitized = pack.evidenceIdsSanitized === true
    || (Array.isArray(pack.evidenceIds) && pack.evidenceIds.length > hard.maxEvidenceIds);

  const truncatedFlags = {
    ...countTrunc,
    ...fieldTrunc,
    textTokens: textTruncated || usedTokens > maxText,
    evidenceIds: idsSanitized,
  };
  const truncated = Object.values(truncatedFlags).some(Boolean)
    || textTruncated
    || usedTokens > maxText;

  return {
    ...pack,
    evidenceIds: Array.isArray(pack.evidenceIds)
      ? pack.evidenceIds.slice(0, hard.maxEvidenceIds)
      : pack.evidenceIds,
    subtitles: finalSubtitles,
    utterances: finalUtterances,
    events: finalEvents,
    timeline,
    storyboard,
    evidence,
    identity,
    speakers,
    audio: { speakers },
    budget: {
      truncated,
      estimatedTextTokens: usedTokens,
      estimated: true,
      omittedEvidenceIds: [...new Set(omittedEvidenceIds)],
      fields: truncatedFlags,
      limits: {
        maxU,
        maxE,
        maxS,
        maxSub,
        maxTl,
        maxEv,
        maxId,
        maxSp,
        maxTextTokens: maxText,
        maxEvidenceIds: hard.maxEvidenceIds,
        maxEvidenceIdLen: hard.maxEvidenceIdLen,
        hard: { ...hard },
      },
    },
  };
}

/**
 * Mnemosyne 候选包 — 不伪造已保存。
 */
export function buildMnemosyneCandidate({
  videoKey,
  selectedClaim,
  evidenceIds = [],
  userConfirmed = false,
  indexVersion = null,
  timeRange = null,
  evidenceHashes = [],
}) {
  if (!userConfirmed) {
    return {
      ok: false,
      reason: 'userConfirmed_required',
      saved: false,
    };
  }
  const { ids } = sanitizeEvidenceIds(evidenceIds);
  return {
    ok: true,
    saved: false,
    note: 'candidate only — not persisted to Mnemosyne without real API',
    observation: {
      videoKey,
      claim: selectedClaim,
      indexVersion,
      timeRange,
    },
    evidence: {
      evidenceIds: ids || [],
      hashes: [...evidenceHashes].slice(0, FULL_EVIDENCE_HARD.maxEvidenceIds),
    },
    claimCandidate: {
      text: selectedClaim,
      status: 'candidate',
      notKnowledge: true,
    },
    userScope: {
      confirmed: true,
      selectedClaim,
      evidenceIds: ids || [],
    },
  };
}
