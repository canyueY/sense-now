# Cursor / Grok 修复任务书：接通抓播、跨块 Speaker 与后台任务安全边界

> 将本文从“你现在是……”开始完整提交给 Cursor 中的 Grok 模型。目标是直接修改代码、补测试并验证，不是再次输出设计建议。

---

你现在是本项目的高级 Node.js、Python、FFmpeg、Windows 音频和本地索引工程师。请直接在当前工作区修复已经通过独立审查确认的 7 个生产缺口。

仓库路径：

```text
<repo-root>/sense-now
```

参考文档：

```text
docs/超长视频与B站流式索引-Grok实施任务书.md
docs/超长视频与B站流式索引方案.md
```

参考文档只是背景。以下缺口、约束和验收条件优先级更高。不要只回复方案，不要等待确认；先检查现有代码和测试，然后逐项实施。

## 1. 已知审查基线

审查时得到以下结果。它们是修复前基线，不是完成声明：

```text
项目测试：171 / 173
其中 2 个失败为当前沙箱 spawn EPERM；测试总数与预期 198 对上

旧回归 harness：78 / 78
新增独立检查：64 / 73
其中 9 个失败对应本文列出的缺口

Python：两个脚本 py_compile 通过
loopback --check：本机 unavailable，原因是缺少 soundcard

真实 pyannote 分块偏移：通过
offset=300000 时首段从 300217 开始，识别出 2 speaker，chunkId 正确

6 小时合成 benchmark：
P95 5.94ms，平均读取 2.6 个 chunk，heap 6.4MB
```

不要把不同 harness 的 pass 数相加后宣称为单一测试套件结果。修复后分别报告每套测试的真实结果，并把环境错误与代码断言失败分开。

## 2. 总目标

完成后必须满足：

1. `capture_start` 后确实启动 CDP 采样、loopback 录音和区域画面采集，而不是只创建一个 `capturing` job；
2. capture 产生可索引的 chunk，`capture_stop` 完整 flush 后等待或触发剩余 chunk 索引；
3. diarization 可选地产出 speaker embedding，并在 job finalize 阶段生成跨 chunk 的全局 speaker 映射；
4. `cancelled` 是终态；取消后不得提交新 chunk、不得重建 catalog、不得覆盖成 `ready`；
5. 非法 jobId 返回结构化错误，不从公开工具抛异常；
6. 所有 chunkId 入口统一校验，不允许 staging 路径穿越；
7. 远程媒体只接受 allowlist 域名，不接受裸 IP，并真正执行 `maxDownloadBytes`；
8. `execution:"auto"` 在调用方没有提供 `durationMs` 时也会主动探测时长，再选择同步或后台路径；
9. 不破坏旧单体索引、现有短视频路径、查询预算、pyannote 偏移和两级检索。

## 3. 实施顺序

严格按以下顺序，每一阶段先补测试再继续：

```text
P0 记录基线
P1 C3 cancel 终态 + C4/C5 输入边界
P2 C6 远程源安全与真实下载预算
P3 C7 auto 时长探测
P4 C2 embedding 生产端与 finalize 合并
P5 C1 抓播生产链路
P6 集成、回归、pack、真实 smoke 说明
```

先修原子性和安全边界，再接需要长时间运行的抓播。

## 4. C3：让 cancel 成为不可逆终态

### 4.1 当前问题

`jobCancel()` 会 abort 并把状态写成 `cancelled`，但正在执行的 `indexChunk()` 返回后仍可能提交 chunk；循环结束后还会进入 `finalizing`，最终把状态覆盖成 `ready`。

实测现象：

```text
cancel returned: cancelled
400ms 后 final state: ready
并且提交了 1 个 chunk
```

### 4.2 强制实现

在 job 持久化状态和 live handle 中都保存取消意图：

```js
{
  cancelRequested: true,
  cancelRequestedAt,
  state: "cancelled",
  stage: "cancelled"
}
```

新增统一守卫，例如：

