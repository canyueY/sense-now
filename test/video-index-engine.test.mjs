import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { createAsrAdapter } from '../src/video-index/adapters/asr-adapter.js';
import { encodePng } from '../src/png.js';

function solidFrame(w, h, v) {
  return Buffer.alloc(w * h * 3, v);
}

function makeEngine(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-eng-'));
  const frames = [
    { t: 0, buf: solidFrame(32, 32, 10) },
    { t: 1, buf: solidFrame(32, 32, 200) },
    { t: 2, buf: solidFrame(32, 32, 30) },
  ];
  const engine = createVideoIndexEngine({
    rootDir: root,
    adapters: {
      extractFrames: async () => frames,
      // 测试默认不跑真实 ffmpeg 抽音频
      extractAudio: async ({ outputPath }) => ({ ok: true, path: outputPath || null }),
      ...overrides.adapters,
    },
    clock: () => '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
  return { root, engine, frames };
}

test('本地文件可建 metadata + 字幕 + storyboard；重复 index 复用', async () => {
  const { root, engine } = makeEngine();
  const path = join(root, 'demo.mp4');
  writeFileSync(path, Buffer.from('fake-media')); // 不真解码；extractFrames 已注入

  const r1 = await engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [
        { startMs: 0, endMs: 2000, text: '介绍记忆架构' },
        { startMs: 15000, endMs: 18000, text: '下一章实现细节' },
      ],
      width: 32,
      height: 32,
    },
  }, { width: 32, height: 32 });
  assert.equal(r1.ok, true);
  assert.equal(r1.reused, false);
  assert.ok(['ready', 'degraded'].includes(r1.manifest.status));
  assert.equal(r1.manifest.capabilities.subtitles, 'ready');
  assert.ok(r1.manifest.counts.utterances >= 1);
  assert.ok(r1.manifest.counts.storyboardUnits >= 1);

  const r2 = await engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [{ startMs: 0, endMs: 2000, text: '介绍记忆架构' }],
    },
  });
  assert.equal(r2.reused, true);

  const q = engine.query({
    videoKey: r1.videoKey,
    question: '这个视频讲了什么',
    mode: 'auto',
  });
  assert.equal(q.queryType, 'text_structure');
  assert.equal(q.visualEvidence.length, 0, '文本问题不附图');
  assert.ok(q.context.chapters.length >= 1 || q.context.utterances.length >= 1);

  const q2 = engine.query({
    videoKey: r1.videoKey,
    question: '这个视频讲了什么',
  });
  assert.equal(q2.cache.hit, true, '重复查询命中缓存');
});

test('取消后不得提交 ready manifest', async () => {
  const { root, engine } = makeEngine({
    adapters: {
      extractFrames: async ({ signal }) => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
    },
  });
  const path = join(root, 'demo.mp4');
  writeFileSync(path, Buffer.from('x'));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => engine.index({
    source: { kind: 'file', path },
  }, { signal: ac.signal }));
  assert.equal(engine.list().length, 0);
});

test('ASR fake command 端到端；非法输出/超时/取消', async () => {
  const asrOk = createAsrAdapter({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        utterances: [
          { startMs: 0, endMs: 1500, text: '真实转写一句', confidence: 0.9 },
        ],
      }),
    }),
  });
  const { root, engine } = makeEngine({ adapters: { asr: asrOk, extractFrames: async () => [] } });
  const path = join(root, 'a.mp4');
  writeFileSync(path, Buffer.from('x'));
  const r = await engine.index({
    source: { kind: 'file', path },
  }, { capabilities: { asr: 'on', subtitles: 'off' }, skipStoryboard: true });
  assert.equal(r.manifest.capabilities.asr, 'ready');
  assert.ok(r.manifest.counts.utterances >= 1);

  const asrBad = createAsrAdapter({
    runner: async () => ({ code: 0, stdout: 'not-json' }),
  });
  const bad = await asrBad.analyze({ videoKey: 'v' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_json');

  const asrTimeout = createAsrAdapter({
    runner: async () => {
      const e = new Error('timeout');
      e.code = 'TIMEOUT';
      throw e;
    },
  });
  const t = await asrTimeout.analyze({ videoKey: 'v' });
  assert.equal(t.reason, 'timeout');

  const asrCancel = createAsrAdapter({
    runner: async (_p, { signal }) => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    },
  });
  const c = await asrCancel.analyze({ videoKey: 'v' }, { signal: AbortSignal.abort() });
  assert.equal(c.reason, 'cancelled');

  const asrFake = createAsrAdapter({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({ utterances: [{ startMs: 0, endMs: 1, text: 'TODO' }] }),
    }),
  });
  const f = await asrFake.analyze({ videoKey: 'v' });
  assert.equal(f.ok, false);
});

