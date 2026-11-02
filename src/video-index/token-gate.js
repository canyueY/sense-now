/**
 * token-gate.js — 检索 / 文本 / 视觉硬预算。估算必须标 estimated:true。
 */

import { DEFAULT_BUDGET, mergeBudget } from './schema.js';

/** 保守字符→token 估算（无真实 tokenizer 时）。绝不伪装成 measured。 */
export function estimateTextTokens(text) {
  const s = String(text ?? '');
  // CJK 偏多时按 ~1.5 字/token，英文偏 ~4 字/token；取更保守的上限
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const other = Math.max(0, s.length - cjk);
  return Math.ceil(cjk / 1.5 + other / 3.5);
}

/** 视觉：按像素粗估（无模型计量时）。 */
export function estimateVisualTokens({ width = 0, height = 0, images = 1 } = {}) {
  const pixels = Math.max(0, width) * Math.max(0, height) * Math.max(1, images);
  // DeepSeek-V4 patch 网格粗估：约 1650 px ≈ 1 token 偏低；用 1200 更保守
  return Math.ceil(pixels / 1200) || 0;
}

export function createTokenGate({ budget = {}, tokenizer = null } = {}) {
  const limits = mergeBudget(budget);

  function measureText(text) {
    if (tokenizer && typeof tokenizer.count === 'function') {
      return { tokens: tokenizer.count(text), estimated: false };
    }
    return { tokens: estimateTextTokens(text), estimated: true };
  }

  function measureVisual(units = []) {
    let tokens = 0;
    let estimated = true;
    for (const u of units) {
      const w = u?.storedSize?.width ?? u?.width ?? 800;
      const h = u?.storedSize?.height ?? u?.height ?? 450;
      tokens += estimateVisualTokens({ width: w, height: h, images: 1 });
    }
    return { tokens, estimated };
  }

  /**
   * 在构造附件前执行。返回裁剪后的上下文与预算报告。
   */
  function enforce({
    chapters = [],
    events = [],
    utterances = [],
    storyboardUnits = [],
    singleFrames = [],
    zoomRequests = 0,
    criticalEvidenceIds = [],
    textBlob = '',
  } = {}) {
    const omittedEvidenceIds = [];
    const critical = new Set(criticalEvidenceIds);

    const keptChapters = chapters.slice(0, limits.maxChapters);
    for (const c of chapters.slice(limits.maxChapters)) {
      for (const id of c.evidenceIds || []) {
        if (!critical.has(id)) omittedEvidenceIds.push(id);
      }
    }

    // 事件：优先保留 critical
    const critEvents = events.filter((e) => (e.evidenceIds || []).some((id) => critical.has(id)));
    const restEvents = events.filter((e) => !critEvents.includes(e));
    const keptEvents = [...critEvents, ...restEvents].slice(0, limits.maxEvents);
    for (const e of events) {
      if (!keptEvents.includes(e)) {
        for (const id of e.evidenceIds || []) {
          if (critical.has(id)) {
            // 关键证据不得静默截断 —— 仍强制保留
            if (!keptEvents.includes(e)) keptEvents.push(e);
          } else {
            omittedEvidenceIds.push(id);
          }
        }
      }
    }
    // 若强制保留后超限，标记 truncated 但不丢 critical
    const finalEvents = keptEvents.slice(0, Math.max(limits.maxEvents, critEvents.length));

    const keptUtterances = utterances.slice(0, limits.maxUtterances);
    for (const u of utterances.slice(limits.maxUtterances)) {
      for (const id of [u.evidenceId, ...(u.evidenceIds || [])].filter(Boolean)) {
        if (!critical.has(id)) omittedEvidenceIds.push(id);
      }
    }

    const keptStory = storyboardUnits.slice(0, limits.maxStoryboardUnits);
    const keptFrames = singleFrames.slice(0, limits.maxSingleFrames);
    const zoomUsed = Math.min(zoomRequests, limits.maxZoomRequests);
    const zoomTruncated = zoomRequests > limits.maxZoomRequests;

    const textParts = [
      textBlob,
      ...keptChapters.map((c) => `${c.title || ''} ${c.summary || ''}`),
      ...keptUtterances.map((u) => u.text || ''),
      ...finalEvents.map((e) => e.summary || e.text || ''),
    ].join('\n');
    const textM = measureText(textParts);
    let textTruncated = false;
    let finalText = textParts;
    if (textM.tokens > limits.maxTextTokens) {
      textTruncated = true;
      // 粗裁：按比例切字符
      const ratio = limits.maxTextTokens / Math.max(1, textM.tokens);
      finalText = textParts.slice(0, Math.floor(textParts.length * ratio));
    }

    const visM = measureVisual([...keptStory, ...keptFrames]);
    let visualTruncated = false;
    let finalStory = keptStory;
    let finalFrames = keptFrames;
    if (visM.tokens > limits.maxVisualTokens) {
      visualTruncated = true;
      // 优先保 critical 关联的 storyboard
      const critStory = keptStory.filter((s) => (s.evidenceIds || []).some((id) => critical.has(id)));
      finalStory = critStory.length ? critStory.slice(0, limits.maxStoryboardUnits) : keptStory.slice(0, 1);
      finalFrames = [];
      for (const s of keptStory) {
        if (!finalStory.includes(s)) {
          for (const id of s.evidenceIds || []) omittedEvidenceIds.push(id);
        }
      }
    }

    // 若删减后没有足够关键证据
    const hasCritical = [...finalEvents, ...keptUtterances, ...finalStory]
      .some((x) => (x.evidenceIds || [x.evidenceId]).some((id) => critical.has(id)));
    const decision = (critical.size > 0 && !hasCritical && (textTruncated || visualTruncated))
      ? 'insufficient'
      : 'ok';

    const truncated = textTruncated || visualTruncated || zoomTruncated
      || chapters.length > keptChapters.length
      || events.length > finalEvents.length
      || utterances.length > keptUtterances.length
      || storyboardUnits.length > finalStory.length;

    const textUsed = measureText(finalText);
    const visUsed = measureVisual([...finalStory, ...finalFrames]);

    return {
      decision,
      chapters: keptChapters,
      events: finalEvents,
      utterances: keptUtterances,
      storyboardUnits: finalStory,
      singleFrames: finalFrames,
      zoomAllowed: zoomUsed,
      text: finalText,
      budget: {
        requested: { ...limits },
        used: {
          chapters: keptChapters.length,
          events: finalEvents.length,
          utterances: keptUtterances.length,
          textTokens: textUsed.tokens,
          storyboardUnits: finalStory.length,
          singleFrames: finalFrames.length,
          zoomRequests: zoomUsed,
          visualTokens: visUsed.tokens,
        },
        estimated: textUsed.estimated || visUsed.estimated,
        truncated,
        omittedEvidenceIds: [...new Set(omittedEvidenceIds)],
      },
    };
  }

  return { limits, measureText, measureVisual, enforce, DEFAULT_BUDGET };
}

export { DEFAULT_BUDGET, mergeBudget };