```js
assertJobMayContinue(jobId, signal)
```

至少在以下位置检查：

1. 每个 chunk 开始前；
2. `indexChunk()` 返回后；
3. `commitChunk()` 前；
4. commit 后、更新进度前；
5. `rebuildCatalog()` 前；
6. 写 final state 前。

规则：

- `AbortSignal.aborted` 或持久化的 `cancelRequested=true` 任一成立都停止；
- `cancelled` 是终态，普通 `updateJob()` 不得把它改成 `indexing/finalizing/ready/degraded/failed`；
- 只有显式 `job_resume` 可以创建新的 attempt 并清除取消意图；推荐增加单调递增 `attempt`，旧 attempt 的异步回调不得更新新 attempt；
- 如果取消发生在 staging 写入期间，调用 `abortChunk()`；
- 如果原子 rename 已经完成，保留这个已完整提交的 chunk，但不得继续提交后续 chunk，也不得把 job 改成 ready；
- `jobCancel()` 必须幂等；重复取消返回当前 cancelled 状态；
- release lock 只能由仍持有相同 lock nonce/attempt 的执行者完成，避免旧回调释放新 job 的锁。

不要只依赖 AbortSignal。外部 adapter 可能忽略 signal，所以 commit 前的持久化状态检查是必须的。

### 4.3 测试

使用 deferred Promise 精确控制 `indexChunk()`：

- indexChunk 运行中 cancel，随后 resolve：零新 commit，最终仍 cancelled；
- cancel 恰好发生在 commit 前：零 commit；
- cancel 恰好发生在 atomic commit 后：最多保留该完整 chunk，最终 cancelled；
- cancel 后等待 500ms，状态不变化；
- 重复 cancel 幂等；
- cancel 后 resume 使用新 attempt，旧异步回调不能污染新状态；
- cancelled job 不执行 finalize/catalog rebuild。

## 5. C4：公开 job API 不因非法 jobId 抛错

### 5.1 当前问题

`job-store.js` 的 `jobPath()` 对非法 id 抛出 `unsafe jobId`。`job_status/job_cancel/job_resume` 直接把该异常暴露到工具层。

### 5.2 强制实现

保留 store 内部的严格校验，但在 controller 或 tool 公共边界统一处理：

```js
{ ok: false, reason: "invalid_job_id" }
```

不存在但格式合法：

```js
{ ok: false, reason: "not-found" }
```

要求：

- 不回显完整恶意输入；
- 不泄露绝对路径或堆栈；
- `job_status/job_cancel/job_resume/capture_stop` 行为一致；
- store 的 `jobPath()` 仍必须拒绝路径分隔符、`..`、控制字符和超长字符串；
- tool.route 最终总能返回可 JSON 序列化结果。

### 5.3 测试

覆盖：

```text
nope
../x
..\x
空字符串
控制字符
10KB 字符串
格式合法但不存在的 job_xxxxxxxx
```

所有公开 action 均不得 throw。

## 6. C5：统一 chunkId 校验，关闭 staging 路径穿越

### 6.1 当前问题

`chunkDir()` 校验 `^\d{6}$`，但 `beginChunk()`、`abortChunk()` 和部分 staging 路径直接拼接 `chunkId`，导致：

```js
beginChunk('../../escape')
```

可以在预期视频目录之外创建 staging。

### 6.2 强制实现

新增并导出唯一校验器：

```js
export function assertChunkId(value) {
  const id = String(value ?? "");
  if (!/^\d{6}$/.test(id)) {
    const err = new Error("invalid chunkId");
    err.code = "INVALID_CHUNK_ID";
    throw err;
  }
  return id;
}
```

下列所有路径在任何字符串拼接前调用它：

- `chunkDir`
- `stagingName`
- `beginChunk`
- `abortChunk`
- `commitChunk`
- `readChunk`
- trash/replace/recovery 路径
- catalog 中读取到的 chunkId

所有最终路径仍通过 `resolveInside()` 二次约束。验证失败时必须在创建目录之前发生。

