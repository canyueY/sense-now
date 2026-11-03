/**
 * source-ref.js — 后台分块索引的安全媒体引用（无 cookie/token/签名 URL）。
 * 用于 resume、evidence/zoom、on-demand ASR 找回本地路径与外挂字幕。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, readJson } from './atomic-json.js';

export const SOURCE_REF_REL = 'chunks/source-ref.json';

/**
 * 从内存 descriptor 抽出可落盘字段；丢弃 cookie / 签名流 URL。
 */
export function sanitizeSourceRef({
  sourceMode = 'file',
  durationMs = null,
  sourceDescriptor = null,
  subtitlePath = null,
  analysisPolicy = undefined,
} = {}) {
  const d = sourceDescriptor && typeof sourceDescriptor === 'object' ? sourceDescriptor : {};
  const mediaPath = d.mediaPath || d.path || null;
  const subPath = subtitlePath || d.subtitlePath || null;
  return {
    layoutVersion: 'source-ref-v1',
    sourceMode: String(sourceMode || 'file'),
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    mediaPath: mediaPath ? String(mediaPath) : null,
    subtitlePath: subPath ? String(subPath) : null,
    // 仅保留非敏感指纹；禁止写入 cookie / token / 带签名的流地址
    contentFingerprint: d.contentFingerprint || d.fingerprint || null,
    bvid: d.bvid || null,
    partId: d.partId || null,
    webpageUrl: typeof d.webpageUrl === 'string' && !/[?&](sign|token|expires)=/i.test(d.webpageUrl)
      ? d.webpageUrl
      : null,
    hasSubtitleMap: Boolean(d.subtitleMap),
    subtitleCount: Array.isArray(d.subtitles) ? d.subtitles.length : 0,
    analysisPolicyPresent: analysisPolicy !== undefined,
  };
}

export function writeSourceRef(videoDir, ref, { clock = () => new Date().toISOString() } = {}) {
  if (!videoDir) throw new Error('videoDir required');
  mkdirSync(join(videoDir, 'chunks'), { recursive: true });
  const body = {
    ...ref,
    updatedAt: typeof clock === 'function' ? clock() : clock,
  };
  writeJsonAtomic(join(videoDir, SOURCE_REF_REL), body);
  return body;
}

export function readSourceRef(videoDir, { optional = true } = {}) {
  if (!videoDir) return optional ? null : (() => { throw new Error('videoDir required'); })();
  const path = join(videoDir, SOURCE_REF_REL);
  if (!existsSync(path)) {
    if (optional) return null;
    throw new Error('source-ref missing');
  }
  return readJson(path, { optional: true });
}

/**
 * 合并 indexOptions 到 descriptor（后台 job 入口用）。
 */
export function attachIndexOptionsToDescriptor(sourceDescriptor, indexOptions = {}) {
  const base = sourceDescriptor && typeof sourceDescriptor === 'object'
    ? { ...sourceDescriptor }
    : {};
  if (indexOptions?.subtitlePath) {
    base.subtitlePath = String(indexOptions.subtitlePath);
  }
  if (indexOptions?.cacheMedia === true) {
    base.cacheMedia = true;
  }
  return base;
}

/**
 * resume 时从落盘 ref 重建最小 descriptor（不含远程流 URL）。
 */
export function descriptorFromSourceRef(ref) {
  if (!ref) return null;
  return {
    mediaPath: ref.mediaPath || null,
    subtitlePath: ref.subtitlePath || null,
    contentFingerprint: ref.contentFingerprint || null,
    bvid: ref.bvid || null,
    partId: ref.partId || null,
    durationMs: ref.durationMs || null,
  };
}
