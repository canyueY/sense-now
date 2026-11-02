import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWhisperEnabled, createWhisperAsrAdapter,
} from '../src/video-index/adapters/whisper-asr.js';

test('faster-whisper 默认关闭；ENABLED=1 或 MODEL 才启用', () => {
  assert.equal(isWhisperEnabled({}), false);
  assert.equal(isWhisperEnabled({ DSH_WHISPER_ENABLED: '0', DSH_WHISPER_MODEL: 'x' }), false);
  assert.equal(isWhisperEnabled({ DSH_WHISPER_ENABLED: '1' }), true);
  assert.equal(isWhisperEnabled({ DSH_WHISPER_MODEL: 'Systran/faster-whisper-small' }), true);

  const off = createWhisperAsrAdapter({ env: {} });
  assert.equal(off.available().ok, false);

  const on = createWhisperAsrAdapter({
    env: { DSH_WHISPER_ENABLED: '1' },
    pythonPath: 'python',
    scriptPath: 'scripts/asr-runner.py',
  });
  assert.equal(on.available().ok, true);
  assert.equal(on.name, 'faster-whisper');
});
