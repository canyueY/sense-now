/**
 * peek-minframes.test.mjs — issue #1 的回归网。
 *
 * 两件事：
 *   ① `runner.peek()` 要取走**已经拼好的那张**，不能清空队列再截一张新的。
 *      旧实现走的是 `flushNow()`（插话专用），复现里 `queued [0,2,4]` 被换成 `[5.92]`。
 *   ② `minFrames` 在**正常队列返回**路径上也要生效，不能只有超时分支检查。
 *      旧实现里 `minFrames: 5` 照样返回一张 1 帧的图，且 `ok: true`。
 *
 * 用 `source:"file"` 喂合成视频，和线上同一条代码路径，只是把屏幕换成文件。
 * 需要 ffmpeg 在 PATH 上；没有就跳过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-peek-'));
// 绝不能真弹窗
process.env.DSH_SEE_NO_WINDOW = '1';

const FIXTURE = join('.tmp', 'peek-clip.mp4');

function ffmpegOk() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  // testsrc2 一直在动 → 积分帧持续触发，能攒出真正的多帧图
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12', '-t', '20',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = !ffmpegOk();
const { createRunner } = skip ? {} : await import('../src/runner.js');

test('peek 队列空时返回 null，不再凭空截一张', { skip }, async () => {
  const runner = createRunner();
  try {
    await runner.start({
      src: { kind: 'file', path: makeFixture(), realtime: true },
      opts: { maxFrames: 3 },
    });

    // 刚开 1.5 秒：已经在解帧了（lastSeen 有值），但还不够封箱（要 3 帧 / 15 秒）。
    // 这正是旧实现出问题的时刻 —— `flushNow()` 会把 lastSeen 塞成一张新图交出去。
    await sleep(1500);
    const st = runner.status();
    assert.ok(st.frames > 0, '前置条件：已经在采帧了');
    assert.equal(st.pending, 0, '前置条件：还没封箱，队列该是空的');

    const s = runner.peek();
    assert.equal(s, null, '队列空时 peek 必须返回 null；返回一张就说明又走了 flushNow()');

    // 副作用检查：peek 不该把"攒了一半"的状态搅乱
    assert.equal(runner.status().pending, 0, 'peek 之后队列仍是空的');
  } finally {
    runner.stop();
  }
});

test('peek 取走队列里的那张，取一张少一张', { skip }, async () => {
  const runner = createRunner();
  try {
    // maxWaitSec 调小 + 每箱 3 帧：几秒就能封出第一张，测试不用等 20 秒
    await runner.start({
      src: { kind: 'file', path: makeFixture(), realtime: true },
      opts: { maxFrames: 3, maxWaitSec: 2 },
    });

    let before = 0;
    for (let i = 0; i < 60; i += 1) {
      await sleep(250);
      before = runner.status().pending;
      if (before >= 1) break;
    }
    assert.ok(before >= 1, `应该先封出一张，实际 pending=${before}`);

    const a = runner.peek();
    assert.ok(a, 'peek 应能取到队列里的那张');
    assert.ok(a.frames.length > 0, '取到的必须是真图');
    // 旧实现 flushNow() 产出的帧标 `via: 'user'`；正常封箱是 cut / mark / floor / time…
    assert.notEqual(a.frames?.[0]?.via, 'user', 'peek 拿的应是自动封箱的图，不是"立刻截一张"');

    const after = runner.status().pending;
    assert.equal(after, before - 1, `peek 只该取走一张（before=${before}, after=${after}）—— 清空队列就是 bug`);
  } finally {
    runner.stop();
  }
});

test('minFrames 在正常返回路径生效：凑不够就不交付', { skip }, async () => {
  const runner = createRunner();
  try {
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true } });

    // 先让管线热起来（避免冷启动的 eager 早退分支干扰）
    await runner.watch({ seconds: 3, minFrames: 1, opts: { maxFrames: 3 } });

    // 逐场景参数：每张图固定 1 帧。minFrames: 5 永远凑不满 → 必须 ok:false。
    // 旧实现这里会返回 { ok: true, frames: 1 }。
    const r = await runner.watch({
      seconds: 3, minFrames: 5, opts: { maxFrames: 1, strategy: 'single' },
    });
    assert.equal(r.ok, false, `凑不够 minFrames 不该交付，实际：${JSON.stringify(r).slice(0, 200)}`);
    assert.ok(
      r.reason === 'no-change' || r.reason === 'capture-stopped',
      `理由应是没攒够/采集停了，实际：${r.reason}`,
    );
  } finally {
    runner.stop();
  }
});
