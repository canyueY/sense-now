/**
 * subtitle-adapter.js — 字幕规范化 → utterances / 章节骨架。
 * 支持内联条目与 SRT / VTT 文件（纯解析，无网络）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { contentHash, evidenceIdOf, chapterIdOf, eventIdOf } from '../ids.js';
import { evidenceLogicalRef } from '../paths.js';
import { validateChapter, validateEvidenceRef } from '../schema.js';

/** 解析时间戳：00:00:01,500 / 00:00:01.500 / 00:01.500 */
export function parseTimestampToMs(raw) {
  const s = String(raw || '').trim().replace(',', '.');
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const hours = m[1] != null ? Number(m[1]) : 0;
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  if (![hours, mins, secs].every(Number.isFinite)) return null;
  return Math.round(((hours * 60 + mins) * 60 + secs) * 1000);
}

export function parseSrt(text) {
  const blocks = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n\r?\n+/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, arr) => {
      // 保留空行以外的内容；块内空行少见
      return !(i === 0 && l === '') && !(i === arr.length - 1 && l === '');
    });
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    if (i >= lines.length) continue;
    const tm = lines[i].match(/(.+?)\s*-->\s*(.+)/);
    if (!tm) continue;
    const startMs = parseTimestampToMs(tm[1].trim());
    const endMs = parseTimestampToMs(tm[2].trim().split(/\s+/)[0]);
    if (startMs == null || endMs == null) continue;
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (!body) continue;
    out.push({ startMs, endMs, text: body });
  }
  return out;
}

export function parseVtt(text) {
  let body = String(text || '').replace(/^\uFEFF/, '');
  body = body.replace(/^WEBVTT[^\n]*\n+/i, '');
  // 去掉 NOTE / STYLE 块
  body = body.replace(/^(NOTE|STYLE)[\s\S]*?(?:\r?\n\r?\n)/gim, '');
  const blocks = body.split(/\r?\n\r?\n+/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let i = 0;
    if (lines[0].includes('-->') === false && lines.length > 1) i = 1;
    if (i >= lines.length || !lines[i].includes('-->')) continue;
    const tm = lines[i].match(/(.+?)\s*-->\s*(.+)/);
    if (!tm) continue;
    const startMs = parseTimestampToMs(tm[1].trim());
    const endMs = parseTimestampToMs(tm[2].trim().split(/\s+/)[0]);
    if (startMs == null || endMs == null) continue;
    const cue = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (!cue) continue;
    out.push({ startMs, endMs, text: cue });
  }
  return out;
}

/**
 * 从本地字幕文件加载。路径必须由调用方保证可信；此处只读文件内容。
 */
/** ASS/SSA：去掉样式标签，保留 Dialogue 文本与时间。 */
export function parseAss(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!/^Dialogue:/i.test(line)) continue;
    // Dialogue: Layer, Start, End, Style, Name, M,L,R,V, Effect, Text
    const body = line.replace(/^Dialogue:\s*/i, '');
    const parts = body.split(',');
    if (parts.length < 10) continue;
    const startMs = parseAssTime(parts[1]);
    const endMs = parseAssTime(parts[2]);
    if (startMs == null || endMs == null) continue;
    const rawText = parts.slice(9).join(',');
    const cleaned = rawText
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\n/gi, '\n')
      .replace(/\\h/gi, ' ')
      .trim();
    if (!cleaned) continue;
    out.push({ startMs, endMs, text: cleaned });
  }
  return out;
}

function parseAssTime(raw) {
  // H:MM:SS.cs (centiseconds)
  const m = String(raw || '').trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3]);
  const cs = Number(m[4].padEnd(2, '0'));
  if (![h, mi, s, cs].every(Number.isFinite)) return null;
  return Math.round((((h * 60 + mi) * 60 + s) * 1000) + cs * 10);
}

export function parseSubtitleText(raw, { ext = '' } = {}) {
  const t = String(raw || '').replace(/^\uFEFF/, '');
  const e = String(ext || '').toLowerCase();
  if (e === '.vtt' || /^WEBVTT/i.test(t.trimStart())) return parseVtt(t);
  if (e === '.ass' || e === '.ssa' || /^\[Script Info\]/i.test(t)) return parseAss(t);
  return parseSrt(t);
}

