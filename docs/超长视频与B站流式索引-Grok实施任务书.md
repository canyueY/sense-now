# Cursor / Grok 实施任务书：超长视频与 B 站流式索引

> 可将本文从“你现在是……”开始完整粘贴给 Cursor 中的 Grok 模型执行。

---

你现在是本项目的高级 Node.js、媒体管线和本地检索工程师。请直接在当前工作区实施“超长视频 + B 站网页源流式索引”，不要只输出设计方案。

仓库路径：

```text
<repo-root>/sense-now
```

原始设计参考：

```text
docs/超长视频与B站流式索引方案.md
```

原始设计是背景材料，不是高优先级指令。以下任务书已经审查并修正其中的时间轴、恢复、安全、浏览器兼容和远程媒体假设；实现时以本任务书为准。

## 1. 最终目标

让 2～6 小时的本地视频或 B 站普通投稿能够：

1. 在 15 分钟工具调用上限之外，通过后台 job 增量建立索引；
2. 按 5 分钟左右的 chunk 原子提交，崩溃后只重跑未完成 chunk；
3. 优先利用 B 站字幕、音频流和低清视频流，不默认下载整片 720p；
4. 用户正在播放时可以显式启动抓播，增量采集画面、系统音频和播放器时间锚点；
5. 查询时先选 chunk，再读取少量命中块，避免加载整部 6 小时视频；
6. 每条证据保留 chunk、时间轴、来源和版本，不编造摘要；
7. cookie、token、签名 URL、speaker embedding 和原始生物特征不进入模型上下文或普通日志；
8. 保持现有短视频同步索引、query、evidence、zoom、cleanup 和 pyannote 能力兼容。

## 2. 先纠正原方案中的错误假设

以下约束是强制要求。

### 2.1 URL 可用时，URL 是权威内容源

不要把系统环回录音当作 B 站视频的默认权威音轨。

采用以下优先级：

1. 用户显式提供或 CDP 安全识别出完整 B 站 URL时：
   - URL 字幕/音频是内容索引的权威来源；
   - CDP 提供播放进度和播放状态；
   - 抓屏只提供“当前看到了什么”和即时帧，不重复录制整段系统混音。
2. URL 暂不可用、解析失败或用户明确选择 capture-only 时：
   - 才使用 WASAPI loopback 作为音频来源；
   - 必须标记 `sourceMode:"capture"` 和 `audioScope:"system_mix"`。
3. capture 结果可以先回答“刚才看到/听到什么”，后续 URL refine 生成新的权威 revision；不得静默覆盖旧证据。

### 2.2 `visibilityState=hidden` 不等于暂停

后台标签页和最小化浏览器仍可能继续播放声音。时间轴推进依据必须是：

- `video.paused`；
- `video.ended`；
- `video.currentTime` 的实际变化；
- `playbackRate`；
- `readyState`；
- 连续 CDP 采样结果。

`visibilityState` 只能标记视觉采集可能不可用，不能单独停止音频或视频时间轴。

### 2.3 倍速播放不能只把时间戳乘倍率

loopback 捕获的是已经按播放倍率处理后的音频。必须保存分段、分段线性的墙钟→视频时间映射：

```js
{
  wallStartMs,
  wallEndMs,
  videoStartMs,
  videoEndMs,
  playbackRate,
  reason: "normal|pause|seek|rate_change|navigation"
}
```

以下事件必须立即结束当前 mapping segment 和 capture chunk：

- seek；
- playbackRate 改变；
- pause/resume；
- URL、BVID、CID、partId 改变；
- 播放结束；
- CDP 连接丢失并发生时间源降级。

ASR/diarization 的墙钟时间戳通过对应 mapping segment 插值到视频时间。不能对整个 chunk 使用单一倍率。

### 2.4 抓播崩溃后不能承诺无缝续抓

进程退出期间没有采到的音频和画面无法恢复。

恢复语义必须是：

- 已提交 chunk 不重跑；
- 新 capture session 从当前播放器时间开始；
- 中间缺口记录为 `gap` 和 `discontinuity`；
- 有 URL 时由 refine 补缺口；
- 没有 URL 时保留缺口，不伪造连续时间轴。

