import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexStore } from '../src/video-index/index-store.js';
import { createBuildingManifest } from '../src/video-index/schema.js';
import { createQueryCache, cacheKeyOf } from '../src/video-index/query-cache.js';
import { cleanupIndexes, purgeTempInDir } from '../src/video-index/index-cleanup.js';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';

function seedReady(store, videoKey, { updatedAt = '2026-01-01T00:00:00.000Z' } = {}) {
  const building = createBuildingManifest({
    videoKey,
    source: { kind: 'file', path: 'x.mp4' },
    indexVersion: 'v1',
    clock: () => updatedAt,
  });
  store.commit(videoKey, {
    manifest: {
      ...building,
      status: 'ready',
      updatedAt,
      capabilities: { ...building.capabilities, metadata: 'ready' },
    },
    metadata: { fingerprint: 'fp' },
  });
}

test('purgeTempInDir 清除 .tmp 与 .building.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-gc1-'));
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:gc:a.mp4';
  seedReady(store, videoKey);
  const dir = store.videoDir(videoKey);
  writeFileSync(join(dir, '.building.json'), '{}');
  writeFileSync(join(dir, '.tmp-leftover'), 'x');
  mkdirSync(join(dir, 'cache'), { recursive: true });
  writeFileSync(join(dir, 'cache', 'queries.json.tmp-1'), 'bad');
  const removed = purgeTempInDir(dir);
  assert.ok(removed.length >= 2);
  assert.equal(existsSync(join(dir, '.building.json')), false);
  assert.equal(existsSync(join(dir, 'manifest.json')), true);
});

test('cleanup 修剪过期查询缓存；maxAge 精确删索引', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-gc2-'));
  const store = createIndexStore({ rootDir: root });
  const oldKey = 'file:gc:old.mp4';
  const newKey = 'file:gc:new.mp4';
  seedReady(store, oldKey, { updatedAt: '2020-01-01T00:00:00.000Z' });
  seedReady(store, newKey, { updatedAt: '2026-01-01T00:00:00.000Z' });

  const cache = createQueryCache({ store });
  const key = cacheKeyOf({
    videoKey: newKey,
    indexVersion: 'v1',
    queryType: 'text_structure',
    question: '讲了什么',
    budget: {},
    relevantEvidenceIds: [],
  });
  cache.set(newKey, key, { ok: true }, { indexVersion: 'v1' });
  const cleanupNow = Date.parse('2026-06-01T00:00:00.000Z');
  // 人为把缓存时间改旧（相对 cleanup 的 now，不是机器当前时间）
  const data = store.readPart(newKey, 'cache/queries.json');
  data.entries[0].at = cleanupNow - 40 * 24 * 3600 * 1000;
  store.writePart(newKey, 'cache/queries.json', data);

  // 未确认时：只报告候选，不真删
  const dry = cleanupIndexes({
    store,
    ttlMs: 7 * 24 * 3600 * 1000,
    maxAgeMs: 365 * 24 * 3600 * 1000,
    now: cleanupNow,
  });
  assert.equal(dry.needsConfirmation, true);
  assert.equal(dry.dryRun, true);
  assert.ok(dry.indexesWouldRemove.includes(oldKey));
  assert.equal(store.exists(oldKey), true);
  assert.ok(dry.cachesPruned.some((c) => c.videoKey === newKey && c.wouldPrune >= 1));
  // 未确认 maxAge 时不得真正修剪缓存 / 删临时文件
  assert.equal(store.readPart(newKey, 'cache/queries.json').entries.length, 1);

  const r = cleanupIndexes({
    store,
    ttlMs: 7 * 24 * 3600 * 1000,
    maxAgeMs: 365 * 24 * 3600 * 1000,
    now: cleanupNow,
    confirmDelete: true,
    confirmVideoKeys: [oldKey],
  });
  assert.ok(r.indexesRemoved.includes(oldKey));
  assert.ok(!r.indexesRemoved.includes(newKey));
  assert.equal(store.exists(oldKey), false);
  assert.equal(store.exists(newKey), true);
});

