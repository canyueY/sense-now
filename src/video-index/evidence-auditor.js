/**
 * evidence-auditor.js — 逻辑复核：只产出 issues + retryPlan，不写盘。
 */

import { createHash } from 'node:crypto';

const WHITELIST = new Set([
  'scanFps', 'roi', 'width', 'height', 'density', 'audioContextMs',
  'ocrLanguage', 'bilingualSplit', 'sceneThreshold', 'dedupeThreshold',
  'localAsr',
]);

export function hashRetryPlan(plan) {
  const body = JSON.stringify(plan, Object.keys(plan || {}).sort());
  return createHash('sha256').update(body).digest('hex').slice(0, 24);
}

export function auditIndexEvidence({
  coverage = null,
  utterances = [],
  segments = [],
  catalog = null,
  policy = null,
  speechActivity = null,
} = {}) {
  const issues = [];
  const texts = (segments.length ? segments : utterances).map((u) => ({
    startMs: u.startMs,
    endMs: u.endMs,
    text: u.text || '',
  })).sort((a, b) => a.startMs - b.startMs);

  let reverse = 0;
  let overlap = 0;
  for (let i = 1; i < texts.length; i += 1) {
    if (texts[i].startMs < texts[i - 1].startMs) reverse += 1;
    if (texts[i].startMs < texts[i - 1].endMs - 200) overlap += 1;
  }
  if (reverse > 0) {
    issues.push({
      code: 'TIME_REVERSE',
      severity: 'warn',
      detail: `${reverse} reverse-ordered subtitle pairs`,
    });
  }
  if (overlap > texts.length * 0.35 && texts.length > 8) {
    issues.push({
      code: 'TIME_OVERLAP',
      severity: 'warn',
      detail: 'excessive subtitle time overlaps',
    });
  }

  const chunks = Array.isArray(catalog?.chunks) ? catalog.chunks : [];
  if (chunks.length >= 4) {
    const mid = Math.floor(chunks.length / 2);
    const earlyTags = chunks.slice(0, mid).flatMap((c) => c.topicTags || []).length;
    const lateTags = chunks.slice(mid).flatMap((c) => c.topicTags || []).length;
    if (earlyTags > 8 && lateTags === 0) {
      issues.push({
        code: 'FRONT_BIAS',
        severity: 'warn',
        detail: 'chapter/topic coverage concentrated in first half',
      });
    }
  }

  if (coverage?.gapCount >= 3) {
    issues.push({
      code: 'SUBTITLE_GAPS',
      severity: 'info',
      detail: `${coverage.gapCount} text gaps`,
      windows: (coverage.gaps || []).slice(0, 3).map((g) => ({
        startMs: g.startMs,
        endMs: g.endMs,
      })),
    });
  }

  if (policy?.speechActivityAssist?.enabled && speechActivity?.speechRanges?.length) {
    const noText = (coverage?.gaps || []).filter((g) => {
      return speechActivity.speechRanges.some((r) => r.startMs < g.endMs && r.endMs > g.startMs);
    });
    if (noText.length) {
      issues.push({
        code: 'SPEECH_WITHOUT_TEXT',
        severity: 'info',
        detail: 'speech activity overlaps subtitle gaps (suggest rescan; not proof of burned-in text)',
        windows: noText.slice(0, 3),
      });
    }
  }

  const retryPlan = buildRetryPlan(issues, policy);
  return {
    issues,
    retryPlan,
    planHash: retryPlan ? hashRetryPlan(retryPlan) : null,
  };
}

function buildRetryPlan(issues, policy) {
  const windows = [];
  for (const issue of issues) {
    for (const w of issue.windows || []) {
      if (windows.length >= (policy?.budgets?.maxRefineWindows ?? 2)) break;
      windows.push({
        startMs: w.startMs,
        endMs: w.endMs,
        actions: sanitizeActions({
          scanFps: Math.min(4, policy?.subtitleFirst?.retryScanFps || 3),
          roi: 'auto',
        }),
      });
    }
  }
  if (!windows.length && issues.some((i) => i.code === 'FRONT_BIAS')) {
    return null;
  }
  if (!windows.length) return null;
  return {
    version: 1,
    windows,
    asrSuggested: policy?.asr?.mode === 'off' ? 'enable_fallback_or_full' : null,
    maxPasses: 1,
  };
}

export function sanitizeActions(actions = {}) {
  const out = {};
  for (const [k, v] of Object.entries(actions)) {
    if (!WHITELIST.has(k)) continue;
    if (k === 'scanFps') {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 4) continue;
      out.scanFps = n;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function assertPlanAllowed(plan, { expectedHash, policy } = {}) {
  if (!plan) {
    const err = new Error('retry plan required');
    err.code = 'PLAN';
    throw err;
  }
  const hash = hashRetryPlan(plan);
  if (expectedHash && hash !== expectedHash) {
    const err = new Error('retry plan hash mismatch');
    err.code = 'PLAN_HASH';
    throw err;
  }
  const maxWin = Math.min(
    3,
    policy?.budgets?.maxRefineWindowsHardLimit
      ?? policy?.budgets?.maxRefineWindows
      ?? 2,
  );
  if ((plan.windows || []).length > maxWin) {
    const err = new Error('too many refine windows');
    err.code = 'PLAN';
    throw err;
  }
  for (const w of plan.windows || []) {
    for (const k of Object.keys(w.actions || {})) {
      if (!WHITELIST.has(k)) {
        const err = new Error(`action not whitelisted: ${k}`);
        err.code = 'PLAN';
        throw err;
      }
    }
    if (w.actions?.scanFps > 4) {
      const err = new Error('scanFps hard max 4');
      err.code = 'PLAN';
      throw err;
    }
  }
  return { ok: true, planHash: hash };
}

export { WHITELIST as RETRY_ACTION_WHITELIST };
