# Cursor / Grok 二次修复任务书：让抓播真正可听、可取消、可分人并保持远程分块

> 将本文从“你现在是……”开始完整粘贴给 Cursor 中的 Grok 模型。请直接修改当前仓库并运行验证，不要再次只输出设计方案。

---

你现在是本项目的高级 Node.js、Python、FFmpeg、Windows 音频和媒体安全工程师。上一轮报告称 C1～C7 已完成，但独立代码验收发现 5 个仍会阻断真实使用的问题。请以本文为准实施二次修复。

仓库：

```text
<repo-root>/sense-now
```

相关文件：

```text
src/video-index/video-index-engine.js
src/video-index/capture-controller.js
src/video-index/adapters/loopback-recorder.js
src/video-index/remote-media.js
src/video-index/job-controller.js
src/video-index/job-store.js
src/video-index/time-mapping.js
src/video-index/adapters/audio-visual-adapter.js
src/video-index/speaker-merge.js
src/capture.js
src/png.js
scripts/audio-visual-runner.py
scripts/loopback-recorder.py
test/capture-pipeline.test.mjs
test/remote-media-limits.test.mjs
test/speaker-merge-production.test.mjs
```

## 1. 已验证基线

当前基线：

```text
npm test                     213 pass / 0 fail
npm pack --dry-run           93 条目
Python py_compile            通过
loopback --check             unavailable（缺 soundcard/pyaudiowpatch）
6h 合成 long-video benchmark 72 chunks，平均读取 2.6，P95 约 8ms，peak heap 约 6.5MB
真实抓播 smoke              未执行
真实 embedding              未执行
```

这些结果只能证明现有自动测试通过，不能证明生产抓播和 embedding 已经接通。不得删除或放宽现有测试。

## 2. 本轮必须修复的 5 个问题

### R1：capture 音频没有进入 ASR

当前 `indexChunk()` 先运行 ASR，之后才从 `captureBundle` 设置 `audioPath`。结果是抓播音频不会被转写。

同时存在：

- 只读取 `audioSegments[0]`；
- 后续录音段被忽略；
- `mappingSegments` 只决定 `timeSource`，没有映射 ASR/diarization 时间；
- pause、倍速、seek、gap 没有进入抓播转写时间轴；
- 无 CDP 时有音频的 chunk 可能只有 1ms；
- 当前测试名声称“可 query”，实际没有 query 并检查文本。

### R2：capture job 取消没有停止 capture controller

`jobCancel()` 只取消普通 index job。capture controller 保存在单独 Map 中，所以 `job_cancel` 后 timer、recorder、frame process 仍可能运行；之后 `capture_stop` 还能提交 chunk。

### R3：生产环境没有默认 frame source

engine 使用：

```js
frameSource: adapters.captureFrameSource || null
```

只有测试注入 fake。生产代码没有用 `spawnFrames()` 创建默认区域抓屏 adapter。因此无 loopback 依赖时，音频和画面都 unavailable，`capture_start` 直接失败。

### R4：真实 speaker embedding 调用错误

当前 Python 代码把 `(start, duration)` tuple 传给 `Inference.crop`。pyannote 要求 `pyannote.core.Segment` 或 Segment 列表。异常又被内部 `except` 吞掉，所以真实 embedding 很可能始终为空。

此外：

- 注释称排除 overlap，实际没有排除；
- runner 返回空向量和 `embeddingStatus:unavailable` 后，Node adapter 没有完整透传状态；
- `validateSpeakerEmbeddings([])` 可能被视为成功，错误标记 pending。

### R5：远程“分块”会先下载整个媒体

当前生产默认逻辑是普通 GET 下载完整媒体到临时文件，再让 FFmpeg 本地 seek。它没有 Range；每个 5 分钟 chunk 都可能重复下载整条流，并撞上 64MB 上限。

真实下载字节计量已经存在，但实现方式破坏了超长视频按块索引的核心目标。

## 3. 修复顺序

