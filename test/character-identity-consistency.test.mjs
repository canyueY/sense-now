import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCharacterIdentity } from '../src/video-index/character-identity.js';
import { createVideoIndexEngine } from '../src/video-index/video-index-engine.js';
import { LAYOUT } from '../src/video-index/index-store.js';
import { createVideoIndexTool, videoIndexToolSpec } from '../src/video-index-tool.js';

const clock = '2026-11-12T00:00:00.000Z';

function engineAt(root) {
  return createVideoIndexEngine({
    rootDir: root,
    adapters: {
      extractFrames: async () => [],
      extractAudio: async ({ outputPath }) => ({ ok: true, path: outputPath || null }),
    },
    clock: () => clock,
  });
}

function media(root) {
  const path = join(root, 'clip.mp4');
  writeFileSync(path, Buffer.from('fake-media'));
  return path;
}

const lines = [
  { startMs: 1000, endMs: 2000, text: '这位是小明', speakerClusterId: 'S1' },
  { startMs: 3000, endMs: 4000, text: '我先走了', speakerClusterId: 'S2' },
];

test('弱声纹不能继承已确认人物', () => {
  const reg = resolveCharacterIdentity({
    videoId: 'file:weak:demo',
    clock,
    utterances: lines.map((s, i) => ({
      utteranceId: `u${i}`, evidenceId: `e${i}`, source: 'subtitle', ...s,
    })),
    visualTracks: [{ trackId: 'V1', startMs: 500, endMs: 5000 }],
    voiceMatches: [
      { speakerClusterId: 'S1', trackId: 'V1', startMs: 1000, endMs: 2000, quality: 'clear', similarity: 'high' },
      { speakerClusterId: 'S2', trackId: 'V1', startMs: 3000, endMs: 4000, quality: 'compressed', similarity: 'low' },
    ],
  });
  const s1 = reg.utteranceRefs.find((r) => r.utteranceId === 'u0');
  const s2 = reg.utteranceRefs.find((r) => r.utteranceId === 'u1');
  assert.equal(s1.label, '小明');
  assert.equal(s1.verification, 'system_verified');
  assert.equal(s2.verification, null);
  assert.notEqual(s2.label, '小明');
  assert.match(s2.label, /可能关联：小明，Candidate/);
});

test('人工确认压过旧的自动归属，且两条互斥关系不能同时生效', () => {
  const base = {
    videoId: 'file:user:demo',
    clock,
    utterances: [{
      utteranceId: 'u', startMs: 0, endMs: 1000, text: '这位是小明',
      speakerClusterId: 'S1', evidenceId: 'e', source: 'subtitle',
    }],
    visualTracks: [{ trackId: 'V1', startMs: 0, endMs: 2000 }],
    voiceMatches: [{
      speakerClusterId: 'S1', trackId: 'V1', startMs: 0, endMs: 1000, quality: 'clear', similarity: 'high',
    }],
  };
  const auto = resolveCharacterIdentity(base);
  const speaker = auto.speakers[0];
  const xiaoming = auto.persons.find((p) => p.display_name === '小明');
  const locked = resolveCharacterIdentity({
    ...base,
    prior: auto,
    userActions: [{
      type: 'confirm', actionId: 'lock-hong', seq: 1,
      personKey: 'name:小红', speakerClusterKey: speaker.cluster_key, name: '小红',
    }],
  });
  const ref = locked.utteranceRefs[0];
  assert.equal(ref.label, '小红');
  assert.equal(ref.verification, 'user_confirmed');
  const effective = locked.relations.filter((r) => r.relation_type === 'speaker_of_person'
    && r.source_entity_id === speaker.id && r.effective !== false && r.status === 'Verified');
  assert.equal(effective.length, 1);
  assert.notEqual(effective[0].target_entity_id, xiaoming.id);
  const old = locked.relations.find((r) => r.target_entity_id === xiaoming.id && r.source_entity_id === speaker.id);
  assert.equal(old.effective, false);
  assert.equal(old.overridden, true);
  assert.ok(old.evidence_ids.length > 0);
});