### 6.3 测试

- `../../escape`、`..\\escape`、绝对路径、斜杠、NUL、空值、过长 id 全部拒绝；
- 拒绝后 workspace 外和 videoDir 内都没有新 staging；
- `000000`、`000001` 正常工作；
- 被篡改的 catalog 不能引导读取目录外文件。

## 7. C6：收紧远程 SSRF，并真正限制下载字节

### 7.1 当前问题

当前 `assertPublicHttpsUrl()` 会允许公网裸 IP，例如：

```text
https://8.8.8.8/...
```

此外 `maxDownloadBytes` 只出现在默认配置中，实际代码只检查输出 WAV/PNG 的 `maxTempBytes`。输出文件大小不是网络下载字节。

### 7.2 URL 策略

内部 stream descriptor 的 URL 必须同时满足：

1. HTTPS；
2. hostname 是域名，`net.isIP(hostname) === 0`；
3. hostname 匹配经过配置的 B 站 CDN suffix allowlist；
4. 无 username/password、fragment、控制字符；
5. DNS 解析结果全部为公网地址；
6. 每次 descriptor refresh 和每次连接前都重新校验；
7. redirect 每一跳重复同样校验；无法检查跳转链时必须禁用自动跳转或改走受控 transport；
8. 禁止 `file:`, `data:`, `concat:`, `subfile:` 等本地或复合协议。

即使某个裸 IP 是公网地址也必须拒绝，因为它绕过了域名 allowlist。

扩充 IP 分类，至少拒绝：

- IPv4/IPv6 loopback、private、link-local、multicast、unspecified；
- CGNAT、benchmark、documentation、reserved；
- IPv4-mapped IPv6；
- 云 metadata 常见地址；
- 非规范化或解析失败地址。

### 7.3 下载字节硬限制

必须区分：

```js
byteUsage.downloaded       // 实际网络响应字节
byteUsage.temporaryPeak    // 临时磁盘峰值
byteUsage.outputBytes      // 最终 WAV/PNG 大小
```

不能再用输出文件大小填充 `downloaded`。

实现一个可观测、可中断的受控 transport。可选方案：

- Node 受控 HTTPS/Range 下载器或本地计量代理，把安全校验后的响应流交给 FFmpeg；或
- 能可靠返回实际网络输入字节并在超过上限时主动终止 FFmpeg 进程树的注入 runner。

无论选择哪种方案，都必须保证生产默认 runner 也执行硬上限，而不只是测试 stub。

超过 `maxDownloadBytes` 时：

1. 立即 abort 网络流；
2. 终止 FFmpeg 进程树；
3. 删除未完成临时文件；
4. 抛出稳定错误码 `DOWNLOAD_LIMIT`；
5. 不把 chunk 标成 ready。

如果当前 FFmpeg 直连模式无法准确计量，就不能声称已经执行该限制。应切换到受控 transport；不要以预计码率或输出大小代替实际计数。

### 7.4 测试

只使用本地 HTTP/HTTPS fixture 和注入 DNS：

- 公网裸 IPv4/IPv6 仍拒绝；
- allowlist 域名 + 公网解析允许；
- allowlist 域名解析到私网拒绝；
- 302 跳到裸 IP/私网拒绝；
- 超过 `maxDownloadBytes` 中途终止，临时文件删除；
- `maxTempBytes` 和 `maxDownloadBytes` 分别触发不同错误；
- 统计的 downloaded 是输入字节，不等于输出 WAV 大小；
- CRLF/NUL header 继续拒绝；
- 测试不访问真实 B 站。

## 8. C7：`execution:auto` 必须主动取得时长

### 8.1 当前问题

`video-index-tool.js` 只在调用方显式传入 `durationMs` 且大于阈值时选择后台路径。不传 duration 时会走同步旧路径。B 站长视频因此可能只建立元数据或在工具调用中超时。

### 8.2 强制实现