按以下顺序实施：

```text
P0 R2 capture cancel 终态
P0 R1 capture audio → ASR/diarization → 时间映射
P1 R3 生产 frame source
P1 R4 真实 embedding
P1 R5 Range/计量代理
P2 测试补强、pack 清理、文档与 smoke
```

每完成一项先运行定向测试，再继续下一项。

## 4. R2 方案：统一 capture 与 job 的取消语义

### 4.1 capture job 必须持有 attempt 和 lock

`capture_start` 对 videoKey 获取与普通 index 相同的排他锁，job 保存：

```js
{
  attempt: 1,
  lockNonce,
  cancelRequested: false,
  captureSessionId
}
```

同一个 videoKey 不允许两个写 capture，也不能与后台 URL/file index 同时写。

### 4.2 `jobCancel` 路由到 capture controller

将 engine 的取消入口改为 async：

```js
async function jobCancel(jobId) {
  // 1. validate id
  // 2. 如果存在 capture controller，先持久化 cancelRequested
  // 3. await controller.requestCancel()
  // 4. 确认 timer/recorder/frame 全部停止
  // 5. 保持 cancelled 终态并按 nonce 释放锁
  // 6. 否则走普通 jobs.jobCancel
}
```

相应修改 `video-index-tool.js`，对 `eng.jobCancel()` 使用 `await`。

强制规则：

- 先持久化 `cancelRequested:true`，再停止外部进程；
- capture controller 的任何 flush/index/commit 前都调用持久化守卫；
- 守卫同时检查 jobId、attempt、cancelRequested、state；
- `capture_stop` 遇到 cancelled job只能幂等清理，不得以 `cancel:false` 再 flush；
- `controller.requestCancel()` 必须 clear scheduler、停止 frame、graceful stop recorder、等待 settle；
- cancelled 后不得 rebuild catalog、不得提交 chunk、不得变为 ready/degraded；
- 只有持有相同 lockNonce 的执行者才能释放锁；
- `_captureControllers` 必须在成功、失败、取消、异常和 engine close 时删除；
- engine `close()` 必须停止全部活跃 capture controller，不能保留计时器或子进程。

建议将普通 index 和 capture 共用一个 `assertJobMayContinue(jobId, signal, attempt)`，或给 capture 注入等价 `mayContinue()` 回调，避免复制不一致的状态机。

### 4.3 必须新增的测试

- capture_start 后调用 `job_cancel`，scheduler active 变为 0；
- recorder.stop 和 frame.stop 各只调用一次；
- cancel 后 recorder 再迟到一个 segment，不进入 bundle；
- cancel 与 flush 同时发生，零新 commit；
- cancel 后再调用 capture_stop，仍是 cancelled 且零 commit；
- cancel 500ms 后状态仍是 cancelled；
- engine.close 清理所有 capture 资源；
- 同 videoKey capture/index 并发被锁拒绝。

## 5. R1 方案：建立专用 capture bundle 分析管线

不要再把 capture bundle 塞进普通 file/url 音频路径后只设置一个 `audioPath`。新增专用模块，例如：

```text
src/video-index/capture-bundle.js
```

建议接口：

```js
analyzeCaptureBundle({
  videoKey,
  chunkId,
  bundle,
  asr,
  audioVisual,
  capabilities,
  speakerMerge,
  signal,
})
```

### 5.1 先分片，再分析

输入 bundle：

```js
{
  audioSegments: [
    { path, wallStartMs, wallEndMs, sampleCount, sampleRate }
  ],
  frames: [{ path, wallMs, videoMs }],
  mappingSegments: [
    { wallStartMs, wallEndMs, videoStartMs, videoEndMs, playbackRate, reason }
  ],
  gaps: []
}
```

处理步骤：

1. 校验所有路径必须位于当前 capture temp 目录；
2. 按 `wallStartMs` 排序并去重，不能只取第一段；
3. 把每个 WAV 与 mapping segment 求交；
4. pause、gap、无 mapping 的部分不伪造播放器时间；
5. 一个 WAV 横跨 seek/rate-change 时拆成多个 analysis slice；
6. 每个 slice 保存：

