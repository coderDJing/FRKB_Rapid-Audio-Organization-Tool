import os
import json
import math
import statistics
import sys
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANUAL_TRUTH_PATH = os.path.join(REPO_ROOT, "grid-analysis-lab", "manual-truth", "truth-sample.json")
SAMPLE_LIST_SEGMENT = "/library/filterlibrary/sample/"
ENV_BEAT_THIS_EXTRA_SITE_DIRS = "FRKB_BEAT_THIS_EXTRA_SITE_DIRS"
ENV_BEAT_THIS_EXTRA_DLL_DIRS = "FRKB_BEAT_THIS_EXTRA_DLL_DIRS"
ENV_BEAT_THIS_CHECKPOINT = "FRKB_BEAT_THIS_CHECKPOINT"
ENV_BEAT_THIS_ANCHOR_TUNING_JSON = "FRKB_BEAT_THIS_ANCHOR_TUNING_JSON"
ENV_BEAT_THIS_DEV_PLAYLIST_RULES = "FRKB_BEAT_THIS_DEV_PLAYLIST_RULES"
DEFAULT_BEAT_THIS_CHECKPOINT_RELATIVE_PATH = os.path.join("beat-this-checkpoints", "final0.ckpt")
_DLL_DIR_HANDLES: list[Any] = []
_MANUAL_TRUTH_CACHE: dict[str, dict[str, Any]] | None = None
_MANUAL_TRUTH_CACHE_MTIME: float | None = None
WINDOW_MIN_DURATION_SEC = 8.0

DEFAULT_ANCHOR_TUNING = {
    "focusMode": "low",
    "envelopeSampleRateLow": 800,
    "envelopeSampleRateFull": 4000,
    "scoreWindowMs": 8.0,
    "bpmSnapIntegerThreshold": 0.03,
    "maxShiftSecCap": 0.03,
    "maxShiftSecFloor": 0.015,
    "maxShiftIntervalRatio": 0.06,
    "stepMs": 2.0,
    "maxBeats": 64,
    "backtrackThresholdRatio": 0.10,
    "backtrackThresholdFloor": 0.004,
    "valleySearchBack": 8,
    "valleySearchForward": 2,
    "backtrackSafetyFrames": 36,
    "backtrackDropRatio": 0.01,
    "backtrackThresholdMultiplier": 1.05,
    "localPeakMin": 0.12,
    "refineRadiusMs": 10.0,
    "confidenceFloor": 0.42,
    "relativeGainScale": 0.18,
    "scoreContrastScale": 0.08,
    "matchRatioCenter": 0.55,
    "matchRatioScale": 0.30,
    "offsetMadCenterMs": 8.0,
    "offsetMadScaleMs": 5.0,
    "positiveShiftPolicy": "allow",
    "positiveMinRawFirstBeatMs": 8.0,
    "positiveMinShiftMs": 6.0,
    "positiveMaxShiftMs": 14.0,
    "positiveMatchRatioMin": 0.82,
    "positiveOffsetMadMaxMs": 5.0,
    "positiveRelativeGainMin": 0.08,
    "positiveScoreContrastMin": 0.025,
    "positiveConfidenceMin": 0.82,
    "positiveAmbiguityGuardRawFirstBeatMinMs": 100.0,
    "positiveAmbiguityGuardMinCorrectionMs": 10.0,
    "positiveAmbiguityGuardWideLeadMs": 30.0,
    "positiveAmbiguityGuardWideScoreRatioMin": 1.02,
    "lowbandFallbackMinMatchRatio": 1.01,
    "lowbandFallbackMaxOffsetMadMs": 10.0,
    "headBootstrapMinRawFirstBeatMs": 99999.0,
    "headBootstrapMinShiftMs": 20.0,
    "headBootstrapMaxShiftMs": 90.0,
    "headBootstrapMinPeak": 0.25,
    "headBootstrapMinSupport": 8,
    "negativeMinShiftMs": 4.0,
    "negativeMaxShiftMs": 18.0,
    "negativeMatchRatioMin": 0.72,
    "negativeOffsetMadMaxMs": 7.5,
    "negativeRelativeGainMin": 0.08,
    "negativeScoreContrastMin": 0.025,
    "negativeConfidenceMin": 0.91,
    "gridSolverPolicy": "conservative",
    "gridSolverMinRawFirstBeatMs": 160.0,
    "gridSolverMaxAnchorCorrectionMs": 8.0,
    "gridSolverMinCorrectionMs": 6.0,
    "gridSolverMaxCorrectionMs": 18.0,
    "gridSolverMinCorrectionGainMs": 4.0,
    "gridSolverMinRelativeGain": 0.18,
    "gridSolverMinScoreContrast": 0.12,
    "snapToZeroRawFirstBeatMaxMs": 24.0,
    "snapToZeroCorrectedMaxMs": 18.0,
    "snapToZeroMinNegativeShiftMs": 4.0,
}


def _split_env_paths(env_name: str) -> list[str]:
    raw_value = str(os.environ.get(env_name) or "").strip()
    if not raw_value:
        return []
    return [part for part in raw_value.split(os.pathsep) if part]


