import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexStore } from '../src/video-index/index-store.js';
import { createBuildingManifest } from '../src/video-index/schema.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'sense-now-idx-'));
}

test('原子提交：manifest 最后写；半成品不算有效索引', () => {
  const root = tmpRoot();
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:abc:demo.mp4';
  store.ensureLayout(videoKey);
  store.writePart(videoKey, 'metadata.json', { title: 'demo', fingerprint: 'fp1' });
  assert.equal(store.exists(videoKey), false, '无 manifest 不算存在');

  const building = createBuildingManifest({
    videoKey,
    source: { kind: 'file', path: 'demo.mp4' },
    indexVersion: 'v1',
    clock: () => '2026-01-01T00:00:00.000Z',
  });
  const manifest = {
    ...building,
    status: 'ready',
    capabilities: { ...building.capabilities, metadata: 'ready', subtitles: 'unavailable', storyboard: 'unavailable' },
  };
  store.commit(videoKey, {
    manifest,
    metadata: { title: 'demo', fingerprint: 'fp1' },
    chapters: [],
    utterances: [],
    events: [],
    subtitles: [],
    evidenceIndex: [],
    storyboardIndex: [],
  });
  assert.equal(store.exists(videoKey), true);
  assert.equal(store.readManifest(videoKey).status, 'ready');
});

test('路径穿越被拒绝；删除只作用于精确 videoKey', () => {
  const root = tmpRoot();
  const store = createIndexStore({ rootDir: root });
  assert.throws(() => store.videoDir('../escape'));
  assert.throws(() => store.videoDir('a/b'));
  assert.throws(() => store.videoDir('C:\\Windows'));

  const videoKey = 'file:abc:demo.mp4';
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
  const other = 'file:xyz:other.mp4';
  store.commit(other, {
    manifest: {
      ...createBuildingManifest({
        videoKey: other,
        source: { kind: 'file', path: 'other.mp4' },
        indexVersion: 'v1',
        clock: () => '2026-01-01T00:00:00.000Z',
      }),
      status: 'ready',
      capabilities: { metadata: 'ready', subtitles: 'unavailable', storyboard: 'unavailable', asr: 'unavailable', ocr: 'unavailable', diarization: 'unavailable', identityBinding: 'unavailable' },
    },
    metadata: { fingerprint: 'fp2' },
  });

  const r = store.remove(videoKey);
  assert.equal(r.removed, true);
  assert.equal(r.recoverable, false);
  assert.equal(store.exists(videoKey), false);
  assert.equal(store.exists(other), true);
});

test('损坏 JSON 与临时文件不破坏 list', () => {
  const root = tmpRoot();
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:bad:x.mp4';
  store.ensureLayout(videoKey);
  writeFileSync(join(store.videoDir(videoKey), 'manifest.json'), '{not-json', 'utf8');
  writeFileSync(join(root, '.tmp-leftover'), 'x');
  const listed = store.list();
  assert.ok(!listed.some((x) => x.videoKey === videoKey));
});

test('resolveEvidenceFile 拒绝越界路径', () => {
  const root = tmpRoot();
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:abc:demo.mp4';
  store.ensureLayout(videoKey);
  assert.throws(() => store.resolveEvidenceFile(videoKey, '../outside.png'));
  assert.throws(() => store.resolveEvidenceFile(videoKey, '/etc/passwd'));
});
