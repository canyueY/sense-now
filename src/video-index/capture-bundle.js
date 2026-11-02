/**
 * capture-bundle.js — 抓播音频分片 → ASR/diarization → 分段线性 wall→video 映射。
 */

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { frameIdOf, contentHash, evidenceIdOf } from './ids.js';
import { dedupeUtterancesAcrossOverlap } from './chunk-plan.js';
import { mapChunkSpeakers, remapUtteranceSpeakers, validateSpeakerEmbeddings } from './speaker-merge.js';
import { buildAsrChapterSkeleton } from './speaker-view.js';

/**
 * 从 PCM WAV 裁出 [startMs, endMs) 子段（16-bit LE；兼容最小 silent WAV）。
 * 非整文件分析：每个 slice 一份临时文件。
 */
export function cropWavRange(srcPath, outPath, startMs, endMs) {
  const buf = readFileSync(srcPath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    const err = new Error('not a RIFF wav');
    err.code = 'WAV';
    throw err;
  }
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataOff = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataOff = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOff < 0 || bits !== 16) {
    const err = new Error('unsupported wav (need PCM16 data)');
    err.code = 'WAV';
    throw err;
  }
  const bytesPerSample = (bits / 8) * channels;
  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const startSample = Math.max(0, Math.floor((Number(startMs) / 1000) * sampleRate));
  const endSample = Math.min(
    totalSamples,
    Math.max(startSample + 1, Math.ceil((Number(endMs) / 1000) * sampleRate)),
  );
  const n = endSample - startSample;
  const pcm = buf.subarray(
    dataOff + startSample * bytesPerSample,
    dataOff + endSample * bytesPerSample,
  );
  const outData = pcm.length;
  const out = Buffer.alloc(44 + outData);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + outData, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * bytesPerSample, 28);
  out.writeUInt16LE(bytesPerSample, 32);
  out.writeUInt16LE(bits, 34);
  out.write('data', 36);
  out.writeUInt32LE(outData, 40);
  pcm.copy(out, 44);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out);
  return {
    path: outPath,
    sampleRate,
    sampleCount: n,
    durationMs: Math.round((n / sampleRate) * 1000),
  };
}

function mapLocalMsToVideo(localMs, slice, mapping) {
  const span = Math.max(1, slice.audioLocalEndMs - slice.audioLocalStartMs);
  const clamped = Math.min(slice.audioLocalEndMs, Math.max(slice.audioLocalStartMs, localMs));
  const wall = slice.wallStartMs
    + ((clamped - slice.audioLocalStartMs) / span) * (slice.wallEndMs - slice.wallStartMs);
  let v = mapWallThroughSegments(wall, mapping);
  if (v == null) {
    const t = (clamped - slice.audioLocalStartMs) / span;
    v = slice.videoStartMs + t * (slice.videoEndMs - slice.videoStartMs);
  }
  return Math.round(v);
}

/**
 * 将墙钟时刻映射到视频时间；找不到返回 null（不伪造）。
 */
export function mapWallThroughSegments(wallMs, mappingSegments = [], open = null) {
  const w = Number(wallMs);
  if (!Number.isFinite(w)) return null;
  for (const s of mappingSegments || []) {
    if (w >= s.wallStartMs && w <= (s.wallEndMs ?? Infinity)) {
      const span = (s.wallEndMs ?? s.wallStartMs) - s.wallStartMs;
      if (span <= 0) return s.videoStartMs;
      const t = (w - s.wallStartMs) / span;
      const vend = s.videoEndMs != null
        ? s.videoEndMs
        : s.videoStartMs + span * (s.playbackRate || 1);
      return s.videoStartMs + t * (vend - s.videoStartMs);
    }
  }
  if (open && w >= open.wallStartMs) {
    return open.videoStartMs + (w - open.wallStartMs) * (open.playbackRate || 1);
  }
  return null;
}

/**
 * 将一段 WAV 与 mapping 求交，拆成 analysis slices。
 */