test('ASR-only 无字幕：生成轻量章节；讲了什么能拿到 utterance', async () => {
  const { root, engine } = makeEngine({
    adapters: {
      extractFrames: async () => [],
      asr: {
        name: 'asr-fake',
        version: '1',
        available: () => ({ ok: true }),
        analyze: async () => ({
          ok: true,
          utterances: [
            { startMs: 0, endMs: 1000, text: '开头讲架构', evidenceId: 'asr-1', utteranceId: 'u1' },
            { startMs: 5000, endMs: 6000, text: '中间讲实现', evidenceId: 'asr-2', utteranceId: 'u2' },
            { startMs: 20_000, endMs: 21_000, text: '结尾讲总结点', evidenceId: 'asr-3', utteranceId: 'u3' },
          ],
          evidence: [
            { evidenceId: 'asr-1', kind: 'asr', startMs: 0, endMs: 1000 },
            { evidenceId: 'asr-2', kind: 'asr', startMs: 5000, endMs: 6000 },
            { evidenceId: 'asr-3', kind: 'asr', startMs: 20_000, endMs: 21_000 },
          ],
        }),
      },
      extractAudio: async () => ({ ok: true, path: join(root, 'a.wav') }),
    },
  });
  writeFileSync(join(root, 'a.wav'), Buffer.from('RIFF'));
  const path = join(root, 'asr-only.mp4');
  writeFileSync(path, Buffer.from('x'));
  const r = await engine.index({
    source: { kind: 'file', path },
  }, { capabilities: { asr: 'on' }, skipStoryboard: true });
  const idx = engine.store.loadIndex(r.videoKey);
  assert.ok(idx.chapters.length >= 1);
  assert.ok(idx.chapters.every((c) => (c.evidenceIds || []).length > 0));
  assert.ok(!/本章总结|抽象摘要/.test(JSON.stringify(idx.chapters)));

  const q = engine.query({ videoKey: r.videoKey, question: '讲了什么', mode: 'text' });
  assert.ok(q.context.utterances.length >= 1 || q.context.chapters.length >= 1);
  const texts = JSON.stringify(q.context);
  assert.ok(/架构|实现|总结点/.test(texts));
});

test('无 ASR 时字幕查询仍可用；普通索引事件不进 cognition llm', async () => {
  const { root, engine } = makeEngine({
    adapters: {
      asr: createAsrAdapter({}), // unavailable
      extractFrames: async () => [{ t: 0, buf: solidFrame(16, 16, 1) }],
    },
  });
  const path = join(root, 's.mp4');
  writeFileSync(path, Buffer.from('x'));
  const r = await engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [{ startMs: 0, endMs: 1000, text: '只有字幕' }],
    },
  }, { width: 16, height: 16 });
  // 有字幕时默认跳过 ASR（skipped）；无字幕才会记 unavailable
  assert.ok(['skipped', 'unavailable'].includes(r.manifest.capabilities.asr));
  assert.notEqual(r.manifest.capabilities.asr, 'ready');
  const q = engine.query({ videoKey: r.videoKey, question: '字幕说了什么' });
  assert.ok(q.context.utterances.length >= 1 || q.context.chapters.length >= 1);

  const cog = engine._internals.evaluateCognition({ trigger: 'subtitle_added' });
  assert.notEqual(cog.decision, 'llm');
});

test('diarization 真正调用 audioVisual，speaker/segment 落盘并回填 utterance', async () => {
  let analyzeCalls = 0;
  const observations = [0, 1].map((i) => ({
    tMs: i * 1000,
    visibleFaceIds: ['face-a'],
    speakingFaceIds: ['face-a'],
    speakerClusterId: 'speaker-a',
    speechClear: true,
    speechMs: 1000,
    lipSyncOk: true,
    overlap: false,
    evidenceId: `av-${i}`,
  }));
  const audioVisual = {
    name: 'av-test',
    version: '1-test',
    available: () => ({ ok: true }),
    analyze: async (input) => {
      analyzeCalls += 1;
      assert.ok(input.audioPath);
      assert.equal(input.utterances.length, 1);
      return {
        ok: true,
        speakers: [{ speakerClusterId: 'speaker-a', totalMs: 2000 }],
        activeSegments: [{ startMs: 0, endMs: 2000, speakerClusterId: 'speaker-a' }],
        overlaps: [],
        observations,
      };
    },
  };
  const { root, engine } = makeEngine({
    adapters: { audioVisual, extractFrames: async () => [] },
  });
  const path = join(root, 'speaker.mp4');
  writeFileSync(path, Buffer.from('x'));
  const r = await engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [{ startMs: 0, endMs: 1500, text: '这是说话内容' }],
    },
  }, {
    capabilities: { diarization: 'on', identityBinding: 'on' },
    skipStoryboard: true,
  });

  assert.equal(analyzeCalls, 1);
  assert.equal(r.manifest.capabilities.diarization, 'ready');
  assert.equal(r.manifest.capabilities.identityBinding, 'ready');
  const index = engine.store.loadIndex(r.videoKey);
  assert.ok(index.audioIndex.some((x) => x.kind === 'speaker' && x.speakerClusterId === 'speaker-a'));
  assert.ok(index.audioIndex.some((x) => x.kind === 'active_segment'));
  assert.equal(index.utterances[0].speakerClusterId, 'speaker-a');
  assert.ok(index.entityOverview.length >= 1);
});

