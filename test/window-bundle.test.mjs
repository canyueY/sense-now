/**
 * window-bundle.test.mjs — 悬浮窗打包完整性（P0）。
 *
 * window.py 依赖同目录 mic-dsh.png / mic.py / window_protocol.py；
 * 缺一个资源时 sync --check 必须失败。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHAT = join(ROOT, 'examples', 'floating-chat');
const SYNC = join(ROOT, 'scripts', 'sync-window.mjs');

const REQUIRED = ['window.py', 'window_protocol.py', 'mic.py', 'mic-dsh.png'];

test('打包输入：floating-chat bundle 四个文件齐全', () => {
  for (const name of REQUIRED) {
    const p = join(CHAT, name);
    assert.ok(existsSync(p), `缺失 ${name}；应从上游 0.0.6 revision 同步`);
    assert.ok(readFileSync(p).length > 100, `${name} 过小，像是空文件`);
  }
});

test('sync-window --check：完整 bundle 通过', () => {
  // 无上游时沿用包内；有上游时比对漂移。两边都齐全应 exit 0。
  const r = spawnSync(process.execPath, [SYNC, '--check', '--quiet'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_SEE_WINDOW: '', DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-wb-')) },
  });
  // 可能因找不到上游但包内齐全而 0；也可能上游一致而 0
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
});

test('sync-window --check：缺一个资源时失败', () => {
  const backup = join(CHAT, 'mic-dsh.png.__bak-test');
  const target = join(CHAT, 'mic-dsh.png');
  assert.ok(existsSync(target));
  renameSync(target, backup);
  try {
    // 指向一个只有 window.py、没有 png 的假上游目录
    const fakeUp = mkdtempSync(join(tmpdir(), 'dsh-fake-win-'));
    const fakeChat = join(fakeUp, 'examples', 'floating-chat');
    mkdirSync(fakeChat, { recursive: true });
    copyFileSync(join(CHAT, 'window.py'), join(fakeChat, 'window.py'));
    // 故意不放 mic-dsh.png；其余资源可有可无
    for (const n of ['mic.py', 'window_protocol.py']) {
      copyFileSync(join(CHAT, n), join(fakeChat, n));
    }
    const r = spawnSync(process.execPath, [SYNC, '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_SEE_WINDOW: join(fakeChat, 'window.py'),
        DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-wb2-')),
      },
    });
    assert.notEqual(r.status, 0, '缺 mic-dsh.png 时 check 必须失败');
    assert.match(String(r.stderr || r.stdout), /mic-dsh\.png|缺失|失败/);
  } finally {
    renameSync(backup, target);
  }
});
