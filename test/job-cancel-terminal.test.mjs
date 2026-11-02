import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobController } from '../src/video-index/job-controller.js';
import { createChunkStore } from '../src/video-index/chunk-store.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'sense-now-cancel-'));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('C3: indexChunk 运行中 cancel → resolve 后零新 commit，终态 cancelled', async () => {
  const root = tmp();
  const gate = deferred();
  let commitsSeen = 0;
  const ctrl = createJobController({
    rootDir: root,
    indexChunk: async ({ chunk }) => {
      await gate.promise;
      return {
        utterances: [{ startMs: chunk.startMs + 1, endMs: chunk.startMs + 2, text: 'x', confidence: 1 }],
        events: [], speakers: [], storyboard: [], evidence: [], chapters: [],
      };
    },
  });
  // wrap commit to count
  const storeProto = createChunkStore({ rootDir: root, videoKey: 'file:c' });
  void storeProto;

  const started = await ctrl.startIndexJob({
    videoKey: 'file:c3',
    durationMs: 15 * 60_000,
    execution: 'background',
    chunkMs: 5 * 60_000,
    overlapMs: 0,
  });
  assert.equal(started.ok, true);

  // wait until indexing started
  await new Promise((r) => setTimeout(r, 30));
  const cancelled = ctrl.jobCancel(started.jobId);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.job.state, 'cancelled');

  gate.resolve();
  await new Promise((r) => setTimeout(r, 500));

  const st = ctrl.jobStatus(started.jobId);
  assert.equal(st.job.state, 'cancelled');
  const store = createChunkStore({ rootDir: root, videoKey: 'file:c3' });
  assert.equal(store.listReadyChunkIds().length, 0);

  // 幂等
  const again = ctrl.jobCancel(started.jobId);
  assert.equal(again.ok, true);
  assert.equal(again.job.state, 'cancelled');

  void commitsSeen;
  rmSync(root, { recursive: true, force: true });
});

test('C3: cancel 恰在 commit 前 → 零 commit', async () => {
  const root = tmp();
  let release;
  const hold = new Promise((r) => { release = r; });
  let phase = 'before';
  const ctrl = createJobController({
    rootDir: root,
    indexChunk: async ({ chunk }) => {
      phase = 'inside';
      await hold;
      phase = 'after';
      return {
        utterances: [{ startMs: chunk.startMs + 1, endMs: chunk.startMs + 2, text: 'y' }],
        events: [], speakers: [], storyboard: [], evidence: [], chapters: [],
      };
    },
  });
  const started = await ctrl.startIndexJob({
    videoKey: 'file:c3b',
    durationMs: 10 * 60_000,
    execution: 'background',
    chunkMs: 5 * 60_000,
    overlapMs: 0,
  });
  for (let i = 0; i < 50 && phase !== 'inside'; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  ctrl.jobCancel(started.jobId);
  release();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ctrl.jobStatus(started.jobId).job.state, 'cancelled');
  assert.equal(createChunkStore({ rootDir: root, videoKey: 'file:c3b' }).listReadyChunkIds().length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('C3: cancel 后 resume 用新 attempt；旧回调不污染', async () => {
  const root = tmp();
  const gates = [];
  const ctrl = createJobController({
    rootDir: root,
    indexChunk: async ({ chunk }) => {
      const g = deferred();
      gates.push(g);
      await g.promise;
      return {
        utterances: [{ startMs: chunk.startMs + 1, endMs: chunk.startMs + 2, text: `t-${chunk.chunkId}` }],
        events: [], speakers: [], storyboard: [], evidence: [], chapters: [],
      };
    },
  });
  const started = await ctrl.startIndexJob({
    videoKey: 'file:c3c',
    durationMs: 10 * 60_000,
    execution: 'background',
    chunkMs: 5 * 60_000,
    overlapMs: 0,
  });
  for (let i = 0; i < 50 && gates.length < 1; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  ctrl.jobCancel(started.jobId);
  // 旧 attempt resolve
  gates.forEach((g) => g.resolve());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ctrl.jobStatus(started.jobId).job.state, 'cancelled');

  const resumed = await ctrl.jobResume(started.jobId);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.attempt, 2);
  // 让新 attempt 完成
  for (let i = 0; i < 100; i += 1) {
    while (gates.length) gates.shift().resolve();
    const st = ctrl.jobStatus(started.jobId);
    if (['ready', 'degraded'].includes(st.job?.state)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const final = ctrl.jobStatus(started.jobId);
  assert.ok(['ready', 'degraded'].includes(final.job.state));
  assert.notEqual(final.job.state, 'cancelled');
  ctrl.jobCancel(started.jobId);
  await new Promise((r) => setTimeout(r, 50));
  rmSync(root, { recursive: true, force: true });
});
