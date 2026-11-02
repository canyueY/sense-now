import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpeakerViews, buildPersonCards, buildAsrChapterSkeleton,
  classifyIdentityBindingCapability, SPEAKER_VIEW_HARD,
} from '../src/video-index/speaker-view.js';
import { buildMinimalIndexPackage, buildFullEvidencePackage, applyFullEvidenceBudget } from '../src/video-index/evidence-package.js';
import { retrieve, retrieveSpeakerAwareUtterances, sampleStructureUtterances } from '../src/video-index/index-retriever.js';
import { buildContext } from '../src/video-index/context-builder.js';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const audioIndexTwo = [
  { kind: 'speaker', speakerClusterId: 'SPEAKER_00', totalMs: 5000, segmentCount: 2 },
  { kind: 'speaker', speakerClusterId: 'SPEAKER_01', totalMs: 3000, segmentCount: 1 },
  { kind: 'active_segment', speakerClusterId: 'SPEAKER_00', startMs: 0, endMs: 2000 },
  { kind: 'active_segment', speakerClusterId: 'SPEAKER_00', startMs: 4000, endMs: 7000 },
  { kind: 'active_segment', speakerClusterId: 'SPEAKER_01', startMs: 2000, endMs: 5000 },
  { kind: 'overlap', speakerClusterId: 'SPEAKER_00', startMs: 2000, endMs: 2500 },
];

test('buildSpeakerViews：两个 speaker 含 totalMs 与时间范围', () => {
  const { speakers } = buildSpeakerViews(audioIndexTwo);
  assert.equal(speakers.length, 2);
  const a = speakers.find((s) => s.speakerClusterId === 'SPEAKER_00');
  assert.equal(a.totalMs, 5000);
  assert.ok(a.timeRanges.some((r) => r.startMs === 0 && r.endMs === 2000));
  assert.ok(a.overlapMs >= 500);
});

test('buildSpeakerViews：无 audioIndex 返回空；硬上限截断', () => {
  assert.deepEqual(buildSpeakerViews([]).speakers, []);
  const many = Array.from({ length: 20 }, (_, i) => ({
    kind: 'speaker', speakerClusterId: `S${i}`, totalMs: 1000 - i,
  }));
  const { speakers, truncated } = buildSpeakerViews(many, { maxSpeakers: 3 });
  assert.equal(speakers.length, 3);
  assert.equal(truncated, true);
  assert.ok(speakers.length <= SPEAKER_VIEW_HARD.maxSpeakers);
});

test('full package 按时间范围过滤 active segments', () => {
  const index = {
    manifest: {
      schemaVersion: '1.1', indexVersion: 'v1', videoKey: 'file:x:a.mp4',
      source: { kind: 'file' }, versions: {}, capabilities: {},
    },
    metadata: {}, chapters: [], topics: [], keyMoments: [], entityOverview: [],
    events: [], subtitles: [], utterances: [], timeline: [], storyboardIndex: [],
    evidenceIndex: [], entityTracks: [],
    audioIndex: audioIndexTwo,
  };
  const pack = buildFullEvidencePackage(index, { startMs: 4500, endMs: 8000 });
  assert.ok(pack.speakers.some((s) => s.speakerClusterId === 'SPEAKER_00'));
  const a = pack.speakers.find((s) => s.speakerClusterId === 'SPEAKER_00');
  assert.ok(a.timeRanges.every((r) => r.endMs >= 4500 && r.startMs <= 8000));
  const mini = buildMinimalIndexPackage(index);
  assert.ok(mini.speakers.length >= 1);
});

test('ASR-only 轻量章节：真实原文 title，evidenceIds 来自 utterance', () => {
  const utts = [
    { startMs: 0, endMs: 1000, text: '开场白一二三', evidenceId: 'e1' },
    { startMs: 2000, endMs: 3000, text: '中间内容', evidenceId: 'e2' },
    { startMs: 20_000, endMs: 21_000, text: '结尾段落', evidenceId: 'e3' },
  ];
  const chapters = buildAsrChapterSkeleton(utts, {
    videoKey: 'file:x:a.mp4', indexVersion: 'v1', gapMs: 5000,
  });
  assert.ok(chapters.length >= 2);
  assert.ok(chapters.every((c) => (c.evidenceIds || []).every((id) => ['e1', 'e2', 'e3'].includes(id))));
  assert.ok(chapters[0].title.includes('开场'));
  assert.equal(chapters[0].summary, '');
  assert.ok(!/总结|摘要/.test(JSON.stringify(chapters)));
});

