import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCognition } from '../src/video-index/cognition-gate.js';

test('普通索引事件不唤醒模型', () => {
  for (const trigger of ['chapter_complete', 'asr_added', 'scene_change', 'subtitle_added', 'entity_detected']) {
    const r = evaluateCognition({ trigger, hasUserQuestion: false });
    assert.ok(r.decision === 'local' || r.decision === 'queue');
    assert.ok(['skipped', 'candidate', 'deferred'].includes(r.state));
    assert.notEqual(r.decision, 'llm');
  }
});

test('高价值片段只标 candidate，不自动 llm', () => {
  const r = evaluateCognition({
    trigger: 'chapter_complete',
    highValueCandidate: true,
  });
  assert.equal(r.state, 'candidate');
  assert.equal(r.decision, 'local');
});

test('用户提问可进入 llm', () => {
  const r = evaluateCognition({
    trigger: 'user_question',
    hasUserQuestion: true,
    requiredEvidenceIds: ['e1'],
  });
  assert.equal(r.decision, 'llm');
  assert.equal(r.state, 'ready');
});
