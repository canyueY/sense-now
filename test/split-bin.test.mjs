/**
 * split-bin.test.mjs — 一张图**只能画一个箱子**。
 *
 * 背景：`solve()` 的 DP 允许跨箱，`cells` 会带上所有箱的格子（只靠 `bin` 区分）。
 * 不过滤就画，第二箱的 y 从 0 重新开始，直接盖在第一箱上 —— 画面糊掉但不报错。
 *
 * **注意**：旧代码（多箱只退一帧）在当前参数下是**对的**，穷举没找到反例
 * （见 `splitOneBin` 的注释）。这里的测试守的是"不变量"，不是"回归某个已知坏样本"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { solve, toRects, splitOneBin } = await import('../src/pack.js');
const { createPipeline } = await import('../src/pipeline.js');

const BIN = { binCost: 1000 };

test('反例（构造出来的）：solve([1,4,4]) 是两箱，cells 里带着第二箱的格子', () => {
  const p = solve([1, 4, 4], BIN);
  assert.equal(p.bins, 2, '这个输入本来就装不进一张');
  assert.equal(p.cells.length, 3, 'cells 不会因为跨箱而少给');
  assert.deepEqual(p.cells.map((c) => c.bin), [0, 0, 1]);
});

test('不过滤就画 = 第二箱盖在第一箱上（这就是"糊图"）', () => {
  const p = solve([1, 4, 4], BIN);
  const all = toRects(p.cells, { width: 800, height: 450 });
  const only0 = toRects(p.cells, { width: 800, height: 450, bin: 0 });
  assert.equal(all.length, 3);
  assert.equal(only0.length, 2, '按 bin 过滤才只拿这一张的格子');
  // 第二箱那格的 y 从 0 重来 —— 和第一箱的第一格完全重叠
  assert.equal(all[2].py, all[0].py);
});

test('splitOneBin：一段一箱、保序、不丢帧', () => {
  const tiers = [1, 4, 4];
  const segs = splitOneBin(tiers, BIN);
  assert.deepEqual(segs, [[1, 4], [4]]);
  for (const s of segs) assert.equal(solve(s, BIN).bins, 1, `这一段还是多箱：${s}`);
  assert.deepEqual(segs.flat(), tiers, '不许丢帧、不许换序');
});

test('splitOneBin：装得下就原样一段', () => {
  for (const tiers of [[4, 4, 4, 4], [8, 8, 8, 8, 8, 8, 8, 8], [2], [1, 1]]) {
    const segs = splitOneBin(tiers, BIN);
    assert.equal(segs.length, 1, `${tiers} 本来就装得下，不该拆`);
    assert.deepEqual(segs[0], tiers);
  }
});

test('splitOneBin：长序列也不丢帧、每段单箱', () => {
  const tiers = [1, 4, 4, 1, 2, 7, 8, 8, 8, 1, 1, 3, 5, 5, 2, 1];
  const segs = splitOneBin(tiers, BIN);
  assert.deepEqual(segs.flat(), tiers);
  for (const s of segs) assert.equal(solve(s, BIN).bins, 1);
});

/** 两个矩形是否真的重叠（面积 > 0） */
function overlaps(a, b) {
  const x = Math.min(a.px + a.pw, b.px + b.pw) - Math.max(a.px, b.px);
  const y = Math.min(a.py + a.ph, b.py + b.ph) - Math.max(a.py, b.py);
  return x > 0 && y > 0;
}

test('整条管线出来的每一张图，格子都不重叠（跨箱不糊）', () => {
  const W = 240; const H = 135;
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  const buf = (v) => Buffer.alloc(W * H * 3, v);
  // 交替明暗：既有切点、又会让档位上下跳（正是 [大,小,小] 这种组合的来源）
  for (let i = 0; i < 48; i += 1) {
    p.push({ t: i / 12, buf: buf((Math.floor(i / 3) % 2) ? 240 : 8) });
  }
  const { sheets, stats } = p.finish();

  assert.ok(sheets.length > 0, '应该出图');
  assert.equal(stats.overflow, 0, '不该走到"多箱兜底"（说明切段生效了）');
  for (const s of sheets) {
    assert.equal(s.frames.length, s.cells.length, '帧数和格子数必须一一对应');
    for (let i = 0; i < s.cells.length; i += 1) {
      for (let j = i + 1; j < s.cells.length; j += 1) {
        assert.ok(!overlaps(s.cells[i], s.cells[j]),
          `第 ${i + 1} 格和第 ${j + 1} 格重叠了（这张图的 why=${s.why}）`);
      }
    }
  }
});
