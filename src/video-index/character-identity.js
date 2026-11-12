/**
 * character-identity.js — 单视频动态人物身份（阶段 B）。
 *
 * Person、Speaker、VisualTrack、NameEntity 分开存放。
 * 同一时间出现的脸和声音不会自动当成同一个人。
 * 身份更新只写解析引用，不改原始字幕/ASR 文本。
 * 范围是这一条视频的全时间轴，不跨视频共享身份。
 */

import { personIdOf, shortHash } from './ids.js';

export const PROCESSING_VERSION = 'character-identity-b1';
export const MODEL_VERSION = 'rules-b1';
export const IDENTITY_SCOPE = 'video';

export const IDENTITY_STATUSES = Object.freeze(['Unknown', 'Candidate', 'Supported', 'Verified']);
export const VERIFICATION = Object.freeze(['system_verified', 'user_confirmed']);
export const SPEAKER_SOURCES = Object.freeze([
  'on_screen', 'off_screen', 'remote', 'voice_over', 'background', 'unknown',
]);
export const RELATION_TYPES = Object.freeze([
  'speaker_of_person',
  'visual_track_of_person',
  'name_of_person',
  'possibly_same_person',
  'not_same_person',
  'addresses_person',
  'mentions_person',
]);
/** 阶段 C 预留，本阶段不计算。 */
export const RESERVED_RELATION_TYPES = Object.freeze([
  'same_as', 'different_from', 'speaks_as', 'mentions', 'addresses', 'appears_with', 'possibly_related',
]);

const STATUS_RANK = Object.freeze({
  Unknown: 0, Candidate: 1, Supported: 2, Verified: 3,
});

const NAME_STOP = new Set([
  '那么', '所以', '但是', '然后', '如果', '我们', '你们', '他们', '她们',
  '这个', '那个', '什么', '怎么', '因为', '好的', '现在', '就是', '可以',
  '不是', '自己', '大家', '这里', '那里', '今天', '明天', '知道', '觉得',
  '电话', '手机', '旁白', '未知', '人物', '说话',
]);

function sid(kind, parts) {
  return `${kind}_${shortHash(parts.join('|'), 10)}`;
}

function cleanName(raw) {
  const s = String(raw || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/(先生|女士|同学|老师)$/u, '');
  if (s.length < 2 || s.length > 8) return null;
  if (NAME_STOP.has(s)) return null;
  if (/^[0-9]+$/.test(s)) return null;
  return s;
}

function rank(status) {
  return STATUS_RANK[status] ?? 0;
}

function clockOf(input) {
  return typeof input.clock === 'function' ? input.clock() : (input.clock || new Date().toISOString());
}

function emptyRegistry(videoId, now) {
  return {
    schemaVersion: 1,
    scope: IDENTITY_SCOPE,
    videoId,
    revision: 1,
    fingerprint: '',
    processingVersion: PROCESSING_VERSION,
    modelVersion: MODEL_VERSION,
    updatedAt: now,
    persons: [],
    speakers: [],
    visualTracks: [],
    names: [],
    relations: [],
    evidences: [],
    events: [],
    scenes: [],
    utteranceRefs: [],
    userActions: [],
    extras: {
      visualTracks: [],
      observations: [],
      sceneHints: [],
      voiceMatches: [],
    },
    limits: [],
  };
}

function findById(list, id) {
  return list.find((item) => item.id === id) || null;
}

function addEvidence(reg, spec) {
  const lineageKey = spec.lineageKey || null;
  let independent = spec.independent !== false;
  let derivedFrom = null;
  if (lineageKey) {
    const prior = reg.evidences.find((e) => e.lineageKey === lineageKey && e.independent !== false);
    if (prior && prior.source_modality !== spec.source_modality) {
      independent = false;
      derivedFrom = prior.id;
    }
  }
  const id = sid('IDE', [
    reg.videoId, spec.evidence_type, spec.source_modality,
    spec.timestamp_start, spec.timestamp_end, spec.observed_value, spec.source_ref || '',
  ]);
  if (findById(reg.evidences, id)) return findById(reg.evidences, id);
  const row = {
    id,
    video_id: reg.videoId,
    evidence_type: spec.evidence_type,
    source_modality: spec.source_modality,
    timestamp_start: spec.timestamp_start,
    timestamp_end: spec.timestamp_end,
    source_ref: spec.source_ref || null,
    observed_value: spec.observed_value,
    reliability: spec.reliability || 'rule_support',
    raw_similarity: null,
    supports_relation: spec.supports_relation !== false,
    provenance: spec.provenance || {},
    model_version: MODEL_VERSION,
    processing_version: PROCESSING_VERSION,
    independent,
    derivedFrom,
    lineageKey,
  };
  reg.evidences.push(row);
  return row;
}

function addRelation(reg, spec) {
  const id = sid('REL', [reg.videoId, spec.relation_type, spec.source_entity_id, spec.target_entity_id]);
  let row = findById(reg.relations, id);
  if (!row) {
    row = {
      id,
      source_entity_id: spec.source_entity_id,
      target_entity_id: spec.target_entity_id,
      relation_type: spec.relation_type,
      status: 'Unknown',
      confidence_level: 'unknown',
      verification: null,
      evidence_ids: [],
      conflict_ids: [],
      created_at: reg.updatedAt,
      updated_at: reg.updatedAt,
      revision: reg.revision,
      locked: false,
    };
    reg.relations.push(row);
  }
  if (row.locked) return row;
  if (spec.evidenceId && !row.evidence_ids.includes(spec.evidenceId)) row.evidence_ids.push(spec.evidenceId);
  if (spec.conflictId && !row.conflict_ids.includes(spec.conflictId)) row.conflict_ids.push(spec.conflictId);
  if (spec.status && rank(spec.status) >= rank(row.status)) {
    row.status = spec.status;
    row.confidence_level = spec.confidence_level || row.confidence_level;
  }
  row.updated_at = reg.updatedAt;
  return row;
}

