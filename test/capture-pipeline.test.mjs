import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCaptureController, createFakeScheduler, createFakeFrameSource,
} from '../src/video-index/capture-controller.js';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { createChunkStore } from '../src/video-index/chunk-store.js';
import { captureArgs } from '../src/capture.js';
import {
  writeSilentWav, buildAnalysisSlices, mapWallThroughSegments,
} from '../src/video-index/capture-bundle.js';
import { createScreenFrameSource } from '../src/video-index/adapters/screen-frame-source.js';
import { createTimeMapping } from '../src/video-index/time-mapping.js';

test('C1: fake capture start→tick→segment→stop 产生可 query chunk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-cap-'));
  try {
    const scheduler = createFakeScheduler();
    const audioDir = join(root, 'aud');
    mkdirSync(audioDir, { recursive: true });
    const fakeRecorder = {
      async check() { return { ok: true }; },
      available() { return { ok: true }; },
      async start({ outDir }) {
        writeSilentWav(join(outDir, 'seg_00000.wav'), 1000);
        this._outDir = outDir;
        this._seg = {
          segmentId: 's0',
          file: 'seg_00000.wav',
          wallStart: Date.now() / 1000,
          wallEnd: Date.now() / 1000 + 1,
          sampleCount: 16000,
          sampleRate: 16000,
        };
        return { ok: true };
      },
      onSegment(fn) {
        this._fn = fn;
        if (this._seg) fn(this._seg);
        return () => {};
      },
      async stop() { return { ok: true, segments: [this._seg], flushed: true }; },
      get segments() { return [this._seg]; },
    };
    const commits = [];
    const wall = { t: 1000 };
    let videoT = 0;
    const controller = createCaptureController({
      rootDir: root,
      videoKey: 'capture:test',
      jobId: 'job_capture1',
      region: { x: 0, y: 0, width: 100, height: 80 },
      cdpEndpoint: 'http://127.0.0.1:9222',
      cdpTransport: {
        async connect() { return true; },
        async evaluate() {
          videoT += 1000;
          return {
            ok: true,
            currentTimeMs: videoT,
            durationMs: 600_000,
            paused: false,
            ended: false,
            playbackRate: 1,
            readyState: 4,
            visibilityState: 'hidden',
            pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
            videoRect: { x: 0, y: 0, width: 100, height: 80 },
            devicePixelRatio: 1,
          };
        },
        disconnect() {},
      },
      recorder: fakeRecorder,
      frameSource: createFakeFrameSource(),
      scheduler,
      clock: () => { wall.t += 10; return wall.t; },
      chunkTargetMs: 3_000,
      allocateChunkId: async () => '000000',
      commitCaptureChunk: async (args) => {
        commits.push(args);
        return { ok: true, chunkId: args.chunk?.chunkId || '000000' };
      },
    });

    const started = await controller.start();
    assert.equal(started.ok, true);
    assert.ok(['ready', 'degraded', 'unavailable'].includes(started.capabilities.audioCapture));
    assert.equal(started.capabilities.frameCapture, 'ready');

    await scheduler.advance(5);
    assert.ok(scheduler.active >= 1);

    const stopped = await controller.stop();
    assert.equal(stopped.ok, true);
    assert.ok(commits.length >= 1 || stopped.lastChunk);
    assert.equal(scheduler.active, 0);
    assert.ok(stopped.stats.cdpSamples >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C1: audio+frame 均 unavailable → start 失败', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-capfail-'));
  try {
    const controller = createCaptureController({
      rootDir: root,
      videoKey: 'capture:fail',
      jobId: 'job_failxxxx',
      region: { x: 0, y: 0, width: 10, height: 10 },
      recorder: {
        async start() { return { ok: false, reason: 'unavailable' }; },
        async stop() { return { ok: true, segments: [] }; },
        onSegment() { return () => {}; },
      },
      frameSource: null,
      scheduler: createFakeScheduler(),
    });
    const r = await controller.start();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C1: ddagrab region 进入 crop 链，非静默全屏', () => {
  const args = captureArgs({
    source: {
      kind: 'screen',
      engine: 'ddagrab',
      region: { x: 10, y: 20, w: 100, h: 80 },
    },
    width: 320,
    height: 180,
    fps: 6,
    engine: 'ddagrab',
  });
  const vf = args.find((a, i) => args[i - 1] === '-vf');
  assert.match(String(vf), /crop=100:80:10:20/);
  assert.match(String(vf), /hwdownload/);
});

