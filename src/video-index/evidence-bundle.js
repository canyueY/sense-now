/**
 * evidence-bundle.js — 三源证据包与 judgementState（非多数投票）。
 */

export const JUDGEMENT_STATES = Object.freeze([
  'supported', 'partially_supported', 'conflict', 'insufficient',
]);

/**
 * 组装统一证据包。
 */
export function buildEvidenceBundle({
  segmentId = null,
  timeRange = null,
  subtitleEvidenceIds = [],
  asrEvidenceIds = [],
  frameEvidenceIds = [],
  speakerIds = [],
  confidence = null,
  conflicts = [],
} = {}) {
  return {
    segmentId,
    timeRange: timeRange || { startMs: null, endMs: null },
    subtitleEvidenceIds: [...subtitleEvidenceIds],
    asrEvidenceIds: [...asrEvidenceIds],
    frameEvidenceIds: [...frameEvidenceIds],
    speakerIds: [...speakerIds],
    confidence,
    conflicts: [...conflicts],
  };
}

/**
 * 根据检索结果推导 judgementState。
 * - 口述：字幕/ASR 为主
 * - 视觉：画面为主
 * - 谁在说：需 speaker + 话语
 */
export function deriveJudgementState({
  queryType = 'text_structure',
  utterances = [],
  chapters = [],
  events = [],
  visualEvidence = [],
  speakers = [],
  conflicts = [],
  decision = null,
} = {}) {
  if (decision === 'insufficient') return 'insufficient';
  if (conflicts?.length) return 'conflict';

  const hasText = (utterances?.length || 0) + (chapters?.length || 0) + (events?.length || 0) > 0;
  const hasVisual = (visualEvidence?.length || 0) > 0;
  const hasSpeaker = (speakers?.length || 0) > 0
    || (utterances || []).some((u) => u.speakerClusterId || u.speakerId);

  if (queryType === 'visual' || queryType === 'visual_detail') {
    if (!hasVisual && !hasText) return 'insufficient';
    if (hasVisual) return 'supported';
    return 'partially_supported';
  }

  if (queryType === 'multimodal') {
    if (!hasText && !hasSpeaker) return 'insufficient';
    if (hasText && hasSpeaker) return 'supported';
    return 'partially_supported';
  }

  if (!hasText && !hasVisual) return 'insufficient';
  if (hasText) return 'supported';
  return 'partially_supported';
}

/**
 * 重写 evidenceId 时同步更新 utterances / segments / events / timeline / bundles。
 */
export function remapEvidenceIds(indexData, idMap = {}) {
  if (!idMap || !Object.keys(idMap).length) return indexData;
  const mapOne = (id) => (idMap[id] != null ? idMap[id] : id);
  const mapArr = (arr) => (arr || []).map(mapOne);
  const mapObj = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const next = { ...obj };
    if (next.evidenceId) next.evidenceId = mapOne(next.evidenceId);
    if (Array.isArray(next.evidenceIds)) next.evidenceIds = mapArr(next.evidenceIds);
    if (Array.isArray(next.subtitleEvidenceIds)) {
      next.subtitleEvidenceIds = mapArr(next.subtitleEvidenceIds);
    }
    if (Array.isArray(next.asrEvidenceIds)) next.asrEvidenceIds = mapArr(next.asrEvidenceIds);
    if (Array.isArray(next.frameEvidenceIds)) {
      next.frameEvidenceIds = mapArr(next.frameEvidenceIds);
    }
    return next;
  };
  return {
    ...indexData,
    utterances: (indexData.utterances || []).map(mapObj),
    events: (indexData.events || []).map(mapObj),
    chapters: (indexData.chapters || []).map(mapObj),
    timeline: (indexData.timeline || []).map(mapObj),
    subtitleSegments: (indexData.subtitleSegments || []).map(mapObj),
    evidenceIndex: (indexData.evidenceIndex || []).map(mapObj),
    storyboardIndex: (indexData.storyboardIndex || []).map(mapObj),
    evidenceBundles: (indexData.evidenceBundles || []).map(mapObj),
  };
}
