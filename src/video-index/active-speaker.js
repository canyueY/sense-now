/** active-speaker.js — 主动说话人检测包装。 */
import { createAudioVisualAdapter } from './adapters/audio-visual-adapter.js';

export function createActiveSpeaker(opts = {}) {
  const inner = createAudioVisualAdapter({ ...opts, name: opts.name || 'active-speaker' });
  return {
    ...inner,
    async analyze(input, ctx) {
      const r = await inner.analyze(input, ctx);
      if (!r.ok) return r;
      return {
        ...r,
        activeSegments: r.activeSegments || [],
      };
    },
  };
}