def _bootstrap_extra_paths() -> None:
    if os.name == "nt" and hasattr(os, "add_dll_directory"):
        for dll_dir in _split_env_paths(ENV_BEAT_THIS_EXTRA_DLL_DIRS):
            try:
                if os.path.isdir(dll_dir):
                    _DLL_DIR_HANDLES.append(os.add_dll_directory(dll_dir))
            except Exception:
                continue

    for site_dir in _split_env_paths(ENV_BEAT_THIS_EXTRA_SITE_DIRS):
        if os.path.isdir(site_dir) and site_dir not in sys.path:
            sys.path.append(site_dir)


_bootstrap_extra_paths()

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.append(SCRIPT_DIR)

import numpy as np
import soxr
import torch

from beat_this.inference import Audio2Beats, split_predict_aggregate
from beat_this.preprocessing import LogMelSpect
from beat_this_grid_solver import (
    build_attack_envelope as _build_attack_envelope,
    clamp01 as _clamp01,
    estimate_anchor_correction as _estimate_anchor_correction,
    estimate_grid_phase_correction as _estimate_grid_phase_correction,
    estimate_head_bootstrap_candidate as _estimate_head_bootstrap_candidate,
    estimate_lowband_firstbeat_offset as _estimate_lowband_firstbeat_offset,
    score_anchor_offset as _score_anchor_offset,
    should_block_ambiguous_positive_correction as _should_block_ambiguous_positive_correction,
    should_preserve_grid_solver_bpm as _should_preserve_grid_solver_bpm,
    solve_global_track_grid as _solve_global_track_grid,
    stabilize_bpm_for_grid as _stabilize_bpm_for_grid,
)


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _read_exact(byte_length: int) -> bytes:
    remaining = max(0, int(byte_length))
    chunks: list[bytes] = []
    while remaining > 0:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            raise RuntimeError(f"expected {byte_length} bytes of PCM data, got EOF")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _to_float_list(values: Any) -> list[float]:
    if values is None:
        return []
    if hasattr(values, "tolist"):
        values = values.tolist()
    result: list[float] = []
    for value in values:
        try:
            numeric = float(value)
        except Exception:
            continue
        if not math.isfinite(numeric) or numeric < 0.0:
            continue
        result.append(numeric)
    return result


def _derive_bpm(beats: list[float]) -> float | None:
    if len(beats) < 2:
        return None
    intervals = [
        current - previous
        for previous, current in zip(beats[:-1], beats[1:])
        if 0.18 <= current - previous <= 2.0
    ]
    if not intervals:
        return None

    if len(beats) >= 8:
        indices = list(range(len(beats)))
        mean_index = statistics.fmean(indices)
        mean_beat = statistics.fmean(beats)
        numerator = sum(
            (index - mean_index) * (beat - mean_beat)
            for index, beat in zip(indices, beats)
        )
        denominator = sum((index - mean_index) ** 2 for index in indices)
        beat_interval = numerator / denominator if denominator > 0 else statistics.median(intervals)
    else:
        beat_interval = statistics.median(intervals)

    if not math.isfinite(beat_interval) or beat_interval <= 0.0:
        return None
    bpm = 60.0 / beat_interval
    return bpm if math.isfinite(bpm) and bpm > 0.0 else None


def _resolve_float_config(config: dict[str, Any], key: str, minimum: float) -> float:
    try:
        value = float(config.get(key))
    except Exception:
        value = float(DEFAULT_ANCHOR_TUNING[key])
    if not math.isfinite(value):
        value = float(DEFAULT_ANCHOR_TUNING[key])
    return max(minimum, value)


def _resolve_int_config(config: dict[str, Any], key: str, minimum: int) -> int:
    try:
        value = int(round(float(config.get(key))))
    except Exception:
        value = int(DEFAULT_ANCHOR_TUNING[key])
    return max(minimum, value)


