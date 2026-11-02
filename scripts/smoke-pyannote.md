# 手工 smoke：真实 pyannote diarization

**不进入 `npm test`。** 仅在本机已安装 Python / pyannote、并显式 opt-in 时使用。

## 前置

```powershell
$env:DSH_PYANNOTE_ENABLED = "1"
$env:DSH_PYANNOTE_PYTHON = "python"        # 可选：指向装了 pyannote 的虚拟环境
# 二选一：
$env:HF_TOKEN = "hf_..."                   # 在线：需要已接受模型条款的 token
$env:DSH_PYANNOTE_MODEL = "D:/models/pyannote-community-1"   # 离线：本地模型目录
```

## 确认探测（不需要 token / 模型，也不下载权重）

```powershell
& $env:DSH_PYANNOTE_PYTHON scripts/audio-visual-runner.py --check
# {"adapter": "pyannote.audio", "model": "pyannote/speaker-diarization-community-1", "telemetry": false}
```

## 本地模型（约 33 MB，之后可完全离线）

```powershell
python -c "from huggingface_hub import snapshot_download; snapshot_download('pyannote/speaker-diarization-community-1', local_dir=r'D:/models/pyannote-community-1')"
$env:DSH_PYANNOTE_MODEL = "D:/models/pyannote-community-1"
```

runner 直接读取 **16 kHz 单声道 PCM WAV**，不经过 torchcodec，所以静态 ffmpeg（没有 `avcodec-*.dll`）也能用；stdio 固定 UTF-8，中文路径可用。

## 直接跑一段音频

```powershell
'{"audioPath":".tmp/verify-voice/smoke/two-speaker-tts.wav","videoKey":"file:test:tts"}' |
  & $env:DSH_PYANNOTE_PYTHON scripts/audio-visual-runner.py
```

期望：`speakers` 里至少 1 个（双人素材应为 2 个）、`activeSegments` 覆盖整段、`observations` 每条带 `speakerClusterId`。

## 短音频 / 短视频索引

准备 5～20 秒本地文件，然后：

```js
video_index({
  action: "index",
  source: "file",
  path: "D:/short-interview.mp4",
  capabilities: { asr: "on", diarization: "on", identityBinding: "on" },
  rebuild: true
})
```

检查：

1. `manifest.capabilities.diarization === "ready"`
2. `audio-index.json` 含 `kind:"speaker"` / `active_segment`
3. query：

```js
video_index({
  action: "query",
  videoKey: "...",
  question: "分别有哪些人在说话，他们各自说了什么？",
  mode: "multimodal"
})
```

4. `context.speakers` 非空；多人时应覆盖多个 `speakerClusterId`
5. 纯音频时 `identityBinding` 不应为 `ready`

强制关闭验证：`$env:DSH_PYANNOTE_ENABLED="0"` 后 `available()` 必须 unavailable，且不启动 Python。

## Speaker merge（可选）

跨块合并需要额外的 `pyannote/embedding`（gated: `auto`），或本地目录：

```powershell
$env:DSH_PYANNOTE_EMBEDDING_MODEL = "D:/models/pyannote-embedding"
```

该模型不可用时，diarization 仍应成功，`manifest.capabilities.speakerMerge === "unavailable"`，utterance 保留 `speakerClusterId`（provisional），不应整段失败。
