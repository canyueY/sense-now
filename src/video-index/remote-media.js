/**
 * remote-media.js — 远程音频/帧范围提取（仅接受内部 stream descriptor）。
 * 域名 allowlist；拒绝裸 IP；受控 transport 计量真实下载字节。
 */

import {
  mkdirSync, existsSync, statSync, unlinkSync, createWriteStream, readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { spawnBounded, killProcessTree } from './bounded-stdio.js';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const DEFAULT_REMOTE_LIMITS = Object.freeze({
  maxDownloadBytes: 64 * 1024 * 1024,
  maxRuntimeMs: 180_000,
  maxRetries: 3,
  maxTempBytes: 128 * 1024 * 1024,
  maxRedirects: 3,
});

const DEFAULT_CDN_SUFFIXES = [
  '.bilivideo.com',
  '.bilivideo.cn',
  '.akamaized.net',
];

function hasControlChars(s) {
  return /[\u0000-\u001f\u007f]/.test(String(s || ''));
}

export function assertSafeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k);
    const val = String(v);
    if (hasControlChars(key) || hasControlChars(val) || /[\r\n]/.test(key + val)) {
      const err = new Error('header injection rejected');
      err.code = 'BAD_HEADER';
      throw err;
    }
    out[key] = val;
  }
  return out;
}

/**
 * 内部 stream URL：必须是 HTTPS 域名（非裸 IP）且匹配 CDN allowlist。
 */
export function assertPublicHttpsUrl(raw, {
  allowSuffixes = DEFAULT_CDN_SUFFIXES,
  resolvedAddresses = [],
} = {}) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    const err = new Error('invalid remote url');
    err.code = 'BAD_URL';
    throw err;
  }
  if (u.protocol !== 'https:') {
    const err = new Error('remote media must be https');
    err.code = 'BAD_URL';
    throw err;
  }
  if (u.username || u.password) {
    const err = new Error('remote url must not include credentials');
    err.code = 'BAD_URL';
    throw err;
  }
  if (u.hash || hasControlChars(u.href)) {
    const err = new Error('remote url contains forbidden characters');
    err.code = 'BAD_URL';
    throw err;
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    const err = new Error('localhost remote media forbidden');
    err.code = 'SSRF';
    throw err;
  }
  // 裸 IP（即使公网）一律拒绝 —— 必须走域名 allowlist
  if (isIP(host)) {
    const err = new Error('bare IP remote media forbidden; domain allowlist required');
    err.code = 'SSRF';
    throw err;
  }
  const ok = allowSuffixes.some((suf) => host === suf.replace(/^\./, '') || host.endsWith(suf));
  if (!ok) {
    const err = new Error(`remote host not allowed: ${host}`);
    err.code = 'SSRF';
    throw err;
  }
  for (const addr of resolvedAddresses || []) {
    if (isForbiddenResolvedAddress(addr)) {
      const err = new Error(`resolved address forbidden: ${addr}`);
      err.code = 'SSRF';
      throw err;
    }
  }
  u.hash = '';
  return u.href;
}

export function isPrivateIp(addr) {
  return isForbiddenResolvedAddress(addr);
}

export function isForbiddenResolvedAddress(addr) {
  const h = String(addr || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === '::1' || h === '0.0.0.0' || h === '::') return true;
  // IPv4-mapped IPv6
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isForbiddenResolvedAddress(mapped[1]);
  if (h.startsWith('fe80:') || h.startsWith('ff')) return true; // link-local / multicast
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA
  if (h.startsWith('2001:db8:')) return true; // documentation
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    // 非 IP 字符串在 resolvedAddresses 上下文视为非法
    return isIP(h) === 0 ? true : false;
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 192 && b === 0 && (c === 2)) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * 受控 HTTPS 下载（计量真实输入字节；校验每一跳 redirect）。
 * 生产默认路径：先下载到临时文件，再交给 FFmpeg 读本地 file:。
 */
