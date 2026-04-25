import math
from typing import Any

import numpy as np

from beat_this_grid_rescue import window_weight
from beat_this_grid_solver import (
    estimate_lowband_firstbeat_offset,
    normalize_phase_ms,
    phase_delta_ms,
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
    return next_result


def _find_prepared_window_by_index(
    prepared_windows: list[dict[str, Any]],
    window_index: int,
) -> dict[str, Any] | None:
    for item in prepared_windows:
        if int(item.get("windowIndex") or -1) == window_index:
            return item
    return None


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

    lowband_offset = estimate_lowband_firstbeat_offset(
        prepared_window["signal"],
        sample_rate,
        list(prepared_window["beats"]),
        tuning,
    )
    current_first_beat_ms = float(next_result.get("firstBeatMs") or 0.0)
    raw_first_beat_ms = _present_float(next_result, "rawFirstBeatMs", current_first_beat_ms)
    current_anchor_correction_ms = float(next_result.get("anchorCorrectionMs") or 0.0)
    if lowband_offset is not None:
        lowband_match_ratio = float(lowband_offset.get("matchRatio") or 0.0)
        lowband_offset_mad_ms = float(lowband_offset.get("offsetMadMs") or 999.0)
        lowband_offset_ms = float(lowband_offset.get("offsetMs") or 0.0)
        if (
            current_anchor_correction_ms <= 0.0
            and current_first_beat_ms > 0.0
            and current_first_beat_ms <= 24.0
            and lowband_match_ratio >= 0.85
            and lowband_offset_mad_ms <= 4.5
            and abs(lowband_offset_ms + raw_first_beat_ms) <= 6.0
        ):
            _apply_first_beat(0.0, "snap-zero-lowband")
            return next_result
        if (
            current_anchor_correction_ms <= 0.0
            and current_first_beat_ms > 0.0
            and current_first_beat_ms <= 18.0
            and lowband_match_ratio >= 0.8
            and lowband_offset_mad_ms <= 4.5
            and lowband_offset_ms <= -30.0
        ):
            _apply_first_beat(0.0, "snap-zero-lowband")
            return next_result
        if (
            current_anchor_correction_ms <= 0.0
            and current_first_beat_ms > 0.0
            and current_first_beat_ms <= 24.0
            and lowband_match_ratio >= 0.85
            and lowband_offset_mad_ms <= 4.5
            and lowband_offset_ms <= -30.0
        ):
            _apply_first_beat(0.0, "snap-zero-lowband")
            return next_result

    if (
        float(next_result.get("windowStartSec") or 0.0) > 0.001
        and current_anchor_correction_ms <= 0.0
        and 0.5 <= current_first_beat_ms <= 8.0
        and int(next_result.get("barBeatOffset") or 0) % 4 != 0
    ):
        _apply_first_beat(0.0, "snap-zero-phase")
        next_result["barBeatOffset"] = 0
        return next_result

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


def apply_frame_center_phase_rescue_to_result(result: dict[str, Any]) -> dict[str, Any]:
    bpm = float(result.get("bpm") or 0.0)
    if not math.isfinite(bpm) or bpm <= 0.0:
        return result
    if abs(bpm - round(bpm)) > 0.000001:
        return result

    anchor_correction_ms = float(result.get("anchorCorrectionMs") or 0.0)
    if abs(anchor_correction_ms) > 0.001:
        return result

    raw_first_beat_ms = _present_float(result, "rawFirstBeatMs", 0.0)
    first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    if not math.isfinite(raw_first_beat_ms) or not math.isfinite(first_beat_ms):
        return result
    if abs(first_beat_ms - raw_first_beat_ms) > 0.001:
        return result
    if raw_first_beat_ms < 39.5:
        return result
    frame_remainder_ms = raw_first_beat_ms % 20.0
    if min(frame_remainder_ms, 20.0 - frame_remainder_ms) > 0.001:
        return result

    refinement_strategy = str(result.get("bpmRefinementStrategy") or "")
    has_bpm_rescue = refinement_strategy == "integer-envelope-rescue" or refinement_strategy.endswith(
        "bpm-envelope-rescue"
    )
    raw_bpm = float(result.get("rawBpm") or 0.0)
    is_half_bpm_rescue = (
        math.isfinite(raw_bpm)
        and raw_bpm > 0.0
        and abs(raw_bpm * 2.0 - bpm) <= max(0.12, bpm * 0.001)
    )
    beat_interval_ms = 60000.0 / bpm
    if raw_first_beat_ms > 105.5:
        if (
            raw_first_beat_ms <= 260.5
            and int(result.get("barBeatOffset") or 0) % 4 != 0
            and float(result.get("qualityScore") or 0.0) >= 0.9
            and float(result.get("beatStabilityScore") or 0.0) >= 0.9
        ):
            next_result = _update_first_beat(
                result,
                normalize_phase_ms(first_beat_ms - 2.0, beat_interval_ms),
                beat_interval_ms,
                "frame-edge",
            )
            next_result["phaseRefinementStrategy"] = "frame-edge-rescue"
            return next_result
        return result

    if refinement_strategy == "double-bpm-envelope-rescue" or is_half_bpm_rescue:
        shift_ms = -14.0
    elif 39.5 <= raw_first_beat_ms <= 40.5:
        shift_ms = -4.0 if float(result.get("anchorConfidenceScore") or 0.0) < 0.5 else -12.0
    elif 95.0 <= raw_first_beat_ms <= 105.0:
        shift_ms = -5.0
    else:
        shift_ms = -9.0
    updated_first_beat_ms = normalize_phase_ms(first_beat_ms + shift_ms, beat_interval_ms)

    next_result = _update_first_beat(
        result,
        updated_first_beat_ms,
        beat_interval_ms,
        "frame-center",
    )
    next_result["phaseRefinementStrategy"] = "frame-center-rescue"
    return next_result
