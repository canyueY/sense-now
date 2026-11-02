/**
 * source-adapter.js — 统一 source 结果形状。
 */

export function normalizeSourceResult({
  videoKey,
  metadata = {},
  parts = [],
  subtitles = [],
  subtitleMap = null,
  mediaRef = null,
  fingerprint,
  provenance = {},
}) {
  if (!videoKey) throw new Error('videoKey required');
  if (!fingerprint) throw new Error('fingerprint required');
  return {
    videoKey,
    metadata,
    parts,
    subtitles,
    subtitleMap,
    mediaRef,
    fingerprint,
    provenance: {
      adapter: provenance.adapter || 'unknown',
      version: provenance.version || '1',
      generatedAt: provenance.generatedAt || new Date().toISOString(),
      ...provenance,
    },
  };
}
