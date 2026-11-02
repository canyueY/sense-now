/** audio-pipeline.js — diarization 管线包装。 */
import { createAudioVisualAdapter } from './adapters/audio-visual-adapter.js';

export function createAudioPipeline(opts = {}) {
  return createAudioVisualAdapter({ ...opts, name: opts.name || 'audio-pipeline' });
}
