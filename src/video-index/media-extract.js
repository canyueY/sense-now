/**
 * media-extract.js — 索引侧媒体辅助（与实时 capture.js 的 -an 管线分离）。
 * 仅在 video-index 需要 ASR / 缓存媒体时调用；使用参数数组，禁止 shell 拼接。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnBounded } from './bounded-stdio.js';
import { assertSafeBilibiliUrl } from './url-allowlist.js';

/**
 * 从视频抽出单声道 wav，供外部 ASR。可注入 runner 做假命令测试。
 */
export function extractAudioWav({
  inputPath,
  outputPath,
  ffmpegPath = 'ffmpeg',
  signal,
  timeoutMs = 120_000,
  runner = null,
  startMs = null,
  endMs = null,
} = {}) {
  if (!inputPath || !existsSync(inputPath)) {
    const err = new Error(`media not found: ${inputPath}`);
    err.code = 'ENOENT';
    return Promise.reject(err);
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const args = [
    '-hide_banner', '-v', 'error', '-nostdin', '-y',
  ];
  if (startMs != null && Number.isFinite(Number(startMs))) {
    args.push('-ss', String(Math.max(0, Number(startMs) / 1000)));
  }
  args.push('-i', inputPath);
  if (endMs != null && startMs != null && Number.isFinite(Number(endMs))) {
    const dur = Math.max(0.05, (Number(endMs) - Number(startMs)) / 1000);
    args.push('-t', String(dur));
  }
  args.push(
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    outputPath,
  );
  const finish = (r) => {
    if (r && r.code != null && r.code !== 0) {
      const err = new Error(`ffmpeg audio extract failed: ${r.stderr || r.code}`);
      err.code = 'FFMPEG';
      throw err;
    }
    if (!existsSync(outputPath)) {
      throw new Error('ffmpeg produced no audio file');
    }
    return { ok: true, path: outputPath };
  };
  if (runner) {
    return Promise.resolve(runner([ffmpegPath, ...args], { signal, timeoutMs, outputPath }))
      .then(finish);
  }
  return runSpawn(ffmpegPath, args, { signal, timeoutMs }).then(finish);
}

/**
 * 用 yt-dlp 下载到指定模板路径。仅参数数组。
 */
export function downloadMediaWithYtDlp({
  url,
  outputTemplate,
  ytdlpPath = 'yt-dlp',
  cookiesFile = null,
  cookiesFromBrowser = null,
  signal,
  timeoutMs = 600_000,
  runner = null,
} = {}) {
  const safeUrl = assertSafeBilibiliUrl(url);
  mkdirSync(dirname(outputTemplate), { recursive: true });
  const args = [
    '--no-playlist',
    '--max-redirects', '5',
    '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
    '-o', outputTemplate,
    '--merge-output-format', 'mp4',
  ];
  if (cookiesFile) args.push('--cookies', cookiesFile);
  else if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  args.push(safeUrl);

  const finish = (r) => {
    if (r && r.code != null && r.code !== 0) {
      const err = new Error(`yt-dlp download failed: ${r.stderr || r.code}`);
      err.code = 'YTDLP';
      throw err;
    }
    return { ok: true, stdout: r?.stdout || '', stderr: r?.stderr || '' };
  };
  if (runner) {
    return Promise.resolve(runner([ytdlpPath, ...args], { signal, timeoutMs, outputTemplate }))
      .then(finish);
  }
  return runSpawn(ytdlpPath, args, { signal, timeoutMs }).then(finish);
}

export function defaultCacheMediaPath(videoDir, basename = 'source.mp4') {
  return join(videoDir, 'evidence', 'media', basename);
}

/**
 * 用 ffprobe 探测时长（毫秒）；不下载整片。可注入 runner。
 */
export async function probeMediaDurationMs(inputPath, {
  ffmpegPath = 'ffprobe',
  signal,
  timeoutMs = 30_000,
  runner = null,
} = {}) {
  if (!inputPath) return null;
  const bin = String(ffmpegPath).includes('ffprobe') ? ffmpegPath : 'ffprobe';
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ];
  const invoke = runner || ((file, a, opts) => spawnBounded(file, a, opts));
  try {
    const r = await invoke(bin, args, { signal, timeoutMs });
    if (r.code !== 0) return null;
    const sec = Number(String(r.stdout || '').trim());
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return Math.round(sec * 1000);
  } catch {
    return null;
  }
}

export function defaultCacheAudioPath(videoDir, basename = 'audio.wav') {
  return join(videoDir, 'evidence', 'audio', basename);
}

function runSpawn(file, args, { signal, timeoutMs } = {}) {
  return spawnBounded(file, args, { signal, timeoutMs });
}
