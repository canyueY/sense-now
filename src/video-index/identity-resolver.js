/**
 * identity-resolver.js — 人物↔音色绑定状态机（确定性，可单测）。
 *
 * 绑定不能只靠单分；需要多独立证据。全片单音色不得断言「UP 主本人」。
 */

import { personIdOf } from './ids.js';
import { validatePersonBinding } from './schema.js';

export const DEFAULT_THRESHOLDS = Object.freeze({
  minSoloSegments: 2,
  minClearSpeechMs: 800,
  minConfidence: 0.75,
  conflictMargin: 0.15,
});

/**
 * @param {{
 *   videoKey: string,
 *   observations: Array<{
 *     tMs: number,
 *     visibleFaceIds: string[],
 *     speakingFaceIds: string[],
 *     speakerClusterId: string|null,
 *     speechClear: boolean,
 *     speechMs: number,
 *     lipSyncOk: boolean|null,
 *     overlap: boolean,
 *     evidenceId: string,
 *   }>,
 *   thresholds?: object,
 * }} input
 */
export function resolveIdentities(input) {
  const {
    videoKey,
    observations = [],
    thresholds = {},
  } = input;
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const faceStats = new Map(); // faceId -> { speakers: Map, solos: [], evidenceIds }
  const speakerStats = new Map(); // speaker -> { faces: Map, evidenceIds, totalMs }
  const persons = new Map();

  for (const obs of observations) {
    const faces = obs.visibleFaceIds || [];
    const speaking = new Set(obs.speakingFaceIds || []);
    const sp = obs.speakerClusterId;

    if (obs.overlap) {
      // 重叠语音：保留 overlap，不压成单人
      continue;
    }

    if (sp) {
      const ss = speakerStats.get(sp) || { faces: new Map(), evidenceIds: [], totalMs: 0 };
      ss.totalMs += obs.speechMs || 0;
      ss.evidenceIds.push(obs.evidenceId);
      speakerStats.set(sp, ss);
    }

    // 单人可见 + 嘴动 + 清晰非重叠语音
    const solo = faces.length === 1 && speaking.has(faces[0])
      && obs.speechClear && !obs.overlap
      && (obs.lipSyncOk !== false)
      && (obs.speechMs || 0) >= th.minClearSpeechMs
      && sp;

    if (solo) {
      const faceId = faces[0];
      const fs = faceStats.get(faceId) || { speakers: new Map(), solos: [], evidenceIds: [] };
      fs.solos.push(obs);
      fs.evidenceIds.push(obs.evidenceId);
      fs.speakers.set(sp, (fs.speakers.get(sp) || 0) + 1);
      faceStats.set(faceId, fs);

      const ss = speakerStats.get(sp);
      ss.faces.set(faceId, (ss.faces.get(faceId) || 0) + 1);
    }

    // 组合纠错线索：记录集合变化（供后续 pass）
  }

  // 组合纠错：A → A+B → B
  applySetTransitions(observations, faceStats, speakerStats);

  // 从 solo 证据生成绑定
  for (const [faceId, fs] of faceStats) {
    const ranked = [...fs.speakers.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) continue;
    const [bestSp, bestCount] = ranked[0];
    const second = ranked[1]?.[1] || 0;
    const evidenceIds = [...new Set(fs.evidenceIds)];
    let bindingState = 'unbound';
    let confidence = Math.min(0.99, 0.5 + bestCount * 0.15);
    let label = null;
    let labelSource = 'inference';

    if (fs.solos.length >= th.minSoloSegments && bestCount >= th.minSoloSegments
      && confidence >= th.minConfidence
      && (bestCount - second) >= 1) {
      bindingState = 'confirmed';
    } else if (fs.solos.length >= 1) {
      bindingState = 'tentative';
      confidence = Math.min(confidence, 0.7);
    }

    // 冲突：同一脸强绑两个声
    if (ranked.length > 1 && ranked[1][1] >= th.minSoloSegments
      && (ranked[0][1] - ranked[1][1]) < 1) {
      bindingState = 'conflict';
      confidence = Math.max(0.2, confidence - th.conflictMargin);
    }

    // 配音/口型不一致
    const lipFail = fs.solos.some((o) => o.lipSyncOk === false);
    if (lipFail) {
      if (bindingState === 'confirmed') bindingState = 'tentative';
      confidence = Math.min(confidence, 0.55);
    }

    const personId = personIdOf({ videoKey, clusterKey: `${faceId}:${bestSp}` });
    const person = validatePersonBinding({
      personId,
      faceTrackIds: [faceId],
      speakerClusterIds: [bestSp],
      avatarRef: null,
      bindingState,
      confidence,
      evidenceIds,
      label,
      labelSource,
    });
    persons.set(personId, person);
  }

  // 无人回退
  const anyFace = observations.some((o) => (o.visibleFaceIds || []).length > 0);
  if (!anyFace) {
    const speakers = [...speakerStats.keys()];
    if (speakers.length === 1) {
      const sp = speakers[0];
      const personId = personIdOf({ videoKey, clusterKey: `audio:${sp}` });
      persons.set(personId, validatePersonBinding({
        personId,
        faceTrackIds: [],
        speakerClusterIds: [sp],
        avatarRef: null,
        bindingState: 'tentative',
        confidence: 0.5,
        evidenceIds: [...new Set(speakerStats.get(sp).evidenceIds)],
        label: '疑似主讲人/旁白',
        labelSource: 'inference',
      }));
    }
    // 多音色：匿名留白，不创建 person
  }

  // 单人出镜但旁白说话 → audio-only（不绑定脸）
  for (const obs of observations) {
    const faces = obs.visibleFaceIds || [];
    const speaking = obs.speakingFaceIds || [];
    if (faces.length === 1 && obs.speakerClusterId && speaking.length === 0 && obs.speechClear) {
      // 确保没有把旁白绑到可见脸上
      for (const p of persons.values()) {
        if (p.faceTrackIds.includes(faces[0]) && p.speakerClusterIds.includes(obs.speakerClusterId)) {
          if (p.bindingState === 'confirmed') {
            p.bindingState = 'tentative';
            p.confidence = Math.min(p.confidence, 0.5);
          }
          // 降级为 audio 线索不足时保持 face unbound for that speaker
        }
      }
    }
  }

  return {
    persons: [...persons.values()],
    speakerClusters: [...speakerStats.entries()].map(([id, s]) => ({
      speakerClusterId: id,
      totalMs: s.totalMs,
      evidenceIds: [...new Set(s.evidenceIds)],
    })),
  };
}

