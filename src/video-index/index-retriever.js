/**
 * index-retriever.js — 无依赖本地文本检索（可解释分数）。
 */

function normalize(s) {
  return String(s || '').normalize('NFKC').toLowerCase();
}

export function tokenize(text) {
  const s = normalize(text);
  const parts = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const cjkBlocks = s.match(/[\u3400-\u9fff]+/g) || [];
  for (const block of cjkBlocks) {
    if (block.length >= 2) parts.push(block);
    for (let i = 0; i < block.length - 1; i += 1) parts.push(block.slice(i, i + 2));
    for (let n = 3; n <= Math.min(4, block.length); n += 1) {
      for (let i = 0; i <= block.length - n; i += 1) parts.push(block.slice(i, i + n));
    }
  }
  return [...new Set(parts.filter((t) => t.length >= 1))];
}

function fieldScore(text, tokens, phrase, weight) {
  const n = normalize(text);
  if (!n) return { score: 0, hits: [] };
  const hits = [];
  let score = 0;
  if (phrase && n.includes(phrase)) {
    score += 5 * weight;
    hits.push({ type: 'phrase', weight });
  }
  let cover = 0;
  for (const t of tokens) {
    if (t.length >= 2 && n.includes(t)) {
      cover += 1;
      score += weight;
      hits.push({ type: 'token', token: t, weight });
    }
  }
  if (tokens.length) score += (cover / tokens.length) * weight;
  return { score, hits };
}

function parseTimeMs(question) {
  const m = String(question).match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (m) {
    if (m[3] != null) {
      return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
    }
    return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  }
  const sec = String(question).match(/(\d+)\s*秒/);
  if (sec) return Number(sec[1]) * 1000;
  const min = String(question).match(/(\d+)\s*分/);
  if (min) return Number(min[1]) * 60 * 1000;
  return null;
}

function utteranceKey(u) {
  return u.utteranceId || u.evidenceId || `${u.startMs}:${u.endMs}:${u.text || ''}`;
}

function speakerOf(u) {
  return u.speakerClusterId || u.speakerId || null;
}

/**
 * text_structure：无关键词命中时按前/中/后均匀抽样真实 utterances。
 */
export function sampleStructureUtterances(utterances = [], maxN = 12) {
  const all = [...(utterances || [])].sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  if (!all.length || maxN <= 0) return [];
  if (all.length <= maxN) {
    return all.map((u) => ({
      ...u,
      _score: 0.1,
      _reasons: ['asr_structure_fallback'],
    }));
  }
  const picks = new Map();
  const take = (idx) => {
    const i = Math.max(0, Math.min(all.length - 1, idx));
    const u = all[i];
    picks.set(utteranceKey(u), u);
  };
  // 前 / 中 / 后锚点
  take(0);
  take(Math.floor((all.length - 1) / 2));
  take(all.length - 1);
  // 均匀填充
  const step = (all.length - 1) / Math.max(1, maxN - 1);
  for (let k = 0; k < maxN && picks.size < maxN; k += 1) {
    take(Math.round(k * step));
  }
  return [...picks.values()]
    .sort((a, b) => (a.startMs || 0) - (b.startMs || 0))
    .slice(0, maxN)
    .map((u) => ({
      ...u,
      _score: 0.1,
      _reasons: ['asr_structure_fallback'],
    }));
}

/**
 * multimodal：按 speaker 分组，保证各簇至少一条（预算允许时）。
 */
