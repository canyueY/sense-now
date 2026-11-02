/**
 * index-cleanup.js — 临时文件、过期查询缓存、可选过期索引 / trash 清理。
 * 两阶段：先扫描生成计划并验证确认，全部合法后才写盘。
 * .__trash-* 默认不删；purgeTrash 需 confirmDelete，且仅当 live manifest 有效。
 */

import {
  existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { isTempName } from './atomic-json.js';
import { LAYOUT } from './index-store.js';
import { decodeVideoKeyDir, safeVideoKey } from './paths.js';

function isTempFileName(name) {
  return isTempName(name) || name.includes('.tmp-') || name === '.building.json';
}

function parseTrashName(name) {
  const m = String(name).match(/^(.*)\.__trash-(\d+)$/);
  if (!m) return null;
  return { encoded: m[1], ts: Number(m[2]) };
}

/** 列出目录内临时文件（不删除）。 */
export function listTempInDir(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (isTempFileName(ent.name)) found.push(p);
    }
  };
  walk(dir);
  return found;
}

export function purgeTempInDir(dir) {
  const removed = [];
  for (const p of listTempInDir(dir)) {
    try {
      unlinkSync(p);
      removed.push(p);
    } catch { /* ignore */ }
  }
  return removed;
}

export function pruneQueryCache(store, videoKey, {
  ttlMs = 7 * 24 * 3600 * 1000,
  now = Date.now(),
  dryRun = false,
} = {}) {
  let data;
  try {
    data = store.readPart(videoKey, LAYOUT.cache.queries, { optional: true });
  } catch {
    return { pruned: 0, kept: 0, wouldPrune: 0 };
  }
  if (!data || !Array.isArray(data.entries)) return { pruned: 0, kept: 0, wouldPrune: 0 };
  const before = data.entries.length;
  const keptEntries = data.entries.filter((e) => ttlMs <= 0 || (now - (e.at || 0)) <= ttlMs);
  const wouldPrune = before - keptEntries.length;
  if (!dryRun && wouldPrune > 0) {
    data.entries = keptEntries;
    try { store.writePart(videoKey, LAYOUT.cache.queries, data); } catch { /* ignore */ }
  }
  return {
    pruned: dryRun ? 0 : wouldPrune,
    wouldPrune,
    kept: dryRun ? before - wouldPrune : keptEntries.length,
  };
}

function liveManifestOk(store, videoKey) {
  try {
    safeVideoKey(videoKey);
    if (!store.exists(videoKey)) return false;
    const m = store.readManifest(videoKey, { optional: true });
    return Boolean(m && m.videoKey && m.status);
  } catch {
    return false;
  }
}

