/**
 * capture.js — 唯一 spawn ffmpeg 的地方。**一根 rawvideo 管道**，不再切分片。
 *
 * 为什么不是「2 秒一片 + `-ss` 回抓」：分片必须关闭才能 seek，光这一条就是 2 秒固定延迟；
 * 每抓一帧还要 spawn 一次 ffmpeg（实测 135ms）。实时场景要的是「帧到手就判、判完就留」，
 * 所以直接 `-f rawvideo` 吐 rgb24，帧在内存里，留帧零成本。
 *
 * ## 三种源的实测（本机 2560×1600 屏 / i9-12900HX，12fps → 800×450）
 *
 * | 源 | 首帧 | CPU | 备注 |
 * |---|---|---|---|
 * | `ddagrab`（桌面复制 API） | 370 ms | **0.28 核** | 走 GPU，屏幕的原生路子 |
 * | `gdigrab`（GDI 抓屏） | 310 ms | 0.45 核 | 每帧先从 GDI 拷 2560×1600 BGRA = **16 MB** 再缩 |
 * | `obs`（OBS 虚拟摄像头） | 575 ms | 0.13 核 | 设备侧已经缩好了，最省 |
 * | `camera`（USB 摄像头） | **1450 ms** | 0.14 核 | 首帧慢是**硬件唤醒**，参数救不了 |
 * | Nikon Webcam Utility（客户端没开） | — | 0.80 核 | 只有 3.4 fps，等于卡死 |
 *
 * 结论：屏幕源**默认用 ddagrab**，跑不起来退回 gdigrab；设备源别停进程 —— 首帧延迟只能靠常驻摊掉。
 */

import { spawn } from 'node:child_process';

export const ENGINES = Object.freeze(['auto', 'ddagrab', 'gdigrab']);

/** 源描述 → 输入参数。纯函数，可单测。 */
export function sourceArgs(source = { kind: 'screen' }, { engine = 'auto', fps = 12 } = {}) {
  const s = source ?? {};
  switch (s.kind) {
    case 'obs':
      return ['-rtbufsize', '256M', '-thread_queue_size', '512',
        '-f', 'dshow', '-i', `video=${s.device ?? 'OBS Virtual Camera'}`];
    case 'camera':
      return ['-rtbufsize', '256M', '-thread_queue_size', '512',
        '-f', 'dshow', '-i', `video=${s.device ?? 'HD Webcam'}`];
    case 'screen': {
      const useDda = s.engine === 'ddagrab' || (s.engine !== 'gdigrab' && engine !== 'gdigrab');
      if (!useDda) {
        // gdigrab 的 -framerate 是**设备侧**采样率，必须给，否则默认 29.97 白解码
        const region = s.region
          ? ['-offset_x', String(s.region.x), '-offset_y', String(s.region.y),
            '-video_size', `${s.region.w}x${s.region.h}`]
          : [];
        return ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0', ...region,
          '-i', s.desktop ?? 'desktop'];
      }
      // ddagrab 是 filter source；region 在 vf 链里 crop（见 captureArgs），此处不静默全屏
      return ['-f', 'lavfi', '-i', `ddagrab=framerate=${fps}:draw_mouse=${s.mouse ? 1 : 0}`];
    }
    case 'file':
      // `realtime` 才加 -re；离线跑要看的是「管线本身多快」，不能被播放速度骗了
      return [...(s.realtime ? ['-re'] : []), '-i', String(s.path)];
    case 'rtmp':
      return s.listen === false ? ['-i', String(s.url)] : ['-listen', '1', '-i', String(s.url)];
    default:
      throw new RangeError(`unknown source kind: ${s.kind}`);
  }
}

/** ddagrab 出来的帧还在 GPU 上，得先 hwdownload 再缩。 */
function isDda(source, engine) {
  if (source?.kind !== 'screen') return false;
  const e = source?.engine ?? engine;
  return e !== 'gdigrab';
}

/**
 * 完整的采集命令。
 *
 * **`-r` 只在源帧率不等于目标时才挂**：gdigrab/ddagrab 已经按 fps 抓了，
 * 再串一个 fps 滤镜是白跑一趟（实测 12fps 下省 3–5% CPU）。
 */
