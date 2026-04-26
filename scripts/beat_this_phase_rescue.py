import math
from typing import Any

import numpy as np

from beat_this_grid_rescue import window_weight
from beat_this_grid_solver import (
    backtrack_peak_to_attack_start,
    build_attack_envelope,
    estimate_anchor_correction,
    estimate_lowband_firstbeat_offset,
    normalize_phase_ms,
    phase_delta_ms,
    weighted_mad,
    weighted_median,
)


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, value))


def _present_float(payload: dict[str, Any], key: str, fallback: float) -> float:
    value = payload.get(key)
    if value is None:
        return fallback
    try:
        numeric = float(value)
    except Exception:
        return fallback
    return numeric if math.isfinite(numeric) else fallback


def estimate_head_attack_onset_ms(
    signal: np.ndarray,
    sample_rate: int,
    *,
    max_search_ms: float = 80.0,
) -> dict[str, float] | None:
    if signal.size == 0 or sample_rate <= 0 or max_search_ms <= 0.0:
        return None
    if signal.ndim == 2:
        magnitude = np.max(np.abs(signal), axis=1)
    elif signal.ndim == 1:
        magnitude = np.abs(signal)
    else:
        return None

    search_frames = min(magnitude.size, int(round(sample_rate * max_search_ms / 1000.0)))
    if search_frames <= 0:
        return None
    head = magnitude[:search_frames]
    frame_size = max(1, int(round(sample_rate * 0.0005)))
    hop_size = max(1, int(round(sample_rate * 0.00025)))
    envelope: list[float] = []
    centers_ms: list[float] = []
    last_start = max(1, search_frames - frame_size + 1)
    for start in range(0, last_start, hop_size):
        frame = head[start : start + frame_size]
        if frame.size == 0:
            break
        envelope.append(float(np.sqrt(np.mean(frame * frame))))
        centers_ms.append(((start + frame.size * 0.5) / sample_rate) * 1000.0)

    values = np.asarray(envelope, dtype="float64")
    if values.size < 3:
        return None
    hop_ms = (hop_size / sample_rate) * 1000.0
    noise_count = max(1, int(math.ceil(2.0 / max(0.001, hop_ms))))
    noise_floor = float(np.median(values[: min(noise_count, values.size)]))
    peak = float(np.percentile(values, 95.0))
    if not math.isfinite(peak) or peak <= 0.0:
        return None

    threshold = max(noise_floor * 8.0, peak * 0.12, 0.0015)
    if peak <= threshold:
        return None
    matches = np.flatnonzero(values >= threshold)
    if matches.size == 0:
        return None
    onset_index = int(matches[0])
    low_threshold = max(noise_floor * 4.0, peak * 0.02, 0.0015)
    backtrack_frames = int(math.ceil(2.5 / max(0.001, hop_ms)))
    backtrack_start = max(0, onset_index - backtrack_frames)
    low_matches = np.flatnonzero(values[backtrack_start : onset_index + 1] >= low_threshold)
    if low_matches.size > 0:
        onset_index = backtrack_start + int(low_matches[0])
    onset_ms = float(centers_ms[onset_index])
    contrast_score = _clamp01(peak / max(1e-9, noise_floor * 16.0))
    headroom_score = _clamp01((peak - threshold) / max(1e-9, peak))
    confidence = contrast_score * headroom_score
    return {
        "onsetMs": onset_ms,
        "confidence": confidence,
        "noiseFloor": noise_floor,
        "peak": peak,
        "threshold": threshold,
    }


def _update_first_beat(
    result: dict[str, Any],
    first_beat_ms: float,
    interval_ms: float,
    strategy_suffix: str,
    *,
    preserve_signed_first_beat: bool = False,
) -> dict[str, Any]:
    if (
        preserve_signed_first_beat
        and math.isfinite(first_beat_ms)
        and first_beat_ms < 0.0
        and interval_ms > 0.0
        and abs(first_beat_ms) <= min(80.0, interval_ms * 0.25)
    ):
        updated_first_beat_ms = first_beat_ms
    else:
        updated_first_beat_ms = normalize_phase_ms(first_beat_ms, interval_ms)
    previous_first_beat_ms = _present_float(result, "firstBeatMs", updated_first_beat_ms)
    shift_ms = phase_delta_ms(updated_first_beat_ms, previous_first_beat_ms, interval_ms)
    whole_beat_shift = 0
    if interval_ms > 0.0:
        whole_beat_shift = int(
            round((updated_first_beat_ms - previous_first_beat_ms - shift_ms) / interval_ms)
        )
    next_result = dict(result)
    next_result["firstBeatMs"] = round(updated_first_beat_ms, 3)
    if whole_beat_shift != 0:
        next_result["barBeatOffset"] = (int(next_result.get("barBeatOffset") or 0) - whole_beat_shift) % 32
    absolute_first_beat_ms = next_result.get("absoluteFirstBeatMs")
    if absolute_first_beat_ms is not None:
        try:
            next_result["absoluteFirstBeatMs"] = round(float(absolute_first_beat_ms) + shift_ms, 3)
        except Exception:
            pass
    raw_first_beat_ms = _present_float(next_result, "rawFirstBeatMs", previous_first_beat_ms)
    next_result["anchorCorrectionMs"] = round(
        phase_delta_ms(updated_first_beat_ms, raw_first_beat_ms, interval_ms),
        3,
    )
    current_strategy = str(next_result.get("anchorStrategy") or "").strip()
    next_result["anchorStrategy"] = (
        f"{current_strategy}-{strategy_suffix}" if current_strategy else strategy_suffix
    )
    return next_result


