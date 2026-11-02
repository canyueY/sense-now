import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobController } from '../src/video-index/job-controller.js';
import { createVideoIndexTool } from '../src/video-index-tool.js';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';

const BAD_IDS = [
  'nope',
  '../x',
  '..\\x',
  '',
  'a\u0000bxxxxxxx',
  'x'.repeat(10_000),
  'job_missing_ok', // 合法格式但不存在
];

test('C4: 非法/缺失 jobId 公开 API 不 throw', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-jid-'));
  try {
    const ctrl = createJobController({
      rootDir: root,
      indexChunk: async () => ({ utterances: [], events: [], speakers: [], storyboard: [], evidence: [], chapters: [] }),
    });
    for (const id of BAD_IDS) {
      assert.doesNotThrow(() => ctrl.jobStatus(id));
      assert.doesNotThrow(() => ctrl.jobCancel(id));
      const st = ctrl.jobStatus(id);
      assert.equal(st.ok, false);
      assert.ok(['invalid_job_id', 'not-found'].includes(st.reason), `id=${JSON.stringify(id)} reason=${st.reason}`);
      // 不回显超长恶意输入
      assert.ok(!JSON.stringify(st).includes('x'.repeat(100)));
    }
    const eng = createVideoIndexEngine({ rootDir: root });
    const tool = createVideoIndexTool({ rootDir: root, engine: eng });
    for (const action of ['job_status', 'job_cancel', 'job_resume', 'capture_stop']) {
      for (const id of ['../x', 'nope', 'job_absent_xx']) {
        const r = await tool.route({ action, jobId: id });
        assert.ok(r);
        assert.ok(typeof r.text === 'string');
        assert.equal(typeof r.meta?.ok === 'boolean' || r.meta?.reason != null, true);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
