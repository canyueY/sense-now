import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeVisualNeed } from '../src/video-index/visual-need-router.js';

test('文本问题不需要视觉', () => {
  const r = routeVisualNeed({
    queryType: 'text_structure',
    storyboardUnits: [{ frameId: 'F1', selectionReasons: ['scene_change'] }],
    question: '讲了什么',
  });
  assert.equal(r.needVisual, false);
  assert.equal(r.zoom, false);
});

test('视觉问题优先 Storyboard，不足才 zoom', () => {
  const hit = routeVisualNeed({
    queryType: 'visual',
    storyboardUnits: [{ frameId: 'F1', selectionReasons: ['scene_change'], evidenceIds: ['e1'] }],
    question: '画面',
  });
  assert.equal(hit.needVisual, true);
  assert.equal(hit.useStoryboard, true);
  assert.equal(hit.zoom, false);

  const miss = routeVisualNeed({
    queryType: 'visual',
    storyboardUnits: [],
    question: '画面里是什么',
    maxZoomRequests: 2,
  });
  assert.equal(miss.zoom, true);
  assert.ok(miss.zoomRequests <= 2);
});