function ensurePerson(reg, { key, firstSeen, trackId = null }) {
  const id = personIdOf({ videoKey: reg.videoId, clusterKey: key });
  let person = findById(reg.persons, id);
  if (!person) {
    person = {
      id,
      video_id: reg.videoId,
      display_name: null,
      canonical_name: null,
      proposed_name: null,
      aliases: [],
      identity_status: 'Unknown',
      verification: null,
      name_locked: false,
      created_at: reg.updatedAt,
      updated_at: reg.updatedAt,
      version: 1,
      first_seen: firstSeen,
      track_ids: [],
      speaker_ids: [],
      conflict: false,
      merged_into: null,
      stable_key: key,
      metadata: { scope: IDENTITY_SCOPE, stable_key: key },
    };
    reg.persons.push(person);
  }
  if (trackId && !person.track_ids.includes(trackId)) person.track_ids.push(trackId);
  if (person.first_seen == null || firstSeen < person.first_seen) person.first_seen = firstSeen;
  return person;
}

function ensureSpeaker(reg, { clusterKey, firstSeen, lastSeen, quality = null }) {
  const id = sid('SP', [reg.videoId, 'speaker', clusterKey]);
  let speaker = findById(reg.speakers, id);
  if (!speaker) {
    speaker = {
      id,
      video_id: reg.videoId,
      cluster_key: clusterKey,
      display_name: null,
      voice_profile_ref: clusterKey.startsWith('tmp:') ? null : `speaker-cluster:${clusterKey}`,
      first_seen: firstSeen,
      last_seen: lastSeen,
      channel_metadata: {},
      status: 'Unknown',
      quality,
      segments: [],
    };
    reg.speakers.push(speaker);
  }
  if (firstSeen < speaker.first_seen) speaker.first_seen = firstSeen;
  if (lastSeen > speaker.last_seen) speaker.last_seen = lastSeen;
  if (quality === 'low' || quality === 'compressed') speaker.quality = quality;
  return speaker;
}

function ensureTrack(reg, track) {
  const id = String(track.trackId || track.id);
  let row = findById(reg.visualTracks, id);
  if (!row) {
    row = {
      id,
      video_id: reg.videoId,
      start_ms: track.startMs ?? track.tMs ?? 0,
      end_ms: track.endMs ?? track.tMs ?? track.startMs ?? 0,
      person_id: null,
    };
    reg.visualTracks.push(row);
  }
  if (Number.isFinite(track.startMs)) row.start_ms = Math.min(row.start_ms, track.startMs);
  if (Number.isFinite(track.endMs)) row.end_ms = Math.max(row.end_ms, track.endMs);
  const person = ensurePerson(reg, { key: `track:${id}`, firstSeen: row.start_ms, trackId: id });
  row.person_id = person.id;
  const ev = addEvidence(reg, {
    evidence_type: 'visual_track',
    source_modality: 'visual',
    timestamp_start: row.start_ms,
    timestamp_end: row.end_ms,
    observed_value: id,
    reliability: 'rule_support',
    source_ref: id,
  });
  addRelation(reg, {
    relation_type: 'visual_track_of_person',
    source_entity_id: id,
    target_entity_id: person.id,
    status: 'Supported',
    confidence_level: 'rule_support',
    evidenceId: ev.id,
  });
  return row;
}

function ensureName(reg, { text, source, startMs, endMs, context, entityType }) {
  const normalized = cleanName(text);
  if (!normalized) return null;
  const id = sid('NM', [reg.videoId, normalized, source, startMs, endMs, entityType]);
  let row = findById(reg.names, id);
  if (!row) {
    row = {
      id,
      text: normalized,
      normalized_text: normalized,
      source,
      timestamp_start: startMs,
      timestamp_end: endMs,
      context: context || '',
      entity_type: entityType,
      confidence_level: 'rule_support',
    };
    reg.names.push(row);
  }
  return row;
}

function nameHolder(reg, name, startMs) {
  return ensurePerson(reg, { key: `name:${name.normalized_text}`, firstSeen: startMs });
}

function overlaps(a0, a1, b0, b1) {
  return a1 >= b0 && a0 <= b1;
}

function phoneCue(text) {
  return /打电话|电话里|在电话|通话中|手机里|你现在在哪里|喂[，,]/.test(text);
}

function assignNumbers(reg) {
  const persons = reg.persons
    .filter((p) => !p.merged_into)
    .sort((a, b) => a.first_seen - b.first_seen || a.id.localeCompare(b.id));
  persons.forEach((p, i) => {
    if (!p.display_name) p.display_name = `未知人物${i + 1}`;
  });
  const speakers = [...reg.speakers].sort((a, b) => a.first_seen - b.first_seen || a.id.localeCompare(b.id));
  speakers.forEach((s, i) => {
    if (!s.display_name) s.display_name = `未知说话人${i + 1}`;
  });
}

function setSpeakerSource(speaker, startMs, endMs, source) {
  speaker.segments.push({ start_ms: startMs, end_ms: endMs, source });
}

function activeName(person, reg) {
  if (person.canonical_name) return person.canonical_name;
  if (person.proposed_name) return person.proposed_name;
  const rel = reg.relations.find((r) => r.relation_type === 'name_of_person'
    && r.target_entity_id === person.id
    && r.status !== 'Unknown'
    && !r.revoked);
  if (!rel) return null;
  const name = reg.names.find((n) => n.id === rel.source_entity_id);
  return name?.normalized_text || null;
}

function relationEvidence(reg, rel) {
  return (rel?.evidence_ids || [])
    .map((id) => findById(reg.evidences, id))
    .filter(Boolean);
}

function linkHasClearEvidence(reg, rel) {
  return relationEvidence(reg, rel).some((e) => e.supports_relation !== false
    && e.independent !== false
    && (e.evidence_type === 'lip_sync' || e.evidence_type === 'voice_match_clear' || e.evidence_type === 'user_confirmation'));
}

/**
 * 一个说话人在同一时刻只能有一条有效最终归属。
 * 人工锁定优先于系统 Verified，其次才是 Supported / Candidate。
 */
