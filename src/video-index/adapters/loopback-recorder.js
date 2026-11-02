/**
 * loopback-recorder.js — 启动 scripts/loopback-recorder.py（可选依赖）。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnBounded, killProcessTree } from '../bounded-stdio.js';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOOPBACK_SCRIPT = join(HERE, '..', '..', '..', 'scripts', 'loopback-recorder.py');

export function createLoopbackRecorderAdapter({
  pythonPath = process.env.DSH_LOOPBACK_PYTHON || 'python',
  scriptPath = process.env.DSH_LOOPBACK_RUNNER || DEFAULT_LOOPBACK_SCRIPT,
  checkProcess = null,
  env = process.env,
} = {}) {
  let availability = null;
  let child = null;
  let segments = [];
  let listeners = [];
  let status = 'idle';

  async function check() {
    if (availability) return availability;
    const invoke = checkProcess || ((file, args) => spawnBounded(file, args, {
      timeoutMs: 15_000,
      env,
    }));
    try {
      const r = await invoke(pythonPath, [scriptPath, '--check']);
      const line = String(r.stdout || '').trim().split('\n').pop() || '{}';
      let info;
      try { info = JSON.parse(line); } catch { info = {}; }
      if (r.code !== 0 || info.ok === false) {
        availability = {
          ok: false,
          reason: 'unavailable',
          detail: info.detail || `loopback check exit ${r.code}`,
        };
      } else {
        availability = { ok: true, ...info };
      }
    } catch (e) {
      availability = { ok: false, reason: 'unavailable', detail: e.message };
    }
    return availability;
  }

  function onSegment(fn) {
    listeners.push(fn);
    return () => { listeners = listeners.filter((x) => x !== fn); };
  }

  async function start({ outDir, durationSec = null, continuous = true } = {}) {
    const avail = await check();
    if (!avail.ok) {
      return { ok: false, reason: 'unavailable', detail: avail.detail };
    }
    if (child) return { ok: true, already: true };
    mkdirSync(outDir, { recursive: true });
    segments = [];
    status = 'recording';
    const args = [scriptPath, '--out', outDir];
    if (continuous) args.push('--continuous');
    if (durationSec != null) args.push('--duration', String(durationSec));
    child = spawn(pythonPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > 512_000) buf = buf.slice(-256_000);
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'segment') {
            segments.push(ev);
            for (const fn of listeners) {
              try { fn(ev); } catch { /* ignore */ }
            }
          }
        } catch { /* ignore bad line */ }
      }
    });
    child.on('exit', () => {
      status = 'stopped';
      child = null;
    });
    return { ok: true, pid: child.pid };
  }

  async function stop({ gracefulMs = 5_000 } = {}) {
    if (!child?.pid) {
      status = 'stopped';
      return { ok: true, segments: [...segments], flushed: true };
    }
    const pid = child.pid;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        killProcessTree(pid);
        resolve();
      }, gracefulMs);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    status = 'stopped';
    child = null;
    return { ok: true, segments: [...segments], flushed: true };
  }

  return {
    check,
    start,
    stop,
    onSegment,
    get status() { return status; },
    get segments() { return [...segments]; },
    available: check,
  };
}
