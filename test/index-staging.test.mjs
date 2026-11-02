import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexStore } from '../src/video-index/index-store.js';
import { createBuildingManifest } from '../src/video-index/schema.js';

function readyManifest(videoKey, indexVersion, clock) {
  const building = createBuildingManifest({
    videoKey,
    source: { kind: 'file', path: 'x.mp4' },
    indexVersion,
    clock,
  });
  return {
    ...building,
    status: 'ready',
    capabilities: { ...building.capabilities, metadata: 'ready' },
  };
}

test('staging 提交：失败不污染 live ready；成功后原子切换', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-stg-'));
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:stg:demo.mp4';
  const clock = () => '2026-01-01T00:00:00.000Z';

  store.commit(videoKey, {
    manifest: readyManifest(videoKey, 'v1', clock),
    metadata: { fingerprint: 'old', note: 'live-v1' },
    chapters: [{ chapterId: 'c-old', startMs: 0, endMs: 1, evidenceIds: [], eventIds: [], topicTags: [] }],
  });
  assert.equal(store.loadIndex(videoKey).metadata.note, 'live-v1');

  store.beginStaging(videoKey);
  store.writePart(videoKey, 'metadata.json', { fingerprint: 'new', note: 'staging-partial' });
  store.abortStaging(videoKey);
  assert.equal(store.loadIndex(videoKey).metadata.note, 'live-v1');
  assert.equal(store.exists(videoKey), true);

  store.beginStaging(videoKey);
  store.writeBinary(videoKey, 'evidence/frames/FRAME_x.png', Buffer.from('png'));
  store.commit(videoKey, {
    manifest: readyManifest(videoKey, 'v2', clock),
    metadata: { fingerprint: 'new', note: 'live-v2' },
    chapters: [{ chapterId: 'c-new', startMs: 0, endMs: 2, evidenceIds: [], eventIds: [], topicTags: [] }],
  });
  const idx = store.loadIndex(videoKey);
  assert.equal(idx.metadata.note, 'live-v2');
  assert.equal(idx.chapters[0].chapterId, 'c-new');
  assert.ok(existsSync(join(idx.dir, 'evidence', 'frames', 'FRAME_x.png')));
  assert.equal(store.stagingSize, 0);
});

test('并发 staging：B 不覆盖 A，写入不会落到 live', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-stg-conc-'));
  const store = createIndexStore({ rootDir: root });
  const keyA = 'file:stg:a.mp4';
  const keyB = 'file:stg:b.mp4';
  const clock = () => '2026-01-01T00:00:00.000Z';

  store.commit(keyA, {
    manifest: readyManifest(keyA, 'v1', clock),
    metadata: { fingerprint: 'a-live', note: 'A-LIVE' },
  });
  store.commit(keyB, {
    manifest: readyManifest(keyB, 'v1', clock),
    metadata: { fingerprint: 'b-live', note: 'B-LIVE' },
  });

  store.beginStaging(keyA);
  store.beginStaging(keyB);
  assert.equal(store.stagingSize, 2);
  store.writePart(keyA, 'metadata.json', { fingerprint: 'a-stg', note: 'CORRUPTED-LIVE' });
  store.writePart(keyB, 'metadata.json', { fingerprint: 'b-stg', note: 'B-STG' });

  assert.equal(store.loadIndex(keyA).metadata.note, 'A-LIVE');
  assert.equal(store.loadIndex(keyB).metadata.note, 'B-LIVE');
  assert.equal(store.readPart(keyA, 'metadata.json').note, 'CORRUPTED-LIVE');
  assert.equal(store.readPart(keyB, 'metadata.json').note, 'B-STG');

  store.abortStaging(keyB);
  assert.equal(store.stagingSize, 1);
  assert.equal(store.loadIndex(keyA).metadata.note, 'A-LIVE');
  store.abortStaging(keyA);
  assert.equal(store.loadIndex(keyA).metadata.note, 'A-LIVE');
});

test('publish 中断后 recover 从 trash 恢复 live', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-stg-rcv-'));
  const store = createIndexStore({ rootDir: root, recoverOnCreate: false });
  const videoKey = 'file:stg:rcv.mp4';
  const clock = () => '2026-01-01T00:00:00.000Z';
  store.commit(videoKey, {
    manifest: readyManifest(videoKey, 'v1', clock),
    metadata: { fingerprint: 'old', note: 'KEEP-ME' },
  });
  const live = store.videoDir(videoKey);
  const trash = join(root, `file=stg=rcv.mp4.__trash-${Date.now()}`);
  renameSync(live, trash);
  assert.equal(existsSync(join(live, 'manifest.json')), false);
  const store2 = createIndexStore({ rootDir: root, recoverOnCreate: true });
  assert.equal(store2.exists(videoKey), true);
  assert.equal(store2.loadIndex(videoKey).metadata.note, 'KEEP-ME');
});

test('list 忽略 .__staging 目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-stg2-'));
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:stg:keep.mp4';
  store.commit(videoKey, {
    manifest: readyManifest(videoKey, 'v1', () => '2026-01-01T00:00:00.000Z'),
    metadata: { fingerprint: 'fp' },
  });
  store.beginStaging('file:stg:other.mp4');
  const listed = store.list().map((x) => x.videoKey);
  assert.ok(listed.includes(videoKey));
  assert.equal(listed.includes('file:stg:other.mp4'), false);
  store.abortStaging('file:stg:other.mp4');
});
