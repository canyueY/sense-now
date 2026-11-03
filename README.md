# Sense Now（见闻）

[![CI](https://github.com/canyueY/sense-now/actions/workflows/ci.yml/badge.svg)](https://github.com/canyueY/sense-now/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933.svg)](https://nodejs.org/)

**让 Agent 不只能看见视频开头，而是能遍历整部视频、按问题回到证据，并在用户授权后补看画面、补听音频。**

Sense Now 是一个面向 [DSH](https://github.com/deepseek-ai) 的本地多模态插件，包含两条彼此独立的工作流：

| 工具 | 职责 | 典型场景 |
|---|---|---|
| `sense_now` | 实时陪看屏幕 / 摄像头 / 本地文件；筛帧拼图；`say` 进悬浮窗 | 一边操作一边讲解、看直播/教程 |
| `video_index` | 本地或 B 站视频一次建索引、多次问答；文本优先，音画按需 | 长访谈、讲座、录播回看 |

### 速览

| 项 | 值 |
|---|---|
| 版本 | `0.1.0`（包名 `sense-now`，旧名 `dsh-see-now` / `see_now` 仅作兼容回退） |
| 运行时 | Node.js ≥ 20；DSH desktop profile |
| 平台 | Windows-first（屏幕采集用 `ddagrab` / `gdigrab`），索引与检索跨平台 |
| 外部依赖 | FFmpeg / ffprobe（必需）、yt-dlp（仅 B 站）、Python 组件（全部可选） |
| 测试基线 | **61 个 `*.test.mjs` / 303 项测试 / 0 失败**，CI 双平台 |
| 许可 | Apache-2.0 |

> 这是开发版：单元测试与合成 benchmark **不能**解读为所有媒体、OCR、声卡和 B 站 CDN 都已实机验证。
> 第 13 节把“测了什么、没测什么、实测数字是多少”分开写清楚了。

## 目录

- [1. 为什么重新设计](#1-为什么重新设计)
- [2. 核心能力](#2-核心能力)
- [3. 安装](#3-安装)
- [4. 快速开始：长视频索引](#4-快速开始长视频索引)
- [5. 实时陪看 `sense_now`](#5-实时陪看-sense_now)
- [6. `analysisPolicy`](#6-analysispolicy)
- [7. `video_index` actions](#7-video_index-actions)
- [8. Agent 协议要点](#8-agent-协议要点)
- [9. 可选本地组件](#9-可选本地组件)
- [10. 环境变量](#10-环境变量)
- [11. 抓播与取消语义](#11-抓播与取消语义)
- [12. 存储、原子性与安全边界](#12-存储原子性与安全边界)
- [13. 测试与验证（实测分析）](#13-测试与验证实测分析)
- [14. 仓库结构](#14-仓库结构)
- [15. 作为 Node.js 库使用](#15-作为-nodejs-库使用)
- [16. 开发](#16-开发)
- [17. 已知限制](#17-已知限制)
- [18. 开源来源与许可](#18-开源来源与许可)

## 1. 为什么重新设计

原始的长视频方案主要依赖有上限的全片抓帧。当视频变长时，固定帧数会让采样越来越稀，甚至只保留开头部分；
同时，把整部视频的所有字幕或图像一次性塞进上下文，也会快速消耗 token。

Sense Now 改用「**全片建索引，问题驱动补证据**」：

```text
视频来源
  ↓
字幕协调器（B 站字幕 / 外挂字幕 / 内嵌文本轨 / 流式 OCR / ASR fallback）
  ↓
5 分钟 core chunk + 20 秒输入重叠
  ↓
chunk catalog + 带时间戳的 evidenceId + coverage
  ↓
查询路由（文本 / 时间 / 视觉 / 音画 / 深度）
  ↓
只加载命中 chunk；必要时 zoom 或生成一次性 refinement 计划
```

这里的 5 分钟不是“只看 5 分钟”，而是将整部视频拆成可原子提交、可重试、可局部检索的小段。
例如 2 小时视频约 24 个 core chunk；6 小时约 72 个。

### 时长路由

`execution:"auto"` 在时长超过约 **12 分钟**（`SYNC_SAFE_MS`）时走后台 job，立即返回 `jobId`；更短则同步 `index`。
也可显式 `sync` / `background`。

> 实现细节：`execution:"sync"` 在本仓库走的是 **chunk 布局**（分块、可增量、可 `job_resume`），
> 不是旧的整片 monolithic 路径；只有 `auto` 且时长低于阈值时才走 monolithic。

## 2. 核心能力

### 2.1 字幕优先，不做无意义重复识别

显式传入 `analysisPolicy`（包括 `{}`）后，索引器进入字幕优先路径。实际优先级是：

1. B 站解析结果中的官方字幕。
2. 调用方已提供的字幕数据。
3. 外部 `SRT` / `VTT` / `ASS` / `SSA` 文件。
4. 媒体内嵌文本字幕轨；位图字幕轨会标记降级，而不会冒充文本。
5. 无可靠字幕轨时，按 chunk 低帧率解码画面底部 ROI，字幕发生变化的候选帧才调用 OCR。
6. 字幕/OCR 仍存在缺口且用户开启 `fallback` 或 `full` 时，才调用 ASR。

分层约束：

- **视频级**：只探测 / 下载官方、内嵌、外挂字幕（`probeOnly`）；后台长视频路径**不**在视频级跑全片 OCR。
- **chunk 级**：OCR 严格落在 `[startMs, endMs)`；无可靠字幕时每个 chunk 原则上只启动一次 OCR FFmpeg。
- 字幕轨缓存与 chunk OCR 缓存分离；不得把首块 OCR 结果当成整部视频的字幕轨。

OCR 读取是**真流式**的：FFmpeg rawvideo 按帧消费，不全量缓冲 stdout（默认 ROI 下 5 分钟 × 1 FPS 约 93 MB 吞吐，
旧的 64 MB 整段缓冲会误杀）。预算触顶或 abort 时会杀掉进程树并返回 `truncated` / `AbortError`。

### 2.2 全片覆盖，查询时只读命中部分

- chunk core 默认 5 分钟，输入窗口在两侧各带最多 20 秒 overlap。
- overlap 中的发言以时间中点决定所属 core chunk，再按文本、说话人与时间重叠去重。
- `chunks/catalog.json` 只保留受限摘要、时间范围、说话人簇、coverage 和 revision，查询时不需把整库读进内存。
- “整个视频讲了什么”之类泛问会按时间覆盖选取代表块，不是只返回开头的 Top 2–3 个命中。
- 文本问题默认不附图；视觉问题优先复用 Storyboard，不足时再在命中时间附近 `zoom`。

### 2.3 字幕、音频、画面三者互补

- **字幕**：承担全片结构、主题、关键段与文本检索。
- **画面**：用于按钮、界面、图表、人物、手部操作、场景和视觉剪辑。
- **语音活动辅助（VAD）**：只判断某个时间窗口是否有人说话，不会转写内容。
- **ASR**：将音频转成文本，是与 VAD 分开的独立授权项。
- **Diarization**：产生匿名说话人簇和活动时间段；不等于知道现实中是谁。
- **Identity binding**：只有脸部/画面/音画时间证据足够时才能从 `tentative` 升级。纯音频不得标记 `ready`，
  也不会把单一音色自动写成“UP 主本人”。

### 2.4 证据可追溯，补充分析不静默覆盖

字幕、ASR、画面、音频和事件都生成独立 `evidenceId`、逻辑 `evidence://` 引用、时间范围、`contentHash`、
`revision` 与 `provenance`。局部 ASR、补抓画面或二次分析会追加新 revision，原始字幕证据保留。
`full` evidence package 必须提供精确时间范围或 `evidenceIds`，禁止无范围展开整部视频。

### 2.5 二次复核与按需 ASR 有明确边界

二次分析（`secondPass` / `postAnalysisAudit`）：

- `off`：不产生自动复核。
- `ask`：只返回计划，只有回传精确 `planHash` 才会执行。
- `auto_once`：最多一次、受预算限制的局部重试，只能调整白名单参数。

按需 ASR（`asr.mode=on_demand`）：

- `query` 发现需要局部转写时，返回 `refinement`（含 `planHash`），并把计划**落盘**。
- Agent 必须调用公开 action `execute_refinement`，不得臆造引擎内部函数名。
- 同一 `planHash` 幂等；`asr.mode=off` 时所有公开入口零 ASR 调用。
- VAD 授权 ≠ ASR 授权；`HF_TOKEN` / 本地模型存在不改变 effective policy。

### 2.6 查询结果就是可引用的证据

`query` 的模型可见文本里直接给出 `[mm:ss–mm:ss] 台词 (EVID_xxx)`、章节与截断说明，
不是只返回“命中 20 条”的计数；视觉问题则返回帧号与时间戳，必要时再 `zoom` 取图。
证据不足时明确写“证据不足”，不会编造引用。

## 3. 安装

### 3.1 前置条件

- Node.js 20 或更高版本。
- DSH desktop profile。
- FFmpeg / ffprobe：本地媒体时长探测、内嵌字幕、抽音频和按需帧依赖它们。
- yt-dlp（可选）：索引 B 站链接时使用；可用 `DSH_YTDLP_PATH` 指定路径。
- Python 组件（全部可选）：faster-whisper、pyannote.audio、loopback backend。

### 3.2 安装到 DSH

```bash
git clone https://github.com/canyueY/sense-now.git
cd sense-now
node scripts/install-dev.mjs
```

`install-dev` 会把包复制到 DSH desktop profile、注册 `sense-now`，并移除旧的 `dsh-see-now` 注册，
避免两个插件重复注册工具。完成后重启 DSH。

```bash
node scripts/install-dev.mjs --check   # 只检查
node scripts/install-dev.mjs --remove  # 卸载 Sense Now
```

安装只复制插件运行时（约 2–3 MB）：`视频输出/`、`素材图/`、`.tmp/`、`venv`、`torchinductor_*`、
`__pycache__` 与本地产物目录都在跳过名单里，不会把几 GB 的素材带进 profile。

Windows PowerShell 下同样可用上述命令；若默认 `python` 无依赖，请为 Whisper / pyannote / loopback
分别设置对应的 `DSH_*_PYTHON`。

### 3.3 验证安装

```bash
node scripts/install-dev.mjs --check
# profile   : C:\Users\<you>\.dsh\profiles\desktop
# sense-now: 已安装  bundles 已注册
```

重启后让模型调用 `sense_now({ action: "status" })` 或 `video_index({ action: "list" })` 确认工具已加载。

## 4. 快速开始：长视频索引

### 4.1 本地视频

```js
video_index({
  action: "index",
  source: "file",
  path: "D:/videos/long-talk.mkv",
  execution: "auto",
  analysisPolicy: {}
})
```

`analysisPolicy: {}` 表示显式启用字幕优先默认值：ASR 关闭、VAD 关闭、段尾帧关闭，profile 只建议不自动应用。
如果完全不传 `analysisPolicy`，则保留兼容的旧版 Storyboard 行为。

长视频可能立即返回 `jobId`：

```js
video_index({ action: "job_status", jobId: "..." })
video_index({ action: "job_cancel", jobId: "..." })
video_index({ action: "job_resume", jobId: "..." })  // 跳过已 ready 的 chunk
```

可选：外挂字幕 `subtitlePath: "D:/subs/talk.srt"`；强制重建 `rebuild: true`（chunk 布局下会清掉旧帧并重跑全部 chunk）。

### 4.2 B 站视频

```js
video_index({
  action: "index",
  source: "bilibili",
  url: "https://www.bilibili.com/video/BV...",
  execution: "background",
  analysisPolicy: { asr: { mode: "off" } }
})
```

B 站模式只接受受控 HTTPS 域名，拒绝 `b23.tv`、裸 IP、localhost 和内网地址。签名 URL、Cookie 和 token
不进入模型上下文，也不写入索引。需要 Storyboard 或本地 ASR 时，必须显式 `cacheMedia: true` 并评估下载成本。
多分 P 可用 `partId`（默认 `p1`）。

### 4.3 查询全片

```js
video_index({
  action: "query",
  videoKey: "file:...:long-talk.mkv",
  question: "整个视频的主要论点和结论是什么？",
  mode: "auto"
})
```

查询路由是确定性的，不需要额外模型：

| mode | 用途 |
|---|---|
| `text` | 主题、章节、说了什么 |
| `time` | 时间戳、第几分钟、开头或结尾 |
| `visual` | 画面、界面、颜色、按钮、图表、人脸或穿着 |
| `multimodal` | 谁在说话、音画是否一致、口型/声音/画面关系 |
| `deep` | 详细分析、比较、复核或证据审计 |
| `auto` | 根据问题词路由到上述类型 |

时间词可以直接问：`第 12 分钟`、`03:20`、`片尾`、`开头`——「片尾/结尾/最后」会换算成 `时长-1ms`，
命中最后一块；「开头/开始」命中第一块。

### 4.4 按需补画面

```js
video_index({
  action: "zoom",
  videoKey: "...",
  startMs: 1019000,
  endMs: 1022000,
  roi: { x: 0, y: 0, width: 1280, height: 720 }
})
```

`timestampMs` 保持视频绝对时间，不会在非零 seek 后重复叠加 chunk 偏移。
`onDemandVisual` 为 `ready` 表示媒体可访问且 FFmpeg/提取器已探针通过；无媒体、无提取器或 policy 禁用时
分别为 `unavailable` / `disabled`，不会因“有默认函数名”就标 ready。

### 4.5 确认局部 ASR refinement

当 `query` 返回 `refinement.status="pending_confirmation"` 时：

```js
video_index({
  action: "execute_refinement",
  videoKey: "...",
  planHash: refinement.planHash,
  confirmation: true
})
```

必须使用查询返回的精确 `planHash`。同一 hash 幂等，不会重复运行 ASR。支持 **monolithic index** 与
**chunk catalog** 两种布局；跨 chunk 窗口按 utterance 中点唯一归属。

### 4.6 取证与清理

```js
// 最小引用包
video_index({ action: "evidence", videoKey: "...", evidenceIds: ["ev_..."] })

// Full package：必须带精确范围或 ids
video_index({
  action: "evidence",
  videoKey: "...",
  package: "full",
  startMs: 600000,
  endMs: 660000
})

// 清理临时文件与查询缓存；删索引需双重确认
video_index({ action: "cleanup", dryRun: true })
video_index({
  action: "cleanup",
  maxAgeMs: 30 * 24 * 3600 * 1000,
  confirmDelete: true,
  confirmVideoKeys: ["file:...:old.mkv"]
})
```

## 5. 实时陪看 `sense_now`

```js
sense_now({ action: "watch" })
sense_now({ action: "watch", say: "我看到你已经进入设置页" })
sense_now({ action: "peek" })
sense_now({ action: "status" })
sense_now({ action: "stop" })
```

| 要点 | 说明 |
|---|---|
| `watch` | **阻塞调用**是正常陪看方式；攒够一张 sheet 或用户插话后返回。回复后应再次 `watch`，不要结束回合。 |
| `peek` | 插件主动唤醒（“有新画面了”）后取已攒好的图，不再次等待。 |
| `say` | **唯一**进入悬浮窗并被语音播报的通道；普通回复文字用户看不到也听不到。 |
| `pace` | `calm` / `normal` / `dense`：控制留帧与叫醒密度；用户说太密/太贵时立刻 `calm`。 |
| `scene` | `true` 时每场景一张满幅图并更频繁叫醒；默认关，未明确要求勿开。 |
| `quality` | `low` → `ultra`；看不清文字立即升档，勿猜。改档会短重启采集并先回一张当前屏。 |
| `source` | `screen`（默认）/ `obs` / `camera` / `file`+`path`（回放调试）。 |

实时管线会先在 64×36 采样网格上计算 HSV 加权差分，再用两类信号留帧：

- 孤立高尖峰：适合换页、硬切和窗口切换。
- 运动积分：适合滚动、缓慢变焦和一镜到底。

留下的帧会拼成 sheet，而不是每帧单独交给模型。用户关闭悬浮窗后插件会停止并留下挂断说明；
收到挂断后**不要**再调 `sense_now`，直到用户重新要求。

调参矩阵与实测说明见 [`docs/调参与实测.md`](./docs/调参与实测.md)。

## 6. `analysisPolicy`

建议从最小授权开始：

```js
video_index({
  action: "index",
  source: "file",
  path: "D:/videos/demo.mp4",
  analysisPolicy: {
    subtitleFirst: { enabled: true, scanFps: 1, roi: "auto" },
    speechActivityAssist: { enabled: false, useVad: true },
    asr: { mode: "off" },
    analysisProfile: { primary: "general", secondary: [] },
    profileSuggestion: { enabled: true },
    secondPass: { mode: "off", maxPasses: 1 },
    postAnalysisAudit: { enabled: false, retryMode: "ask", maxRetries: 1 },
    captureUtteranceEndFrame: { enabled: false, maxPerChunk: 12 }
  }
})
```

### 6.1 ASR 模式

| 模式 | 行为 |
|---|---|
| `off` | 所有入口都不得调用 ASR。 |
| `on_demand` | 只允许用户问题或已确认 refinement 触发局部 ASR。 |
| `fallback` | 字幕/OCR 缺口时允许 ASR。 |
| `full` | 索引阶段执行全量 ASR。 |

旧 `capabilities.asr`（`off` / `auto` / `on`）在同时传入 `analysisPolicy` 时仍映射为 `off` / `fallback` / `full`。
`HF_TOKEN`、已下载模型或本地 Python 环境都不会改变 effective policy。

### 6.2 内容 profile

profile 是用户选择的分析倾向，不是隐式自动开关。当前包含：

`general`、`visual_edit`、`handcraft`、`anime`、`film`、`screen_tutorial`、`slides_lecture`、
`interview`、`talking_head`、`gameplay`、`sports`、`news_documentary`、`product_review`、`vlog`、
`music_stage`、`surveillance_timelapse`。

`profileSuggestion` 只返回画面密度、ROI、场景灵敏度、段尾帧和音频能力的建议；用户显式参数永远优先，
建议不会直接开启 ASR。

### 6.3 预算硬顶（节选）

| 项 | 默认倾向 | 硬顶量级 |
|---|---|---|
| `scanFps` | 1 | ≤ 4 |
| `maxFramesScannedPerChunk` | 300 | ≤ 400 |
| `maxOcrCallsPerMinute` | 20 | ≤ 30 |
| `maxOcrCallsPerChunk` | 90 | ≤ 120 |
| `maxOcrRuntimeMsPerChunk` | 90s | ≤ 120s |
| `maxRefineWindows` | 2 | ≤ 3 |
| `maxAudioSecondsPerWindow` | 30 | ≤ 120 |

`Infinity` / `NaN` / 夸张大数无法绕过硬顶。触顶时显式返回 `truncated` 与 `limitReasons`。

## 7. `video_index` actions

| action | 作用 |
|---|---|
| `index` | 索引本地文件或 B 站链接；`execution`: `auto` / `sync` / `background`；`rebuild:true` 强制重建 |
| `query` | 返回受预算限制的检索上下文和引用；可能附带 `refinement` |
| `evidence` | 按 id 或时间范围取证；`package`: `minimal` / `full` |
| `zoom` | 在已索引的时间窗口补一张完整画面或 ROI |
| `status` / `list` | 查看索引 |
| `remove` | 只删除精确 `videoKey` 的索引，不删原媒体 |
| `cleanup` | 清临时文件与过期查询缓存；删过期索引 / trash 需确认 |
| `job_status` / `job_cancel` / `job_resume` | 管理后台 chunk job |
| `capture_start` / `capture_stop` | 显式开始/停止抓播；无 URL 时属 system-mix 录音授权 |
| `refine` | B 站 URL 补洞或确认二次分析计划（`confirmation.planHash`） |
| `execute_refinement` | 确认并执行 query 产生的 on-demand ASR 计划 |

## 8. Agent 协议要点

1. **两个工具不要混用职责**：实时陪看用 `sense_now`；离线长视频用 `video_index`。索引过程本身不叫醒模型。
2. **先 index / 等 job，再 query**：后台 job 未到 `ready`/`degraded` 终态前，勿假设末尾 chunk 已可检索。
3. **看到 `refinement.planHash` → 调 `execute_refinement`**：不要调用文档或返回值里不存在的内部 API（例如臆造的 `executeOnDemandAsr()`）。
4. **`say` 才是用户通道**：陪看时把要对用户说的话放进同一次 `watch` 的 `say`。
5. **证据不足就说不足**：capability 为 `unavailable` / `degraded`，或 `truncated` / `omittedEvidenceIds` 出现时，不要编造画面或台词。
6. **返回值必须是无损 JSON**：工具层会去掉 `undefined`；Agent 侧也不要依赖不可序列化字段。

## 9. 可选本地组件

### 9.1 faster-whisper ASR

默认关闭。只有 `DSH_WHISPER_ENABLED=1` 或显式设置 `DSH_WHISPER_MODEL` 才启用 runner；
这个运行时开关仍不能绕过 `analysisPolicy.asr.mode`。

```powershell
python -m pip install faster-whisper
$env:DSH_WHISPER_ENABLED = "1"
$env:DSH_WHISPER_PYTHON = "D:/venvs/sense-now/Scripts/python.exe"
$env:DSH_WHISPER_MODEL = "Systran/faster-whisper-small"
$env:DSH_WHISPER_DEVICE = "cpu"
$env:DSH_WHISPER_COMPUTE_TYPE = "int8"
python scripts/asr-runner.py --check
```

`--check` 只检查 import，不下载模型。

### 9.2 pyannote.audio 说话人分离

默认关闭，必须显式设置 `DSH_PYANNOTE_ENABLED=1`。`HF_TOKEN`、`HUGGINGFACE_HUB_TOKEN` 和本地模型路径
只是凭据/资源，不是功能开关。

```powershell
python -m pip install "pyannote.audio>=4,<5"
$env:DSH_PYANNOTE_ENABLED = "1"
$env:DSH_PYANNOTE_PYTHON = "D:/venvs/sense-now/Scripts/python.exe"
$env:HF_TOKEN = "hf_..."  # 只放环境变量，不得写入仓库
$env:DSH_PYANNOTE_DEVICE = "auto"
python scripts/audio-visual-runner.py --check
```

跨 chunk speaker merge 还需要 embedding 模型，并显式开启 `speakerMerge.enabled`。embedding 默认只存在内存，
不进入 query/context；不可用时 diarization 仍可以返回 provisional speaker。

### 9.3 VAD、OCR 与 loopback

- VAD 默认不带生产 runner，需要注入 `speechActivity` adapter，且 `speechActivityAssist.enabled=true`。
- OCR 默认不带具体模型，需要注入 OCR adapter。未配置时状态为 `unavailable`，不伪造识别结果。
- Windows 系统混音抓播需 `soundcard` 或 `pyaudiowpatch`：`python scripts/loopback-recorder.py --check`。

## 10. 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH 主目录（默认 `~/.dsh`） |
| `DSH_SENSE_VIDEO_INDEX` | 索引根目录（旧名 `DSH_SEE_VIDEO_INDEX` 兼容） |
| `DSH_FFMPEG_PATH` | ffmpeg 可执行文件 |
| `DSH_YTDLP_PATH` | yt-dlp 可执行文件 |
| `DSH_SENSE_WINDOW` / `DSH_SEE_WINDOW` | 悬浮窗 `window.py` 路径 |
| `DSH_SENSE_NO_WINDOW` / `DSH_SEE_NO_WINDOW` | `=1` 时禁用悬浮窗 |
| `DSH_SENSE_PYTHON` / `DSH_SEE_PYTHON` | 跑悬浮窗的 Python |
| `DSH_WHISPER_*` | faster-whisper 开关与模型（见 9.1） |
| `DSH_PYANNOTE_*` / `HF_TOKEN` | pyannote 开关与凭据（token **不得**入库） |
| `DSH_LOOPBACK_PYTHON` | loopback 录音用的 Python |
| `DSH_VOICE_ADAPTER` | 语音播报适配器 |
| `DSH_TOOLS_PATH` | 本地开发时解析 `@deepseek-ai/dsh-tools` |

## 11. 抓播与取消语义

`capture_start` 会创建 controller，在开始 recorder 之前注册 segment 回调，定时采样 CDP，
抓取手工选定的屏幕区域，并将音频 segment/画面帧组成 capture bundle。
暂停、倍速、seek 和 gap 使用 piecewise wall-time → video-time 映射。

`job_cancel` 先持久化 `cancelRequested`，再中止 controller。在 chunk 分析前后、commit 前、catalog 前和终态前
都有 attempt/cancel 守卫；已取消 job 不得被迟到回调覆盖成 `ready`。`job_resume` 跳过已 ready 的 chunk
（`rebuild:true` 时例外，会全部重跑）。

CDP 只接受 `http://127.0.0.1:<port>` 或 localhost 等价地址。Chrome 136+ 建议使用独立 `--user-data-dir`。

## 12. 存储、原子性与安全边界

默认索引根目录：`${DSH_HOME}/sense-now/video-index/`。可用 `DSH_SENSE_VIDEO_INDEX` 覆盖；
旧的 `DSH_SEE_VIDEO_INDEX` 仅作兼容回退。Windows 下目录名将 `:` 编码为 `=`。

```text
video-index/
  <encoded-video-key>/
    manifest.json                  # monolithic 布局
    metadata.json                  # 标题、路径、时长、尺寸、fingerprint
    detail/subtitle-segments.json
    detail/utterances.json
    analysis/coverage.json         # durationMs + textRanges + coverage 比值
    analysis/recommendations.json
    analysis/effective-policy.json
    analysis/audit.json
    evidence/evidence-index.json
    evidence/storyboard-index.json
    evidence/audio-index.json
    evidence/frames/<frameId>.png  # zoom / chunk storyboard 落盘的帧
    refinements/                   # plan-*.json / exec-*.json
    chunks/                        # chunk 布局
      catalog.json                 # durationMs + 聚合 coverage + chunk 摘要
      source-ref.json
      000000/
        chunk-manifest.json
        utterances.json
        events.json
        speakers.json
        storyboard.json
        evidence.json
        chapters.json
```

写入先进入 staging，完整文件写完后才原子切换 live generation，manifest 最后写入。
发布时清理 `.building.json` 标记；发布过程有 journal/trash 恢复语义，默认不删唯一恢复副本。

其他安全约束：

- `videoKey`、`jobId`、`chunkId` 和 evidence 相对路径在拼接前校验，拒绝路径穿越。
- 远程媒体与字幕下载：HTTPS、域名白名单、相对重定向再校验、DNS 拒私网/loopback、Content-Type 校验、
  累计字节硬顶；URL query/签名不进日志、evidence、catalog 或模型可见 metadata。
- stdout/stderr 有上限；OCR 流式路径只限制残片缓冲，不再用整段 stdout 顶死正常 5 分钟扫描。
  超时或取消时终止进程树。
- embeddings 默认不持久化，不进入 query/context。
- Capability 状态：`disabled` / `skipped` / `unavailable` / `pending` / `degraded` / `ready`；
  未验证的 adapter **不写假 ready**（例如 chunk 抽帧没落盘时是 `degraded`，视觉查询会报
  `storyboard_missing_images` 而不是假装有图）。

本项目**不**上传屏幕、不连续录像、不捆绑采集驱动或 TTS 引擎；详见 [`NOTICE`](./NOTICE)。

## 13. 测试与验证（实测分析）

### 13.1 规模与 CI

| 项 | 值 |
|---|---|
| 测试文件 | **61 个** `test/*.test.mjs` |
| 测试项 | **303 项**，`npm test`（Node 内置 test runner），本机约 17 s |
| 结果 | **303 pass / 0 fail**（本机 Node v24.21.0；CI 用 Node 20 同样通过） |
| CI | GitHub Actions，`windows-latest` + `ubuntu-latest` 双平台矩阵 |
| CI 步骤 | `python -m py_compile`（3 个 runner + 3 个悬浮窗脚本）→ `npm test` → `npm pack --dry-run --json` |
| 打包体积 | `npm pack`：**122 个条目 / 2.25 MB**（unpacked），不含 `.env`、`__pycache__`、`.pyc`、模型缓存与测试媒体 |
| 网络 | 测试**不访问公网**；远程相关用例要么注入 runner/`fetch`，要么在 `127.0.0.1` 起本地 http server 后自测 |

### 13.2 分领域覆盖

61 个文件按职责分布如下（项数合计 303）：

| 领域 | 代表文件 | 项数 | 主要断言 |
|---|---|---|---|
| 实时陪看与采集 | `capture-pipeline`、`live`、`loop`、`window*`、`scene*`、`interject`、`speech`、`png` | **112** | 帧率与留帧策略、拼图、悬浮窗协议与 pid 生命周期、语音状态机、挂断语义 |
| 长视频索引与检索 | `subtitle-first-production`、`subtitle-first-index`、`video-index-engine`、`video-index-tool`、`subtitle-parse`、`context-builder`、`query-router` | **104** | 字幕优先级与分层 OCR、覆盖率、时长路由、query 文本/引用、预算截断、时间词路由、证据包 |
| 分块 / job / 存储 | `chunk-store-job`、`chunk-plan`、`chunked-query`、`chunk-path-security`、`index-staging`、`index-cleanup`、`job-cancel-terminal`、`job-id-validation` | **32** | 原子提交与 staging 发布、`rebuild` 真重跑、cancel 终态不可逆、路径穿越、`.building.json` 清理 |
| 远程与媒体代理 | `url-allowlist`、`bilibili-source`、`long-video-remote-cdp`、`metered-media-proxy`、`remote-media-limits`、`media-extract` | **27** | 域名白名单与 SSRF、Range 代理与字节上限、CDP 仅 loopback、字幕 Content-Type |
| 说话人 / 身份 / embedding | `speaker-view`、`speaker-merge-production`、`identity-resolver`、`pyannote-runner`、`embedding-segment` | **28** | 匿名簇与跨 chunk 合并、身份只能由多模态证据升级、纯音频不得 `ready` |

### 13.3 基准实测（本机，2026-11-03）

**`npm run bench:video-index -- --synthetic`**：注入帧与字幕的合成索引，不含真实解码。

| 指标 | 实测 |
|---|---|
| 首次建索引 | 89–92 ms（3 utterance / 7 storyboard 单元 / 10 条 evidence） |
| 复用索引连查 10 次 | 合计 103 ms，均值 **10.3 ms/次**，缓存未命中 |
| 每次查询都重建 | 3 次均值 **80.6 ms/次**（≈ 复用路径的 8 倍） |

**`npm run bench:long-video`**：6 小时 / 72 chunk 合成长视频。

| 指标 | 实测 |
|---|---|
| 建 72 个 chunk | 680 ms |
| 40 次查询读取 chunk | 共 264 块，均值 6.6 块（约占全片 **9%**） |
| 查询延迟 | p50 **6.26 ms**、p95 **22.64 ms** |
| 峰值堆内存 | 6.25 MB |

复现：

```bash
npm run bench:video-index -- --synthetic
npm run bench:long-video
```

> 这两组数字只代表“索引与检索层的开销”，**不含**真实 FFmpeg 全片解码、OCR/ASR 推理与模型计费，
> 也不是产品 SLA。bench 输出里的 `unmeasured` 字段会把没测的部分显式列出来。

### 13.4 覆盖边界：合成了什么，没合成什么

**已由自动化覆盖**（合成 / 注入级）：

- 流式 OCR 预算触顶时停掉 FFmpeg、`probeOnly` 分层、真后台 `indexAdaptive` 建完 job 后检索片尾字幕。
- chunk 帧落盘与 `imageRef`/`evidenceIds` 一致性；抽帧失败时 `degraded` 且不留半截 PNG。
- `execute_refinement` 幂等、无范围 `full package` 拒绝、非法 `planHash` 拒绝。
- 字幕下载的 SSRF / Content-Type / 字节上限；CDP 仅 loopback。
- `.building.json` 发布后清理、残留不把 `ready` 降级；`rebuild:true` 真的重跑 chunk。
- query 文本通道：台词 + `EVID_`、换行折叠、截断计数、证据不足与空证据的表述。

**仍需自行实机确认**（自动化不冒充）：

- 不同 B 站账号、字幕权限、CDN、地区与签名 URL 的端到端稳定性。
- 真实 OCR / VAD / ASR 在多种分辨率、噪声与语言条件下的准确率。
- 真实多人场景的跨 chunk speaker 一致率与「人脸—音色」绑定质量。
- 不同 Windows 声卡与 loopback backend 的兼容性。
- 真实长视频（数小时）的端到端耗时与内存曲线。

手工 smoke 文档：[`smoke-subtitle-first.md`](./scripts/smoke-subtitle-first.md)、
[`smoke-pyannote.md`](./scripts/smoke-pyannote.md)、[`smoke-capture.md`](./scripts/smoke-capture.md)。
变更记录见 [`CHANGELOG.md`](./CHANGELOG.md)。

### 13.5 近期修复的回归项

| 问题 | 修复 | 回归测试 |
|---|---|---|
| `query` 只返回计数，Agent 拿不到台词 | 文本通道输出 `[mm:ss] 台词 (EVID_)`、章节与截断说明 | `video-index-tool.test.mjs` |
| chunk storyboard 无图却标 `ready` | 抽帧写 PNG + frame evidence；缺图 `degraded`，查询报 `storyboard_missing_images` | `chunk-store-job.test.mjs` |
| 本地文件 `durationMs` 为 `null`，coverage 全零 | 落盘前 probe 时长并回写 metadata；coverage 用真实时长重建 | `auto-duration-routing.test.mjs` |
| 索引目录残留 `.building.json` | 发布时删除；残留标记不把 `ready` 降级 | `video-index-store.test.mjs` |
| `index({rebuild:true})` 在 chunk 布局静默 no-op | `rebuild` 传到 job、清旧帧、跳过逻辑让路 | `chunk-store-job.test.mjs` |
| 「片尾」类问题固定命中片头 | `parseTimeMs` 认识片尾/开头，按 catalog 时长换算 | `chunked-query.test.mjs` |
| 无字幕索引返回两个空段，模型只能猜 | 文本通道明确写“没有可引用的文本证据” | `video-index-tool.test.mjs` |

## 14. 仓库结构

```text
src/
  index.js                         DSH 插件注册（sense_now + video_index）
  tool-spec.js                     sense_now 工具协议
  capture.js / pipeline.js         实时采集与筛帧
  cuts.js / tiers.js / pack.js     切点、节奏、拼图
  runner.js / loop.js              陪看会话与自动唤醒
  window.js / voice.js / chat.js   悬浮窗、语音、会话记录
  video-index-tool.js              video_index 工具路由（含 query 文本通道）
  video-index/
    video-index-engine.js          索引/查询/补充分析主引擎
    analysis-policy.js             策略规范化与硬顶
    subtitle-coordinator.js        视频级 + chunk 级字幕协调
    subtitle-stream-source.js      真流式 ROI rawvideo
    subtitle-band-scanner.js       字幕变化门控与 OCR 预算
    subtitle-download.js           受控字幕 URL 下载
    native-subtitle.js             内嵌字幕探测/提取
    refinement-plan.js             on_demand planHash 落盘与校验
    on-demand-asr.js               局部 ASR（含 chunk catalog）
    chunk-plan.js / chunk-store.js 5 分钟分块与原子存储
    job-controller.js              后台 job / cancel / resume / rebuild
    index-retriever.js             两级检索、时间词与 speaker-aware 上下文
    context-builder.js / token-gate.js  证据装配与预算截断
    evidence-*.js                  证据、package、audit 和 revision
    capture-controller.js          抓播控制器
    metered-media-proxy.js         受控 Range proxy
    adapters/                      字幕、ASR、OCR、VAD、pyannote、B 站等
scripts/                           Python runners、bench、install-dev、smoke
examples/floating-chat/            悬浮窗 bundle
test/                              61 个测试文件 / 303 项测试
docs/                              方案、调参与复验文档
```

## 15. 作为 Node.js 库使用

DSH 是可选 peer dependency（`@deepseek-ai/dsh-tools`）。核心采集、拼图与索引引擎可独立导入：

```js
import { createPipeline } from "sense-now/pipeline";
import { spawnFrames } from "sense-now/capture";
import { createVideoIndexEngine } from "sense-now/video-index";
```

对索引引擎进行集成时，应显式传入 `rootDir`，并通过 `adapters` 注入 OCR、VAD、实体、人脸或其他生产组件。
稳定导出面见 `package.json` 的 `exports`。

## 16. 开发

```bash
npm test                                          # 303 项
npm run bench:video-index -- --synthetic          # 索引/检索基线
npm run bench:long-video                          # 6h / 72 chunk 基准
npm pack --dry-run --json --ignore-scripts
python -m py_compile scripts/audio-visual-runner.py scripts/asr-runner.py scripts/loopback-recorder.py
```

其他常用脚本：

```bash
npm run install-dev
npm run check:window      # 校验悬浮窗 bundle
npm run debug:live        # 实时差分调试窗
```

`main` 分支已开启保护，要求 Windows 和 Ubuntu 两个 CI 状态检查通过，禁止 force push 与分支删除。

## 17. 已知限制

- 当前是 Windows-first；屏幕采集主要使用 `ddagrab` / `gdigrab`。
- OCR 与 VAD 只定义了生产适配协议，仓库不默认携带模型。
- B 站不支持付费番剧、DRM、直播与 `b23.tv` 短链。
- 抓播崩溃后不能无缝恢复；系统会保留 gap，并允许使用 URL `refine` 补洞。
- active-speaker / face-tracker 及人物—音色绑定仍是实验能力，真实识别质量取决于接入的人脸、口型、
  speaker 和时间同步证据。
- 视觉回退在没有任何文本命中时会优先加载靠前的 chunk；极长视频上建议配合时间词提问。
- 任何 capability 为 `unavailable` / `degraded` 或证据被预算截断时，Agent 都应明确说明证据不足，而不是猜测。

## 18. 开源来源与许可

Sense Now 基于 SAOS-3624 的 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) 继续开发。
本仓库保留上游的 Apache-2.0 [`LICENSE`](./LICENSE)、[`NOTICE`](./NOTICE) 和作者归属，
并在此基础上新增字幕优先长视频索引、分块检索、按需音画证据、权限开关、预算硬顶、原子发布和安全边界。

使用、修改和再分发时，请遵守 Apache License 2.0 并保留 `LICENSE` 与 `NOTICE`。
