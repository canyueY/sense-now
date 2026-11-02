/**
 * bilibili-source.js — 可配置 yt-dlp CLI 适配器。禁止 shell 拼接；测试注入 runner。
 * URL 仅允许 bilibili.com HTTPS（拒绝 b23.tv 短链）；并校验结果 webpage_url。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizePartId, videoKeyOf, contentHash, extractBilibiliId } from '../ids.js';
import { normalizeSourceResult } from './source-adapter.js';
import { assertSafeBilibiliUrl, assertSafeBilibiliResultUrl } from '../url-allowlist.js';
import { spawnBounded } from '../bounded-stdio.js';

export function resolveYtDlpPath({ explicit = null, env = process.env } = {}) {
  return explicit || env.DSH_YTDLP_PATH || 'yt-dlp';
}

/**
 * @param {{
 *   ytdlpPath?: string,
 *   runner?: (args: string[], opts) => Promise<{ stdout: string, stderr: string, code: number }>,
 *   clock?: () => string,
 *   cookiesFromBrowser?: string|null,
 *   cookiesFile?: string|null,
 * }} opts
 */
export function createBilibiliSource(opts = {}) {
  const {
    ytdlpPath = null,
    runner = null,
    clock = () => new Date().toISOString(),
    cookiesFromBrowser = null,
    cookiesFile = null,
    env = process.env,
  } = opts;

  const bin = resolveYtDlpPath({ explicit: ytdlpPath, env });

  async function run(args, { signal, timeoutMs = 60_000 } = {}) {
    if (runner) return runner(args, { signal, timeoutMs });
    return spawnBounded(bin, args, { signal, timeoutMs });
  }

  return {
    name: 'bilibili-source',
    version: '1',
    async available() {
      try {
        const r = await run(['--version'], { timeoutMs: 10_000 });
        if (r.code !== 0) {
          return {
            ok: false,
            reason: 'unavailable',
            detail: `yt-dlp exited ${r.code}`,
            hint: 'Install yt-dlp or set DSH_YTDLP_PATH',
          };
        }
        return { ok: true, version: String(r.stdout || '').trim() };
      } catch (e) {
        return {
          ok: false,
          reason: 'unavailable',
          detail: e.message,
          hint: 'Install yt-dlp or set DSH_YTDLP_PATH; file source still works',
        };
      }
    },

    async resolve(source, { signal, downloadMedia = false, cachePath = null } = {}) {
      const avail = await this.available();
      if (!avail.ok) {
        const err = new Error(`bilibili source unavailable: ${avail.detail}`);
        err.code = 'UNAVAILABLE';
        err.hint = avail.hint;
        throw err;
      }

      const url = assertSafeBilibiliUrl(source.url || source.uri || '');
      const partId = normalizePartId(source.partId || 'p1');
      const args = [
        '--dump-single-json',
        '--skip-download',
        '--no-playlist',
      ];
      if (cookiesFile) {
        args.push('--cookies', cookiesFile);
      } else if (cookiesFromBrowser) {
        args.push('--cookies-from-browser', cookiesFromBrowser);
      }
      args.push(url);

      const r = await run(args, { signal });
      if (signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      if (r.code !== 0) {
        const err = new Error(`yt-dlp failed: ${r.stderr || r.stdout || r.code}`);
        err.code = 'YTDLP';
        throw err;
      }

      let meta;
      try {
        meta = JSON.parse(r.stdout);
      } catch (e) {
        const err = new Error(`invalid yt-dlp json: ${e.message}`);
        err.code = 'INVALID_JSON';
        throw err;
      }

      // 结果 URL 必须仍在白名单（防重定向到内网/任意站）
      const webpage = assertSafeBilibiliResultUrl(meta.webpage_url || url);
      const bvid = extractBilibiliId(meta.id || meta.display_id || webpage || url);
      const videoKey = videoKeyOf({ kind: 'bilibili', url: webpage, bvid, partId });
      const subtitles = normalizeYtSubtitles(meta.subtitles || meta.automatic_captions || {});
      const fingerprint = contentHash(JSON.stringify({
        id: meta.id,
        duration: meta.duration,
        title: meta.title,
        partId,
      }));

      let mediaRef = {
        kind: 'bilibili',
        url: webpage,
        cached: false,
        path: null,
        downloadRequested: false,
      };

      if (downloadMedia && cachePath) {
        mkdirSync(dirname(cachePath), { recursive: true });
        const dlArgs = [
          '--no-playlist',
          '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
          '-o', cachePath,
          '--merge-output-format', 'mp4',
        ];
        if (cookiesFile) dlArgs.push('--cookies', cookiesFile);
        else if (cookiesFromBrowser) dlArgs.push('--cookies-from-browser', cookiesFromBrowser);
        dlArgs.push(webpage);
        const dl = await run(dlArgs, { signal, timeoutMs: 600_000 });
        if (signal?.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        if (dl.code !== 0) {
          const err = new Error(`yt-dlp download failed: ${dl.stderr || dl.code}`);
          err.code = 'YTDLP_DOWNLOAD';
          throw err;
        }
        mediaRef = {
          kind: 'bilibili',
          url: webpage,
          cached: true,
          path: cachePath,
          downloadRequested: true,
        };
      } else if (downloadMedia) {
        mediaRef.downloadRequested = true;
      }

      return normalizeSourceResult({
        videoKey,
        metadata: {
          title: meta.title || null,
          uploader: meta.uploader || meta.channel || null,
          durationMs: meta.duration != null ? Math.round(meta.duration * 1000) : null,
          bvid,
          webpage_url: webpage,
          description: typeof meta.description === 'string'
            ? meta.description.slice(0, 2000)
            : null,
        },
        parts: [{ partId, title: meta.title || partId }],
        subtitles,
        subtitleMap: meta.subtitles || meta.automatic_captions || {},
        mediaRef,
        fingerprint,
        provenance: {
          adapter: 'bilibili-source',
          version: '1',
          generatedAt: clock(),
          ytdlp: avail.version || null,
        },
      });
    },

    /**
     * 解析流地址到内存 descriptor（不落盘、不含 cookie）。
     * 公开工具不得直接传 CDN URL；仅通过本方法创建 descriptor。
     */
    async resolveStreams(source, { signal } = {}) {
      const avail = await this.available();
      if (!avail.ok) {
        const err = new Error(`bilibili source unavailable: ${avail.detail}`);
        err.code = 'UNAVAILABLE';
        err.hint = avail.hint;
        throw err;
      }

      const url = assertSafeBilibiliUrl(source.url || source.uri || '');
      const partId = normalizePartId(source.partId || 'p1');
      const args = [
        '--dump-single-json',
        '--skip-download',
        '--no-playlist',
      ];
      if (cookiesFile) args.push('--cookies', cookiesFile);
      else if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
      args.push(url);

      const r = await run(args, { signal });
      if (signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      if (r.code !== 0) {
        const err = new Error(`yt-dlp failed: ${r.stderr || r.stdout || r.code}`);
        err.code = 'YTDLP';
        throw err;
      }

      let meta;
      try {
        meta = JSON.parse(r.stdout);
      } catch (e) {
        const err = new Error(`invalid yt-dlp json: ${e.message}`);
        err.code = 'INVALID_JSON';
        throw err;
      }

      const webpage = assertSafeBilibiliResultUrl(meta.webpage_url || url);
      const bvid = extractBilibiliId(meta.id || meta.display_id || webpage || url);
      const cid = meta.cid != null ? String(meta.cid) : null;
      const durationMs = meta.duration != null ? Math.round(meta.duration * 1000) : null;
      const formats = Array.isArray(meta.formats) ? meta.formats : [];
      const audioFmt = pickAudioFormat(formats);
      const videoFmt = pickLowVideoFormat(formats);
      if (!audioFmt?.url && !videoFmt?.url) {
        const err = new Error('no usable audio/video format in yt-dlp json');
        err.code = 'NO_STREAM';
        throw err;
      }

      const now = Date.now();
      const httpHeaders = sanitizeStreamHeaders(meta.http_headers || {});
      const contentFingerprint = contentHash(JSON.stringify({
        id: meta.id,
        cid,
        partId,
        duration: meta.duration,
        audio: audioFmt?.format_id,
        video: videoFmt?.format_id,
      }));

      // 内存短生命周期；调用方不得写入 manifest/state/cache/log
      return {
        webpageUrl: webpage,
        bvid,
        cid,
        partId,
        durationMs,
        resolvedAt: now,
        expiresAt: now + 30 * 60_000,
        audio: audioFmt ? {
          url: audioFmt.url,
          formatId: String(audioFmt.format_id || ''),
          ext: String(audioFmt.ext || 'm4a'),
          headers: { ...httpHeaders, ...sanitizeStreamHeaders(audioFmt.http_headers) },
        } : null,
        video: videoFmt ? {
          url: videoFmt.url,
          formatId: String(videoFmt.format_id || ''),
          width: Number(videoFmt.width) || null,
          height: Number(videoFmt.height) || null,
          headers: { ...httpHeaders, ...sanitizeStreamHeaders(videoFmt.http_headers) },
        } : null,
        subtitles: normalizeYtSubtitles(meta.subtitles || meta.automatic_captions || {}),
        subtitleMap: meta.subtitles || meta.automatic_captions || {},
        contentFingerprint,
      };
    },
  };
}

function sanitizeStreamHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k);
    const val = String(v);
    if (/[\u0000-\u001f\u007f]/.test(key + val) || /[\r\n]/.test(key + val)) continue;
    // 不保留 cookie/authorization
    if (/^(cookie|authorization|set-cookie)$/i.test(key)) continue;
    out[key] = val;
  }
  return out;
}

