import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMeteredMediaProxy } from '../src/video-index/metered-media-proxy.js';
import { extractAudioRange, assertPublicHttpsUrl } from '../src/video-index/remote-media.js';

test('R5: proxy 发出 Range、支持 206、累计字节、超限中止、abort 关端口', async () => {
  const full = Buffer.alloc(256 * 1024, 7);
  const seenRanges = [];
  let redirects = 0;

  const proxy = await startMeteredMediaProxy({
    upstreamUrl: 'https://upos-sz-mirrorcos.bilivideo.com/big.bin',
    maxDownloadBytes: 8 * 1024,
    skipUrlAssert: true,
    upstreamRequest: async ({ url, headers }) => {
      if (url.includes('redir')) {
        redirects += 1;
        return { redirect: 'https://upos-sz-mirrorcos.bilivideo.com/big.bin' };
      }
      if (url.includes('8.8.8.8') || /^https?:\/\/\d+\.\d+\./.test(url)) {
        const err = new Error('bare IP forbidden');
        err.code = 'SSRF';
        throw err;
      }
      const range = headers.range || headers.Range;
      if (range) seenRanges.push(range);
      let start = 0;
      let end = full.length - 1;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : Math.min(start + 4095, full.length - 1);
      }
      const slice = full.subarray(start, end + 1);
      return {
        statusCode: range ? 206 : 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${start + slice.length - 1}/${full.length}`,
          'accept-ranges': 'bytes',
        },
        stream: Readable.from([slice]),
      };
    },
  });

  try {
    // Range 请求
    const body = await new Promise((resolve, reject) => {
      http.get(proxy.localUrl, { headers: { Range: 'bytes=0-1023' } }, (res) => {
        assert.equal(res.statusCode, 206);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    assert.equal(body.length, 1024);
    assert.ok(seenRanges.some((r) => /bytes=0-1023/.test(r)));

    // 第二次 Range，累计
    await new Promise((resolve, reject) => {
      http.get(proxy.localUrl, { headers: { Range: 'bytes=2048-4095' } }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
    assert.ok(proxy.getDownloadedBytes() >= 1024 + 2048);
    assert.ok(proxy.getDownloadedBytes() < full.length);

    // 超限：硬终态 DOWNLOAD_LIMIT，阻止后续 Range
    let limitHit = false;
    const proxy2 = await startMeteredMediaProxy({
      upstreamUrl: 'https://upos-sz-mirrorcos.bilivideo.com/big.bin',
      maxDownloadBytes: 512,
      skipUrlAssert: true,
      upstreamRequest: async () => {
        const slice = full.subarray(0, 4096);
        return {
          statusCode: 206,
          headers: {
            'content-length': String(slice.length),
            'content-range': `bytes 0-4095/${full.length}`,
          },
          stream: Readable.from([slice]),
        };
      },
    });
    proxy2.onLimitExceeded(() => { limitHit = true; });
    await new Promise((resolve) => {
      http.get(proxy2.localUrl, { headers: { Range: 'bytes=0-4095' } }, (res) => {
        res.on('data', () => {});
        res.on('close', resolve);
        res.on('end', resolve);
      }).on('error', () => resolve());
    });
    assert.equal(proxy2.isLimitExceeded(), true);
    assert.equal(limitHit, true);
    assert.ok(proxy2.getDownloadedBytes() > 512);
    // 后续 Range 必须被拒绝（不可再打上游）
    const retry = await new Promise((resolve) => {
      http.get(proxy2.localUrl, { headers: { Range: 'bytes=0-100' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString(),
          code: res.headers['x-error-code'],
        }));
      }).on('error', (e) => resolve({ error: e.code }));
    });
    assert.ok(
      retry.status === 429
      || retry.error === 'ECONNREFUSED'
      || retry.code === 'DOWNLOAD_LIMIT'
      || /DOWNLOAD_LIMIT/.test(retry.body || ''),
      JSON.stringify(retry),
    );

    // redirect 相对解析
    const proxy3 = await startMeteredMediaProxy({
      upstreamUrl: 'https://upos-sz-mirrorcos.bilivideo.com/redir',
      skipUrlAssert: true,
      upstreamRequest: async ({ url }) => {
        if (url.endsWith('/redir')) return { redirect: '/big.bin' };
        return {
          statusCode: 200,
          headers: { 'content-length': '4' },
          stream: Readable.from([Buffer.from('abcd')]),
        };
      },
    });
    const b3 = await new Promise((resolve, reject) => {
      http.get(proxy3.localUrl, (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => resolve(Buffer.concat(c)));
      }).on('error', reject);
    });
    assert.equal(b3.toString(), 'abcd');
    proxy3.close();

    // redirect 到裸 IP 拒绝
    await assert.rejects(() => startMeteredMediaProxy({
      upstreamUrl: 'https://8.8.8.8/x',
    }), /bare IP|SSRF|not allowed/i);

    // DNS 私网
    assert.throws(
      () => assertPublicHttpsUrl('https://upos-sz-mirrorcos.bilivideo.com/a', {
        resolvedAddresses: ['10.1.2.3'],
      }),
      /forbidden|SSRF/i,
    );

    // abort 后无活跃端口
    const port = proxy.port;
    proxy.abort();
    assert.equal(proxy.closed, true);
    await assert.rejects(() => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/${proxy.nonce}` }, resolve);
      req.on('error', reject);
    }), /ECONNREFUSED|ECONNRESET|closed/i);
  } finally {
    try { proxy.close(); } catch { /* ignore */ }
  }
  void redirects;
});

test('R5: extractAudioRange 默认不完整 GET；显式 downloadToTemp 才整对象下载', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-r5ex-'));
  try {
    const wav = join(root, 'out.wav');
    let seenArgs = null;
    const r = await extractAudioRange({
      descriptor: {
        audio: { url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a', headers: {} },
      },
      startMs: 300_000,
      endMs: 600_000,
      outWav: wav,
      useMeteredProxy: false,
      runner: async (_f, args) => {
        seenArgs = args;
        writeFileSync(wav, Buffer.alloc(200, 1));
        return { code: 0, stdout: '', stderr: '', downloadedBytes: 50_000 };
      },
    });
    assert.ok(!String(seenArgs).includes('.dl-'));
    assert.equal(r.byteUsage.downloaded, 50_000);
    assert.notEqual(r.byteUsage.downloaded, r.byteUsage.outputBytes);

    let fullGet = false;
    await assert.rejects(() => extractAudioRange({
      descriptor: {
        audio: { url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a', headers: {} },
      },
      startMs: 0,
      endMs: 1000,
      outWav: join(root, 'x.wav'),
      downloadToTemp: true,
      useMeteredProxy: false,
      ffmpegPath: 'ffmpeg-not-exist-xyz',
      transport: async ({ outPath }) => {
        fullGet = true;
        writeFileSync(outPath, Buffer.alloc(2048, 2));
        return { downloaded: 2048 };
      },
    }));
    assert.equal(fullGet, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  void existsSync;
});
