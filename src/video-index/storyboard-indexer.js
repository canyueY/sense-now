/**
 * storyboard-indexer.js — 订阅 pipeline observer，写出 Storyboard 单元与证据。
 * 不直接依赖 pipeline 写文件；由引擎喂入 keep/sheet 事件。
 */

import { contentHash, evidenceIdOf, frameIdOf, sceneIdOf } from './ids.js';
import { evidenceLogicalRef } from './paths.js';
import { signalsFromKeep } from './frame-gate.js';
import { validateStoryboardUnit, validateEvidenceRef } from './schema.js';

export function createStoryboardIndexer({
  videoKey,
  indexVersion,
  store,
  sourceSize = { width: 800, height: 450 },
  storedSize = null,
  clock = () => new Date().toISOString(),
}) {
  const stored = storedSize || { ...sourceSize };
  const units = [];
  const evidence = [];
  const sheetMap = [];

  function onKeep(event) {
    // event: { t, via, score, tier, buf?, width, height, subtitleChanged? }
    const timestampMs = Math.round((event.t || 0) * 1000);
    const reasons = signalsFromKeep({
      via: event.via,
      score: event.score,
      subtitleChanged: event.subtitleChanged,
    });
    if (event.via) reasons.push(event.via === 'cut' ? 'scene_change' : `via_${event.via}`);

    const buf = event.buf || Buffer.alloc(0);
    const ch = contentHash(buf.length ? buf : `${videoKey}:${timestampMs}:${event.via}`);
    const roi = {
      x: 0,
      y: 0,
      width: sourceSize.width,
      height: sourceSize.height,
    };
    const fid = frameIdOf({ videoKey, timestampMs, roi, contentHash: ch });
    const eid = evidenceIdOf({
      videoKey, kind: 'frame', startMs: timestampMs, endMs: timestampMs, contentHash: ch,
    });

    let sourceFile = null;
    if (buf.length && store) {
      sourceFile = `evidence/frames/${fid}.png`;
      // 调用方若已是 PNG 直接存；否则存 raw 标记（引擎侧应先 encode）
      if (event.png) store.writeBinary(videoKey, sourceFile, event.png);
      else if (event.storeRaw) store.writeBinary(videoKey, sourceFile, buf);
    }

    const scaleX = stored.width / sourceSize.width;
    const scaleY = stored.height / sourceSize.height;
    const unit = validateStoryboardUnit({
      frameId: fid,
      timestampMs,
      imageRef: evidenceLogicalRef(videoKey, 'frame', fid),
      sceneId: sceneIdOf({ videoKey, indexVersion, timestampMs }),
      sourceSize: { ...sourceSize },
      storedSize: { ...stored },
      roi,
      transform: { scaleX, scaleY, offsetX: 0, offsetY: 0 },
      selectionReasons: [...new Set(reasons)],
      evidenceIds: [eid],
    });
    units.push(unit);

    const ev = validateEvidenceRef({
      evidenceId: eid,
      kind: 'frame',
      startMs: timestampMs,
      endMs: timestampMs,
      ref: evidenceLogicalRef(videoKey, 'frame', fid),
      sourceFile,
      contentHash: ch,
      provenance: {
        adapter: 'storyboard-indexer',
        version: '1',
        generatedAt: clock(),
      },
    });
    evidence.push(ev);
    return { unit, evidence: ev };
  }

  function onSheet(sheet) {
    // sheet → frame 映射
    const map = {
      at: sheet.at,
      from: sheet.from,
      to: sheet.to,
      why: sheet.why,
      frameIds: (sheet.frames || []).map((f) => {
        const timestampMs = Math.round((f.t || 0) * 1000);
        const hit = units.find((u) => u.timestampMs === timestampMs);
        return hit?.frameId || null;
      }).filter(Boolean),
    };
    sheetMap.push(map);
    return map;
  }

  function result() {
    return {
      storyboardUnits: units,
      evidence,
      sheetMap,
    };
  }

  return { onKeep, onSheet, result, units, evidence };
}

/** 从字幕变化时间点生成额外 selection reason 辅助。 */
export function subtitleChangeAt(subtitles, timestampMs, windowMs = 500) {
  return (subtitles || []).some((s) => Math.abs((s.startMs || 0) - timestampMs) <= windowMs);
}
