/**
 * speech-activity-adapter.js — VAD/语音活动；默认不可用；需 policy 显式启用。
 */

export function createSpeechActivityAdapter({
  runner = null,
  name = 'speech-activity-external',
  version = '1',
} = {}) {
  return {
    name,
    version,
    available() {
      if (!runner) {
        return { ok: false, reason: 'unavailable', detail: 'no VAD runner configured' };
      }
      return { ok: true };
    },
    /**
     * @returns {{ ok, speechRanges, gaps, recommendations, capability }}
     */
    async analyze(input, { signal, policy } = {}) {
      if (!policy?.speechActivityAssist?.enabled) {
        return {
          ok: false,
          reason: 'disabled',
          speechRanges: [],
          gaps: [],
          recommendations: [],
          capability: 'disabled',
        };
      }
      if (!policy.speechActivityAssist.useVad) {
        return {
          ok: false,
          reason: 'vad_off',
          speechRanges: [],
          gaps: [],
          recommendations: [],
          capability: 'skipped',
        };
      }
      const avail = this.available();
      if (!avail.ok) {
        return {
          ok: false,
          reason: 'unavailable',
          detail: avail.detail,
          speechRanges: [],
          gaps: [],
          recommendations: [],
          capability: 'unavailable',
        };
      }
      if (signal?.aborted) {
        return {
          ok: false, reason: 'cancelled', speechRanges: [], gaps: [],
          recommendations: [], capability: 'degraded',
        };
      }
      try {
        const out = await runner(input, { signal });
        return {
          ok: true,
          speechRanges: out.speechRanges || out.ranges || [],
          gaps: out.gaps || [],
          recommendations: out.recommendations || [],
          capability: 'ready',
        };
      } catch (e) {
        return {
          ok: false,
          reason: 'failed',
          detail: e.message,
          speechRanges: [],
          gaps: [],
          recommendations: [],
          capability: 'degraded',
        };
      }
    },
  };
}