test('人工否认后同一关系不能再成为生效归属', () => {
  const base = {
    videoId: 'file:deny:demo',
    clock,
    utterances: [{
      utteranceId: 'u', startMs: 0, endMs: 1000, text: '这位是小明',
      speakerClusterId: 'S1', evidenceId: 'e', source: 'subtitle',
    }],
    visualTracks: [{ trackId: 'V1', startMs: 0, endMs: 2000 }],
    voiceMatches: [{
      speakerClusterId: 'S1', trackId: 'V1', startMs: 0, endMs: 1000, quality: 'clear', similarity: 'high',
    }],
  };
  const auto = resolveCharacterIdentity(base);
  const rel = auto.relations.find((r) => r.relation_type === 'speaker_of_person' && r.verification === 'system_verified');
  const denied = resolveCharacterIdentity({
    ...base,
    prior: auto,
    userActions: [{ type: 'deny', actionId: 'deny-1', seq: 1, relationId: rel.id }],
  });
  assert.equal(denied.utteranceRefs[0].verification, null);
  assert.notEqual(denied.utteranceRefs[0].label, '小明');
  const again = resolveCharacterIdentity({ ...base, prior: denied, userActions: denied.userActions });
  assert.notEqual(again.utteranceRefs[0].label, '小明');
  const kept = again.relations.find((r) => r.id === rel.id);
  assert.equal(kept.revoked, true);
  assert.ok(kept.evidence_ids.length > 0);
});

test('重建保留人工决定；失败不覆盖；重复回放不新增事件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-cid-rebuild-'));
  const eng = engineAt(root);
  const path = media(root);
  const source = { kind: 'file', path, width: 32, height: 32, subtitles: lines };
  const indexed = await eng.index({ source }, {
    skipStoryboard: true, width: 32, height: 32,
    capabilities: { characterIdentity: 'on' },
    visualTracks: [{ trackId: 'V1', startMs: 500, endMs: 5000 }],
    voiceMatches: [
      { speakerClusterId: 'S1', trackId: 'V1', startMs: 1000, endMs: 2000, quality: 'clear', similarity: 'high' },
    ],
  });
  const key = indexed.videoKey;
  const speaker = eng.store.readCharacterIdentity(key).speakers.find((s) => s.cluster_key === 'S1');
  const updated = eng.updateCharacterIdentity(key, {
    type: 'confirm', actionId: 'lock-hong', personKey: 'name:小红', speakerId: speaker.id, name: '小红',
  });
  assert.equal(updated.ok, true);
  const decisionFile = join(eng.store.videoDir(key), LAYOUT.summary.characterIdentityDecisions);
  const before = readFileSync(decisionFile, 'utf8');
  const eventsBefore = eng.store.readCharacterIdentity(key).events.filter((e) => e.actor === 'user').length;

  const rebuilt = await eng.index({ source }, {
    rebuild: true, skipStoryboard: true, width: 32, height: 32,
    capabilities: { characterIdentity: 'on' },
  });
  assert.equal(rebuilt.manifest.capabilities.characterIdentity, 'ready');
  const after = eng.store.readCharacterIdentity(key);
  assert.equal(after.utteranceRefs.find((r) => r.utteranceId && after.speakers.find((s) => s.id === r.speakerId)?.cluster_key === 'S1').label, '小红');
  assert.equal(readFileSync(decisionFile, 'utf8').includes('lock-hong'), true);

  const replayed = eng.resolveStoredCharacterIdentity(key, { force: true });
  const eventsAfter = replayed.registry.events.filter((e) => e.actor === 'user').length;
  assert.equal(eventsAfter, eventsBefore);

  const failed = await eng.index({ source }, {
    rebuild: true, skipStoryboard: true, width: 32, height: 32,
    capabilities: { characterIdentity: 'on' },
    characterIdentityFault: 'throw',
  });
  assert.equal(failed.manifest.capabilities.characterIdentity, 'degraded');
  assert.equal(readFileSync(decisionFile, 'utf8'), before);
  assert.equal(eng.store.readCharacterIdentity(key).utteranceRefs.find((r) => r.label === '小红') != null, true);
});

