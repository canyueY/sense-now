/**
 * speaker-merge.js — provisional speaker ID 与可选 embedding 合并（默认关闭）。
 * embedding 永不进入 query/context/evidence package。
 */

import { writeJsonAtomic, readJson } from './atomic-json.js';
import { join } from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';

export function provisionalSpeakerId(chunkId, localId) {
  const c = String(chunkId || '000000');
  const s = String(localId || 'SPEAKER_00').replace(/[^\w.-]+/g, '_').slice(0, 64);
  return `C${c}_${s}`;
}

/**
 * 将 chunk-local speakers 映射为 provisional（无全局合并时）。
 */
export function mapChunkSpeakers(speakers = [], chunkId) {
  return (speakers || []).map((s) => {
    const local = s.speakerClusterId || s.speakerId;
    return {
      ...s,
      localSpeakerId: local,
      speakerClusterId: provisionalSpeakerId(chunkId, local),
      bindingState: s.bindingState || 'provisional',
    };
  });
}

export function remapUtteranceSpeakers(utterances = [], idMap = new Map()) {
  return (utterances || []).map((u) => {
    const local = u.speakerClusterId || u.speakerId;
    if (!local) return u;
    const mapped = idMap.get(local) || provisionalSpeakerId(u.chunkId || '000000', local);
    return { ...u, speakerClusterId: mapped, localSpeakerId: local };
  });
}

/**
 * 可选 embedding 合并。默认不持久化；仅写 private/ 且需显式允许。
 */
export function mergeSpeakersByEmbedding({
  clusters = [],
  threshold = 0.82,
  algorithmVersion = 'cosine-v1',
} = {}) {
  const mergeEvidence = [];
  const parents = new Map();
  const find = (x) => {
    while (parents.get(x) && parents.get(x) !== x) x = parents.get(x);
    return x;
  };
  for (const c of clusters) parents.set(c.id, c.id);

  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      const a = clusters[i];
      const b = clusters[j];
      if (!a.embedding || !b.embedding) continue;
      const sim = cosine(a.embedding, b.embedding);
      if (sim >= threshold) {
        const pa = find(a.id);
        const pb = find(b.id);
        if (pa !== pb) parents.set(pb, pa);
        mergeEvidence.push({
          left: a.id,
          right: b.id,
          similarity: sim,
          threshold,
          algorithmVersion,
          chunkIds: [...new Set([...(a.chunkIds || []), ...(b.chunkIds || [])])],
          status: sim >= threshold + 0.05 ? 'merged' : 'tentative',
        });
      }
    }
  }

  const idMap = new Map();
  for (const c of clusters) {
    idMap.set(c.id, find(c.id));
  }
  return { idMap, mergeEvidence };
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function writePrivateEmbeddings(videoDir, payload, { persistSpeakerEmbeddings = false } = {}) {
  if (!persistSpeakerEmbeddings) return { ok: false, reason: 'persist_disabled' };
  const dir = join(videoDir, 'private');
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'speaker-embeddings.json'), {
    note: 'private; never expose to model context',
    ...payload,
  });
  return { ok: true, path: 'private/speaker-embeddings.json' };
}

export function clearPrivateEmbeddings(videoDir) {
  const dir = join(videoDir, 'private');
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function readPrivateEmbeddings(videoDir) {
  return readJson(join(videoDir, 'private', 'speaker-embeddings.json'), { optional: true });
}

/** 发布不含向量的全局 speaker 映射（可进 query，不可含 embedding）。 */
export function writeSpeakerMap(videoDir, map) {
  mkdirSync(videoDir, { recursive: true });
  const safe = {
    ...map,
    speakers: Object.fromEntries(
      Object.entries(map.speakers || {}).map(([k, v]) => [k, {
        globalSpeakerId: v.globalSpeakerId,
        state: v.state,
        score: v.score,
        mergeEvidence: v.mergeEvidence || [],
      }]),
    ),
  };
  writeJsonAtomic(join(videoDir, 'speaker-map.json'), safe);
  return safe;
}

export function readSpeakerMap(videoDir) {
  return readJson(join(videoDir, 'speaker-map.json'), { optional: true });
}

/** 校验 runner 返回的 embedding 列表；拒绝 NaN/维度不一致/超大。 */
export function validateSpeakerEmbeddings(list, {
  maxSpeakers = 32,
  maxDim = 2048,
  minDim = 8,
  allowEmpty = true,
} = {}) {
  if (!Array.isArray(list)) {
    return { ok: false, reason: 'invalid_schema', detail: 'speakerEmbeddings must be array' };
  }
  if (list.length > maxSpeakers) {
    return { ok: false, reason: 'invalid_schema', detail: 'too many speakers' };
  }
  if (!list.length && !allowEmpty) {
    return { ok: false, reason: 'unavailable', detail: 'empty speakerEmbeddings' };
  }
  const out = [];
  let dim = null;
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      return { ok: false, reason: 'invalid_schema', detail: 'embedding item not object' };
    }
    const emb = item.embedding;
    if (!Array.isArray(emb)) {
      return { ok: false, reason: 'invalid_schema', detail: 'embedding must be array' };
    }
    if (emb.length < minDim || emb.length > maxDim) {
      return { ok: false, reason: 'invalid_schema', detail: 'embedding dimension out of range' };
    }
    if (dim == null) dim = emb.length;
    if (emb.length !== dim) {
      return { ok: false, reason: 'invalid_schema', detail: 'embedding dimension mismatch' };
    }
    const nums = [];
    for (const x of emb) {
      const n = Number(x);
      if (!Number.isFinite(n)) {
        return { ok: false, reason: 'invalid_schema', detail: 'embedding non-finite' };
      }
      nums.push(n);
    }
    out.push({
      localSpeakerId: String(item.localSpeakerId || item.speakerClusterId || '').slice(0, 64),
      embedding: nums,
      dimension: dim,
      segmentCount: Number(item.segmentCount) || 0,
      totalMs: Number(item.totalMs) || 0,
      modelId: item.modelId ? String(item.modelId).slice(0, 128) : null,
    });
  }
  return { ok: true, embeddings: out, dimension: dim };
}
