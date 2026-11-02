/**
 * video-index-tool.js — 独立 `video_index` 工具（与 sense_now 职责分离）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { createVideoIndexEngine } from './video-index/video-index-engine.js';
import { videoIndexRoot } from './video-index/paths.js';
import {
  buildMinimalIndexPackage,
  buildFullEvidencePackage,
  buildMnemosyneCandidate,
  applyFullEvidenceBudget,
  sanitizeEvidenceIds,
} from './video-index/evidence-package.js';
import { TOOL_TIMEOUT_MS } from './tool-spec.js';

export function videoIndexToolSpec() {
  return {
    name: 'video_index',
    description:
      'Offline multimodal video index: build a reusable local index once, then answer questions '
      + 'by retrieving text first and visual evidence on demand.\n\n'
      + 'Actions:\n'
      + '- `index` — index a local file (`path`) or Bilibili URL (`url`). Same source reuses ready index unless `rebuild:true`.\n'
      + '- `query` — retrieve evidence for a question (does NOT invent the final answer).\n'
      + '- `evidence` — fetch controlled evidence refs by id / time range.\n'
      + '- `zoom` — request a local zoom frame for an indexed time range (budget-limited).\n'
      + '- `status` / `list` / `remove` — inspect or delete one videoKey.\n'
      + '- `job_status` / `job_cancel` / `job_resume` — background long-video jobs.\n'
      + '- `capture_start` / `capture_stop` — explicit Windows capture MVP (system mix when URL unavailable).\n'
      + '- `refine` — URL refine or confirm second-pass (confirmation.planHash); ask mode never writes without match.\n'
      + '- `execute_refinement` — confirm and run a query-emitted on_demand ASR plan (planHash + confirmation:true). '
      + 'Does not invent ASR when asr.mode=off; idempotent for the same planHash.\n'
      + '- `cleanup` — purge temp files and expired query cache; optional maxAgeMs to drop old indexes; '
      + 'optional purgeTrash (requires confirmDelete) to remove .__trash-* recovery copies when live index is valid.\n\n'
      + 'This is separate from live `sense_now` watching. Indexing does not wake the model. '
      + 'Long videos use execution:auto|background and return jobId immediately. '
      + 'Text questions return citations without images; visual questions prefer existing storyboard frames. '
      + 'When query returns refinement.planHash, call execute_refinement with that hash — never invent internal engine APIs.',
    parameters: {
      action: {
        type: 'string',
        description: 'index | query | evidence | zoom | status | list | remove | cleanup | job_status | job_cancel | job_resume | capture_start | capture_stop | refine | execute_refinement',
      },
      planHash: {
        type: 'string',
        description: 'With execute_refinement / refine confirmation: exact planHash from query.refinement or audit plan',
      },
      execution: {
        type: 'string',
        description: 'With index: auto | sync | background (auto returns jobId when duration likely exceeds tool timeout)',
      },
      durationMs: {
        type: 'integer',
        description: 'With index background: known/estimated duration in ms (required for planning when not in metadata)',
      },
      jobId: { type: 'string', description: 'Background job id' },
      region: {
        type: 'json',
        description: 'With capture_start: manual {x,y,width,height} screen region',
      },
      cdpEndpoint: {
        type: 'string',
        description: 'With capture_start: http://127.0.0.1:<port> only (independent Chrome profile recommended)',
      },
      source: {
        type: 'string',
        description: 'file | bilibili (for index)',
      },
      path: { type: 'string', description: 'Local video path (source:file)' },
      url: { type: 'string', description: 'Bilibili URL (source:bilibili)' },
      partId: { type: 'string', description: 'Bilibili part id, default p1' },
      subtitlePath: {
        type: 'string',
        description: 'Optional local .srt / .vtt sidecar for index',
      },
      cacheMedia: {
        type: 'boolean',
        description: 'With Bilibili: download media into index cache so Storyboard/ASR can run (explicit opt-in)',
      },
      videoKey: { type: 'string', description: 'Index key returned by index/list' },
      question: { type: 'string', description: 'User question for query' },
      mode: {
        type: 'string',
        description: 'auto | text | time | visual | multimodal | deep',
      },
      profile: {
        type: 'string',
        description: 'auto | tutorial | interview | game | anime | vtuber | documentary | music',
      },
      capabilities: {
        type: 'json',
        description: 'With index: adapter capability switches such as { asr:"on", diarization:"on", identityBinding:"on" }. Legacy asr off|auto|on maps to analysisPolicy.asr.mode when analysisPolicy is also set.',
      },
      analysisPolicy: {
        type: 'json',
        description:
          'Subtitle-first long-video policy. Omit to keep legacy index behavior. '
          + 'Includes subtitleFirst, speechActivityAssist, asr.mode (off|on_demand|fallback|full), '
          + 'analysisProfile, profileSuggestion, secondPass, postAnalysisAudit, captureUtteranceEndFrame, budgets. '
          + 'Suggestions never auto-apply; HF_TOKEN alone never enables ASR/VAD.',
      },
      confirmation: {
        type: 'json',
        description: 'With refine / execute_refinement: true or { planHash } to confirm (exact hash match required).',
      },
      retryPlan: {
        type: 'json',
        description: 'With refine: optional retry plan body paired with confirmation.planHash.',
      },
      identityObservations: {
        type: 'array',
        description: 'With index: optional face/speaker observations used by identity binding',
      },
      budget: { type: 'json', description: 'Optional budget overrides' },
      evidenceIds: { type: 'array', description: 'Evidence ids for evidence/full package' },
      startMs: { type: 'integer', description: 'Range start' },
      endMs: { type: 'integer', description: 'Range end' },
      roi: { type: 'json', description: 'Optional ROI in original coordinates' },
      rebuild: { type: 'boolean', description: 'Force rebuild index' },
      package: {
        type: 'string',
        description: 'With evidence: minimal | full (default minimal refs via evidence action)',
      },
      mnemosyneClaim: {
        type: 'string',
        description: 'If set with userConfirmed, build Mnemosyne candidate only (not saved)',
      },
      userConfirmed: { type: 'boolean', description: 'Required for Mnemosyne candidate' },
      ttlMs: { type: 'integer', description: 'With cleanup: query-cache TTL (default 7d)' },
      maxAgeMs: {
        type: 'integer',
        description: 'With cleanup: remove indexes older than this (explicit; default none)',
      },
      dryRun: { type: 'boolean', description: 'With cleanup: report only, do not delete' },
      confirmDelete: {
        type: 'boolean',
        description: 'With cleanup+maxAgeMs: required to actually delete aged indexes',
      },
      confirmVideoKeys: {
        type: 'array',
        description: 'With cleanup+maxAgeMs: exact videoKeys allowed to delete (must match candidates)',
      },
      purgeTrash: {
        type: 'boolean',
        description: 'With cleanup: preview/remove .__trash-* recovery dirs (default false; needs confirmDelete to delete)',
      },
      trashMaxAgeMs: {
        type: 'integer',
        description: 'With cleanup+purgeTrash: only trash older than this age (ms)',
      },
      includeIdentity: {
        type: 'boolean',
        description: 'With evidence package:full — include identity tracks only when true',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          images: { type: 'array', items: { type: 'json' } },
          meta: { type: 'json' },
        },
      },
      render(args, value) {
        return [
          ...(value.images ?? []).map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe() { return false; },
  };
}

function toLosslessJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toLosslessJson);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue; // 省略 undefined，避免宿主看到 images:null
    out[k] = toLosslessJson(v);
  }
  return out;
}

/** 无图时省略 images 字段（不要 undefined→null）。 */
function toolResult({ text, meta, images = null }) {
  const out = { text, meta };
  if (Array.isArray(images) && images.length) out.images = images;
  return out;
}