export function retrieveSpeakerAwareUtterances(allUtterances = [], scoredHits = [], {
  maxUtterances = 12,
} = {}) {
  const reasons = ['speaker_grouped_retrieval'];
  const all = Array.isArray(allUtterances) ? allUtterances : [];
  const tagged = all.filter((u) => speakerOf(u));
  if (!tagged.length) {
    const fallback = all.slice(0, maxUtterances).map((u) => ({
      ...u,
      _score: u._score ?? 0.1,
      _reasons: ['speaker_fallback'],
    }));
    return {
      utterances: fallback,
      reasons: ['speaker_fallback'],
      truncated: all.length > maxUtterances,
    };
  }

  const hitByKey = new Map();
  for (const u of scoredHits || []) hitByKey.set(utteranceKey(u), u);

  const bySpeaker = new Map();
  for (const u of tagged) {
    const sp = speakerOf(u);
    if (!bySpeaker.has(sp)) bySpeaker.set(sp, []);
    bySpeaker.get(sp).push(u);
  }

  // speaker 排序：总时长近似（用 end-start 和），稳定
  const speakerOrder = [...bySpeaker.entries()].map(([sp, list]) => {
    const totalMs = list.reduce((s, u) => s + Math.max(0, (u.endMs || 0) - (u.startMs || 0)), 0);
    return { sp, list, totalMs };
  }).sort((a, b) => b.totalMs - a.totalMs || a.sp.localeCompare(b.sp));

  const selected = [];
  const selectedKeys = new Set();
  let truncated = false;

  const pickRep = (list) => {
    const hit = list
      .map((u) => hitByKey.get(utteranceKey(u)))
      .filter(Boolean)
      .sort((a, b) => (b._score || 0) - (a._score || 0))[0];
    if (hit) return { ...hit, _reasons: [...(hit._reasons || []), 'speaker_grouped_retrieval'] };
    // 最长 → 最高置信 → 最早
    const sorted = [...list].sort((a, b) => {
      const da = (a.endMs || 0) - (a.startMs || 0);
      const db = (b.endMs || 0) - (b.startMs || 0);
      if (db !== da) return db - da;
      const ca = Number(a.confidence) || 0;
      const cb = Number(b.confidence) || 0;
      if (cb !== ca) return cb - ca;
      return (a.startMs || 0) - (b.startMs || 0);
    });
    const u = sorted[0];
    return {
      ...u,
      _score: u._score ?? 0.15,
      _reasons: ['speaker_grouped_retrieval', 'speaker_fallback'],
    };
  };

  for (const { list } of speakerOrder) {
    if (selected.length >= maxUtterances) {
      truncated = true;
      break;
    }
    const rep = pickRep(list);
    const key = utteranceKey(rep);
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    selected.push(rep);
  }

  if (speakerOrder.length > maxUtterances) {
    truncated = true;
    reasons.push('speaker_budget_truncated');
  }

  // 填充剩余高分命中
  const restHits = [...(scoredHits || [])]
    .sort((a, b) => (b._score || 0) - (a._score || 0) || (a.startMs || 0) - (b.startMs || 0));
  for (const u of restHits) {
    if (selected.length >= maxUtterances) {
      truncated = true;
      break;
    }
    const key = utteranceKey(u);
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    selected.push({
      ...u,
      _reasons: [...(u._reasons || []), 'speaker_grouped_retrieval'],
    });
  }

  return { utterances: selected, reasons, truncated };
}

/**
 * 两级检索：先对 catalog 打分选 top chunks，再只加载命中块。
 * @returns {{ chunkIds: string[], scores: Array<{chunkId,score}>, atMs: number|null }}
 */
/**
 * 全片泛问：按时间覆盖选代表块（开头/中段/结尾 + 章节价值），受硬预算限制。
 */
export function selectOverviewChunksFromCatalog(catalog, {
  maxChunks = 12,
  hardMax = 24,
} = {}) {
  const entries = (Array.isArray(catalog?.chunks) ? catalog.chunks
    : (Array.isArray(catalog) ? catalog : []))
    .filter((c) => ['ready', 'degraded'].includes(c.status))
    .sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  const limit = Math.min(hardMax, Math.max(3, Number(maxChunks) || 12));
  if (!entries.length) return { chunkIds: [], scores: [], mode: 'overview' };
  if (entries.length <= limit) {
    return {
      chunkIds: entries.map((c) => c.chunkId),
      scores: entries.map((c) => ({ chunkId: c.chunkId, score: 0.2, startMs: c.startMs, endMs: c.endMs })),
      mode: 'overview',
    };
  }

  const picks = new Map();
  const take = (idx, score = 0.2) => {
    const i = Math.max(0, Math.min(entries.length - 1, idx));
    const c = entries[i];
    if (!picks.has(c.chunkId)) {
      picks.set(c.chunkId, {
        chunkId: c.chunkId, score, startMs: c.startMs, endMs: c.endMs,
      });
    }
  };
  // 开头 / 中段 / 结尾硬覆盖
  take(0, 0.5);
  take(Math.floor((entries.length - 1) / 2), 0.45);
  take(entries.length - 1, 0.5);
  // 按 topic/excerpt 价值
  const valued = [...entries]
    .map((c) => ({
      c,
      v: (c.topicTags || []).length * 2
        + Math.min(8, String(c.firstUtteranceExcerpt || '').length / 10)
        + (Number(c.subtitleCoverage) || 0),
    }))
    .sort((a, b) => b.v - a.v);
  for (const { c, v } of valued) {
    if (picks.size >= limit) break;
    take(entries.indexOf(c), 0.2 + Math.min(0.3, v / 20));
  }
  // 均匀补齐时间轴
  const step = (entries.length - 1) / Math.max(1, limit - 1);
  for (let k = 0; k < limit && picks.size < limit; k += 1) {
    take(Math.round(k * step), 0.15);
  }
  const scores = [...picks.values()].sort((a, b) => a.startMs - b.startMs);
  return {
    chunkIds: scores.map((s) => s.chunkId),
    scores,
    mode: 'overview',
  };
}

