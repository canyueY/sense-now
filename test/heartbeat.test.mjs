/**
 * heartbeat.test.mjs — 心跳过期 ≠ 用户关窗。
 *
 * 社区有 1 例"会话自己结束了"。定位到这条链：
 *   心跳 6 秒没更新（机器睡一觉醒来 / 窗口主线程卡一下）
 *   → `windowAlive()` false
 *   → 循环一拍就 `stop('window-closed')`
 *   → `index.js` 落挂断说明（"用户关掉了窗，不要再调 sense_now"）+ `runner.hangUp()`
 *   → 之后 `watch` 一律被 `guardReason` 拦，这个会话再也回不来。
 *
 * 判据换成"进程没了才算关"之后，心跳抖动只累加拍数、且只停不挂断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-hb-'));
process.env.DSH_HOME = home;
// 这里**不能**设 DSH_SEE_NO_WINDOW：要真的读 pid 和心跳文件
delete process.env.DSH_SEE_NO_WINDOW;

const { windowAlive, windowPidAlive, pidPath } = await import('../src/window.js');
const { chatDir } = await import('../src/chat.js');
const { startLoop, windowVerdict, WINDOW_GONE_TICKS } = await import('../src/loop.js');

/** 造一个"进程活着"的窗：pid 指向本测试进程，心跳自己摆 */
function fakeWindow({ heartbeatAgeSec = 0 } = {}) {
  writeFileSync(pidPath(), String(process.pid));
  mkdirSync(chatDir(), { recursive: true });
  const hb = join(chatDir(), 'window-heartbeat');
  writeFileSync(hb, '');
  const t = Date.now() / 1000 - heartbeatAgeSec;
  utimesSync(hb, t, t);
  return hb;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('心跳新鲜 + 进程活着 → 窗活着', () => {
  fakeWindow({ heartbeatAgeSec: 0 });
  assert.equal(windowPidAlive(), true);
  assert.equal(windowAlive(), true);
});

test('心跳过期、但进程还活着 → windowAlive 判否，windowPidAlive 判是', () => {
  fakeWindow({ heartbeatAgeSec: 8 });
  assert.equal(windowAlive(), false, 'windowAlive 的语义是"这窗还能不能用"，过期就要能重开');
  assert.equal(windowPidAlive(), true, '进程没死，这是关键区别');
});

test('pid 文件指向不存在的进程 → pid 判否', () => {
  writeFileSync(pidPath(), '999999');
  assert.equal(windowPidAlive(), false);
  assert.equal(windowAlive(), false);
});

test('windowVerdict：进程没了才算"用户关窗"，心跳过期只算卡住', () => {
  // 窗开着、活着
  assert.equal(windowVerdict({ wasOpen: true, alive: true, pidAlive: true }), null);
  // 从来没开起来过（没 python）→ 什么都不判
  assert.equal(windowVerdict({ wasOpen: false, alive: false, pidAlive: false }), null);
  // 进程没了 → 立刻按关窗处理
  assert.equal(windowVerdict({ wasOpen: true, alive: false, pidAlive: false }), 'closed');
  // 进程还在、心跳刚断 → 先别定案
  assert.equal(windowVerdict({ wasOpen: true, alive: false, pidAlive: true, goneTicks: 1 }), null);
  // 连续够多拍 → 当成窗没了，但用的是 stalled（不挂断）
  assert.equal(windowVerdict({
    wasOpen: true, alive: false, pidAlive: true, goneTicks: WINDOW_GONE_TICKS,
  }), 'stalled');
});

test('回归：心跳过期不该在第一拍就停（更不该挂断）', async () => {
  fakeWindow({ heartbeatAgeSec: 8 });
  const stopped = [];
  const runner = {
    windowWasOpen: () => true,
    status: () => ({ running: true, pending: 0, secondsSinceWake: 8 }),
    stop() {},
    hangUp() { stopped.push('hangUp'); },
  };
  const loop = startLoop({
    ctx: { get: () => undefined },
    getSessionId: () => 's1',
    runner,
    onStop: (reason) => stopped.push(reason),
  });

  await sleep(400);            // 一拍是 2 秒，这里连第一拍都还没到
  assert.equal(loop.stopped(), false);
  await sleep(2200);           // 过了一拍：仍在宽限里
  assert.equal(loop.stopped(), false, `心跳刚过期就定案 = 误杀（要连续 ${WINDOW_GONE_TICKS} 拍）`);
  assert.deepEqual(stopped, []);

  loop.dispose();
});

test('回归：窗真的开了又没了（进程死）→ 立刻停，停因是 window-closed', async () => {
  writeFileSync(pidPath(), '999999');
  const stopped = [];
  const runner = {
    windowWasOpen: () => true,
    status: () => ({ running: true, pending: 0, secondsSinceWake: 8 }),
    stop() {},
  };
  const loop = startLoop({
    ctx: { get: () => undefined },
    getSessionId: () => 's1',
    runner,
    onStop: (reason) => stopped.push(reason),
  });

  await sleep(400);
  loop.dispose();
  assert.deepEqual(stopped, ['window-closed']);
});
