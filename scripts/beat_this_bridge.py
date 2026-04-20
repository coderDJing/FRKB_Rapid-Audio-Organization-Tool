import os
import json
import math
import statistics
import sys
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANUAL_TRUTH_PATH = os.path.join(REPO_ROOT, "grid-analysis-lab", "manual-truth", "truth-sample.json")
SAMPLE_LIST_SEGMENT = "/library/filterlibrary/sample/"
RAW_LIST_SEGMENT = "/library/filterlibrary/raw/"
ENV_BEAT_THIS_EXTRA_SITE_DIRS = "FRKB_BEAT_THIS_EXTRA_SITE_DIRS"
ENV_BEAT_THIS_EXTRA_DLL_DIRS = "FRKB_BEAT_THIS_EXTRA_DLL_DIRS"
ENV_BEAT_THIS_CHECKPOINT = "FRKB_BEAT_THIS_CHECKPOINT"
ENV_BEAT_THIS_ANCHOR_TUNING_JSON = "FRKB_BEAT_THIS_ANCHOR_TUNING_JSON"
ENV_BEAT_THIS_DEV_PLAYLIST_RULES = "FRKB_BEAT_THIS_DEV_PLAYLIST_RULES"
DEFAULT_BEAT_THIS_CHECKPOINT_RELATIVE_PATH = os.path.join("beat-this-checkpoints", "final0.ckpt")
_DLL_DIR_HANDLES: list[Any] = []
_MANUAL_TRUTH_CACHE: dict[str, dict[str, Any]] | None = None
_MANUAL_TRUTH_CACHE_MTIME: float | None = None

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
    "positiveMaxShiftMs": 10.0,
    "positiveMatchRatioMin": 0.82,
    "positiveOffsetMadMaxMs": 5.0,
    "positiveRelativeGainMin": 0.08,
    "positiveScoreContrastMin": 0.025,
    "positiveConfidenceMin": 0.82,
    "negativeMinShiftMs": 4.0,
    "negativeMaxShiftMs": 18.0,
    "negativeMatchRatioMin": 0.72,
    "negativeOffsetMadMaxMs": 7.5,
    "negativeRelativeGainMin": 0.08,
    "negativeScoreContrastMin": 0.025,
    "negativeConfidenceMin": 0.78,
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

import numpy as np
import soxr
import torch

from beat_this.inference import Audio2Beats, split_predict_aggregate
from beat_this.preprocessing import LogMelSpect


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


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, value))


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
    payload["negativeMinShiftMs"] = _resolve_float_config(payload, "negativeMinShiftMs", 0.0)
    payload["negativeMaxShiftMs"] = _resolve_float_config(payload, "negativeMaxShiftMs", 0.0)
    payload["negativeMatchRatioMin"] = _resolve_float_config(payload, "negativeMatchRatioMin", 0.0)
    payload["negativeOffsetMadMaxMs"] = _resolve_float_config(payload, "negativeOffsetMadMaxMs", 0.001)
    payload["negativeRelativeGainMin"] = _resolve_float_config(payload, "negativeRelativeGainMin", 0.0)
    payload["negativeScoreContrastMin"] = _resolve_float_config(payload, "negativeScoreContrastMin", 0.0)
    payload["negativeConfidenceMin"] = _resolve_float_config(payload, "negativeConfidenceMin", 0.0)
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


def _stabilize_bpm_for_grid(bpm: float, tuning: dict[str, Any]) -> float:
    if not math.isfinite(bpm) or bpm <= 0.0:
        return bpm
    snapped_bpm = float(bpm)
    nearest_integer = round(snapped_bpm)
    if abs(snapped_bpm - nearest_integer) <= float(tuning["bpmSnapIntegerThreshold"]):
        snapped_bpm = float(nearest_integer)
    return round(snapped_bpm, 6)


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


def _mix_to_mono(signal: np.ndarray) -> np.ndarray:
    if signal.ndim == 1:
        return signal.astype("float64", copy=False)
    if signal.ndim == 2:
        return signal.mean(axis=1).astype("float64", copy=False)
    raise RuntimeError(f"expected mono/stereo signal, got shape {signal.shape}")