export function buildAnalysisSlices(segment, mappingSegments = [], {
  sessionWallOriginMs = null,
} = {}) {
  const wallStart = Number(segment.wallStartMs);
  const wallEnd = Number(segment.wallEndMs);
  if (!Number.isFinite(wallStart) || !Number.isFinite(wallEnd) || wallEnd <= wallStart) {
    // 无墙钟：按样本时长
    const sr = Number(segment.sampleRate) || 16000;
    const samples = Number(segment.sampleCount) || 0;
    const durMs = samples > 0 ? Math.round((samples / sr) * 1000) : 0;
    if (durMs <= 0) return [];
    const origin = sessionWallOriginMs ?? 0;
    return [{
      path: segment.path,
      audioLocalStartMs: 0,
      audioLocalEndMs: durMs,
      wallStartMs: origin,
      wallEndMs: origin + durMs,
      videoStartMs: 0,
      videoEndMs: durMs,
      playbackRate: 1,
      timeSource: 'wallclock',
    }];
  }

  const maps = [...(mappingSegments || [])]
    .filter((m) => Number.isFinite(m.wallStartMs))
    .sort((a, b) => a.wallStartMs - b.wallStartMs);

  if (!maps.length) {
    const dur = wallEnd - wallStart;
    const v0 = sessionWallOriginMs != null ? wallStart - sessionWallOriginMs : 0;
    return [{
      path: segment.path,
      audioLocalStartMs: 0,
      audioLocalEndMs: dur,
      wallStartMs: wallStart,
      wallEndMs: wallEnd,
      videoStartMs: Math.max(0, v0),
      videoEndMs: Math.max(0, v0) + dur,
      playbackRate: 1,
      timeSource: 'wallclock',
    }];
  }

  const slices = [];
  const segDur = wallEnd - wallStart;
  for (const m of maps) {
    const mEnd = m.wallEndMs ?? wallEnd;
    const overlapStart = Math.max(wallStart, m.wallStartMs);
    const overlapEnd = Math.min(wallEnd, mEnd);
    if (overlapEnd <= overlapStart) continue;
    // pause 区间：playbackRate≈0 或 reason=pause → 跳过
    if (m.reason === 'pause' || (Number(m.playbackRate) || 1) <= 0) continue;

    const audioLocalStartMs = Math.round(((overlapStart - wallStart) / segDur) * segDur);
    const audioLocalEndMs = Math.round(((overlapEnd - wallStart) / segDur) * segDur);
    const vStart = mapWallThroughSegments(overlapStart, [m]);
    const vEnd = mapWallThroughSegments(overlapEnd, [m]);
    if (vStart == null || vEnd == null || vEnd <= vStart) continue;

    slices.push({
      path: segment.path,
      audioLocalStartMs,
      audioLocalEndMs,
      wallStartMs: overlapStart,
      wallEndMs: overlapEnd,
      videoStartMs: vStart,
      videoEndMs: vEnd,
      playbackRate: Number(m.playbackRate) || 1,
      timeSource: 'cdp',
    });
  }
  return slices;
}

function assertInsideTemp(path, tempRoot) {
  if (!path || !tempRoot) {
    const err = new Error('capture path/temp required');
    err.code = 'PATH';
    throw err;
  }
  const abs = resolve(path);
  const root = resolve(tempRoot);
  const rel = relative(root, abs);
  if (isAbsolute(rel) || rel.startsWith('..')) {
    const err = new Error('capture path escapes temp dir');
    err.code = 'PATH';
    throw err;
  }
  if (!existsSync(abs)) {
    const err = new Error(`capture audio missing: ${path}`);
    err.code = 'ENOENT';
    throw err;
  }
  return abs;
}

/**
 * 分析整个 capture bundle（所有 audioSegments）。
 */
