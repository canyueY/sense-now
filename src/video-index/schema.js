/**
 * schema.js — Manifest / EvidenceRef / StoryboardUnit / Chapter 校验。
 */

import { SCHEMA_VERSION } from './ids.js';

export const CAPABILITY_STATES = Object.freeze([
  'ready', 'unavailable', 'degraded', 'skipped', 'pending', 'disabled',
]);

export const INDEX_STATUSES = Object.freeze(['building', 'ready', 'degraded', 'failed']);

export const EVIDENCE_KINDS = Object.freeze([
  'subtitle', 'asr', 'frame', 'audio', 'event', 'metadata',
]);

export const BINDING_STATES = Object.freeze([
  'unbound', 'tentative', 'confirmed', 'conflict',
]);

export const DEFAULT_BUDGET = Object.freeze({
  maxChapters: 3,
  maxEvents: 12,
  maxUtterances: 20,
  maxTextTokens: 6000,
  maxStoryboardUnits: 4,
  maxSingleFrames: 2,
  maxZoomRequests: 2,
  maxVisualTokens: 8000,
});

function isIso(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function fail(msg) {
  const e = new Error(msg);
  e.code = 'SCHEMA';
  throw e;
}

export function validateManifest(m) {
  if (!m || typeof m !== 'object') fail('manifest must be object');
  if (m.schemaVersion !== SCHEMA_VERSION) fail(`unsupported schemaVersion: ${m.schemaVersion}`);
  if (!m.indexVersion || typeof m.indexVersion !== 'string') fail('indexVersion required');
  if (!m.videoKey || typeof m.videoKey !== 'string') fail('videoKey required');
  if (!m.source || typeof m.source !== 'object') fail('source required');
  if (!INDEX_STATUSES.includes(m.status)) fail(`invalid status: ${m.status}`);
  if (!isIso(m.createdAt) || !isIso(m.updatedAt)) fail('createdAt/updatedAt must be ISO-8601');
  if (!m.capabilities || typeof m.capabilities !== 'object') fail('capabilities required');
  for (const [k, v] of Object.entries(m.capabilities)) {
    if (!CAPABILITY_STATES.includes(v)) fail(`capability ${k} invalid: ${v}`);
  }
  if (!m.counts || typeof m.counts !== 'object') fail('counts required');
  return m;
}

export function validateEvidenceRef(e) {
  if (!e || typeof e !== 'object') fail('evidence must be object');
  if (!e.evidenceId || typeof e.evidenceId !== 'string') fail('evidenceId required');
  if (e.evidenceId.length > 80) fail('evidenceId too long');
  if (/[\\/]|\.\./.test(e.evidenceId)) fail('evidenceId path traversal');
  if (!EVIDENCE_KINDS.includes(e.kind)) fail(`invalid evidence kind: ${e.kind}`);
  if (!Number.isFinite(e.startMs) || !Number.isFinite(e.endMs)) fail('startMs/endMs required');
  if (e.endMs < e.startMs) fail('endMs < startMs');
  if (!e.ref || typeof e.ref !== 'string' || !e.ref.startsWith('evidence://')) {
    fail('ref must be evidence:// logical reference');
  }
  if (e.contentHash != null && typeof e.contentHash !== 'string') fail('contentHash must be string');
  if (e.sourceFile != null) {
    const sf = String(e.sourceFile);
    if (sf.includes('..') || sf.startsWith('/') || /^[a-zA-Z]:/.test(sf)) {
      fail('sourceFile must be relative inside index dir');
    }
  }
  if (!e.provenance || typeof e.provenance !== 'object') fail('provenance required');
  return e;
}

export function validateStoryboardUnit(u) {
  if (!u || typeof u !== 'object') fail('storyboard unit must be object');
  if (!u.frameId) fail('frameId required');
  if (!Number.isFinite(u.timestampMs)) fail('timestampMs required');
  if (!u.imageRef || !String(u.imageRef).startsWith('evidence://')) fail('imageRef required');
  if (!u.sourceSize || !Number.isFinite(u.sourceSize.width)) fail('sourceSize required');
  if (!u.storedSize || !Number.isFinite(u.storedSize.width)) fail('storedSize required');
  if (!u.roi || !Number.isFinite(u.roi.width)) fail('roi required (original coords)');
  if (!u.transform || typeof u.transform !== 'object') fail('transform required');
  if (!Array.isArray(u.selectionReasons)) fail('selectionReasons required');
  if (!Array.isArray(u.evidenceIds)) fail('evidenceIds required');
  return u;
}

export function validateChapter(c) {
  if (!c || typeof c !== 'object') fail('chapter must be object');
  if (!c.chapterId) fail('chapterId required');
  if (!Number.isFinite(c.startMs) || !Number.isFinite(c.endMs)) fail('startMs/endMs required');
  if (c.endMs < c.startMs) fail('endMs < startMs');
  if (c.summary != null && typeof c.summary !== 'string') fail('summary must be string');
  if (typeof c.summary === 'string') {
    const s = c.summary.trim().toLowerCase();
    if (s === 'todo' || s.startsWith('todo:') || s === 'tbd' || s === 'placeholder') {
      fail('pseudo summary not allowed');
    }
  }
  if (!Array.isArray(c.evidenceIds)) fail('evidenceIds required');
  if (!Array.isArray(c.eventIds)) fail('eventIds required');
  return c;
}

export function validatePersonBinding(p) {
  if (!p || typeof p !== 'object') fail('person must be object');
  if (!p.personId) fail('personId required');
  if (!BINDING_STATES.includes(p.bindingState)) fail(`invalid bindingState: ${p.bindingState}`);
  if (!Array.isArray(p.evidenceIds)) fail('evidenceIds required');
  if (p.label && /UP\s*主本人/i.test(p.label) && p.labelSource !== 'user-confirmed') {
    fail('cannot assert UP主本人 without user confirmation');
  }
  return p;
}

export function emptyCapabilities(overrides = {}) {
  return {
    metadata: 'pending',
    subtitles: 'pending',
    storyboard: 'pending',
    asr: 'unavailable',
    ocr: 'unavailable',
    diarization: 'unavailable',
    identityBinding: 'unavailable',
    subtitleText: 'pending',
    subtitleOcr: 'skipped',
    speechActivityAssist: 'disabled',
    onDemandVisual: 'skipped',
    onDemandAudio: 'skipped',
    profileSuggestion: 'skipped',
    evidenceAudit: 'skipped',
    ...overrides,
  };
}

export function createBuildingManifest({
  videoKey, source, indexVersion, clock = () => new Date().toISOString(),
}) {
  const now = clock();
  return {
    schemaVersion: SCHEMA_VERSION,
    indexVersion,
    videoKey,
    source: {
      kind: source.kind,
      uri: source.uri || source.url || source.path || null,
      partId: source.partId || null,
    },
    status: 'building',
    createdAt: now,
    updatedAt: now,
    capabilities: emptyCapabilities(),
    versions: {
      pipeline: '0.0.5+',
      retrieval: '1',
      adapters: {},
    },
    counts: {
      chapters: 0,
      events: 0,
      utterances: 0,
      storyboardUnits: 0,
      evidence: 0,
    },
  };
}

export function mergeBudget(partial = {}) {
  return { ...DEFAULT_BUDGET, ...partial };
}
