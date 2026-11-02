import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateTopics, aggregateKeyMoments, enrichChapterTags,
} from '../src/video-index/event-aggregator.js';

test('topics 从重复词聚合且带回 evidenceIds', () => {
  const topics = aggregateTopics({
    utterances: [
      { text: '介绍记忆架构与系统设计', evidenceId: 'e1', startMs: 0, endMs: 1000 },
      { text: '记忆架构的下一步', evidenceId: 'e2', startMs: 2000, endMs: 3000 },
      { text: '无关闲聊', evidenceId: 'e3', startMs: 4000, endMs: 5000 },
    ],
  });
  assert.ok(topics.some((t) => t.tag.includes('记忆') || t.tag.includes('架构')));
  const hit = topics.find((t) => t.count >= 2);
  assert.ok(hit);
  assert.ok(hit.evidenceIds.length >= 1);
});

test('key-moments 捕捉强调句与章节边界；不发明假摘要', () => {
  const moments = aggregateKeyMoments({
    videoKey: 'file:x:a.mp4',
    indexVersion: 'v1',
    chapters: [{
      chapterId: 'c1', title: '', startMs: 0, endMs: 5000, evidenceIds: ['e0'],
    }],
    utterances: [
      { text: '注意！这是结论', evidenceId: 'e1', startMs: 1000, endMs: 2000 },
      { text: '短', evidenceId: 'e2', startMs: 3000, endMs: 3100 },
    ],
  });
  assert.ok(moments.some((m) => m.kind === 'chapter_boundary'));
  assert.ok(moments.some((m) => m.kind === 'emphasis'));
  assert.ok(moments.every((m) => Array.isArray(m.evidenceIds)));
});

test('key-moments 按价值保留片尾强调，不被前 20 章节挤掉', () => {
  const chapters = Array.from({ length: 25 }, (_, i) => ({
    chapterId: `c${i}`,
    title: '',
    startMs: i * 1000,
    endMs: i * 1000 + 500,
    evidenceIds: [`e${i}`],
  }));
  const moments = aggregateKeyMoments({
    videoKey: 'file:x:a.mp4',
    indexVersion: 'v1',
    maxMoments: 20,
    chapters,
    utterances: [
      {
        text: '注意！最后的关键结论',
        evidenceId: 'tail',
        startMs: 30_000,
        endMs: 31_000,
      },
    ],
  });
  assert.ok(moments.some((m) => m.kind === 'emphasis' && /关键结论/.test(m.label)));
  assert.ok(moments.length <= 20);
});

test('enrichChapterTags 只在空 tags 时回填', () => {
  const chapters = [
    { chapterId: 'c1', startMs: 0, endMs: 5000, topicTags: [], evidenceIds: [] },
    { chapterId: 'c2', startMs: 6000, endMs: 9000, topicTags: ['已有'], evidenceIds: [] },
  ];
  const topics = [
    { tag: '记忆', count: 3, startMs: 0, endMs: 4000, evidenceIds: ['e1'] },
  ];
  const out = enrichChapterTags(chapters, topics);
  assert.deepEqual(out[0].topicTags, ['记忆']);
  assert.deepEqual(out[1].topicTags, ['已有']);
});
