/**
 * visual-need-router.js — 文本优先；视觉按需；先 Storyboard 再 zoom。
 */

function usableStoryboard(units = []) {
  return units.filter((u) => u?.imageRef || (u?.evidenceIds || []).length);
}

export function routeVisualNeed({
  queryType,
  storyboardUnits = [],
  question = '',
  maxZoomRequests = 2,
  existingSufficient = null,
  storyboardCapability = null,
} = {}) {
  const reasons = [];

  if (queryType === 'text_structure' || queryType === 'time_locator') {
    reasons.push('text_or_time_no_visual');
    return {
      needVisual: false,
      useStoryboard: false,
      zoom: false,
      selected: [],
      zoomRequests: 0,
      reasons,
    };
  }

  if (queryType !== 'visual' && queryType !== 'multimodal' && queryType !== 'deep') {
    reasons.push('query_type_no_visual');
    return {
      needVisual: false,
      useStoryboard: false,
      zoom: false,
      selected: [],
      zoomRequests: 0,
      reasons,
    };
  }

  reasons.push('visual_query');
  const rawUnits = storyboardUnits || [];
  const usable = usableStoryboard(rawUnits);
  if (rawUnits.length && !usable.length) reasons.push('storyboard_missing_images');
  if (storyboardCapability === 'skipped' && !usable.length) {
    reasons.push('storyboard_skipped');
    return {
      needVisual: true,
      useStoryboard: false,
      zoom: false,
      selected: [],
      zoomRequests: 0,
      reasons,
    };
  }
  const selected = pickRelevantStoryboard(usable, question);
  const sufficient = existingSufficient ?? selected.length > 0;

  if (sufficient) {
    reasons.push('storyboard_sufficient');
    return {
      needVisual: true,
      useStoryboard: true,
      zoom: false,
      selected,
      zoomRequests: 0,
      reasons,
    };
  }

  reasons.push('storyboard_insufficient_zoom');
  return {
    needVisual: true,
    useStoryboard: false,
    zoom: true,
    selected: [],
    zoomRequests: Math.min(1, maxZoomRequests),
    reasons,
  };
}

function pickRelevantStoryboard(units, question) {
  if (!units.length) return [];
  const q = String(question || '').toLowerCase();
  const scored = units.map((u) => {
    let score = 0;
    const blob = `${(u.selectionReasons || []).join(' ')} ${u.sceneId || ''}`.toLowerCase();
    for (const tok of tokenize(q)) {
      if (blob.includes(tok)) score += 2;
    }
    // 默认取靠前的关键帧
    score += 0.1;
    return { u, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 4).map((x) => x.u);
}

function tokenize(s) {
  return String(s)
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}
