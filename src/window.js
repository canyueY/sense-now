/**
 * window.js — 拉起那颗悬浮窗（Python + tkinter，无边框/置顶/液态玻璃）。
 *
 * ## 为什么借用 watch 那份脚本，而不是拷一份
 *
 * 那份 `window.py` 有 3000 多行，而且**还在改**（用户刚收尾完一轮视觉）。
 * 拷一份进来 = 从今往后两边各自演化，改好的一边另一边看不见。
 * 所以默认策略是「找到哪份用哪份」，按优先级：
 *
 *   1. `DSH_SENSE_WINDOW` 环境变量      —— 显式指定
 *   2. `~/.dsh/sense-window.json` 的 script
 *   3. `~/.dsh/watch-window.json` 的 script  —— 用户就在那儿维护
 *   4. profile 里装的 `dsh-watch-together/examples/floating-chat/window.py`
 *   5. 开发仓库里的 `../dsh-watch-together/examples/floating-chat/window.py`
 *
 * 真到要独立发版那天，把 window.py 拷进 `examples/floating-chat/` 并加进第 5 步即可。
 *
 * ## 两个必须分开的东西
 *
 * - **聊天记录**：靠 `DSH_VIDEO_CACHE_DIR` 传给子进程，指到 `~/.dsh/sense-now`。
 *   不分开的话，sense-now 的消息会和陪看的消息串进同一个窗。
 * - **pid 锁**：`~/.dsh/sense-now-window.pid`。不分开的话，陪看的窗开着时我们就不敢开了。
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, openSync, readdirSync, readFileSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatDir, dshHome } from './chat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 包里自带的那份 —— 由 `scripts/sync-window.mjs` 从上游生成，是最后的兜底 */
export const PACKAGED = join(HERE, '..', 'examples', 'floating-chat', 'window.py');
const REL = join('examples', 'floating-chat', 'window.py');

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}

function senseConfig() {
  const modern = readJson(join(dshHome(), 'sense-window.json'));
  if (Object.keys(modern).length) return modern;
  return readJson(join(dshHome(), 'see-window.json'));
}

export function pidPath() {
  return join(dshHome(), 'sense-now-window.pid');
}

/** 心跳文件：窗口每秒 touch 一次，用来区分"进程还在"和"窗口真的在画"。 */
function heartbeatPath() {
  return join(chatDir(), 'window-heartbeat');
}

/** 心跳多久算过期。窗口 1 秒写一次，6 秒足够容忍一次 GC 或短暂卡顿。 */
export const HEARTBEAT_STALE_SEC = 6;

function logPath() {
  return join(dshHome(), 'sense-now-window.log');
}

/**
 * 已安装的 `dsh-watch-together` 里那份 window.py（可能有多份）。
 *
 * 坑：以前硬编码 `profiles/desktop`，但 profile 名不止一个（本机有 `desktop` 和 `web`），
 * 而且 npm 还可能把它 hoist 到 `profiles/node_modules`。所以这里**全扫**。
 * 用运行中的那份而不是仓库那份，是因为 DSH 实际加载的就是 profile 里的副本 ——
 * 测仓库版等于没测到真正分发的版本。
 */
