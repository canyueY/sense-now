/**
 * metered-media-proxy.js — 本机 ephemeral HTTP 代理，转发 Range 到 CDN 并累计下载字节。
 */

import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import {
  assertPublicHttpsUrl, assertSafeHeaders, isForbiddenResolvedAddress, DEFAULT_CDN_SUFFIXES,
} from './remote-media.js';

const FORWARD_REQ_HEADERS = new Set([
  'range', 'user-agent', 'referer', 'origin', 'accept', 'accept-encoding',
]);

/**
 * 启动仅绑定 127.0.0.1 的一次性代理。
 * @returns {{ localUrl, close, getDownloadedBytes, abort }}
 */
export async function startMeteredMediaProxy({
  upstreamUrl,
  headers = {},
  maxDownloadBytes = 64 * 1024 * 1024,
  maxRedirects = 3,
  allowSuffixes = DEFAULT_CDN_SUFFIXES,
  resolveDns = null,
  signal = null,
  onByte = null,
  /** 测试注入：({ url, headers }) => Promise<{statusCode, headers, stream}|{redirect}> */
  upstreamRequest = null,
  skipUrlAssert = false,
} = {}) {
  const safeHeaders = assertSafeHeaders(headers);
  let currentUrl = skipUrlAssert
    ? String(upstreamUrl)
    : assertPublicHttpsUrl(upstreamUrl, { allowSuffixes });
  const nonce = randomBytes(16).toString('hex');
  let downloaded = 0;
  let closed = false;
  let limitExceeded = false;
  let activeUpstream = null;
  const sockets = new Set();
  const onLimitListeners = new Set();

  function tripLimit() {
    if (limitExceeded) return;
    limitExceeded = true;
    for (const fn of onLimitListeners) {
      try { fn(downloaded); } catch { /* ignore */ }
    }
    onLimitListeners.clear();
  }

  async function resolveAndPin(hostname) {
    const lookup = resolveDns || ((host) => dns.promises.lookup(host, { all: true, verbatim: true })
      .then((list) => list.map((x) => x.address)));
    const addrs = await lookup(hostname);
    const list = Array.isArray(addrs) ? addrs : [addrs];
    assertPublicHttpsUrl(`https://${hostname}/`, { allowSuffixes, resolvedAddresses: list });
    const publicAddr = list.find((a) => !isForbiddenResolvedAddress(a));
    if (!publicAddr) {
      const err = new Error('no public resolved address');
      err.code = 'SSRF';
      throw err;
    }
    return publicAddr;
  }

  async function fetchUpstream(reqHeaders, res) {
    let redirects = 0;
    let url = currentUrl;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (closed) {
        res.destroy();
        return;
      }
      // Descriptor headers win (Bilibili CDN rejects Lavf UA); client only fills gaps such as Range.
      const outHeaders = {};
      for (const [k, v] of Object.entries(safeHeaders)) {
        outHeaders[k.toLowerCase()] = v;
      }
      for (const [k, v] of Object.entries(reqHeaders || {})) {
        const lk = k.toLowerCase();
        if (!FORWARD_REQ_HEADERS.has(lk) || v == null) continue;
        if (outHeaders[lk] == null) outHeaders[lk] = v;
      }

      let result;
      if (typeof upstreamRequest === 'function') {
        const r = await upstreamRequest({ url, headers: outHeaders });
        if (r.redirect) {
          result = { redirect: r.redirect, base: url };
        } else {
          result = { response: r.stream || r.response, code: r.statusCode || 200, headers: r.headers };
        }
      } else {
        const u = new URL(url);
        outHeaders.host = u.hostname;
        const pinnedIp = await resolveAndPin(u.hostname);
        result = await new Promise((resolve, reject) => {
          const opts = {
            protocol: 'https:',
            hostname: pinnedIp,
            servername: u.hostname,
            port: u.port || 443,
            path: `${u.pathname}${u.search}`,
            method: 'GET',
            headers: outHeaders,
            timeout: 60_000,
          };
          const up = https.request(opts, (upRes) => {
            const code = upRes.statusCode || 0;
            if (code >= 300 && code < 400 && upRes.headers.location) {
              upRes.resume();
              resolve({ redirect: upRes.headers.location, base: url });
              return;
            }
            resolve({ response: upRes, code });
          });
          activeUpstream = up;
          up.on('error', reject);
          up.on('timeout', () => {
            up.destroy();
            reject(Object.assign(new Error('upstream timeout'), { code: 'TIMEOUT' }));
          });
          up.end();
        });
      }

      if (result.redirect) {
        redirects += 1;
        if (redirects > maxRedirects) {
          const err = new Error('too many redirects');
          err.code = 'REDIRECT';
          throw err;
        }
        let next;
        try {
          next = new URL(result.redirect, result.base).href;
        } catch {
          const err = new Error('invalid redirect location');
          err.code = 'REDIRECT';
          throw err;
        }
        if (!skipUrlAssert) {
          url = assertPublicHttpsUrl(next, { allowSuffixes });
        } else {
          url = next;
        }
        currentUrl = url;
        continue;
      }

      const upRes = result.response;
      const passHeaders = {};
      const srcHeaders = result.headers || upRes.headers || {};
      for (const h of [
        'content-type', 'content-length', 'content-range', 'accept-ranges',
        'content-encoding', 'transfer-encoding',
      ]) {
        if (srcHeaders[h]) passHeaders[h] = srcHeaders[h];
      }
      res.writeHead(result.code || 200, passHeaders);
      upRes.on('data', (chunk) => {
        if (limitExceeded || closed) {
          try { upRes.destroy(); } catch { /* ignore */ }
          try { res.destroy(); } catch { /* ignore */ }
          return;
        }
        downloaded += chunk.length;
        onByte?.(downloaded);
        if (downloaded > maxDownloadBytes) {
          tripLimit();
          try { upRes.destroy(); } catch { /* ignore */ }
          try { res.destroy(); } catch { /* ignore */ }
          try { activeUpstream?.destroy(); } catch { /* ignore */ }
          // 永久终态：关闭代理，阻止 FFmpeg 后续 Range 重试
          close();
          return;
        }
        if (!res.write(chunk)) {
          upRes.pause();
          res.once('drain', () => upRes.resume());
        }
      });
      upRes.on('end', () => {
        try { res.end(); } catch { /* ignore */ }
      });
      upRes.on('error', () => {
        try { res.destroy(); } catch { /* ignore */ }
      });
      return;
    }
  }

  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    req.socket.on('close', () => sockets.delete(req.socket));
    if (limitExceeded) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'X-Error-Code': 'DOWNLOAD_LIMIT' });
      res.end('DOWNLOAD_LIMIT');
      return;
    }
    if (closed) {
      res.writeHead(503);
      res.end();
      return;
    }
    const path = req.url || '';
    if (!path.startsWith(`/${nonce}`)) {
      res.writeHead(404);
      res.end();
      return;
    }
    // 客户端不可改变目标 URL —— 忽略 query 中的任何 upstream 参数
    fetchUpstream(req.headers, res).catch((e) => {
      if (!res.headersSent) {
        const code = e.code === 'DOWNLOAD_LIMIT' ? 429
          : (e.code === 'SSRF' || e.code === 'BAD_URL' ? 403 : 502);
        res.writeHead(code, {
          'Content-Type': 'text/plain',
          ...(e.code === 'DOWNLOAD_LIMIT' ? { 'X-Error-Code': 'DOWNLOAD_LIMIT' } : {}),
        });
      }
      try { res.end(String(e.message || 'proxy error')); } catch { /* ignore */ }
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  const { port } = server.address();
  const localUrl = `http://127.0.0.1:${port}/${nonce}`;

  const onAbort = () => { close(); };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  function close() {
    if (closed) return;
    closed = true;
    try { activeUpstream?.destroy(); } catch { /* ignore */ }
    for (const s of sockets) {
      try { s.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
    try { server.close(); } catch { /* ignore */ }
    signal?.removeEventListener?.('abort', onAbort);
  }

  function abort() {
    close();
  }

  return {
    localUrl,
    port,
    nonce,
    close,
    abort,
    getDownloadedBytes: () => downloaded,
    isLimitExceeded: () => limitExceeded,
    onLimitExceeded(fn) {
      if (typeof fn !== 'function') return () => {};
      if (limitExceeded) {
        try { fn(downloaded); } catch { /* ignore */ }
        return () => {};
      }
      onLimitListeners.add(fn);
      return () => onLimitListeners.delete(fn);
    },
    get closed() { return closed; },
    get limitExceeded() { return limitExceeded; },
  };
}