function settleExclusiveLinks(reg) {
  const bySpeaker = new Map();
  for (const rel of reg.relations) {
    if (rel.relation_type !== 'speaker_of_person' || rel.revoked) continue;
    const list = bySpeaker.get(rel.source_entity_id) || [];
    list.push(rel);
    bySpeaker.set(rel.source_entity_id, list);
  }
  for (const list of bySpeaker.values()) {
    const user = list.filter((r) => r.locked && r.verification === 'user_confirmed' && r.status === 'Verified' && r.pending_review !== true);
    const userTargets = [...new Set(user.map((r) => r.target_entity_id))];
    if (userTargets.length > 1) {
      for (const rel of user) {
        rel.effective = false;
        rel.pending_review = true;
      }
      reg.limits.push('同一说话人有多条冲突的人工锁定，进入待审核');
      continue;
    }
    if (userTargets.length === 1) {
      const keep = user[user.length - 1];
      keep.effective = true;
      keep.pending_review = false;
      for (const rel of list) {
        if (rel === keep) continue;
        if (rel.effective === false && rel.overridden) continue;
        rel.effective = false;
        rel.overridden = true;
        rel.override_reason = rel.override_reason || 'user_decision';
      }
      continue;
    }
    const sys = list.filter((r) => r.effective !== false && r.status === 'Verified' && r.verification === 'system_verified');
    const sysTargets = [...new Set(sys.map((r) => r.target_entity_id))];
    if (sysTargets.length > 1) {
      for (const rel of sys) {
        rel.effective = false;
        rel.conflict_open = true;
      }
      reg.limits.push('同一说话人有多条系统确认归属，未选定');
    }
  }
}

function selectEffectiveLink(links) {
  const active = links.filter((r) => !r.revoked && r.effective !== false && r.pending_review !== true && r.status !== 'Unknown');
  const user = active.filter((r) => r.locked && r.verification === 'user_confirmed' && r.status === 'Verified');
  if (new Set(user.map((r) => r.target_entity_id)).size > 1) return { link: null, competing: 'review' };
  if (user.length) return { link: user[user.length - 1], competing: null };
  const sys = active.filter((r) => r.verification === 'system_verified' && r.status === 'Verified');
  if (new Set(sys.map((r) => r.target_entity_id)).size > 1) return { link: null, competing: 'conflict' };
  if (sys.length === 1) return { link: sys[0], competing: null };
  if (sys.length > 1) return { link: sys[sys.length - 1], competing: null };
  const supported = active.filter((r) => r.status === 'Supported');
  if (supported.length === 1) return { link: supported[0], competing: null };
  if (supported.length > 1) return { link: null, competing: 'conflict' };
  const cand = active.filter((r) => r.status === 'Candidate');
  if (cand.length === 1) return { link: cand[0], competing: null };
  if (cand.length > 1) return { link: null, competing: 'conflict' };
  return { link: null, competing: null };
}

function rebuildRefs(reg, utteranceIndex) {
  reg.utteranceRefs = utteranceIndex.map((u) => {
    const speaker = reg.speakers.find((s) => s.cluster_key === u.speakerClusterId) || null;
    const links = speaker
      ? reg.relations.filter((r) => r.relation_type === 'speaker_of_person'
        && r.source_entity_id === speaker.id
        && !r.revoked)
      : [];
    const picked = selectEffectiveLink(links);
    const link = picked.link;
    const person = link ? findById(reg.persons, link.target_entity_id) : null;
    const unknown = speaker?.display_name || '未知说话人';
    const proposed = person ? activeName(person, reg) : null;
    let label = unknown;
    let status = 'Unknown';
    let verification = null;
    let personId = null;
    if (picked.competing === 'review') {
      label = `${unknown}（待审核）`;
      status = 'Candidate';
    } else if (picked.competing === 'conflict') {
      label = `${unknown}（身份冲突，未选定）`;
      status = 'Candidate';
    } else if (link && person && link.status === 'Verified'
      && (link.verification === 'user_confirmed' || link.verification === 'system_verified')
      && proposed) {
      label = proposed;
      status = 'Verified';
      verification = link.verification;
      personId = person.id;
    } else if (link && person && proposed && (link.status === 'Supported' || link.status === 'Candidate')) {
      label = `${unknown}（可能关联：${proposed}，${link.status}）`;
      status = link.status;
      personId = person.id;
    } else if (link) {
      status = link.status === 'Verified' ? 'Candidate' : (link.status || 'Unknown');
    }
    return {
      utteranceId: u.utteranceId,
      evidenceId: u.evidenceId || null,
      startMs: u.startMs,
      endMs: u.endMs,
      speakerId: speaker?.id || null,
      personId,
      relationId: link?.id || null,
      label,
      status,
      verification,
      proposedName: verification ? proposed : (proposed && status !== 'Unknown' ? proposed : null),
    };
  });
}

function promote(reg) {
  for (const rel of reg.relations) {
    if (rel.locked || rel.revoked) continue;
    const evs = rel.evidence_ids
      .map((id) => findById(reg.evidences, id))
      .filter((e) => e && e.supports_relation && e.independent !== false);
    const high = evs.filter((e) => e.reliability === 'high' || e.evidence_type === 'name_introduction'
      || e.evidence_type === 'lip_sync' || e.evidence_type === 'voice_match_clear');
    if (high.length && rank(rel.status) < rank('Supported')) {
      rel.status = 'Supported';
      rel.confidence_level = 'rule_support';
    } else if (evs.length && rank(rel.status) < rank('Candidate')) {
      rel.status = 'Candidate';
      rel.confidence_level = 'rule_support';
    }
  }

  for (const person of reg.persons) {
    if (person.merged_into || person.name_locked) continue;
    const names = reg.relations.filter((r) => r.relation_type === 'name_of_person'
      && r.target_entity_id === person.id && !r.revoked && rank(r.status) >= rank('Supported'));
    const distinct = new Set(names.map((r) => {
      const n = findById(reg.names, r.source_entity_id);
      return n?.normalized_text;
    }).filter(Boolean));
    if (distinct.size > 1) {
      person.conflict = true;
      person.identity_status = 'Candidate';
      person.verification = null;
      person.canonical_name = null;
      if (!person.name_locked) person.display_name = null;
      reg.limits.push(`人物 ${person.id} 有多个姓名支持，保留冲突，不选边`);
      continue;
    }
    const speakerLinks = reg.relations.filter((r) => r.relation_type === 'speaker_of_person'
      && r.target_entity_id === person.id && !r.revoked && rank(r.status) >= rank('Supported'));
    const clearVoice = speakerLinks.some((r) => r.evidence_ids.some((id) => {
      const e = findById(reg.evidences, id);
      return e && e.independent !== false && (e.evidence_type === 'lip_sync' || e.evidence_type === 'voice_match_clear');
    }));
    if (distinct.size === 1 && clearVoice && !person.conflict) {
      const name = [...distinct][0];
      person.proposed_name = name;
      person.canonical_name = name;
      person.display_name = name;
      person.identity_status = 'Verified';
      person.verification = 'system_verified';
      if (!person.aliases.includes(name)) person.aliases.push(name);
      for (const rel of names) {
        if (!rel.locked) {
          rel.status = 'Verified';
          rel.verification = 'system_verified';
          rel.confidence_level = 'rule_support';
        }
      }
      for (const rel of speakerLinks) {
        if (rel.locked || !linkHasClearEvidence(reg, rel)) continue;
        rel.status = 'Verified';
        rel.verification = 'system_verified';
        rel.confidence_level = 'rule_support';
      }
    } else if (distinct.size === 1) {
      person.proposed_name = [...distinct][0];
      person.identity_status = 'Supported';
      person.verification = null;
    } else if (speakerLinks.length || names.length) {
      person.identity_status = person.identity_status === 'Unknown' ? 'Candidate' : person.identity_status;
    }
  }
}

