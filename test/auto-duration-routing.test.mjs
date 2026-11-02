import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { createBilibiliSource } from '../src/video-index/adapters/bilibili-source.js';
import { createVideoIndexTool } from '../src/video-index-tool.js';

test('C7: B 站 mock 不传 duration，2h → background；resolver 只调用一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-auto-'));
  let resolveCalls = 0;
  try {
    const bilibiliSource = createBilibiliSource({
      runner: async (args) => {
        if (args.includes('--version')) return { code: 0, stdout: '1\n', stderr: '' };
        resolveCalls += 1;
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 'BV1xx411c7mD',
            cid: 1,
            title: 'long',
            duration: 7200,
            webpage_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
            formats: [
              { format_id: 'a', url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a', vcodec: 'none', acodec: 'mp4a', abr: 64, ext: 'm4a' },
              { format_id: 'v', url: 'https://upos-sz-mirrorcos.bilivideo.com/v.m4s', vcodec: 'avc1', acodec: 'none', width: 640, height: 360 },
            ],
            subtitles: {},
          }),
          stderr: '',
        };
      },
    });
    const eng = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        bilibiliSource,
        indexChunk: async () => ({ utterances: [], events: [], speakers: [], storyboard: [], evidence: [], chapters: [] }),
      },
    });
    // monkey: engine uses its own jobs.indexChunk; override via start through indexAdaptive
    const r = await eng.indexAdaptive({
      source: { kind: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD', partId: 'p1' },
      execution: 'auto',
      // 不传 durationMs
    });
    assert.equal(r.background, true);
    assert.ok(r.jobId);
    assert.equal(r.durationMs, 7_200_000);
    assert.equal(resolveCalls, 1);
    const dumped = JSON.stringify(r);
    assert.ok(!dumped.includes('bilivideo.com/a.m4a'));
    eng.jobCancel(r.jobId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C7: 本地 probe 2h → background；2min → sync 短路径；未知时长 DURATION_UNKNOWN', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-auto2-'));
  try {
    const media = join(root, 'x.mp4');
    writeFileSync(media, Buffer.from('fake'));
    const engLong = createVideoIndexEngine({
      rootDir: root,
      adapters: {
        ffprobe: async () => ({ code: 0, stdout: '7200\n', stderr: '' }),
      },
    });
    const long = await engLong.indexAdaptive({
      source: { kind: 'file', path: media },
      execution: 'auto',
    });
    assert.equal(long.background, true);
    assert.equal(long.durationMs, 7_200_000);
    engLong.jobCancel(long.jobId);

    const engShort = createVideoIndexEngine({
      rootDir: join(root, 's'),
      adapters: {
        ffprobe: async () => ({ code: 0, stdout: '120\n', stderr: '' }),
        extractFrames: async () => [],
      },
    });
    const short = await engShort.indexAdaptive({
      source: { kind: 'file', path: media },
      execution: 'auto',
      indexOptions: { skipStoryboard: true },
    });
    assert.equal(short.background, false);
    assert.equal(short.sync || short.ok, true);

    const engUnk = createVideoIndexEngine({
      rootDir: join(root, 'u'),
      adapters: {
        ffprobe: async () => ({ code: 0, stdout: 'nan\n', stderr: '' }),
      },
    });
    await assert.rejects(
      () => engUnk.indexAdaptive({ source: { kind: 'file', path: media }, execution: 'auto' }),
      (e) => e.code === 'DURATION_UNKNOWN',
    );

    const tool = createVideoIndexTool({
      rootDir: join(root, 't'),
      engine: createVideoIndexEngine({
        rootDir: join(root, 't'),
        adapters: {
          bilibiliSource: createBilibiliSource({
            runner: async (args) => {
              if (args.includes('--version')) return { code: 0, stdout: '1', stderr: '' };
              return {
                code: 0,
                stdout: JSON.stringify({
                  id: 'BV1xx411c7mD', duration: 7200,
                  webpage_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
                  formats: [
                    { format_id: 'a', url: 'https://upos-sz-mirrorcos.bilivideo.com/a.m4a', vcodec: 'none', acodec: 'mp4a', abr: 64 },
                  ],
                  subtitles: {},
                }),
                stderr: '',
              };
            },
          }),
        },
      }),
    });
    const tr = await tool.route({
      action: 'index',
      source: 'bilibili',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      execution: 'auto',
    });
    assert.match(tr.text, /后台索引|job/);
    assert.equal(tr.meta.background, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
