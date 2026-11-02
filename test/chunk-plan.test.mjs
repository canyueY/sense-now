import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planChunks, ownsByMidpoint, dedupeUtterancesAcrossOverlap, chunkIdOf,
} from '../src/video-index/chunk-plan.js';

test('2h / 6h chunk plan：半开区间无空洞', () => {
  for (const hours of [2, 6]) {
    const dur = hours * 3600_000;
    const plan = planChunks({ durationMs: dur, chunkMs: 5 * 60_000, overlapMs: 20_000 });
    assert.ok(plan.length >= hours * 12 - 1);
    assert.equal(plan[0].startMs, 0);
    assert.equal(plan[plan.length - 1].endMs, dur);
    for (let i = 0; i < plan.length - 1; i += 1) {
      assert.equal(plan[i].endMs, plan[i + 1].startMs);
      assert.ok(plan[i].endMs > plan[i].startMs);
      assert.equal(plan[i].chunkId, chunkIdOf(i));
    }
  }
});

test('overlap ownership：中点决定归属，无双边重复', () => {
  const a = { startMs: 0, endMs: 300_000, inputStartMs: 0, inputEndMs: 320_000 };
  const b = { startMs: 300_000, endMs: 600_000, inputStartMs: 280_000, inputEndMs: 620_000 };
  const u = { startMs: 295_000, endMs: 305_000, text: 'boundary' };
  // mid=300000：半开 [0,300000) 不含；[300000,600000) 含
  assert.equal(ownsByMidpoint(u, a), false);
  assert.equal(ownsByMidpoint(u, b), true);
});

test('ASR overlap 去重：同文+重叠时间保留高置信', () => {
  const items = [
    { startMs: 100, endMs: 200, text: '你好 世界', confidence: 0.5, speakerClusterId: 'S1' },
    { startMs: 110, endMs: 210, text: '你好世界', confidence: 0.9, speakerClusterId: 'S1' },
    { startMs: 500, endMs: 600, text: '另一句', confidence: 0.8, speakerClusterId: 'S1' },
  ];
  const out = dedupeUtterancesAcrossOverlap(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].confidence, 0.9);
});
