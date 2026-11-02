/**
 * cuts.js — 逐帧画面变化分。**因果**，不看未来（除了一帧的尖峰确认）。
 *
 * `scorePair` 照抄 storyboard 的 scan.js（HSV 三通道加权绝对差，0–255）——
 * 同一段测试片它 9/9 命中、`ffmpeg scdet` 只 4/9（scdet 算亮度类 MAFD，对"同亮度换色"失明）。
 * 唯一改动：喂进来的不是整帧，而是 64×36 的网格，顺带把降采样的平均做了。
 */

export const SCAN_W = 64;
export const SCAN_H = 36;

/** 64×36 网格：每格取 4 个采样点求平均（降噪，且只花 9k 次读）。 */
export function gridRgb(rgb, width, height, out) {
  const sx = width / SCAN_W;
  const sy = height / SCAN_H;
  for (let gy = 0; gy < SCAN_H; gy += 1) {
    const y0 = ((gy + 0.25) * sy) | 0;
    const y1 = ((gy + 0.75) * sy) | 0;
    const r0 = y0 * width;
    const r1 = y1 * width;
    for (let gx = 0; gx < SCAN_W; gx += 1) {
      const x0 = ((gx + 0.25) * sx) | 0;
      const x1 = ((gx + 0.75) * sx) | 0;
      const a = (r0 + x0) * 3;
      const b = (r0 + x1) * 3;
      const c = (r1 + x0) * 3;
      const d = (r1 + x1) * 3;
      const i = gy * SCAN_W + gx;
      out[i * 3] = (rgb[a] + rgb[b] + rgb[c] + rgb[d]) * 0.25;
      out[i * 3 + 1] = (rgb[a + 1] + rgb[b + 1] + rgb[c + 1] + rgb[d + 1]) * 0.25;
      out[i * 3 + 2] = (rgb[a + 2] + rgb[b + 2] + rgb[c + 2] + rgb[d + 2]) * 0.25;
    }
  }
  return out;
}

/** RGB → HSV（各通道归一到 0–255，H 由角度缩放）。就地写进 out，不分配。 */
export function rgbToHsv(rgb, out) {
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 3) {
    const rn = rgb[i] / 255;
    const gn = rgb[i + 1] / 255;
    const bn = rgb[i + 2] / 255;
    const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
    const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    out[j] = (h / 360) * 255;
    out[j + 1] = max === 0 ? 0 : (d / max) * 255;
    out[j + 2] = max * 255;
  }
  return out;
}

/** 两帧 HSV 的加权绝对差均值，0–255。色相按环形处理，低饱和像素的色相降权。 */
export function scorePair(prev, cur) {
  let sum = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    sum += hueDiff * hueWeight
      + Math.abs(cur[i + 1] - prev[i + 1])
      + Math.abs(cur[i + 2] - prev[i + 2]);
  }
  return sum / ((cur.length / 3) * 3);
}

/**
 * 打分器：内部维护上一帧的 HSV。
 * 返回 `{ score, hsv }`，score 为 null 表示这是第一帧（没有前帧可比）。
 * **hsv 是复用的缓冲**，要用就自己拷走。
 */
export function createScorer({ width, height }) {
  const n = SCAN_W * SCAN_H;
  const rgb = new Float32Array(n * 3);
  let prev = null;
  let cur = new Float32Array(n * 3);

  return function score(frame) {
    gridRgb(frame, width, height, rgb);
    rgbToHsv(rgb, cur);
    let s = null;
    if (prev) s = scorePair(prev, cur);
    const tmp = prev ?? new Float32Array(n * 3);
    tmp.set(cur);
    prev = tmp;
    return { score: s, hsv: cur };
  };
}