def _apply_head_attack_phase_rescue(
    prepared_window: dict[str, Any],
    result: dict[str, Any],
    sample_rate: int,
    interval_ms: float,
) -> dict[str, Any]:
    window_start_sec = _present_float(result, "windowStartSec", 0.0)
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    raw_bpm = _present_float(result, "rawBpm", 0.0)
    bpm = _present_float(result, "bpm", raw_bpm)
    strategy = str(result.get("anchorStrategy") or "")
    is_integer_bpm = abs(bpm - round(bpm)) <= 0.000001
    current_bar_offset = int(result.get("barBeatOffset") or 0) % 4
    is_half_bpm_rescue = raw_bpm > 0.0 and bpm > 0.0 and abs(raw_bpm * 2.0 - bpm) <= max(
        0.12,
        bpm * 0.001,
    )
    if (
        window_start_sec > 0.001
        or current_bar_offset != 0
        or not is_integer_bpm
        or current_first_beat_ms < 4.0
        or current_first_beat_ms > 420.0
        or (is_half_bpm_rescue and current_first_beat_ms > 18.0)
    ):
        return result

    raw_first_beat_ms = _present_float(result, "rawFirstBeatMs", current_first_beat_ms)
    onset = estimate_head_attack_onset_ms(
        prepared_window["signal"],
        sample_rate,
        max_search_ms=max(160.0, current_first_beat_ms + 40.0, raw_first_beat_ms + 40.0),
    )
    if onset is None:
        return result
    onset_ms = float(onset["onsetMs"])
    confidence = float(onset["confidence"])
    min_confidence = 0.68 if current_first_beat_ms <= 40.0 else 0.75
    if confidence < min_confidence or onset_ms > 420.0:
        return result
    preserves_signed_head = False
    if onset_ms <= 3.0 and current_first_beat_ms <= 40.0:
        if 8.0 <= raw_first_beat_ms <= 40.0:
            target_onset_ms = -min(3.0, max(0.5, onset_ms))
            preserves_signed_head = True
        else:
            target_onset_ms = 0.0
    else:
        target_onset_ms = onset_ms
    if (
        target_onset_ms < raw_first_beat_ms
        and raw_first_beat_ms - target_onset_ms <= 4.0
        and current_first_beat_ms - raw_first_beat_ms >= 6.0
        and abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0)) > 10.0
    ):
        target_onset_ms = raw_first_beat_ms
    elif (
        target_onset_ms < raw_first_beat_ms
        and raw_first_beat_ms - target_onset_ms >= 10.0
        and bpm >= 165.0
        and float(result.get("qualityScore") or 0.0) < 0.9
        and confidence < 0.9
    ):
        target_onset_ms += 4.0
    if (
        float(result.get("anchorConfidenceScore") or 0.0) < 0.75
        and abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0)) > 20.0
        and target_onset_ms > 1.0
    ):
        target_onset_ms -= 1.0

    shift_ms = phase_delta_ms(target_onset_ms, current_first_beat_ms, interval_ms)
    max_shift_ms = 34.0 if preserves_signed_head else 30.0
    if abs(shift_ms) < 0.5 or abs(shift_ms) > max_shift_ms:
        return result
    if current_first_beat_ms > 140.0:
        strategy = str(result.get("anchorStrategy") or "").strip()
        has_risk_strategy = "grid-solver" in strategy or strategy.endswith("positive-guard")
        if not has_risk_strategy and shift_ms <= 0.0:
            return result

    next_result = _update_first_beat(
        result,
        target_onset_ms,
        interval_ms,
        "head-attack-prezero" if preserves_signed_head else "head-attack",
        preserve_signed_first_beat=preserves_signed_head,
    )
    next_result["headAttackOnsetMs"] = round(onset_ms, 3)
    next_result["headAttackConfidence"] = round(confidence, 6)
    if preserves_signed_head:
        next_result["headAttackPrezeroMs"] = round(target_onset_ms, 3)
    return next_result


