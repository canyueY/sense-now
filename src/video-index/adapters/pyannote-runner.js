/**
 * pyannote-runner.js — 可选的真实本地 speaker diarization runner。
 *
 * 仅当 DSH_PYANNOTE_ENABLED=1 时启用。HF_TOKEN / 本地模型路径只是凭据，不是开关。
 * availability probe 使用 --check，不得下载模型。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAudioVisualAdapter } from './audio-visual-adapter.js';
import { spawnBounded } from '../bounded-stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PYANNOTE_SCRIPT = join(HERE, '..', '..', '..', 'scripts', 'audio-visual-runner.py');

/** 仅显式 ENABLED=1 才开启；ENABLED=0 强制关闭。 */
export function isPyannoteEnabled(env = process.env) {
  const flag = String(env.DSH_PYANNOTE_ENABLED ?? '').trim();
  if (flag === '0' || /^false$/i.test(flag) || flag === 'off') return false;
  return flag === '1';
}

function redactSecrets(text) {
  return String(text || '')
    .replace(/hf_[A-Za-z0-9._-]{8,}/g, 'hf_[REDACTED]')
    .replace(/(HF_TOKEN|HUGGINGFACE_HUB_TOKEN|DSH_PYANNOTE_TOKEN)\s*=\s*\S+/gi, '$1=[REDACTED]');
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch (e) {
    const err = new Error(`invalid pyannote runner JSON: ${e.message}`);
    err.code = 'INVALID_JSON';
    throw err;
  }
}

export function createPyannoteAudioVisualAdapter({
  env = process.env,
  pythonPath = env.DSH_PYANNOTE_PYTHON || 'python',
  scriptPath = env.DSH_PYANNOTE_RUNNER || DEFAULT_PYANNOTE_SCRIPT,
  checkProcess = null,
  runProcess = null,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  let availability = null;

  const check = () => {
    if (availability) return availability;
    if (!isPyannoteEnabled(env)) {
      availability = {
        ok: false,
        reason: 'unavailable',
        detail: 'pyannote disabled; set DSH_PYANNOTE_ENABLED=1 to opt in (HF_TOKEN alone does not enable)',
      };
      return availability;
    }
    const invoke = checkProcess || ((file, args) => spawnSync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      env,
    }));
    try {
      const r = invoke(pythonPath, [scriptPath, '--check']);
      if (r?.status !== 0) {
        availability = {
          ok: false,
          reason: 'unavailable',
          detail: redactSecrets(String(r?.stderr || r?.stdout || `python exited ${r?.status}`).trim()),
        };
      } else {
        const info = parseJsonOutput(r.stdout);
        availability = { ok: true, ...info };
      }
    } catch (e) {
      availability = {
        ok: false,
        reason: 'unavailable',
        detail: redactSecrets(e.message),
      };
    }
    return availability;
  };

  const runner = async (input, { signal } = {}) => {
    if (!isPyannoteEnabled(env)) {
      const err = new Error('pyannote disabled; set DSH_PYANNOTE_ENABLED=1');
      err.code = 'DISABLED';
      throw err;
    }
    const invoke = runProcess || ((file, args, opts) => spawnBounded(file, args, opts));
    const r = await invoke(pythonPath, [scriptPath], {
      signal,
      timeoutMs,
      stdinText: JSON.stringify(input),
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 2 * 1024 * 1024,
    });
    if (r.code !== 0) {
      const err = new Error(`pyannote runner failed: ${redactSecrets(r.stderr || `exit ${r.code}`)}`);
      err.code = 'PYANNOTE';
      throw err;
    }
    return parseJsonOutput(r.stdout);
  };

  const base = createAudioVisualAdapter({
    name: 'pyannote-community-1',
    version: '4',
    runner,
  });
  return {
    ...base,
    available: check,
  };
}
