# 字幕优先长视频索引：最终方案与 Grok 实施任务书

本文分为两部分：

- 第一部分：供项目负责人审批的最终产品与架构方案。
- 第二部分：可直接复制给 Cursor 中 Grok 模型执行的完整实施任务书。

---

# 第一部分：最终方案

## 1. 目标

解决当前普通索引以固定 `maxFrames: 120` 抓取完整画面，导致长视频后段视觉覆盖不足，以及泛问只加载少量 chunk、难以代表整部视频的问题。

新架构采用：

> 全片字幕文本优先覆盖，语音能力由用户选择，完整画面按问题和视频类型按需补充，所有增强分析均受用户开关、预算和 revision 约束。

系统负责完整提供能力、开关、状态、提醒和成本估算；用户层负责决定启用哪些能力以及是否执行二次分析。

## 2. 不可违反的产品边界

1. “语音活动辅助”和“语音转文字”是两个独立授权项。
2. 环境中存在 `HF_TOKEN`、模型或 Python 依赖，不等于用户授权启用。
3. 视频类型可以由系统建议，但最终 profile 由用户选择。
4. 系统不得根据类型建议静默提高抓帧分辨率、密度或启用 ASR。
5. AI 逻辑复核只能生成问题清单、建议参数和预计成本。
6. 只有用户显式选择 `auto_once` 时，逻辑复核才允许自动执行一次局部重试。
7. 自动重试最多一次，只能修改白名单参数，只能处理指定时间窗。
8. 二次分析不得默认重跑整部视频。
9. 所有补充分析生成新的 evidenceId 和 revision，不覆盖旧证据。
10. 证据不足时返回 `insufficient`；来源冲突时返回 `conflict`。

## 3. 总体处理流程

```text
视频输入
  ↓
读取用户分析配置和预算
  ↓
探测现成字幕
  ├─ B站字幕
  ├─ 内嵌字幕轨
  ├─ 外挂 SRT/VTT
  └─ 没有现成字幕 → 低帧率字幕 ROI 扫描
                         ↓
                    字幕变化检测
                         ↓
                    候选帧 OCR
  ↓
形成全片带时间戳的字幕索引
  ↓
按 5 分钟 chunk 保存并建立全片 catalog
  ↓
生成低成本内容类型建议和能力提醒
  ↓
用户选择 profile、语音开关和是否二次分析
  ↓
AI 回答前先检索全片字幕/章节
  ↓
根据用户已授权能力补充局部画面、音频或说话人证据
  ↓
可选逻辑复核 → 输出建议或执行一次已授权的局部重试
  ↓
返回 supported / partially_supported / conflict / insufficient
```

## 4. 字幕来源优先级

按以下顺序获取文本：

1. B站官方字幕或平台字幕。
2. 视频内嵌字幕轨。
3. 用户提供的 SRT/VTT。
4. 烧录字幕 OCR。
5. 用户启用后的局部或全片 ASR。

来源必须保留：

```text
bilibili
native
external
ocr
asr_generated
```

存在可靠字幕轨时默认跳过 OCR。ASR 结果必须标记为 `asr_generated`，不得冒充原始字幕。

## 5. 烧录字幕扫描

没有字幕轨时，只低帧率解码字幕可能出现的 ROI，不在首次索引中批量保存完整画面。

默认建议：

```js
{
  subtitleFirst: true,
  subtitleScanFps: 1,
  subtitleRoi: "auto",
  fallbackSubtitleRoiHeightRatio: 0.45,
  maxOcrCandidatesPerMinute: 12
}
```

处理规则：

1. 优先自动探测字幕区域，失败后回退画面底部 45%。
2. 支持顶部字幕、双语字幕、竖屏和侧边字幕。
3. OCR 前先执行文字候选检测、画面差异和字幕变化门控。
4. 只有变化候选帧送入 OCR。
5. 同一句至少跨两个候选帧确认。
6. 使用规范化文本相似度合并重复字幕。
7. 水印、台标和长期固定文字不进入正文字幕。
8. OCR 候选帧默认不保存为完整画面证据。

每条最终字幕：

```js
{
  segmentId,
  startMs,
  endMs,
  text,
  confidence,
  language,
  source,
  roi,
  evidenceId,
  chunkId
}
```

## 6. 两个独立的语音开关

### 6.1 语音活动辅助

```js
{
  speechActivityAssist: {
    enabled: false,
    useVad: true,
    useSpeakerTiming: false
  }
}
```

