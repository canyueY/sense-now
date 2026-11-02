import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractAudioWav, downloadMediaWithYtDlp, defaultCacheMediaPath,
} from '../src/video-index/media-extract.js';
import { createBilibiliSource } from '../src/video-index/adapters/bilibili-source.js';
import { createIndexStore } from '../src/video-index/index-store.js';

test('extractAudioWav：runner 收到参数数组且无 shell', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-aud-'));
  const input = join(root, 'in.mp4');
  const output = join(root, 'out.wav');
  writeFileSync(input, Buffer.from('x'));
  let seen;
  const r = await extractAudioWav({
    inputPath: input,
    outputPath: output,
    ffmpegPath: 'ffmpeg',
    runner: async (argv) => {
      seen = argv;
      assert.ok(Array.isArray(argv));
      assert.equal(argv[0], 'ffmpeg');
      assert.ok(argv.includes('-vn'));
      assert.ok(!argv.some((a) => String(a).includes('&&')));
      writeFileSync(output, Buffer.from('RIFF'));
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(r.ok, true);
  assert.ok(existsSync(output));
  assert.ok(seen.includes(input));
});

test('downloadMediaWithYtDlp：参数数组', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-dl-'));
  const out = join(root, 'source.mp4');
  let seen;
  await downloadMediaWithYtDlp({
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    outputTemplate: out,
    runner: async (argv) => {
      seen = argv;
      assert.ok(Array.isArray(argv));
      assert.equal(argv[0], 'yt-dlp');
      assert.ok(argv.includes('-o'));
      writeFileSync(out, Buffer.from('mp4'));
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.ok(seen.includes('--no-playlist'));
});

test('bilibili resolve + downloadMedia + cachePath', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-bili-'));
  const store = createIndexStore({ rootDir: root });
  const videoKey = 'bilibili:BV1xx411c7mD:p1';
  store.ensureLayout(videoKey);
  const cachePath = defaultCacheMediaPath(store.videoDir(videoKey));
  let calls = 0;
  const src = createBilibiliSource({
    runner: async (args) => {
      calls += 1;
      assert.ok(Array.isArray(args));
      if (args.includes('--version')) return { code: 0, stdout: '1\n', stderr: '' };
      if (args.includes('--dump-single-json')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 'BV1xx411c7mD', title: 't', duration: 3,
            webpage_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
          }),
          stderr: '',
        };
      }
      // download
      assert.ok(args.includes('-o'));
      writeFileSync(cachePath, Buffer.from('cached'));
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const r = await src.resolve(
    { kind: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    { downloadMedia: true, cachePath },
  );
  assert.equal(r.mediaRef.cached, true);
  assert.equal(r.mediaRef.path, cachePath);
  assert.ok(calls >= 2);
});