/**
 * 利用可见集合变化纠正：A→A+B→B 时，若 B 段语音属 SPEAKER_X，倾向绑 B。
 */
function applySetTransitions(observations, faceStats, speakerStats) {
  for (let i = 1; i < observations.length - 1; i += 1) {
    const prev = new Set(observations[i - 1].visibleFaceIds || []);
    const cur = new Set(observations[i].visibleFaceIds || []);
    const next = new Set(observations[i + 1].visibleFaceIds || []);
    // A → A+B → B
    if (prev.size === 1 && cur.size === 2 && next.size === 1) {
      const a = [...prev][0];
      const b = [...next][0];
      if (cur.has(a) && cur.has(b) && a !== b) {
        const mid = observations[i];
        const sp = mid.speakerClusterId;
        if (sp && (mid.speakingFaceIds || []).includes(b)) {
          const fs = faceStats.get(b) || { speakers: new Map(), solos: [], evidenceIds: [] };
          fs.speakers.set(sp, (fs.speakers.get(sp) || 0) + 1);
          fs.evidenceIds.push(mid.evidenceId);
          fs.solos.push(mid);
          faceStats.set(b, fs);
          const ss = speakerStats.get(sp) || { faces: new Map(), evidenceIds: [], totalMs: 0 };
          ss.faces.set(b, (ss.faces.get(b) || 0) + 1);
          ss.evidenceIds.push(mid.evidenceId);
          speakerStats.set(sp, ss);
        }
      }
    }
  }
}
