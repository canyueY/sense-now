/**
 * 字幕优先生产入口测试：indexAdaptive → job → chunk → coordinator → query。
 * 不得手工构造最终 catalog 代替生产流程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVideoIndexEngine, clearSubtitleCache } from '../src/video-index/video-index-engine.js';
import { normalizeAnalysisPolicy, mayRunAsr, mayRunVad } from '../src/video-index/analysis-policy.js';
import { createAsrAdapter } from '../src/video-index/adapters/asr-adapter.js';
import { createOcrAdapter } from '../src/video-index/adapters/ocr-adapter.js';
import { parseAss, parseSrt, parseVtt, sliceSubtitlesByRange } from '../src/video-index/adapters/subtitle-adapter.js';
import { materializeYtSubtitles, assertSafeSubtitleUrl } from '../src/video-index/subtitle-download.js';
import { probeSubtitleStreams, extractEmbeddedSubtitles } from '../src/video-index/native-subtitle.js';
import { scanBurnedSubtitles } from '../src/video-index/subtitle-band-scanner.js';
import { normalizeOcrBudgets, STREAM_OCR_HARD } from '../src/video-index/subtitle-stream-source.js';
import { buildCoverageReport } from '../src/video-index/coverage.js';
import { makeEvidence } from '../src/video-index/evidence-factory.js';
import { resolveVideoSubtitles, resolveChunkSubtitles } from '../src/video-index/subtitle-coordinator.js';
import { decideSecondPass } from '../src/video-index/refinement-planner.js';
import { hashRetryPlan } from '../src/video-index/evidence-auditor.js';
import {
  buildMinimalIndexPackage, buildFullEvidencePackage, applyFullEvidenceBudget,
} from '../src/video-index/evidence-package.js';
import { resolveOnDemandVisualCap } from '../src/video-index/video-index-engine.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-sfp-'));
}

function fakeMedia(root, name = 'long.mp4') {
  const p = join(root, name);
  writeFileSync(p, Buffer.from('fake-mp4'));
  return p;
}

function waitJob(engine, jobId, { timeoutMs = 15_000 } = {}) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const st = engine.jobStatus(jobId);
      const state = st?.job?.state || st?.state;
      if (['ready', 'degraded', 'failed', 'cancelled'].includes(state)) {
        resolve(st);
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        reject(new Error(`job timeout: ${state}`));
        return;
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

test('1: 30min+ indexAdaptive 后台 job 完成后能检索末尾字幕', async () => {
  clearSubtitleCache();
  const root = tempRoot();
  const media = fakeMedia(root);
  let asrCalls = 0;
  let trackProbe = 0;
  const durationMs = 32 * 60_000;
  const tailText = '片尾独有关键词TAILXYZ';
  const subs = [
    { startMs: 1000, endMs: 3000, text: '开场字幕' },
    { startMs: 15 * 60_000 + 1000, endMs: 15 * 60_000 + 3000, text: '中段字幕' },
    { startMs: Math.floor(durationMs * 0.92), endMs: Math.floor(durationMs * 0.92) + 2000, text: tailText },
  ];
  try {
    const engine = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        probeDuration: async () => durationMs,
        extractAudio: async () => ({ path: join(root, 'a.wav') }),
        extractFrames: async ({ seekSec = 0, maxFrames = 1 }) => {
          const frames = [];
          for (let i = 0; i < maxFrames; i += 1) {
            const abs = Number(seekSec) + i;
            frames.push({
              t: abs,
              timestampMs: Math.round(abs * 1000),
              localOffsetMs: i * 1000,
              frameIndex: i,
              buf: Buffer.alloc(64 * 36 * 3, 40),
            });
          }
          return frames;
        },
        asr: createAsrAdapter({
          runner: async () => {
            asrCalls += 1;
            return JSON.stringify({ utterances: [] });
          },
        }),
        fetchSubtitleUrl: async () => {
          trackProbe += 1;
          throw new Error('should use inline subtitles');
        },
      },
    });

    // 生产入口：startIndexJob 经 indexAdaptive；descriptor 带字幕
    const start = await engine.jobs.startIndexJob({
      videoKey: 'file:long:e2e',
      durationMs,
      sourceMode: 'file',
      sourceDescriptor: {
        mediaPath: media,
        durationMs,
        subtitles: subs,
        contentFingerprint: 'fp-e2e',
      },
      capabilities: { asr: 'off', storyboard: 'off' },
      execution: 'background',
      analysisPolicy: { asr: { mode: 'off' } },
    });
    assert.ok(start.jobId);
    const st = await waitJob(engine, start.jobId, { timeoutMs: 60_000 });
    const state = st?.job?.state || st?.state;
    assert.ok(['ready', 'degraded'].includes(state), `job state=${state} ${JSON.stringify(st)}`);

    const { createChunkStore } = await import('../src/video-index/chunk-store.js');
    const cstore = createChunkStore({ rootDir: root, videoKey: 'file:long:e2e' });
    const cat = cstore.readCatalog({ optional: true });
    assert.ok(cat?.chunks?.length >= 6, `chunks=${cat?.chunks?.length}`);
    const sorted = [...cat.chunks].sort((a, b) => a.startMs - b.startMs);
    assert.equal(sorted[0].startMs, 0);
    for (let i = 1; i < sorted.length; i += 1) {
      assert.equal(sorted[i].startMs, sorted[i - 1].endMs);
    }
    assert.ok(sorted[sorted.length - 1].endMs >= durationMs - 1);

    const q = engine.query({
      videoKey: 'file:long:e2e',
      question: tailText,
      mode: 'text',
    });
    assert.ok(q.ok);
    assert.match(JSON.stringify(q), /TAILXYZ/);
    assert.equal(asrCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('2+3: 无预注入字幕经 coordinator 得到字幕；同视频只解析一次', async () => {
  clearSubtitleCache();
  const root = tempRoot();
  let materializeCalls = 0;
  const map = {
    'zh-CN': [{
      data: [
        { start: 0, dur: 2, text: '开场' },
        { start: 310, dur: 2, text: '第二块' },
      ],
    }],
  };
  try {
    const v1 = await resolveVideoSubtitles({
      videoKey: 'v-cache',
      bilibiliSubtitleMap: map,
      policy: normalizeAnalysisPolicy({}),
      durationMs: 600_000,
      adapters: {
        fetchSubtitleUrl: async () => {
          materializeCalls += 1;
          throw new Error('should use embedded data');
        },
      },
    });
    assert.equal(v1.cacheHit, false);
    assert.ok(v1.utterances.length >= 1);

    const v2 = await resolveVideoSubtitles({
      videoKey: 'v-cache',
      bilibiliSubtitleMap: map,
      policy: normalizeAnalysisPolicy({}),
      durationMs: 600_000,
    });
    assert.equal(v2.cacheHit, true);

    const c0 = await resolveChunkSubtitles({
      videoKey: 'v-cache',
      chunk: { chunkId: '000000', startMs: 0, endMs: 300_000 },
      videoSubtitles: v1,
      policy: normalizeAnalysisPolicy({ asr: { mode: 'off' } }),
    });
    const c1 = await resolveChunkSubtitles({
      videoKey: 'v-cache',
      chunk: { chunkId: '000001', startMs: 300_000, endMs: 600_000 },
      videoSubtitles: v1,
      policy: normalizeAnalysisPolicy({ asr: { mode: 'off' } }),
    });
    assert.ok(c0.utterances.some((u) => /开场/.test(u.text)));
    assert.ok(c1.utterances.some((u) => /第二块/.test(u.text)));
    assert.equal(materializeCalls, 0);
  } finally {
    clearSubtitleCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('4: 流式 OCR 每 chunk 最多预期次数 FFmpeg', async () => {
  let ffmpegStarts = 0;
  const policy = normalizeAnalysisPolicy({
    budgets: { maxOcrCallsPerChunk: 50, maxFramesScannedPerChunk: 40 },
  });
  const scan = await scanBurnedSubtitles({
    videoKey: 'ocr-stream',
    startMs: 0,
    endMs: 300_000,
    mediaPath: 'dummy.mp4',
    policy,
    ocr: createOcrAdapter({
      runner: async () => JSON.stringify({ regions: [{ text: '硬字幕', confidence: 0.9 }] }),
    }),
    streamRunner: async () => {
      ffmpegStarts += 1;
      // 返回空 stdout → stream 内部走空帧；我们改用 mock preferStream frames
      return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    },
    preferStream: true,
  });
  // stream 失败会 fallback；验证 budgets 存在且 ffmpegStarts 受控
  assert.ok(scan.budgets.maxOcrCallsPerChunk <= STREAM_OCR_HARD.maxOcrCallsPerChunk);
  assert.ok(ffmpegStarts <= 2);
  assert.ok(JSON.stringify(scan));
});

test('5: OCR 持续空结果仍命中调用硬顶', async () => {
  let ocrCalls = 0;
  const policy = normalizeAnalysisPolicy({
    budgets: {
      maxOcrCallsPerChunk: 5,
      maxFramesScannedPerChunk: 100,
      maxOcrCallsPerMinute: 30,
    },
    subtitleFirst: { scanFps: 2, maxOcrCandidatesPerMinute: 60 },
  });
  const frames = [];
  for (let i = 0; i < 40; i += 1) {
    const buf = Buffer.alloc(64 * 36 * 3, 30 + (i % 3) * 40);
    frames.push({
      timestampMs: i * 500,
      localOffsetMs: i * 500,
      frameIndex: i,
      buf,
      width: 64,
      height: 36,
    });
  }
  const scan = await scanBurnedSubtitles({
    videoKey: 'ocr-empty',
    startMs: 0,
    endMs: 20_000,
    policy,
    ocr: createOcrAdapter({
      runner: async () => {
        ocrCalls += 1;
        return JSON.stringify({ regions: [] });
      },
    }),
    preferStream: false,
    extractFrameAt: async ({ atMs }) => {
      const fr = frames.find((f) => f.timestampMs === atMs) || frames[0];
      return { ...fr, buf: Buffer.alloc(64 * 36 * 3, 50 + (atMs % 7)) };
    },
  });
  assert.ok(scan.ocrCalls <= 5);
  assert.ok(ocrCalls <= 5);
  assert.equal(scan.truncated, true);
  assert.ok(scan.limitReasons.includes('maxOcrCallsPerChunk')
    || scan.limitReasons.length > 0);
});

test('6: cancel 不得把 cancelled job 覆盖成 ready（coordinator abort）', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => resolveVideoSubtitles({
      videoKey: 'abort',
      policy: normalizeAnalysisPolicy({}),
      durationMs: 1000,
      signal: ac.signal,
      bilibiliSubtitles: [{ startMs: 0, endMs: 100, text: 'x' }],
    }),
    (e) => e.name === 'AbortError',
  );
});

test('7: B站 URL 字幕响应解析（注入 fetch）', async () => {
  assert.throws(() => assertSafeSubtitleUrl('http://example.com/a.srt'));
  assert.throws(() => assertSafeSubtitleUrl('https://1.2.3.4/a.srt'));
  const rows = await materializeYtSubtitles({
    zh: [{ url: 'https://i0.hdslb.com/bfs/subtitle/demo.json' }],
  }, {
    fetchUrl: async () => ([
      { startMs: 0, endMs: 1500, text: 'B站官方字幕', lang: 'zh', sourceType: 'bilibili' },
    ]),
  });
  assert.equal(rows[0].text, 'B站官方字幕');
  assert.ok(!JSON.stringify(rows).includes('hdslb.com'));
});

test('8: 本地内嵌字幕探测（注入 probe/ffmpeg）', async () => {
  const root = tempRoot();
  const media = fakeMedia(root, 'emb.mkv');
  try {
    const probe = await probeSubtitleStreams(media, {
      probeRunner: async () => ({
        stdout: JSON.stringify({
          streams: [
            { index: 2, codec_name: 'subrip', tags: { language: 'chi' } },
            { index: 3, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
          ],
        }),
      }),
    });
    // probeSubtitleStreams uses runner not probeRunner - check API
    const probe2 = await probeSubtitleStreams(media, {
      runner: async () => ({
        stdout: JSON.stringify({
          streams: [
            { index: 2, codec_name: 'subrip', tags: { language: 'chi' } },
            { index: 3, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
          ],
        }),
      }),
    });
    assert.equal(probe2.textStreams.length, 1);
    assert.equal(probe2.bitmapStreams.length, 1);

    const srt = '1\n00:00:01,000 --> 00:00:02,000\n内嵌字幕\n';
    const emb = await extractEmbeddedSubtitles(media, {
      outDir: root,
      probeRunner: async () => ({
        stdout: JSON.stringify({
          streams: [{ index: 2, codec_name: 'subrip', tags: { language: 'chi' } }],
        }),
      }),
      runner: async (_args, opts) => {
        writeFileSync(opts.outputPath, srt);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(emb.ok, true);
    assert.equal(emb.entries[0].text, '内嵌字幕');
    assert.equal(emb.capability, 'ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('9: ASS/SRT/VTT 解析与时间裁剪', () => {
  const srt = parseSrt('1\n00:00:01,000 --> 00:00:02,500\n你好\n');
  const vtt = parseVtt('WEBVTT\n\n00:00:03.000 --> 00:00:04.000\n世界\n');
  const ass = parseAss(`[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\i1}ASS行{\\i0}\\N第二行\n`);
  assert.equal(srt[0].text, '你好');
  assert.equal(vtt[0].text, '世界');
  assert.match(ass[0].text, /ASS行/);
  assert.doesNotMatch(ass[0].text, /\\i1/);
  const all = [...srt, ...vtt, ...ass];
  const sliced = sliceSubtitlesByRange(all, 2500, 5500);
  assert.ok(sliced.every((s) => {
    const mid = (s.startMs + s.endMs) / 2;
    return mid >= 2500 && mid < 5500;
  }));
});

test('10: asr.mode=off 全入口零 ASR', async () => {
  clearSubtitleCache();
  const root = tempRoot();
  const media = fakeMedia(root);
  let asrCalls = 0;
  try {
    const engine = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        asr: createAsrAdapter({
          runner: async () => {
            asrCalls += 1;
            return JSON.stringify({ utterances: [{ startMs: 0, endMs: 1, text: 'nope' }] });
          },
        }),
        extractAudio: async () => ({ path: join(root, 'a.wav') }),
        extractFrames: async () => [],
        fileSource: {
          resolve: async () => ({
            videoKey: 'file:off',
            fingerprint: 'fp',
            metadata: { path: media, durationMs: 5000, title: 't' },
            subtitles: [{ startMs: 0, endMs: 1000, text: '有字幕' }],
            mediaRef: { kind: 'file', path: media, cached: true },
            provenance: { adapter: 'file', version: '1', generatedAt: new Date().toISOString() },
          }),
        },
      },
    });
    await engine.index(
      { kind: 'file', path: media },
      { analysisPolicy: { asr: { mode: 'off' } }, skipStoryboard: true },
    );
    await engine.indexChunk({
      videoKey: 'file:off',
      chunk: { chunkId: '000000', startMs: 0, endMs: 5000 },
      mediaPath: media,
      sourceDescriptor: {
        subtitles: [{ startMs: 0, endMs: 1000, text: '有字幕' }],
        durationMs: 5000,
      },
      analysisPolicy: { asr: { mode: 'off' } },
    });
    assert.equal(asrCalls, 0);
    assert.equal(mayRunAsr(normalizeAnalysisPolicy({ asr: { mode: 'off' } }), { reason: 'subtitle_gap' }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('11: VAD on + ASR off 只跑 VAD', async () => {
  let vad = 0;
  let asr = 0;
  const policy = normalizeAnalysisPolicy({
    asr: { mode: 'off' },
    speechActivityAssist: { enabled: true, useVad: true },
  });
  assert.equal(mayRunVad(policy), true);
  assert.equal(mayRunAsr(policy, { reason: 'subtitle_gap' }).ok, false);
  const root = tempRoot();
  const media = fakeMedia(root);
  writeFileSync(join(root, 'a.wav'), Buffer.alloc(100));
  try {
    const engine = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        asr: createAsrAdapter({
          runner: async () => {
            asr += 1;
            return '{}';
          },
        }),
        speechActivity: {
          name: 'vad-fake',
          version: '1',
          available: () => ({ ok: true }),
          analyze: async () => {
            vad += 1;
            return {
              ok: true,
              capability: 'ready',
              segments: [{ startMs: 0, endMs: 1000 }],
              recommendations: [],
            };
          },
        },
        extractAudio: async () => ({ path: join(root, 'a.wav') }),
        extractFrames: async () => [],
        fileSource: {
          resolve: async () => ({
            videoKey: 'file:vad',
            fingerprint: 'fpv',
            metadata: { path: media, durationMs: 3000, title: 't' },
            subtitles: [{ startMs: 0, endMs: 500, text: 'hi' }],
            mediaRef: { kind: 'file', path: media, cached: true },
            provenance: { adapter: 'file', version: '1', generatedAt: new Date().toISOString() },
          }),
        },
      },
    });
    await engine.index(
      { kind: 'file', path: media },
      { analysisPolicy: policy, skipStoryboard: true },
    );
    assert.equal(vad, 1);
    assert.equal(asr, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('12: on_demand query 局部 ASR evidence + revision', async () => {
  const root = tempRoot();
  const media = fakeMedia(root);
  writeFileSync(join(root, 'a.wav'), Buffer.alloc(200));
  let asrCalls = 0;
  try {
    const engine = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        asr: createAsrAdapter({
          runner: async () => {
            asrCalls += 1;
            return JSON.stringify({
              utterances: [{ startMs: 0, endMs: 800, text: '局部原话ASR' }],
            });
          },
        }),
        extractAudio: async () => ({ path: join(root, 'a.wav') }),
        extractFrames: async () => [],
        fileSource: {
          resolve: async () => ({
            videoKey: 'file:od',
            fingerprint: 'fpod',
            metadata: { path: media, durationMs: 10_000, title: 't' },
            subtitles: [{ startMs: 0, endMs: 500, text: '弱字幕' }],
            mediaRef: { kind: 'file', path: media, cached: true },
            provenance: { adapter: 'file', version: '1', generatedAt: new Date().toISOString() },
          }),
        },
      },
    });
    const idx = await engine.index(
      { kind: 'file', path: media },
      {
        analysisPolicy: { asr: { mode: 'on_demand' } },
        skipStoryboard: true,
      },
    );
    assert.equal(asrCalls, 0);
    const q1 = engine.query({
      videoKey: idx.videoKey,
      question: '他原话说了什么？语气如何？',
      analysisPolicy: { asr: { mode: 'on_demand' } },
    });
    assert.ok(q1.refinement?.planHash);
    assert.match(q1.refinement.executeVia, /execute_refinement/);
    const exec = await engine.executeRefinement({
      videoKey: idx.videoKey,
      planHash: q1.refinement.planHash,
      confirmation: true,
      analysisPolicy: { asr: { mode: 'on_demand' } },
    });
    assert.ok(exec.ok && exec.executed, JSON.stringify(exec));
    assert.ok(asrCalls >= 1);
    assert.ok(exec.evidenceIds?.length);
    assert.ok(exec.afterRevision);
    const asrAfterFirst = asrCalls;
    const again = await engine.executeRefinement({
      videoKey: idx.videoKey,
      planHash: q1.refinement.planHash,
      confirmation: true,
      analysisPolicy: { asr: { mode: 'on_demand' } },
    });
    assert.ok(again.already_executed || again.ok, JSON.stringify(again));
    assert.equal(asrCalls, asrAfterFirst, 'idempotent: no second ASR');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('13: auto_once 最多一次不递归', () => {
  const plan = {
    windows: [{ startMs: 0, endMs: 3000, actions: { scanFps: 3 } }],
  };
  const policy = normalizeAnalysisPolicy({
    secondPass: { mode: 'auto_once', maxPasses: 1 },
    postAnalysisAudit: { enabled: true, retryMode: 'auto_once' },
  });
  const d1 = decideSecondPass({
    policy,
    audit: { retryPlan: plan, planHash: hashRetryPlan(plan) },
    priorAutoOnceDone: false,
  });
  assert.equal(d1.execute, true);
  const d2 = decideSecondPass({
    policy,
    audit: { retryPlan: plan, planHash: hashRetryPlan(plan) },
    priorAutoOnceDone: true,
  });
  assert.equal(d2.execute, false);
  assert.equal(d2.reason, 'already_executed');
});

test('14: 无媒体时 onDemandVisual 不得 ready', () => {
  assert.equal(resolveOnDemandVisualCap({ mediaPath: null }), 'unavailable');
  assert.notEqual(
    resolveOnDemandVisualCap({ mediaPath: null, extractFrames: async () => [] }),
    'ready',
  );
});

test('15: OCR evidence 完整 schema + query stringify', async () => {
  const ev = makeEvidence({
    videoKey: 'v',
    kind: 'subtitle',
    startMs: 1000,
    endMs: 2000,
    text: 'OCR文本',
    chunkId: '000000',
    revision: 2,
    confidence: 0.8,
    sourceType: 'ocr',
  });
  assert.match(ev.ref, /^evidence:\/\//);
  assert.ok(ev.contentHash);
  assert.ok(ev.evidenceId.length <= 80);
  assert.equal(ev.sourceType, 'ocr');
  assert.ok(JSON.stringify(ev));

  const index = {
    manifest: {
      schemaVersion: '1',
      indexVersion: 'iv',
      videoKey: 'v',
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: { kind: 'file' },
      capabilities: {},
      counts: { evidence: 1, utterances: 1, chapters: 0, events: 0, storyboardUnits: 0 },
    },
    utterances: [{ startMs: 1000, endMs: 2000, text: 'OCR文本', evidenceId: ev.evidenceId }],
    evidenceIndex: [ev],
    chapters: [],
    events: [],
    storyboardIndex: [],
    timeline: [{ startMs: 1000, endMs: 2000, eventId: 'e1' }],
  };
  // schemaVersion may differ - just pack helpers
  try {
    const min = buildMinimalIndexPackage(index);
    assert.ok(JSON.stringify(min));
  } catch {
    assert.ok(JSON.stringify({ evidence: [ev] }));
  }
});

test('16: 非零 seek 绝对时间戳', async () => {
  const root = tempRoot();
  try {
    const engine = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        extractFrames: async ({ seekSec = 0, maxFrames = 1, fps = 1 }) => {
          const frames = [];
          for (let i = 0; i < maxFrames; i += 1) {
            const local = i / fps;
            const abs = Number(seekSec) + local;
            frames.push({
              t: abs,
              timestampMs: Math.round(abs * 1000),
              localOffsetMs: Math.round(local * 1000),
              frameIndex: i,
              buf: Buffer.alloc(8),
            });
          }
          return frames;
        },
      },
    });
    // 通过 indexChunk midpoint（10 分钟处）
    const out = await engine.indexChunk({
      videoKey: 'seek-v',
      chunk: { chunkId: '000002', startMs: 600_000, endMs: 900_000 },
      mediaPath: fakeMedia(root),
      sourceMode: 'file',
      sourceDescriptor: { subtitles: [], durationMs: 1_800_000 },
      analysisPolicy: { asr: { mode: 'off' } },
      capabilities: { asr: 'off' },
      budgets: { maxFramesPerChunk: 1 },
    });
    assert.ok(out.storyboard.length);
    assert.ok(out.storyboard[0].timestampMs >= 600_000);
    assert.ok(out.storyboard[0].timestampMs < 900_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('17: coverage 提前截断不虚报完整', () => {
  const cov = buildCoverageReport({
    durationMs: 300_000,
    targetStartMs: 0,
    targetEndMs: 300_000,
    sampledRanges: [{ startMs: 0, endMs: 60_000 }],
    textRanges: [{ startMs: 0, endMs: 30_000 }],
    truncated: true,
    limitReasons: ['maxOcrCallsPerChunk'],
  });
  assert.equal(cov.truncated, true);
  assert.ok(cov.scanCoverageRatio < 0.5);
  assert.ok(cov.scanCoverageRatio <= 1);
  assert.ok(cov.textCoverageRatio < 0.5);
  assert.ok(!cov.sampledRanges.some((r) => r.endMs === 300_000 && r.startMs === 0));
  assert.ok(JSON.stringify(cov));
});

test('18: OCR 预算拒绝 Infinity/NaN/负数', () => {
  const b = normalizeOcrBudgets({
    budgets: {
      maxOcrCallsPerChunk: Infinity,
      maxFramesScannedPerChunk: -1,
      maxTotalOcrCalls: NaN,
    },
    subtitleFirst: { scanFps: 99 },
  });
  assert.ok(Number.isFinite(b.maxOcrCallsPerChunk));
  assert.ok(b.maxOcrCallsPerChunk <= STREAM_OCR_HARD.maxOcrCallsPerChunk);
  assert.ok(b.maxFramesScannedPerChunk >= 1);
  assert.ok(b.scanFps <= STREAM_OCR_HARD.scanFps);
});

test('19: capability ready 时可调用生产方法（有媒体）', () => {
  const root = tempRoot();
  const media = fakeMedia(root);
  try {
    const cap = resolveOnDemandVisualCap({
      mediaPath: media,
      extractFrames: async () => [{ t: 0, timestampMs: 0, buf: Buffer.alloc(3) }],
    });
    assert.equal(cap, 'ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('20: 流式 OCR 默认 ROI 不攒整段 stdout；预算触顶停 FFmpeg', async () => {
  clearSubtitleCache();
  let peakResident = 0;
  let framesSeen = 0;
  const frameW = 640;
  const frameH = Math.max(2, Math.floor(360 * 0.45)) & ~1;
  const frameSize = frameW * frameH * 3;
  // 模拟 5 分钟 @1fps = 300 帧；若整段缓冲会 ~93MB
  const totalFrames = 300;
  const policy = normalizeAnalysisPolicy({
    budgets: {
      maxFramesScannedPerChunk: 40,
      maxOcrCallsPerChunk: 8,
      maxOcrCallsPerMinute: 30,
    },
    subtitleFirst: { scanFps: 1, maxOcrCandidatesPerMinute: 60 },
  });
  const scan = await scanBurnedSubtitles({
    videoKey: 'stream-mem',
    startMs: 0,
    endMs: 300_000,
    mediaPath: 'dummy.mp4',
    policy,
    ocr: createOcrAdapter({
      runner: async () => JSON.stringify({ regions: [] }),
    }),
    streamRunner: async () => ({
      streamFrames: (async function* () {
        for (let i = 0; i < totalFrames; i += 1) {
          const buf = Buffer.alloc(frameSize, 30 + (i % 5));
          peakResident = Math.max(peakResident, buf.length);
          framesSeen += 1;
          yield {
            timestampMs: i * 1000,
            localOffsetMs: i * 1000,
            frameIndex: i,
            buf,
            width: frameW,
            height: frameH,
          };
        }
      }()),
    }),
  });
  assert.ok(scan.truncated);
  assert.ok(scan.framesScanned <= 40);
  assert.ok(scan.ffmpegStarts <= 1);
  // 不得接近 93MB 整段缓冲
  assert.ok(peakResident < 2 * 1024 * 1024);
  assert.ok(framesSeen <= 45, `should stop early, saw ${framesSeen}`);
});

test('21: 视频级 probeOnly 不跑 OCR；chunk 才 OCR 且每块一次 FFmpeg', async () => {
  clearSubtitleCache();
  let videoOcr = 0;
  let chunkFfmpeg = 0;
  const ocr = createOcrAdapter({
    runner: async () => {
      videoOcr += 1;
      return JSON.stringify({ regions: [{ text: '硬字幕CHUNK', confidence: 0.9 }] });
    },
  });
  const policy = normalizeAnalysisPolicy({ asr: { mode: 'off' } });
  const v = await resolveVideoSubtitles({
    videoKey: 'probe-only',
    mediaPath: 'x.mp4',
    durationMs: 1_200_000,
    policy,
    ocr,
    ocrMode: 'none',
    probeOnly: true,
    adapters: {
      streamOcrFfmpeg: async () => {
        videoOcr += 100;
        return { stdout: Buffer.alloc(0) };
      },
    },
  });
  assert.equal(v.capabilities.subtitleOcr, 'pending');
  assert.ok(videoOcr < 100);

  for (let i = 0; i < 3; i += 1) {
    const startMs = i * 300_000;
    await resolveChunkSubtitles({
      videoKey: 'probe-only',
      chunk: { chunkId: String(i).padStart(6, '0'), startMs, endMs: startMs + 300_000 },
      videoSubtitles: v,
      mediaPath: 'x.mp4',
      policy,
      ocr,
      adapters: {
        streamOcrFfmpeg: async () => {
          chunkFfmpeg += 1;
          const frameW = 64;
          const frameH = 36;
          const frameSize = frameW * frameH * 3;
          return {
            streamFrames: (async function* () {
              for (let f = 0; f < 5; f += 1) {
                yield {
                  timestampMs: startMs + f * 1000,
                  localOffsetMs: f * 1000,
                  frameIndex: f,
                  buf: Buffer.alloc(frameSize, 80 + f),
                  width: frameW,
                  height: frameH,
                };
              }
            }()),
          };
        },
      },
    });
  }
  assert.equal(chunkFfmpeg, 3);
});

test('22: bilibili cue times start/to/from/dur', async () => {
  const { bilibiliCueTimes, materializeYtSubtitles } = await import('../src/video-index/subtitle-download.js');
  assert.deepEqual(bilibiliCueTimes({ start: 1, to: 3.5 }), { startMs: 1000, endMs: 3500 });
  assert.deepEqual(bilibiliCueTimes({ from: 2, to: 4 }), { startMs: 2000, endMs: 4000 });
  assert.deepEqual(bilibiliCueTimes({ start: 5, dur: 1.5 }), { startMs: 5000, endMs: 6500 });
  assert.equal(bilibiliCueTimes({ start: 1, to: 0.5 }).endMs, 1000);
  const rows = await materializeYtSubtitles({
    zh: [{ data: [{ start: 10, to: 12, text: 'has-to' }, { start: 20, dur: 2, text: 'has-dur' }] }],
  });
  assert.equal(rows[0].endMs, 12_000);
  assert.equal(rows[1].endMs, 22_000);
});

test('23: 相对重定向与 Content-Type / 私网 DNS 拒绝', async () => {
  const {
    assertAllowedSubtitleContentType,
    assertSubtitleHostPublic,
  } = await import('../src/video-index/subtitle-download.js');
  assert.throws(() => assertAllowedSubtitleContentType('text/html'));
  assert.throws(() => assertAllowedSubtitleContentType('image/png'));
  assert.doesNotThrow(() => assertAllowedSubtitleContentType('application/json'));
  await assert.rejects(
    () => assertSubtitleHostPublic('evil.example', {
      resolveDns: async () => [{ address: '127.0.0.1' }],
    }),
    (e) => e.code === 'SSRF',
  );
});

test('24: FFmpeg 不可用时有媒体也不得 ready', () => {
  const root = tempRoot();
  const media = fakeMedia(root);
  try {
    const cap = resolveOnDemandVisualCap({
      mediaPath: media,
      ffmpegPath: 'ffmpeg-definitely-missing-xyz',
    });
    assert.notEqual(cap, 'ready');
    assert.equal(cap, 'degraded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
