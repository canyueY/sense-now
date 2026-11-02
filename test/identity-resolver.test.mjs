import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdentities } from '../src/video-index/identity-resolver.js';

test('单人正面讲话可 confirmed', () => {
  const r = resolveIdentities({
    videoKey: 'file:id:demo',
    observations: [
      {
        tMs: 1000, visibleFaceIds: ['FACE_A'], speakingFaceIds: ['FACE_A'],
        speakerClusterId: 'SPEAKER_01', speechClear: true, speechMs: 1000,
        lipSyncOk: true, overlap: false, evidenceId: 'e1',
      },
      {
        tMs: 5000, visibleFaceIds: ['FACE_A'], speakingFaceIds: ['FACE_A'],
        speakerClusterId: 'SPEAKER_01', speechClear: true, speechMs: 1200,
        lipSyncOk: true, overlap: false, evidenceId: 'e2',
      },
    ],
  });
  assert.equal(r.persons.length, 1);
  assert.equal(r.persons[0].bindingState, 'confirmed');
  assert.ok(!/UP\s*主本人/.test(r.persons[0].label || ''));
});

test('单人出镜但旁白说话保持弱绑定/audio 倾向', () => {
  const r = resolveIdentities({
    videoKey: 'file:id:demo',
    observations: [
      {
        tMs: 1000, visibleFaceIds: ['FACE_A'], speakingFaceIds: [],
        speakerClusterId: 'SPEAKER_01', speechClear: true, speechMs: 1000,
        lipSyncOk: null, overlap: false, evidenceId: 'e1',
      },
      {
        tMs: 2000, visibleFaceIds: ['FACE_A'], speakingFaceIds: [],
        speakerClusterId: 'SPEAKER_01', speechClear: true, speechMs: 1000,
        lipSyncOk: null, overlap: false, evidenceId: 'e2',
      },
    ],
  });
  // 无 solo 嘴动证据 → 不应 confirmed 绑脸
  assert.ok(r.persons.every((p) => p.bindingState !== 'confirmed'));
});

test('A → A+B → B 组合纠错', () => {
  const r = resolveIdentities({
    videoKey: 'file:id:demo',
    observations: [
      {
        tMs: 0, visibleFaceIds: ['A'], speakingFaceIds: ['A'],
        speakerClusterId: 'S1', speechClear: true, speechMs: 900,
        lipSyncOk: true, overlap: false, evidenceId: 'e0',
      },
      {
        tMs: 1000, visibleFaceIds: ['A', 'B'], speakingFaceIds: ['B'],
        speakerClusterId: 'S2', speechClear: true, speechMs: 900,
        lipSyncOk: true, overlap: false, evidenceId: 'e1',
      },
      {
        tMs: 2000, visibleFaceIds: ['B'], speakingFaceIds: ['B'],
        speakerClusterId: 'S2', speechClear: true, speechMs: 900,
        lipSyncOk: true, overlap: false, evidenceId: 'e2',
      },
      {
        tMs: 3000, visibleFaceIds: ['B'], speakingFaceIds: ['B'],
        speakerClusterId: 'S2', speechClear: true, speechMs: 900,
        lipSyncOk: true, overlap: false, evidenceId: 'e3',
      },
    ],
  });
  const b = r.persons.find((p) => p.faceTrackIds.includes('B'));
  assert.ok(b);
  assert.ok(b.speakerClusterIds.includes('S2'));
});

test('A+B → B+C → A+C 证据不足保持 tentative', () => {
  const r = resolveIdentities({
    videoKey: 'file:id:demo',
    observations: [
      {
        tMs: 0, visibleFaceIds: ['A', 'B'], speakingFaceIds: ['A'],
        speakerClusterId: 'S1', speechClear: true, speechMs: 900,
        lipSyncOk: true, overlap: false, evidenceId: 'e0',
      },
      {
        tMs: 1000, visibleFaceIds: ['B', 'C'], speakingFaceIds: ['B'],
        speakerClusterId: 'S2', speechClear: true, speechMs: 900,
        lipSyncOk: true, overlap: false, evidenceId: 'e1',
      },
      {
        tMs: 2000, visibleFaceIds: ['A', 'C'], speakingFaceIds: ['C'],
        speakerClusterId: 'S3', speechClear: true, speechMs: 900,
        lipSyncOk: true, overlap: false, evidenceId: 'e2',
      },
    ],
  });
  assert.ok(r.persons.every((p) => p.bindingState !== 'confirmed' || p.confidence < 0.9));
});

test('无人单音色标疑似主讲人，不标 UP 主本人；多音色匿名', () => {
  const one = resolveIdentities({
    videoKey: 'file:id:demo',
    observations: [
      {
        tMs: 0, visibleFaceIds: [], speakingFaceIds: [],
        speakerClusterId: 'S1', speechClear: true, speechMs: 2000,
        lipSyncOk: null, overlap: false, evidenceId: 'e1',
      },
    ],
  });
  assert.equal(one.persons.length, 1);
  assert.match(one.persons[0].label, /疑似主讲人/);
  assert.ok(!/UP\s*主本人/.test(one.persons[0].label));

  const multi = resolveIdentities({
    videoKey: 'file:id:demo',
    observations: [
      {
        tMs: 0, visibleFaceIds: [], speakingFaceIds: [],
        speakerClusterId: 'S1', speechClear: true, speechMs: 1000,
        lipSyncOk: null, overlap: false, evidenceId: 'e1',
      },
      {
        tMs: 2000, visibleFaceIds: [], speakingFaceIds: [],
        speakerClusterId: 'S2', speechClear: true, speechMs: 1000,
        lipSyncOk: null, overlap: false, evidenceId: 'e2',
      },
    ],
  });
  assert.equal(multi.persons.length, 0);
});

test('overlap 与口型不一致不乱绑定', () => {
  const r = resolveIdentities({
    videoKey: 'file:id:demo',
    observations: [
      {
        tMs: 0, visibleFaceIds: ['A'], speakingFaceIds: ['A'],
        speakerClusterId: 'S1', speechClear: true, speechMs: 1000,
        lipSyncOk: false, overlap: false, evidenceId: 'e1',
      },
      {
        tMs: 1000, visibleFaceIds: ['A', 'B'], speakingFaceIds: ['A', 'B'],
        speakerClusterId: 'S1', speechClear: true, speechMs: 1000,
        lipSyncOk: true, overlap: true, evidenceId: 'e2',
      },
    ],
  });
  if (r.persons.length) {
    assert.notEqual(r.persons[0].bindingState, 'confirmed');
  }
});