export function loadSubtitleFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    const err = new Error(`subtitle file not found: ${filePath}`);
    err.code = 'ENOENT';
    throw err;
  }
  const raw = readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 8 * 1024 * 1024) {
    throw new Error('subtitle file too large');
  }
  const ext = extname(filePath).toLowerCase();
  return parseSubtitleText(raw, { ext });
}

/** 按半开区间裁剪字幕；中点归属。 */
export function sliceSubtitlesByRange(entries = [], startMs, endMs) {
  const a = Number(startMs) || 0;
  const b = Number(endMs);
  if (!Number.isFinite(b)) return [...entries];
  return (entries || []).filter((s) => {
    const mid = ((Number(s.startMs) || 0) + (Number(s.endMs) || 0)) / 2;
    return mid >= a && mid < b;
  });
}

export function normalizeSubtitles(raw = [], { videoKey, indexVersion, clock = () => new Date().toISOString() } = {}) {
  const subtitles = [];
  const utterances = [];
  const evidence = [];

  for (const s of raw) {
    const text = String(s.text || '').trim();
    if (!text) continue;
    const startMs = Math.round(Number(s.startMs) || 0);
    const endMs = Math.round(Number(s.endMs) || startMs);
    const ch = contentHash(`${startMs}|${endMs}|${text}`);
    const eid = evidenceIdOf({ videoKey, kind: 'subtitle', startMs, endMs, contentHash: ch });
    const givenConf = Number(s.confidence);
    const confidence = Number.isFinite(givenConf) ? givenConf : 1;
    const row = {
      startMs,
      endMs,
      text,
      lang: s.lang || null,
      evidenceId: eid,
      evidenceIds: [eid],
      confidence,
      sourceType: s.sourceType || (Number.isFinite(givenConf) ? 'ocr' : 'native'),
    };
    subtitles.push(row);
    utterances.push({
      utteranceId: `UTT_${eid.slice(5, 17)}`,
      startMs,
      endMs,
      text,
      source: 'subtitle',
      speakerClusterId: null,
      evidenceId: eid,
      evidenceIds: [eid],
      confidence,
      sourceType: row.sourceType,
    });
    evidence.push(validateEvidenceRef({
      evidenceId: eid,
      kind: 'subtitle',
      startMs,
      endMs,
      ref: evidenceLogicalRef(videoKey, 'subtitle', eid),
      sourceFile: null,
      contentHash: ch,
      provenance: {
        adapter: 'subtitle-adapter',
        version: '1',
        generatedAt: clock(),
      },
    }));
  }

  const chapters = buildChapterSkeleton(subtitles, { videoKey, indexVersion });
  return { subtitles, utterances, evidence, chapters };
}

/** 规则章节骨架：按大间隙切；不可靠时允许空标题/摘要，不发明内容。 */
export function buildChapterSkeleton(subtitles, { videoKey, indexVersion, gapMs = 12_000 } = {}) {
  if (!subtitles.length) return [];
  const chapters = [];
  let start = subtitles[0].startMs;
  let buf = [];
  let prevEnd = subtitles[0].endMs;

  const flush = (endMs) => {
    if (!buf.length) return;
    const evidenceIds = buf.map((s) => s.evidenceId).filter(Boolean);
    const title = ''; // 规则不够可靠时不发明标题
    const summary = '';
    const chapter = validateChapter({
      chapterId: chapterIdOf({ videoKey, indexVersion, startMs: start, endMs, title }),
      title,
      startMs: start,
      endMs,
      summary,
      topicTags: [],
      eventIds: [],
      evidenceIds,
      summaryMethod: 'subtitle-rules',
      confidence: evidenceIds.length ? 0.4 : 0,
    });
    chapters.push(chapter);
    buf = [];
  };

  for (const s of subtitles) {
    if (buf.length && s.startMs - prevEnd >= gapMs) {
      flush(prevEnd);
      start = s.startMs;
    }
    buf.push(s);
    prevEnd = s.endMs;
  }
  flush(prevEnd);
  return chapters;
}

export function subtitleEvents(subtitles, { videoKey, indexVersion } = {}) {
  return (subtitles || []).slice(0, 200).map((s) => ({
    eventId: eventIdOf({
      videoKey,
      indexVersion,
      startMs: s.startMs,
      kind: 'subtitle',
      contentHash: s.evidenceId || '',
    }),
    startMs: s.startMs,
    endMs: s.endMs,
    kind: 'subtitle',
    summary: s.text.slice(0, 80),
    text: s.text,
    evidenceIds: s.evidenceIds || [s.evidenceId].filter(Boolean),
  }));
}
