/**
 * query-router.js — 确定性、可解释的查询类型路由。不调用模型。
 */

const VISUAL_RE = /(画面|屏幕|界面|颜色|外观|长什么样|按钮|图标|软件|看[到见]|图[里上]|视觉|镜头|字幕条|弹幕位置|脸|穿着|穿什么)/i;
const TIME_RE = /(什么时候|何时|哪[一段个]|第几[分秒章节]|开头|结尾|首次|第一次|前后|时间戳|\d+:\d+|\d+\s*(分|秒|分钟))/i;
const TEXT_RE = /(讲了什么|说了什么|总结|摘要|主题|章节|内容|大纲|讲了|介绍了|讲到|提到)/i;
const DEEP_RE = /(深度分析|详细分析|论证|比较|对比|复核|审计|仔细核查|逐条)/i;
const MULTI_RE = /(一边|同时|音画|口型|谁在说|说话的人|音色|配音|矛盾|一边说一边)/i;

const MODES = new Set(['auto', 'text', 'time', 'visual', 'multimodal', 'deep']);

export function routeQuery({ question = '', mode = 'auto' } = {}) {
  const q = String(question || '').trim();
  const m = String(mode || 'auto').toLowerCase();
  const reasons = [];

  if (m !== 'auto' && MODES.has(m)) {
    const map = {
      text: 'text_structure',
      time: 'time_locator',
      visual: 'visual',
      multimodal: 'multimodal',
      deep: 'deep',
    };
    reasons.push(`explicit_mode:${m}`);
    return { queryType: map[m], mode: m, reasons, question: q };
  }

  if (DEEP_RE.test(q)) {
    reasons.push('contains_deep_terms');
    return { queryType: 'deep', mode: 'auto', reasons, question: q };
  }
  if (MULTI_RE.test(q)) {
    reasons.push('contains_multimodal_terms');
    return { queryType: 'multimodal', mode: 'auto', reasons, question: q };
  }
  if (VISUAL_RE.test(q)) {
    reasons.push('contains_visual_terms');
    return { queryType: 'visual', mode: 'auto', reasons, question: q };
  }
  // 时间词不自动意味着视觉
  if (TIME_RE.test(q)) {
    reasons.push('explicit_timestamp');
    return { queryType: 'time_locator', mode: 'auto', reasons, question: q };
  }
  if (TEXT_RE.test(q) || q.length > 0) {
    if (TEXT_RE.test(q)) reasons.push('contains_structure_terms');
    else reasons.push('default_text_structure');
    return { queryType: 'text_structure', mode: 'auto', reasons, question: q };
  }
  reasons.push('empty_question');
  return { queryType: 'text_structure', mode: 'auto', reasons, question: q };
}