它只判断是否存在语音、语音起止、可能的重叠语音和字幕缺口，不产生文字。

开启后可用于提醒：

- 有持续语音但没有字幕，建议复扫字幕 ROI。
- 字幕时间可能缺失。
- 某些时间窗可能需要 ASR。
- 多人轮流发言，可能适合启用说话人分析。

关闭后不得运行 VAD 或其他音频判断。

### 6.2 语音转文字

```js
{
  asr: {
    mode: "off"
  }
}
```

支持：

- `off`：完全不运行 ASR。
- `on_demand`：用户问题明确需要听觉证据时，分析局部时间窗。
- `fallback`：字幕复扫失败后，仅分析缺口时间窗。
- `full`：按 chunk 对全片执行 ASR。

向后兼容：

- 旧 `capabilities.asr: "off"` 映射为 `off`。
- 旧 `capabilities.asr: "auto"` 映射为 `fallback`，但只能在用户显式传入该值时生效。
- 旧 `capabilities.asr: "on"` 映射为 `full`。

不能因为检测到 token、模型或 runner 就自动从 `off` 变为其他模式。

## 7. 字幕缺口的逐级补救

根据用户授权执行：

1. 首次以 1 fps 扫描字幕 ROI。
2. 如果语音活动辅助已开启，检测到语音但无字幕，则产生“建议复扫”提醒。
3. 用户允许复扫后，对指定窗口提高到 2～4 fps，并扩大或重新探测 ROI。
4. 如果仍失败且 ASR 为 `fallback` 或 `full`，对缺口运行 ASR。
5. 如果 ASR 为 `off`，记录 gap 并返回能力提醒，不得偷偷转写。

“有语音”只能说明值得复查，不能证明画面中一定存在字幕。

## 8. 可选段尾稳定画面

```js
{
  captureUtteranceEndFrame: false
}
```

适合教程、软件操作、手工、游戏解说、PPT 和产品演示。默认关闭。

不是机械取最后一帧，而是在：

```text
[endMs - 1200ms, endMs + 300ms]
```

选择段尾稳定帧：

1. 排除黑帧、模糊帧和转场帧。
2. 优先选结束前最近的稳定画面。
3. 失败时选候选窗口中清晰度最高者。
4. 相邻话语画面近似时共用一个 frame evidence。
5. 受 `maxEndFramesPerChunk` 硬限制。

## 9. 5 分钟 chunk 与全片检索

保留 5 分钟 chunk 和约 20 秒 overlap。它是物理存储边界，不是章节边界。

必须保证：

- 跨块字幕和 ASR 依据时间中点归属并去重。
- 章节允许跨多个 chunk。
- 精确查询加载命中块及必要的相邻块。
- 泛问不能只读 Top 2～3 块。
- 全片总结先读取所有 chunk 的轻量 catalog，再按章节价值和时间覆盖选择代表块。
- 至少覆盖开头、中段、结尾和主要章节。
- 6 小时视频建议选择 8～16 个代表片段进行二级聚合。
- 超过 12 小时可增加 30～60 分钟的二级目录索引，底层仍保持 5 分钟 chunk。

## 10. 用户层内容 profile

系统完整实现所有 profile，但最终使用哪个 profile 由用户决定。

```js
{
  analysisProfile: "general",
  profileSuggestion: {
    enabled: true
  },
  secondPass: {
    mode: "off"
  }
}
```

`profileSuggestion.enabled` 只产生建议、理由、证据和成本，不自动应用参数。

`secondPass.mode` 支持：

- `off`：不二次分析。
- `ask`：返回建议，由用户确认。
- `auto_once`：用户预先授权后自动执行一次局部二次分析。

系统必须完整支持以下 profile：

