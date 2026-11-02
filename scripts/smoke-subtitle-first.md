# 手工 smoke：字幕优先长视频索引

**不进入 `npm test`。** 下列场景区分实测层级；未在本机跑通的条目不得写成「已通过」。

| 层级 | 含义 |
|------|------|
| unit/synthetic | `npm test` 合成夹具 |
| integration with stub | 生产入口 + 注入 adapter |
| real component | 本机真实 FFmpeg / yt-dlp / OCR / ASR |
| real media smoke | 真实 B站/本地媒体端到端 |

## 前置

```powershell
# 可选真实组件
$env:DSH_YTDLP_PATH = "yt-dlp"
# ASR / VAD 按项目既有开关；HF_TOKEN 存在不得改变 effective policy
```

## 1. 30 分钟 B站视频 + 官方字幕

```js
video_index({
  action: "index_adaptive",
  source: { kind: "bilibili", url: "https://www.bilibili.com/video/BVxxxx" },
  execution: "background",
  analysisPolicy: { asr: { mode: "off" } }
})
// job_status → ready/degraded
// query：用字幕原文中的短语检索
```

期望：字幕来源 `bilibili`；同视频字幕只物化一次；chunk 裁剪半开区间。  
**层级：real media smoke（未在 CI 默认执行 → 报告中写「未实测」除非本机已跑）。**

## 2. 本地 MP4/MKV + 内嵌字幕

```js
video_index({
  action: "index",
  source: { kind: "file", path: "D:/sample-with-subs.mkv" },
  analysisPolicy: {}
})
```

期望：ffprobe 枚举 text 轨；bitmap-only 标记 degraded/unsupported，不伪装成功。  
**层级：real component + real media smoke。**

## 3. 无字幕、画面底部硬字幕（OCR）

```js
video_index({
  action: "index_adaptive",
  source: { kind: "file", path: "D:/hardsub-30m.mp4" },
  execution: "background",
  analysisPolicy: {
    asr: { mode: "off" },
    subtitleFirst: { enabled: true, scanFps: 1 },
    budgets: { maxOcrCallsPerChunk: 90 }
  }
})
```

期望：每 5 分钟 chunk 原则上 1 次 FFmpeg ROI 流；空 OCR 仍受 `maxOcrCallsPerChunk` 硬顶；coverage.truncated 在触顶时为 true。  
**层级：real component（需 OCR runner）。**

## 4. 无字幕 + ASR fallback

```js
analysisPolicy: { asr: { mode: "fallback" } }
```

期望：字幕/OCR 缺口后才调 ASR；VAD 未授权时不跑 VAD。  
**层级：real component。**

## 5. asr.mode=off 严格权限

所有入口（index / indexChunk / indexAdaptive / query / refine）ASR 调用次数为 0。  
`HF_TOKEN` 存在不得把 mode 改成 on。  
**层级：unit/synthetic 已覆盖；real 组件对照「未实测」即可。**

## 6. 视觉问题触发局部完整画面

```js
video_index({ action: "zoom", videoKey, startMs: 600000, endMs: 601000 })
```

期望：`timestampMs` 为绝对媒体时间（约 10 分钟），不是 0。  
无本地媒体时 `onDemandVisual !== ready`。

## 7. 字幕不足 + auto_once 一次

```js
analysisPolicy: {
  asr: { mode: "on_demand" },
  secondPass: { mode: "auto_once" },
  postAnalysisAudit: { enabled: true, retryMode: "auto_once" }
}
```

期望：最多执行一次局部重试；不得递归第二次；不得把 ASR 从 off 改掉。

## 8. 取消长视频任务

```js
job_cancel(jobId)  // OCR/下载/commit 前后
```

期望：终态 `cancelled`；不得再被覆盖成 ready；已 abort 的 chunk 不发布。

## 9. 降级：无声卡 / 无 OCR / 无 ASR

关闭对应 runner 后：capability 为 `unavailable`/`degraded`，索引仍可完成字幕轨路径。  
**层级：integration with stub + 本机 real component。**

## 报告写法

- 已跑通：写命令、时长、关键 capability、是否 truncated。
- 未跑：明确写「未实测：真实 OCR/ASR/VAD/B站/CDN/FFmpeg」。
- 禁止把 unit/synthetic 结果写成 real media 通过。
