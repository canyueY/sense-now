# Cursor / Grok 修复任务书：query 文本通道、chunk storyboard 与时长/覆盖率

> 本任务书基于一次真实端到端跑通（2026-11-03，Windows，DSH desktop profile，v0.1.0）。
> 所有“现状”结论都有可复现的索引产物路径与观测值，不需要重新猜。
> 执行者请按 §3 的顺序做，一次只改一个 R 项，每项自带测试与验收。

**一句话摘要**：`video_index` 现在**能建索引、能查计数，但 Agent 拿不到台词、画面问题出不了图、
覆盖率把已索引的片子说成 poor、索引目录还留着构建标记**。四个修复点分别在
`src/video-index-tool.js`（文本通道）、`src/video-index/video-index-engine.js`（chunk 帧落盘、时长探测）、
`src/video-index/index-store.js`（发布清理）。全部可以用现有测试 harness 复现，不需要真实媒体。

## 1. 已验证基线

| 项 | 值 |
|---|---|
| 仓库 | `D:\HuaweiMoveData\Users\残月Y\Desktop\dsh-see-now-main`（`main`，HEAD `828c15f`） |
| Node / npm | v24.21.0 / 11.19.0 |
| ffmpeg / ffprobe | 在 PATH 上，`ffprobe -show_entries format=duration` 对测试视频返回 `450.966667` |
| DSH profile | `C:\Users\残月Y\.dsh\profiles\desktop`，已注册 `sense-now` |
| 索引根 | `C:\Users\残月Y\.dsh\sense-now\video-index\` |
| 测试基线 | `npm test` → **288 pass / 0 fail**（README 里仍写 285，需一并更正） |

本轮产生的两条真实索引（可直接拿来做验收对比，不要删）：

```
video-index\file=0eda4c69ce8f=SenseNow____.mp4\        ← monolithic（外挂 SRT，sync）
video-index\file=39959ab16066=sense-now-real-441s.mkv\ ← chunk catalog（内嵌 subrip，background）
```

测试视频：

- `视频输出/out/SenseNow_成片_带字幕.mp4`（1920×1080，H.264 + AAC，450.97 s，**视轨正常**）
- `视频输出/out/SenseNow_字幕.srt`（同片外挂字幕）
- `.tmp/release-smoke-2969d50/sense-now-real-441s.mkv`（441.02 s，h264 + mp3 + **subrip 内嵌轨**，**视轨全黑**，见 §9）

## 2. 总目标与硬边界

目标：让“问一句就能拿到可引用的台词”、“画面问题真的能出图”、“覆盖率不再把已索引的片子说成 poor”、
“索引目录不残留构建标记”。四个改动都必须是**真数据**，不允许用占位或假 ready 过关。

硬边界（违反即打回）：

1. 不改任何公开工具协议：`video_index` 的 action 名、参数名、`meta` 结构对上层保持兼容。
2. 不新增 action，不新增环境变量开关，不引入新依赖。
3. 不允许把“没有图像”的单元标成 `ready`；`disabled / skipped / unavailable / pending / degraded / ready` 语义按 README 执行。
4. 不动 `sense_now` 实时链路、不动 capture CDP 语义、不动 `videoKey` / `evidenceId` / `frameId` 生成规则。
5. 不删改已有测试来让套件变绿；新增测试必须能在 `npm test` 里独立跑。
6. 全程不写死绝对路径；不把本机用户名、`%USERPROFILE%` 等写进源码或测试断言。

## 3. 修复顺序

```
R1 query 文本通道（最高优先，直接决定“能不能回答问题”）
R2 chunk storyboard 真 ready
R3 本地文件 duration / coverage
R4 .building.json 残留
R5 两个低优先一致性小项（可同 R2/R3 一起做）
```

每完成一项：`npm test` 必须仍为 0 fail，再进入下一项。

---

## 4. R1：`query` 的模型可见文本里必须带台词与引用

### 4.1 现状（已复现）

`src/video-index-tool.js:345-357` 里，`action=query` 返回给模型的 `text` 只有五行：

```
queryType=text_structure decision=llm
reasons: default_text_structure, text_or_time_no_visual, budget_truncated, user_question, user_request
chapters=1 events=12 utterances=20
visual=0 cacheHit=no
truncated=true omitted=20
（索引层只返回证据与引用，请据此回答用户，不要把摘要当成唯一事实。）
```

真实 utterance 正文、时间戳、`evidenceId`、`citations` 全部只进了 `meta`。DSH 的工具结果里模型只能读到
`text` + `images`，读不到 `meta`。实际后果：问“整条视频讲了什么”，模型只拿到“有 20 条 utterance”，
一句台词都引不出来，只能凭文件名瞎猜——这与 README “query 返回的是可供 Agent 回答的证据与引用” 冲突，
也让 `docs/` 里“字幕优先问答”的整条价值链断在最后一步。

已确认可用字段（无需改引擎）：

- `eng.query()` 返回 `context.utterances[]`，元素含 `text`（**含换行**）、`startMs`、`endMs`、`evidenceId`、`speakerClusterId`。
  `src/video-index/context-builder.js:108-118` 会保留这些字段，并额外返回 `citations[]`。
- `context.chapters[]` 含 `title`、`startMs`、`endMs`、`summary`、`evidenceIds`。
- `decision` 可能是 `llm` / `insufficient`（`context-builder.js:77-81`）。

### 4.2 强制实现

在 `src/video-index-tool.js` 的 query 分支里，`text` 改为“摘要行 + 证据正文”，顺序固定：

```
queryType=... decision=... layout=...
reasons: ...
visual=N cacheHit=... truncated=... omitted=N
--- chapters ---
[03:12–05:40] 章节标题 (EVID_xxx, EVID_yyy)
--- utterances (按 startMs 升序，最多 maxTextUtterances 条) ---
[00:04–00:10] 最近，UP 一边在给 Mnemosyne 2.0 补充知识、准备升级… (EVID_023f4c6976754fcc)
[00:10–00:15] 给某位知名 UP 主开源的"看视频"插件… (EVID_...)
--- omitted ---
剩余 39 条 utterance 未展开；需要哪一段请带更具体的时间或关键词再问
```

实现约束：

1. **换行折叠**：`u.text` 里的 `\n` 必须折成空格并压缩连续空白，单条正文超过 120 字按 120 字截断并加 `…`。
   否则一条 SRT 就能把工具输出撑成多行垃圾。
2. **上限**：新增常量 `QUERY_TEXT_LIMITS = { maxUtterances: 12, maxChapters: 3, maxCharsPerUtterance: 120 }`，
   导出以便测试。`text` 总长超过 `estimateTextTokens` 约 800 token 时继续丢尾部 utterance，并在 `--- omitted ---` 里报数。
3. **顺序**：utterances 必须按 `startMs` 升序（不是相关度），否则时间线读不出来；chapters 按 `startMs` 升序。
4. **引用一致**：正文里的 `EVID_*` 必须与同一返回值的 `meta.citations` 一致；允许只列前 2 个 id 并加 `+N`。
5. **`decision=insufficient`**：正文段落换成一句明确说明（例如 `证据不足：仅命中 N 条 utterance，命中时间段 [..]`），
   不得编造，也不得省略“证据不足”四个字。
6. **只对文本类查询展开**：`queryType` 为 `visual` / `multimodal` 时不要塞台词正文，改为
   `visual evidence: N 帧 (FRAME_xxx @ 02:00, ...)`，避免视觉问题淹没在字幕里。
7. `meta` 原样保留（不要为了省 token 删 `meta` 字段，外部消费者依赖它）。
8. 不改 `eng.query()` 的返回结构；所有改动收敛在 tool 层。

### 4.3 必须新增的测试

在 `test/video-index-tool.test.mjs`（现有 harness 已能 `createVideoIndexTool({ rootDir, adapters })` + 注入字幕）：

1. `query` 的 `text` 含至少 2 条 utterance 正文与至少 2 个 `EVID_`；顺序为 `startMs` 升序；
   `text` 里不含 `\n\n`（换行已折叠）。
2. 构造 30 条 utterance 的索引，断言 `text` 只展开 12 条，且 `--- omitted ---` 里报出剩余条数。
3. `mode=visual` 的 `text` 不含 utterance 正文，含 `visual evidence:` 行。
4. `decision=insufficient` 时 `text` 含“证据不足”，且不含 `EVID_`（无证据可引时不得编）。
5. 旧断言（无损 JSON、`meta` 字段）保持通过。

---

## 5. R2：chunk catalog 的 storyboard 不许“假 ready”

### 5.1 现状（已复现）

`chunks/000000/storyboard.json` 里的四个单元长这样（**没有 `imageRef`、没有 `evidenceIds`**）：

```json
[
  { "frameId": "FRAME_ed18edc7b4e735f6", "timestampMs": 150000, "chunkId": "000000" },
  { "frameId": "FRAME_31e3ad46d1568003", "timestampMs": 151000, "chunkId": "000000" },
  { "frameId": "FRAME_dabd002d03d94768", "timestampMs": 152000, "chunkId": "000000" },
  { "frameId": "FRAME_5012235e5e8340bd", "timestampMs": 153000, "chunkId": "000000" }
]
```

而同一 chunk 的 `chunk-manifest.json` 写着 `"storyboard": "ready"`。`evidence/frames/` 下只有 zoom 写出的 3 个 PNG，
**这四个帧从来没有落过盘**。

后果（实测）：`video_index({action:"query", mode:"visual"})` 返回
`visual=0`、`reasons` 含 `storyboard_insufficient_zoom`，一张图都拿不到；
工具层 `loadPngForUnit()`（`src/video-index-tool.js:229-241`）因为没有 `evidenceIds` 直接返回 `null`，静默丢图。

根因在 `src/video-index/video-index-engine.js:503-563` 的 chunk 级“轻量帧”：

- 本地媒体分支（526-556）只 `extractFrames()` 拿 buffer → `frameIdOf()` → 把 `{frameId, timestampMs, chunkId}` 推进
  `storyboard`，**没有 `encodePng`、没有 `store.writeBinary`、没有 frame evidence、没有 `imageRef` / `evidenceIds`**；
- 随后 553 行无条件 `capabilities.storyboard = storyboard.length ? 'ready' : 'degraded'`。
- 对比：URL 分支（519-524）虽然也缺 evidence，但至少写了 `imageRef: pngOut`；段尾帧路径（1130-1169）是**完整正确**的样板
  （写 PNG + 写 frameEvidence + 补 `imageRef`/`sourceSize`/`storedSize`/`roi`/`transform`/`selectionReasons`/`evidenceIds`）。

### 5.2 强制实现

改 `indexChunk()` 的本地媒体分支，按段尾帧路径的样板补齐：

1. 对每一帧：`encodePng(fr.buf, w, h)`；`contentHash(png)`；用 `frameIdOf({videoKey, timestampMs, roi, contentHash})` 生成 `fid`
   （**必须把 contentHash 纳入 frameId**，现在用的是 `contentHash(\`${chunk.chunkId}:${ts}\`)` 这种假哈希）。
2. `chunkStore.writeBinary` / `store.writeBinary(videoKey, \`evidence/frames/${fid}.png\`, png)` 落盘，失败即 `continue` 并降级。
3. 追加 frame evidence：`{ evidenceId, kind:'frame', startMs, endMs, ref, sourceFile, contentHash, provenance:{via:'chunk_storyboard'} }`，
   并进入该 chunk 的 `evidence` 数组（controller 已经会把 `out.evidence` 写进 chunk）。
4. storyboard 单元补全字段：`imageRef`、`sourceSize`、`storedSize`、`roi`、`transform`、`selectionReasons: ['chunk_lightweight']`、`evidenceIds`。
5. 能力位：只有**全部**单元都有 `imageRef` 且 PNG 真实存在时才 `ready`；否则 `degraded`。
   如果本 chunk 一帧都没取到 → `degraded`（不是 `unavailable`，因为媒体在、只是没取到）。
6. 1272-1310 的 monolithic commit payload（`storyboardIndex` / `coverage` 那一段）不要动；只有 chunk 路径需要补。

### 5.3 旧索引兼容（必须）

`videoKey` 已存在的旧索引里，storyboard 单元没有 `imageRef`。视觉查询遇到这类单元：

- 在 `routeVisualNeed` / `loadPngForUnit` 之前过滤掉“无 `imageRef` 且无 `evidenceIds`”的单元，不要让它们进入 `visualEvidence`；
- 过滤后为空时 `reasons` 必须保留 `storyboard_insufficient_zoom`，并新增 `storyboard_missing_images`，
  让上层能区分“没抽帧”和“抽了但没存图”；
- **不得**因为兼容而回退成“假装有图”。

### 5.4 测试

新增/扩展 `test/chunk-store-job.test.mjs` + `test/video-index-tool.test.mjs`：

1. 用注入的 `extractFrames`（返回固定 buffer）走 background chunk 索引 → 断言
   `chunks/000000/storyboard.json` 每个单元都有 `imageRef` + `evidenceIds`，且 `evidence/frames/<frameId>.png` 存在、字节数 > 0。
2. 断言 chunk-manifest 的 `storyboard` 为 `ready` 当且仅当所有单元 PNG 存在。
3. 让 `extractFrames` 抛错 → 断言 `storyboard=degraded` 且目录里没有半截 PNG。
4. `query(mode:visual)` 在 R2 之后必须 `visual>=1` 且工具返回 `images.length>=1`。
5. 旧索引（手工构造只有 `frameId/timestampMs` 的 chunk）→ `query(mode:visual)` 返回 `visual=0` 且 `reasons` 含 `storyboard_missing_images`，不抛错。

---

## 6. R3：本地文件的 duration 与 coverage 不能是全零

### 6.1 现状（已复现）

`...file=0eda4c69ce8f=.../metadata.json`：

```json
{ "title": "SenseNow_成片_带字幕.mp4", "path": "...", "size": 34567590,
  "mtimeMs": 1793658096787.433, "durationMs": null, "width": null, "height": null,
  "fingerprint": "sha256:da68a5ef..." }
```

`analysis/coverage.json`：

```json
{ "durationMs": 0, "targetStartMs": 0, "targetEndMs": 0,
  "textRanges": [], "sampledRanges": [], "missingRanges": [],
  "scanCoverageRatio": 0, "textCoverageRatio": 0, "coverageRatio": 0,
  "status": "poor", "sourceCoverage": { "native": 109 } }
```

而同目录 `manifest.json` 写的是 `counts.utterances = 109`、`status = "ready"`，视频实际 450.97 s。
也就是说：**片子索引成功了，覆盖率却说“poor / 0”，且不知道时长**。按 Agent 协议第 5 条，
模型会据此回答“证据不足”，跟事实相反。

根因链（三处协同）：

1. `src/video-index/adapters/file-source.js:39-41`：`durationMs: source.durationMs ?? null`（`width`/`height` 同理），
   而 tool 传入的 `source` 只有 `{kind:'file', path}`（`src/video-index-tool.js:255-256`），于是镜头一进来 duration 就是 `null`。
2. `src/video-index/video-index-engine.js:742`：`const durationMs = Number(metadata.durationMs) || ... || 0` → `0`。
   接着 773 行把它传进 `resolveVideoSubtitles({ durationMs: 0 })`，`subtitle-coordinator.js:240-251` 用 0 建 coverage，
   `coverage.js:63-115` 于是把 `targetEnd` 钳成 0、`textRanges` 全被 clamp 空、`status='poor'`。
3. `src/video-index/video-index-engine.js:1176`：`if (!coverage && durationMs)` —— coverage 是个**truthy 的空报告**，
   所以永远不重建。真正的 `probeMediaDurationMs()` 只在 `indexAdaptive`（2250 行）里跑过，没回写 metadata。

### 6.2 强制实现

1. `file-source.js`：保持不探测（适配器保持无副作用、零 ffprobe），但**引擎必须在 metadata 落盘前补齐**。
2. `video-index-engine.js` 的 `index()`：在 742 行之前，若 `metadata.durationMs` 不是正数，调用
   `adapters.probeDuration || probeMediaDurationMs(mediaPathEarly)`，拿到值后**写回 `metadata.durationMs`**（并参与后面的 manifest/metadata 落盘）。
   探测失败不要抛错（字幕缺失也能索引），但要在 `coverage.limitReasons` 里加 `duration_unknown`。
3. `indexAdaptive` 已经探测过时长（`prepareSourceForIndex` → `prepared.durationMs`），但 2343-2348 行
   `index({ source }, { ...indexOptions, signal, capabilities, analysisPolicy })` **没有把它传下去**。
   请给 `index()` 的 options（631-646 行）加 `durationMs = null`，并在该调用处传 `durationMs: prepared.durationMs`，避免二次 ffprobe。
   注意：同步短片路径正是这条，不加这一步 R3 只修一半。
4. 覆盖率重建条件改为：`if ((!coverage || coverage.durationMs <= 0 || !coverage.textRanges?.length) && durationMs > 0)` 时用
   `buildCoverage(subtitleSegments.length ? subtitleSegments : subPack.utterances, durationMs)` 重建；
   并且**重建后 `status` 必须能到 `good`/`partial`**（449 s 的片 + 109 条字幕，textCoverageRatio 应 > 0.7）。
5. 顺手把 `width`/`height` 也补上（`ffprobe -show_entries stream=width,height`，同一次 probe 里做，失败则留 `null`）——
   现在 `metadata.width/height` 为 `null`，影响 ROI 与 storyboard 尺寸推断。
6. chunk 路径目前**完全没有** `coverage.json`。要么在 `chunks/catalog.json` 顶层加一个聚合 coverage（`durationMs` 用源时长、
   `textRanges` 用各 chunk `subtitleCoverage` 换算），要么明确在 catalog 里写 `coverage: null` 并在 `status` 里体现；
   二选一，但**不要留“查不到就是 null”**这种模糊状态。

### 6.3 测试

扩展 `test/subtitle-first-index.test.mjs` / `test/auto-duration-routing.test.mjs`：

1. 注入 `probeDuration: async () => 450_967` 的引擎，索引一个只有字幕的假文件 → 断言
   `metadata.json.durationMs === 450967`，`analysis/coverage.json` 的 `durationMs === 450967`、`status !== 'poor'`、
   `textRanges.length > 0`。
2. 注入 `probeDuration: async () => null` → 断言索引仍成功，`coverage.limitReasons` 含 `duration_unknown`，`durationMs === 0`。
3. chunk 路径：断言 `chunks/catalog.json` 里有明确的 duration 与 coverage 表达（按 6.2 第 6 条实现的那一种）。

---

## 7. R4：成功发布后不能留下 `.building.json`

### 7.1 现状

`video-index-engine.js:716-727` 先 `store.writePart(videoKey, '.building.json', building)`（status=`building`、counts 全 0），
随后 `store.commit()` → `index-store.js:261-271` → `writePayload()` 写全套文件 → `publishStaging()` 把整个 staging 目录 rename 成 live。
`.building.json` 跟着搬进 live，**没有任何地方删它**：

```
...file=0eda4c69ce8f=.../.building.json   ← status: "building", counts 全 0
```

风险：崩溃恢复与 `cleanup` 会把“已 ready 的索引”当成“构建中”；`index-cleanup.js:16` 只是把它当临时文件名处理
（要靠人工 cleanup 才消失），属于把内部标记泄漏给用户。

### 7.2 强制实现

1. `index-store.js` 的 `writePayload()` 末尾（写完最终 manifest 之后）删除同目录的 `.building.json`（不存在则忽略）。
2. `publishStaging()` 在 rename 之前做一次同样的兜底删除，防止有人绕过 `writePayload`。
3. `loadIndex()` / `status()` 读取时：若 `.building.json` 存在但 `manifest.json` 已是 `ready`，按 `ready` 报，
   并忽略该标记（不得把 ready 索引降级成 building）。
4. 不要靠 `cleanup` 兜底——cleanup 是用户主动动作，不能当成写入路径的清理手段。

### 7.3 测试

扩展 `test/index-staging.test.mjs` / `test/video-index-store.test.mjs`：

1. 完整 `index()` 后断言索引目录内 **不存在** `.building.json`。
2. 中途抛错（注入 `resolveVideoSubtitles` 抛错）→ 断言 live 目录没有被半发布，且 `.building.json` 不会让 `status` 变成 `building`。
3. 手工放一个 `.building.json` + 正常 `manifest.json` 的 ready 索引 → `status` 仍为 `ready`。

---

## 8. R5：两个低优先一致性小项

### 8.1 capability 口径不一致

同一个 `analysisPolicy: {}`：

- monolithic（sync）：`storyboard: "skipped"`（`video-index-engine.js:938`）
- chunk（background）：`storyboard: "ready"`（`video-index-engine.js:553`）

R2 修完后，chunk 至少是“真 ready”。请再确认：**`storyboard:skipped` 时视觉查询的 `reasons` 应说明 `storyboard_skipped`**，
而不是让上层看到 `storyboard_insufficient_zoom` 去猜。改 `visual-need-router.js` 的 reasons 即可，不改策略。

### 8.2 `textConfidence` 恒为 0

`chunk-store.js:198-203` 用 utterance 的 `confidence` 中位数算 `textConfidence`，而字幕适配器产出的 utterance
**没有 `confidence` 字段**（`detail/utterances.json` 里 109 条全部缺），于是恒为 0。
请：native/外挂字幕统一补 `confidence`（SRT/VTT 无置信度时用 `1.0` 并标 `sourceType:'native'`，OCR 才用真实置信度），
或把 `textConfidence` 改为“不可用 → `null`”并同步 README 的字段说明。**二选一，不许继续输出 0 假装有值。**

## 9. 不要修的东西（避免误伤）

- `.tmp/release-smoke-2969d50/sense-now-real-441s.mkv` 的 zoom 出来是纯黑帧：**这是素材问题**。
  用裸 ffmpeg 在 1.65 s / 201.5 s / 331.5 s 和全解码到 200 s 各取一帧，字节完全相同（`sha256:033D086C…`）。
  不要为它改 seek 逻辑，也不要给它写回归断言。
- monolithic 与 chunk 的 `videoKey` 分别是 `file:0eda4c69ce8f:SenseNow____.mp4` 与 `file:39959ab16066:sense-now-real-441s.mkv`，
  格式不要动，已有索引必须还能 `query`。
- `docs/端到端跑通报告-2026-11-03.md` 是观测记录，别改它的结论数字；修完后可在文末追加“已修复”段落。

## 10. 必须运行的验证

```powershell
npm test                                          # 基线 288 pass / 0 fail，只能增不能减
python -m py_compile scripts/*.py                 # 不要因为改 JS 把 Python 弄坏（跑一遍即可）
npm pack --dry-run --json --ignore-scripts        # 包内条目数不得因新增文件异常膨胀
node scripts/install-dev.mjs --check              # profile 状态
```

真实 smoke（改完后按顺序跑一遍，允许用 DSH 或 Node 直调引擎）：

1. `video_index({action:"index", source:"file", path:"视频输出/out/SenseNow_成片_带字幕.mp4",
   subtitlePath:"视频输出/out/SenseNow_字幕.srt", execution:"auto", analysisPolicy:{}})` → `ready`。
2. `video_index({action:"query", videoKey, question:"整个视频的主要论点和结论是什么？", mode:"auto"})`
   → **`text` 里能直接看到 5 条以上带时间戳的台词 + `EVID_`**（这是 R1 的验收点）。
3. `video_index({action:"index", source:"file", path:".tmp/release-smoke-2969d50/sense-now-real-441s.mkv",
   execution:"background", analysisPolicy:{}})` → job `ready`；
   `query`/`zoom` 后 `evidence/frames/` 里确实有 PNG，`query(mode:visual)` 的 `visual >= 1`（R2 验收点）。
4. `status` 应报出 `durationMs ≈ 450967`；`analysis/coverage.json` 的 `status` 不再是 `poor`（R3 验收点）。
5. 索引目录里没有 `.building.json`（R4 验收点）。

## 11. 验收标准（逐条可判定）

- [ ] R1：`query` 的 `text` 含 ≥2 条台词正文与对应 `EVID_`；换行已折叠；超预算有 `--- omitted ---` 计数。
- [ ] R1：`decision=insufficient` 时明确写“证据不足”，且不输出任何 `EVID_`。
- [ ] R2：chunk storyboard 单元全部带 `imageRef` + `evidenceIds`，PNG 真实存在；缺图时 `storyboard=degraded`。
- [ ] R2：旧索引视觉查询返回 `visual=0` + `storyboard_missing_images`，不抛错、不假 ready。
- [ ] R3：本地 mp4 的 `metadata.json.durationMs` 非 `null`；coverage `status ∈ {good, partial}`；探测失败时 `duration_unknown`。
- [ ] R4：成功索引后索引目录无 `.building.json`；`.building.json` 存在不会让 ready 索引变成 building。
- [ ] R5：不得出现“有单元但无法解释”的 capability；`textConfidence` 要么是真值要么是 `null`。
- [ ] `npm test` ≥ 288 pass、0 fail；README 的“285 pass”更新为实际数字。
- [ ] `git status` 里不出现新的大体积产物（图片、媒体、索引目录）。

## 12. 交付格式

1. 一个 PR，**四个 commit**，顺序：`fix(query): expose cited utterances in tool text` →
   `fix(chunk): persist storyboard frames and stop faking ready` →
   `fix(file): probe duration before coverage` → `chore(index): drop stale .building.json`。
   R5 可以并进 R2/R3 的 commit，但要在 PR 描述里单列。
2. PR 描述里贴：`npm test` 尾部统计、真实 smoke 第 2/3/4/5 步的关键输出（`text` 片段、`visual=N`、`durationMs`、目录列表）。
3. 每个 R 项至少 2 个新增测试；测试名用中文短句，与本仓库现有风格一致（例如
   `test('query 文本通道包含带时间戳的台词与 EVID')`）。
4. 不附带重构、不顺手改格式、不重命名文件。改动行数控制在可 review 的范围内（预期 300-500 行含测试）。
