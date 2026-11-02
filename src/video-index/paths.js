/**
 * paths.js — 索引根目录与路径安全（防穿越）。
 *
 * 逻辑 videoKey 可含冒号（如 file:hash:name.mp4）；落盘目录名把 `:` 换成 `=`，
 * 因为 Windows 不允许目录名含冒号。
 */

import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { dshHome } from '../chat.js';

export function videoIndexRoot(env = process.env, override = null) {
  if (override) return resolve(override);
  if (env.DSH_SENSE_VIDEO_INDEX) return resolve(env.DSH_SENSE_VIDEO_INDEX);
  // 兼容重命名前的配置；新配置优先。
  if (env.DSH_SEE_VIDEO_INDEX) return resolve(env.DSH_SEE_VIDEO_INDEX);
  return join(dshHome(env), 'sense-now', 'video-index');
}

/** 规范化逻辑 videoKey（可含冒号；禁止路径分隔与穿越）。 */
export function safeVideoKey(videoKey) {
  const s = String(videoKey || '').trim();
  if (!s) throw new Error('videoKey is required');
  if (s.includes('..') || s.includes('/') || s.includes('\\') || s.includes('\0')) {
    throw new Error(`unsafe videoKey: ${s}`);
  }
  if (!/^[\w.:\-]+$/i.test(s)) {
    throw new Error(`unsafe videoKey characters: ${s}`);
  }
  return s;
}

/** 逻辑 videoKey → 跨平台安全目录名。 */
export function encodeVideoKeyDir(videoKey) {
  return safeVideoKey(videoKey).replace(/:/g, '=');
}

/** 目录名 → 逻辑 videoKey。 */
export function decodeVideoKeyDir(dirName) {
  const s = String(dirName || '');
  if (s.includes('..') || s.includes('/') || s.includes('\\') || s.includes('\0')) {
    throw new Error(`unsafe dir name: ${dirName}`);
  }
  return s.replace(/=/g, ':');
}

/**
 * 解析位于索引根内的 video 目录。拒绝穿越与绝对路径注入。
 */
export function resolveVideoDir(rootDir, videoKey) {
  const root = resolve(rootDir);
  const dirName = encodeVideoKeyDir(videoKey);
  const target = resolve(root, dirName);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escape rejected for videoKey: ${videoKey}`);
  }
  if (rel.includes('..')) {
    throw new Error(`path escape rejected for videoKey: ${videoKey}`);
  }
  // 编码后目录名不得再引入分隔符
  if (dirName.includes('/') || dirName.includes('\\') || dirName.includes('..')) {
    throw new Error(`path escape rejected for videoKey: ${videoKey}`);
  }
  void sep;
  void normalize;
  return target;
}

/**
 * 解析索引内相对文件路径。禁止绝对路径与 `..`。
 */
export function resolveInside(videoDir, relativePath) {
  const base = resolve(videoDir);
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) {
    throw new Error(`path escape rejected: ${relativePath}`);
  }
  const target = resolve(base, rel);
  const r = relative(base, target);
  if (!r || r.startsWith('..') || isAbsolute(r)) {
    throw new Error(`path escape rejected: ${relativePath}`);
  }
  return target;
}

export function evidenceLogicalRef(videoKey, kind, id) {
  return `evidence://${safeVideoKey(videoKey)}/${kind}/${id}`;
}

export function defaultHomeHint() {
  return join(homedir(), '.dsh', 'sense-now', 'video-index');
}
