# 给正在运行的 Grok：同步上游 0.0.6 / 0.0.7 必要修复

这是当前任务的增量要求。继续现有实现，不要重启任务，不要回滚或覆盖已经完成的 video-index、字幕优先、analysisPolicy、ASR 授权、profile、audit 等改动。

上游来源：`https://github.com/SAOS-3624/dsh-see-now`

- 最新 main：`06c4594381fe0ef59dbce0fb2c705c6621cc29b3`（0.0.7）
- 0.0.6 release：`916354d36e58fdd843fff96284ff7c985bd00020`
- 窗口资源修复：`f6402a177dea348603773035937d5e690decb1a6`
- 持续陪看修复：`dc022aa0dfe0606fc489b80e63a25431dd508302`

本地目录没有 `.git` 共同祖先，不要直接覆盖目录、不要把上游 package.json/README/CHANGELOG 整体复制过来。可以把上游浅克隆到临时目录，用 `git show`/逐文件 diff 移植语义；完成后删除临时目录。保留本地版本 `0.1.0` 和全部新增 exports/files/scripts。

## 一、必须合入：悬浮窗依赖与打包完整性（P0）

当前本地 `examples/floating-chat/window.py` 明确依赖：

- `window_protocol.py`
- `mic-dsh.png`
- 可能调用的 `mic.py`

但本地 `examples/floating-chat/` 目前只有 `window.py`。按上游 0.0.6 移植：

1. 补入上述三个运行时资源，来源必须是同一上游 revision，避免协议不一致。
2. 修改 `scripts/sync-window.mjs`，把窗口运行所需文件作为一个 bundle 同步，而不是只同步 `window.py`。
3. `--check` 必须逐个检查 bundle 文件，报告缺失/漂移；普通 sync 必须逐个原子或安全写入。
4. `package.json files` 必须确保这些 `.py/.png` 进入 npm 包，同时继续排除 `__pycache__`、`.pyc`。
5. 增加测试：打包输入完整；缺一个资源时 check 失败；完整时通过。
6. 不要把整个 `examples` 无限制打包造成缓存或大文件进入包；使用精确 glob 更稳妥。

## 二、必须合入：0.0.7 心跳误判修复（P1）

当前本地 `src/loop.js` 仍把 `runner.windowWasOpen() && !windowAlive()` 直接当作 `window-closed`。移植上游语义：

1. `src/window.js` 新增 `windowPidAlive()`：只检查 pid 进程是否存在，不检查 heartbeat。
2. `windowAlive()` 保持“窗口当前可用”的语义：pid 有效且 heartbeat 未过期；兼容没有 heartbeat 文件的旧窗口。
3. `src/loop.js` 新增纯函数 `windowVerdict()` 和 `WINDOW_GONE_TICKS=3`。
4. pid 消失才判 `closed`，继续走用户关窗/hangUp。
5. pid 存在但 heartbeat 过期时先累计 goneTicks；达到阈值才判 `stalled`，停止循环但不得 hangUp，下一次 watch 可以重开窗口。
6. status 能区分 `window-closed` 与 `window-stalled`。
7. 移植/改写 `test/heartbeat.test.mjs`，至少覆盖 alive、pid alive/heartbeat stale、进程消失、连续三拍 stalled、stalled 不 hangUp。

不要把 video-index 的 job heartbeat 与悬浮窗 heartbeat 混为同一个状态或文件。

## 三、必须合入：peek 不得清空已拼队列（P1）

当前本地 `runner.peek()` 仍调用 `pipeline.flushNow()`。改为：

1. `peek()` 用 `pipeline.take()` 获取已经完成的最早一张 sheet。
2. 队列为空返回 null，不凭空生成当前帧。
3. 用户插话要求立即截断、冷启动 eager 和 timeout 的专用路径仍可使用 `flushNow()`，不要一刀切全部替换。
4. 增加回归：预先排队的多帧 sheet 被 peek 原样取出；pending 递减；不会被当前单帧替换；连续 peek 按 FIFO。

## 四、必须合入：watch 开始前锁定会话 owner（P1）

当前本地 `ensureLoop()` 在 `runner.watch()` 返回后读取可变化的 `lastSessionId`。改为：

1. 进入阻塞 watch 前记录 `ownerAtStart = lastSessionId`。
2. `ensureLoop(owner = null)` 优先使用显式 owner。
3. watch 返回后调用 `ensureLoop(ownerAtStart)`。
4. peek 等非阻塞路径仍可使用当前会话，但必须保持现有多会话重建判断。
5. 增加测试：A 开始 watch，等待期间 B 更新 session/event，最终 loop.session 仍为 A。

## 五、必须合入：minFrames 所有成功路径生效（P1）

1. 正常队列提前返回也必须检查 `sheet.frames.length >= minFrames`。
2. 不足时丢弃该 sheet 并继续等待，不能返回 `ok:true`。
3. timeout partial 路径保留检查。
4. `scene:true`/逐场景模式每张固定一帧，应把 effective minFrames 设为 1，并向结果/提示说明用户设置在此模式不生效。
5. 增加正常返回、timeout、scene 互斥三个方向的回归测试。

## 六、可兼容移植但不得阻塞主任务（P2）

主任务和上述 P0/P1 全绿后，如不与本地扩展冲突，再移植：

1. `src/binaries.js` 的 FFmpeg 查找顺序：显式参数/DSH_FFMPEG_PATH/FFMPEG_PATH/DSH_FFMPEG_DIR/DSH_HOME tools/bin/PATH。
2. macOS `avfoundation` 屏幕、摄像头、crop、像素格式探针和黑屏权限提示。
3. `ensureConfiguredVoice()` 热重载；不得影响未配置 voice 的主路径。
4. `bin/see-window.mjs` 与 `dsh-see-window --status/--force/--close`，并在本地 package.json 合并 bin 字段，不能覆盖现有字段。
5. `examples/voice-say-mac.mjs` 与 `scripts/mac-live-smoke.mjs`。

如果本轮不做 P2，最终报告必须逐项标为 deferred，不得写成已完成。

## 七、并发工作与当前 schema 状态

我在你运行期间观察到 `src/video-index/schema.js` 已开始接受 capability 状态 `disabled`，说明当前工作正在写入。请以你最终文件为准，并保证：

1. capability 的生产端、schema、manifest、store、query 和测试使用同一枚举。
2. `speechActivityAssist:false` 可规范化为 `disabled`，但不得出现 schema 拒绝自身输出。
3. 在所有代码写完后再运行一次完整测试，不能引用此前的 225 pass 作为本轮结果。

## 八、最终验收

完成当前字幕优先主任务与本增量后执行：

1. `npm test`
2. `npm pack --dry-run --json --ignore-scripts`
3. 检查 pack 包含 window.py、window_protocol.py、mic.py、mic-dsh.png（以及实际启用的 bin/voice/mac 文件）。
4. 检查 pack 不含 `__pycache__`、`.pyc`、临时媒体、模型、索引缓存、token。
5. 检查 Windows 现有 capture/video-index 测试无回归。
6. 无 macOS 实机时只能报告协议和 fake 测试通过，不能声称 macOS 真实采集通过。

最终交付报告单独增加“上游同步”章节，列出：

- 每个上游 commit 的移植状态：done / equivalent-existing / deferred。
- 实际修改文件。
- 新增回归测试。
- 本地扩展与上游发生冲突时采用的合并策略。
- 最终真实 pass/fail 和 pack 条目数。

不要执行 git commit。