test('text_structure fallback：前中后抽样，不伪装关键词命中', () => {
  const utts = Array.from({ length: 9 }, (_, i) => ({
    text: `段${i}`, startMs: i * 1000, endMs: i * 1000 + 500, evidenceId: `e${i}`,
  }));
  const sampled = sampleStructureUtterances(utts, 3);
  assert.equal(sampled.length, 3);
  assert.ok(sampled.some((u) => u.evidenceId === 'e0'));
  assert.ok(sampled.some((u) => u.evidenceId === 'e8'));
  assert.ok(sampled.every((u) => u._score === 0.1 && u._reasons.includes('asr_structure_fallback')));

  const r = retrieve({
    metadata: {}, chapters: [], events: [], storyboardIndex: [],
    utterances: utts,
  }, { question: '讲了什么', queryType: 'text_structure', maxUtterances: 5 });
  assert.ok(r.utterances.length >= 3);
  assert.ok(r.reasons.includes('asr_structure_fallback'));
});

test('multimodal 部分命中仍覆盖各 speaker', () => {
  const utts = [
    { utteranceId: 'u0', text: '另一个人打招呼', startMs: 0, endMs: 100, evidenceId: 'e0', speakerClusterId: 'A' },
    { utteranceId: 'u1', text: '我是第二位嘉宾', startMs: 200, endMs: 400, evidenceId: 'e1', speakerClusterId: 'B' },
    { utteranceId: 'u2', text: '主持人串场', startMs: 500, endMs: 700, evidenceId: 'e2', speakerClusterId: 'C' },
  ];
  const r = retrieve({
    metadata: {}, chapters: [], events: [], storyboardIndex: [], utterances: utts,
  }, { question: '哪个人在说话', queryType: 'multimodal', maxUtterances: 12 });
  const speakers = new Set(r.utterances.map((u) => u.speakerClusterId));
  assert.ok(speakers.has('A') && speakers.has('B') && speakers.has('C'));
  assert.ok(r.reasons.includes('speaker_grouped_retrieval'));

  const budget = retrieveSpeakerAwareUtterances(utts, [], { maxUtterances: 2 });
  assert.equal(budget.utterances.length, 2);
  assert.equal(budget.truncated, true);
  assert.ok(budget.reasons.includes('speaker_budget_truncated'));
});

test('query.context 含 speakers 与匿名 persons，无生物特征', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-spk-q-'));
  const observations = [0, 1].map((i) => ({
    tMs: i * 1000,
    visibleFaceIds: ['face-a'],
    speakingFaceIds: ['face-a'],
    speakerClusterId: 'SPEAKER_00',
    speechClear: true,
    speechMs: 1000,
    lipSyncOk: true,
    overlap: false,
    evidenceId: `av-${i}`,
  }));
  const engine = createVideoIndexEngine({
    rootDir: root,
    adapters: {
      extractFrames: async () => [],
      audioVisual: {
        name: 'av',
        version: '1',
        available: () => ({ ok: true }),
        analyze: async () => ({
          ok: true,
          speakers: [
            { speakerClusterId: 'SPEAKER_00', totalMs: 2000 },
            { speakerClusterId: 'SPEAKER_01', totalMs: 1000 },
          ],
          activeSegments: [
            { startMs: 0, endMs: 2000, speakerClusterId: 'SPEAKER_00' },
            { startMs: 2000, endMs: 3000, speakerClusterId: 'SPEAKER_01' },
          ],
          overlaps: [],
          observations,
        }),
      },
    },
  });
  const path = join(root, 'v.mp4');
  writeFileSync(path, Buffer.from('x'));
  const indexed = await engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [
        { startMs: 0, endMs: 1500, text: '第一位说话' },
        { startMs: 2000, endMs: 2800, text: '第二位说话' },
      ],
    },
  }, { capabilities: { diarization: 'on', identityBinding: 'on' }, skipStoryboard: true });

  const q = engine.query({
    videoKey: indexed.videoKey,
    question: '分别有哪些人在说话',
    mode: 'multimodal',
  });
  assert.ok(q.context.speakers.length >= 2);
  assert.ok(q.context.persons.length >= 1);
  assert.equal(q.context.persons[0].bindingState, 'confirmed');
  assert.ok(q.context.persons[0].timeRanges.length >= 1);
  const blob = JSON.stringify(q.context);
  assert.ok(!/embedding|voiceprint|rawFace|faceVector/i.test(blob));
  assert.equal(indexed.manifest.capabilities.identityBinding, 'ready');
});

