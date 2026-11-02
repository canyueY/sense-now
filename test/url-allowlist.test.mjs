import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeBilibiliUrl, assertSafeBilibiliResultUrl, isAllowedBilibiliHost,
} from '../src/video-index/url-allowlist.js';
import { createBilibiliSource } from '../src/video-index/adapters/bilibili-source.js';

test('只允许 bilibili.com 的 https', () => {
  assert.match(assertSafeBilibiliUrl('https://www.bilibili.com/video/BV1xx'), /^https:\/\//);
  assert.equal(isAllowedBilibiliHost('www.bilibili.com'), true);
});

test('拒绝 b23.tv 短链（重定向发生在 webpage_url 检查之前）', () => {
  assert.throws(() => assertSafeBilibiliUrl('https://b23.tv/abcd'), /b23|SSRF|short/i);
  assert.equal(isAllowedBilibiliHost('b23.tv'), false);
});

test('拒绝 localhost / 内网 / 任意站 / http', () => {
  for (const u of [
    'http://www.bilibili.com/video/BV1',
    'https://localhost/video',
    'https://127.0.0.1/x',
    'https://192.168.1.1/x',
    'https://10.0.0.2/x',
    'https://evil.example.com/x',
    'https://user:pass@www.bilibili.com/x',
  ]) {
    assert.throws(() => assertSafeBilibiliUrl(u), /SSRF|BAD_URL|https|forbidden|allowed|credentials/i);
  }
});

test('结果 webpage_url 跳出白名单则拒绝', async () => {
  const src = createBilibiliSource({
    runner: async (args) => {
      if (args.includes('--version')) return { code: 0, stdout: '1', stderr: '' };
      return {
        code: 0,
        stdout: JSON.stringify({
          id: 'BV1xx411c7mD',
          title: 'x',
          webpage_url: 'http://127.0.0.1/steal',
        }),
        stderr: '',
      };
    },
  });
  await assert.rejects(
    () => src.resolve({ url: 'https://www.bilibili.com/video/BV1xx411c7mD' }),
    /SSRF|BAD_URL|https|forbidden/i,
  );
});

test('assertSafeBilibiliResultUrl 同样校验', () => {
  assert.throws(() => assertSafeBilibiliResultUrl('https://169.254.169.254/latest'), /SSRF|forbidden/i);
  assert.throws(() => assertSafeBilibiliResultUrl('https://b23.tv/x'), /b23|SSRF|short/i);
});