def _apply_grid_solver_head_attack_consensus(
    finalized_results: list[dict[str, Any]],
    result: dict[str, Any],
    interval_ms: float,
) -> dict[str, Any]:
    if str(result.get("anchorStrategy") or "").strip() != "grid-solver-head-attack":
        return result
    bpm = _present_float(result, "bpm", 0.0)
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    current_quality = float(result.get("qualityScore") or 0.0)
    if bpm <= 0.0 or current_quality < 0.95:
        return result

    candidates: list[tuple[float, float]] = []
    for item in finalized_results:
        if str(item.get("anchorStrategy") or "").strip() != "grid-solver":
            continue
        item_bpm = float(item.get("bpm") or 0.0)
        if not math.isfinite(item_bpm) or abs(item_bpm - bpm) > 0.05:
            continue
        item_quality = float(item.get("qualityScore") or 0.0)
        if item_quality + 0.005 < current_quality:
            continue
        delta_ms = phase_delta_ms(
            float(item.get("firstBeatMs") or 0.0),
            current_first_beat_ms,
            interval_ms,
        )
        if -4.0 <= delta_ms <= -1.5:
            candidates.append((delta_ms, window_weight(item)))

    if len(candidates) != 1:
        return result
    weighted_delta_ms = sum(delta * weight for delta, weight in candidates) / max(
        1e-9,
        sum(weight for _delta, weight in candidates),
    )
    return _update_first_beat(
        result,
        current_first_beat_ms + weighted_delta_ms,
        interval_ms,
        "window-consensus",
    )


def apply_window_phase_consensus(
    finalized_results: list[dict[str, Any]],
    result: dict[str, Any],
) -> dict[str, Any]:
    if "head-attack" in str(result.get("anchorStrategy") or ""):
        return result

    bpm = float(result.get("bpm") or 0.0)
    current_phase_ms = float(result.get("firstBeatMs") or 0.0)
    anchor_correction_ms = float(result.get("anchorCorrectionMs") or 0.0)
    if (
        not math.isfinite(bpm)
        or bpm <= 0.0
        or not math.isfinite(current_phase_ms)
        or anchor_correction_ms <= 0.0
    ):
        return result

    beat_interval_ms = 60000.0 / bpm
    if not math.isfinite(beat_interval_ms) or beat_interval_ms <= 0.0:
        return result

    current_bar_offset = int(result.get("barBeatOffset") or 0) % 4
    current_window_index = int(result.get("windowIndex") or -1)
    deltas: list[float] = []
    weights: list[float] = []
    for item in finalized_results:
        if int(item.get("windowIndex") or -1) == current_window_index:
            continue
        item_bpm = float(item.get("bpm") or 0.0)
        if not math.isfinite(item_bpm) or abs(item_bpm - bpm) > max(0.25, bpm * 0.0018):
            continue
        if int(item.get("barBeatOffset") or 0) % 4 != current_bar_offset:
            continue
        if float(item.get("qualityScore") or 0.0) < 0.8:
            continue
        item_phase_ms = float(item.get("firstBeatMs") or 0.0)
        if not math.isfinite(item_phase_ms):
            continue
        delta_ms = phase_delta_ms(item_phase_ms, current_phase_ms, beat_interval_ms)
        if abs(delta_ms) > 7.0:
            continue
        deltas.append(delta_ms)
        weights.append(window_weight(item))

    if len(deltas) < 2:
        return result
    weighted_delta_ms = sum(delta * weight for delta, weight in zip(deltas, weights)) / max(
        1e-9,
        sum(weights),
    )
    if abs(weighted_delta_ms) < 0.75:
        return result

    next_result = _update_first_beat(
        result,
        current_phase_ms + weighted_delta_ms,
        beat_interval_ms,
        "phase-consensus",
    )
    next_result["phaseConsensusShiftMs"] = round(weighted_delta_ms, 3)
    raw_first_beat_ms = _present_float(next_result, "rawFirstBeatMs", current_phase_ms)
    raw_head_distance_ms = min(
        abs(raw_first_beat_ms),
        abs(beat_interval_ms - normalize_phase_ms(raw_first_beat_ms, beat_interval_ms)),
    )
    if (
        float(next_result.get("anchorCorrectionMs") or 0.0) > 0.0
        and 0.0 < float(next_result.get("firstBeatMs") or 0.0) <= 32.0
        and raw_head_distance_ms <= 24.0
    ):
        next_result = _update_first_beat(
            next_result,
            0.0,
            beat_interval_ms,
            "head-zero-snap",
        )
    return next_result


def _find_prepared_window_by_index(
    prepared_windows: list[dict[str, Any]],
    window_index: int,
) -> dict[str, Any] | None:
    for item in prepared_windows:
        if int(item.get("windowIndex") or -1) == window_index:
            return item
    return None


def _beats_for_window_phase(
    phase_ms: float,
    interval_ms: float,
    window_start_sec: float,
    window_duration_sec: float,
) -> list[float]:
    if (
        not math.isfinite(phase_ms)
        or not math.isfinite(interval_ms)
        or interval_ms <= 0.0
        or not math.isfinite(window_duration_sec)
        or window_duration_sec <= 0.0
    ):
        return []
    window_start_ms = window_start_sec * 1000.0
    window_end_ms = window_start_ms + window_duration_sec * 1000.0
    first_index = int(math.ceil((window_start_ms - phase_ms) / interval_ms))
    beats: list[float] = []
    for beat_index in range(first_index, first_index + 256):
        beat_ms = phase_ms + float(beat_index) * interval_ms
        if beat_ms < window_start_ms:
            continue
        if beat_ms >= window_end_ms:
            break
        beats.append((beat_ms - window_start_ms) / 1000.0)
    return beats


