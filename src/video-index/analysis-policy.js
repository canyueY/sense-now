/**
 * analysis-policy.js — 字幕优先长视频策略：规范化、硬顶、向后兼容映射。
 */

export const ASR_MODES = Object.freeze(['off', 'on_demand', 'fallback', 'full']);
export const PASS_MODES = Object.freeze(['off', 'ask', 'auto_once']);
export const PROFILE_IDS = Object.freeze([
  'general', 'visual_edit', 'handcraft', 'anime', 'film', 'screen_tutorial',
  'slides_lecture', 'interview', 'talking_head', 'gameplay', 'sports',
  'news_documentary', 'product_review', 'vlog', 'music_stage', 'surveillance_timelapse',
]);

const HARD = Object.freeze({
  scanFps: 4,
  retryScanFps: 4,
  maxOcrCandidatesPerMinute: 60,
  maxFramesScannedPerChunk: 400,
  maxOcrCallsPerMinute: 30,
  maxOcrCallsPerChunk: 120,
  maxTotalOcrCalls: 2000,
  maxOcrRuntimeMsPerChunk: 120_000,
  maxStoredSubtitleFrames: 64,
  fallbackRoiHeightRatio: 0.9,
  maxRefineWindows: 3,
  maxAudioSecondsPerWindow: 120,
  maxSecondPassCostRatio: 1,
  maxEndFramesPerChunk: 32,
  maxOverviewChunks: 24,
});

function finiteNum(v, fallback, { min = 0, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v, fallback, { min = 0, max = 1e6 } = {}) {
  return Math.round(finiteNum(v, fallback, { min, max }));
}

/**
 * 旧 capabilities.asr → 新 asr.mode（仅当调用方显式传值）。
 */
export function mapLegacyAsrCapability(asrCap) {
  if (asrCap == null) return null;
  const v = String(asrCap).trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'auto') return 'fallback';
  if (v === 'on') return 'full';
  return null;
}

export function defaultAnalysisPolicy() {
  return {
    subtitleFirst: {
      enabled: true,
      scanFps: 1,
      retryScanFps: 3,
      retryScanFpsHardMax: HARD.retryScanFps,
      roi: 'auto',
      fallbackRoiHeightRatio: 0.45,
      maxOcrCandidatesPerMinute: 12,
    },
    speechActivityAssist: {
      enabled: false,
      useVad: true,
      useSpeakerTiming: false,
    },
    asr: { mode: 'off' },
    analysisProfile: { primary: 'general', secondary: [] },
    profileSuggestion: { enabled: true },
    secondPass: { mode: 'off', maxPasses: 1 },
    postAnalysisAudit: { enabled: false, retryMode: 'ask', maxRetries: 1 },
    captureUtteranceEndFrame: { enabled: false, maxPerChunk: 12 },
    budgets: {
      maxRefineWindows: 2,
      maxRefineWindowsHardLimit: HARD.maxRefineWindows,
      maxAudioSecondsPerWindow: 30,
      maxSecondPassCostRatio: 0.5,
      maxOverviewChunks: 12,
      maxFramesScannedPerChunk: 300,
      maxOcrCallsPerMinute: 20,
      maxOcrCallsPerChunk: 90,
      maxTotalOcrCalls: HARD.maxTotalOcrCalls,
      maxOcrRuntimeMsPerChunk: 90_000,
      maxStoredSubtitleFrames: 32,
    },
  };
}

/**
 * @param {object|null} raw 工具层 analysisPolicy
 * @param {{ capabilities?: object, explicitPolicy?: boolean }} opts
 *   explicitPolicy=false 且 raw 为空 → 返回 null（保持旧行为）
 */