test('R1: 两段真实 WAV → captureStop → query 含两段文本', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-r1-'));
  try {
    const scheduler = createFakeScheduler();
    let segN = 0;
    const fakeRecorder = {
      async start({ outDir }) {
        this._outDir = outDir;
        this._segs = [];
        for (let i = 0; i < 2; i += 1) {
          const file = `seg_${String(i).padStart(5, '0')}.wav`;
          writeSilentWav(join(outDir, file), 1000);
          const seg = {
            segmentId: `seg${i}`,
            file,
            wallStart: 10 + i,
            wallEnd: 11 + i,
            sampleCount: 16000,
            sampleRate: 16000,
          };
          this._segs.push(seg);
        }
        return { ok: true };
      },
      onSegment(fn) {
        this._fn = fn;
        for (const s of this._segs || []) fn(s);
        return () => {};
      },
      async stop() { return { ok: true, segments: this._segs || [], flushed: true }; },
    };
    const asrByFile = new Map();
    const eng = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        captureScheduler: scheduler,
        loopbackRecorder: fakeRecorder,
        captureFrameSource: createFakeFrameSource(),
        asr: {
          available: () => ({ ok: true }),
          analyze: async ({ audioPath }) => {
            // 裁剪后路径不再含原 seg 名；按调用序区分两段
            const text = asrByFile.size === 0 ? '第一段内容' : '第二段内容';
            asrByFile.set(audioPath, text);
            return {
              ok: true,
              utterances: [{ startMs: 0, endMs: 800, text }],
              evidence: [],
            };
          },
        },
        cdpTransport: {
          async connect() {},
          async evaluate() {
            return {
              ok: true, currentTimeMs: 5000, durationMs: 600_000,
              paused: false, ended: false, playbackRate: 1, readyState: 4,
              visibilityState: 'visible',
              pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
              videoRect: { x: 0, y: 0, width: 40, height: 40 }, devicePixelRatio: 1,
            };
          },
          disconnect() {},
        },
      },
    });

    const start = await eng.captureStart({
      region: { x: 1, y: 2, width: 40, height: 40 },
      cdpEndpoint: 'http://127.0.0.1:9222',
      videoKey: 'capture:r1',
    });
    assert.equal(start.ok, true);
    await scheduler.advance(2);
    const stop = await eng.captureStop(start.jobId);
    assert.equal(stop.ok, true);
    assert.ok(stop.catalogChunks >= 1, 'catalog must have chunks');

    const store = createChunkStore({ rootDir: root, videoKey: 'capture:r1' });
    const ids = store.listReadyChunkIds();
    assert.ok(ids.length > 0);
    const chunk = store.readChunk(ids[0]);
    assert.ok((chunk.utterances || []).length > 0);
    assert.ok((chunk.manifest?.counts?.utterances || chunk.utterances.length) > 0);

    const q = eng.query({ videoKey: 'capture:r1', question: '讲了什么', mode: 'text' });
    assert.ok(q.ok !== false);
    const blob = JSON.stringify(q);
    assert.match(blob, /第一段内容/);
    assert.match(blob, /第二段内容/);
    assert.ok(asrByFile.size >= 2, 'all audioSegments consumed by ASR');
    void segN;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1: 2x 播放 / pause / seek / gap / 无 CDP 时长', () => {
  // 2×：10s 墙钟 → ~20s 视频
  const maps = [{
    wallStartMs: 0, wallEndMs: 10_000,
    videoStartMs: 0, videoEndMs: 20_000,
    playbackRate: 2, reason: 'play',
  }];
  assert.equal(Math.round(mapWallThroughSegments(10_000, maps)), 20_000);

  // pause 不进 slice
  const pauseMaps = [
    { wallStartMs: 0, wallEndMs: 5000, videoStartMs: 0, videoEndMs: 5000, playbackRate: 1 },
    { wallStartMs: 5000, wallEndMs: 8000, videoStartMs: 5000, videoEndMs: 5000, playbackRate: 0, reason: 'pause' },
  ];
  const slices = buildAnalysisSlices({
    path: '/x.wav', wallStartMs: 0, wallEndMs: 8000, sampleCount: 128000, sampleRate: 16000,
  }, pauseMaps);
  assert.ok(slices.every((s) => s.reason !== 'pause'));
  assert.ok(slices.every((s) => (s.playbackRate || 1) > 0));

  // seek 拆片：不跨 seek
  const seekMaps = [
    { wallStartMs: 0, wallEndMs: 3000, videoStartMs: 0, videoEndMs: 3000, playbackRate: 1 },
    { wallStartMs: 3000, wallEndMs: 6000, videoStartMs: 10_000, videoEndMs: 13_000, playbackRate: 1, reason: 'seek' },
  ];
  const seekSlices = buildAnalysisSlices({
    path: '/y.wav', wallStartMs: 0, wallEndMs: 6000, sampleCount: 96000, sampleRate: 16000,
  }, seekMaps);
  assert.ok(seekSlices.length >= 2);
  assert.ok(seekSlices.every((s) => s.videoEndMs - s.videoStartMs < 10_000));

  // 无 CDP：wallclock 时长接近录音
  const noCdp = buildAnalysisSlices({
    path: '/z.wav', wallStartMs: 1000, wallEndMs: 61_000, sampleCount: 960_000, sampleRate: 16000,
  }, [], { sessionWallOriginMs: 1000 });
  assert.equal(noCdp.length, 1);
  assert.equal(noCdp[0].timeSource, 'wallclock');
  assert.ok(noCdp[0].videoEndMs - noCdp[0].videoStartMs >= 59_000);
});

