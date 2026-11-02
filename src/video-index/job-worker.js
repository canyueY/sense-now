/**
 * job-worker.js — 后台索引 worker 辅助（进程树生命周期，非独立 daemon）。
 * 宿主退出时 graceful stop → 杀进程树；不脱离插件生命周期。
 */

import { spawn } from 'node:child_process';
import { killProcessTree } from './bounded-stdio.js';

/**
 * 可选：在独立 Node 子进程跑 indexChunk 循环。
 * 默认 job-controller 在同进程 setImmediate 执行（测试友好）。
 */
export function spawnJobWorker({
  workerScript,
  jobId,
  env = process.env,
  stdio = 'ignore',
} = {}) {
  if (!workerScript) {
    const err = new Error('workerScript required');
    err.code = 'NO_WORKER';
    throw err;
  }
  const child = spawn(process.execPath, [workerScript, '--jobId', String(jobId)], {
    env: { ...env, DSH_VIDEO_INDEX_JOB_ID: String(jobId) },
    stdio,
    windowsHide: true,
    detached: false,
  });
  return {
    pid: child.pid,
    child,
    stop({ gracefulMs = 3_000 } = {}) {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ ok: true });
        };
        child.once('exit', finish);
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          if (done) return;
          if (child.pid) killProcessTree(child.pid);
          finish();
        }, gracefulMs).unref?.();
      });
    },
  };
}

export function attachAbortToChild(child, signal) {
  if (!signal || !child?.pid) return () => {};
  const onAbort = () => {
    try { killProcessTree(child.pid); } catch { /* ignore */ }
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener?.('abort', onAbort);
}