test('首次查询和缓存命中带同一份身份；人工修改后查询看到新结果', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-cid-cache-'));
  const eng = engineAt(root);
  const path = media(root);
  const indexed = await eng.index({
    source: { kind: 'file', path, width: 32, height: 32, subtitles: lines },
  }, {
    skipStoryboard: true, width: 32, height: 32,
    capabilities: { characterIdentity: 'on' },
  });
  const first = eng.query({ videoKey: indexed.videoKey, question: '小明' });
  const hit = eng.query({ videoKey: indexed.videoKey, question: '小明' });
  assert.equal(first.cache.hit, false);
  assert.equal(hit.cache.hit, true);
  assert.equal(hit.characterIdentity.revision, first.characterIdentity.revision);
  assert.equal(hit.characterIdentity.processingVersion, 'character-identity-b1');
  const speaker = first.characterIdentity.speakers.find((s) => s.cluster_key === 'S1');
  eng.updateCharacterIdentity(indexed.videoKey, {
    type: 'confirm', actionId: 'lock-hong', personKey: 'name:小红', speakerId: speaker.id, name: '小红',
  });
  const next = eng.query({ videoKey: indexed.videoKey, question: '小明' });
  assert.equal(next.cache.hit, false);
  assert.ok(next.characterIdentity.revision > first.characterIdentity.revision);
  assert.ok(next.characterIdentity.utteranceRefs.some((r) => r.label === '小红'));
});

test('分块与整片都会写出身份；分块本地说话人编号不会被当成同一个人', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-cid-chunk-'));
  const eng = engineAt(root);
  const path = media(root);
  const subs = [
    { startMs: 10_000, endMs: 12_000, text: '这位是小明', speakerClusterId: 'SPEAKER_00' },
    { startMs: 310_000, endMs: 312_000, text: '这边另有一人', speakerClusterId: 'SPEAKER_00' },
  ];
  const whole = await eng.index({
    source: { kind: 'file', path, width: 32, height: 32, subtitles: subs },
  }, {
    skipStoryboard: true, width: 32, height: 32,
    capabilities: { characterIdentity: 'on' },
    visualTracks: [{ trackId: 'V1', startMs: 9000, endMs: 13000 }],
    voiceMatches: [{
      speakerClusterId: 'SPEAKER_00', trackId: 'V1', startMs: 10000, endMs: 12000,
      quality: 'clear', similarity: 'high',
    }],
  });
  assert.equal(whole.manifest.capabilities.characterIdentity, 'ready');
  const wholeReg = eng.store.readCharacterIdentity(whole.videoKey);
  assert.equal(wholeReg.processingVersion, 'character-identity-b1');

  const chunkRoot = mkdtempSync(join(tmpdir(), 'sense-now-cid-bili-'));
  const chunkEng = createVideoIndexEngine({
    rootDir: chunkRoot,
    adapters: {
      extractFrames: async () => [],
      extractAudio: async () => ({ ok: false }),
      bilibiliSource: {
        resolveStreams: async () => ({
          webpageUrl: 'https://www.bilibili.com/video/BV1test',
          bvid: 'BV1test',
          partId: 'p1',
          durationMs: 600_000,
          subtitles: subs,
        }),
      },
    },
    clock: () => clock,
  });
  const job = await chunkEng.indexAdaptive({
    source: { kind: 'bilibili', url: 'https://www.bilibili.com/video/BV1test' },
    execution: 'sync',
    capabilities: { characterIdentity: 'on' },
    indexOptions: {
      visualTracks: [{ trackId: 'V1', startMs: 9000, endMs: 13000 }],
    },
  });
  assert.equal(job.state, 'ready');
  const saved = chunkEng.store.readCharacterIdentity(job.videoKey);
  assert.equal(saved.processingVersion, 'character-identity-b1');
  const locals = saved.speakers.map((s) => s.cluster_key).filter((k) => k.endsWith('SPEAKER_00'));
  assert.equal(locals.length, 2);
  assert.equal(new Set(locals).size, 2);
  const confirmed = saved.utteranceRefs.filter((r) => r.verification === 'system_verified');
  assert.equal(confirmed.length, 0);
  const q1 = chunkEng.query({ videoKey: job.videoKey, question: '小明' });
  const q2 = chunkEng.query({ videoKey: job.videoKey, question: '小明' });
  assert.equal(q1.characterIdentity.revision, saved.revision);
  assert.equal(q2.characterIdentity.revision, q1.characterIdentity.revision);
});