### 2.5 远程 `ffmpeg -ss` 不保证只下载目标片段

不同容器、索引位置和 CDN Range 行为会导致额外读取。实现必须：

- 记录每块实际下载字节数；
- 设置单块字节上限、时间上限和临时文件上限；
- Range/seek 不可用时明确降级或失败；
- 不得在文案中无条件宣称“零整片下载”；
- 集成测试使用本地 HTTP Range/redirect fixture 验证，而不是访问真实 B 站。

### 2.6 CDP 不能假定默认浏览器配置一定可连接

Chrome 136+ 对默认用户数据目录的 remote-debugging 开关有限制；较新 Chrome 还可能要求用户显式允许远程调试。

实现必须支持：

- 用户提供的 `cdpEndpoint`；
- 显式 localhost 端口；
- 独立 `--user-data-dir` 的 helper 启动方式；
- CDP 不可用时安全降级；
- 不读取或复制用户默认浏览器 cookie 数据库。

不要在测试中启动真实 Chrome/Edge。

## 3. 范围和非目标

本轮必须支持：

- 本地文件长视频；
- `https://*.bilibili.com` 普通投稿；
- 多 P/合集中的单个明确 part；
- URL 后台分块索引；
- Windows 抓播的可选 MVP；
- 断点恢复；
- 两级检索；
- URL refine；
- 已有 ASR、pyannote、speaker/person 查询链路。

明确不支持：

- 直播滚动索引；
- 付费番剧或 DRM 绕过；
- 批量爬取；
- 绕过登录/风控；
- 通过抓屏或录音规避内容保护；
- 默认持久化 speaker embeddings；
- 将匿名 speaker 推断成现实姓名或“UP 主本人”。

## 4. 实施顺序

不要一上来同时写 CDP、WASAPI、B 站和检索。按下面顺序完成，每阶段先测试通过再进入下一阶段。

### Phase 0：基线、契约和迁移

1. 运行并记录：

```powershell
npm test
npm pack --dry-run --json --ignore-scripts
```

2. 阅读当前实现，尤其是：

- `src/video-index/video-index-engine.js`
- `src/video-index/index-store.js`
- `src/video-index-tool.js`
- `src/video-index/speaker-view.js`
- `src/video-index/evidence-package.js`
- `src/video-index/adapters/bilibili-source.js`
- `src/video-index/adapters/asr-adapter.js`
- `src/video-index/adapters/pyannote-runner.js`
- `scripts/audio-visual-runner.py`

3. 定义 schema/version 迁移规则：

- 旧单体索引继续可读；
- 新索引使用 chunk layout；
- 不在读取旧索引时自动做不可逆迁移；
- 可提供显式 `migrate` 或在 rebuild 时转为新格式；
- manifest 增加 `layoutVersion`，不要复用含义不清的旧字段。

### Phase 1：chunk store + job store + 本地文件纵向切片

先用本地文件打通，不碰真实网络和声卡。

必须实现：

- chunk 规划；
- 单 chunk 音频/ASR/diarization/帧处理；
- chunk 原子提交；
- 后台 job；
- cancel/resume；
- 查询 ready chunks；
- 故障注入恢复测试。

### Phase 2：B 站 URL 流式索引

在 Phase 1 稳定后实现：

- `resolveStreams()`；
- 临时、不可持久化的 stream descriptor；
- 安全的远程音频范围提取；
- 签名过期刷新；
- 字幕优先；
- 低清帧提取；
- 本地 HTTP fixture 集成测试。

### Phase 3：抓播 MVP

最后接入：

- 显式启动的 loopback recorder；
- 手动 region；
- CDP 时间探针；
- 分段时间映射；
- capture chunk；
- 中断缺口；
- URL refine。

自动 region 和浏览器一键启动属于增强项，不能阻塞手动 region MVP。

### Phase 4：跨块 speaker、两级检索和基准

完成：

- provisional speaker IDs；
- 可选 embedding merge；
- mergeEvidence；
- chunk catalog；
- query cache revision；
- 6 小时合成索引 benchmark；
- 安全与清理审计。

