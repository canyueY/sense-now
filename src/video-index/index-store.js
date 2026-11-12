/**
 * index-store.js — 单视频索引目录读写。
 * 重建时按 videoKey 写入独立 staging 目录，成功后再原子切换。
 * 崩溃恢复：启动时扫描 journal / trash / staging 半成品。
 */

import {
  existsSync, mkdirSync, readdirSync, rmSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, readJson, isTempName } from './atomic-json.js';
import {
  resolveVideoDir, resolveInside, safeVideoKey, decodeVideoKeyDir, encodeVideoKeyDir,
} from './paths.js';
import { validateManifest } from './schema.js';

export const LAYOUT = Object.freeze({
  manifest: 'manifest.json',
  metadata: 'metadata.json',
  summary: {
    chapters: 'summary/chapters.json',
    topics: 'summary/topics.json',
    entityOverview: 'summary/entity-overview.json',
    keyMoments: 'summary/key-moments.json',
    characterIdentity: 'summary/character-identity.json',
    characterIdentityDecisions: 'summary/character-identity-decisions.json',
  },
  detail: {
    timeline: 'detail/timeline.json',
    utterances: 'detail/utterances.json',
    events: 'detail/events.json',
    subtitles: 'detail/subtitles.json',
    entityTracks: 'detail/entity-tracks.json',
    subtitleSegments: 'detail/subtitle-segments.json',
  },
  analysis: {
    coverage: 'analysis/coverage.json',
    recommendations: 'analysis/recommendations.json',
    effectivePolicy: 'analysis/effective-policy.json',
    audit: 'analysis/audit.json',
  },
  evidence: {
    index: 'evidence/evidence-index.json',
    storyboard: 'evidence/storyboard-index.json',
    audio: 'evidence/audio-index.json',
    frames: 'evidence/frames',
    audioDir: 'evidence/audio',
  },
  refinements: 'refinements',
  cache: {
    queries: 'cache/queries.json',
  },
});

function isReservedDirName(name) {
  return name.endsWith('.__staging')
    || name.includes('.__trash-')
    || name.endsWith('.publish.json')
    || isTempName(name)
    || name.startsWith('.');
}

function journalPath(rootDir, videoKey) {
  return join(rootDir, `${encodeVideoKeyDir(videoKey)}.publish.json`);
}

function parseTrashName(name) {
  const m = String(name).match(/^(.*)\.__trash-(\d+)$/);
  if (!m) return null;
  return { encoded: m[1], ts: Number(m[2]) };
}