function extractNames(reg, utterances) {
  for (const u of utterances) {
    const text = String(u.text || '').trim();
    if (!text) continue;
    const modality = u.modality || (u.sourceType === 'ocr' ? 'ocr' : (String(u.source || '').includes('asr') ? 'asr' : 'subtitle'));
    const lineageKey = `${text.normalize('NFKC').replace(/\s+/g, '')}|${Math.round(u.startMs / 1500)}`;
    let body = text;
    const prefixed = text.match(/^([^：:]{1,12})[：:]\s*(.+)$/u);
    if (prefixed) {
      const who = cleanName(prefixed[1]);
      body = prefixed[2];
      if (who) {
        const name = ensureName(reg, {
          text: who, source: modality, startMs: u.startMs, endMs: u.endMs,
          context: text, entityType: 'subtitle_label',
        });
        const holder = nameHolder(reg, name, u.startMs);
        const ev = addEvidence(reg, {
          evidence_type: 'subtitle_label',
          source_modality: modality,
          timestamp_start: u.startMs,
          timestamp_end: u.endMs,
          observed_value: who,
          reliability: 'medium',
          source_ref: u.evidenceId || u.utteranceId,
          lineageKey,
          provenance: { role: 'label_not_fact' },
        });
        addRelation(reg, {
          relation_type: 'name_of_person',
          source_entity_id: name.id,
          target_entity_id: holder.id,
          status: 'Candidate',
          evidenceId: ev.id,
        });
        if (u.speakerClusterId) {
          const speaker = ensureSpeaker(reg, {
            clusterKey: u.speakerClusterId, firstSeen: u.startMs, lastSeen: u.endMs,
          });
          addRelation(reg, {
            relation_type: 'speaker_of_person',
            source_entity_id: speaker.id,
            target_entity_id: holder.id,
            status: 'Candidate',
            confidence_level: 'rule_support',
            evidenceId: ev.id,
          });
        }
      }
    }

    const voc = body.match(/^([\u4e00-\u9fffA-Za-z·]{2,8})[，,]/u);
    if (voc) {
      const who = cleanName(voc[1]);
      if (who) {
        const name = ensureName(reg, {
          text: who, source: modality, startMs: u.startMs, endMs: u.endMs,
          context: text, entityType: 'address',
        });
        const holder = nameHolder(reg, name, u.startMs);
        const ev = addEvidence(reg, {
          evidence_type: 'name_mention',
          source_modality: modality,
          timestamp_start: u.startMs,
          timestamp_end: u.endMs,
          observed_value: who,
          reliability: 'medium',
          source_ref: u.evidenceId || u.utteranceId,
          lineageKey: `${lineageKey}|addr`,
          provenance: { role: 'addresses_not_speaker' },
        });
        addRelation(reg, {
          relation_type: 'addresses_person',
          source_entity_id: u.speakerClusterId
            ? ensureSpeaker(reg, { clusterKey: u.speakerClusterId, firstSeen: u.startMs, lastSeen: u.endMs }).id
            : name.id,
          target_entity_id: holder.id,
          status: 'Candidate',
          evidenceId: ev.id,
        });
        if (holder.identity_status === 'Unknown') holder.identity_status = 'Candidate';
        holder.proposed_name = holder.proposed_name || who;
      }
    }

    const intro = body.match(/(?:这位是|这是|他叫|她叫|名叫)([\u4e00-\u9fffA-Za-z·]{2,8})/u);
    const self = body.match(/我(?:叫|名叫|是)([\u4e00-\u9fffA-Za-z·]{2,8})/u);
    const selfOk = self && !/^我是(?:说|在|不|很|一个)/.test(body);
    if (intro || selfOk) {
      const raw = (intro || self)[1];
      const who = cleanName(raw);
      if (who) {
        const name = ensureName(reg, {
          text: who, source: modality, startMs: u.startMs, endMs: u.endMs,
          context: text, entityType: intro ? 'introduction' : 'self_introduction',
        });
        const tracks = reg.visualTracks.filter((t) => overlaps(t.start_ms, t.end_ms, u.startMs, u.endMs));
        const target = intro && tracks.length === 1
          ? findById(reg.persons, tracks[0].person_id)
          : nameHolder(reg, name, u.startMs);
        const ev = addEvidence(reg, {
          evidence_type: 'name_introduction',
          source_modality: modality,
          timestamp_start: u.startMs,
          timestamp_end: u.endMs,
          observed_value: who,
          reliability: 'high',
          source_ref: u.evidenceId || u.utteranceId,
          lineageKey: `${lineageKey}|intro`,
          provenance: { role: intro ? 'introduction' : 'self_introduction', visualTracks: tracks.length },
        });
        addRelation(reg, {
          relation_type: 'name_of_person',
          source_entity_id: name.id,
          target_entity_id: target.id,
          status: intro && tracks.length === 1 ? 'Supported' : 'Candidate',
          evidenceId: ev.id,
        });
        if (!(intro && tracks.length === 1)) {
          reg.limits.push(`${u.startMs}ms 的姓名介绍没有唯一画面人物，只保留候选`);
        }
      }
    }

    const mention = body.match(/(?:提到|说起|谈到)([\u4e00-\u9fffA-Za-z·]{2,8})/u);
    if (mention) {
      const who = cleanName(mention[1]);
      if (who) {
        const name = ensureName(reg, {
          text: who, source: modality, startMs: u.startMs, endMs: u.endMs,
          context: text, entityType: 'mention',
        });
        const holder = nameHolder(reg, name, u.startMs);
        const ev = addEvidence(reg, {
          evidence_type: 'name_mention',
          source_modality: modality,
          timestamp_start: u.startMs,
          timestamp_end: u.endMs,
          observed_value: who,
          reliability: 'low',
          source_ref: u.evidenceId || u.utteranceId,
          lineageKey: `${lineageKey}|mention`,
        });
        addRelation(reg, {
          relation_type: 'mentions_person',
          source_entity_id: name.id,
          target_entity_id: holder.id,
          status: 'Candidate',
          evidenceId: ev.id,
        });
      }
    }
  }
}

