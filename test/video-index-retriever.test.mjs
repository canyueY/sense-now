import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, tokenize } from '../src/video-index/index-retriever.js';

test('本地检索：关键词与时间定位可解释', () => {
  assert.ok(tokenize('系统设计 记忆').length >= 2);
  const index = {
    metadata: { title: '记忆架构' },
    chapters: [
      {
        chapterId: 'c1', title: '介绍核心概念', summary: '介绍系统的基本原理',
        topicTags: ['系统设计'], startMs: 0, endMs: 85000, evidenceIds: ['e1'],
      },
      {
        chapterId: 'c2', title: '实现细节', summary: '代码层面', topicTags: [],
        startMs: 85000, endMs: 200000, evidenceIds: ['e2'],
      },
    ],
    events: [
      { eventId: 'ev1', startMs: 12000, endMs: 15000, summary: '提到记忆', evidenceIds: ['e3'] },
    ],
    utterances: [
      { text: '我们来看记忆架构', startMs: 10000, endMs: 14000, evidenceId: 'u1' },
      { text: '无关闲聊', startMs: 90000, endMs: 91000, evidenceId: 'u2' },
    ],
    storyboardIndex: [
      { frameId: 'F1', timestampMs: 12000, evidenceIds: ['f1'] },
    ],
  };
  const r = retrieve(index, { question: '记忆架构讲了什么', queryType: 'text_structure' });
  assert.ok(r.utterances.some((u) => u.evidenceId === 'u1' && u._score > 0));
  assert.ok(r.chapters.some((c) => c._score > 0) || r.utterances[0]._score > 0);
  assert.ok(r.scoreDetails.length > 0);

  const t = retrieve(index, { question: '0:12 那段', queryType: 'time_locator' });
  assert.ok(t.atMs === 12000);
  assert.ok(t.events.some((e) => e.eventId === 'ev1') || t.utterances.length > 0);
});

test('multimodal 谁在说话：优先返回带 speaker 的 utterance，否则退化前 N 条', () => {
  const base = {
    metadata: {}, chapters: [], events: [], storyboardIndex: [],
  };
  const withSpeaker = retrieve({
    ...base,
    utterances: [
      { utteranceId: 'u0', text: '普通内容', startMs: 0, endMs: 100, evidenceId: 'e0' },
      { utteranceId: 'u1', text: '另一段内容', startMs: 100, endMs: 200, evidenceId: 'e1', speakerClusterId: 'speaker-a' },
    ],
  }, { question: '谁在说话', queryType: 'multimodal' });
  assert.ok(withSpeaker.utterances.some((u) => u.speakerClusterId === 'speaker-a'));
  assert.ok(withSpeaker.reasons.includes('speaker_grouped_retrieval'));

  const fallback = retrieve({
    ...base,
    utterances: [{ utteranceId: 'u2', text: '没有分离音色', startMs: 0, endMs: 100, evidenceId: 'e2' }],
  }, { question: '谁在说话', queryType: 'multimodal' });
  assert.equal(fallback.utterances.length, 1);
  assert.equal(fallback.utterances[0].utteranceId, 'u2');
  assert.ok(fallback.reasons.includes('speaker_fallback'));
});

test('multimodal 偶然命中一词仍保留其他 speaker；顺序稳定', () => {
  const utts = [
    { utteranceId: 'uA', text: '另一个人出现了', startMs: 0, endMs: 500, evidenceId: 'eA', speakerClusterId: 'A' },
    { utteranceId: 'uB1', text: '天气不错', startMs: 1000, endMs: 2000, evidenceId: 'eB1', speakerClusterId: 'B' },
    { utteranceId: 'uB2', text: '继续聊天气', startMs: 2100, endMs: 3000, evidenceId: 'eB2', speakerClusterId: 'B' },
  ];
  const index = { metadata: {}, chapters: [], events: [], storyboardIndex: [], utterances: utts };
  const a = retrieve(index, { question: '哪个人在说话', queryType: 'multimodal' });
  const b = retrieve(index, { question: '哪个人在说话', queryType: 'multimodal' });
  const speakers = new Set(a.utterances.map((u) => u.speakerClusterId));
  assert.ok(speakers.has('A') && speakers.has('B'));
  assert.deepEqual(
    a.utterances.map((u) => u.utteranceId),
    b.utterances.map((u) => u.utteranceId),
  );
});
