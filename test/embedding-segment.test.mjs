import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateSpeakerEmbeddings } from '../src/video-index/speaker-merge.js';
import { createAudioVisualAdapter } from '../src/video-index/adapters/audio-visual-adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', 'scripts', 'audio-visual-runner.py');

test('R4: crop 收到 Segment(start,end)；overlap 排除；offset 相对 WAV；空 embedding 不 pending', () => {
  const py = `
import json, sys, types, importlib.util
# stub modules so we don't need installed pyannote for contract test
core = types.ModuleType("pyannote")
core_core = types.ModuleType("pyannote.core")
class Segment:
    def __init__(self, start, end):
        self.start = float(start)
        self.end = float(end)
core_core.Segment = Segment
sys.modules["pyannote"] = core
sys.modules["pyannote.core"] = core_core
sys.modules["pyannote.audio"] = types.ModuleType("pyannote.audio")

spec = importlib.util.spec_from_file_location("avr", r${JSON.stringify(RUNNER)})
avr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(avr)

seen = []
class FakeInf:
    def crop(self, path, segment):
        seen.append((float(segment.start), float(segment.end), type(segment).__name__))
        # 不用 numpy：返回 list，aggregate 里会 asarray
        if segment.start < 1.0:
            return [1.0, 0.0, 0.0, 0.0]
        return [0.0, 1.0, 0.0, 0.0]

# 绝对时间含 offset=300000；overlap 只盖住中间短段，不碰到两段 exclusive
segs = [
    (300000, 301000, "SPEAKER_00"),  # 相对 0–1s，与 overlap 不相交
    (301000, 301500, "SPEAKER_00"),  # 落在 overlap → 排除
    (305000, 307000, "SPEAKER_01"),  # 相对 5–7s
]
overlaps = [(301000, 301500)]
out = avr.compute_speaker_embeddings(
    "dummy.wav",
    segs,
    offset_ms=300000,
    overlap_ranges=overlaps,
    inference=FakeInf(),
    audio_duration_ms=20000,
)
assert out.get("ok") is True, out
assert len(out["speakerEmbeddings"]) == 2, out
assert all(s[2] == "Segment" for s in seen), seen
# (start,end) 语义：时长约 2s，不是 (start,duration)=(0,2) 误当 end=2 的巧合也要验 end=start+2
assert any(abs(s[0] - 0.0) < 1e-6 and abs(s[1] - 1.0) < 1e-6 for s in seen), seen
assert any(abs(s[0] - 5.0) < 1e-6 and abs(s[1] - 7.0) < 1e-6 for s in seen), seen
# 相对 WAV，不是 300+
assert all(s[0] < 10 for s in seen), seen
# overlap 相对 1.0–1.5 不进入
assert not any(abs(s[0] - 1.0) < 1e-6 and abs(s[1] - 1.5) < 1e-6 for s in seen), seen
import math
for e in out["speakerEmbeddings"]:
    n = math.sqrt(sum(x*x for x in e["embedding"]))
    assert abs(n - 1.0) < 1e-5
print(json.dumps({"ok": True, "crops": len(seen), "speakers": len(out["speakerEmbeddings"])}))
`;
  const r = spawnSync('python', ['-c', py], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
  const j = JSON.parse(String(r.stdout).trim().split('\n').pop());
  assert.equal(j.ok, true);
  assert.equal(j.speakers, 2);
});

test('R4: 空 embedding + unavailable 不标 pending；adapter 透传 embeddingStatus', async () => {
  assert.equal(validateSpeakerEmbeddings([], { allowEmpty: false }).ok, false);
  assert.equal(validateSpeakerEmbeddings([]).ok, true);

  const av = createAudioVisualAdapter({
    runner: async () => ({
      speakers: [{ speakerClusterId: 'S0' }],
      activeSegments: [],
      speakerEmbeddings: [],
      embeddingStatus: { ok: false, reason: 'unavailable', detail: 'no model' },
    }),
  });
  const out = await av.analyze({ audioPath: 'x.wav' });
  assert.equal(out.ok, true);
  assert.equal(out.embeddingStatus.reason, 'unavailable');
  assert.equal(out.speakerEmbeddings.length, 0);
});

test('R4: inference 抛错 → structured unavailable', () => {
  const py = `
import json, sys, types, importlib.util
core = types.ModuleType("pyannote")
core_core = types.ModuleType("pyannote.core")
class Segment:
    def __init__(self, start, end):
        self.start = float(start); self.end = float(end)
core_core.Segment = Segment
sys.modules["pyannote"] = core
sys.modules["pyannote.core"] = core_core
sys.modules["pyannote.audio"] = types.ModuleType("pyannote.audio")
spec = importlib.util.spec_from_file_location("avr", r${JSON.stringify(RUNNER)})
avr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(avr)
class Boom:
    def crop(self, *a, **k):
        raise RuntimeError("crop failed")
out = avr.compute_speaker_embeddings("x.wav", [(0, 2000, "S0")], inference=Boom())
assert out["ok"] is False
assert out["reason"] == "unavailable"
print(json.dumps(out))
`;
  const r = spawnSync('python', ['-c', py], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const j = JSON.parse(String(r.stdout).trim().split('\n').pop());
  assert.equal(j.ok, false);
});
