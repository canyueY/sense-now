/**
 * subtitle-download.js — 受控下载 B站/平台字幕 URL（HTTPS、字节顶、超时、DNS 校验）。
 */

import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { URL } from 'node:url';
import { parseSubtitleText } from './adapters/subtitle-adapter.js';
import { isForbiddenResolvedAddress } from './remote-media.js';

function finiteSec(v) {
  const n = Number(v);
  return Number.isFinite(n) && !Number.isNaN(n) ? n : null;
}

/** B站字幕 cue 时间：优先 to/end，其次 dur/duration。 */
export function bilibiliCueTimes(line = {}) {
  const startSec = finiteSec(line.start) ?? finiteSec(line.from) ?? 0;
  let endSec;
  if (finiteSec(line.to) != null) endSec = finiteSec(line.to);
  else if (finiteSec(line.end) != null) endSec = finiteSec(line.end);
  else if (finiteSec(line.dur) != null) endSec = startSec + finiteSec(line.dur);
  else if (finiteSec(line.duration) != null) endSec = startSec + finiteSec(line.duration);
  else endSec = startSec;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;
  const startMs = Math.max(0, Math.round(startSec * 1000));
  const endMs = Math.max(startMs, Math.round(endSec * 1000));
  return { startMs, endMs };
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

const ALLOWED_HOST_SUFFIXES = [
  '.bilibili.com',
  '.bilivideo.com',
  '.hdslb.com',
  'bilibili.com',
];

export function assertSafeSubtitleUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch {
    const err = new Error('invalid subtitle url');
    err.code = 'URL';
    throw err;
  }
  if (u.protocol !== 'https:') {
    const err = new Error('subtitle url must be https');
    err.code = 'URL';
    throw err;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.includes(':')) {
    const err = new Error('bare IP subtitle url rejected');
    err.code = 'URL';
    throw err;
  }
  const host = u.hostname.toLowerCase();
  const ok = ALLOWED_HOST_SUFFIXES.some(
    (s) => host === s.replace(/^\./, '') || host.endsWith(s),
  );
  if (!ok) {
    const err = new Error(`subtitle host not allowed: ${host}`);
    err.code = 'URL';
    throw err;
  }
  // 不把 query（可能含签名）返回给调用方的 model 层
  return {
    href: u.href,
    origin: u.origin,
    pathname: u.pathname,
    host,
  };
}

const ALLOWED_CONTENT_TYPES = [
  'application/json',
  'text/plain',
  'text/vtt',
  'text/srt',
  'application/x-subrip',
  'application/octet-stream',
];

const REJECT_CONTENT_TYPES = [
  'image/', 'video/', 'audio/', 'application/zip', 'application/gzip',
  'application/x-tar', 'application/pdf', 'text/html',
];

export function assertAllowedSubtitleContentType(ctype) {
  const c = String(ctype || '').toLowerCase().split(';')[0].trim();
  if (!c) return true; // 部分 CDN 省略
  if (REJECT_CONTENT_TYPES.some((p) => c.startsWith(p) || c === p.replace(/\/$/, ''))) {
    const err = new Error('subtitle content-type rejected');
    err.code = 'CONTENT_TYPE';
    throw err;
  }
  if (ALLOWED_CONTENT_TYPES.some((a) => c === a || c.startsWith(`${a}+`))) return true;
  // 宽松：text/* 字幕相关
  if (c.startsWith('text/')) return true;
  const err = new Error('subtitle content-type not allowed');
  err.code = 'CONTENT_TYPE';
  throw err;
}

export async function assertSubtitleHostPublic(hostname, { resolveDns = dnsLookup } = {}) {
  const host = String(hostname || '').toLowerCase();
  let addrs;
  try {
    const r = await resolveDns(host, { all: true });
    addrs = Array.isArray(r) ? r.map((x) => x.address || x) : [r];
  } catch (e) {
    const err = new Error(`subtitle dns failed: ${e.message}`);
    err.code = 'DNS';
    throw err;
  }
  for (const addr of addrs) {
    if (isForbiddenResolvedAddress(addr)) {
      const err = new Error('subtitle resolved to forbidden address');
      err.code = 'SSRF';
      throw err;
    }
  }
  return addrs;
}

