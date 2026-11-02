/**
 * context-builder.js — 按优先级装载证据，超预算显式截断。
 */

import { createTokenGate } from './token-gate.js';
import { routeVisualNeed } from './visual-need-router.js';
import { buildSpeakerViews, buildPersonCards, SPEAKER_VIEW_HARD } from './speaker-view.js';
import { deriveJudgementState } from './evidence-bundle.js';

export function buildContext({
  retrieval,
  queryType,
  question,
  budget = {},
  criticalEvidenceIds = [],
  zoomRequests = 0,
  audioIndex = [],
  entityOverview = [],
}) {
  const gate = createTokenGate({ budget });
  const visual = routeVisualNeed({
    queryType,
    storyboardUnits: retrieval.storyboardUnits || [],
    question,
    maxZoomRequests: gate.limits.maxZoomRequests,
  });

  const conflicts = findConflicts(retrieval.events || []);

  const orderedEvents = [
    ...conflicts,
    ...(retrieval.events || []).filter((e) => !conflicts.includes(e)),
  ];

  // speaker 代表 utterance 已排在前；token gate 按顺序截断
  const enforced = gate.enforce({
    chapters: retrieval.chapters || [],
    events: orderedEvents,
    utterances: retrieval.utterances || [],
    storyboardUnits: visual.needVisual ? (visual.selected.length ? visual.selected : retrieval.storyboardUnits || []) : [],
    singleFrames: [],
    zoomRequests: visual.zoom ? visual.zoomRequests + zoomRequests : zoomRequests,
    criticalEvidenceIds: [
      ...criticalEvidenceIds,
      ...conflicts.flatMap((e) => e.evidenceIds || []),
    ],
  });

  const speakerPack = buildSpeakerViews(audioIndex, {
    maxSpeakers: SPEAKER_VIEW_HARD.maxSpeakers,
  });
  const personPack = buildPersonCards(entityOverview, audioIndex, {
    maxPersons: SPEAKER_VIEW_HARD.maxPersons,
  });

  const citations = [];
  for (const c of enforced.chapters) {
    for (const id of c.evidenceIds || []) citations.push({ evidenceId: id, from: 'chapter', chapterId: c.chapterId });
  }
  for (const e of enforced.events) {
    for (const id of e.evidenceIds || []) citations.push({ evidenceId: id, from: 'event', eventId: e.eventId });
  }
  for (const u of enforced.utterances) {
    const id = u.evidenceId || (u.evidenceIds || [])[0];
    if (id) {
      citations.push({
        evidenceId: id,
        from: 'utterance',
        speakerClusterId: u.speakerClusterId || u.speakerId || null,
      });
    }
  }
  for (const s of enforced.storyboardUnits) {
    for (const id of s.evidenceIds || []) citations.push({ evidenceId: id, from: 'storyboard', frameId: s.frameId });
  }

  let decision = 'llm';
  if (enforced.decision === 'insufficient') decision = 'insufficient';
  else if (queryType === 'text_structure' && enforced.chapters.length && !visual.needVisual) {
    decision = 'llm';
  }

  const reasons = [
    ...(visual.reasons || []),
    ...(retrieval.reasons || []),
    ...(enforced.budget.truncated ? ['budget_truncated'] : []),
    ...(speakerPack.truncated ? ['speaker_view_truncated'] : []),
    ...(personPack.truncated ? ['person_view_truncated'] : []),
  ];

  const visualEvidence = visual.needVisual ? stripScore(enforced.storyboardUnits) : [];
  const judgementState = deriveJudgementState({
    queryType,
    utterances: enforced.utterances,
    chapters: enforced.chapters,
    events: enforced.events,
    visualEvidence,
    speakers: speakerPack.speakers,
    conflicts,
    decision,
  });

  return {
    queryType,
    decision,
    judgementState,
    reasons,
    context: {
      metadata: retrieval.metadata || {},
      chapters: stripScore(enforced.chapters),
      events: stripScore(enforced.events),
      utterances: stripScore(enforced.utterances),
      speakers: speakerPack.speakers,
      persons: personPack.persons,
    },
    visualEvidence,
    citations,
    budget: enforced.budget,
    visual,
  };
}

function stripScore(arr) {
  return (arr || []).map((x) => {
    const { _score, _reasons, ...rest } = x;
    return rest;
  });
}

function findConflicts(events) {
  if (events.length < 2) return [];
  const out = [];
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i];
      const b = events[j];
      if ((a._score || 0) > 1 && (b._score || 0) > 1 && a.kind && b.kind && a.kind === b.kind) {
        if (Math.abs((a.startMs || 0) - (b.startMs || 0)) > 30_000) {
          if (!out.includes(a)) out.push(a);
          if (!out.includes(b)) out.push(b);
        }
      }
    }
  }
  return out.slice(0, 4);
}