test('未调用或失败的 audioVisual 不得把 diarization 标成 ready', async () => {
  const audioVisual = {
    name: 'av-fail',
    version: '1',
    available: () => ({ ok: true }),
    analyze: async () => ({ ok: false, reason: 'failed', speakers: [], activeSegments: [] }),
  };
  const { root, engine } = makeEngine({ adapters: { audioVisual, extractFrames: async () => [] } });
  const path = join(root, 'speaker-fail.mp4');
  writeFileSync(path, Buffer.from('x'));
  const r = await engine.index({
    source: { kind: 'file', path, subtitles: [{ startMs: 0, endMs: 1000, text: '一句话' }] },
  }, { capabilities: { diarization: 'on' }, skipStoryboard: true });
  assert.equal(r.manifest.capabilities.diarization, 'degraded');
  assert.notEqual(r.manifest.capabilities.diarization, 'ready');
});

test('已有索引缺少请求 capability 时不得复用；新 identityObservations 也必须重建', async () => {
  let analyzeCalls = 0;
  const audioVisual = {
    name: 'av-reuse',
    version: '1',
    available: () => ({ ok: true }),
    analyze: async () => {
      analyzeCalls += 1;
      return {
        ok: true,
        speakers: [{ speakerClusterId: 'speaker-a' }],
        activeSegments: [],
        overlaps: [],
        observations: [],
      };
    },
  };
  const { root, engine } = makeEngine({ adapters: { audioVisual, extractFrames: async () => [] } });
  const path = join(root, 'reuse-cap.mp4');
  writeFileSync(path, Buffer.from('x'));
  const source = { kind: 'file', path, subtitles: [{ startMs: 0, endMs: 1000, text: '一句话' }] };

  const first = await engine.index({ source }, { skipStoryboard: true });
  assert.equal(first.reused, false);
  assert.equal(analyzeCalls, 0);

  const upgraded = await engine.index({ source }, {
    capabilities: { diarization: 'on' },
    skipStoryboard: true,
  });
  assert.equal(upgraded.reused, false);
  assert.equal(analyzeCalls, 1);
  assert.equal(upgraded.manifest.capabilities.diarization, 'ready');

  const withIdentity = await engine.index({ source }, {
    capabilities: { diarization: 'on' },
    identityObservations: [{
      tMs: 0,
      visibleFaceIds: [],
      speakingFaceIds: [],
      speakerClusterId: 'speaker-a',
      speechClear: true,
      speechMs: 1000,
      lipSyncOk: null,
      overlap: false,
      evidenceId: 'identity-new',
    }],
    skipStoryboard: true,
  });
  assert.equal(withIdentity.reused, false);
  assert.equal(analyzeCalls, 2);
  // 纯音频 observation、无人脸 → 不得标 ready
  assert.equal(withIdentity.manifest.capabilities.identityBinding, 'degraded');
});

test('视觉查询优先 storyboard；zoom 受预算约束', async () => {
  const { root, engine } = makeEngine();
  const path = join(root, 'v.mp4');
  writeFileSync(path, Buffer.from('x'));
  const r = await engine.index({
    source: { kind: 'file', path, subtitles: [{ startMs: 0, endMs: 500, text: 'hi' }] },
  }, { width: 32, height: 32 });

  const q = engine.query({ videoKey: r.videoKey, question: '画面里是什么', mode: 'visual' });
  assert.equal(q.queryType, 'visual');
  assert.ok(q.visualEvidence.length >= 1);

  const z = await engine.zoom({
    videoKey: r.videoKey,
    startMs: 0,
    endMs: 3000,
    budget: { maxZoomRequests: 2 },
  });
  assert.equal(z.ok, true);
  // 已有 storyboard 覆盖该范围时应 reuse
  assert.equal(z.reused, true);

  const z2 = await engine.zoom({
    videoKey: r.videoKey,
    startMs: 999000,
    endMs: 999100,
    budget: { maxZoomRequests: 0 },
  });
  assert.equal(z2.ok, false);
  assert.equal(z2.reason, 'zoom_budget_exhausted');
});

test('remove 精确删除；evidence 路径安全', async () => {
  const { root, engine } = makeEngine({
    adapters: { extractFrames: async () => [] },
  });
  const path = join(root, 'r.mp4');
  writeFileSync(path, Buffer.from('x'));
  const r = await engine.index({
    source: { kind: 'file', path, subtitles: [{ startMs: 0, endMs: 1, text: 'a' }] },
  }, { skipStoryboard: true });
  const ev = engine.getEvidence({ videoKey: r.videoKey });
  assert.equal(ev.ok, true);
  const rm = engine.remove(r.videoKey);
  assert.equal(rm.removed, true);
  assert.equal(engine.status(r.videoKey).ok, false);
});

// 避免 unused lint-style noise
void encodePng;
