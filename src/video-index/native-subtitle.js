/**
 * native-subtitle.js — ffprobe 枚举内嵌字幕流 + ffmpeg 抽出文本轨。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnBounded } from './bounded-stdio.js';
import { parseSubtitleText } from './adapters/subtitle-adapter.js';

const TEXT_CODECS = new Set([
  'subrip', 'srt', 'webvtt', 'ass', 'ssa', 'mov_text', 'text', 'ttml',
]);
const BITMAP_CODECS = new Set([
  'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvdsub', 'xsub', 'dvb_subtitle',
]);

/**
 * @returns {{ streams: Array, textStreams: Array, bitmapStreams: Array }}
 */
export async function probeSubtitleStreams(mediaPath, {
  ffprobePath = 'ffprobe',
  signal,
  runner = null,
} = {}) {
  if (!mediaPath || !existsSync(mediaPath)) {
    return { streams: [], textStreams: [], bitmapStreams: [], ok: false, reason: 'enoent' };
  }
  const args = [
    '-v', 'quiet', '-print_format', 'json', '-show_streams',
    '-select_streams', 's',
    mediaPath,
  ];
  let raw;
  try {
    raw = runner
      ? await runner(args, { signal })
      : await spawnBounded(ffprobePath, args, { signal, timeoutMs: 60_000 });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { streams: [], textStreams: [], bitmapStreams: [], ok: false, reason: e.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.stdout || raw || '{}');
  } catch {
    return { streams: [], textStreams: [], bitmapStreams: [], ok: false, reason: 'invalid_json' };
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const textStreams = [];
  const bitmapStreams = [];
  for (const s of streams) {
    const codec = String(s.codec_name || '').toLowerCase();
    const row = {
      index: s.index,
      codec,
      language: s.tags?.language || s.tags?.LANGUAGE || null,
      title: s.tags?.title || null,
    };
    if (TEXT_CODECS.has(codec)) textStreams.push(row);
    else if (BITMAP_CODECS.has(codec)) bitmapStreams.push({ ...row, unsupportedText: true });
    else bitmapStreams.push({ ...row, unsupportedText: true });
  }
  return { streams, textStreams, bitmapStreams, ok: true };
}

/**
 * 抽出第一条可用文本字幕轨为 entries。
 */
export async function extractEmbeddedSubtitles(mediaPath, {
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  outDir,
  signal,
  language = null,
  runner = null,
  probeRunner = null,
} = {}) {
  const probe = await probeSubtitleStreams(mediaPath, {
    ffprobePath, signal, runner: probeRunner,
  });
  if (!probe.ok) {
    return {
      ok: false,
      reason: probe.reason || 'probe_failed',
      entries: [],
      capability: 'unavailable',
      bitmapUnsupported: probe.bitmapStreams || [],
    };
  }
  if (!probe.textStreams.length) {
    return {
      ok: false,
      reason: probe.bitmapStreams.length ? 'bitmap_only' : 'no_subtitle_stream',
      entries: [],
      capability: probe.bitmapStreams.length ? 'degraded' : 'unavailable',
      bitmapUnsupported: probe.bitmapStreams,
      skipToOcr: probe.bitmapStreams.length > 0,
    };
  }
  let pick = probe.textStreams[0];
  if (language) {
    const hit = probe.textStreams.find(
      (s) => String(s.language || '').toLowerCase().startsWith(String(language).toLowerCase()),
    );
    if (hit) pick = hit;
  }
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `native-${pick.index}.srt`);
  const args = [
    '-hide_banner', '-v', 'error', '-nostdin', '-y',
    '-i', mediaPath,
    '-map', `0:${pick.index}`,
    outPath,
  ];
  try {
    const r = runner
      ? await runner(args, { signal, outputPath: outPath })
      : await spawnBounded(ffmpegPath, args, { signal, timeoutMs: 180_000 });
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (r?.code != null && r.code !== 0 && !existsSync(outPath)) {
      return {
        ok: false,
        reason: 'extract_failed',
        entries: [],
        capability: 'degraded',
        detail: String(r.stderr || r.code).slice(0, 200),
        bitmapUnsupported: probe.bitmapStreams,
      };
    }
    if (!existsSync(outPath)) {
      return {
        ok: false, reason: 'no_output', entries: [], capability: 'degraded',
        bitmapUnsupported: probe.bitmapStreams,
      };
    }
    const raw = readFileSync(outPath, 'utf8');
    const entries = parseSubtitleText(raw, { ext: '.srt' }).map((e) => ({
      ...e,
      lang: pick.language,
      sourceType: 'native',
    }));
    try { unlinkSync(outPath); } catch { /* ignore */ }
    return {
      ok: entries.length > 0,
      entries,
      capability: entries.length ? 'ready' : 'degraded',
      stream: pick,
      bitmapUnsupported: probe.bitmapStreams,
    };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return {
      ok: false,
      reason: e.message,
      entries: [],
      capability: 'degraded',
      bitmapUnsupported: probe.bitmapStreams,
    };
  }
}
