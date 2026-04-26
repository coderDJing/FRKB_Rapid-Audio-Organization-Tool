import math
import statistics
from typing import Any

import numpy as np
import soxr


def clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, value))


def stabilize_bpm_for_grid(bpm: float, tuning: dict[str, Any]) -> float:
    if not math.isfinite(bpm) or bpm <= 0.0:
        return bpm
    snapped_bpm = float(bpm)
    nearest_integer = round(snapped_bpm)
    if abs(snapped_bpm - nearest_integer) <= float(tuning["bpmSnapIntegerThreshold"]):
        snapped_bpm = float(nearest_integer)
    return round(snapped_bpm, 6)


def should_preserve_grid_solver_bpm(raw_bpm: float, snapped_bpm: float) -> bool:
    if not math.isfinite(raw_bpm) or raw_bpm <= 0.0:
        return False
    nearest_integer = round(raw_bpm)
    return abs(raw_bpm - nearest_integer) > 0.012 and abs(snapped_bpm - nearest_integer) <= 0.000001


def mix_to_mono(signal: np.ndarray) -> np.ndarray:
    if signal.ndim == 1:
        return signal.astype("float64", copy=False)
    if signal.ndim == 2:
        return signal.mean(axis=1).astype("float64", copy=False)
    raise RuntimeError(f"expected mono/stereo signal, got shape {signal.shape}")


def moving_average(values: np.ndarray, window_size: int) -> np.ndarray:
    if window_size <= 1 or values.size <= 1:
        return values.astype("float64", copy=False)
    kernel = np.ones(window_size, dtype="float64") / float(window_size)
    return np.convolve(values, kernel, mode="same")


def weighted_median(values: np.ndarray, weights: np.ndarray) -> float | None:
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


def weighted_mad(values: np.ndarray, weights: np.ndarray, center_value: float | None = None) -> float | None:
    if values.size == 0 or weights.size == 0 or values.size != weights.size:
        return None
    center = center_value if center_value is not None else weighted_median(values, weights)
    if center is None or not math.isfinite(center):
        return None
    deviations = np.abs(values - center)
    return weighted_median(deviations, weights)


