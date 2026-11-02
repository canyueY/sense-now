#!/usr/bin/env python3
"""Local pyannote speaker diarization bridge for sense-now.

stdin: {"audioPath": "...", "videoKey": "..."}
stdout: {"speakers": [...], "activeSegments": [...], "overlaps": [...], "observations": [...]}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import wave
from collections import defaultdict
from pathlib import Path

DEFAULT_MODEL = "pyannote/speaker-diarization-community-1"
MAX_SEGMENTS = 20_000


def fail(message: str, code: int = 2) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def configuration() -> tuple[str, str | None]:
    model = os.environ.get("DSH_PYANNOTE_MODEL", DEFAULT_MODEL)
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    if not Path(model).exists() and not token:
        fail(
            "HF_TOKEN/HUGGINGFACE_HUB_TOKEN is required for the remote pyannote model; "
            "alternatively set DSH_PYANNOTE_MODEL to a downloaded local model directory"
        )
    return model, token


def import_pipeline():
    # Privacy-preserving default. Users can explicitly override this environment variable.
    os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")
    # Matplotlib is imported transitively by pyannote. A dedicated writable cache avoids
    # lock/path failures on Windows accounts whose home directory contains non-ASCII text.
    mpl_cache = Path(tempfile.gettempdir()) / "sense-now" / "matplotlib"
    mpl_cache.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", str(mpl_cache))
    try:
        from pyannote.audio import Pipeline  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on optional local environment
        fail(f"pyannote.audio is unavailable: {exc}")
    return Pipeline


def iter_segments(annotation):
    for segment, _, speaker in annotation.itertracks(yield_label=True):
        start_ms = max(0, round(float(segment.start) * 1000))
        end_ms = max(start_ms, round(float(segment.end) * 1000))
        if end_ms > start_ms:
            yield start_ms, end_ms, str(speaker)


def overlap_regions(segments):
    events = []
    for start_ms, end_ms, speaker in segments:
        events.append((start_ms, 1, speaker))
        events.append((end_ms, -1, speaker))
    events.sort(key=lambda item: (item[0], item[1]))  # close before open at same timestamp
    active = set()
    previous = None
    out = []
    for at_ms, direction, speaker in events:
        if previous is not None and at_ms > previous and len(active) > 1:
            out.append({
                "startMs": previous,
                "endMs": at_ms,
                "speakerClusterIds": sorted(active),
            })
        if direction < 0:
            active.discard(speaker)
        else:
            active.add(speaker)
        previous = at_ms
    return out


def evidence_id(video_key: str, start_ms: int, end_ms: int, speaker: str) -> str:
    raw = f"{video_key}|{start_ms}|{end_ms}|{speaker}|pyannote".encode("utf-8")
    return "AV_" + hashlib.sha256(raw).hexdigest()[:24]


def load_waveform(audio_path: Path):
    """Read a mono PCM16 WAV directly so pyannote never needs torchcodec/FFmpeg DLLs.

    The indexer always feeds a 16 kHz mono WAV extracted by ffmpeg, so the common path
    avoids torchcodec entirely (its FFmpeg DLLs are missing on static ffmpeg builds).
    Returns (waveform, sample_rate) or None when the file is not a plain PCM WAV.
    """
    try:
        with wave.open(str(audio_path), "rb") as handle:
            if handle.getnchannels() != 1 or handle.getsampwidth() != 2:
                return None
            sample_rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, OSError):
        return None
    if not frames:
        return None
    import torch  # type: ignore

    samples = torch.frombuffer(bytearray(frames), dtype=torch.int16).to(torch.float32) / 32768.0
    return samples.unsqueeze(0), sample_rate


def run(payload: dict) -> dict:
    audio_path = Path(str(payload.get("audioPath") or ""))
    if not audio_path.is_file():
        fail(f"audioPath does not exist: {audio_path}")
    # chunk-local → absolute: runner returns local; offset applied below
    try:
        offset_ms = max(0, int(payload.get("offsetMs") or 0))
    except (TypeError, ValueError):
        offset_ms = 0
    chunk_id = payload.get("chunkId")
    return_embeddings = bool(payload.get("returnEmbeddings"))
    model, token = configuration()
    Pipeline = import_pipeline()
    wave_input = load_waveform(audio_path)
    try:
        try:
            pipeline = Pipeline.from_pretrained(model, token=token)
        except TypeError:  # pyannote 3.x compatibility
            pipeline = Pipeline.from_pretrained(model, use_auth_token=token)
        device = os.environ.get("DSH_PYANNOTE_DEVICE", "auto").lower()
        if device != "cpu":
            import torch  # type: ignore
            selected = "cuda" if device == "auto" and torch.cuda.is_available() else device
            if selected != "auto":
                pipeline.to(torch.device(selected))
        if wave_input is None:
            output = pipeline(str(audio_path))
        else:
            waveform, sample_rate = wave_input
            output = pipeline({"waveform": waveform, "sample_rate": sample_rate})
    except Exception as exc:  # pragma: no cover - model/runtime dependent
        fail(f"pyannote inference failed: {exc}")

    regular = getattr(output, "speaker_diarization", output)
    exclusive = getattr(output, "exclusive_speaker_diarization", regular)
    regular_segments = [
        (s + offset_ms, e + offset_ms, sp)
        for s, e, sp in list(iter_segments(regular))[:MAX_SEGMENTS]
    ]
    active_segments_raw = [
        (s + offset_ms, e + offset_ms, sp)
        for s, e, sp in list(iter_segments(exclusive))[:MAX_SEGMENTS]
    ]
    totals = defaultdict(int)
    counts = defaultdict(int)
    for start_ms, end_ms, speaker in regular_segments:
        totals[speaker] += end_ms - start_ms
        counts[speaker] += 1

    speakers = [
        {
            "speakerClusterId": speaker,
            "totalMs": totals[speaker],
            "segmentCount": counts[speaker],
            "chunkId": chunk_id,
        }
        for speaker in sorted(totals)
    ]
    active_segments = [
        {"startMs": start_ms, "endMs": end_ms, "speakerClusterId": speaker, "chunkId": chunk_id}
        for start_ms, end_ms, speaker in active_segments_raw
    ]
    overlaps = overlap_regions(regular_segments)
    video_key = str(payload.get("videoKey") or "")
    observations = []
    overlap_ranges = [(x["startMs"], x["endMs"]) for x in overlaps]
    for start_ms, end_ms, speaker in active_segments_raw:
        is_overlap = any(start_ms < b and end_ms > a for a, b in overlap_ranges)
        observations.append({
            "tMs": (start_ms + end_ms) // 2,
            "visibleFaceIds": [],
            "speakingFaceIds": [],
            "speakerClusterId": speaker,
            "speechClear": True,
            "speechMs": end_ms - start_ms,
            "lipSyncOk": None,
            "overlap": is_overlap,
            "evidenceId": evidence_id(video_key, start_ms, end_ms, speaker),
        })

    result = {
        "speakers": speakers,
        "activeSegments": active_segments,
        "overlaps": overlaps,
        "observations": observations,
        "provenance": {"adapter": "pyannote.audio", "model": model},
    }
    if return_embeddings:
        emb = compute_speaker_embeddings(
            audio_path,
            active_segments_raw,
            offset_ms=offset_ms,
            overlap_ranges=overlap_ranges,
            model_id=os.environ.get("DSH_PYANNOTE_EMBEDDING_MODEL", ""),
            inference=None,
            audio_input=(
                {"waveform": wave_input[0], "sample_rate": wave_input[1]}
                if wave_input is not None else None
            ),
        )
        if emb.get("ok"):
            result["speakerEmbeddings"] = emb["speakerEmbeddings"]
            result["embeddingStatus"] = {"ok": True, "reason": "ready"}
        else:
            result["speakerEmbeddings"] = []
            result["embeddingStatus"] = {
                "ok": False,
                "reason": emb.get("reason", "unavailable"),
                "detail": emb.get("detail"),
            }
    return result


def _segment_intersects_overlaps(start_ms, end_ms, overlap_ranges):
    for a, b in overlap_ranges or []:
        if start_ms < b and end_ms > a:
            return True
    return False


def aggregate_speaker_centroids(segments, crop_fn, offset_ms=0, overlap_ranges=None,
                                audio_duration_ms=None, min_ms=500, prefer_ms=1500,
                                max_segs=8, max_speakers=16, max_total_ms=120_000):
    """裁剪 segment→向量→centroid；crop_fn(start_sec, end_sec) 可注入。"""
    from collections import defaultdict
    import math

    by_spk = defaultdict(list)
    for start_ms, end_ms, spk in segments:
        if _segment_intersects_overlaps(start_ms, end_ms, overlap_ranges):
            continue
        # 片段时间先减去 chunk offset，落在当前 WAV 内
        a = start_ms - offset_ms
        b = end_ms - offset_ms
        if audio_duration_ms is not None:
            a = max(0, min(a, audio_duration_ms))
            b = max(0, min(b, audio_duration_ms))
        else:
            a = max(0, a)
            b = max(0, b)
        dur = b - a
        if dur < min_ms:
            continue
        by_spk[spk].append((a, b, dur))

    out = []
    total_infer_ms = 0
    for spk in sorted(by_spk)[:max_speakers]:
        segs = sorted(by_spk[spk], key=lambda x: -x[2])
        preferred = [s for s in segs if s[2] >= prefer_ms] or segs
        preferred = preferred[:max_segs]
        vectors = []
        total_ms = 0
        for a, b, dur in preferred:
            if total_infer_ms + dur > max_total_ms:
                break
            try:
                vec = crop_fn(a / 1000.0, b / 1000.0)
                if vec is None:
                    continue
                try:
                    import numpy as np  # type: ignore
                    v = np.asarray(vec, dtype=float).reshape(-1)
                    if not np.all(np.isfinite(v)) or float(np.linalg.norm(v)) == 0.0:
                        continue
                    n = float(np.linalg.norm(v)) or 1.0
                    vectors.append((v / n).tolist())
                except Exception:
                    flat = [float(x) for x in list(vec)]
                    if not flat or any(not math.isfinite(x) for x in flat):
                        continue
                    n = math.sqrt(sum(x * x for x in flat)) or 1.0
                    if n == 0.0:
                        continue
                    vectors.append([x / n for x in flat])
                total_ms += dur
                total_infer_ms += dur
            except Exception:
                continue
        if not vectors:
            continue
        dim = len(vectors[0])
        centroid = [sum(v[i] for v in vectors) / len(vectors) for i in range(dim)]
        n = math.sqrt(sum(x * x for x in centroid)) or 1.0
        if n == 0.0 or any(not math.isfinite(x) for x in centroid):
            continue
        centroid = [x / n for x in centroid]
        out.append({
            "localSpeakerId": spk,
            "embedding": centroid,
            "dimension": len(centroid),
            "segmentCount": len(vectors),
            "totalMs": total_ms,
        })
    return out


def compute_speaker_embeddings(audio_path, segments, offset_ms=0, overlap_ranges=None,
                               model_id="", inference=None, audio_duration_ms=None,
                               audio_input=None):
    """可选 speaker embedding；模型不可用时 structured unavailable。"""
    if not model_id:
        model_id = os.environ.get("DSH_PYANNOTE_EMBEDDING_MODEL", "pyannote/embedding")

    try:
        from pyannote.core import Segment  # type: ignore
    except Exception:  # noqa: BLE001
        class Segment:  # noqa: N801 — mirror pyannote.core.Segment(start, end)
            def __init__(self, start, end):
                self.start = float(start)
                self.end = float(end)

    if inference is None:
        try:
            from pyannote.audio import Model, Inference  # type: ignore
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "unavailable", "detail": f"embedding backend: {exc}"}

        try:
            token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN") or None
            try:
                model = Model.from_pretrained(model_id, token=token)
            except TypeError:
                model = Model.from_pretrained(model_id, use_auth_token=token)
            inference = Inference(model, window="whole")
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "unavailable", "detail": str(exc)[:300]}

    def crop_fn(start_sec, end_sec):
        # pyannote Inference.crop 需要 Segment(start, end)，不是 (start, duration)。
        # Prefer an in-memory waveform dict so torchcodec / shared FFmpeg DLLs are not needed.
        target = audio_input if audio_input is not None else str(audio_path)
        excerpt = inference.crop(target, Segment(start_sec, end_sec))
        if hasattr(excerpt, "data"):
            return excerpt.data
        return excerpt

    try:
        out = aggregate_speaker_centroids(
            segments,
            crop_fn,
            offset_ms=offset_ms,
            overlap_ranges=overlap_ranges,
            audio_duration_ms=audio_duration_ms,
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "unavailable", "detail": str(exc)[:300]}

    for item in out:
        item["modelId"] = model_id
    if not out:
        return {"ok": False, "reason": "unavailable", "detail": "no embedding segments"}
    return {"ok": True, "speakerEmbeddings": out}


def main() -> None:
    # The bridge speaks UTF-8 JSON on stdio regardless of the Windows locale, so Chinese
    # Non-ASCII paths survive both stdin and stdout.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    # `--check` only proves the Python/pyannote environment can be imported. It must not
    # require HF credentials or a local model (and never downloads weights).
    if args.check:
        real_stdout = sys.stdout
        try:
            # pyannote/huggingface may print diagnostics on stdout; keep protocol JSON clean.
            sys.stdout = sys.stderr
            import_pipeline()
        finally:
            sys.stdout = real_stdout
        model = os.environ.get("DSH_PYANNOTE_MODEL", DEFAULT_MODEL)
        print(json.dumps({"adapter": "pyannote.audio", "model": model, "telemetry": False}))
        return
    model, _ = configuration()
    Pipeline = import_pipeline()
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        fail(f"invalid stdin JSON: {exc}")
    real_stdout = sys.stdout
    try:
        # Any library print/log on stdout would corrupt the JSON protocol; redirect it.
        sys.stdout = sys.stderr
        result = run(payload)
    finally:
        sys.stdout = real_stdout
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()