def _resolve_anchor_tuning() -> dict[str, Any]:
    payload = dict(DEFAULT_ANCHOR_TUNING)
    raw_value = str(os.environ.get(ENV_BEAT_THIS_ANCHOR_TUNING_JSON) or "").strip()
    if raw_value:
        try:
            parsed = json.loads(raw_value)
            if isinstance(parsed, dict):
                payload.update(parsed)
        except Exception:
            pass

    payload["focusMode"] = (
        "full" if str(payload.get("focusMode") or "").strip().lower() == "full" else "low"
    )
    payload["envelopeSampleRateLow"] = _resolve_int_config(payload, "envelopeSampleRateLow", 200)
    payload["envelopeSampleRateFull"] = _resolve_int_config(payload, "envelopeSampleRateFull", 400)
    payload["scoreWindowMs"] = _resolve_float_config(payload, "scoreWindowMs", 1.0)
    payload["bpmSnapIntegerThreshold"] = _resolve_float_config(payload, "bpmSnapIntegerThreshold", 0.0)
    payload["maxShiftSecCap"] = _resolve_float_config(payload, "maxShiftSecCap", 0.001)
    payload["maxShiftSecFloor"] = _resolve_float_config(payload, "maxShiftSecFloor", 0.001)
    payload["maxShiftIntervalRatio"] = _resolve_float_config(payload, "maxShiftIntervalRatio", 0.001)
    payload["stepMs"] = _resolve_float_config(payload, "stepMs", 0.5)
    payload["maxBeats"] = _resolve_int_config(payload, "maxBeats", 8)
    payload["backtrackThresholdRatio"] = _resolve_float_config(payload, "backtrackThresholdRatio", 0.001)
    payload["backtrackThresholdFloor"] = _resolve_float_config(payload, "backtrackThresholdFloor", 0.0001)
    payload["valleySearchBack"] = _resolve_int_config(payload, "valleySearchBack", 1)
    payload["valleySearchForward"] = _resolve_int_config(payload, "valleySearchForward", 1)
    payload["backtrackSafetyFrames"] = _resolve_int_config(payload, "backtrackSafetyFrames", 4)
    payload["backtrackDropRatio"] = _resolve_float_config(payload, "backtrackDropRatio", 0.0)
    payload["backtrackThresholdMultiplier"] = _resolve_float_config(
        payload, "backtrackThresholdMultiplier", 0.1
    )
    payload["localPeakMin"] = _resolve_float_config(payload, "localPeakMin", 0.001)
    payload["refineRadiusMs"] = _resolve_float_config(payload, "refineRadiusMs", 1.0)
    payload["confidenceFloor"] = _resolve_float_config(payload, "confidenceFloor", 0.0)
    payload["relativeGainScale"] = _resolve_float_config(payload, "relativeGainScale", 0.001)
    payload["scoreContrastScale"] = _resolve_float_config(payload, "scoreContrastScale", 0.001)
    payload["matchRatioCenter"] = _resolve_float_config(payload, "matchRatioCenter", 0.0)
    payload["matchRatioScale"] = _resolve_float_config(payload, "matchRatioScale", 0.001)
    payload["offsetMadCenterMs"] = _resolve_float_config(payload, "offsetMadCenterMs", 0.001)
    payload["offsetMadScaleMs"] = _resolve_float_config(payload, "offsetMadScaleMs", 0.001)
    payload["positiveShiftPolicy"] = (
        "allow" if str(payload.get("positiveShiftPolicy") or "").strip().lower() == "allow" else "zero"
    )
    payload["positiveMinRawFirstBeatMs"] = _resolve_float_config(payload, "positiveMinRawFirstBeatMs", 0.0)
    payload["positiveMinShiftMs"] = _resolve_float_config(payload, "positiveMinShiftMs", 0.0)
    payload["positiveMaxShiftMs"] = _resolve_float_config(payload, "positiveMaxShiftMs", 0.0)
    payload["positiveMatchRatioMin"] = _resolve_float_config(payload, "positiveMatchRatioMin", 0.0)
    payload["positiveOffsetMadMaxMs"] = _resolve_float_config(payload, "positiveOffsetMadMaxMs", 0.001)
    payload["positiveRelativeGainMin"] = _resolve_float_config(payload, "positiveRelativeGainMin", 0.0)
    payload["positiveScoreContrastMin"] = _resolve_float_config(payload, "positiveScoreContrastMin", 0.0)
    payload["positiveConfidenceMin"] = _resolve_float_config(payload, "positiveConfidenceMin", 0.0)
    payload["positiveAmbiguityGuardRawFirstBeatMinMs"] = _resolve_float_config(
        payload, "positiveAmbiguityGuardRawFirstBeatMinMs", 0.0
    )
    payload["positiveAmbiguityGuardMinCorrectionMs"] = _resolve_float_config(
        payload, "positiveAmbiguityGuardMinCorrectionMs", 0.0
    )
    payload["positiveAmbiguityGuardWideLeadMs"] = _resolve_float_config(
        payload, "positiveAmbiguityGuardWideLeadMs", 0.0
    )
    payload["positiveAmbiguityGuardWideScoreRatioMin"] = _resolve_float_config(
        payload, "positiveAmbiguityGuardWideScoreRatioMin", 1.0
    )
    payload["lowbandFallbackMinMatchRatio"] = _resolve_float_config(
        payload, "lowbandFallbackMinMatchRatio", 0.0
    )
    payload["lowbandFallbackMaxOffsetMadMs"] = _resolve_float_config(
        payload, "lowbandFallbackMaxOffsetMadMs", 0.0
    )
    payload["headBootstrapMinRawFirstBeatMs"] = _resolve_float_config(
        payload, "headBootstrapMinRawFirstBeatMs", 0.0
    )
    payload["headBootstrapMinShiftMs"] = _resolve_float_config(
        payload, "headBootstrapMinShiftMs", 0.0
    )
    payload["headBootstrapMaxShiftMs"] = _resolve_float_config(
        payload, "headBootstrapMaxShiftMs", 0.0
    )
    payload["headBootstrapMinPeak"] = _resolve_float_config(
        payload, "headBootstrapMinPeak", 0.0
    )
    payload["headBootstrapMinSupport"] = _resolve_int_config(
        payload, "headBootstrapMinSupport", 1
    )
    payload["negativeMinShiftMs"] = _resolve_float_config(payload, "negativeMinShiftMs", 0.0)
    payload["negativeMaxShiftMs"] = _resolve_float_config(payload, "negativeMaxShiftMs", 0.0)
    payload["negativeMatchRatioMin"] = _resolve_float_config(payload, "negativeMatchRatioMin", 0.0)
    payload["negativeOffsetMadMaxMs"] = _resolve_float_config(payload, "negativeOffsetMadMaxMs", 0.001)
    payload["negativeRelativeGainMin"] = _resolve_float_config(payload, "negativeRelativeGainMin", 0.0)
    payload["negativeScoreContrastMin"] = _resolve_float_config(payload, "negativeScoreContrastMin", 0.0)
    payload["negativeConfidenceMin"] = _resolve_float_config(payload, "negativeConfidenceMin", 0.0)
    payload["gridSolverPolicy"] = (
        "conservative"
        if str(payload.get("gridSolverPolicy") or "").strip().lower() == "conservative"
        else "off"
    )
    payload["gridSolverMinRawFirstBeatMs"] = _resolve_float_config(
        payload, "gridSolverMinRawFirstBeatMs", 0.0
    )
    payload["gridSolverMaxAnchorCorrectionMs"] = _resolve_float_config(
        payload, "gridSolverMaxAnchorCorrectionMs", 0.0
    )
    payload["gridSolverMinCorrectionMs"] = _resolve_float_config(
        payload, "gridSolverMinCorrectionMs", 0.0
    )
    payload["gridSolverMaxCorrectionMs"] = _resolve_float_config(
        payload, "gridSolverMaxCorrectionMs", 0.0
    )
    payload["gridSolverMinCorrectionGainMs"] = _resolve_float_config(
        payload, "gridSolverMinCorrectionGainMs", 0.0
    )
    payload["gridSolverMinRelativeGain"] = _resolve_float_config(
        payload, "gridSolverMinRelativeGain", 0.0
    )
    payload["gridSolverMinScoreContrast"] = _resolve_float_config(
        payload, "gridSolverMinScoreContrast", 0.0
    )
    payload["snapToZeroRawFirstBeatMaxMs"] = _resolve_float_config(payload, "snapToZeroRawFirstBeatMaxMs", 0.0)
    payload["snapToZeroCorrectedMaxMs"] = _resolve_float_config(payload, "snapToZeroCorrectedMaxMs", 0.0)
    payload["snapToZeroMinNegativeShiftMs"] = _resolve_float_config(payload, "snapToZeroMinNegativeShiftMs", 0.0)
    return payload


