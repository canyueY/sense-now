/**
 * evidence-factory.js — 统一 evidence 契约（subtitle/OCR/ASR/frame）。
 */

import { contentHash, evidenceIdOf } from './ids.js';
import { evidenceLogicalRef } from './paths.js';
import { validateEvidenceRef } from './schema.js';

const MAX_ID_LEN = 80;

function safeId(id) {
  const s = String(id || '').replace(/[\\/..]/g, '_').slice(0, MAX_ID_LEN);
  if (!s || s.includes('..')) {
    const err = new Error('invalid evidenceId');
    err.code = 'EVIDENCE';
    throw err;
  }
  return s;
}

/**
 * @returns {object} validated evidence ref
 */
export function makeEvidence({
  videoKey,
  kind,
  startMs,
  endMs,
  text = null,
  buf = null,
  chunkId = null,
  revision = 1,
  confidence = null,
  sourceType = null,
  provenance = {},
  clock = () => new Date().toISOString(),
  sourceFile = null,
} = {}) {
  const sMs = Math.round(Number(startMs) || 0);
  const eMs = Math.round(Number(endMs) || sMs);
  const body = text != null
    ? `t|${String(text).normalize('NFKC').trim()}`
    : (buf ? buf : `${kind}|${sMs}|${eMs}`);
  const ch = contentHash(body);
  const eid = safeId(evidenceIdOf({
    videoKey, kind, startMs: sMs, endMs: eMs, contentHash: ch,
  }));
  const row = {
    evidenceId: eid,
    kind,
    startMs: sMs,
    endMs: eMs,
    ref: evidenceLogicalRef(videoKey, kind, eid),
    sourceFile,
    contentHash: ch,
    confidence: confidence == null ? null : Number(confidence),
    chunkId,
    revision: Number(revision) || 1,
    sourceType: sourceType || kind,
    provenance: {
      adapter: provenance.adapter || 'evidence-factory',
      version: provenance.version || '1',
      generatedAt: typeof clock === 'function' ? clock() : clock,
      source: sourceType || provenance.source || null,
      ...provenance,
    },
  };
  return validateEvidenceRef(row);
}

export function assertEvidenceBatch(list = []) {
  const out = [];
  const errors = [];
  for (const e of list) {
    try {
      out.push(validateEvidenceRef(e));
    } catch (err) {
      errors.push({ evidenceId: e?.evidenceId, message: err.message });
    }
  }
  return { ok: errors.length === 0, evidence: out, errors };
}
