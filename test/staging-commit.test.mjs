import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexStore } from '../src/video-index/index-store.js';
import { createBuildingManifest } from '../src/video-index/schema.js';

test('staging 提交：中途失败不污染 live ready；成功后原子切换', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-stg-'));
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:stg:demo.mp4';

  const building = createBuildingManifest({
    videoKey,
    source: { kind: 'file', path: 'demo.mp4' },
    indexVersion: 'v1',
    clock: () => '2026-01-01T00:00:00.000Z',
  });
  // 先有一份 ready live
  store.commit(videoKey, {
    manifest: {
      ...building,
      status: 'ready',
      capabilities: { ...building.capabilities, metadata: 'ready' },
    },
    metadata: { fingerprint: 'old', note: 'live-old' },
    chapters: [{ chapterId: 'old' }],
  });
  assert.equal(store.readPart(videoKey, 'metadata.json').note, 'live-old');

  store.beginStaging(videoKey);
  store.writePart(videoKey, 'metadata.json', { fingerprint: 'new', note: 'staging-new' });
  // 模拟崩溃：abort staging，live 应仍是旧数据
  store.abortStaging(videoKey);
  assert.equal(store.readPart(videoKey, 'metadata.json').note, 'live-old');
  assert.equal(store.exists(videoKey), true);

  // 完整 staging 提交
  store.beginStaging(videoKey);
  store.writeBinary(videoKey, 'evidence/frames/F1.png', Buffer.from('png'));
  const final = store.commit(videoKey, {
    manifest: {
      ...building,
      indexVersion: 'v2',
      status: 'ready',
      capabilities: { ...building.capabilities, metadata: 'ready', storyboard: 'ready' },
    },
    metadata: { fingerprint: 'new', note: 'live-new' },
    chapters: [{ chapterId: 'new' }],
    storyboardIndex: [{ frameId: 'F1' }],
  });
  assert.equal(final.indexVersion, 'v2');
  assert.equal(store.readPart(videoKey, 'metadata.json').note, 'live-new');
  assert.equal(store.readPart(videoKey, 'summary/chapters.json')[0].chapterId, 'new');
  assert.ok(existsSync(join(store.videoDir(videoKey), 'evidence', 'frames', 'F1.png')));
  // 不应残留 staging 目录
  const stagingPath = join(root, 'file=stg=demo.mp4.__staging');
  assert.equal(existsSync(stagingPath), false);
  void writeFileSync;
  void readFileSync;
});
