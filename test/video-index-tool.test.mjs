import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoIndexTool, QUERY_TEXT_LIMITS } from '../src/video-index-tool.js';
import {
  buildMinimalIndexPackage,
  buildFullEvidencePackage,
  buildMnemosyneCandidate,
  applyFullEvidenceBudget,
  sanitizeEvidenceIds,
  FULL_EVIDENCE_HARD,
} from '../src/video-index/evidence-package.js';
import { estimateTextTokens } from '../src/video-index/token-gate.js';

function badJson(v, path = '$') {
  if (v === undefined) return `${path} is undefined`;
  if (typeof v === 'number' && !Number.isFinite(v)) return `${path} = ${v}`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const r = badJson(v[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      const r = badJson(val, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

test('video_index 工具：index/query/list/remove 返回无损 JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-tool-'));
  const path = join(root, 'clip.mp4');
  writeFileSync(path, Buffer.from('x'));
  const tool = createVideoIndexTool({
    rootDir: root,
    adapters: {
      extractFrames: async () => [{
        t: 0,
        buf: Buffer.alloc(8 * 8 * 3, 40),
      }],
    },
  });

  const indexed = await tool.execute({
    action: 'index',
    source: 'file',
    path,
    // pass subtitles via engine by indexing through custom — tool only passes path
  });
  // 无字幕时仍应成功（degraded 可接受）
  assert.equal(badJson(indexed), null);
  assert.ok(indexed.meta?.videoKey || indexed.meta?.ok === false || indexed.text);

  // 直接用 engine 建带字幕索引，再走工具 query
  const eng = tool.engine;
  const r = await eng.index({
    source: {
      kind: 'file',
      path,
      subtitles: [{ startMs: 0, endMs: 1000, text: '核心概念介绍' }],
    },
  }, { width: 8, height: 8, rebuild: true });

  const q = await tool.execute({
    action: 'query',
    videoKey: r.videoKey,
    question: '讲了什么',
  });
  assert.equal(badJson(q), null);
  assert.ok(!('images' in q) || q.images === undefined, '文本问题应省略 images，不能是 null');
  assert.notEqual(q.images, null);

  const listed = await tool.execute({ action: 'list' });
  assert.equal(badJson(listed), null);

  const rem = await tool.execute({ action: 'remove', videoKey: r.videoKey });
  assert.equal(badJson(rem), null);
  assert.match(rem.text, /删除|没有/);
});

test('remove 无 videoKey 时拒绝；未知 action 列清单', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-tool2-'));
  const tool = createVideoIndexTool({
    rootDir: root,
    adapters: { extractFrames: async () => [] },
  });
  const rem = await tool.execute({ action: 'remove' });
  assert.match(rem.text, /videoKey/);
  const unk = await tool.execute({ action: 'dance' });
  assert.match(unk.text, /未知 action/);
  assert.match(unk.text, /index/);
});

test('video_index index 透传 capabilities 与 identityObservations', async () => {
  let received = null;
  const engine = {
    async indexAdaptive(input) {
      received = input;
      return {
        ok: true,
        background: false,
        sync: true,
        reused: false,
        videoKey: 'file:tool:pass.mp4',
        manifest: { status: 'ready', capabilities: {} },
      };
    },
  };
  const tool = createVideoIndexTool({ rootDir: 'unused-for-injected-engine', engine });
  const observation = { tMs: 0, speakerClusterId: 'speaker-a' };
  const result = await tool.execute({
    action: 'index',
    source: 'file',
    path: 'pass.mp4',
    capabilities: { diarization: 'on', identityBinding: 'on' },
    identityObservations: [observation],
  });
  assert.equal(result.meta.videoKey, 'file:tool:pass.mp4');
  assert.deepEqual(received.capabilities, { diarization: 'on', identityBinding: 'on' });
  assert.deepEqual(received.indexOptions?.identityObservations, [observation]);
});

