import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldGoIdle, IDLE_STOP_MS, MAX_AUTONOMOUS_WAKES } from '../src/loop.js';

/**
 * 回归：社区实报「装上后会卡读图循环」。
 *
 * 常驻循环原来**只有"采集停了"一个退出条件** —— 屏幕一直在动（放视频、刷网页）
 * 就会每 15 秒叫醒模型一次，永远不停，用户什么都没问、会话却在一轮一轮读图。
 */

const NOW = 1_700_000_000_000;

test('连续自动唤醒达到上限就收工（窗开着也算）', () => {
  assert.equal(shouldGoIdle({ wakesSinceUser: MAX_AUTONOMOUS_WAKES - 1, now: NOW, lastUserAt: NOW, windowOpen: true }), false);
  assert.equal(shouldGoIdle({ wakesSinceUser: MAX_AUTONOMOUS_WAKES, now: NOW, lastUserAt: NOW, windowOpen: true }), true);
  // 窗开着也照样有上限 —— 防"窗开着但人走了"
  assert.equal(shouldGoIdle({ wakesSinceUser: 99, now: NOW, lastUserAt: NOW, windowOpen: true }), true);
});

test('没开悬浮窗 + 用户长时间不说话 → 收工', () => {
  // 刚聊过：不收
  assert.equal(shouldGoIdle({ wakesSinceUser: 1, now: NOW, lastUserAt: NOW - 1000, windowOpen: false }), false);
  // 超过阈值：收
  assert.equal(shouldGoIdle({ wakesSinceUser: 1, now: NOW, lastUserAt: NOW - IDLE_STOP_MS - 1, windowOpen: false }), true);
});

test('悬浮窗开着时不按"多久没说话"收工（陪看中途不说话是正常的）', () => {
  const long = NOW - IDLE_STOP_MS * 10;
  assert.equal(shouldGoIdle({ wakesSinceUser: 2, now: NOW, lastUserAt: long, windowOpen: true }), false);
  assert.equal(shouldGoIdle({ wakesSinceUser: 2, now: NOW, lastUserAt: long, windowOpen: false }), true);
});
