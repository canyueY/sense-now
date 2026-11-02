/**
 * ids.js — 稳定 ID 规则（唯一拼装处）。禁止其它模块自行拼接证据/帧 ID。
 */

import { createHash } from 'node:crypto';
import { basename, normalize } from 'node:path';

const SCHEMA_VERSION = '1.1';

export function shortHash(input, len = 16) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, len);
}

export function contentHash(bufOrStr) {
  const h = createHash('sha256');
  if (Buffer.isBuffer(bufOrStr) || bufOrStr instanceof Uint8Array) h.update(bufOrStr);
  else h.update(String(bufOrStr ?? ''));
  return `sha256:${h.digest('hex')}`;
}

/** 规范化 source → videoKey。 */
export function videoKeyOf(source = {}) {
  const kind = String(source.kind || 'file').toLowerCase();
  if (kind === 'bilibili') {
    const id = extractBilibiliId(source.url || source.uri || source.bvid || '');
    const part = normalizePartId(source.partId || source.part || 'p1');
    return `bilibili:${id}:${part}`;
  }
  if (kind === 'file') {
    const p = normalize(String(source.path || source.uri || ''));
    const name = basename(p).replace(/[^\w.\-]+/g, '_') || 'file';
    const dig = shortHash(p.toLowerCase(), 12);
    return `file:${dig}:${name}`;
  }
  const dig = shortHash(JSON.stringify(source), 16);
  return `${kind}:${dig}`;
}

export function extractBilibiliId(urlOrId) {
  const s = String(urlOrId || '').trim();
  const m = s.match(/\b(BV[\w]+)\b/i) || s.match(/\bav(\d+)\b/i);
  if (m) return m[1] ? (m[0].startsWith('av') ? m[0].toLowerCase() : m[1]) : s;
  if (/^BV[\w]+$/i.test(s) || /^av\d+$/i.test(s)) return s;
  return shortHash(s || 'unknown', 12);
}

export function normalizePartId(part) {
  const s = String(part || 'p1').toLowerCase().replace(/^p+/, '');
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return `p${Math.floor(n)}`;
  return 'p1';
}

function roiKey(roi) {
  if (!roi || typeof roi !== 'object') return 'full';
  const { x = 0, y = 0, width = 0, height = 0 } = roi;
  return `${x},${y},${width},${height}`;
}

/** frameId：videoKey + timestampMs + roi + contentHash */
export function frameIdOf({ videoKey, timestampMs, roi, contentHash: ch }) {
  const dig = shortHash(`${videoKey}|${Math.round(timestampMs)}|${roiKey(roi)}|${ch}`, 16);
  return `FRAME_${dig}`;
}

/** evidenceId：videoKey + kind + startMs + endMs + contentHash */
export function evidenceIdOf({ videoKey, kind, startMs, endMs, contentHash: ch }) {
  const dig = shortHash(
    `${videoKey}|${kind}|${Math.round(startMs)}|${Math.round(endMs)}|${ch}`,
    16,
  );
  return `EVID_${dig}`;
}

export function chapterIdOf({ videoKey, indexVersion, startMs, endMs, title = '' }) {
  const dig = shortHash(
    `${videoKey}|${indexVersion}|ch|${Math.round(startMs)}|${Math.round(endMs)}|${title}`,
    12,
  );
  return `CH_${dig}`;
}

export function eventIdOf({ videoKey, indexVersion, startMs, kind, contentHash: ch = '' }) {
  const dig = shortHash(
    `${videoKey}|${indexVersion}|ev|${Math.round(startMs)}|${kind}|${ch}`,
    12,
  );
  return `EVENT_${dig}`;
}

export function sceneIdOf({ videoKey, indexVersion, timestampMs }) {
  const dig = shortHash(`${videoKey}|${indexVersion}|sc|${Math.round(timestampMs)}`, 12);
  return `SCENE_${dig}`;
}

export function personIdOf({ videoKey, clusterKey }) {
  const dig = shortHash(`${videoKey}|person|${clusterKey}`, 8);
  return `P_${dig}`;
}

export function indexVersionOf(parts) {
  return shortHash(JSON.stringify(parts), 20);
}

export { SCHEMA_VERSION };
