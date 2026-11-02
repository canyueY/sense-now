/**
 * utterance-end-frame.js — 段尾稳定帧（默认关闭；需 effective policy 明确开启）。
 */

function meanLuma(buf) {
  if (!buf?.length) return 0;
  let s = 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 12) {
    s += 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
    n += 1;
  }
  return n ? s / n : 0;
}

function sharpnessProxy(buf, width, height) {
  if (!buf || width < 3 || height < 3) return 0;
  let acc = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y += 4) {
    for (let x = 1; x < width - 1; x += 4) {
      const i = (y * width + x) * 3;
      const c = buf[i];
      const dx = Math.abs(c - buf[i + 3]);
      const dy = Math.abs(c - buf[i + width * 3]);
      acc += dx + dy;
      n += 1;
    }
  }
  return n ? acc / n : 0;
}

function similarFrame(a, b) {
  if (!a?.buf || !b?.buf || a.buf.length !== b.buf.length) return false;
  let diff = 0;
  const step = 24;
  for (let i = 0; i < a.buf.length; i += step) {
    if (Math.abs(a.buf[i] - b.buf[i]) > 20) diff += 1;
  }
  return (diff / Math.max(1, Math.floor(a.buf.length / step))) < 0.08;
}

/**
 * @param {{ utterances, extractFrameAt, maxPerChunk, signal }} opts
 */
export async function selectUtteranceEndFrames({
  utterances = [],
  extractFrameAt,
  maxPerChunk = 12,
  hardMax = 32,
  signal,
} = {}) {
  const limit = Math.min(hardMax, Math.max(0, Number(maxPerChunk) || 0));
  if (!limit || !extractFrameAt) return { frames: [], skipped: true };

  const picked = [];
  const sorted = [...utterances]
    .filter((u) => Number.isFinite(u.endMs))
    .sort((a, b) => a.endMs - b.endMs);

  for (const u of sorted) {
    if (picked.length >= limit) break;
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const windowStart = Math.max(0, u.endMs - 1200);
    const windowEnd = u.endMs + 300;
    const samples = [];
    for (let t = windowStart; t <= windowEnd; t += 300) {
      const fr = await extractFrameAt({ atMs: t, signal });
      if (!fr?.buf) continue;
      const luma = meanLuma(fr.buf);
      if (luma < 12 || luma > 245) continue; // 黑/白闪
      const sharp = sharpnessProxy(fr.buf, fr.width, fr.height);
      if (sharp < 4) continue; // 模糊/转场近似
      samples.push({
        tMs: t,
        buf: fr.buf,
        width: fr.width,
        height: fr.height,
        sharp,
        distToEnd: Math.abs(t - u.endMs),
        utteranceEndMs: u.endMs,
        utteranceIds: [u.utteranceId || u.evidenceId].filter(Boolean),
      });
    }
    if (!samples.length) continue;
    samples.sort((a, b) => (a.distToEnd - b.distToEnd) || (b.sharp - a.sharp));
    const best = samples[0];
    const dup = picked.find((p) => similarFrame(p, best));
    if (dup) {
      dup.utteranceIds.push(...best.utteranceIds);
      continue;
    }
    picked.push(best);
  }

  return {
    frames: picked.map(({ buf, ...meta }) => ({ ...meta, buf })),
    skipped: false,
  };
}
