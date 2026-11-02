import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPublicHttpsUrl, isForbiddenResolvedAddress, downloadWithBudget,
  extractAudioRange, assertRedirectTargetAllowed,
} from '../src/video-index/remote-media.js';

test('C6: 公网裸 IP 拒绝；域名 allowlist + 公网解析允许；解析到私网拒绝', () => {
  assert.throws(() => assertPublicHttpsUrl('https://8.8.8.8/a'), /bare IP|SSRF/i);
  assert.throws(() => assertPublicHttpsUrl('https://[2001:4860:4860::8888]/x'), /bare IP|SSRF|not allowed/i);
  assert.ok(assertPublicHttpsUrl('https://upos-sz-mirrorcos.bilivideo.com/a.m4a'));
  assert.throws(
    () => assertPublicHttpsUrl('https://upos-sz-mirrorcos.bilivideo.com/a.m4a', {
      resolvedAddresses: ['10.0.0.1'],
    }),
    /forbidden|SSRF/i,
  );
  assert.ok(isForbiddenResolvedAddress('169.254.169.254'));
  assert.ok(isForbiddenResolvedAddress('::ffff:127.0.0.1'));
  assert.throws(() => assertRedirectTargetAllowed('https://8.8.8.8/x'), /bare IP|SSRF/i);
});

test('C6: maxDownloadBytes 按输入字节终止；downloaded ≠ outputBytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-dllim-'));
  const big = Buffer.alloc(64 * 1024, 7);
  const server = http.createServer((req, res) => {
    if (req.url === '/redir-ip') {
      res.writeHead(302, { Location: 'https://8.8.8.8/x' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': big.length });
    res.end(big);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    // transport 注入：模拟超限
    const out = join(root, 'dl.bin');
    await assert.rejects(() => downloadWithBudget({
      url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a',
      outPath: out,
      limits: { maxDownloadBytes: 1024 },
      transport: async ({ maxDownloadBytes }) => {
        // 假装读了超过上限的输入
        if (big.length > maxDownloadBytes) {
          const err = new Error('download exceeds maxDownloadBytes');
          err.code = 'DOWNLOAD_LIMIT';
          throw err;
        }
        writeFileSync(out, big);
        return { downloaded: big.length };
      },
    }), (e) => e.code === 'DOWNLOAD_LIMIT');
    assert.equal(existsSync(out), false);

    // extractAudioRange：runner 报告 downloadedBytes ≠ 输出大小
    const wav = join(root, 'out.wav');
    const tinyWav = Buffer.alloc(200, 1);
    const r = await extractAudioRange({
      descriptor: {
        audio: { url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a', headers: {} },
      },
      startMs: 0,
      endMs: 1000,
      outWav: wav,
      downloadToTemp: false,
      runner: async () => {
        writeFileSync(wav, tinyWav);
        return { code: 0, stdout: '', stderr: '', downloadedBytes: 50_000 };
      },
    });
    assert.equal(r.byteUsage.downloaded, 50_000);
    assert.equal(r.byteUsage.outputBytes, 200);
    assert.notEqual(r.byteUsage.downloaded, r.byteUsage.outputBytes);

    // TEMP_LIMIT
    await assert.rejects(() => extractAudioRange({
      descriptor: {
        audio: { url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a', headers: {} },
      },
      startMs: 0,
      endMs: 1000,
      outWav: join(root, 'big.wav'),
      limits: { maxTempBytes: 100 },
      downloadToTemp: false,
      runner: async (_f, _a) => {
        writeFileSync(join(root, 'big.wav'), Buffer.alloc(500));
        return { code: 0, stdout: '', stderr: '', downloadedBytes: 500 };
      },
    }), (e) => e.code === 'TEMP_LIMIT');

    // redirect 到裸 IP
    await assert.rejects(() => downloadWithBudget({
      url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a',
      outPath: join(root, 'r.bin'),
      transport: async () => ({ redirectUrl: 'https://8.8.8.8/x' }),
    }), /bare IP|SSRF/i);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
  void port;
});