不要在 tool 层仅凭用户参数提前决定同步/后台。把“解析来源、取得时长、选择执行模式”收敛到 engine 的一个入口，且来源只解析一次。

推荐契约：

```js
await eng.indexAdaptive({
  source,
  execution: "auto|sync|background",
  durationMs: optionalHint,
  capabilities,
  signal,
});
```

规则：

- B 站：`resolveStreams()` 返回 `durationMs` 后再决定；descriptor 只在内存使用，不能落盘或返回；
- 本地文件：优先使用 file source/ffprobe 元数据取得时长；
- 用户传入 duration 只是 hint，若与探测值差异明显，以探测值为准并记录非敏感 warning；
- `auto` 且时长大于 `SYNC_SAFE_MS`：返回后台 job；
- `auto` 且短视频：可以继续旧同步路径，保持兼容；
- `background`：无论时长都返回 job，但仍需探测时长用于 chunk plan；
- `sync`：保留显式同步语义，但仍受工具硬超时；
- 无法取得时长时，不得静默进入可能无限运行的旧同步路径。返回 `DURATION_UNKNOWN`，或采用明确有硬上限的安全后台探测状态；
- 不得为判断时长下载整部媒体；
- 不得重复调用 `resolveStreams()` 导致签名 URL 和 part 身份不一致。

### 8.3 测试

- B 站 mock 不传 duration，resolver 返回 2h：立即返回 background job；
- 本地 mock 不传 duration，probe 返回 2h：后台；
- 不传 duration，probe 返回 2min：旧同步能力不回归；
- `execution:background` 强制后台；
- `execution:sync` 保持同步；
- duration 未知返回稳定错误，不进入旧长 Promise；
- resolver 只调用一次；
- descriptor/signed URL 不出现在 job JSON、工具 meta 或日志。

## 9. C2：接通跨 chunk speaker embedding 生产端

### 9.1 当前问题

- engine 固定传 `returnEmbeddings:false`；
- Python runner 收到 `true` 后只有 `pass`；
- `mergeSpeakersByEmbedding()` 只有单测，没有被生产 controller 调用；
- 所有 speaker 永远停留在 `Cxxxxx_SPEAKER_yy`。

### 9.2 配置和 capability

增加明确配置，不因存在 `HF_TOKEN` 就自动开启：

```js
speakerMerge: {
  enabled: false,              // 默认关闭，用户显式开启
  threshold: 0.78,
  persistEmbeddings: false     // 默认绝不落盘
}
```

只有以下条件全部成立才请求 embedding：

- diarization 已显式开启；
- `speakerMerge.enabled === true`；
- runner 报告 embedding backend available。

capability 状态应区分：

```text
disabled
pending
ready
tentative
unavailable
degraded
```

没有真实 embedding 时不得标 `speakerMerge:ready`。

### 9.3 Python runner 输出

当 `returnEmbeddings:true` 时，runner 必须为每个有足够语音时长的本地 speaker 计算归一化的 centroid embedding。

输出建议：

```json
{
  "speakerEmbeddings": [
    {
      "localSpeakerId": "SPEAKER_00",
      "embedding": [0.01, -0.02],
      "dimension": 512,
      "segmentCount": 4,
      "totalMs": 18320,
      "modelId": "configured-model-id"
    }
  ]
}
```

要求：

- 使用明确可配置的 speaker embedding model/backend；不要假设 diarization pipeline 输出天然带 embedding；
- 模型不可用时返回结构化 unavailable，不能返回空数组后标 ready；
- 只选择非 overlap、达到最小时长的片段；
- 对每段做长度和数量硬上限，防止单个 speaker 占用无限推理资源；
- centroid 做 L2 normalize；
- 不在 stdout 日志中单独打印 embedding；
- 不返回人名，只返回匿名局部 speaker id；
- `returnEmbeddings:false` 时保持现有行为和性能。

Node adapter 必须严格校验：数组长度、维度一致、全部 finite、总 speaker 数硬顶、向量维度合理，并拒绝 NaN/Infinity/超大对象。