function exactKeyMatch(candidates, confirmVideoKeys) {
  const allowed = new Set((confirmVideoKeys || []).map(String));
  const missing = candidates.filter((k) => !allowed.has(k));
  const extra = [...allowed].filter((k) => !candidates.includes(k));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/**
 * 全库清理（两阶段：计划 → 确认 → 执行）。
 */
export function cleanupIndexes({
  store,
  ttlMs = 7 * 24 * 3600 * 1000,
  maxAgeMs = null,
  dryRun = false,
  confirmDelete = false,
  confirmVideoKeys = [],
  purgeTrash = false,
  trashMaxAgeMs = null,
  now = Date.now(),
  jobsRoot = null,
  jobTempTtlMs = 24 * 3600 * 1000,
  activeLockPaths = [],
} = {}) {
  const wantsAgeDelete = maxAgeMs != null && Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0;
  const ageMs = wantsAgeDelete ? Number(maxAgeMs) : null;
  const wantsTrash = purgeTrash === true;
  const trashAge = trashMaxAgeMs != null && Number.isFinite(Number(trashMaxAgeMs)) && Number(trashMaxAgeMs) > 0
    ? Number(trashMaxAgeMs)
    : null;

  const report = {
    ok: true,
    dryRun: true,
    tempFilesRemoved: [],
    cachesPruned: [],
    indexesRemoved: [],
    indexesWouldRemove: [],
    trashPreserved: [],
    trashWouldRemove: [],
    trashRemoved: [],
    trashFailed: [],
    jobsCleaned: [],
    privateCleared: [],
    needsConfirmation: false,
    scanned: 0,
    hint: null,
  };
  const activeLocks = new Set((activeLockPaths || []).map(String));

  const root = store.rootDir;
  if (!existsSync(root)) {
    report.dryRun = Boolean(dryRun);
    return report;
  }

  // ——— 阶段 1：只扫描 ———
  const plan = {
    rootTempOrStaging: [],
    videoTemps: [],
    orphanTemps: [],
    cachePlans: [],
    ageCandidates: [],
    trashAll: [],
  };

  for (const name of readdirSync(root)) {
    const trashMeta = parseTrashName(name);
    if (trashMeta) {
      let videoKey = null;
      try {
        videoKey = decodeVideoKeyDir(trashMeta.encoded);
        safeVideoKey(videoKey);
      } catch {
        videoKey = null;
      }
      const p = join(root, name);
      const liveOk = videoKey ? liveManifestOk(store, videoKey) : false;
      const age = now - trashMeta.ts;
      const ageOk = trashAge == null || age >= trashAge;
      plan.trashAll.push({
        path: p,
        videoKey,
        ts: trashMeta.ts,
        liveOk,
        ageOk,
        eligible: liveOk && ageOk,
      });
      continue;
    }
    if (name.endsWith('.__staging') || isTempName(name) || name.startsWith('.tmp-')) {
      plan.rootTempOrStaging.push(join(root, name));
    }
  }

  const items = store.list();
  report.scanned = items.length;

  for (const item of items) {
    const videoKey = item.videoKey;
    try { safeVideoKey(videoKey); } catch { continue; }
    const temps = listTempInDir(store.videoDir(videoKey));
    if (temps.length) plan.videoTemps.push({ videoKey, paths: temps });

    const cachePreview = pruneQueryCache(store, videoKey, { ttlMs, now, dryRun: true });
    if (cachePreview.wouldPrune > 0) {
      plan.cachePlans.push({ videoKey, ...cachePreview });
    }

    if (wantsAgeDelete) {
      const updated = Date.parse(item.updatedAt || item.manifest?.updatedAt || '') || 0;
      if (updated && now - updated > ageMs) plan.ageCandidates.push(videoKey);
    }
  }

  for (const name of readdirSync(root)) {
    if (name.endsWith('.__staging') || name.includes('.__trash-') || name.startsWith('.')) continue;
    let videoKey;
    try { videoKey = decodeVideoKeyDir(name); safeVideoKey(videoKey); } catch { continue; }
    if (store.exists(videoKey)) continue;
    const dir = join(root, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const temps = listTempInDir(dir);
    if (temps.length) plan.orphanTemps.push(...temps);
  }

  // ——— 确认门闩 ———
  let ageConfirmFail = false;
  if (wantsAgeDelete) {
    report.indexesWouldRemove = [...plan.ageCandidates];
    if (confirmDelete === true) {
      const match = exactKeyMatch(plan.ageCandidates, confirmVideoKeys);
      if (!match.ok) {
        ageConfirmFail = true;
        report.ok = false;
        report.needsConfirmation = true;
        report.hint = 'confirmVideoKeys must exactly match indexesWouldRemove';
      }
    } else {
      report.needsConfirmation = true;
      report.hint = 'maxAgeMs deletions require confirmDelete:true and confirmVideoKeys matching candidates';
    }
  }

  if (wantsTrash && confirmDelete !== true) {
    report.needsConfirmation = true;
    report.hint = [
      report.hint,
      'purgeTrash requires confirmDelete:true (optional trashMaxAgeMs)',
    ].filter(Boolean).join('; ');
  }

  /**
   * 写权限：
   * - dryRun → 全禁
   * - maxAge 未确认或 confirmVideoKeys 不匹配 → 全禁（含临时文件/缓存）
   * - trash 另需 confirmDelete；不因仅预览 trash 而禁普通清理（无 maxAge 时）
   */
  const ageBlocksAll = wantsAgeDelete && (confirmDelete !== true || ageConfirmFail);
  const allowMaintenance = !dryRun && !ageBlocksAll && !ageConfirmFail;
  const allowTrash = !dryRun && wantsTrash && confirmDelete === true && !ageConfirmFail && !ageBlocksAll;

  // 预览列表（写前填充；执行成功后 tempFilesRemoved 改为实际删除）
  const previewTemps = [
    ...plan.rootTempOrStaging,
    ...plan.videoTemps.flatMap((v) => v.paths),
    ...plan.orphanTemps,
  ];
  report.tempFilesRemoved = previewTemps;
  report.cachesPruned = plan.cachePlans.map((c) => ({
    videoKey: c.videoKey,
    wouldPrune: c.wouldPrune,
    pruned: 0,
    kept: c.kept,
  }));

  for (const t of plan.trashAll) {
    if (wantsTrash && t.eligible) report.trashWouldRemove.push(t.path);
    else report.trashPreserved.push(t.path);
  }

  // ——— 阶段 2：执行 ———
  if (allowMaintenance) {
    report.tempFilesRemoved = [];
    for (const p of plan.rootTempOrStaging) {
      try {
        rmSync(p, { recursive: true, force: true });
        report.tempFilesRemoved.push(p);
      } catch { /* ignore */ }
    }
    for (const { paths } of plan.videoTemps) {
      for (const p of paths) {
        try {
          unlinkSync(p);
          report.tempFilesRemoved.push(p);
        } catch { /* ignore */ }
      }
    }
    for (const p of plan.orphanTemps) {
      try {
        unlinkSync(p);
        report.tempFilesRemoved.push(p);
      } catch { /* ignore */ }
    }

    report.cachesPruned = [];
    for (const c of plan.cachePlans) {
      const result = pruneQueryCache(store, c.videoKey, { ttlMs, now, dryRun: false });
      if (result.wouldPrune > 0 || result.pruned > 0) {
        report.cachesPruned.push({ videoKey: c.videoKey, ...result });
      }
    }

    if (wantsAgeDelete && confirmDelete === true && !ageConfirmFail) {
      report.needsConfirmation = wantsTrash && !allowTrash ? true : false;
      for (const videoKey of plan.ageCandidates) {
        const r = store.remove(videoKey);
        if (r.removed) report.indexesRemoved.push(videoKey);
      }
    }
  }

  // trash：重新分类报告
  const trashWould = [];
  const trashRemoved = [];
  const trashPreserved = [];
  const trashFailed = [];

  for (const t of plan.trashAll) {
    if (allowTrash && t.eligible) {
      try {
        if (!t.videoKey || !liveManifestOk(store, t.videoKey)) {
          trashPreserved.push(t.path);
          continue;
        }
        rmSync(t.path, { recursive: true, force: true });
        if (existsSync(t.path)) {
          trashFailed.push(t.path);
          trashPreserved.push(t.path);
        } else {
          trashRemoved.push(t.path);
        }
      } catch {
        trashFailed.push(t.path);
        trashPreserved.push(t.path);
      }
    } else {
      trashPreserved.push(t.path);
      if (wantsTrash && t.eligible) trashWould.push(t.path);
    }
  }

  report.trashWouldRemove = trashWould;
  report.trashRemoved = trashRemoved;
  report.trashPreserved = trashPreserved;
  report.trashFailed = trashFailed;

  // dryRun 语义：本次未执行（或未获准执行）调用方请求的破坏性操作
  const requestedDestructive = wantsAgeDelete || wantsTrash || !dryRun;
  if (dryRun || ageBlocksAll || ageConfirmFail) {
    report.dryRun = true;
  } else if (wantsTrash && !allowTrash) {
    report.dryRun = true;
  } else if (allowMaintenance || allowTrash) {
    report.dryRun = false;
  } else {
    report.dryRun = true;
  }

  // 无 maxAge/trash 的普通 cleanup：执行后 dryRun=false
  if (allowMaintenance && !wantsAgeDelete && !wantsTrash && !dryRun) {
    report.dryRun = false;
  }

  // job temp / cancelled job 清理（不删活跃锁目录）
  if (allowMaintenance && jobsRoot && existsSync(jobsRoot)) {
    for (const name of readdirSync(jobsRoot)) {
      const p = join(jobsRoot, name);
      if (activeLocks.has(p)) continue;
      if (!name.endsWith('.json')) continue;
      try {
        const raw = readFileSyncSafe(p);
        const job = raw ? JSON.parse(raw) : null;
        if (!job) continue;
        const terminal = ['cancelled', 'failed'].includes(job.state);
        const age = now - (Date.parse(job.updatedAt || '') || 0);
        if (terminal && age >= jobTempTtlMs) {
          if (!dryRun) {
            try {
              unlinkSync(p);
              report.jobsCleaned.push(job.jobId || p);
            } catch { /* ignore */ }
          } else {
            report.jobsCleaned.push(job.jobId || p);
          }
        }
      } catch { /* ignore */ }
    }
  }

  // private embeddings 跟随精确 videoKey 删除（仅 age 确认删除时）
  if (allowMaintenance && wantsAgeDelete && confirmDelete && !ageConfirmFail) {
    for (const videoKey of report.indexesRemoved) {
      try {
        const priv = join(store.videoDir(videoKey), 'private');
        // remove() 已删整目录；此处记录意图
        report.privateCleared.push(videoKey);
        void priv;
      } catch { /* ignore */ }
    }
  }

  void requestedDestructive;
  return report;
}

function readFileSyncSafe(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