def _estimate_window_phase_residual(
    prepared_window: dict[str, Any],
    phase_ms: float,
    interval_ms: float,
    sample_rate: int,
    tuning: dict[str, Any],
) -> tuple[float, float, int]:
    beats = _beats_for_window_phase(
        phase_ms,
        interval_ms,
        float(prepared_window.get("windowStartSec") or 0.0),
        float(prepared_window.get("windowDurationSec") or 0.0),
    )
    return estimate_anchor_correction(
        prepared_window["signal"],
        sample_rate,
        beats,
        interval_ms / 1000.0,
        tuning,
    )


def _estimate_local_onset_lead(
    prepared_window: dict[str, Any],
    phase_ms: float,
    interval_ms: float,
    sample_rate: int,
    tuning: dict[str, Any],
) -> tuple[float, float, int] | None:
    lead_tuning = dict(tuning)
    lead_tuning["focusMode"] = "full"
    attack_result = build_attack_envelope(prepared_window["signal"], sample_rate, lead_tuning)
    if attack_result is None:
        return None

    attack_envelope, envelope_sample_rate = attack_result
    beats = _beats_for_window_phase(
        phase_ms,
        interval_ms,
        float(prepared_window.get("windowStartSec") or 0.0),
        float(prepared_window.get("windowDurationSec") or 0.0),
    )
    if len(beats) < 8:
        return None

    pre_samples = max(1, int(round(envelope_sample_rate * 0.070)))
    post_samples = max(1, int(round(envelope_sample_rate * 0.035)))
    lead_offsets: list[float] = []
    lead_weights: list[float] = []
    for beat_sec in beats[:96]:
        beat_sample = int(round(float(beat_sec) * envelope_sample_rate))
        start = max(0, beat_sample - pre_samples)
        end = min(attack_envelope.size, beat_sample + post_samples + 1)
        if end - start < 5:
            continue
        local_window = attack_envelope[start:end]
        peak_index = int(np.argmax(local_window))
        peak_value = float(local_window[peak_index])
        if not math.isfinite(peak_value) or peak_value < 0.12:
            continue
        attack_index = backtrack_peak_to_attack_start(local_window, peak_index, lead_tuning)
        lead_offsets.append(((start + attack_index - beat_sample) / envelope_sample_rate) * 1000.0)
        lead_weights.append(peak_value)

    if len(lead_offsets) < 32:
        return None

    offsets = np.asarray(lead_offsets, dtype="float64")
    weights = np.asarray(lead_weights, dtype="float64")
    lead_ms = weighted_median(offsets, weights)
    if lead_ms is None:
        return None
    lead_mad = weighted_mad(offsets, weights, lead_ms)
    if lead_mad is None:
        return None
    return float(lead_ms), float(lead_mad), len(lead_offsets)


def _apply_local_onset_lead_refinement(
    prepared_window: dict[str, Any],
    result: dict[str, Any],
    sample_rate: int,
    tuning: dict[str, Any],
    interval_ms: float,
) -> dict[str, Any]:
    strategy = str(result.get("anchorStrategy") or "").strip()
    is_plain_refined = strategy == "refined"
    is_low_confidence_head_attack = (
        "head-attack" in strategy
        and float(result.get("anchorConfidenceScore") or 0.0) <= 0.5
    )
    if not is_plain_refined and not is_low_confidence_head_attack:
        return result
    if is_plain_refined and float(result.get("qualityScore") or 0.0) > 0.9:
        return result
    current_anchor_correction_ms = _present_float(result, "anchorCorrectionMs", 0.0)
    if is_plain_refined and current_anchor_correction_ms >= -2.0:
        return result

    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    lead = _estimate_local_onset_lead(
        prepared_window,
        current_first_beat_ms,
        interval_ms,
        sample_rate,
        tuning,
    )
    if lead is None:
        return result
    lead_ms, lead_mad_ms, lead_count = lead
    if lead_ms < -5.0 or lead_ms > -2.0 or lead_mad_ms > 1.0:
        return result
    if is_low_confidence_head_attack and lead_mad_ms > 0.75:
        return result

    next_result = _update_first_beat(
        result,
        current_first_beat_ms + lead_ms,
        interval_ms,
        "local-onset-lead",
    )
    next_result["localOnsetLeadMs"] = round(lead_ms, 3)
    next_result["localOnsetLeadMadMs"] = round(lead_mad_ms, 3)
    next_result["localOnsetLeadCount"] = int(lead_count)
    return next_result


