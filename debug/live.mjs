#!/usr/bin/env node
/**
 * debug/live.mjs — 实时调试窗：把「抓到哪一帧、为什么留下、怎么排进 sheet」画给人看。
 *
 *   node debug/live.mjs                        # 屏幕源，自动开小窗
 *   node debug/live.mjs --source=file --file=samples/x.mp4 --realtime=1
 *   node debug/live.mjs --port=9411 --seconds=120
 *   node debug/live.mjs --dtFrames=24 --maxWaitSec=20 --markBoost=0    # 参数透传
 *
 * ## 这个文件不在插件里
 *
 * 它放在 `debug/`，不进 `src/`、不在 package.json 的 `files`、`install-dev` 也会跳过。
 * 插件本体完全不知道它存在 —— 它只是**从外面**驱动同一条流水线：
 *
 *     capture.spawnFrames → pipeline.push → pipeline.take → 浏览器
 *
 * 用的都是插件已经公开的读口（`log` / `stats` / `tiers` / `take()` / `constants`），
 * 一行 `src/` 都没改。这样调试窗永远看到的是**真实发生的事**，而不是一份影子实现。
 *
 * ## 唯一复算的地方，和它的自我校验
 *
 * 「正在拼的这一批会排成什么样」在插件里没有读口（`plan()` 是闭包内的私有函数）。
 * 这里照 `pipeline.js` 的 `seqOf()` 复算一遍（假切点加成 + applyStrategy），
 * 然后 **每出一张图就对拍一次**：把 sheet 自己的 `frames` 再算一遍，
 * 和真实 `cells` 逐个比像素。不一致就在窗口上标红 —— 复算可以，但不能悄悄错。
 *
 * 同理，积分累积量（`acc`）也是复算的：每一帧加自己的分，遇到 `cut` 清零、
 * 遇到真正留下的 `mark` 清零。**留下 mark 时如果累计量还没到阈值，说明复算漂了**，
 * 那一栏会自己变成「漂移」并且不再显示数字。
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';

import { spawnFrames, pickScreenEngine } from '../src/capture.js';
import { createPipeline, REF_SCORE } from '../src/pipeline.js';
import { SCENE_OPTS } from '../src/runner.js';
import { createScorer } from '../src/cuts.js';
import { applyStrategy } from '../src/tiers.js';
import { solve, toRects } from '../src/pack.js';
import { coverInto } from '../src/scale.js';
import { encodePng } from '../src/png.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ 参数 */

const NUM = new Set(['width', 'height', 'fps', 'cutAbs', 'cutSpike', 'cutMinGap',
  'integralSeconds', 'markMinGap', 'silentFloorSec', 'dtFrames', 'smoothFrames', 'dupMin',
  'maxWaitSec', 'flushGain', 'maxFrames', 'binCost', 'markBoost', 'floorBoost',
  'boostMinFrames', 'port', 'seconds']);

const opts = {};
const flags = {};
const rest = argv.slice(2);
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i];
  if (!a.startsWith('--')) continue;
  const body = a.slice(2);
  const eq = body.indexOf('=');
  const k = eq >= 0 ? body.slice(0, eq) : body;
  let v = eq >= 0 ? body.slice(eq + 1) : true;
  // `--port 9411` 也认：**cmd 会把 `--port=9411` 按 `=` 拆成两段**，
  // 从 .cmd 里转发参数时只能拿到拆开的形式。顺手也让命令行更宽松。
  if (v === true && NUM.has(k) && rest[i + 1] !== undefined && !String(rest[i + 1]).startsWith('--')) {
    v = rest[i + 1];
    i += 1;
  }
  if (NUM.has(k)) opts[k] = Number(v);
  else flags[k] = v;
}

const PORT = Number(opts.port) || 9411;
const MAX_SEC = Number(opts.seconds) || 0;
const SOURCE = String(flags.source ?? 'screen');
const WIDTH = Number(opts.width) || 800;
const HEIGHT = Number(opts.height) || 450;
const FPS = Number(opts.fps) || 12;
const OPEN = flags.open !== false && !flags['no-open'];

/* -------------------------------------------------------------- 缩略图 */

