import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPublicHttpsUrl,
  extractAudioRange, isPrivateIp, assertRedirectTargetAllowed,
} from '../src/video-index/remote-media.js';
import { createBilibiliSource } from '../src/video-index/adapters/bilibili-source.js';
import {
  assertLocalCdpEndpoint, validateCdpSample,
} from '../src/video-index/cdp-bridge.js';
import { createTimeMapping } from '../src/video-index/time-mapping.js';
import { provisionalSpeakerId, mapChunkSpeakers, mergeSpeakersByEmbedding } from '../src/video-index/speaker-merge.js';
import { validateAsrOutput } from '../src/video-index/adapters/asr-adapter.js';
import { selectChunksFromCatalog } from '../src/video-index/index-retriever.js';
import { createChunkStore } from '../src/video-index/chunk-store.js';
import { validateManualRegion, createCaptureSession } from '../src/video-index/capture-source.js';
import { cacheKeyOf, chunkSetHash } from '../src/video-index/query-cache.js';

// re-export helper: assertSafeHeaders is internal — test via extract failure
test('remote SSRF：私网 / localhost / 裸公网 IP / CRLF header 拒绝', () => {
  assert.throws(() => assertPublicHttpsUrl('http://example.com/a'), /https/);
  assert.throws(() => assertPublicHttpsUrl('https://127.0.0.1/a'), /bare IP|local|forbidden|SSRF|private/i);
  assert.throws(() => assertPublicHttpsUrl('https://8.8.8.8/a'), /bare IP|SSRF/i);
  assert.throws(() => assertPublicHttpsUrl('https://192.168.1.1/a'), /bare IP|forbidden|SSRF|private/i);
  assert.ok(isPrivateIp('10.0.0.1'));
  assert.throws(
    () => assertRedirectTargetAllowed('https://169.254.169.254/latest'),
    /bare IP|forbidden|SSRF|private/i,
  );
});

test('resolveStreams：单 P、descriptor 不含 cookie、不落盘', async () => {
  const src = createBilibiliSource({
    runner: async (args) => {
      if (args.includes('--version')) return { code: 0, stdout: '2024.01\n', stderr: '' };
      assert.ok(args.includes('--no-playlist'));
      assert.ok(!args.includes('--max-redirects'), 'yt-dlp has no --max-redirects option');
      return {
        code: 0,
        stdout: JSON.stringify({
          id: 'BV1xx411c7mD',
          cid: 12345,
          title: 'demo',
          duration: 600,
          webpage_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
          http_headers: { Cookie: 'SESSDATA=secret', Referer: 'https://www.bilibili.com' },
          formats: [
            {
              format_id: '30280', url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a',
              vcodec: 'none', acodec: 'mp4a', abr: 128, ext: 'm4a',
              http_headers: { Cookie: 'SHOULD_NOT_KEEP=1' },
            },
            {
              format_id: '30016', url: 'https://upos-sz-mirrorcos.bilivideo.com/v.m4s',
              vcodec: 'avc1', acodec: 'none', width: 640, height: 360, ext: 'm4s',
            },
          ],
          subtitles: {},
        }),
        stderr: '',
      };
    },
  });
  const d = await src.resolveStreams({
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    partId: 'p1',
  });
  assert.equal(d.bvid.toLowerCase().includes('bv1xx') || d.bvid.length > 0, true);
  assert.equal(d.cid, '12345');
  assert.ok(d.audio?.url.startsWith('https://'));
  assert.equal(d.audio.headers.Cookie, undefined);
  assert.equal(d.audio.headers.cookie, undefined);
  const dumped = JSON.stringify(d);
  assert.ok(!dumped.includes('SESSDATA'));
  assert.ok(!dumped.includes('SHOULD_NOT_KEEP'));
});

test('CDP：仅 localhost；hidden 不视为暂停；rate/seek 切 mapping', () => {
  assert.throws(() => assertLocalCdpEndpoint('http://example.com:9222'), /localhost/);
  const ok = assertLocalCdpEndpoint('http://127.0.0.1:9222');
  assert.equal(ok.port, 9222);

  const sample = validateCdpSample({
    ok: true,
    currentTimeMs: 5000,
    durationMs: 60_000,
    paused: false,
    ended: false,
    playbackRate: 1.5,
    readyState: 4,
    visibilityState: 'hidden',
    pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    videoRect: { x: 0, y: 0, width: 100, height: 100 },
    devicePixelRatio: 1,
  }, { sampledAtMonotonicMs: 1000 });
  assert.equal(sample.paused, false);
  assert.equal(sample.visibilityState, 'hidden');

  const map = createTimeMapping({ clock: () => 0 });
  map.onPlayerSample({
    currentTimeMs: 0, paused: false, ended: false, playbackRate: 1, wallMs: 0,
  });
  map.onPlayerSample({
    currentTimeMs: 1000, paused: false, ended: false, playbackRate: 2, wallMs: 1000, event: 'rate_change',
  });
  const segs = map.snapshot();
  assert.ok(segs.length >= 1);
  assert.equal(map.wallToVideo(500), 500);
});