- `general`：通用字幕优先。
- `visual_edit`：混剪、MV；提高镜头变化采样和完整画面密度。
- `handcraft`：手工、烹饪、维修；以手、工具和工作区域为任务中心。
- `anime`：番剧、动画；重视对白语气、人物表情和反应镜头。
- `film`：电影、电视剧；重视场景建立、人物关系、对白和关键动作。
- `screen_tutorial`：软件教程；提高 UI 分辨率，抓操作前后和结果画面。
- `slides_lecture`：PPT、课程；以换页为主要抓帧点，强化图表/公式 OCR。
- `interview`：访谈、播客；重视 speaker 与观点，降低普通画面密度。
- `talking_head`：单人口播；字幕为主，只补板书、插图和屏幕展示。
- `gameplay`：游戏；重视 HUD、得分、任务、胜负和语气峰值。
- `sports`：赛事；重视计分板、回放和动作前后，不把解说时间当事件时间。
- `news_documentary`：新闻、纪录片；识别姓名条、地点条，区分采访、旁白和资料画面。
- `product_review`：评测、开箱；重视产品特写、型号、接口和对比画面。
- `vlog`：旅行、生活；以地点、人物和活动变化组织内容。
- `music_stage`：音乐、演唱会；根据段落、舞台变化和表演者抓帧。
- `surveillance_timelapse`：监控、延时、无对白；以运动和状态变化为主，跳过字幕假设。

允许主 profile 加次 profile，但配置优先级必须为：

1. 用户显式参数。
2. 安全和预算硬限制。
3. 主 profile。
4. 次 profile 的局部补充。
5. 系统建议，不自动生效。

## 11. AI 逻辑复核

```js
{
  postAnalysisAudit: {
    enabled: false,
    retryMode: "ask",
    maxRetries: 1
  }
}
```

复核检查：

- 字幕是否大量断裂或重复。
- 是否存在长时间语音但无文本（仅在语音辅助已授权时）。
- OCR 是否主要识别成水印、台标或弹幕。
- 章节是否只覆盖视频前段。
- 字幕时间是否异常重叠或逆序。
- 关键章节是否没有证据。
- 同一专名是否存在大量不同写法。
- 字幕、ASR 和画面是否有未报告冲突。
- 现有分析参数是否明显不适合用户选择的 profile。

`retryMode`：

- `off`：只给复核报告。
- `ask`：给出局部重试计划，等待用户确认。
- `auto_once`：用户预先授权后自动执行一次。

白名单参数：

- 指定窗口字幕扫描 fps，硬顶 4 fps。
- 扩大或重新探测字幕 ROI。
- 指定窗口画面分辨率。
- 指定窗口抓帧密度。
- 音频切片前后文长度。
- OCR 语言和双语分行策略。
- 场景变化敏感度。
- 画面去重阈值。
- 只有 ASR 模式允许时，才能建议/执行局部 ASR。

禁止：

- 无限重试。
- 自动重跑整片。
- 自动启用未授权 ASR/VAD/diarization。
- 删除或覆盖旧证据。
- 自动下载额外模型。
- 把逻辑推测写成识别结果。

## 12. 用户提醒机制

索引结束和查询需要补证时返回非阻塞提醒：

```js
{
  recommendations: [
    {
      code: "PROFILE_SUGGESTION",
      severity: "info",
      title: "可能是软件教程",
      reason: "画面文字密度高且界面变化集中",
      suggestedAction: "select_profile",
      suggestedValue: "screen_tutorial",
      estimatedCost: {
        extraFrames: 24,
        extraAudioSeconds: 0
      },
      requiresUserApproval: true,
      evidenceIds: ["..."]
    }
  ]
}
```

提醒必须可解释、可忽略、可追溯、带预计成本。不能用提醒绕过权限。

## 13. 三源证据融合

不采用简单多数投票：

- “说了什么”：字幕为主，ASR 校验。
- “画面是什么”：完整画面为主，字幕负责定位。
- “谁在说”：speaker 时间段、脸轨迹和主动说话证据共同判断。
- “何时发生”：返回多来源重叠时间范围。
- “边说边演示什么”：文本给意图，操作前后/段尾稳定帧给结果。
- “人物与观点绑定”：必须同时具备话语、speaker 和人物证据。
- “全片讲了什么”：全片章节为主，只补关键视觉段。

统一证据包：

```js
{
  segmentId,
  timeRange: { startMs, endMs },
  subtitleEvidenceIds: [],
  asrEvidenceIds: [],
  frameEvidenceIds: [],
  speakerIds: [],
  confidence,
  conflicts: []
}
```

统一判断状态：

- `supported`
- `partially_supported`
- `conflict`
- `insufficient`

## 14. 建议的完整用户配置

