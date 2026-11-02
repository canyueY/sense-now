/**
 * live.test.mjs — 实时管线的三条不变量。
 *
 * 这三个数一旦变，线上表现会直接坏掉，而且坏得不显眼（图还是出得来）：
 *   ① 一镜到底不能出假切点
 *   ② 3 个 1 档帧要排成 L 形（75%），不是被拆成两张各 50%
 *   ③ 插话必须带上「此刻那一帧」
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTiers } from '../src/tiers.js';
import { solve } from '../src/pack.js';
import { coverInto } from '../src/scale.js';
import { createPipeline } from '../src/pipeline.js';

const W = 160;
const H = 90;

/** 造一帧：底色 + 一个随 f 移动的方块（模拟"画面在动但没换镜头"） */
function frame(scene, f, { shift = 1 } = {}) {
  const buf = Buffer.alloc(W * H * 3);
  const [r, g, b] = scene;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
  const bx = (f * shift) % (W - 20);
  for (let y = 10; y < 30; y += 1) {
    for (let x = bx; x < bx + 20; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 250;
      buf[i + 1] = 250;
      buf[i + 2] = 250;
    }
  }
  return buf;
}

test('一镜到底：缓慢运动不出切点', () => {
  const p = createPipeline({ width: W, height: H, fps: 12 });
  for (let f = 0; f < 120; f += 1) p.push({ t: f / 12, buf: frame([40, 60, 80], f, { shift: 2 }) });
  p.finish();
  assert.equal(p.stats.cuts, 0, `假切点 ${p.stats.cuts} 个`);
});

test('硬切：换场只认一刀，且只认孤立尖峰', () => {
  const p = createPipeline({ width: W, height: H, fps: 12 });
  for (let f = 0; f < 120; f += 1) {
    const scene = f < 60 ? [30, 120, 60] : [200, 40, 40];
    p.push({ t: f / 12, buf: frame(scene, f) });
  }
  p.finish();
  assert.equal(p.stats.cuts, 1, `切点数 ${p.stats.cuts}`);
  const cut = p.log.find((k) => k.via === 'cut');
  assert.ok(cut.t >= 4.9 && cut.t <= 5.1, `刀抬在了 ${cut.t}s`);
});

test('排布：3 个 1 档帧是一张 75% 的 L 形，不是两张各 50%', () => {
  const three = solve([1, 1, 1], { binCost: 1000 });
  assert.equal(three.bins, 1);
  assert.ok(Math.abs(three.area - 0.75) < 1e-6, `area=${three.area}`);

  const four = solve([1, 1, 1, 1], { binCost: 1000 });
  assert.equal(four.bins, 1);
  assert.ok(Math.abs(four.area - 1) < 1e-6);

  const five = solve([1, 1, 1, 1, 1], { binCost: 1000 });
  assert.equal(five.bins, 2);
});

test('档位：连续留帧会升档，安静下来会降回去', () => {
  const t = createTiers({ fps: 12, dtFrames: 12, smoothFrames: 6 });
  for (let f = 0; f <= 48; f += 1) t.tick(f / 12);
  assert.equal(t.levelAt(), 1, '一开始没有边界，应该是 1 档');

  for (let f = 0; f <= 36; f += 6) t.mark(f / 12);      // 每秒 2 帧
  for (let f = 0; f <= 120; f += 1) t.tick(4 + f / 12);  // 再空转 10 秒
  assert.ok(t.levelAt() <= 2, `安静 10 秒后还停在 ${t.levelAt()} 档`);
});

test('缩放：cover 不改比例，取中间那块', () => {
  const src = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      src[i] = x < W / 2 ? 10 : 200;      // 左暗右亮，缩小时不会混成一个值
      src[i + 1] = 50;
      src[i + 2] = 50;
    }
  }
  const dst = Buffer.alloc(80 * 45 * 3);
  coverInto(src, W, H, dst, 80, 45);
  assert.ok(dst[0] < 60, `左边缘应该是暗的，实际 ${dst[0]}`);
  const right = (44 * 80 + 79) * 3;
  assert.ok(dst[right] > 150, `右边缘应该是亮的，实际 ${dst[right]}`);
});

test('插话：截断出来的图里必须有「此刻那一帧」', () => {
  const p = createPipeline({ width: W, height: H, fps: 12 });
  for (let f = 0; f < 60; f += 1) p.push({ t: f / 12, buf: frame([40, 60, 80], f, { shift: 2 }) });
  const s = p.flushNow(5);
  assert.ok(s, '应该出图');
  // 插话发生在 5.0s，但**此刻**能拿到的最新像素是 4.917s（最后一帧解出来的）——
  // 相差不能超过一帧，否则就是"给了几秒前的画面"
  assert.ok(s.to > 4.9, `最后一张是 ${s.to}s，太旧了`);
  assert.ok(s.frames.length >= 1);
});

test('采集参数：屏幕走 ddagrab 时没有 -framerate，也不挂多余的 -r', async () => {
  const { captureArgs, sourceArgs } = await import('../src/capture.js');
  const dda = captureArgs({ source: { kind: 'screen' }, width: 800, height: 450, fps: 12, engine: 'ddagrab' });
  assert.ok(dda.join(' ').includes('ddagrab=framerate=12'), 'ddagrab 的帧率是滤镜参数');
  assert.ok(dda.join(' ').includes('hwdownload'), 'GPU 帧要先拿下来');
  assert.ok(!dda.includes('-r'), '屏幕源已经按 fps 抓了，再挂 -r 是白跑一趟');

  const gdi = captureArgs({ source: { kind: 'screen' }, width: 800, height: 450, fps: 12, engine: 'gdigrab' });
  assert.ok(gdi.join(' ').includes('-f gdigrab'), 'gdigrab 要显式指定');
  assert.ok(gdi.join(' ').includes('-framerate 12'), 'gdigrab 的帧率是设备侧参数');

  const region = sourceArgs(
    { kind: 'screen', region: { x: 100, y: 50, w: 1280, h: 720 } }, { engine: 'gdigrab', fps: 12 },
  ).join(' ');
  assert.ok(region.includes('-offset_x 100') && region.includes('-video_size 1280x720'));
});

test('采集参数：设备源走 dshow，保留 -r 和 rtbufsize', async () => {
  const { captureArgs } = await import('../src/capture.js');
  const cam = captureArgs({ source: { kind: 'camera' }, width: 800, height: 450, fps: 12 }).join(' ');
  assert.ok(cam.includes('-f dshow'), 'dshow');
  assert.ok(cam.includes('video=HD Webcam'), '默认设备名');
  assert.ok(cam.includes('-r 12'), '设备帧率不是 12，要重采样');
  assert.ok(cam.includes('-rtbufsize'), '直播设备必须给缓冲');
  assert.ok(!cam.includes('-framerate'), 'dshow 不能加 -framerate，会 I/O error');
});