function installedCopies(env = process.env) {
  const home = dshHome(env);
  const roots = [join(home, 'node_modules'), join(home, 'profiles', 'node_modules')];
  try {
    for (const name of readdirSync(join(home, 'profiles'))) {
      roots.push(join(home, 'profiles', name, 'node_modules'));
    }
  } catch { /* 没有 profiles 目录 */ }
  const out = [];
  for (const root of roots) {
    const p = join(root, 'dsh-watch-together', REL);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/**
 * 窗口脚本放哪（按优先级找第一份存在的）。
 *
 * | 顺序 | 来源 | 什么时候用 |
 * |---|---|---|
 * | 1 | `DSH_SEE_WINDOW` | 临时指定、调试 |
 * | 2 | `~/.dsh/see-window.json` 的 `script` | 持久配置 |
 * | 3 | `~/.dsh/watch-window.json` 的 `script` | 用户在陪看那边维护的那份 |
 * | 4 | 已安装的 watch-together | **用户装了就永远是最新的**，零重复 |
 * | 5 | 开发仓库 `../dsh-watch-together` | 一边改一边试 |
 * | 6 | 包内 `examples/floating-chat/window.py` | 用户没装 watch 时的兜底 |
 *
 * 导出是为了让 `--check` 能报清楚究竟用的是哪个。
 *
 * @param {{env?:object}} [o] — 传 env 是为了让测试不用改 process.env
 */
export function resolveScript({ env = process.env } = {}) {
  const explicit = env.DSH_SENSE_WINDOW || env.DSH_SEE_WINDOW;
  if (explicit && existsSync(explicit)) {
    return { script: explicit, from: env.DSH_SENSE_WINDOW ? 'DSH_SENSE_WINDOW' : 'DSH_SEE_WINDOW' };
  }

  const seen = readJson(join(dshHome(env), 'see-window.json')).script;
  if (seen && existsSync(seen)) return { script: seen, from: '~/.dsh/see-window.json' };

  const watch = readJson(join(dshHome(env), 'watch-window.json')).script;
  if (watch && existsSync(watch)) return { script: watch, from: '~/.dsh/watch-window.json' };

  const installed = installedCopies(env);
  if (installed.length) return { script: installed[0], from: '已安装的 watch-together' };

  const repo = join(HERE, '..', '..', 'dsh-watch-together', REL);
  if (existsSync(repo)) return { script: repo, from: '开发仓库' };

  if (existsSync(PACKAGED)) return { script: PACKAGED, from: '包内' };
  return { script: null, from: null };
}

/**
 * 解释器候选：**必须有 tkinter**。
 *
 * 本机踩过的坑：`PATH` 上的 `pythonw.exe` / `python.exe` 都是 WorkBuddy managed 的，
 * **不带 tkinter**，spawn 之后立刻退（日志里刷了一排 "No module named 'tkinter'"）。
 * 真正能用的是商店版（`WindowsApps/PythonSoftwareFoundation.Python.3.13_.../python.exe`）。
 * 所以这里不能只按名字排，得**真跑一次 import** 验。
 */
const TK_PROBE = 'import tkinter';

/**
 * 这个解释器能不能 `import tkinter`？
 *
 * 导出来是为了可测 —— 本机踩过的坑就是"解释器名字对、但没有 tkinter"，
 * 光看路径判断不出来，只能真跑一次。
 */
export function hasTkinter(python) {
  const r = spawnSync(python, ['-c', TK_PROBE], {
    timeout: 8000, windowsHide: true, stdio: 'ignore',
  });
  return r?.status === 0;
}

/**
 * 商店版的真实路径。
 *
 * 坑：`WindowsApps\PythonSoftwareFoundation.Python.3.13_*` 下的 `python.exe` 是
 * **App Execution Alias（重解析点）**，`existsSync()` 对它返回 false，
 * 但 `readdirSync()` 能列出、直接 spawn 也能跑。所以这里只认目录列举，不再二次探测。
 */
function storePython() {
  const dir = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps');
  const out = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!/^PythonSoftwareFoundation\.Python\.\d/.test(name)) continue;
      for (const exe of ['pythonw.exe', 'python.exe']) {
        out.push(join(dir, name, exe));
      }
    }
  } catch { /* 读不了目录就算了 */ }
  return out;
}

function pythonCandidates() {
  const cfg = senseConfig();
  const list = [];
  for (const c of [
    process.env.DSH_SENSE_PYTHON,
    process.env.DSH_SEE_PYTHON,
    cfg.python,
    process.env.DSH_FLOAT_PYTHON,
  ]) {
    if (c) list.push(c);
  }
  if (process.platform === 'win32') {
    list.push('pythonw.exe', 'python.exe', ...storePython());
  } else {
    list.push('python3', 'python');
  }
  // 去重但保序
  return [...new Set(list.filter(Boolean))];
}

