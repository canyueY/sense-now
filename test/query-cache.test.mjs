import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexStore } from '../src/video-index/index-store.js';
import { createBuildingManifest } from '../src/video-index/schema.js';
import { createQueryCache, cacheKeyOf } from '../src/video-index/query-cache.js';

function readyStore() {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-cache-'));
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:cache:demo.mp4';
  const building = createBuildingManifest({
    videoKey,
    source: { kind: 'file', path: 'demo.mp4' },
    indexVersion: 'v1',
    clock: () => '2026-01-01T00:00:00.000Z',
  });
  store.commit(videoKey, {
    manifest: {
      ...building,
      status: 'ready',
      capabilities: { ...building.capabilities, metadata: 'ready' },
    },
    metadata: { fingerprint: 'fp' },
  });
  return { store, videoKey };
}

test('相同键命中；indexVersion/budget/evidence 变化未命中', () => {
  const { store, videoKey } = readyStore();
  const cache = createQueryCache({ store });
  const base = {
    videoKey,
    indexVersion: 'v1',
    queryType: 'text_structure',
    question: '讲了什么',
    budget: { maxChapters: 3 },
    relevantEvidenceIds: ['e1', 'e2'],
  };
  const key = cacheKeyOf(base);
  cache.set(videoKey, key, { ok: true, sample: 1 }, { indexVersion: 'v1' });
  assert.equal(cache.get(videoKey, key, { indexVersion: 'v1' }).hit, true);
  assert.equal(cache.get(videoKey, key, { indexVersion: 'v2' }).hit, false);

  const key2 = cacheKeyOf({ ...base, budget: { maxChapters: 1 } });
  assert.notEqual(key, key2);
  assert.equal(cache.get(videoKey, key2, { indexVersion: 'v1' }).hit, false);

  const key3 = cacheKeyOf({ ...base, relevantEvidenceIds: ['e9'] });
  assert.notEqual(key, key3);
});

test('损坏缓存自动忽略', () => {
  const { store, videoKey } = readyStore();
  const cache = createQueryCache({ store });
  writeFileSync(join(store.videoDir(videoKey), 'cache', 'queries.json'), '{bad', 'utf8');
  const r = cache.get(videoKey, 'anything', { indexVersion: 'v1' });
  assert.equal(r.hit, false);
});