export function captureArgs({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  fast = true, sws = 'area',
} = {}) {
  const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-nostdin'];
  if (fast) {
    // `-fflags nobuffer` 只对**直播式**输入有意义，而且它会把 `-re` 的文件回放直接堵死
    // （实测：加上它、配上 -re，4 秒一个字节都不出；去掉立刻 57MB）。
    if (source?.kind !== 'file') args.push('-fflags', 'nobuffer');
    args.push('-flags', 'low_delay');
    if (source?.kind === 'obs' || source?.kind === 'camera') {
      args.push('-probesize', '32', '-analyzeduration', '0');
    }
  }
  args.push(...sourceArgs(source, { engine, fps }));
  args.push('-an', '-sn');
  const region = source?.region;
  const crop = region && Number.isFinite(region.x) && Number.isFinite(region.y)
    && (Number.isFinite(region.w) || Number.isFinite(region.width))
    && (Number.isFinite(region.h) || Number.isFinite(region.height))
    ? `crop=${region.w ?? region.width}:${region.h ?? region.height}:${region.x}:${region.y}`
    : null;
  if (isDda(source, engine)) {
    // ddagrab：hwdownload 后 crop，禁止无提示全屏
    const chain = crop
      ? `hwdownload,format=bgra,${crop},scale=${width}:${height}:flags=${sws}`
      : `hwdownload,format=bgra,scale=${width}:${height}:flags=${sws}`;
    args.push('-vf', chain);
  } else {
    args.push('-vf', `scale=${width}:${height}:flags=${sws}`);
  }
  if (source?.kind !== 'screen') args.push('-r', String(fps));
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  return args;
}

/**
 * 逐帧读，**同步回调**。回调里做的事会直接变成对 ffmpeg 的背压 —— 这是刻意的：
 * 判帧、留帧、重排都在回调里跑完，绝不让帧在内存里越堆越多。
 *
 * @returns {{stop:()=>void, done:Promise<{frames:number, ms:number, code:number|null}>}}
 */export function spawnFrames({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  onFrame, onStderr = null, onFirst = null,
} = {}) {
  const args = captureArgs({ source, width, height, fps, ffmpegPath, engine }).slice(1);
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const need = width * height * 3;
  let pending = null;
  let n = 0;
  const t0 = Date.now();
  let err = '';

  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      pending = pending?.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= need) {
        const buf = pending.subarray(0, need);
        pending = pending.subarray(need);
        const i = n;
        n += 1;
        if (i === 0) onFirst?.(Date.now() - t0);
        onFrame?.({ i, t: i / fps, buf });
      }
      if (pending.length === 0) pending = null;
    });
    child.stderr.on('data', (d) => {
      err = `${err}${d}`.slice(-4000);
      onStderr?.(String(d));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (err.trim() && code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-300)}`));
        return;
      }
      resolve({ frames: n, ms: Date.now() - t0, code });
    });
  });

  return {
    done,
    child,
    stop() {
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    },
  };
}

/* ---------------------------------------------------------------- 引擎探测 */

/**
 * 屏幕源用哪个引擎 —— **测一次、整个进程记住**。
 *
 * 为什么需要探测：`ddagrab` 走桌面复制 API，独占全屏的游戏 / 部分远程桌面会把它挡住
 * （报 "Selected output not supported" 或者干脆不吐帧）。那种情况下不能哑着 ——
 * 退到 `gdigrab` 只是多花 0.17 核，画面照样能看。
 *
 * 代价是进程里第一次开屏幕要多 spawn 一次 ffmpeg（~400ms）。所以结果缓存，
 * 之后每次 start 都是 0 成本；本机这两种引擎的可用性不会在一次会话里变。
 */
let cachedEngine = null;

export function resetScreenEngineCache() {
  cachedEngine = null;
}

export function pickScreenEngine({
  ffmpegPath = 'ffmpeg', fps = 12, timeoutMs = 2500,
} = {}) {
  if (cachedEngine) return Promise.resolve(cachedEngine);
  const W = 64;
  const H = 36;                     // 探针只取 1 帧，尺寸越小越快
  const args = captureArgs({
    source: { kind: 'screen', engine: 'ddagrab' }, width: W, height: H, fps, ffmpegPath, engine: 'ddagrab',
  }).slice(1);
  args.splice(args.length - 1, 0, '-frames:v', '1');

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let got = 0;
    const done = (engine) => {
      cachedEngine = engine;
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      resolve(engine);
    };
    const timer = setTimeout(() => done('gdigrab'), timeoutMs);
    child.stdout.on('data', (d) => {
      got += d.length;
      if (got >= W * H * 3) { clearTimeout(timer); done('ddagrab'); }
    });
    child.on('error', () => { clearTimeout(timer); done('gdigrab'); });
    child.on('close', () => { clearTimeout(timer); if (!got) done('gdigrab'); });
  });
}