### 9.4 controller finalize 合并

`indexChunk()` 把 embedding 作为私有运行时字段返回给 controller；不要写进普通 chunk JSON、query context、evidence package、日志或工具 meta。

正常不中断的 job：

1. controller 在内存收集各 chunk 的 embedding；
2. 调用 `mergeSpeakersByEmbedding()`；
3. 阈值外不合并；歧义匹配保持 tentative；
4. 发布不含向量的 `speaker-map.json`，记录：

```json
{
  "C000001_SPEAKER_00": {
    "globalSpeakerId": "GSPK_0001",
    "state": "confirmed|tentative|unmerged",
    "score": 0.84,
    "mergeEvidence": ["chunk:000001", "chunk:000002"]
  }
}
```

5. query 读取映射后返回 global id，同时保留原始 chunk-local id 以便追溯；
6. 不重写已经原子提交的 chunk；通过 global mapping 解释它们。

恢复语义：

- `persistEmbeddings:false` 时，崩溃前的向量不可恢复；恢复后只能对当前进程拥有的向量合并，整体 capability 标 tentative/degraded；
- 只有用户显式设置 `persistEmbeddings:true` 时，才允许写入 videoDir 下的 `private/`；
- private 文件必须不进入 npm pack、query、evidence、普通 cleanup 报告或日志，并尽可能使用仅当前用户可读权限；
- cleanup 提供明确的 private embedding 删除路径；
- 不允许为了 resume 偷偷改变默认隐私策略。

### 9.5 测试

- `returnEmbeddings:false` 不加载 embedding backend；
- true 时 runner stub 返回两个有限向量并通过 adapter；
- NaN、Infinity、维度不一致、超大向量拒绝；
- 两块同一声音合并为同一 global id；
- 低分、冲突和 overlap 保持 tentative/unmerged；
- finalize 生产调用 merge，而不是只测孤立函数；
- chunk、job、query cache、日志和 evidence 中搜索不到向量；
- query 能看到 global id 与 merge state；
- 无 embedding 时 capability 不假 ready；
- 默认不创建 `private/`；显式持久化时 cleanup 可安全删除。

## 10. C1：接通完整抓播生产链路

这是本轮最大改动，必须在前述安全和取消语义完成后实施。

### 10.1 当前问题

当前行为：

- `capture-source.js` 有 `tick()`，但没有调度调用；
- engine 只传入 `adapters.loopbackRecorder || null`，仓库没有默认 Node recorder adapter；
- `scripts/loopback-recorder.py` 没有被生产代码启动；
- 没有任何 capture job 调用 `capture.js` 的 `spawnFrames()` 抓 region；
- `captureStart()` 只创建 `state:"capturing"`；
- `captureStop()` 只停止 session 并改状态；
- 不生成音频 chunk、storyboard、utterance 或索引。

不得再让 `capture_start` 在零采集时返回貌似成功的 capturing。任一必选组件启动失败时，返回 degraded/unavailable 并说明具体 capability。

### 10.2 新增 Node loopback adapter

建议新增：

```text
src/video-index/adapters/loopback-recorder.js
```

负责：

- 运行 `python scripts/loopback-recorder.py`，参数数组且 `shell:false`；
- 启动前执行或缓存 `--check`；
- 使用现有 bounded stdio 和进程树终止能力；
- 逐行解析有界 JSON 事件；
- 暴露 `start() / stop() / onSegment() / status()`；
- Python 不可用或依赖缺失时返回 structured unavailable；
- 输出写 capture job 专属 temp/staging 目录；
- 不接受 token、cookie、URL 作为子进程参数；
- stop 必须等待 flush 完成并验证 WAV/sidecar 已原子落盘；
- adapter 崩溃时记录 recoverable gap，不伪造连续音频。

修改 Python recorder：

