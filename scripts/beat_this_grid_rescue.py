import math
import statistics
from typing import Any

import numpy as np

from beat_this_grid_solver import (
    build_attack_envelope,
    clamp01,
    moving_average,
    normalize_phase_ms,
    phase_delta_ms,
    should_preserve_grid_solver_bpm,
    stabilize_bpm_for_grid,
    weighted_mad,
)


def _score_grid_phase(
    score_envelope: np.ndarray,
    beat_interval_samples: float,
    first_beat_samples: float,
    max_beats: int,
) -> tuple[float, int]:
    if score_envelope.size == 0 or not math.isfinite(beat_interval_samples) or beat_interval_samples <= 0.0:
        return 0.0, 0
    samples: list[int] = []
    position = float(first_beat_samples)
    while len(samples) < max_beats and position < float(score_envelope.size):
        rounded = int(round(position))
        if 0 <= rounded < score_envelope.size:
            samples.append(rounded)
        position += beat_interval_samples
    if not samples:
        return 0.0, 0
    return float(np.sum(score_envelope[samples]) / len(samples)), len(samples)


def _weighted_mode_int(values: list[int], weights: list[float], modulo: int) -> int:
    if modulo <= 0 or not values or len(values) != len(weights):
        return 0
    score_map: dict[int, float] = {}
    for value, weight in zip(values, weights):
        normalized = int(value) % modulo
        score_map[normalized] = score_map.get(normalized, 0.0) + float(weight)
    if not score_map:
        return 0
    return max(score_map.items(), key=lambda item: item[1])[0]


def window_weight(item: dict[str, Any]) -> float:
    quality = clamp01(float(item.get("qualityScore") or 0.0))
    anchor_confidence = clamp01(float(item.get("anchorConfidenceScore") or 0.0))
    beat_factor = clamp01(float(item.get("beatCount") or 0.0) / 64.0)
    downbeat_factor = clamp01(float(item.get("downbeatCount") or 0.0) / 16.0)
    base = 0.45 + anchor_confidence * 0.2 + beat_factor * 0.2 + downbeat_factor * 0.15
    return max(0.001, quality * base)


def _result_raw_bpm(item: dict[str, Any]) -> float:
    try:
        bpm = float(item.get("rawBpm") or item.get("bpm") or 0.0)
    except Exception:
        return 0.0
    return bpm if math.isfinite(bpm) and bpm > 0.0 else 0.0


def _compatible_bpm_results(
    window_results: list[dict[str, Any]],
    reference_bpm: float,
) -> list[dict[str, Any]]:
    if not math.isfinite(reference_bpm) or reference_bpm <= 0.0:
        return []
    bpm_tolerance = max(0.35, reference_bpm * 0.0025)
    return [
        item
        for item in window_results
        if _result_raw_bpm(item) > 0.0 and abs(_result_raw_bpm(item) - reference_bpm) <= bpm_tolerance
    ]