/** pid 文件指向的那个进程还在不在。**不看心跳**，见 `windowPidAlive` 的注释。 */
export function windowPidAlive() {
  if (process.env.DSH_SENSE_NO_WINDOW === '1' || process.env.DSH_SEE_NO_WINDOW === '1') return false;
  let pid = 0;
  try { pid = Number(readFileSync(pidPath(), 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  return true;
}

/**
 * 上次开的那个还活着吗？（**"这窗还能用吗"**，决定要不要重开）
 *
 * **不能只看 pid**：pid 会被系统复用，进程也可能活着但界面卡死。
 * 加一层心跳：窗口每秒 touch 一个文件，过期就当它死了。
 * 没有心跳文件时**不判死**：老版本窗口不写心跳，误杀会让它每次都被重开。
 *
 * **别拿它回答"用户是不是不想看了"**：那个判断用 `windowPidAlive()` + 拍数，
 * 见 `loop.js` 的 `windowVerdict()`。
 */
export function windowAlive() {
  if (!windowPidAlive()) return false;
  try {
    const hb = statSync(heartbeatPath());
    if ((Date.now() - hb.mtimeMs) / 1000 > HEARTBEAT_STALE_SEC) return false;
  } catch { /* 没有心跳文件：兼容老窗口，继续信任 pid */ }
  return true;
}

/**
 * 开窗（幂等）。
 *
 * 三步都要做，少一步就会得到一个"看起来成功、其实早就退了"的窗：
 *   1. 真跑一次 `import tkinter` 验解释器（managed python 没有，会立刻退）
 *   2. spawn 之后等 700ms，看它有没有自己退出（脚本报错退出也是退）
 *   3. **确认活着才写 pid** —— 否则 pid 文件指向死进程，`windowAlive()` 永远 false
 *
 * `script` 传了就**跳过 resolveScript()**，测试靠这个把自己钉在一个注定失败的脚本上 ——
 * 否则一旦那个脚本不存在，回退链会摸到真的 window.py，测试当场把窗弹到用户脸上（踩过）。
 *
 * @returns {{ok:boolean, script?:string, python?:string, from?:string, reason?:string, already?:boolean}}
 */
export async function openWindow({ force = false, log = () => {}, settleMs = 700, script: forced = null } = {}) {
  if (process.env.DSH_SENSE_NO_WINDOW === '1' || process.env.DSH_SEE_NO_WINDOW === '1') {
    return { ok: false, reason: 'disabled' };
  }
  if (!force && windowAlive()) return { ok: true, already: true };

  const { script, from } = forced
    ? { script: forced, from: '调用方指定' }
    : resolveScript();
  if (!script) {
    return { ok: false, reason: '找不到 window.py（设 DSH_SENSE_WINDOW，或写 ~/.dsh/sense-window.json）' };
  }
  if (forced && !existsSync(forced)) {
    return { ok: false, reason: `指定的 script 不存在：${forced}`, script: forced, from };
  }

  const tried = [];
  for (const python of pythonCandidates()) {
    if (!hasTkinter(python)) { tried.push(`${python}（无 tkinter）`); continue; }

    let errFd = 'ignore';
    try { errFd = openSync(logPath(), 'a'); } catch { /* 打不开日志就丢掉 */ }

    let child;
    try {
      child = spawn(python, [script], {
        stdio: ['ignore', errFd, errFd],
        detached: true,
        windowsHide: true,
        env: {
          ...process.env,
          // 关键：窗口按这个目录找 chat.jsonl，指到我们自己的目录，
          // 既不会读到陪看的消息，也不会把我们的消息写进陪看那条流
          DSH_VIDEO_CACHE_DIR: chatDir(),
        },
      });
    } catch (e) {
      tried.push(`${python}（spawn 失败：${e?.message ?? e}）`);
      if (typeof errFd === 'number') { try { closeSync(errFd); } catch { /* 已关 */ } }
      continue;
    }

    const dead = await waitExit(child, settleMs);
    if (typeof errFd === 'number') { try { closeSync(errFd); } catch { /* 已关 */ } }
    if (dead) {
      tried.push(`${python}（启动后 ${settleMs}ms 内退出，code=${dead.code}）`);
      log(`[window] ${python} 启动后立即退出，换下一个`);
      continue;
    }

    child.unref?.();
    try { writeFileSync(pidPath(), String(child.pid ?? ''), 'utf8'); } catch { /* 写不了只是会多开一次 */ }
    return { ok: true, script, from, python };
  }

  return {
    ok: false,
    reason: `没有能用的解释器（要带 tkinter）：${tried.join(' / ') || '一个候选都没有'}`,
    script,
  };
}

/** 等最多 `ms`；进程先退出就返回 {code}，否则返回 null（还活着）。 */
function waitExit(child, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(null), ms);
    child.once('exit', (code, signal) => finish({ code: code ?? signal }));
    child.once('error', (e) => finish({ code: `error:${e?.message ?? e}` }));
  });
}

/** 关窗（读 pid 杀掉；用户自己点 × 的话这里什么也不用做） */
export function closeWindow() {
  try {
    const pid = Number(readFileSync(pidPath(), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid);
  } catch { /* 已经没了 */ }
  try { unlinkSync(pidPath()); } catch { /* 本来就没有 */ }
}
