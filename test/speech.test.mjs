/**
 * speech.test.mjs — 声音与插话的守卫。
 *
 * 这一组守的是"用户能不能听见/看见"这件事，坏起来**不报错**：
 *   - `say` 只写盘不发事件 → 窗口有字、没声音（用户第一反应就是这个）
 *   - 插话没记待回执 → 模型先去取图，回来就忘了回，用户侧等于没理他
 *   - 待回执不清 → 一轮话被念三遍
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-speech-'));
process.env.DSH_HOME = home;

const { onSpeech, emitSpeech, emitSpoken, speechSubscribers, __resetSpeech } =
  await import('../src/speech.js');
const { appendSpoken, appendChat, chatFile } =
  await import('../src/chat.js');
const { interjectNote, noteInterjected, clearInterjected, pendingInterjected,
  replyReminder, __resetInterject } = await import('../src/interject.js');

beforeEach(() => { __resetSpeech(); __resetInterject(); });

test('没有订阅者时发事件是空操作，不抛', () => {
  assert.equal(emitSpeech({ text: 'hi' }), 0);
  assert.equal(speechSubscribers(), 0);
});

test('appendSpoken 写盘的同时一定发 due 事件（缺一个就是"有字没声"）', () => {
  const got = [];
  onSpeech((e) => got.push(e), { voice: true });

  appendSpoken('assistant', '我看看');

  assert.equal(got.length, 1, '必须发出事件，否则没有声音');
  assert.equal(got[0].state, 'due');
  assert.equal(got[0].text, '我看看');
  assert.equal(got[0].origin, 'chat', 'origin=chat 让展示层别再写一遍');
});

test('speak:false 只写盘不发事件（诊断行不该被念）', () => {
  const got = [];
  onSpeech((e) => got.push(e), { voice: true });
  appendSpoken('meta', '悬浮窗没开起来', { speak: false });
  assert.equal(got.length, 0);
});

test('speechSubscribers 只数 voice:true 的（只做展示的订阅者不算会出声）', () => {
  const offA = onSpeech(() => {}, { voice: true });
  const offB = onSpeech(() => {}, { voice: false });
  assert.equal(speechSubscribers(), 1);
  offA(); offB();
  assert.equal(speechSubscribers(), 0);
});

test('适配器发的 spoken 能送到订阅者手里', () => {
  const got = [];
  onSpeech((e) => got.push(e.state), { voice: true });
  emitSpeech({ text: 'x', state: 'due' });
  emitSpoken({ text: 'x' });
  assert.deepEqual(got, ['due', 'spoken']);
});

test('插话话术必须说清楚"只有 say 能进窗、会被念"', () => {
  const note = interjectNote('这是啥');
  assert.match(note, /这是啥/);
  assert.match(note, /先说话/, '要明确"先说话再干活"');
  assert.match(note, /say/, '要指名 say 这个参数');
  assert.match(note, /看不到|看不见/, '要说清楚普通回复用户看不到');
});

test('插话记待回执；没带 say 时提醒一次，且只提醒一次', () => {
  noteInterjected('这个表格最后一列是啥');
  assert.equal(pendingInterjected().text, '这个表格最后一列是啥');

  const first = replyReminder({ answered: false });
  assert.match(first, /未回应/);
  assert.match(first, /这个表格最后一列是啥/);

  const second = replyReminder({ answered: false });
  assert.equal(second, '', '同一句只提醒一次，再念就是噪音');
});

test('带了 say 就等于回过了，待回执立刻清掉', () => {
  noteInterjected('你好');
  assert.equal(replyReminder({ answered: true }), '', 'answered 不该再提醒');
  assert.equal(pendingInterjected(), null, 'answered 要清掉待回执');
});

test('同一句话重复说，不重置提醒次数（否则会无限循环）', () => {
  noteInterjected('你好');
  assert.match(replyReminder({ answered: false }), /未回应/);
  const again = noteInterjected('你好');
  const at = pendingInterjected();
  assert.equal(again.reminded, 1, '重复记录不该把 reminded 清零');
  assert.equal(replyReminder({ answered: false }), '', '还是不该再提醒');
  assert.equal(at.reminded, 1);
});

test('待回执过 3 分钟自动失效', () => {
  const now = Date.now();
  noteInterjected('很久以前', { at: now - 181_000 });
  assert.equal(pendingInterjected(now), null);
});

test('chat.jsonl 里能同时看到 assistant 的话和 user 的插话', () => {
  appendSpoken('assistant', '我先看看你的屏幕');
  appendChat('user', '上面那个报错是什么意思');
  const lines = readFileSync(chatFile(), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.role === 'assistant' && l.text.includes('先看看')));
  assert.ok(lines.some((l) => l.role === 'user' && l.text.includes('报错')));
});