export async function downloadWithBudget({
  url,
  headers = {},
  outPath,
  limits = {},
  signal,
  allowSuffixes = DEFAULT_CDN_SUFFIXES,
  resolveDns = null,
  transport = null,
} = {}) {
  const lim = { ...DEFAULT_REMOTE_LIMITS, ...limits };
  let current = assertPublicHttpsUrl(url, { allowSuffixes });
  const safeHeaders = assertSafeHeaders(headers);
  let redirects = 0;
  let downloaded = 0;

  while (redirects <= lim.maxRedirects) {
    if (resolveDns) {
      const addrs = await resolveDns(new URL(current).hostname);
      assertPublicHttpsUrl(current, { allowSuffixes, resolvedAddresses: addrs });
    } else {
      assertPublicHttpsUrl(current, { allowSuffixes });
    }

    if (transport) {
      const r = await transport({
        url: current,
        headers: safeHeaders,
        outPath,
        maxDownloadBytes: lim.maxDownloadBytes,
        signal,
      });
      if (r.redirectUrl) {
        redirects += 1;
        current = assertPublicHttpsUrl(r.redirectUrl, { allowSuffixes });
        continue;
      }
      if (r.downloaded > lim.maxDownloadBytes) {
        try { unlinkSync(outPath); } catch { /* ignore */ }
        const err = new Error('download exceeds maxDownloadBytes');
        err.code = 'DOWNLOAD_LIMIT';
        throw err;
      }
      return {
        ok: true,
        path: outPath,
        byteUsage: {
          downloaded: r.downloaded,
          temporaryPeak: r.downloaded,
          outputBytes: existsSync(outPath) ? statSync(outPath).size : 0,
        },
      };
    }

    const result = await nodeHttpsDownload({
      url: current,
      headers: safeHeaders,
      outPath,
      maxDownloadBytes: lim.maxDownloadBytes,
      signal,
      timeoutMs: lim.maxRuntimeMs,
    });
    if (result.redirectUrl) {
      redirects += 1;
      // 每一跳重新校验（裸 IP / 私网拒绝）
      current = assertPublicHttpsUrl(result.redirectUrl, { allowSuffixes });
      continue;
    }
    downloaded = result.downloaded;
    break;
  }
  if (redirects > lim.maxRedirects) {
    try { unlinkSync(outPath); } catch { /* ignore */ }
    const err = new Error('too many redirects');
    err.code = 'REDIRECT';
    throw err;
  }
  return {
    ok: true,
    path: outPath,
    byteUsage: {
      downloaded,
      temporaryPeak: downloaded,
      outputBytes: existsSync(outPath) ? statSync(outPath).size : 0,
    },
  };
}

function nodeHttpsDownload({
  url, headers, outPath, maxDownloadBytes, signal, timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(outPath), { recursive: true });
    const u = new URL(url);
    const reqFn = u.protocol === 'https:' ? httpsRequest : httpRequest;
    if (u.protocol !== 'https:') {
      const err = new Error('only https allowed');
      err.code = 'BAD_URL';
      reject(err);
      return;
    }
    let downloaded = 0;
    let settled = false;
    const req = reqFn({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { ...headers, Connection: 'close' },
      timeout: timeoutMs,
      // 不自动跟随 redirect —— 我们逐跳校验
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        settle({ redirectUrl: res.headers.location });
        return;
      }
      if (code !== 200) {
        res.resume();
        const err = new Error(`http ${code}`);
        err.code = 'HTTP';
        settleErr(err);
        return;
      }
      const ws = createWriteStream(outPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (downloaded > maxDownloadBytes) {
          res.destroy();
          ws.destroy();
          try { unlinkSync(outPath); } catch { /* ignore */ }
          const err = new Error('download exceeds maxDownloadBytes');
          err.code = 'DOWNLOAD_LIMIT';
          settleErr(err);
        }
      });
      res.pipe(ws);
      ws.on('finish', () => settle({ downloaded, redirectUrl: null }));
      ws.on('error', settleErr);
      res.on('error', settleErr);
    });
    req.on('error', settleErr);
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('download timeout');
      err.code = 'TIMEOUT';
      settleErr(err);
    });
    const onAbort = () => {
      req.destroy();
      try { unlinkSync(outPath); } catch { /* ignore */ }
      const err = new Error('aborted');
      err.name = 'AbortError';
      settleErr(err);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    req.end();

    function settle(v) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      resolve(v);
    }
    function settleErr(e) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      reject(e);
    }
  });
}

