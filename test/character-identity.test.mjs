import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCharacterIdentity,
  labelForUtterance,
  listCharacterIdentities,
} from '../src/video-index/character-identity.js';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { LAYOUT } from '../src/video-index/index-store.js';

const phoneUtterances = [
  {
    utteranceId: 'u1', startMs: 10000, endMs: 12000, text: '你现在在哪里？',
    speakerClusterId: 'S001', evidenceId: 'e1', source: 'asr',
  },
  {
    utteranceId: 'u2', startMs: 12000, endMs: 14000, text: '我马上就到了。',
    speakerClusterId: 'S002', evidenceId: 'e2', source: 'asr',
  },
];

function phoneBase(extra = {}) {
  return resolveCharacterIdentity({
    videoId: 'file:phone:demo',
    clock: '2026-11-12T00:00:00.000Z',
    utterances: phoneUtterances,
    visualTracks: [{ trackId: 'V001', startMs: 9000, endMs: 15000 }],
    ...extra,
  });
}

test('电话：画面人物不接收离屏台词', () => {
  const original = phoneUtterances.map((u) => u.text);
  const reg = phoneBase();
  assert.deepEqual(phoneUtterances.map((u) => u.text), original);
  const visible = reg.visualTracks.find((t) => t.id === 'V001');
  const off = reg.speakers.find((s) => s.cluster_key === 'S002');
  const wrong = reg.relations.find((r) => r.relation_type === 'speaker_of_person'
    && r.source_entity_id === off.id
    && r.target_entity_id === visible.person_id
    && !r.revoked);
  assert.equal(wrong, undefined);
  const ref = reg.utteranceRefs.find((r) => r.utteranceId === 'u2');
  assert.equal(ref.personId, null);
  assert.match(ref.label, /^未知说话人/);
  assert.equal(ref.verification, null);
  assert.ok(reg.scenes.some((s) => s.kind === 'possible_phone_conversation'));
  assert.ok(off.segments.some((s) => s.source === 'remote'));
});

test('电话人物后入画：介绍加清晰声纹才回溯，只出现画面不够', () => {
  const early = phoneBase({
    utterances: [
      ...phoneUtterances,
      {
        utteranceId: 'u3', startMs: 250000, endMs: 252000, text: '这位是小明',
        speakerClusterId: 'S009', evidenceId: 'e3', source: 'subtitle',
      },
    ],
    visualTracks: [
      { trackId: 'V001', startMs: 9000, endMs: 15000 },
      { trackId: 'V002', startMs: 248000, endMs: 330000 },
    ],
  });
  const earlyRef = early.utteranceRefs.find((r) => r.utteranceId === 'u2');
  assert.equal(earlyRef.personId, null);
  const introduced = early.persons.find((p) => p.proposed_name === '小明' && p.track_ids.includes('V002'));
  assert.ok(introduced);
  assert.notEqual(introduced.verification, 'system_verified');

  const later = resolveCharacterIdentity({
    videoId: 'file:phone:demo',
    clock: '2026-11-12T00:01:00.000Z',
    prior: early,
    visualTracks: [
      { trackId: 'V001', startMs: 9000, endMs: 15000 },
      { trackId: 'V002', startMs: 248000, endMs: 330000 },
    ],
    utterances: [
      ...phoneUtterances,
      {
        utteranceId: 'u3', startMs: 250000, endMs: 252000, text: '这位是小明',
        speakerClusterId: 'S009', evidenceId: 'e3', source: 'subtitle',
      },
    ],
    voiceMatches: [{
      speakerClusterId: 'S002', trackId: 'V002', startMs: 320000, endMs: 322000,
      quality: 'clear', similarity: 'high',
    }],
  });
  const back = later.utteranceRefs.find((r) => r.utteranceId === 'u2');
  assert.equal(back.label, '小明');
  assert.equal(back.verification, 'system_verified');
  assert.equal(back.personId, introduced.id);
  assert.notEqual(later.utteranceRefs.find((r) => r.utteranceId === 'u1').label, '小明');
  assert.ok(later.revision > early.revision);
  assert.equal(phoneUtterances[1].text, '我马上就到了。');
});

test('称呼不是说话人身份', () => {
  const reg = resolveCharacterIdentity({
    videoId: 'file:addr:demo',
    clock: '2026-11-12T00:00:00.000Z',
    utterances: [{
      utteranceId: 'u', startMs: 0, endMs: 2000, text: '小明，你在哪里？',
      speakerClusterId: 'S001', evidenceId: 'e', source: 'asr',
    }],
  });
  const ref = reg.utteranceRefs[0];
  assert.match(ref.label, /^未知说话人/);
  assert.equal(ref.verification, null);
  assert.ok(reg.relations.some((r) => r.relation_type === 'addresses_person'));
  assert.ok(!reg.relations.some((r) => r.relation_type === 'speaker_of_person' && r.verification === 'system_verified'));
  assert.equal(labelForUtterance(reg, { utteranceId: 'u' }).includes('小明：'), false);
});