const TW = 176;                       // 帧流里的缩略图（覆盖式缩放，保持比例）
const TH = 99;
const KW = 480;                       // 进了 sheet 的那几帧给大一点，格子里要看得清
const KH = 270;

/** rawvideo rgb24 → 小图 base64。实测 176×99 缩放 + PNG(level1) ≈ 1.5ms。 */
function thumbOf(buf, w = TW, h = TH) {
  const dst = Buffer.alloc(w * h * 3);
  coverInto(buf, WIDTH, HEIGHT, dst, w, h);
  return encodePng(dst, w, h, { level: 1 }).toString('base64');
}

/* ------------------------------------------------------------ 事件广播 */

const clients = new Set();

function send(event, data, target = null) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (target) { try { target.write(frame); } catch { /* 走了 */ } return; }
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

/* ------------------------------------------------------- 复算：排布与积分 */

const p = createPipeline({
  width: WIDTH, height: HEIGHT, fps: FPS, queueDepth: 0,
  // `--scene`：看逐帧模式的效果（一张图一帧、铺满），和插件里 scene:true 完全同参
  ...(flags.scene === true ? { ...SCENE_OPTS } : {}),
  ...opts,
});
const O = p.constants;
const dbg = createScorer({ width: WIDTH, height: HEIGHT });

/** 与 pipeline.js 的 seqOf() 必须逐字对应（加成 + 策略）。 */
function seqOf(rows) {
  const on = rows.length >= Math.max(1, Number(O.boostMinFrames) || 4);
  const boostFor = (via) => {
    if (!on) return 0;
    const raw = via === 'mark' ? O.markBoost : via === 'floor' ? O.floorBoost : 0;
    return Math.max(0, Number(raw) || 0);
  };
  return rows.map((r) => applyStrategy([Math.min(8, r.level + boostFor(r.via))], O.strategy)[0]);
}

/** 这一批会排成什么样 —— 与 flush() 同口径（单箱 + toRects）。 */
function layoutOf(rows) {
  if (!rows.length) return { seq: [], bins: 0, fill: 0, cells: [] };
  const seq = seqOf(rows);
  const pl = solve(seq, { binCost: O.binCost });
  const kept = pl.cells.filter((c) => c.bin === 0);
  const rects = toRects(kept, { width: WIDTH, height: HEIGHT, gutter: 0 });
  const area = kept.reduce((acc, c) => acc + c.w * c.h, 0);
  return {
    seq,
    bins: pl.bins,
    fill: area,
    cells: rects.map((r) => ({ px: r.px, py: r.py, pw: r.pw, ph: r.ph, tier: r.t })),
  };
}

let acc = 0;                 // 复算的积分累积
let accDrift = false;        // 复算和真实判据对不上 → 停止显示数字
let pendingRows = [];        // 本批已留下、还没出图的帧（log 的尾巴）
const pendThumbs = new Map(); // t → 小缩略图（握手时补发给中途连上来的页面）
let consumedTo = -Infinity;  // 最近一张图用到的最晚时刻
let layoutCheck = { ok: 0, bad: 0, lastBad: null };

const need = REF_SCORE * FPS * (Number(O.integralSeconds) || 3);

/**
 * 复算 `decide()` 的那几行。
 *
 * **必须和插件一样晚一帧**：插件是第 k+1 帧到手才判第 k 帧，所以它的 `acc`
 * 永远差一帧。早先这里"看到帧就加自己的分"，然后在看到 mark 时清零 ——
 * 结果是**先把当前帧的分加进去、再连它一起抹掉**，每留一个积分帧就少一帧的量。
 * 实测 6 秒那个积分帧：复算 140.7，阈值 144，差 3.4 —— 正好一帧的分。
 * 现在按队列走，逐帧对位，`acc` 与插件逐值相同。
 */
const pend = [];             // 还没被判定的帧 {t, sc}