test('Minimal / Full evidence package 与 Mnemosyne 候选边界', () => {
  const index = {
    manifest: {
      schemaVersion: '1.1',
      indexVersion: 'v1',
      videoKey: 'file:x:a.mp4',
      source: { kind: 'file' },
      versions: { pipeline: '0.0.5+', retrieval: '1', adapters: {} },
      capabilities: {},
    },
    metadata: { title: 't' },
    chapters: [{ chapterId: 'c1', startMs: 0, endMs: 1000, evidenceIds: ['e1'], title: '', topicTags: [] }],
    topics: [],
    keyMoments: [],
    entityOverview: [],
    events: [{ eventId: 'ev1', startMs: 0, endMs: 500, evidenceIds: ['e1'], summary: 'a' }],
    subtitles: [{ startMs: 0, endMs: 500, text: 'hi', evidenceIds: ['e1'] }],
    utterances: [{ startMs: 0, endMs: 500, text: 'hi', evidenceId: 'e1' }],
    timeline: [{ startMs: 0, endMs: 500, eventId: 'ev1' }],
    storyboardIndex: [{ frameId: 'F1', timestampMs: 0, evidenceIds: ['e1'], imageRef: 'evidence://x/frame/F1' }],
    evidenceIndex: [{ evidenceId: 'e1', startMs: 0, endMs: 500 }],
    entityTracks: [],
  };
  const mini = buildMinimalIndexPackage(index);
  assert.equal(mini.kind, 'minimal');
  assert.ok(mini.chapters[0].evidenceIds.includes('e1'));

  const full = buildFullEvidencePackage(index, { startMs: 0, endMs: 600 });
  assert.equal(full.kind, 'full');
  assert.ok(full.subtitles.length >= 1);
  assert.deepEqual(full.identity, [], '默认不带 identity');

  const withId = buildFullEvidencePackage(index, {
    startMs: 0, endMs: 600, includeIdentity: true,
  });
  assert.ok(Array.isArray(withId.identity));

  const scoped = buildFullEvidencePackage(index, { startMs: 9000, endMs: 10000 });
  assert.equal(scoped.subtitles.length, 0);

  // 仅传不存在的 evidenceId 不得带回完整 timeline
  const badId = buildFullEvidencePackage(index, {
    evidenceIds: ['no-such-id'],
  });
  assert.equal(badId.timeline.length, 0);
  assert.equal(badId.subtitles.length, 0);
  assert.equal(badId.evidence.length, 0);

  // timeline 仅有 eventId 时，经 event.evidenceIds 关联
  const byEvent = buildFullEvidencePackage(index, { evidenceIds: ['e1'] });
  assert.equal(byEvent.timeline.length, 1);
  assert.equal(byEvent.timeline[0].eventId, 'ev1');

  // timeline 自带 evidenceIds
  const withOwn = buildFullEvidencePackage({
    ...index,
    timeline: [{ startMs: 0, endMs: 500, evidenceIds: ['e1'] }],
  }, { evidenceIds: ['e1'] });
  assert.equal(withOwn.timeline.length, 1);

  // range + evidenceIds 同时满足
  const both = buildFullEvidencePackage(index, {
    startMs: 0, endMs: 100, evidenceIds: ['e1'],
  });
  assert.equal(both.timeline.length, 1);
  const bothMiss = buildFullEvidencePackage(index, {
    startMs: 9000, endMs: 10000, evidenceIds: ['e1'],
  });
  assert.equal(bothMiss.timeline.length, 0);

  const no = buildMnemosyneCandidate({
    videoKey: 'file:x:a.mp4',
    selectedClaim: 'claim',
    evidenceIds: ['e1'],
    userConfirmed: false,
  });
  assert.equal(no.ok, false);
  assert.equal(no.saved, false);

  const yes = buildMnemosyneCandidate({
    videoKey: 'file:x:a.mp4',
    selectedClaim: 'claim',
    evidenceIds: ['e1'],
    userConfirmed: true,
    indexVersion: 'v1',
  });
  assert.equal(yes.ok, true);
  assert.equal(yes.saved, false);
  assert.equal(yes.claimCandidate.notKnowledge, true);
});

test('evidence package:full 无范围拒绝；有范围才展开', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-full-'));
  const path = join(root, 'clip.mp4');
  writeFileSync(path, Buffer.from('x'));
  const tool = createVideoIndexTool({
    rootDir: root,
    adapters: { extractFrames: async () => [] },
  });
  const r = await tool.engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [{ startMs: 0, endMs: 500, text: '范围证据' }],
    },
  }, { skipStoryboard: true });

  const denied = await tool.execute({
    action: 'evidence',
    videoKey: r.videoKey,
    package: 'full',
  });
  assert.equal(denied.meta?.ok, false);
  assert.equal(denied.meta?.reason, 'scope_required');

  const ok = await tool.execute({
    action: 'evidence',
    videoKey: r.videoKey,
    package: 'full',
    startMs: 0,
    endMs: 1000,
    budget: { maxUtterances: 5 },
  });
  assert.equal(ok.meta?.kind, 'full');
  assert.ok(ok.meta?.budget);
  assert.deepEqual(ok.meta?.identity, []);

  const bypass = await tool.execute({
    action: 'evidence',
    videoKey: r.videoKey,
    package: 'full',
    startMs: 0,
    endMs: 1000,
    budget: { maxUtterances: 1e9, maxEvents: 1e9, maxStoryboardUnits: 1e9, maxTextTokens: 1e9 },
  });
  assert.ok(bypass.meta?.budget?.limits?.maxU <= 40);
  assert.ok(bypass.meta?.budget?.limits?.maxTextTokens <= FULL_EVIDENCE_HARD.maxTextTokens);
  assert.ok(bypass.meta?.budget?.limits?.hard);
});