- 支持显式 continuous 模式，而不是未传 duration 时只录一个 segment；
- 通过 0.5～1 秒小块采样累计成约 30 秒 WAV，避免 stop 时丢失整段；
- SIGINT/SIGTERM 时 flush 当前非空 partial segment，再发 stop 事件；
- sidecar 保存 monotonic start/end、wall start/end、sample count、sample rate；
- 设备失效返回 `device_invalidated` 且可重试次数有硬顶；
- `.tmp` 写完后 `os.replace()`；
- 不静默选择麦克风，必须是默认 render endpoint 的 loopback；
- `--check` 永不开始录音。

### 10.3 调度 CDP tick

不要裸写一个无法停止的 `setInterval(session.tick, 1000)`。实现可测试的 capture controller/scheduler：

```js
const timer = scheduler.every(1000, async () => { ... });
```

要求：

- 默认 1000ms 采样一次；
- 上一次 tick 未结束时跳过，不并发堆积；
- tick 异常有界重试并记录 time-source degraded；
- pause、seek、倍速、navigation 按现有 time-mapping 切 segment；
- `visibilityState:hidden` 不能单独当暂停；
- stop/cancel/host shutdown 必须 clear timer 并等待正在执行的 tick settle；
- fake scheduler/fake clock 可在单测中确定性推进。

### 10.4 接入区域画面采集

使用 `src/capture.js` 的 `spawnFrames()` 或一个生产默认实现以它为底层的 adapter。

要求：

- `capture_start` 仍要求显式 manual region；
- `gdigrab` 和 `ddagrab` 都必须真正应用 x/y/width/height；当前若 ddagrab 不支持 region，要增加正确 crop 链或安全回退 gdigrab，不能悄悄抓全屏；
- 抓帧频率和保留频率分离；只保留有硬上限的 storyboard 帧，例如每 30 秒最多一帧；
- raw RGB 不无限排队；沿用背压或 bounded single-flight；
- 保存帧时关联最新 CDP sample/mapping segment，得到 video timestamp；
- CDP 不可用时标 `timeSource:"wallclock"`，不能伪造播放器时间；
- pause 期间可不保留重复帧；seek/rate change/navigation 立即切 capture chunk；
- stop/cancel 终止 FFmpeg 进程树并等待 done settle；
- PNG/JPEG 写 staging，索引提交前不可见；
- 画面组件不可用时，音频仍可继续但 job 标 degraded，反之亦然。

### 10.5 capture chunk 与索引

新增一个 controller，把以下事件组合成可提交 capture chunk：

- recorder segment；
- CDP mapping segment；
- retained frames；
- gap/discontinuity；
- URL/BVID/CID/part 变化；
- pause/seek/rate change。

不要把 capture audio 当作普通媒体文件后再次按错误的播放器绝对时间 seek。扩展 `indexChunk()` 输入契约，明确支持预切好的 capture bundle，例如：

```js
sourceDescriptor: {
  captureBundle: {
    audioSegments: [{ path, wallStartMs, wallEndMs }],
    frames: [{ path, wallMs, videoMs }],
    mappingSegments: [],
    gaps: []
  }
}
```

索引时：

1. 合并或顺序处理属于该 chunk 的 WAV；
2. ASR/diarization 先得到 capture-local 时间；
3. 使用分段线性 mapping 转为视频时间；
4. 跨 gap 的结果拆分或丢弃，不跨越缺口伪造 utterance；
5. retained frames 直接进入 storyboard，不重新从不存在的媒体文件提取；
6. 走现有 `indexChunk → commitChunk → catalog/query` 链路；
7. chunk commit 前执行 cancel/attempt 守卫；
8. URL 可用时仍以 URL refine 为权威 revision，capture revision 不被静默覆盖。

切块规则：

- 默认目标约 5 分钟；
- seek、navigation、part 改变、CDP 时间倒退、大 gap 强制提前切块；
- stop 时 flush 最后不足 5 分钟的 chunk；
- recorder 的 30 秒文件只是输入 segment，不等同于索引 chunk；
- chunk 使用半开区间并沿用 overlap ownership，不能重复证据。