## 5. chunk 数据模型

默认配置：

```js
chunkMs = 5 * 60_000;
overlapMs = 20_000;
maxFramesPerChunk = 4;
```

边界必须使用半开区间：

```text
[startMs, endMs)
```

最后一个 chunk 可以在 duration 结束。

### 5.1 overlap 所有权

处理输入窗口可以是：

```text
[startMs - overlapMs, endMs + overlapMs]
```

但 canonical 输出必须裁回 core 区间，或使用确定性的 midpoint ownership。不能把 overlap 证据在相邻 chunk 重复写两次。

ASR 去重至少使用：

- 视频时间重叠；
- 规范化文本；
- 置信度；
- speakerClusterId（若存在）。

不能只按 evidenceId 去重，因为不同 chunk 会生成不同 evidenceId。

### 5.2 推荐目录

```text
<index-root>/<videoKey>/
  manifest.json
  metadata.json
  summary/
    chapters.tree.json
    topics.json
    key-moments.json
  chunks/
    catalog.json
    000000/
      chunk-manifest.json
      utterances.json
      events.json
      speakers.json
      storyboard.json
      evidence.json
  evidence/frames/
  private/                    # 默认不创建；显式允许才存 embedding
  cache/queries.json
```

每个 chunk 通过同目录 staging 写入，`chunk-manifest.json` 最后写，再原子 rename。全局 manifest 最后原子更新。

查询流程只读取全局 manifest 指向的 ready generation，不能看到半写 chunk。

### 5.3 chunk manifest

至少包含：

```js
{
  chunkId,
  revision,
  startMs,
  endMs,
  inputStartMs,
  inputEndMs,
  status: "queued|processing|ready|degraded|failed|cancelled",
  sourceMode: "file|url|capture|refine",
  timeSource: "stream|cdp|wallclock",
  discontinuity: false,
  gaps: [],
  capabilities: {},
  counts: {},
  byteUsage: { downloaded: 0, temporaryPeak: 0 },
  provenance: {
    sourceRevision,
    adapterVersions,
    generatedAt
  },
  error: null
}
```

`ready` 只能在所有必需文件已提交后写入。部分 adapter 失败但仍有可查询文本时使用 `degraded`。

## 6. 后台 job

### 6.1 API

保留现有 `status(videoKey)` 语义，避免与 job 状态混淆。新增动作建议使用：

```js
video_index({ action: "index", source: "file|bilibili", ..., execution: "auto|sync|background" })
video_index({ action: "capture_start", region?, cdpEndpoint?, url? })
video_index({ action: "capture_stop", jobId })
video_index({ action: "job_status", jobId })
video_index({ action: "job_cancel", jobId })
video_index({ action: "job_resume", jobId })
video_index({ action: "refine", videoKey, url })
```

规则：

- `execution:"auto"`：预计超出安全同步时长时立即返回 jobId；
- `execution:"sync"`：仅允许短素材或明确 `wait:true`，仍受工具超时；
- `execution:"background"`：立即返回；
- 不要通过一个长 Promise 假装后台任务；
- 工具取消只取消等待，不应误杀已明确提交到后台的 job，除非调用 `job_cancel`。

### 6.2 job 状态机

```text
queued
  → resolving
  → capturing             # capture only
  → planning
  → indexing
  → finalizing
  → ready | degraded | failed | cancelled
```

允许 `paused/recoverable`，但不要把进程崩溃后的 capture 缺口称为无损 resume。

### 6.3 进程模型

后台 worker 是插件进程拥有的独立子进程：

- 工具调用返回后可以继续；
- 插件正常退出时先发 graceful stop，再杀进程树；
- 不默认创建脱离宿主生命周期的永久 daemon；
- 宿主异常退出后，下次启动把 `running` job 标成 `recoverable`；
- URL/file job 可以从下一个未完成 chunk 继续；
- capture job 新建 session 并记录 gap。

### 6.4 锁

同一 videoKey 只允许一个写 job。

锁必须使用排他创建（如 `open(..., "wx")`），不能先 exists 再 create。锁内容包含：

```js
{ pid, processStartTime, nonce, heartbeatAt, jobId, videoKey }
```

