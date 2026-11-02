/**
 * whisper-asr.js — 可选本地 faster-whisper ASR 适配器。
 *
 * 默认关闭；仅 DSH_WHISPER_ENABLED=1 或设置 DSH_WHISPER_MODEL 时启用。
 * 通过 scripts/asr-runner.py 走现有外部命令 JSON 协议，因此校验/证据/offset 逻辑复用。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAsrAdapter } from './asr-adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ASR_SCRIPT = join(HERE, '..', '..', '..', 'scripts', 'asr-runner.py');

export function isWhisperEnabled(env = process.env) {
  const flag = String(env.DSH_WHISPER_ENABLED ?? '').trim();
  if (flag === '0' || /^false$/i.test(flag) || flag === 'off') return false;
  return flag === '1' || Boolean(env.DSH_WHISPER_MODEL);
}

export function createWhisperAsrAdapter({
  env = process.env,
  pythonPath = env.DSH_WHISPER_PYTHON || 'python',
  scriptPath = env.DSH_WHISPER_RUNNER || DEFAULT_ASR_SCRIPT,
  timeoutMs = Number(env.DSH_WHISPER_TIMEOUT_MS) || 600_000,
} = {}) {
  if (!isWhisperEnabled(env)) return createAsrAdapter({});
  return createAsrAdapter({
    command: pythonPath,
    args: [scriptPath],
    name: 'faster-whisper',
    version: '1',
    timeoutMs,
  });
}
