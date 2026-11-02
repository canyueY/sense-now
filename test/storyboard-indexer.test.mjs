import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexStore } from '../src/video-index/index-store.js';
import { createStoryboardIndexer } from '../src/video-index/storyboard-indexer.js';
import { encodePng } from '../src/png.js';
import { createPipeline } from '../src/pipeline.js';
import { signalsFromKeep, shouldKeepFrame } from '../src/video-index/frame-gate.js';

test('frame-gate 信号映射', () => {
  assert.ok(signalsFromKeep({ via: 'cut' }).includes('scene_boundary'));
  assert.ok(signalsFromKeep({ via: 'mark', score: 10 }).includes('frame_difference'));
  assert.equal(shouldKeepFrame(['duplicate_rejected']), false);
  assert.equal(shouldKeepFrame(['scene_boundary']), true);
});

test('pipeline observer 留帧事件可被 storyboard indexer 消费', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-sb-'));
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'file:sb:demo.mp4';
  store.ensureLayout(videoKey);
  const indexer = createStoryboardIndexer({
    videoKey,
    indexVersion: 'v1',
    store,
    sourceSize: { width: 16, height: 16 },
    storedSize: { width: 16, height: 16 },
    clock: () => '2026-01-01T00:00:00.000Z',
  });

  const keeps = [];
  const pipe = createPipeline({
    width: 16,
    height: 16,
    fps: 4,
    queueDepth: 0,
    cutAbs: 1,
    silentFloorSec: 100,
    maxWaitSec: 100,
    onKeep: (ev) => keeps.push(ev),
  });

  // 两帧反差色块 → 切点
  const a = Buffer.alloc(16 * 16 * 3, 10);
  const b = Buffer.alloc(16 * 16 * 3, 240);
  pipe.push({ t: 0, buf: a });
  pipe.push({ t: 0.25, buf: b });
  pipe.push({ t: 0.5, buf: a });
  pipe.finish();
  assert.ok(keeps.length >= 1, 'observer 应收到 keep');

  for (const k of keeps) {
    const png = encodePng(
      k.via === 'cut' ? b : a,
      16,
      16,
      { level: 1 },
    );
    const { unit } = indexer.onKeep({ ...k, png, buf: a });
    assert.ok(unit.roi.width === 16);
    assert.ok(unit.transform.scaleX);
  }
  const r = indexer.result();
  assert.ok(r.storyboardUnits.length >= 1);
  assert.ok(r.evidence.length >= 1);
  assert.ok(r.evidence[0].ref.startsWith('evidence://'));
});