export function createIndexStore({ rootDir, recoverOnCreate = true } = {}) {
  if (!rootDir) throw new Error('rootDir required');

  /** @type {Map<string, { videoKey: string, dir: string }>} */
  const stagingByKey = new Map();

  function videoDir(videoKey) {
    return resolveVideoDir(rootDir, videoKey);
  }

  function stagingDirName(videoKey) {
    return `${encodeVideoKeyDir(videoKey)}.__staging`;
  }

  function getStaging(videoKey) {
    return stagingByKey.get(safeVideoKey(videoKey)) || null;
  }

  function activeDir(videoKey) {
    const st = getStaging(videoKey);
    if (st) return st.dir;
    return videoDir(videoKey);
  }

  function ensureDirs(dir) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'summary'), { recursive: true });
    mkdirSync(join(dir, 'detail'), { recursive: true });
    mkdirSync(join(dir, 'analysis'), { recursive: true });
    mkdirSync(join(dir, 'refinements'), { recursive: true });
    mkdirSync(join(dir, 'evidence', 'frames'), { recursive: true });
    mkdirSync(join(dir, 'evidence', 'audio'), { recursive: true });
    mkdirSync(join(dir, 'evidence', 'media'), { recursive: true });
    mkdirSync(join(dir, 'cache'), { recursive: true });
    return dir;
  }

  function ensureLayout(videoKey) {
    return ensureDirs(activeDir(videoKey));
  }

  function beginStaging(videoKey) {
    const key = safeVideoKey(videoKey);
    abortStaging(key);
    const name = stagingDirName(key);
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error('unsafe staging dir');
    }
    const dir = join(rootDir, name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    ensureDirs(dir);
    const entry = { videoKey: key, dir };
    stagingByKey.set(key, entry);
    return entry;
  }

  function abortStaging(videoKey = null) {
    if (videoKey == null) {
      for (const key of [...stagingByKey.keys()]) abortStaging(key);
      return;
    }
    const key = safeVideoKey(videoKey);
    const st = stagingByKey.get(key);
    stagingByKey.delete(key);
    const dir = st?.dir || join(rootDir, stagingDirName(key));
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { unlinkSync(journalPath(rootDir, key)); } catch { /* ignore */ }
  }

  function writePart(videoKey, relativePath, value) {
    const dir = ensureLayout(videoKey);
    const file = resolveInside(dir, relativePath);
    writeJsonAtomic(file, value);
    return file;
  }

  function readPart(videoKey, relativePath, { optional = false } = {}) {
    const key = safeVideoKey(videoKey);
    if (!exists(key) && !getStaging(key)) {
      if (optional) return null;
      throw new Error(`index not found: ${videoKey}`);
    }
    const dir = activeDir(key);
    const file = resolveInside(dir, relativePath);
    return readJson(file, { optional });
  }

  function writeBinary(videoKey, relativePath, buffer) {
    const dir = ensureLayout(videoKey);
    const file = resolveInside(dir, relativePath);
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp-${Date.now()}`;
    writeFileSync(tmp, buffer);
    try {
      renameSync(tmp, file);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    return relativePath.replace(/\\/g, '/');
  }

  function exists(videoKey) {
    try {
      const dir = videoDir(videoKey);
      return existsSync(join(dir, LAYOUT.manifest));
    } catch {
      return false;
    }
  }

  function readManifest(videoKey, { optional = false } = {}) {
    try {
      if (!exists(videoKey)) {
        if (optional) return null;
        throw new Error(`index not found: ${videoKey}`);
      }
      const file = resolveInside(videoDir(videoKey), LAYOUT.manifest);
      const m = readJson(file, { optional });
      if (!m) return null;
      return validateManifest(m);
    } catch (e) {
      if (optional) return null;
      throw e;
    }
  }

  function writePayload(dir, {
    manifest,
    metadata = null,
    chapters = [],
    topics = [],
    entityOverview = [],
    keyMoments = [],
    timeline = [],
    utterances = [],
    events = [],
    subtitles = [],
    entityTracks = [],
    evidenceIndex = [],
    storyboardIndex = [],
    audioIndex = [],
    subtitleSegments = null,
    coverage = null,
    recommendations = null,
    effectivePolicy = null,
    audit = null,
    characterIdentity = null,
    identityDecisions = null,
  }) {
    ensureDirs(dir);
    const w = (rel, value) => writeJsonAtomic(resolveInside(dir, rel), value);
    if (metadata != null) w(LAYOUT.metadata, metadata);
    w(LAYOUT.summary.chapters, chapters);
    w(LAYOUT.summary.topics, topics);
    w(LAYOUT.summary.entityOverview, entityOverview);
    w(LAYOUT.summary.keyMoments, keyMoments);
    w(LAYOUT.detail.timeline, timeline);
    w(LAYOUT.detail.utterances, utterances);
    w(LAYOUT.detail.events, events);
    w(LAYOUT.detail.subtitles, subtitles);
    w(LAYOUT.detail.entityTracks, entityTracks);
    if (subtitleSegments != null) w(LAYOUT.detail.subtitleSegments, subtitleSegments);
    if (coverage != null) w(LAYOUT.analysis.coverage, coverage);
    if (recommendations != null) w(LAYOUT.analysis.recommendations, recommendations);
    if (effectivePolicy != null) w(LAYOUT.analysis.effectivePolicy, effectivePolicy);
    if (audit != null) w(LAYOUT.analysis.audit, audit);
    if (characterIdentity != null) w(LAYOUT.summary.characterIdentity, characterIdentity);
    if (identityDecisions != null) w(LAYOUT.summary.characterIdentityDecisions, identityDecisions);
    w(LAYOUT.evidence.index, evidenceIndex);
    w(LAYOUT.evidence.storyboard, storyboardIndex);
    w(LAYOUT.evidence.audio, audioIndex);
    const final = validateManifest(manifest);
    w(LAYOUT.manifest, final);
    try { unlinkSync(join(dir, '.building.json')); } catch { /* 没有构建标记 */ }
    return final;
  }

  function writeJournal(videoKey, payload) {
    writeJsonAtomic(journalPath(rootDir, videoKey), {
      ...payload,
      videoKey: safeVideoKey(videoKey),
      updatedAt: new Date().toISOString(),
    });
  }

  function clearJournal(videoKey) {
    try { unlinkSync(journalPath(rootDir, videoKey)); } catch { /* ignore */ }
  }

  /**
   * 提交：若有该 videoKey 的 staging，写入后原子切换；否则直接写 live。
   */
  function commit(videoKey, payload) {
    const key = safeVideoKey(videoKey);
    const st = stagingByKey.get(key);
    if (st) {
      const final = writePayload(st.dir, payload);
      publishStaging(key);
      return final;
    }
    const dir = ensureLayout(key);
    return writePayload(dir, payload);
  }

  function publishStaging(videoKey) {
    const key = safeVideoKey(videoKey);
    const st = stagingByKey.get(key);
    if (!st) throw new Error('no active staging to publish');
    const live = videoDir(key);
    const from = st.dir;
    const trash = join(rootDir, `${encodeVideoKeyDir(key)}.__trash-${Date.now()}`);
    if (!existsSync(join(from, LAYOUT.manifest))) {
      throw new Error('staging missing manifest; refuse publish');
    }
    try { unlinkSync(join(from, '.building.json')); } catch { /* ignore */ }

    writeJournal(key, {
      phase: 'start',
      stagingDir: from,
      liveDir: live,
      trashDir: trash,
    });

    if (existsSync(live)) {
      renameSync(live, trash);
      writeJournal(key, {
        phase: 'live_parked',
        stagingDir: from,
        liveDir: live,
        trashDir: trash,
      });
    }

    try {
      renameSync(from, live);
    } catch (e) {
      try {
        if (existsSync(trash) && !existsSync(live)) renameSync(trash, live);
      } catch { /* ignore */ }
      stagingByKey.delete(key);
      writeJournal(key, {
        phase: 'failed',
        stagingDir: from,
        liveDir: live,
        trashDir: trash,
        error: String(e?.message || e),
      });
      throw e;
    }

    stagingByKey.delete(key);
    writeJournal(key, {
      phase: 'promoted',
      stagingDir: from,
      liveDir: live,
      trashDir: trash,
    });
    // 成功后保留 trash 作为可恢复副本，由 recover / 显式 purgeTrash 清理；不立即 rm
    clearJournal(key);
  }

  /**
   * 启动恢复：journal / 仅有 trash / 仅有完整 staging。
   * @returns {{ restored: string[], notes: string[] }}
   */
  function recoverIncompletePublishes() {
    const restored = [];
    const notes = [];
    if (!existsSync(rootDir)) return { restored, notes };

    const names = readdirSync(rootDir);

    // 1) journal 驱动
    for (const name of names) {
      if (!name.endsWith('.publish.json')) continue;
      const encoded = name.slice(0, -'.publish.json'.length);
      let videoKey;
      try { videoKey = decodeVideoKeyDir(encoded); safeVideoKey(videoKey); } catch { continue; }
      let j;
      try { j = readJson(join(rootDir, name), { optional: true }); } catch { continue; }
      if (!j) continue;
      const live = j.liveDir || videoDir(videoKey);
      const trash = j.trashDir;
      const staging = j.stagingDir || join(rootDir, stagingDirName(videoKey));

      if (j.phase === 'live_parked' || j.phase === 'failed' || j.phase === 'start') {
        if (!existsSync(join(live, LAYOUT.manifest))) {
          if (trash && existsSync(join(trash, LAYOUT.manifest))) {
            try {
              renameSync(trash, live);
              restored.push(videoKey);
              notes.push(`restored live from trash via journal (${j.phase})`);
            } catch (e) {
              notes.push(`restore failed: ${e.message}`);
            }
          } else if (existsSync(join(staging, LAYOUT.manifest))) {
            try {
              renameSync(staging, live);
              restored.push(videoKey);
              notes.push(`promoted staging via journal (${j.phase})`);
            } catch (e) {
              notes.push(`promote failed: ${e.message}`);
            }
          }
        }
      } else if (j.phase === 'promoted') {
        // live 应已就绪；清 journal
      }
      clearJournal(videoKey);
    }

    // 2) 无 live、有 trash → 恢复最新 trash
    const trashByEncoded = new Map();
    for (const name of readdirSync(rootDir)) {
      const parsed = parseTrashName(name);
      if (!parsed) continue;
      const prev = trashByEncoded.get(parsed.encoded);
      if (!prev || parsed.ts > prev.ts) {
        trashByEncoded.set(parsed.encoded, { name, ts: parsed.ts });
      }
    }
    for (const [encoded, info] of trashByEncoded) {
      let videoKey;
      try { videoKey = decodeVideoKeyDir(encoded); safeVideoKey(videoKey); } catch { continue; }
      const live = videoDir(videoKey);
      if (existsSync(join(live, LAYOUT.manifest))) continue;
      const trash = join(rootDir, info.name);
      if (!existsSync(join(trash, LAYOUT.manifest))) continue;
      try {
        renameSync(trash, live);
        restored.push(videoKey);
        notes.push('restored live from orphan trash');
      } catch (e) {
        notes.push(`orphan trash restore failed: ${e.message}`);
      }
    }

    // 3) 无 live、有完整 staging → 提升（罕见：crash after journal clear?）
    for (const name of readdirSync(rootDir)) {
      if (!name.endsWith('.__staging')) continue;
      const encoded = name.slice(0, -'.__staging'.length);
      let videoKey;
      try { videoKey = decodeVideoKeyDir(encoded); safeVideoKey(videoKey); } catch { continue; }
      const live = videoDir(videoKey);
      if (existsSync(join(live, LAYOUT.manifest))) continue;
      const staging = join(rootDir, name);
      if (!existsSync(join(staging, LAYOUT.manifest))) continue;
      try {
        renameSync(staging, live);
        restored.push(videoKey);
        notes.push('promoted orphan staging with manifest');
      } catch (e) {
        notes.push(`orphan staging promote failed: ${e.message}`);
      }
    }

    return { restored, notes };
  }

  function loadIndex(videoKey) {
    const manifest = readManifest(videoKey);
    const dir = videoDir(videoKey);
    const arr = (rel) => readJson(resolveInside(dir, rel), { optional: true }) || [];
    const obj = (rel) => readJson(resolveInside(dir, rel), { optional: true }) || null;
    return {
      manifest,
      metadata: readJson(resolveInside(dir, LAYOUT.metadata), { optional: true }) || {},
      chapters: arr(LAYOUT.summary.chapters),
      topics: arr(LAYOUT.summary.topics),
      entityOverview: arr(LAYOUT.summary.entityOverview),
      keyMoments: arr(LAYOUT.summary.keyMoments),
      timeline: arr(LAYOUT.detail.timeline),
      utterances: arr(LAYOUT.detail.utterances),
      events: arr(LAYOUT.detail.events),
      subtitles: arr(LAYOUT.detail.subtitles),
      entityTracks: arr(LAYOUT.detail.entityTracks),
      subtitleSegments: arr(LAYOUT.detail.subtitleSegments),
      coverage: obj(LAYOUT.analysis.coverage),
      recommendations: obj(LAYOUT.analysis.recommendations),
      effectivePolicy: obj(LAYOUT.analysis.effectivePolicy),
      audit: obj(LAYOUT.analysis.audit),
      evidenceIndex: arr(LAYOUT.evidence.index),
      storyboardIndex: arr(LAYOUT.evidence.storyboard),
      audioIndex: arr(LAYOUT.evidence.audio),
      characterIdentity: obj(LAYOUT.summary.characterIdentity),
      identityDecisions: obj(LAYOUT.summary.characterIdentityDecisions),
      dir,
    };
  }

  function readCharacterIdentity(videoKey) {
    try {
      const file = resolveInside(activeDir(videoKey), LAYOUT.summary.characterIdentity);
      return readJson(file, { optional: true });
    } catch {
      return null;
    }
  }

  function writeCharacterIdentity(videoKey, registry) {
    const dir = ensureLayout(videoKey);
    writeJsonAtomic(resolveInside(dir, LAYOUT.summary.characterIdentity), registry);
    return registry;
  }

  function readIdentityDecisions(videoKey) {
    try {
      const file = resolveInside(activeDir(videoKey), LAYOUT.summary.characterIdentityDecisions);
      return readJson(file, { optional: true });
    } catch {
      return null;
    }
  }

  function writeIdentityDecisions(videoKey, decisions) {
    const dir = ensureLayout(videoKey);
    writeJsonAtomic(resolveInside(dir, LAYOUT.summary.characterIdentityDecisions), decisions);
    return decisions;
  }

  function list() {
    if (!existsSync(rootDir)) return [];
    const out = [];
    for (const name of readdirSync(rootDir)) {
      if (isReservedDirName(name)) continue;
      try {
        const videoKey = decodeVideoKeyDir(name);
        safeVideoKey(videoKey);
        const m = readManifest(videoKey, { optional: true });
        if (m) {
          out.push({
            videoKey: m.videoKey || videoKey,
            status: m.status,
            updatedAt: m.updatedAt,
            manifest: m,
          });
        }
      } catch {
        // skip
      }
    }
    return out;
  }

  function remove(videoKey) {
    const key = safeVideoKey(videoKey);
    abortStaging(key);
    const dir = videoDir(key);
    if (!existsSync(dir)) {
      return { ok: true, removed: false, videoKey: key, recoverable: false };
    }
    resolveVideoDir(rootDir, key);
    rmSync(dir, { recursive: true, force: true });
    // 顺带清该 key 的 trash
    try {
      const enc = encodeVideoKeyDir(key);
      for (const name of readdirSync(rootDir)) {
        if (name.startsWith(`${enc}.__trash-`)) {
          try { rmSync(join(rootDir, name), { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return {
      ok: true,
      removed: true,
      videoKey: key,
      recoverable: false,
      note: 'index deleted permanently; original media was not removed',
    };
  }

  function resolveEvidenceFile(videoKey, sourceFile) {
    return resolveInside(activeDir(videoKey), sourceFile);
  }

  function status(videoKey) {
    const m = readManifest(videoKey, { optional: true });
    if (!m) return { ok: false, reason: 'not-found', videoKey };
    // 残留 .building.json 不能把已 ready 的 manifest 降级
    return { ok: true, videoKey, manifest: m, status: m.status, capabilities: m.capabilities };
  }

  /**
   * 显式清理可恢复 trash。
   * requireLive=true（默认）：仅当对应 videoKey 存在有效 live manifest 时删除。
   */
  function purgeTrashDirs({
    olderThanMs = 0,
    now = Date.now(),
    requireLive = true,
  } = {}) {
    const removed = [];
    const preserved = [];
    if (!existsSync(rootDir)) return { removed, preserved };
    for (const name of readdirSync(rootDir)) {
      const parsed = parseTrashName(name);
      if (!parsed) continue;
      if (olderThanMs > 0 && now - parsed.ts < olderThanMs) continue;
      const p = join(rootDir, name);
      let videoKey = null;
      try {
        videoKey = decodeVideoKeyDir(parsed.encoded);
        safeVideoKey(videoKey);
      } catch {
        preserved.push(p);
        continue;
      }
      if (requireLive) {
        const liveOk = exists(videoKey) && Boolean(readManifest(videoKey, { optional: true }));
        if (!liveOk) {
          preserved.push(p);
          continue;
        }
      }
      try {
        rmSync(p, { recursive: true, force: true });
        if (existsSync(p)) preserved.push(p);
        else removed.push(p);
      } catch {
        preserved.push(p);
      }
    }
    return { removed, preserved };
  }

  if (recoverOnCreate) {
    try { recoverIncompletePublishes(); } catch { /* ignore */ }
  }

  return {
    rootDir,
    LAYOUT,
    videoDir,
    activeVideoDir: activeDir,
    ensureLayout,
    writePart,
    readPart,
    writeBinary,
    exists,
    readManifest,
    commit,
    loadIndex,
    readCharacterIdentity,
    writeCharacterIdentity,
    readIdentityDecisions,
    writeIdentityDecisions,
    list,
    remove,
    resolveEvidenceFile,
    status,
    beginStaging,
    abortStaging,
    publishStaging,
    getStaging,
    recoverIncompletePublishes,
    purgeTrashDirs,
    /** @deprecated 单槽兼容：无活动 staging 时 null；有则返回任意一个（测试用） */
    get staging() {
      if (stagingByKey.size === 0) return null;
      if (stagingByKey.size === 1) return [...stagingByKey.values()][0];
      return null;
    },
    get stagingSize() { return stagingByKey.size; },
  };
}
