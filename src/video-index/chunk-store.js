/**
 * chunk-store.js — chunk 原子提交与 catalog；查询只见 ready generation。
 */

import {
  existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, readJson } from './atomic-json.js';
import { resolveInside, resolveVideoDir, safeVideoKey, encodeVideoKeyDir } from './paths.js';
import { LAYOUT_VERSION, chunkIdOf } from './chunk-plan.js';

export const CHUNK_LAYOUT = Object.freeze({
  dir: 'chunks',
  catalog: 'chunks/catalog.json',
  chunkManifest: 'chunk-manifest.json',
  utterances: 'utterances.json',
  events: 'events.json',
  speakers: 'speakers.json',
  storyboard: 'storyboard.json',
  evidence: 'evidence.json',
  chapters: 'chapters.json',
});

export function assertChunkId(value) {
  const id = String(value ?? '');
  if (!/^\d{6}$/.test(id)) {
    const err = new Error('invalid chunkId');
    err.code = 'INVALID_CHUNK_ID';
    throw err;
  }
  return id;
}

function stagingName(chunkId) {
  const id = assertChunkId(chunkId);
  return `${id}.__staging`;
}

export function createChunkStore({ rootDir, videoKey }) {
  const key = safeVideoKey(videoKey);
  const videoDir = resolveVideoDir(rootDir, key);
  const chunksRoot = join(videoDir, CHUNK_LAYOUT.dir);

  function ensureChunksRoot() {
    mkdirSync(chunksRoot, { recursive: true });
    return chunksRoot;
  }

  function chunkDir(chunkId) {
    const id = assertChunkId(chunkId);
    return resolveInside(chunksRoot, id);
  }

  function beginChunk(chunkId) {
    const id = assertChunkId(chunkId);
    ensureChunksRoot();
    const staging = resolveInside(chunksRoot, stagingName(id));
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    return staging;
  }

  function abortChunk(chunkId) {
    const id = assertChunkId(chunkId);
    const staging = resolveInside(chunksRoot, stagingName(id));
    if (existsSync(staging)) {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * 原子提交 chunk：先写 staging 内全部文件，manifest 最后写，再 rename。
   */
  function commitChunk(chunkId, payload = {}) {
    const id = assertChunkId(chunkId);
    const staging = beginChunk(id);
    const {
      chunkManifest,
      utterances = [],
      events = [],
      speakers = [],
      storyboard = [],
      evidence = [],
      chapters = [],
    } = payload;

    if (!chunkManifest || !chunkManifest.chunkId) {
      throw new Error('chunkManifest.chunkId required');
    }
    if (!['ready', 'degraded'].includes(chunkManifest.status)) {
      throw new Error('commitChunk requires status ready|degraded');
    }

    writeJsonAtomic(join(staging, CHUNK_LAYOUT.utterances), utterances);
    writeJsonAtomic(join(staging, CHUNK_LAYOUT.events), events);
    writeJsonAtomic(join(staging, CHUNK_LAYOUT.speakers), speakers);
    writeJsonAtomic(join(staging, CHUNK_LAYOUT.storyboard), storyboard);
    writeJsonAtomic(join(staging, CHUNK_LAYOUT.evidence), evidence);
    writeJsonAtomic(join(staging, CHUNK_LAYOUT.chapters), chapters);
    // manifest 最后写
    writeJsonAtomic(join(staging, CHUNK_LAYOUT.chunkManifest), {
      ...chunkManifest,
      chunkId: id,
      layoutVersion: LAYOUT_VERSION,
    });

    const live = resolveInside(chunksRoot, id);
    const trash = resolveInside(chunksRoot, `${id}.__trash-${Date.now()}`);
    if (existsSync(live)) renameSync(live, trash);
    try {
      renameSync(staging, live);
    } catch (e) {
      try {
        if (existsSync(trash) && !existsSync(live)) renameSync(trash, live);
      } catch { /* ignore */ }
      throw e;
    }
    try { rmSync(trash, { recursive: true, force: true }); } catch { /* ignore */ }
    return readChunk(id);
  }

  function readChunk(chunkId, { optional = false } = {}) {
    let id;
    try {
      id = assertChunkId(chunkId);
    } catch (e) {
      if (optional) return null;
      throw e;
    }
    const dir = resolveInside(chunksRoot, id);
    const manifestPath = join(dir, CHUNK_LAYOUT.chunkManifest);
    if (!existsSync(manifestPath)) {
      if (optional) return null;
      throw new Error(`chunk not found: ${id}`);
    }
    // 忽略 staging / trash
    const manifest = readJson(manifestPath);
    if (!['ready', 'degraded'].includes(manifest.status)) {
      if (optional) return null;
      throw new Error(`chunk not queryable: ${id}`);
    }
    return {
      chunkId: id,
      manifest,
      utterances: readJson(join(dir, CHUNK_LAYOUT.utterances), { optional: true }) || [],
      events: readJson(join(dir, CHUNK_LAYOUT.events), { optional: true }) || [],
      speakers: readJson(join(dir, CHUNK_LAYOUT.speakers), { optional: true }) || [],
      storyboard: readJson(join(dir, CHUNK_LAYOUT.storyboard), { optional: true }) || [],
      evidence: readJson(join(dir, CHUNK_LAYOUT.evidence), { optional: true }) || [],
      chapters: readJson(join(dir, CHUNK_LAYOUT.chapters), { optional: true }) || [],
      dir,
    };
  }

  function listReadyChunkIds() {
    if (!existsSync(chunksRoot)) return [];
    const out = [];
    for (const name of readdirSync(chunksRoot)) {
      if (!/^\d{6}$/.test(name)) continue;
      try {
        const m = readJson(join(chunksRoot, name, CHUNK_LAYOUT.chunkManifest), { optional: true });
        if (m && ['ready', 'degraded'].includes(m.status)) out.push(name);
      } catch { /* ignore */ }
    }
    return out.sort();
  }

  function writeCatalog(entries, extra = {}) {
    ensureChunksRoot();
    const durationMs = Number.isFinite(Number(extra.durationMs))
      ? Number(extra.durationMs)
      : entries.reduce((m, c) => Math.max(m, Number(c.endMs) || 0), 0);
    const covered = entries.reduce((sum, c) => {
      const span = Math.max(0, (Number(c.endMs) || 0) - (Number(c.startMs) || 0));
      return sum + span * (Number(c.subtitleCoverage) || 0);
    }, 0);
    const ratio = durationMs > 0 ? Math.min(1, covered / durationMs) : 0;
    writeJsonAtomic(join(videoDir, CHUNK_LAYOUT.catalog), {
      layoutVersion: LAYOUT_VERSION,
      updatedAt: new Date().toISOString(),
      durationMs,
      coverage: extra.coverage || {
        durationMs,
        textCoverageRatio: ratio,
        status: ratio >= 0.7 ? 'good' : (ratio > 0 ? 'partial' : 'none'),
        source: 'chunk_aggregate',
      },
      chunks: entries,
    });
  }

  function readCatalog({ optional = true } = {}) {
    return readJson(join(videoDir, CHUNK_LAYOUT.catalog), { optional });
  }

  /**
   * 从已提交 chunk 重建受限 catalog（不读整库进内存以外的全量字段）。
   */
  function rebuildCatalog() {
    const entries = [];
    for (const rawId of listReadyChunkIds()) {
      let id;
      try { id = assertChunkId(rawId); } catch { continue; }
      const c = readChunk(id, { optional: true });
      if (!c) continue;
      const first = c.utterances[0];
      const dur = Math.max(1, (c.manifest.endMs || 0) - (c.manifest.startMs || 0));
      let covered = 0;
      for (const u of c.utterances || []) {
        covered += Math.max(0, (u.endMs || 0) - (u.startMs || 0));
      }
      const subtitleCoverage = Math.min(1, covered / dur);
      const confs = (c.utterances || [])
        .map((u) => Number(u.confidence))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const textConfidence = confs.length ? confs[Math.floor(confs.length / 2)] : null;
      const gapCount = Number(c.manifest?.gapCount)
        || Math.max(0, Math.round((1 - subtitleCoverage) * 3));
      entries.push({
        chunkId: id,
        revision: c.manifest.revision || 1,
        startMs: c.manifest.startMs,
        endMs: c.manifest.endMs,
        firstUtteranceExcerpt: String(first?.text || '').slice(0, 80),
        topicTags: [...new Set(c.chapters.flatMap((ch) => ch.topicTags || []))].slice(0, 8),
        topTokens: [],
        speakerClusterIds: [...new Set(c.speakers.map((s) => s.speakerClusterId).filter(Boolean))].slice(0, 8),
        storyboardRefs: (c.storyboard || []).slice(0, 4).map((s) => s.frameId || s.imageRef).filter(Boolean),
        status: c.manifest.status,
        timeSource: c.manifest.timeSource || 'stream',
        subtitleCoverage,
        textConfidence,
        gapCount,
        profileHints: [...new Set(c.chapters.flatMap((ch) => ch.profileHints || []))].slice(0, 4),
      });
    }
    writeCatalog(entries);
    return entries;
  }

  return {
    videoKey: key,
    videoDir,
    chunksRoot,
    LAYOUT_VERSION,
    beginChunk,
    abortChunk,
    commitChunk,
    readChunk,
    listReadyChunkIds,
    writeCatalog,
    readCatalog,
    rebuildCatalog,
    chunkIdOf,
  };
}

export { chunkIdOf, LAYOUT_VERSION };