```js
{
  subtitleFirst: {
    enabled: true,
    scanFps: 1,
    retryScanFps: 3,
    retryScanFpsHardMax: 4,
    roi: "auto",
    fallbackRoiHeightRatio: 0.45,
    maxOcrCandidatesPerMinute: 12
  },

  speechActivityAssist: {
    enabled: false,
    useVad: true,
    useSpeakerTiming: false
  },

  asr: {
    mode: "off"
  },

  analysisProfile: {
    primary: "general",
    secondary: []
  },

  profileSuggestion: {
    enabled: true
  },

  secondPass: {
    mode: "off",
    maxPasses: 1
  },

  postAnalysisAudit: {
    enabled: false,
    retryMode: "ask",
    maxRetries: 1
  },

  captureUtteranceEndFrame: {
    enabled: false,
    maxPerChunk: 12
  },

  budgets: {
    maxRefineWindows: 2,
    maxRefineWindowsHardLimit: 3,
    maxAudioSecondsPerWindow: 30,
    maxSecondPassCostRatio: 0.5
  }
}
```

## 15. 验收标准

1. 30 分钟、2 小时和 6 小时视频尾部字幕均可检索。
2. 最后 10% 时间范围内的测试关键词命中率为 100%。
3. 全片泛问覆盖开头、中段、结尾和主要章节。
4. 有可靠字幕轨时不运行 OCR。
5. OCR 只处理变化候选帧，重复字幕正确合并。
6. `speechActivityAssist.enabled:false` 时不运行 VAD。
7. `asr.mode:off` 时任何路径都不能运行 ASR。
8. ASR 四种模式行为分别有测试覆盖。
9. profile 建议不会自动应用。
10. `secondPass.mode:ask` 只返回计划，不写盘。
11. `auto_once` 最多执行一次局部分析。
12. AI 复核不能调整白名单外参数。
13. 纯总结查询默认返回 0 张图片。
14. 视觉问题能补充命中时间附近的完整画面。
15. 每条证据可追到 evidenceId、chunkId、revision 和 provenance。
16. 冲突返回 `conflict`，媒体/预算不足返回 `insufficient`。
17. 现有测试全部通过，新增长视频覆盖、权限和重试测试。

---

# 第二部分：可直接提交给 Cursor/Grok 的实施任务书

以下内容可以原样复制给 Grok：