function markScenes(reg, utterances, sceneHints) {
  for (const hint of sceneHints || []) {
    reg.scenes.push({
      id: sid('SCN', [reg.videoId, hint.kind, hint.startMs, hint.endMs]),
      kind: hint.kind,
      start_ms: hint.startMs,
      end_ms: hint.endMs,
      cues: hint.cues || [],
      status: 'Candidate',
    });
  }
  for (const u of utterances) {
    if (!phoneCue(u.text || '')) continue;
    reg.scenes.push({
      id: sid('SCN', [reg.videoId, 'possible_phone_conversation', u.startMs, u.endMs]),
      kind: 'possible_phone_conversation',
      start_ms: Math.max(0, u.startMs - 2000),
      end_ms: u.endMs + 2000,
      cues: ['dialogue'],
      status: 'Candidate',
    });
  }
}

function inPhone(reg, startMs, endMs) {
  return reg.scenes.some((s) => s.kind === 'possible_phone_conversation' && overlaps(s.start_ms, s.end_ms, startMs, endMs));
}

function applyObservations(reg, observations) {
  for (const obs of observations || []) {
    const startMs = Number(obs.startMs ?? obs.tMs ?? 0);
    const endMs = Number(obs.endMs ?? (startMs + (obs.speechMs || 0)));
    for (const faceId of obs.visibleFaceIds || []) {
      ensureTrack(reg, { trackId: faceId, startMs, endMs });
    }
    const speaking = obs.speakingFaceIds || [];
    const soloLip = speaking.length === 1
      && obs.lipSyncOk === true
      && obs.speechClear !== false
      && !obs.overlap
      && obs.speakerClusterId;
    if (!soloLip) {
      if (obs.overlap) reg.limits.push(`${startMs}ms 重叠语音，不分配说话人`);
      continue;
    }
    const track = findById(reg.visualTracks, speaking[0]);
    const speaker = ensureSpeaker(reg, {
      clusterKey: obs.speakerClusterId, firstSeen: startMs, lastSeen: endMs, quality: 'clear',
    });
    const ev = addEvidence(reg, {
      evidence_type: 'lip_sync',
      source_modality: 'audiovisual',
      timestamp_start: startMs,
      timestamp_end: endMs,
      observed_value: `${speaker.id}->${track?.person_id}`,
      reliability: 'high',
      source_ref: obs.evidenceId || null,
      provenance: { staticFrame: false },
    });
    addRelation(reg, {
      relation_type: 'speaker_of_person',
      source_entity_id: speaker.id,
      target_entity_id: track.person_id,
      status: 'Supported',
      evidenceId: ev.id,
    });
    setSpeakerSource(speaker, startMs, endMs, 'on_screen');
    if (!speaker.person_ids) speaker.person_ids = [];
    if (!speaker.person_ids.includes(track.person_id)) speaker.person_ids.push(track.person_id);
  }
}

function applyVoiceMatches(reg, matches) {
  for (const m of matches || []) {
    const quality = m.quality || 'low';
    const high = m.similarity === 'high' && quality === 'clear';
    const speaker = ensureSpeaker(reg, {
      clusterKey: m.speakerClusterId,
      firstSeen: m.startMs || 0,
      lastSeen: m.endMs || m.startMs || 0,
      quality: high ? 'clear' : quality,
    });
    const track = findById(reg.visualTracks, m.trackId);
    if (!track) {
      reg.limits.push(`声纹匹配缺少轨迹 ${m.trackId}`);
      continue;
    }
    const ev = addEvidence(reg, {
      evidence_type: high ? 'voice_match_clear' : 'voice_match_weak',
      source_modality: 'audio',
      timestamp_start: m.startMs || 0,
      timestamp_end: m.endMs || m.startMs || 0,
      observed_value: quality,
      reliability: high ? 'high' : 'low',
      source_ref: m.evidenceId || null,
      provenance: { quality, similarity: m.similarity || 'unspecified', not_a_probability: true },
    });
    addRelation(reg, {
      relation_type: 'speaker_of_person',
      source_entity_id: speaker.id,
      target_entity_id: track.person_id,
      status: high ? 'Supported' : 'Candidate',
      evidenceId: ev.id,
    });
    if (!high) reg.limits.push(`${speaker.id} 的声纹质量为 ${quality}，只保留候选`);
  }
}

function assignSources(reg, utterances) {
  for (const u of utterances) {
    if (!u.speakerClusterId) continue;
    const speaker = ensureSpeaker(reg, {
      clusterKey: u.speakerClusterId, firstSeen: u.startMs, lastSeen: u.endMs,
    });
    const already = speaker.segments.some((s) => overlaps(s.start_ms, s.end_ms, u.startMs, u.endMs));
    if (already) continue;
    const tracks = reg.visualTracks.filter((t) => overlaps(t.start_ms, t.end_ms, u.startMs, u.endMs));
    let source = 'unknown';
    if (/旁白/.test(u.text || '')) source = 'voice_over';
    else if (inPhone(reg, u.startMs, u.endMs)) source = 'remote';
    else if (!tracks.length) source = 'off_screen';
    else source = 'unknown';
    setSpeakerSource(speaker, u.startMs, u.endMs, source);
    if (source === 'remote' && tracks.length) {
      addEvidence(reg, {
        evidence_type: 'phone_scene',
        source_modality: 'context',
        timestamp_start: u.startMs,
        timestamp_end: u.endMs,
        observed_value: 'not_assigned_to_visible_person',
        reliability: 'rule_support',
        supports_relation: false,
        source_ref: u.evidenceId || u.utteranceId,
        provenance: { visibleTracks: tracks.map((t) => t.id) },
      });
    }
  }
}

function linkSameNames(reg) {
  const byName = new Map();
  for (const person of reg.persons) {
    if (person.merged_into) continue;
    const name = person.proposed_name || person.canonical_name;
    if (!name) continue;
    const list = byName.get(name) || [];
    list.push(person);
    byName.set(name, list);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        addRelation(reg, {
          relation_type: 'possibly_same_person',
          source_entity_id: list[i].id,
          target_entity_id: list[j].id,
          status: 'Candidate',
          confidence_level: 'rule_support',
        });
      }
    }
    reg.limits.push(`姓名「${name}」对应多个候选人物，未自动合并`);
  }
}