```js
{
  path,
  audioLocalStartMs,
  audioLocalEndMs,
  wallStartMs,
  wallEndMs,
  videoStartMs,
  videoEndMs,
  playbackRate,
  timeSource
}
```

7. 对每个 slice 调用 ASR/diarization，runner 返回 slice-local 时间；
8. 使用 wall→video 分段线性映射转换每条 utterance、activeSegment 和 overlap 的起止时间；
9. 结果跨 gap 或映射边界时拆分或丢弃不可信部分；
10. 合并所有 slice 结果，再执行 overlap ownership 和文本去重。

不允许简单地给整个 5 分钟 chunk 加一个 `offsetMs`，因为倍速、暂停和 seek 不是单一偏移。

### 5.2 无 CDP 的降级时间轴

capture-only 且没有 CDP 时：

- 以 capture session 开始墙钟为相对 0；
- 视频时间按实际录音样本时长推进；
- `timeSource:"wallclock"`；
- chunk end 取音频/画面实际最大持续时间，不能写成 1ms；
- 不声称与网页播放器时间对齐；
- 后续有 URL refine 时创建新 revision 补齐权威时间。

### 5.3 chunkId 必须在分析前分配

不要让 `indexChunk()` 把缺失 chunkId 默认成 `000000`。capture controller 在调用分析前从受锁保护的 allocator 取得真实六位 chunkId：

```text
000000, 000001, 000002, ...
```

allocator 必须考虑现有 ready/degraded/staging/trash，避免并发覆盖。

### 5.4 调整 `indexChunk()` 顺序

推荐结构：

```js
if (sourceDescriptor?.captureBundle) {
  return indexCaptureChunk(...);
}

// 原 file/url 路径继续走现有字幕→提音频→ASR→diarization→storyboard
```

或者在普通流程最前面完成 capture bundle preparation，但必须保证：

- ASR 执行前 audio slices 已就绪；
- 所有 audio segment 都被消费；
- capture 时间映射真正作用于 ASR 和 diarization；
- retained frames 直接进入 storyboard；
- 不再从 capture bundle 取 `audioSegments[0]`。

### 5.5 录音 segment 事件不能丢

在 recorder start 之前注册 `onSegment`：

```js
unsubscribe = rec.onSegment(handleSegment);
const recStart = await rec.start(...);
```

stop/异常时取消订阅。`rec.stop()` 返回的 segments 要与事件列表按稳定 segmentId 合并，防止启动瞬间或 shutdown 尾段遗漏。

### 5.6 必须新增的端到端测试

构造两个真实可读取的短 WAV，不要写任意 32/100 字节冒充 WAV。

fake ASR 对第一段返回“第一段内容”，第二段返回“第二段内容”。完整执行：

```text
engine.captureStart
→ scheduler tick
→ 两个 recorder segment
→ captureStop
→ query("讲了什么")
```

强制断言：

- query 同时包含两段文本；
- catalog 至少一个 chunk；
- chunk manifest 的 utterance count > 0；
- 2× 播放时，10 秒墙钟映射约 20 秒视频时间；
- pause 区间不生成虚假 utterance；
- seek 前后不产生跨越 seek 的 utterance；
- gap 被保留；
- 无 CDP 的 60 秒录音 chunk 时长接近 60 秒，不是 1ms；
- 测试必须调用真实 engine query，不能只断言 `Array.isArray()`。

## 6. R3 方案：提供生产默认 screen frame source

新增：

```text
src/video-index/adapters/screen-frame-source.js
```

底层使用：

```js
spawnFrames({ source, width, height, fps, ffmpegPath, engine, onFrame })
```

接口：

```js
createScreenFrameSource({ ffmpegPath, spawnFramesImpl })
  .start({ region, outDir, onFrame })
```

