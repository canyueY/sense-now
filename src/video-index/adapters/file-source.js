/**
 * file-source.js — 本地文件源（不复制原片，只记受控引用）。
 */

import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { contentHash, videoKeyOf } from '../ids.js';
import { normalizeSourceResult } from './source-adapter.js';

export function createFileSource({ clock = () => new Date().toISOString() } = {}) {
  return {
    name: 'file-source',
    version: '1',
    available() {
      return { ok: true };
    },
    async resolve(source, { signal } = {}) {
      if (signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      const path = resolve(String(source.path || ''));
      if (!existsSync(path)) {
        const err = new Error(`file not found: ${path}`);
        err.code = 'ENOENT';
        throw err;
      }
      const st = statSync(path);
      const fingerprint = contentHash(`${path}|${st.size}|${st.mtimeMs}`);
      const videoKey = videoKeyOf({ kind: 'file', path });
      return normalizeSourceResult({
        videoKey,
        metadata: {
          title: basename(path),
          path,
          size: st.size,
          mtimeMs: st.mtimeMs,
          durationMs: source.durationMs ?? null,
          width: source.width ?? null,
          height: source.height ?? null,
        },
        parts: [{ partId: 'p1', title: basename(path) }],
        subtitles: source.subtitles || [],
        mediaRef: {
          kind: 'file',
          path,
          // 不默认复制；仅引用
          cached: false,
        },
        fingerprint,
        provenance: {
          adapter: 'file-source',
          version: '1',
          generatedAt: clock(),
        },
      });
    },
  };
}