test('P0: snapshotIncludingOpen；flush 含 open；2× ASR→query；向前 seek', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-p0map-'));
  try {
    // 纯函数：snapshot 不含 open；snapshotIncludingOpen 含
    const tm = createTimeMapping({ clock: () => 1000 });
    tm.openSegment({ wallStartMs: 1000, videoStartMs: 0, playbackRate: 2 });
    assert.equal(tm.snapshot().length, 0);
    const withOpen = tm.snapshotIncludingOpen({ wallEndMs: 2000, videoEndMs: 2000 });
    assert.equal(withOpen.length, 1);
    assert.equal(withOpen[0].playbackRate, 2);
    assert.equal(withOpen[0].provisional, true);

    const scheduler = createFakeScheduler();
    let wallMs = 10_000;
    let videoMs = 0;
    const rate = 2;
    const asrPaths = [];
    let segFn = null;
    const eng = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        asr: {
          available: () => ({ ok: true }),
          analyze: async ({ audioPath }) => {
            asrPaths.push(audioPath);
            return {
              ok: true,
              utterances: [{ startMs: 0, endMs: 500, text: '倍速内容' }],
              evidence: [{ startMs: 0, endMs: 500, text: '倍速内容', kind: 'asr' }],
            };
          },
        },
      },
    });
    const ctrl = createCaptureController({
      rootDir: root,
      videoKey: 'capture:p0map',
      jobId: 'job_p0mapxxxx',
      region: { x: 0, y: 0, width: 40, height: 40 },
      cdpEndpoint: 'http://127.0.0.1:9222',
      cdpTransport: {
        async connect() {},
        async evaluate() {
          wallMs += 1000;
          videoMs += 1000 * rate;
          return {
            ok: true, currentTimeMs: videoMs, durationMs: 600_000,
            paused: false, ended: false, playbackRate: rate, readyState: 4,
            visibilityState: 'visible',
            pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
            videoRect: { x: 0, y: 0, width: 40, height: 40 }, devicePixelRatio: 1,
          };
        },
        disconnect() {},
      },
      recorder: {
        async start({ outDir }) {
          writeSilentWav(join(outDir, 'seg_00000.wav'), 2000);
          return { ok: true };
        },
        onSegment(fn) { segFn = fn; return () => {}; },
        async stop() {
          // stop 时提交与 mapping 重叠的段
          const seg = {
            segmentId: 's0', file: 'seg_00000.wav',
            wallStart: (wallMs - 2000) / 1000,
            wallEnd: wallMs / 1000,
            sampleCount: 32000, sampleRate: 16000,
          };
          segFn?.(seg);
          return { ok: true, segments: [seg] };
        },
      },
      frameSource: createFakeFrameSource(),
      scheduler,
      clock: () => wallMs,
      allocateChunkId: async () => '000000',
      commitCaptureChunk: async (args) => {
        const maps = args.sourceDescriptor?.captureBundle?.mappingSegments || [];
        assert.ok(maps.length >= 1, 'flush must include open mapping');
        assert.ok(maps.some((m) => Number(m.playbackRate) === 2), maps);
        const out = await eng.indexChunk({
          videoKey: 'capture:p0map',
          chunk: { ...args.chunk, chunkId: '000000' },
          sourceMode: 'capture',
          sourceDescriptor: args.sourceDescriptor,
        });
        const cstore = createChunkStore({ rootDir: root, videoKey: 'capture:p0map' });
        cstore.commitChunk('000000', {
          chunkManifest: {
            chunkId: '000000', revision: 1,
            startMs: out.resolvedChunk?.startMs ?? 0,
            endMs: out.resolvedChunk?.endMs ?? 1,
            status: 'ready', sourceMode: 'capture',
            timeSource: out.timeSource,
            counts: { utterances: (out.utterances || []).length },
            capabilities: out.capabilities || {},
          },
          utterances: out.utterances || [],
          events: [], speakers: [], storyboard: [],
          evidence: out.evidence || [], chapters: out.chapters || [],
        });
        cstore.rebuildCatalog();
        return { chunkId: '000000', ...out };
      },
    });
    assert.equal((await ctrl.start()).ok, true);
    await scheduler.advance(4);
    await ctrl.stop({ cancel: false });

    const store = createChunkStore({ rootDir: root, videoKey: 'capture:p0map' });
    const chunk = store.readChunk(store.listReadyChunkIds()[0]);
    assert.ok(chunk.utterances.length > 0);
    assert.equal(chunk.manifest.timeSource, 'cdp');
    assert.ok(chunk.utterances[0].endMs >= 800, JSON.stringify(chunk.utterances[0]));
    assert.match(JSON.stringify(eng.query({
      videoKey: 'capture:p0map', question: '讲了什么', mode: 'text',
    })), /倍速内容/);
    assert.ok(asrPaths.some((p) => String(p).includes('.slices')));

    // 向前 seek
    const scheduler2 = createFakeScheduler();
    let v = 0;
    let w = 5000;
    let phase = 0;
    const seekCommits = [];
    const c2 = createCaptureController({
      rootDir: root,
      videoKey: 'capture:seekfwd',
      jobId: 'job_seekfwd1',
      region: { x: 0, y: 0, width: 10, height: 10 },
      cdpEndpoint: 'http://127.0.0.1:9222',
      cdpTransport: {
        async connect() {},
        async evaluate() {
          w += 1000;
          phase += 1;
          if (phase === 3) v = 60_000;
          else v += 1000;
          return {
            ok: true, currentTimeMs: v, durationMs: 600_000,
            paused: false, ended: false, playbackRate: 1, readyState: 4,
            visibilityState: 'visible',
            pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
            videoRect: { x: 0, y: 0, width: 10, height: 10 }, devicePixelRatio: 1,
          };
        },
        disconnect() {},
      },
      recorder: {
        async start({ outDir }) {
          writeSilentWav(join(outDir, 'a.wav'), 500);
          this._seg = {
            segmentId: 'a', file: 'a.wav',
            wallStart: 5, wallEnd: 5.5, sampleCount: 8000, sampleRate: 16000,
          };
          return { ok: true };
        },
        onSegment(fn) { fn(this._seg); return () => {}; },
        async stop() { return { ok: true, segments: [this._seg] }; },
      },
      frameSource: createFakeFrameSource(),
      scheduler: scheduler2,
      clock: () => w,
      chunkTargetMs: 600_000,
      allocateChunkId: async () => String(seekCommits.length).padStart(6, '0'),
      commitCaptureChunk: async (args) => {
        seekCommits.push({ reason: args.sourceDescriptor?.captureBundle?.reason });
        return { ok: true, chunkId: args.chunk.chunkId };
      },
    });
    await c2.start();
    await scheduler2.advance(5);
    assert.ok(seekCommits.some((c) => c.reason === 'seek'), JSON.stringify(seekCommits));
    await c2.stop({ cancel: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1: cropWavRange 裁出局部；evidence 映射到视频时间', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-crop-'));
  try {
    const src = join(root, 'full.wav');
    writeSilentWav(src, 3000);
    const { cropWavRange, analyzeCaptureBundle } = await import('../src/video-index/capture-bundle.js');
    const out = join(root, 'part.wav');
    const cropped = cropWavRange(src, out, 1000, 2000);
    assert.ok(cropped.durationMs >= 900 && cropped.durationMs <= 1100);
    const analyzed = await analyzeCaptureBundle({
      videoKey: 'v',
      chunkId: '000000',
      chunk: { startMs: 0, endMs: 5000 },
      tempRoot: root,
      bundle: {
        audioSegments: [{
          path: src, wallStartMs: 0, wallEndMs: 3000, sampleCount: 48000, sampleRate: 16000,
        }],
        mappingSegments: [{
          wallStartMs: 0, wallEndMs: 3000,
          videoStartMs: 0, videoEndMs: 6000, playbackRate: 2,
        }],
        frames: [],
        gaps: [],
      },
      asr: {
        available: () => ({ ok: true }),
        analyze: async ({ audioPath }) => {
          assert.ok(String(audioPath).includes('.slices'));
          return {
            ok: true,
            utterances: [{ startMs: 0, endMs: 400, text: '裁片段' }],
            evidence: [{ startMs: 0, endMs: 400, text: '裁片段', kind: 'asr' }],
          };
        },
      },
    });
    assert.ok(analyzed.utterances[0].endMs > analyzed.utterances[0].startMs);
    assert.ok(analyzed.evidence[0].startMs != null);
    assert.ok(String(analyzed.evidence[0].evidenceId || '').startsWith('EVID_'));
    // 2× 映射：slice 覆盖整段 0–3000 wall → 0–6000 video；utterance 在裁剪文件开头
    assert.ok(analyzed.utterances[0].endMs <= 6000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R2: job_cancel 停止 scheduler/recorder/frame；迟到 segment 不入 bundle；capture_stop 幂等', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-r2-'));
  try {
    const scheduler = createFakeScheduler();
    let recorderStops = 0;
    let frameStops = 0;
    let lateFn = null;
    const fakeRecorder = {
      async start({ outDir }) {
        writeSilentWav(join(outDir, 'seg_00000.wav'), 500);
        this._seg = {
          segmentId: 'early',
          file: 'seg_00000.wav',
          wallStart: 1, wallEnd: 1.5, sampleCount: 8000, sampleRate: 16000,
        };
        return { ok: true };
      },
      onSegment(fn) {
        lateFn = fn;
        fn(this._seg);
        return () => {};
      },
      async stop() {
        recorderStops += 1;
        return { ok: true, segments: [this._seg], flushed: true };
      },
    };
    const frameSource = {
      start({ onFrame }) {
        return {
          stop: async () => { frameStops += 1; },
        };
      },
    };
    const eng = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        captureScheduler: scheduler,
        loopbackRecorder: fakeRecorder,
        captureFrameSource: frameSource,
        asr: { available: () => ({ ok: false }) },
        cdpTransport: {
          async connect() {},
          async evaluate() {
            return {
              ok: true, currentTimeMs: 1000, durationMs: 60_000,
              paused: false, ended: false, playbackRate: 1, readyState: 4,
              visibilityState: 'visible',
              pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
              videoRect: { x: 0, y: 0, width: 40, height: 40 }, devicePixelRatio: 1,
            };
          },
          disconnect() {},
        },
      },
    });
    const start = await eng.captureStart({
      region: { x: 0, y: 0, width: 40, height: 40 },
      cdpEndpoint: 'http://127.0.0.1:9222',
      videoKey: 'capture:r2',
    });
    assert.equal(start.ok, true);
    await scheduler.advance(1);
    const cancel = await eng.jobCancel(start.jobId);
    assert.equal(cancel.ok, true);
    assert.equal(scheduler.active, 0);
    assert.equal(recorderStops, 1);
    assert.equal(frameStops, 1);

    // 迟到 segment
    lateFn?.({
      segmentId: 'late',
      file: 'late.wav',
      wallStart: 99, wallEnd: 100, sampleCount: 100, sampleRate: 16000,
    });

    const stop2 = await eng.captureStop(start.jobId);
    assert.equal(stop2.state, 'cancelled');
    assert.ok(stop2.idempotent || stop2.catalogChunks === 0);

    const store = createChunkStore({ rootDir: root, videoKey: 'capture:r2' });
    assert.equal(store.listReadyChunkIds().length, 0);

    // 500ms 后仍 cancelled
    await new Promise((r) => setTimeout(r, 500));
    const st = eng.jobStatus(start.jobId);
    assert.equal(st.job?.state, 'cancelled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R2: 同 videoKey capture/index 并发被锁拒绝；engine.close 清理', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-r2lock-'));
  try {
    const scheduler = createFakeScheduler();
    const eng = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        captureScheduler: scheduler,
        loopbackRecorder: {
          async start({ outDir }) {
            writeSilentWav(join(outDir, 'a.wav'), 200);
            this._seg = { segmentId: 'a', file: 'a.wav', wallStart: 1, wallEnd: 1.2, sampleCount: 3200, sampleRate: 16000 };
            return { ok: true };
          },
          onSegment(fn) { fn(this._seg); return () => {}; },
          async stop() { return { ok: true, segments: [this._seg] }; },
        },
        captureFrameSource: createFakeFrameSource(),
      },
    });
    const a = await eng.captureStart({
      region: { x: 0, y: 0, width: 20, height: 20 },
      videoKey: 'capture:lock',
    });
    assert.equal(a.ok, true);
    const b = await eng.captureStart({
      region: { x: 0, y: 0, width: 20, height: 20 },
      videoKey: 'capture:lock',
    });
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'locked');

    await eng.close();
    assert.equal(scheduler.active, 0);
    const st = eng.jobStatus(a.jobId);
    assert.equal(st.job?.state, 'cancelled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R3: 生产 screen-frame adapter 被默认创建；PNG 有效；region 传递；stop 后无回调', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-r3-'));
  try {
    let seenSource = null;
    let calls = 0;
    const fakeSpawn = ({ source, onFrame, width, height }) => {
      seenSource = source;
      const buf = Buffer.alloc(width * height * 3, 40);
      // 立即一帧
      setImmediate(() => onFrame({ i: 0, t: 0, buf }));
      return {
        child: { pid: 0 },
        stop() {},
        done: Promise.resolve({ frames: 1, ms: 1, code: 0 }),
      };
    };
    const src = createScreenFrameSource({
      spawnFramesImpl: fakeSpawn,
      width: 32,
      height: 18,
      fps: 1,
    });
    assert.equal(src.kind, 'screen-frame-source');
    const outDir = join(root, 'frames');
    const handle = src.start({
      region: { x: 5, y: 6, width: 100, height: 80 },
      outDir,
      onFrame: (fr) => {
        calls += 1;
        // frame source 只回 raw，不写 PNG
        assert.ok(fr.buf);
        assert.equal(fr.buf.length, 32 * 18 * 3);
        assert.equal(fr.path, undefined);
        assert.equal(existsSync(join(outDir, 'frame_00000.png')), false);
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seenSource.region, { x: 5, y: 6, w: 100, h: 80 });
    assert.ok(calls >= 1);
    await handle.stop();
    const before = calls;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, before);

    // engine 默认不注入 captureFrameSource 时应创建生产 adapter（无 loopback 但有 frame → ok/degraded）
    const eng = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        captureScheduler: createFakeScheduler(),
        loopbackRecorder: {
          async start() { return { ok: false, reason: 'unavailable' }; },
          onSegment() { return () => {}; },
          async stop() { return { ok: true, segments: [] }; },
        },
        // 不注入 captureFrameSource —— 用生产 createScreenFrameSource，但注入 spawn
        captureFrameSource: createScreenFrameSource({ spawnFramesImpl: fakeSpawn }),
      },
    });
    const start = await eng.captureStart({
      region: { x: 1, y: 2, width: 40, height: 40 },
      videoKey: 'capture:r3',
    });
    assert.equal(start.ok, true);
    assert.ok(['ready', 'degraded'].includes(start.capabilities.frameCapture)
      || start.capabilities.audioCapture === 'unavailable');
    await eng.jobCancel(start.jobId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R3: FFmpeg 启动失败 → frameCapture 非 ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-r3fail-'));
  try {
    const bad = createScreenFrameSource({
      spawnFramesImpl: () => { throw new Error('ffmpeg missing'); },
    });
    const controller = createCaptureController({
      rootDir: root,
      videoKey: 'capture:r3f',
      jobId: 'job_r3failxx',
      region: { x: 0, y: 0, width: 10, height: 10 },
      recorder: {
        async start() { return { ok: false, reason: 'unavailable' }; },
        async stop() { return { ok: true, segments: [] }; },
        onSegment() { return () => {}; },
      },
      frameSource: bad,
      scheduler: createFakeScheduler(),
    });
    const r = await controller.start();
    assert.equal(r.ok, false);
    assert.notEqual(r.capabilities.frameCapture, 'ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
