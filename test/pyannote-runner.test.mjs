import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPyannoteAudioVisualAdapter, isPyannoteEnabled,
} from '../src/video-index/adapters/pyannote-runner.js';

test('pyannote runner：未显式配置时 unavailable', () => {
  const adapter = createPyannoteAudioVisualAdapter({ env: {} });
  const status = adapter.available();
  assert.equal(status.ok, false);
  assert.match(status.detail, /DSH_PYANNOTE_ENABLED/);
});

test('只有 HF_TOKEN 不得启用，且不调用 checkProcess', () => {
  let checkCalls = 0;
  const adapter = createPyannoteAudioVisualAdapter({
    env: { HF_TOKEN: 'hf_should_not_enable' },
    checkProcess: () => {
      checkCalls += 1;
      return { status: 0, stdout: '{}', stderr: '' };
    },
  });
  assert.equal(isPyannoteEnabled({ HF_TOKEN: 'hf_x' }), false);
  assert.equal(adapter.available().ok, false);
  assert.equal(checkCalls, 0);
  assert.ok(!String(adapter.available().detail).includes('hf_should_not_enable'));
});

test('只有 DSH_PYANNOTE_MODEL 不得启用', () => {
  let checkCalls = 0;
  const adapter = createPyannoteAudioVisualAdapter({
    env: { DSH_PYANNOTE_MODEL: 'D:/models/x' },
    checkProcess: () => { checkCalls += 1; return { status: 0, stdout: '{}', stderr: '' }; },
  });
  assert.equal(adapter.available().ok, false);
  assert.equal(checkCalls, 0);
});

test('ENABLED=0 + HF_TOKEN / 本地模型：强制关闭', () => {
  let checkCalls = 0;
  for (const env of [
    { DSH_PYANNOTE_ENABLED: '0', HF_TOKEN: 'hf_x' },
    { DSH_PYANNOTE_ENABLED: '0', DSH_PYANNOTE_MODEL: 'D:/m' },
    { DSH_PYANNOTE_ENABLED: 'false', HF_TOKEN: 'hf_x' },
  ]) {
    checkCalls = 0;
    const adapter = createPyannoteAudioVisualAdapter({
      env,
      checkProcess: () => { checkCalls += 1; return { status: 0, stdout: '{}', stderr: '' }; },
    });
    assert.equal(adapter.available().ok, false);
    assert.equal(checkCalls, 0);
  }
});

test('ENABLED=1 + 合法配置：才调用 checkProcess', async () => {
  let checkCalls = 0;
  let runPayload = null;
  const adapter = createPyannoteAudioVisualAdapter({
    env: { DSH_PYANNOTE_ENABLED: '1', HF_TOKEN: 'hf_test_token_not_for_log' },
    checkProcess: () => {
      checkCalls += 1;
      return {
        status: 0,
        stdout: JSON.stringify({ adapter: 'pyannote.audio', model: 'community-1' }),
        stderr: '',
      };
    },
    runProcess: async (_file, _args, opts) => {
      runPayload = JSON.parse(opts.stdinText);
      return {
        code: 0,
        stdout: JSON.stringify({
          speakers: [{ speakerClusterId: 'SPEAKER_00', totalMs: 1000 }],
          activeSegments: [{ startMs: 0, endMs: 1000, speakerClusterId: 'SPEAKER_00' }],
          overlaps: [],
          observations: [],
        }),
        stderr: '',
      };
    },
  });

  assert.equal(adapter.available().ok, true);
  assert.equal(adapter.available().ok, true);
  assert.equal(checkCalls, 1, 'availability probe 应缓存');
  const result = await adapter.analyze({ videoKey: 'file:x:a.mp4', audioPath: 'a.wav' });
  assert.equal(result.ok, true);
  assert.equal(result.speakers[0].speakerClusterId, 'SPEAKER_00');
  assert.equal(runPayload.audioPath, 'a.wav');
});

test('错误信息中不包含 token', () => {
  const adapter = createPyannoteAudioVisualAdapter({
    env: { DSH_PYANNOTE_ENABLED: '1', HF_TOKEN: 'test-token-redacted' },
    checkProcess: () => ({
      status: 1,
      stdout: '',
      stderr: 'auth failed HF_TOKEN=test-token-redacted',
    }),
  });
  const status = adapter.available();
  assert.equal(status.ok, false);
  assert.ok(!String(status.detail).includes('test-token-redacted'));
});
