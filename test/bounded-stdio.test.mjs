import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnBounded, killProcessTree } from '../src/video-index/bounded-stdio.js';

test('spawnBounded 正常捕获 stdout', async () => {
  const r = await spawnBounded(process.execPath, ['-e', 'process.stdout.write("hi")'], {
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hi');
});

test('spawnBounded 超限 stdout 拒绝', async () => {
  await assert.rejects(
    () => spawnBounded(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(2000))'],
      { timeoutMs: 10_000, maxStdoutBytes: 64 },
    ),
    (e) => e && e.code === 'STDIO_LIMIT',
  );
});

test('killProcessTree 对无效 pid 是空操作', () => {
  assert.doesNotThrow(() => killProcessTree(0));
  assert.doesNotThrow(() => killProcessTree(-1));
  assert.doesNotThrow(() => killProcessTree(undefined));
});
