import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOOLS_PATH = process.env.DSH_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

/**
 * 假上下文。**`saveImage` 故意读 `this.compression`** —— 真事故就是它：
 * 方法从服务上取下来裸调会丢 this，报 `Cannot read properties of undefined`，
 * 所有出图工具一起挂。这里让裸调直接炸，`.call()` 才对。
 */
function fakeCtx() {
  const registered = [];
  const disposed = [];
  const warns = [];
  const saved = [];
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool);
        return () => disposed.push(tool.name);
      },
    },
    logger: { warn: (m) => warns.push(m), error: (m) => warns.push(m), info: () => {} },
    attachments: {
      compression: 'png',
      async saveImage(o) {
        assert.equal(this.compression, 'png', 'saveImage 必须用 .call(svc) 调，否则 this 丢了');
        saved.push(o);
        return { attachmentId: `fake-${saved.length}`, mediaType: o.mediaType, bytes: o.data.length };
      },
    },
  };
  return { ctx, registered, disposed, warns, saved };
}

const skip = !existsSync(TOOLS_PATH) && '找不到宿主的 dsh-tools，跳过（设 DSH_TOOLS_PATH 可指定）';

test('插件能加载、注册 sense_now 与 video_index、dispose 能解绑', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  assert.equal(mod.name, 'sense-now');
  assert.deepEqual(mod.inject, ['tools', 'attachments', 'sessionController']);

  const { ctx, registered, disposed } = fakeCtx();
  const dispose = await mod.apply(ctx);

  assert.equal(registered.length, 2, '注册 sense_now 与 video_index');
  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(names, ['sense_now', 'video_index']);
  assert.equal(typeof registered[0].execute, 'function');
  assert.equal(typeof registered[1].execute, 'function');

  dispose();
  assert.ok(disposed.includes('sense_now'), 'sense_now 要解绑');
  assert.ok(disposed.includes('video_index'), 'video_index 要解绑');
});

test('刚起来时 status 说没在采集，不抛错', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  const { ctx, registered } = fakeCtx();
  await mod.apply(ctx);
  const v = await registered[0].execute({ action: 'status' });
  assert.match(v.text, /没在采集/);
});

test('未知 action 列可用项，而不是静默什么都不做', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  const { ctx, registered } = fakeCtx();
  await mod.apply(ctx);
  const v = await registered[0].execute({ action: 'dance' });
  assert.match(v.text, /未知 action/);
  assert.match(v.text, /watch/);
});

/** 递归找出 undefined / 非有限数 —— 宿主就是拿这个判 "not lossless JSON" 的 */
function badJson(v, path = '$') {
  if (v === undefined) return `${path} is undefined`;
  if (typeof v === 'number' && !Number.isFinite(v)) return `${path} = ${v}`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const r = badJson(v[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      const r = badJson(val, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

test('返回值必须是无损 JSON —— undefined 会让整个工具调用作废', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  const { ctx, registered } = fakeCtx();
  await mod.apply(ctx);
  for (const args of [{ action: 'status' }, { action: 'nope' }, { action: 'stop' }]) {
    const v = await registered[0].execute(args);
    const bad = badJson(v);
    assert.equal(bad, null, `action=${args.action} 的返回值里有非法 JSON: ${bad}`);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(v)));
  }
});

test('peek：没在采集时说得清，不假装给了图', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  const { ctx, registered, saved } = fakeCtx();
  await mod.apply(ctx);
  const v = await registered[0].execute({ action: 'peek' });
  assert.equal(saved.length, 0, '没图就不该提交附件');
  assert.match(v.text, /没有画面/);
});
