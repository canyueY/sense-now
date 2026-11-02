#!/usr/bin/env node
/**
 * install-dev — 把本包同步进 DSH 的 desktop profile。
 *
 *   node scripts/install-dev.mjs            # 安装 / 同步
 *   node scripts/install-dev.mjs --check    # 只看状态，不改动
 *   node scripts/install-dev.mjs --remove   # 卸载
 *
 * 为什么必须手动做：desktop profile 由 Electron 应用独占管理，
 * `dsh plugin --profile desktop ...` 会被拒绝（"managed exclusively by the Electron application"）。
 *
 * 为什么复制而不是软链：Node 解析裸包名（`@deepseek-ai/dsh-tools`）用的是真实路径，
 * 软链会让它从源码目录向上找、找不到宿主的包。复制到 profile 的 node_modules 里，
 * 解析链才是 profiles/desktop/node_modules → profiles/node_modules。
 */

import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
const MODULES = join(PROFILE_DIR, 'node_modules');
const PKG_NAME = 'sense-now';
const LEGACY_PKG_NAME = 'dsh-see-now';

// `.tmp` / `.venv*` / `pip-*` / `__pycache__` 是本地产物，绝不能进 profile；
// `debug` 是开发期调试窗，不进插件；`samples` / `test` / `.github` 也用不到。
// 注意：`scripts` 必须保留 —— `scripts/audio-visual-runner.py` 是 pyannote 运行时依赖。
const SKIP = new Set(['node_modules', '.git', '.github', 'test', '.tmp', 'debug', 'samples']);
const shouldSkip = (name) => SKIP.has(name)
  || name.startsWith('.venv')
  || name.startsWith('pip-')
  || name === '__pycache__';

const mode = process.argv.includes('--remove') ? 'remove'
  : process.argv.includes('--check') ? 'check' : 'install';

if (!existsSync(PROFILE_DIR)) {
  console.error(`profile 不存在：${PROFILE_DIR}`);
  process.exit(2);
}
const pkgPath = join(PROFILE_DIR, 'package.json');
const readJson = async (p) => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''));

async function editProfile({ add }) {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const hasDep = Object.hasOwn(pkg.dependencies ?? {}, PKG_NAME);

  if (add) {
    if (!hasDep) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = join(PROFILE_DIR, `package.json.bak-${stamp}-preseenow`);
      await writeFile(backup, await readFile(pkgPath), 'utf8');
      console.log(`已备份 package.json → ${backup}`);
    }
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [PKG_NAME]: `file:${HERE.replace(/\\/g, '/')}` };
    // 品牌迁移：避免宿主同时加载旧插件和 Sense Now，造成工具重复注册。
    delete pkg.dependencies[LEGACY_PKG_NAME];
    pkg.dsh = pkg.dsh ?? {};
    pkg.dsh.profile = pkg.dsh.profile ?? {};
    pkg.dsh.profile.bundles = [
      ...bundles.filter((b) => b !== LEGACY_PKG_NAME && b !== PKG_NAME),
      PKG_NAME,
    ];
  } else {
    if (pkg.dependencies) delete pkg.dependencies[PKG_NAME];
    if (pkg.dsh?.profile?.bundles) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME);
    }
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

async function report() {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const target = join(MODULES, PKG_NAME);
  const installed = existsSync(target);
  const registered = bundles.includes(PKG_NAME);
  console.log(`profile   : ${PROFILE_DIR}`);
  console.log(`${PKG_NAME}: ${installed ? '已安装' : '未安装'}  bundles ${registered ? '已注册' : '未注册'}`);
  console.log(`bundles 共 ${bundles.length} 项：${bundles.join(', ')}`);
  return { installed, registered };
}

if (mode === 'check') {
  await report();
  process.exit(0);
}

if (mode === 'remove') {
  await rm(join(MODULES, PKG_NAME), { recursive: true, force: true });
  await editProfile({ add: false });
  console.log('已卸载 sense-now。重启 DSH 生效。');
  await report();
  process.exit(0);
}

await rm(join(MODULES, PKG_NAME), { recursive: true, force: true });
await rm(join(MODULES, LEGACY_PKG_NAME), { recursive: true, force: true });
await cp(HERE, join(MODULES, PKG_NAME), {
  recursive: true,
  filter: (s) => !shouldSkip(s.split(/[\\/]/).pop()),
});
await editProfile({ add: true });
console.log('已安装。重启 DSH 生效，然后让模型调 `sense_now({ action: "watch" })`。');
await report();
