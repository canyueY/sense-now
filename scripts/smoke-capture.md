# 真实抓播 Smoke（不进默认 `npm test`）

在具备声卡、可调试 Chrome、可选 ASR/pyannote 的机器上手动执行。

## 前置

```powershell
python scripts/loopback-recorder.py --check
# 若 unavailable：pip install soundcard
# Chrome：独立 profile + 远程调试端口，例如
# chrome.exe --remote-debugging-port=9222 --user-data-dir=D:\chrome-sense-now
```

## 流程（约 30 分钟 B 站普通投稿）

1. 打开投稿页并开始播放。
2. 调用：

```js
video_index({
  action: "capture_start",
  url: "https://www.bilibili.com/video/BVxxxx",
  region: { x, y, width, height },  // 手动区域
  cdpEndpoint: "http://127.0.0.1:9222",
})
```

3. 播放约 30 分钟后：

```js
video_index({ action: "capture_stop", jobId })
video_index({ action: "job_status", jobId })  // 等到 ready|degraded
video_index({ action: "query", videoKey, question: "开头讲了什么" })
video_index({ action: "query", videoKey, question: "中间讲了什么" })
video_index({ action: "query", videoKey, question: "结尾讲了什么" })
video_index({ action: "query", videoKey, question: "谁在说话", mode: "multimodal" })
```

## 必须记录的输出

- 实际捕获时长
- CDP sample 数 / 失败数
- audio segment 数、总样本数、gaps
- retained frame 数
- ready/degraded chunk 数
- utterance / speaker 数
- capture 视频时间误差（相对播放器）
- backlog 峰值
- 是否使用真实 ASR / pyannote / embedding
- 各 capability 最终状态

## 状态

**真实抓播未在本仓库 CI/本轮交付中执行。** 自动化已覆盖：两段 fake WAV→ASR→`query`、`job_cancel` 资源清理、生产 `screen-frame-source`（注入 spawn）、embedding `Segment` 契约、Range 计量代理。不得把上述 fake 测试描述为真实 smoke。
