/**
 * bounded-stdio.js — 子进程 stdout/stderr 流式计数，超限杀进程树。
 */

import { spawn, execFileSync } from 'node:child_process';

export const DEFAULT_MAX_STDIO_BYTES = 8 * 1024 * 1024; // 8 MiB per stream

/**
 * 终止进程树（含 Windows 上 yt-dlp 拉起的 ffmpeg 等后代）。
 */
export function killProcessTree(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(n), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 8_000,
      });
    } catch { /* ignore */ }
    return;
  }
  // Unix：先杀子进程再杀自身
  try {
    const out = execFileSync('pgrep', ['-P', String(n)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    for (const line of String(out).split(/\s+/)) {
      const child = Number(line);
      if (Number.isFinite(child) && child > 0) killProcessTree(child);
    }
  } catch { /* no children / pgrep missing */ }
  try { process.kill(n, 'SIGKILL'); } catch { /* ignore */ }
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   maxStdoutBytes?: number,
 *   maxStderrBytes?: number,
 *   stdinText?: string|null,
 * }} opts
 */
export function spawnBounded(file, args, opts = {}) {
  const {
    signal,
    timeoutMs = 60_000,
    maxStdoutBytes = DEFAULT_MAX_STDIO_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDIO_BYTES,
    stdinText = null,
  } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: [stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let limitHit = null;
    let killWaitTimer = null;

    const kill = () => {
      killProcessTree(child.pid);
    };

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killWaitTimer) clearTimeout(killWaitTimer);
      signal?.removeEventListener?.('abort', onAbort);
      kill();
      // 等进程树退出后再 reject，避免后代继续写 staging
      const done = () => reject(err);
      if (child.exitCode != null || child.signalCode != null) {
        done();
        return;
      }
      child.once('close', done);
      killWaitTimer = setTimeout(done, 3_000);
    };

    const finishResolve = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killWaitTimer) clearTimeout(killWaitTimer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ stdout, stderr, code: code ?? 1, limitHit });
    };

    const timer = setTimeout(() => {
      finishReject(Object.assign(new Error('subprocess timeout'), { code: 'TIMEOUT' }));
    }, timeoutMs);

    const onAbort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      finishReject(e);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      const n = Buffer.byteLength(d, 'utf8');
      stdoutBytes += n;
      if (stdoutBytes > maxStdoutBytes) {
        limitHit = 'stdout';
        finishReject(Object.assign(new Error('stdout size limit exceeded'), { code: 'STDIO_LIMIT' }));
        return;
      }
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      const n = Buffer.byteLength(d, 'utf8');
      stderrBytes += n;
      if (stderrBytes > maxStderrBytes) {
        limitHit = 'stderr';
        finishReject(Object.assign(new Error('stderr size limit exceeded'), { code: 'STDIO_LIMIT' }));
        return;
      }
      stderr += d;
    });
    child.on('error', (e) => finishReject(e));
    child.on('close', (code) => finishResolve(code));

    if (stdinText != null) {
      child.stdin.end(stdinText, 'utf8');
    }
  });
}