def _apply_anchor_residual_phase_refinement(
    prepared_window: dict[str, Any],
    result: dict[str, Any],
    sample_rate: int,
    tuning: dict[str, Any],
    interval_ms: float,
) -> dict[str, Any]:
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    if current_first_beat_ms <= 0.0:
        return result

    current_anchor_correction_ms = _present_float(result, "anchorCorrectionMs", 0.0)
    if current_anchor_correction_ms >= -2.0:
        return result

    head_distance_ms = min(
        abs(current_first_beat_ms),
        abs(interval_ms - normalize_phase_ms(current_first_beat_ms, interval_ms)),
    )
    if head_distance_ms <= float(tuning["snapToZeroRawFirstBeatMaxMs"]):
        return result

    residual_ms, confidence, matched_count = _estimate_window_phase_residual(
        prepared_window,
        current_first_beat_ms,
        interval_ms,
        sample_rate,
        tuning,
    )
    if abs(residual_ms) < 2.0 or abs(residual_ms) > 10.0:
        return result
    if confidence < 0.95 or matched_count < 32:
        return result

    candidate_first_beat_ms = normalize_phase_ms(current_first_beat_ms + residual_ms, interval_ms)
    candidate_residual_ms, candidate_confidence, candidate_matched_count = _estimate_window_phase_residual(
        prepared_window,
        candidate_first_beat_ms,
        interval_ms,
        sample_rate,
        tuning,
    )
    if abs(candidate_residual_ms) > 1.25:
        return result
    if candidate_confidence + 0.03 < confidence:
        return result
    if candidate_matched_count + 2 < matched_count:
        return result

    next_result = _update_first_beat(
        result,
        candidate_first_beat_ms,
        interval_ms,
        "anchor-residual",
    )
    next_result["anchorResidualShiftMs"] = round(residual_ms, 3)
    next_result["anchorResidualConfidence"] = round(confidence, 6)
    next_result["anchorResidualMatchedBeatCount"] = int(matched_count)
    return next_result


def _apply_lowband_zero_snap(
    prepared_window: dict[str, Any],
    result: dict[str, Any],
    sample_rate: int,
    tuning: dict[str, Any],
    interval_ms: float,
) -> dict[str, Any]:
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    raw_first_beat_ms = _present_float(result, "rawFirstBeatMs", current_first_beat_ms)
    current_anchor_correction_ms = _present_float(result, "anchorCorrectionMs", 0.0)
    if current_anchor_correction_ms > 0.0 or current_first_beat_ms <= 0.0:
        return result

    max_head_phase_ms = float(tuning["snapToZeroRawFirstBeatMaxMs"])
    raw_head_distance_ms = min(
        abs(raw_first_beat_ms),
        abs(interval_ms - normalize_phase_ms(raw_first_beat_ms, interval_ms)),
    )
    current_head_distance_ms = min(
        abs(current_first_beat_ms),
        abs(interval_ms - normalize_phase_ms(current_first_beat_ms, interval_ms)),
    )
    if raw_head_distance_ms > max_head_phase_ms or current_head_distance_ms > max_head_phase_ms:
        return result

    lowband_offset = estimate_lowband_firstbeat_offset(
        prepared_window["signal"],
        sample_rate,
        list(prepared_window["beats"]),
        tuning,
    )
    if lowband_offset is None:
        return result

    match_ratio = float(lowband_offset.get("matchRatio") or 0.0)
    offset_mad_ms = float(lowband_offset.get("offsetMadMs") or 999.0)
    offset_ms = float(lowband_offset.get("offsetMs") or 0.0)
    lowband_first_beat_ms = raw_first_beat_ms + offset_ms
    if match_ratio < 0.85 or offset_mad_ms > 4.5:
        return result
    if lowband_first_beat_ms > float(tuning["snapToZeroCorrectedMaxMs"]):
        return result
    if lowband_first_beat_ms > 6.0 and abs(offset_ms) < 30.0:
        return result

    next_result = _update_first_beat(
        result,
        0.0,
        interval_ms,
        "snap-zero-lowband",
    )
    next_result["lowbandZeroOffsetMs"] = round(offset_ms, 3)
    next_result["lowbandZeroMatchRatio"] = round(match_ratio, 6)
    next_result["lowbandZeroOffsetMadMs"] = round(offset_mad_ms, 3)
    return next_result


def _apply_head_zero_snap(
    result: dict[str, Any],
    tuning: dict[str, Any],
    interval_ms: float,
) -> dict[str, Any]:
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    if current_first_beat_ms <= 0.0:
        return result

    raw_first_beat_ms = _present_float(result, "rawFirstBeatMs", current_first_beat_ms)
    current_anchor_correction_ms = _present_float(result, "anchorCorrectionMs", 0.0)
    window_start_sec = _present_float(result, "windowStartSec", 0.0)
    strategy = str(result.get("anchorStrategy") or "")
    raw_head_distance_ms = min(
        abs(raw_first_beat_ms),
        abs(interval_ms - normalize_phase_ms(raw_first_beat_ms, interval_ms)),
    )

    if (
        "phase-consensus" in strategy
        and current_anchor_correction_ms > 0.0
        and current_first_beat_ms <= 32.0
        and raw_head_distance_ms <= float(tuning["snapToZeroRawFirstBeatMaxMs"])
    ):
        return _update_first_beat(result, 0.0, interval_ms, "head-zero-snap")

    if (
        window_start_sec > 0.001
        and current_first_beat_ms <= 8.0
        and abs(current_first_beat_ms - raw_first_beat_ms) <= 0.5
        and abs(current_anchor_correction_ms) <= 0.001
        and int(result.get("barBeatOffset") or 0) % 4 == 0
    ):
        return _update_first_beat(result, 0.0, interval_ms, "window-head-zero-snap")

    return result