要求：

- engine 默认使用生产 adapter：

```js
const frameSource = adapters.captureFrameSource
  || createScreenFrameSource({ ffmpegPath });
```

- region 必须经 `validateManualRegion()`；
- 转换为 `spawnFrames` 所需 `{x,y,w,h}` 时不能混淆 width/height；
- ddagrab 使用 crop 链；若当前机器不支持，明确回退 gdigrab并更新 capability；
- 禁止静默抓全屏；
- 默认采集 fps 保守，例如 1fps；保留仍为每 30 秒最多 1 帧；
- raw RGB 只在 callback 生命周期内存在，不写 `.raw` 作为 storyboard；
- capture controller 在确认保留后调用：

```js
const png = encodePng(buf, width, height, { level: 1 });
writeFileSync(pngPath, png, { flag: "wx" });
```

- storyboard 的 `imageRef` 必须指向有效 PNG；
- `onFrame` single-flight/有界，不允许编码队列无限增长；
- stop 使用进程树终止能力并等待 `done` settle；
- FFmpeg 启动失败时返回 unavailable/degraded，不能把 capability 标 ready；
- frame source 成功启动后才能标 `frameCapture:"ready"`。

测试：

- 注入 fake `spawnFramesImpl`，验证生产 adapter 确实被 engine 默认创建；
- 输出 PNG 通过签名、IHDR 和解码测试；
- region 参数传递正确；
- 30 秒内多帧只保留 1 帧；
- stop 后不再回调；
- FFmpeg 启动 error 时 capability 不是 ready；
- 没有 loopback 但 frame adapter 可用时 capture_start 为 degraded/ok，而不是失败。

## 7. R4 方案：修复真实 speaker embedding

### 7.1 正确调用 pyannote

Python 使用：

```python
from pyannote.core import Segment

excerpt = inference.crop(
    str(audio_path),
    Segment(a / 1000.0, b / 1000.0),
)
```

第二个参数是 `(start, end)` 语义的 `Segment`，不是 `(start, duration)` tuple。

删除未使用且会增加依赖失败面的 `torchaudio` import，除非实现确实使用它。

### 7.2 排除 overlap

优先使用 `exclusive_speaker_diarization` 的片段生成 embedding，或显式计算 overlap ranges 后过滤任何相交片段。

要求：

- 每段至少 500ms，推荐优先 1.5s 以上；
- 单 speaker 最多 8 段；
- 单 job speaker 数和总推理时长有硬顶；
- 片段时间先减去 chunk offset，保证落在当前 WAV 内；
- 裁剪到 `[0, audioDuration]`；
- centroid L2 normalize；
- 空向量、全零、NaN/Infinity 拒绝。

### 7.3 状态必须完整透传

Python 输出：

```json
{
  "speakerEmbeddings": [],
  "embeddingStatus": {
    "ok": false,
    "reason": "unavailable",
    "detail": "..."
  }
}
```

`audio-visual-adapter.js` 必须透传 `embeddingStatus`。engine 规则：

- `speakerEmbeddings.length > 0` 且校验通过：`pending`；
- 空数组 + unavailable：`unavailable`；
- 非法向量：`degraded`；
- 未请求：`disabled`；
- finalize 真实发布 speaker-map 后：`ready/tentative`。

修改 `validateSpeakerEmbeddings()`：请求 embedding 时空数组不能被视为成功生产结果。

### 7.4 可测试性

将“裁剪 segment→取得向量→聚合 centroid”拆成可注入 inference 的函数。新增 Python 或 Node 驱动的离线测试：

- fake inference 断言收到 `Segment(start,end)`；
- offset=300000 时裁剪仍从当前 WAV 的相对时间开始；
- overlap 片段不进入 inference；
- 两个 speaker 产生两个归一化向量；
- inference 抛错时 structured unavailable；
- 空 embedding 不触发 finalize merge，不标 ready；
- 生产 job finalize 的 speaker-map 不包含向量。