function decideMine(entry, kept) {
  if (entry.sc === null) return;                       // 首帧：插件直接 return，不累加
  if (kept && kept.via === 'cut') { acc = 0; return; } // 跨刀那一帧的分不算运动
  acc += entry.sc;
  if (kept && kept.via === 'mark') {
    if (acc < need - 1e-6) {
      if (!accDrift) {
        process.stderr.write(`[debug] 积分复算漂移：t=${kept.t}s 复算 ${acc.toFixed(1)} < 阈值 ${need}\n`);
      }
      accDrift = true;
    }
    acc = 0;
  }
  // floor / dup 被挡：都不动 acc（插件同）
}

/* -------------------------------------------------------------- 出图 */

const RECENT_MAX = 6;
const recentSheets = [];     // 最近几张的完整载荷：刷新页面不用重跑也能看到刚才那几张

function emitSheet(s, why2 = null, target = null) {
  if (!s) return;
  consumedTo = Math.max(consumedTo, s.to);

  // 用这张图**自己的帧**复算一遍，和真实 cells 逐个对拍。
  // 这一步是「复算可以，但不能悄悄错」的唯一保险。
  const rows = s.frames.map((f) => ({ level: f.level, via: f.via }));
  const pred = layoutOf(rows);
  const same = pred.cells.length === s.cells.length
    && pred.cells.every((c, i) => Math.abs(c.px - s.cells[i].px) <= 1
      && Math.abs(c.py - s.cells[i].py) <= 1
      && Math.abs(c.pw - s.cells[i].pw) <= 1
      && Math.abs(c.ph - s.cells[i].ph) <= 1
      && c.tier === s.cells[i].tier);
  if (same) layoutCheck.ok += 1;
  else {
    layoutCheck.bad += 1;
    layoutCheck.lastBad = { at: +s.at.toFixed(2), pred: pred.cells, real: s.cells };
  }

  const payload = {
    at: +s.at.toFixed(2),
    from: +s.from.toFixed(2),
    to: +s.to.toFixed(2),
    why: s.why,
    whyNote: why2,
    fill: s.fill,
    bins: s.bins,
    frames: s.frames.map((f) => ({ t: f.t, tier: f.tier, level: f.level, via: f.via })),
    cells: s.cells,
    tokens: Math.round((WIDTH * HEIGHT) / 1667),
    kb: Math.round(s.png.length / 1024),
    png: `data:image/png;base64,${s.png.toString('base64')}`,
    check: same ? 'ok' : 'bad',
    checkCounts: { ok: layoutCheck.ok, bad: layoutCheck.bad },
  };
  recentSheets.push(payload);
  while (recentSheets.length > RECENT_MAX) recentSheets.shift();
  send('sheet', payload, target);
}

function drainSheets() {
  for (;;) {
    const s = p.take();
    if (!s) break;
    emitSheet(s);
  }
  pendingRows = p.log.filter((r) => r.t > consumedTo);
  // 已进图的缩略图没人要了，别让它跟着进程一起长（40 帧 × 十几 KB 也是几 MB）
  for (const t of pendThumbs.keys()) if (t <= consumedTo) pendThumbs.delete(t);
}

function emitBatch({ target = null, withThumbs = false } = {}) {
  const lay = layoutOf(pendingRows);
  send('batch', {
    rows: pendingRows.map((r, i) => ({
      t: r.t, level: r.level, tier: lay.seq[i] ?? r.tier, base: r.tier, via: r.via,
      score: r.score, dup: r.dup,
      // 只在握手时带图：中途连上来的页面手里没有"之前那几帧"的缩略图，
      // 靠这个把当前这批补齐（平时靠 frame 事件，不带图省带宽）
      ...(withThumbs ? { img: pendThumbs.get(r.t) ?? null } : {}),
    })),
    layout: lay,
    // 装不下会立刻出图，所以这里 bins>1 只在"刚到第 N 帧、还没判"的一瞬间出现
    overflow: lay.bins > 1,
  }, target);
}

/* ---------------------------------------------------------------- 主循环 */

let frames = 0;
let t0 = Date.now();
let lastStats = 0;
let stopping = false;

