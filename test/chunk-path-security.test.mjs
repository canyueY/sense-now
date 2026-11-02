import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChunkStore, assertChunkId } from '../src/video-index/chunk-store.js';

test('C5: 恶意 chunkId 在创建目录前拒绝，无副作用', () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-chunksec-'));
  try {
    const store = createChunkStore({ rootDir: root, videoKey: 'file:sec' });
    const before = snapshot(root);
    const bad = ['../../escape', '..\\escape', '/tmp/x', 'C:\\x', 'a/b', '000000\0', '', '123', '1234567', null, undefined];
    for (const id of bad) {
      assert.throws(() => assertChunkId(id), /invalid chunkId|INVALID/);
      assert.throws(() => store.beginChunk(id), /invalid chunkId|INVALID/);
      assert.throws(() => store.abortChunk(id), /invalid chunkId|INVALID/);
      assert.throws(() => store.commitChunk(id, {
        chunkManifest: { chunkId: '000000', status: 'ready', startMs: 0, endMs: 1 },
      }), /invalid chunkId|INVALID/);
    }
    const after = snapshot(root);
    // 不应在 videoDir 外创建 escape 目录
    assert.ok(!existsSync(join(root, 'escape')));
    assert.ok(!existsSync(join(root, '..', 'escape')));
    // staging 不应因恶意 id 出现
    const vids = readdirSync(root);
    for (const v of vids) {
      const chunks = join(root, v, 'chunks');
      if (existsSync(chunks)) {
        for (const n of readdirSync(chunks)) {
          assert.ok(!n.includes('..'));
          assert.ok(!n.includes('escape'));
        }
      }
    }
    void before;
    void after;

    // 合法 id 正常
    store.commitChunk('000000', {
      chunkManifest: {
        chunkId: '000000', revision: 1, startMs: 0, endMs: 1000,
        status: 'ready', sourceMode: 'file', timeSource: 'stream',
      },
      utterances: [], events: [], speakers: [], storyboard: [], evidence: [], chapters: [],
    });
    assert.ok(store.readChunk('000000'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshot(dir) {
  try { return readdirSync(dir).sort().join(','); } catch { return ''; }
}