def _moving_average(values: np.ndarray, window_size: int) -> np.ndarray:
    if window_size <= 1 or values.size <= 1:
        return values.astype("float64", copy=False)
    kernel = np.ones(window_size, dtype="float64") / float(window_size)
    return np.convolve(values, kernel, mode="same")


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float | None:
    if values.size == 0 or weights.size == 0 or values.size != weights.size:
        return None
    total_weight = float(np.sum(weights))
    if not math.isfinite(total_weight) or total_weight <= 0.0:
        return None
    order = np.argsort(values)
    sorted_values = values[order]
    sorted_weights = weights[order]
    cumulative = np.cumsum(sorted_weights)
    target = total_weight * 0.5
    index = int(np.searchsorted(cumulative, target, side="left"))
    index = min(max(index, 0), sorted_values.size - 1)
    weighted_value = float(sorted_values[index])
    return weighted_value if math.isfinite(weighted_value) else None


def _weighted_mad(values: np.ndarray, weights: np.ndarray, center_value: float | None = None) -> float | None:
    if values.size == 0 or weights.size == 0 or values.size != weights.size:
        return None
    center = center_value if center_value is not None else _weighted_median(values, weights)
    if center is None or not math.isfinite(center):
        return None
    deviations = np.abs(values - center)
    return _weighted_median(deviations, weights)


def _backtrack_peak_to_attack_start(
    local_window: np.ndarray,
    peak_index: int,
    tuning: dict[str, Any],
) -> int:
    if local_window.size == 0:
        return 0
    peak_index = min(max(int(peak_index), 0), local_window.size - 1)
    peak_value = float(local_window[peak_index])
    if peak_index <= 0 or not math.isfinite(peak_value) or peak_value <= 0.0:
        return peak_index

    threshold = max(
        peak_value * float(tuning["backtrackThresholdRatio"]),
        float(tuning["backtrackThresholdFloor"]),
    )
    floor_matches = np.flatnonzero(local_window[: peak_index + 1] <= threshold)
    if floor_matches.size == 0:
        return peak_index

    threshold_index = int(floor_matches[-1])
    valley_search_start = max(0, threshold_index - int(tuning["valleySearchBack"]))
    valley_search_end = min(peak_index + 1, threshold_index + int(tuning["valleySearchForward"]))
    valley_slice = local_window[valley_search_start:valley_search_end]
    if valley_slice.size == 0:
        return threshold_index
    valley_index = int(np.argmin(valley_slice)) + valley_search_start

    # If the valley still sits inside a noisy shoulder, walk a little further back
    # while the envelope keeps dropping so we land closer to the audible attack start.
    walk_index = valley_index
    safety_limit = max(0, peak_index - int(tuning["backtrackSafetyFrames"]))
    while walk_index > safety_limit:
        previous_value = float(local_window[walk_index - 1])
        current_value = float(local_window[walk_index])
        if previous_value > current_value + peak_value * float(tuning["backtrackDropRatio"]):
            break
        if previous_value > threshold * float(tuning["backtrackThresholdMultiplier"]):
            break
        walk_index -= 1
    return max(0, walk_index)


def _build_attack_envelope(
    signal: np.ndarray,
    sample_rate: int,
    tuning: dict[str, Any],
) -> tuple[np.ndarray, int] | None:
    if sample_rate <= 0:
        return None
    mono = _mix_to_mono(signal)
    if mono.size < 64:
        return None

    if str(tuning["focusMode"]) == "low":
        envelope_sample_rate = min(sample_rate, int(tuning["envelopeSampleRateLow"]))
    else:
        envelope_sample_rate = min(sample_rate, int(tuning["envelopeSampleRateFull"]))
    if envelope_sample_rate != sample_rate:
        mono = soxr.resample(mono, in_rate=sample_rate, out_rate=envelope_sample_rate)

    mono = mono.astype("float64", copy=False)
    if mono.size < 64:
        return None

    abs_signal = np.abs(mono)
    fast_window = max(1, int(round(envelope_sample_rate * 0.004)))
    slow_window = max(fast_window + 1, int(round(envelope_sample_rate * 0.040)))
    smooth_window = max(1, int(round(envelope_sample_rate * 0.002)))

    fast_env = _moving_average(abs_signal, fast_window)
    slow_env = _moving_average(abs_signal, slow_window)
    attack_env = np.maximum(0.0, fast_env - slow_env)
    attack_env = _moving_average(attack_env, smooth_window)

    peak_value = float(np.max(attack_env)) if attack_env.size else 0.0
    if not math.isfinite(peak_value) or peak_value <= 1e-9:
        return None
    return attack_env / peak_value, envelope_sample_rate


