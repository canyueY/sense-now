import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import { encodePng, testCard } from '../src/png.js';

const SIGNATURE = '89504e470d0a1a0a';

/** 按 PNG 规范把块切开，返回 [{type, data}] */
function readChunks(png) {
  const out = [];
  let i = 8;
  while (i < png.length) {
    const len = png.readUInt32BE(i);
    const type = png.subarray(i + 4, i + 8).toString('ascii');
    const data = png.subarray(i + 8, i + 8 + len);
    out.push({ type, data });
    i += 12 + len;   // 4 长度 + 4 类型 + 数据 + 4 CRC
  }
  return out;
}

test('签名与块顺序符合规范', () => {
  const { rgb, width, height } = testCard(32, 18);
  const png = encodePng(rgb, width, height);
  assert.equal(png.subarray(0, 8).toString('hex'), SIGNATURE);
  const types = readChunks(png).map((c) => c.type);
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
});

test('IHDR 里的尺寸/位深/颜色类型对得上', () => {
  const { rgb } = testCard(48, 27);
  const png = encodePng(rgb, 48, 27);
  const ihdr = readChunks(png).find((c) => c.type === 'IHDR').data;
  assert.equal(ihdr.readUInt32BE(0), 48);
  assert.equal(ihdr.readUInt32BE(4), 27);
  assert.equal(ihdr[8], 8, '位深');
  assert.equal(ihdr[9], 2, '颜色类型应为 2 (RGB)');
  assert.equal(ihdr[12], 0, '隔行应为 0');
});

test('解压 IDAT 能逐字节还原原始像素（纯 JS 往返，不依赖 ffmpeg）', () => {
  const { rgb, width, height } = testCard(64, 36);
  const png = encodePng(rgb, width, height);
  const raw = inflateSync(readChunks(png).find((c) => c.type === 'IDAT').data);

  const stride = width * 3;
  assert.equal(raw.length, (stride + 1) * height, '每行要多一个滤波字节');
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    assert.equal(raw[start], 0, `第 ${y} 行滤波类型应为 0`);
    const row = raw.subarray(start + 1, start + 1 + stride);
    assert.deepEqual(Buffer.from(row), rgb.subarray(y * stride, y * stride + stride), `第 ${y} 行像素不一致`);
  }
});

test('每个块都有合法 CRC —— 手算第 0 块核对', () => {
  const { rgb } = testCard(16, 9);
  const png = encodePng(rgb, 16, 9);
  const len = png.readUInt32BE(8);
  const body = png.subarray(12, 12 + 4 + len);     // 类型 + 数据
  const stored = png.readUInt32BE(12 + 4 + len);
  // 重算一遍（表驱动的 CRC32 只此一份实现，这里用查表法独立再算一次）
  let c = 0xffffffff;
  for (let i = 0; i < body.length; i += 1) {
    c ^= body[i];
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  assert.equal((c ^ 0xffffffff) >>> 0, stored);
});

test('尺寸非法时明确报错，不产出坏图', () => {
  assert.throws(() => encodePng(Buffer.alloc(10), 0, 5), /bad size/);
  assert.throws(() => encodePng(Buffer.alloc(10), 4, 1), /rgb too small/);
});

test('测试卡确实是 16 个不同的色块', () => {
  const { rgb, width, height } = testCard(320, 180);
  const seen = new Set();
  for (let cy = 0; cy < 4; cy += 1) {
    for (let cx = 0; cx < 4; cx += 1) {
      const x = cx * 80 + 40;
      const y = cy * 45 + 22;
      const p = (y * width + x) * 3;
      seen.add(`${rgb[p]},${rgb[p + 1]},${rgb[p + 2]}`);
    }
  }
  assert.equal(seen.size, 16, '16 个格子应该是 16 种颜色');
});

test('level 只影响体积，不影响像素', () => {
  const { rgb, width, height } = testCard(64, 36);
  const a = encodePng(rgb, width, height, { level: 1 });
  const b = encodePng(rgb, width, height, { level: 9 });
  const px = (png) => inflateSync(readChunks(png).find((c) => c.type === 'IDAT').data);
  assert.deepEqual(Buffer.from(px(a)), Buffer.from(px(b)));
});
