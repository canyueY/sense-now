#!/usr/bin/env node
/**
 * A/B benchmark 接口：A=每次查询重构造；B=先索引再检索。
 * 无真实模型计费时只报告可测输入规模，不推导虚假金额。
 *
 * 用法：
 *   node scripts/bench-video-index.mjs --path=video.mp4
 *   node scripts/bench-video-index.mjs --synthetic
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

function solid(w, h, v) {
  return Buffer.alloc(w * h * 3, v);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-bench-'));
  const path = args.path || join(root, 'synthetic.mp4');
  if (args.synthetic || !args.path) writeFileSync(path, Buffer.from('synthetic'));

  const frames = Array.from({ length: 24 }, (_, i) => ({
    t: i * 0.5,
    buf: solid(64, 36, (i * 40) % 255),
  }));

  const engine = createVideoIndexEngine({
    rootDir: root,
    adapters: {
      extractFrames: async () => frames,
    },
  });

  const questions = [
    '这个视频讲了什么',
    '什么时候提到记忆',
    '画面里是什么',
    '总结主题',
    '开头说了什么',
    '有哪些章节',
    '界面颜色怎么样',
    '1:00 那段内容',
    '深度分析论证',
    '核心概念是什么',
  ];

  const t0 = performance.now();
  const indexed = await engine.index({
    source: {
      kind: 'file',
      path,
      subtitles: [
        { startMs: 0, endMs: 2000, text: '介绍记忆架构与系统设计' },
        { startMs: 5000, endMs: 8000, text: '实现细节与证据追溯' },
        { startMs: 12000, endMs: 15000, text: '查询路由与预算控制' },
      ],
    },
  }, { width: 64, height: 36 });
  const indexMs = performance.now() - t0;

  // B：索引后连续 10 次查询
  const bStats = [];
  const tB0 = performance.now();
  for (const q of questions) {
    const t = performance.now();
    const r = engine.query({ videoKey: indexed.videoKey, question: q });
    bStats.push({
      q,
      ms: performance.now() - t,
      chapters: r.context.chapters.length,
      events: r.context.events.length,
      utterances: r.context.utterances.length,
      visual: r.visualEvidence.length,
      textTokens: r.budget.used.textTokens,
      visualTokens: r.budget.used.visualTokens,
      estimated: r.budget.estimated,
      cacheHit: r.cache.hit,
      decision: r.decision,
      queryType: r.queryType,
    });
  }
  const bTotalMs = performance.now() - tB0;

  // A：模拟每次重新构造（重复 rebuild index + query）——昂贵基线
  const aStats = [];
  const tA0 = performance.now();
  for (const q of questions.slice(0, 3)) {
    const t = performance.now();
    await engine.index({
      source: {
        kind: 'file',
        path,
        subtitles: [
          { startMs: 0, endMs: 2000, text: '介绍记忆架构与系统设计' },
        ],
      },
    }, { rebuild: true, width: 64, height: 36 });
    const r = engine.query({ videoKey: indexed.videoKey, question: q });
    aStats.push({ q, ms: performance.now() - t, visual: r.visualEvidence.length });
  }
  const aTotalMs = performance.now() - tA0;

  const report = {
    measuredAt: new Date().toISOString(),
    note: '无真实模型计费；只报告可测输入规模与延迟',
    index: {
      videoKey: indexed.videoKey,
      status: indexed.manifest.status,
      firstIndexMs: +indexMs.toFixed(1),
      counts: indexed.manifest.counts,
      capabilities: indexed.manifest.capabilities,
    },
    pathB_indexThenQuery: {
      queries: bStats.length,
      totalMs: +bTotalMs.toFixed(1),
      cacheHits: bStats.filter((s) => s.cacheHit).length,
      avgMs: +(bTotalMs / bStats.length).toFixed(1),
      details: bStats,
    },
    pathA_rebuildEachQuery: {
      queries: aStats.length,
      totalMs: +aTotalMs.toFixed(1),
      avgMs: +(aTotalMs / Math.max(1, aStats.length)).toFixed(1),
      details: aStats,
      note: '仅抽样 3 次；完整 10 次未跑以节省 CI',
    },
    unmeasured: [
      '真实 tokenizer token 数（本报告 estimated=true）',
      '模型计费金额',
      '真实 ffmpeg 全片解码（本 bench 注入 synthetic frames）',
      'Storyboard 命中率（需真实长视频）',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