test('纯音频 identityBinding 不得 ready；空 persons + observations → degraded', () => {
  assert.equal(classifyIdentityBindingCapability({
    requested: true,
    ranResolver: true,
    persons: [{ faceTrackIds: [], speakerClusterIds: ['S1'] }],
    observationsCount: 2,
  }), 'degraded');
  assert.equal(classifyIdentityBindingCapability({
    requested: true,
    ranResolver: true,
    persons: [],
    observationsCount: 3,
  }), 'degraded');
  assert.equal(classifyIdentityBindingCapability({
    requested: true,
    ranResolver: true,
    persons: [{ faceTrackIds: ['F1'], speakerClusterIds: ['S1'] }],
    observationsCount: 2,
  }), 'ready');
  assert.equal(classifyIdentityBindingCapability({
    requested: false,
    ranResolver: false,
    persons: [],
    observationsCount: 0,
  }), 'unavailable');
});

test('buildPersonCards 不升级 conflict；数量硬限', () => {
  const cards = buildPersonCards([
    {
      personId: 'P1', bindingState: 'conflict', confidence: 0.3,
      faceTrackIds: ['F1'], speakerClusterIds: ['S1'], evidenceIds: ['e1'],
      embedding: 'SECRET', voiceprint: 'SECRET',
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      personId: `PX${i}`, bindingState: 'tentative', faceTrackIds: [], speakerClusterIds: [`S${i}`], evidenceIds: [],
    })),
  ], audioIndexTwo, { maxPersons: 3 });
  assert.equal(cards.persons[0].bindingState, 'conflict');
  assert.equal(cards.persons.length, 3);
  assert.ok(!('embedding' in cards.persons[0]));
  assert.ok(!('voiceprint' in cards.persons[0]));
});

test('context-builder 输出 speakers/persons 字段', () => {
  const r = buildContext({
    retrieval: {
      metadata: {},
      chapters: [],
      events: [],
      utterances: [{ text: 'hi', evidenceId: 'u1', speakerClusterId: 'SPEAKER_00' }],
      storyboardUnits: [],
      reasons: [],
    },
    queryType: 'multimodal',
    question: '谁在说话',
    audioIndex: audioIndexTwo,
    entityOverview: [{
      personId: 'P1', bindingState: 'tentative', confidence: 0.5,
      faceTrackIds: [], speakerClusterIds: ['SPEAKER_00'], evidenceIds: ['e1'],
      label: '疑似主讲人/旁白', labelSource: 'inference',
    }],
  });
  assert.ok(r.context.speakers.length >= 1);
  assert.ok(r.context.persons.length >= 1);
  assert.equal(r.context.persons[0].bindingState, 'tentative');
});

test('applyFullEvidenceBudget 截断 speakers', () => {
  const index = {
    manifest: {
      schemaVersion: '1.1', indexVersion: 'v1', videoKey: 'file:x:a.mp4',
      source: { kind: 'file' }, versions: {}, capabilities: {},
    },
    metadata: {}, chapters: [], topics: [], keyMoments: [], entityOverview: [],
    events: [], subtitles: [], utterances: [], timeline: [], storyboardIndex: [],
    evidenceIndex: [], entityTracks: [],
    audioIndex: Array.from({ length: 12 }, (_, i) => ({
      kind: 'speaker', speakerClusterId: `SP${i}`, totalMs: 100 * (12 - i),
    })),
  };
  const raw = buildFullEvidencePackage(index, { startMs: 0, endMs: 999999 });
  const pack = applyFullEvidenceBudget(raw, { maxSpeakers: 2 });
  assert.ok(pack.speakers.length <= SPEAKER_VIEW_HARD.maxSpeakers);
  assert.ok(pack.budget.limits.maxSp <= SPEAKER_VIEW_HARD.maxSpeakers);
});
