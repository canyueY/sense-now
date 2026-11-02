/**
 * event-aggregator.js — 从字幕/事件规则聚合 topics 与 key-moments。
 * 不发明摘要正文；只做可回溯的标签与时间锚点。
 */

import { eventIdOf } from './ids.js';

const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '就', '都', '也',
  '和', '与', '或', '及', '一个', '我们', '你们', '他们', '什么', '怎么', '因为', '所以',
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with',
]);

function tokenize(text) {
  const s = String(text || '').normalize('NFKC').toLowerCase();
  const out = [];
  for (const w of s.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 2 && !STOP.has(w)) out.push(w);
  }
  const cjk = s.replace(/[^\u3400-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i += 1) {
    const bg = cjk.slice(i, i + 2);
    if (!STOP.has(bg)) out.push(bg);
  }
  for (let i = 0; i < cjk.length - 2; i += 1) {
    out.push(cjk.slice(i, i + 3));
  }
  return out;
}

/**
 * 从 utterances/字幕统计主题标签（频次），绑定代表性 evidenceIds。
 */
export function aggregateTopics({
  utterances = [],
  chapters = [],
  maxTopics = 12,
} = {}) {
  const freq = new Map(); // token -> { count, evidenceIds, startMs, endMs }
  const feed = (text, evidenceId, startMs, endMs) => {
    for (const t of tokenize(text)) {
      if (t.length < 2) continue;
      const cur = freq.get(t) || { count: 0, evidenceIds: new Set(), startMs, endMs };
      cur.count += 1;
      if (evidenceId) cur.evidenceIds.add(evidenceId);
      cur.startMs = Math.min(cur.startMs ?? startMs, startMs);
      cur.endMs = Math.max(cur.endMs ?? endMs, endMs);
      freq.set(t, cur);
    }
  };
  for (const u of utterances) {
    feed(u.text, u.evidenceId || (u.evidenceIds || [])[0], u.startMs || 0, u.endMs || 0);
  }
  for (const c of chapters) {
    feed(`${c.title || ''} ${(c.topicTags || []).join(' ')}`, (c.evidenceIds || [])[0], c.startMs, c.endMs);
  }

  return [...freq.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxTopics)
    .map(([tag, v]) => ({
      tag,
      count: v.count,
      startMs: v.startMs ?? 0,
      endMs: v.endMs ?? 0,
      evidenceIds: [...v.evidenceIds].slice(0, 8),
    }));
}

/**
 * 关键时刻：章节边界、长 utterance、含问号/强调的字幕行。
 */
export function aggregateKeyMoments({
  chapters = [],
  utterances = [],
  events = [],
  videoKey = '',
  indexVersion = '',
  maxMoments = 20,
} = {}) {
  const moments = [];

  for (const c of chapters) {
    moments.push({
      momentId: eventIdOf({
        videoKey, indexVersion, startMs: c.startMs, kind: 'chapter_boundary', contentHash: c.chapterId,
      }),
      kind: 'chapter_boundary',
      startMs: c.startMs,
      endMs: c.startMs,
      label: c.title || '',
      evidenceIds: (c.evidenceIds || []).slice(0, 4),
      confidence: c.title ? 0.5 : 0.3,
    });
  }

  for (const u of utterances) {
    const text = String(u.text || '');
    const long = text.length >= 24;
    const emph = /[？?！!]/.test(text) || /重要|注意|结论|总结|首先|最后/.test(text);
    if (!long && !emph) continue;
    moments.push({
      momentId: eventIdOf({
        videoKey,
        indexVersion,
        startMs: u.startMs,
        kind: emph ? 'emphasis' : 'long_utterance',
        contentHash: u.evidenceId || text.slice(0, 32),
      }),
      kind: emph ? 'emphasis' : 'long_utterance',
      startMs: u.startMs,
      endMs: u.endMs,
      label: text.slice(0, 80),
      evidenceIds: [u.evidenceId, ...(u.evidenceIds || [])].filter(Boolean).slice(0, 4),
      confidence: emph ? 0.55 : 0.4,
    });
  }

  // 去重：同 startMs±1s 同 kind 只留置信度高的
  moments.sort((a, b) => a.startMs - b.startMs || b.confidence - a.confidence);
  const deduped = [];
  for (const m of moments) {
    const near = deduped.find((k) => Math.abs(k.startMs - m.startMs) < 1000 && k.kind === m.kind);
    if (!near) deduped.push(m);
  }

  // 按价值选，再按时间排序：避免「只截前 N 个章节边界」丢掉片尾强调句
  const scored = deduped.map((m) => {
    let value = m.confidence || 0;
    if (m.kind === 'emphasis') value += 1.0;
    else if (m.kind === 'long_utterance') value += 0.4;
    else if (m.kind === 'chapter_boundary') value += 0.2;
    return { m, value };
  });
  scored.sort((a, b) => b.value - a.value || a.m.startMs - b.m.startMs);

  // 时间分桶保底：开头 / 中段 / 结尾各至少留 1 条（若有）
  const maxT = Math.max(0, ...deduped.map((x) => x.startMs));
  const buckets = [
    deduped.filter((x) => x.startMs <= maxT / 3),
    deduped.filter((x) => x.startMs > maxT / 3 && x.startMs <= (2 * maxT) / 3),
    deduped.filter((x) => x.startMs > (2 * maxT) / 3),
  ];
  const picked = new Set();
  const out = [];
  const take = (item) => {
    if (!item || picked.has(item.momentId)) return;
    picked.add(item.momentId);
    out.push(item);
  };
  for (const bucket of buckets) {
    if (!bucket.length || out.length >= maxMoments) continue;
    const best = [...bucket].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    take(best);
  }
  for (const { m } of scored) {
    if (out.length >= maxMoments) break;
    take(m);
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/**
 * 把章节的 topicTags 用聚合结果回填（仅空标签时），不改写已有 summary。
 */
export function enrichChapterTags(chapters = [], topics = []) {
  if (!chapters.length || !topics.length) return chapters;
  return chapters.map((c) => {
    if ((c.topicTags || []).length) return c;
    const tags = topics
      .filter((t) => t.startMs <= c.endMs && t.endMs >= c.startMs)
      .slice(0, 5)
      .map((t) => t.tag);
    return tags.length ? { ...c, topicTags: tags } : c;
  });
}
