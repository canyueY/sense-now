#!/usr/bin/env node
/**
 * 超长视频合成索引 benchmark（不进默认 npm test）。
 * 用法：
 *   npm run bench:long-video -- --duration-hours 6 --chunk-minutes 5
 *   node scripts/bench-long-video.mjs --duration-hours 2 --chunk-minutes 5
 *
 * 只报告本机实测：数据规模、读取 chunk 数、峰值内存、P50/P95。
 * 不写死虚假性能结论。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createChunkStore } from '../src/video-index/chunk-store.js';
import { planChunks } from '../src/video-index/chunk-plan.js';
import {
  selectChunksFromCatalog, mergeChunkViews, retrieve,
} from '../src/video-index/index-retriever.js';

const rawArgs = process.argv.slice(2);
const args = {};
for (let i = 0; i < rawArgs.length; i += 1) {
  const a = rawArgs[i];
  const eq = a.match(/^--([^=]+)=(.*)$/);
  if (eq) {
    args[eq[1]] = eq[2];
    continue;
  }
  const flag = a.match(/^--(.+)$/);
  if (flag) {
    const next = rawArgs[i + 1];
    if (next && !next.startsWith('--')) {
      args[flag[1]] = next;
      i += 1;
    } else {
      args[flag[1]] = true;
    }
  }
}

const hours = Number(args['duration-hours'] || 6);
const chunkMinutes = Number(args['chunk-minutes'] || 5);
const durationMs = hours * 3600_000;
const chunkMs = chunkMinutes * 60_000;

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const root = mkdtempSync(join(tmpdir(), 'sense-now-long-bench-'));
const videoKey = `bench:synthetic:${hours}h`;
const plan = planChunks({ durationMs, chunkMs, overlapMs: 20_000 });
const store = createChunkStore({ rootDir: root, videoKey });

const tBuild0 = performance.now();
for (const c of plan) {
  const mid = Math.floor((c.startMs + c.endMs) / 2);
  store.commitChunk(c.chunkId, {
    chunkManifest: {
      chunkId: c.chunkId,
      revision: 1,
      startMs: c.startMs,
      endMs: c.endMs,
      inputStartMs: c.inputStartMs,
      inputEndMs: c.inputEndMs,
      status: 'ready',
      sourceMode: 'file',
      timeSource: 'stream',
      discontinuity: false,
      gaps: [],
      capabilities: { asr: 'ready' },
      counts: { utterances: 2 },
      byteUsage: { downloaded: 0, temporaryPeak: 0 },
      provenance: { generatedAt: new Date().toISOString() },
      error: null,
    },
    utterances: [
      {
        utteranceId: `u-${c.chunkId}-a`,
        startMs: c.startMs + 1000,
        endMs: c.startMs + 4000,
        text: `chunk ${c.chunkId} opening remarks about topic alpha`,
        evidenceId: `e-${c.chunkId}-a`,
      },
      {
        utteranceId: `u-${c.chunkId}-b`,
        startMs: mid,
        endMs: mid + 2000,
        text: `chunk ${c.chunkId} middle content beta`,
        evidenceId: `e-${c.chunkId}-b`,
      },
    ],
    events: [],
    speakers: [{ speakerClusterId: `C${c.chunkId}_SPEAKER_00` }],
    storyboard: [],
    evidence: [],
    chapters: [{
      chapterId: `ch-${c.chunkId}`,
      startMs: c.startMs,
      endMs: c.endMs,
      title: `chunk ${c.chunkId} opening remarks`,
      topicTags: ['alpha'],
    }],
  });
}
const catalog = store.rebuildCatalog();
const buildMs = performance.now() - tBuild0;

const questions = [
  'topic alpha',
  'middle content',
  '1:00:00 那段',
  '讲了什么',
  'opening remarks',
];
const latencies = [];
let totalChunksRead = 0;
const memBefore = process.memoryUsage().heapUsed;

for (let i = 0; i < 40; i += 1) {
  const q = questions[i % questions.length];
  const t0 = performance.now();
  const sel = selectChunksFromCatalog(catalog, { question: q, queryType: 'text_structure', topK: 3 });
  const loaded = sel.chunkIds.map((id) => store.readChunk(id));
  totalChunksRead += loaded.length;
  const merged = mergeChunkViews(loaded);
  retrieve(merged, { question: q, queryType: 'text_structure', maxUtterances: 12 });
  latencies.push(performance.now() - t0);
}
const memAfter = process.memoryUsage().heapUsed;
latencies.sort((a, b) => a - b);

console.log(JSON.stringify({
  machine: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: cpus()?.length ?? null,
  },
  config: { durationHours: hours, chunkMinutes, chunkCount: plan.length },
  buildMs: Math.round(buildMs),
  catalogChunks: catalog.length,
  query: {
    samples: latencies.length,
    chunksReadTotal: totalChunksRead,
    chunksReadAvg: totalChunksRead / latencies.length,
    p50Ms: Math.round(pct(latencies, 50) * 100) / 100,
    p95Ms: Math.round(pct(latencies, 95) * 100) / 100,
    heapDeltaMb: Math.round(((memAfter - memBefore) / 1024 / 1024) * 100) / 100,
    peakHeapMb: Math.round((memAfter / 1024 / 1024) * 100) / 100,
  },
  note: 'Measured on this machine only; do not treat as product SLA.',
}, null, 2));

try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