## 8. R5 方案：使用受控本地计量代理保持 FFmpeg Range seek

不要再“完整下载远程对象→本地 FFmpeg seek”。推荐新增内部 loopback proxy：

```text
src/video-index/metered-media-proxy.js
```

### 8.1 数据流

```text
FFmpeg
→ http://127.0.0.1:<ephemeral>/<nonce>
→ 本地 proxy 转发 FFmpeg 的 Range 请求
→ 校验并连接 B 站 CDN
→ 把 206/200 响应流回传 FFmpeg
→ 对所有上游响应字节累计计量
```

这样 FFmpeg 可以按容器索引发 Range/seek，同时应用真实下载字节硬上限。

### 8.2 安全要求

- proxy 只监听 `127.0.0.1`，使用随机不可猜 nonce；
- 只服务当前一次 extraction，完成后立即 close；
- 上游 URL 只来自内部 `resolveStreams()` descriptor；
- 每次连接和 redirect 都做 HTTPS、域名 allowlist、控制字符和公网 IP 校验；
- 使用 `dns.promises.lookup(host,{all:true,verbatim:true})`；
- 连接时固定到已经验证的 IP，同时 TLS `servername` 和 Host 保持原域名，缩小 DNS rebinding 窗口；
- redirect 支持相对 Location，但必须用当前 URL 作为 base 后重新校验；
- 只转发必要 header：Range、User-Agent、Referer、Origin 等 allowlist；
- 不允许客户端改变目标 URL；
- 不记录 signed URL、cookie 或完整请求头；
- 总字节跨多个 Range 请求累计；
- 超过 `maxDownloadBytes` 时同时：关闭上游、关闭 proxy response、abort FFmpeg、杀进程树、删除输出；
- `maxRuntimeMs`、redirect、retry、临时磁盘仍独立限制；
- byteUsage 区分 downloaded、outputBytes、temporaryPeak；同时存在的文件按总和计算磁盘峰值。

如果不采用 proxy，也必须实现同等能力：支持 FFmpeg 所需的随机 Range、逐跳安全校验、跨请求累计和立即中止。不能用完整 GET 或输出文件大小代替。

### 8.3 FFmpeg 输入

FFmpeg 只看到本地、短生命周期 URL：

```text
http://127.0.0.1:<port>/<nonce>
```

协议白名单只开放实际需要的本地 `http,tcp` 和输出 `file`。上游 CDN headers 由 proxy 处理，不通过 `-headers` 暴露给 FFmpeg stderr。

### 8.4 测试

本地 fixture 提供一个足够大的可 seek 媒体或模拟 Range 对象，记录收到的 Range：

- FFmpeg/proxy 发出 Range；
- 支持 206；
- 5 分钟片段下载字节明显小于完整对象；
- 多次 Range 的字节累计正确；
- 超限中途终止并删除输出；
- 相对 redirect 正常解析；
- redirect 到裸 IP、私网、非 allowlist 域名拒绝；
- DNS 返回私网拒绝；
- abort 后 proxy 端口关闭、无活跃 socket；
- 测试不访问真实 B 站。

保留完整 GET 只能作为用户显式允许且有严格大小上限的小文件 fallback，不能作为长视频生产默认路径。

## 9. 修正现有测试中的假阳性

重点修改 `test/capture-pipeline.test.mjs`：

- 不再用任意 Buffer 冒充 WAV；使用最小合法 PCM WAV helper；
- fake recorder 必须把文件写进 controller 提供的 `outDir`；
- 测试至少产生两个 segment；
- 不允许只断言 `Array.isArray(store.listReadyChunkIds())`；必须断言长度 > 0；
- 必须读取 chunk，断言 utterances、storyboard、manifest counts；
- 必须调用 engine.query 并检查转写文本；
- 必须单独测试 `job_cancel`，不能用正常 capture_stop 代替取消测试；
- production default adapter 测试不能注入 `createFakeFrameSource()` 后声称生产已接通，应注入底层 spawn 工厂验证默认 adapter。