test('未知人物与未知说话人独立创建，压缩声纹不确认', () => {
  const reg = phoneBase({
    voiceMatches: [{
      speakerClusterId: 'S002', trackId: 'V001', startMs: 12000, endMs: 14000,
      quality: 'compressed', similarity: 'high',
    }],
  });
  assert.ok(reg.persons.some((p) => p.display_name.startsWith('未知人物')));
  assert.ok(reg.speakers.some((s) => s.display_name.startsWith('未知说话人')));
  const ref = reg.utteranceRefs.find((r) => r.utteranceId === 'u2');
  assert.notEqual(ref.verification, 'system_verified');
  assert.ok(reg.limits.some((line) => /压缩|候选/.test(line)));
});

test('姓名冲突会降级，人工确认不会被自动结果盖掉', () => {
  const input = {
    videoId: 'file:conflict:demo',
    clock: '2026-11-12T00:00:00.000Z',
    visualTracks: [{ trackId: 'V', startMs: 0, endMs: 8000 }],
    utterances: [
      { utteranceId: 'a', startMs: 1000, endMs: 2000, text: '这位是小明', speakerClusterId: 'S1', evidenceId: 'ea' },
      { utteranceId: 'b', startMs: 3000, endMs: 4000, text: '这位是小红', speakerClusterId: 'S1', evidenceId: 'eb' },
    ],
    voiceMatches: [{
      speakerClusterId: 'S1', trackId: 'V', startMs: 5000, endMs: 6000,
      quality: 'clear', similarity: 'high',
    }],
  };
  const conflicted = resolveCharacterIdentity(input);
  const person = conflicted.persons.find((p) => p.track_ids.includes('V'));
  assert.equal(person.conflict, true);
  assert.notEqual(person.verification, 'system_verified');

  const confirmed = resolveCharacterIdentity({
    ...input,
    prior: conflicted,
    userActions: [{ type: 'confirm', personId: person.id, speakerId: conflicted.speakers[0].id, name: '小明' }],
  });
  const kept = confirmed.persons.find((p) => p.id === person.id);
  assert.equal(kept.verification, 'user_confirmed');
  assert.equal(kept.display_name, '小明');
  assert.equal(kept.canonical_name, '小明');
});

test('人工改名、合并、拆分、撤销', () => {
  const base = {
    videoId: 'file:edit:demo',
    clock: '2026-11-12T00:00:00.000Z',
    visualTracks: [
      { trackId: 'V1', startMs: 0, endMs: 1000 },
      { trackId: 'V2', startMs: 5000, endMs: 6000 },
    ],
    utterances: [
      { utteranceId: 'u', startMs: 0, endMs: 800, text: '你好', speakerClusterId: 'S1', evidenceId: 'e' },
    ],
    observations: [{
      tMs: 100, visibleFaceIds: ['V1'], speakingFaceIds: ['V1'],
      speakerClusterId: 'S1', speechClear: true, speechMs: 800, lipSyncOk: true, overlap: false, evidenceId: 'lip',
    }],
  };
  const reg = resolveCharacterIdentity(base);
  const person = reg.persons.find((p) => p.track_ids.includes('V1'));
  const other = reg.persons.find((p) => p.track_ids.includes('V2'));
  const speaker = reg.speakers.find((s) => s.cluster_key === 'S1');
  const renamed = resolveCharacterIdentity({
    ...base, prior: reg, userActions: [{ type: 'rename', personId: person.id, displayName: '临时名' }],
  });
  assert.equal(renamed.persons.find((p) => p.id === person.id).display_name, '临时名');

  const merged = resolveCharacterIdentity({
    ...base,
    prior: renamed,
    userActions: [{ type: 'merge', keepPersonId: person.id, dropPersonId: other.id }],
  });
  assert.equal(merged.persons.find((p) => p.id === other.id).merged_into, person.id);
  assert.ok(listCharacterIdentities(merged).every((p) => p.id !== other.id));

  const split = resolveCharacterIdentity({
    ...base,
    prior: merged,
    userActions: [{ type: 'split', personId: person.id, speakerId: speaker.id }],
  });
  const moved = split.relations.find((r) => r.relation_type === 'speaker_of_person' && r.source_entity_id === speaker.id && !r.revoked);
  assert.notEqual(moved.target_entity_id, person.id);

  const undone = resolveCharacterIdentity({ ...base, prior: split, userActions: [] });
  assert.equal(undone.persons.find((p) => p.id === person.id).display_name.startsWith('未知人物')
    || undone.persons.find((p) => p.id === person.id).verification === 'system_verified', true);
});

