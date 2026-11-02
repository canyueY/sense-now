import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/video-index/context-builder.js';

test('文本查询不附视觉证据', () => {
  const r = buildContext({
    retrieval: {
      metadata: { title: 't' },
      chapters: [{ chapterId: 'c1', title: 'intro', evidenceIds: ['e1'], summary: 'hi' }],
      events: [],
      utterances: [{ text: 'hello', evidenceId: 'u1' }],
      storyboardUnits: [{ frameId: 'F1', evidenceIds: ['f1'], selectionReasons: [] }],
    },
    queryType: 'text_structure',
    question: '讲了什么',
  });
  assert.equal(r.visualEvidence.length, 0);
  assert.ok(r.context.chapters.length >= 1);
});

test('视觉查询带 storyboard；超预算 truncated', () => {
  const units = Array.from({ length: 10 }, (_, i) => ({
    frameId: `F${i}`,
    evidenceIds: [`e${i}`],
    selectionReasons: ['scene_change'],
    storedSize: { width: 800, height: 450 },
  }));
  const r = buildContext({
    retrieval: {
      metadata: {},
      chapters: [],
      events: [],
      utterances: [],
      storyboardUnits: units,
    },
    queryType: 'visual',
    question: '画面里是什么',
    budget: { maxStoryboardUnits: 2, maxVisualTokens: 100 },
  });
  assert.ok(r.visualEvidence.length <= 2);
  assert.equal(r.budget.estimated, true);
});
