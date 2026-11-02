/**
 * audio-visual-adapter.js — diarization / 主动说话人；默认 unavailable。
 */

export function createAudioVisualAdapter({
  runner = null,
  name = 'audio-visual-external',
  version = '1',
} = {}) {
  return {
    name,
    version,
    available() {
      if (!runner) {
        return { ok: false, reason: 'unavailable', detail: 'no diarization/active-speaker configured' };
      }
      return { ok: true };
    },
    async analyze(input, { signal } = {}) {
      const avail = this.available();
      if (!avail.ok) {
        return {
          ok: false,
          reason: 'unavailable',
          detail: avail.detail,
          speakers: [],
          activeSegments: [],
        };
      }
      if (signal?.aborted) {
        return { ok: false, reason: 'cancelled', speakers: [], activeSegments: [] };
      }
      try {
        const out = await runner(input, { signal });
        if (!out || !Array.isArray(out.speakers)) {
          return {
            ok: false,
            reason: 'invalid_schema',
            detail: 'speakers array required',
            speakers: [],
            activeSegments: [],
          };
        }
        return {
          ok: true,
          speakers: out.speakers,
          activeSegments: out.activeSegments || [],
          overlaps: out.overlaps || [],
          observations: out.observations || out.identityObservations || [],
          speakerEmbeddings: out.speakerEmbeddings || out.embeddings || [],
          embeddingStatus: out.embeddingStatus || null,
        };
      } catch (e) {
        return {
          ok: false,
          reason: 'failed',
          detail: e.message,
          speakers: [],
          activeSegments: [],
        };
      }
    },
  };
}