test('Full Evidence：maxTextTokens 与超长字段硬预算', () => {
  const huge = '汉'.repeat(200_000);
  const index = {
    manifest: {
      schemaVersion: '1.1',
      indexVersion: 'v1',
      videoKey: 'file:x:huge.mp4',
      source: { kind: 'file' },
      versions: { pipeline: '0.0.5+', retrieval: '1', adapters: {} },
      capabilities: {},
    },
    metadata: {},
    chapters: [],
    topics: [],
    keyMoments: [],
    entityOverview: [],
    events: [{ eventId: 'ev1', startMs: 0, endMs: 500, evidenceIds: ['e1'], summary: huge }],
    subtitles: [{ startMs: 0, endMs: 500, text: huge, evidenceIds: ['e1'] }],
    utterances: [{ startMs: 0, endMs: 500, text: huge, evidenceId: 'e1' }],
    timeline: [{ startMs: 0, endMs: 500, eventId: 'ev1' }],
    storyboardIndex: [],
    evidenceIndex: [{ evidenceId: 'e1', startMs: 0, endMs: 500, text: huge }],
    entityTracks: [],
  };
  const raw = buildFullEvidencePackage(index, { startMs: 0, endMs: 1000 });
  const pack = applyFullEvidenceBudget(raw, { maxTextTokens: 10 });
  assert.equal(pack.budget.truncated, true);
  assert.ok(pack.budget.estimatedTextTokens <= 10 + 2, '不得明显超过 maxTextTokens');
  const blob = JSON.stringify(pack);
  assert.ok(blob.length < 50_000, `体积应受控，实际 ${blob.length}`);
  assert.ok(!blob.includes(huge.slice(0, 1000)));
  assert.doesNotThrow(() => JSON.parse(blob));

  const single = applyFullEvidenceBudget(
    buildFullEvidencePackage({
      ...index,
      subtitles: [{ startMs: 0, endMs: 100, text: '字'.repeat(50_000), evidenceIds: ['e1'] }],
      utterances: [],
      events: [],
      evidenceIndex: [{ evidenceId: 'e1', startMs: 0, endMs: 100 }],
    }, { startMs: 0, endMs: 200 }),
    { maxTextTokens: 5 },
  );
  assert.equal(single.budget.truncated, true);
  assert.ok(single.budget.fields.textTokens || single.budget.fields.subtitles);

  const manyIds = Array.from({ length: 10_000 }, (_, i) => `e${i}`);
  const san = sanitizeEvidenceIds(manyIds);
  assert.ok(san.ids.length <= FULL_EVIDENCE_HARD.maxEvidenceIds);
  assert.equal(san.truncated, true);
  const idPack = applyFullEvidenceBudget(
    buildFullEvidencePackage(index, { evidenceIds: manyIds }),
    { maxTextTokens: 100 },
  );
  assert.ok((idPack.evidenceIds || []).length <= FULL_EVIDENCE_HARD.maxEvidenceIds);
  assert.ok(JSON.stringify(idPack).length < 200_000);

  const tiny = applyFullEvidenceBudget(
    buildFullEvidencePackage({
      ...index,
      subtitles: [{ startMs: 0, endMs: 100, text: '短', evidenceIds: ['e1'] }],
      utterances: [{ startMs: 0, endMs: 100, text: '短句', evidenceId: 'e1' }],
      events: [{ eventId: 'ev1', startMs: 0, endMs: 100, evidenceIds: ['e1'], summary: 'ok' }],
      evidenceIndex: [{ evidenceId: 'e1', startMs: 0, endMs: 100 }],
    }, { startMs: 0, endMs: 200 }),
    {},
  );
  assert.equal(tiny.budget.truncated, false);
  assert.equal(tiny.subtitles[0].text, '短');
  assert.ok(tiny.budget.estimatedTextTokens >= estimateTextTokens('短'));

  for (const bad of [1e9, Infinity, NaN, -1, 'nope', null]) {
    const p = applyFullEvidenceBudget(raw, { maxTextTokens: bad });
    assert.ok(p.budget.limits.maxTextTokens <= FULL_EVIDENCE_HARD.maxTextTokens);
    assert.ok(Number.isFinite(p.budget.limits.maxTextTokens));
  }
});