export function normalizeAnalysisPolicy(raw, {
  capabilities = null,
  explicitPolicy = null,
} = {}) {
  const isObject = raw != null && typeof raw === 'object' && !Array.isArray(raw);
  const hasRaw = isObject && Object.keys(raw).length > 0;
  // 显式传入对象（含 {}）→ 字幕优先默认；未传 / null → 旧行为
  const explicit = explicitPolicy != null ? Boolean(explicitPolicy) : isObject;
  if (!explicit) {
    return null;
  }

  const base = defaultAnalysisPolicy();
  const src = isObject ? raw : {};

  const sf = { ...base.subtitleFirst, ...(src.subtitleFirst || {}) };
  sf.enabled = sf.enabled !== false;
  sf.scanFps = clampInt(sf.scanFps, 1, { min: 0.1, max: HARD.scanFps });
  sf.retryScanFps = clampInt(sf.retryScanFps, 3, { min: 1, max: HARD.retryScanFps });
  sf.retryScanFpsHardMax = HARD.retryScanFps;
  sf.fallbackRoiHeightRatio = finiteNum(sf.fallbackRoiHeightRatio, 0.45, {
    min: 0.1, max: HARD.fallbackRoiHeightRatio,
  });
  sf.maxOcrCandidatesPerMinute = clampInt(sf.maxOcrCandidatesPerMinute, 12, {
    min: 1, max: HARD.maxOcrCandidatesPerMinute,
  });
  sf.roi = sf.roi === 'auto' || typeof sf.roi === 'object' ? sf.roi : 'auto';

  const saa = { ...base.speechActivityAssist, ...(src.speechActivityAssist || {}) };
  saa.enabled = Boolean(saa.enabled);
  saa.useVad = saa.useVad !== false;
  saa.useSpeakerTiming = Boolean(saa.useSpeakerTiming);

  let asrMode = base.asr.mode;
  if (src.asr?.mode != null) {
    const m = String(src.asr.mode).toLowerCase();
    if (!ASR_MODES.includes(m)) {
      const err = new Error(`invalid asr.mode: ${src.asr.mode}`);
      err.code = 'POLICY';
      throw err;
    }
    asrMode = m;
  } else if (capabilities && Object.prototype.hasOwnProperty.call(capabilities, 'asr')) {
    const mapped = mapLegacyAsrCapability(capabilities.asr);
    if (mapped) asrMode = mapped;
  }

  const ap = { ...base.analysisProfile, ...(src.analysisProfile || {}) };
  if (typeof src.analysisProfile === 'string') {
    ap.primary = src.analysisProfile;
    ap.secondary = [];
  }
  ap.primary = PROFILE_IDS.includes(ap.primary) ? ap.primary : 'general';
  ap.secondary = (Array.isArray(ap.secondary) ? ap.secondary : [])
    .filter((p) => PROFILE_IDS.includes(p) && p !== ap.primary)
    .slice(0, 3);

  const ps = { ...base.profileSuggestion, ...(src.profileSuggestion || {}) };
  ps.enabled = ps.enabled !== false;

  const sp = { ...base.secondPass, ...(src.secondPass || {}) };
  if (!PASS_MODES.includes(sp.mode)) {
    const err = new Error(`invalid secondPass.mode: ${sp.mode}`);
    err.code = 'POLICY';
    throw err;
  }
  sp.maxPasses = clampInt(sp.maxPasses, 1, { min: 0, max: 1 });

  const audit = { ...base.postAnalysisAudit, ...(src.postAnalysisAudit || {}) };
  audit.enabled = Boolean(audit.enabled);
  if (!PASS_MODES.includes(audit.retryMode)) {
    const err = new Error(`invalid postAnalysisAudit.retryMode: ${audit.retryMode}`);
    err.code = 'POLICY';
    throw err;
  }
  audit.maxRetries = clampInt(audit.maxRetries, 1, { min: 0, max: 1 });

  const endF = { ...base.captureUtteranceEndFrame, ...(src.captureUtteranceEndFrame || {}) };
  endF.enabled = Boolean(endF.enabled);
  endF.maxPerChunk = clampInt(endF.maxPerChunk ?? endF.maxPerChunk, 12, {
    min: 0, max: HARD.maxEndFramesPerChunk,
  });

  const budgets = { ...base.budgets, ...(src.budgets || {}) };
  budgets.maxRefineWindowsHardLimit = HARD.maxRefineWindows;
  budgets.maxRefineWindows = clampInt(budgets.maxRefineWindows, 2, {
    min: 0, max: HARD.maxRefineWindows,
  });
  budgets.maxAudioSecondsPerWindow = clampInt(budgets.maxAudioSecondsPerWindow, 30, {
    min: 1, max: HARD.maxAudioSecondsPerWindow,
  });
  budgets.maxSecondPassCostRatio = finiteNum(budgets.maxSecondPassCostRatio, 0.5, {
    min: 0, max: HARD.maxSecondPassCostRatio,
  });
  budgets.maxOverviewChunks = clampInt(budgets.maxOverviewChunks, 12, {
    min: 3, max: HARD.maxOverviewChunks,
  });
  budgets.maxFramesScannedPerChunk = clampInt(budgets.maxFramesScannedPerChunk, 300, {
    min: 1, max: HARD.maxFramesScannedPerChunk,
  });
  budgets.maxOcrCallsPerMinute = clampInt(budgets.maxOcrCallsPerMinute, 20, {
    min: 1, max: HARD.maxOcrCallsPerMinute,
  });
  budgets.maxOcrCallsPerChunk = clampInt(budgets.maxOcrCallsPerChunk, 90, {
    min: 1, max: HARD.maxOcrCallsPerChunk,
  });
  budgets.maxTotalOcrCalls = clampInt(budgets.maxTotalOcrCalls, HARD.maxTotalOcrCalls, {
    min: 1, max: HARD.maxTotalOcrCalls,
  });
  budgets.maxOcrRuntimeMsPerChunk = clampInt(budgets.maxOcrRuntimeMsPerChunk, 90_000, {
    min: 1000, max: HARD.maxOcrRuntimeMsPerChunk,
  });
  budgets.maxStoredSubtitleFrames = clampInt(budgets.maxStoredSubtitleFrames, 32, {
    min: 0, max: HARD.maxStoredSubtitleFrames,
  });

  return {
    subtitleFirst: sf,
    speechActivityAssist: saa,
    asr: { mode: asrMode },
    analysisProfile: ap,
    profileSuggestion: ps,
    secondPass: sp,
    postAnalysisAudit: audit,
    captureUtteranceEndFrame: endF,
    budgets,
    _meta: { explicit: true, hard: { ...HARD } },
  };
}

export function mayRunAsr(policy, { reason = 'index' } = {}) {
  if (!policy) {
    // 旧路径：由 capabilities.asr 自行决定
    return { ok: null, reason: 'legacy' };
  }
  const mode = policy.asr?.mode || 'off';
  if (mode === 'off') return { ok: false, reason: 'asr_off' };
  if (mode === 'full') return { ok: true, reason: 'full' };
  if (mode === 'fallback') {
    return { ok: reason === 'subtitle_gap' || reason === 'fallback', reason: mode };
  }
  if (mode === 'on_demand') {
    return { ok: reason === 'query' || reason === 'refine' || reason === 'on_demand', reason: mode };
  }
  return { ok: false, reason: 'unknown' };
}

export function mayRunVad(policy) {
  return Boolean(policy?.speechActivityAssist?.enabled && policy.speechActivityAssist.useVad);
}

export { HARD as POLICY_HARD_LIMITS };
