/**
 * refinement-planner.js — ask / auto_once 二次分析守卫。
 */

import { assertPlanAllowed, hashRetryPlan } from './evidence-auditor.js';

/**
 * 根据 policy 决定是否可执行写盘二次分析。
 */
export function decideSecondPass({
  policy,
  audit,
  confirmation = null,
  priorAutoOnceDone = false,
} = {}) {
  const mode = policy?.secondPass?.mode
    || (policy?.postAnalysisAudit?.enabled ? policy.postAnalysisAudit.retryMode : 'off')
    || 'off';

  if (mode === 'off') {
    return {
      execute: false,
      mode,
      reportOnly: Boolean(audit),
      reason: 'off',
    };
  }

  if (!audit?.retryPlan) {
    return { execute: false, mode, reportOnly: true, reason: 'no_plan' };
  }

  if (mode === 'ask') {
    if (!confirmation?.planHash) {
      return {
        execute: false,
        mode: 'ask',
        reportOnly: true,
        reason: 'awaiting_confirmation',
        planHash: audit.planHash || hashRetryPlan(audit.retryPlan),
        retryPlan: audit.retryPlan,
      };
    }
    try {
      assertPlanAllowed(audit.retryPlan, {
        expectedHash: confirmation.planHash,
        policy,
      });
    } catch (e) {
      return {
        execute: false,
        mode: 'ask',
        reportOnly: true,
        reason: e.code || 'PLAN',
        detail: e.message,
      };
    }
    return {
      execute: true,
      mode: 'ask',
      reportOnly: false,
      retryPlan: audit.retryPlan,
      planHash: confirmation.planHash,
    };
  }

  if (mode === 'auto_once') {
    if (priorAutoOnceDone) {
      return {
        execute: false,
        mode: 'auto_once',
        reportOnly: true,
        reason: 'already_executed',
      };
    }
    try {
      assertPlanAllowed(audit.retryPlan, { policy });
    } catch (e) {
      return {
        execute: false,
        mode: 'auto_once',
        reportOnly: true,
        reason: e.code || 'PLAN',
        detail: e.message,
      };
    }
    return {
      execute: true,
      mode: 'auto_once',
      reportOnly: false,
      retryPlan: audit.retryPlan,
      planHash: audit.planHash,
    };
  }

  return { execute: false, mode, reportOnly: true, reason: 'unknown_mode' };
}
