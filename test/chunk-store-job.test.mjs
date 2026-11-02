import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChunkStore } from '../src/video-index/chunk-store.js';
import { createJobStore, LOCK_STALE_MS } from '../src/video-index/job-store.js';
import { createJobController } from '../src/video-index/job-controller.js';
import { planChunks } from '../src/video-index/chunk-plan.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'sense-now-chunk-'));
}

test('chunk 原子提交：manifest 最后；reader 不见半写', () => {
  const root = tmp();
  try {
    const store = createChunkStore({ rootDir: root, videoKey: 'file:demo' });
    const staging = store.beginChunk('000000');
    writeFileSync(join(staging, 'utterances.json'), '[]');
    // 无 manifest → read 不可见
    assert.equal(store.readChunk('000000', { optional: true }), null);
    store.abortChunk('000000');

    store.commitChunk('000000', {
      chunkManifest: {
        chunkId: '000000',
        revision: 1,
        startMs: 0,
        endMs: 1000,
        status: 'ready',
        sourceMode: 'file',
        timeSource: 'stream',
      },
      utterances: [{ startMs: 0, endMs: 500, text: 'hi' }],
      events: [],
      speakers: [],
      storyboard: [],
      evidence: [],
      chapters: [],
    });
    const c = store.readChunk('000000');
    assert.equal(c.utterances.length, 1);
    const cat = store.rebuildCatalog();
    assert.equal(cat.length, 1);
    assert.equal(cat[0].firstUtteranceExcerpt, 'hi');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('job 排他锁 + stale heartbeat 回收', () => {
  const root = tmp();
  let now = 1_000_000;
  try {
    const jobs = createJobStore({ rootDir: root, clock: () => now });
    const a = jobs.acquireLock('vk1', { jobId: 'job_a' });
    assert.equal(a.ok, true);
    const b = jobs.acquireLock('vk1', { jobId: 'job_b' });
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'locked');

    // 伪造过期锁文件（不同 pid）
    jobs.releaseLock('vk1');
    const again = jobs.acquireLock('vk1', { jobId: 'job_c' });
    assert.equal(again.ok, true);
    const path = again.path;
    writeFileSync(path, JSON.stringify({
      pid: 999999,
      processStartTime: 1,
      nonce: 'x',
      heartbeatAt: now - LOCK_STALE_MS - 1,
      jobId: 'old',
      videoKey: 'vk1',
    }));
    now += LOCK_STALE_MS + 10;
    const d = jobs.acquireLock('vk1', { jobId: 'job_d' });
    assert.equal(d.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('后台 job 立即返回 jobId；resume 跳过 ready；capture resume 产生 gap', async () => {
  const root = tmp();
  let calls = 0;
  const ctrl = createJobController({
    rootDir: root,
    indexChunk: async ({ chunk }) => {
      calls += 1;
      return {
        utterances: [{
          startMs: chunk.startMs + 10,
          endMs: chunk.startMs + 20,
          text: `t-${chunk.chunkId}`,
          confidence: 1,
        }],
        events: [],
        speakers: [{ speakerClusterId: 'SPEAKER_00' }],
        storyboard: [],
        evidence: [],
        chapters: [],
        degraded: false,
        capabilities: { asr: 'ready' },
        byteUsage: { downloaded: 0, temporaryPeak: 0 },
        timeSource: 'stream',
      };
    },
  });

  async function waitTerminal(jobId, { allowIndexing = false } = {}) {
    for (let i = 0; i < 100; i += 1) {
      const st = ctrl.jobStatus(jobId);
      const state = st.job?.state;
      if (['ready', 'degraded', 'failed', 'cancelled'].includes(state)) {
        if (allowIndexing || st.job?.stage !== 'indexing') return st;
        if (state !== 'indexing' && state !== 'planning' && state !== 'finalizing') return st;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    return ctrl.jobStatus(jobId);
  }

  try {
    const started = await ctrl.startIndexJob({
      videoKey: 'file:long',
      durationMs: 12 * 60_000, // > sync safe → background
      sourceMode: 'file',
      execution: 'background',
      chunkMs: 5 * 60_000,
      overlapMs: 0,
    });
    assert.equal(started.ok, true);
    assert.equal(started.background, true);
    assert.ok(started.jobId);

    const done = await waitTerminal(started.jobId);
    assert.ok(['ready', 'degraded'].includes(done.job.state), `state=${done.job?.state}`);
    const firstCalls = calls;

    // resume：ready 块应跳过
    const resumed = await ctrl.jobResume(started.jobId);
    assert.equal(resumed.ok, true);
    const after = await waitTerminal(started.jobId);
    assert.ok(['ready', 'degraded'].includes(after.job.state));
    assert.ok(calls <= firstCalls + 1); // 几乎不重跑

    // capture resume → gap
    const capJob = ctrl.jobs.createJob({
      videoKey: 'cap:1',
      sourceMode: 'capture',
      state: 'recoverable',
      plan: { chunks: planChunks({ durationMs: 60_000 }) },
    });
    const cap = await ctrl.jobResume(capJob.jobId);
    assert.equal(cap.captureRestartRequired, true);
    assert.ok(cap.gaps?.length >= 1);
  } finally {
    for (const j of ctrl.jobs.listJobs()) {
      try { ctrl.jobCancel(j.jobId); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 50));
    rmSync(root, { recursive: true, force: true });
  }
});

test('同 videoKey 并发拒绝；不同 key 隔离', async () => {
  const root = tmp();
  try {
    const ctrl = createJobController({
      rootDir: root,
      indexChunk: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return {
          utterances: [], events: [], speakers: [], storyboard: [],
          evidence: [], chapters: [], capabilities: {},
        };
      },
    });
    const a = await ctrl.startIndexJob({
      videoKey: 'same',
      durationMs: 20 * 60_000,
      execution: 'background',
      chunkMs: 5 * 60_000,
    });
    assert.equal(a.ok, true);
    const b = await ctrl.startIndexJob({
      videoKey: 'same',
      durationMs: 20 * 60_000,
      execution: 'background',
      chunkMs: 5 * 60_000,
    });
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'locked');

    const c = await ctrl.startIndexJob({
      videoKey: 'other',
      durationMs: 20 * 60_000,
      execution: 'background',
      chunkMs: 5 * 60_000,
    });
    assert.equal(c.ok, true);
    assert.notEqual(c.jobId, a.jobId);

    await ctrl.jobCancel(a.jobId);
    await ctrl.jobCancel(c.jobId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
