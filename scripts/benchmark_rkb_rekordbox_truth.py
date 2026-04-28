import argparse
import hashlib
import inspect
import importlib.util
import json
import math
import os
import statistics
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TRUTH = (
    REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark" / "rekordbox-current-truth.json"
)
DEFAULT_AUDIO_ROOTS = [
    Path("D:/FRKB_database-B/library/FilterLibrary/new"),
    Path("D:/FRKB_database-B/library/FilterLibrary/sample"),
    Path("D:/FRKB_database-B/library/FilterLibrary/grid-failures-current"),
]
DEFAULT_AUDIO_ROOT = ";".join(str(item) for item in DEFAULT_AUDIO_ROOTS)
DEFAULT_FFMPEG = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe"
DEFAULT_FFPROBE = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffprobe.exe"
DEFAULT_OUTPUT = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark" / "latest.json"
DEFAULT_PREDICTION_CACHE_DIR = (
    REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark" / "beatthis-prediction-cache"
)
BEAT_THIS_BRIDGE = REPO_ROOT / "scripts" / "beat_this_bridge.py"

SAMPLE_RATE = 44100
CHANNELS = 2
WINDOW_SEC = 30.0
MAX_SCAN_SEC = 120.0
DRIFT_BEAT_HORIZONS = (32, 64, 128)
STRICT_TOLERANCE_MS = 2.0
PREDICTION_CACHE_VERSION = 1

_ACTIVE_LOGIT_CACHE_CONTEXT: dict[str, Any] | None = None


