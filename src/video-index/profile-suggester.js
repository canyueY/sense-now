/**
 * profile-suggester.js — 只产出 recommendations，不改变 effective policy。
 */

import { PROFILE_LIBRARY } from './profile-policy.js';

function estimateCost(profileId) {
  const p = PROFILE_LIBRARY[profileId] || PROFILE_LIBRARY.general;
  const density = p.suggestedVisual?.density || 'low';
  const extraFrames = density === 'high' ? 48 : density === 'medium' ? 24 : 8;
  const extraAudioSeconds = p.suggestAudio?.asr && p.suggestAudio.asr !== 'off' ? 60 : 0;
  return { extraFrames, extraAudioSeconds };
}

/**
 * 基于轻量 coverage/catalog 提示生成建议（启发式，可注入）。
 */
export function suggestProfiles({
  coverage = null,
  catalog = null,
  enabled = true,
  evidenceIds = [],
} = {}) {
  if (!enabled) return { recommendations: [] };
  const recommendations = [];
  const tags = new Set();
  const chunks = Array.isArray(catalog?.chunks) ? catalog.chunks
    : (Array.isArray(catalog) ? catalog : []);
  for (const c of chunks) {
    for (const t of c.topicTags || []) tags.add(String(t).toLowerCase());
    for (const t of c.profileHints || []) tags.add(String(t).toLowerCase());
  }
  const gapCount = Number(coverage?.gapCount) || 0;
  const textRatio = Number(coverage?.coverageRatio);
  const blob = [...tags].join(' ');

  const push = (code, suggestedValue, title, reason, severity = 'info') => {
    recommendations.push({
      code,
      severity,
      title,
      reason,
      suggestedAction: 'select_profile',
      suggestedValue,
      estimatedCost: estimateCost(suggestedValue),
      requiresUserApproval: true,
      evidenceIds: evidenceIds.slice(0, 8),
    });
  };

  if (/ui|软件|教程|截图|界面/.test(blob)) {
    push('PROFILE_SUGGESTION', 'screen_tutorial', '可能是软件教程', '画面文字密度高且界面变化集中');
  } else if (/ppt|课件|讲座|公式/.test(blob)) {
    push('PROFILE_SUGGESTION', 'slides_lecture', '可能是课程/PPT', '检测到幻灯片/讲解类标签');
  } else if (/访谈|播客|嘉宾/.test(blob)) {
    push('PROFILE_SUGGESTION', 'interview', '可能是访谈', '多说话人/访谈类标签');
  } else if (/游戏|通关|boss/.test(blob)) {
    push('PROFILE_SUGGESTION', 'gameplay', '可能是游戏实况', '游戏/HUD 相关标签');
  } else if (/开箱|评测|上手/.test(blob)) {
    push('PROFILE_SUGGESTION', 'product_review', '可能是产品评测', '开箱/评测相关标签');
  } else if (coverage?.skipSubtitleAssumption) {
    push('PROFILE_SUGGESTION', 'surveillance_timelapse', '可能是监控/延时', '字幕假设被跳过');
  }

  if (gapCount >= 3 && Number.isFinite(textRatio) && textRatio < 0.5) {
    recommendations.push({
      code: 'SUBTITLE_GAP',
      severity: 'warn',
      title: '字幕覆盖偏低',
      reason: `检测到 ${gapCount} 处缺口，覆盖率约 ${Math.round(textRatio * 100)}%`,
      suggestedAction: 'retry_subtitle_scan',
      suggestedValue: { retryScanFps: 3 },
      estimatedCost: { extraFrames: 0, extraAudioSeconds: 0, extraOcrCandidates: gapCount * 6 },
      requiresUserApproval: true,
      evidenceIds: evidenceIds.slice(0, 8),
    });
  }

  return { recommendations: recommendations.slice(0, 6) };
}
