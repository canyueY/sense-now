import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBilibiliSource, resolveYtDlpPath } from '../src/video-index/adapters/bilibili-source.js';

test('yt-dlp 路径优先级：显式 > 环境变量 > PATH 名', () => {
  assert.equal(resolveYtDlpPath({ explicit: 'C:/yt-dlp.exe', env: { DSH_YTDLP_PATH: 'x' } }), 'C:/yt-dlp.exe');
  assert.equal(resolveYtDlpPath({ env: { DSH_YTDLP_PATH: 'D:/yt-dlp' } }), 'D:/yt-dlp');
  assert.equal(resolveYtDlpPath({ env: {} }), 'yt-dlp');
});

test('fake CLI：参数为数组，无 shell；解析 JSON 元数据', async () => {
  const calls = [];
  const src = createBilibiliSource({
    runner: async (args) => {
      calls.push(args);
      assert.ok(Array.isArray(args));
      assert.ok(!args.some((a) => String(a).includes('&&') || String(a).includes('|')));
      if (args.includes('--version')) {
        return { code: 0, stdout: '2024.01.01\n', stderr: '' };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          id: 'BV1xx411c7mD',
          title: 'demo',
          duration: 12.5,
          uploader: 'up',
          webpage_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
          subtitles: {},
        }),
        stderr: '',
      };
    },
  });
  const avail = await src.available();
  assert.equal(avail.ok, true);
  const r = await src.resolve({
    kind: 'bilibili',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    partId: 'p1',
  });
  assert.match(r.videoKey, /bilibili:BV1xx411c7mD:p1/i);
  assert.equal(r.metadata.title, 'demo');
  assert.ok(r.fingerprint);
  assert.equal(r.provenance.adapter, 'bilibili-source');
  assert.ok(calls.every((c) => Array.isArray(c)));
});

test('缺少 yt-dlp 时 unavailable，不影响协议形状', async () => {
  const src = createBilibiliSource({
    runner: async () => {
      const e = new Error('spawn ENOENT');
      e.code = 'ENOENT';
      throw e;
    },
  });
  const avail = await src.available();
  assert.equal(avail.ok, false);
  assert.equal(avail.reason, 'unavailable');
});

test('非法 JSON / 非零退出', async () => {
  const badJson = createBilibiliSource({
    runner: async (args) => {
      if (args.includes('--version')) return { code: 0, stdout: '1', stderr: '' };
      return { code: 0, stdout: 'not-json', stderr: '' };
    },
  });
  await assert.rejects(() => badJson.resolve({ url: 'https://www.bilibili.com/video/BVxxx' }));

  const nonzero = createBilibiliSource({
    runner: async (args) => {
      if (args.includes('--version')) return { code: 0, stdout: '1', stderr: '' };
      return { code: 2, stdout: '', stderr: 'login required' };
    },
  });
  await assert.rejects(() => nonzero.resolve({ url: 'https://www.bilibili.com/video/BVxxx' }));
});
