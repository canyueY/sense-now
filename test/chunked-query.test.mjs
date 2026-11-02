import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { createChunkStore } from '../src/video-index/chunk-store.js';
import { writeSpeakerMap } from '../src/video-index/speaker-merge.js';
import { resolveVideoDir } from '../src/video-index/paths.js';

test('chunked index：list/status 可见，query 带回 speakers/timeRanges', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-chunked-query-'));
  try {
    const videoKey = 'bilibili:BV1test:p1';
    const store = createChunkStore({ rootDir: root, videoKey });
    for (const [chunkId, start] of [['000000', 0], ['000001', 300_000]]) {
      store.commitChunk(chunkId, {
        chunkManifest: {
          chunkId,
          revision: 1,
          startMs: start,
          endMs: start + 300_000,
          status: 'ready',
          sourceMode: 'url',
          timeSource: 'stream',
        },
        utterances: [],
        events: [],
        speakers: [{
          speakerClusterId: `C${chunkId}_SPEAKER_00`,
          totalMs: 1000,
          segmentCount: 1,
          timeRanges: [{ startMs: start + 10, endMs: start + 1010 }],
        }],
        storyboard: [],
        evidence: [],
        chapters: [],
      });
    }
    store.rebuildCatalog();

    const engine = createVideoIndexEngine({ rootDir: root, adapters: {} });
    const list = engine.list();
    assert.ok(list.some((x) => x.videoKey === videoKey), 'chunked index visible in list');

    const status = engine.status(videoKey);
    assert.equal(status.ok, true);
    assert.equal(status.counts.chunks, 2);

    const q = engine.query({ videoKey, question: '谁在说话' });
    assert.equal(q.ok, true);
    assert.equal(q.queryType, 'multimodal');
    assert.ok(q.context.speakers.length >= 2);
    assert.ok(q.context.speakers.every((s) => Array.isArray(s.timeRanges)));
    assert.ok(q.context.speakers.some((s) => s.timeRanges.length === 1));
    assert.deepEqual(q.chunksLoaded, ['000000', '000001']);

    // 跨块合并结果（speaker-map.json）必须应用到 query，而不是只写盘
    writeSpeakerMap(resolveVideoDir(root, videoKey), {
      layoutVersion: 'chunk-v1',
      speakers: {
        'C000000_SPEAKER_00': { globalSpeakerId: 'GSPK_0001', state: 'confirmed' },
        'C000001_SPEAKER_00': { globalSpeakerId: 'GSPK_0001', state: 'confirmed' },
      },
    });
    const merged = engine.query({ videoKey, question: '合并后谁在说话' });
    const global = merged.context.speakers.filter((s) => s.speakerClusterId === 'GSPK_0001');
    assert.equal(global.length, 1);
    assert.equal(global[0].timeRanges.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
