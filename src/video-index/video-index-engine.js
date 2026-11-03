/**
 * video-index-engine.js — 索引引擎：index / query / evidence / status / list / remove。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createIndexStore } from './index-store.js';
import {
  createBuildingManifest, emptyCapabilities, validateManifest,
} from './schema.js';
import {
  indexVersionOf, contentHash, videoKeyOf, evidenceIdOf, frameIdOf,
} from './ids.js';
import { createFileSource } from './adapters/file-source.js';
import { createBilibiliSource } from './adapters/bilibili-source.js';
import {
  normalizeSubtitles, subtitleEvents, loadSubtitleFile,
} from './adapters/subtitle-adapter.js';
import { createWhisperAsrAdapter } from './adapters/whisper-asr.js';
import { createOcrAdapter } from './adapters/ocr-adapter.js';
import { createEntityAdapter } from './adapters/entity-adapter.js';
import { createPyannoteAudioVisualAdapter } from './adapters/pyannote-runner.js';
import { createStoryboardIndexer } from './storyboard-indexer.js';
import { retrieve } from './index-retriever.js';
import { buildContext } from './context-builder.js';
import { routeQuery } from './query-router.js';
import { createQueryCache, cacheKeyOf, RETRIEVAL_VERSION } from './query-cache.js';
import { evaluateCognition } from './cognition-gate.js';
import { mergeBudget } from './schema.js';
import { resolveIdentities } from './identity-resolver.js';
import { evidenceLogicalRef, decodeVideoKeyDir } from './paths.js';
import {
  extractAudioWav, defaultCacheAudioPath, defaultCacheMediaPath, probeMediaDurationMs,
} from './media-extract.js';
import {
  aggregateTopics, aggregateKeyMoments, enrichChapterTags,
} from './event-aggregator.js';
import {
  buildAsrChapterSkeleton, classifyIdentityBindingCapability,
} from './speaker-view.js';
import { cleanupIndexes } from './index-cleanup.js';
import { encodePng } from '../png.js';
import { createPipeline } from '../pipeline.js';
import { createJobController } from './job-controller.js';
import { createChunkStore } from './chunk-store.js';
import {
  LAYOUT_VERSION, ownsByMidpoint, dedupeUtterancesAcrossOverlap,
} from './chunk-plan.js';
import { selectChunksFromCatalog, mergeChunkViews } from './index-retriever.js';
import { chunkSetHash } from './query-cache.js';
import { extractAudioRange, extractFrameAt } from './remote-media.js';
import { createCaptureSession } from './capture-source.js';
import { createCaptureController } from './capture-controller.js';
import { createWebSocketCdpTransport } from './cdp-websocket.js';
import { createLoopbackRecorderAdapter } from './adapters/loopback-recorder.js';
import { createScreenFrameSource } from './adapters/screen-frame-source.js';
import { analyzeCaptureBundle } from './capture-bundle.js';
import {
  clearPrivateEmbeddings, validateSpeakerEmbeddings, readSpeakerMap,
} from './speaker-merge.js';
import { join } from 'node:path';
import { unlinkSync, mkdirSync } from 'node:fs';
import {
  normalizeAnalysisPolicy, mayRunAsr, mayRunVad,
} from './analysis-policy.js';
import { resolveSubtitleSources, buildCoverage } from './subtitle-source.js';
import {
  resolveVideoSubtitles, resolveChunkSubtitles, clearSubtitleCache,
} from './subtitle-coordinator.js';
import { assertEvidenceBatch } from './evidence-factory.js';
import {
  needsOnDemandAsr, planAsrWindows, runOnDemandAsrWindows,
} from './on-demand-asr.js';
import {
  buildOnDemandAsrPlan, saveRefinementPlan, loadRefinementPlan, loadRefinementExec,
  assertPlanExecutable,
} from './refinement-plan.js';
import { createSpeechActivityAdapter } from './adapters/speech-activity-adapter.js';
import { suggestProfiles } from './profile-suggester.js';
import { auditIndexEvidence } from './evidence-auditor.js';
import { decideSecondPass } from './refinement-planner.js';
import { selectUtteranceEndFrames } from './utterance-end-frame.js';
import { writeJsonAtomic } from './atomic-json.js';
import { spawnSync } from 'node:child_process';
import {
  attachIndexOptionsToDescriptor, readSourceRef,
} from './source-ref.js';

function aborted(signal) {
  if (signal?.aborted) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }
}

function segmentSpeakerId(segment) {
  return segment?.speakerClusterId || segment?.speakerId || segment?.clusterId || null;
}

function attachSpeakersToUtterances(utterances, activeSegments) {
  if (!Array.isArray(activeSegments) || activeSegments.length === 0) return utterances;
  return (utterances || []).map((u) => {
    if (u.speakerClusterId || u.speakerId) return u;
    let best = null;
    let bestOverlap = 0;
    for (const segment of activeSegments) {
      const speakerClusterId = segmentSpeakerId(segment);
      if (!speakerClusterId) continue;
      const startMs = Number(segment.startMs);
      const endMs = Number(segment.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      const overlap = Math.max(0, Math.min(u.endMs, endMs) - Math.max(u.startMs, startMs));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = speakerClusterId;
      }
    }
    return best ? { ...u, speakerClusterId: best } : u;
  });
}

function buildAudioIndex(audioVisualResult) {
  if (!audioVisualResult?.ok) return [];
  return [
    ...(audioVisualResult.speakers || []).map((speaker) => ({ kind: 'speaker', ...speaker })),
    ...(audioVisualResult.activeSegments || []).map((segment) => ({ kind: 'active_segment', ...segment })),
    ...(audioVisualResult.overlaps || []).map((overlap) => ({ kind: 'overlap', ...overlap })),
  ];
}

export function createVideoIndexEngine({
  rootDir,
  ffmpegPath = 'ffmpeg',
  adapters = {},
  clock = () => new Date().toISOString(),
  log = () => {},
} = {}) {
  if (!rootDir) throw new Error('rootDir required (inject temp dir in tests)');
  const store = createIndexStore({ rootDir });
  const fileSource = adapters.fileSource || createFileSource({ clock });
  const bilibiliSource = adapters.bilibiliSource || createBilibiliSource({ clock });
  const asr = adapters.asr || createWhisperAsrAdapter();
  const ocr = adapters.ocr || createOcrAdapter({});
  const entity = adapters.entity || createEntityAdapter({});
  const audioVisual = adapters.audioVisual || createPyannoteAudioVisualAdapter();
  const speechActivity = adapters.speechActivity || createSpeechActivityAdapter({});
  const cache = createQueryCache({ store });
  /** @type {Map<string, object>} planHash → 已执行结果（幂等） */
  const refinementDone = new Map();
  const extractFrames = adapters.extractFrames || defaultExtractFrames;
  const extractAudio = adapters.extractAudio || extractAudioWav;
  const probeDuration = adapters.probeDuration || probeMediaDurationMs;
  let jobs = null;

  /**
   * 单 chunk 索引：纯数据输出，不发布全局 manifest。
   */
  async function indexChunk({
    videoKey,
    chunk,
    sourceDescriptor = null,
    sourceMode = 'file',
    mediaPath = null,
    capabilities: capOpts = {},
    signal,
    budgets = {},
    speakerMerge: mergeOpts = null,
    analysisPolicy: rawPolicy = null,
  } = {}) {
    const policy = normalizeAnalysisPolicy(rawPolicy, { capabilities: capOpts });
    aborted(signal);
    if (!chunk || (chunk.startMs == null && !chunk.chunkId && !sourceDescriptor?.captureBundle)) {
      throw new Error('chunk required');
    }
    if (!chunk.chunkId) chunk = { ...chunk, chunkId: '000000' };

    // R1: capture bundle 专用管线 —— 必须在普通 ASR 之前完成
    if (sourceDescriptor?.captureBundle) {
      const bundle = sourceDescriptor.captureBundle;
      const tempRoot = bundle.tempRoot
        || (bundle.audioSegments?.[0]?.path
          ? join(bundle.audioSegments[0].path, '..', '..')
          : join(store.videoDir(videoKey), 'tmp'));
      const analyzed = await analyzeCaptureBundle({
        videoKey,
        chunkId: chunk.chunkId,
        chunk,
        bundle,
        tempRoot,
        asr,
        audioVisual,
        capabilities: capOpts,
        speakerMerge: mergeOpts || capOpts.speakerMerge || null,
        signal,
        sessionWallOriginMs: bundle.sessionWallOriginMs ?? null,
        clock,
      });
      const resolved = analyzed.resolvedChunk || {};
      return {
        chunkManifest: null,
        utterances: analyzed.utterances || [],
        events: analyzed.events || [],
        speakers: analyzed.speakers || [],
        storyboard: analyzed.storyboard || [],
        evidence: analyzed.evidence || [],
        chapters: analyzed.chapters || [],
        speakerEmbeddings: analyzed.speakerEmbeddings || [],
        degraded: analyzed.degraded,
        error: null,
        capabilities: analyzed.capabilities || {},
        byteUsage: analyzed.byteUsage || { downloaded: 0, temporaryPeak: 0, outputBytes: 0 },
        timeSource: analyzed.timeSource || 'wallclock',
        discontinuity: analyzed.discontinuity,
        gaps: analyzed.gaps || [],
        provenance: {
          ...(analyzed.provenance || {}),
          layoutVersion: LAYOUT_VERSION,
          captureBundleBeforeAsr: true,
        },
        resolvedChunk: {
          startMs: resolved.startMs ?? chunk.startMs,
          endMs: resolved.endMs ?? chunk.endMs,
        },
      };
    }

    const offsetMs = Number(chunk.inputStartMs ?? chunk.startMs) || 0;
    const tempDir = join(store.videoDir(videoKey), 'tmp', `chunk-${chunk.chunkId}`);
    mkdirSync(tempDir, { recursive: true });
    const wavOut = join(tempDir, 'audio.wav');
    let byteUsage = { downloaded: 0, temporaryPeak: 0 };
    let timeSource = sourceMode === 'capture' ? 'wallclock' : 'stream';
    let degraded = false;
    let error = null;
    const capabilities = {};
    let utterances = [];
    let events = [];
    let speakers = [];
    let storyboard = [];
    let evidence = [];
    let chapters = [];
    let gaps = [];
    /** @type {any[]} */
    let speakerEmbeddings = [];
    let chunkCoverage = null;
    let audioPath = null;

    try {
      // 字幕优先：显式 policy → coordinator（与同步 index 共用）；否则旧 descriptor 裁剪
      if (policy) {
        aborted(signal);
        const videoSubs = await resolveVideoSubtitles({
          videoKey,
          indexVersion: `chunk:${chunk.chunkId}`,
          mediaPath,
          mediaRevision: sourceDescriptor?.contentFingerprint || null,
          sourceDescriptor,
          bilibiliSubtitles: Array.isArray(sourceDescriptor?.subtitles)
            ? sourceDescriptor.subtitles.filter((s) => s.text)
            : null,
          bilibiliSubtitleMap: sourceDescriptor?.subtitleMap || null,
          subtitlePath: sourceDescriptor?.subtitlePath || null,
          language: capOpts.language || policy.language || null,
          policy,
          durationMs: Number(sourceDescriptor?.durationMs) || chunk.endMs || 0,
          signal,
          ocr: null,
          ffmpegPath,
          ffprobePath: adapters.ffprobePath || 'ffprobe',
          outDir: tempDir,
          clock,
          ocrMode: 'none',
          probeOnly: true,
          adapters: {
            fetchSubtitleUrl: adapters.fetchSubtitleUrl || null,
            streamOcrFfmpeg: adapters.streamOcrFfmpeg || null,
            ffmpegSubtitle: adapters.ffmpegSubtitle || null,
            ffprobeSubtitle: adapters.ffprobeSubtitle || null,
          },
        });
        aborted(signal);
        const chunkSubs = await resolveChunkSubtitles({
          videoKey,
          indexVersion: `chunk:${chunk.chunkId}`,
          chunk,
          videoSubtitles: videoSubs,
          mediaPath,
          policy,
          signal,
          ocr,
          asr,
          extractAudio: async (opts) => extractAudio({
            ...opts,
            ffmpegPath,
            outputPath: opts.outputPath || join(tempDir, 'coord-asr.wav'),
          }),
          ffmpegPath,
          clock,
          adapters: {
            streamOcrFfmpeg: adapters.streamOcrFfmpeg || null,
          },
          ocrCallCounter: videoSubs.ocrCallCounter,
        });
        aborted(signal);
        utterances = (chunkSubs.utterances || []).map((u) => ({ ...u, chunkId: chunk.chunkId }));
        evidence = chunkSubs.evidence || [];
        const checked = assertEvidenceBatch(evidence);
        if (!checked.ok && checked.errors?.length) {
          degraded = true;
          error = { code: 'EVIDENCE', message: checked.errors[0]?.message || 'invalid evidence' };
          evidence = checked.evidence;
        }
        events = subtitleEvents(
          (chunkSubs.subtitles || utterances).map((u) => ({
            ...u,
            evidenceId: u.evidenceId,
            evidenceIds: u.evidenceIds || [u.evidenceId].filter(Boolean),
            text: u.text || '',
          })),
          { videoKey },
        );
        capabilities.subtitles = chunkSubs.capabilities?.subtitleText || (utterances.length ? 'ready' : 'unavailable');
        capabilities.subtitleText = capabilities.subtitles;
        capabilities.subtitleOcr = chunkSubs.capabilities?.subtitleOcr || 'skipped';
        if (chunkSubs.capabilities?.asr) capabilities.asr = chunkSubs.capabilities.asr;
        chunkCoverage = chunkSubs.coverage;
        if (chunkSubs.truncated) {
          capabilities.subtitleOcr = capabilities.subtitleOcr === 'ready'
            ? 'degraded'
            : capabilities.subtitleOcr;
        }
      } else {
        const subs = Array.isArray(sourceDescriptor?.subtitles) ? sourceDescriptor.subtitles : [];
        const inRange = subs.filter((s) => {
          const mid = ((s.startMs || 0) + (s.endMs || 0)) / 2;
          return mid >= chunk.startMs && mid < chunk.endMs;
        });
        if (inRange.length) {
          const pack = normalizeSubtitles(inRange, { videoKey, clock });
          utterances = pack.utterances.map((u) => ({ ...u, chunkId: chunk.chunkId }));
          evidence = pack.evidence;
          events = subtitleEvents(pack.subtitles, { videoKey });
          capabilities.subtitles = 'ready';
        } else {
          capabilities.subtitles = 'unavailable';
        }
      }

      // 音频提取
      if (sourceMode === 'url' && sourceDescriptor?.audio?.url) {
        try {
          const r = await extractAudioRange({
            descriptor: sourceDescriptor,
            startMs: chunk.inputStartMs,
            endMs: chunk.inputEndMs,
            outWav: wavOut,
            ffmpegPath,
            signal,
            limits: budgets.remote,
            runner: adapters.remoteFfmpeg || null,
          });
          audioPath = r.path;
          byteUsage = r.byteUsage || byteUsage;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          degraded = true;
          error = { code: e.code || 'REMOTE', message: e.message };
          capabilities.asr = 'degraded';
        }
      } else if (mediaPath && existsSync(mediaPath)) {
        try {
          const r = await extractAudio({
            inputPath: mediaPath,
            outputPath: wavOut,
            ffmpegPath,
            signal,
            startMs: chunk.inputStartMs,
            endMs: chunk.inputEndMs,
          });
          audioPath = r?.path || wavOut;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          degraded = true;
          error = { code: e.code || 'AUDIO', message: e.message };
        }
      }

      // ASR：policy 存在时严格按 mode；否则保持旧 capabilities.asr 行为
      let wantAsr;
      let skipAsrForSubs = false;
      if (policy) {
        const gate = mayRunAsr(policy, {
          reason: utterances.length ? 'index' : 'subtitle_gap',
        });
        // full → 允许；fallback 仅缺口；on_demand/off → 索引阶段不跑
        wantAsr = gate.ok === true
          && (policy.asr.mode === 'full'
            || (policy.asr.mode === 'fallback' && !utterances.length));
        if (!wantAsr) {
          capabilities.asr = policy.asr.mode === 'off' ? 'skipped'
            : (utterances.length ? 'skipped' : 'skipped');
        }
      } else {
        wantAsr = capOpts.asr === 'on'
          || (capOpts.asr !== 'off' && !utterances.length);
        skipAsrForSubs = sourceMode === 'url' && utterances.length > 0 && capOpts.asr !== 'on';
      }
      if (wantAsr && !skipAsrForSubs) {
        const asrAvail = asr.available();
        if (!asrAvail.ok) {
          capabilities.asr = 'unavailable';
          if (!utterances.length) degraded = true;
        } else if (audioPath) {
          const asrOut = await asr.analyze({
            videoKey,
            audioPath,
            offsetMs,
            chunkId: chunk.chunkId,
            language: capOpts.language || null,
          }, { signal });
          if (asrOut.ok) {
            const tagged = (asrOut.utterances || []).map((u) => ({
              ...u,
              source: 'asr_generated',
              provenance: { ...(u.provenance || {}), source: 'asr_generated' },
            }));
            utterances = [...utterances, ...tagged];
            evidence = [...evidence, ...(asrOut.evidence || [])];
            capabilities.asr = 'ready';
          } else {
            capabilities.asr = asrOut.reason === 'unavailable' ? 'unavailable' : 'degraded';
            if (!utterances.length) degraded = true;
          }
        } else {
          capabilities.asr = 'unavailable';
          if (!utterances.length) degraded = true;
        }
      } else if (skipAsrForSubs) {
        capabilities.asr = 'skipped';
      } else if (!policy) {
        capabilities.asr = utterances.length ? 'skipped' : 'unavailable';
      }

      // diarization（可选）+ speaker embedding（显式 speakerMerge.enabled）
      const wantDiar = capOpts.diarization === 'on';
      const mergeCfg = mergeOpts || capOpts.speakerMerge || null;
      const wantEmb = Boolean(wantDiar && mergeCfg?.enabled);
      if (wantDiar && audioPath && audioVisual.available().ok) {
        try {
          const av = await audioVisual.analyze({
            videoKey,
            audioPath,
            chunkId: chunk.chunkId,
            offsetMs,
            returnEmbeddings: wantEmb,
            utterances,
          }, { signal });
          if (av.ok) {
            speakers = (av.speakers || []).map((s) => {
              const id = s.speakerClusterId || s.speakerId;
              const ranges = (av.activeSegments || [])
                .filter((seg) => (seg.speakerClusterId || seg.speakerId) === id)
                .filter((seg) => Number.isFinite(seg.startMs) && Number.isFinite(seg.endMs))
                .map((seg) => ({ startMs: seg.startMs, endMs: seg.endMs }))
                .slice(0, 6);
              return ranges.length && !s.timeRanges ? { ...s, timeRanges: ranges } : s;
            });
            utterances = attachSpeakersToUtterances(utterances, av.activeSegments);
            capabilities.diarization = 'ready';
            if (wantEmb) {
              const status = av.embeddingStatus;
              const raw = av.speakerEmbeddings || av.embeddings || [];
              if ((!raw || !raw.length) && status && status.ok === false) {
                capabilities.speakerMerge = status.reason === 'unavailable' ? 'unavailable' : 'degraded';
              } else {
                const validated = validateSpeakerEmbeddings(raw, { allowEmpty: false });
                if (validated.ok && validated.embeddings.length) {
                  speakerEmbeddings = validated.embeddings;
                  capabilities.speakerMerge = 'pending';
                } else if (!raw?.length) {
                  capabilities.speakerMerge = 'unavailable';
                } else {
                  capabilities.speakerMerge = 'degraded';
                }
              }
            }
          } else {
            capabilities.diarization = av.reason === 'unavailable' ? 'unavailable' : 'degraded';
            if (wantEmb) capabilities.speakerMerge = 'unavailable';
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          capabilities.diarization = 'degraded';
          if (wantEmb) capabilities.speakerMerge = 'degraded';
        }
      } else {
        capabilities.diarization = wantDiar ? 'unavailable' : 'skipped';
        if (wantEmb) capabilities.speakerMerge = 'unavailable';
        else if (mergeCfg?.enabled) capabilities.speakerMerge = 'disabled';
      }

      // 轻量帧（最多 maxFramesPerChunk）
      const maxFrames = Math.min(4, Number(budgets.maxFramesPerChunk) || 4);
      if (capOpts.storyboard !== 'off' && maxFrames > 0) {
        try {
          if (sourceMode === 'url' && sourceDescriptor?.video?.url) {
            const mid = Math.floor((chunk.startMs + chunk.endMs) / 2);
            const pngOut = join(tempDir, 'frame.png');
            const fr = await extractFrameAt({
              descriptor: sourceDescriptor,
              atMs: mid,
              outPng: pngOut,
              ffmpegPath,
              signal,
              runner: adapters.remoteFfmpeg || null,
            });
            byteUsage.downloaded += fr.byteUsage?.downloaded || 0;
            storyboard.push({
              frameId: frameIdOf({ videoKey, timestampMs: mid, contentHash: contentHash(String(mid)) }),
              timestampMs: mid,
              imageRef: pngOut,
              chunkId: chunk.chunkId,
            });
            capabilities.storyboard = 'ready';
          } else if (mediaPath && existsSync(mediaPath)) {
            const seekSec = (chunk.startMs + chunk.endMs) / 2000;
            const fw = 320;
            const fh = 180;
            const frames = await extractFrames({
              path: mediaPath,
              ffmpegPath,
              width: fw,
              height: fh,
              fps: 1,
              signal,
              maxFrames,
              seekSec,
            });
            let stored = 0;
            for (const fr of frames.slice(0, maxFrames)) {
              if (!fr?.buf) continue;
              const ts = Number.isFinite(fr.timestampMs)
                ? Math.round(fr.timestampMs)
                : Math.round((Number(fr.t) || 0) * 1000);
              let w = fr.width || fw;
              let h = fr.height || fh;
              let png;
              try {
                if (fr.buf.length !== w * h * 3) {
                  w = 1;
                  h = 1;
                  const px = Buffer.alloc(3);
                  fr.buf.copy(px, 0, 0, Math.min(3, fr.buf.length));
                  png = encodePng(px, 1, 1, { level: 3 });
                } else {
                  png = encodePng(fr.buf, w, h, { level: 3 });
                }
              } catch {
                continue;
              }
              const ch = contentHash(png);
              const roi = { x: 0, y: 0, width: w, height: h };
              const fid = frameIdOf({ videoKey, timestampMs: ts, roi, contentHash: ch });
              const eid = evidenceIdOf({
                videoKey, kind: 'frame', startMs: ts, endMs: ts, contentHash: ch,
              });
              const sourceFile = `evidence/frames/${fid}.png`;
              try {
                store.writeBinary(videoKey, sourceFile, png);
              } catch {
                continue;
              }
              const unit = {
                frameId: fid,
                timestampMs: ts,
                chunkId: chunk.chunkId,
                imageRef: evidenceLogicalRef(videoKey, 'frame', fid),
                sourceSize: { width: w, height: h },
                storedSize: { width: w, height: h },
                roi,
                transform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
                selectionReasons: ['chunk_lightweight'],
                evidenceIds: [eid],
              };
              storyboard.push(unit);
              evidence.push({
                evidenceId: eid,
                kind: 'frame',
                startMs: ts,
                endMs: ts,
                ref: unit.imageRef,
                sourceFile,
                contentHash: ch,
                provenance: { via: 'chunk_storyboard', generatedAt: clock() },
              });
              stored += 1;
            }
            const complete = storyboard.length > 0
              && storyboard.every((u) => u.imageRef && u.evidenceIds?.length)
              && stored === storyboard.length;
            capabilities.storyboard = complete ? 'ready' : 'degraded';
          } else {
            capabilities.storyboard = 'unavailable';
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          capabilities.storyboard = 'degraded';
        }
      } else {
        capabilities.storyboard = 'skipped';
      }

      if (utterances.length) {
        chapters = buildAsrChapterSkeleton(utterances, {
          videoKey,
          indexVersion: `chunk:${chunk.chunkId}`,
        }).slice(0, 3);
      }
    } finally {
      // 默认删除临时 wav（keepAudio 除外）
      if (!budgets.keepAudio) {
        try { if (existsSync(wavOut)) unlinkSync(wavOut); } catch { /* ignore */ }
      }
    }

    return {
      chunkManifest: null, // 由 controller 组装
      utterances,
      events,
      speakers,
      storyboard,
      evidence,
      chapters,
      speakerEmbeddings, // 私有运行时字段；controller 不得写入 chunk JSON
      degraded,
      error,
      capabilities,
      byteUsage,
      timeSource,
      discontinuity: Boolean(gaps.length),
      gaps,
      provenance: {
        generatedAt: typeof clock === 'function' ? clock() : new Date().toISOString(),
        sourceMode,
        layoutVersion: LAYOUT_VERSION,
      },
      coverage: chunkCoverage || undefined,
    };
  }

  jobs = createJobController({
    rootDir,
    indexChunk: async (args) => {
      // 补 mediaPath：file 模式从 descriptor 或现有索引
      let mediaPath = args.mediaPath || args.sourceDescriptor?.mediaPath || null;
      if (!mediaPath && args.sourceMode === 'file' && args.videoKey) {
        try {
          const meta = store.readPart(args.videoKey, store.LAYOUT.metadata, { optional: true });
          mediaPath = meta?.path || null;
        } catch { /* ignore */ }
      }
      return indexChunk({ ...args, mediaPath });
    },
    clock: () => Date.now(),
    log,
  });

  async function resolveSource(input, { signal, downloadMedia = false, cachePath = null } = {}) {
    const source = input.source || input;
    const kind = String(source.kind || 'file').toLowerCase();
    if (kind === 'bilibili') {
      return bilibiliSource.resolve(source, { signal, downloadMedia, cachePath });
    }
    if (kind === 'file') return fileSource.resolve(source, { signal });
    throw new Error(`unsupported source kind: ${kind}`);
  }

  async function index(input, options = {}) {
    const {
      profile = 'auto',
      capabilities: capOpts = {},
      rebuild = false,
      signal,
      width = 800,
      height = 450,
      fps = 6,
      skipStoryboard = false,
      /** 显式允许缓存/下载媒体（Bilibili Storyboard 需要） */
      cacheMedia = false,
      subtitlePath = null,
      subtitles: inlineSubtitles = null,
      analysisPolicy: rawPolicy = undefined,
      secondPassConfirmation = null,
    } = options;

    aborted(signal);
    // rawPolicy === undefined → 未传，兼容旧路径；显式 {} / 对象 → 启用新管线
    const effectivePolicy = normalizeAnalysisPolicy(
      rawPolicy === undefined ? null : rawPolicy,
      { capabilities: capOpts, explicitPolicy: rawPolicy !== undefined },
    );
    const sourceIn = input.source || input;
    const kind = String(sourceIn.kind || 'file').toLowerCase();
    const subtitleFirst = Boolean(effectivePolicy?.subtitleFirst?.enabled);
    // 字幕优先：首次索引不依赖固定 maxFrames:120 全片视觉覆盖
    const wantStoryboard = !skipStoryboard
      && (capOpts.storyboard || 'auto') !== 'off'
      && !subtitleFirst;
    const needDownload = kind === 'bilibili' && wantStoryboard && cacheMedia === true;

    // 先轻量 resolve（不下载体），用于复用判断
    const preview = await resolveSource(input, { signal, downloadMedia: false });
    let { videoKey, fingerprint, metadata, subtitles: rawSubs, mediaRef, provenance } = preview;

    // 合并外挂字幕：subtitlePath > inline > source 自带
    if (subtitlePath) {
      rawSubs = loadSubtitleFile(subtitlePath);
    } else if (Array.isArray(inlineSubtitles) && inlineSubtitles.length) {
      rawSubs = inlineSubtitles;
    } else if (Array.isArray(sourceIn.subtitles) && sourceIn.subtitles.length && !rawSubs?.length) {
      rawSubs = sourceIn.subtitles;
    }

    if (!rebuild && store.exists(videoKey)) {
      const existing = store.readManifest(videoKey, { optional: true });
      if (existing && (existing.status === 'ready' || existing.status === 'degraded')) {
        const meta = store.readPart(videoKey, store.LAYOUT.metadata, { optional: true });
        const requestedCapabilitiesReady = Object.entries(capOpts)
          .filter(([, value]) => value === 'on')
          .every(([name]) => existing.capabilities?.[name] === 'ready');
        const hasFreshIdentityEvidence = Array.isArray(options.identityObservations)
          && options.identityObservations.length > 0;
        if (meta?.fingerprint === fingerprint
          && requestedCapabilitiesReady
          && !hasFreshIdentityEvidence) {
          return { ok: true, reused: true, videoKey, manifest: existing };
        }
      }
    }

    const indexVersion = indexVersionOf({
      fingerprint,
      pipeline: '0.0.5+',
      retrieval: RETRIEVAL_VERSION,
      profile,
    });

    // 整个重建写在 staging；成功后原子切换，避免旧 ready 指向混合数据
    store.beginStaging(videoKey);
    try {
    if (needDownload) {
      const cachePath = defaultCacheMediaPath(store.activeVideoDir(videoKey), 'source.mp4');
      const downloaded = await bilibiliSource.resolve(sourceIn, {
        signal,
        downloadMedia: true,
        cachePath,
      });
      mediaRef = downloaded.mediaRef;
      metadata = { ...metadata, ...downloaded.metadata };
      if (downloaded.subtitles?.length && !rawSubs?.length) rawSubs = downloaded.subtitles;
      provenance = downloaded.provenance;
    }

    const building = createBuildingManifest({
      videoKey,
      source: {
        kind: kind === 'bilibili' ? 'bilibili' : (input.source?.kind || 'file'),
        uri: metadata.webpage_url || metadata.path || input.source?.url || input.source?.path,
        partId: input.source?.partId || 'p1',
      },
      indexVersion,
      clock,
    });
    // building 只写在 staging，不碰 live manifest
    store.writePart(videoKey, '.building.json', building);

    const caps = emptyCapabilities({ metadata: 'ready' });
    let status = 'ready';
    const adapterVersions = { [provenance.adapter]: provenance.version };
    let coverage = null;
    let subtitleSegments = [];
    let recommendations = [];
    let speechActivityResult = null;
    let auditResult = null;

    // 字幕：显式 policy → 统一 source coordinator；否则旧路径
    let subPack = { subtitles: [], utterances: [], evidence: [], chapters: [] };
    const wantSubs = (capOpts.subtitles || 'auto') !== 'off';
    const mediaPathEarly = mediaRef?.path || metadata.path || null;
    const durationMs = Number(metadata.durationMs) || Number(metadata.duration) * 1000 || 0;

    if (effectivePolicy && wantSubs) {
      const extractAt = adapters.extractFrameAt || (mediaPathEarly ? async ({ atMs, signal: sig }) => {
        aborted(sig || signal);
        const frames = await extractFrames({
          path: mediaPathEarly,
          ffmpegPath,
          width: Math.min(width, 640),
          height: Math.min(height, 360),
          fps: 1,
          signal: sig || signal,
          maxFrames: 1,
          seekSec: (atMs || 0) / 1000,
        });
        return frames[0] || null;
      } : null);
      // 同步短片允许 whole_video OCR；长视频后台路径使用 ocrMode:none
      const syncOcrMode = (Number.isFinite(durationMs) && durationMs > 12 * 60_000)
        ? 'none'
        : 'whole_video';
      const resolved = await resolveVideoSubtitles({
        videoKey,
        indexVersion,
        mediaPath: mediaPathEarly,
        mediaRevision: fingerprint || null,
        bilibiliSubtitles: kind === 'bilibili' ? rawSubs : null,
        bilibiliSubtitleMap: preview?.subtitleMap || null,
        nativeSubtitles: kind !== 'bilibili' ? rawSubs : null,
        subtitlePath: subtitlePath || null,
        language: capOpts.language || null,
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
        policy: effectivePolicy,
        ocr,
        extractFrameAt: extractAt,
        signal,
        ffmpegPath,
        ffprobePath: adapters.ffprobePath || 'ffprobe',
        outDir: join(store.activeVideoDir(videoKey), 'tmp'),
        clock,
        ocrMode: syncOcrMode,
        adapters: {
          fetchSubtitleUrl: adapters.fetchSubtitleUrl || null,
          streamOcrFfmpeg: adapters.streamOcrFfmpeg || null,
          ffmpegSubtitle: adapters.ffmpegSubtitle || null,
          ffprobeSubtitle: adapters.ffprobeSubtitle || null,
          detectSubtitleRoi: adapters.detectSubtitleRoi || null,
        },
      });
      subtitleSegments = (resolved.utterances || []).map((u) => ({
        segmentId: u.utteranceId || u.segmentId,
        startMs: u.startMs,
        endMs: u.endMs,
        text: u.text,
        confidence: u.confidence ?? 0.9,
        language: u.language || u.lang || null,
        source: u.sourceType || u.source || 'native',
        evidenceId: u.evidenceId,
        chunkId: u.chunkId || null,
      }));
      subPack = {
        subtitles: resolved.subtitles || subtitleSegments,
        utterances: resolved.utterances || [],
        evidence: resolved.evidence || [],
        chapters: resolved.chapters || [],
      };
      caps.subtitles = resolved.capabilities?.subtitleText || (subPack.utterances.length ? 'ready' : 'unavailable');
      caps.subtitleText = resolved.capabilities?.subtitleText || caps.subtitles;
      caps.subtitleOcr = resolved.capabilities?.subtitleOcr || 'skipped';
      coverage = resolved.coverage || buildCoverage(subtitleSegments, durationMs);
      if (ocr.available?.().ok) adapterVersions[ocr.name] = ocr.version;
    } else if (wantSubs && rawSubs?.length) {
      subPack = normalizeSubtitles(rawSubs, { videoKey, indexVersion, clock });
      caps.subtitles = 'ready';
      caps.subtitleText = 'ready';
      caps.subtitleOcr = 'skipped';
    } else if (wantSubs) {
      caps.subtitles = 'unavailable';
      caps.subtitleText = 'unavailable';
    } else {
      caps.subtitles = 'skipped';
      caps.subtitleText = 'skipped';
    }

    let analysisAudioPath = mediaRef?.path || metadata.path || null;
    let audioExtractAttempted = false;
    const ensureAnalysisAudio = async () => {
      if (audioExtractAttempted) return analysisAudioPath;
      audioExtractAttempted = true;
      const mediaForAudio = mediaRef?.path || metadata.path;
      if (!mediaForAudio || !existsSync(mediaForAudio)) return analysisAudioPath;
      const wavOut = defaultCacheAudioPath(store.activeVideoDir(videoKey), 'audio.wav');
      try {
        const ar = await extractAudio({
          inputPath: mediaForAudio,
          outputPath: wavOut,
          ffmpegPath,
          signal,
        });
        if (ar?.path) analysisAudioPath = ar.path;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        log(`audio extract skipped: ${e.message}`);
      }
      return analysisAudioPath;
    };

    // 语音活动辅助（独立授权；关闭时零 VAD）
    if (effectivePolicy) {
      if (!mayRunVad(effectivePolicy)) {
        caps.speechActivityAssist = 'disabled';
      } else {
        aborted(signal);
        const audioPath = await ensureAnalysisAudio();
        speechActivityResult = await speechActivity.analyze(
          { videoKey, audioPath, durationMs },
          { signal, policy: effectivePolicy },
        );
        caps.speechActivityAssist = speechActivityResult.capability || 'unavailable';
        if (speechActivityResult.recommendations?.length) {
          recommendations.push(...speechActivityResult.recommendations);
        }
      }
    }

    // ASR：policy 严格门控；旧路径保持 capabilities.asr 行为
    let wantAsr;
    if (effectivePolicy) {
      const gap = !subPack.utterances.length
        || (coverage?.gapCount > 0 && effectivePolicy.asr.mode === 'fallback');
      const gate = mayRunAsr(effectivePolicy, {
        reason: gap && !subPack.utterances.length ? 'subtitle_gap' : 'index',
      });
      wantAsr = gate.ok === true && (
        effectivePolicy.asr.mode === 'full'
        || (effectivePolicy.asr.mode === 'fallback' && !subPack.utterances.length)
      );
      if (!wantAsr) caps.asr = 'skipped';
    } else {
      wantAsr = capOpts.asr === 'on' || (capOpts.asr !== 'off' && !subPack.utterances.length);
    }
    if (wantAsr) {
      const asrAvail = asr.available();
      if (!asrAvail.ok) {
        caps.asr = 'unavailable';
        if (!subPack.utterances.length) status = 'degraded';
      } else {
        try {
          aborted(signal);
          const audioPath = await ensureAnalysisAudio();
          const asrOut = await asr.analyze({
            videoKey,
            audioPath,
          }, { signal });
          adapterVersions[asr.name] = asr.version;
          if (asrOut.ok) {
            const taggedU = (asrOut.utterances || []).map((u) => ({
              ...u,
              source: 'asr_generated',
              provenance: { ...(u.provenance || {}), source: 'asr_generated' },
            }));
            subPack.utterances = [...subPack.utterances, ...taggedU];
            subPack.evidence = [...subPack.evidence, ...(asrOut.evidence || [])];
            caps.asr = 'ready';
          } else {
            caps.asr = asrOut.reason === 'unavailable' ? 'unavailable' : 'degraded';
            status = 'degraded';
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          caps.asr = 'degraded';
          status = 'degraded';
          log(`asr failed: ${e.message}`);
        }
      }
    } else if (!effectivePolicy) {
      caps.asr = subPack.utterances.length ? 'skipped' : 'unavailable';
    }

    // OCR / diarization / identity — 按需，默认不可用
    caps.ocr = ocr.available().ok && capOpts.ocr === 'on' ? 'ready' : 'unavailable';
    const wantDiar = capOpts.diarization === 'on'
      || profile === 'interview'
      || capOpts.identityBinding === 'on';
    const audioVisualAvailable = wantDiar && audioVisual.available().ok;
    caps.diarization = wantDiar && audioVisualAvailable ? 'pending' : 'unavailable';
    caps.identityBinding = (capOpts.identityBinding === 'on'
      || options.identityObservations?.length)
      ? 'pending'
      : 'unavailable';

    // Storyboard（字幕优先模式下跳过批量 maxFrames:120；改按需/段尾帧）
    let storyboardUnits = [];
    let frameEvidence = [];
    const mediaPath = mediaRef?.path || metadata.path || null;
    if (subtitleFirst) {
      caps.storyboard = 'skipped';
      caps.onDemandVisual = resolveOnDemandVisualCap({
        mediaPath,
        extractFrames: adapters.extractFrames || null,
        extractFrameAt: adapters.extractFrameAt || null,
        remoteFrameExtractor: adapters.remoteFrameExtractor || null,
        policyDisabled: effectivePolicy?.subtitleFirst?.enabled === false,
        ffmpegPath,
        extractorAvailable: adapters.visualAvailable || null,
      });
    } else if (wantStoryboard && mediaPath) {
      try {
        aborted(signal);
        const frames = await extractFrames({
          path: mediaPath,
          ffmpegPath,
          width,
          height,
          fps,
          signal,
          maxFrames: 120,
        });
        const indexer = createStoryboardIndexer({
          videoKey,
          indexVersion,
          store,
          sourceSize: { width, height },
          storedSize: { width, height },
          clock,
        });
        // 用 pipeline observer 风格处理
        const pipe = createPipeline({
          width, height, fps, queueDepth: 0, maxWaitSec: 999, silentFloorSec: 999,
          onKeep: null,
        });
        // 若 pipeline 支持 observer 则挂上；否则直接喂 indexer
        for (const fr of frames) {
          aborted(signal);
          pipe.push({ t: fr.t, buf: fr.buf });
        }
        pipe.finish();
        // 从 pipeline log 重建 keep 事件；同时保留原始帧 buf
        const byT = new Map(frames.map((f) => [+f.t.toFixed(2), f]));
        for (const entry of pipe.log) {
          const fr = byT.get(entry.t) || frames.find((f) => Math.abs(f.t - entry.t) < 0.05);
          const png = fr ? encodePng(fr.buf, width, height, { level: 3 }) : null;
          indexer.onKeep({
            t: entry.t,
            via: entry.via,
            score: entry.score,
            tier: entry.tier,
            buf: fr?.buf,
            png,
            width,
            height,
          });
        }
        const r = indexer.result();
        storyboardUnits = r.storyboardUnits;
        frameEvidence = r.evidence;
        caps.storyboard = storyboardUnits.length ? 'ready' : 'degraded';
        if (!storyboardUnits.length) status = 'degraded';
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        caps.storyboard = 'degraded';
        status = 'degraded';
        log(`storyboard failed: ${e.message}`);
      }
    } else if (!wantStoryboard) {
      caps.storyboard = 'skipped';
    } else {
      // bilibili 未开 cacheMedia 时没有本地媒体：明确 unavailable，不伪造帧
      caps.storyboard = 'unavailable';
      if (kind === 'bilibili' && !cacheMedia) {
        log('bilibili storyboard skipped: pass cacheMedia:true to download via yt-dlp');
      }
      status = 'degraded';
    }

    aborted(signal);

    const events = subtitleEvents(subPack.subtitles, { videoKey, indexVersion });
    const evidenceIndex = [...subPack.evidence, ...frameEvidence];
    const entityOverview = [];
    let audioIndex = [];
    let adapterIdentityObservations = [];

    if (wantDiar && audioVisualAvailable) {
      try {
        const audioPath = await ensureAnalysisAudio();
        aborted(signal);
        const av = await audioVisual.analyze({
          videoKey,
          audioPath,
          mediaPath,
          utterances: subPack.utterances,
          storyboardUnits,
        }, { signal });
        aborted(signal);
        adapterVersions[audioVisual.name] = audioVisual.version;
        if (av.ok) {
          caps.diarization = 'ready';
          audioIndex = buildAudioIndex(av);
          subPack.utterances = attachSpeakersToUtterances(subPack.utterances, av.activeSegments);
          adapterIdentityObservations = Array.isArray(av.observations) ? av.observations : [];
        } else {
          caps.diarization = av.reason === 'unavailable' ? 'unavailable' : 'degraded';
          status = 'degraded';
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        caps.diarization = 'degraded';
        status = 'degraded';
        log(`audio-visual analysis failed: ${e.message}`);
      }
    }

    // 可选身份（注入观察时）
    const identityObservations = [
      ...(Array.isArray(options.identityObservations) ? options.identityObservations : []),
      ...adapterIdentityObservations,
    ];
    const identityRequested = caps.identityBinding === 'pending'
      || capOpts.identityBinding === 'on'
      || identityObservations.length > 0;
    if (identityObservations.length) {
      const idr = resolveIdentities({
        videoKey,
        observations: identityObservations,
      });
      entityOverview.push(...idr.persons);
      caps.identityBinding = classifyIdentityBindingCapability({
        requested: identityRequested,
        ranResolver: true,
        persons: idr.persons,
        observationsCount: identityObservations.length,
      });
    } else if (caps.identityBinding === 'pending') {
      caps.identityBinding = classifyIdentityBindingCapability({
        requested: identityRequested,
        ranResolver: false,
        persons: [],
        observationsCount: 0,
      });
    }

    // 无字幕章节但有 ASR utterances → 轻量章节（真实原文 title，不编造摘要）
    if ((!subPack.chapters || subPack.chapters.length === 0) && subPack.utterances.length) {
      subPack.chapters = buildAsrChapterSkeleton(subPack.utterances, {
        videoKey,
        indexVersion,
      });
    }

    const topics = aggregateTopics({
      utterances: subPack.utterances,
      chapters: subPack.chapters,
    });
    let chapters = enrichChapterTags(subPack.chapters, topics);
    const keyMoments = aggregateKeyMoments({
      chapters,
      utterances: subPack.utterances,
      events,
      videoKey,
      indexVersion,
    });

    // 段尾稳定帧：仅 effective policy 明确开启
    if (effectivePolicy?.captureUtteranceEndFrame?.enabled && mediaPath) {
      aborted(signal);
      const endSel = await selectUtteranceEndFrames({
        utterances: subPack.utterances,
        maxPerChunk: effectivePolicy.captureUtteranceEndFrame.maxPerChunk,
        extractFrameAt: async ({ atMs, signal: sig }) => {
          const frames = await extractFrames({
            path: mediaPath,
            ffmpegPath,
            width,
            height,
            fps: 1,
            signal: sig || signal,
            maxFrames: 1,
            seekSec: (atMs || 0) / 1000,
          });
          return frames[0] || null;
        },
        signal,
      });
      for (const fr of endSel.frames || []) {
        if (!fr.buf) continue;
        const fw = fr.width || width;
        const fh = fr.height || height;
        const png = encodePng(fr.buf, fw, fh, { level: 3 });
        const ch = contentHash(png);
        const roi = { x: 0, y: 0, width: fw, height: fh };
        const eid = evidenceIdOf({
          videoKey, kind: 'frame', startMs: fr.tMs, endMs: fr.tMs, contentHash: ch,
        });
        const fid = frameIdOf({
          videoKey, timestampMs: fr.tMs, roi, contentHash: ch,
        });
        const rel = `evidence/frames/${fid}.png`;
        try {
          store.writeBinary(videoKey, rel, png);
        } catch (e) {
          log(`end-frame write skipped: ${e.message}`);
          continue;
        }
        frameEvidence.push({
          evidenceId: eid,
          kind: 'frame',
          startMs: fr.tMs,
          endMs: fr.tMs,
          ref: `evidence://${videoKey}/${rel}`,
          sourceFile: rel,
          provenance: {
            generatedAt: clock(),
            via: 'utterance_end_frame',
            utteranceIds: fr.utteranceIds || [],
          },
        });
        storyboardUnits.push({
          frameId: fid,
          timestampMs: fr.tMs,
          imageRef: `evidence://${videoKey}/${rel}`,
          sourceSize: { width: fw, height: fh },
          storedSize: { width: fw, height: fh },
          roi,
          transform: { scale: 1 },
          selectionReasons: ['utterance_end_stable'],
          evidenceIds: [eid],
        });
      }
      if (endSel.frames?.length && caps.onDemandVisual !== 'unavailable') {
        caps.onDemandVisual = caps.onDemandVisual === 'unavailable' ? 'unavailable' : 'ready';
      }
    }

    if (!coverage && durationMs) {
      coverage = buildCoverage(subtitleSegments.length ? subtitleSegments : subPack.utterances, durationMs);
    }

    if (effectivePolicy?.profileSuggestion?.enabled !== false && effectivePolicy) {
      const sug = suggestProfiles({
        coverage,
        catalog: null,
        enabled: true,
        evidenceIds: (subPack.evidence || []).map((e) => e.evidenceId).filter(Boolean),
      });
      recommendations.push(...(sug.recommendations || []));
      caps.profileSuggestion = sug.recommendations?.length ? 'ready' : 'ready';
    } else if (effectivePolicy) {
      caps.profileSuggestion = 'skipped';
    }

    if (effectivePolicy?.postAnalysisAudit?.enabled) {
      auditResult = auditIndexEvidence({
        coverage,
        utterances: subPack.utterances,
        segments: subtitleSegments,
        policy: effectivePolicy,
        speechActivity: speechActivityResult,
      });
      caps.evidenceAudit = 'ready';
      const decision = decideSecondPass({
        policy: effectivePolicy,
        audit: auditResult,
        confirmation: secondPassConfirmation,
        priorAutoOnceDone: false,
      });
      if (decision.execute && decision.retryPlan) {
        // auto_once / 已确认 ask：仅记录 refinement 计划标记；局部重试由 refine action 执行写盘
        const revDir = join(store.activeVideoDir(videoKey), 'refinements');
        mkdirSync(revDir, { recursive: true });
        writeJsonAtomic(join(revDir, `plan-${decision.planHash || 'auto'}.json`), {
          executedAt: clock(),
          mode: decision.mode,
          planHash: decision.planHash,
          retryPlan: decision.retryPlan,
          autoOnceDone: decision.mode === 'auto_once',
        });
      } else if (decision.reportOnly && auditResult) {
        recommendations.push({
          code: 'AUDIT_RETRY_PLAN',
          severity: 'info',
          title: '逻辑复核建议局部重试',
          reason: decision.reason || 'ask',
          suggestedAction: 'confirm_second_pass',
          suggestedValue: {
            planHash: auditResult.planHash,
            retryPlan: auditResult.retryPlan,
          },
          estimatedCost: {
            extraFrames: (auditResult.retryPlan?.windows?.length || 0) * 12,
            extraAudioSeconds: 0,
          },
          requiresUserApproval: decision.mode !== 'auto_once',
          evidenceIds: [],
        });
      }
    } else if (effectivePolicy) {
      caps.evidenceAudit = 'skipped';
    }

    const now = clock();
    const manifest = validateManifest({
      ...building,
      status,
      updatedAt: now,
      capabilities: caps,
      versions: {
        pipeline: '0.0.5+',
        retrieval: RETRIEVAL_VERSION,
        adapters: adapterVersions,
      },
      counts: {
        chapters: chapters.length,
        events: events.length,
        utterances: subPack.utterances.length,
        storyboardUnits: storyboardUnits.length,
        evidence: (() => {
          const ids = new Set([
            ...evidenceIndex.map((e) => e.evidenceId),
            ...frameEvidence.map((e) => e.evidenceId),
          ]);
          return ids.size;
        })(),
      },
    });

    // 取消后不得提交 ready
    aborted(signal);

    const allEvidence = [...evidenceIndex];
    for (const e of frameEvidence) {
      if (!allEvidence.some((x) => x.evidenceId === e.evidenceId)) allEvidence.push(e);
    }

    store.commit(videoKey, {
      manifest,
      metadata: { ...metadata, fingerprint, profile },
      chapters,
      topics,
      entityOverview,
      keyMoments,
      timeline: events.map((e) => ({ startMs: e.startMs, endMs: e.endMs, eventId: e.eventId })),
      utterances: subPack.utterances,
      events,
      subtitles: subPack.subtitles,
      entityTracks: entityOverview,
      evidenceIndex: allEvidence,
      storyboardIndex: storyboardUnits,
      audioIndex,
      subtitleSegments: subtitleSegments.length ? subtitleSegments : undefined,
      coverage: coverage || undefined,
      recommendations: recommendations.length ? { items: recommendations } : undefined,
      effectivePolicy: effectivePolicy || undefined,
      audit: auditResult || undefined,
    });

    return {
      ok: true,
      reused: false,
      videoKey,
      manifest,
      effectivePolicy: effectivePolicy || null,
      coverage: coverage || null,
      recommendations,
      audit: auditResult || null,
    };
    } catch (e) {
      try { store.abortStaging(videoKey); } catch { /* ignore */ }
      throw e;
    }
  }

  function attachOnDemandHint(result, {
    question, retrieval, coverage, policy, durationMs, videoKey,
  }) {
    if (!policy || policy.asr?.mode !== 'on_demand' || !videoKey) return result;
    const need = needsOnDemandAsr({ question, retrieval, coverage, policy });
    if (!need.ok) return result;
    let baseRevision = 1;
    try {
      if (store.exists(videoKey)) {
        const idx = store.loadIndex(videoKey);
        baseRevision = (idx.manifest?.counts?.evidence || 0) + 0;
      } else {
        const cstore = createChunkStore({ rootDir, videoKey });
        const cat = cstore.readCatalog({ optional: true });
        baseRevision = cat?.revision || cat?.chunks?.length || 1;
      }
    } catch { /* ignore */ }
    const plan = buildOnDemandAsrPlan({
      videoKey,
      question,
      baseRevision,
      durationMs,
      coverage,
      retrieval,
      policy,
      reasons: need.reasons,
    });
    try {
      saveRefinementPlan(store.activeVideoDir(videoKey), plan, { clock });
    } catch {
      try { saveRefinementPlan(store.videoDir(videoKey), plan, { clock }); } catch { /* ignore */ }
    }
    return {
      ...result,
      reasons: [...(result.reasons || []), 'on_demand_asr_suggested'],
      refinement: {
        kind: plan.kind,
        status: 'pending_confirmation',
        planHash: plan.planHash,
        videoKey: plan.videoKey,
        baseRevision: plan.baseRevision,
        windows: plan.windows,
        reasons: plan.reasons,
        estimatedBudget: plan.estimatedBudget,
        requires: plan.requires,
        executeVia: 'video_index({ action: "execute_refinement", planHash, confirmation: true })',
      },
    };
  }

  /**
   * 公开可确认入口：按 planHash 执行局部 ASR（monolithic 或 chunk catalog）。
   */
  async function executeRefinement({
    videoKey,
    planHash,
    confirmation = false,
    signal,
    analysisPolicy: rawPolicy = undefined,
  } = {}) {
    aborted(signal);
    if (!videoKey || !planHash) {
      return { ok: false, reason: 'missing_args' };
    }
    const memoKey = `${videoKey}::${planHash}`;
    if (refinementDone.has(memoKey)) {
      return { ok: true, already_executed: true, ...refinementDone.get(memoKey) };
    }
    const videoDir = store.exists(videoKey)
      ? store.activeVideoDir(videoKey)
      : store.videoDir(videoKey);
    const prior = loadRefinementExec(videoDir, planHash);
    // 仅当确实成功写入过才算 already_executed；registeredOnly / 仅落盘不算
    if (prior && prior.registeredOnly !== true && (prior.success === true || (prior.ok === true && prior.executed === true))) {
      refinementDone.set(memoKey, prior);
      return {
        ok: true,
        already_executed: true,
        ...prior,
      };
    }
    const plan = loadRefinementPlan(videoDir, planHash);
    if (!plan) return { ok: false, reason: 'plan_not_found', planHash };

    const chunkStore = createChunkStore({ rootDir, videoKey });
    const catalog = chunkStore.readCatalog({ optional: true });
    const monolithic = store.exists(videoKey) ? store.loadIndex(videoKey) : null;
    const policy = normalizeAnalysisPolicy(
      rawPolicy !== undefined
        ? rawPolicy
        : (monolithic?.effectivePolicy || { asr: { mode: 'on_demand' } }),
      { explicitPolicy: true },
    );
    if (policy.asr?.mode === 'off') {
      return { ok: false, reason: 'asr_off', asrCalls: 0 };
    }

    const sourceRef = readSourceRef(videoDir, { optional: true });
    const durationMs = monolithic?.metadata?.durationMs
      || catalog?.durationMs
      || sourceRef?.durationMs
      || 0;
    const currentRev = monolithic
      ? (monolithic.manifest?.counts?.evidence || 0)
      : (catalog?.revision || catalog?.chunks?.length || 1);
    try {
      assertPlanExecutable(plan, {
        videoKey,
        planHash,
        baseRevision: plan.baseRevision,
        policy,
        durationMs,
        confirmation: confirmation === true || confirmation?.planHash === planHash,
      });
    } catch (e) {
      return { ok: false, reason: e.code || 'PLAN', detail: e.message };
    }
    // baseRevision 漂移：拒绝（避免静默错写）
    if (Number(plan.baseRevision) !== Number(currentRev)
      && Math.abs(Number(plan.baseRevision) - Number(currentRev)) > 0) {
      // 允许 catalog revision 与 plan 同值；若完全对不上则拒绝
      if (monolithic && Number(plan.baseRevision) !== Number(currentRev)) {
        return { ok: false, reason: 'REVISION', detail: 'baseRevision changed' };
      }
    }

    const mediaPath = monolithic?.metadata?.path
      || catalog?.mediaPath
      || sourceRef?.mediaPath
      || null;
    if (!mediaPath || !existsSync(mediaPath)) {
      return { ok: false, reason: 'unavailable', detail: 'no_media' };
    }

    const beforeRevision = currentRev;
    const afterRevision = beforeRevision + 1;
    const tempDir = join(videoDir, 'tmp', 'on-demand-asr');
    const asrRun = await runOnDemandAsrWindows({
      videoKey,
      windows: plan.windows,
      mediaPath,
      asr,
      extractAudio,
      tempDir,
      policy,
      signal,
      revision: afterRevision,
      clock,
    });

    if (!asrRun.ok) {
      const failBody = {
        ok: false,
        reason: asrRun.reason,
        planHash,
        beforeRevision,
        afterRevision: beforeRevision,
        asrCalls: asrRun.asrCalls || 0,
        windows: plan.windows,
        reasons: plan.reasons,
        completedAt: clock(),
        success: false,
      };
      writeJsonAtomic(join(videoDir, 'refinements', `exec-${planHash}.json`), failBody);
      return failBody;
    }

    if (catalog?.chunks?.length) {
      // chunk catalog：按 utterance 中点归属，一次 ASR，不双写
      const chunks = catalog.chunks.map((c) => ({
        chunkId: c.chunkId,
        startMs: c.startMs,
        endMs: c.endMs,
      }));
      let tagged = asrRun.utterances.map((u) => {
        const owner = chunks.find((c) => ownsByMidpoint(u, c));
        return { ...u, chunkId: owner?.chunkId || chunks[0]?.chunkId || null };
      });
      tagged = dedupeUtterancesAcrossOverlap(tagged);
      const byChunk = new Map();
      for (const u of tagged) {
        if (!u.chunkId) continue;
        if (!byChunk.has(u.chunkId)) byChunk.set(u.chunkId, []);
        byChunk.get(u.chunkId).push(u);
      }
      const evidenceIds = [];
      for (const [cid, utts] of byChunk) {
        const existing = chunkStore.readChunk(cid, { optional: true });
        if (!existing) continue;
        const ev = asrRun.evidence.filter((e) => utts.some(
          (u) => u.startMs === e.startMs && u.endMs === e.endMs,
        ));
        const rev = (existing.manifest?.revision || 1) + 1;
        chunkStore.commitChunk(cid, {
          chunkManifest: {
            ...existing.manifest,
            revision: rev,
            status: existing.manifest?.status || 'ready',
          },
          utterances: [...(existing.utterances || []), ...utts],
          evidence: [...(existing.evidence || []), ...ev],
          events: existing.events || [],
          speakers: existing.speakers || [],
          storyboard: existing.storyboard || [],
          chapters: existing.chapters || [],
        });
        evidenceIds.push(...ev.map((e) => e.evidenceId));
      }
      try { chunkStore.rebuildCatalog(); } catch { /* ignore */ }
      // 使 query cache 失效：bump 通过新 revision 自然失效
      const okBody = {
        ok: true,
        executed: true,
        already_executed: false,
        planHash,
        beforeRevision,
        afterRevision,
        windows: plan.windows,
        reasons: plan.reasons,
        asrCalls: asrRun.asrCalls,
        evidenceIds,
        layout: 'chunk_catalog',
        completedAt: clock(),
        success: true,
      };
      writeJsonAtomic(join(videoDir, 'refinements', `exec-${planHash}.json`), okBody);
      refinementDone.set(memoKey, okBody);
      return okBody;
    }

    if (monolithic) {
      const nextUtterances = [...(monolithic.utterances || []), ...asrRun.utterances];
      const nextEvidence = [...(monolithic.evidenceIndex || []), ...asrRun.evidence];
      store.commit(videoKey, {
        ...monolithic,
        utterances: nextUtterances,
        evidenceIndex: nextEvidence,
        manifest: {
          ...monolithic.manifest,
          updatedAt: clock(),
          counts: {
            ...monolithic.manifest.counts,
            utterances: nextUtterances.length,
            evidence: nextEvidence.length,
          },
        },
      });
      const okBody = {
        ok: true,
        executed: true,
        already_executed: false,
        planHash,
        beforeRevision,
        afterRevision: nextEvidence.length,
        windows: plan.windows,
        reasons: plan.reasons,
        asrCalls: asrRun.asrCalls,
        evidenceIds: asrRun.evidence.map((e) => e.evidenceId),
        layout: 'monolithic',
        completedAt: clock(),
        success: true,
      };
      writeJsonAtomic(join(videoDir, 'refinements', `exec-${planHash}.json`), okBody);
      refinementDone.set(memoKey, okBody);
      return okBody;
    }

    return { ok: false, reason: 'no_index' };
  }

  /** @deprecated 内部兼容；Agent 应使用 execute_refinement */
  async function executeOnDemandAsr(opts = {}) {
    if (opts.planHash) {
      return executeRefinement({
        videoKey: opts.videoKey,
        planHash: opts.planHash,
        confirmation: true,
        signal: opts.signal,
        analysisPolicy: opts.analysisPolicy,
      });
    }
    // 无 planHash：生成计划并要求确认，不直接跑 ASR
    const plan = buildOnDemandAsrPlan({
      videoKey: opts.videoKey,
      question: opts.question || '',
      baseRevision: 1,
      durationMs: 0,
      policy: normalizeAnalysisPolicy(
        opts.analysisPolicy !== undefined ? opts.analysisPolicy : { asr: { mode: 'on_demand' } },
        { explicitPolicy: true },
      ),
      reasons: ['legacy_executeOnDemandAsr'],
    });
    try {
      saveRefinementPlan(store.videoDir(opts.videoKey), plan, { clock });
    } catch { /* ignore */ }
    return {
      ok: false,
      reason: 'confirmation_required',
      refinement: {
        ...plan,
        status: 'pending_confirmation',
        executeVia: 'video_index({ action: "execute_refinement", planHash, confirmation: true })',
      },
    };
  }

  function query(request = {}) {
    const {
      videoKey,
      question = '',
      mode = 'auto',
      budget = {},
      signal,
      analysisPolicy: rawQueryPolicy = undefined,
    } = request;
    aborted(signal);

    // 两级检索：优先 chunk catalog（长视频）
    const chunkStore = createChunkStore({ rootDir, videoKey });
    const catalog = chunkStore.readCatalog({ optional: true });
    if (catalog?.chunks?.length) {
      const routed = routeQuery({ question, mode });
      const limits = mergeBudget(budget);
      const selected = selectChunksFromCatalog(catalog, {
        question,
        queryType: routed.queryType,
        topK: Math.min(3, Number(limits.maxChunks) || 3),
        overviewMaxChunks: Math.min(
          24,
          Number(budget.maxOverviewChunks) || Number(limits.maxOverviewChunks) || 12,
        ),
      });
      const loaded = [];
      for (const id of selected.chunkIds) {
        const c = chunkStore.readChunk(id, { optional: true });
        if (c) loaded.push(c);
      }
      const merged = mergeChunkViews(loaded);
      const speakerMap = readSpeakerMap(store.videoDir(videoKey));
      if (speakerMap?.speakers) {
        const map = speakerMap.speakers;
        const remapId = (id) => (id && map[id]?.globalSpeakerId) || id;
        merged.speakers = (merged.speakers || []).map((s) => {
          const gid = remapId(s.speakerClusterId);
          if (!gid || gid === s.speakerClusterId) return s;
          return {
            ...s,
            localSpeakerId: s.speakerClusterId,
            speakerClusterId: gid,
            bindingState: map[s.speakerClusterId]?.state || s.bindingState,
          };
        });
        merged.utterances = (merged.utterances || []).map((u) => {
          const gid = remapId(u.speakerClusterId);
          if (!gid || gid === u.speakerClusterId) return u;
          return { ...u, localSpeakerId: u.speakerClusterId, speakerClusterId: gid };
        });
      }
      const retrieval = retrieve(merged, {
        question,
        queryType: routed.queryType,
        maxUtterances: limits.maxUtterances,
      });
      const revHash = chunkSetHash(loaded.map((c) => ({
        chunkId: c.chunkId,
        revision: c.manifest?.revision,
      })));
      const key = cacheKeyOf({
        videoKey,
        indexVersion: catalog.layoutVersion || LAYOUT_VERSION,
        layoutVersion: LAYOUT_VERSION,
        chunkRevisionHash: revHash,
        queryType: routed.queryType,
        question,
        budget: limits,
        relevantEvidenceIds: retrieval.evidenceIds,
        retrievalVersion: RETRIEVAL_VERSION,
      });
      const cached = cache.get(videoKey, key, { indexVersion: catalog.layoutVersion || LAYOUT_VERSION });
      if (cached.hit) {
        return { ...cached.value, cache: { hit: true, key }, chunksLoaded: selected.chunkIds };
      }
      const chunkStoryboardCap = loaded.length
        && loaded.every((c) => c.manifest?.capabilities?.storyboard === 'skipped')
        ? 'skipped'
        : null;
      const built = buildContext({
        retrieval,
        queryType: routed.queryType,
        question,
        budget: limits,
        audioIndex: (merged.speakers || []).map((s) => ({ kind: 'speaker', ...s })),
        entityOverview: [],
        storyboardCapability: chunkStoryboardCap,
      });
      // citation 补 chunkId/revision/timeSource
      const citations = (built.citations || []).map((c) => {
        const hit = loaded.find((ch) => (ch.utterances || []).some((u) => u.evidenceId === c.evidenceId)
          || (ch.evidence || []).some((e) => e.evidenceId === c.evidenceId));
        return {
          ...c,
          chunkId: c.chunkId || hit?.chunkId || null,
          revision: c.revision || hit?.manifest?.revision || null,
          timeSource: c.timeSource || hit?.manifest?.timeSource || null,
        };
      });
      let result = {
        ok: true,
        queryType: routed.queryType,
        decision: built.decision,
        judgementState: built.judgementState,
        reasons: [...routed.reasons, ...built.reasons, 'chunk_catalog_retrieval'],
        context: built.context,
        visualEvidence: built.visualEvidence,
        citations,
        budget: built.budget,
        cache: { hit: false, key },
        chunksLoaded: selected.chunkIds,
        selectionMode: selected.mode || null,
        layoutVersion: LAYOUT_VERSION,
      };
      const policyForAsr = normalizeAnalysisPolicy(
        rawQueryPolicy !== undefined ? rawQueryPolicy : null,
        { explicitPolicy: rawQueryPolicy !== undefined },
      );
      result = attachOnDemandHint(result, {
        question,
        retrieval,
        coverage: catalog.coverage || null,
        policy: policyForAsr,
        durationMs: catalog.durationMs || 0,
        videoKey,
      });
      cache.set(videoKey, key, result, { indexVersion: catalog.layoutVersion || LAYOUT_VERSION });
      return result;
    }

    if (!store.exists(videoKey)) {
      return {
        ok: false,
        reason: 'not-found',
        queryType: null,
        decision: 'insufficient',
        reasons: ['index_not_found'],
        context: { metadata: {}, chapters: [], events: [], utterances: [], speakers: [], persons: [] },
        visualEvidence: [],
        citations: [],
        budget: { requested: mergeBudget(budget), used: {}, estimated: true, truncated: false, omittedEvidenceIds: [] },
        cache: { hit: false, key: null },
      };
    }

    const indexData = store.loadIndex(videoKey);
    const routed = routeQuery({ question, mode });
    const limits = mergeBudget(budget);

    // Cognition：用户提问才进 llm 路径
    const cog = evaluateCognition({
      trigger: 'user_question',
      hasUserQuestion: Boolean(question),
      indexCanAnswer: false,
    });

    const retrieval = retrieve(indexData, {
      question,
      queryType: routed.queryType,
      maxUtterances: limits.maxUtterances,
    });

    const key = cacheKeyOf({
      videoKey,
      indexVersion: indexData.manifest.indexVersion,
      queryType: routed.queryType,
      question,
      budget: limits,
      relevantEvidenceIds: retrieval.evidenceIds,
      retrievalVersion: RETRIEVAL_VERSION,
    });

    const cached = cache.get(videoKey, key, { indexVersion: indexData.manifest.indexVersion });
    if (cached.hit) {
      return { ...cached.value, cache: { hit: true, key } };
    }

    const built = buildContext({
      retrieval,
      queryType: routed.queryType,
      question,
      budget: limits,
      audioIndex: indexData.audioIndex || [],
      entityOverview: indexData.entityOverview || [],
      storyboardCapability: indexData.manifest?.capabilities?.storyboard || null,
    });

    let result = {
      ok: true,
      queryType: routed.queryType,
      decision: built.decision === 'insufficient' ? 'insufficient' : (cog.decision === 'local' && !question ? 'local' : built.decision),
      judgementState: built.decision === 'insufficient' ? 'insufficient' : built.judgementState,
      reasons: [...routed.reasons, ...built.reasons, ...cog.reasons],
      context: built.context,
      visualEvidence: built.visualEvidence,
      citations: built.citations,
      budget: built.budget,
      cache: { hit: false, key },
      cognition: cog,
    };

    const syncPolicy = normalizeAnalysisPolicy(
      rawQueryPolicy !== undefined
        ? rawQueryPolicy
        : (indexData.effectivePolicy || null),
      {
        explicitPolicy: rawQueryPolicy !== undefined || Boolean(indexData.effectivePolicy),
      },
    );
    result = attachOnDemandHint(result, {
      question,
      retrieval,
      coverage: indexData.coverage || null,
      policy: syncPolicy,
      durationMs: indexData.metadata?.durationMs || 0,
      videoKey,
    });

    cache.set(videoKey, key, result, { indexVersion: indexData.manifest.indexVersion });
    return result;
  }

  /**
   * 统一加载可查询视图：优先 monolithic，否则合并 chunk catalog。
   * evidence / zoom / package 必须走这里，不能只查 store.exists。
   */
  function loadQueryableIndex(videoKey, {
    startMs = null,
    endMs = null,
    chunkIds = null,
  } = {}) {
    if (store.exists(videoKey)) {
      return {
        ok: true,
        layout: 'monolithic',
        index: store.loadIndex(videoKey),
        chunkStore: null,
        sourceRef: readSourceRef(store.videoDir(videoKey), { optional: true }),
      };
    }
    const chunkStore = createChunkStore({ rootDir, videoKey });
    const catalog = chunkStore.readCatalog({ optional: true });
    if (!catalog?.chunks?.length) {
      return { ok: false, reason: 'not-found', layout: null, index: null };
    }
    let ids = Array.isArray(chunkIds) && chunkIds.length
      ? chunkIds
      : catalog.chunks.map((c) => c.chunkId);
    if (startMs != null || endMs != null) {
      const a = startMs == null ? -Infinity : Number(startMs);
      const b = endMs == null ? Infinity : Number(endMs);
      ids = catalog.chunks
        .filter((c) => Number(c.endMs) > a && Number(c.startMs) < b)
        .map((c) => c.chunkId);
      if (!ids.length) ids = catalog.chunks.map((c) => c.chunkId);
    }
    const loaded = [];
    for (const id of ids) {
      const c = chunkStore.readChunk(id, { optional: true });
      if (c) loaded.push(c);
    }
    if (!loaded.length) {
      return { ok: false, reason: 'not-found', layout: 'chunk_catalog', index: null };
    }
    const merged = mergeChunkViews(loaded);
    const sourceRef = readSourceRef(chunkStore.videoDir, { optional: true });
    const durationMs = sourceRef?.durationMs
      || Math.max(...catalog.chunks.map((c) => Number(c.endMs) || 0), 0);
    return {
      ok: true,
      layout: 'chunk_catalog',
      index: {
        ...merged,
        metadata: {
          ...(merged.metadata || {}),
          path: sourceRef?.mediaPath || null,
          durationMs,
        },
        manifest: {
          status: 'ready',
          layoutVersion: catalog.layoutVersion || LAYOUT_VERSION,
          indexVersion: catalog.layoutVersion || LAYOUT_VERSION,
          updatedAt: catalog.updatedAt || null,
          counts: {
            chunks: catalog.chunks.length,
            evidence: (merged.evidenceIndex || []).length,
            utterances: (merged.utterances || []).length,
          },
        },
        effectivePolicy: null,
        coverage: null,
      },
      chunkStore,
      catalog,
      loadedChunks: loaded,
      sourceRef,
    };
  }

  function getEvidence(request = {}) {
    const { videoKey, evidenceIds = [], startMs, endMs } = request;
    const view = loadQueryableIndex(videoKey, { startMs, endMs });
    if (!view.ok) return { ok: false, reason: 'not-found', evidence: [], layout: null };
    const idSet = evidenceIds.length ? new Set(evidenceIds) : null;
    let list = view.index.evidenceIndex || [];
    if (idSet) list = list.filter((e) => idSet.has(e.evidenceId));
    if (startMs != null) list = list.filter((e) => e.endMs >= startMs);
    if (endMs != null) list = list.filter((e) => e.startMs <= endMs);
    // 路径安全：只返回索引内引用（chunk 与 monolithic 共用 videoDir）
    for (const e of list) {
      if (e.sourceFile) {
        try { store.resolveEvidenceFile(videoKey, e.sourceFile); } catch { /* skip unsafe */ }
      }
    }
    return {
      ok: true,
      videoKey,
      evidence: list,
      layout: view.layout,
    };
  }

  async function zoom(request = {}) {
    const {
      videoKey, startMs, endMs, roi = null, signal, budget = {},
    } = request;
    aborted(signal);
    const limits = mergeBudget(budget);
    const view = loadQueryableIndex(videoKey, { startMs, endMs });
    if (!view.ok) return { ok: false, reason: 'not-found' };
    const indexData = view.index;
    // 先检查已有 storyboard
    const existing = (indexData.storyboardIndex || []).filter((s) => {
      const t = s.timestampMs;
      return t >= startMs && t <= endMs;
    });
    if (existing.length) {
      return {
        ok: true,
        zoom: false,
        reused: true,
        units: existing.slice(0, limits.maxStoryboardUnits),
        zoomRequests: 0,
        layout: view.layout,
      };
    }
    // 受 maxZoomRequests 限制；此处单次 zoom = 1
    if (limits.maxZoomRequests < 1) {
      return { ok: false, reason: 'zoom_budget_exhausted', zoomRequests: 0 };
    }
    const meta = indexData.metadata || {};
    const path = meta.path || view.sourceRef?.mediaPath || null;
    if (!path) {
      return { ok: false, reason: 'no_media', detail: 'cannot zoom without local media path' };
    }
    const tSec = (startMs + (endMs || startMs)) / 2000;
    const frames = await extractFrames({
      path,
      ffmpegPath,
      width: 800,
      height: 450,
      fps: 1,
      signal,
      maxFrames: 1,
      seekSec: tSec,
    });
    if (!frames.length) return { ok: false, reason: 'no_frame' };
    const fr = frames[0];
    const png = encodePng(fr.buf, 800, 450, { level: 3 });
    const timestampMs = Number.isFinite(fr.timestampMs)
      ? Math.round(fr.timestampMs)
      : Math.round((Number(fr.t) || tSec) * 1000);
    const ch = contentHash(png);
    const fid = frameIdOf({
      videoKey,
      timestampMs,
      roi: roi || { x: 0, y: 0, width: 800, height: 450 },
      contentHash: ch,
    });
    const eid = evidenceIdOf({
      videoKey, kind: 'frame', startMs: timestampMs, endMs: timestampMs, contentHash: ch,
    });
    const sourceFile = `evidence/frames/${fid}.png`;
    store.writeBinary(videoKey, sourceFile, png);
    const unit = {
      frameId: fid,
      timestampMs,
      imageRef: evidenceLogicalRef(videoKey, 'frame', fid),
      sceneId: `SCENE_zoom_${timestampMs}`,
      sourceSize: { width: 800, height: 450 },
      storedSize: { width: 800, height: 450 },
      roi: roi || { x: 0, y: 0, width: 800, height: 450 },
      transform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
      selectionReasons: ['manual_request', 'zoom'],
      evidenceIds: [eid],
      chunkId: null,
    };
    const frameEvidence = {
      evidenceId: eid,
      kind: 'frame',
      startMs: timestampMs,
      endMs: timestampMs,
      ref: unit.imageRef,
      sourceFile,
      contentHash: ch,
      provenance: { adapter: 'zoom', version: '1', generatedAt: clock() },
    };

    // chunk catalog：写入时间中点所属 chunk，递增 revision，重建 catalog
    if (view.layout === 'chunk_catalog' && view.chunkStore) {
      const mid = timestampMs;
      const owner = (view.catalog?.chunks || []).find(
        (c) => mid >= Number(c.startMs) && mid < Number(c.endMs),
      ) || (view.catalog?.chunks || [])[0];
      if (!owner) {
        return { ok: false, reason: 'no_chunk', detail: 'catalog empty' };
      }
      const existingChunk = view.chunkStore.readChunk(owner.chunkId, { optional: true });
      if (!existingChunk) {
        return { ok: false, reason: 'chunk_missing', chunkId: owner.chunkId };
      }
      unit.chunkId = owner.chunkId;
      frameEvidence.chunkId = owner.chunkId;
      const rev = (existingChunk.manifest?.revision || 1) + 1;
      view.chunkStore.commitChunk(owner.chunkId, {
        chunkManifest: {
          ...existingChunk.manifest,
          revision: rev,
          status: existingChunk.manifest?.status || 'ready',
        },
        utterances: existingChunk.utterances || [],
        events: existingChunk.events || [],
        speakers: existingChunk.speakers || [],
        storyboard: [...(existingChunk.storyboard || []), unit],
        evidence: [...(existingChunk.evidence || []), frameEvidence],
        chapters: existingChunk.chapters || [],
      });
      try { view.chunkStore.rebuildCatalog(); } catch { /* ignore */ }
      return {
        ok: true,
        zoom: true,
        reused: false,
        units: [unit],
        zoomRequests: 1,
        layout: 'chunk_catalog',
        chunkId: owner.chunkId,
      };
    }

    // monolithic：追加到全局索引
    const storyboardIndex = [...(indexData.storyboardIndex || []), unit];
    const evidenceIndex = [...(indexData.evidenceIndex || []), frameEvidence];
    const newVersion = indexVersionOf({
      prev: indexData.manifest.indexVersion,
      zoom: eid,
    });
    const manifest = {
      ...indexData.manifest,
      indexVersion: newVersion,
      updatedAt: clock(),
      counts: {
        ...indexData.manifest.counts,
        storyboardUnits: storyboardIndex.length,
        evidence: evidenceIndex.length,
      },
    };
    store.commit(videoKey, {
      manifest,
      metadata: indexData.metadata,
      chapters: indexData.chapters,
      topics: indexData.topics,
      entityOverview: indexData.entityOverview,
      keyMoments: indexData.keyMoments,
      timeline: indexData.timeline,
      utterances: indexData.utterances,
      events: indexData.events,
      subtitles: indexData.subtitles,
      entityTracks: indexData.entityTracks,
      evidenceIndex,
      storyboardIndex,
      audioIndex: indexData.audioIndex,
    });
    return {
      ok: true, zoom: true, reused: false, units: [unit], zoomRequests: 1, layout: 'monolithic',
    };
  }

  function chunkCatalogOf(videoKey) {
    try {
      return createChunkStore({ rootDir, videoKey }).readCatalog({ optional: true });
    } catch {
      return null;
    }
  }

  function status(videoKey) {
    const legacy = store.status(videoKey);
    if (legacy?.ok) return legacy;
    const catalog = chunkCatalogOf(videoKey);
    if (catalog?.chunks?.length) {
      const ready = catalog.chunks.filter((c) => c.status === 'ready').length;
      const degraded = catalog.chunks.filter((c) => c.status === 'degraded').length;
      return {
        ok: true,
        videoKey,
        status: ready === catalog.chunks.length ? 'ready' : (degraded ? 'degraded' : 'building'),
        layoutVersion: catalog.layoutVersion,
        counts: {
          chunks: catalog.chunks.length,
          readyChunks: ready,
          degradedChunks: degraded,
        },
        updatedAt: catalog.updatedAt || null,
      };
    }
    return legacy;
  }

  function list() {
    const out = store.list();
    const seen = new Set(out.map((x) => x.videoKey));
    try {
      for (const name of readdirSync(rootDir)) {
        let key;
        try { key = decodeVideoKeyDir(name); } catch { continue; }
        if (seen.has(key)) continue;
        const catalog = chunkCatalogOf(key);
        if (!catalog?.chunks?.length) continue;
        const ready = catalog.chunks.filter((c) => c.status === 'ready').length;
        const degraded = catalog.chunks.filter((c) => c.status === 'degraded').length;
        out.push({
          videoKey: key,
          status: ready === catalog.chunks.length ? 'ready' : (degraded ? 'degraded' : 'building'),
          updatedAt: catalog.updatedAt || null,
          layoutVersion: catalog.layoutVersion,
          counts: { chunks: catalog.chunks.length, readyChunks: ready, degradedChunks: degraded },
          manifest: null,
        });
        seen.add(key);
      }
    } catch { /* ignore */ }
    return out;
  }

  function remove(videoKey) {
    try {
      clearPrivateEmbeddings(store.videoDir(videoKey));
    } catch { /* ignore */ }
    return store.remove(videoKey);
  }

  function cleanup(options = {}) {
    return cleanupIndexes({ store, jobsRoot: join(rootDir, '.jobs'), ...options });
  }

  async function startBackgroundIndex(input = {}) {
    return jobs.startIndexJob(input);
  }

  /**
   * 长视频入口：file / bilibili URL → 后台分块 job。
   * descriptor 仅内存传递，不进入返回值。
   */
  async function startLongIndex({
    source,
    durationMs = null,
    execution = 'auto',
    capabilities = {},
    videoKey = null,
    mediaPath = null,
    signal,
    speakerMerge: mergeOpts = null,
    indexOptions = {},
    analysisPolicy = undefined,
  } = {}) {
    aborted(signal);
    const prepared = await prepareSourceForIndex({
      source, durationMs, videoKey, mediaPath, signal,
    });
    const sourceDescriptor = attachIndexOptionsToDescriptor(
      {
        ...(prepared.sourceDescriptor || {}),
        durationMs: prepared.durationMs,
      },
      indexOptions,
    );
    const r = await jobs.startIndexJob({
      videoKey: prepared.videoKey,
      durationMs: prepared.durationMs,
      sourceMode: prepared.sourceMode,
      sourceDescriptor,
      capabilities,
      execution,
      speakerMerge: mergeOpts || capabilities?.speakerMerge || null,
      analysisPolicy,
    });
    return sanitizePublicJobResult({
      ...r,
      durationMs: prepared.durationMs,
      durationWarning: prepared.durationWarning || null,
      hasSubtitlePath: Boolean(sourceDescriptor.subtitlePath),
    });
  }

  /**
   * 解析来源 + 探测时长 + 选择 sync/background（只 resolve 一次）。
   */
  async function prepareSourceForIndex({
    source, durationMs = null, videoKey = null, mediaPath = null, signal,
  } = {}) {
    const kind = String(source?.kind || 'file').toLowerCase();
    let sourceDescriptor = null;
    let key = videoKey;
    let probed = null;
    let mode = 'file';
    let durationWarning = null;

    if (kind === 'bilibili') {
      mode = 'url';
      sourceDescriptor = await bilibiliSource.resolveStreams(source, { signal });
      key = key || videoKeyOf({
        kind: 'bilibili',
        url: sourceDescriptor.webpageUrl,
        bvid: sourceDescriptor.bvid,
        partId: sourceDescriptor.partId,
      });
      probed = sourceDescriptor.durationMs;
    } else {
      mode = 'file';
      const resolved = await fileSource.resolve(source, { signal });
      key = key || resolved.videoKey;
      const path = mediaPath || resolved.mediaRef?.path || resolved.metadata?.path || source.path;
      probed = resolved.metadata?.durationMs;
      if (!Number.isFinite(Number(probed)) || Number(probed) <= 0) {
        probed = await probeMediaDurationMs(path, { signal, ffmpegPath, runner: adapters.ffprobe || null });
      }
      sourceDescriptor = {
        mediaPath: path,
        subtitles: resolved.subtitles || [],
      };
    }

    const hint = Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
      ? Number(durationMs)
      : null;
    let dur = probed;
    if (hint != null && probed != null && Math.abs(hint - probed) > Math.max(60_000, probed * 0.1)) {
      durationWarning = 'duration_hint_mismatch_using_probed';
      dur = probed;
    } else if (hint != null && (dur == null || !Number.isFinite(dur))) {
      dur = hint;
    } else if (hint != null && probed == null) {
      dur = hint;
    }

    if (!Number.isFinite(Number(dur)) || Number(dur) <= 0) {
      const err = new Error('unable to determine media duration');
      err.code = 'DURATION_UNKNOWN';
      throw err;
    }
    return {
      videoKey: key,
      durationMs: Number(dur),
      sourceMode: mode,
      sourceDescriptor,
      durationWarning,
      kind,
    };
  }

  /**
   * 统一入口：auto 探测时长后选择同步短路径或后台分块。
   */
  async function indexAdaptive({
    source,
    execution = 'auto',
    durationMs = null,
    capabilities = {},
    videoKey = null,
    mediaPath = null,
    signal,
    indexOptions = {},
    speakerMerge: mergeOpts = null,
    analysisPolicy = undefined,
  } = {}) {
    aborted(signal);
    const exec = String(execution || 'auto').toLowerCase();
    const prepared = await prepareSourceForIndex({
      source, durationMs, videoKey, mediaPath, signal,
    });
    const policyArg = analysisPolicy !== undefined
      ? analysisPolicy
      : indexOptions.analysisPolicy;

    const needBg = exec === 'background'
      || (exec === 'auto' && jobs.estimateNeedsBackground(prepared.durationMs, 'auto'));

    // URL 已持有内存 descriptor：后台或同步分块都走 startIndexJob，避免二次 resolveStreams
    if (needBg || exec === 'background' || prepared.sourceMode === 'url' || exec === 'sync') {
      // 外挂字幕等 indexOptions 必须并入 descriptor，否则后台 chunk 拿不到 subtitlePath
      const sourceDescriptor = attachIndexOptionsToDescriptor(
        {
          ...(prepared.sourceDescriptor || {}),
          durationMs: prepared.durationMs,
        },
        indexOptions,
      );
      const r = await jobs.startIndexJob({
        videoKey: prepared.videoKey,
        durationMs: prepared.durationMs,
        sourceMode: prepared.sourceMode,
        sourceDescriptor,
        capabilities,
        execution: needBg || exec === 'background' ? 'background' : 'sync',
        speakerMerge: mergeOpts || capabilities?.speakerMerge || null,
        analysisPolicy: policyArg,
      });
      return sanitizePublicJobResult({
        ...r,
        adaptive: true,
        durationMs: prepared.durationMs,
        durationWarning: prepared.durationWarning,
        hasSubtitlePath: Boolean(sourceDescriptor.subtitlePath),
      });
    }

    // 短本地文件：旧同步整片路径（兼容既有 short-file 测试）
    const r = await index({ source }, {
      ...indexOptions,
      signal,
      capabilities,
      analysisPolicy: policyArg,
    });
    return {
      ok: true,
      background: false,
      adaptive: true,
      sync: true,
      durationMs: prepared.durationMs,
      durationWarning: prepared.durationWarning,
      ...r,
    };
  }

  function sanitizePublicJobResult(r) {
    if (!r || typeof r !== 'object') return r;
    const {
      // eslint-disable-next-line no-unused-vars
      sourceDescriptor, descriptor, audio, video, cookie, cookies, token, ...safe
    } = r;
    return safe;
  }

  function jobStatus(jobId) {
    return jobs.jobStatus(jobId);
  }

  async function jobCancel(jobId) {
    const check = jobs.jobs.validateJobId(jobId);
    if (!check.ok) return { ok: false, reason: 'invalid_job_id' };
    const job = jobs.jobs.readJob(check.jobId, { optional: true });
    if (!job) return { ok: false, reason: 'not-found' };

    const controllers = jobs._captureControllers || new Map();
    const controller = controllers.get(check.jobId);
    if (controller) {
      // 先持久化 cancelRequested，再停外部进程
      jobs.jobs.updateJob(check.jobId, {
        cancelRequested: true,
        cancelRequestedAt: new Date().toISOString(),
        state: 'cancelled',
        stage: 'cancelled',
      }, { forceCancelled: true });
      try {
        await controller.requestCancel();
      } catch { /* ignore */ }
      controllers.delete(check.jobId);
      const nonce = job.lockNonce || null;
      try {
        jobs.jobs.releaseLock(job.videoKey, { nonce });
      } catch { /* ignore */ }
      const next = jobs.jobs.readJob(check.jobId, { optional: true });
      return { ok: true, job: next, captureStopped: true };
    }
    return jobs.jobCancel(check.jobId);
  }

  async function jobResume(jobId) {
    return jobs.jobResume(jobId);
  }

  function allocateNextChunkId(videoKey) {
    const cstore = createChunkStore({ rootDir, videoKey });
    const ids = cstore.listReadyChunkIds().map(Number).filter(Number.isFinite);
    let n = ids.length ? Math.max(...ids) + 1 : 0;
    let id = String(n).padStart(6, '0');
    while (cstore.readChunk(id, { optional: true })) {
      n += 1;
      id = String(n).padStart(6, '0');
      if (n > 999999) break;
    }
    return id;
  }

  async function captureStart(opts = {}) {
    if (!opts.region) {
      return { ok: false, reason: 'REGION', detail: 'manual region required for capture MVP' };
    }
    const videoKey = opts.videoKey || `capture:${Date.now().toString(36)}`;
    const lock = jobs.jobs.acquireLock(videoKey, { jobId: 'pending' });
    if (!lock.ok) {
      return { ok: false, reason: 'locked', detail: lock.detail || 'videoKey write locked' };
    }
    const lockNonce = lock.lock?.nonce || null;
    const job = jobs.jobs.createJob({
      videoKey,
      sourceMode: 'capture',
      execution: 'background',
      state: 'starting',
      stage: 'starting',
      attempt: 1,
      lockNonce,
      cancelRequested: false,
    });
    // 保持原锁，只原子更新 jobId（禁止 release→reacquire 竞态窗口）
    const updated = jobs.jobs.updateLockJobId(videoKey, {
      nonce: lockNonce,
      jobId: job.jobId,
    });
    if (!updated.ok) {
      try { jobs.jobs.releaseLock(videoKey, { nonce: lockNonce }); } catch { /* ignore */ }
      jobs.jobs.updateJob(job.jobId, {
        state: 'failed',
        error: { code: 'lock_update', message: updated.reason },
      });
      return { ok: false, reason: 'locked', detail: updated.reason, jobId: job.jobId };
    }
    jobs.jobs.updateJob(job.jobId, { lockNonce, attempt: 1 });

    const recorder = adapters.loopbackRecorder || createLoopbackRecorderAdapter();
    const frameSource = adapters.captureFrameSource
      || createScreenFrameSource({ ffmpegPath });
    const attempt = 1;

    const mayContinue = () => {
      try {
        return jobs.assertJobMayContinue(job.jobId, null, attempt);
      } catch {
        return false;
      }
    };

    const controller = createCaptureController({
      rootDir,
      videoKey,
      jobId: job.jobId,
      attempt,
      url: opts.url || null,
      region: opts.region,
      cdpEndpoint: opts.cdpEndpoint || null,
      cdpTransport: adapters.cdpTransport || (opts.cdpEndpoint ? createWebSocketCdpTransport() : null),
      captureCapabilities: opts.capabilities || {},
      captureSpeakerMerge: opts.speakerMerge || null,
      recorder,
      frameSource,
      scheduler: adapters.captureScheduler || undefined,
      clock: () => Date.now(),
      log,
      mayContinue,
      allocateChunkId: async () => allocateNextChunkId(videoKey),
      commitCaptureChunk: async (args) => {
        if (!mayContinue()) return null;
        let id = args.chunk?.chunkId;
        if (!id || !/^\d{6}$/.test(id)) id = allocateNextChunkId(videoKey);
        const out = await indexChunk({
          ...args,
          chunk: { ...args.chunk, chunkId: id },
          mediaPath: null,
        });
        if (!mayContinue()) return null;
        const cstore = createChunkStore({ rootDir, videoKey });
        const startMs = out.resolvedChunk?.startMs ?? args.chunk.startMs;
        const endMs = out.resolvedChunk?.endMs ?? args.chunk.endMs;
        cstore.commitChunk(id, {
          chunkManifest: {
            chunkId: id,
            revision: 1,
            startMs,
            endMs,
            inputStartMs: startMs,
            inputEndMs: endMs,
            status: out.degraded ? 'degraded' : 'ready',
            sourceMode: 'capture',
            timeSource: out.timeSource || 'wallclock',
            discontinuity: Boolean(out.gaps?.length),
            gaps: out.gaps || [],
            capabilities: out.capabilities || {},
            counts: { utterances: (out.utterances || []).length },
            byteUsage: out.byteUsage || { downloaded: 0, temporaryPeak: 0, outputBytes: 0 },
            provenance: out.provenance,
            error: out.error,
          },
          utterances: out.utterances || [],
          events: out.events || [],
          speakers: out.speakers || [],
          storyboard: out.storyboard || [],
          evidence: out.evidence || [],
          chapters: out.chapters || [],
        });
        if (!mayContinue()) return null;
        cstore.rebuildCatalog();
        return { chunkId: id, ...out };
      },
    });
    const started = await controller.start();
    if (!started.ok) {
      jobs.jobs.updateJob(job.jobId, {
        state: 'failed',
        stage: 'failed',
        error: { code: started.reason, message: started.detail },
      }, { forceCancelled: false });
      try { jobs.jobs.releaseLock(videoKey, { nonce: lockNonce }); } catch { /* ignore */ }
      return {
        ok: false,
        reason: started.reason,
        detail: started.detail,
        capabilities: started.capabilities,
        jobId: job.jobId,
      };
    }
    jobs.jobs.updateJob(job.jobId, {
      state: 'capturing',
      stage: 'capturing',
      captureSessionId: started.sessionId,
      audioScope: started.audioScope,
      capabilities: started.capabilities,
      lockNonce,
      attempt: 1,
    });
    jobs._captureControllers = jobs._captureControllers || new Map();
    jobs._captureControllers.set(job.jobId, controller);
    return {
      ok: true,
      jobId: job.jobId,
      videoKey,
      sessionId: started.sessionId,
      sourceMode: started.sourceMode,
      audioScope: started.audioScope,
      capabilities: started.capabilities,
    };
  }

  async function captureStop(jobId) {
    const check = jobs.jobs.validateJobId(jobId);
    if (!check.ok) return { ok: false, reason: 'invalid_job_id' };
    const job = jobs.jobs.readJob(check.jobId, { optional: true });
    if (!job) return { ok: false, reason: 'not-found' };

    const controller = jobs._captureControllers?.get(check.jobId);
    if (!controller) {
      if (job.state === 'cancelled' || job.cancelRequested) {
        return { ok: true, jobId: check.jobId, state: 'cancelled', idempotent: true, catalogChunks: 0 };
      }
      return { ok: false, reason: 'not-found' };
    }

    // cancelled job：幂等清理，不得以 cancel:false 再 flush
    if (job.cancelRequested || job.state === 'cancelled' || controller.cancelRequested) {
      try { await controller.requestCancel(); } catch { /* ignore */ }
      jobs._captureControllers.delete(check.jobId);
      try {
        jobs.jobs.releaseLock(job.videoKey, { nonce: job.lockNonce });
      } catch { /* ignore */ }
      jobs.jobs.updateJob(check.jobId, {
        state: 'cancelled',
        stage: 'cancelled',
      }, { forceCancelled: true });
      return {
        ok: true,
        jobId: check.jobId,
        state: 'cancelled',
        idempotent: true,
        catalogChunks: 0,
      };
    }

    jobs.jobs.updateJob(check.jobId, { state: 'flushing', stage: 'flushing' });
    const stopped = await controller.stop({ cancel: false });
    jobs.jobs.updateJob(check.jobId, { state: 'indexing', stage: 'indexing' });
    const cstore = createChunkStore({
      rootDir,
      videoKey: job.videoKey,
    });
    let catalog = [];
    try { catalog = cstore.rebuildCatalog(); } catch { /* ignore */ }
    const finalState = stopped.cancelled
      ? 'cancelled'
      : ((stopped.gaps?.length || stopped.capabilities?.cdp === 'degraded') ? 'degraded' : 'ready');
    jobs.jobs.updateJob(check.jobId, {
      state: finalState,
      stage: finalState,
      gaps: stopped.gaps,
      progress: {
        readyChunks: catalog.length,
        currentStage: finalState,
      },
      captureStats: stopped.stats,
    }, finalState === 'cancelled' ? { forceCancelled: true } : {});
    jobs._captureControllers.delete(check.jobId);
    try {
      jobs.jobs.releaseLock(job.videoKey, { nonce: job.lockNonce });
    } catch { /* ignore */ }
    return {
      ok: true,
      jobId: check.jobId,
      state: finalState,
      capabilities: stopped.capabilities,
      stats: stopped.stats,
      catalogChunks: catalog.length,
      gaps: stopped.gaps,
    };
  }

  async function refine({
    videoKey,
    url = null,
    partId = 'p1',
    signal,
    analysisPolicy: rawPolicy = undefined,
    confirmation = null,
    retryPlan = null,
  } = {}) {
    // 二次分析确认：ask/auto_once 守卫（无 URL 时也可仅确认计划）
    if (confirmation?.planHash || retryPlan) {
      const view = loadQueryableIndex(videoKey);
      if (!view.ok && !store.exists(videoKey)) {
        return { ok: false, reason: 'not-found' };
      }
      let existing = null;
      try {
        if (store.exists(videoKey)) existing = store.loadIndex(videoKey);
      } catch { existing = null; }
      const policy = normalizeAnalysisPolicy(
        rawPolicy !== undefined
          ? rawPolicy
          : (existing?.effectivePolicy || {}),
        { explicitPolicy: true },
      );
      const audit = existing?.audit || (retryPlan ? { retryPlan, planHash: confirmation?.planHash } : null);
      const priorPath = join(
        store.exists(videoKey) ? store.activeVideoDir(videoKey) : store.videoDir(videoKey),
        'refinements',
      );
      let priorAutoOnceDone = false;
      try {
        if (existsSync(priorPath)) {
          for (const name of readdirSync(priorPath)) {
            if (!name.startsWith('exec-') || !name.endsWith('.json')) continue;
            const body = JSON.parse(readFileSync(join(priorPath, name), 'utf8'));
            if (body.autoOnceDone || body.success === true) priorAutoOnceDone = true;
          }
        }
      } catch { /* ignore */ }
      const decision = decideSecondPass({
        policy: {
          ...policy,
          secondPass: {
            ...(policy.secondPass || {}),
            mode: confirmation?.planHash ? 'ask' : (policy.secondPass?.mode || 'off'),
          },
          postAnalysisAudit: {
            ...(policy.postAnalysisAudit || {}),
            enabled: true,
            retryMode: confirmation?.planHash
              ? 'ask'
              : (policy.postAnalysisAudit?.retryMode || policy.secondPass?.mode || 'off'),
          },
        },
        audit: audit?.retryPlan ? audit : { retryPlan, planHash: confirmation?.planHash },
        confirmation,
        priorAutoOnceDone,
      });
      if (!decision.execute) {
        return {
          ok: true,
          refine: true,
          executed: false,
          reportOnly: true,
          reason: decision.reason,
          planHash: decision.planHash || audit?.planHash || null,
          retryPlan: decision.retryPlan || audit?.retryPlan || null,
          judgementState: 'partially_supported',
        };
      }
      mkdirSync(priorPath, { recursive: true });
      const revision = (existing?.manifest?.counts?.evidence || 0) + 1;
      const windows = decision.retryPlan?.windows || [];
      let asrResult = null;
      const wantLocalAsr = policy.asr?.mode === 'on_demand'
        || policy.asr?.mode === 'fallback'
        || (decision.retryPlan?.edits || []).some((e) => /asr/i.test(String(e.action || e)));
      // 不得暗中把 ASR 从 off 改成其他模式
      if (wantLocalAsr && policy.asr?.mode !== 'off' && mayRunAsr(policy, {
        reason: policy.asr.mode === 'fallback' ? 'subtitle_gap' : 'refine',
      }).ok) {
        const mediaPath = existing?.metadata?.path
          || view.sourceRef?.mediaPath
          || null;
        const tempDir = join(
          store.exists(videoKey) ? store.activeVideoDir(videoKey) : store.videoDir(videoKey),
          'tmp',
          'refine-asr',
        );
        asrResult = await runOnDemandAsrWindows({
          videoKey,
          windows: windows.length
            ? windows.map((w) => ({
              startMs: w.startMs,
              endMs: w.endMs,
              reason: w.reason || 'refine',
            }))
            : planAsrWindows({
              durationMs: existing?.metadata?.durationMs || view.sourceRef?.durationMs || 0,
              policy,
              gaps: existing?.coverage?.gaps || [],
            }),
          mediaPath,
          asr,
          extractAudio,
          tempDir,
          policy,
          signal,
          revision,
          clock,
        });
        if (asrResult.ok && existing && store.exists(videoKey)) {
          const nextUtterances = [
            ...(existing.utterances || []),
            ...asrResult.utterances,
          ];
          const nextEvidence = [
            ...(existing.evidenceIndex || []),
            ...asrResult.evidence,
          ];
          store.commit(videoKey, {
            ...existing,
            utterances: nextUtterances,
            evidenceIndex: nextEvidence,
            manifest: {
              ...existing.manifest,
              updatedAt: clock(),
              counts: {
                ...existing.manifest.counts,
                utterances: nextUtterances.length,
                evidence: nextEvidence.length,
              },
            },
          });
        }
      }
      const asrWrote = Boolean(asrResult?.ok && (asrResult.evidence?.length || asrResult.utterances?.length));
      const executed = asrWrote;
      writeJsonAtomic(join(priorPath, `exec-${decision.planHash}.json`), {
        executedAt: clock(),
        planHash: decision.planHash,
        retryPlan: decision.retryPlan,
        autoOnceDone: executed && decision.mode === 'auto_once',
        revision,
        ok: executed,
        success: executed,
        registeredOnly: !executed,
        before: {
          utterances: existing?.utterances?.length || 0,
          evidence: existing?.evidenceIndex?.length || 0,
        },
        after: {
          utterances: (existing?.utterances?.length || 0) + (asrResult?.utterances?.length || 0),
          evidence: (existing?.evidenceIndex?.length || 0) + (asrResult?.evidence?.length || 0),
        },
        triggerReasons: decision.retryPlan?.reasons || [],
        asrCalls: asrResult?.asrCalls || 0,
        asrMode: policy.asr?.mode,
      });
      return {
        ok: true,
        refine: true,
        executed,
        registeredOnly: !executed,
        reportOnly: !executed,
        reason: executed ? 'executed' : (asrResult?.reason || 'plan_registered_no_asr_write'),
        planHash: decision.planHash,
        windows,
        revision,
        onDemandAsr: asrResult
          ? {
            executed: asrWrote,
            asrCalls: asrResult.asrCalls,
            evidenceIds: (asrResult.evidence || []).map((e) => e.evidenceId),
            reason: asrResult.reason || null,
          }
          : null,
        note: asrWrote
          ? '局部 ASR 已写入新 revision，原字幕 evidence 保留'
          : '计划已确认并登记，但未写入 ASR evidence（asr.mode=off、无媒体或运行失败）；不得视为已执行',
      };
    }

    if (!videoKey || !url) {
      return { ok: false, reason: 'missing_args' };
    }
    let descriptor;
    try {
      descriptor = await bilibiliSource.resolveStreams({ url, partId }, { signal });
    } catch (e) {
      return { ok: false, reason: e.code || 'resolve_failed', detail: e.message };
    }
    const policy = normalizeAnalysisPolicy(
      rawPolicy === undefined ? null : rawPolicy,
      { capabilities: { asr: 'auto' }, explicitPolicy: rawPolicy !== undefined },
    );
    // 不落盘 descriptor；启动 URL refine job
    const r = await jobs.startIndexJob({
      videoKey,
      durationMs: descriptor.durationMs || 0,
      sourceMode: 'refine',
      sourceDescriptor: descriptor,
      capabilities: policy ? { asr: policy.asr.mode === 'full' ? 'on' : policy.asr.mode === 'off' ? 'off' : 'auto' } : { asr: 'auto' },
      execution: 'background',
      analysisPolicy: policy || undefined,
    });
    return {
      ok: r.ok !== false,
      refine: true,
      contentFingerprint: descriptor.contentFingerprint,
      bvid: descriptor.bvid,
      cid: descriptor.cid,
      partId: descriptor.partId,
      effectivePolicy: policy || null,
      ...r,
      // 确保签名 URL 不回传到工具层
      sourceDescriptor: undefined,
    };
  }

  async function close() {
    const controllers = jobs?._captureControllers;
    if (controllers?.size) {
      const entries = [...controllers.entries()];
      for (const [id, controller] of entries) {
        try { await controller.requestCancel(); } catch { /* ignore */ }
        controllers.delete(id);
        try {
          const job = jobs.jobs.readJob(id, { optional: true });
          if (job?.lockNonce) {
            jobs.jobs.releaseLock(job.videoKey, { nonce: job.lockNonce });
          }
          if (job && job.state !== 'cancelled') {
            jobs.jobs.updateJob(id, {
              state: 'cancelled',
              stage: 'cancelled',
              cancelRequested: true,
            }, { forceCancelled: true });
          }
        } catch { /* ignore */ }
      }
    }
  }

  return {
    index,
    indexChunk,
    query,
    executeOnDemandAsr,
    executeRefinement,
    getEvidence,
    zoom,
    loadQueryableIndex,
    status,
    list,
    remove,
    cleanup,
    startBackgroundIndex,
    startLongIndex,
    indexAdaptive,
    prepareSourceForIndex,
    jobStatus,
    jobCancel,
    jobResume,
    captureStart,
    captureStop,
    refine,
    close,
    store,
    jobs,
    _internals: { routeQuery, evaluateCognition, retrieve, cache, selectChunksFromCatalog },
  };
}

/**
 * 默认用 ffmpeg 抽帧。
 * 返回绝对媒体时间：timestampMs / t（秒）= seekSec + localOffset。
 */
function defaultExtractFrames({
  path, ffmpegPath = 'ffmpeg', width = 800, height = 450, fps = 6, signal, maxFrames = 120, seekSec = null,
}) {
  const seek = seekSec != null && Number.isFinite(Number(seekSec)) ? Number(seekSec) : 0;
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-v', 'error', '-nostdin'];
    if (seekSec != null) args.push('-ss', String(seekSec));
    args.push(
      '-i', path,
      '-vf', `fps=${fps},scale=${width}:${height}:flags=area`,
      '-frames:v', String(maxFrames),
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      'pipe:1',
    );
    const child = spawn(ffmpegPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const frameSize = width * height * 3;
    let buf = Buffer.alloc(0);
    const frames = [];
    let stderr = '';
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameSize && frames.length < maxFrames) {
        const frame = Buffer.from(buf.subarray(0, frameSize));
        buf = buf.subarray(frameSize);
        const localOffsetSec = frames.length / fps;
        const absSec = seek + localOffsetSec;
        frames.push({
          t: absSec,
          timestampMs: Math.round(absSec * 1000),
          localOffsetMs: Math.round(localOffsetSec * 1000),
          frameIndex: frames.length,
          sourceWindow: { seekSec: seek, fps },
          buf: frame,
        });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      signal?.removeEventListener?.('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      signal?.removeEventListener?.('abort', onAbort);
      if (signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
        return;
      }
      if (code !== 0 && frames.length === 0) {
        reject(new Error(`ffmpeg failed: ${stderr || code}`));
        return;
      }
      resolve(frames);
    });
  });
}

/** FFmpeg / 提取器可用性探测缓存（TTL） */
const visualProbeCache = new Map();
const VISUAL_PROBE_TTL_MS = 5 * 60_000;

function probeFfmpegAvailable(ffmpegPath = 'ffmpeg') {
  const key = String(ffmpegPath || 'ffmpeg');
  const hit = visualProbeCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.ok;
  let ok = false;
  try {
    const r = spawnSync(key, ['-version'], {
      windowsHide: true,
      timeout: 5_000,
      encoding: 'utf8',
    });
    ok = r.status === 0;
  } catch {
    ok = false;
  }
  visualProbeCache.set(key, { ok, expiresAt: Date.now() + VISUAL_PROBE_TTL_MS });
  return ok;
}

function resolveOnDemandVisualCap({
  mediaPath = null,
  extractFrames = null,
  extractFrameAt = null,
  remoteFrameExtractor = null,
  captureAdapter = null,
  policyDisabled = false,
  ffmpegPath = 'ffmpeg',
  extractorAvailable = null,
} = {}) {
  if (policyDisabled) return 'disabled';
  const hasLocal = Boolean(mediaPath && existsSync(mediaPath));
  const injected = typeof extractFrameAt === 'function'
    || typeof remoteFrameExtractor === 'function'
    || typeof captureAdapter === 'function'
    || (typeof extractFrames === 'function' && extractFrames !== defaultExtractFrames);
  // 显式 available() 钩子优先
  if (typeof extractorAvailable === 'function') {
    const a = extractorAvailable();
    if (a?.ok) return hasLocal ? 'ready' : 'pending';
    if (a?.reason === 'pending') return 'pending';
    return hasLocal ? 'degraded' : 'unavailable';
  }
  if (injected) {
    return hasLocal ? 'ready' : 'pending';
  }
  // 无本地媒体且无注入提取器：不可用（PATH 上有 ffmpeg 也不等于本视频 ready）
  if (!hasLocal) return 'unavailable';
  // 默认 defaultExtractFrames：必须验证 ffmpeg 二进制
  const binOk = probeFfmpegAvailable(ffmpegPath);
  if (binOk) return 'ready';
  return 'degraded';
}

export {
  videoKeyOf, clearSubtitleCache, resolveOnDemandVisualCap, probeFfmpegAvailable,
};
