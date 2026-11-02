#!/usr/bin/env python3
"""faster-whisper ASR bridge for sense-now.

stdin:  {"audioPath": "...", "videoKey": "...", "language": null, "offsetMs": 0, "chunkId": "000000"}
stdout: {"utterances": [{"startMs": 0, "endMs": 1200, "text": "...", "confidence": null}], ...}

Timestamps are chunk-local; the JS adapter adds offsetMs and assigns chunkId.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_MODEL = os.environ.get("DSH_WHISPER_MODEL", "Systran/faster-whisper-small")
DEFAULT_DEVICE = os.environ.get("DSH_WHISPER_DEVICE", "cpu")
DEFAULT_COMPUTE = os.environ.get("DSH_WHISPER_COMPUTE_TYPE", "int8")


def fail(message: str, code: int = 2) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def import_backend():
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:  # noqa: BLE001
        fail(f"faster-whisper unavailable: {exc}")
    return WhisperModel


def main() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    if args.check:
        real_stdout = sys.stdout
        try:
            sys.stdout = sys.stderr
            import_backend()
        finally:
            sys.stdout = real_stdout
        print(json.dumps({
            "adapter": "faster-whisper",
            "model": os.environ.get("DSH_WHISPER_MODEL", DEFAULT_MODEL),
            "ok": True,
        }))
        return

    try:
        payload = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        fail(f"invalid stdin JSON: {exc}")

    audio_path = Path(str(payload.get("audioPath") or ""))
    if not audio_path.is_file():
        fail(f"audioPath does not exist: {audio_path}")

    model_id = os.environ.get("DSH_WHISPER_MODEL", DEFAULT_MODEL)
    device = os.environ.get("DSH_WHISPER_DEVICE", DEFAULT_DEVICE)
    compute_type = os.environ.get("DSH_WHISPER_COMPUTE_TYPE", DEFAULT_COMPUTE)
    language = payload.get("language") or os.environ.get("DSH_WHISPER_LANGUAGE") or None

    WhisperModel = import_backend()
    real_stdout = sys.stdout
    try:
        # Keep protocol stdout clean: model load/transcribe may print diagnostics.
        sys.stdout = sys.stderr
        model = WhisperModel(model_id, device=device, compute_type=compute_type)
        try:
            segments, info = model.transcribe(
                str(audio_path),
                language=language,
                beam_size=1,
                vad_filter=True,
            )
        except Exception:  # noqa: BLE001 — VAD backend may be unavailable
            segments, info = model.transcribe(
                str(audio_path),
                language=language,
                beam_size=1,
                vad_filter=False,
            )
        utterances = []
        for seg in segments:
            text = str(getattr(seg, "text", "") or "").strip()
            if not text:
                continue
            start_ms = max(0, round(float(seg.start) * 1000))
            end_ms = max(start_ms, round(float(seg.end) * 1000))
            utterances.append({
                "startMs": start_ms,
                "endMs": end_ms,
                "text": text,
                "confidence": None,
            })
        out = {
            "utterances": utterances,
            "model": model_id,
            "language": getattr(info, "language", None),
        }
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        fail(f"faster-whisper inference failed: {exc}")
    finally:
        sys.stdout = real_stdout

    print(json.dumps(out, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