function pickAudioFormat(formats) {
  const audioOnly = formats.filter((f) => f?.url && (f.vcodec === 'none' || !f.vcodec)
    && f.acodec && f.acodec !== 'none');
  if (audioOnly.length) {
    return audioOnly.sort((a, b) => (Number(a.abr) || 0) - (Number(b.abr) || 0))[0];
  }
  return formats.find((f) => f?.url && f.acodec && f.acodec !== 'none') || null;
}

function pickLowVideoFormat(formats) {
  const vids = formats.filter((f) => f?.url && f.vcodec && f.vcodec !== 'none'
    && Number(f.height) > 0);
  if (!vids.length) return formats.find((f) => f?.url && f.vcodec && f.vcodec !== 'none') || null;
  return vids.sort((a, b) => (Number(a.height) || 9999) - (Number(b.height) || 9999))[0];
}

function normalizeYtSubtitles(map) {
  const out = [];
  for (const [lang, list] of Object.entries(map || {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.data && Array.isArray(item.data)) {
        for (const line of item.data) {
          out.push({
            lang,
            startMs: Math.round((line.start ?? line.from ?? 0) * 1000),
            endMs: Math.round(
              line.to != null
                ? Number(line.to) * 1000
                : ((line.start ?? line.from ?? 0) + (line.dur || 0)) * 1000,
            ),
            text: String(line.text || line.content || '').trim(),
            sourceType: 'bilibili',
          });
        }
      }
      // URL-only 条目保留占位，供 subtitle-coordinator 物化；不把签名 URL 写入 text
      if (item?.url && !item?.data) {
        out.push({
          lang,
          startMs: 0,
          endMs: 0,
          text: '',
          sourceType: 'bilibili',
          _urlPending: true,
          // 仅内部使用；对外 sanitize 时剥掉
          _subtitleUrl: item.url,
        });
      }
    }
  }
  return out.filter((s) => s.text || s._urlPending);
}