function isOverviewQuestion(question = '', queryType = '') {
  if (queryType !== 'text_structure') return false;
  const q = String(question);
  return /整[个部]?视频|全片|总结|概述|讲了什么|讲了些什么|主要内容|大体|整体/.test(q)
    || /what.*(about|summary|overall)|summarize|whole video/i.test(q);
}

export function selectChunksFromCatalog(catalog, {
  question = '',
  queryType = 'text_structure',
  topK = 3,
  overviewMaxChunks = 12,
} = {}) {
  const entries = Array.isArray(catalog?.chunks) ? catalog.chunks
    : (Array.isArray(catalog) ? catalog : []);
  const tokens = tokenize(question);
  const phrase = normalize(question);
  const atMs = parseTimeMs(question);

  // 泛问：不得只加载 Top 2～3；改走时间覆盖代表块
  if (atMs == null && isOverviewQuestion(question, queryType)) {
    return selectOverviewChunksFromCatalog(catalog, {
      maxChunks: Math.max(topK, overviewMaxChunks),
    });
  }

  const readyEntries = entries.filter((c) => ['ready', 'degraded'].includes(c.status));
  const scored = readyEntries
    .map((c) => {
      let score = 0;
      if (atMs != null && c.startMs <= atMs && atMs < c.endMs) score += 20;
      const blob = `${c.firstUtteranceExcerpt || ''} ${(c.topicTags || []).join(' ')} ${(c.topTokens || []).join(' ')}`;
      score += fieldScore(blob, tokens, phrase, 2).score;
      if (queryType === 'multimodal' && (c.speakerClusterIds || []).length) score += 1;
      return { chunkId: c.chunkId, score, startMs: c.startMs, endMs: c.endMs };
    })
    .filter((c) => c.score > 0 || (atMs == null && queryType === 'text_structure'))
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));

  // 画面问题常常没有文本命中；仍要加载带帧的 chunk，否则 storyboard 永远进不了 query
  if (!scored.length && (queryType === 'visual' || queryType === 'multimodal' || queryType === 'deep')) {
    const fallback = readyEntries.slice(0, Math.max(1, topK));
    return {
      chunkIds: fallback.map((c) => c.chunkId),
      scores: fallback.map((c) => ({
        chunkId: c.chunkId, score: 0.1, startMs: c.startMs, endMs: c.endMs,
      })),
      atMs,
      mode: 'visual_fallback',
    };
  }

  let picks = scored;
  if (atMs != null) {
    picks = scored.filter((c) => c.startMs <= atMs && atMs < c.endMs);
    if (!picks.length) picks = scored.slice(0, topK);
    // 精确命中时带上相邻块
    if (picks.length) {
      const hit = picks[0];
      const idx = entries.findIndex((c) => c.chunkId === hit.chunkId);
      const neigh = [];
      if (idx > 0) neigh.push(entries[idx - 1]);
      if (idx >= 0 && idx < entries.length - 1) neigh.push(entries[idx + 1]);
      for (const n of neigh) {
        if (!picks.some((p) => p.chunkId === n.chunkId)) {
          picks.push({
            chunkId: n.chunkId, score: 0.5, startMs: n.startMs, endMs: n.endMs,
          });
        }
      }
    }
  } else if (queryType === 'text_structure' && scored.every((c) => c.score === 0)) {
    // 无关键词：也走 overview，避免只取前 topK
    return selectOverviewChunksFromCatalog(catalog, {
      maxChunks: Math.max(topK, overviewMaxChunks),
    });
  }
  const sliceN = Math.max(1, atMs != null ? Math.min(picks.length, topK + 2) : topK);
  const chunkIds = picks.slice(0, sliceN).map((c) => c.chunkId);
  return { chunkIds, scores: picks.slice(0, sliceN), atMs };
}

/**
 * 将多个 ready chunk 合并为 retrieve 可用的轻量 index 视图。
 */
export function mergeChunkViews(chunks = []) {
  const utterances = [];
  const events = [];
  const chapters = [];
  const storyboardIndex = [];
  const evidenceIndex = [];
  const speakers = [];
  for (const c of chunks) {
    for (const u of c.utterances || []) {
      utterances.push({
        ...u,
        chunkId: c.chunkId,
        revision: c.manifest?.revision,
        timeSource: c.manifest?.timeSource,
      });
    }
    for (const e of c.events || []) {
      events.push({ ...e, chunkId: c.chunkId, revision: c.manifest?.revision });
    }
    for (const ch of c.chapters || []) {
      chapters.push({ ...ch, chunkId: c.chunkId });
    }
    for (const s of c.storyboard || []) {
      storyboardIndex.push({ ...s, chunkId: c.chunkId });
    }
    for (const ev of c.evidence || []) {
      evidenceIndex.push({
        ...ev,
        chunkId: c.chunkId,
        revision: c.manifest?.revision,
        timeSource: c.manifest?.timeSource,
      });
    }
    for (const sp of c.speakers || []) speakers.push(sp);
  }
  return {
    utterances,
    events,
    chapters,
    storyboardIndex,
    evidenceIndex,
    speakers,
    metadata: {},
  };
}

