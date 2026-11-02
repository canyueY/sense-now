import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSrt, parseVtt, parseTimestampToMs, loadSubtitleFile,
} from '../src/video-index/adapters/subtitle-adapter.js';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';

test('parseTimestampToMs 支持 SRT/VTT 写法', () => {
  assert.equal(parseTimestampToMs('00:00:01,500'), 1500);
  assert.equal(parseTimestampToMs('00:00:01.500'), 1500);
  assert.equal(parseTimestampToMs('01:02.5'), 62500);
});

test('parseSrt / parseVtt', () => {
  const srt = `1
00:00:00,000 --> 00:00:01,500
你好世界

2
00:00:02,000 --> 00:00:03,000
第二句
`;
  const a = parseSrt(srt);
  assert.equal(a.length, 2);
  assert.equal(a[0].text, '你好世界');
  assert.equal(a[0].endMs, 1500);

  const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
Hello

00:00:02.000 --> 00:00:03.000
World
`;
  const b = parseVtt(vtt);
  assert.equal(b.length, 2);
  assert.equal(b[1].text, 'World');
});

test('loadSubtitleFile + index 用 subtitlePath', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-sub-'));
  const video = join(root, 'a.mp4');
  const srt = join(root, 'a.srt');
  writeFileSync(video, Buffer.from('x'));
  writeFileSync(srt, `1
00:00:00,000 --> 00:00:02,000
外挂字幕记忆架构
`);
  const engine = createVideoIndexEngine({
    rootDir: root,
    adapters: {
      extractFrames: async () => [],
      extractAudio: async () => ({ ok: true, path: null }),
    },
  });
  const r = await engine.index(
    { source: { kind: 'file', path: video } },
    { subtitlePath: srt, skipStoryboard: true },
  );
  assert.equal(r.manifest.capabilities.subtitles, 'ready');
  assert.ok(r.manifest.counts.utterances >= 1);
  const q = engine.query({ videoKey: r.videoKey, question: '记忆架构' });
  assert.ok(q.context.utterances.length >= 1 || q.context.chapters.length >= 1);
});
