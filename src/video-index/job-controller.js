/**
 * job-controller.js — 后台索引编排；cancelled 为不可逆终态。
 */

import { createJobStore } from './job-store.js';
import { createChunkStore } from './chunk-store.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  planChunks, LAYOUT_VERSION, ownsByMidpoint, dedupeUtterancesAcrossOverlap,
} from './chunk-plan.js';
import {
  mapChunkSpeakers, remapUtteranceSpeakers, mergeSpeakersByEmbedding,
  writePrivateEmbeddings, writeSpeakerMap,
} from './speaker-merge.js';
import { killProcessTree } from './bounded-stdio.js';
import {
  sanitizeSourceRef, writeSourceRef, readSourceRef, descriptorFromSourceRef,
} from './source-ref.js';

const SYNC_SAFE_MS = 12 * 60_000;
const TERMINAL_CANCELLED = 'cancelled';
const ACTIVE_AFTER_CANCEL = new Set([
  'queued', 'resolving', 'capturing', 'planning', 'indexing',
  'finalizing', 'ready', 'degraded', 'failed', 'paused', 'recoverable',
]);

export function createJobController({
  rootDir,
  indexChunk,
  clock = () => Date.now(),
  log = () => {},
  workerRunner = null,
  speakerMerge = null,
  onIndexed = null,
} = {}) {
  if (!rootDir) throw new Error('rootDir required');
  if (typeof indexChunk !== 'function') throw new Error('indexChunk required');

  const jobs = createJobStore({ rootDir, clock });
  /** @type {Map<string, { abort?: AbortController, attempt: number, lockNonce?: string }>} */
  const live = new Map();

  jobs.markRecoverableRunningJobs();

  function estimateNeedsBackground(durationMs, execution = 'auto') {
    if (execution === 'background') return true;
    if (execution === 'sync') return false;
    return Number(durationMs) > SYNC_SAFE_MS;
  }

  function wrapJobId(fn) {
    return (jobId, ...rest) => {
      const check = jobs.validateJobId(jobId);
      if (!check.ok) return { ok: false, reason: 'invalid_job_id' };
      try {
        return fn(check.jobId, ...rest);
      } catch (e) {
        if (e?.code === 'UNSAFE_JOB_ID') return { ok: false, reason: 'invalid_job_id' };
        throw e;
      }
    };
  }

  function assertJobMayContinue(jobId, signal, attempt) {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      err.code = 'CANCELLED';
      throw err;
    }
    const job = jobs.readJob(jobId, { optional: true });
    if (!job) {
      const err = new Error('job gone');
      err.name = 'AbortError';
      err.code = 'CANCELLED';
      throw err;
    }
    if (job.cancelRequested || job.state === TERMINAL_CANCELLED) {
      const err = new Error('cancel requested');
      err.name = 'AbortError';
      err.code = 'CANCELLED';
      throw err;
    }
    if (attempt != null && job.attempt != null && Number(job.attempt) !== Number(attempt)) {
      const err = new Error('stale attempt');
      err.name = 'AbortError';
      err.code = 'STALE_ATTEMPT';
      throw err;
    }
    return job;
  }

  async function startIndexJob({
    videoKey,
    durationMs,
    sourceMode = 'file',
    sourceDescriptor = null,
    capabilities = {},
    execution = 'auto',
    chunkMs,
    overlapMs,
    speakerMerge: mergeOpts = null,
    analysisPolicy = undefined,
    rebuild = false,
  } = {}) {
    const plan = planChunks({ durationMs, chunkMs, overlapMs });
    const background = estimateNeedsBackground(durationMs, execution);
    const lock = jobs.acquireLock(videoKey);
    if (!lock.ok) {
      return { ok: false, reason: 'locked', detail: lock.detail, lock: lock.lock };
    }

    const safeRef = sanitizeSourceRef({
      sourceMode,
      durationMs,
      sourceDescriptor,
      subtitlePath: sourceDescriptor?.subtitlePath || null,
      analysisPolicy,
    });
    const chunkStore = createChunkStore({ rootDir, videoKey });
    // rebuild：清掉上一轮的帧，否则旧 PNG 会成为没人引用、也不会被覆盖的孤儿
    if (rebuild) {
      try { rmSync(join(chunkStore.videoDir, 'evidence', 'frames'), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try {
      writeSourceRef(chunkStore.videoDir, safeRef, { clock: () => new Date(clock()).toISOString() });
    } catch (e) {
      log(`source-ref write failed: ${e.message}`);
    }

    const job = jobs.createJob({
      videoKey,
      sourceMode,
      execution: background ? 'background' : 'sync',
      layoutVersion: LAYOUT_VERSION,
      attempt: 1,
      cancelRequested: false,
      cancelRequestedAt: null,
      lockNonce: lock.lock?.nonce || null,
      plan: {
        durationMs,
        chunkCount: plan.length,
        chunks: plan.map((c) => ({
          chunkId: c.chunkId,
          startMs: c.startMs,
          endMs: c.endMs,
          status: 'queued',
        })),
      },
      progress: {
        plannedMs: durationMs,
        backlogChunks: plan.length,
        currentStage: 'planning',
      },
      hasDescriptor: Boolean(sourceDescriptor),
      hasSubtitlePath: Boolean(safeRef.subtitlePath),
      safeSource: {
        mediaPath: safeRef.mediaPath,
        subtitlePath: safeRef.subtitlePath,
        durationMs: safeRef.durationMs,
        sourceMode: safeRef.sourceMode,
      },
      speakerMerge: mergeOpts || speakerMerge || null,
    });

    jobs.updateJob(job.jobId, { state: 'planning', stage: 'planning' });

    const run = () => runIndexingJob({
      jobId: job.jobId,
      videoKey,
      plan,
      sourceMode,
      sourceDescriptor,
      capabilities,
      attempt: 1,
      lockNonce: lock.lock?.nonce || null,
      speakerMergeOpts: mergeOpts || speakerMerge || null,
      analysisPolicy,
      rebuild,
    });

    if (background) {
      setImmediate(() => {
        run().catch((e) => {
          log(`job ${job.jobId} failed: ${e.message}`);
          try {
            jobs.updateJob(job.jobId, {
              state: 'failed',
              stage: 'failed',
              error: { code: e.code || 'JOB', message: e.message },
            }, { allowFromCancelled: false });
          } catch { /* ignore */ }
          try {
            jobs.releaseLock(videoKey, { nonce: lock.lock?.nonce });
          } catch { /* ignore */ }
          live.delete(job.jobId);
        });
      });
      return {
        ok: true,
        background: true,
        jobId: job.jobId,
        videoKey,
        state: 'planning',
        progress: job.progress,
      };
    }

    const result = await run();
    return { ok: true, background: false, ...result };
  }

  async function runIndexingJob({
    jobId, videoKey, plan, sourceMode, sourceDescriptor, capabilities,
    attempt = 1, lockNonce = null, speakerMergeOpts = null, analysisPolicy = undefined,
    rebuild = false,
  }) {
    const ac = new AbortController();
    live.set(jobId, { abort: ac, attempt, lockNonce });
    const store = createChunkStore({ rootDir, videoKey });
    let ready = 0;
    let degraded = 0;
    let failed = 0;
    let indexedMs = 0;
    /** @type {Array<{id:string,embedding:number[],chunkIds:string[]}>} */
    const embeddingClusters = [];
    let cancelled = false;

    const bumpIndexing = () => {
      try {
        assertJobMayContinue(jobId, ac.signal, attempt);
        jobs.updateJob(jobId, {
          state: 'indexing',
          stage: 'indexing',
          progress: { currentStage: 'indexing', backlogChunks: plan.length },
        });
      } catch {
        cancelled = true;
      }
    };
    bumpIndexing();
    if (cancelled) {
      finishCancelled();
      return { jobId, videoKey, state: TERMINAL_CANCELLED };
    }

    for (const chunk of plan) {
      try {
        assertJobMayContinue(jobId, ac.signal, attempt);
      } catch {
        cancelled = true;
        break;
      }

      const existing = store.readChunk(chunk.chunkId, { optional: true });
      // rebuild 时不能复用旧 chunk，否则 index({rebuild:true}) 会静默 no-op
      if (!rebuild
        && (existing?.manifest?.status === 'ready' || existing?.manifest?.status === 'degraded')) {
        ready += existing.manifest.status === 'ready' ? 1 : 0;
        degraded += existing.manifest.status === 'degraded' ? 1 : 0;
        indexedMs += chunk.endMs - chunk.startMs;
        continue;
      }

      jobs.heartbeatLock(videoKey);
      try {
        assertJobMayContinue(jobId, ac.signal, attempt);
        jobs.updateJob(jobId, {
          progress: {
            currentStage: `chunk:${chunk.chunkId}`,
            backlogChunks: plan.length - ready - degraded - failed,
          },
        });
      } catch {
        cancelled = true;
        break;
      }

      try {
        const out = await indexChunk({
          videoKey,
          chunk,
          sourceDescriptor,
          sourceMode,
          capabilities,
          signal: ac.signal,
          speakerMerge: speakerMergeOpts,
          analysisPolicy,
        });

        // indexChunk 返回后、commit 前再查一次
        try {
          assertJobMayContinue(jobId, ac.signal, attempt);
        } catch {
          try { store.abortChunk(chunk.chunkId); } catch { /* ignore */ }
          cancelled = true;
          break;
        }

        const speakers = mapChunkSpeakers(out.speakers || [], chunk.chunkId);
        const idMap = new Map(
          speakers.map((s) => [s.localSpeakerId, s.speakerClusterId]),
        );
        let utterances = (out.utterances || []).map((u) => ({ ...u, chunkId: chunk.chunkId }));
        utterances = remapUtteranceSpeakers(utterances, idMap);
        utterances = utterances.filter((u) => ownsByMidpoint(u, chunk));
        utterances = dedupeUtterancesAcrossOverlap(utterances);

        // 私有 embedding：仅内存，不写 chunk JSON
        for (const emb of out.speakerEmbeddings || []) {
          if (!emb?.embedding || !Array.isArray(emb.embedding)) continue;
          const local = emb.localSpeakerId || emb.speakerClusterId;
          embeddingClusters.push({
            id: provisionalOrMapped(local, chunk.chunkId, idMap),
            embedding: emb.embedding,
            chunkIds: [chunk.chunkId],
          });
        }

        const status = out.degraded ? 'degraded' : 'ready';
        try {
          assertJobMayContinue(jobId, ac.signal, attempt);
        } catch {
          try { store.abortChunk(chunk.chunkId); } catch { /* ignore */ }
          cancelled = true;
          break;
        }

        store.commitChunk(chunk.chunkId, {
          chunkManifest: {
            chunkId: chunk.chunkId,
            revision: 1,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
            inputStartMs: chunk.inputStartMs,
            inputEndMs: chunk.inputEndMs,
            status,
            sourceMode,
            timeSource: out.timeSource || 'stream',
            discontinuity: Boolean(out.discontinuity),
            gaps: out.gaps || [],
            capabilities: out.capabilities || {},
            counts: {
              utterances: utterances.length,
              events: (out.events || []).length,
              speakers: speakers.length,
            },
            byteUsage: out.byteUsage || { downloaded: 0, temporaryPeak: 0, outputBytes: 0 },
            provenance: out.provenance || { generatedAt: new Date().toISOString() },
            error: out.error || null,
          },
          utterances,
          events: (out.events || []).filter((e) => ownsByMidpoint(e, chunk)),
          speakers,
          storyboard: out.storyboard || [],
          evidence: out.evidence || [],
          chapters: out.chapters || [],
        });

        // commit 后若已取消：保留该完整 chunk，但不再继续
        try {
          assertJobMayContinue(jobId, ac.signal, attempt);
        } catch {
          cancelled = true;
          if (status === 'ready') ready += 1;
          else degraded += 1;
          indexedMs += chunk.endMs - chunk.startMs;
          break;
        }

        if (status === 'ready') ready += 1;
        else degraded += 1;
        indexedMs += chunk.endMs - chunk.startMs;
      } catch (e) {
        if (e.name === 'AbortError' || e.code === 'CANCELLED' || e.code === 'STALE_ATTEMPT') {
          try { store.abortChunk(chunk.chunkId); } catch { /* ignore */ }
          cancelled = true;
          break;
        }
        failed += 1;
        log(`chunk ${chunk.chunkId} failed: ${e.message}`);
        try {
          assertJobMayContinue(jobId, ac.signal, attempt);
          store.commitChunk(chunk.chunkId, {
            chunkManifest: {
              chunkId: chunk.chunkId,
              revision: 1,
              startMs: chunk.startMs,
              endMs: chunk.endMs,
              inputStartMs: chunk.inputStartMs,
              inputEndMs: chunk.inputEndMs,
              status: 'degraded',
              sourceMode,
              timeSource: 'stream',
              discontinuity: false,
              gaps: [],
              capabilities: {},
              counts: {},
              byteUsage: { downloaded: 0, temporaryPeak: 0, outputBytes: 0 },
              provenance: { generatedAt: new Date().toISOString() },
              error: { code: e.code || 'CHUNK', message: e.message },
            },
            utterances: [],
            events: [],
            speakers: [],
            storyboard: [],
            evidence: [],
            chapters: [],
          });
          degraded += 1;
        } catch {
          cancelled = true;
          break;
        }
      }

      try {
        assertJobMayContinue(jobId, ac.signal, attempt);
        jobs.updateJob(jobId, {
          progress: {
            indexedMs,
            readyChunks: ready,
            degradedChunks: degraded,
            failedChunks: failed,
            backlogChunks: Math.max(0, plan.length - ready - degraded - failed),
          },
        });
      } catch {
        cancelled = true;
        break;
      }
    }

    if (cancelled) {
      finishCancelled();
      return { jobId, videoKey, state: TERMINAL_CANCELLED, progress: { readyChunks: ready } };
    }

    // finalize：仍需守卫
    try {
      assertJobMayContinue(jobId, ac.signal, attempt);
    } catch {
      finishCancelled();
      return { jobId, videoKey, state: TERMINAL_CANCELLED };
    }

    jobs.updateJob(jobId, { state: 'finalizing', stage: 'finalizing' });

    // speaker merge（可选）
    let speakerMergeCap = 'disabled';
    if (speakerMergeOpts?.enabled && embeddingClusters.length) {
      try {
        const merged = mergeSpeakersByEmbedding({
          clusters: embeddingClusters,
          threshold: Number(speakerMergeOpts.threshold) || 0.78,
        });
        const map = buildGlobalSpeakerMap(merged);
        writeSpeakerMap(store.videoDir, map);
        if (speakerMergeOpts.persistEmbeddings) {
          writePrivateEmbeddings(store.videoDir, {
            clusters: embeddingClusters.map((c) => ({
              id: c.id,
              dimension: c.embedding.length,
              chunkIds: c.chunkIds,
              // 不写完整向量到普通字段以外的 private 时才允许
              embedding: c.embedding,
            })),
          }, { persistSpeakerEmbeddings: true });
        }
        speakerMergeCap = merged.mergeEvidence.some((e) => e.status === 'tentative')
          ? 'tentative'
          : 'ready';
      } catch (e) {
        log(`speaker merge failed: ${e.message}`);
        speakerMergeCap = 'degraded';
      }
    } else if (speakerMergeOpts?.enabled) {
      speakerMergeCap = embeddingClusters.length ? 'pending' : 'unavailable';
    }

    try {
      assertJobMayContinue(jobId, ac.signal, attempt);
    } catch {
      finishCancelled();
      return { jobId, videoKey, state: TERMINAL_CANCELLED };
    }

    const catalog = store.rebuildCatalog();
    let finalState = failed && !ready ? 'failed' : (degraded || failed ? 'degraded' : 'ready');
    let characterIdentityCap = null;
    if (typeof onIndexed === 'function' && (finalState === 'ready' || finalState === 'degraded')) {
      try {
        const indexed = onIndexed({ videoKey, capabilities, state: finalState, sourceDescriptor });
        if (indexed && indexed.ok === false) {
          characterIdentityCap = 'degraded';
          if (finalState === 'ready') finalState = 'degraded';
          log(`character identity degraded: ${indexed.reason || indexed.error || 'failed'}`);
        } else if (indexed && indexed.ok === true && capabilities?.characterIdentity === 'on') {
          characterIdentityCap = 'ready';
        }
      } catch (e) {
        log(`onIndexed failed: ${e.message}`);
        characterIdentityCap = 'degraded';
        if (finalState === 'ready') finalState = 'degraded';
      }
    }
    const jobCapabilities = { speakerMerge: speakerMergeCap };
    if (characterIdentityCap) jobCapabilities.characterIdentity = characterIdentityCap;
    const final = jobs.updateJob(jobId, {
      state: finalState,
      stage: finalState,
      progress: {
        indexedMs,
        readyChunks: ready,
        degradedChunks: degraded,
        failedChunks: failed,
        backlogChunks: 0,
        currentStage: finalState,
      },
      catalogChunks: catalog.length,
      capabilities: jobCapabilities,
    }) || { state: finalState, progress: { readyChunks: ready } };

    try { jobs.releaseLock(videoKey, { nonce: lockNonce }); } catch { /* ignore */ }
    live.delete(jobId);
    void workerRunner;
    return {
      jobId,
      videoKey,
      state: final.state,
      progress: final.progress,
      catalogChunks: catalog.length,
      capabilities: jobCapabilities,
    };

    function finishCancelled() {
      jobs.updateJob(jobId, {
        state: TERMINAL_CANCELLED,
        stage: TERMINAL_CANCELLED,
        cancelRequested: true,
      }, { forceCancelled: true });
      try { jobs.releaseLock(videoKey, { nonce: lockNonce }); } catch { /* ignore */ }
      live.delete(jobId);
    }
  }

  const jobStatus = wrapJobId((jobId) => {
    const job = jobs.readJob(jobId, { optional: true });
    if (!job) return { ok: false, reason: 'not-found' };
    return { ok: true, job: sanitizeJob(job) };
  });

  const jobCancel = wrapJobId((jobId) => {
    const job = jobs.readJob(jobId, { optional: true });
    if (!job) return { ok: false, reason: 'not-found' };
    if (job.state === TERMINAL_CANCELLED || job.cancelRequested) {
      return { ok: true, job: sanitizeJob(job), idempotent: true };
    }
    const h = live.get(jobId);
    if (h?.abort) h.abort.abort();
    if (h?.child?.pid) killProcessTree(h.child.pid);
    const next = jobs.updateJob(jobId, {
      state: TERMINAL_CANCELLED,
      stage: TERMINAL_CANCELLED,
      cancelRequested: true,
      cancelRequestedAt: new Date(clock()).toISOString(),
    }, { forceCancelled: true });
    // 不在此处 releaseLock：由仍持有 lockNonce 的执行者在退出时释放，
    // 避免与正在 commit 的回调竞态。若无 live handle，可释放。
    if (!h) {
      try { jobs.releaseLock(job.videoKey); } catch { /* ignore */ }
    }
    return { ok: true, job: sanitizeJob(next) };
  });

  const jobResume = wrapJobId(async (jobId) => {
    const job = jobs.readJob(jobId, { optional: true });
    if (!job) return { ok: false, reason: 'not-found' };
    if (!job.plan?.chunks) return { ok: false, reason: 'no_plan' };
    if (job.sourceMode === 'capture') {
      const gaps = [...(job.gaps || []), {
        kind: 'gap',
        reason: 'resume_after_interrupt',
        recordedAt: new Date(clock()).toISOString(),
      }];
      jobs.updateJob(jobId, { gaps, state: 'recoverable' }, { allowFromCancelled: true });
      return {
        ok: true,
        resumed: false,
        captureRestartRequired: true,
        gaps,
        detail: 'capture cannot seamlessly resume; start a new capture session',
      };
    }
    const nextAttempt = (Number(job.attempt) || 1) + 1;
    const lock = jobs.acquireLock(job.videoKey, { jobId });
    if (!lock.ok) return { ok: false, reason: 'locked', detail: lock.detail };

    jobs.updateJob(jobId, {
      attempt: nextAttempt,
      cancelRequested: false,
      cancelRequestedAt: null,
      state: 'indexing',
      stage: 'indexing',
      lockNonce: lock.lock?.nonce || null,
      error: null,
    }, { allowFromCancelled: true });

    const plan = job.plan.chunks.map((c) => ({
      chunkId: c.chunkId,
      startMs: c.startMs,
      endMs: c.endMs,
      inputStartMs: c.startMs,
      inputEndMs: c.endMs,
      index: Number(c.chunkId),
    }));
    const attempt = nextAttempt;
    const nonce = lock.lock?.nonce || null;
    // resume：从落盘 source-ref / job.safeSource 恢复媒体与外挂字幕路径（不含远程签名流）
    const storeForResume = createChunkStore({ rootDir, videoKey: job.videoKey });
    const diskRef = readSourceRef(storeForResume.videoDir, { optional: true })
      || job.safeSource
      || null;
    const resumedDescriptor = descriptorFromSourceRef(diskRef);
    setImmediate(() => {
      runIndexingJob({
        jobId,
        videoKey: job.videoKey,
        plan,
        sourceMode: job.sourceMode || diskRef?.sourceMode || 'file',
        sourceDescriptor: resumedDescriptor,
        capabilities: {},
        attempt,
        lockNonce: nonce,
        speakerMergeOpts: job.speakerMerge || speakerMerge,
      }).catch((e) => {
        jobs.updateJob(jobId, {
          state: 'failed',
          error: { message: e.message },
        });
        jobs.releaseLock(job.videoKey, { nonce });
      });
    });
    return { ok: true, resumed: true, jobId, state: 'indexing', attempt: nextAttempt };
  });

  return {
    jobs,
    startIndexJob,
    jobStatus,
    jobCancel,
    jobResume,
    estimateNeedsBackground,
    assertJobMayContinue,
    SYNC_SAFE_MS,
  };
}

function provisionalOrMapped(local, chunkId, idMap) {
  if (idMap.has(local)) return idMap.get(local);
  return `C${chunkId}_${String(local || 'SPEAKER_00')}`;
}

function buildGlobalSpeakerMap(merged) {
  const map = {};
  let n = 1;
  const globalOf = new Map();
  for (const [from, to] of merged.idMap.entries()) {
    if (!globalOf.has(to)) {
      globalOf.set(to, `GSPK_${String(n).padStart(4, '0')}`);
      n += 1;
    }
    const ev = merged.mergeEvidence.filter((e) => e.left === from || e.right === from
      || e.left === to || e.right === to);
    const tentative = ev.some((e) => e.status === 'tentative');
    map[from] = {
      globalSpeakerId: globalOf.get(to),
      state: from === to && !ev.length ? 'unmerged' : (tentative ? 'tentative' : 'confirmed'),
      score: ev.length ? Math.max(...ev.map((e) => e.similarity)) : null,
      mergeEvidence: [...new Set(ev.flatMap((e) => (e.chunkIds || []).map((c) => `chunk:${c}`)))],
    };
  }
  return {
    layoutVersion: LAYOUT_VERSION,
    updatedAt: new Date().toISOString(),
    speakers: map,
  };
}

function sanitizeJob(job) {
  if (!job) return null;
  const {
    // eslint-disable-next-line no-unused-vars
    descriptor, streamUrl, cookie, cookies, token, speakerEmbeddings, ...safe
  } = job;
  return safe;
}

export { SYNC_SAFE_MS, ACTIVE_AFTER_CANCEL };