处理 PID 重用：只有 heartbeat 过期且进程身份不匹配时才回收锁。

### 6.5 原子性

`state.json`、chunk manifest、global manifest 均使用现有 atomic JSON 能力。更新顺序：

1. 写 chunk staging；
2. 写 chunk manifest；
3. rename 成正式 chunk；
4. 更新 global manifest；
5. 更新 job state。

故障注入必须覆盖每一步之间的崩溃。

## 7. 本地文件与 URL 的统一 `indexChunk`

把当前整片 `index()` 拆成编排层和 chunk 层，但保持旧 API 可用。

建议接口：

```js
indexChunk({
  videoKey,
  chunk,
  sourceDescriptor,
  capabilities,
  signal,
  budgets
})
```

输出必须是纯数据，不直接发布全局 manifest：

```js
{
  chunkManifest,
  utterances,
  events,
  speakers,
  storyboard,
  evidence,
  chapters
}
```

编排层负责提交、全局聚合和状态更新。

短素材可以规划成一个 chunk，复用同一路径，避免维护两套逻辑。

## 8. ASR

修改 `src/video-index/adapters/asr-adapter.js`：

- 输入增加 `offsetMs`、`chunkId`、`language`；
- runner 仍返回 chunk-local 时间；
- adapter 校验后转换为视频绝对时间；
- 单 chunk 超时默认 600 秒，可配置但有硬上限；
- stdout/stderr 继续使用 bounded stdio；
- 超时或取消杀完整进程树；
- 单块失败不影响其他块；
- B 站有可用字幕时默认跳过 ASR；
- 没有真实 ASR adapter 时明确 `unavailable`，不能生成假转写。

ASR-only 仍需生成真实原文驱动的轻量章节；不得发明总结。

## 9. pyannote 和跨块 speaker

### 9.1 chunk-local diarization

修改 Python runner 支持 payload 中的：

```js
{
  audioPath,
  videoKey,
  chunkId,
  offsetMs,
  minSpeakers?,
  maxSpeakers?,
  returnEmbeddings: false
}
```

默认不输出 embedding。时间戳转换为视频绝对时间后再写 chunk。

### 9.2 provisional IDs

无全局合并时使用：

```text
C000012_SPEAKER_00
```

不能让不同 chunk 的 `SPEAKER_00` 自动视为同一人。

### 9.3 embedding 合并

仅在显式配置时启用：

- embedding 不进入 query/context/evidence package；
- 默认不持久化；
- 如需跨重启恢复，必须显式 `persistSpeakerEmbeddings:true`，只写本地 `private/`；
- cleanup/remove 必须清理 private 数据；
- 不记录到日志；
- 相似度阈值可配置，不把 `0.75` 写成普适真理；
- 模糊匹配保持 provisional/tentative；
- 每次合并写 `mergeEvidence`：chunk IDs、相似度、重叠连续性、算法版本。

不要把“人工核对一致率 90%”作为无数据集的 CI 门槛。提供独立评估脚本和人工报告格式。

## 10. B 站 URL 解析

在 `bilibili-source.js` 增加不下载媒体的 `resolveStreams()`。

使用 yt-dlp 参数数组且 `shell:false`。解析 `--dump-single-json` 输出，按明确 part/CID 选择格式。

返回内存中的短生命周期 descriptor：

```js
{
  webpageUrl,
  bvid,
  cid,
  partId,
  durationMs,
  resolvedAt,
  expiresAt,
  audio: { url, formatId, ext, headers },
  video: { url, formatId, width, height, headers },
  subtitles: [],
  contentFingerprint
}
```

强制要求：

- descriptor 不写入 manifest、state、cache 或普通日志；
- cookie 不写入返回对象；
- headers 只保留必要字段；
- header 名和值拒绝 CR/LF/NUL，防止 FFmpeg header 注入；
- BVID、CID、partId 和 duration 用于 refine 身份校验；
- 多 P 必须明确选择单 P，不能意外展开合集；
- b23 短链继续拒绝；
- 不调用未实现且不稳定的私有 WBI 接口作为默认路径；
- yt-dlp 不可用时明确报错，不伪造流地址。