test('dryRun 会枚举嵌套临时文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-gc-dry-'));
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:gc:dry.mp4';
  seedReady(store, videoKey);
  const nested = join(store.videoDir(videoKey), 'cache', '.tmp-nested');
  writeFileSync(nested, 'x');
  const r = cleanupIndexes({ store, dryRun: true });
  assert.ok(r.tempFilesRemoved.some((p) => p.includes('.tmp-nested')));
  assert.equal(existsSync(nested), true, 'dryRun 不删除');
});

test('engine.cleanup dryRun 不删', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-gc3-'));
  const engine = createVideoIndexEngine({
    rootDir: root,
    adapters: {
      extractFrames: async () => [],
      extractAudio: async () => ({ ok: true, path: null }),
    },
  });
  const path = join(root, 'v.mp4');
  writeFileSync(path, Buffer.from('x'));
  const indexed = await engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [
        { startMs: 0, endMs: 1000, text: '记忆架构系统设计记忆架构' },
        { startMs: 2000, endMs: 3000, text: '记忆架构继续' },
      ],
    },
  }, { skipStoryboard: true });
  const idx = engine.store.loadIndex(indexed.videoKey);
  assert.ok(idx.topics.length >= 1, '应写出 topics');
  assert.ok(Array.isArray(idx.keyMoments));

  const dry = engine.cleanup({ dryRun: true, maxAgeMs: 1 });
  assert.equal(dry.dryRun, true);
  assert.equal(engine.store.exists(indexed.videoKey), true);
});