function diffEvents(reg, prior) {
  const prevPersons = new Map((prior?.persons || []).map((p) => [p.id, p]));
  const prevRels = new Map((prior?.relations || []).map((r) => [r.id, r]));
  for (const person of reg.persons) {
    const old = prevPersons.get(person.id);
    if (!old) {
      reg.events.push(eventRow(reg, person.id, 'created', null, person.identity_status, []));
    } else if (old.identity_status !== person.identity_status || old.display_name !== person.display_name) {
      reg.events.push(eventRow(reg, person.id, 'revised', old.identity_status, person.identity_status, []));
    }
  }
  for (const rel of reg.relations) {
    const old = prevRels.get(rel.id);
    if (!old) {
      reg.events.push(eventRow(reg, rel.id, 'candidate_added', null, rel.status, rel.evidence_ids));
    } else if (old.status !== rel.status) {
      reg.events.push(eventRow(reg, rel.id, rel.revoked ? 'retracted' : 'revised', old.status, rel.status, rel.evidence_ids));
    }
  }
  if (reg.events.length > 200) reg.events = reg.events.slice(-200);
}

function eventRow(reg, entityId, eventType, previous, next, evidenceIds, actor = 'system') {
  return {
    id: sid('IEV', [reg.videoId, reg.revision, entityId, eventType, previous, next, actor]),
    video_id: reg.videoId,
    entity_id: entityId,
    event_type: eventType,
    previous_state: previous,
    new_state: next,
    evidence_ids: evidenceIds || [],
    actor,
    timestamp: reg.updatedAt,
    revision: reg.revision,
  };
}

function fingerprintOf(input, utteranceIndex) {
  return shortHash(JSON.stringify({
    videoId: input.videoId,
    utterances: utteranceIndex.map((u) => [u.utteranceId, u.startMs, u.endMs, u.speakerClusterId, u.text]),
    tracks: input.visualTracks || [],
    observations: input.observations || [],
    scenes: input.sceneHints || [],
    voice: input.voiceMatches || [],
    actions: input.userActions || [],
  }), 20);
}

function utteranceIndexOf(utterances) {
  return (utterances || []).map((u, i) => ({
    utteranceId: u.utteranceId || u.evidenceId || `utt-${i}`,
    evidenceId: u.evidenceId || null,
    startMs: Number(u.startMs) || 0,
    endMs: Number(u.endMs) || Number(u.startMs) || 0,
    speakerClusterId: u.speakerClusterId || null,
    text: String(u.text || ''),
    source: u.source || null,
    sourceType: u.sourceType || null,
    modality: u.modality || null,
  }));
}

function pushUserEvent(reg, action, entityId, eventType, previous, next, evidenceIds) {
  const id = sid('IEV', [reg.videoId, 'user', action.actionId || eventType, entityId, eventType]);
  if (reg.events.some((e) => e.id === id)) return;
  reg.events.push({
    id,
    video_id: reg.videoId,
    entity_id: entityId,
    event_type: eventType,
    previous_state: previous,
    new_state: next,
    evidence_ids: evidenceIds || [],
    actor: 'user',
    action_id: action.actionId || null,
    timestamp: reg.updatedAt,
    revision: reg.revision,
  });
}

function resolvePersonRef(reg, action) {
  if (action.personId && findById(reg.persons, action.personId) && !findById(reg.persons, action.personId).merged_into) {
    return findById(reg.persons, action.personId);
  }
  if (action.personKey) {
    return reg.persons.find((p) => p.stable_key === action.personKey && !p.merged_into) || null;
  }
  return null;
}

function resolveSpeakerRef(reg, action) {
  if (action.speakerId && findById(reg.speakers, action.speakerId)) return findById(reg.speakers, action.speakerId);
  if (action.speakerClusterKey) return reg.speakers.find((s) => s.cluster_key === action.speakerClusterKey) || null;
  return null;
}

function supersedeOtherSpeakerLinks(reg, speakerId, keepId, reason) {
  for (const rel of reg.relations) {
    if (rel.relation_type !== 'speaker_of_person') continue;
    if (rel.source_entity_id !== speakerId || rel.id === keepId || rel.revoked) continue;
    rel.effective = false;
    rel.overridden = true;
    rel.override_reason = reason;
  }
}

function applyUserActions(reg, actions) {
  const seen = new Set();
  const applied = [];
  reg.pendingActions = [];
  for (const raw of actions || []) {
    const actionId = raw.actionId || sid('ACT', [
      reg.videoId, raw.type, raw.speakerId || raw.speakerClusterKey || '',
      raw.personId || raw.personKey || raw.keepPersonId || '', raw.seq ?? '',
    ]);
    if (seen.has(actionId)) continue;
    seen.add(actionId);
    let person = resolvePersonRef(reg, raw);
    let speaker = resolveSpeakerRef(reg, raw);
    if (raw.type === 'confirm' && !person) {
      const named = cleanName(raw.name)
        || (String(raw.personKey || '').startsWith('name:') ? String(raw.personKey).slice(5) : null);
      if (named) person = ensurePerson(reg, { key: `name:${named}`, name: named });
    }
    const needsPerson = ['confirm', 'rename', 'link', 'unlink', 'split'].includes(raw.type);
    const needsSpeaker = ['link', 'unlink', 'split'].includes(raw.type) || (raw.type === 'confirm' && (raw.speakerId || raw.speakerClusterKey));
    const denyMissing = raw.type === 'deny'
      && !findById(reg.relations, raw.relationId)
      && !(person && speaker);
    const keepPerson = raw.type === 'merge'
      ? resolvePersonRef(reg, { personId: raw.keepPersonId, personKey: raw.keepPersonKey })
      : null;
    const dropPerson = raw.type === 'merge'
      ? resolvePersonRef(reg, { personId: raw.dropPersonId, personKey: raw.dropPersonKey })
      : null;
    const mergeMissing = raw.type === 'merge'
      && (!keepPerson || !dropPerson || keepPerson.id === dropPerson.id);
    if ((needsPerson && (raw.personId || raw.personKey) && !person)
      || (needsSpeaker && (raw.speakerId || raw.speakerClusterKey) && !speaker)
      || denyMissing
      || mergeMissing) {
      reg.pendingActions.push({
        ...raw,
        actionId,
        status: 'pending_review',
        reason: 'unmapped_reference',
      });
      reg.limits.push(`人工操作 ${actionId} 无法映射到当前实体，进入待审核`);
      continue;
    }
    const bound = {
      ...raw,
      actionId,
      personId: person?.id || raw.personId || null,
      speakerId: speaker?.id || raw.speakerId || null,
      speakerClusterKey: speaker?.cluster_key || raw.speakerClusterKey || null,
      personKey: person?.stable_key || raw.personKey || null,
      keepPersonId: keepPerson?.id || raw.keepPersonId || null,
      dropPersonId: dropPerson?.id || raw.dropPersonId || null,
      keepPersonKey: keepPerson?.stable_key || raw.keepPersonKey || null,
      dropPersonKey: dropPerson?.stable_key || raw.dropPersonKey || null,
      status: 'applied',
    };
    applyUserAction(reg, bound);
    applied.push(bound);
  }
  reg.userActions = [...applied, ...reg.pendingActions];
}