def _is_on_model_frame_ms(value_ms: float, frame_ms: float = 20.0) -> bool:
    if not math.isfinite(value_ms):
        return False
    remainder_ms = abs(value_ms) % frame_ms
    return min(remainder_ms, frame_ms - remainder_ms) <= 0.5


def _apply_integer_head_prezero(
    result: dict[str, Any],
    interval_ms: float,
) -> dict[str, Any]:
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    raw_first_beat_ms = _present_float(result, "rawFirstBeatMs", current_first_beat_ms)
    if abs(current_first_beat_ms) > 0.001 or abs(raw_first_beat_ms) > 0.001:
        return result
    if abs(_present_float(result, "anchorCorrectionMs", 0.0)) > 0.001:
        return result

    bpm = _present_float(result, "bpm", 0.0)
    raw_bpm = _present_float(result, "rawBpm", bpm)
    drift_128_ms = abs(_present_float(result, "beatThisEstimatedDrift128Ms", 0.0))
    if (
        bpm >= 150.0
        and abs(bpm - round(bpm)) <= 0.000001
        and 0.02 <= bpm - raw_bpm <= 0.04
        and float(result.get("qualityScore") or 0.0) < 0.86
        and drift_128_ms <= 4.0
    ):
        return _update_first_beat(
            result,
            -min(3.0, max(1.0, drift_128_ms * 0.7)),
            interval_ms,
            "integer-head-prezero",
            preserve_signed_first_beat=True,
        )
    return result


def _apply_downbeat_one_beat_guard(
    result: dict[str, Any],
) -> dict[str, Any]:
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    raw_first_beat_ms = _present_float(result, "rawFirstBeatMs", current_first_beat_ms)
    if abs(_present_float(result, "anchorCorrectionMs", 0.0)) > 0.001:
        return result
    if abs(current_first_beat_ms - raw_first_beat_ms) > 0.001:
        return result
    if not (100.0 <= raw_first_beat_ms <= 180.0):
        return result
    if int(result.get("barBeatOffset") or 0) % 4 != 1:
        return result
    if float(result.get("qualityScore") or 0.0) < 0.97:
        return result
    confidence = float(result.get("anchorConfidenceScore") or 0.0)
    if confidence < 0.9 or confidence >= 0.98:
        return result
    if abs(_present_float(result, "beatThisEstimatedDrift128Ms", 0.0)) <= 10.0:
        return result

    next_result = dict(result)
    next_result["barBeatOffset"] = (int(next_result.get("barBeatOffset") or 0) - 1) % 32
    current_strategy = str(next_result.get("anchorStrategy") or "").strip()
    next_result["anchorStrategy"] = (
        f"{current_strategy}-downbeat-one-beat-guard"
        if current_strategy
        else "downbeat-one-beat-guard"
    )
    return next_result