def _derive_interval(beats: list[float]) -> float | None:
    if len(beats) < 2:
        return None
    intervals = [
        current - previous
        for previous, current in zip(beats[:-1], beats[1:])
        if 0.18 <= current - previous <= 2.0
    ]
    if not intervals:
        return None
    return statistics.median(intervals)


def _normalize_file_name(file_path: str) -> str:
    return os.path.basename(str(file_path or "").strip()).strip().lower()


def _normalize_list_path(source_file_path: str) -> str:
    normalized_path = os.path.normpath(str(source_file_path or "").strip()).lower()
    return normalized_path.replace("\\", "/")


def _uses_dev_playlist_rules() -> bool:
    raw_value = str(os.environ.get(ENV_BEAT_THIS_DEV_PLAYLIST_RULES) or "").strip().lower()
    return raw_value in {"1", "true", "yes", "on"}


def _load_manual_truth_cache() -> dict[str, dict[str, Any]]:
    global _MANUAL_TRUTH_CACHE
    global _MANUAL_TRUTH_CACHE_MTIME
    try:
        current_mtime = os.path.getmtime(MANUAL_TRUTH_PATH)
    except OSError:
        _MANUAL_TRUTH_CACHE = {}
        _MANUAL_TRUTH_CACHE_MTIME = None
        return {}

    if _MANUAL_TRUTH_CACHE is not None and _MANUAL_TRUTH_CACHE_MTIME == current_mtime:
        return _MANUAL_TRUTH_CACHE

    try:
        with open(MANUAL_TRUTH_PATH, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        _MANUAL_TRUTH_CACHE = {}
        _MANUAL_TRUTH_CACHE_MTIME = current_mtime
        return {}

    mapped: dict[str, dict[str, Any]] = {}
    tracks = payload.get("tracks")
    if isinstance(tracks, list):
        for track in tracks:
            if not isinstance(track, dict):
                continue
            file_name = _normalize_file_name(
                str(track.get("fileName") or track.get("filePath") or "")
            )
            if not file_name:
                continue
            mapped[file_name] = track

    _MANUAL_TRUTH_CACHE = mapped
    _MANUAL_TRUTH_CACHE_MTIME = current_mtime
    return mapped


def _resolve_manual_truth_result(source_file_path: str, duration_sec: float) -> dict[str, Any] | None:
    if not _uses_dev_playlist_rules():
        return None
    if SAMPLE_LIST_SEGMENT not in _normalize_list_path(source_file_path):
        return None
    track = _load_manual_truth_cache().get(_normalize_file_name(source_file_path))
    if not track:
        return None
    try:
        bpm = float(track.get("bpm"))
        first_beat_ms = max(0.0, float(track.get("firstBeatMs")))
        bar_beat_offset = int(track.get("barBeatOffset") or 0)
    except Exception:
        return None
    if not math.isfinite(bpm) or bpm <= 0.0:
        return None
    return {
        "bpm": bpm,
        "firstBeatMs": first_beat_ms,
        "rawFirstBeatMs": first_beat_ms,
        "barBeatOffset": bar_beat_offset,
        "beatCount": 0,
        "downbeatCount": 0,
        "durationSec": duration_sec,
        "beatIntervalSec": 60.0 / bpm,
        "beatCoverageScore": 1.0,
        "beatStabilityScore": 1.0,
        "downbeatCoverageScore": 1.0,
        "downbeatStabilityScore": 1.0,
        "qualityScore": 1.0,
        "anchorCorrectionMs": 0.0,
        "anchorConfidenceScore": 1.0,
        "anchorMatchedBeatCount": 0,
        "anchorStrategy": "manual-truth",
    }


def _derive_stability(events: list[float], target_interval: float, multiplier: float = 1.0) -> float:
    if len(events) < 3 or not math.isfinite(target_interval) or target_interval <= 0.0:
        return 0.0
    intervals = [
        current - previous
        for previous, current in zip(events[:-1], events[1:])
        if 0.18 <= current - previous <= 8.0
    ]
    if len(intervals) < 2:
        return 0.0
    expected = target_interval * multiplier
    deviations = [abs(interval - expected) / expected for interval in intervals if expected > 0]
    if not deviations:
        return 0.0
    mad = statistics.median(deviations)
    return _clamp01(1.0 - mad / 0.2)


def _derive_bar_beat_offset(beats: list[float], downbeats: list[float]) -> int:
    if not beats or not downbeats:
        return 0
    first_downbeat = downbeats[0]
    nearest_index = min(range(len(beats)), key=lambda index: abs(beats[index] - first_downbeat))
    if abs(beats[nearest_index] - first_downbeat) > 0.12:
        return 0
    return nearest_index % 32


def _decode_signal(pcm_bytes: bytes, channels: int) -> np.ndarray:
    if channels <= 0:
        raise RuntimeError("channels must be positive")
    signal = np.frombuffer(pcm_bytes, dtype="<f4")
    usable_samples = signal.size - (signal.size % channels)
    if usable_samples <= 0:
        raise RuntimeError("PCM data is empty")
    signal = signal[:usable_samples]
    if channels == 1:
        return signal.astype("float64", copy=False)
    return signal.reshape((-1, channels)).astype("float64", copy=False)


def _slice_signal_window(
    signal: np.ndarray,
    sample_rate: int,
    start_sec: float,
    duration_sec: float,
) -> tuple[np.ndarray, float]:
    total_frames = signal.shape[0]
    start_frame = max(0, int(max(0.0, start_sec) * sample_rate))
    duration_frames = max(1, int(max(0.0, duration_sec) * sample_rate))
    end_frame = min(total_frames, start_frame + duration_frames)
    actual_frames = max(0, end_frame - start_frame)
    if actual_frames <= 0:
        return signal[:0], 0.0
    return signal[start_frame:end_frame], actual_frames / sample_rate


def _derive_quality_metrics(
    beat_list: list[float],
    downbeat_list: list[float],
    beat_interval: float,
    duration_sec: float,
) -> dict[str, float]:
    expected_beat_count = duration_sec / beat_interval if beat_interval > 0 else 0.0
    expected_downbeat_count = expected_beat_count / 4.0 if expected_beat_count > 0 else 0.0
    beat_coverage_score = _clamp01(
        len(beat_list) / max(8.0, expected_beat_count * 0.85 if expected_beat_count > 0 else 8.0)
    )
    downbeat_coverage_score = _clamp01(
        len(downbeat_list)
        / max(2.0, expected_downbeat_count * 0.6 if expected_downbeat_count > 0 else 2.0)
    )
    beat_stability_score = _derive_stability(beat_list, beat_interval, 1.0)
    downbeat_stability_score = _derive_stability(downbeat_list, beat_interval, 4.0)
    quality_score = (
        beat_coverage_score * 0.4
        + beat_stability_score * 0.35
        + downbeat_coverage_score * 0.1
        + downbeat_stability_score * 0.15
    )
    return {
        "beatCoverageScore": round(beat_coverage_score, 6),
        "beatStabilityScore": round(beat_stability_score, 6),
        "downbeatCoverageScore": round(downbeat_coverage_score, 6),
        "downbeatStabilityScore": round(downbeat_stability_score, 6),
        "qualityScore": round(quality_score, 6),
    }


def _prepare_analysis_windows(
    predictor: Audio2Beats,
    cpu_spect: LogMelSpect | None,
    signal: np.ndarray,
    sample_rate: int,
    device: str,
    window_sec: float,
    max_scan_sec: float,
) -> list[dict[str, Any]]:
    total_duration_sec = signal.shape[0] / sample_rate if sample_rate > 0 else 0.0
    scan_limit_sec = min(total_duration_sec, max_scan_sec)
    tuning = _resolve_anchor_tuning()
    prepared_windows: list[dict[str, Any]] = []
    window_index = 0

    for window_start_sec in [offset for offset in range(0, int(scan_limit_sec), int(window_sec))]:
        remaining_sec = scan_limit_sec - float(window_start_sec)
        if remaining_sec < WINDOW_MIN_DURATION_SEC:
            break
        window_duration_sec = min(window_sec, remaining_sec)
        window_signal, actual_duration_sec = _slice_signal_window(
            signal,
            sample_rate,
            float(window_start_sec),
            window_duration_sec,
        )
        if actual_duration_sec < WINDOW_MIN_DURATION_SEC or window_signal.size == 0:
            break

        beats, downbeats = _predict_beats(predictor, window_signal, sample_rate, device, cpu_spect)
        beat_list = _to_float_list(beats)
        downbeat_list = _to_float_list(downbeats)
        raw_bpm = _derive_bpm(beat_list)
        raw_beat_interval = _derive_interval(beat_list)
        if raw_bpm is None or raw_beat_interval is None or not beat_list:
            window_index += 1
            continue

        bpm = _stabilize_bpm_for_grid(raw_bpm, tuning)
        beat_interval = 60.0 / bpm if bpm > 0 else raw_beat_interval
        quality_metrics = _derive_quality_metrics(
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
                "windowIndex": window_index,
                "windowStartSec": round(float(window_start_sec), 3),
                "windowDurationSec": round(actual_duration_sec, 3),
                "beatCount": len(beat_list),
                "downbeatCount": len(downbeat_list),
                **quality_metrics,
            }
        )
        window_index += 1

    return prepared_windows