```text
你正在修改 sense-now 项目。请直接检查现有代码并完成实现，不要只给方案，不要生成伪代码，不要跳过测试。

项目基线：
- Node.js ESM，Node >= 20。
- 当前主要实现位于 src/video-index/。
- 现有核心文件包括：
  - src/video-index/video-index-engine.js
  - src/video-index-tool.js
  - src/video-index/index-retriever.js
  - src/video-index/context-builder.js
  - src/video-index/chunk-store.js
  - src/video-index/index-store.js
  - src/video-index/media-extract.js
  - src/video-index/storyboard-indexer.js
  - src/video-index/adapters/subtitle-adapter.js
  - src/video-index/adapters/ocr-adapter.js
  - src/video-index/adapters/asr-adapter.js
  - src/video-index/schema.js
- 当前普通索引仍有固定 maxFrames:120 的前段视觉偏置，不能用简单提高该值解决。
- 当前长视频已有 5 分钟 chunk、20 秒 overlap、catalog、两级检索、staging、revision/evidence、SSRF/Range 预算和 cancel 终态保护。必须复用且不得破坏。
- 开始前先运行 npm test，记录真实基线；交付时全部现有测试和新增测试必须通过。

总目标：
实现“全片字幕优先、语音能力独立授权、完整画面按需补充、用户选择视频 profile、AI 复核受限重试”的长视频索引。系统完整实现所有能力、开关、提醒和成本估算，但视频类型、语音能力和二次分析是否启用由用户层决定，禁止静默启用。

一、配置与向后兼容

新增统一 analysisPolicy（工具层传 JSON，engine/index/indexAdaptive/job/capture/refine 全链路透传并持久化规范化后的 effective policy）：

{
  subtitleFirst: {
    enabled: true,
    scanFps: 1,
    retryScanFps: 3,
    retryScanFpsHardMax: 4,
    roi: "auto",
    fallbackRoiHeightRatio: 0.45,
    maxOcrCandidatesPerMinute: 12
  },
  speechActivityAssist: {
    enabled: false,
    useVad: true,
    useSpeakerTiming: false
  },
  asr: { mode: "off" },
  analysisProfile: { primary: "general", secondary: [] },
  profileSuggestion: { enabled: true },
  secondPass: { mode: "off", maxPasses: 1 },
  postAnalysisAudit: { enabled: false, retryMode: "ask", maxRetries: 1 },
  captureUtteranceEndFrame: { enabled: false, maxPerChunk: 12 },
  budgets: {
    maxRefineWindows: 2,
    maxRefineWindowsHardLimit: 3,
    maxAudioSecondsPerWindow: 30,
    maxSecondPassCostRatio: 0.5
  }
}

要求：
1. 新建 policy normalize/validate 模块；所有数字有合理默认值和硬顶，拒绝 NaN、Infinity、1e9 等绕过。
2. 未传 analysisPolicy 时保持兼容，不改变已有用户行为，但不得仅因 HF_TOKEN/runner/model 存在而自动启用新语音能力。
3. 旧 capabilities.asr 映射：off→off，auto→fallback，on→full。只有调用方显式传值才映射。
4. speechActivityAssist 与 asr 完全独立；关闭 speechActivityAssist 后不得执行 VAD；asr.mode=off 后任何路径不得调用 ASR adapter。
5. secondPass.mode 和 postAnalysisAudit.retryMode 仅允许 off/ask/auto_once；auto_once 代表用户预授权，仍最多一次。

二、全片字幕来源与字幕优先索引

实现统一 subtitle source coordinator，优先级：B站/平台字幕 → 内嵌字幕轨 → subtitlePath/SRT/VTT → 烧录字幕 OCR → 已授权 ASR。

建议新增：
- src/video-index/subtitle-source.js
- src/video-index/subtitle-band-scanner.js
- src/video-index/subtitle-segment-builder.js

要求：
1. 有可靠时间戳字幕时跳过字幕 OCR。
2. 没有字幕轨时，用 FFmpeg 低帧率解码字幕 ROI；首次不要批量保存完整画面。
3. 自动 ROI 探测不可用时回退底部 45%，并允许顶部、双语、竖屏/侧边字幕。
4. OCR 前执行字幕候选检测、变化门控和去重；只有变化候选调用 ocr adapter。
5. 多帧投票确认字幕时间；规范化空格/标点后按文本相似度合并。
6. 排除长期固定水印、台标和重复弹幕。
7. 生成 subtitle segments：segmentId/startMs/endMs/text/confidence/language/source/roi/evidenceId/chunkId。
8. provenance 必须区分 bilibili/native/external/ocr/asr_generated。
9. OCR 仍走可注入 adapter；没有真实 runner 时 capability=unavailable，测试用 fake runner，不伪造 ready。
10. 不能把任意 Buffer 冒充图片；沿用项目现有 raw→encodePng 边界。

三、语音活动辅助和 ASR 独立授权

实现或接入 audio activity adapter，至少支持 VAD 时间段协议，可注入 fake runner。

要求：
1. speechActivityAssist.enabled=false 时零调用、零音频抽取、capability=skipped/disabled，不是 ready。
2. enabled=true 时只输出 speech ranges/gaps/recommendations，不产生文本。
3. 检测到持续语音而无字幕时，只产生复扫建议；不能直接证明有画面字幕。
4. asr.mode=off：任何 index/query/refine/audit/second-pass 路径都禁止 ASR。
5. on_demand：仅显式需要听觉证据的 query/refine 时间窗调用。
6. fallback：字幕 ROI 复扫失败且有授权条件时，只分析缺口。
7. full：按 chunk 分析全片，复用 overlap 去重和证据映射。
8. ASR 结果 source=asr_generated；不覆盖原字幕。
9. 音频切片使用现有 extractAudioWav/cropWavRange 等安全路径，禁止整片重复抽取。

四、5 分钟 chunk 和全片检索

保留 5 分钟 chunk + 20 秒 overlap，不把 chunk 当章节。

修复检索：
1. 精确问题先扫轻量 catalog，加载命中块和必要的相邻块。
2. text_structure/“整个视频讲了什么”不能只加载 Top 2～3 chunk。
3. 新增全片层级检索：读取全部 chunk 的轻量章节/topic/coverage，按章节价值和时间分布选代表块。
4. 至少覆盖开头/中段/结尾；每个主要章节至少一个代表块；片尾总结不能被前段挤掉。
5. 代表块数量受硬预算控制；6h 默认建议 8～16，但不能一次把所有正文交给模型。
6. 跨块字幕/ASR/章节按现有 midpoint ownership 与 evidence 去重。
7. catalog 增加 subtitleCoverage、textConfidence、gapCount、profileHints 等轻量字段，不把完整证据塞入 catalog。

五、按需完整画面与段尾稳定帧

首次字幕索引不再依赖普通路径固定 maxFrames:120 作为全片视觉覆盖。保留 zoom/按需抓帧，并新增按时间窗抽取完整画面的通用方法。

captureUtteranceEndFrame.enabled=true 时：
1. 在 [endMs-1200,endMs+300] 选候选帧。
2. 排除黑帧、模糊帧、转场帧。
3. 优先段尾前最近稳定帧，否则选清晰度最高者。
4. 相邻画面感知相似时去重，多个 segment 可引用同一 frame evidence。
5. maxPerChunk 默认 12 且有硬顶。
6. 默认 false；profile 建议不得自动打开，只有 effective policy 明确开启才执行。

六、用户层 profile 与提醒

实现完整 profile policy 库，但不要自动应用建议。建议新增：
- src/video-index/profile-policy.js
- src/video-index/profile-suggester.js

必须支持 primary/secondary：general、visual_edit、handcraft、anime、film、screen_tutorial、slides_lecture、interview、talking_head、gameplay、sports、news_documentary、product_review、vlog、music_stage、surveillance_timelapse。

每个 profile 定义：
- 字幕/OCR重点
- 建议的画面分辨率和采样策略
- ROI/任务中心（如 handcraft 的手、工具、工作台）
- 场景变化阈值
- 段尾帧是否建议
- 推荐的可选音频能力
- 查询补证策略

profileSuggestion.enabled=true 时，只返回 recommendations：code/severity/title/reason/suggestedAction/suggestedValue/estimatedCost/requiresUserApproval/evidenceIds。

不得：
- 自动切 profile。
- 自动启用 ASR/VAD/diarization。
- 自动二次分析，除非 secondPass.mode=auto_once。

配置优先级：用户显式值 > 安全/预算硬限制 > primary profile > secondary profile > suggestion（不生效）。

七、二次分析和 AI 逻辑复核

建议新增：
- src/video-index/evidence-auditor.js
- src/video-index/refinement-planner.js

复核检查字幕断裂/重复、时间逆序、前段覆盖偏置、章节无证据、OCR 水印污染、专名不一致、已授权情况下的 speech-without-text、字幕/ASR/画面冲突、当前参数与用户 profile 是否不匹配。

要求：
1. auditor 本身输出结构化 issues 和 retryPlan，不直接修改索引。
2. retryMode=off/ask 时不得写盘、不得抓帧、不得抽音频。
3. retryMode=auto_once 才可执行一次；必须有 attempt/revision 守卫，崩溃恢复后不能重复自动执行。
4. 只允许局部时间窗；maxRefineWindows 默认 2、硬顶 3。
5. 只能调整白名单：局部 scan fps（硬顶4）、ROI、局部分辨率/密度、音频上下文、OCR语言/双语、scene threshold、dedupe threshold。
6. ASR 不在有效模式时，retryPlan 可以提醒用户开启，但不能执行。
7. 新结果写新 revision，先 staging 后原子发布；旧证据和 provenance 保留。
8. 比较覆盖率、置信度、gap、重复率和冲突数；没有改善时保留旧 revision 为优先版本并报告原因。

八、证据融合与状态

新增/扩展 evidence bundle：segmentId/timeRange/subtitleEvidenceIds/asrEvidenceIds/frameEvidenceIds/speakerIds/confidence/conflicts。

不要多数投票：口述内容以字幕/ASR为主，视觉事实以画面为主，谁在说需 speaker 时间段+脸轨迹+主动说话证据。无法裁决时保留各来源并返回 conflict。

查询/上下文返回 judgementState：supported/partially_supported/conflict/insufficient。

修复所有 evidenceId 关联：如果补证时重写 evidenceId，utterance/segment/event/timeline/evidence bundle 必须一起更新；增加回归测试保证引用可解析。

九、存储、schema 和 capability

按现有 index/chunk 布局扩展（名称可根据现有风格微调）：
- subtitle-segments.json
- coverage.json
- recommendations.json
- refinements/<revision>.json 或等价受控结构

coverage 至少包含 durationMs/scannedRanges/textRanges/gaps/coverageRatio/confidenceP50/status。

capabilities 增加或等价表达：subtitleText、subtitleOcr、speechActivityAssist、asr、onDemandVisual、onDemandAudio、profileSuggestion、evidenceAudit。只在真实执行成功后 ready；关闭为 skipped/disabled；adapter 不可用为 unavailable；部分失败为 degraded。

所有 schema 需界限校验；保持旧索引可读。索引版本/布局版本变化要使 query cache 正确失效。

十、工具层和用户提醒

video_index 工具增加 analysisPolicy JSON 透传，以及明确的二次分析确认入口。优先复用 refine action；如果新增 action，必须更新 tool schema、帮助文本和 README。

ask 模式返回计划和 confirmation token/plan hash；执行时要求精确匹配，防止确认过期计划或参数被替换。错误/缺失确认不得写盘。

返回 effectivePolicy、capabilities、coverage 摘要、recommendations、estimatedCost、实际 cost、revision 和 judgementState。提醒必须非阻塞、可忽略、可追溯。

十一、安全与成本

1. 继续使用现有 URL allowlist、DNS pin、Range proxy、DOWNLOAD_LIMIT、TEMP_LIMIT、bounded stdio、进程树取消和 staging 原子发布。
2. 不增加 shell 拼接；spawn 参数使用数组。
3. 所有新 runner 限 stdout/stderr、超时、AbortSignal 和 schema。
4. 所有循环、fps、候选数、重试数、窗口数、分辨率、音频秒数设硬顶。
5. cancel 在字幕扫描、OCR、VAD、ASR、补帧、audit、commit 前后都检查，cancelled 不得被 ready 覆盖。
6. 默认不持久化 speaker embeddings；不得把 embedding 放入 query context。
7. 不记录或输出 token/密钥。

十二、测试

在保持全部现有测试通过的基础上新增至少以下测试：

A. 字幕来源
- 原生/B站/SRT存在时跳过OCR。
- 无字幕时ROI扫描覆盖全片末尾。
- 字幕变化才调用OCR。
- 水印固定文字被排除。
- 双语/顶部/竖屏ROI。

B. 权限
- speechActivityAssist=false 时VAD零调用。
- asr.mode=off 在index/query/refine/audit/second-pass中ASR均零调用。
- on_demand/fallback/full行为分别正确。
- HF_TOKEN存在也不能改变effective policy。

C. 长视频
- 30m/2h/6h最后10%关键词可检索。
- 泛问覆盖开头/中段/结尾和主要章节。
- 5分钟chunk边界字幕去重且章节可跨块。

D. 段尾稳定帧
- 默认关闭零抓帧。
- 排除黑帧/模糊/转场。
- 相似帧去重。
- maxPerChunk硬顶。

E. profile与提醒
- 所有profile可validate。
- suggestion只返回建议，不改变effective policy。
- 用户显式参数优先。
- estimatedCost和evidenceIds存在。

F. audit/second pass
- off/ask无写盘副作用。
- auto_once只执行一次，重启/恢复不重复。
- 白名单外参数拒绝。
- 过期/错误plan hash拒绝且不写盘。
- 新revision失败时旧ready仍可读。

G. 证据
- subtitle/asr/frame evidence保持独立。
- 重写evidenceId后所有引用一致且可查询。
- conflict/insufficient正确返回，不编造答案。

H. 安全/预算
- NaN/Infinity/1e9无法绕过。
- cancel终态。
- runner超时和stdout上限。
- 下载预算与现有SSRF测试不回归。

十三、文档和打包

更新 README：
- 解释所有开关默认值。
- 明确系统建议不会自动生效。
- 给出最省资源、推荐、自动一次、深度分析四种示例，但不要把高成本模式设为默认。
- 明确真实 OCR/ASR/VAD/AI auditor 需要用户配置 adapter。

检查 package.json files 和 npm pack --dry-run --json --ignore-scripts；新增运行时文件必须打包，不能包含 __pycache__/.pyc/临时媒体/模型/token。

十四、交付要求

直接修改代码并运行测试。不要执行 git commit。

最终报告必须包含：
1. 实际修改文件清单。
2. 配置默认值和向后兼容说明。
3. 字幕扫描、权限、profile、二次分析的数据流。
4. capability和存储结构。
5. 新增测试列表。
6. npm test真实 pass/fail。
7. npm pack条目数及排除项检查。
8. benchmark结果，并明确合成还是真实媒体。
9. 哪些真实组件未实测。
10. 尚存风险。

禁止只汇报“完成”。没有真实runner或硬件时，使用协议级fake完成自动测试，并明确标注真实OCR/ASR/VAD/媒体质量未验证。
```