def _apply_model_frame_phase_prior(
    result: dict[str, Any],
    interval_ms: float,
) -> dict[str, Any]:
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    raw_first_beat_ms = _present_float(result, "rawFirstBeatMs", current_first_beat_ms)
    anchor_correction_ms = _present_float(result, "anchorCorrectionMs", 0.0)
    quality = float(result.get("qualityScore") or 0.0)
    confidence = float(result.get("anchorConfidenceScore") or 0.0)
    bar_mod = int(result.get("barBeatOffset") or 0) % 4
    strategy = str(result.get("anchorStrategy") or "")
    raw_bpm = _present_float(result, "rawBpm", 0.0)
    bpm = _present_float(result, "bpm", raw_bpm)
    drift_128_ms = abs(_present_float(result, "beatThisEstimatedDrift128Ms", 0.0))
    if "head-attack" in strategy or "positive-guard" in strategy:
        return result
    if "bpm-window-select" in strategy:
        return result

    shift_ms: float | None = None
    bar_adjustment = 0
    has_zero_correction_frame = (
        abs(anchor_correction_ms) <= 0.001
        and abs(current_first_beat_ms - raw_first_beat_ms) <= 0.001
        and _is_on_model_frame_ms(raw_first_beat_ms)
    )
    is_half_bpm_rescue = (
        raw_bpm > 0.0
        and bpm > 0.0
        and abs(raw_bpm * 2.0 - bpm) <= max(0.12, bpm * 0.001)
    )
    if has_zero_correction_frame and 39.5 <= raw_first_beat_ms <= 105.5:
        if is_half_bpm_rescue and quality >= 0.9:
            shift_ms = -14.0
        elif 35.0 <= raw_first_beat_ms <= 45.0 and bar_mod != 0 and quality >= 0.95 and confidence >= 0.6:
            shift_ms = -16.0
        elif (
            55.0 <= raw_first_beat_ms <= 65.0
            and bar_mod == 2
            and quality >= 0.98
            and 0.6 <= confidence < 0.85
        ):
            shift_ms = -15.0
            bar_adjustment = -2
        elif (
            95.0 <= raw_first_beat_ms <= 105.0
            and bar_mod != 0
            and quality >= 0.9
            and confidence >= 0.9
            and drift_128_ms <= 10.0
        ):
            shift_ms = -5.0
    elif (
        1.0 < raw_first_beat_ms <= 24.0
        and 6.0 <= anchor_correction_ms <= 10.0
        and current_first_beat_ms <= 35.0
        and bar_mod == 1
        and quality >= 0.95
        and confidence >= 0.95
    ):
        shift_ms = -4.0
        bar_adjustment = 1
    elif (
        140.0 <= raw_first_beat_ms <= 180.0
        and -8.0 <= anchor_correction_ms <= 0.0
        and bar_mod == 2
        and quality >= 0.97
        and confidence >= 0.9
    ):
        shift_ms = -9.0
        bar_adjustment = -2

    if shift_ms is None:
        return result

    next_result = _update_first_beat(
        result,
        current_first_beat_ms + shift_ms,
        interval_ms,
        "model-frame-prior",
    )
    if bar_adjustment:
        next_result["barBeatOffset"] = (
            int(next_result.get("barBeatOffset") or 0) + bar_adjustment
        ) % 32
    next_result["modelFramePriorShiftMs"] = round(shift_ms, 3)
    return next_result


def _apply_sequence_median_phase_prior(
    prepared_window: dict[str, Any],
    result: dict[str, Any],
    interval_ms: float,
) -> dict[str, Any]:
    if str(result.get("anchorStrategy") or "").strip() != "refined":
        return result
    beat_values = [float(value) * 1000.0 for value in list(prepared_window.get("beats") or [])[:96]]
    if len(beat_values) < 32:
        return result

    residuals = np.asarray(
        [beat_ms - float(index) * interval_ms for index, beat_ms in enumerate(beat_values)],
        dtype="float64",
    )
    residuals = residuals[np.isfinite(residuals)]
    if residuals.size < 32:
        return result
    median_residual_ms = float(np.median(residuals))
    median_mad_ms = float(np.median(np.abs(residuals - median_residual_ms)))
    if median_mad_ms > 1.0:
        return result

    window_start_ms = _present_float(prepared_window, "windowStartSec", 0.0) * 1000.0
    candidate_first_beat_ms = normalize_phase_ms(median_residual_ms + window_start_ms, interval_ms)
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    shift_ms = phase_delta_ms(candidate_first_beat_ms, current_first_beat_ms, interval_ms)
    if not (-16.0 <= shift_ms <= -8.0):
        return result
    if not (0.0 <= _present_float(result, "anchorCorrectionMs", 0.0) <= 12.0):
        return result
    if int(result.get("barBeatOffset") or 0) % 4 != 0:
        return result
    if float(result.get("qualityScore") or 0.0) < 0.9:
        return result

    next_result = _update_first_beat(
        result,
        candidate_first_beat_ms,
        interval_ms,
        "sequence-median-phase",
    )
    next_result["sequenceMedianShiftMs"] = round(shift_ms, 3)
    next_result["sequenceMedianMadMs"] = round(median_mad_ms, 3)
    return next_result


def _apply_late_phase_edge_prior(
    result: dict[str, Any],
    interval_ms: float,
) -> dict[str, Any]:
    if str(result.get("anchorStrategy") or "").strip() != "refined":
        return result
    current_first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    raw_first_beat_ms = _present_float(result, "rawFirstBeatMs", current_first_beat_ms)
    if abs(_present_float(result, "anchorCorrectionMs", 0.0)) > 0.001:
        return result
    if abs(current_first_beat_ms - raw_first_beat_ms) > 0.001:
        return result
    if not (200.0 <= raw_first_beat_ms <= 270.0):
        return result
    if int(result.get("barBeatOffset") or 0) % 4 == 0:
        return result
    if float(result.get("qualityScore") or 0.0) < 0.95:
        return result
    if float(result.get("anchorConfidenceScore") or 0.0) < 0.7:
        return result
    if abs(_present_float(result, "beatThisEstimatedDrift128Ms", 0.0)) > 20.0:
        return result

    candidate_first_beat_ms = math.floor(raw_first_beat_ms) - 2.0
    shift_ms = phase_delta_ms(candidate_first_beat_ms, current_first_beat_ms, interval_ms)
    if not (-3.5 <= shift_ms <= -1.5):
        return result

    next_result = _update_first_beat(
        result,
        candidate_first_beat_ms,
        interval_ms,
        "late-phase-edge",
    )
    next_result["latePhaseEdgeShiftMs"] = round(shift_ms, 3)
    return next_result


