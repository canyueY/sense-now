/**
 * atomic-json.js — UTF-8 JSON 原子写（同目录临时文件 + rename）。
 */

import {
  mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 32;

function assertDepth(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('JSON depth limit exceeded');
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new Error('JSON array length limit exceeded');
    for (const item of value) assertDepth(item, depth + 1);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > 10_000) throw new Error('JSON object key limit exceeded');
  for (const k of keys) assertDepth(value[k], depth + 1);
}

export function writeJsonAtomic(filePath, value, { pretty = true } = {}) {
  assertDepth(value);
  const text = pretty ? `${JSON.stringify(value, null, 2)}\n` : `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) {
    throw new Error('JSON payload too large');
  }
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, filePath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function readJson(filePath, { optional = false } = {}) {
  if (!existsSync(filePath)) {
    if (optional) return null;
    throw new Error(`missing json: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) {
    throw new Error('JSON file too large');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`corrupt json: ${filePath}: ${e.message}`);
    err.cause = e;
    err.code = 'CORRUPT_JSON';
    throw err;
  }
}

export function isTempName(name) {
  return String(name || '').startsWith('.tmp-');
}