export async function extractAudioRange({
  descriptor,
  startMs,
  endMs,
  outWav,
  ffmpegPath = 'ffmpeg',
  limits = {},
  signal,
  runner = null,
  allowSuffixes = DEFAULT_CDN_SUFFIXES,
  resolveDns = null,
  transport = null,
  /** @deprecated 完整 GET 仅作显式小文件 fallback；生产默认 false → Range proxy */
  downloadToTemp = false,
  useMeteredProxy = null,
} = {}) {
  const lim = { ...DEFAULT_REMOTE_LIMITS, ...limits };
  if (!descriptor?.audio?.url) {
    const err = new Error('descriptor.audio.url required');
    err.code = 'NO_STREAM';
    throw err;
  }
  const url = assertPublicHttpsUrl(descriptor.audio.url, { allowSuffixes });
  const headers = assertSafeHeaders(descriptor.audio.headers || {});
  const durSec = Math.max(0.1, (Number(endMs) - Number(startMs)) / 1000);
  const ss = Math.max(0, Number(startMs) / 1000);
  mkdirSync(dirname(outWav), { recursive: true });

  const started = Date.now();
  let downloaded = 0;
  let inputForFfmpeg = url;
  let tempMedia = null;
  let proxy = null;
  const wantProxy = useMeteredProxy !== false && !downloadToTemp && !runner;

  const limitAbort = new AbortController();
  const onAbortForward = () => {
    try { limitAbort.abort(); } catch { /* ignore */ }
  };
  signal?.addEventListener?.('abort', onAbortForward, { once: true });
  const combinedSignal = limitAbort.signal;

  // 生产默认：本机 Range 计量代理（FFmpeg seek，不完整 GET）
  if (wantProxy) {
    const { startMeteredMediaProxy } = await import('./metered-media-proxy.js');
    proxy = await startMeteredMediaProxy({
      upstreamUrl: url,
      headers,
      maxDownloadBytes: lim.maxDownloadBytes,
      maxRedirects: lim.maxRedirects,
      allowSuffixes,
      resolveDns,
      signal: combinedSignal,
    });
    proxy.onLimitExceeded?.(() => {
      try { limitAbort.abort(); } catch { /* ignore */ }
    });
    inputForFfmpeg = proxy.localUrl;
  } else if (downloadToTemp && !runner) {
    // 显式小文件 fallback：完整 GET
    tempMedia = join(
      dirname(outWav),
      `.dl-${randomBytes(6).toString('hex')}.bin`,
    );
    const dl = await downloadWithBudget({
      url,
      headers,
      outPath: tempMedia,
      limits: lim,
      signal,
      allowSuffixes,
      resolveDns,
      transport,
    });
    downloaded = dl.byteUsage.downloaded;
    inputForFfmpeg = tempMedia;
  }

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-ss', String(ss),
    '-i', inputForFfmpeg,
    '-t', String(durSec),
    '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav',
    outWav,
  ];
  // 经 proxy 时 CDN headers 由 proxy 处理，不经 -headers 暴露给 FFmpeg stderr
  if (!tempMedia && !proxy && Object.keys(headers).length) {
    const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    args.splice(args.indexOf('-i'), 0, '-headers', headerLines);
  }

  const invoke = runner || ((file, a, opts) => spawnBounded(file, a, opts));
  let r;
  try {
    const invokeOpts = {
      signal: combinedSignal,
      timeoutMs: lim.maxRuntimeMs,
    };
    r = await invoke(ffmpegPath, args, invokeOpts);
    if (proxy) downloaded = proxy.getDownloadedBytes();
  } catch (e) {
    if (proxy) {
      downloaded = proxy.getDownloadedBytes();
      if (proxy.isLimitExceeded?.()) {
        try { unlinkSync(outWav); } catch { /* ignore */ }
        proxy.abort();
        const err = new Error('download exceeds maxDownloadBytes');
        err.code = 'DOWNLOAD_LIMIT';
        err.byteUsage = { downloaded, temporaryPeak: downloaded, outputBytes: 0 };
        throw err;
      }
      proxy.abort();
    }
    try { unlinkSync(outWav); } catch { /* ignore */ }
    throw e;
  } finally {
    signal?.removeEventListener?.('abort', onAbortForward);
    if (proxy) {
      try { proxy.close(); } catch { /* ignore */ }
    }
    if (tempMedia) {
      try { unlinkSync(tempMedia); } catch { /* ignore */ }
    }
  }
  if (proxy?.isLimitExceeded?.()) {
    try { unlinkSync(outWav); } catch { /* ignore */ }
    const err = new Error('download exceeds maxDownloadBytes');
    err.code = 'DOWNLOAD_LIMIT';
    err.byteUsage = { downloaded: proxy.getDownloadedBytes(), temporaryPeak: downloaded, outputBytes: 0 };
    throw err;
  }
  if (r.code !== 0) {
    try { unlinkSync(outWav); } catch { /* ignore */ }
    const err = new Error(`remote audio extract failed: ${r.stderr || r.code}`);
    err.code = 'FFMPEG';
    throw err;
  }
  if (!existsSync(outWav)) {
    const err = new Error('remote audio extract produced no file');
    err.code = 'FFMPEG';
    throw err;
  }
  const st = statSync(outWav);
  if (st.size > lim.maxTempBytes) {
    try { unlinkSync(outWav); } catch { /* ignore */ }
    const err = new Error('temporary audio exceeds maxTempBytes');
    err.code = 'TEMP_LIMIT';
    throw err;
  }
  // runner 注入路径：若提供 byteUsage.downloaded 则采用
  if (r.byteUsage?.downloaded != null) downloaded = r.byteUsage.downloaded;
  else if (runner && downloaded === 0) {
    // 测试 stub 未计量时不得把输出大小冒充下载字节
    downloaded = Number(r.downloadedBytes) || 0;
  } else if (proxy) {
    downloaded = proxy.getDownloadedBytes();
  }

  return {
    ok: true,
    path: outWav,
    byteUsage: {
      downloaded,
      temporaryPeak: Math.max(downloaded, st.size),
      outputBytes: st.size,
      runtimeMs: Date.now() - started,
    },
    viaProxy: Boolean(proxy || wantProxy),
  };
}

