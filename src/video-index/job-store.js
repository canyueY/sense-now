/**
 * job-store.js — 后台索引 job 状态与排他锁（wx + heartbeat）。
 */

import {
  existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync,
  unlinkSync, renameSync, rmSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJsonAtomic, readJson } from './atomic-json.js';
import { encodeVideoKeyDir, safeVideoKey, resolveInside } from './paths.js';

export const JOB_STATES = Object.freeze([
  'queued', 'resolving', 'capturing', 'planning', 'indexing',
  'finalizing', 'ready', 'degraded', 'failed', 'cancelled',
  'paused', 'recoverable',
]);

const LOCK_STALE_MS = 90_000;

function jobsRoot(rootDir) {
  return join(rootDir, '.jobs');
}

function lockPath(rootDir, videoKey) {
  return join(rootDir, `${encodeVideoKeyDir(safeVideoKey(videoKey))}.lock`);
}

function processAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createJobStore({ rootDir, clock = () => Date.now() } = {}) {
  if (!rootDir) throw new Error('rootDir required');
  const root = jobsRoot(rootDir);
  mkdirSync(root, { recursive: true });

  function validateJobId(jobId) {
    const id = String(jobId ?? '');
    if (!id || id.length > 80 || id.length < 8) {
      return { ok: false, reason: 'invalid_job_id' };
    }
    if (/[\\/\0]|[^\w.-]/.test(id) || id.includes('..')) {
      return { ok: false, reason: 'invalid_job_id' };
    }
    if (!/^[\w.-]{8,80}$/.test(id)) {
      return { ok: false, reason: 'invalid_job_id' };
    }
    return { ok: true, jobId: id };
  }

  function jobPath(jobId) {
    const check = validateJobId(jobId);
    if (!check.ok) {
      const err = new Error('unsafe jobId');
      err.code = 'UNSAFE_JOB_ID';
      throw err;
    }
    return join(root, `${check.jobId}.json`);
  }

  function createJob(partial = {}) {
    const jobId = partial.jobId || `job_${randomBytes(8).toString('hex')}`;
    const now = new Date(clock()).toISOString();
    const job = {
      jobId,
      videoKey: partial.videoKey ? safeVideoKey(partial.videoKey) : null,
      state: 'queued',
      stage: 'queued',
      sourceMode: partial.sourceMode || 'file',
      execution: partial.execution || 'background',
      layoutVersion: partial.layoutVersion || 'chunk-v1',
      attempt: 1,
      cancelRequested: false,
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
      heartbeatAt: clock(),
      pid: process.pid,
      processStartTime: processStartMs(),
      progress: {
        capturedMs: 0,
        plannedMs: 0,
        indexedMs: 0,
        readyChunks: 0,
        degradedChunks: 0,
        failedChunks: 0,
        backlogChunks: 0,
        currentStage: 'queued',
      },
      plan: partial.plan || null,
      error: null,
      gaps: [],
      ...partial,
      jobId,
    };
    writeJsonAtomic(jobPath(jobId), job);
    return job;
  }

  function readJob(jobId, { optional = false } = {}) {
    const check = validateJobId(jobId);
    if (!check.ok) {
      if (optional) return null;
      const err = new Error('unsafe jobId');
      err.code = 'UNSAFE_JOB_ID';
      throw err;
    }
    return readJson(jobPath(check.jobId), { optional });
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.forceCancelled] 允许写入/保持 cancelled
   * @param {boolean} [opts.allowFromCancelled] resume 清除取消意图
   */
  function updateJob(jobId, patch = {}, opts = {}) {
    const cur = readJob(jobId, { optional: true });
    if (!cur) return null;

    const fromCancelled = cur.state === 'cancelled' || cur.cancelRequested === true;

    // cancelled 终态：普通 update 不得改成其他活跃/完成态
    if (fromCancelled && !opts.allowFromCancelled && !opts.forceCancelled) {
      return cur;
    }

    const next = {
      ...cur,
      ...patch,
      jobId: cur.jobId,
      updatedAt: new Date(clock()).toISOString(),
      heartbeatAt: clock(),
    };
    if (opts.forceCancelled) {
      next.state = 'cancelled';
      next.stage = 'cancelled';
      next.cancelRequested = true;
      if (patch.cancelRequestedAt) next.cancelRequestedAt = patch.cancelRequestedAt;
    }
    if (opts.allowFromCancelled && patch.cancelRequested === false) {
      next.cancelRequested = false;
    }
    if (patch.progress) {
      next.progress = { ...cur.progress, ...patch.progress };
    }
    writeJsonAtomic(jobPath(jobId), next);
    return next;
  }

  function listJobs() {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        try { return readJson(join(root, n), { optional: true }); } catch { return null; }
      })
      .filter(Boolean);
  }

  /**
   * 排他锁：open wx。心跳过期且进程身份不匹配才回收。
   */
  function acquireLock(videoKey, { jobId } = {}) {
    const key = safeVideoKey(videoKey);
    const path = lockPath(rootDir, key);
    const payload = {
      pid: process.pid,
      processStartTime: processStartMs(),
      nonce: randomBytes(8).toString('hex'),
      heartbeatAt: clock(),
      jobId: jobId || null,
      videoKey: key,
    };
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      return { ok: true, lock: payload, path };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let existing = null;
      try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { existing = null; }
      const stale = isLockStale(existing, clock());
      if (stale) {
        try { unlinkSync(path); } catch { /* ignore */ }
        return acquireLock(videoKey, { jobId });
      }
      return {
        ok: false,
        reason: 'locked',
        lock: existing,
        detail: `videoKey locked by job ${existing?.jobId || '?'}`,
      };
    }
  }

  function heartbeatLock(videoKey) {
    const path = lockPath(rootDir, videoKey);
    if (!existsSync(path)) return false;
    let cur;
    try { cur = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
    if (cur.pid !== process.pid) return false;
    cur.heartbeatAt = clock();
    const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, `${JSON.stringify(cur, null, 2)}\n`, { flag: 'wx' });
    renameSync(tmp, path);
    return true;
  }

  /**
   * 在不释放锁的前提下原子更新 jobId（避免 pending→real 的竞态窗口）。
   */
  function updateLockJobId(videoKey, { nonce, jobId } = {}) {
    const path = lockPath(rootDir, videoKey);
    if (!existsSync(path)) return { ok: false, reason: 'no_lock' };
    let cur;
    try { cur = JSON.parse(readFileSync(path, 'utf8')); } catch {
      return { ok: false, reason: 'corrupt' };
    }
    if (cur.pid !== process.pid) return { ok: false, reason: 'not_owner' };
    if (nonce != null && cur.nonce && cur.nonce !== nonce) {
      return { ok: false, reason: 'nonce_mismatch' };
    }
    cur.jobId = jobId || cur.jobId;
    cur.heartbeatAt = clock();
    const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, `${JSON.stringify(cur, null, 2)}\n`, { flag: 'wx' });
    renameSync(tmp, path);
    return { ok: true, lock: cur };
  }

  function releaseLock(videoKey, { nonce = null } = {}) {
    const path = lockPath(rootDir, videoKey);
    try {
      if (!existsSync(path)) return true;
      const cur = JSON.parse(readFileSync(path, 'utf8'));
      if (cur.pid !== process.pid) return false;
      if (nonce != null && cur.nonce && cur.nonce !== nonce) return false;
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  function markRecoverableRunningJobs() {
    const out = [];
    for (const job of listJobs()) {
      if (!['indexing', 'capturing', 'planning', 'resolving', 'finalizing', 'queued'].includes(job.state)) {
        continue;
      }
      const alive = processAlive(job.pid) && job.processStartTime === processStartMs()
        && job.pid === process.pid;
      if (!alive) {
        const next = updateJob(job.jobId, {
          state: 'recoverable',
          stage: 'recoverable',
          error: { code: 'HOST_EXIT', message: 'host exited; capture gaps may exist' },
        });
        out.push(next);
        try { releaseLock(job.videoKey); } catch { /* ignore */ }
      }
    }
    return out;
  }

  return {
    root,
    createJob,
    readJob,
    updateJob,
    listJobs,
    acquireLock,
    updateLockJobId,
    heartbeatLock,
    releaseLock,
    markRecoverableRunningJobs,
    validateJobId,
    isLockStale: (lock) => isLockStale(lock, clock()),
  };
}

function processStartMs() {
  // 粗粒度进程身份：启动时刻（秒）+ pid，降低 PID 重用误判
  return Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000;
}

function isLockStale(lock, now) {
  if (!lock || typeof lock !== 'object') return true;
  const hb = Number(lock.heartbeatAt) || 0;
  if (now - hb < LOCK_STALE_MS) return false;
  if (!processAlive(lock.pid)) return true;
  // 进程仍在但启动时间不匹配 → 视为 PID 重用
  if (lock.processStartTime && lock.processStartTime !== processStartMs()) return true;
  // 同进程心跳过期（卡住）→ 可回收
  if (lock.pid === process.pid && now - hb >= LOCK_STALE_MS) return true;
  return now - hb >= LOCK_STALE_MS * 2;
}

export { LOCK_STALE_MS };