## 11. 远程媒体安全

新增 `remote-media.js` 时必须遵守：

1. 只接受 `resolveStreams()` 创建的内部 descriptor；公开工具不能直接传 CDN URL。
2. 仅 HTTPS。
3. URL 禁止 username/password、fragment、NUL、控制字符。
4. host 必须通过配置化 allowlist；初始可以包含经过测试的 B 站 CDN suffix，但不要假设列表永远不变。
5. 对解析到的 IPv4/IPv6 拒绝：
   - loopback；
   - link-local；
   - RFC1918/ULA；
   - multicast；
   - unspecified；
   - metadata 地址；
   - 其他非公网地址。
6. DNS 校验与连接之间存在 rebinding 风险。若不能控制 FFmpeg 每次重定向，必须在文档中诚实说明边界；不得声称已经验证每一跳。
7. 限制 FFmpeg protocol whitelist，只允许确实需要的协议。
8. 不启用 `file:`, `concat:`, `subfile:`, `data:`, 任意本地协议。
9. 每块限制：
   - 最大下载字节；
   - 最大运行时间；
   - 最大重试次数；
   - 最大累计 backoff；
   - 最大临时磁盘。
10. 403/410 才触发 descriptor refresh；429/503 遵循有限退避；其他 4xx 不无限重试。
11. 重试前重新校验 content identity。

测试使用本地 HTTP fixture 模拟：

- Range；
- 不支持 Range；
- 302；
- 跳转到私网；
- 403 后 refresh；
- 429 Retry-After；
- 超大响应；
- 慢响应；
- header 注入。

## 12. 远程音频和帧提取

建议接口：

```js
extractAudioRange({ descriptor, startMs, endMs, outWav, limits, signal })
extractFrameAt({ descriptor, atMs, outPng, limits, signal })
```

规则：

- 音频统一输出 16kHz mono PCM WAV；
- 临时文件写 job temp，不直接写 live chunk；
- 成功提交 chunk 后删除临时 WAV，除非 `keepAudio:true`；
- 记录实际下载字节和峰值临时磁盘；
- 画面优先低清流；videoshot 仅作为可选优化，失败回退 seek；
- 全局 storyboard 帧硬上限；
- remote seek 失败不能回退为无上限整片下载；
- zoom 仍受现有预算与 SSRF 规则限制。

## 13. 抓播音频

新增 `scripts/loopback-recorder.py`，但保持可选依赖。

要求：

- 显式 `--check`；
- 显式启动，不后台静默录音；
- 默认 WASAPI shared-mode loopback；
- 设备切换/失效时报告可恢复错误；
- 16kHz mono PCM；
- 30 秒 segment；
- 文件名和 sidecar 含 monotonic 时间、sample count、wall start/end；
- 先写 `.tmp`，关闭 WAV 后原子 rename；
- stdout 为有界 JSON 事件；
- token/cookie 不传给 recorder；
- 停止时 flush 完整 WAV header；
- capture job 取消时杀进程树；
- 默认不永久保存处理后的原始音频。

不要把 recorder 在 pause 时反复启停。保持连续录音并根据 CDP mapping 丢弃或切分暂停区间，避免设备重开造成丢样。

至少支持一个主实现和清晰的 unavailable 报告。若 `soundcard`/`pyaudiowpatch` 未安装，不能让插件加载失败。

## 14. 画面区域和 capture

保持视频和音频为两个独立进程，避免 stdout 背压互相影响。

### 14.1 手动 region 是 MVP

先支持：

```js
{ x, y, width, height }
```

- gdigrab 使用 offset/video_size；
- ddagrab 在正确的 hwdownload/format 阶段加入 crop；
- 校验整数、正尺寸、最大面积、屏幕边界；
- 失败时可以整屏低分辨率降级，但必须提示用户。

### 14.2 CDP 自动 region 是增强

不能只使用 `screenX + getBoundingClientRect + 浏览器 chrome 高度` 作为“精确坐标”。必须考虑：

- CSS pixel 与 device pixel；
- browser zoom；
- devicePixelRatio；
- visual viewport；
- 多显示器和负坐标；
- 全屏；
- iframe；
- 元素 transform；
- 窗口边框和标题栏。