export async function analyzeCaptureBundle({
  videoKey,
  chunkId,
  chunk,
  bundle,
  tempRoot,
  asr,
  audioVisual,
  capabilities: capOpts = {},
  speakerMerge: mergeOpts = null,
  signal,
  sessionWallOriginMs = null,
  clock = () => new Date().toISOString(),
} = {}) {
  const audioSegments = [...(bundle?.audioSegments || [])]
    .filter((s) => s?.path)
    .sort((a, b) => (a.wallStartMs || 0) - (b.wallStartMs || 0));

  const mapping = bundle?.mappingSegments || [];
  const gaps = bundle?.gaps || [];
  const frames = bundle?.frames || [];

  for (const seg of audioSegments) {
    assertInsideTemp(seg.path, tempRoot);
  }

  const slices = [];
  for (const seg of audioSegments) {
    slices.push(...buildAnalysisSlices(seg, mapping, { sessionWallOriginMs }));
  }

  let utterances = [];
  let evidence = [];
  let speakers = [];
  let speakerEmbeddings = [];
  const capabilities = {
    asr: 'unavailable',
    diarization: 'skipped',
    speakerMerge: mergeOpts?.enabled ? 'disabled' : 'disabled',
    storyboard: 'unavailable',
  };
  let degraded = false;
  let timeSource = mapping.length ? 'cdp' : 'wallclock';

  const wantAsr = capOpts.asr !== 'off';
  const wantDiar = capOpts.diarization === 'on';
  const wantEmb = Boolean(wantDiar && mergeOpts?.enabled);

  // 无 mapping 且无切片时，仍按样本时长建 wallclock 片
  if (!slices.length && audioSegments.length) {
    for (const seg of audioSegments) {
      slices.push(...buildAnalysisSlices(seg, [], { sessionWallOriginMs }));
    }
  }

  let sliceIdx = 0;
  for (const slice of slices) {
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }

    // 始终裁到 audioLocal 区间，禁止对完整 WAV 重复 ASR/diarization
    let sliceAudioPath = slice.path;
    try {
      const cropDir = join(dirname(slice.path), '.slices');
      const cropPath = join(cropDir, `${chunkId}_${sliceIdx}.wav`);
      cropWavRange(
        slice.path,
        cropPath,
        Math.max(0, slice.audioLocalStartMs || 0),
        Math.max((slice.audioLocalStartMs || 0) + 1, slice.audioLocalEndMs || 1),
      );
      sliceAudioPath = cropPath;
    } catch {
      sliceAudioPath = slice.path;
    }
    sliceIdx += 1;

    if (wantAsr && asr?.available?.().ok) {
      const asrOut = await asr.analyze({
        videoKey,
        audioPath: sliceAudioPath,
        offsetMs: 0, // 已裁到 slice；返回时间为 slice-local
        chunkId,
        language: capOpts.language || null,
      }, { signal });
      if (asrOut.ok) {
        capabilities.asr = 'ready';
        for (const u of asrOut.utterances || []) {
          // slice-local（相对裁剪文件 0）→ 原文件 local → wall → video
          const localStart = slice.audioLocalStartMs + (u.startMs || 0);
          const localEnd = slice.audioLocalStartMs + (u.endMs || 0);
          const vStart = mapLocalMsToVideo(localStart, slice, mapping);
          const vEnd = mapLocalMsToVideo(localEnd, slice, mapping);
          if (vEnd <= vStart) continue;
          const crossesGap = (gaps || []).some((g) => vStart < g.toVideoMs && vEnd > g.fromVideoMs
            && g.fromVideoMs != null);
          if (crossesGap) continue;
          if (slice.timeSource === 'wallclock') timeSource = 'wallclock';
          else if (slice.timeSource === 'cdp') timeSource = 'cdp';
          utterances.push({
            ...u,
            startMs: vStart,
            endMs: vEnd,
            chunkId,
            timeSource: slice.timeSource || timeSource,
            localStartMs: localStart,
            localEndMs: localEnd,
          });
        }
        for (const ev of asrOut.evidence || []) {
          const eStart = mapLocalMsToVideo(
            slice.audioLocalStartMs + (ev.startMs || ev.tMs || 0),
            slice,
            mapping,
          );
          const eEnd = mapLocalMsToVideo(
            slice.audioLocalStartMs + (ev.endMs != null
              ? ev.endMs
              : ((ev.startMs || ev.tMs || 0) + 1)),
            slice,
            mapping,
          );
          evidence.push({
            ...ev,
            startMs: eStart,
            endMs: eEnd,
            tMs: Math.round((eStart + eEnd) / 2),
            chunkId,
            timeSource: slice.timeSource || timeSource,
            evidenceId: evidenceIdOf({
              videoKey,
              kind: ev.kind || 'asr',
              startMs: eStart,
              endMs: eEnd,
              contentHash: contentHash(String(ev.text || ev.evidenceId || eStart)),
            }),
          });
        }
      } else if (capabilities.asr !== 'ready') {
        capabilities.asr = asrOut.reason === 'unavailable' ? 'unavailable' : 'degraded';
        degraded = true;
      }
    } else if (wantAsr && !asr?.available?.().ok) {
      capabilities.asr = 'unavailable';
      degraded = true;
    }

    if (wantDiar && audioVisual?.available?.().ok) {
      const av = await audioVisual.analyze({
        videoKey,
        audioPath: sliceAudioPath,
        chunkId,
        offsetMs: 0,
        returnEmbeddings: wantEmb,
      }, { signal });
      if (av.ok) {
        capabilities.diarization = 'ready';
        const mappedSegs = (av.activeSegments || []).map((s) => ({
          ...s,
          startMs: mapLocalMsToVideo(slice.audioLocalStartMs + (s.startMs || 0), slice, mapping),
          endMs: mapLocalMsToVideo(slice.audioLocalStartMs + (s.endMs || 0), slice, mapping),
        }));
        speakers.push(...(av.speakers || []));
        utterances = attachByOverlap(utterances, mappedSegs);
        if (wantEmb) {
          const status = av.embeddingStatus;
          const raw = av.speakerEmbeddings || [];
          if ((!raw || !raw.length) && status && status.ok === false) {
            capabilities.speakerMerge = 'unavailable';
          } else {
            const validated = validateSpeakerEmbeddings(raw, { allowEmpty: false });
            if (validated.ok && validated.embeddings.length) {
              speakerEmbeddings.push(...validated.embeddings);
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
      }
    }
  }

  if (!wantAsr) capabilities.asr = utterances.length ? 'skipped' : 'unavailable';
  if (!wantDiar) capabilities.diarization = 'skipped';
  if (!wantEmb) capabilities.speakerMerge = 'disabled';

  const mappedSpeakers = mapChunkSpeakers(speakers, chunkId);
  const idMap = new Map(mappedSpeakers.map((s) => [s.localSpeakerId, s.speakerClusterId]));
  utterances = remapUtteranceSpeakers(utterances, idMap);
  utterances = dedupeUtterancesAcrossOverlap(utterances);

  // chunk 时间：取实际内容范围
  let startMs = chunk?.startMs;
  let endMs = chunk?.endMs;
  if (slices.length) {
    const minV = Math.min(...slices.map((s) => s.videoStartMs));
    const maxV = Math.max(...slices.map((s) => s.videoEndMs));
    if (!Number.isFinite(startMs) || startMs === 0 && endMs === 1) startMs = minV;
    if (!Number.isFinite(endMs) || endMs <= startMs) endMs = Math.max(maxV, startMs + 1);
  }

  const storyboard = [];
  for (const fr of frames) {
    storyboard.push({
      frameId: frameIdOf({
        videoKey,
        timestampMs: fr.videoMs || 0,
        contentHash: contentHash(`${chunkId}:${fr.videoMs}:${fr.path || ''}`),
      }),
      timestampMs: fr.videoMs || 0,
      imageRef: fr.path || null,
      chunkId,
      timeSource,
    });
  }
  if (storyboard.length) capabilities.storyboard = 'ready';

  let chapters = [];
  if (utterances.length) {
    chapters = buildAsrChapterSkeleton(utterances, {
      videoKey,
      indexVersion: `capture:${chunkId}`,
    }).slice(0, 3);
  }

  return {
    utterances,
    events: [],
    speakers: mappedSpeakers,
    storyboard,
    evidence,
    chapters,
    speakerEmbeddings,
    degraded,
    capabilities,
    timeSource,
    discontinuity: Boolean(gaps.length),
    gaps,
    byteUsage: { downloaded: 0, temporaryPeak: 0, outputBytes: 0 },
    provenance: {
      generatedAt: typeof clock === 'function' ? clock() : new Date().toISOString(),
      sourceMode: 'capture',
      slices: slices.length,
      audioSegments: audioSegments.length,
    },
    resolvedChunk: {
      startMs: Number(startMs) || 0,
      endMs: Number(endMs) || Math.max(1, Number(startMs) || 0 + 1),
    },
  };
}

function attachByOverlap(utterances, activeSegments) {
  if (!activeSegments?.length) return utterances;
  return utterances.map((u) => {
    if (u.speakerClusterId || u.speakerId) return u;
    let best = null;
    let bestOverlap = 0;
    for (const s of activeSegments) {
      const sp = s.speakerClusterId || s.speakerId;
      if (!sp) continue;
      const overlap = Math.max(0, Math.min(u.endMs, s.endMs) - Math.max(u.startMs, s.startMs));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = sp;
      }
    }
    return best ? { ...u, speakerClusterId: best } : u;
  });
}

/** 最小合法 16kHz mono PCM WAV（silence）。 */
export function writeSilentWav(path, durationMs = 1000, sampleRate = 16000) {
  const n = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  writeFileSync(path, buf);
  return { path, sampleCount: n, sampleRate, durationMs };
}
