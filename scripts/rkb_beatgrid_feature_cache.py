import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

import benchmark_rkb_rekordbox_truth as benchmark
from beat_this_grid_solver import build_attack_envelope
from rkb_benchmark_bridge_result import normalize_bridge_result
from rkb_beatgrid_lab_common import (
    DEFAULT_FEATURE_CACHE_DIR,
    FEATURE_CACHE_VERSION,
    arrays_path_for_key,
    atomic_write_json,
    build_feature_index_map,
    configure_utf8_stdio,
    load_selected_truth_tracks,
    metadata_path_for_key,
    normalize_lookup_key,
    print_json,
    read_feature_metadata,
    resolve_feature_arrays_path,
    resolve_feature_entry,
    stable_hash,
    update_feature_index_entry,
    validate_feature_metadata_identity,
)
from rkb_official_phase_selector import build_high_attack_from_signal


def _array_stats(values: np.ndarray) -> dict[str, Any]:
    if values.size == 0:
        return {"count": 0, "mean": 0.0, "p95": 0.0, "max": 0.0}
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {"count": int(values.size), "mean": 0.0, "p95": 0.0, "max": 0.0}
    return {
        "count": int(values.size),
        "mean": round(float(np.mean(finite)), 6),
        "p95": round(float(np.percentile(finite, 95.0)), 6),
        "max": round(float(np.max(finite)), 6),
    }


def _normalize_array(values: np.ndarray | None) -> np.ndarray:
    if values is None:
        return np.asarray([], dtype="float32")
    return np.asarray(values, dtype="float32")