def _score_integer_bpm_candidate(
    score_envelope: np.ndarray,
    envelope_sample_rate: int,
    bpm: float,
    anchor_ms: float,
    max_beats: int,
) -> tuple[float, int]:
    if (
        score_envelope.size == 0
        or envelope_sample_rate <= 0
        or not math.isfinite(bpm)
        or bpm <= 0.0
        or not math.isfinite(anchor_ms)
        or max_beats <= 0
    ):
        return 0.0, 0

    beat_interval_ms = 60000.0 / bpm
    beat_interval_samples = (beat_interval_ms / 1000.0) * envelope_sample_rate
    if beat_interval_samples <= 0.0:
        return 0.0, 0

    best_score = 0.0
    best_support = 0
    for phase_shift_ms in range(-30, 31, 2):
        first_beat_ms = anchor_ms + float(phase_shift_ms)
        while first_beat_ms >= beat_interval_ms:
            first_beat_ms -= beat_interval_ms
        if first_beat_ms < 0.0:
            first_beat_ms += math.ceil(abs(first_beat_ms) / beat_interval_ms) * beat_interval_ms

        position = (first_beat_ms / 1000.0) * envelope_sample_rate
        values: list[float] = []
        while len(values) < max_beats and position < float(score_envelope.size):
            rounded = int(round(position))
            if 0 <= rounded < score_envelope.size:
                values.append(float(score_envelope[rounded]))
            position += beat_interval_samples

        if len(values) < 64:
            continue
        ordered_values = sorted(values)
        lower_quarter = ordered_values[: max(1, len(ordered_values) // 4)]
        score = statistics.fmean(values) * 0.75 + statistics.fmean(lower_quarter) * 0.25
        if score > best_score:
            best_score = score
            best_support = len(values)

    return best_score, best_support


def apply_integer_bpm_rescue_to_result(
    signal: np.ndarray,
    sample_rate: int,
    window_results: list[dict[str, Any]],
    result: dict[str, Any],
    tuning: dict[str, Any],
) -> dict[str, Any]:
    if signal.size == 0 or sample_rate <= 0:
        return result

    raw_bpm = _result_raw_bpm(result)
    if not math.isfinite(raw_bpm) or raw_bpm <= 0.0:
        return result

    nearest_integer = round(raw_bpm)
    integer_delta = abs(raw_bpm - nearest_integer)
    snap_threshold = float(tuning["bpmSnapIntegerThreshold"])
    if integer_delta > 0.25:
        return result

    current_bpm = float(result.get("bpm") or raw_bpm)
    if abs(current_bpm - nearest_integer) <= 0.000001:
        return result

    compatible_results = _compatible_bpm_results(window_results, raw_bpm)
    integer_aligned_results = [
        item
        for item in compatible_results
        if abs(_result_raw_bpm(item) - nearest_integer) <= snap_threshold
        or abs(float(item.get("bpm") or 0.0) - nearest_integer) <= 0.000001
    ]

    absolute_first_beat_ms = result.get("absoluteFirstBeatMs")
    if absolute_first_beat_ms is not None:
        try:
            absolute_first_beat_ms = float(absolute_first_beat_ms)
        except Exception:
            absolute_first_beat_ms = None
    if not isinstance(absolute_first_beat_ms, float) or not math.isfinite(absolute_first_beat_ms):
        absolute_first_beat_ms = float(result.get("firstBeatMs") or 0.0)

    attack_result = build_attack_envelope(signal, sample_rate, tuning)
    if attack_result is None:
        return result
    attack_envelope, envelope_sample_rate = attack_result
    score_window = max(1, int(round(envelope_sample_rate * (float(tuning["scoreWindowMs"]) / 1000.0))))
    score_envelope = moving_average(attack_envelope, score_window)
    max_beats = max(128, int(tuning["maxBeats"]) * 4)
    raw_score, raw_support = _score_integer_bpm_candidate(
        score_envelope,
        envelope_sample_rate,
        raw_bpm,
        absolute_first_beat_ms,
        max_beats,
    )
    integer_score, integer_support = _score_integer_bpm_candidate(
        score_envelope,
        envelope_sample_rate,
        float(nearest_integer),
        absolute_first_beat_ms,
        max_beats,
    )
    if raw_support < 64 or integer_support < 64:
        return result
    score_gain = (integer_score - raw_score) / max(1e-9, integer_score, raw_score)
    has_window_support = len(integer_aligned_results) >= 2
    required_score_gain = 0.08 if has_window_support else 0.12
    if score_gain < required_score_gain or integer_score - raw_score < 0.01:
        return result

    bpm = float(nearest_integer)
    beat_interval_ms = 60000.0 / bpm
    if not math.isfinite(beat_interval_ms) or beat_interval_ms <= 0.0:
        return result

    next_result = dict(result)
    next_result["bpm"] = round(bpm, 6)
    next_result["beatIntervalSec"] = round(60.0 / bpm, 6)
    next_result["bpmRefinementStrategy"] = "integer-envelope-rescue"
    next_result["bpmRefinementScoreGain"] = round(score_gain, 6)
    return next_result


def apply_half_double_bpm_rescue_to_result(
    signal: np.ndarray,
    sample_rate: int,
    window_results: list[dict[str, Any]],
    result: dict[str, Any],
    tuning: dict[str, Any],
) -> dict[str, Any]:
    if signal.size == 0 or sample_rate <= 0:
        return result

    current_bpm = float(result.get("bpm") or _result_raw_bpm(result))
    if not math.isfinite(current_bpm) or current_bpm <= 0.0:
        return result

    candidates: list[tuple[str, float]] = []
    if 55.0 <= current_bpm <= 95.0:
        doubled_bpm = current_bpm * 2.0
        nearest_integer = round(doubled_bpm)
        candidate_bpm = (
            float(nearest_integer)
            if abs(doubled_bpm - nearest_integer) <= max(0.18, float(tuning["bpmSnapIntegerThreshold"]) * 6.0)
            else doubled_bpm
        )
        candidates.append(("double", candidate_bpm))
    if 180.0 <= current_bpm <= 260.0:
        halved_bpm = current_bpm / 2.0
        nearest_integer = round(halved_bpm)
        candidate_bpm = (
            float(nearest_integer)
            if abs(halved_bpm - nearest_integer) <= max(0.18, float(tuning["bpmSnapIntegerThreshold"]) * 6.0)
            else halved_bpm
        )
        candidates.append(("half", candidate_bpm))
    if not candidates:
        return result

    absolute_first_beat_ms = result.get("absoluteFirstBeatMs")
    if absolute_first_beat_ms is not None:
        try:
            absolute_first_beat_ms = float(absolute_first_beat_ms)
        except Exception:
            absolute_first_beat_ms = None
    if not isinstance(absolute_first_beat_ms, float) or not math.isfinite(absolute_first_beat_ms):
        absolute_first_beat_ms = float(result.get("firstBeatMs") or 0.0)

    attack_result = build_attack_envelope(signal, sample_rate, tuning)
    if attack_result is None:
        return result
    attack_envelope, envelope_sample_rate = attack_result
    score_window = max(1, int(round(envelope_sample_rate * (float(tuning["scoreWindowMs"]) / 1000.0))))
    score_envelope = moving_average(attack_envelope, score_window)
    max_beats = max(128, int(tuning["maxBeats"]) * 4)
    current_score, current_support = _score_integer_bpm_candidate(
        score_envelope,
        envelope_sample_rate,
        current_bpm,
        absolute_first_beat_ms,
        max_beats,
    )
    if current_support < 64:
        return result

    best_result: dict[str, Any] | None = None
    best_score_gain = 0.0
    for strategy, candidate_bpm in candidates:
        if not math.isfinite(candidate_bpm) or candidate_bpm <= 0.0:
            continue
        tolerance = max(0.35, candidate_bpm * 0.0025)
        direct_support = [
            item
            for item in window_results
            if abs(_result_raw_bpm(item) - candidate_bpm) <= tolerance
        ]
        related_support = [
            item
            for item in window_results
            if min(
                abs(_result_raw_bpm(item) - candidate_bpm),
                abs(_result_raw_bpm(item) * 2.0 - candidate_bpm),
                abs((_result_raw_bpm(item) / 2.0) - candidate_bpm),
            )
            <= tolerance
        ]
        if len(direct_support) < 2 or len(related_support) < 2:
            continue
        candidate_score, candidate_support = _score_integer_bpm_candidate(
            score_envelope,
            envelope_sample_rate,
            candidate_bpm,
            absolute_first_beat_ms,
            max_beats,
        )
        if candidate_support < 64:
            continue
        score_gain = (candidate_score - current_score) / max(1e-9, candidate_score, current_score)
        if score_gain < 0.12 or candidate_score - current_score < 0.01:
            continue
        next_result = dict(result)
        next_result["bpm"] = round(candidate_bpm, 6)
        next_result["beatIntervalSec"] = round(60.0 / candidate_bpm, 6)
        next_result["bpmRefinementStrategy"] = f"{strategy}-bpm-envelope-rescue"
        next_result["bpmRefinementScoreGain"] = round(score_gain, 6)
        next_result["bpmRefinementWindowSupport"] = len(related_support)
        if best_result is None or score_gain > best_score_gain:
            best_result = next_result
            best_score_gain = score_gain

    return best_result if best_result is not None else result


def solve_global_track_grid(
    signal: np.ndarray,
    sample_rate: int,
    duration_sec: float,
    window_results: list[dict[str, Any]],
    tuning: dict[str, Any],
    anchor_window: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if signal.size == 0 or sample_rate <= 0:
        return None
    valid_results = [
        item
        for item in window_results
        if math.isfinite(float(item.get("bpm") or 0.0))
        and float(item.get("bpm") or 0.0) > 0.0
        and math.isfinite(float(item.get("firstBeatMs") or 0.0))
        and float(item.get("firstBeatMs") or 0.0) >= 0.0
    ]
    if not valid_results:
        return None

    best_window = max(
        valid_results,
        key=lambda item: (
            float(item.get("qualityScore") or 0.0),
            int(item.get("beatCount") or 0),
            int(item.get("downbeatCount") or 0),
        ),
    )
    reference_window = anchor_window if anchor_window in valid_results else best_window
    if len(valid_results) == 1:
        return dict(reference_window)

    reference_bpm = _result_raw_bpm(reference_window)
    compatible_results = _compatible_bpm_results(valid_results, reference_bpm)
    if len(compatible_results) < 2:
        return dict(reference_window)
    valid_results = compatible_results

    weights = [window_weight(item) for item in valid_results]
    raw_bpm = float(reference_window.get("rawBpm") or reference_window.get("bpm") or 0.0)
    if not math.isfinite(raw_bpm) or raw_bpm <= 0.0:
        return dict(reference_window)

    bpm = float(reference_window.get("bpm") or 0.0)
    if not math.isfinite(bpm) or bpm <= 0.0:
        bpm = stabilize_bpm_for_grid(raw_bpm, tuning)
        if should_preserve_grid_solver_bpm(raw_bpm, bpm):
            bpm = round(raw_bpm, 6)
    beat_interval_ms = 60000.0 / bpm if bpm > 0 else 0.0
    if not math.isfinite(beat_interval_ms) or beat_interval_ms <= 0.0:
        return dict(reference_window)
    reference_first_beat_ms = normalize_phase_ms(
        float(reference_window.get("firstBeatMs") or 0.0),
        beat_interval_ms,
    )
    reference_raw_first_beat_ms = normalize_phase_ms(
        float(reference_window.get("rawFirstBeatMs") or reference_first_beat_ms),
        beat_interval_ms,
    )

    attack_result = build_attack_envelope(signal, sample_rate, tuning)
    if attack_result is None:
        return dict(reference_window)
    attack_envelope, envelope_sample_rate = attack_result
    score_window = max(1, int(round(envelope_sample_rate * (float(tuning["scoreWindowMs"]) / 1000.0))))
    score_envelope = moving_average(attack_envelope, score_window)
    beat_interval_samples = (60.0 / bpm) * envelope_sample_rate if bpm > 0 else 0.0
    if beat_interval_samples <= 0.0:
        return dict(reference_window)

    center_first_beat_samples = (reference_first_beat_ms / 1000.0) * envelope_sample_rate
    evaluation_beats = max(96, int(tuning["maxBeats"]) * 3)
    base_score, beat_support = _score_grid_phase(
        score_envelope,
        beat_interval_samples,
        center_first_beat_samples,
        evaluation_beats,
    )
    if beat_support < 16:
        return dict(reference_window)

    search_radius_ms = min(float(tuning["gridSolverMaxCorrectionMs"]), 18.0)
    search_radius_samples = max(1, int(round((search_radius_ms / 1000.0) * envelope_sample_rate)))
    step_samples = max(1, int(round((float(tuning["stepMs"]) / 1000.0) * envelope_sample_rate)))
    best_score = base_score
    best_offset_samples = 0
    second_best_score = base_score
    for offset_samples in range(-search_radius_samples, search_radius_samples + 1, step_samples):
        score_value, support = _score_grid_phase(
            score_envelope,
            beat_interval_samples,
            center_first_beat_samples + offset_samples,
            evaluation_beats,
        )
        if support < 16:
            continue
        if score_value > best_score:
            second_best_score = best_score
            best_score = score_value
            best_offset_samples = offset_samples
        elif score_value > second_best_score:
            second_best_score = score_value

    phase_samples = np.asarray(
        [
            phase_delta_ms(float(item["firstBeatMs"]), reference_first_beat_ms, beat_interval_ms)
            for item in valid_results
        ],
        dtype="float64",
    )
    phase_mad_value = weighted_mad(phase_samples, np.asarray(weights, dtype="float64"), 0.0)
    phase_mad_ms = float(phase_mad_value) if phase_mad_value is not None else 999.0
    shift_ms = (best_offset_samples / envelope_sample_rate) * 1000.0
    relative_gain = (best_score - base_score) / max(1e-9, best_score, base_score)
    score_contrast = (best_score - second_best_score) / max(1e-9, best_score)
    if (
        abs(shift_ms) < 4.0
        or abs(shift_ms) > search_radius_ms
        or relative_gain < 0.01
        or score_contrast < 0.005
        or phase_mad_ms > 12.0
    ):
        return dict(reference_window)

    first_beat_ms = round(normalize_phase_ms(reference_first_beat_ms + shift_ms, beat_interval_ms), 3)
    raw_first_beat_ms = round(reference_raw_first_beat_ms, 3)
    reference_absolute_first_beat_ms = float(
        reference_window.get("absoluteFirstBeatMs") or reference_first_beat_ms
    )
    reference_absolute_raw_first_beat_ms = float(
        reference_window.get("absoluteRawFirstBeatMs") or reference_absolute_first_beat_ms
    )
    absolute_first_beat_ms = reference_absolute_first_beat_ms + shift_ms
    absolute_raw_first_beat_ms = reference_absolute_raw_first_beat_ms
    if beat_interval_ms > 0.0 and beat_interval_ms - first_beat_ms <= float(tuning["snapToZeroCorrectedMaxMs"]):
        first_beat_ms = 0.0
    if beat_interval_ms > 0.0 and beat_interval_ms - raw_first_beat_ms <= float(tuning["snapToZeroRawFirstBeatMaxMs"]):
        raw_first_beat_ms = 0.0
    anchor_correction_ms = round(first_beat_ms - raw_first_beat_ms, 3)
    anchor_confidence_score = round(
        clamp01(
            clamp01(relative_gain / 0.03) * 0.55
            + clamp01(score_contrast / 0.015) * 0.2
            + clamp01((12.0 - phase_mad_ms) / 8.0) * 0.25
        ),
        6,
    )
    if anchor_confidence_score < 0.95:
        return dict(reference_window)
    anchor_matched_beat_count = int(
        sum(int(item.get("anchorMatchedBeatCount") or 0) for item in valid_results)
    )

    bar_beat_offset = _weighted_mode_int(
        [int(item.get("barBeatOffset") or 0) for item in valid_results],
        weights,
        32,
    )

    beat_count = max(int(item.get("beatCount") or 0) for item in valid_results)
    downbeat_count = max(int(item.get("downbeatCount") or 0) for item in valid_results)
    total_weight = max(0.001, sum(weights))
    beat_coverage_score = round(
        sum(float(item.get("beatCoverageScore") or 0.0) * weight for item, weight in zip(valid_results, weights))
        / total_weight,
        6,
    )
    beat_stability_score = round(
        sum(float(item.get("beatStabilityScore") or 0.0) * weight for item, weight in zip(valid_results, weights))
        / total_weight,
        6,
    )
    downbeat_coverage_score = round(
        sum(
            float(item.get("downbeatCoverageScore") or 0.0) * weight
            for item, weight in zip(valid_results, weights)
        )
        / total_weight,
        6,
    )
    downbeat_stability_score = round(
        sum(
            float(item.get("downbeatStabilityScore") or 0.0) * weight
            for item, weight in zip(valid_results, weights)
        )
        / total_weight,
        6,
    )
    quality_score = round(
        sum(float(item.get("qualityScore") or 0.0) * weight for item, weight in zip(valid_results, weights))
        / total_weight,
        6,
    )

    return {
        "bpm": round(bpm, 6),
        "rawBpm": round(raw_bpm, 6),
        "firstBeatMs": first_beat_ms,
        "rawFirstBeatMs": raw_first_beat_ms,
        "absoluteFirstBeatMs": round(absolute_first_beat_ms, 3),
        "absoluteRawFirstBeatMs": round(absolute_raw_first_beat_ms, 3),
        "barBeatOffset": bar_beat_offset,
        "beatCount": beat_count,
        "downbeatCount": downbeat_count,
        "durationSec": round(float(duration_sec), 3),
        "beatIntervalSec": round(60.0 / bpm, 6),
        "beatCoverageScore": beat_coverage_score,
        "beatStabilityScore": beat_stability_score,
        "downbeatCoverageScore": downbeat_coverage_score,
        "downbeatStabilityScore": downbeat_stability_score,
        "qualityScore": quality_score,
        "anchorCorrectionMs": anchor_correction_ms,
        "anchorConfidenceScore": anchor_confidence_score,
        "anchorMatchedBeatCount": anchor_matched_beat_count,
        "anchorStrategy": "global-grid-solver",
        "windowIndex": int(reference_window.get("windowIndex") or 0),
        "windowStartSec": round(float(reference_window.get("windowStartSec") or 0.0), 3),
        "windowDurationSec": round(float(reference_window.get("windowDurationSec") or 0.0), 3),
    }
