/**
 * frame-gate.js — 本地视觉门控信号（纯函数，可单测）。
 */

export const FRAME_SIGNALS = Object.freeze([
  'frame_difference',
  'scene_boundary',
  'duplicate_rejected',
  'subtitle_change',
  'audio_event',
  'ocr_change',
  'entity_change',
  'manual_request',
]);

/**
 * 将 pipeline via / 分数映射为门控信号。
 */
export function signalsFromKeep({ via, score = 0, dup = null, subtitleChanged = false } = {}) {
  const signals = [];
  if (via === 'cut') signals.push('scene_boundary');
  if (via === 'mark' || via === 'start' || via === 'floor') signals.push('frame_difference');
  if (dup !== null && dup < 8) signals.push('duplicate_rejected');
  if (subtitleChanged) signals.push('subtitle_change');
  if (score > 0 && !signals.includes('frame_difference') && via !== 'cut') {
    signals.push('frame_difference');
  }
  return signals;
}

export function shouldKeepFrame(signals = []) {
  if (signals.includes('duplicate_rejected') && !signals.includes('scene_boundary') && !signals.includes('manual_request')) {
    return false;
  }
  return signals.some((s) => s === 'scene_boundary' || s === 'frame_difference'
    || s === 'subtitle_change' || s === 'manual_request' || s === 'audio_event'
    || s === 'ocr_change' || s === 'entity_change');
}