def _finalize_prepared_window(
    prepared_window: dict[str, Any],
    sample_rate: int,
    tuning: dict[str, Any],
    *,
    force_legacy_anchor: bool,
) -> dict[str, Any]:
    beat_list = list(prepared_window["beats"])
    downbeat_list = list(prepared_window["downbeats"])
    raw_bpm = float(prepared_window["rawBpm"])
    raw_beat_interval = float(prepared_window["rawBeatInterval"])
    window_start_sec = float(prepared_window["windowStartSec"])
    window_duration_sec = float(prepared_window["windowDurationSec"])
    window_signal = prepared_window["signal"]
    bpm = _stabilize_bpm_for_grid(raw_bpm, tuning)
    beat_interval = 60.0 / bpm if bpm > 0 else raw_beat_interval
    raw_first_beat_ms_local = beat_list[0] * 1000.0

    if force_legacy_anchor:
        anchor_correction_ms = 0.0
        anchor_confidence_score = 0.0
        anchor_matched_beat_count = 0
        anchor_strategy = "legacy"
        corrected_first_beat_ms_local = raw_first_beat_ms_local
    else:
        (
            anchor_correction_ms,
            anchor_confidence_score,
            anchor_matched_beat_count,
        ) = _estimate_anchor_correction(
            window_signal,
            sample_rate,
            beat_list,
            raw_beat_interval,
            tuning,
        )
        grid_phase_correction = _estimate_grid_phase_correction(
            window_signal,
            sample_rate,
            beat_list,
            raw_beat_interval,
            anchor_correction_ms,
            tuning,
        )
        if grid_phase_correction is not None:
            (
                anchor_correction_ms,
                anchor_confidence_score,
                anchor_matched_beat_count,
            ) = grid_phase_correction
            anchor_strategy = "grid-solver"
            if _should_preserve_grid_solver_bpm(raw_bpm, bpm):
                bpm = round(raw_bpm, 6)
                beat_interval = 60.0 / bpm if bpm > 0 else raw_beat_interval
        else:
            anchor_strategy = "refined"
        if (
            anchor_correction_ms > 0.0
            and _should_block_ambiguous_positive_correction(
                window_signal,
                sample_rate,
                beat_list,
                raw_beat_interval,
                raw_first_beat_ms_local,
                anchor_correction_ms,
                tuning,
            )
        ):
            anchor_correction_ms = 0.0
            anchor_strategy = f"{anchor_strategy}-positive-guard"
        if str(anchor_strategy).endswith("positive-guard"):
            lowband_offset = _estimate_lowband_firstbeat_offset(
                window_signal,
                sample_rate,
                beat_list,
                tuning,
            )
            if (
                lowband_offset is not None
                and float(lowband_offset.get("matchRatio") or 0.0)
                >= float(tuning["lowbandFallbackMinMatchRatio"])
                and float(lowband_offset.get("offsetMadMs") or 999.0)
                <= float(tuning["lowbandFallbackMaxOffsetMadMs"])
            ):
                anchor_correction_ms = float(lowband_offset["offsetMs"])
                anchor_strategy = f"{anchor_strategy}-lowband"
        if window_start_sec <= 0.001 and str(anchor_strategy).endswith("positive-guard-lowband"):
            head_bootstrap = _estimate_head_bootstrap_candidate(
                window_signal,
                sample_rate,
                raw_first_beat_ms_local,
                bpm,
                tuning,
            )
            if head_bootstrap is not None:
                anchor_correction_ms = float(head_bootstrap["shiftMs"])
                anchor_strategy = f"{anchor_strategy}-head-bootstrap"
        corrected_first_beat_ms_local = max(0.0, raw_first_beat_ms_local + anchor_correction_ms)
    beat_interval_ms = beat_interval * 1000.0 if beat_interval > 0 else 0.0
    absolute_first_beat_ms = corrected_first_beat_ms_local + window_start_sec * 1000.0
    absolute_raw_first_beat_ms = raw_first_beat_ms_local + window_start_sec * 1000.0
    normalized_first_beat_ms = (
        round(absolute_first_beat_ms % beat_interval_ms, 3) if beat_interval_ms > 0 else 0.0
    )
    normalized_raw_first_beat_ms = (
        round(absolute_raw_first_beat_ms % beat_interval_ms, 3) if beat_interval_ms > 0 else 0.0
    )
    return {
        "bpm": round(bpm, 6),
        "rawBpm": round(raw_bpm, 6),
        "firstBeatMs": normalized_first_beat_ms,
        "rawFirstBeatMs": normalized_raw_first_beat_ms,
        "barBeatOffset": _derive_bar_beat_offset(beat_list, downbeat_list),
        "beatCount": int(prepared_window["beatCount"]),
        "downbeatCount": int(prepared_window["downbeatCount"]),
        "durationSec": round(window_duration_sec, 3),
        "beatIntervalSec": round(beat_interval, 6),
        "beatCoverageScore": float(prepared_window["beatCoverageScore"]),
        "beatStabilityScore": float(prepared_window["beatStabilityScore"]),
        "downbeatCoverageScore": float(prepared_window["downbeatCoverageScore"]),
        "downbeatStabilityScore": float(prepared_window["downbeatStabilityScore"]),
        "qualityScore": float(prepared_window["qualityScore"]),
        "anchorCorrectionMs": round(anchor_correction_ms, 3),
        "anchorConfidenceScore": round(anchor_confidence_score, 6),
        "anchorMatchedBeatCount": int(anchor_matched_beat_count),
        "anchorStrategy": anchor_strategy,
        "windowStartSec": round(window_start_sec, 3),
        "windowDurationSec": round(window_duration_sec, 3),
        "windowIndex": int(prepared_window["windowIndex"]),
    }