function serviceOf(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch { /* ignore */ }
  try { return ctx?.[key] ?? null; } catch { return null; }
}

/**
 * 创建工具执行器。rootDir 可注入（测试必须注入临时目录）。
 */
export function createVideoIndexTool({
  ctx = null,
  rootDir = null,
  engine = null,
  ffmpegPath = process.env.DSH_FFMPEG_PATH || 'ffmpeg',
  log = () => {},
  adapters = {},
} = {}) {
  const resolvedRoot = rootDir || videoIndexRoot();
  const eng = engine || createVideoIndexEngine({
    rootDir: resolvedRoot,
    ffmpegPath,
    adapters,
    log,
  });

  async function loadPngForUnit(videoKey, unit) {
    const indexData = eng.store.loadIndex(videoKey);
    const ev = (indexData.evidenceIndex || []).find((e) => (unit.evidenceIds || []).includes(e.evidenceId));
    if (!ev?.sourceFile) return null;
    const file = eng.store.resolveEvidenceFile(videoKey, ev.sourceFile);
    if (!existsSync(file)) return null;
    return readFileSync(file);
  }

  const toolObj = {
    ...videoIndexToolSpec(),
    async execute(args = {}, run = {}) {
      return toLosslessJson(await toolObj.route(args, run));
    },
    async route(args = {}, run = {}) {
      const action = String(args.action || '').toLowerCase();
      const signal = run?.signal ?? null;

      if (action === 'index') {
        const kind = String(args.source || (args.url ? 'bilibili' : 'file')).toLowerCase();
        const source = kind === 'bilibili'
          ? { kind: 'bilibili', url: args.url, partId: args.partId || 'p1' }
          : { kind: 'file', path: args.path };
        const execution = String(args.execution || 'auto').toLowerCase();
        const durationMs = Number(args.durationMs);
        const caps = args.capabilities && typeof args.capabilities === 'object'
          ? args.capabilities
          : {};
        try {
          const r = await eng.indexAdaptive({
            source,
            execution,
            durationMs: Number.isFinite(durationMs) ? durationMs : null,
            capabilities: caps,
            videoKey: args.videoKey || null,
            mediaPath: kind === 'file' ? args.path : null,
            signal,
            speakerMerge: caps.speakerMerge || null,
            analysisPolicy: args.analysisPolicy !== undefined ? args.analysisPolicy : undefined,
            indexOptions: {
              profile: args.profile || 'auto',
              rebuild: args.rebuild === true,
              skipStoryboard: args.skipStoryboard === true,
              subtitlePath: args.subtitlePath || null,
              cacheMedia: args.cacheMedia === true,
              identityObservations: Array.isArray(args.identityObservations)
                ? args.identityObservations
                : [],
              analysisPolicy: args.analysisPolicy !== undefined ? args.analysisPolicy : undefined,
            },
          });
          if (r.background) {
            return {
              text: `已提交后台索引 job ${r.jobId}（videoKey=${r.videoKey || 'pending'}, durationMs=${r.durationMs}）。`
                + '用 job_status 查询进度；工具取消不会杀掉该 job，除非 job_cancel。',
              meta: toLosslessJson(sanitizeJobMeta(r)),
            };
          }
          const tips = [];
          if (kind === 'bilibili' && args.cacheMedia !== true && r.manifest?.capabilities?.storyboard === 'unavailable') {
            tips.push('Bilibili Storyboard 需要显式 cacheMedia:true（会经 yt-dlp 缓存媒体）。');
          }
          return {
            text: (r.reused
              ? `已复用索引 ${r.videoKey}（status=${r.manifest?.status}）。`
              : `已建立索引 ${r.videoKey}（status=${r.manifest?.status || r.state}）。后续 query 不会重新解码整部视频。`)
              + (tips.length ? `\n${tips.join('\n')}` : ''),
            meta: toLosslessJson(sanitizeJobMeta(r)),
          };
        } catch (e) {
          return {
            text: `索引失败：${e.message}${e.hint ? `（${e.hint}）` : ''}`,
            meta: {
              ok: false,
              reason: e.code || 'index_failed',
              error: String(e.message),
            },
          };
        }
      }

      if (action === 'query') {
        const videoKey = args.videoKey;
        if (!videoKey) {
          return { text: '需要 videoKey。先 index 或 list。', meta: { ok: false, reason: 'missing_videoKey' } };
        }
        const r = eng.query({
          videoKey,
          question: args.question || '',
          mode: args.mode || 'auto',
          budget: args.budget || {},
          signal,
        });
        const images = [];
        if (r.visualEvidence?.length && ctx) {
          const svc = serviceOf(ctx, 'attachments');
          if (svc?.saveImage) {
            for (const u of r.visualEvidence.slice(0, 4)) {
              try {
                const png = await loadPngForUnit(videoKey, u);
                if (!png) continue;
                const ref = await svc.saveImage.call(svc, {
                  data: png,
                  mediaType: 'image/png',
                  name: `video-index-${u.frameId}.png`,
                });
                images.push(ref);
              } catch { /* 单张失败不阻断 */ }
            }
          }
        }
        const lines = [
          `queryType=${r.queryType} decision=${r.decision}`,
          `reasons: ${(r.reasons || []).join(', ')}`,
          `chapters=${r.context?.chapters?.length || 0} events=${r.context?.events?.length || 0} utterances=${r.context?.utterances?.length || 0}`,
          `visual=${r.visualEvidence?.length || 0} cacheHit=${r.cache?.hit ? 'yes' : 'no'}`,
          r.budget?.truncated ? `truncated=true omitted=${(r.budget.omittedEvidenceIds || []).length}` : 'truncated=false',
          '（索引层只返回证据与引用，请据此回答用户，不要把摘要当成唯一事实。）',
        ];
        return toolResult({
          text: lines.join('\n'),
          images,
          meta: toLosslessJson(r),
        });
      }

      if (action === 'evidence') {
        const videoKey = args.videoKey;
        if (!videoKey) {
          return { text: '需要 videoKey。', meta: { ok: false, reason: 'missing_videoKey' } };
        }
        if (args.package === 'full') {
          const hasRange = Number.isFinite(Number(args.startMs)) && Number.isFinite(Number(args.endMs));
          const rawIds = Array.isArray(args.evidenceIds) ? args.evidenceIds : null;
          const idSan = sanitizeEvidenceIds(rawIds);
          const hasIds = idSan.ids && idSan.ids.length > 0;
          const requestedIds = rawIds != null;
          if (!hasRange && !requestedIds) {
            return {
              text: 'full package 必须提供 startMs+endMs，或非空 evidenceIds（禁止无范围展开整片）。',
              meta: { ok: false, reason: 'scope_required' },
            };
          }
          if (requestedIds && !hasIds) {
            return {
              text: 'evidenceIds 全部无效或超限被丢弃；请提供合法 id 或时间范围。',
              meta: { ok: false, reason: 'evidenceIds_invalid', evidenceIdsSanitized: true },
            };
          }
          const indexData = eng.store.loadIndex(videoKey);
          let pack = buildFullEvidencePackage(indexData, {
            startMs: hasRange ? Number(args.startMs) : 0,
            endMs: hasRange ? Number(args.endMs) : Number.POSITIVE_INFINITY,
            evidenceIds: requestedIds ? rawIds : null,
            includeIdentity: args.includeIdentity === true,
          });
          pack = applyFullEvidenceBudget(pack, args.budget || {});
          return {
            text: `Full evidence package for ${videoKey}（scoped${pack.budget?.truncated ? ', truncated' : ''}）。`,
            meta: toLosslessJson(pack),
          };
        }
        if (args.package === 'minimal') {
          const indexData = eng.store.loadIndex(videoKey);
          return {
            text: `Minimal index package for ${videoKey}。`,
            meta: toLosslessJson(buildMinimalIndexPackage(indexData)),
          };
        }
        if (args.mnemosyneClaim) {
          const cand = buildMnemosyneCandidate({
            videoKey,
            selectedClaim: args.mnemosyneClaim,
            evidenceIds: args.evidenceIds || [],
            userConfirmed: args.userConfirmed === true,
            indexVersion: eng.store.readManifest(videoKey, { optional: true })?.indexVersion,
            timeRange: { startMs: args.startMs ?? null, endMs: args.endMs ?? null },
          });
          return {
            text: cand.saved ? '已保存' : (cand.ok ? '已生成 Mnemosyne 候选包（未保存）。' : `无法生成：${cand.reason}`),
            meta: toLosslessJson(cand),
          };
        }
        const r = eng.getEvidence({
          videoKey,
          evidenceIds: args.evidenceIds || [],
          startMs: args.startMs,
          endMs: args.endMs,
        });
        return {
          text: r.ok ? `evidence × ${r.evidence.length}` : `evidence 失败：${r.reason}`,
          meta: toLosslessJson(r),
        };
      }

      if (action === 'zoom') {
        const r = await eng.zoom({
          videoKey: args.videoKey,
          startMs: Number(args.startMs) || 0,
          endMs: Number(args.endMs) || Number(args.startMs) || 0,
          roi: args.roi || null,
          budget: args.budget || {},
          signal,
        });
        const images = [];
        if (r.ok && r.units?.length && ctx) {
          for (const u of r.units) {
            try {
              const png = await loadPngForUnit(args.videoKey, u);
              if (!png) continue;
              const svc = serviceOf(ctx, 'attachments');
              if (!svc?.saveImage) break;
              images.push(await svc.saveImage.call(svc, {
                data: png,
                mediaType: 'image/png',
                name: `video-index-zoom-${u.frameId}.png`,
              }));
            } catch { /* ignore */ }
          }
        }
        return toolResult({
          text: r.ok
            ? (r.reused ? '复用已有 Storyboard，未重新扫描整片。' : '已 zoom 并写入证据索引。')
            : `zoom 失败：${r.reason}`,
          images,
          meta: toLosslessJson(r),
        });
      }

      if (action === 'status') {
        const r = eng.status(args.videoKey);
        return {
          text: r.ok
            ? `${r.videoKey} status=${r.status}`
            : `未找到 ${args.videoKey}`,
          meta: toLosslessJson(r),
        };
      }

      if (action === 'list') {
        const items = eng.list();
        return {
          text: items.length
            ? items.map((i) => `${i.videoKey} (${i.status})`).join('\n')
            : '索引为空。',
          meta: { ok: true, items: toLosslessJson(items) },
        };
      }

      if (action === 'remove') {
        if (!args.videoKey) {
          return {
            text: 'remove 必须指定精确 videoKey，不会删除整个索引根目录。',
            meta: { ok: false, reason: 'missing_videoKey' },
          };
        }
        const r = eng.remove(args.videoKey);
        return {
          text: r.removed
            ? `已删除索引 ${r.videoKey}（不可恢复；原视频文件未删）。`
            : `没有可删的索引 ${r.videoKey}。`,
          meta: toLosslessJson(r),
        };
      }

      if (action === 'cleanup') {
        const maxAgeMs = Number(args.maxAgeMs) > 0 ? Number(args.maxAgeMs) : null;
        const trashMaxAgeMs = Number(args.trashMaxAgeMs) > 0 ? Number(args.trashMaxAgeMs) : null;
        const r = eng.cleanup({
          ttlMs: Number(args.ttlMs) > 0 ? Number(args.ttlMs) : undefined,
          maxAgeMs,
          dryRun: args.dryRun === true,
          confirmDelete: args.confirmDelete === true,
          confirmVideoKeys: Array.isArray(args.confirmVideoKeys) ? args.confirmVideoKeys : [],
          purgeTrash: args.purgeTrash === true,
          trashMaxAgeMs,
        });
        const lines = [
          `cleanup${r.dryRun ? '（dryRun）' : ''}：扫描 ${r.scanned}，`
          + `临时文件 ${r.tempFilesRemoved.length}，缓存修剪 ${r.cachesPruned.length}，`
          + `删除索引 ${r.indexesRemoved.length}，`
          + `trash 保留 ${(r.trashPreserved || []).length} / 将删 ${(r.trashWouldRemove || []).length} / 已删 ${(r.trashRemoved || []).length}。`,
        ];
        if (r.needsConfirmation) {
          if ((r.indexesWouldRemove || []).length) {
            lines.push(`待确认删除索引：${r.indexesWouldRemove.join(', ')}`);
            lines.push('要删索引请传 confirmDelete:true 且 confirmVideoKeys 精确匹配。');
          }
          if (args.purgeTrash === true && !(r.trashRemoved || []).length) {
            lines.push('要删 trash 请传 purgeTrash:true 与 confirmDelete:true（可选 trashMaxAgeMs）；仅当 live manifest 有效时删除。');
          }
        } else if (r.indexesRemoved.length) {
          lines.push(`已删索引：${r.indexesRemoved.join(', ')}（不可恢复；原媒体未动）`);
        }
        if ((r.trashRemoved || []).length) {
          lines.push(`已删 trash：${r.trashRemoved.length} 个`);
        }
        return { text: lines.join('\n'), meta: toLosslessJson(r) };
      }

      if (action === 'job_status') {
        const r = eng.jobStatus(args.jobId);
        return {
          text: r.ok
            ? `job ${args.jobId} state=${r.job?.state} stage=${r.job?.stage}`
            : `未找到 job ${args.jobId}`,
          meta: toLosslessJson(sanitizeJobMeta(r)),
        };
      }

      if (action === 'job_cancel') {
        const r = await eng.jobCancel(args.jobId);
        return {
          text: r.ok ? `已取消 job ${args.jobId}` : `取消失败：${r.reason}`,
          meta: toLosslessJson(sanitizeJobMeta(r)),
        };
      }

      if (action === 'job_resume') {
        const r = await eng.jobResume(args.jobId);
        return {
          text: r.ok
            ? (r.captureRestartRequired
              ? `capture 不能无缝续抓；已记录 gap，请 capture_start 新 session。`
              : `已恢复 job ${args.jobId}`)
            : `恢复失败：${r.reason}`,
          meta: toLosslessJson(sanitizeJobMeta(r)),
        };
      }

      if (action === 'capture_start') {
        try {
          const r = await eng.captureStart({
            url: args.url || null,
            region: args.region || null,
            cdpEndpoint: args.cdpEndpoint || null,
            videoKey: args.videoKey || null,
            sourceMode: args.sourceMode || null,
            capabilities: args.capabilities || {},
            speakerMerge: args.speakerMerge || null,
          });
          return {
            text: `已启动抓播 session ${r.sessionId}（job=${r.jobId}, sourceMode=${r.sourceMode}, audioScope=${r.audioScope}）。`
              + (r.audioScope === 'system_mix' ? ' 将录制系统混音；请显式确认。' : ' URL 为权威内容源；抓屏仅作画面锚点。'),
            meta: toLosslessJson(sanitizeJobMeta(r)),
          };
        } catch (e) {
          return {
            text: `抓播启动失败：${e.message}`,
            meta: { ok: false, reason: e.code || 'capture_failed', error: String(e.message) },
          };
        }
      }

      if (action === 'capture_stop') {
        const r = await eng.captureStop(args.jobId);
        return {
          text: r.ok
            ? `已停止抓播 job ${args.jobId}（gaps=${(r.gaps || []).length}）`
            : `停止失败：${r.reason}`,
          meta: toLosslessJson(sanitizeJobMeta(r)),
        };
      }

      if (action === 'refine') {
        const r = await eng.refine({
          videoKey: args.videoKey,
          url: args.url || null,
          partId: args.partId || 'p1',
          signal,
          analysisPolicy: args.analysisPolicy !== undefined ? args.analysisPolicy : undefined,
          confirmation: args.confirmation || null,
          retryPlan: args.retryPlan || null,
        });
        if (r.reportOnly) {
          return {
            text: `二次分析未执行（${r.reason}）。planHash=${r.planHash || 'n/a'}；确认时请回传精确 planHash。`,
            meta: toLosslessJson(r),
          };
        }
        if (r.executed) {
          return {
            text: `已按确认执行局部二次分析计划（planHash=${r.planHash}）。`,
            meta: toLosslessJson(r),
          };
        }
        return {
          text: r.ok
            ? `已提交 refine job ${r.jobId}（fingerprint=${r.contentFingerprint}）；旧 capture 证据保留 provenance。`
            : `refine 失败：${r.reason || r.detail}`,
          meta: toLosslessJson(sanitizeJobMeta(r)),
        };
      }

      if (action === 'execute_refinement') {
        const planHash = args.planHash
          || args.confirmation?.planHash
          || null;
        const confirmed = args.confirmation === true
          || args.confirmation?.planHash === planHash
          || args.confirmed === true;
        const r = await eng.executeRefinement({
          videoKey: args.videoKey,
          planHash,
          confirmation: confirmed,
          signal,
          analysisPolicy: args.analysisPolicy !== undefined ? args.analysisPolicy : undefined,
        });
        return {
          text: r.already_executed
            ? `refinement 已执行过（planHash=${planHash}），未重复 ASR。`
            : (r.ok
              ? `已执行 on_demand ASR refinement（planHash=${planHash}，revision ${r.beforeRevision}→${r.afterRevision}）。`
              : `execute_refinement 失败：${r.reason || r.detail}`),
          meta: toLosslessJson(r),
        };
      }

      return {
        text: `未知 action: ${action}（可用 index / query / evidence / zoom / status / list / remove / cleanup / job_* / capture_* / refine / execute_refinement）`,
        meta: { action },
      };
    },
    engine: eng,
  };

  return toolObj;
}

function sanitizeJobMeta(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const {
    // eslint-disable-next-line no-unused-vars
    sourceDescriptor, descriptor, streamUrl, cookie, cookies, token, audio, video, ...rest
  } = obj;
  const out = { ...rest };
  if (out.job && typeof out.job === 'object') {
    out.job = sanitizeJobMeta(out.job);
  }
  return out;
}
