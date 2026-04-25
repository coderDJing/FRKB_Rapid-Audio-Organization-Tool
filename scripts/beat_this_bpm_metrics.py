import math

import numpy as np


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, value))


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
    index = int(np.searchsorted(cumulative, total_weight * 0.5, side="left"))
    index = min(max(index, 0), sorted_values.size - 1)
    value = float(sorted_values[index])
    return value if math.isfinite(value) else None


def _weighted_mad(values: np.ndarray, weights: np.ndarray, center_value: float) -> float | None:
    if values.size == 0 or weights.size == 0 or values.size != weights.size:
        return None
    if not math.isfinite(center_value):
        return None
    return _weighted_median(np.abs(values - center_value), weights)


def _window_weight(item: dict) -> float:
    quality = _clamp01(float(item.get("qualityScore") or 0.0))
    anchor_confidence = _clamp01(float(item.get("anchorConfidenceScore") or 0.0))
    beat_factor = _clamp01(float(item.get("beatCount") or 0.0) / 64.0)
    downbeat_factor = _clamp01(float(item.get("downbeatCount") or 0.0) / 16.0)
    base = 0.45 + anchor_confidence * 0.2 + beat_factor * 0.2 + downbeat_factor * 0.15
    return max(0.001, quality * base)


def _result_raw_bpm(item: dict) -> float:
    try:
        bpm = float(item.get("rawBpm") or item.get("bpm") or 0.0)
    except Exception:
        return 0.0
    return bpm if math.isfinite(bpm) and bpm > 0.0 else 0.0


def estimate_bpm_drift_proxy(
    window_results: list[dict],
    reference_result: dict,
) -> dict:
    reference_bpm = _result_raw_bpm(reference_result)
    if not math.isfinite(reference_bpm) or reference_bpm <= 0.0:
        return {}

    valid_results = [item for item in window_results if _result_raw_bpm(item) > 0.0]
    if not valid_results:
        return {}

    bpm_values = np.asarray(
        [_result_raw_bpm(item) for item in valid_results],
        dtype="float64",
    )
    weights = np.asarray([_window_weight(item) for item in valid_results], dtype="float64")
    if bpm_values.size < 2:
        return {
            "beatThisWindowCount": int(bpm_values.size),
        }

    bpm_mad = _weighted_mad(bpm_values, weights, reference_bpm)
    if bpm_mad is None or not math.isfinite(float(bpm_mad)):
        return {
            "beatThisWindowCount": int(bpm_values.size),
        }

    bpm_mad_value = abs(float(bpm_mad))
    beat_interval_ms = 60000.0 / reference_bpm
    interval_error_ms = 0.0
    lower_bpm = reference_bpm - bpm_mad_value
    upper_bpm = reference_bpm + bpm_mad_value
    if lower_bpm > 0.0:
        interval_error_ms = max(interval_error_ms, abs((60000.0 / lower_bpm) - beat_interval_ms))
    if upper_bpm > 0.0:
        interval_error_ms = max(interval_error_ms, abs((60000.0 / upper_bpm) - beat_interval_ms))

    return {
        "beatThisEstimatedDrift128Ms": round(interval_error_ms * 128.0, 3),
        "beatThisWindowCount": int(bpm_values.size),
    }