function emitFrame(e, kept) {
  const t = +e.t.toFixed(2);
  const small = thumbOf(e.buf);
  if (kept) pendThumbs.set(t, small);
  send('frame', {
    i: e.i, t, score: e.sc === null ? null : +e.sc.toFixed(1),
    kept: Boolean(kept),
    via: kept?.via ?? null,
    level: kept?.level ?? p.tiers.levelAt(),
    tier: kept?.tier ?? null,
    dup: kept?.dup ?? null,
    density: +p.tiers.density.toFixed(3),
    // 缩略图必须取**被判定的那一帧**的 buffer，否则会因为差一帧而挂到错的 t 上
    img: small,
    big: kept ? thumbOf(e.buf, KW, KH) : null,
    acc: accDrift ? null : Math.round(acc),
    need,
    drift: accDrift,
  });
}

function onFrame(f) {
  frames += 1;

  // 分数自己算一份：插件只在 log 里记**留下**的帧，而这里要看全部。
  // 同一个 scorer、同一帧顺序 → 分数与插件内部逐值相同（实测总和 0 差）。
  const sc = dbg(f.buf).score;
  const before = p.log.length;
  pend.push({ t: f.t, i: f.i, buf: f.buf, sc });
  p.push(f);
  // 注意：log 长出来的是**上一帧**的判定结果（插件延迟一帧），不是这一帧
  const kept = p.log.length > before ? p.log[p.log.length - 1] : null;

  // 按插件的一帧延迟推进：这一拍被判的是 pend[0]，用它的 buffer 发帧
  while (pend.length >= 2) {
    const e = pend.shift();
    const isKept = kept && Math.abs(kept.t - +e.t.toFixed(2)) < 0.005 ? kept : null;
    decideMine(e, isKept);
    emitFrame(e, isKept);
  }

  drainSheets();
  if (kept) emitBatch();

  const now = Date.now();
  if (now - lastStats >= 500) {
    lastStats = now;
    send('stats', {
      ...p.stats,
      elapsed: (now - t0) / 1000,
      realFps: frames / ((now - t0) / 1000),
      pending: p.pending,
      batch: pendingRows.length,
      density: +p.tiers.density.toFixed(3),
      level: p.tiers.levelAt(),
      acc: accDrift ? null : Math.round(acc),
      need,
      drift: accDrift,
      check: layoutCheck,
    });
  }

  if (MAX_SEC > 0 && f.t >= MAX_SEC) stop('到点了');
}

/* ------------------------------------------------------------------ 停止 */

let capture = null;
let stoppingPromise = null;

function stop(reason) {
  if (stopping) return stoppingPromise;
  stopping = true;
  capture?.stop();
  stoppingPromise = (async () => {
    // finish() 会把尾巴判完并出图；`sheets` 是内部数组，take() 已经取走的都移除了，
    // 所以这里剩下的就是还没发出去的。
    const { stats, sheets } = p.finish();
    for (const s of sheets) emitSheet(s);
    send('done', { reason, stats, check: layoutCheck });
    process.stderr.write(`\n[debug] 停了（${reason}）  ${frames} 帧 · 出图 ${stats.sheets} 张\n`
      + '[debug] 结果还开着，窗口里可以继续看；关掉这个黑窗口就退出。\n');
  })();
  return stoppingPromise;
}

/* ------------------------------------------------------------------ HTTP */

const HTML = readFileSync(join(HERE, 'live.html'), 'utf8');

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(HTML);
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': hello\n\n');
    clients.add(res);
    // 新连接补一份现状，刷新页面不用重开采集（只发给这一个连接，不广播）
    const hello = `event: hello\ndata: ${JSON.stringify({
      constants: { width: WIDTH, height: HEIGHT, fps: FPS, ...O },
      need, refScore: REF_SCORE, source: SOURCE,
      sourceDetail: SOURCE === 'file' ? basename(String(flags.file ?? '')) : String(flags.device ?? ''),
    })}\n\n`;
    res.write(hello);
    // 顺序有讲究：先补历史图，再补当前批次 —— 客户端收到 sheet 会清空格子，
    // 最后到的必须是 batch，不然中途连上来会看到一片空。
    for (const s of recentSheets) send('sheet', s, res);
    emitBatch({ target: res, withThumbs: true });
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/cmd') {
    const what = url.searchParams.get('do');
    if (what === 'interject') {
      // 走真实插话路径：立刻把这一批截断出图（老帧从最老的开始丢）
      const made = p.flushNow();
      if (made) { emitSheet(made, 'interject'); pendingRows = []; }
      send('note', { text: '已模拟一次插话（flushNow）' });
      res.end('ok');
      return;
    }
    if (what === 'stop') { void stop('手动停止'); res.end('ok'); return; }
    res.writeHead(400); res.end('unknown');
    return;
  }

  if (url.pathname === '/health') {
    // 给"第二次双击"用：端口被占时先问一声是不是自己人
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ app: 'sense-now-debug', source: SOURCE }));
    return;
  }

  res.writeHead(404); res.end();
});

