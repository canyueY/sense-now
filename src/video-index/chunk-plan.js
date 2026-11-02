/**
 * chunk-plan.js — 超长视频半开区间 [startMs, endMs) 分块规划。
 */

export const DEFAULT_CHUNK_MS = 5 * 60_000;
export const DEFAULT_OVERLAP_MS = 20_000;
export const LAYOUT_VERSION = 'chunk-v1';

/**
 * @param {{ durationMs: number, chunkMs?: number, overlapMs?: number }} opts
 * @returns {Array<{ chunkId: string, index: number, startMs: number, endMs: number, inputStartMs: number, inputEndMs: number }>}
 */
export function planChunks({
  durationMs,
  chunkMs = DEFAULT_CHUNK_MS,
  overlapMs = DEFAULT_OVERLAP_MS,
} = {}) {
  const dur = Number(durationMs);
  const size = Math.max(1_000, Number(chunkMs) || DEFAULT_CHUNK_MS);
  const overlap = Math.max(0, Math.min(Number(overlapMs) || 0, Math.floor(size / 2)));
  if (!Number.isFinite(dur) || dur <= 0) {
    return [{
      chunkId: chunkIdOf(0),
      index: 0,
      startMs: 0,
      endMs: 0,
      inputStartMs: 0,
      inputEndMs: 0,
    }];
  }

  const out = [];
  let start = 0;
  let i = 0;
  while (start < dur) {
    const end = Math.min(dur, start + size);
    const inputStartMs = Math.max(0, start - overlap);
    const inputEndMs = Math.min(dur, end + overlap);
    out.push({
      chunkId: chunkIdOf(i),
      index: i,
      startMs: start,
      endMs: end,
      inputStartMs,
      inputEndMs,
    });
    i += 1;
    start = end;
    if (i > 100_000) throw new Error('chunk plan overflow');
  }
  return out;
}

export function chunkIdOf(index) {
  const n = Math.max(0, Math.floor(Number(index) || 0));
  return String(n).padStart(6, '0');
}

/**
 * overlap 窗口内 utterance 的 core 区间所有权：中点落在 [startMs, endMs) 才属于该 chunk。
 */
export function ownsByMidpoint(item, chunk) {
  const a = Number(item?.startMs);
  const b = Number(item?.endMs ?? a);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const mid = (a + b) / 2;
  return mid >= chunk.startMs && mid < chunk.endMs;
}

/**
 * 将相对 chunk 输入窗口的时间转为视频绝对时间。
 */
export function toAbsoluteTime(localMs, offsetMs) {
  const local = Number(localMs);
  const off = Number(offsetMs) || 0;
  if (!Number.isFinite(local)) return null;
  return local + off;
}

/**
 * ASR/事件去重：时间重叠 + 规范化文本（+ speaker）。
 */
export function dedupeUtterancesAcrossOverlap(items = [], { timeSlopMs = 400 } = {}) {
  const norm = (t) => String(t || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const kept = [];
  for (const u of items) {
    const text = norm(u.text);
    const sp = u.speakerClusterId || u.speakerId || '';
    const dup = kept.find((k) => {
      const ksp = k.speakerClusterId || k.speakerId || '';
      if (sp !== ksp) return false;
      if (norm(k.text) !== text || !text) return false;
      const overlap = Math.min(k.endMs, u.endMs) - Math.max(k.startMs, u.startMs);
      return overlap >= -timeSlopMs;
    });
    if (!dup) {
      kept.push(u);
      continue;
    }
    const confU = Number(u.confidence) || 0;
    const confK = Number(dup.confidence) || 0;
    if (confU > confK) {
      const i = kept.indexOf(dup);
      kept[i] = u;
    }
  }
  return kept;
}
