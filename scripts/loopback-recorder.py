#!/usr/bin/env python3
"""
loopback-recorder.py — 可选 WASAPI loopback 录音（显式启动，不静默后台）。

--check 仅探测依赖，不录音。
--continuous 连续分段（约 30s），直到 SIGTERM/SIGINT。
未安装 soundcard / pyaudiowpatch 时以 JSON unavailable 退出，不拖垮插件加载。
"""

from __future__ import annotations

import argparse
import array
import json
import os
import signal
import sys
import time
import wave
from pathlib import Path

SAMPLE_RATE = 16000
CHANNELS = 1
SEGMENT_SEC = 30
BLOCK_SEC = 0.5
MAX_DEVICE_RETRIES = 3

_stop = False
_partial: list[int] = []
_out_dir: Path | None = None
_seg_idx = 0
_mono_start = 0.0
_wall_seg_start = 0.0


def emit(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    if len(line) > 16_000:
        line = json.dumps({"type": "error", "reason": "event_too_large"}, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def fail(msg: str, code: int = 1) -> None:
    emit({"type": "error", "ok": False, "reason": "failed", "detail": str(msg)[:500]})
    sys.exit(code)


def check_deps() -> dict:
    backends = []
    errors = []
    try:
        import soundcard  # type: ignore  # noqa: F401
        backends.append("soundcard")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"soundcard:{exc}")
    try:
        import pyaudiowpatch  # type: ignore  # noqa: F401
        backends.append("pyaudiowpatch")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"pyaudiowpatch:{exc}")
    if not backends:
        return {
            "ok": False,
            "reason": "unavailable",
            "detail": "no loopback backend; install soundcard or pyaudiowpatch",
            "errors": errors[:4],
        }
    return {"ok": True, "backends": backends, "sampleRate": SAMPLE_RATE, "channels": CHANNELS}


def atomic_write_wav(path: Path, frames: bytes, sample_rate: int = SAMPLE_RATE) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with wave.open(str(tmp), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(frames)
    os.replace(tmp, path)


def flush_partial() -> None:
    global _seg_idx, _partial
    if not _out_dir or not _partial:
        return
    pcm = array.array("h", _partial)
    raw = pcm.tobytes()
    n = len(pcm)
    name = f"seg_{_seg_idx:05d}.wav"
    path = _out_dir / name
    wall_end = time.time()
    mono_end = time.monotonic()
    atomic_write_wav(path, raw)
    sidecar = {
        "file": name,
        "sampleCount": n,
        "sampleRate": SAMPLE_RATE,
        "wallStart": _wall_seg_start,
        "wallEnd": wall_end,
        "monotonicStart": _mono_start,
        "monotonicEnd": mono_end,
        "segmentIndex": _seg_idx,
        "partial": True,
    }
    ( _out_dir / f"{name}.json").write_text(json.dumps(sidecar, ensure_ascii=False), encoding="utf-8")
    emit({"type": "segment", **sidecar})
    _seg_idx += 1
    _partial = []


def _on_signal(signum, _frame) -> None:  # noqa: ANN001
    global _stop
    _stop = True
    emit({"type": "signal", "signum": int(signum)})


def record_soundcard(out_dir: Path, duration_sec: float | None, continuous: bool) -> int:
    global _stop, _partial, _out_dir, _seg_idx, _mono_start, _wall_seg_start
    import soundcard as sc  # type: ignore

    _out_dir = out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    speaker = sc.default_speaker()
    loop = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    emit({"type": "start", "backend": "soundcard", "device": str(speaker.name)[:120], "continuous": continuous})

    wall_start = time.time()
    end_at = None if (continuous and duration_sec is None) else (
        None if duration_sec is None else wall_start + max(0.1, duration_sec)
    )
    # continuous without duration → run until signal
    if continuous and duration_sec is None:
        end_at = None
    elif not continuous and duration_sec is None:
        end_at = wall_start + SEGMENT_SEC

    retries = 0
    block = max(1, int(SAMPLE_RATE * BLOCK_SEC))
    target = SAMPLE_RATE * SEGMENT_SEC

    try:
        with loop.recorder(samplerate=SAMPLE_RATE, channels=CHANNELS) as rec:
            _mono_start = time.monotonic()
            _wall_seg_start = time.time()
            _partial = []
            while not _stop:
                if end_at is not None and time.time() >= end_at:
                    break
                try:
                    data = rec.record(numframes=block)
                except Exception as exc:  # noqa: BLE001
                    retries += 1
                    emit({
                        "type": "error",
                        "reason": "device_invalidated",
                        "detail": str(exc)[:300],
                        "recoverable": retries < MAX_DEVICE_RETRIES,
                        "retry": retries,
                    })
                    if retries >= MAX_DEVICE_RETRIES:
                        flush_partial()
                        return 3
                    time.sleep(0.2)
                    continue
                for x in data.reshape(-1):
                    v = int(max(-1.0, min(1.0, float(x))) * 32767)
                    _partial.append(v)
                if len(_partial) >= target:
                    pcm = array.array("h", _partial[:target])
                    rest = _partial[target:]
                    raw = pcm.tobytes()
                    n = len(pcm)
                    name = f"seg_{_seg_idx:05d}.wav"
                    path = out_dir / name
                    wall_end = time.time()
                    mono_end = time.monotonic()
                    atomic_write_wav(path, raw)
                    sidecar = {
                        "file": name,
                        "sampleCount": n,
                        "sampleRate": SAMPLE_RATE,
                        "wallStart": _wall_seg_start,
                        "wallEnd": wall_end,
                        "monotonicStart": _mono_start,
                        "monotonicEnd": mono_end,
                        "segmentIndex": _seg_idx,
                        "partial": False,
                    }
                    (out_dir / f"{name}.json").write_text(
                        json.dumps(sidecar, ensure_ascii=False), encoding="utf-8"
                    )
                    emit({"type": "segment", **sidecar})
                    _seg_idx += 1
                    _partial = rest
                    _mono_start = time.monotonic()
                    _wall_seg_start = time.time()
                if not continuous and end_at is None:
                    break
    finally:
        flush_partial()
        emit({
            "type": "stop",
            "ok": True,
            "segments": _seg_idx,
            "flushed": True,
        })
    return 0


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass

    parser = argparse.ArgumentParser(description="WASAPI loopback recorder (optional)")
    parser.add_argument("--check", action="store_true", help="probe backends only")
    parser.add_argument("--out", type=str, default="", help="output directory for segments")
    parser.add_argument("--duration", type=float, default=None, help="seconds to record")
    parser.add_argument(
        "--continuous",
        action="store_true",
        help="keep recording segments until signal/duration",
    )
    args = parser.parse_args()

    if args.check:
        info = check_deps()
        emit({"type": "check", **info})
        return 0 if info.get("ok") else 2

    info = check_deps()
    if not info.get("ok"):
        emit({"type": "error", **info})
        return 2

    if not args.out:
        fail("--out required when recording")

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    out_dir = Path(args.out)
    try:
        if "soundcard" in info.get("backends", []):
            return record_soundcard(out_dir, args.duration, bool(args.continuous))
        fail("no implemented backend available at runtime")
    except Exception as exc:  # noqa: BLE001
        emit({
            "type": "error",
            "ok": False,
            "reason": "device_invalidated",
            "detail": str(exc)[:500],
            "recoverable": True,
        })
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
