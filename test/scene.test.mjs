import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';
import { applyStrategy, STRATEGIES } from '../src/tiers.js';
import { SCENE_OPTS, PACES, DEFAULT_PACE } from '../src/runner.js';

const W = 200, H = 120, FPS = 12;

/** 造一帧纯色 rgb24：换颜色 = 一次硬切，不依赖 ffmpeg。 */
function solid(r, g, b) {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < buf.length; i += 3) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; }
  return buf;
}

/** 三段颜色各停 24 帧（2 秒），共 3 个画面。 */
function blocks() {
  const colors = [[10, 10, 10], [240, 240, 240], [200, 40, 40]];
  const out = [];
  colors.forEach((c, bi) => {
    const buf = solid(...c);
    for (let i = 0; i < 24; i += 1) out.push({ t: (bi * 24 + i) / FPS, buf });
  });
  return out;
}

function run(opts) {
  const p = createPipeline({ width: W, height: H, fps: FPS, queueDepth: 0, ...opts });
  const sheets = [];
  for (const f of blocks()) {
    p.push(f);
    for (;;) { const s = p.take(); if (!s) break; sheets.push(s); }
  }
  sheets.push(...p.finish().sheets);
  return { sheets, stats: p.stats };
}

test('single 策略把所有档位压到 1（0 档是补位帧，原样保留）', () => {
  assert.deepEqual(applyStrategy([1, 2, 5, 8], 'single'), [1, 1, 1, 1]);
  assert.deepEqual(applyStrategy([0, 3], 'single'), [0, 1]);
  // 别的策略不受影响：'compact' 还是 +1
  assert.deepEqual(applyStrategy([1, 3], 'compact'), [2, 4]);
  assert.equal(STRATEGIES.single.fixed, 1);
});

test('逐帧模式：每张图恰好一帧，且铺满整张画布', () => {
  const { sheets, stats } = run(SCENE_OPTS);
  assert.ok(sheets.length >= 3, `三个画面至少三张图，实际 ${sheets.length}`);
  assert.ok(stats.kept >= 3, `至少留下三帧，实际 ${stats.kept}`);
  for (const s of sheets) {
    assert.equal(s.frames.length, 1, `一张图只能有一帧，实际 ${s.frames.length}`);
    assert.equal(s.cells.length, 1);
    const c = s.cells[0];
    assert.deepEqual(
      { px: c.px, py: c.py, pw: c.pw, ph: c.ph },
      { px: 0, py: 0, pw: W, ph: H },
      '这一帧必须铺满整张画布',
    );
    // 画布上不能有灰条：单帧满幅 = 100%
    assert.ok(s.fill > 0.97, `单帧应当铺满，实际 fill=${s.fill.toFixed(2)}`);
  }
});

test('常规模式不受影响：同一段素材仍然多帧拼一张', () => {
  const { sheets } = run({});
  const maxFrames = Math.max(...sheets.map((s) => s.frames.length));
  assert.ok(maxFrames >= 2, `常规模式该把多帧拼进一张，实际最多 ${maxFrames} 帧/张`);
});

test('三档节奏：越省门槛越高、叫醒越稀，逐帧用的是最密那档', () => {
  assert.deepEqual(Object.keys(PACES).sort(), ['calm', 'dense', 'normal']);
  // 门槛：calm 最高（最不敏感）→ dense 最低
  assert.ok(PACES.calm.cutAbs > PACES.normal.cutAbs, 'calm 的门槛必须比 normal 高');
  assert.ok(PACES.normal.cutAbs > PACES.dense.cutAbs, 'normal 的门槛必须比 dense 高');
  // 唤醒间隔：calm 最长
  assert.ok(PACES.calm.wakeGapSec > PACES.normal.wakeGapSec);
  assert.ok(PACES.normal.wakeGapSec > PACES.dense.wakeGapSec);
  // 默认档不能是最密那档 —— 否则"默认就很吵"这个毛病会回来
  assert.equal(DEFAULT_PACE, 'normal');
  // 逐帧模式用的是 dense 的门槛（7），且默认常量已经退到 12
  assert.equal(createPipeline({}).constants.cutAbs, PACES[DEFAULT_PACE].cutAbs);
});