test('工具参数覆盖身份字段，缺参返回 invalid_input', async () => {
  const spec = videoIndexToolSpec();
  for (const key of ['personId', 'speakerId', 'displayName', 'relationId', 'keepPersonId', 'dropPersonId', 'visualTracks', 'voiceMatches', 'sceneHints']) {
    assert.equal(typeof spec.parameters[key], 'object', key);
  }
  const root = mkdtempSync(join(tmpdir(), 'sense-now-cid-tool-'));
  const tool = createVideoIndexTool({ rootDir: root, adapters: { extractFrames: async () => [] } });
  const missing = await tool.execute({ action: 'identity_confirm', videoKey: 'file:none' });
  assert.equal(missing.meta.reason, 'invalid_input');
  const deny = await tool.execute({ action: 'identity_deny', videoKey: 'file:none', personId: 'P1' });
  assert.equal(deny.meta.reason, 'invalid_input');
});

test('缺少身份材料时安全降级，不改写原句', () => {
  const text = '普通一句';
  const reg = resolveCharacterIdentity({
    videoId: 'file:empty:demo',
    clock,
    utterances: [{ utteranceId: 'u', startMs: 0, endMs: 1000, text, speakerClusterId: null, evidenceId: 'e' }],
  });
  assert.equal(reg.utteranceRefs[0].label.startsWith('未知'), true);
  assert.equal(reg.utteranceRefs[0].verification, null);
  assert.equal(reg.persons.length, 0);
  assert.equal(text, '普通一句');
});

test('无法映射的 merge 进入待审核，不标成已执行', () => {
  const reg = resolveCharacterIdentity({
    videoId: 'file:merge-missing:demo',
    clock,
    utterances: [{
      utteranceId: 'u', startMs: 0, endMs: 1000, text: '你好',
      speakerClusterId: 'S1', evidenceId: 'e',
    }],
    visualTracks: [{ trackId: 'V1', startMs: 0, endMs: 1000 }],
    userActions: [{
      type: 'merge',
      actionId: 'merge-missing',
      seq: 1,
      keepPersonId: 'PER_missing_keep',
      dropPersonId: 'PER_missing_drop',
    }],
  });
  const action = reg.userActions.find((a) => a.actionId === 'merge-missing');
  assert.equal(action.status, 'pending_review');
  assert.equal(action.reason, 'unmapped_reference');
  assert.equal(reg.userActions.some((a) => a.actionId === 'merge-missing' && a.status === 'applied'), false);
  assert.equal(reg.persons.some((p) => p.merged_into), false);
});

test('分块身份解析失败时作业状态改为 degraded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sense-now-cid-job-degraded-'));
  const eng = createVideoIndexEngine({
    rootDir: root,
    adapters: {
      extractFrames: async () => [],
      extractAudio: async () => ({ ok: false }),
      bilibiliSource: {
        resolveStreams: async () => ({
          webpageUrl: 'https://www.bilibili.com/video/BV1fault',
          bvid: 'BV1fault',
          partId: 'p1',
          durationMs: 20_000,
          subtitles: [{ startMs: 1000, endMs: 2000, text: '你好', speakerClusterId: 'SPEAKER_00' }],
        }),
      },
    },
    clock: () => clock,
  });
  const job = await eng.indexAdaptive({
    source: { kind: 'bilibili', url: 'https://www.bilibili.com/video/BV1fault' },
    execution: 'sync',
    capabilities: { characterIdentity: 'on' },
    indexOptions: { characterIdentityFault: 'throw' },
  });
  assert.equal(job.state, 'degraded');
  assert.equal(job.capabilities.characterIdentity, 'degraded');
  const stored = eng.jobStatus(job.jobId);
  assert.equal(stored.job.state, 'degraded');
  assert.equal(stored.job.capabilities.characterIdentity, 'degraded');
});
