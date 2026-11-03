/**
 * 公开入口链路断点：外挂字幕进后台、chunk evidence/zoom、refine 假“已执行”。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { createVideoIndexTool } from '../src/video-index-tool.js';
import { createChunkStore } from '../src/video-index/chunk-store.js';
import {
  readSourceRef, attachIndexOptionsToDescriptor,
} from '../src/video-index/source-ref.js';

test('subtitlePath 经 indexAdaptive 进入后台 sourceDescriptor / source-ref', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-subtitle-path-'));
  const media = join(root, 'long.mp4');
  const srt = join(root, 'ext.srt');
  writeFileSync(media, Buffer.alloc(64));
  writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nhello sidecar\n\n');
  try {
    const attached = attachIndexOptionsToDescriptor(
      { mediaPath: media },
      { subtitlePath: srt },
    );
    assert.equal(attached.subtitlePath, srt);

    let captured = null;
    const engine = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        fileSource: {
          resolve: async (source) => ({
            videoKey: 'file:test:long.mp4',
            metadata: { durationMs: 15 * 60_000, path: source.path || media },
            mediaRef: { path: source.path || media },
            subtitles: [],
          }),
        },
        probeDuration: async () => 15 * 60_000,
      },
    });
    // monkey：拦截 startIndexJob
    const orig = engine.jobs.startIndexJob.bind(engine.jobs);
    engine.jobs.startIndexJob = async (opts) => {
      captured = opts;
      return orig(opts);
    };

    const r = await engine.indexAdaptive({
      source: { kind: 'file', path: media },
      execution: 'background',
      analysisPolicy: {},
      indexOptions: { subtitlePath: srt },
    });
    assert.equal(r.ok, true);
    assert.equal(r.background, true);
    assert.ok(captured, 'startIndexJob called');
    assert.equal(captured.sourceDescriptor?.subtitlePath, srt);
    assert.equal(r.hasSubtitlePath, true);

    const ref = readSourceRef(createChunkStore({
      rootDir: root,
      videoKey: captured.videoKey,
    }).videoDir);
    assert.ok(ref);
    assert.equal(ref.subtitlePath, srt);
    assert.equal(ref.mediaPath, media);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('chunk catalog：evidence / zoom 公开入口不再 not-found', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-chunk-ev-'));
  const media = join(root, 'clip.mp4');
  writeFileSync(media, Buffer.alloc(32));
  const videoKey = 'file:deadbeef:clip.mp4';
  try {
    const store = createChunkStore({ rootDir: root, videoKey });
    store.commitChunk('000000', {
      chunkManifest: {
        chunkId: '000000',
        revision: 1,
        startMs: 0,
        endMs: 300_000,
        status: 'ready',
        sourceMode: 'file',
        timeSource: 'stream',
      },
      utterances: [{
        utteranceId: 'u1',
        startMs: 1000,
        endMs: 2000,
        text: 'chunk text',
        evidenceId: 'EVID_chunk1',
      }],
      events: [],
      speakers: [],
      storyboard: [],
      evidence: [{
        evidenceId: 'EVID_chunk1',
        kind: 'subtitle',
        startMs: 1000,
        endMs: 2000,
        text: 'chunk text',
      }],
      chapters: [],
    });
    store.rebuildCatalog();
    writeFileSync(join(store.videoDir, 'chunks', 'source-ref.json'), JSON.stringify({
      layoutVersion: 'source-ref-v1',
      sourceMode: 'file',
      durationMs: 300_000,
      mediaPath: media,
      subtitlePath: null,
    }));

    const engine = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        extractFrames: async () => [{
          buf: Buffer.alloc(800 * 450 * 3, 7),
          timestampMs: 1500,
          t: 1.5,
        }],
      },
    });

    assert.equal(engine.store.exists(videoKey), false, 'no monolithic manifest');

    const ev = engine.getEvidence({ videoKey });
    assert.equal(ev.ok, true);
    assert.equal(ev.layout, 'chunk_catalog');
    assert.ok(ev.evidence.some((e) => e.evidenceId === 'EVID_chunk1'));

    const tool = createVideoIndexTool({ rootDir: root, engine });
    const toolEv = await tool.route({ action: 'evidence', videoKey });
    assert.match(toolEv.text, /evidence/);
    assert.equal(toolEv.meta.ok, true);

    const z = await engine.zoom({
      videoKey,
      startMs: 1000,
      endMs: 2000,
    });
    assert.equal(z.ok, true, z.reason || z.detail);
    assert.equal(z.layout, 'chunk_catalog');
    assert.ok(z.units?.length);

    const toolZ = await tool.route({
      action: 'zoom',
      videoKey,
      startMs: 1000,
      endMs: 2000,
    });
    assert.equal(toolZ.meta.ok, true);
    assert.doesNotMatch(toolZ.text, /找不到|not-found|失败：not-found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refine 确认但未写入 ASR 时不得报 executed=true', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-refine-reg-'));
  try {
    const engine = createVideoIndexEngine({ rootDir: root, adapters: {} });
    // 建一个最小 monolithic 索引
    const videoKey = 'file:abc:demo.mp4';
    const dir = engine.store.videoDir(videoKey);
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    engine.store.commit(videoKey, {
      manifest: {
        schemaVersion: '1.1',
        videoKey,
        status: 'ready',
        indexVersion: 'v1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: { kind: 'file' },
        capabilities: {},
        counts: {
          chapters: 0, events: 0, utterances: 0, evidence: 0, storyboardUnits: 0,
        },
      },
      metadata: { path: join(root, 'missing.mp4'), durationMs: 60_000 },
      chapters: [],
      topics: [],
      entityOverview: [],
      keyMoments: [],
      timeline: [],
      utterances: [],
      events: [],
      subtitles: [],
      entityTracks: [],
      evidenceIndex: [],
      storyboardIndex: [],
      audioIndex: [],
      effectivePolicy: { asr: { mode: 'off' }, secondPass: { mode: 'ask' } },
      audit: {
        planHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
        retryPlan: {
          windows: [{ startMs: 0, endMs: 5000, reason: 'test' }],
          reasons: ['test'],
          edits: [{ action: 'local_asr' }],
        },
      },
    });

    // 强制 planHash 校验：用真实 hash 更稳妥 —— 直接走 retryPlan + confirmation
    const retryPlan = {
      windows: [{ startMs: 0, endMs: 5000 }],
      reasons: ['gap'],
      edits: [{ action: 'local_asr' }],
    };
    const { hashRetryPlan } = await import('../src/video-index/evidence-auditor.js');
    const planHash = hashRetryPlan(retryPlan);

    const r = await engine.refine({
      videoKey,
      confirmation: { planHash },
      retryPlan,
      analysisPolicy: { asr: { mode: 'off' }, secondPass: { mode: 'ask' } },
    });
    assert.equal(r.executed, false, `asr off must not claim executed: ${JSON.stringify(r)}`);
    assert.ok(
      r.registeredOnly === true || r.reportOnly === true,
      `expected registeredOnly or reportOnly: ${JSON.stringify(r)}`,
    );
    assert.notEqual(r.executed, true);

    const tool = createVideoIndexTool({ rootDir: root, engine });
    const out = await tool.route({
      action: 'refine',
      videoKey,
      confirmation: { planHash },
      retryPlan,
      analysisPolicy: { asr: { mode: 'off' }, secondPass: { mode: 'ask' } },
    });
    assert.match(out.text, /未真正执行|未执行|已登记/);
    assert.doesNotMatch(out.text, /已按确认执行局部二次分析并写入证据/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