test('同一句烧录字幕不把 OCR 和 ASR 算成两份独立证据', () => {
  const reg = resolveCharacterIdentity({
    videoId: 'file:lineage:demo',
    clock: '2026-11-12T00:00:00.000Z',
    utterances: [
      { utteranceId: 'a', startMs: 1000, endMs: 2000, text: '我叫小明', speakerClusterId: 'S1', source: 'asr', modality: 'asr' },
      { utteranceId: 'b', startMs: 1100, endMs: 2100, text: '我叫小明', speakerClusterId: 'S1', source: 'ocr', modality: 'ocr' },
    ],
  });
  const intros = reg.evidences.filter((e) => e.evidence_type === 'name_introduction');
  assert.ok(intros.length >= 2);
  assert.equal(intros.filter((e) => e.independent !== false).length, 1);
});

test('规则解析本身只走缓存数据，几百句仍在本地短时间内完成', () => {
  const utterances = Array.from({ length: 400 }, (_, i) => ({
    utteranceId: `u${i}`,
    startMs: i * 1000,
    endMs: i * 1000 + 800,
    text: i % 17 === 0 ? '小明，你在哪里？' : '继续说',
    speakerClusterId: i % 2 === 0 ? 'S1' : 'S2',
    evidenceId: `e${i}`,
  }));
  const started = Date.now();
  const reg = resolveCharacterIdentity({
    videoId: 'file:bench:demo',
    clock: '2026-11-12T00:00:00.000Z',
    utterances,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `elapsed ${elapsed}ms`);
  assert.equal(reg.modelVersion, 'rules-b1');
  assert.equal(reg.scope, 'video');
  assert.ok(reg.utteranceRefs.length === 400);
});

test('关闭开关时索引不写身份文件；打开后电话台词仍不归给画面人物', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-cid-'));
  const engine = createVideoIndexEngine({
    rootDir: root,
    adapters: {
      extractFrames: async () => [],
      extractAudio: async ({ outputPath }) => ({ ok: true, path: outputPath || null }),
    },
    clock: () => '2026-11-12T00:00:00.000Z',
  });
  const path = join(root, 'phone.mp4');
  writeFileSync(path, Buffer.from('fake-media'));
  const off = await engine.index({
    source: {
      kind: 'file',
      path,
      width: 32,
      height: 32,
      subtitles: [
        { startMs: 10000, endMs: 12000, text: '你现在在哪里？', speakerClusterId: 'S001' },
        { startMs: 12000, endMs: 14000, text: '我马上就到了。', speakerClusterId: 'S002' },
      ],
    },
  }, { skipStoryboard: true, width: 32, height: 32 });
  assert.equal(off.ok, true);
  assert.equal(off.manifest.capabilities.characterIdentity, undefined);
  const offFile = join(engine.store.videoDir(off.videoKey), LAYOUT.summary.characterIdentity);
  assert.equal(existsSync(offFile), false);

  const on = await engine.index({
    source: {
      kind: 'file',
      path,
      width: 32,
      height: 32,
      subtitles: [
        { startMs: 10000, endMs: 12000, text: '你现在在哪里？', speakerClusterId: 'S001' },
        { startMs: 12000, endMs: 14000, text: '我马上就到了。', speakerClusterId: 'S002' },
      ],
    },
  }, {
    rebuild: true,
    skipStoryboard: true,
    width: 32,
    height: 32,
    capabilities: { characterIdentity: 'on' },
    visualTracks: [{ trackId: 'V001', startMs: 9000, endMs: 15000 }],
  });
  assert.equal(on.manifest.capabilities.characterIdentity, 'ready');
  const saved = engine.store.readCharacterIdentity(on.videoKey);
  const visible = saved.visualTracks.find((t) => t.id === 'V001');
  const offscreen = saved.speakers.find((s) => s.cluster_key === 'S002');
  assert.ok(visible && offscreen);
  assert.ok(!saved.relations.some((r) => r.relation_type === 'speaker_of_person'
    && r.source_entity_id === offscreen.id
    && r.target_entity_id === visible.person_id
    && !r.revoked));
  const q = engine.query({ videoKey: on.videoKey, question: '我马上就到了' });
  const offRef = q.characterIdentity.utteranceRefs.find((r) => r.speakerId === offscreen.id);
  assert.match(offRef.label, /^未知说话人/);
});