CDP 使用 Runtime.evaluate/DOM box 信息和 Page.getLayoutMetrics，输出坐标必须经过可视化校验测试。无法可靠换算时要求用户确认或回退手动 region。

## 15. CDP bridge

新增 `cdp-bridge.js`：

- 只允许 `http://127.0.0.1:<port>`、`http://localhost:<port>` 或对应 WebSocket；
- 拒绝任意远程调试地址；
- 只选择 URL 通过现有 B 站页面 allowlist 的 page target；
- 不连接 extension/background/service-worker target；
- 不读取 cookie/localStorage/sessionStorage；
- 不执行用户提供的任意 JavaScript；
- 内置固定脚本只读取视频状态、URL 和几何；
- CDP 输出有 schema、长度和数值边界校验；
- 断线指数退避但有上限；
- 断线期间标记 timeSource 降级，不伪造采样。

每秒采样至少包含：

```js
{
  sampledAtMonotonicMs,
  currentTimeMs,
  durationMs,
  paused,
  ended,
  playbackRate,
  readyState,
  visibilityState,
  pageUrl,
  videoRect,
  devicePixelRatio
}
```

提供 helper 文档，而不是自动接管默认浏览器配置。Chrome 136+ helper 使用独立 `--user-data-dir`；不得复制默认 profile。

## 16. refine

refine 前必须验证：

- 页面 URL 是允许的 B 站 URL；
- BVID/CID/partId 与 capture session 一致；
- duration 差异在合理范围；
- 用户没有切换到另一 P；
- content fingerprint 匹配。

refine 生成新 revision：

- 旧 capture evidence 保留 provenance；
- URL 字幕/音频补 gap；
- CDP anchors 用于捕获时间轴对齐；
- 冲突保留两份证据并标 conflict；
- 不静默把 capture 文本覆盖为 URL 文本；
- query 默认选择最新权威 revision，但 evidenceId 仍可追溯旧 revision。

## 17. 两级检索

新增/维护小型 `chunks/catalog.json`，每 chunk 只保存受限字段：

```js
{
  chunkId,
  revision,
  startMs,
  endMs,
  firstUtteranceExcerpt,
  topicTags,
  topTokens,
  speakerClusterIds,
  storyboardRefs,
  status,
  timeSource
}
```

查询流程：

1. route；
2. 时间问题直接选相交 chunk；
3. 文本问题对 catalog 打分，选 top 2～3；
4. multimodal 按 speaker 保证代表 chunk；
5. 只加载命中 ready/degraded chunks；
6. 块内二次检索；
7. 进入现有 token gate；
8. context/citation 加 `chunkId`、`revision`、`timeSource`。

不能把所有 chunk JSON 读入内存后再筛选。

查询缓存 key 增加：

- layoutVersion；
- global revision；
- 命中 chunkId+revision 集合的稳定 hash；
- budget；
- queryType。

新 chunk ready 后，旧缓存必须自然失效。

## 18. 全局章节和摘要

- 每 chunk 生成 1～3 个轻量章节；
- 标题/摘要只能来自真实字幕/ASR 原文截取；
- 不调用外部模型编造摘要；
- 粗章节按时间、topic 和 discontinuity 聚合；
- 总章节硬上限；
- 章节树节点保留 child/chunk/evidence IDs；
- 原方案“12×90 秒”之类的固定覆盖上限必须取消，但查询输出仍受 token budget 限制。

## 19. 全局 capability 和进度

global capability 由 chunk capability 聚合：

- 所有计划块 ready：`ready`；
- 部分 ready、部分 failed/unavailable：`degraded`；
- 尚未调用：`pending`；
- 没有 adapter：`unavailable`；
- 用户关闭：`skipped`。

不能因为 adapter `available()` 就写 ready。

进度至少区分：

```js
{
  capturedMs,
  plannedMs,
  indexedMs,
  readyChunks,
  degradedChunks,
  failedChunks,
  backlogChunks,
  currentStage
}
```

## 20. 资源调度

默认：

