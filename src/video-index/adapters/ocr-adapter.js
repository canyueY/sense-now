/**
 * ocr-adapter.js — 外部命令 OCR；未配置时明确 unavailable，不伪造。
 */

import { createAsrAdapter } from './asr-adapter.js';

/** 复用外部命令协议形状，字段为 regions 而非 utterances。 */
export function createOcrAdapter(opts = {}) {
  const base = createAsrAdapter({
    ...opts,
    name: opts.name || 'ocr-external',
  });
  return {
    name: base.name,
    version: base.version || '1',
    available() {
      if (!opts.command && !opts.runner) {
        return { ok: false, reason: 'unavailable', detail: 'no OCR command configured' };
      }
      return { ok: true };
    },
    async analyze(input, ctx = {}) {
      const avail = this.available();
      if (!avail.ok) {
        return { ok: false, reason: 'unavailable', detail: avail.detail, regions: [] };
      }
      // 若提供 runner，期望返回 { regions: [{ text, x, y, width, height, confidence? }] }
      try {
        const raw = opts.runner
          ? await opts.runner(JSON.stringify(input), ctx)
          : null;
        if (!raw) {
          return { ok: false, reason: 'unavailable', detail: 'OCR runner missing', regions: [] };
        }
        const parsed = typeof raw === 'string' ? JSON.parse(raw.stdout || raw) : JSON.parse(raw.stdout || '{}');
        if (!Array.isArray(parsed.regions)) {
          return { ok: false, reason: 'invalid_schema', detail: 'regions required', regions: [] };
        }
        return { ok: true, regions: parsed.regions };
      } catch (e) {
        return { ok: false, reason: 'failed', detail: e.message, regions: [] };
      }
    },
  };
}