def _score_anchor_offset(
    score_envelope: np.ndarray,
    beat_samples: np.ndarray,
    offset_samples: int,
) -> float:
    if beat_samples.size == 0 or score_envelope.size == 0:
        return 0.0
    sample_positions = beat_samples + int(offset_samples)
    valid_mask = (sample_positions >= 0) & (sample_positions < score_envelope.size)
    if not np.any(valid_mask):
        return 0.0
    valid_positions = sample_positions[valid_mask]
    return float(np.sum(score_envelope[valid_positions]) / max(1, beat_samples.size))


def _estimate_anchor_correction(
    signal: np.ndarray,
    sample_rate: int,
    beats: list[float],
    beat_interval: float,
) -> tuple[float, float, int]:
    if len(beats) < 8 or sample_rate <= 0 or not math.isfinite(beat_interval) or beat_interval <= 0.0:
        return 0.0, 0.0, 0

    tuning = _resolve_anchor_tuning()
    raw_first_beat_ms = float(beats[0]) * 1000.0 if beats else 0.0
    attack_result = _build_attack_envelope(signal, sample_rate, tuning)
    if attack_result is None:
        return 0.0, 0.0, 0
    attack_envelope, envelope_sample_rate = attack_result
    if attack_envelope.size < 64:
        return 0.0, 0.0, 0

    score_window = max(1, int(round(envelope_sample_rate * (float(tuning["scoreWindowMs"]) / 1000.0))))
    score_envelope = _moving_average(attack_envelope, score_window)

    max_shift_sec = min(
        float(tuning["maxShiftSecCap"]),
        max(float(tuning["maxShiftSecFloor"]), beat_interval * float(tuning["maxShiftIntervalRatio"])),
    )
    max_shift_samples = max(1, int(round(max_shift_sec * envelope_sample_rate)))
    step_samples = max(1, int(round(envelope_sample_rate * (float(tuning["stepMs"]) / 1000.0))))

    beat_array = np.asarray(beats, dtype="float64")
    beat_array = beat_array[np.isfinite(beat_array)]
    if beat_array.size < 8:
        return 0.0, 0.0, 0

    beat_samples = np.rint(beat_array * envelope_sample_rate).astype(np.int64, copy=False)
    if beat_samples.size > int(tuning["maxBeats"]):
        sample_stride = max(1, int(math.ceil(beat_samples.size / float(tuning["maxBeats"]))))
        beat_samples = beat_samples[::sample_stride]
    if beat_samples.size < 8:
        return 0.0, 0.0, 0

    offsets = np.arange(-max_shift_samples, max_shift_samples + 1, step_samples, dtype=np.int64)
    if offsets.size == 0:
        return 0.0, 0.0, 0

    scores = np.asarray(
        [_score_anchor_offset(score_envelope, beat_samples, int(offset)) for offset in offsets],
        dtype="float64",
    )
    if scores.size == 0 or not np.any(np.isfinite(scores)):
        return 0.0, 0.0, 0

    best_index = int(np.nanargmax(scores))
    best_offset_samples = int(offsets[best_index])
    best_score = float(scores[best_index])
    zero_index = int(np.argmin(np.abs(offsets)))
    zero_score = float(scores[zero_index])

    separation_samples = max(step_samples * 2, int(round(envelope_sample_rate * 0.005)))
    candidate_mask = np.abs(offsets - best_offset_samples) > separation_samples
    second_best_score = (
        float(np.max(scores[candidate_mask]))
        if np.any(candidate_mask)
        else zero_score
    )

    relative_gain = (best_score - zero_score) / max(1e-9, best_score, zero_score)
    score_contrast = (best_score - second_best_score) / max(1e-9, best_score)
    confidence = _clamp01(relative_gain / float(tuning["relativeGainScale"])) * 0.65 + _clamp01(
        score_contrast / float(tuning["scoreContrastScale"])
    ) * 0.35

    if confidence < float(tuning["confidenceFloor"]):
        return 0.0, confidence, 0

    refine_radius_samples = max(
        step_samples * 2,
        int(round(envelope_sample_rate * (float(tuning["refineRadiusMs"]) / 1000.0))),
    )
    refined_offsets: list[float] = []
    refined_weights: list[float] = []

    for beat_sample in beat_samples:
        center = int(beat_sample) + best_offset_samples
        start = max(0, center - refine_radius_samples)
        end = min(attack_envelope.size, center + refine_radius_samples + 1)
        if end - start < 3:
            continue
        local_window = attack_envelope[start:end]
        local_peak_index = int(np.argmax(local_window))
        local_peak_value = float(local_window[local_peak_index])
        if not math.isfinite(local_peak_value) or local_peak_value < float(tuning["localPeakMin"]):
            continue
        local_attack_index = _backtrack_peak_to_attack_start(local_window, local_peak_index, tuning)
        refined_offsets.append(float(start + local_attack_index - int(beat_sample)))
        refined_weights.append(local_peak_value)

    matched_count = len(refined_offsets)
    if matched_count == 0:
        return 0.0, confidence, 0

    refined_offsets_array = np.asarray(refined_offsets, dtype="float64")
    refined_weights_array = np.asarray(refined_weights, dtype="float64")
    refined_offset_value = _weighted_median(
        refined_offsets_array,
        refined_weights_array,
    )
    final_offset_samples = (
        int(round(refined_offset_value))
        if refined_offset_value is not None
        else best_offset_samples
    )
    final_offset_samples = max(-max_shift_samples, min(max_shift_samples, final_offset_samples))

    match_ratio = matched_count / max(1, beat_samples.size)
    offset_mad_samples = _weighted_mad(
        refined_offsets_array,
        refined_weights_array,
        float(final_offset_samples),
    )
    offset_mad_ms = (
        (float(offset_mad_samples) / envelope_sample_rate) * 1000.0
        if offset_mad_samples is not None and math.isfinite(float(offset_mad_samples))
        else 999.0
    )
    confidence = (
        confidence * 0.45
        + _clamp01((match_ratio - float(tuning["matchRatioCenter"])) / float(tuning["matchRatioScale"])) * 0.30
        + _clamp01(
            (float(tuning["offsetMadCenterMs"]) - offset_mad_ms) / float(tuning["offsetMadScaleMs"])
        ) * 0.25
    )

    final_offset_ms = (final_offset_samples / envelope_sample_rate) * 1000.0
    if final_offset_ms >= 0.0:
        if str(tuning["positiveShiftPolicy"]) != "allow":
            return 0.0, confidence, matched_count
        if raw_first_beat_ms < float(tuning["positiveMinRawFirstBeatMs"]):
            return 0.0, confidence, matched_count
        if (
            final_offset_ms < float(tuning["positiveMinShiftMs"])
            or match_ratio < float(tuning["positiveMatchRatioMin"])
            or offset_mad_ms > float(tuning["positiveOffsetMadMaxMs"])
            or relative_gain < float(tuning["positiveRelativeGainMin"])
            or score_contrast < float(tuning["positiveScoreContrastMin"])
            or confidence < float(tuning["positiveConfidenceMin"])
        ):
            return 0.0, confidence, matched_count
        applied_offset_ms = min(float(tuning["positiveMaxShiftMs"]), final_offset_ms)
    else:
        if (
            abs(final_offset_ms) < float(tuning["negativeMinShiftMs"])
            or match_ratio < float(tuning["negativeMatchRatioMin"])
            or offset_mad_ms > float(tuning["negativeOffsetMadMaxMs"])
            or relative_gain < float(tuning["negativeRelativeGainMin"])
            or score_contrast < float(tuning["negativeScoreContrastMin"])
            or confidence < float(tuning["negativeConfidenceMin"])
        ):
            return 0.0, confidence, matched_count
        applied_offset_ms = max(-float(tuning["negativeMaxShiftMs"]), final_offset_ms)

    corrected_first_beat_ms = raw_first_beat_ms + applied_offset_ms
    if (
        applied_offset_ms < 0.0
        and raw_first_beat_ms <= float(tuning["snapToZeroRawFirstBeatMaxMs"])
        and corrected_first_beat_ms <= float(tuning["snapToZeroCorrectedMaxMs"])
        and abs(applied_offset_ms) >= float(tuning["snapToZeroMinNegativeShiftMs"])
    ):
        applied_offset_ms = -raw_first_beat_ms

    return (
        applied_offset_ms,
        confidence,
        matched_count,
    )


