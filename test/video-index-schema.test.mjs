import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest, validateEvidenceRef, validateStoryboardUnit, validateChapter,
  createBuildingManifest, DEFAULT_BUDGET,
} from '../src/video-index/schema.js';
import {
  videoKeyOf, frameIdOf, evidenceIdOf, contentHash, shortHash, SCHEMA_VERSION,
} from '../src/video-index/ids.js';

test('相同输入 ID 稳定，内容变化则不同', () => {
  const vk = videoKeyOf({ kind: 'file', path: 'D:/a/b.mp4' });
  assert.equal(vk, videoKeyOf({ kind: 'file', path: 'D:/a/b.mp4' }));
  const ch = contentHash('abc');
  const a = evidenceIdOf({ videoKey: vk, kind: 'subtitle', startMs: 0, endMs: 1000, contentHash: ch });
  const b = evidenceIdOf({ videoKey: vk, kind: 'subtitle', startMs: 0, endMs: 1000, contentHash: ch });
  assert.equal(a, b);
  const c = evidenceIdOf({
    videoKey: vk, kind: 'subtitle', startMs: 0, endMs: 1000, contentHash: contentHash('abd'),
  });
  assert.notEqual(a, c);
  const f1 = frameIdOf({ videoKey: vk, timestampMs: 100, roi: null, contentHash: ch });
  const f2 = frameIdOf({ videoKey: vk, timestampMs: 100, roi: null, contentHash: ch });
  assert.equal(f1, f2);
});

test('bilibili videoKey 规范化分 P', () => {
  const k = videoKeyOf({ kind: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD', partId: '2' });
  assert.match(k, /^bilibili:BV1xx411c7mD:p2$/i);
});

test('manifest / evidence / storyboard / chapter schema', () => {
  const m = createBuildingManifest({
    videoKey: 'file:abc:x.mp4',
    source: { kind: 'file', path: 'x.mp4' },
    indexVersion: 'v1',
    clock: () => '2026-01-01T00:00:00.000Z',
  });
  m.status = 'ready';
  m.capabilities.metadata = 'ready';
  assert.equal(validateManifest(m).schemaVersion, SCHEMA_VERSION);

  validateEvidenceRef({
    evidenceId: 'EVID_1',
    kind: 'subtitle',
    startMs: 0,
    endMs: 10,
    ref: 'evidence://file:abc:x.mp4/subtitle/EVID_1',
    sourceFile: 'detail/subtitles.json',
    contentHash: 'sha256:x',
    provenance: { adapter: 't', version: '1', generatedAt: '2026-01-01T00:00:00.000Z' },
  });

  assert.throws(() => validateEvidenceRef({
    evidenceId: 'EVID_1',
    kind: 'subtitle',
    startMs: 0,
    endMs: 10,
    ref: 'evidence://x/subtitle/1',
    sourceFile: '../secret',
    contentHash: 'sha256:x',
    provenance: { adapter: 't', version: '1', generatedAt: '2026-01-01T00:00:00.000Z' },
  }));

  validateStoryboardUnit({
    frameId: 'FRAME_1',
    timestampMs: 0,
    imageRef: 'evidence://v/frame/FRAME_1',
    sceneId: 'SCENE_1',
    sourceSize: { width: 1920, height: 1080 },
    storedSize: { width: 800, height: 450 },
    roi: { x: 0, y: 0, width: 1920, height: 1080 },
    transform: { scaleX: 0.4, scaleY: 0.4, offsetX: 0, offsetY: 0 },
    selectionReasons: ['scene_change'],
    evidenceIds: ['EVID_1'],
  });

  validateChapter({
    chapterId: 'CH_1',
    title: '',
    startMs: 0,
    endMs: 1000,
    summary: '',
    topicTags: [],
    eventIds: [],
    evidenceIds: ['EVID_1'],
    summaryMethod: 'subtitle-rules',
    confidence: 0.4,
  });

  assert.throws(() => validateChapter({
    chapterId: 'CH_1',
    title: 'x',
    startMs: 0,
    endMs: 1000,
    summary: 'TODO',
    topicTags: [],
    eventIds: [],
    evidenceIds: [],
  }));

  assert.ok(DEFAULT_BUDGET.maxTextTokens > 0);
  assert.equal(shortHash('a').length, 16);
});
