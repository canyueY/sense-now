/**
 * on-demand-asr.js — query/refine 局部 ASR（与 VAD 授权独立）。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mayRunAsr } from './analysis-policy.js';
import { makeEvidence, assertEvidenceBatch } from './evidence-factory.js';

const HARD = Object.freeze({
  defaultWindowMs: 20_000,
  maxWindowMs: 120_000,
  maxWindows: 3,
});

export function needsOnDemandAsr({
  question = '',
  retrieval = null,
  coverage = null,
  policy = null,
} = {}) {
  if (!policy || policy.asr?.mode !== 'on_demand') return { ok: false, reasons: ['mode'] };
  const q = String(question || '');
  const reasons = [];
  const hits = retrieval?.utterances?.length || retrieval?.hits?.length || 0;
  if (hits < 2) reasons.push('subtitle_hits_insufficient');
  if (/谁在说|谁说的|谁讲|which speaker|who (is )?speaking/i.test(q)) {
    reasons.push('who_speaking');
  }
  if (/语气|原话|听起来|声音|tone|verbatim|what.*(say|said)/i.test(q)) {
    reasons.push('audio_verbatim');
  }
  if (coverage?.gapCount > 0 || (coverage?.textCoverageRatio != null && coverage.textCoverageRatio < 0.4)) {
    reasons.push('subtitle_gap');
  }
  const lowConf = (retrieval?.utterances || []).some((u) => (u.confidence ?? 1) < 0.55);
  if (lowConf) reasons.push('low_ocr_confidence');
  if (/\d{2,}|专名|人名|数字/.test(q) && hits > 0) {
    // 数字/专名冲突启发式：命中文本与问题数字不一致时
    const nums = q.match(/\d+/g) || [];
    if (nums.length) {
      const joined = (retrieval?.utterances || []).map((u) => u.text || '').join(' ');
      if (nums.some((n) => !joined.includes(n))) reasons.push('number_conflict');
    }
  }
  return { ok: reasons.length > 0, reasons };
}

export function planAsrWindows({
  focusMs = null,
  gaps = [],
  durationMs = 0,
  policy = null,
  maxWindows = null,
} = {}) {
  const maxN = Math.min(
    HARD.maxWindows,
    Number(maxWindows) || policy?.budgets?.maxRefineWindows || 2,
  );
  const winMs = Math.min(
    HARD.maxWindowMs,
    Math.max(
      1000,
      (Number(policy?.budgets?.maxAudioSecondsPerWindow) || 30) * 1000,
    ),
  );
  const half = Math.floor(winMs / 2);
  const windows = [];
  if (Number.isFinite(focusMs)) {
    const startMs = Math.max(0, focusMs - half);
    const endMs = Math.min(durationMs || focusMs + half, startMs + winMs);
    windows.push({ startMs, endMs, reason: 'focus' });
  }
  for (const g of gaps || []) {
    if (windows.length >= maxN) break;
    const mid = Math.floor(((g.startMs || 0) + (g.endMs || 0)) / 2);
    const startMs = Math.max(0, mid - half);
    const endMs = Math.min(durationMs || startMs + winMs, startMs + winMs);
    if (windows.some((w) => Math.abs(w.startMs - startMs) < 2000)) continue;
    windows.push({ startMs, endMs, reason: g.reason || 'gap' });
  }
  if (!windows.length && durationMs > 0) {
    windows.push({
      startMs: 0,
      endMs: Math.min(durationMs, winMs),
      reason: 'default',
    });
  }
  return windows.slice(0, maxN);
}

/**
 * 执行局部 ASR；不覆盖原字幕 evidence。
 */
export async function runOnDemandAsrWindows({
  videoKey,
  windows = [],
  mediaPath = null,
  audioPath = null,
  asr,
  extractAudio = null,
  tempDir,
  policy,
  signal,
  chunkId = null,
  revision = 1,
  clock = () => new Date().toISOString(),
} = {}) {
  const gate = mayRunAsr(policy, { reason: 'on_demand' });
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason || 'asr_blocked',
      utterances: [],
      evidence: [],
      asrCalls: 0,
    };
  }
  if (!asr?.available?.().ok) {
    return {
      ok: false, reason: 'unavailable', utterances: [], evidence: [], asrCalls: 0,
    };
  }

  const utterances = [];
  const evidence = [];
  let asrCalls = 0;
  mkdirSync(tempDir, { recursive: true });

  for (const w of windows) {
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    let wav = audioPath;
    if (extractAudio && mediaPath && existsSync(mediaPath)) {
      const out = join(tempDir, `asr-${w.startMs}-${w.endMs}.wav`);
      const r = await extractAudio({
        inputPath: mediaPath,
        outputPath: out,
        startMs: w.startMs,
        endMs: w.endMs,
        signal,
      });
      wav = r?.path || out;
    }
    if (!wav || !existsSync(wav)) continue;
    asrCalls += 1;
    const asrOut = await asr.analyze({
      videoKey,
      audioPath: wav,
      offsetMs: w.startMs,
      chunkId,
      language: null,
    }, { signal });
    if (!asrOut?.ok) continue;
    for (const u of asrOut.utterances || []) {
      const row = {
        ...u,
        source: 'asr_generated',
        sourceType: 'asr_generated',
        chunkId,
        revision,
        provenance: {
          ...(u.provenance || {}),
          source: 'asr_generated',
          onDemand: true,
          window: w,
        },
      };
      utterances.push(row);
      try {
        evidence.push(makeEvidence({
          videoKey,
          kind: 'asr',
          startMs: row.startMs,
          endMs: row.endMs,
          text: row.text,
          chunkId,
          revision,
          confidence: row.confidence,
          sourceType: 'asr_generated',
          provenance: { adapter: 'on-demand-asr', source: 'asr_generated', onDemand: true },
          clock,
        }));
      } catch { /* skip */ }
    }
    for (const e of asrOut.evidence || []) {
      evidence.push({ ...e, revision, sourceType: e.sourceType || 'asr_generated' });
    }
  }

  const checked = assertEvidenceBatch(evidence);
  return {
    ok: utterances.length > 0,
    reason: utterances.length ? null : 'no_asr_text',
    utterances,
    evidence: checked.evidence,
    evidenceErrors: checked.errors,
    asrCalls,
    windows,
    revision,
  };
}

export { HARD as ON_DEMAND_ASR_HARD };
