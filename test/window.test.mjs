// 悬浮窗的启动逻辑：解释器要带 tkinter、pid 只在真活着时才写
//
// 这一组测试是补踩过的坑：
//   1. PATH 上的 python 是 WorkBuddy managed 的，**没有 tkinter**，spawn 之后立刻退
//   2. 老代码在 waitExit 之前就写了 pid → pid 指向死进程 → windowAlive() 永远 false
//   3. 商店版解释器在 WindowsApps 里是 App Execution Alias，**existsSync 判定不到**
//
// ⚠️ 这里**绝不能真的把窗开起来**（会弹到用户脸上、还会占住真机的 pid 锁），
// 所以每个用例都用 `DSH_SEE_NO_WINDOW=1` 或"一定失败的解释器"把路堵死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import window.js 之前设好 DSH_HOME（chatDir() 读它）
const home = mkdtempSync(join(tmpdir(), 'dsh-see-window-'));
process.env.DSH_HOME = home;
delete process.env.DSH_SEE_WINDOW;
delete process.env.DSH_SEE_PYTHON;
delete process.env.DSH_FLOAT_PYTHON;

const { openWindow, closeWindow, windowAlive, pidPath, resolveScript, hasTkinter } =
  await import('../src/window.js');

test('DSH_SEE_NO_WINDOW=1 时直接拒绝，不 spawn', async () => {
  process.env.DSH_SEE_NO_WINDOW = '1';
  try {
    const st = await openWindow();
    assert.equal(st.ok, false);
    assert.equal(st.reason, 'disabled');
  } finally {
    delete process.env.DSH_SEE_NO_WINDOW;
  }
  assert.equal(existsSync(pidPath()), false, 'disabled 时不能留 pid');
});

test('pid 文件指向不存在的进程时，windowAlive 必须是 false', () => {
  writeFileSync(pidPath(), '2147483646', 'utf8');
  assert.equal(windowAlive(), false);
});

test('pid 文件是垃圾内容时也不能崩', () => {
  writeFileSync(pidPath(), 'not-a-pid', 'utf8');
  assert.equal(windowAlive(), false);
  writeFileSync(pidPath(), '', 'utf8');
  assert.equal(windowAlive(), false);
});

test('closeWindow 会把 pid 文件清掉', () => {
  writeFileSync(pidPath(), '2147483646', 'utf8');
  closeWindow();
  assert.equal(existsSync(pidPath()), false);
});

test('DSH_SEE_WINDOW 指向不存在的文件时，跳过它并继续往下找', () => {
  const missing = join(home, 'nope.py');
  process.env.DSH_SEE_WINDOW = missing;
  try {
    const resolved = resolveScript();
    assert.notEqual(resolved.script, missing, '不存在的路径不能当脚本');
    assert.notEqual(resolved.from, 'DSH_SEE_WINDOW');
  } finally {
    delete process.env.DSH_SEE_WINDOW;
  }
});

test('DSH_SEE_WINDOW 指向真实文件时优先用它', () => {
  const fake = join(home, 'fake-window.py');
  writeFileSync(fake, 'import sys; sys.exit(0)\n', 'utf8');
  process.env.DSH_SEE_WINDOW = fake;
  try {
    const resolved = resolveScript();
    assert.equal(resolved.script, fake);
    assert.equal(resolved.from, 'DSH_SEE_WINDOW');
  } finally {
    delete process.env.DSH_SEE_WINDOW;
    rmSync(fake, { force: true });
  }
});

test('脚本秒退时判定为失败，且绝不留下 pid', async () => {
  // 用 python 起一个 `sys.exit(0)` 的假脚本：解释器能跑、脚本跑完就退。
  // 这正是老代码出问题的那种情况 —— 它当时会返回 ok:true 并写下死 pid。
  //
  // **必须用 script: 注入**，不能靠 DSH_SEE_WINDOW：那个路径一旦不存在，
  // resolveScript() 会顺着回退链摸到真的 window.py，测试就把窗弹到用户脸上了（踩过）。
  const fake = join(home, 'instant-exit.py');
  writeFileSync(fake, 'import sys\nsys.exit(0)\n', 'utf8');
  try {
    const st = await openWindow({ script: fake, settleMs: 1500 });
    assert.equal(st.ok, false, `脚本秒退不该算成功：${JSON.stringify(st)}`);
    assert.equal(existsSync(pidPath()), false, '秒退的进程绝不能留下 pid');
    assert.equal(windowAlive(), false);
  } finally {
    rmSync(fake, { force: true });
  }
});

test('注入一个不存在的 script 时，不回落到回退链', async () => {
  // 这条守的正是"测试意外弹出真窗"那个坑：
  // 注入路径不存在 → 直接失败，绝不去摸 ~/.dsh 或兄弟仓库里的真 window.py。
  const st = await openWindow({ script: join(home, 'gone-forever.py'), settleMs: 200 });
  assert.equal(st.ok, false);
  assert.match(st.reason, /不存在/);
  assert.equal(existsSync(pidPath()), false);
});

test('不存在的解释器一定过不了 tkinter 验证', () => {
  // openWindow 的顺序是：验 tkinter → spawn → 等 settle → 才写 pid。
  // 这一步就是把"不存在的 exe"和"没装 tk 的 python"挡在 spawn 之前的地方。
  assert.equal(hasTkinter(join(home, 'not-python-1.exe')), false);
  assert.equal(hasTkinter(join(home, 'not-python-2.exe')), false);
});
