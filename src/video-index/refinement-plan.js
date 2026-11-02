/**
 * refinement-plan.js — 公开可确认的 on_demand ASR 计划（planHash + 落盘 + 幂等）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, readJson } from './atomic-json.js';
import { planAsrWindows, ON_DEMAND_ASR_HARD } from './on-demand-asr.js';

export function hashRefinementPlan(plan) {
  const norm = {
    kind: plan.kind,
    videoKey: plan.videoKey,
    baseRevision: plan.baseRevision,
    windows: (plan.windows || []).map((w) => ({
      startMs: Math.round(Number(w.startMs) || 0),
      endMs: Math.round(Number(w.endMs) || 0),
      reason: w.reason || null,
    })),
    reasons: [...(plan.reasons || [])].sort(),
    requires: {
      asr: Boolean(plan.requires?.asr),
      speechActivityAssist: Boolean(plan.requires?.speechActivityAssist),
    },
  };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 32);
}

export function buildOnDemandAsrPlan({
  videoKey,
  question = '',
  baseRevision = 1,
  durationMs = 0,
  coverage = null,
  retrieval = null,
  policy = null,
  reasons = [],
} = {}) {
  const windows = planAsrWindows({
    focusMs: retrieval?.utterances?.[0]?.startMs ?? null,
    gaps: coverage?.gaps || [],
    durationMs,
    policy,
  });
  const plan = {
    kind: 'on_demand_asr',
    status: 'pending_confirmation',
    videoKey,
    baseRevision: Number(baseRevision) || 1,
    windows,
    reasons: [...reasons],
    estimatedBudget: {
      maxWindows: windows.length,
      maxAudioSecondsPerWindow: policy?.budgets?.maxAudioSecondsPerWindow || 30,
      hardMaxWindowMs: ON_DEMAND_ASR_HARD.maxWindowMs,
    },
    requires: {
      asr: true,
      speechActivityAssist: false,
    },
    question: String(question || '').slice(0, 200),
  };
  plan.planHash = hashRefinementPlan(plan);
  return plan;
}

export function refinementDir(videoDir) {
  return join(videoDir, 'refinements');
}

export function saveRefinementPlan(videoDir, plan, { clock = () => new Date().toISOString() } = {}) {
  const dir = refinementDir(videoDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `plan-${plan.planHash}.json`);
  const body = {
    ...plan,
    savedAt: typeof clock === 'function' ? clock() : clock,
  };
  writeJsonAtomic(path, body);
  return { path, plan: body };
}

export function loadRefinementPlan(videoDir, planHash) {
  const path = join(refinementDir(videoDir), `plan-${planHash}.json`);
  if (!existsSync(path)) return null;
  return readJson(path);
}

export function loadRefinementExec(videoDir, planHash) {
  const path = join(refinementDir(videoDir), `exec-${planHash}.json`);
  if (!existsSync(path)) return null;
  return readJson(path, { optional: true });
}

export function assertPlanExecutable(plan, {
  videoKey,
  planHash,
  baseRevision,
  policy,
  durationMs = 0,
  confirmation = false,
} = {}) {
  if (!plan) {
    const err = new Error('refinement plan not found');
    err.code = 'PLAN_NOT_FOUND';
    throw err;
  }
  if (plan.videoKey !== videoKey) {
    const err = new Error('videoKey mismatch');
    err.code = 'PLAN';
    throw err;
  }
  const expected = hashRefinementPlan(plan);
  if (planHash && planHash !== expected && planHash !== plan.planHash) {
    const err = new Error('planHash mismatch');
    err.code = 'PLAN_HASH';
    throw err;
  }
  if (baseRevision != null && Number(plan.baseRevision) !== Number(baseRevision)) {
    const err = new Error('baseRevision changed');
    err.code = 'REVISION';
    throw err;
  }
  if (!confirmation) {
    const err = new Error('confirmation required');
    err.code = 'CONFIRM';
    throw err;
  }
  if (policy?.asr?.mode === 'off') {
    const err = new Error('asr.mode=off');
    err.code = 'ASR_OFF';
    throw err;
  }
  const maxWin = Math.min(
    ON_DEMAND_ASR_HARD.maxWindows,
    policy?.budgets?.maxRefineWindowsHardLimit
      ?? policy?.budgets?.maxRefineWindows
      ?? 3,
  );
  if ((plan.windows || []).length > maxWin) {
    const err = new Error('too many windows');
    err.code = 'PLAN';
    throw err;
  }
  const maxMs = ON_DEMAND_ASR_HARD.maxWindowMs;
  for (const w of plan.windows || []) {
    const a = Number(w.startMs) || 0;
    const b = Number(w.endMs) || 0;
    if (b < a) {
      const err = new Error('invalid window');
      err.code = 'PLAN';
      throw err;
    }
    if (b - a > maxMs) {
      const err = new Error('window too long');
      err.code = 'PLAN';
      throw err;
    }
    if (durationMs > 0 && (a >= durationMs || b > durationMs + 1000)) {
      const err = new Error('window beyond duration');
      err.code = 'PLAN';
      throw err;
    }
  }
  return { ok: true, planHash: expected };
}

export function listPriorAutoOnce(videoDir) {
  const dir = refinementDir(videoDir);
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('exec-') || !name.endsWith('.json')) continue;
    try {
      const body = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (body.autoOnceDone) return true;
    } catch { /* ignore */ }
  }
  return false;
}
