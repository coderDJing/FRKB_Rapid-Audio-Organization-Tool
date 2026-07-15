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

from rkb_benchmark_candidate_oracle import derive_candidate_oracle as _derive_candidate_oracle
from rkb_benchmark_bridge_result import normalize_bridge_result as _normalize_bridge_result
from rkb_benchmark_summary import build_summary as _build_summary_impl
from frkb_database_paths import FRKB_BENCHMARK_CURRENT_AUDIO_ROOT
from rkb_dataset_contract import (
    OUTPUT_IDENTITY_FIELDS,
    attach_benchmark_result_digest,
    build_benchmark_provenance_from_args,
    matches_track_filters,
    validate_truth_contract,
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_ROOT = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_TRUTH = BENCHMARK_ROOT / "rekordbox-current-truth.v2.json"
DEFAULT_AUDIO_ROOT = FRKB_BENCHMARK_CURRENT_AUDIO_ROOT
DEFAULT_FFMPEG = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe"
DEFAULT_FFPROBE = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffprobe.exe"
DEFAULT_OUTPUT = BENCHMARK_ROOT / "latest.v2.json"
DEFAULT_PREDICTION_CACHE_DIR = BENCHMARK_ROOT / "beatthis-prediction-cache"
DEFAULT_FEATURE_CACHE_DIR = BENCHMARK_ROOT / "feature-cache"
DEFAULT_REGISTRY = BENCHMARK_ROOT / "rkb-dataset-registry.json"
BEAT_THIS_BRIDGE = REPO_ROOT / "scripts" / "beat_this_bridge.py"

SAMPLE_RATE = 44100
CHANNELS = 2
WINDOW_SEC = 30.0
MAX_SCAN_SEC = 120.0
DRIFT_BEAT_HORIZONS = (32, 64, 128)
STRICT_TOLERANCE_MS = 5.0
PREDICTION_CACHE_VERSION = 1

_ACTIVE_LOGIT_CACHE_CONTEXT: dict[str, Any] | None = None


def _load_hybrid_solver_module() -> Any:
    return importlib.import_module("rkb_hybrid_beatgrid_solver")


def _load_constant_grid_dp_solver_module() -> Any:
    return importlib.import_module("rkb_constant_grid_dp_solver")


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
    module_file = getattr(sys.modules.get(module_name), "__file__", None)
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
    payload = {**base_payload, "kind": kind, **(extra or {})}
    return _stable_cache_hash(payload), payload


def _cache_stats() -> dict[str, int]:
    keys = ("windowHits", "windowMisses", "windowWrites", "logitHits", "logitMisses", "logitWrites", "errors")
    return {key: 0 for key in keys}


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
    return "pass" if abs(float(value)) <= tolerance_ms else "fail"


def _normalize_downbeat_offset(value: Any) -> int:
    numeric = _to_float(value)
    if numeric is None:
        return 0
    rounded = int(round(numeric))
    return ((rounded % 4) + 4) % 4


def _read_fixed_truth_map(track: dict[str, Any]) -> dict[str, Any] | None:
    beat_grid_map = track.get("beatGridMap")
    if not isinstance(beat_grid_map, dict):
        return None
    if beat_grid_map.get("version") != 2 or beat_grid_map.get("source") not in {"manual", "analysis"}:
        return None
    if not isinstance(beat_grid_map.get("signature"), str) or not beat_grid_map["signature"].strip():
        return None
    clips = beat_grid_map.get("clips")
    if not isinstance(clips, list) or len(clips) != 1 or not isinstance(clips[0], dict):
        return None
    clip = clips[0]
    start_sec = _to_float(clip.get("startSec"))
    anchor_sec = _to_float(clip.get("anchorSec"))
    bpm = _to_float(clip.get("bpm"))
    downbeat_beat_offset = clip.get("downbeatBeatOffset")
    if (
        start_sec is None
        or abs(start_sec) > 0.000001
        or anchor_sec is None
        or anchor_sec < 0.0
        or bpm is None
        or bpm <= 0.0
        or not isinstance(downbeat_beat_offset, int)
        or not 0 <= downbeat_beat_offset < 4
    ):
        return None
    return {
        "version": 2,
        "source": beat_grid_map["source"],
        "signature": beat_grid_map["signature"].strip(),
        "clips": [
            {
                "startSec": 0,
                "anchorSec": round(anchor_sec, 6),
                "bpm": round(bpm, 6),
                "downbeatBeatOffset": downbeat_beat_offset,
            }
        ],
    }


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


def _load_truth_tracks(
    truth_path: Path, audio_roots: list[Path], ffprobe_path: Path,
    truth_batch_id: str = "", registry_path: Path | None = None,
) -> list[dict[str, Any]]:
    from rkb_beatgrid_lab_common import track_identity_key
    payload = json.loads(truth_path.read_text(encoding="utf-8"))
    validate_truth_contract(truth_path, payload)
    tracks = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(tracks, list) or not tracks:
        raise RuntimeError(f"truth contains no tracks: {truth_path}")
    if truth_batch_id:
        from run_parallel_rkb_beatgrid_feature_cache import _enrich_tracks_from_registry
        tracks = _enrich_tracks_from_registry(
            [{key: value for key, value in item.items() if key not in {"sourcePath", "filePath"}} for item in tracks if isinstance(item, dict)],
            registry_path=registry_path or DEFAULT_REGISTRY, batch_id=truth_batch_id,
        )
    resolved: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for item in tracks:
        if not isinstance(item, dict):
            continue
        file_name = str(item.get("fileName") or "").strip()
        identity_key = track_identity_key(item)
        if not file_name or not identity_key or identity_key in seen_keys:
            continue
        seen_keys.add(identity_key)
        instance_id = str(item.get("instanceId") or "").strip()
        source_path_value = str(item.get("sourcePath") or "").strip()
        if instance_id and not source_path_value:
            raise RuntimeError(f"instance truth track is missing sourcePath: {instance_id}")
        file_path = Path(source_path_value) if source_path_value else _resolve_audio_path(audio_roots, file_name)
        if source_path_value and not file_path.is_file():
            raise RuntimeError(f"truth sourcePath is not an existing file: {file_path}")
        beat_grid_map = _read_fixed_truth_map(item)
        if not beat_grid_map:
            raise RuntimeError(f"truth track has no valid fixed v2 map: {identity_key}")
        clip = beat_grid_map["clips"][0]
        bpm = float(clip["bpm"])
        first_beat_ms = float(clip["anchorSec"]) * 1000.0
        resolved.append(
            {
                **{key: item[key] for key in OUTPUT_IDENTITY_FIELDS if item.get(key) not in (None, "")},
                "fileName": file_name,
                "filePath": str(file_path),
                "sourcePath": str(file_path),
                "title": str(item.get("title") or "").strip(),
                "artist": str(item.get("artist") or "").strip(),
                "bpm": round(float(bpm), 6),
                "firstBeatMs": round(float(first_beat_ms), 3),
                "downbeatBeatOffset": int(clip["downbeatBeatOffset"]),
                "beatGridMap": beat_grid_map,
                "fileExists": file_path.exists(),
                "timeBasis": _probe_time_basis(ffprobe_path, file_path) if file_path.exists() else None,
            }
        )
    return resolved


def _derive_grid_metrics(
    *,
    result_bpm: float,
    result_first_beat_timeline_ms: float,
    result_downbeat_beat_offset: int,
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
    truth_downbeat_beat_offset = _normalize_downbeat_offset(truth.get("downbeatBeatOffset"))
    result_downbeat_beat_offset = _normalize_downbeat_offset(result_downbeat_beat_offset)
    first_beat_shift = 0
    if truth_interval_ms > 0.0:
        first_beat_shift = int(round((raw_first_beat_delta_ms - phase_error_ms) / truth_interval_ms))
    adjusted_result_downbeat_beat_offset = _normalize_downbeat_offset(
        result_downbeat_beat_offset + first_beat_shift
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
        "downbeatBeatOffsetMatches": adjusted_result_downbeat_beat_offset
        == truth_downbeat_beat_offset,
        "rawDownbeatBeatOffsetMatches": result_downbeat_beat_offset == truth_downbeat_beat_offset,
        "adjustedDownbeatBeatOffset": adjusted_result_downbeat_beat_offset,
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
    downbeat_status = "pass" if metrics["downbeatBeatOffsetMatches"] else "fail"

    if _is_half_or_double_bpm(result_bpm, truth_bpm):
        category = "half-or-double-bpm"
    elif bpm_drift_status == "fail":
        category = "bpm"
    elif phase_status == "fail":
        category = "first-beat-phase"
    elif grid_max_status == "fail":
        category = "grid-drift"
    elif downbeat_status == "fail":
        category = "downbeat"
    else:
        category = "pass"

    return {
        "category": category,
        "bpmDriftStatus": bpm_drift_status,
        "firstBeatPhaseStatus": phase_status,
        "gridMaxStatus": grid_max_status,
        "downbeatBeatOffsetStatus": downbeat_status,
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


def _analyze_track_hybrid(
    *,
    hybrid_solver: Any,
    feature_cache_dir: Path,
    truth: dict[str, Any],
) -> dict[str, Any]:
    result = hybrid_solver.solve_hybrid_beatgrid_from_cache(
        track=truth,
        feature_cache_dir=feature_cache_dir,
    )
    return _normalize_bridge_result(result)


def _analyze_track_constant_grid_dp(
    *,
    constant_grid_dp_solver: Any,
    feature_cache_dir: Path,
    truth: dict[str, Any],
) -> dict[str, Any]:
    result = constant_grid_dp_solver.solve_constant_grid_dp_from_cache(
        track=truth,
        feature_cache_dir=feature_cache_dir,
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
        result_downbeat_beat_offset=int(analysis["downbeatBeatOffset"]),
        truth=truth,
        compare_count=compare_count,
    )
    absolute_metrics = _derive_grid_metrics(
        result_bpm=float(analysis["bpm"]),
        result_first_beat_timeline_ms=absolute_timeline_first_beat_ms,
        result_downbeat_beat_offset=int(analysis["downbeatBeatOffset"]),
        truth=truth,
        compare_count=compare_count,
    )
    raw_metrics = _derive_grid_metrics(
        result_bpm=float(analysis["bpm"]),
        result_first_beat_timeline_ms=raw_timeline_first_beat_ms,
        result_downbeat_beat_offset=int(analysis["downbeatBeatOffset"]),
        truth=truth,
        compare_count=compare_count,
    )
    classification = _classify(current_metrics, float(analysis["bpm"]), float(truth["bpm"]))
    candidate_oracle = _derive_candidate_oracle(
        analysis,
        truth,
        offset_ms=offset_ms,
        compare_count=compare_count,
        derive_grid_metrics=_derive_grid_metrics,
        classify=_classify,
        to_float=_to_float,
        normalize_downbeat_offset=_normalize_downbeat_offset,
    )

    return {
        **{key: truth[key] for key in OUTPUT_IDENTITY_FIELDS if truth.get(key) not in (None, "")},
        "fileName": truth["fileName"],
        "title": truth.get("title"),
        "artist": truth.get("artist"),
        "filePath": truth["filePath"],
        "truth": {
            "beatGridMap": truth["beatGridMap"],
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
        "candidateOracle": candidate_oracle,
    }


def _build_summary(rows: list[dict[str, Any]], error_rows: list[dict[str, Any]]) -> dict[str, Any]:
    return _build_summary_impl(rows, error_rows, strict_tolerance_ms=STRICT_TOLERANCE_MS)


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark FRKB BeatThis grid against Rekordbox truth")
    parser.add_argument("--truth", default=str(DEFAULT_TRUTH))
    parser.add_argument("--truth-batch-id", default="")
    parser.add_argument("--registry", default=str(DEFAULT_REGISTRY))
    parser.add_argument("--audio-root", default=str(DEFAULT_AUDIO_ROOT))
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    parser.add_argument("--ffprobe", default=str(DEFAULT_FFPROBE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--solver", choices=["legacy", "hybrid", "constant-grid-dp"], default="legacy")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--feature-cache-dir", default=str(DEFAULT_FEATURE_CACHE_DIR))
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
    solver = str(args.solver or "legacy").strip().lower()
    feature_cache_dir = Path(args.feature_cache_dir)
    device = str(args.device or "cpu").strip() or "cpu"
    prediction_cache_dir = None if args.no_prediction_cache else Path(args.prediction_cache_dir)
    if not truth_path.exists():
        legacy_truth_path = truth_path.with_name("rekordbox-current-truth.json")
        raise SystemExit(
            "v2 Rekordbox truth not found: "
            f"{truth_path}. Generate a derived file without changing {legacy_truth_path} with: "
            f'py -3 scripts/convert_legacy_grid_truth_to_v2.py --input "{legacy_truth_path}" '
            f'--output "{truth_path}" --apply'
        )
    missing_audio_roots = [item for item in audio_roots if not item.exists()]
    if missing_audio_roots:
        missing = ", ".join(str(item) for item in missing_audio_roots)
        raise SystemExit(f"audio root not found: {missing}")
    if not ffmpeg_path.exists():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    if not ffprobe_path.exists():
        raise SystemExit(f"ffprobe not found: {ffprobe_path}")
    if solver in {"hybrid", "constant-grid-dp"} and not feature_cache_dir.exists():
        raise SystemExit(f"feature cache dir not found: {feature_cache_dir}")
    started_at = time.time()
    truth_contract = validate_truth_contract(truth_path)
    truth_tracks = _load_truth_tracks(
        truth_path, audio_roots, ffprobe_path, str(args.truth_batch_id or "").strip(), Path(args.registry),
    )
    missing_tracks = [item for item in truth_tracks if not item["fileExists"]]
    if missing_tracks:
        missing_names = ", ".join(item["fileName"] for item in missing_tracks[:5])
        raise SystemExit(f"truth tracks missing from audio roots: {missing_names}")
    only_filters = [_normalize_lookup_key(item) for item in args.only if _normalize_lookup_key(item)]
    truth_tracks = [item for item in truth_tracks if matches_track_filters(item, only_filters)]
    if args.limit and args.limit > 0:
        truth_tracks = truth_tracks[: args.limit]
    bridge = None
    checkpoint_path = ""
    predictor = None
    cpu_spect = None
    hybrid_solver = None
    constant_grid_dp_solver = None
    if solver == "legacy":
        bridge = _load_bridge_module()
        _install_full_logit_prediction_cache(bridge)
        checkpoint_path = str(bridge._resolve_checkpoint_path())
        predictor = bridge.Audio2Beats(checkpoint_path=checkpoint_path, device=device, dbn=False)
        cpu_spect = bridge.LogMelSpect(device="cpu") if bridge._uses_accelerated_device(device) else None
    elif solver == "hybrid":
        hybrid_solver = _load_hybrid_solver_module()
    else:
        constant_grid_dp_solver = _load_constant_grid_dp_solver_module()
    prediction_cache_stats = _cache_stats()
    run_provenance = build_benchmark_provenance_from_args(args, truth_contract)

    rows: list[dict[str, Any]] = []
    error_rows: list[dict[str, Any]] = []
    for index, truth in enumerate(truth_tracks, start=1):
        label = f"[{index}/{len(truth_tracks)}] {truth['fileName']}"
        print(label, flush=True)
        try:
            if solver == "legacy":
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
            elif solver == "hybrid":
                analysis = _analyze_track_hybrid(
                    hybrid_solver=hybrid_solver,
                    feature_cache_dir=feature_cache_dir,
                    truth=truth,
                )
            else:
                analysis = _analyze_track_constant_grid_dp(
                    constant_grid_dp_solver=constant_grid_dp_solver,
                    feature_cache_dir=feature_cache_dir,
                    truth=truth,
                )
            rows.append(_build_track_report(analysis, truth))
        except Exception as error:
            error_rows.append(
                {
                    **truth,
                    "error": str(error),
                }
            )
            print(f"  error: {error}", flush=True)

    summary = _build_summary(rows, error_rows)
    payload = attach_benchmark_result_digest({
        "summary": {
            **summary,
            "truthPath": str(truth_path),
            "runProvenance": run_provenance,
            "truthBatchId": str(args.truth_batch_id or "").strip() or None,
            "registry": str(args.registry) if str(args.truth_batch_id or "").strip() else None,
            "audioRoot": str(args.audio_root),
            "audioRoots": [str(item) for item in audio_roots],
            "device": device,
            "solver": solver,
            "windowSec": WINDOW_SEC,
            "maxScanSec": MAX_SCAN_SEC,
            "featureCache": {
                "enabled": solver in {"hybrid", "constant-grid-dp"},
                "dir": str(feature_cache_dir) if solver in {"hybrid", "constant-grid-dp"} else None,
            },
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
    })
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": payload["summary"], "output": str(output_path)}, ensure_ascii=False, indent=2))
    return 0 if not error_rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