function applyUserAction(reg, action) {
  const type = action?.type;
  if (type === 'confirm') {
    const person = findById(reg.persons, action.personId);
    if (!person) return;
    const name = cleanName(action.name) || person.proposed_name || person.canonical_name;
    if (name) {
      person.canonical_name = name;
      person.display_name = name;
      person.proposed_name = name;
      if (!person.aliases.includes(name)) person.aliases.push(name);
    }
    person.identity_status = 'Verified';
    person.verification = 'user_confirmed';
    person.name_locked = true;
    person.conflict = false;
    if (action.speakerId) {
      const rel = addRelation(reg, {
        relation_type: 'speaker_of_person',
        source_entity_id: action.speakerId,
        target_entity_id: person.id,
        status: 'Verified',
      });
      rel.status = 'Verified';
      rel.verification = 'user_confirmed';
      rel.locked = true;
      rel.revoked = false;
      rel.effective = true;
      rel.overridden = false;
      const ev = addEvidence(reg, {
        evidence_type: 'user_confirmation',
        source_modality: 'user',
        timestamp_start: person.first_seen || 0,
        timestamp_end: person.first_seen || 0,
        observed_value: name || person.id,
        reliability: 'high',
        provenance: { actor: 'user', actionId: action.actionId || null },
      });
      if (!rel.evidence_ids.includes(ev.id)) rel.evidence_ids.push(ev.id);
      supersedeOtherSpeakerLinks(reg, action.speakerId, rel.id, 'user_decision');
    }
    pushUserEvent(reg, action, person.id, 'confirmed', 'Candidate', 'Verified', []);
    return;
  }
  if (type === 'deny') {
    const rel = findById(reg.relations, action.relationId)
      || reg.relations.find((r) => r.relation_type === 'speaker_of_person'
        && r.source_entity_id === action.speakerId
        && r.target_entity_id === action.personId);
    if (!rel) return;
    rel.revoked = true;
    rel.locked = true;
    rel.effective = false;
    rel.status = 'Unknown';
    rel.verification = null;
    rel.override_reason = 'user_denial';
    const ev = addEvidence(reg, {
      evidence_type: 'user_denial',
      source_modality: 'user',
      timestamp_start: 0,
      timestamp_end: 0,
      observed_value: rel.id,
      reliability: 'high',
      supports_relation: false,
      provenance: { actor: 'user', actionId: action.actionId || null },
    });
    if (!rel.conflict_ids.includes(ev.id)) rel.conflict_ids.push(ev.id);
    pushUserEvent(reg, action, rel.id, 'retracted', 'Supported', 'Unknown', [ev.id]);
    return;
  }
  if (type === 'rename') {
    const person = findById(reg.persons, action.personId);
    if (!person) return;
    const previous = person.display_name;
    person.display_name = String(action.displayName || previous);
    person.name_locked = true;
    pushUserEvent(reg, action, person.id, 'renamed', previous, person.display_name, []);
    return;
  }
  if (type === 'link') {
    const rel = addRelation(reg, {
      relation_type: 'speaker_of_person',
      source_entity_id: action.speakerId,
      target_entity_id: action.personId,
      status: 'Verified',
    });
    rel.status = 'Verified';
    rel.locked = true;
    rel.revoked = false;
    rel.effective = true;
    rel.verification = 'user_confirmed';
    supersedeOtherSpeakerLinks(reg, action.speakerId, rel.id, 'user_decision');
    const person = findById(reg.persons, action.personId);
    if (person && !person.speaker_ids.includes(action.speakerId)) person.speaker_ids.push(action.speakerId);
    pushUserEvent(reg, action, rel.id, 'linked', null, 'Verified', []);
    return;
  }
  if (type === 'unlink') {
    applyUserAction(reg, { type: 'deny', speakerId: action.speakerId, personId: action.personId, relationId: action.relationId });
    return;
  }
  if (type === 'merge') {
    const keep = findById(reg.persons, action.keepPersonId);
    const drop = findById(reg.persons, action.dropPersonId);
    if (!keep || !drop || keep.id === drop.id) return;
    drop.merged_into = keep.id;
    drop.identity_status = 'Unknown';
    if (drop.display_name && !keep.aliases.includes(drop.display_name)) keep.aliases.push(drop.display_name);
    for (const rel of reg.relations) {
      if (rel.target_entity_id === drop.id) rel.target_entity_id = keep.id;
      if (rel.source_entity_id === drop.id) rel.source_entity_id = keep.id;
    }
    keep.track_ids = [...new Set([...keep.track_ids, ...drop.track_ids])];
    keep.speaker_ids = [...new Set([...keep.speaker_ids, ...drop.speaker_ids])];
    pushUserEvent(reg, action, keep.id, 'merged', drop.id, keep.id, []);
    return;
  }
  if (type === 'split') {
    const person = findById(reg.persons, action.personId);
    const speaker = findById(reg.speakers, action.speakerId);
    if (!person || !speaker) return;
    const born = ensurePerson(reg, {
      key: `split:${person.id}:${speaker.id}`,
      firstSeen: speaker.first_seen,
    });
    born.display_name = null;
    for (const rel of reg.relations) {
      if (rel.relation_type === 'speaker_of_person'
        && rel.source_entity_id === speaker.id
        && rel.target_entity_id === person.id) {
        rel.target_entity_id = born.id;
        rel.locked = true;
        rel.verification = 'user_confirmed';
      }
    }
    person.speaker_ids = person.speaker_ids.filter((id) => id !== speaker.id);
    if (!born.speaker_ids.includes(speaker.id)) born.speaker_ids.push(speaker.id);
    pushUserEvent(reg, action, born.id, 'split', person.id, born.id, []);
  }
}

