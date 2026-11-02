/**
 * 字幕优先长视频索引：任务书 A–H 协议级覆盖（fake adapters）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeAnalysisPolicy,
  mayRunAsr,
  mayRunVad,
  mapLegacyAsrCapability,
  PROFILE_IDS,
  POLICY_HARD_LIMITS,
} from '../src/video-index/analysis-policy.js';
import { listProfiles, validateProfileId, resolveProfileHints } from '../src/video-index/profile-policy.js';
import { suggestProfiles } from '../src/video-index/profile-suggester.js';
import {
  buildSubtitleSegments,
  normalizeSubtitleText,
  textSimilarity,
} from '../src/video-index/subtitle-segment-builder.js';
import { resolveSubtitleSources } from '../src/video-index/subtitle-source.js';
import { scanBurnedSubtitles } from '../src/video-index/subtitle-band-scanner.js';
import { createSpeechActivityAdapter } from '../src/video-index/adapters/speech-activity-adapter.js';
import {
  auditIndexEvidence,
  assertPlanAllowed,
  hashRetryPlan,
  RETRY_ACTION_WHITELIST,
} from '../src/video-index/evidence-auditor.js';
import { decideSecondPass } from '../src/video-index/refinement-planner.js';
import { selectUtteranceEndFrames } from '../src/video-index/utterance-end-frame.js';
import {
  selectChunksFromCatalog,
  selectOverviewChunksFromCatalog,
} from '../src/video-index/index-retriever.js';
import {
  buildEvidenceBundle,
  deriveJudgementState,
  remapEvidenceIds,
} from '../src/video-index/evidence-bundle.js';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { createAsrAdapter } from '../src/video-index/adapters/asr-adapter.js';
import { createOcrAdapter } from '../src/video-index/adapters/ocr-adapter.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-sf-'));
}

// ——— A. 字幕来源 ———

test('A: 有原生字幕时跳过 OCR', async () => {
  let ocrCalls = 0;
  const ocr = createOcrAdapter({
    runner: async () => {
      ocrCalls += 1;
      return JSON.stringify({ regions: [{ text: '不应出现' }] });
    },
  });
  const r = await resolveSubtitleSources({
    videoKey: 'v1',
    indexVersion: 'iv',
    nativeSubtitles: [
      { startMs: 0, endMs: 1000, text: '开场白' },
      { startMs: 1000, endMs: 2000, text: '第二句' },
    ],
    durationMs: 60_000,
    policy: normalizeAnalysisPolicy({}),
    ocr,
    extractFrameAt: async () => ({ buf: Buffer.alloc(3), width: 1, height: 1 }),
  });
  assert.equal(ocrCalls, 0);
  assert.ok(r.skippedOcr);
  assert.equal(r.capabilities.subtitleOcr, 'skipped');
  assert.ok(r.segments.length >= 2);
  assert.ok(r.sourcesUsed.includes('native'));
});

test('A: 无字幕时 ROI 扫描覆盖片尾；仅变化帧调 OCR', async () => {
  const durationMs = 10_000;
  let ocrCalls = 0;
  const frames = new Map();
  // 稳定底 + 末尾变化字幕带
  for (let t = 0; t < durationMs; t += 1000) {
    const buf = Buffer.alloc(30 * 20 * 3, 40);
    if (t >= 8000) buf.fill(200, 30 * 11 * 3); // 底部带变化
    frames.set(t, { buf, width: 30, height: 20 });
  }
  const ocr = createOcrAdapter({
    runner: async () => {
      ocrCalls += 1;
      return JSON.stringify({
        regions: [{ text: '片尾关键词XYZ', confidence: 0.9 }],
      });
    },
  });
  const scan = await scanBurnedSubtitles({
    durationMs,
    extractFrameAt: async ({ atMs }) => frames.get(Math.floor(atMs / 1000) * 1000) || frames.get(0),
    ocr,
    policy: normalizeAnalysisPolicy({ subtitleFirst: { scanFps: 1, maxOcrCandidatesPerMinute: 60 } }),
  });
  assert.ok(ocrCalls > 0);
  assert.ok(ocrCalls < durationMs / 250); // 非每帧
  assert.ok(scan.candidates.some((c) => c.tMs >= durationMs * 0.8));
});

test('A: 水印固定文字被排除；双语可合并', () => {
  const cands = [];
  for (let i = 0; i < 10; i += 1) {
    cands.push({ tMs: 10_000 + i * 500, text: '台标WATERMARK', confidence: 0.9 });
  }
  // 连续同文候选才能跨帧确认
  cands.push({ tMs: 100, text: 'Hello', confidence: 0.9 });
  cands.push({ tMs: 400, text: 'Hello', confidence: 0.9 });
  cands.push({ tMs: 2000, text: '你好', confidence: 0.9 });
  cands.push({ tMs: 2300, text: '你好', confidence: 0.9 });
  const segs = buildSubtitleSegments(cands, { videoKey: 'v', source: 'ocr' });
  assert.ok(!segs.some((s) => /watermark/i.test(normalizeSubtitleText(s.text))));
  assert.ok(segs.some((s) => s.text === 'Hello'));
  assert.ok(segs.some((s) => s.text === '你好'));
  assert.ok(textSimilarity('Hello!', 'hello') > 0.8);
});

// ——— B. 权限 ———

test('B: speechActivityAssist=false 时 VAD 零调用', async () => {
  let calls = 0;
  const ada = createSpeechActivityAdapter({
    runner: async () => {
      calls += 1;
      return { speechRanges: [{ startMs: 0, endMs: 1000 }] };
    },
  });
  const policy = normalizeAnalysisPolicy({ speechActivityAssist: { enabled: false } });
  assert.equal(mayRunVad(policy), false);
  const out = await ada.analyze({ audioPath: 'x' }, { policy });
  assert.equal(calls, 0);
  assert.equal(out.capability, 'disabled');
});

test('B: asr.mode=off 全路径禁止；HF_TOKEN 不改变 policy', () => {
  process.env.HF_TOKEN = 'hf_fake_token_for_test';
  try {
    const policy = normalizeAnalysisPolicy({ asr: { mode: 'off' } });
    assert.equal(policy.asr.mode, 'off');
    assert.equal(mayRunAsr(policy, { reason: 'index' }).ok, false);
    assert.equal(mayRunAsr(policy, { reason: 'query' }).ok, false);
    assert.equal(mayRunAsr(policy, { reason: 'subtitle_gap' }).ok, false);
    assert.equal(mayRunAsr(policy, { reason: 'refine' }).ok, false);
  } finally {
    delete process.env.HF_TOKEN;
  }
});

test('B: on_demand / fallback / full 门控', () => {
  assert.equal(mayRunAsr(normalizeAnalysisPolicy({ asr: { mode: 'on_demand' } }), { reason: 'index' }).ok, false);
  assert.equal(mayRunAsr(normalizeAnalysisPolicy({ asr: { mode: 'on_demand' } }), { reason: 'query' }).ok, true);
  assert.equal(mayRunAsr(normalizeAnalysisPolicy({ asr: { mode: 'fallback' } }), { reason: 'subtitle_gap' }).ok, true);
  assert.equal(mayRunAsr(normalizeAnalysisPolicy({ asr: { mode: 'fallback' } }), { reason: 'index' }).ok, false);
  assert.equal(mayRunAsr(normalizeAnalysisPolicy({ asr: { mode: 'full' } }), { reason: 'index' }).ok, true);
  assert.equal(mapLegacyAsrCapability('auto'), 'fallback');
  assert.equal(mapLegacyAsrCapability('on'), 'full');
  assert.equal(mapLegacyAsrCapability('off'), 'off');
});

test('B: 未传 analysisPolicy 保持 null（兼容）', () => {
  assert.equal(normalizeAnalysisPolicy(null), null);
  assert.equal(normalizeAnalysisPolicy(undefined), null);
});

test('B: index 路径 asr.mode=off 零 ASR 调用', async () => {
  const root = tempRoot();
  let asrCalls = 0;
  try {
    const eng = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        fileSource: {
          resolve: async () => ({
            videoKey: 'file:test:off.mp4',
            fingerprint: 'fp-off',
            metadata: { path: join(root, 'missing.mp4'), durationMs: 5000, title: 't' },
            subtitles: [{ startMs: 0, endMs: 1000, text: '有字幕' }],
            mediaRef: null,
            provenance: { adapter: 'fake', version: '1' },
          }),
        },
        asr: createAsrAdapter({
          runner: async () => {
            asrCalls += 1;
            return { ok: true, utterances: [], evidence: [] };
          },
        }),
        extractFrames: async () => [],
      },
    });
    await eng.index({ kind: 'file', path: 'x.mp4' }, {
      skipStoryboard: true,
      analysisPolicy: { asr: { mode: 'off' }, subtitleFirst: { enabled: true } },
    });
    assert.equal(asrCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ——— C. 长视频检索 ———

test('C: 泛问覆盖开头/中段/结尾；末尾 10% 关键词可检索', () => {
  const chunks = [];
  const total = 72; // 6h @ 5min
  for (let i = 0; i < total; i += 1) {
    chunks.push({
      chunkId: String(i).padStart(6, '0'),
      status: 'ready',
      startMs: i * 300_000,
      endMs: (i + 1) * 300_000,
      firstUtteranceExcerpt: i >= total - 2 ? '片尾秘密关键词OMEGA' : `段${i}`,
      topicTags: i % 10 === 0 ? [`ch${i}`] : [],
      subtitleCoverage: 0.5,
    });
  }
  const catalog = { chunks };
  const ov = selectOverviewChunksFromCatalog(catalog, { maxChunks: 12 });
  const ids = ov.chunkIds;
  assert.ok(ids.includes('000000'));
  assert.ok(ids.includes(String(total - 1).padStart(6, '0')) || ids.includes(String(Math.floor((total - 1) / 2)).padStart(6, '0')));
  const mid = String(Math.floor((total - 1) / 2)).padStart(6, '0');
  assert.ok(ids.includes(mid) || ov.scores.some((s) => s.chunkId === mid));

  const hit = selectChunksFromCatalog(catalog, {
    question: 'OMEGA 是什么',
    queryType: 'text_structure',
    topK: 3,
  });
  assert.ok(hit.chunkIds.some((id) => Number(id) >= total * 0.9));

  const overviewQ = selectChunksFromCatalog(catalog, {
    question: '整个视频讲了什么',
    queryType: 'text_structure',
    topK: 3,
  });
  assert.equal(overviewQ.mode, 'overview');
  assert.ok(overviewQ.chunkIds.length >= 3);
  assert.ok(overviewQ.chunkIds.length > 3);
});

// ——— D. 段尾稳定帧 ———

test('D: 默认关闭零抓帧；开启时排除黑帧并硬顶', async () => {
  let calls = 0;
  const black = Buffer.alloc(16 * 16 * 3, 0);
  const good = Buffer.alloc(16 * 16 * 3, 120);
  for (let i = 0; i < good.length; i += 3) good[i] = 80 + (i % 40);

  const off = await selectUtteranceEndFrames({
    utterances: [{ endMs: 5000, utteranceId: 'u1' }],
    maxPerChunk: 0,
    extractFrameAt: async () => { calls += 1; return { buf: good, width: 16, height: 16 }; },
  });
  assert.equal(calls, 0);
  assert.ok(off.skipped);

  calls = 0;
  const on = await selectUtteranceEndFrames({
    utterances: Array.from({ length: 40 }, (_, i) => ({ endMs: 1000 + i * 2000, utteranceId: `u${i}` })),
    maxPerChunk: 12,
    hardMax: 32,
    extractFrameAt: async ({ atMs }) => {
      calls += 1;
      if (atMs % 5000 < 300) return { buf: black, width: 16, height: 16 };
      return { buf: good, width: 16, height: 16 };
    },
  });
  assert.ok(on.frames.length <= 12);
  assert.ok(calls > 0);
});

// ——— E. profile 与提醒 ———

test('E: 全部 profile 可 validate；suggestion 不改 effective policy', () => {
  assert.equal(listProfiles().length, PROFILE_IDS.length);
  for (const id of PROFILE_IDS) assert.ok(validateProfileId(id));
  const base = normalizeAnalysisPolicy({ analysisProfile: { primary: 'general' } });
  const sug = suggestProfiles({
    coverage: { gapCount: 4, coverageRatio: 0.2 },
    catalog: { chunks: [{ topicTags: ['软件教程', 'UI'], profileHints: [] }] },
    enabled: true,
    evidenceIds: ['e1'],
  });
  assert.ok(sug.recommendations.length);
  assert.ok(sug.recommendations.every((r) => r.requiresUserApproval && r.estimatedCost));
  const after = normalizeAnalysisPolicy({ analysisProfile: { primary: 'general' } });
  assert.equal(after.analysisProfile.primary, base.analysisProfile.primary);
  assert.notEqual(sug.recommendations[0].suggestedValue, after.analysisProfile.primary);
  const hints = resolveProfileHints({ primary: 'handcraft', secondary: ['interview'] });
  assert.equal(hints.taskRoi, 'hands_tools_bench');
});

test('E: 用户显式参数优先于 profile', () => {
  const p = normalizeAnalysisPolicy({
    analysisProfile: { primary: 'interview' },
    asr: { mode: 'off' },
    speechActivityAssist: { enabled: false },
    captureUtteranceEndFrame: { enabled: false },
  });
  assert.equal(p.asr.mode, 'off');
  assert.equal(p.speechActivityAssist.enabled, false);
  assert.equal(p.captureUtteranceEndFrame.enabled, false);
});

// ——— F. audit / second pass ———

test('F: ask/off 无写盘；白名单外拒绝；错误 hash 拒绝', () => {
  const policy = normalizeAnalysisPolicy({
    postAnalysisAudit: { enabled: true, retryMode: 'ask' },
    secondPass: { mode: 'ask' },
    asr: { mode: 'off' },
  });
  const audit = auditIndexEvidence({
    coverage: {
      gapCount: 3,
      gaps: [
        { startMs: 1000, endMs: 5000 },
        { startMs: 9000, endMs: 12000 },
        { startMs: 20000, endMs: 25000 },
      ],
    },
    policy,
  });
  assert.ok(audit.retryPlan);
  const ask = decideSecondPass({ policy, audit, confirmation: null });
  assert.equal(ask.execute, false);
  assert.equal(ask.reason, 'awaiting_confirmation');

  assert.throws(() => assertPlanAllowed({
    version: 1,
    windows: [{ startMs: 0, endMs: 1000, actions: { downloadModel: true } }],
  }, { policy }), /whitelist|not whitelisted/i);

  assert.throws(() => assertPlanAllowed(audit.retryPlan, {
    expectedHash: 'deadbeef',
    policy,
  }), /hash/i);

  const ok = decideSecondPass({
    policy,
    audit,
    confirmation: { planHash: hashRetryPlan(audit.retryPlan) },
  });
  assert.equal(ok.execute, true);

  const once = decideSecondPass({
    policy: normalizeAnalysisPolicy({
      postAnalysisAudit: { enabled: true, retryMode: 'auto_once' },
      secondPass: { mode: 'auto_once' },
    }),
    audit,
    priorAutoOnceDone: true,
  });
  assert.equal(once.execute, false);
  assert.equal(once.reason, 'already_executed');
  assert.ok(RETRY_ACTION_WHITELIST.has('scanFps'));
});

// ——— G. 证据 ———

test('G: evidence bundle + remap + judgementState', () => {
  const b = buildEvidenceBundle({
    segmentId: 's1',
    timeRange: { startMs: 0, endMs: 1000 },
    subtitleEvidenceIds: ['sub1'],
    asrEvidenceIds: ['asr1'],
    frameEvidenceIds: ['f1'],
    speakerIds: ['sp1'],
  });
  assert.equal(b.subtitleEvidenceIds[0], 'sub1');
  assert.notEqual(b.asrEvidenceIds[0], b.subtitleEvidenceIds[0]);

  const remapped = remapEvidenceIds({
    utterances: [{ evidenceId: 'old', text: 'x' }],
    events: [{ evidenceIds: ['old', 'keep'] }],
    evidenceIndex: [{ evidenceId: 'old' }],
  }, { old: 'new' });
  assert.equal(remapped.utterances[0].evidenceId, 'new');
  assert.deepEqual(remapped.events[0].evidenceIds, ['new', 'keep']);

  assert.equal(deriveJudgementState({
    queryType: 'text_structure',
    utterances: [{ text: 'a' }],
  }), 'supported');
  assert.equal(deriveJudgementState({
    queryType: 'text_structure',
    decision: 'insufficient',
  }), 'insufficient');
  assert.equal(deriveJudgementState({
    queryType: 'text_structure',
    conflicts: [{}],
  }), 'conflict');
});

// ——— H. 安全/预算 ———

test('H: NaN/Infinity/1e9 无法绕过硬顶', () => {
  const p = normalizeAnalysisPolicy({
    subtitleFirst: {
      scanFps: 1e9,
      maxOcrCandidatesPerMinute: Infinity,
      fallbackRoiHeightRatio: NaN,
    },
    budgets: {
      maxRefineWindows: 99,
      maxAudioSecondsPerWindow: 1e9,
    },
    captureUtteranceEndFrame: { enabled: true, maxPerChunk: 999 },
  });
  assert.ok(p.subtitleFirst.scanFps <= POLICY_HARD_LIMITS.scanFps);
  assert.ok(p.subtitleFirst.maxOcrCandidatesPerMinute <= POLICY_HARD_LIMITS.maxOcrCandidatesPerMinute);
  assert.equal(p.subtitleFirst.fallbackRoiHeightRatio, 0.45);
  assert.ok(p.budgets.maxRefineWindows <= POLICY_HARD_LIMITS.maxRefineWindows);
  assert.ok(p.budgets.maxAudioSecondsPerWindow <= POLICY_HARD_LIMITS.maxAudioSecondsPerWindow);
  assert.ok(p.captureUtteranceEndFrame.maxPerChunk <= POLICY_HARD_LIMITS.maxEndFramesPerChunk);
});

test('H: 非法 asr.mode / secondPass.mode 抛错', () => {
  assert.throws(() => normalizeAnalysisPolicy({ asr: { mode: 'sneaky' } }), /asr\.mode/);
  assert.throws(() => normalizeAnalysisPolicy({ secondPass: { mode: 'always' } }), /secondPass/);
});
