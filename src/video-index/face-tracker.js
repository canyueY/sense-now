/** face-tracker.js — 包装 entity adapter；不可用时不伪造。 */
import { createEntityAdapter } from './adapters/entity-adapter.js';

export function createFaceTracker(opts = {}) {
  return createEntityAdapter({ ...opts, name: opts.name || 'face-tracker' });
}
