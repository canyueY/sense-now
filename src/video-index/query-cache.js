/**
 * query-cache.js — 检索结果缓存（不缓存最终自然语言答案）。
 */

import { createHash } from 'node:crypto';
import { writeJsonAtomic, readJson } from './atomic-json.js';
import { LAYOUT } from './index-store.js';

const RETRIEVAL_VERSION = '2';

export function budgetSignature(budget = {}) {
  const keys = Object.keys(budget).sort();
  return keys.map((k) => `${k}=${budget[k]}`).join('&');
}

export function normalizeQuestion(q) {
  return String(q || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function cacheKeyOf({
  videoKey,
  indexVersion,
  queryType,
  question,
  budget = {},
  relevantEvidenceIds = [],
  retrievalVersion = RETRIEVAL_VERSION,
  layoutVersion = null,
  chunkRevisionHash = null,
} = {}) {
  const payload = [
    videoKey,
    indexVersion,
    layoutVersion || '',
    chunkRevisionHash || '',
    queryType,
    normalizeQuestion(question),
    retrievalVersion,
    budgetSignature(budget),
    [...relevantEvidenceIds].map(String).sort().join(','),
  ].join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** 命中 chunkId+revision 集合的稳定 hash（新 chunk ready 后旧缓存自然失效）。 */
export function chunkSetHash(entries = []) {
  const parts = (entries || [])
    .map((e) => `${e.chunkId}:${e.revision || 1}`)
    .sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export function createQueryCache({ store, maxEntries = 200, ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
  function load(videoKey) {
    try {
      const data = store.readPart(videoKey, LAYOUT.cache.queries, { optional: true });
      if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
        return { entries: [] };
      }
      return data;
    } catch {
      return { entries: [] };
    }
  }

  function save(videoKey, data) {
    store.writePart(videoKey, LAYOUT.cache.queries, data);
  }

  function get(videoKey, key, { indexVersion } = {}) {
    const data = load(videoKey);
    const now = Date.now();
    const hit = data.entries.find((e) => e.key === key);
    if (!hit) return { hit: false, key };
    if (indexVersion && hit.indexVersion !== indexVersion) {
      return { hit: false, key, reason: 'indexVersion_mismatch' };
    }
    if (ttlMs > 0 && now - (hit.at || 0) > ttlMs) {
      return { hit: false, key, reason: 'ttl_expired' };
    }
    return { hit: true, key, value: hit.value, at: hit.at };
  }

  function set(videoKey, key, value, { indexVersion } = {}) {
    const data = load(videoKey);
    data.entries = data.entries.filter((e) => e.key !== key);
    data.entries.unshift({
      key,
      indexVersion,
      at: Date.now(),
      value,
    });
    if (data.entries.length > maxEntries) {
      data.entries = data.entries.slice(0, maxEntries);
    }
    try {
      save(videoKey, data);
    } catch {
      // 损坏/写失败不影响索引
    }
    return { hit: false, key, stored: true };
  }

  return { cacheKeyOf, get, set, load, RETRIEVAL_VERSION };
}

export { RETRIEVAL_VERSION };
