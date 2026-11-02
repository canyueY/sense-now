/**
 * time-mapping.js — 墙钟→视频时间分段线性映射（支持倍速/暂停/seek）。
 */

export function createTimeMapping({ clock = () => Date.now() } = {}) {
  /** @type {Array<{ wallStartMs, wallEndMs, videoStartMs, videoEndMs, playbackRate, reason }>} */
  const segments = [];
  let open = null;

  function openSegment({
    wallStartMs = clock(),
    videoStartMs,
    playbackRate = 1,
    reason = 'normal',
  }) {
    closeSegment({ wallEndMs: wallStartMs, reason: 'segment_replace' });
    open = {
      wallStartMs,
      wallEndMs: null,
      videoStartMs: Number(videoStartMs) || 0,
      videoEndMs: null,
      playbackRate: Number(playbackRate) > 0 ? Number(playbackRate) : 1,
      reason,
    };
    return open;
  }

  function closeSegment({ wallEndMs = clock(), videoEndMs = null, reason = null } = {}) {
    if (!open) return null;
    const wallEnd = Number(wallEndMs);
    const rate = open.playbackRate || 1;
    const computedVideoEnd = videoEndMs != null
      ? Number(videoEndMs)
      : open.videoStartMs + Math.max(0, wallEnd - open.wallStartMs) * rate;
    const seg = {
      ...open,
      wallEndMs: wallEnd,
      videoEndMs: computedVideoEnd,
      reason: reason || open.reason,
    };
    if (seg.wallEndMs > seg.wallStartMs) segments.push(seg);
    open = null;
    return seg;
  }

  function onPlayerSample(sample = {}) {
    const {
      currentTimeMs,
      paused,
      ended,
      playbackRate = 1,
      wallMs = clock(),
      event = null,
    } = sample;

    if (event === 'seek' || event === 'rate_change' || event === 'navigation') {
      closeSegment({ wallEndMs: wallMs, reason: event });
      if (!paused && !ended) {
        openSegment({
          wallStartMs: wallMs,
          videoStartMs: currentTimeMs,
          playbackRate,
          reason: event === 'rate_change' ? 'rate_change' : 'seek',
        });
      }
      return { segments: snapshot(), open };
    }

    if (paused || ended) {
      closeSegment({
        wallEndMs: wallMs,
        videoEndMs: currentTimeMs,
        reason: ended ? 'ended' : 'pause',
      });
      return { segments: snapshot(), open };
    }

    // resume / normal
    if (!open) {
      openSegment({
        wallStartMs: wallMs,
        videoStartMs: currentTimeMs,
        playbackRate,
        reason: 'normal',
      });
    } else if (Math.abs((open.playbackRate || 1) - playbackRate) > 1e-6) {
      closeSegment({ wallEndMs: wallMs, videoEndMs: currentTimeMs, reason: 'rate_change' });
      openSegment({
        wallStartMs: wallMs,
        videoStartMs: currentTimeMs,
        playbackRate,
        reason: 'rate_change',
      });
    }
    return { segments: snapshot(), open };
  }

  /**
   * 将墙钟时间插值到视频时间；找不到 mapping 返回 null（不伪造）。
   */
  function wallToVideo(wallMs) {
    const w = Number(wallMs);
    if (!Number.isFinite(w)) return null;
    for (const s of segments) {
      if (w >= s.wallStartMs && w <= s.wallEndMs) {
        const span = s.wallEndMs - s.wallStartMs;
        if (span <= 0) return s.videoStartMs;
        const t = (w - s.wallStartMs) / span;
        return s.videoStartMs + t * (s.videoEndMs - s.videoStartMs);
      }
    }
    if (open && w >= open.wallStartMs) {
      return open.videoStartMs + (w - open.wallStartMs) * (open.playbackRate || 1);
    }
    return null;
  }

  function snapshot() {
    return segments.map((s) => ({ ...s }));
  }

  /**
   * 含当前 open 段的只读快照（不关闭 open）。
   * 周期性 flush 时必须用此接口，否则连续播放的 mapping 为空 → 误退化为 wallclock。
   */
  function snapshotIncludingOpen({
    wallEndMs = clock(),
    videoEndMs = null,
  } = {}) {
    const out = snapshot();
    if (!open) return out;
    const wallEnd = Number(wallEndMs);
    const rate = open.playbackRate || 1;
    const computedVideoEnd = videoEndMs != null
      ? Number(videoEndMs)
      : open.videoStartMs + Math.max(0, wallEnd - open.wallStartMs) * rate;
    if (!(wallEnd > open.wallStartMs)) return out;
    out.push({
      ...open,
      wallEndMs: wallEnd,
      videoEndMs: computedVideoEnd,
      provisional: true,
    });
    return out;
  }

  function recordGap({ fromVideoMs, toVideoMs, reason = 'discontinuity' }) {
    return {
      kind: 'gap',
      fromVideoMs,
      toVideoMs,
      reason,
      recordedAt: new Date(clock()).toISOString(),
    };
  }

  return {
    openSegment,
    closeSegment,
    onPlayerSample,
    wallToVideo,
    snapshot,
    snapshotIncludingOpen,
    recordGap,
    get open() { return open ? { ...open } : null; },
  };
}
