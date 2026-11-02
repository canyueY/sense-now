#!/usr/bin/env node
/**
 * sync-window.mjs — 把上游悬浮窗 bundle 同步进 `examples/floating-chat/`。
 *
 * window.py 不是单独文件：它 import window_protocol、跑 mic.py、贴 mic-dsh.png。
 * 只同步 .py 会得到「能装、装完起不来」的包。
 *
 * `--check` 逐个检查 bundle；普通 sync 逐个安全写入（内容不变则跳过）。
 */

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REL = join('examples', 'floating-chat', 'window.py');
const DEST = join(ROOT, REL);
const DEST_DIR = dirname(DEST);

/** 插在 shebang 之后的一行标记。比较内容时会被剥掉。 */
const MARK = '# ⚠️ 本文件由 sense-now/scripts/sync-window.mjs 生成，请勿手改（要改请改上游 dsh-watch-together）';

/** 与 window.py 同目录、运行时必需的资源（同一上游 revision）。 */
export const WINDOW_BUNDLE_ASSETS = Object.freeze([
  'mic-dsh.png',
  'mic.py',
  'window_protocol.py',
]);

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const quiet = args.has('--quiet');

function say(msg) {
  if (!quiet) process.stdout.write(`${msg}\n`);
}

function findUpstream() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const candidates = [];

  if (process.env.DSH_SENSE_WINDOW || process.env.DSH_SEE_WINDOW) {
    candidates.push({
      p: process.env.DSH_SENSE_WINDOW || process.env.DSH_SEE_WINDOW,
      from: process.env.DSH_SENSE_WINDOW ? 'DSH_SENSE_WINDOW' : 'DSH_SEE_WINDOW',
    });
  }
  for (const cfg of ['see-window.json', 'watch-window.json']) {
    try {
      const p = JSON.parse(readFileSync(join(home, cfg), 'utf8'))?.script;
      if (p) candidates.push({ p, from: `~/.dsh/${cfg}` });
    } catch { /* ignore */ }
  }

  candidates.push({
    p: join(ROOT, '..', 'dsh-watch-together', REL),
    from: '开发仓库',
  });

  const roots = [join(home, 'node_modules'), join(home, 'profiles', 'node_modules')];
  try {
    for (const name of readdirSync(join(home, 'profiles'))) {
      roots.push(join(home, 'profiles', name, 'node_modules'));
    }
  } catch { /* ignore */ }
  for (const root of roots) {
    candidates.push({ p: join(root, 'dsh-watch-together', REL), from: '已安装的 watch-together' });
  }

  for (const c of candidates) {
    if (c.p && existsSync(c.p)) return c;
  }
  return null;
}

function stripMark(text) {
  return text.split(/\r?\n/).filter((l) => l !== MARK).join('\n');
}

function withMark(text) {
  const lines = text.split(/\r?\n/);
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, MARK);
  return lines.join('\n');
}

function assetPaths(dir) {
  return {
    'window.py': join(dir, 'window.py'),
    ...Object.fromEntries(WINDOW_BUNDLE_ASSETS.map((n) => [n, join(dir, n)])),
  };
}

/** 包内 bundle 是否齐全（不比内容，只比存在）。 */
export function packagedBundleStatus(root = ROOT) {
  const dir = join(root, 'examples', 'floating-chat');
  const missing = [];
  const present = [];
  for (const [name, p] of Object.entries(assetPaths(dir))) {
    if (existsSync(p)) present.push(name);
    else missing.push(name);
  }
  return { ok: missing.length === 0, present, missing, dir };
}

function filesEqual(a, b) {
  try {
    const left = readFileSync(a);
    const right = existsSync(b) ? readFileSync(b) : null;
    return right !== null && left.equals(right);
  } catch {
    return false;
  }
}

function syncAsset(from, to, name) {
  if (!existsSync(from)) return { skipped: true, reason: 'upstream_missing' };
  if (filesEqual(from, to)) return { unchanged: true };
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  say(`[sync-window] 资源已同步 ${name}`);
  return { written: true };
}

const upstream = findUpstream();
const pack = packagedBundleStatus();

if (!upstream) {
  if (pack.ok) {
    say(`[sync-window] 找不到上游，沿用包内 bundle（${pack.present.join(', ')}）；`
      + '如果你刚改了窗口，这次同步是无效的。');
    process.exit(checkOnly ? 0 : 0);
  }
  process.stderr.write(
    '[sync-window] 找不到上游 window.py，而且包内 bundle 不完整。\n'
    + `  缺失：${pack.missing.join(', ') || '(全部)'}\n`
    + '  要么装 dsh-watch-together，要么设 DSH_SENSE_WINDOW 指到 window.py。\n',
  );
  process.exit(1);
}

const srcDir = dirname(upstream.p);
const src = readFileSync(upstream.p, 'utf8');
const want = withMark(src);
const have = existsSync(DEST) ? readFileSync(DEST, 'utf8') : null;
const samePy = have !== null && stripMark(have) === stripMark(want);

if (checkOnly) {
  const problems = [];
  if (!samePy) {
    problems.push(`window.py 与上游不一致（上游：${upstream.from}）`);
  }
  for (const name of WINDOW_BUNDLE_ASSETS) {
    const from = join(srcDir, name);
    const to = join(DEST_DIR, name);
    if (!existsSync(to)) {
      problems.push(`包内缺失 ${name}`);
      continue;
    }
    if (existsSync(from) && !filesEqual(from, to)) {
      problems.push(`${name} 与上游漂移`);
    }
  }
  if (!problems.length) {
    say(`[sync-window] bundle 一致（${upstream.from}，window.py ${src.length} 字节 + ${WINDOW_BUNDLE_ASSETS.length} 资源）`);
    process.exit(0);
  }
  process.stderr.write(
    `[sync-window] 检查失败：\n  - ${problems.join('\n  - ')}\n`
    + '  跑 `npm run sync:window` 或 `npm pack`（prepack 会自动同步）。\n',
  );
  process.exit(1);
}

if (samePy) {
  say(`[sync-window] window.py 上游没变，跳过（${upstream.from}，${src.length} 字节）`);
} else {
  mkdirSync(DEST_DIR, { recursive: true });
  writeFileSync(DEST, want, 'utf8');
  say(`[sync-window] 已同步 window.py ${src.length} 字节 ← ${upstream.from}`);
  say(`              ${DEST}`);
}

for (const name of WINDOW_BUNDLE_ASSETS) {
  syncAsset(join(srcDir, name), join(DEST_DIR, name), name);
}