新增防回归断言：

```text
capture bundle 处理发生在 ASR 前
所有 audioSegments 均被消费
mappingSegments 实际改变 utterance 时间
job_cancel 停止全部资源
默认 screen-frame adapter 存在
embedding crop 收到 Segment
remote extraction 使用 Range 而非完整 GET
```

## 10. pack 与 benchmark 修正

当前 npm 包包含：

```text
scripts/__pycache__/*.pyc
```

新增 `.npmignore` 或调整 package files，排除：

```text
**/__pycache__/**
**/*.pyc
```

不要排除真正需要的 `.py` runner、capture adapter、smoke 文档和 benchmark。

文档中区分：

```text
npm run bench:video-index   # 旧单体 A/B synthetic benchmark
npm run bench:long-video   # 6h chunk catalog/retrieval benchmark
```

不要把前者带 `--duration-hours` 后当成 6 小时分块 benchmark；该参数会被脚本忽略。

## 11. 必须运行的验证

```powershell
npm test
npm pack --dry-run --json --ignore-scripts
python -m py_compile scripts/audio-visual-runner.py
python -m py_compile scripts/loopback-recorder.py
python scripts/loopback-recorder.py --check
npm run bench:long-video -- --duration-hours 6 --chunk-minutes 5
```

另外分别运行新增的定向测试。`loopback --check` 因缺依赖 unavailable 可以作为环境限制，但不能因此跳过 fake recorder 的完整端到端测试。

检查 pack JSON：

- 必须包含 production screen-frame adapter；
- 必须包含 loopback runner/adapter；
- 不得包含 `__pycache__` 和 `.pyc`。

## 12. 真实 smoke 前置条件

只有满足以下条件后才进行 30 分钟真实抓播 smoke：

1. engine query 能从两个 fake audio segments 返回两段文本；
2. capture job_cancel 资源清理测试通过；
3. 默认生产 frame source 测试通过；
4. embedding Segment 契约测试通过；
5. Range proxy 测试证明没有完整下载对象。

真实环境缺 soundcard、浏览器、ASR 或模型时明确写“未执行”，不得把 fake 测试描述为真实 smoke。

## 13. 本轮验收标准

以下条件必须全部满足：

- 抓播音频在 ASR 前被处理；
- 两个以上 recorder segment 都进入索引；
- query 能返回抓播转写；
- 倍速、pause、seek、gap 映射有端到端断言；
- 无 CDP 时 chunk 时长来自真实采集时长；
- capture `job_cancel` 后零 commit、零活动 timer、零子进程；
- engine 有生产默认 frame source，输出有效 PNG；
- pyannote embedding 使用 `Segment(start,end)`；
- overlap 不进入 embedding；
- 空 embedding 不标 pending/ready；
- 远程 chunk 使用 Range/计量代理，不默认完整 GET；
- 下载超限杀掉 FFmpeg 并清理 socket/temp；
- 现有 213 个测试无回归，新增测试全部通过；
- pack 不含 pycache；
- 未执行的真实组件继续明确标未实测。

## 14. 最终交付格式

完成后按以下格式报告：

```text
1. R1～R5 状态
2. 修改文件清单
3. capture 音频从 recorder segment 到 query 的实际数据流
4. piecewise 时间映射实现
5. capture cancel 的资源和终态处理
6. production frame source 实现
7. pyannote Segment/overlap/状态处理
8. Range proxy、DNS 固定、字节计量和终止方式
9. 新增测试以及它们消除的旧假阳性
10. npm test 完整结果
11. Python 结果
12. npm pack 条目与 pycache 检查
13. 6h long-video benchmark
14. 真实 capture/ASR/pyannote/embedding/CDP/loopback 是否实测
15. 尚存风险
16. 是否执行 git commit
```

不要先反问，不要只给方案。请直接检查现有实现、修改代码、运行测试。未经用户要求不要执行 git commit。
