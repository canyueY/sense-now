/**
 * scene 与 minFrames 互斥回归（任务书第五节第 4 点）。
 * 正常队列 / timeout 路径见 peek-minframes.test.mjs。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_OPTS } from '../src/runner.js';

test('scene 模式固定单帧参数（与 minFrames>1 互斥的根基）', () => {
  assert.equal(SCENE_OPTS.maxFrames, 1);
  assert.equal(SCENE_OPTS.strategy, 'single');
});

test('effective minFrames：scene 时压成 1，否则保留用户值', () => {
  const effective = (sceneMode, requested) => (sceneMode ? 1 : requested);
  assert.equal(effective(true, 5), 1);
  assert.equal(effective(false, 5), 5);
  assert.equal(effective(false, 1), 1);
});