/**
 * @param {object} index — loadIndex() 结果
 * @param {{ question: string, queryType: string, maxUtterances?: number }} req
 */
export function retrieve(index, {
  question = '',
  queryType = 'text_structure',
  maxUtterances = 12,
} = {}) {
  const tokens = tokenize(question);
  const phrase = normalize(question);
  const atMs = parseTimeMs(question);
  const details = [];
  const extraReasons = [];

  const metaBlob = `${index.metadata?.title || ''} ${index.metadata?.description || ''}`;
  const chapters = (index.chapters || []).map((c) => {
    const a = fieldScore(`${c.title || ''} ${(c.topicTags || []).join(' ')} ${metaBlob}`, tokens, phrase, 3);
    const b = fieldScore(c.summary || '', tokens, phrase, 2);
    let score = a.score + b.score;
    if (atMs != null && c.startMs <= atMs && atMs <= c.endMs) score += 8;
    details.push({ kind: 'chapter', id: c.chapterId, score, hits: [...a.hits, ...b.hits] });
    return { ...c, _score: score };
  }).filter((c) => c._score > 0 || queryType === 'text_structure')
    .sort((a, b) => b._score - a._score);

  const events = (index.events || []).map((e) => {
    const a = fieldScore(`${e.summary || ''} ${e.text || ''} ${e.kind || ''}`, tokens, phrase, 2.5);
    let score = a.score;
    if (atMs != null && Math.abs((e.startMs || 0) - atMs) < 15_000) score += 6;
    details.push({ kind: 'event', id: e.eventId, score, hits: a.hits });
    return { ...e, _score: score };
  }).filter((e) => e._score > 0)
    .sort((a, b) => b._score - a._score);

  const scoredUtterances = (index.utterances || []).map((u) => {
    const speaker = speakerOf(u) || '';
    const a = fieldScore(`${u.text || ''} ${speaker}`, tokens, phrase, 2);
    let score = a.score;
    if (atMs != null && u.startMs <= atMs && atMs <= u.endMs) score += 7;
    details.push({ kind: 'utterance', id: u.utteranceId || u.evidenceId, score, hits: a.hits });
    return { ...u, _score: score };
  }).filter((u) => u._score > 0)
    .sort((a, b) => b._score - a._score);

  let utterances = scoredUtterances;

  if (queryType === 'multimodal') {
    const tagged = (index.utterances || []).some((u) => speakerOf(u));
    if (tagged) {
      const grouped = retrieveSpeakerAwareUtterances(index.utterances || [], scoredUtterances, {
        maxUtterances,
      });
      utterances = grouped.utterances;
      extraReasons.push(...grouped.reasons);
      if (grouped.truncated) extraReasons.push('speaker_budget_truncated');
    } else if (utterances.length === 0) {
      utterances = (index.utterances || []).slice(0, maxUtterances).map((u) => ({
        ...u,
        _score: 0.1,
        _reasons: ['speaker_fallback'],
      }));
      extraReasons.push('speaker_fallback');
    }
  }

  if (queryType === 'text_structure') {
    const keywordHits = scoredUtterances.length;
    if (keywordHits === 0 && (index.utterances || []).length > 0) {
      utterances = sampleStructureUtterances(index.utterances, maxUtterances);
      extraReasons.push('asr_structure_fallback');
    }
  }

  let finalChapters = chapters;
  if (queryType === 'text_structure' && finalChapters.filter((c) => c._score > 0).length === 0) {
    finalChapters = (index.chapters || []).slice(0, 3).map((c) => ({ ...c, _score: 0.1 }));
  }

  const storyboard = (index.storyboardIndex || []).map((s) => {
    let score = 0.1;
    if (atMs != null && Math.abs((s.timestampMs || 0) - atMs) < 10_000) score += 5;
    return { ...s, _score: score };
  }).sort((a, b) => b._score - a._score);

  const evidenceIds = new Set();
  for (const c of finalChapters) for (const id of c.evidenceIds || []) evidenceIds.add(id);
  for (const e of events) for (const id of e.evidenceIds || []) evidenceIds.add(id);
  for (const u of utterances) {
    if (u.evidenceId) evidenceIds.add(u.evidenceId);
    for (const id of u.evidenceIds || []) evidenceIds.add(id);
  }

  return {
    metadata: index.metadata || {},
    chapters: finalChapters,
    events,
    utterances,
    storyboardUnits: storyboard,
    evidenceIds: [...evidenceIds],
    scoreDetails: details.filter((d) => d.score > 0),
    atMs,
    reasons: [...new Set(extraReasons)],
  };
}