- 每个 videoKey 一个写 job；
- 全局一个 CPU/GPU 重型分析 slot；
- 远程下载单并发；
- capture recorder 可以继续落盘，处理队列有硬上限；
- backlog 超阈值时按明确策略降级，不能无限占磁盘。

降级策略可配置：

```text
pause_processing
capture_only_then_process
skip_diarization_for_non_priority_chunks
```

默认优先保证采集不丢，再延迟分析；不得静默跳块。

开始 job 前做磁盘预检，运行中监控剩余空间。达到阈值时停止产生新临时文件并把 job 置为 `paused`/`degraded`，不要把磁盘写满。

## 21. cleanup

扩展现有两阶段 cleanup：

- 第一阶段只扫描；
- 未确认时不写盘；
- 支持 job temp TTL；
- 支持 cancelled/failed job 清理；
- 不删除活跃锁对应目录；
- 不删除唯一恢复副本；
- 不删除未发布但可恢复 chunk staging，除非确认过期且 job 不活跃；
- 删除报告与实际磁盘一致；
- private embeddings 跟随精确 videoKey 删除；
- capture 原始音频默认按 TTL 删除。

## 22. 测试要求

自动测试禁止：

- 访问真实 B 站；
- 使用真实 cookie/token；
- 下载模型；
- 录制真实桌面/系统音频；
- 启动真实 Chrome/Edge；
- 依赖 CUDA；
- sleep 很长时间。

使用注入式 runner、fake clock、临时目录、本地 HTTP server 和合成媒体。

### 22.1 chunk/store

- 2 小时、6 小时 chunk plan；
- 半开区间无空洞；
- overlap ownership 无重复；
- manifest 最后发布；
- chunk 写到每个阶段崩溃后的恢复；
- reader 不看到半写 chunk；
- 旧布局仍可读。

### 22.2 job

- 工具立即返回 jobId；
- 状态原子更新；
- 排他锁；
- PID/heartbeat stale lock；
- cancel 杀进程树；
- URL/file resume 跳过 ready chunk；
- capture resume 产生 gap；
- 同 videoKey 并发拒绝；
- 不同 videoKey 状态隔离。

### 22.3 URL

- yt-dlp JSON 单 P 选择；
- descriptor 不落盘；
- cookie/token/签名 URL 不出现在索引和日志；
- Range server；
- 403 refresh；
- 429 有界退避；
- redirect 到私网拒绝；
- CRLF header 拒绝；
- 字节/时间/磁盘上限；
- 不支持 seek 时不拉整片；
- subtitle 优先跳过 ASR。

### 22.4 capture/CDP

- normal/pause/resume；
- seek 前后切块；
- rate change 切 mapping segment；
- hidden 但 currentTime 前进时不能视为暂停；
- CDP 断线降级；
- URL/part 变化切 session；
- 手动 region 参数；
- ddagrab crop 参数；
- recorder `.tmp`→正式 WAV；
- device invalidated；
- 停止时完整 flush。

### 22.5 ASR/speaker

- offsetMs；
- overlap 文本去重；
- 单块失败 global degraded；
- provisional speaker IDs；
- 不确定跨块 merge 保持 tentative；
- embeddings 不进入 query/package/log；
- identityBinding 不因纯音频而 false-ready。

### 22.6 query

- 6 小时合成索引只读取 top chunks；
- 时间问题定位正确 chunk；
- ASR-only “讲了什么”不为空；
- multimodal 每 speaker 至少一个代表（预算允许时）；
- citation 含 chunkId/revision/timeSource；
- 新 chunk 发布后 cache miss；
- context 服从硬 token budget；
- speakers/persons 数组受限。

### 22.7 cleanup/security

- dry-run 零写入；
- 错误确认零写入；
- 活跃 job 不删；
- 唯一恢复副本不删；
- 私网/本地协议拒绝；
- secrets redaction；
- 路径穿越拒绝。

## 23. benchmark 与验收

新增不进入默认 `npm test` 的 benchmark：

```powershell
npm run bench:video-index -- --duration-hours 6 --chunk-minutes 5
```

benchmark 输出机器信息、数据规模、读取 chunk 数、峰值内存、P50/P95，不要写死虚假性能结论。

