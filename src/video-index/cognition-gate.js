/**
 * cognition-gate.js — 默认沉默：普通索引事件不唤醒模型。
 */

const ALLOW_USER = new Set([
  'user_question',
  'user_summary_request',
  'user_deep_analysis',
  'user_compare',
  'user_identity_review',
  'user_conflict_review',
]);

const SKIP_EVENTS = new Set([
  'chapter_complete',
  'asr_added',
  'scene_change',
  'subtitle_added',
  'entity_detected',
  'storyboard_unit',
  'index_progress',
]);

/**
 * @param {{
 *   trigger: string,
 *   hasUserQuestion?: boolean,
 *   indexCanAnswer?: boolean,
 *   requiredEvidenceIds?: string[],
 *   highValueCandidate?: boolean,
 * }} input
 */
export function evaluateCognition(input = {}) {
  const {
    trigger = 'unknown',
    hasUserQuestion = false,
    indexCanAnswer = false,
    requiredEvidenceIds = [],
    highValueCandidate = false,
  } = input;

  const reasons = [];

  if (SKIP_EVENTS.has(trigger) && !hasUserQuestion) {
    reasons.push(`skip_event:${trigger}`);
    if (highValueCandidate) {
      return {
        state: 'candidate',
        decision: 'local',
        reasons: [...reasons, 'high_value_marked_candidate_only'],
        requiredEvidenceIds: [...requiredEvidenceIds],
      };
    }
    return {
      state: 'skipped',
      decision: 'local',
      reasons,
      requiredEvidenceIds: [],
    };
  }

  if (hasUserQuestion || ALLOW_USER.has(trigger)) {
    reasons.push(hasUserQuestion ? 'user_question' : `allow:${trigger}`);
    if (indexCanAnswer && requiredEvidenceIds.length === 0) {
      return {
        state: 'ready',
        decision: 'local',
        reasons: [...reasons, 'index_sufficient'],
        requiredEvidenceIds: [],
      };
    }
    if (!indexCanAnswer && requiredEvidenceIds.length > 0) {
      return {
        state: 'ready',
        decision: 'llm',
        reasons: [...reasons, 'needs_llm_with_evidence'],
        requiredEvidenceIds: [...requiredEvidenceIds],
      };
    }
    return {
      state: 'ready',
      decision: 'llm',
      reasons: [...reasons, 'user_request'],
      requiredEvidenceIds: [...requiredEvidenceIds],
    };
  }

  if (highValueCandidate) {
    return {
      state: 'candidate',
      decision: 'local',
      reasons: ['high_value_candidate_no_auto_wake'],
      requiredEvidenceIds: [...requiredEvidenceIds],
    };
  }

  return {
    state: 'deferred',
    decision: 'queue',
    reasons: [`unknown_trigger:${trigger}`],
    requiredEvidenceIds: [],
  };
}