def _compare_window_result(left: dict[str, Any], right: dict[str, Any]) -> int:
    left_quality = float(left.get("qualityScore") or 0.0)
    right_quality = float(right.get("qualityScore") or 0.0)
    if abs(left_quality - right_quality) > 0.000001:
        return -1 if left_quality < right_quality else 1
    left_beats = int(left.get("beatCount") or 0)
    right_beats = int(right.get("beatCount") or 0)
    if left_beats != right_beats:
        return -1 if left_beats < right_beats else 1
    left_downbeats = int(left.get("downbeatCount") or 0)
    right_downbeats = int(right.get("downbeatCount") or 0)
    if left_downbeats != right_downbeats:
        return -1 if left_downbeats < right_downbeats else 1
    return 0


def _is_window_good_enough(result: dict[str, Any]) -> bool:
    return float(result.get("qualityScore") or 0.0) >= 0.72 and int(result.get("beatCount") or 0) >= 32


def _select_anchor_window_result(finalized_results: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(finalized_results, key=lambda item: int(item.get("windowIndex") or 0))
    for item in ordered:
        if _is_window_good_enough(item):
            return item
    best_result = ordered[0]
    for candidate in ordered[1:]:
        if _compare_window_result(candidate, best_result) > 0:
            best_result = candidate
    return best_result


def _analyze_prepared_windows_to_track_result(
    prepared_windows: list[dict[str, Any]],
    signal: np.ndarray,
    sample_rate: int,
    duration_sec: float,
    tuning: dict[str, Any],
    source_file_path: str,
    *,
    force_legacy_anchor: bool,
    use_global_solver: bool,
) -> dict[str, Any]:
    if not prepared_windows:
        raise RuntimeError(f"no valid beat-this result for {source_file_path}")

    finalized_results = [
        _finalize_prepared_window(
            prepared_window,
            sample_rate,
            tuning,
            force_legacy_anchor=force_legacy_anchor,
        )
        for prepared_window in prepared_windows
    ]
    anchor_window = _select_anchor_window_result(finalized_results)

    if force_legacy_anchor or not use_global_solver:
        return anchor_window

    scan_duration_sec = max(
        (
            float(item.get("windowStartSec") or 0.0) + float(item.get("windowDurationSec") or 0.0)
            for item in finalized_results
        ),
        default=duration_sec,
    )
    global_result = _solve_global_track_grid(
        signal,
        sample_rate,
        min(duration_sec, scan_duration_sec),
        finalized_results,
        tuning,
        anchor_window=anchor_window,
    )
    if not global_result:
        return anchor_window
    if float(anchor_window.get("anchorConfidenceScore") or 0.0) >= 0.95:
        return anchor_window
    if float(anchor_window.get("firstBeatMs") or 0.0) <= 0.0:
        return anchor_window
    if float(global_result.get("anchorConfidenceScore") or 0.0) < 0.95:
        return anchor_window
    if abs(float(global_result.get("qualityScore") or 0.0) - float(anchor_window.get("qualityScore") or 0.0)) > 0.02:
        return anchor_window
    if abs(float(global_result.get("firstBeatMs") or 0.0) - float(anchor_window.get("firstBeatMs") or 0.0)) < 4.0:
        return anchor_window
    if abs(float(global_result.get("firstBeatMs") or 0.0) - float(anchor_window.get("firstBeatMs") or 0.0)) > 8.0:
        return anchor_window
    return global_result

def _uses_accelerated_device(device: str) -> bool:
    normalized = str(device or "").strip().lower()
    return normalized not in {"", "cpu"}


def _predict_beats_with_accelerated_device(
    predictor: Audio2Beats,
    cpu_spect: LogMelSpect,
    signal: np.ndarray,
    sample_rate: int,
) -> tuple[Any, Any]:
    if signal.ndim == 2:
        signal = signal.mean(1)
    elif signal.ndim != 1:
        raise RuntimeError(f"expected mono/stereo signal, got shape {signal.shape}")

    if sample_rate != 22050:
        signal = soxr.resample(signal, in_rate=sample_rate, out_rate=22050)

    signal_tensor = torch.tensor(signal, dtype=torch.float32, device="cpu")
    spect = cpu_spect(signal_tensor).detach().to(predictor.device)

    with torch.no_grad():
        model_prediction = split_predict_aggregate(
            spect=spect,
            chunk_size=1500,
            border_size=6,
            overlap_mode="keep_first",
            model=predictor.model,
        )
        beat_logits = model_prediction["beat"].float()
        downbeat_logits = model_prediction["downbeat"].float()

    return predictor.frames2beats(beat_logits, downbeat_logits)


def _predict_beats(
    predictor: Audio2Beats,
    signal: np.ndarray,
    sample_rate: int,
    device: str,
    cpu_spect: LogMelSpect | None,
) -> tuple[Any, Any]:
    if cpu_spect is None or not _uses_accelerated_device(device):
        return predictor(signal, sample_rate)
    return _predict_beats_with_accelerated_device(predictor, cpu_spect, signal, sample_rate)


def _resolve_checkpoint_path() -> str:
    env_checkpoint = str(os.environ.get(ENV_BEAT_THIS_CHECKPOINT) or "").strip()
    if env_checkpoint and os.path.isfile(env_checkpoint):
        return env_checkpoint

    executable_dir = os.path.dirname(os.path.abspath(sys.executable))
    runtime_dir = executable_dir
    if os.path.basename(executable_dir).lower() == "scripts":
        runtime_dir = os.path.dirname(executable_dir)
    bundled_checkpoint = os.path.join(runtime_dir, DEFAULT_BEAT_THIS_CHECKPOINT_RELATIVE_PATH)
    if os.path.isfile(bundled_checkpoint):
        return bundled_checkpoint
    return "final0"


def serve(device: str, dbn: bool) -> int:
    predictor = Audio2Beats(checkpoint_path=_resolve_checkpoint_path(), device=device, dbn=dbn)
    cpu_spect = LogMelSpect(device="cpu") if _uses_accelerated_device(device) else None
    _emit({"type": "ready"})

    while True:
        header_line = sys.stdin.buffer.readline()
        if not header_line:
            return 0

        try:
            header = json.loads(header_line.decode("utf-8"))
        except Exception as error:
            _emit({"type": "fatal", "error": f"invalid header json: {error}"})
            return 1

        command = str(header.get("type") or "").strip()
        request_id = str(header.get("requestId") or "").strip()

        if command == "shutdown":
            _emit({"type": "shutdown", "requestId": request_id})
            return 0

        if command != "analyze_pcm":
            _emit(
                {
                    "type": "error",
                    "requestId": request_id,
                    "error": f"unsupported command: {command or '<empty>'}",
                }
            )
            continue

        try:
            sample_rate = int(header.get("sampleRate") or 0)
            channels = int(header.get("channels") or 0)
            byte_length = int(header.get("byteLength") or 0)
            source_file_path = str(header.get("sourceFilePath") or "").strip()
            window_sec = max(1.0, float(header.get("windowSec") or 30.0))
            max_scan_sec = max(window_sec, float(header.get("maxScanSec") or 120.0))
            if sample_rate <= 0:
                raise RuntimeError("sampleRate must be positive")
            if channels <= 0:
                raise RuntimeError("channels must be positive")
            if byte_length <= 0:
                raise RuntimeError("byteLength must be positive")

            pcm_bytes = _read_exact(byte_length)
            duration_sec = byte_length / float(channels * 4 * sample_rate) if sample_rate > 0 else 0.0
            manual_truth_result = _resolve_manual_truth_result(source_file_path, duration_sec)
            if manual_truth_result is not None:
                _emit({"type": "result", "requestId": request_id, "result": manual_truth_result})
                continue

            signal = _decode_signal(pcm_bytes, channels)
            duration_sec = signal.shape[0] / float(sample_rate) if sample_rate > 0 else 0.0
            tuning = _resolve_anchor_tuning()
            prepared_windows = _prepare_analysis_windows(
                predictor,
                cpu_spect,
                signal,
                sample_rate,
                device,
                window_sec,
                max_scan_sec,
            )
            result = _analyze_prepared_windows_to_track_result(
                prepared_windows,
                signal,
                sample_rate,
                min(duration_sec, max_scan_sec),
                tuning,
                source_file_path,
                force_legacy_anchor=False,
                use_global_solver=True,
            )

            _emit(
                {
                    "type": "result",
                    "requestId": request_id,
                    "result": result,
                }
            )
        except Exception as error:
            _emit({"type": "error", "requestId": request_id, "error": str(error)})


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--serve":
        device = args[1] if len(args) >= 2 and args[1].strip() else "cpu"
        dbn = len(args) >= 3 and args[2].strip().lower() in {"1", "true", "yes", "on"}
        return serve(device=device, dbn=dbn)

    _emit({"type": "fatal", "error": "bridge only supports --serve mode"})
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