功能验收：

1. 2 小时合成视频可后台规划并逐 chunk 提交；
2. kill worker 后 URL/file job 从未完成 chunk 恢复；
3. capture 中断产生 gap，不伪造连续；
4. query 只读取 top chunks；
5. context 不超过预算；
6. secrets 和 signed URL 不落盘；
7. 临时磁盘和下载字节受硬限制；
8. cleanup 不破坏活跃/可恢复 job；
9. 原有短视频测试全部通过；
10. npm 包包含新增运行时脚本和模块。

原方案中的以下数字只能作为 benchmark 目标，不能在未实测时宣称完成：

- 抓播时间误差 ≤2 秒；
- backlog ≤60 秒；
- 6 小时 query P95 <2 秒；
- speaker 跨块一致率 ≥90%；
- URL 索引 0.3～0.6× 实时。

必须在真实机器报告中注明硬件、媒体、adapter 和测量方法。

## 24. 文件改动建议

新增：

```text
src/video-index/chunk-plan.js
src/video-index/chunk-store.js
src/video-index/job-store.js
src/video-index/job-worker.js
src/video-index/job-controller.js
src/video-index/remote-media.js
src/video-index/capture-source.js
src/video-index/cdp-bridge.js
src/video-index/time-mapping.js
src/video-index/speaker-merge.js
scripts/loopback-recorder.py
scripts/bench-long-video.mjs
```

修改：

```text
src/capture.js
src/video-index/video-index-engine.js
src/video-index/index-store.js
src/video-index/index-retriever.js
src/video-index/context-builder.js
src/video-index/evidence-package.js
src/video-index/speaker-view.js
src/video-index/index-cleanup.js
src/video-index/adapters/bilibili-source.js
src/video-index/adapters/asr-adapter.js
src/video-index/adapters/pyannote-runner.js
scripts/audio-visual-runner.py
src/video-index-tool.js
README.md
package.json
```

可以根据现有架构合并模块，但不要把 job、chunk store、CDP、remote media 全塞进 `video-index-engine.js`。

## 25. 文档和用户提示

README 必须说明：

- URL 模式与 capture 模式差异；
- capture 会录制系统混音；
- 必须显式启动；
- CDP 的独立 profile/用户确认要求；
- 首次模型下载与 CPU 性能；
- 短视频同步、长视频后台；
- job status/cancel/resume；
- cleanup 和磁盘占用；
- DRM/付费内容不支持；
- embeddings 默认不持久化；
- 实测与估算的区别。

## 26. 完成后的强制验证

至少运行：

```powershell
npm test
npm pack --dry-run --json --ignore-scripts
python -m py_compile scripts/audio-visual-runner.py
python -m py_compile scripts/loopback-recorder.py
```

若 Python 路径来自项目虚拟环境，使用该解释器。

检查 npm pack 清单确实包含新增 worker、Python runner 和 benchmark 脚本，不包含：

- `.venv*`；
- token/cookie；
- 测试媒体；
- job 临时文件；
- 签名 URL；
- 私有 embeddings。

不要为了让测试通过而放宽安全检查或删除旧测试。

## 27. 最终交付格式

完成后输出：

1. 实际完成的 phase；
2. 修改文件清单；
3. chunk/job/schema 设计摘要；
4. 安全边界；
5. 新增测试；
6. `npm test` pass/fail；
7. `npm pack` 条目数和新增运行时文件确认；
8. Python 语法检查；
9. 是否运行真实 B 站、真实 CDP、真实 loopback、真实 ASR/pyannote；
10. 未实测指标必须明确标记“未实测”；
11. 尚存风险；
12. 是否执行 git commit。

没有真实网络、声卡、浏览器或模型权限时，完成可注入的生产实现和离线测试，但不得声称真实环境已验证。

请直接开始实施，不要先反问。遇到小型设计选择时按以下优先级决定：

```text
数据安全与隐私
→ 不丢失/不伪造证据
→ 可恢复性
→ 资源硬上限
→ 查询 token 成本
→ 向后兼容
→ 性能
→ 最小代码改动
```