def backtrack_peak_to_attack_start(
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


def build_attack_envelope(
    signal: np.ndarray,
    sample_rate: int,
    tuning: dict[str, Any],
) -> tuple[np.ndarray, int] | None:
    if sample_rate <= 0:
        return None
    mono = mix_to_mono(signal)
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

    fast_env = moving_average(abs_signal, fast_window)
    slow_env = moving_average(abs_signal, slow_window)
    attack_env = np.maximum(0.0, fast_env - slow_env)
    attack_env = moving_average(attack_env, smooth_window)

    peak_value = float(np.max(attack_env)) if attack_env.size else 0.0
    if not math.isfinite(peak_value) or peak_value <= 1e-9:
        return None
    return attack_env / peak_value, envelope_sample_rate


def score_anchor_offset(
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


def estimate_anchor_correction(
    signal: np.ndarray,
    sample_rate: int,
    beats: list[float],
    beat_interval: float,
    tuning: dict[str, Any],
) -> tuple[float, float, int]:
    if len(beats) < 8 or sample_rate <= 0 or not math.isfinite(beat_interval) or beat_interval <= 0.0:
        return 0.0, 0.0, 0

    raw_first_beat_ms = float(beats[0]) * 1000.0 if beats else 0.0
    attack_result = build_attack_envelope(signal, sample_rate, tuning)
    if attack_result is None:
        return 0.0, 0.0, 0
    attack_envelope, envelope_sample_rate = attack_result
    if attack_envelope.size < 64:
        return 0.0, 0.0, 0

    score_window = max(1, int(round(envelope_sample_rate * (float(tuning["scoreWindowMs"]) / 1000.0))))
    score_envelope = moving_average(attack_envelope, score_window)

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
        [score_anchor_offset(score_envelope, beat_samples, int(offset)) for offset in offsets],
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
    second_best_score = float(np.max(scores[candidate_mask])) if np.any(candidate_mask) else zero_score

    relative_gain = (best_score - zero_score) / max(1e-9, best_score, zero_score)
    score_contrast = (best_score - second_best_score) / max(1e-9, best_score)
    confidence = clamp01(relative_gain / float(tuning["relativeGainScale"])) * 0.65 + clamp01(
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
        local_attack_index = backtrack_peak_to_attack_start(local_window, local_peak_index, tuning)
        refined_offsets.append(float(start + local_attack_index - int(beat_sample)))
        refined_weights.append(local_peak_value)

    matched_count = len(refined_offsets)
    if matched_count == 0:
        return 0.0, confidence, 0

    refined_offsets_array = np.asarray(refined_offsets, dtype="float64")
    refined_weights_array = np.asarray(refined_weights, dtype="float64")
    refined_offset_value = weighted_median(refined_offsets_array, refined_weights_array)
    final_offset_samples = (
        int(round(refined_offset_value)) if refined_offset_value is not None else best_offset_samples
    )
    final_offset_samples = max(-max_shift_samples, min(max_shift_samples, final_offset_samples))

    match_ratio = matched_count / max(1, beat_samples.size)
    offset_mad_samples = weighted_mad(
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
        + clamp01((match_ratio - float(tuning["matchRatioCenter"])) / float(tuning["matchRatioScale"])) * 0.30
        + clamp01(
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

    return applied_offset_ms, confidence, matched_count


def estimate_grid_phase_correction(
    signal: np.ndarray,
    sample_rate: int,
    beats: list[float],
    beat_interval: float,
    anchor_correction_ms: float,
    tuning: dict[str, Any],
) -> tuple[float, float, int] | None:
    if len(beats) < 8 or sample_rate <= 0 or not math.isfinite(beat_interval) or beat_interval <= 0.0:
        return None
    if str(tuning["gridSolverPolicy"]) != "conservative":
        return None

    raw_first_beat_ms = float(beats[0]) * 1000.0
    if raw_first_beat_ms < float(tuning["gridSolverMinRawFirstBeatMs"]):
        return None
    if anchor_correction_ms >= float(tuning["gridSolverMaxAnchorCorrectionMs"]):
        return None

    attack_result = build_attack_envelope(signal, sample_rate, tuning)
    if attack_result is None:
        return None
    attack_envelope, envelope_sample_rate = attack_result
    if attack_envelope.size < 64:
        return None

    score_window = max(1, int(round(envelope_sample_rate * (float(tuning["scoreWindowMs"]) / 1000.0))))
    score_envelope = moving_average(attack_envelope, score_window)
    max_shift_sec = min(
        float(tuning["maxShiftSecCap"]),
        max(float(tuning["maxShiftSecFloor"]), beat_interval * float(tuning["maxShiftIntervalRatio"])),
    )
    max_shift_samples = max(1, int(round(max_shift_sec * envelope_sample_rate)))
    step_samples = max(1, int(round(envelope_sample_rate * (float(tuning["stepMs"]) / 1000.0))))

    beat_array = np.asarray(beats, dtype="float64")
    beat_array = beat_array[np.isfinite(beat_array)]
    if beat_array.size < 8:
        return None
    beat_samples = np.rint(beat_array * envelope_sample_rate).astype(np.int64, copy=False)
    if beat_samples.size > int(tuning["maxBeats"]):
        sample_stride = max(1, int(math.ceil(beat_samples.size / float(tuning["maxBeats"]))))
        beat_samples = beat_samples[::sample_stride]
    if beat_samples.size < 8:
        return None

    offsets = np.arange(-max_shift_samples, max_shift_samples + 1, step_samples, dtype=np.int64)
    if offsets.size == 0:
        return None
    scores = np.asarray(
        [score_anchor_offset(score_envelope, beat_samples, int(offset)) for offset in offsets],
        dtype="float64",
    )
    if scores.size == 0 or not np.any(np.isfinite(scores)):
        return None

    best_index = int(np.nanargmax(scores))
    best_offset_samples = int(offsets[best_index])
    best_score = float(scores[best_index])
    zero_index = int(np.argmin(np.abs(offsets)))
    zero_score = float(scores[zero_index])
    separation_samples = max(step_samples * 2, int(round(envelope_sample_rate * 0.005)))
    candidate_mask = np.abs(offsets - best_offset_samples) > separation_samples
    second_best_score = float(np.max(scores[candidate_mask])) if np.any(candidate_mask) else zero_score

    relative_gain = (best_score - zero_score) / max(1e-9, best_score, zero_score)
    score_contrast = (best_score - second_best_score) / max(1e-9, best_score)
    correction_ms = (best_offset_samples / envelope_sample_rate) * 1000.0
    if (
        correction_ms < float(tuning["gridSolverMinCorrectionMs"])
        or correction_ms > float(tuning["gridSolverMaxCorrectionMs"])
        or correction_ms - anchor_correction_ms < float(tuning["gridSolverMinCorrectionGainMs"])
        or relative_gain < float(tuning["gridSolverMinRelativeGain"])
        or score_contrast < float(tuning["gridSolverMinScoreContrast"])
    ):
        return None

    confidence = clamp01(relative_gain / float(tuning["gridSolverMinRelativeGain"])) * 0.55
    confidence += clamp01(score_contrast / float(tuning["gridSolverMinScoreContrast"])) * 0.45
    return correction_ms, clamp01(confidence), int(beat_samples.size)


def should_block_ambiguous_positive_correction(
    signal: np.ndarray,
    sample_rate: int,
    beats: list[float],
    beat_interval: float,
    raw_first_beat_ms: float,
    anchor_correction_ms: float,
    tuning: dict[str, Any],
) -> bool:
    if (
        sample_rate <= 0
        or len(beats) < 8
        or not math.isfinite(beat_interval)
        or beat_interval <= 0.0
        or not math.isfinite(raw_first_beat_ms)
        or raw_first_beat_ms < float(tuning["positiveAmbiguityGuardRawFirstBeatMinMs"])
        or not math.isfinite(anchor_correction_ms)
        or anchor_correction_ms < float(tuning["positiveAmbiguityGuardMinCorrectionMs"])
    ):
        return False

    attack_result = build_attack_envelope(signal, sample_rate, tuning)
    if attack_result is None:
        return False
    attack_envelope, envelope_sample_rate = attack_result
    if attack_envelope.size < 64:
        return False

    score_window = max(1, int(round(envelope_sample_rate * (float(tuning["scoreWindowMs"]) / 1000.0))))
    score_envelope = moving_average(attack_envelope, score_window)
    beat_array = np.asarray(beats, dtype="float64")
    beat_array = beat_array[np.isfinite(beat_array)]
    if beat_array.size < 8:
        return False
    beat_samples = np.rint(beat_array * envelope_sample_rate).astype(np.int64, copy=False)
    if beat_samples.size > int(tuning["maxBeats"]):
        sample_stride = max(1, int(math.ceil(beat_samples.size / float(tuning["maxBeats"]))))
        beat_samples = beat_samples[::sample_stride]
    if beat_samples.size < 8:
        return False

    max_shift_sec = min(
        float(tuning["maxShiftSecCap"]),
        max(float(tuning["maxShiftSecFloor"]), beat_interval * float(tuning["maxShiftIntervalRatio"])),
    )
    max_shift_samples = max(1, int(round(max_shift_sec * envelope_sample_rate)))
    step_samples = max(1, int(round(envelope_sample_rate * (float(tuning["stepMs"]) / 1000.0))))
    local_scores = np.asarray(
        [
            score_anchor_offset(score_envelope, beat_samples, int(offset))
            for offset in range(-max_shift_samples, max_shift_samples + 1, step_samples)
        ],
        dtype="float64",
    )
    local_offsets = np.arange(-max_shift_samples, max_shift_samples + 1, step_samples, dtype=np.int64)
    if local_scores.size == 0 or not np.any(np.isfinite(local_scores)):
        return False
    local_best_index = int(np.nanargmax(local_scores))
    local_best_offset_ms = (int(local_offsets[local_best_index]) / envelope_sample_rate) * 1000.0
    local_best_score = float(local_scores[local_best_index])

    wide_step_ms = 5.0
    wide_limit_ms = 120.0
    wide_offsets_ms = range(-int(wide_limit_ms), int(wide_limit_ms) + 1, int(wide_step_ms))
    wide_scores: list[tuple[float, float]] = []
    for offset_ms in wide_offsets_ms:
        offset_samples = int(round((float(offset_ms) / 1000.0) * envelope_sample_rate))
        wide_scores.append(
            (float(offset_ms), score_anchor_offset(score_envelope, beat_samples, offset_samples))
        )
    wide_best_offset_ms, wide_best_score = max(wide_scores, key=lambda item: item[1])
    return (
        wide_best_offset_ms - local_best_offset_ms >= float(tuning["positiveAmbiguityGuardWideLeadMs"])
        and wide_best_score >= local_best_score * float(tuning["positiveAmbiguityGuardWideScoreRatioMin"])
    )


def estimate_lowband_firstbeat_offset(
    signal: np.ndarray,
    sample_rate: int,
    beats: list[float],
    tuning: dict[str, Any],
    max_beats: int = 24,
) -> dict[str, float] | None:
    if sample_rate <= 0 or len(beats) < 8:
        return None
    mono = mix_to_mono(signal)
    low_sample_rate = 300
    low = soxr.resample(mono, in_rate=sample_rate, out_rate=low_sample_rate)
    if low.size < 64:
        return None

    abs_signal = np.abs(low.astype("float64", copy=False))
    fast_env = moving_average(abs_signal, max(1, int(round(low_sample_rate * 0.010))))
    slow_env = moving_average(abs_signal, max(2, int(round(low_sample_rate * 0.080))))
    attack_env = np.maximum(0.0, fast_env - slow_env)
    attack_env = moving_average(attack_env, max(1, int(round(low_sample_rate * 0.004))))
    peak_value = float(np.max(attack_env)) if attack_env.size else 0.0
    if peak_value <= 1e-9:
        return None
    attack_env = attack_env / peak_value

    beat_array = np.asarray(beats[:max_beats], dtype="float64")
    beat_array = beat_array[np.isfinite(beat_array)]
    if beat_array.size < 8:
        return None

    offsets_ms: list[float] = []
    weights: list[float] = []
    for beat_sec in beat_array:
        beat_index = int(round(float(beat_sec) * low_sample_rate))
        start_index = max(0, beat_index - int(round(0.12 * low_sample_rate)))
        end_index = min(len(attack_env), beat_index + int(round(0.04 * low_sample_rate)))
        if end_index - start_index < 8:
            continue
        window = attack_env[start_index:end_index]
        candidates: list[tuple[float, float]] = []
        for index in range(2, len(window) - 2):
            value = float(window[index])
            if value < 0.18:
                continue
            if (
                value >= float(window[index - 1])
                and value >= float(window[index + 1])
                and value >= float(window[index - 2])
                and value >= float(window[index + 2])
            ):
                local_window = window[max(0, index - 20) : min(len(window), index + 5)]
                local_start = backtrack_peak_to_attack_start(local_window, min(20, index), tuning)
                global_start = start_index + max(0, index - 20) + local_start
                start_ms = (global_start / low_sample_rate) * 1000.0
                offset_ms = start_ms - float(beat_sec) * 1000.0
                if -60.0 <= offset_ms <= -5.0:
                    candidates.append((offset_ms, value))
        if not candidates:
            continue
        candidates.sort(key=lambda item: (abs(item[0]), -item[1]))
        chosen_offset_ms, chosen_weight = candidates[0]
        offsets_ms.append(chosen_offset_ms)
        weights.append(chosen_weight)

    if len(offsets_ms) < 8:
        return None
    offset_array = np.asarray(offsets_ms, dtype="float64")
    weight_array = np.asarray(weights, dtype="float64")
    center = weighted_median(offset_array, weight_array)
    if center is None or not math.isfinite(center):
        return None
    mad_value = weighted_mad(offset_array, weight_array, center)
    return {
        "offsetMs": float(center),
        "offsetMadMs": float(mad_value) if mad_value is not None and math.isfinite(float(mad_value)) else 999.0,
        "matchRatio": len(offsets_ms) / len(beat_array),
    }


def estimate_head_bootstrap_candidate(
    signal: np.ndarray,
    sample_rate: int,
    raw_first_beat_ms: float,
    bpm: float,
    tuning: dict[str, Any],
) -> dict[str, float] | None:
    if (
        sample_rate <= 0
        or not math.isfinite(raw_first_beat_ms)
        or raw_first_beat_ms < float(tuning["headBootstrapMinRawFirstBeatMs"])
        or not math.isfinite(bpm)
        or bpm <= 0.0
    ):
        return None

    mono = mix_to_mono(signal[: int(sample_rate * 4)])
    low_sample_rate = 300
    low = soxr.resample(mono, in_rate=sample_rate, out_rate=low_sample_rate)
    if low.size < 64:
        return None

    abs_signal = np.abs(low.astype("float64", copy=False))
    fast_env = moving_average(abs_signal, max(1, int(round(low_sample_rate * 0.010))))
    slow_env = moving_average(abs_signal, max(2, int(round(low_sample_rate * 0.080))))
    attack_env = np.maximum(0.0, fast_env - slow_env)
    attack_env = moving_average(attack_env, max(1, int(round(low_sample_rate * 0.004))))
    peak_value = float(np.max(attack_env)) if attack_env.size else 0.0
    if peak_value <= 1e-9:
        return None
    attack_env = attack_env / peak_value

    beat_interval_ms = 60000.0 / bpm
    peak_start_ms = max(0.0, raw_first_beat_ms - 40.0)
    peak_end_ms = min(1000.0, raw_first_beat_ms + 80.0)
    start_index = max(0, int(round((peak_start_ms / 1000.0) * low_sample_rate)))
    end_index = min(len(attack_env), int(round((peak_end_ms / 1000.0) * low_sample_rate)))
    if end_index - start_index < 8:
        return None

    window = attack_env[start_index:end_index]
    candidates: list[tuple[float, float, float, int]] = []
    for index in range(2, len(window) - 2):
        value = float(window[index])
        if value < 0.12:
            continue
        if (
            value >= float(window[index - 1])
            and value >= float(window[index + 1])
            and value >= float(window[index - 2])
            and value >= float(window[index + 2])
        ):
            local_window = window[max(0, index - 30) : min(len(window), index + 8)]
            local_start = backtrack_peak_to_attack_start(local_window, min(30, index), tuning)
            global_start = start_index + max(0, index - 30) + local_start
            start_ms = (global_start / low_sample_rate) * 1000.0
            shift_ms = start_ms - raw_first_beat_ms
            if (
                shift_ms > -float(tuning["headBootstrapMinShiftMs"])
                or shift_ms < -float(tuning["headBootstrapMaxShiftMs"])
            ):
                continue
            values: list[float] = []
            for beat_index in range(0, 16):
                sample_index = int(round(((start_ms + beat_index * beat_interval_ms) / 1000.0) * low_sample_rate))
                if sample_index < 0:
                    continue
                if sample_index >= len(attack_env):
                    break
                values.append(float(attack_env[sample_index]))
            if len(values) < int(tuning["headBootstrapMinSupport"]):
                continue
            score = statistics.fmean(values) * 0.7 + statistics.median(values) * 0.3
            candidates.append((score, value, start_ms, len(values)))

    if not candidates:
        return None
    candidates.sort(reverse=True)
    best_score, best_peak, best_candidate_ms, best_support = candidates[0]
    if best_peak < float(tuning["headBootstrapMinPeak"]):
        return None
    return {
        "candidateMs": float(best_candidate_ms),
        "shiftMs": float(best_candidate_ms - raw_first_beat_ms),
        "peak": float(best_peak),
        "score": float(best_score),
        "support": int(best_support),
    }


def phase_delta_ms(value_ms: float, reference_ms: float, beat_interval_ms: float) -> float:
    if not math.isfinite(beat_interval_ms) or beat_interval_ms <= 0.0:
        return 0.0
    return ((value_ms - reference_ms + beat_interval_ms * 0.5) % beat_interval_ms) - beat_interval_ms * 0.5


def normalize_phase_ms(value_ms: float, beat_interval_ms: float) -> float:
    if not math.isfinite(beat_interval_ms) or beat_interval_ms <= 0.0:
        return 0.0
    normalized = value_ms % beat_interval_ms
    if normalized < 0.0:
        normalized += beat_interval_ms
    return normalized
