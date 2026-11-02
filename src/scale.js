/**
 * scale.js — 把抓到的整幅帧缩进一格。storyboard 的 `blit()` 只搬不缩（缩放交给 ffmpeg
 * 的 `cover` 滤镜），实时场景帧已经在内存里，再 spawn 一次 ffmpeg 就白省了 —— 所以缩放在这里做。
 *
 * 覆盖式（cover）：短边填满、长边居中裁掉，**绝不改画面比例**。
 */

/**
 * @param {Buffer|Uint8Array} src 源 rawvideo rgb24
 * @param {number} sw 源宽
 * @param {number} sh 源高
 * @param {Buffer|Uint8Array} dst 目标（dw*dh*3）
 * @param {number} dw
 * @param {number} dh
 */
export function coverInto(src, sw, sh, dst, dw, dh) {
  const f = Math.max(dw / sw, dh / sh);
  const rw = dw / f;
  const rh = dh / f;
  const ox = (sw - rw) / 2;
  const oy = (sh - rh) / 2;

  const x0s = new Int32Array(dw);
  const x1s = new Int32Array(dw);
  for (let x = 0; x < dw; x += 1) {
    const a = Math.floor(ox + (x * rw) / dw);
    const b = Math.floor(ox + ((x + 1) * rw) / dw);
    x0s[x] = a;
    x1s[x] = b > a ? b : a + 1;
  }
  const y0s = new Int32Array(dh);
  const y1s = new Int32Array(dh);
  for (let y = 0; y < dh; y += 1) {
    const a = Math.floor(oy + (y * rh) / dh);
    const b = Math.floor(oy + ((y + 1) * rh) / dh);
    y0s[y] = a;
    y1s[y] = b > a ? b : a + 1;
  }

  for (let y = 0; y < dh; y += 1) {
    const y0 = y0s[y];
    const y1 = y1s[y] > sh ? sh : y1s[y];
    const ny = y1 - y0;
    for (let x = 0; x < dw; x += 1) {
      let sx0 = x0s[x];
      let sx1 = x1s[x] > sw ? sw : x1s[x];
      if (sx0 >= sw) sx0 = sw - 1;
      if (sx1 <= sx0) sx1 = sx0 + 1;
      const nx = sx1 - sx0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let p = (sy * sw + sx0) * 3;
        for (let k = 0; k < nx; k += 1) {
          r += src[p];
          g += src[p + 1];
          b += src[p + 2];
          p += 3;
        }
      }
      const n = nx * ny;
      const o = (y * dw + x) * 3;
      dst[o] = r / n;
      dst[o + 1] = g / n;
      dst[o + 2] = b / n;
    }
  }
  return dst;
}
