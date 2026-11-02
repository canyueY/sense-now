/**
 * entity-adapter.js — 人物/实体感知适配器接口；默认 unavailable。
 */

export function createEntityAdapter({ runner = null, command = null, name = 'entity-external', version = '1' } = {}) {
  return {
    name,
    version,
    available() {
      if (!runner && !command) {
        return { ok: false, reason: 'unavailable', detail: 'no entity/face model configured' };
      }
      return { ok: true };
    },
    async analyze(input, { signal } = {}) {
      const avail = this.available();
      if (!avail.ok) {
        return { ok: false, reason: 'unavailable', detail: avail.detail, faces: [], tracks: [] };
      }
      if (signal?.aborted) {
        return { ok: false, reason: 'cancelled', faces: [], tracks: [] };
      }
      if (!runner) {
        return { ok: false, reason: 'unavailable', detail: 'runner required', faces: [], tracks: [] };
      }
      try {
        const out = await runner(input, { signal });
        if (!out || !Array.isArray(out.faces)) {
          return { ok: false, reason: 'invalid_schema', detail: 'faces array required', faces: [], tracks: [] };
        }
        return { ok: true, faces: out.faces, tracks: out.tracks || [] };
      } catch (e) {
        return { ok: false, reason: 'failed', detail: e.message, faces: [], tracks: [] };
      }
    },
  };
}
