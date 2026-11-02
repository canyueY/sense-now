/**
 * coverage.js — scan / text / speech 覆盖率语义分离。
 * 半开区间；扫描提前结束不得虚报完整。
 */

function clampRange(r, lo, hi) {
  const startMs = Math.max(lo, Math.min(hi, Number(r.startMs) || 0));
  const endMs = Math.max(startMs, Math.min(hi, Number(r.endMs) || startMs));
  return { startMs, endMs };
}

export function mergeRanges(ranges = [], { lo = 0, hi = Infinity } = {}) {
  const sorted = [...ranges]
    .map((r) => clampRange(r, lo, Number.isFinite(hi) ? hi : (Number(r.endMs) || 0)))
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, r.endMs);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

export function rangeDurationMs(ranges = []) {
  let n = 0;
  for (const r of ranges) n += Math.max(0, r.endMs - r.startMs);
  return n;
}

export function invertRanges(covered = [], { startMs = 0, endMs = 0 } = {}) {
  const gaps = [];
  let cursor = startMs;
  for (const r of mergeRanges(covered, { lo: startMs, hi: endMs })) {
    if (r.startMs > cursor) gaps.push({ startMs: cursor, endMs: r.startMs });
    cursor = Math.max(cursor, r.endMs);
  }
  if (endMs > cursor) gaps.push({ startMs: cursor, endMs });
  return gaps;
}

/**
 * @param {{
 *   durationMs?: number,
 *   targetStartMs?: number,
 *   targetEndMs?: number,
 *   textRanges?: Array,
 *   sampledRanges?: Array,
 *   missingRanges?: Array,
 *   failedRanges?: Array,
 *   truncated?: boolean,
 *   limitReasons?: string[],
 *   sourceCoverage?: object,
 *   speechRanges?: Array|null,
 *   vadAuthorized?: boolean,
 *   vadRan?: boolean,
 * }} input
 */
export function buildCoverageReport(input = {}) {
  const targetStart = Math.max(0, Number(input.targetStartMs) || 0);
  const durationMs = Math.max(0, Number(input.durationMs) || 0);
  const targetEnd = input.targetEndMs != null
    ? Math.max(targetStart, Number(input.targetEndMs) || targetStart)
    : targetStart + durationMs;
  const targetDur = Math.max(0, targetEnd - targetStart);

  const sampledRanges = mergeRanges(input.sampledRanges || [], {
    lo: targetStart, hi: targetEnd,
  });
  const textRanges = mergeRanges(input.textRanges || [], {
    lo: targetStart, hi: targetEnd,
  });

  // 未扫描区域不得算进 scanned
  const truncated = Boolean(input.truncated);
  const limitReasons = [...new Set(input.limitReasons || [])];
  const failedRanges = (input.failedRanges || []).map((r) => ({
    ...clampRange(r, targetStart, targetEnd),
    reason: r.reason || 'failed',
  }));

  const scannedMs = rangeDurationMs(sampledRanges);
  const textMs = rangeDurationMs(textRanges);
  const scanCoverageRatio = targetDur > 0 ? Math.min(1, scannedMs / targetDur) : 0;
  const textCoverageRatio = targetDur > 0 ? Math.min(1, textMs / targetDur) : 0;

  let speechCoverageRatio = null;
  let speechRanges = null;
  if (input.vadAuthorized && input.vadRan && Array.isArray(input.speechRanges)) {
    speechRanges = mergeRanges(input.speechRanges, { lo: targetStart, hi: targetEnd });
    speechCoverageRatio = targetDur > 0
      ? Math.min(1, rangeDurationMs(speechRanges) / targetDur)
      : 0;
  }

  const missingRanges = input.missingRanges?.length
    ? mergeRanges(input.missingRanges, { lo: targetStart, hi: targetEnd })
    : invertRanges(textRanges, { startMs: targetStart, endMs: targetEnd });

  // 无讲话区间不自动算字幕失败：仅标记 no_text，不计入 failed
  const gaps = missingRanges.map((g) => ({ ...g, reason: 'no_text' }));

  const confs = (input.textRanges || [])
    .map((r) => Number(r.confidence) || 0)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const confidenceP50 = confs.length ? confs[Math.floor(confs.length / 2)] : 0;

  const status = truncated
    ? 'truncated'
    : (textCoverageRatio >= 0.7 ? 'good' : textCoverageRatio >= 0.3 ? 'partial' : 'poor');

  return {
    durationMs: targetDur,
    targetStartMs: targetStart,
    targetEndMs: targetEnd,
    scannedRanges: sampledRanges,
    sampledRanges,
    textRanges,
    speechRanges,
    missingRanges: gaps,
    gaps,
    failedRanges,
    truncated,
    limitReasons,
    scanCoverageRatio,
    textCoverageRatio,
    speechCoverageRatio,
    // 兼容旧字段：不再用「整片 0..duration」冒充扫描完成
    coverageRatio: textCoverageRatio,
    confidenceP50,
    gapCount: gaps.length,
    status,
    sourceCoverage: input.sourceCoverage || {},
  };
}

/** 兼容旧 API */
export function buildCoverage(segments = [], durationMs = 0) {
  return buildCoverageReport({
    durationMs,
    textRanges: segments,
    sampledRanges: segments?.length
      ? [{ startMs: 0, endMs: durationMs }]
      : [],
    truncated: false,
  });
}