function carryTimestamps(reg, prior) {
  if (!prior) return;
  for (const person of reg.persons) {
    const old = (prior.persons || []).find((p) => p.id === person.id);
    if (old) person.created_at = old.created_at;
  }
}

/**
 * @param {object} input
 * @returns {object} registry
 */
export function resolveCharacterIdentity(input = {}) {
  const videoId = input.videoId || input.videoKey;
  if (!videoId) {
    const err = new Error('videoId required');
    err.code = 'VIDEO_ID';
    throw err;
  }
  const now = clockOf(input);
  const utteranceIndex = utteranceIndexOf(input.utterances);
  const fp = fingerprintOf({ ...input, videoId }, utteranceIndex);
  const prior = input.prior || null;
  const userActions = input.userActions || prior?.userActions || [];
  if (prior && prior.fingerprint === fp && !input.force) return prior;

  const reg = emptyRegistry(videoId, now);
  reg.revision = (prior?.revision || 0) + 1;
  reg.fingerprint = fp;
  reg.userActions = userActions;
  reg.extras = {
    visualTracks: input.visualTracks || [],
    observations: input.observations || [],
    sceneHints: input.sceneHints || [],
    voiceMatches: input.voiceMatches || [],
  };
  reg.events = prior?.events ? prior.events.slice(-160) : [];

  for (const track of input.visualTracks || []) ensureTrack(reg, track);
  for (const u of utteranceIndex) {
    if (!u.speakerClusterId) continue;
    ensureSpeaker(reg, { clusterKey: u.speakerClusterId, firstSeen: u.startMs, lastSeen: u.endMs });
  }
  markScenes(reg, utteranceIndex, input.sceneHints);
  extractNames(reg, utteranceIndex);
  applyObservations(reg, input.observations);
  applyVoiceMatches(reg, input.voiceMatches);
  assignSources(reg, utteranceIndex);
  promote(reg);
  linkSameNames(reg);
  applyUserActions(reg, userActions);
  settleExclusiveLinks(reg);
  assignNumbers(reg);
  for (const speaker of reg.speakers) {
    const links = reg.relations.filter((r) => r.relation_type === 'speaker_of_person' && r.source_entity_id === speaker.id && !r.revoked);
    speaker.status = selectEffectiveLink(links).link?.status || 'Unknown';
  }
  for (const person of reg.persons) {
    person.speaker_ids = reg.relations
      .filter((r) => r.relation_type === 'speaker_of_person' && r.target_entity_id === person.id && r.effective !== false && !r.revoked && r.status !== 'Unknown')
      .map((r) => r.source_entity_id);
    person.updated_at = now;
    person.version = reg.revision;
  }
  rebuildRefs(reg, utteranceIndex);
  carryTimestamps(reg, prior);
  diffEvents(reg, prior);
  reg.limits = [...new Set(reg.limits)];
  assertIdentityInvariants(reg);
  return reg;
}

export function assertIdentityInvariants(reg) {
  if (!reg) return;
  for (const ref of reg.utteranceRefs || []) {
    if (ref.verification !== 'system_verified' && ref.verification !== 'user_confirmed') continue;
    const link = (reg.relations || []).find((r) => r.id === ref.relationId);
    if (!link || link.status !== 'Verified' || link.verification !== ref.verification || link.effective === false || link.revoked) {
      throw new Error(`invariant: confirmed line ${ref.utteranceId} is not backed by that speaker link`);
    }
  }
  const bySpeaker = new Map();
  for (const rel of reg.relations || []) {
    if (rel.relation_type !== 'speaker_of_person' || rel.revoked || rel.effective === false) continue;
    if (rel.status !== 'Verified') continue;
    const list = bySpeaker.get(rel.source_entity_id) || [];
    list.push(rel.target_entity_id);
    bySpeaker.set(rel.source_entity_id, list);
  }
  for (const [speakerId, targets] of bySpeaker) {
    if (new Set(targets).size > 1) {
      throw new Error(`invariant: speaker ${speakerId} has more than one effective final person`);
    }
  }
}

export function labelForUtterance(registry, utterance) {
  if (!registry?.utteranceRefs || !utterance) return null;
  const ref = registry.utteranceRefs.find((r) => (
    (utterance.utteranceId && r.utteranceId === utterance.utteranceId)
    || (utterance.evidenceId && r.evidenceId === utterance.evidenceId)
  ));
  return ref?.label || null;
}

export function listCharacterIdentities(registry) {
  if (!registry) return [];
  return registry.persons.filter((p) => !p.merged_into).map((p) => ({
    id: p.id,
    displayName: p.display_name,
    proposedName: p.proposed_name,
    canonicalName: p.canonical_name,
    status: p.identity_status,
    verification: p.verification,
    speakers: p.speaker_ids,
    firstSeen: p.first_seen,
    evidenceCount: registry.relations
      .filter((r) => r.target_entity_id === p.id || r.source_entity_id === p.id)
      .reduce((n, r) => n + r.evidence_ids.length, 0),
    conflict: Boolean(p.conflict),
  }));
}

export function characterIdentityDetail(registry, personId) {
  if (!registry) return null;
  const person = findById(registry.persons, personId);
  if (!person) return null;
  const rels = registry.relations.filter((r) => r.target_entity_id === personId || r.source_entity_id === personId);
  const evidenceIds = new Set(rels.flatMap((r) => [...r.evidence_ids, ...r.conflict_ids]));
  const evidences = registry.evidences.filter((e) => evidenceIds.has(e.id));
  return {
    person,
    visual: registry.visualTracks.filter((t) => t.person_id === personId),
    speech: registry.utteranceRefs.filter((r) => r.personId === personId || person.speaker_ids.includes(r.speakerId)),
    names: registry.names.filter((n) => rels.some((r) => r.source_entity_id === n.id || r.target_entity_id === n.id)),
    support: evidences.filter((e) => e.supports_relation),
    oppose: evidences.filter((e) => !e.supports_relation),
    history: registry.events.filter((e) => e.entity_id === personId || rels.some((r) => r.id === e.entity_id)),
    relations: rels,
  };
}

export { RESERVED_RELATION_TYPES as FUTURE_RELATION_TYPES };