def _serialize_windows(prepared_windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for window in prepared_windows:
        signal = window.get("signal")
        serialized.append(
            {
                "windowIndex": int(window.get("windowIndex") or 0),
                "windowStartSec": round(float(window.get("windowStartSec") or 0.0), 3),
                "windowDurationSec": round(float(window.get("windowDurationSec") or 0.0), 3),
                "signalFrameCount": int(getattr(signal, "shape", [0])[0] or 0),
                "rawBpm": round(float(window.get("rawBpm") or 0.0), 6),
                "rawBeatInterval": round(float(window.get("rawBeatInterval") or 0.0), 6),
                "beatCount": int(window.get("beatCount") or 0),
                "downbeatCount": int(window.get("downbeatCount") or 0),
                "beatCoverageScore": round(float(window.get("beatCoverageScore") or 0.0), 6),
                "beatStabilityScore": round(float(window.get("beatStabilityScore") or 0.0), 6),
                "downbeatCoverageScore": round(float(window.get("downbeatCoverageScore") or 0.0), 6),
                "downbeatStabilityScore": round(float(window.get("downbeatStabilityScore") or 0.0), 6),
                "qualityScore": round(float(window.get("qualityScore") or 0.0), 6),
                "beats": [round(float(value), 6) for value in window.get("beats", [])],
                "downbeats": [round(float(value), 6) for value in window.get("downbeats", [])],
            }
        )
    return serialized


def _build_attack_feature(
    *,
    signal: np.ndarray,
    sample_rate: int,
    tuning: dict[str, Any],
    focus_mode: str,
) -> tuple[np.ndarray, int]:
    next_tuning = dict(tuning)
    next_tuning["focusMode"] = focus_mode
    result = build_attack_envelope(signal, sample_rate, next_tuning)
    if result is None:
        return np.asarray([], dtype="float32"), 0
    envelope, envelope_sample_rate = result
    return _normalize_array(envelope), int(envelope_sample_rate)


def _feature_cache_payload(
    *,
    bridge: Any,
    file_path: Path,
    checkpoint_path: str,
    device: str,
) -> dict[str, Any]:
    rescue_predict = None
    rescue_module = sys.modules.get("beat_this_full_logit_rescue")
    if rescue_module is not None:
        rescue_predict = getattr(rescue_module, "_predict_frame_logits", None)

    return {
        "featureCacheVersion": FEATURE_CACHE_VERSION,
        "audioFile": benchmark._file_signature(file_path),
        "sampleRate": benchmark.SAMPLE_RATE,
        "channels": benchmark.CHANNELS,
        "maxScanSec": benchmark.MAX_SCAN_SEC,
        "device": str(device or "cpu").strip().lower() or "cpu",
        "checkpoint": benchmark._file_signature(checkpoint_path),
        "beatThisInference": benchmark._module_signature("beat_this.inference"),
        "beatThisPreprocessing": benchmark._module_signature("beat_this.preprocessing"),
        "featureFunctions": {
            "decodeSignal": benchmark._function_source_signature(getattr(bridge, "_decode_signal", None)),
            "prepareWindows": benchmark._function_source_signature(
                getattr(bridge, "_prepare_analysis_windows", None)
            ),
            "analyzePreparedWindows": benchmark._function_source_signature(
                getattr(bridge, "_analyze_prepared_windows_to_track_result", None)
            ),
            "predictFrameLogits": benchmark._function_source_signature(rescue_predict),
            "buildAttackEnvelope": benchmark._function_source_signature(build_attack_envelope),
            "buildOfficialHighAttackEnvelope": benchmark._function_source_signature(
                build_high_attack_from_signal
            ),
        },
    }


def _build_legacy_grid_solver_feature(
    *,
    bridge: Any,
    predictor: Any,
    cpu_spect: Any,
    signal: np.ndarray,
    sample_rate: int,
    duration_sec: float,
    prepared_windows: list[dict[str, Any]],
    tuning: dict[str, Any],
    file_path: Path,
    device: str,
    time_basis: dict[str, Any] | None,
    prediction_cache_dir: Path | None,
    prediction_cache_payload: dict[str, Any],
    prediction_stats: dict[str, int],
) -> dict[str, Any]:
    logit_cache_context = (
        {
            "cacheDir": prediction_cache_dir,
            "basePayload": prediction_cache_payload,
            "stats": prediction_stats,
        }
        if prediction_cache_dir is not None
        else None
    )
    with benchmark._active_logit_cache_context(logit_cache_context):
        result = bridge._analyze_prepared_windows_to_track_result(
            prepared_windows,
            signal,
            sample_rate,
            duration_sec,
            tuning,
            str(file_path),
            force_legacy_anchor=False,
            use_global_solver=True,
            predictor=predictor,
            cpu_spect=cpu_spect,
            device=device,
            time_basis=time_basis,
        )
    normalized = normalize_bridge_result(result)
    return {
        "solver": "beat-this-current-global-solver",
        "result": normalized,
        "selectedSource": normalized.get("gridSolverSelectedSource"),
        "candidateCount": normalized.get("gridSolverCandidateCount"),
        "score": normalized.get("gridSolverScore"),
    }


def _write_feature_arrays(
    *,
    arrays_path: Path,
    beat_logits: np.ndarray,
    downbeat_logits: np.ndarray,
    full_attack: np.ndarray,
    full_attack_rate: int,
    lowrate_attack: np.ndarray,
    lowrate_attack_rate: int,
    high_attack: np.ndarray,
    high_attack_rate: int,
) -> None:
    arrays_path.parent.mkdir(parents=True, exist_ok=True)
    with arrays_path.open("wb") as output:
        np.savez_compressed(
            output,
            beatLogits=_normalize_array(beat_logits),
            downbeatLogits=_normalize_array(downbeat_logits),
            beatLogitFrameRate=np.asarray(50.0, dtype="float32"),
            downbeatLogitFrameRate=np.asarray(50.0, dtype="float32"),
            fullAttackEnvelope=_normalize_array(full_attack),
            fullAttackSampleRate=np.asarray(full_attack_rate, dtype="int32"),
            lowrateAttackEnvelope=_normalize_array(lowrate_attack),
            lowrateAttackSampleRate=np.asarray(lowrate_attack_rate, dtype="int32"),
            officialHighAttackEnvelope=_normalize_array(high_attack),
            officialHighAttackSampleRate=np.asarray(high_attack_rate, dtype="int32"),
        )


def _ensure_predictor(
    *,
    bridge: Any,
    checkpoint_path: str,
    device: str,
    runtime: dict[str, Any],
) -> tuple[Any, Any]:
    if runtime.get("predictor") is None:
        runtime["predictor"] = bridge.Audio2Beats(
            checkpoint_path=checkpoint_path,
            device=device,
            dbn=False,
        )
        runtime["cpuSpect"] = (
            bridge.LogMelSpect(device="cpu") if bridge._uses_accelerated_device(device) else None
        )
    return runtime["predictor"], runtime.get("cpuSpect")


def _extract_track_features(
    *,
    bridge: Any,
    ffmpeg_path: Path,
    checkpoint_path: str,
    device: str,
    runtime: dict[str, Any],
    prediction_cache_dir: Path | None,
    track: dict[str, Any],
    cache_dir: Path,
    force: bool,
) -> dict[str, Any]:
    file_path = Path(str(track["filePath"]))
    cache_payload = _feature_cache_payload(
        bridge=bridge,
        file_path=file_path,
        checkpoint_path=checkpoint_path,
        device=device,
    )
    cache_key = stable_hash(cache_payload)
    metadata_path = metadata_path_for_key(cache_dir, cache_key)
    arrays_path = arrays_path_for_key(cache_dir, cache_key)
    if not force and metadata_path.exists() and arrays_path.exists():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if isinstance(metadata, dict) and metadata.get("cacheKey") == cache_key:
                entry = {
                    "instanceId": metadata.get("instanceId"),
                    "batchId": metadata.get("batchId"),
                    "assetSha256": metadata.get("assetSha256"),
                    "cacheKey": cache_key,
                }
                validate_feature_metadata_identity(track=track, entry=entry, metadata=metadata)
                return {
                    "status": "hit",
                    "cacheKey": cache_key,
                    "metadata": metadata,
                    "metadataPath": metadata_path,
                    "arraysPath": arrays_path,
                }
        except (OSError, RuntimeError, json.JSONDecodeError):
            pass

    predictor, cpu_spect = _ensure_predictor(
        bridge=bridge,
        checkpoint_path=checkpoint_path,
        device=device,
        runtime=runtime,
    )
    pcm_data = benchmark._decode_pcm_window(ffmpeg_path, file_path, benchmark.MAX_SCAN_SEC)
    signal = bridge._decode_signal(pcm_data, benchmark.CHANNELS)
    duration_sec = signal.shape[0] / float(benchmark.SAMPLE_RATE)
    tuning = bridge._resolve_anchor_tuning()
    prediction_stats = benchmark._cache_stats()
    prediction_cache_payload = benchmark._prediction_cache_base_payload(
        bridge=bridge,
        file_path=file_path,
        checkpoint_path=checkpoint_path,
        device=device,
    )
    prepared_windows = benchmark._prepare_analysis_windows_with_cache(
        bridge=bridge,
        predictor=predictor,
        cpu_spect=cpu_spect,
        signal=signal,
        sample_rate=benchmark.SAMPLE_RATE,
        device=device,
        tuning=tuning,
        cache_dir=prediction_cache_dir,
        cache_base_payload=prediction_cache_payload,
        stats=prediction_stats,
    )
    rescue_module = sys.modules.get("beat_this_full_logit_rescue")
    cached_predict_frame_logits = (
        getattr(rescue_module, "_predict_frame_logits", None) if rescue_module is not None else None
    )
    if cached_predict_frame_logits is None:
        raise RuntimeError("full-logit predictor is not available")
    logit_cache_context = (
        {
            "cacheDir": prediction_cache_dir,
            "basePayload": prediction_cache_payload,
            "stats": prediction_stats,
        }
        if prediction_cache_dir is not None
        else None
    )
    with benchmark._active_logit_cache_context(logit_cache_context):
        beat_logits, downbeat_logits = cached_predict_frame_logits(
            predictor,
            signal,
            benchmark.SAMPLE_RATE,
            device,
            cpu_spect,
        )
    full_attack, full_attack_rate = _build_attack_feature(
        signal=signal,
        sample_rate=benchmark.SAMPLE_RATE,
        tuning=tuning,
        focus_mode="full",
    )
    lowrate_attack, lowrate_attack_rate = _build_attack_feature(
        signal=signal,
        sample_rate=benchmark.SAMPLE_RATE,
        tuning=tuning,
        focus_mode="low",
    )
    high_attack, high_attack_rate = build_high_attack_from_signal(
        signal,
        sample_rate=benchmark.SAMPLE_RATE,
    )
    legacy_grid_solver = _build_legacy_grid_solver_feature(
        bridge=bridge,
        predictor=predictor,
        cpu_spect=cpu_spect,
        signal=signal,
        sample_rate=benchmark.SAMPLE_RATE,
        duration_sec=min(duration_sec, benchmark.MAX_SCAN_SEC),
        prepared_windows=prepared_windows,
        tuning=tuning,
        file_path=file_path,
        device=device,
        time_basis=track.get("timeBasis") if isinstance(track.get("timeBasis"), dict) else None,
        prediction_cache_dir=prediction_cache_dir,
        prediction_cache_payload=prediction_cache_payload,
        prediction_stats=prediction_stats,
    )
    _write_feature_arrays(
        arrays_path=arrays_path,
        beat_logits=beat_logits,
        downbeat_logits=downbeat_logits,
        full_attack=full_attack,
        full_attack_rate=full_attack_rate,
        lowrate_attack=lowrate_attack,
        lowrate_attack_rate=lowrate_attack_rate,
        high_attack=high_attack,
        high_attack_rate=high_attack_rate,
    )
    metadata = {
        "cacheKey": cache_key,
        "cachePayload": cache_payload,
        "createdAt": round(time.time(), 3),
        "featureCacheVersion": FEATURE_CACHE_VERSION,
        "fileName": track["fileName"],
        "lookupKey": normalize_lookup_key(track["fileName"]),
        "arraysPath": arrays_path.name,
        "audio": {
            "sampleRate": benchmark.SAMPLE_RATE,
            "channels": benchmark.CHANNELS,
            "durationSec": round(duration_sec, 3),
            "timeBasis": track.get("timeBasis"),
        },
        "beatThis": {
            "checkpointPath": checkpoint_path,
            "windows": _serialize_windows(prepared_windows),
            "windowCount": len(prepared_windows),
            "beatLogits": _array_stats(np.asarray(beat_logits)),
            "downbeatLogits": _array_stats(np.asarray(downbeat_logits)),
        },
        "legacyGridSolver": legacy_grid_solver,
        "attack": {
            "full": {"sampleRate": full_attack_rate, **_array_stats(full_attack)},
            "lowrate": {"sampleRate": lowrate_attack_rate, **_array_stats(lowrate_attack)},
            "officialHigh": {"sampleRate": high_attack_rate, **_array_stats(high_attack)},
        },
        "predictionCache": {
            "enabled": prediction_cache_dir is not None,
            "dir": str(prediction_cache_dir) if prediction_cache_dir is not None else None,
            **prediction_stats,
        },
    }
    for key in (
        "instanceId",
        "batchId",
        "assetSha256",
        "pcmSha256",
        "familyId",
        "isolationFamilyId",
    ):
        value = track.get(key)
        if value not in (None, ""):
            metadata[key] = value
    source_path = track.get("sourcePath") or track.get("filePath")
    if source_path not in (None, ""):
        metadata["sourcePath"] = source_path
    atomic_write_json(metadata_path, metadata)
    return {
        "status": "miss",
        "cacheKey": cache_key,
        "metadata": metadata,
        "metadataPath": metadata_path,
        "arraysPath": arrays_path,
    }


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Build FRKB hybrid beatgrid feature cache")
    parser.add_argument("--truth", default=str(benchmark.DEFAULT_TRUTH))
    parser.add_argument("--audio-root", default=str(benchmark.DEFAULT_AUDIO_ROOT))
    parser.add_argument("--ffmpeg", default=str(benchmark.DEFAULT_FFMPEG))
    parser.add_argument("--ffprobe", default=str(benchmark.DEFAULT_FFPROBE))
    parser.add_argument("--cache-dir", default=str(DEFAULT_FEATURE_CACHE_DIR))
    parser.add_argument("--prediction-cache-dir", default=str(benchmark.DEFAULT_PREDICTION_CACHE_DIR))
    parser.add_argument("--no-prediction-cache", action="store_true")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-index-update", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", action="append", default=[])
    args = parser.parse_args()

    truth_path = Path(args.truth)
    ffmpeg_path = Path(args.ffmpeg)
    ffprobe_path = Path(args.ffprobe)
    cache_dir = Path(args.cache_dir)
    prediction_cache_dir = None if args.no_prediction_cache else Path(args.prediction_cache_dir)
    device = str(args.device or "cpu").strip() or "cpu"

    if not truth_path.exists():
        raise SystemExit(f"truth not found: {truth_path}")
    if not ffmpeg_path.exists():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    if not ffprobe_path.exists():
        raise SystemExit(f"ffprobe not found: {ffprobe_path}")

    only_filters = [normalize_lookup_key(item) for item in args.only if normalize_lookup_key(item)]
    selected_tracks = load_selected_truth_tracks(
        truth_path=truth_path,
        audio_root=str(args.audio_root),
        ffprobe_path=ffprobe_path,
        only_filters=only_filters,
        limit=int(args.limit or 0),
    )
    if not selected_tracks:
        raise SystemExit("no tracks selected")

    started_at = time.time()
    stats = {"hit": 0, "miss": 0, "error": 0}
    errors: list[dict[str, Any]] = []
    index_map = {} if args.force else build_feature_index_map(cache_dir)
    bridge: Any | None = None
    checkpoint_path = ""
    runtime: dict[str, Any] = {"predictor": None, "cpuSpect": None}
    for index, track in enumerate(selected_tracks, start=1):
        print(f"[{index}/{len(selected_tracks)}] {track['fileName']}", flush=True)
        try:
            if not args.force:
                entry = resolve_feature_entry(track=track, index_map=index_map)
                if entry is not None:
                    try:
                        metadata = read_feature_metadata(cache_dir, entry, track=track)
                        arrays_path = resolve_feature_arrays_path(cache_dir, entry, metadata)
                        if arrays_path.exists():
                            stats["hit"] += 1
                            continue
                    except RuntimeError:
                        pass
            if bridge is None:
                bridge = benchmark._load_bridge_module()
                benchmark._install_full_logit_prediction_cache(bridge)
                checkpoint_path = str(bridge._resolve_checkpoint_path())
            result = _extract_track_features(
                bridge=bridge,
                ffmpeg_path=ffmpeg_path,
                checkpoint_path=checkpoint_path,
                device=device,
                runtime=runtime,
                prediction_cache_dir=prediction_cache_dir,
                track=track,
                cache_dir=cache_dir,
                force=bool(args.force),
            )
            stats[str(result["status"])] += 1
            metadata = result["metadata"]
            if not args.no_index_update:
                update_feature_index_entry(
                    cache_dir,
                    {
                        "fileName": track["fileName"],
                        "lookupKey": normalize_lookup_key(track["fileName"]),
                        "instanceId": track.get("instanceId"),
                        "batchId": track.get("batchId"),
                        "assetSha256": track.get("assetSha256"),
                        "pcmSha256": track.get("pcmSha256"),
                        "familyId": track.get("familyId"),
                        "isolationFamilyId": track.get("isolationFamilyId"),
                        "sourcePath": track.get("sourcePath") or track.get("filePath"),
                        "cacheKey": result["cacheKey"],
                        "metadataPath": result["metadataPath"].name,
                        "arraysPath": result["arraysPath"].name,
                        "durationSec": (metadata.get("audio") or {}).get("durationSec"),
                        "featureCacheVersion": metadata.get("featureCacheVersion"),
                        "updatedAt": round(time.time(), 3),
                    },
                )
        except Exception as error:
            stats["error"] += 1
            errors.append(
                {
                    "fileName": track.get("fileName"),
                    "instanceId": track.get("instanceId"),
                    "batchId": track.get("batchId"),
                    "error": str(error),
                }
            )
            print(f"  error: {error}", flush=True)

    print_json(
        {
            "summary": {
                "selectedTrackCount": len(selected_tracks),
                "cacheDir": str(cache_dir),
                **stats,
                "durationSec": round(time.time() - started_at, 3),
            },
            "errors": errors,
        }
    )
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
