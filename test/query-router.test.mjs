import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeQuery } from '../src/video-index/query-router.js';

test('显式 mode 优先', () => {
  const r = routeQuery({ question: '画面里是什么', mode: 'text' });
  assert.equal(r.queryType, 'text_structure');
  assert.ok(r.reasons.some((x) => x.startsWith('explicit_mode')));
});

test('文本结构 vs 视觉 vs 时间 vs deep vs multimodal', () => {
  assert.equal(routeQuery({ question: '这个视频讲了什么' }).queryType, 'text_structure');
  assert.equal(routeQuery({ question: '画面里是什么颜色的按钮' }).queryType, 'visual');
  assert.equal(routeQuery({ question: '什么时候第一次提到记忆' }).queryType, 'time_locator');
  assert.equal(routeQuery({ question: '请深度分析论证这段' }).queryType, 'deep');
  assert.equal(routeQuery({ question: '谁在说同时在操作' }).queryType, 'multimodal');
});

test('时间词不自动意味着视觉', () => {
  const r = routeQuery({ question: '1:23 那段说了什么' });
  assert.equal(r.queryType, 'time_locator');
  assert.ok(r.reasons.includes('explicit_timestamp'));
});