test('confirmDelete 但 confirmVideoKeys 不匹配时完全不写盘', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-gc-badconfirm-'));
  const store = createIndexStore({ rootDir: root });
  const oldKey = 'file:gc:old2.mp4';
  const newKey = 'file:gc:new2.mp4';
  seedReady(store, oldKey, { updatedAt: '2020-01-01T00:00:00.000Z' });
  seedReady(store, newKey, { updatedAt: '2026-01-01T00:00:00.000Z' });

  const tmp = join(store.videoDir(newKey), '.tmp-keep');
  writeFileSync(tmp, 'x');
  const cache = createQueryCache({ store });
  const key = cacheKeyOf({
    videoKey: newKey,
    indexVersion: 'v1',
    queryType: 'text_structure',
    question: 'q',
    budget: {},
    relevantEvidenceIds: [],
  });
  cache.set(newKey, key, { ok: true }, { indexVersion: 'v1' });
  const cleanupNow = Date.parse('2026-06-01T00:00:00.000Z');
  const data = store.readPart(newKey, 'cache/queries.json');
  data.entries[0].at = cleanupNow - 40 * 24 * 3600 * 1000;
  store.writePart(newKey, 'cache/queries.json', data);

  const wrong = cleanupIndexes({
    store,
    ttlMs: 7 * 24 * 3600 * 1000,
    maxAgeMs: 365 * 24 * 3600 * 1000,
    now: cleanupNow,
    confirmDelete: true,
    confirmVideoKeys: ['file:gc:WRONG.mp4'],
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.dryRun, true);
  assert.equal(existsSync(tmp), true);
  assert.equal(store.readPart(newKey, 'cache/queries.json').entries.length, 1);
  assert.equal(store.exists(oldKey), true);
  assert.equal(store.exists(newKey), true);

  const missing = cleanupIndexes({
    store,
    ttlMs: 7 * 24 * 3600 * 1000,
    maxAgeMs: 365 * 24 * 3600 * 1000,
    now: cleanupNow,
    confirmDelete: true,
    confirmVideoKeys: [],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.dryRun, true);
  assert.equal(existsSync(tmp), true);
  assert.equal(store.exists(oldKey), true);

  const extra = cleanupIndexes({
    store,
    ttlMs: 7 * 24 * 3600 * 1000,
    maxAgeMs: 365 * 24 * 3600 * 1000,
    now: cleanupNow,
    confirmDelete: true,
    confirmVideoKeys: [oldKey, newKey],
  });
  assert.equal(extra.ok, false);
  assert.equal(extra.dryRun, true);
  assert.equal(store.exists(oldKey), true);

  const ok = cleanupIndexes({
    store,
    ttlMs: 7 * 24 * 3600 * 1000,
    maxAgeMs: 365 * 24 * 3600 * 1000,
    now: cleanupNow,
    confirmDelete: true,
    confirmVideoKeys: [oldKey],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.dryRun, false);
  assert.ok(ok.indexesRemoved.includes(oldKey));
  assert.equal(existsSync(tmp), false);
  assert.equal(store.exists(oldKey), false);
});

test('purgeTrash：默认保留；未确认只报告；确认后仅删有效 live 的旧 trash', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-gc-trash-'));
  const store = createIndexStore({ rootDir: root, recoverOnCreate: false });
  const liveKey = 'file:gc:live.mp4';
  const orphanKey = 'file:gc:orphan.mp4';
  seedReady(store, liveKey);

  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const oldTrash = join(root, 'file=gc=live.mp4.__trash-1');
  const youngTrash = join(root, `file=gc=live.mp4.__trash-${now - 1000}`);
  const orphanTrash = join(root, 'file=gc=orphan.mp4.__trash-1');
  const corruptKey = 'file:gc:corrupt.mp4';
  seedReady(store, corruptKey);
  const corruptTrash = join(root, 'file=gc=corrupt.mp4.__trash-1');

  mkdirSync(oldTrash, { recursive: true });
  writeFileSync(join(oldTrash, 'manifest.json'), '{"ok":true}');
  mkdirSync(youngTrash, { recursive: true });
  writeFileSync(join(youngTrash, 'manifest.json'), '{"ok":true}');
  mkdirSync(orphanTrash, { recursive: true });
  writeFileSync(join(orphanTrash, 'manifest.json'), '{"ok":true}');
  mkdirSync(corruptTrash, { recursive: true });
  writeFileSync(join(corruptTrash, 'manifest.json'), '{"ok":true}');
  // 破坏 live manifest
  writeFileSync(join(store.videoDir(corruptKey), 'manifest.json'), '{not-json');

  const def = cleanupIndexes({ store, now });
  assert.ok(def.trashPreserved.length >= 3);
  assert.equal(existsSync(oldTrash), true);

  const preview = cleanupIndexes({
    store,
    now,
    purgeTrash: true,
    trashMaxAgeMs: 7 * 24 * 3600 * 1000,
  });
  assert.equal(preview.dryRun, true);
  assert.ok(preview.trashWouldRemove.includes(oldTrash));
  assert.equal(existsSync(oldTrash), true);
  assert.equal(existsSync(youngTrash), true);
  assert.equal(existsSync(orphanTrash), true);

  const dry = cleanupIndexes({
    store,
    now,
    purgeTrash: true,
    trashMaxAgeMs: 7 * 24 * 3600 * 1000,
    confirmDelete: true,
    dryRun: true,
  });
  assert.equal(existsSync(oldTrash), true);
  assert.ok((dry.trashRemoved || []).length === 0);

  const gone = cleanupIndexes({
    store,
    now,
    purgeTrash: true,
    trashMaxAgeMs: 7 * 24 * 3600 * 1000,
    confirmDelete: true,
  });
  assert.ok(gone.trashRemoved.includes(oldTrash));
  assert.equal(existsSync(oldTrash), false);
  assert.equal(existsSync(youngTrash), true, '未达 trashMaxAgeMs 保留');
  assert.equal(existsSync(orphanTrash), true, '无 live 保留');
  assert.equal(existsSync(corruptTrash), true, 'live 损坏保留');
  assert.ok(gone.trashPreserved.includes(orphanTrash));
  assert.ok(gone.trashPreserved.includes(corruptTrash));
  // 报告与磁盘一致
  for (const p of gone.trashRemoved) assert.equal(existsSync(p), false);
  for (const p of gone.trashPreserved) assert.equal(existsSync(p), true);
});
