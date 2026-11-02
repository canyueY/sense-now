# Changelog

本文件从 `0.0.4` 起记录；更早的版本见 GitHub Releases。

## [0.1.0] - 2026-11-02

### Added — V1.1 视频索引问答（与实时陪看并列）

新增独立工具 `video_index`（**不塞进** `sense_now`），实现「一次索引、多次查询」：

- 本地文件 / Bilibili（可选 `yt-dlp`）建索引：metadata、字幕 utterances、Storyboard、证据引用。
- 查询路由（text / time / visual / multimodal / deep）、本地文本检索、Token/Cognition Gate、查询缓存。
- 文本问题默认不附图；视觉问题优先复用 Storyboard；`zoom` 受硬预算约束。
- 外部 ASR/OCR/人物适配器：不可用时明确 `unavailable`/`degraded`，**不伪造**转写或人物 ID。
- 人物↔音色绑定状态机（P4）：确定性单测；真实识别需自行配置 adapter（实验性）。
- Minimal / Full Evidence Package；Mnemosyne **仅候选包**（无 API 时不伪造已保存）。
- 索引目录默认 `${DSH_HOME}/sense-now/video-index/`；Windows 下目录名将 `:` 编码为 `=`。

### Compatibility

- `sense_now` 的 watch/peek/start/stop/status、say、挂断、文件只播一次等行为保持不变。
- 未调用 `video_index` / 未配置索引时，不创建索引目录，实时陪看与 0.0.5 一致。
- `pipeline.js` 增加可选 `onKeep` / `onSheet` observer（默认关闭）。

### Added — 索引收尾能力

- 外挂 `.srt` / `.vtt`（`subtitlePath`）；索引侧 ASR 前抽 wav；Bilibili 显式 `cacheMedia:true` 才下载。
- 规则聚合 `topics` / `key-moments`（可回溯 evidenceIds，不发明摘要正文）。
- `video_index({ action:"cleanup" })`：清临时文件、按 TTL 修剪查询缓存；可选 `maxAgeMs` 删除过期索引。

### Docs / Package

- README 增加「实时陪看」与「视频索引问答」两个工作流说明。
- `package.json` exports：`./video-index`、`./video-index-tool` 等稳定公共面。
- `npm run bench:video-index`：A/B 基准脚本（合成帧；不宣称未测金额）。

## [0.0.5] - 2026-11-02

`examples/floating-chat/window.py` 同步上游 `dsh-watch-together` **0.2.4**（生成产物，
`npm run sync:window` 自动更新）。0.0.4 带出去的那份窗口有两个问题，这个版本一起修掉：

### Fixed — 气泡里的字一直黑白闪

字色是按背景亮度选的（气泡透明，背后就是桌面/视频）。原来每 0.12 秒按
`p50 < 0.50` 硬切白/深两色，画面一动亮度就在阈值附近来回穿，字一秒能翻七八次。
现在改成**滞回**（白的暗到 0.38 才翻深、深的亮到 0.62 才翻白）+ **连续两次同向才切**，
同样 16 次抖动从翻 15 次降到 0 次。顶部细条同样处理。

### Changed — 玻璃合成与气泡布局（上游 PR #28）

- 小框（气泡/输入框）边缘改用 blur 1.45 的帧做 smoothstep 过渡，不再二值硬切。
- CPU 管线补齐外缘 R/B 色散与上一帧运动混合（原来只有 GPU 有）；移动帧跳过色散，
  拖动/滚动响应更快。
- 消息气泡改成按正文实测的自适应宽高，时间戳移到气泡上方不再占框内空间。
- 麦克风回到玻璃帧合成（`MIC_POS`），不再在 Canvas 上单独建图。

## [0.0.4] - 2026-11-02

> 主题两件：**协议换成 Apache-2.0**，以及**常驻循环学会自己收工**。

### License — 改成 Apache-2.0

- `PolyForm-Noncommercial-1.0.0` → **`Apache-2.0`**。个人、公司内部、闭源产品、SaaS、
  二次分发都不需要授权、不收费，保留 `LICENSE` 与 `NOTICE` 即可。
- **删掉 `CLA.md` 与 `COMMERCIAL.md`**：Apache-2.0 下不需要贡献者签 CLA，
  也没有"商业授权"这回事了。`package.json` 的 `files` 同步移除这两个文件。
- `NOTICE` 重写：标准 Apache 声明 + 保留原来那份"这个项目**不做什么**"（不上传屏幕、
  不连续录制、不内置采集驱动、不内置 TTS 引擎）。
- `README` 的「授权说明」与「协议」两节、`CONTRIBUTING.md` 第一节、PR 模板里的 CLA 勾选项
  全部同步；`examples/floating-chat/` 不再需要"单独 Apache"的例外说明 —— 整个包同一个协议。
- README 挂上**赞赏码**（`docs/images/reward-qr.png`）：纯自愿，**不解锁任何功能**，
  也不影响以后的授权方式。

### Fixed — 常驻循环不再"卡读图循环"

社区实报：装上之后会话会一轮一轮读图，用户什么都没问也不停。根因是常驻循环
**只有"采集停了"一个退出条件** —— 屏幕一直在动（放视频、刷网页）就会每 `wakeMinGapSec`
叫醒模型一次、模型看一眼图回一句、下一张再叫一次，永远不停，而且每次都是一轮模型调用。

- 新增 `shouldGoIdle()`，两条收工线互为兜底：
  - `IDLE_STOP_MS`（3 分钟）：**没开悬浮窗**且用户超过 3 分钟没说话 → 停。
    悬浮窗开着就不按这条判 —— 那是陪看场景，两小时的电影中途不说话是正常的。
  - `MAX_AUTONOMOUS_WAKES`（8 次）：连续自动唤醒都没人搭理 → 停，窗开着也算
    （防"窗开着但人走了"）。
  - 用户一说话，计数与时间戳都重置。
- 收工不是"突然哑掉"：会在窗口里留一行灰字（`（有一阵没人说话了，我先停一停；要看再说一声。）`），
  且不朗读。
- `test/idle.test.mjs` 三条用例钉住：上限到就停、没窗+久不说话就停、窗开着不按时间判。

### Changed — 悬浮窗同步到 `dsh-watch-together` 0.2.3

`examples/floating-chat/window.py` 是**生成产物**（`npm run sync:window` / `prepack` 自动同步），
这次带上游 0.2.3 的一整轮窗口修复：

- 气泡改成「时间头 + 两行正文」，88px 统一高度，超长按框高折行/截断，标点不落行首。
- 折叠不再重建整窗几何（原来会在 `rounded_mask` 抛 `y1 must be >= y0`）；折叠不跳回原位、
  折叠背景有圆角、配置存展开高度。
- 每 1.8 秒重新置顶一次，DSH 抢焦点后浮窗不再被压下去。
- 拖动/缩放越界钳位，抓屏前挡掉非正尺寸（`Region has zero or negative size` 每帧刷日志、
  背景永久花不了）。
- snapshot 模式不再被 `_tick` 重新打开 WDA；`window` 接口 hide/show 兼容只返回布尔的实现。
- 麦克风改 Canvas 矢量图标，不再往合成帧上贴第二层。

### Fixed — 版本号漂移

`dsh.plugin.json` 还写着 `0.0.2`，与 `package.json` 的 `0.0.3` 不一致。这次一起对齐到 `0.0.4`
（宿主按 `dsh.plugin.json` 认版本，漂着会让"装了新版但页面显示旧版"）。

## [0.0.3] - 2026-11-01

首个公开版本：让 AI 实时看见屏幕 —— 按画面变化量筛帧、拼成一张图推进会话。
