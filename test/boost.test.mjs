/**
 * boost.test.mjs — 「积分假切点给更小的格子」这条规则的守卫。
 *
 * 规则本身照抄 storyboard 的 `MARK_BOOST`，但在实时场景**不能无条件应用**：
 * 帧稀的时候压档是白扔画布（实测 fill 94% → 63%，帧数一点没多）；
 * 帧密的时候压档才真的省 token（每张固定 216，5 帧比 4 帧便宜 26%）。
 *
 * 所以加了个 `boostMinFrames` 门槛，这里守三件事：
 *   ① 帧少 → 档位原样，画布不浪费
 *   ② 帧多 → 档位被压小，每张塞更多帧
 *   ③ `markBoost: "0"` 这种字符串不会被当成拼接（曾把整张图打成 64 格碎格）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';

const W = 160;
const H = 90;

/** 底色 + 一个随 f 移动的方块（"画面在动但没换镜头"） */
function frame(f, { shift = 3 } = {}) {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = 40; buf[i + 1] = 60; buf[i + 2] = 90;
  }
  const bx = (f * shift) % (W - 24);
  for (let y = 10; y < 40; y += 1) {
    for (let x = bx; x < bx + 24; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 250; buf[i + 1] = 240; buf[i + 2] = 230;
    }
  }
  return buf;
}

/**
 * 喂 `n` 帧，每帧间隔 `gap` 秒，最后收尾。
 * `opts` 直接透传给 createPipeline。
 */
function run(n, { gap = 0.08, ...opts } = {}) {
  const p = createPipeline({
    width: W, height: H, fps: 12, maxWaitSec: 1e9, silentFloorSec: 1e9, ...opts,
  });
  for (let i = 0; i < n; i += 1) p.push({ t: i * gap, buf: frame(i) });
  return p.finish();
}

/** 这一批里出现过的档位 */
const tiersOf = (sheets) => sheets.flatMap((s) => s.frames.map((f) => f.tier));

test('帧少于门槛时，不加假切点加成（档位保持原样）', () => {
  // 3 帧一批：boostMinFrames 默认 4，所以这一批不该被压
  const { sheets } = run(3, { boostMinFrames: 4 });
  const got = tiersOf(sheets);
  assert.ok(got.length >= 1, '至少得出一帧');
  // 密度极低，档位应该是 1
  assert.ok(got.every((t) => t === 1), `帧少时不该压档，实际档位：${got.join(',')}`);
});

test('帧数够了就压档，而且一张图塞得更多', () => {
  // 要喂**足够长**的序列：档位来自 12 帧窗的密度 EMA，喂 12 帧时平滑还没爬起来，
  // 一律停在 1 档（这个坑一开始就踩了，测出来的"加成前后一样"是假的）。
  // 这里 8 秒 / 每秒 ~10 帧边界 → 密度顶到上限 → 档位能升到 8。
  const common = {
    dupMin: 0,
    gap: 0.1, n: 90, markMinGap: 0.05, integralSeconds: 0.3, cutAbs: 999,
  };
  const withBoost = run(common.n, {
    gap: common.gap, markMinGap: common.markMinGap, integralSeconds: common.integralSeconds,
    cutAbs: common.cutAbs, dupMin: common.dupMin, boostMinFrames: 4, markBoost: 2,
  });
  const noBoost = run(common.n, {
    gap: common.gap, markMinGap: common.markMinGap, integralSeconds: common.integralSeconds,
    cutAbs: common.cutAbs, dupMin: common.dupMin, boostMinFrames: 999, markBoost: 2,
  });

  const a = tiersOf(withBoost.sheets);
  const b = tiersOf(noBoost.sheets);
  assert.ok(a.length && b.length, '两组都得出图');
  assert.ok(Math.max(...a) > Math.max(...b),
    `加成后档位该更大（格子更小）：${a.join(',')} vs ${b.join(',')}`);

  const perA = withBoost.sheets.reduce((s, x) => s + x.frames.length, 0) / withBoost.sheets.length;
  const perB = noBoost.sheets.reduce((s, x) => s + x.frames.length, 0) / noBoost.sheets.length;
  assert.ok(perA >= perB, `加成后每张帧数不该变少：${perA} vs ${perB}`);
});

test('markBoost 传字符串 "0" 时按 0 处理（不是字符串拼接）', () => {
  // 这个坑真实踩过：`lv + "0"` = "10" → clamp 成 8 档 → 整张图 64 格碎格
  const { sheets } = run(12, { gap: 0.06, boostMinFrames: 1, markBoost: '0', floorBoost: '0' });
  const got = tiersOf(sheets);
  assert.ok(got.every((t) => t <= 3), `"0" 被当成了加成，档位炸到：${got.join(',')}`);
});

test('markBoost: 0 和 markBoost: "0" 行为一致', () => {
  const a = tiersOf(run(12, { gap: 0.06, boostMinFrames: 1, markBoost: 0 }).sheets);
  const b = tiersOf(run(12, { gap: 0.06, boostMinFrames: 1, markBoost: '0' }).sheets);
  assert.deepEqual(a, b);
});
