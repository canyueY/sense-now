/**
 * screen-frame-source.js — 生产默认区域抓屏（底层 spawnFrames）。
 * 只回调 raw RGB buffer；由 capture controller 在保留闸门后编码 PNG。
 */

import { spawnFrames } from '../../capture.js';
import { validateManualRegion } from '../capture-source.js';
import { killProcessTree } from '../bounded-stdio.js';

export function createScreenFrameSource({
  ffmpegPath = 'ffmpeg',
  spawnFramesImpl = spawnFrames,
  width = 320,
  height = 180,
  fps = 1,
  engine = 'auto',
} = {}) {
  return {
    kind: 'screen-frame-source',
    start({ region, outDir, onFrame }) {
      void outDir; // 不再预写 PNG；保留路径由 controller 决定
      const r = validateManualRegion(region);
      let n = 0;
      let busy = false;
      let stopped = false;
      let childHandle = null;

      const source = {
        kind: 'screen',
        engine,
        region: { x: r.x, y: r.y, w: r.width, h: r.height },
      };

      try {
        childHandle = spawnFramesImpl({
          source,
          width,
          height,
          fps,
          ffmpegPath,
          engine,
          onFrame: (frame) => {
            if (stopped || busy) return;
            busy = true;
            try {
              const buf = frame.buf;
              if (!buf) return;
              // raw 仅在 callback 生命周期；不写磁盘
              onFrame?.({
                buf,
                width,
                height,
                t: frame.t ?? n / fps,
              });
              n += 1;
            } catch { /* ignore single frame */ } finally {
              busy = false;
            }
          },
        });
      } catch (e) {
        const err = new Error(`screen frame source failed: ${e.message}`);
        err.code = 'FRAME_UNAVAILABLE';
        throw err;
      }

      return {
        stop: async () => {
          stopped = true;
          try {
            childHandle?.stop?.();
          } catch { /* ignore */ }
          try {
            const pid = childHandle?.child?.pid;
            if (pid) killProcessTree(pid);
          } catch { /* ignore */ }
          try {
            await childHandle?.done;
          } catch { /* ignore */ }
        },
        get frameCount() { return n; },
        get child() { return childHandle?.child || null; },
      };
    },
  };
}