function fetchOnce(url, { signal, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const req = httpsRequest({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Accept: 'text/plain,text/vtt,application/json,application/x-subrip,*/*',
        'User-Agent': 'sense-now-subtitle/1',
      },
      timeout: timeoutMs,
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        if (!settled) {
          settled = true;
          cleanup();
          resolve({ redirect: res.headers.location, statusCode: code });
        }
        res.resume();
        return;
      }
      const ctype = String(res.headers['content-type'] || '');
      const chunks = [];
      let size = 0;
      let overLimit = false;
      res.on('data', (c) => {
        if (overLimit || settled) return;
        size += c.length;
        if (size > maxBytes) {
          overLimit = true;
          req.destroy();
          if (!settled) {
            settled = true;
            cleanup();
            reject(Object.assign(new Error('subtitle download over byte limit'), { code: 'LIMIT' }));
          }
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (overLimit) return;
        resolve({
          statusCode: code,
          contentType: ctype,
          body: Buffer.concat(chunks),
        });
      });
    });
    const cleanup = () => {
      signal?.removeEventListener?.('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(Object.assign(new Error('subtitle download timeout'), { code: 'TIMEOUT' }));
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    req.end();
  });
}

export async function downloadSubtitleUrl(url, {
  signal,
  language = null,
  resolveDns = dnsLookup,
} = {}) {
  let current = assertSafeSubtitleUrl(url).href;
  const failedUrls = new Set();
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (failedUrls.has(current)) {
      const err = new Error('subtitle url already failed byte limit');
      err.code = 'LIMIT';
      throw err;
    }
    const safe = assertSafeSubtitleUrl(current);
    await assertSubtitleHostPublic(safe.host, { resolveDns });
    let res;
    try {
      res = await fetchOnce(current, { signal });
    } catch (e) {
      if (e.code === 'LIMIT') failedUrls.add(current);
      throw e;
    }
    if (res.redirect) {
      // 相对重定向：相对当前 URL 解析后再完整校验
      const next = new URL(res.redirect, current).href;
      current = assertSafeSubtitleUrl(next).href;
      continue;
    }
    if (res.statusCode !== 200) {
      const err = new Error(`subtitle http ${res.statusCode}`);
      err.code = 'HTTP';
      throw err;
    }
    assertAllowedSubtitleContentType(res.contentType);
    const text = res.body.toString('utf8');
    // JSON bilibili 格式：[{from,to,content}] 或 {body:[{from,to,content}]}
    if (/^\s*[\[{]/.test(text)) {
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : (j.body || j.data || []);
        if (Array.isArray(arr)) {
          return arr.map((line) => {
            const times = bilibiliCueTimes(line);
            if (!times) return null;
            return {
              startMs: times.startMs,
              endMs: times.endMs,
              text: String(line.content || line.text || '').trim(),
              lang: language,
              sourceType: 'bilibili',
            };
          }).filter((s) => s?.text);
        }
      } catch { /* fall through to text parse */ }
    }
    const pathOnly = safe.pathname.toLowerCase();
    const ext = pathOnly.endsWith('.vtt') ? '.vtt'
      : pathOnly.endsWith('.ass') ? '.ass'
        : pathOnly.endsWith('.ssa') ? '.ssa'
          : '.srt';
    return parseSubtitleText(text, { ext }).map((e) => ({
      ...e,
      lang: language,
      sourceType: 'bilibili',
    }));
  }
  const err = new Error('too many redirects');
  err.code = 'REDIRECT';
  throw err;
}

/**
 * 规范化 yt-dlp 字幕 map：支持 data 内嵌与 url 列表。
 */
export async function materializeYtSubtitles(map, {
  signal,
  preferredLangs = ['zh-CN', 'zh-Hans', 'zh', 'ai-zh', 'en'],
  fetchUrl = downloadSubtitleUrl,
} = {}) {
  const out = [];
  const entries = Object.entries(map || {});
  // 语言优先
  entries.sort(([a], [b]) => {
    const ia = preferredLangs.findIndex((l) => a.toLowerCase().startsWith(l.toLowerCase()));
    const ib = preferredLangs.findIndex((l) => b.toLowerCase().startsWith(l.toLowerCase()));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const [lang, list] of entries) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.data && Array.isArray(item.data)) {
        for (const line of item.data) {
          const text = String(line.text || line.content || '').trim();
          if (!text) continue;
          const times = bilibiliCueTimes(line);
          if (!times) continue;
          out.push({
            lang,
            startMs: times.startMs,
            endMs: times.endMs,
            text,
            sourceType: 'bilibili',
          });
        }
        if (out.length) return out;
      }
      if (item?.url) {
        try {
          const rows = await fetchUrl(item.url, { signal, language: lang });
          if (rows?.length) return rows;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          // 尝试下一条
        }
      }
    }
  }
  return out.filter((s) => s.text);
}