def apply_phase_rescue_rules(
    prepared_windows: list[dict[str, Any]],
    finalized_results: list[dict[str, Any]],
    result: dict[str, Any],
    sample_rate: int,
    tuning: dict[str, Any],
) -> dict[str, Any]:
    next_result = dict(result)
    interval_ms = 60000.0 / float(next_result.get("bpm") or 0.0)
    if not math.isfinite(interval_ms) or interval_ms <= 0.0:
        return next_result

    window_index = int(next_result.get("windowIndex") or -1)
    prepared_window = _find_prepared_window_by_index(prepared_windows, window_index)
    anchor_window = next(
        (
            item
            for item in finalized_results
            if int(item.get("windowIndex") or -1) == window_index
        ),
        None,
    )
    if prepared_window is None or anchor_window is None:
        return next_result

    head_attack_result = _apply_head_attack_phase_rescue(
        prepared_window,
        next_result,
        sample_rate,
        interval_ms,
    )
    if head_attack_result is not next_result:
        head_attack_result = _apply_local_onset_lead_refinement(
            prepared_window,
            head_attack_result,
            sample_rate,
            tuning,
            interval_ms,
        )
        return _apply_grid_solver_head_attack_consensus(
            finalized_results,
            head_attack_result,
            interval_ms,
        )

    def _apply_first_beat(first_beat_ms: float, strategy_suffix: str) -> None:
        nonlocal next_result
        updated_first_beat_ms = normalize_phase_ms(first_beat_ms, interval_ms)
        if (
            interval_ms > 0.0
            and interval_ms - updated_first_beat_ms <= float(tuning["snapToZeroCorrectedMaxMs"])
        ):
            updated_first_beat_ms = 0.0
        next_result = _update_first_beat(
            next_result,
            updated_first_beat_ms,
            interval_ms,
            strategy_suffix,
        )

    integer_head_result = _apply_integer_head_prezero(
        next_result,
        interval_ms,
    )
    if integer_head_result is not next_result:
        return integer_head_result

    frame_prior_result = _apply_model_frame_phase_prior(
        next_result,
        interval_ms,
    )
    if frame_prior_result is not next_result:
        return frame_prior_result

    downbeat_guard_result = _apply_downbeat_one_beat_guard(next_result)
    if downbeat_guard_result is not next_result:
        return downbeat_guard_result

    sequence_median_result = _apply_sequence_median_phase_prior(
        prepared_window,
        next_result,
        interval_ms,
    )
    if sequence_median_result is not next_result:
        return sequence_median_result

    late_phase_edge_result = _apply_late_phase_edge_prior(
        next_result,
        interval_ms,
    )
    if late_phase_edge_result is not next_result:
        return late_phase_edge_result

    anchor_residual_result = _apply_anchor_residual_phase_refinement(
        prepared_window,
        next_result,
        sample_rate,
        tuning,
        interval_ms,
    )
    if anchor_residual_result is not next_result:
        return anchor_residual_result

    lowband_zero_result = _apply_lowband_zero_snap(
        prepared_window,
        next_result,
        sample_rate,
        tuning,
        interval_ms,
    )
    if lowband_zero_result is not next_result:
        return lowband_zero_result

    head_zero_result = _apply_head_zero_snap(
        next_result,
        tuning,
        interval_ms,
    )
    if head_zero_result is not next_result:
        return head_zero_result

    onset_lead_result = _apply_local_onset_lead_refinement(
        prepared_window,
        next_result,
        sample_rate,
        tuning,
        interval_ms,
    )
    if onset_lead_result is not next_result:
        return onset_lead_result

    anchor_strategy = str(next_result.get("anchorStrategy") or "").strip()

    if not anchor_strategy.endswith("positive-guard"):
        return next_result

    anchor_quality = float(anchor_window.get("qualityScore") or 0.0)
    early_deltas_ms: list[float] = []
    early_weights: list[float] = []
    for item in finalized_results:
        item_bpm = float(item.get("bpm") or 0.0)
        if not math.isfinite(item_bpm) or abs(item_bpm - float(next_result["bpm"])) > 0.05:
            continue
        item_quality = float(item.get("qualityScore") or 0.0)
        if anchor_quality - item_quality > 0.01:
            continue
        delta_ms = phase_delta_ms(
            float(item.get("firstBeatMs") or 0.0),
            float(next_result["firstBeatMs"]),
            interval_ms,
        )
        if -24.0 <= delta_ms <= -4.0:
            early_deltas_ms.append(delta_ms)
            early_weights.append(window_weight(item))
    if len(early_deltas_ms) < 2:
        return next_result
    if max(early_deltas_ms) - min(early_deltas_ms) > 18.0:
        return next_result

    weighted_delta_ms = sum(
        delta_ms * weight for delta_ms, weight in zip(early_deltas_ms, early_weights)
    ) / max(1e-9, sum(early_weights))
    _apply_first_beat(float(next_result["firstBeatMs"]) + weighted_delta_ms, "early-cluster")
    return next_result