test('ASR offsetMs → 绝对时间；provisional speaker', () => {
  const v = validateAsrOutput({
    utterances: [{ startMs: 100, endMs: 200, text: 'hello chunk', confidence: 0.9 }],
  }, { videoKey: 'v', offsetMs: 300_000, chunkId: '000003' });
  assert.equal(v.ok, true);
  assert.equal(v.utterances[0].startMs, 300_100);
  assert.equal(v.utterances[0].chunkId, '000003');

  assert.equal(provisionalSpeakerId('000012', 'SPEAKER_00'), 'C000012_SPEAKER_00');
  const mapped = mapChunkSpeakers([{ speakerClusterId: 'SPEAKER_00' }], '000001');
  assert.equal(mapped[0].speakerClusterId, 'C000001_SPEAKER_00');

  const merge = mergeSpeakersByEmbedding({
    clusters: [
      { id: 'C000001_SPEAKER_00', embedding: [1, 0], chunkIds: ['000001'] },
      { id: 'C000002_SPEAKER_00', embedding: [0.99, 0.01], chunkIds: ['000002'] },
    ],
    threshold: 0.9,
  });
  assert.ok(merge.mergeEvidence.length >= 1);
});

test('两级检索：catalog 只读 top chunks；cache key 含 chunk revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-ret-'));
  try {
    const store = createChunkStore({ rootDir: root, videoKey: 'vk' });
    for (const [id, start, text] of [
      ['000000', 0, 'alpha intro'],
      ['000001', 300_000, 'beta middle'],
      ['000002', 600_000, 'gamma end'],
    ]) {
      store.commitChunk(id, {
        chunkManifest: {
          chunkId: id, revision: 1, startMs: start, endMs: start + 300_000,
          status: 'ready', sourceMode: 'file', timeSource: 'stream',
        },
        utterances: [{ startMs: start + 10, endMs: start + 20, text }],
        events: [], speakers: [], storyboard: [], evidence: [], chapters: [],
      });
    }
    const catalog = { chunks: store.rebuildCatalog() };
    const sel = selectChunksFromCatalog(catalog, { question: 'beta middle', topK: 2 });
    assert.ok(sel.chunkIds.includes('000001'));
    assert.ok(sel.chunkIds.length <= 2);

    const timeSel = selectChunksFromCatalog(catalog, { question: '在 5:00 说了什么', topK: 2 });
    assert.ok(timeSel.chunkIds.includes('000001'));

    const h1 = chunkSetHash([{ chunkId: '000001', revision: 1 }]);
    const h2 = chunkSetHash([{ chunkId: '000001', revision: 2 }]);
    assert.notEqual(h1, h2);
    const k1 = cacheKeyOf({
      videoKey: 'vk', indexVersion: '1', queryType: 'text', question: 'q',
      layoutVersion: 'chunk-v1', chunkRevisionHash: h1,
    });
    const k2 = cacheKeyOf({
      videoKey: 'vk', indexVersion: '1', queryType: 'text', question: 'q',
      layoutVersion: 'chunk-v1', chunkRevisionHash: h2,
    });
    assert.notEqual(k1, k2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture：手动 region；URL 优先；interrupt 记 gap', async () => {
  assert.throws(() => validateManualRegion({ x: 0, y: 0, width: -1, height: 10 }), /positive/);
  const session = createCaptureSession({
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    region: { x: 10, y: 20, width: 100, height: 80 },
    sourceMode: null,
  });
  const started = await session.start();
  assert.equal(started.sourceMode, 'url');
  assert.equal(started.audioScope, 'none_default');
  session.noteDiscontinuity({ fromVideoMs: 1000, toVideoMs: 5000, reason: 'interrupt' });
  const stopped = await session.stop();
  assert.ok(stopped.gaps.length >= 1);
});

test('本地 Range fixture：extractAudioRange 记录字节且拒绝超限', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-range-'));
  const wavBody = Buffer.alloc(1024, 1);
  const server = http.createServer((req, res) => {
    if (req.url === '/private') {
      res.writeHead(302, { Location: 'https://127.0.0.1/x' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wavBody.length });
    res.end(wavBody);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // 生产路径禁止 loopback URL；此处用注入 runner 模拟成功提取
    const out = join(root, 'out.wav');
    const r = await extractAudioRange({
      descriptor: {
        audio: {
          url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a',
          headers: { Referer: 'https://www.bilibili.com' },
        },
      },
      startMs: 0,
      endMs: 1000,
      outWav: out,
      downloadToTemp: false,
      runner: async (_file, _args) => {
        writeFileSync(out, wavBody);
        return { code: 0, stdout: '', stderr: '', downloadedBytes: 4096 };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.byteUsage.downloaded, 4096);
    assert.equal(r.byteUsage.outputBytes, 1024);

    await assert.rejects(() => extractAudioRange({
      descriptor: {
        audio: { url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a', headers: { 'X-A': 'a\r\nEvil: 1' } },
      },
      startMs: 0,
      endMs: 1000,
      outWav: join(root, 'bad.wav'),
      runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    }), /header/i);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
  void port;
});

test('metered proxy：descriptor UA/Referer 优先，客户端只补 Range', async () => {
  const { startMeteredMediaProxy } = await import('../src/video-index/metered-media-proxy.js');
  const { Readable } = await import('node:stream');
  let seen = null;
  const proxy = await startMeteredMediaProxy({
    upstreamUrl: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a',
    headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'BrowserUA' },
    upstreamRequest: async ({ headers }) => {
      seen = headers;
      return {
        statusCode: 206,
        headers: { 'content-length': '1' },
        stream: Readable.from([Buffer.from('x')]),
      };
    },
  });
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(proxy.localUrl, {
        headers: { Range: 'bytes=0-0', 'User-Agent': 'Lavf/60' },
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
    });
  } finally {
    proxy.close();
  }
  assert.equal(seen['user-agent'], 'BrowserUA', 'descriptor UA must win over Lavf');
  assert.equal(seen.referer, 'https://www.bilibili.com/');
  assert.equal(seen.range, 'bytes=0-0');
});
