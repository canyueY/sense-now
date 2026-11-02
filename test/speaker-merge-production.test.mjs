import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobController } from '../src/video-index/job-controller.js';
import { validateSpeakerEmbeddings, readSpeakerMap } from '../src/video-index/speaker-merge.js';
import { createChunkStore } from '../src/video-index/chunk-store.js';

test('C2: validate embeddings 拒绝 NaN/维度不一致', () => {
  assert.equal(validateSpeakerEmbeddings([
    { localSpeakerId: 'S0', embedding: [1, 0, Number.NaN] },
  ]).ok, false);
  assert.equal(validateSpeakerEmbeddings([
    { localSpeakerId: 'S0', embedding: [1, 0] },
    { localSpeakerId: 'S1', embedding: [1, 0, 0] },
  ]).ok, false);
  assert.equal(validateSpeakerEmbeddings([
    { localSpeakerId: 'S0', embedding: Array(16).fill(0.1) },
  ]).ok, true);
});

test('C2: finalize 生产调用 merge 并发布 speaker-map；默认无 private/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-spk-'));
  try {
    const embA = Array(16).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    const embB = Array(16).fill(0).map((_, i) => (i === 0 ? 0.99 : 0.01));
    const ctrl = createJobController({
      rootDir: root,
      speakerMerge: { enabled: true, threshold: 0.78, persistEmbeddings: false },
      indexChunk: async ({ chunk }) => ({
        utterances: [{
          startMs: chunk.startMs + 10,
          endMs: chunk.startMs + 20,
          text: `hi ${chunk.chunkId}`,
          speakerClusterId: 'SPEAKER_00',
        }],
        events: [],
        speakers: [{ speakerClusterId: 'SPEAKER_00' }],
        storyboard: [],
        evidence: [],
        chapters: [],
        speakerEmbeddings: [{
          localSpeakerId: 'SPEAKER_00',
          embedding: chunk.chunkId === '000000' ? embA : embB,
        }],
      }),
    });
    const started = await ctrl.startIndexJob({
      videoKey: 'file:spk',
      durationMs: 10 * 60_000,
      execution: 'background',
      chunkMs: 5 * 60_000,
      overlapMs: 0,
      speakerMerge: { enabled: true, threshold: 0.78, persistEmbeddings: false },
    });
    for (let i = 0; i < 80; i += 1) {
      const st = ctrl.jobStatus(started.jobId);
      if (['ready', 'degraded', 'failed'].includes(st.job?.state)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const done = ctrl.jobStatus(started.jobId);
    assert.ok(['ready', 'degraded'].includes(done.job.state));
    const store = createChunkStore({ rootDir: root, videoKey: 'file:spk' });
    const map = readSpeakerMap(store.videoDir);
    assert.ok(map?.speakers);
    const values = Object.values(map.speakers);
    assert.ok(values.some((v) => v.globalSpeakerId?.startsWith('GSPK_')));
    assert.ok(!existsSync(join(store.videoDir, 'private')));
    // chunk JSON 不含 embedding 向量
    const chunk = store.readChunk('000000');
    const raw = JSON.stringify(chunk);
    assert.ok(!raw.includes('"embedding"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