export async function extractFrameAt({
  descriptor,
  atMs,
  outPng,
  ffmpegPath = 'ffmpeg',
  limits = {},
  signal,
  runner = null,
  allowSuffixes = DEFAULT_CDN_SUFFIXES,
  resolveDns = null,
  transport = null,
  downloadToTemp = false,
  useMeteredProxy = null,
} = {}) {
  const lim = { ...DEFAULT_REMOTE_LIMITS, ...limits };
  if (!descriptor?.video?.url) {
    const err = new Error('descriptor.video.url required');
    err.code = 'NO_STREAM';
    throw err;
  }
  const url = assertPublicHttpsUrl(descriptor.video.url, { allowSuffixes });
  const headers = assertSafeHeaders(descriptor.video.headers || {});
  mkdirSync(dirname(outPng), { recursive: true });
  const ss = Math.max(0, Number(atMs) / 1000);

  let downloaded = 0;
  let inputForFfmpeg = url;
  let tempMedia = null;
  let proxy = null;
  const wantProxy = useMeteredProxy !== false && !downloadToTemp && !runner;
  if (wantProxy) {
    const { startMeteredMediaProxy } = await import('./metered-media-proxy.js');
    proxy = await startMeteredMediaProxy({
      upstreamUrl: url,
      headers,
      maxDownloadBytes: lim.maxDownloadBytes,
      maxRedirects: lim.maxRedirects,
      allowSuffixes,
      resolveDns,
      signal,
    });
    inputForFfmpeg = proxy.localUrl;
  } else if (downloadToTemp && !runner) {
    tempMedia = join(dirname(outPng), `.dl-${randomBytes(6).toString('hex')}.bin`);
    const dl = await downloadWithBudget({
      url, headers, outPath: tempMedia, limits: lim, signal, allowSuffixes, resolveDns, transport,
    });
    downloaded = dl.byteUsage.downloaded;
    inputForFfmpeg = tempMedia;
  }

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-ss', String(ss),
    '-i', inputForFfmpeg,
    '-frames:v', '1',
    '-f', 'image2',
    outPng,
  ];
  if (!tempMedia && !proxy && Object.keys(headers).length) {
    const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    args.splice(args.indexOf('-i'), 0, '-headers', headerLines);
  }
  const invoke = runner || ((file, a, opts) => spawnBounded(file, a, opts));
  let r;
  try {
    r = await invoke(ffmpegPath, args, { signal, timeoutMs: lim.maxRuntimeMs });
    if (proxy) downloaded = proxy.getDownloadedBytes();
  } finally {
    if (proxy) {
      try { proxy.close(); } catch { /* ignore */ }
    }
    if (tempMedia) {
      try { unlinkSync(tempMedia); } catch { /* ignore */ }
    }
  }
  if (r.code !== 0 || !existsSync(outPng)) {
    const err = new Error(`remote frame extract failed: ${r.stderr || r.code}`);
    err.code = 'FFMPEG';
    throw err;
  }
  const st = statSync(outPng);
  if (r.byteUsage?.downloaded != null) downloaded = r.byteUsage.downloaded;
  else if (runner && downloaded === 0) downloaded = Number(r.downloadedBytes) || 0;
  else if (proxy) downloaded = proxy.getDownloadedBytes();
  return {
    ok: true,
    path: outPng,
    byteUsage: {
      downloaded,
      temporaryPeak: Math.max(downloaded, st.size),
      outputBytes: st.size,
    },
    viaProxy: Boolean(proxy || wantProxy),
  };
}

export function assertRedirectTargetAllowed(url, opts) {
  return assertPublicHttpsUrl(url, opts);
}

export { DEFAULT_CDN_SUFFIXES, killProcessTree };