/* --------------------------------------------------------------- 起服务 */

async function isOurServer(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600) });
    const j = await r.json();
    return j?.app === 'sense-now-debug';
  } catch {
    return false;
  }
}

/** 从 PORT 起往后找空位。端口上有我们自己的实例就不抢，直接把窗口指过去。 */
async function bindPort() {
  for (let i = 0; i < 8; i += 1) {
    const port = PORT + i;
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => { server.off('listening', onListening); reject(e); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return { port, fresh: true };
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (await isOurServer(port)) return { port, fresh: false };
      // 被别的程序占着 → 换一个
    }
  }
  return null;
}

const bound = await bindPort();
if (!bound) {
  process.stderr.write(`[debug] 端口 ${PORT}~${PORT + 7} 都被占了，没法起。\n`);
  exit(2);
}

const URL_BASE = `http://127.0.0.1:${bound.port}`;

if (!bound.fresh) {
  process.stderr.write(`[debug] ${URL_BASE} 已经在跑了，直接把窗口指过去。\n`
    + '        要重开一份就先关掉原来那个黑窗口。\n');
  if (OPEN) openWindow(URL_BASE);
  exit(0);
}

{
  process.stderr.write(`[debug] ${URL_BASE}\n`);

  const engine = SOURCE === 'screen' ? await pickScreenEngine({ fps: FPS }) : 'auto';
  const source = SOURCE === 'screen' ? { kind: 'screen', engine }
    : SOURCE === 'file' ? { kind: 'file', path: String(flags.file ?? ''), realtime: Boolean(flags.realtime) }
      : SOURCE === 'obs' ? { kind: 'obs', device: flags.device }
        : SOURCE === 'camera' ? { kind: 'camera', device: flags.device }
          : { kind: 'screen', engine };

  process.stderr.write(`[debug] 源 ${SOURCE} · 引擎 ${engine} · ${WIDTH}×${HEIGHT}@${FPS}fps\n`);
  if (OPEN) openWindow(URL_BASE);

  t0 = Date.now();
  capture = spawnFrames({
    source, width: WIDTH, height: HEIGHT, fps: FPS,
    onFrame,
    onStderr: (s) => process.stderr.write(s),
  });

  capture.done.then(() => stop('输入结束')).catch((e) => {
    process.stderr.write(`[debug] 采集失败：${e.message}\n`);
    void stop('采集失败');
  });
}

/* --------------------------------------------------------------- 开小窗 */

/**
 * `--app=` 在 Edge/Chrome 里会开一个**没有地址栏、没有标签页**的独立窗口，
 * 看起来就是个原生小工具。找不到浏览器就退回默认浏览器（有地址栏，但能用）。
 */
function openWindow(url) {
  // 尺寸按**物理像素**给：150% 缩放下 1220 只会得到 813 的 CSS 宽度，挤。
  // 1440×900 在本机（150%）约等于 960×600 的可用区，100% 缩放的机器上也不至于太夸张。
  const size = '--window-size=1440,900';
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  const exe = cands.find((c) => existsSync(c));
  if (!exe) {
    process.stderr.write('[debug] 没找到 Edge/Chrome，请手动打开上面的地址\n');
    return;
  }
  const child = spawn(exe, [`--app=${url}`, size, '--window-position=140,90',
    '--disable-features=Translate', '--no-first-run'], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
}

/* ------------------------------------------------------------- 优雅退出 */

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await stop(sig);
    server.close();
    // ffmpeg 已经 kill 了；给 SSE 一点时间把最后一帧发出去
    setTimeout(() => exit(0), 120);
  });
}
