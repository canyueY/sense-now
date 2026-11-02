import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenGate, estimateTextTokens } from '../src/video-index/token-gate.js';

test('字符估算必须标 estimated:true，不能伪装成 measured', () => {
  const gate = createTokenGate({ budget: { maxTextTokens: 50, maxChapters: 1, maxEvents: 2, maxUtterances: 2 } });
  const m = gate.measureText('你好世界 hello world '.repeat(20));
  assert.equal(m.estimated, true);
  assert.ok(m.tokens > 0);
  assert.ok(estimateTextTokens('abc') > 0);
});

test('超预算时 truncated + omittedEvidenceIds；关键证据不静默丢', () => {
  const gate = createTokenGate({
    budget: { maxEvents: 2, maxChapters: 1, maxUtterances: 1, maxStoryboardUnits: 1, maxTextTokens: 6000 },
  });
  const r = gate.enforce({
    chapters: [
      { chapterId: 'c1', evidenceIds: ['e1'] },
      { chapterId: 'c2', evidenceIds: ['e2'] },
    ],
    events: [
      { eventId: 'ev1', evidenceIds: ['crit1'], summary: 'a' },
      { eventId: 'ev2', evidenceIds: ['x2'], summary: 'b' },
      { eventId: 'ev3', evidenceIds: ['x3'], summary: 'c' },
    ],
    utterances: [
      { evidenceId: 'u1', text: 'one' },
      { evidenceId: 'u2', text: 'two' },
    ],
    criticalEvidenceIds: ['crit1'],
  });
  assert.equal(r.budget.truncated, true);
  assert.equal(r.budget.estimated, true);
  assert.ok(r.events.some((e) => (e.evidenceIds || []).includes('crit1')));
  assert.ok(r.budget.omittedEvidenceIds.length >= 1);
});

test('真实 tokenizer 可用时 estimated:false', () => {
  const gate = createTokenGate({
    tokenizer: { count: (t) => String(t).length },
  });
  const m = gate.measureText('abcd');
  assert.equal(m.estimated, false);
  assert.equal(m.tokens, 4);
});