### 10.6 capture job 状态

状态至少覆盖：

```text
starting
capturing
flushing
indexing
finalizing
ready | degraded | failed | cancelled
```

`capture_start` 只有在至少一个真实采集组件成功启动后才能返回 `ok:true`，返回 capability：

```js
{
  cdp: "ready|degraded|unavailable",
  audioCapture: "ready|degraded|unavailable",
  frameCapture: "ready|degraded|unavailable"
}
```

如果音频和画面都不可用，则 start 失败并清理 timer/process/temp/lock。

`capture_stop`：

1. 阻止新 tick/frame；
2. graceful stop recorder；
3. flush partial WAV；
4. finalize capture bundle；
5. 索引最后 chunk；
6. rebuild catalog；
7. 最后才进入 ready/degraded；
8. 返回真实的 chunk/utterance/frame/speaker 计数。

可以让 stop 返回 `flushing/indexing` 并由 `job_status` 观察完成，但不能先报 ready 再后台写数据。

### 10.7 capture 测试

全部自动测试使用 fake recorder、fake scheduler、fake CDP、fake frame source：

- start 后每秒调用 tick，stop 后不再调用；
- tick 不重入；
- recorder segment 进入 capture bundle；
- frame 与最新 video time 对齐；
- pause/seek/rate change/navigation 切 mapping/chunk；
- hidden 但 currentTime 前进仍继续；
- stop flush partial segment；
- stop 后至少产生一个可 query chunk；
- ASR utterance 经 mapping 得到正确绝对时间；
- gap 不被 utterance 跨越；
- cancel 终止 timer、recorder、frame process，且不提交新 chunk；
- recorder unavailable + frame ready：degraded 但可运行；
- audio/frame 均 unavailable：start 失败且零泄漏；
- ddagrab region 不得退化为未提示的全屏采集；
- 临时目录和进程在异常路径被清理。

## 11. 需要修改或新增的文件

先根据实际仓库结构确认，预计至少涉及：

```text
src/video-index-tool.js
src/video-index/video-index-engine.js
src/video-index/job-controller.js
src/video-index/job-store.js
src/video-index/chunk-store.js
src/video-index/remote-media.js
src/video-index/capture-source.js
src/video-index/speaker-merge.js
src/video-index/adapters/audio-visual-adapter.js 或实际同职责模块
src/video-index/adapters/pyannote-runner.js
src/video-index/adapters/loopback-recorder.js          # 新增
src/video-index/capture-controller.js                  # 可新增
src/capture.js
scripts/audio-visual-runner.py
scripts/loopback-recorder.py
README.md
docs/超长视频与B站流式索引方案.md 或独立实现说明
```

测试建议新增/扩展：

```text
test/job-cancel-terminal.test.mjs
test/job-id-validation.test.mjs
test/chunk-path-security.test.mjs
test/remote-media-limits.test.mjs
test/auto-duration-routing.test.mjs
test/speaker-merge-production.test.mjs
test/capture-pipeline.test.mjs
```

可以按项目现有习惯合并文件，但每个缺口都必须有独立回归断言。

## 12. 兼容与隐私要求

- 不删除或放宽旧测试；
- 不改变旧单体索引的只读兼容；
- 不把 HF token、cookie、signed URL、请求头或 embedding 写入日志/manifest/tool meta；
- 不因检测到 `HF_TOKEN` 就自动开启 pyannote 或 embedding；显式关闭必须有效；
- capture 必须由用户显式 action 启动，禁止插件加载时自动录屏/录音；
- 不读取或复制浏览器默认 cookie 数据库；
- 不把 `visibilityState:hidden` 当作暂停；
- 不声称 capture 崩溃后无损恢复；缺失区间必须记录 gap；
- 不用删除失败测试、扩大 timeout 或吞异常来制造全绿；
- 所有数组、stdio、帧队列、向量和临时磁盘均保留硬上限。

## 13. 强制验证命令

