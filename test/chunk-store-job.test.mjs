import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChunkStore } from '../src/video-index/chunk-store.js';
import { createJobStore, LOCK_STALE_MS } from '../src/video-index/job-store.js';
import { createJobController } from '../src/video-index/job-controller.js';
import { planChunks } from '../src/video-index/chunk-plan.js';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { createVideoIndexTool } from '../src/video-index-tool.js';

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

function waitJob(engine, jobId, timeoutMs = 20_000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const st = engine.jobStatus(jobId);
      const state = st?.job?.state;
      if (['ready', 'degraded', 'failed', 'cancelled'].includes(state)) {
        resolve(st);
        return;
      }
      if (Date.now() - t0 > timeoutMs) reject(new Error(`timeout ${state}`));
      else setTimeout(tick, 40);
    };
    tick();
  });
}

test('chunk storyboard 落盘 PNG 且带 imageRef', async () => {
  const root = tmp();
  const media = join(root, 'clip.mp4');
  writeFileSync(media, Buffer.from('fake'));
  const frame = Buffer.alloc(320 * 180 * 3, 12);
  try {
    const engine = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        fileSource: {
          resolve: async () => ({
            videoKey: 'file:sbtest:clip.mp4',
            metadata: { durationMs: 15 * 60_000, path: media, title: 'clip.mp4' },
            mediaRef: { path: media },
            subtitles: [],
          }),
        },
        probeDuration: async () => 15 * 60_000,
        extractFrames: async () => [{ buf: frame, timestampMs: 1000, t: 1, width: 320, height: 180 }],
        extractAudio: async () => { throw new Error('no audio'); },
      },
    });
    const started = await engine.indexAdaptive({
      source: { kind: 'file', path: media },
      execution: 'background',
    });
    assert.equal(started.background, true);
    await waitJob(engine, started.jobId);
    const store = createChunkStore({ rootDir: root, videoKey: started.videoKey });
    const chunk = store.readChunk('000000');
    assert.ok(chunk.storyboard.length >= 1);
    for (const u of chunk.storyboard) {
      assert.ok(u.imageRef);
      assert.ok(u.evidenceIds?.length);
      const png = join(store.videoDir, 'evidence', 'frames', `${u.frameId}.png`);
      assert.equal(existsSync(png), true);
      assert.ok(readFileSync(png).length > 0);
    }
    assert.equal(chunk.manifest.capabilities.storyboard, 'ready');
    const tool = createVideoIndexTool({
      rootDir: root,
      engine,
      ctx: {
        attachments: {
          saveImage(img) { return { ok: true, bytes: img.data?.length || 0 }; },
        },
      },
    });
    const q = await tool.execute({
      action: 'query',
      videoKey: started.videoKey,
      question: '画面里是什么',
      mode: 'visual',
    });
    assert.ok((q.meta.visualEvidence || []).length >= 1);
    assert.ok((q.images || []).length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('抽帧失败时 storyboard 为 degraded 且不留半截 PNG', async () => {
  const root = tmp();
  const media = join(root, 'clip.mp4');
  writeFileSync(media, Buffer.from('fake'));
  try {
    const engine = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        extractFrames: async () => { throw new Error('ffmpeg missing'); },
        extractAudio: async () => null,
      },
    });
    const out = await engine.indexChunk({
      videoKey: 'file:sbfail:clip.mp4',
      chunk: { chunkId: '000000', startMs: 0, endMs: 5000, inputStartMs: 0, inputEndMs: 5000 },
      sourceMode: 'file',
      mediaPath: media,
      sourceDescriptor: { mediaPath: media },
    });
    assert.equal(out.capabilities.storyboard, 'degraded');
    const framesDir = join(engine.store.videoDir('file:sbfail:clip.mp4'), 'evidence', 'frames');
    if (existsSync(framesDir)) {
      assert.equal(readdirSync(framesDir).length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('旧 chunk 无图时视觉查询标记 storyboard_missing_images', async () => {
  const root = tmp();
  try {
    const videoKey = 'file:oldsb:clip.mp4';
    const store = createChunkStore({ rootDir: root, videoKey });
    store.commitChunk('000000', {
      chunkManifest: {
        chunkId: '000000', revision: 1, startMs: 0, endMs: 300_000, status: 'ready', sourceMode: 'file',
      },
      utterances: [],
      events: [],
      speakers: [],
      storyboard: [{ frameId: 'FRAME_old', timestampMs: 1000, chunkId: '000000' }],
      evidence: [],
      chapters: [],
    });
    store.rebuildCatalog();
    const engine = createVideoIndexEngine({ rootDir: root, adapters: {} });
    const q = engine.query({ videoKey, question: '画面里是什么', mode: 'visual' });
    assert.equal(q.visualEvidence?.length || 0, 0);
    assert.ok((q.reasons || []).includes('storyboard_missing_images'));
    const tool = createVideoIndexTool({ rootDir: root, engine });
    const out = await tool.execute({ action: 'query', videoKey, question: '画面', mode: 'visual' });
    assert.equal(out.meta.visualEvidence?.length || 0, 0);
    assert.ok(out.meta.reasons.includes('storyboard_missing_images'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