def _load_bridge_module() -> Any:
    spec = importlib.util.spec_from_file_location("beat_this_bridge", BEAT_THIS_BRIDGE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load bridge module: {BEAT_THIS_BRIDGE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def _normalized_path_identity(path: Path) -> str:
    try:
        resolved = path.resolve()
    except Exception:
        resolved = path.absolute()
    return os.path.normcase(str(resolved))

def _file_signature(path_value: str | Path | None) -> dict[str, Any]:
    raw_value = str(path_value or "").strip()
    if not raw_value:
        return {"path": "", "exists": False}
    path = Path(raw_value)
    identity = _normalized_path_identity(path)
    if not path.exists():
        return {"path": identity, "exists": False}
    stat = path.stat()
    return {
        "path": identity,
        "exists": True,
        "size": int(stat.st_size),
        "mtimeNs": int(stat.st_mtime_ns),
    }

def _module_signature(module_name: str) -> dict[str, Any]:
    module = sys.modules.get(module_name)
    module_file = getattr(module, "__file__", None) if module is not None else None
    return _file_signature(module_file)


def _function_source_signature(function: Any) -> dict[str, Any]:
    if function is None:
        return {"available": False}
    original_signature = getattr(function, "_frkb_original_source_signature", None)
    if isinstance(original_signature, dict):
        return original_signature
    try:
        source = inspect.getsource(function)
    except Exception:
        return {
            "available": False,
            "module": str(getattr(function, "__module__", "") or ""),
            "qualname": str(getattr(function, "__qualname__", "") or ""),
        }
    return {
        "available": True,
        "module": str(getattr(function, "__module__", "") or ""),
        "qualname": str(getattr(function, "__qualname__", "") or ""),
        "sourceSha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
    }


def _stable_cache_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _prediction_cache_base_payload(
    *,
    bridge: Any,
    file_path: Path,
    checkpoint_path: str,
    device: str,
) -> dict[str, Any]:
    return {
        "cacheVersion": PREDICTION_CACHE_VERSION,
        "audioFile": _file_signature(file_path),
        "sampleRate": SAMPLE_RATE,
        "channels": CHANNELS,
        "windowSec": WINDOW_SEC,
        "maxScanSec": MAX_SCAN_SEC,
        "device": str(device or "cpu").strip().lower() or "cpu",
        "checkpoint": _file_signature(checkpoint_path),
        "beatThisInference": _module_signature("beat_this.inference"),
        "beatThisPreprocessing": _module_signature("beat_this.preprocessing"),
        "predictionFunctions": {
            "decodeSignal": _function_source_signature(getattr(bridge, "_decode_signal", None)),
            "predictBeats": _function_source_signature(getattr(bridge, "_predict_beats", None)),
            "predictBeatsAccelerated": _function_source_signature(
                getattr(bridge, "_predict_beats_with_accelerated_device", None)
            ),
            "predictFrameLogits": _function_source_signature(
                bridge._apply_full_track_logit_rescue.__globals__.get("_predict_frame_logits")
            ),
        },
        "predictionImplementation": {
            "usesAcceleratedDevice": bool(bridge._uses_accelerated_device(device)),
        },
    }


def _prediction_cache_key(
    base_payload: dict[str, Any],
    kind: str,
    extra: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    payload = {
        **base_payload,
        "kind": kind,
        **(extra or {}),
    }
    return _stable_cache_hash(payload), payload


def _cache_stats() -> dict[str, int]:
    return {
        "windowHits": 0,
        "windowMisses": 0,
        "windowWrites": 0,
        "logitHits": 0,
        "logitMisses": 0,
        "logitWrites": 0,
        "errors": 0,
    }


def _bump_cache_stat(stats: dict[str, int] | None, key: str) -> None:
    if stats is not None:
        stats[key] = int(stats.get(key, 0)) + 1


def _prediction_window_cache_path(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / f"windows-{cache_key}.json"


def _prediction_logit_cache_path(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / f"full-logits-{cache_key}.npz"


def _serialize_prediction_windows(prepared_windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for window in prepared_windows:
        signal = window.get("signal")
        frame_count = int(getattr(signal, "shape", [0])[0] or 0)
        serialized.append(
            {
                "windowIndex": int(window.get("windowIndex") or 0),
                "windowStartSec": float(window.get("windowStartSec") or 0.0),
                "windowDurationSec": float(window.get("windowDurationSec") or 0.0),
                "signalFrameCount": frame_count,
                "beats": [float(value) for value in window.get("beats", [])],
                "downbeats": [float(value) for value in window.get("downbeats", [])],
            }
        )
    return serialized


def _slice_cached_signal_window(
    signal: Any,
    *,
    sample_rate: int,
    window_start_sec: float,
    signal_frame_count: int,
) -> tuple[Any, float]:
    total_frames = int(signal.shape[0])
    start_frame = max(0, int(max(0.0, window_start_sec) * sample_rate))
    end_frame = min(total_frames, start_frame + max(0, int(signal_frame_count)))
    actual_frames = max(0, end_frame - start_frame)
    if actual_frames <= 0:
        return signal[:0], 0.0
    return signal[start_frame:end_frame], actual_frames / sample_rate


def _rebuild_cached_prediction_windows(
    *,
    bridge: Any,
    signal: Any,
    tuning: dict[str, Any],
    cached_windows: list[Any],
) -> list[dict[str, Any]]:
    prepared_windows: list[dict[str, Any]] = []
    for item in cached_windows:
        if not isinstance(item, dict):
            continue
        beat_list = [float(value) for value in item.get("beats", [])]
        downbeat_list = [float(value) for value in item.get("downbeats", [])]
        raw_bpm = bridge._derive_bpm(beat_list)
        raw_beat_interval = bridge._derive_interval(beat_list)
        if raw_bpm is None or raw_beat_interval is None or not beat_list:
            continue
        window_start_sec = float(item.get("windowStartSec") or 0.0)
        signal_frame_count = int(item.get("signalFrameCount") or 0)
        window_signal, actual_duration_sec = _slice_cached_signal_window(
            signal,
            sample_rate=SAMPLE_RATE,
            window_start_sec=window_start_sec,
            signal_frame_count=signal_frame_count,
        )
        if actual_duration_sec <= 0.0 or getattr(window_signal, "size", 0) == 0:
            continue
        bpm = bridge._stabilize_bpm_for_grid(raw_bpm, tuning)
        beat_interval = 60.0 / bpm if bpm > 0 else raw_beat_interval
        quality_metrics = bridge._derive_quality_metrics(
            beat_list,
            downbeat_list,
            beat_interval,
            actual_duration_sec,
        )
        prepared_windows.append(
            {
                "signal": window_signal,
                "beats": beat_list,
                "downbeats": downbeat_list,
                "rawBpm": round(raw_bpm, 6),
                "rawBeatInterval": round(raw_beat_interval, 6),
                "windowIndex": int(item.get("windowIndex") or 0),
                "windowStartSec": round(window_start_sec, 3),
                "windowDurationSec": round(float(item.get("windowDurationSec") or actual_duration_sec), 3),
                "beatCount": len(beat_list),
                "downbeatCount": len(downbeat_list),
                **quality_metrics,
            }
        )
    return prepared_windows


def _read_cached_prediction_windows(
    *,
    cache_dir: Path,
    cache_key: str,
    bridge: Any,
    signal: Any,
    tuning: dict[str, Any],
    stats: dict[str, int],
) -> list[dict[str, Any]] | None:
    cache_path = _prediction_window_cache_path(cache_dir, cache_key)
    if not cache_path.exists():
        _bump_cache_stat(stats, "windowMisses")
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or payload.get("cacheKey") != cache_key:
            raise RuntimeError("cache key mismatch")
        cached_windows = payload.get("windows")
        if not isinstance(cached_windows, list):
            raise RuntimeError("cache windows payload is not a list")
        prepared_windows = _rebuild_cached_prediction_windows(
            bridge=bridge,
            signal=signal,
            tuning=tuning,
            cached_windows=cached_windows,
        )
        _bump_cache_stat(stats, "windowHits")
        return prepared_windows
    except Exception as error:
        _bump_cache_stat(stats, "errors")
        print(f"  prediction cache ignored: {error}", flush=True)
        return None


def _write_cached_prediction_windows(
    *,
    cache_dir: Path,
    cache_key: str,
    cache_payload: dict[str, Any],
    prepared_windows: list[dict[str, Any]],
    stats: dict[str, int],
) -> None:
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = _prediction_window_cache_path(cache_dir, cache_key)
        payload = {
            "cacheKey": cache_key,
            "cachePayload": cache_payload,
            "createdAt": round(time.time(), 3),
            "windows": _serialize_prediction_windows(prepared_windows),
        }
        cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        _bump_cache_stat(stats, "windowWrites")
    except Exception as error:
        _bump_cache_stat(stats, "errors")
        print(f"  prediction cache write failed: {error}", flush=True)


def _prepare_analysis_windows_with_cache(
    *,
    bridge: Any,
    predictor: Any,
    cpu_spect: Any,
    signal: Any,
    sample_rate: int,
    device: str,
    tuning: dict[str, Any],
    cache_dir: Path | None,
    cache_base_payload: dict[str, Any],
    stats: dict[str, int],
) -> list[dict[str, Any]]:
    if cache_dir is None:
        return bridge._prepare_analysis_windows(
            predictor,
            cpu_spect,
            signal,
            sample_rate,
            device,
            WINDOW_SEC,
            MAX_SCAN_SEC,
        )

    cache_key, cache_payload = _prediction_cache_key(cache_base_payload, "analysis-windows")
    cached_windows = _read_cached_prediction_windows(
        cache_dir=cache_dir,
        cache_key=cache_key,
        bridge=bridge,
        signal=signal,
        tuning=tuning,
        stats=stats,
    )
    if cached_windows is not None:
        return cached_windows

    prepared_windows = bridge._prepare_analysis_windows(
        predictor,
        cpu_spect,
        signal,
        sample_rate,
        device,
        WINDOW_SEC,
        MAX_SCAN_SEC,
    )
    _write_cached_prediction_windows(
        cache_dir=cache_dir,
        cache_key=cache_key,
        cache_payload=cache_payload,
        prepared_windows=prepared_windows,
        stats=stats,
    )
    return prepared_windows


@contextmanager
def _active_logit_cache_context(context: dict[str, Any] | None) -> Any:
    global _ACTIVE_LOGIT_CACHE_CONTEXT
    previous_context = _ACTIVE_LOGIT_CACHE_CONTEXT
    _ACTIVE_LOGIT_CACHE_CONTEXT = context
    try:
        yield
    finally:
        _ACTIVE_LOGIT_CACHE_CONTEXT = previous_context


def _install_full_logit_prediction_cache(bridge: Any) -> None:
    rescue_module = sys.modules.get("beat_this_full_logit_rescue")
    original_predict = getattr(rescue_module, "_predict_frame_logits", None) if rescue_module else None
    if original_predict is None or getattr(original_predict, "_frkb_cache_wrapped", False):
        return

    def cached_predict_frame_logits(
        predictor: Any,
        signal: Any,
        sample_rate: int,
        device: str,
        cpu_spect: Any,
    ) -> tuple[np.ndarray, np.ndarray]:
        context = _ACTIVE_LOGIT_CACHE_CONTEXT
        if not context or context.get("cacheDir") is None:
            return original_predict(predictor, signal, sample_rate, device, cpu_spect)

        cache_dir = Path(str(context["cacheDir"]))
        stats = context.get("stats")
        base_payload = dict(context["basePayload"])
        signal_shape = tuple(int(value) for value in getattr(signal, "shape", ()))
        cache_key, cache_payload = _prediction_cache_key(
            base_payload,
            "full-track-logits",
            {
                "logitSampleRate": int(sample_rate),
                "signalShape": signal_shape,
                "logitDevice": str(device or "cpu").strip().lower() or "cpu",
            },
        )
        cache_path = _prediction_logit_cache_path(cache_dir, cache_key)
        if cache_path.exists():
            try:
                with np.load(cache_path, allow_pickle=False) as cached:
                    stored_key = str(cached["cacheKey"].item())
                    if stored_key != cache_key:
                        raise RuntimeError("cache key mismatch")
                    beat_logits = cached["beatLogits"].astype("float64", copy=False)
                    downbeat_logits = cached["downbeatLogits"].astype("float64", copy=False)
                _bump_cache_stat(stats, "logitHits")
                return beat_logits, downbeat_logits
            except Exception as error:
                _bump_cache_stat(stats, "errors")
                print(f"  full-logit cache ignored: {error}", flush=True)

        _bump_cache_stat(stats, "logitMisses")
        beat_logits, downbeat_logits = original_predict(predictor, signal, sample_rate, device, cpu_spect)
        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
            with cache_path.open("wb") as output:
                np.savez(
                    output,
                    cacheKey=np.asarray(cache_key),
                    cachePayload=np.asarray(json.dumps(cache_payload, ensure_ascii=False, sort_keys=True)),
                    beatLogits=np.asarray(beat_logits, dtype="float64"),
                    downbeatLogits=np.asarray(downbeat_logits, dtype="float64"),
                )
            _bump_cache_stat(stats, "logitWrites")
        except Exception as error:
            _bump_cache_stat(stats, "errors")
            print(f"  full-logit cache write failed: {error}", flush=True)
        return beat_logits, downbeat_logits

    setattr(cached_predict_frame_logits, "_frkb_cache_wrapped", True)
    setattr(
        cached_predict_frame_logits,
        "_frkb_original_source_signature",
        _function_source_signature(original_predict),
    )
    setattr(rescue_module, "_predict_frame_logits", cached_predict_frame_logits)
    bridge._apply_full_track_logit_rescue.__globals__["_predict_frame_logits"] = cached_predict_frame_logits


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _normalize_lookup_key(value: Any) -> str:
    return str(value or "").strip().lower()


def _phase_delta_ms(candidate_ms: float, reference_ms: float, interval_ms: float) -> float:
    if not math.isfinite(interval_ms) or interval_ms <= 0.0:
        return candidate_ms - reference_ms
    return ((candidate_ms - reference_ms + interval_ms * 0.5) % interval_ms) - interval_ms * 0.5


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = int(math.ceil((percentile / 100.0) * len(ordered))) - 1
    return ordered[min(max(index, 0), len(ordered) - 1)]


def _status_from_error(value: float, tolerance_ms: float = STRICT_TOLERANCE_MS) -> str:
    absolute = abs(float(value))
    return "pass" if absolute <= tolerance_ms else "fail"


def _normalize_bar_offset(value: Any, modulo: int) -> int:
    numeric = _to_float(value)
    if numeric is None:
        return 0
    rounded = int(round(numeric))
    return ((rounded % modulo) + modulo) % modulo


def _resolve_first_beat_label_from_offset(bar_beat_offset: int) -> int:
    normalized = int(bar_beat_offset) % 4
    return ((5 - normalized - 1) % 4) + 1


def _decode_pcm_window(ffmpeg_path: Path, file_path: Path, duration_sec: float) -> bytes:
    cmd = [
        str(ffmpeg_path),
        "-v",
        "error",
        "-ss",
        "0",
        "-t",
        str(duration_sec),
        "-i",
        str(file_path),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ac",
        str(CHANNELS),
        "-ar",
        str(SAMPLE_RATE),
        "pipe:1",
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return result.stdout


def _resolve_first_packet_skip_samples(packet: dict[str, Any] | None) -> float:
    side_data_list = packet.get("side_data_list") if isinstance(packet, dict) else None
    if not isinstance(side_data_list, list):
        return 0.0
    for side_data in side_data_list:
        if not isinstance(side_data, dict):
            continue
        if str(side_data.get("side_data_type") or "") != "Skip Samples":
            continue
        return max(0.0, _to_float(side_data.get("skip_samples")) or 0.0)
    return 0.0


def _probe_time_basis(ffprobe_path: Path, file_path: Path) -> dict[str, Any]:
    cmd = [
        str(ffprobe_path),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "stream=start_time,sample_rate:stream_tags=encoder:packet_side_data=side_data_type,skip_samples",
        "-show_packets",
        "-read_intervals",
        "%+#1",
        "-select_streams",
        "a:0",
        str(file_path),
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, text=True)
    payload = json.loads(result.stdout or "{}")
    streams = payload.get("streams") if isinstance(payload, dict) else None
    packets = payload.get("packets") if isinstance(payload, dict) else None
    stream = streams[0] if isinstance(streams, list) and streams else {}
    packet = packets[0] if isinstance(packets, list) and packets else {}
    tags = stream.get("tags") if isinstance(stream, dict) else None
    encoder = str(tags.get("encoder") or "").strip() if isinstance(tags, dict) else ""
    start_time_sec = max(0.0, _to_float(stream.get("start_time")) or 0.0)
    sample_rate = max(0.0, _to_float(stream.get("sample_rate")) or 0.0)
    skip_samples = _resolve_first_packet_skip_samples(packet)
    skip_samples_ms = (skip_samples / sample_rate) * 1000.0 if sample_rate > 0.0 else 0.0
    gapless_skip_offset_ms = skip_samples_ms if skip_samples_ms > 0.0 and encoder.startswith("LAME") else 0.0
    start_time_ms = start_time_sec * 1000.0
    return {
        "offsetMs": round(start_time_ms + gapless_skip_offset_ms, 3),
        "streamStartTimeMs": round(start_time_ms, 3),
        "sampleRate": int(sample_rate) if sample_rate > 0.0 else None,
        "encoder": encoder,
        "skipSamples": int(skip_samples) if skip_samples > 0.0 else 0,
        "skipSamplesMs": round(skip_samples_ms, 3),
        "appliedGaplessSkipMs": round(gapless_skip_offset_ms, 3),
    }


def _parse_audio_roots(value: str) -> list[Path]:
    roots = [Path(item.strip()) for item in str(value or "").split(";") if item.strip()]
    if not roots:
        raise RuntimeError("audio root is empty")
    return roots


def _resolve_audio_path(audio_roots: list[Path], file_name: str) -> Path:
    for audio_root in audio_roots:
        file_path = audio_root / file_name
        if file_path.exists():
            return file_path
    return audio_roots[0] / file_name


def _load_truth_tracks(truth_path: Path, audio_roots: list[Path], ffprobe_path: Path) -> list[dict[str, Any]]:
    payload = json.loads(truth_path.read_text(encoding="utf-8"))
    tracks = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(tracks, list) or not tracks:
        raise RuntimeError(f"truth contains no tracks: {truth_path}")

    resolved: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for item in tracks:
        if not isinstance(item, dict):
            continue
        file_name = str(item.get("fileName") or "").strip()
        lookup_key = _normalize_lookup_key(file_name)
        if not file_name or lookup_key in seen_keys:
            continue
        seen_keys.add(lookup_key)

        bpm = _to_float(item.get("bpm"))
        first_beat_ms = _to_float(item.get("firstBeatMs"))
        if bpm is None or bpm <= 0.0 or first_beat_ms is None or first_beat_ms < 0.0:
            continue

        file_path = _resolve_audio_path(audio_roots, file_name)
        bar_beat_offset = _normalize_bar_offset(item.get("barBeatOffset"), 32)
        first_beat_label = int(item.get("firstBeatLabel") or _resolve_first_beat_label_from_offset(bar_beat_offset))
        resolved.append(
            {
                "fileName": file_name,
                "filePath": str(file_path),
                "title": str(item.get("title") or "").strip(),
                "artist": str(item.get("artist") or "").strip(),
                "bpm": round(float(bpm), 6),
                "firstBeatMs": round(float(first_beat_ms), 3),
                "firstBeatLabel": first_beat_label,
                "barBeatOffset": bar_beat_offset,
                "fileExists": file_path.exists(),
                "timeBasis": _probe_time_basis(ffprobe_path, file_path) if file_path.exists() else None,
            }
        )
    return resolved


def _matches_only_filters(track: dict[str, Any], filters: list[str]) -> bool:
    if not filters:
        return True
    haystack = " ".join(
        [
            str(track.get("fileName") or ""),
            str(track.get("title") or ""),
            str(track.get("artist") or ""),
        ]
    ).lower()
    return any(item in haystack for item in filters)


def _derive_grid_metrics(
    *,
    result_bpm: float,
    result_first_beat_timeline_ms: float,
    result_bar_beat_offset: int,
    truth: dict[str, Any],
    compare_count: int,
) -> dict[str, Any]:
    truth_bpm = float(truth["bpm"])
    truth_interval_ms = 60000.0 / truth_bpm if truth_bpm > 0.0 else 0.0
    result_interval_ms = 60000.0 / result_bpm if result_bpm > 0.0 else 0.0
    interval_error_ms = result_interval_ms - truth_interval_ms
    raw_first_beat_delta_ms = result_first_beat_timeline_ms - float(truth["firstBeatMs"])
    phase_error_ms = _phase_delta_ms(
        result_first_beat_timeline_ms,
        float(truth["firstBeatMs"]),
        truth_interval_ms,
    )
    signed_errors = [phase_error_ms + index * interval_error_ms for index in range(compare_count)]
    abs_errors = [abs(value) for value in signed_errors]
    rmse_ms = math.sqrt(sum(value * value for value in signed_errors) / max(1, len(signed_errors)))
    bpm_error = result_bpm - truth_bpm
    bpm_only_drift = {
        f"bpmOnlyDrift{horizon}BeatsMs": round(interval_error_ms * horizon, 3)
        for horizon in DRIFT_BEAT_HORIZONS
    }
    grid_drift = {
        f"gridDrift{horizon}BeatsMs": round(
            signed_errors[min(max(horizon - 1, 0), len(signed_errors) - 1)],
            3,
        )
        for horizon in DRIFT_BEAT_HORIZONS
    }
    truth_bar_mod4 = _normalize_bar_offset(truth.get("barBeatOffset"), 4)
    result_bar_mod4 = _normalize_bar_offset(result_bar_beat_offset, 4)
    truth_bar_exact32 = _normalize_bar_offset(truth.get("barBeatOffset"), 32)
    result_bar_exact32 = _normalize_bar_offset(result_bar_beat_offset, 32)
    first_beat_shift = 0
    if truth_interval_ms > 0.0:
        first_beat_shift = int(round((raw_first_beat_delta_ms - phase_error_ms) / truth_interval_ms))
    adjusted_result_bar_mod4 = _normalize_bar_offset(result_bar_beat_offset + first_beat_shift, 4)
    adjusted_result_bar_exact32 = _normalize_bar_offset(
        result_bar_beat_offset + first_beat_shift,
        32,
    )
    return {
        "bpmError": round(bpm_error, 6),
        "bpmAbsError": round(abs(bpm_error), 6),
        "beatIntervalErrorMs": round(interval_error_ms, 6),
        "firstBeatShiftBeats": first_beat_shift,
        "firstBeatPhaseErrorMs": round(phase_error_ms, 3),
        "firstBeatPhaseAbsErrorMs": round(abs(phase_error_ms), 3),
        "gridCompareCount": compare_count,
        "gridMeanAbsMs": round(statistics.fmean(abs_errors), 3) if abs_errors else 0.0,
        "gridP95AbsMs": round(_percentile(abs_errors, 95.0), 3),
        "gridMaxAbsMs": round(max(abs_errors, default=0.0), 3),
        "gridRmseMs": round(rmse_ms, 3),
        "barBeatOffsetMatchedMod4": adjusted_result_bar_mod4 == truth_bar_mod4,
        "barBeatOffsetMatchedExact32": adjusted_result_bar_exact32 == truth_bar_exact32,
        "rawBarBeatOffsetMatchedMod4": result_bar_mod4 == truth_bar_mod4,
        "rawBarBeatOffsetMatchedExact32": result_bar_exact32 == truth_bar_exact32,
        "adjustedBarBeatOffsetMod4": adjusted_result_bar_mod4,
        "adjustedBarBeatOffsetExact32": adjusted_result_bar_exact32,
        **bpm_only_drift,
        **grid_drift,
    }


def _is_half_or_double_bpm(result_bpm: float, truth_bpm: float) -> bool:
    if result_bpm <= 0.0 or truth_bpm <= 0.0:
        return False
    return abs(result_bpm * 2.0 - truth_bpm) <= 0.08 or abs(result_bpm / 2.0 - truth_bpm) <= 0.08


def _classify(metrics: dict[str, Any], result_bpm: float, truth_bpm: float) -> dict[str, str]:
    bpm_drift_status = _status_from_error(float(metrics["bpmOnlyDrift128BeatsMs"]))
    phase_status = _status_from_error(float(metrics["firstBeatPhaseAbsErrorMs"]))
    grid_max_status = _status_from_error(float(metrics["gridMaxAbsMs"]))
    bar_status = "pass" if metrics["barBeatOffsetMatchedMod4"] else "fail"

    if _is_half_or_double_bpm(result_bpm, truth_bpm):
        category = "half-or-double-bpm"
    elif bpm_drift_status == "fail":
        category = "bpm"
    elif phase_status == "fail":
        category = "first-beat-phase"
    elif grid_max_status == "fail":
        category = "grid-drift"
    elif bar_status == "fail":
        category = "downbeat"
    else:
        category = "pass"

    return {
        "category": category,
        "bpmDriftStatus": bpm_drift_status,
        "firstBeatPhaseStatus": phase_status,
        "gridMaxStatus": grid_max_status,
        "barBeatOffsetStatus": bar_status,
    }


def _normalize_bridge_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "bpm": round(_to_float(result.get("bpm")) or 0.0, 6),
        "rawBpm": round(_to_float(result.get("rawBpm")) or 0.0, 6),
        "firstBeatMs": round(_to_float(result.get("firstBeatMs")) or 0.0, 3),
        "rawFirstBeatMs": round(_to_float(result.get("rawFirstBeatMs")) or 0.0, 3),
        "absoluteFirstBeatMs": round(_to_float(result.get("absoluteFirstBeatMs")) or 0.0, 3),
        "absoluteRawFirstBeatMs": round(_to_float(result.get("absoluteRawFirstBeatMs")) or 0.0, 3),
        "barBeatOffset": _normalize_bar_offset(result.get("barBeatOffset"), 32),
        "beatCount": int(result.get("beatCount") or 0),
        "downbeatCount": int(result.get("downbeatCount") or 0),
        "durationSec": round(_to_float(result.get("durationSec")) or 0.0, 3),
        "beatIntervalSec": round(_to_float(result.get("beatIntervalSec")) or 0.0, 6),
        "qualityScore": round(_to_float(result.get("qualityScore")) or 0.0, 6),
        "anchorCorrectionMs": round(_to_float(result.get("anchorCorrectionMs")) or 0.0, 3),
        "anchorConfidenceScore": round(_to_float(result.get("anchorConfidenceScore")) or 0.0, 6),
        "anchorMatchedBeatCount": int(result.get("anchorMatchedBeatCount") or 0),
        "anchorStrategy": str(result.get("anchorStrategy") or "").strip() or None,
        "windowIndex": int(result.get("windowIndex") or 0),
        "windowStartSec": round(_to_float(result.get("windowStartSec")) or 0.0, 3),
        "windowDurationSec": round(_to_float(result.get("windowDurationSec")) or 0.0, 3),
        "beatThisEstimatedDrift128Ms": round(
            _to_float(result.get("beatThisEstimatedDrift128Ms")) or 0.0,
            3,
        ),
        "beatThisWindowCount": int(result.get("beatThisWindowCount") or 0),
    }


def _analyze_track(
    *,
    bridge: Any,
    predictor: Any,
    cpu_spect: Any,
    ffmpeg_path: Path,
    device: str,
    checkpoint_path: str,
    prediction_cache_dir: Path | None,
    prediction_cache_stats: dict[str, int],
    truth: dict[str, Any],
) -> dict[str, Any]:
    file_path = Path(str(truth["filePath"]))
    pcm_data = _decode_pcm_window(ffmpeg_path, file_path, MAX_SCAN_SEC)
    signal = bridge._decode_signal(pcm_data, CHANNELS)
    duration_sec = signal.shape[0] / SAMPLE_RATE if SAMPLE_RATE > 0 else 0.0
    tuning = bridge._resolve_anchor_tuning()
    cache_base_payload = _prediction_cache_base_payload(
        bridge=bridge,
        file_path=file_path,
        checkpoint_path=checkpoint_path,
        device=device,
    )
    prepared_windows = _prepare_analysis_windows_with_cache(
        bridge=bridge,
        predictor=predictor,
        cpu_spect=cpu_spect,
        signal=signal,
        sample_rate=SAMPLE_RATE,
        device=device,
        tuning=tuning,
        cache_dir=prediction_cache_dir,
        cache_base_payload=cache_base_payload,
        stats=prediction_cache_stats,
    )
    logit_cache_context = (
        {
            "cacheDir": prediction_cache_dir,
            "basePayload": cache_base_payload,
            "stats": prediction_cache_stats,
        }
        if prediction_cache_dir is not None
        else None
    )
    with _active_logit_cache_context(logit_cache_context):
        result = bridge._analyze_prepared_windows_to_track_result(
            prepared_windows,
            signal,
            SAMPLE_RATE,
            min(duration_sec, MAX_SCAN_SEC),
            tuning,
            str(file_path),
            force_legacy_anchor=False,
            use_global_solver=True,
            predictor=predictor,
            cpu_spect=cpu_spect,
            device=device,
            time_basis=truth.get("timeBasis") if isinstance(truth.get("timeBasis"), dict) else None,
        )
    return _normalize_bridge_result(result)


def _build_track_report(analysis: dict[str, Any], truth: dict[str, Any]) -> dict[str, Any]:
    offset_ms = float((truth.get("timeBasis") or {}).get("offsetMs") or 0.0)
    compare_count = 128
    current_timeline_first_beat_ms = float(analysis["firstBeatMs"]) + offset_ms
    absolute_timeline_first_beat_ms = float(analysis["absoluteFirstBeatMs"]) + offset_ms
    raw_timeline_first_beat_ms = float(analysis["rawFirstBeatMs"]) + offset_ms

    current_metrics = _derive_grid_metrics(
        result_bpm=float(analysis["bpm"]),
        result_first_beat_timeline_ms=current_timeline_first_beat_ms,
        result_bar_beat_offset=int(analysis["barBeatOffset"]),
        truth=truth,
        compare_count=compare_count,
    )
    absolute_metrics = _derive_grid_metrics(
        result_bpm=float(analysis["bpm"]),
        result_first_beat_timeline_ms=absolute_timeline_first_beat_ms,
        result_bar_beat_offset=int(analysis["barBeatOffset"]),
        truth=truth,
        compare_count=compare_count,
    )
    raw_metrics = _derive_grid_metrics(
        result_bpm=float(analysis["bpm"]),
        result_first_beat_timeline_ms=raw_timeline_first_beat_ms,
        result_bar_beat_offset=int(analysis["barBeatOffset"]),
        truth=truth,
        compare_count=compare_count,
    )
    classification = _classify(current_metrics, float(analysis["bpm"]), float(truth["bpm"]))

    return {
        "fileName": truth["fileName"],
        "title": truth.get("title"),
        "artist": truth.get("artist"),
        "filePath": truth["filePath"],
        "truth": {
            "bpm": truth["bpm"],
            "firstBeatMs": truth["firstBeatMs"],
            "firstBeatLabel": truth["firstBeatLabel"],
            "barBeatOffset": truth["barBeatOffset"],
            "timeBasis": truth.get("timeBasis"),
        },
        "analysis": analysis,
        "currentTimeline": {
            "coordinate": "analysis.firstBeatMs + timeBasisOffsetMs",
            "firstBeatMs": round(current_timeline_first_beat_ms, 3),
            **current_metrics,
            **classification,
        },
        "absoluteTimelineCandidate": {
            "coordinate": "analysis.absoluteFirstBeatMs + timeBasisOffsetMs",
            "firstBeatMs": round(absolute_timeline_first_beat_ms, 3),
            **absolute_metrics,
            **_classify(absolute_metrics, float(analysis["bpm"]), float(truth["bpm"])),
        },
        "rawTimelineCandidate": {
            "coordinate": "analysis.rawFirstBeatMs + timeBasisOffsetMs",
            "firstBeatMs": round(raw_timeline_first_beat_ms, 3),
            **raw_metrics,
        },
    }


def _summarize_metric(rows: list[dict[str, Any]], metric_path: tuple[str, ...]) -> dict[str, float]:
    values: list[float] = []
    for row in rows:
        value: Any = row
        for key in metric_path:
            value = value.get(key) if isinstance(value, dict) else None
        numeric = _to_float(value)
        if numeric is not None:
            values.append(abs(numeric))
    if not values:
        return {"mean": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0}
    return {
        "mean": round(statistics.fmean(values), 3),
        "median": round(statistics.median(values), 3),
        "p95": round(_percentile(values, 95.0), 3),
        "max": round(max(values), 3),
    }


def _build_summary(rows: list[dict[str, Any]], error_rows: list[dict[str, Any]]) -> dict[str, Any]:
    categories: dict[str, int] = {}
    for row in rows:
        category = str((row.get("currentTimeline") or {}).get("category") or "unknown")
        categories[category] = categories.get(category, 0) + 1

    worst_tracks = sorted(
        rows,
        key=lambda row: float((row.get("currentTimeline") or {}).get("gridMeanAbsMs") or 0.0),
        reverse=True,
    )[:8]

    return {
        "trackTotal": len(rows) + len(error_rows),
        "analyzedTrackCount": len(rows),
        "errorTrackCount": len(error_rows),
        "categoryCounts": categories,
        "currentTimeline": {
            "firstBeatPhaseAbsErrorMs": _summarize_metric(rows, ("currentTimeline", "firstBeatPhaseAbsErrorMs")),
            "gridMeanAbsMs": _summarize_metric(rows, ("currentTimeline", "gridMeanAbsMs")),
            "gridP95AbsMs": _summarize_metric(rows, ("currentTimeline", "gridP95AbsMs")),
            "gridMaxAbsMs": _summarize_metric(rows, ("currentTimeline", "gridMaxAbsMs")),
            "bpmOnlyDrift128BeatsMs": _summarize_metric(rows, ("currentTimeline", "bpmOnlyDrift128BeatsMs")),
        },
        "absoluteTimelineCandidate": {
            "firstBeatPhaseAbsErrorMs": _summarize_metric(
                rows,
                ("absoluteTimelineCandidate", "firstBeatPhaseAbsErrorMs"),
            ),
            "gridMeanAbsMs": _summarize_metric(rows, ("absoluteTimelineCandidate", "gridMeanAbsMs")),
            "gridP95AbsMs": _summarize_metric(rows, ("absoluteTimelineCandidate", "gridP95AbsMs")),
            "gridMaxAbsMs": _summarize_metric(rows, ("absoluteTimelineCandidate", "gridMaxAbsMs")),
        },
        "downbeatMismatchMod4Count": sum(
            1 for row in rows if not bool((row.get("currentTimeline") or {}).get("barBeatOffsetMatchedMod4"))
        ),
        "exact32OffsetMismatchCount": sum(
            1 for row in rows if not bool((row.get("currentTimeline") or {}).get("barBeatOffsetMatchedExact32"))
        ),
        "worstTracks": [
            {
                "fileName": row["fileName"],
                "category": (row.get("currentTimeline") or {}).get("category"),
                "bpm": (row.get("analysis") or {}).get("bpm"),
                "truthBpm": (row.get("truth") or {}).get("bpm"),
                "firstBeatPhaseAbsErrorMs": (row.get("currentTimeline") or {}).get("firstBeatPhaseAbsErrorMs"),
                "gridMeanAbsMs": (row.get("currentTimeline") or {}).get("gridMeanAbsMs"),
                "gridMaxAbsMs": (row.get("currentTimeline") or {}).get("gridMaxAbsMs"),
                "bpmOnlyDrift128BeatsMs": (row.get("currentTimeline") or {}).get("bpmOnlyDrift128BeatsMs"),
                "barBeatOffset": (row.get("analysis") or {}).get("barBeatOffset"),
                "truthBarBeatOffset": (row.get("truth") or {}).get("barBeatOffset"),
                "anchorStrategy": (row.get("analysis") or {}).get("anchorStrategy"),
            }
            for row in worst_tracks
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark FRKB BeatThis grid against Rekordbox truth")
    parser.add_argument("--truth", default=str(DEFAULT_TRUTH))
    parser.add_argument("--audio-root", default=str(DEFAULT_AUDIO_ROOT))
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    parser.add_argument("--ffprobe", default=str(DEFAULT_FFPROBE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--prediction-cache-dir", default=str(DEFAULT_PREDICTION_CACHE_DIR))
    parser.add_argument(
        "--no-prediction-cache",
        action="store_true",
        help="Disable deterministic BeatThis raw prediction cache.",
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        help="Filter tracks by case-insensitive file/title/artist substring. Can be repeated.",
    )
    args = parser.parse_args()

    truth_path = Path(args.truth)
    audio_roots = _parse_audio_roots(args.audio_root)
    ffmpeg_path = Path(args.ffmpeg)
    ffprobe_path = Path(args.ffprobe)
    output_path = Path(args.output)
    device = str(args.device or "cpu").strip() or "cpu"
    prediction_cache_dir = None if args.no_prediction_cache else Path(args.prediction_cache_dir)

    if not truth_path.exists():
        raise SystemExit(f"truth not found: {truth_path}")
    missing_audio_roots = [item for item in audio_roots if not item.exists()]
    if missing_audio_roots:
        missing = ", ".join(str(item) for item in missing_audio_roots)
        raise SystemExit(f"audio root not found: {missing}")
    if not ffmpeg_path.exists():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    if not ffprobe_path.exists():
        raise SystemExit(f"ffprobe not found: {ffprobe_path}")

    started_at = time.time()
    truth_tracks = _load_truth_tracks(truth_path, audio_roots, ffprobe_path)
    missing_tracks = [item for item in truth_tracks if not item["fileExists"]]
    if missing_tracks:
        missing_names = ", ".join(item["fileName"] for item in missing_tracks[:5])
        raise SystemExit(f"truth tracks missing from audio roots: {missing_names}")
    only_filters = [_normalize_lookup_key(item) for item in args.only if _normalize_lookup_key(item)]
    truth_tracks = [item for item in truth_tracks if _matches_only_filters(item, only_filters)]
    if args.limit and args.limit > 0:
        truth_tracks = truth_tracks[: args.limit]

    bridge = _load_bridge_module()
    _install_full_logit_prediction_cache(bridge)
    checkpoint_path = str(bridge._resolve_checkpoint_path())
    predictor = bridge.Audio2Beats(checkpoint_path=checkpoint_path, device=device, dbn=False)
    cpu_spect = bridge.LogMelSpect(device="cpu") if bridge._uses_accelerated_device(device) else None
    prediction_cache_stats = _cache_stats()

    rows: list[dict[str, Any]] = []
    error_rows: list[dict[str, Any]] = []
    for index, truth in enumerate(truth_tracks, start=1):
        label = f"[{index}/{len(truth_tracks)}] {truth['fileName']}"
        print(label, flush=True)
        try:
            analysis = _analyze_track(
                bridge=bridge,
                predictor=predictor,
                cpu_spect=cpu_spect,
                ffmpeg_path=ffmpeg_path,
                device=device,
                checkpoint_path=checkpoint_path,
                prediction_cache_dir=prediction_cache_dir,
                prediction_cache_stats=prediction_cache_stats,
                truth=truth,
            )
            rows.append(_build_track_report(analysis, truth))
        except Exception as error:
            error_rows.append(
                {
                    "fileName": truth["fileName"],
                    "filePath": truth["filePath"],
                    "error": str(error),
                }
            )
            print(f"  error: {error}", flush=True)

    summary = _build_summary(rows, error_rows)
    payload = {
        "summary": {
            **summary,
            "truthPath": str(truth_path),
            "audioRoot": str(args.audio_root),
            "audioRoots": [str(item) for item in audio_roots],
            "device": device,
            "windowSec": WINDOW_SEC,
            "maxScanSec": MAX_SCAN_SEC,
            "strictToleranceMs": STRICT_TOLERANCE_MS,
            "predictionCache": {
                "enabled": prediction_cache_dir is not None,
                "dir": str(prediction_cache_dir) if prediction_cache_dir is not None else None,
                **prediction_cache_stats,
            },
            "durationSec": round(time.time() - started_at, 3),
        },
        "errors": error_rows,
        "tracks": rows,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": payload["summary"], "output": str(output_path)}, ensure_ascii=False, indent=2))
    return 0 if not error_rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
