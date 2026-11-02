import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunner, guardReason } from '../src/runner.js';

/**
 * 回归：社区实报「文件回放解 1955 帧、攒一堆唤醒、关窗也停不干净，得卸载才行」。
 *
 * 根因是 `watch` 在采集停掉时会**自动重启**：
 *   - 对文件源 = 从头再放一遍 → 无限重播 → 无限出图 → 无限叫醒
 *   - 对关过窗的用户 = 把窗重新开起来 → 关不掉
 */

test('硬闸：挂断/文件放完 只有显式指定来源才放行', () => {
  assert.equal(guardReason({}), null);
  assert.equal(guardReason({ explicitSrc: true }), null);

  assert.equal(guardReason({ hungUp: true }), 'hung-up');
  assert.equal(guardReason({ fileEnded: true }), 'file-ended');
  // 显式来源能覆盖两个闸
  assert.equal(guardReason({ hungUp: true, fileEnded: true, explicitSrc: true }), null);
});

test('挂断之后再调 watch：立刻返回 hung-up，且不会去开窗', async () => {
  const r = createRunner({ graceSec: 0 });
  r.hangUp();
  assert.equal(r.isHungUp(), true);

  const out = await r.watch({ seconds: 5 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'hung-up');
  // 关键：没有真的去拉悬浮窗（否则等于"关掉又弹出来"）
  assert.equal(r.windowWasOpen(), false);
  // 也没有启动采集
  assert.equal(r.status().running, false);
});

test('没挂断时 watch 不会被误拦', async () => {
  const r = createRunner({ graceSec: 0 });
  assert.equal(r.isHungUp(), false);
  assert.equal(r.endedFile(), null);
  assert.notEqual(guardReason({ hungUp: r.isHungUp(), fileEnded: Boolean(r.endedFile()) }), 'hung-up');
});
