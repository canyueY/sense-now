/**
 * asr-adapter.js — 外部命令 JSON 协议适配器。
 *
 * 协议：命令接收 stdin JSON `{ "audioPath", "videoKey", "language?" }`，
 * stdout 输出 `{ "utterances": [{ "startMs", "endMs", "text", "speakerClusterId?", "confidence?" }] }`。
 * 禁止假转写；不可用时 available() 返回 unavailable。
 */

import { contentHash, evidenceIdOf } from '../ids.js';
import { evidenceLogicalRef } from '../paths.js';
import { validateEvidenceRef } from '../schema.js';
import { spawnBounded } from '../bounded-stdio.js';

const MAX_UTTERANCES = 20_000;
const MAX_TEXT = 8_000;

const HARD_TIMEOUT_CAP_MS = 600_000;

export function createAsrAdapter({
  command = null,
  args = [],
  runner = null,
  timeoutMs = 120_000,
  clock = () => new Date().toISOString(),
  name = 'asr-external',
  version = '1',
} = {}) {
  const cappedTimeout = Math.min(
    Math.max(1_000, Number(timeoutMs) || 120_000),
    HARD_TIMEOUT_CAP_MS,
  );
  return {
    name,
    version,
    available() {
      if (!command && !runner) {
        return { ok: false, reason: 'unavailable', detail: 'no ASR command configured' };
      }
      return { ok: true };
    },
    async analyze(input, { signal, onProgress } = {}) {
      const avail = this.available();
      if (!avail.ok) {
        return { ok: false, reason: 'unavailable', detail: avail.detail, utterances: [], evidence: [] };
      }
      onProgress?.({ stage: 'asr', status: 'start' });

      const offsetMs = Number.isFinite(Number(input.offsetMs)) ? Math.max(0, Number(input.offsetMs)) : 0;
      const chunkId = input.chunkId != null ? String(input.chunkId) : null;
      const payload = JSON.stringify({
        audioPath: input.audioPath || null,
        videoKey: input.videoKey,
        language: input.language || null,
        offsetMs,
        chunkId,
      });

      let raw;
      try {
        raw = runner
          ? await runner(payload, { signal, timeoutMs: cappedTimeout })
          : await runCommand(command, args, payload, { signal, timeoutMs: cappedTimeout });
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) {
          return { ok: false, reason: 'cancelled', detail: e.message, utterances: [], evidence: [] };
        }
        if (e.code === 'TIMEOUT') {
          return { ok: false, reason: 'timeout', detail: e.message, utterances: [], evidence: [] };
        }
        return { ok: false, reason: 'failed', detail: e.message, utterances: [], evidence: [] };
      }

      if (raw.code != null && raw.code !== 0) {
        return {
          ok: false,
          reason: 'nonzero_exit',
          detail: `exit ${raw.code}: ${raw.stderr || ''}`,
          utterances: [],
          evidence: [],
        };
      }

      let parsed;
      try {
        parsed = JSON.parse(raw.stdout || raw);
      } catch (e) {
        return { ok: false, reason: 'invalid_json', detail: e.message, utterances: [], evidence: [] };
      }

      const validated = validateAsrOutput(parsed, {
        videoKey: input.videoKey,
        clock,
        adapterName: name,
        adapterVersion: version,
        offsetMs,
        chunkId,
      });
      if (!validated.ok) return { ...validated, utterances: [], evidence: [] };

      onProgress?.({ stage: 'asr', status: 'done', count: validated.utterances.length });
      return validated;
    },
  };
}

export function validateAsrOutput(parsed, {
  videoKey,
  clock = () => new Date().toISOString(),
  adapterName = 'asr-external',
  adapterVersion = '1',
  offsetMs = 0,
  chunkId = null,
} = {}) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'invalid_schema', detail: 'root must be object' };
  }
  if (!Array.isArray(parsed.utterances)) {
    return { ok: false, reason: 'invalid_schema', detail: 'utterances must be array' };
  }
  if (parsed.utterances.length > MAX_UTTERANCES) {
    return { ok: false, reason: 'invalid_schema', detail: 'too many utterances' };
  }

  const utterances = [];
  const evidence = [];
  for (const u of parsed.utterances) {
    if (!u || typeof u !== 'object') {
      return { ok: false, reason: 'invalid_schema', detail: 'utterance not object' };
    }
    if (!Number.isFinite(u.startMs) || !Number.isFinite(u.endMs)) {
      return { ok: false, reason: 'invalid_schema', detail: 'startMs/endMs required' };
    }
    if (u.endMs < u.startMs) {
      return { ok: false, reason: 'invalid_schema', detail: 'endMs < startMs' };
    }
    const text = String(u.text || '').trim();
    if (!text) continue;
    if (text.length > MAX_TEXT) {
      return { ok: false, reason: 'invalid_schema', detail: 'text too long' };
    }
    // 拒绝明显占位假转写
    if (/^(TODO|fake|placeholder|lorem ipsum)$/i.test(text)) {
      return { ok: false, reason: 'invalid_schema', detail: 'placeholder transcript rejected' };
    }
    // runner 返回 chunk-local 时间；adapter 加上 offsetMs 转为视频绝对时间
    const off = Number.isFinite(Number(offsetMs)) ? Math.max(0, Number(offsetMs)) : 0;
    const startMs = Math.round(u.startMs) + off;
    const endMs = Math.round(u.endMs) + off;
    const ch = contentHash(`${startMs}|${endMs}|${text}|asr`);
    const eid = evidenceIdOf({ videoKey, kind: 'asr', startMs, endMs, contentHash: ch });
    utterances.push({
      utteranceId: `UTT_${eid.slice(5, 17)}`,
      startMs,
      endMs,
      text,
      source: 'asr',
      speakerClusterId: u.speakerClusterId || null,
      confidence: Number.isFinite(u.confidence) ? u.confidence : null,
      evidenceId: eid,
      evidenceIds: [eid],
      chunkId: chunkId || null,
      localStartMs: Math.round(u.startMs),
      localEndMs: Math.round(u.endMs),
    });
    evidence.push(validateEvidenceRef({
      evidenceId: eid,
      kind: 'asr',
      startMs,
      endMs,
      ref: evidenceLogicalRef(videoKey, 'asr', eid),
      sourceFile: null,
      contentHash: ch,
      provenance: {
        adapter: adapterName,
        version: adapterVersion,
        generatedAt: clock(),
        confidence: Number.isFinite(u.confidence) ? u.confidence : null,
        chunkId: chunkId || null,
      },
    }));
  }

  return { ok: true, utterances, evidence };
}

function runCommand(command, args, stdinText, { signal, timeoutMs } = {}) {
  return spawnBounded(command, args, { signal, timeoutMs, stdinText });
}
