/**
 * profile-policy.js — 用户层内容 profile 定义库（不自动应用建议）。
 */

import { PROFILE_IDS } from './analysis-policy.js';

/** @type {Record<string, object>} */
export const PROFILE_LIBRARY = Object.freeze({
  general: {
    id: 'general',
    label: '通用字幕优先',
    subtitleFocus: 'dialogue',
    suggestedVisual: { width: 800, height: 450, density: 'low' },
    taskRoi: null,
    sceneSensitivity: 0.5,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'subtitle_first',
  },
  visual_edit: {
    id: 'visual_edit',
    label: '混剪/MV',
    subtitleFocus: 'lyrics_or_title',
    suggestedVisual: { width: 960, height: 540, density: 'high' },
    taskRoi: null,
    sceneSensitivity: 0.85,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'visual_heavy',
  },
  handcraft: {
    id: 'handcraft',
    label: '手工/烹饪/维修',
    subtitleFocus: 'instruction',
    suggestedVisual: { width: 960, height: 540, density: 'medium' },
    taskRoi: 'hands_tools_bench',
    sceneSensitivity: 0.55,
    suggestEndFrame: true,
    suggestAudio: { speechActivity: true, asr: 'fallback' },
    queryStrategy: 'demo_result',
  },
  anime: {
    id: 'anime',
    label: '番剧/动画',
    subtitleFocus: 'dialogue',
    suggestedVisual: { width: 800, height: 450, density: 'medium' },
    taskRoi: 'faces_reactions',
    sceneSensitivity: 0.6,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'dialogue_reaction',
  },
  film: {
    id: 'film',
    label: '电影/剧集',
    subtitleFocus: 'dialogue',
    suggestedVisual: { width: 960, height: 540, density: 'medium' },
    taskRoi: 'establishing_cast',
    sceneSensitivity: 0.55,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'narrative',
  },
  screen_tutorial: {
    id: 'screen_tutorial',
    label: '软件教程',
    subtitleFocus: 'ui_caption',
    suggestedVisual: { width: 1280, height: 720, density: 'medium' },
    taskRoi: 'ui_cursor',
    sceneSensitivity: 0.4,
    suggestEndFrame: true,
    suggestAudio: { speechActivity: true, asr: 'fallback' },
    queryStrategy: 'ui_before_after',
  },
  slides_lecture: {
    id: 'slides_lecture',
    label: 'PPT/课程',
    subtitleFocus: 'slide_text',
    suggestedVisual: { width: 1280, height: 720, density: 'low' },
    taskRoi: 'slide_region',
    sceneSensitivity: 0.35,
    suggestEndFrame: true,
    suggestAudio: { speechActivity: true, asr: 'fallback' },
    queryStrategy: 'slide_change',
  },
  interview: {
    id: 'interview',
    label: '访谈/播客',
    subtitleFocus: 'dialogue',
    suggestedVisual: { width: 640, height: 360, density: 'low' },
    taskRoi: 'speakers',
    sceneSensitivity: 0.3,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: true, asr: 'full' },
    queryStrategy: 'speaker_opinion',
  },
  talking_head: {
    id: 'talking_head',
    label: '单人口播',
    subtitleFocus: 'dialogue',
    suggestedVisual: { width: 800, height: 450, density: 'low' },
    taskRoi: 'board_inserts',
    sceneSensitivity: 0.35,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'subtitle_first',
  },
  gameplay: {
    id: 'gameplay',
    label: '游戏',
    subtitleFocus: 'hud_quest',
    suggestedVisual: { width: 960, height: 540, density: 'medium' },
    taskRoi: 'hud_score',
    sceneSensitivity: 0.7,
    suggestEndFrame: true,
    suggestAudio: { speechActivity: true, asr: 'on_demand' },
    queryStrategy: 'hud_event',
  },
  sports: {
    id: 'sports',
    label: '赛事',
    subtitleFocus: 'scoreboard',
    suggestedVisual: { width: 960, height: 540, density: 'high' },
    taskRoi: 'scoreboard_replay',
    sceneSensitivity: 0.75,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'action_not_commentary',
  },
  news_documentary: {
    id: 'news_documentary',
    label: '新闻/纪录片',
    subtitleFocus: 'lower_third',
    suggestedVisual: { width: 960, height: 540, density: 'medium' },
    taskRoi: 'nameplate_broll',
    sceneSensitivity: 0.5,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: true, asr: 'fallback' },
    queryStrategy: 'attribution',
  },
  product_review: {
    id: 'product_review',
    label: '评测/开箱',
    subtitleFocus: 'specs',
    suggestedVisual: { width: 960, height: 540, density: 'medium' },
    taskRoi: 'product_closeup',
    sceneSensitivity: 0.5,
    suggestEndFrame: true,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'product_detail',
  },
  vlog: {
    id: 'vlog',
    label: '旅行/生活',
    subtitleFocus: 'place_activity',
    suggestedVisual: { width: 800, height: 450, density: 'medium' },
    taskRoi: 'place_people',
    sceneSensitivity: 0.55,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'place_activity',
  },
  music_stage: {
    id: 'music_stage',
    label: '音乐/演唱会',
    subtitleFocus: 'lyrics',
    suggestedVisual: { width: 960, height: 540, density: 'medium' },
    taskRoi: 'stage_performer',
    sceneSensitivity: 0.65,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'performance_section',
  },
  surveillance_timelapse: {
    id: 'surveillance_timelapse',
    label: '监控/延时',
    subtitleFocus: 'none',
    suggestedVisual: { width: 800, height: 450, density: 'motion' },
    taskRoi: 'motion_hotspots',
    sceneSensitivity: 0.8,
    suggestEndFrame: false,
    suggestAudio: { speechActivity: false, asr: 'off' },
    queryStrategy: 'motion_state',
    skipSubtitleAssumption: true,
  },
});

export function getProfile(id) {
  return PROFILE_LIBRARY[id] || PROFILE_LIBRARY.general;
}

export function listProfiles() {
  return PROFILE_IDS.map((id) => ({ id, ...PROFILE_LIBRARY[id] }));
}

/**
 * 合并 primary + secondary（secondary 只作局部补充，不覆盖用户显式值）。
 */
export function resolveProfileHints(analysisProfile = { primary: 'general', secondary: [] }) {
  const primary = getProfile(analysisProfile.primary || 'general');
  const secondary = (analysisProfile.secondary || []).map(getProfile);
  return {
    primary,
    secondary,
    suggestEndFrame: primary.suggestEndFrame
      || secondary.some((s) => s.suggestEndFrame),
    skipSubtitleAssumption: Boolean(primary.skipSubtitleAssumption),
    suggestedVisual: { ...primary.suggestedVisual },
    taskRoi: primary.taskRoi || secondary.find((s) => s.taskRoi)?.taskRoi || null,
  };
}

export function validateProfileId(id) {
  return PROFILE_IDS.includes(id);
}