先记录修复前结果，完成后运行：

```powershell
npm test
npm pack --dry-run --json --ignore-scripts
python -m py_compile scripts/audio-visual-runner.py
python -m py_compile scripts/loopback-recorder.py
python scripts/loopback-recorder.py --check
npm run bench:video-index -- --duration-hours 6 --chunk-minutes 5
```

如果仓库已有独立 audit/harness 命令，也必须分别运行并报告。不要把 `spawn EPERM`、缺 `soundcard`、缺模型权限伪装成代码通过；同时也不要把明确的环境限制误报成断言回归。

对新增安全测试可以单独运行，确保失败时能定位 C1～C7。

## 14. 真实 smoke 门槛

自动测试通过后，提供一个不会进入默认测试的显式 smoke 文档或脚本：

```text
30 分钟 B 站普通投稿播放
手动 region
显式 capture_start
CDP 每秒采样
loopback 连续分段
capture_stop flush
等待 job ready/degraded
查询开头、中间、结尾内容和 speaker
```

smoke 必须输出：

- 实际捕获时长；
- CDP sample 数和失败数；
- audio segment 数、总样本数和 gap；
- retained frame 数；
- ready/degraded chunk 数；
- utterance/speaker 数；
- capture 视频时间误差；
- backlog 峰值；
- 是否使用真实 ASR、pyannote、embedding；
- 所有 capability 的最终状态。

没有声卡依赖、浏览器、模型或授权时，不要伪造 smoke 通过。交付实现、fake 集成测试和可复现命令，并明确写“真实抓播未执行”。

## 15. 本轮验收条件

必须全部满足：

1. C1～C7 各有生产代码修复和自动回归测试；
2. `capture_start` 不再空转；fake 集成测试证明会产生可 query chunk；
3. cancel 后延迟观察仍为 cancelled，且没有取消后的 commit；
4. 恶意 jobId 不 throw；
5. 恶意 chunkId 无任何目录副作用；
6. 裸公网 IP 被拒绝，下载预算按真实输入字节强制终止；
7. 不传 duration 的 2 小时来源自动进入后台；
8. 开启 speaker merge 时生产 finalize 确实调用合并并发布匿名全局映射；
9. 默认不持久化 embedding；
10. 旧 78/78 harness 不回归；
11. 原有可运行测试不新增断言失败；
12. npm 包包含新增 Node/Python 运行时文件；
13. 文档明确安装 loopback 可选依赖、显式启用方法和隐私行为。

以下数据在真实运行前仍只是 benchmark/验收目标，不得写成已验证事实：

```text
30 分钟真实抓播稳定性
抓播时间误差
backlog
真实 6 小时媒体 query P95
跨块 speaker 一致率
真实 B 站 CDN 下载比例
```

已有的 6 小时合成结果 `P95 5.94ms / 平均 2.6 块 / heap 6.4MB` 只能标记为合成 benchmark，不代表真实媒体表现。

## 16. 最终交付格式

完成后按以下结构报告：

```text
1. 总结：C1～C7 各自状态
2. 修改文件清单
3. 抓播实际数据流：start → tick/record/frame → chunk → index → query
4. cancel 终态实现和竞态处理
5. speaker embedding/merge 实现与隐私边界
6. SSRF 与 maxDownloadBytes 实现方式
7. auto duration 路由行为
8. 新增测试及每套 harness 的独立 pass/fail
9. npm test 结果；环境 EPERM 单独列出
10. Python py_compile 与 loopback --check
11. npm pack 条目数与新增运行时文件确认
12. 6h 合成 benchmark
13. 是否执行 30 分钟真实抓播 smoke；未执行就明确写未执行
14. 真实 ASR/pyannote/embedding/CDP/loopback 各自是否实测
15. 尚存风险
16. 是否执行 git commit
```

不要只提供 diff 摘要。给出实际测试命令与真实输出概况。未经用户要求不要执行 git commit。

请现在直接开始检查和修改代码。