def _should_use_legacy_anchor_strategy(source_file_path: str) -> bool:
    return _uses_dev_playlist_rules() and RAW_LIST_SEGMENT in _normalize_list_path(source_file_path)


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
            beats, downbeats = _predict_beats(predictor, signal, sample_rate, device, cpu_spect)
            beat_list = _to_float_list(beats)
            downbeat_list = _to_float_list(downbeats)
            bpm = _derive_bpm(beat_list)
            if bpm is None:
                raise RuntimeError("Beat This! did not produce a valid BPM")
            if not beat_list:
                raise RuntimeError("Beat This! did not produce any beats")
            raw_beat_interval = _derive_interval(beat_list)
            if raw_beat_interval is None:
                raise RuntimeError("Beat This! did not produce a stable beat interval")
            tuning = _resolve_anchor_tuning()
            bpm = _stabilize_bpm_for_grid(bpm, tuning)
            beat_interval = 60.0 / bpm if bpm > 0 else raw_beat_interval
            raw_first_beat_ms = beat_list[0] * 1000.0
            use_legacy_anchor_strategy = _should_use_legacy_anchor_strategy(source_file_path)
            if use_legacy_anchor_strategy:
                anchor_correction_ms = 0.0
                anchor_confidence_score = 0.0
                anchor_matched_beat_count = 0
                corrected_first_beat_ms = raw_first_beat_ms
            else:
                (
                    anchor_correction_ms,
                    anchor_confidence_score,
                    anchor_matched_beat_count,
                ) = _estimate_anchor_correction(
                    signal,
                    sample_rate,
                    beat_list,
                    raw_beat_interval,
                )
                corrected_first_beat_ms = max(0.0, raw_first_beat_ms + anchor_correction_ms)

            expected_beat_count = duration_sec / beat_interval if beat_interval > 0 else 0.0
            expected_downbeat_count = expected_beat_count / 4.0 if expected_beat_count > 0 else 0.0
            beat_coverage_score = _clamp01(
                len(beat_list) / max(8.0, expected_beat_count * 0.85 if expected_beat_count > 0 else 8.0)
            )
            downbeat_coverage_score = _clamp01(
                len(downbeat_list)
                / max(2.0, expected_downbeat_count * 0.6 if expected_downbeat_count > 0 else 2.0)
            )
            beat_stability_score = _derive_stability(beat_list, raw_beat_interval, 1.0)
            downbeat_stability_score = _derive_stability(downbeat_list, raw_beat_interval, 4.0)
            quality_score = (
                beat_coverage_score * 0.4
                + beat_stability_score * 0.35
                + downbeat_coverage_score * 0.1
                + downbeat_stability_score * 0.15
            )

            _emit(
                {
                    "type": "result",
                    "requestId": request_id,
                    "result": {
                        "bpm": bpm,
                        "firstBeatMs": corrected_first_beat_ms,
                        "rawFirstBeatMs": raw_first_beat_ms,
                        "barBeatOffset": _derive_bar_beat_offset(beat_list, downbeat_list),
                        "beatCount": len(beat_list),
                        "downbeatCount": len(downbeat_list),
                        "durationSec": duration_sec,
                        "beatIntervalSec": beat_interval,
                        "beatCoverageScore": beat_coverage_score,
                        "beatStabilityScore": beat_stability_score,
                        "downbeatCoverageScore": downbeat_coverage_score,
                        "downbeatStabilityScore": downbeat_stability_score,
                        "qualityScore": quality_score,
                        "anchorCorrectionMs": anchor_correction_ms,
                        "anchorConfidenceScore": anchor_confidence_score,
                        "anchorMatchedBeatCount": anchor_matched_beat_count,
                        "anchorStrategy": "legacy" if use_legacy_anchor_strategy else "refined",
                    },
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