test('query 文本通道包含带时间戳的台词与 EVID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-qtext-'));
  const path = join(root, 'clip.mp4');
  writeFileSync(path, Buffer.from('x'));
  const tool = createVideoIndexTool({
    rootDir: root,
    adapters: { extractFrames: async () => [] },
  });
  const r = await tool.engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [
        { startMs: 10_000, endMs: 15_000, text: '后一句台词\n换行应折叠' },
        { startMs: 4_000, endMs: 10_000, text: '先一句台词' },
      ],
    },
  }, { skipStoryboard: true, rebuild: true });
  const q = await tool.execute({
    action: 'query',
    videoKey: r.videoKey,
    question: '讲了什么',
  });
  assert.equal(badJson(q), null);
  assert.ok(q.meta?.citations);
  const evids = [...q.text.matchAll(/EVID_[0-9a-f]+/g)].map((m) => m[0]);
  assert.ok(evids.length >= 2);
  const first = q.text.indexOf('先一句台词');
  const second = q.text.indexOf('后一句台词');
  assert.ok(first >= 0 && second > first, 'utterances 按 startMs 升序');
  assert.equal(q.text.includes('\n\n'), false);
  assert.match(q.text, /\[00:04–00:10\].*先一句台词/);
  assert.ok(!q.text.includes('换行应折叠\n') && q.text.includes('后一句台词 换行应折叠'));
});

test('query 文本最多展开 12 条并报告省略数', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-qomit-'));
  const path = join(root, 'clip.mp4');
  writeFileSync(path, Buffer.from('x'));
  const tool = createVideoIndexTool({
    rootDir: root,
    adapters: { extractFrames: async () => [] },
  });
  const subtitles = Array.from({ length: 30 }, (_, i) => ({
    startMs: i * 1000,
    endMs: i * 1000 + 800,
    text: `台词${String(i).padStart(2, '0')}`,
  }));
  const r = await tool.engine.index({
    source: { kind: 'file', path, subtitles },
  }, { skipStoryboard: true, rebuild: true, budget: { maxUtterances: 40, maxTextTokens: 8000 } });
  const q = await tool.execute({
    action: 'query',
    videoKey: r.videoKey,
    question: '讲了什么',
    budget: { maxUtterances: 40, maxTextTokens: 8000 },
  });
  const shown = (q.text.match(/台词\d{2}/g) || []).length;
  assert.equal(shown, QUERY_TEXT_LIMITS.maxUtterances);
  assert.match(q.text, /--- omitted ---\n剩余 18 条 utterance/);
});

test('visual 查询文本不展开台词', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-qvis-'));
  const path = join(root, 'clip.mp4');
  writeFileSync(path, Buffer.from('x'));
  const tool = createVideoIndexTool({
    rootDir: root,
    adapters: { extractFrames: async () => [] },
  });
  const r = await tool.engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [{ startMs: 0, endMs: 1000, text: '不该出现在视觉正文里的台词XYZ' }],
    },
  }, { skipStoryboard: true, rebuild: true });
  const q = await tool.execute({
    action: 'query',
    videoKey: r.videoKey,
    question: '画面里是什么',
    mode: 'visual',
  });
  assert.match(q.text, /visual evidence:/);
  assert.equal(q.text.includes('不该出现在视觉正文里的台词XYZ'), false);
  assert.ok(q.meta);
});

test('证据不足时文本写明且不编造 EVID', async () => {
  const tool = createVideoIndexTool({
    rootDir: mkdtempSync(join(tmpdir(), 'sense-now-qins-')),
    engine: {
      query() {
        return {
          ok: true,
          queryType: 'text_structure',
          decision: 'insufficient',
          reasons: ['no_hits'],
          context: { chapters: [], events: [], utterances: [] },
          visualEvidence: [],
          citations: [],
          budget: { truncated: false, omittedEvidenceIds: [] },
          cache: { hit: false },
        };
      },
    },
  });
  const q = await tool.execute({
    action: 'query',
    videoKey: 'file:none:empty.mp4',
    question: '没有的内容',
  });
  assert.match(q.text, /证据不足/);
  assert.equal(/EVID_/.test(q.text), false);
  assert.ok(q.meta);
});

test('索引没有文本证据时明确说明，而不是留两个空段', async () => {
  const tool = createVideoIndexTool({
    rootDir: mkdtempSync(join(tmpdir(), 'sense-now-qempty-')),
    engine: {
      query() {
        return {
          ok: true,
          queryType: 'text_structure',
          decision: 'llm',
          reasons: [],
          context: { chapters: [], events: [], utterances: [] },
          visualEvidence: [],
          citations: [],
          budget: { truncated: false, omittedEvidenceIds: [] },
          cache: { hit: false },
        };
      },
    },
  });
  const q = await tool.execute({
    action: 'query',
    videoKey: 'file:empty:empty.mp4',
    question: '这条视频讲了什么',
  });
  assert.match(q.text, /没有可引用的文本证据/);
  assert.equal(q.text.includes('--- utterances ---'), false);
});
