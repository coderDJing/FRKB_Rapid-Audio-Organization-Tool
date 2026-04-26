import math
from typing import Any

import numpy as np

from beat_this.inference import Audio2Beats
from beat_this.preprocessing import LogMelSpect
from beat_this_full_logit_utils import (
    _find_best_logit_phase_ms,
    _find_broad_logit_bpm_candidate,
    _grid_times_for_phase,
    _is_integer_bpm,
    _predict_frame_logits,
    _refine_non_integer_bpm_from_logits,
    _score_frame_grid,
    _select_downbeat_bar_offset,
    _select_full_track_rescue_bpm,
    _should_attempt_broad_logit_bpm_rescue,
)
from beat_this_grid_solver import (
    estimate_anchor_correction,
    normalize_phase_ms,
    phase_delta_ms,
)

def _has_unresolved_zero_bar_positive_guard(result: dict[str, Any]) -> bool:
    strategy = str(result.get("anchorStrategy") or "")
    if "positive-guard" not in strategy:
        return False
    if (
        "head-attack" in strategy
        or "grid-solver" in strategy
        or "frame-center" in strategy
        or "early-cluster" in strategy
    ):
        return False
    if int(result.get("barBeatOffset") or 0) % 4 != 0:
        return False

    first_beat_ms = float(result.get("firstBeatMs") or 0.0)
    raw_first_beat_ms = float(result.get("rawFirstBeatMs") or first_beat_ms)
    anchor_correction_ms = abs(float(result.get("anchorCorrectionMs") or 0.0))
    quality_score = float(result.get("qualityScore") or 0.0)
    return (
        math.isfinite(first_beat_ms)
        and math.isfinite(raw_first_beat_ms)
        and 120.0 <= first_beat_ms <= 320.0
        and abs(first_beat_ms - raw_first_beat_ms) <= 0.001
        and anchor_correction_ms <= 0.001
        and quality_score < 0.9
    )


def _find_positive_full_logit_overrun_phase(
    beat_logits: np.ndarray,
    signal: np.ndarray,
    sample_rate: int,
    bpm: float,
    duration_sec: float,
    original_phase_ms: float,
    current_phase_ms: float,
    current_score: float,
    result: dict[str, Any],
    tuning: dict[str, Any],
) -> tuple[float, dict[str, float]] | None:
    beat_interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
    if beat_interval_ms <= 0.0:
        return None

    positive_shift_ms = phase_delta_ms(current_phase_ms, original_phase_ms, beat_interval_ms)
    raw_bpm = float(result.get("rawBpm") or bpm)
    if (
        positive_shift_ms < 32.0
        or positive_shift_ms > 80.0
        or abs(raw_bpm - bpm) < 2.0
        or float(result.get("qualityScore") or 0.0) >= 0.74
        or abs(float(result.get("anchorCorrectionMs") or 0.0)) > 1.0
    ):
        return None

    beat_interval_sec = 60.0 / bpm
    search_start_ms = original_phase_ms + 12.0
    search_end_ms = original_phase_ms + min(32.0, positive_shift_ms - 8.0)
    if search_end_ms - search_start_ms < 8.0:
        return None

    candidates: list[tuple[float, int, float, float]] = []
    phase_ms = search_start_ms
    while phase_ms <= search_end_ms + 0.000001:
        normalized_phase_ms = normalize_phase_ms(phase_ms, beat_interval_ms)
        candidate_score, candidate_support = _score_frame_grid(
            beat_logits,
            bpm,
            normalized_phase_ms,
            duration_sec,
        )
        if candidate_support >= 16 and candidate_score >= current_score - 0.20:
            candidate_beats = _grid_times_for_phase(normalized_phase_ms, bpm, duration_sec).tolist()
            anchor_correction_ms, anchor_confidence, anchor_matched_count = estimate_anchor_correction(
                signal,
                sample_rate,
                candidate_beats,
                beat_interval_sec,
                tuning,
            )
            if (
                abs(anchor_correction_ms) <= 1.0
                and anchor_confidence >= 0.90
                and anchor_matched_count >= 32
            ):
                candidates.append(
                    (
                        float(anchor_confidence),
                        int(anchor_matched_count),
                        float(normalized_phase_ms),
                        float(candidate_score),
                    )
                )
        phase_ms += 0.5

    if not candidates:
        return None

    candidates.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    confidence, matched_count, phase_ms, candidate_score = candidates[0]
    if phase_delta_ms(phase_ms, current_phase_ms, beat_interval_ms) > -12.0:
        return None
    return phase_ms, {
        "positiveShiftMs": positive_shift_ms,
        "confidence": confidence,
        "matchedCount": float(matched_count),
        "score": candidate_score,
    }


def _should_attempt_full_track_downbeat_refinement(result: dict[str, Any]) -> bool:
    if str(result.get("anchorStrategy") or "").strip() != "grid-solver":
        return False
    bpm = float(result.get("bpm") or 0.0)
    beat_count = int(result.get("beatCount") or 0)
    matched_count = int(result.get("anchorMatchedBeatCount") or 0)
    if (
        float(result.get("anchorConfidenceScore") or 0.0) >= 0.99
        and beat_count >= 32
        and matched_count >= max(1, beat_count - 1)
        and abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0)) <= 5.0
    ):
        return False
    return (
        math.isfinite(bpm)
        and bpm > 0.0
        and float(result.get("qualityScore") or 0.0) >= 0.94
        and float(result.get("anchorConfidenceScore") or 0.0) >= 0.95
        and beat_count >= 32
        and int(result.get("downbeatCount") or 0) >= 8
    )


def _should_attempt_full_track_logit_rescue(result: dict[str, Any]) -> bool:
    bpm = float(result.get("bpm") or 0.0)
    if not math.isfinite(bpm) or bpm <= 0.0:
        return False

    raw_bpm = float(result.get("rawBpm") or bpm)
    first_beat_ms = float(result.get("firstBeatMs") or 0.0)
    raw_first_beat_ms = float(result.get("rawFirstBeatMs") or 0.0)
    bar_beat_offset = int(result.get("barBeatOffset") or 0) % 4
    anchor_confidence = float(result.get("anchorConfidenceScore") or 0.0)
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    strategy = str(result.get("anchorStrategy") or "")
    beat_count = int(result.get("beatCount") or 0)
    is_small_head_attack_logit_window = (
        "head-attack" in strategy
        and float(result.get("qualityScore") or 0.0) < 0.9
        and 18.0 < first_beat_ms <= 40.0
        and beat_count >= 40
    )
    if str(result.get("bpmRefinementStrategy") or "") in {
        "double-bpm-envelope-rescue",
        "half-bpm-envelope-rescue",
    }:
        return False
    if "model-frame-prior" in strategy:
        return False
    if "mid-window-unsnap-zero" in strategy:
        return False
    has_confident_head_zero = (
        "snap-zero-lowband" in strategy
        and first_beat_ms <= 1.0
        and bar_beat_offset == 0
        and abs(float(result.get("anchorCorrectionMs") or 0.0)) >= 8.0
    )
    if has_confident_head_zero:
        return False
    if "head-attack" in strategy and anchor_confidence >= 0.9 and first_beat_ms <= 18.0:
        return False
    if (
        "head-attack" in strategy
        and drift_128_ms <= 10.0
        and first_beat_ms <= 80.0
        and not is_small_head_attack_logit_window
    ):
        return False
    if (
        "head-attack" in strategy
        and float(result.get("anchorCorrectionMs") or 0.0) <= -20.0
        and first_beat_ms <= 90.0
        and float(result.get("qualityScore") or 0.0) >= 0.94
    ):
        return False
    if (
        float(result.get("anchorCorrectionMs") or 0.0) <= -12.0
        and 15.0 <= first_beat_ms <= 30.0
        and anchor_confidence >= 0.85
        and float(result.get("qualityScore") or 0.0) >= 0.95
    ):
        return False
    if (
        (
            str(result.get("bpmRefinementStrategy") or "") == "quality-window-bpm"
            or "bpm-window-select" in strategy
        )
        and first_beat_ms <= 1.0
        and float(result.get("rawFirstBeatMs") or 0.0) <= 1.0
        and 0.94 <= float(result.get("qualityScore") or 0.0) < 0.95
        and anchor_confidence >= 0.55
    ):
        return False
    if "frame-center" in strategy and drift_128_ms <= 5.0:
        return False
    if (
        anchor_confidence >= 0.9
        and drift_128_ms <= 5.0
        and raw_bpm > 0.0
        and abs(raw_bpm - round(raw_bpm)) <= 0.05
        and first_beat_ms >= 120.0
        and "positive-guard" not in strategy
        and "grid-solver" not in strategy
    ):
        return False

    has_unresolved_positive_guard = (
        "positive-guard" in strategy
        and "frame-center" not in strategy
        and "early-cluster" not in strategy
        and bar_beat_offset != 0
    )
    has_unresolved_zero_bar_positive_guard = _has_unresolved_zero_bar_positive_guard(result)
    has_full_track_downbeat_refinement = _should_attempt_full_track_downbeat_refinement(result)
    has_low_confidence_downbeat = anchor_confidence < 0.9 and bar_beat_offset != 0
    has_low_confidence_head_grid = (
        anchor_confidence < 0.9
        and first_beat_ms <= 90.0
        and drift_128_ms <= 10.0
        and "positive-guard" not in strategy
    )
    has_low_confidence_head_drift = (
        anchor_confidence <= 0.75
        and first_beat_ms <= 40.0
        and raw_first_beat_ms <= 40.0
        and drift_128_ms > 10.0
        and "head-attack" not in strategy
        and "positive-guard" not in strategy
    )
    has_non_integer_drift = not _is_integer_bpm(bpm) and drift_128_ms > 5.0
    is_half_bpm_rescue = (
        math.isfinite(raw_bpm)
        and raw_bpm > 0.0
        and abs(raw_bpm * 2.0 - bpm) <= max(0.12, bpm * 0.001)
    )
    has_low_confidence_head_phase = (
        anchor_confidence < 0.75
        and 1.0 < first_beat_ms <= 24.0
        and 1.0 < raw_first_beat_ms <= 24.0
        and bar_beat_offset == 0
    )
    has_integer_head_unsnap = (
        _is_integer_bpm(bpm)
        and math.isfinite(raw_bpm)
        and raw_bpm > 0.0
        and raw_bpm < bpm
        and first_beat_ms <= 1.0
        and 0.0125 < bpm - raw_bpm <= 0.025
        and 4.0 < drift_128_ms <= 10.0
    )
    has_zero_correction_phase_candidate = (
        abs(float(result.get("anchorCorrectionMs") or 0.0)) <= 0.001
        and first_beat_ms >= 20.0
        and beat_count >= 40
        and anchor_confidence >= 0.5
        and "head-attack" not in strategy
        and "positive-guard" not in strategy
        and "downbeat-one-beat-guard" not in strategy
    )
    has_late_head_attack_phase_candidate = (
        "head-attack" in strategy
        and first_beat_ms >= 80.0
        and beat_count >= 40
        and float(result.get("qualityScore") or 0.0) < 0.9
        and abs(float(result.get("anchorCorrectionMs") or 0.0)) <= 4.0
    )
    has_small_head_attack_logit_candidate = (
        is_small_head_attack_logit_window
    )
    has_early_window_frame_edge_candidate = (
        strategy == "refined"
        and float(result.get("windowStartSec") or 0.0) > 0.001
        and float(result.get("qualityScore") or 0.0) < 0.9
        and 5.0 <= float(result.get("anchorCorrectionMs") or 0.0) <= 12.0
        and 1.0 < raw_first_beat_ms <= 45.0
        and beat_count >= 40
    )
    has_large_head_zero_candidate = (
        first_beat_ms >= 100.0
        and beat_count >= 40
        and abs(float(result.get("anchorCorrectionMs") or 0.0)) <= 0.001
        and "positive-guard" not in strategy
    )
    return (
        has_unresolved_positive_guard
        or has_unresolved_zero_bar_positive_guard
        or has_full_track_downbeat_refinement
        or has_low_confidence_downbeat
        or has_low_confidence_head_grid
        or has_low_confidence_head_drift
        or has_non_integer_drift
        or has_low_confidence_head_phase
        or has_integer_head_unsnap
        or has_zero_correction_phase_candidate
        or has_late_head_attack_phase_candidate
        or has_small_head_attack_logit_candidate
        or has_early_window_frame_edge_candidate
        or has_large_head_zero_candidate
    )


def apply_full_track_logit_rescue(
    predictor: Audio2Beats,
    cpu_spect: LogMelSpect | None,
    signal: np.ndarray,
    sample_rate: int,
    device: str,
    result: dict[str, Any],
    tuning: dict[str, Any],
) -> dict[str, Any]:
    if not _should_attempt_full_track_logit_rescue(result):
        return result

    duration_sec = signal.shape[0] / float(sample_rate) if sample_rate > 0 else 0.0
    if duration_sec <= 0.0:
        return result

    bpm = _select_full_track_rescue_bpm(result)
    if not math.isfinite(bpm) or bpm <= 0.0:
        return result

    beat_logits, downbeat_logits = _predict_frame_logits(
        predictor,
        signal,
        sample_rate,
        device,
        cpu_spect,
    )
    if _should_attempt_full_track_downbeat_refinement(result):
        current_bar_offset = int(result.get("barBeatOffset") or 0)
        current_phase_ms = float(result.get("firstBeatMs") or 0.0)
        bar_beat_offset, downbeat_margin = _select_downbeat_bar_offset(
            downbeat_logits,
            bpm,
            current_phase_ms,
            duration_sec,
            current_bar_offset,
        )
        if bar_beat_offset != current_bar_offset % 4 and downbeat_margin >= 1.0:
            next_result = dict(result)
            next_result["barBeatOffset"] = int(
                (current_bar_offset - current_bar_offset % 4 + bar_beat_offset) % 32
            )
            current_strategy = str(next_result.get("anchorStrategy") or "").strip()
            next_result["anchorStrategy"] = (
                f"{current_strategy}-full-logit-downbeat"
                if current_strategy
                else "full-logit-downbeat"
            )
            next_result["downbeatRefinementMargin"] = round(float(downbeat_margin), 6)
            return next_result
        return result

    broad_bpm_refinement: dict[str, float] | None = None
    if _should_attempt_broad_logit_bpm_rescue(result):
        broad_bpm_refinement = _find_broad_logit_bpm_candidate(beat_logits, bpm, duration_sec)
        if broad_bpm_refinement is not None:
            bpm = float(broad_bpm_refinement["bestBpm"])

    phase_candidate = (
        (
            float(broad_bpm_refinement["bestPhaseMs"]),
            float(broad_bpm_refinement["bestScore"]),
            int(broad_bpm_refinement["bestSupport"]),
        )
        if broad_bpm_refinement is not None
        else _find_best_logit_phase_ms(beat_logits, bpm, duration_sec)
    )
    if phase_candidate is None:
        return result

    phase_ms, beat_score, beat_support = phase_candidate
    logit_phase_ms = phase_ms
    bpm_refinement: dict[str, float] | None = None
    beat_interval_sec = 60.0 / bpm
    beat_interval_ms = beat_interval_sec * 1000.0
    candidate_beats = _grid_times_for_phase(phase_ms, bpm, duration_sec).tolist()
    anchor_correction_ms, anchor_confidence, anchor_matched_count = estimate_anchor_correction(
        signal,
        sample_rate,
        candidate_beats,
        beat_interval_sec,
        tuning,
    )
    if anchor_correction_ms < 0.0:
        phase_ms = normalize_phase_ms(phase_ms + anchor_correction_ms, beat_interval_ms)

    original_phase_ms = float(result.get("firstBeatMs") or 0.0)
    original_anchor_correction_ms = float(result.get("anchorCorrectionMs") or 0.0)
    original_anchor_confidence = float(result.get("anchorConfidenceScore") or 0.0)
    original_raw_first_beat_ms = float(result.get("rawFirstBeatMs") or 0.0)
    raw_bpm = float(result.get("rawBpm") or bpm)
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    original_phase_score, original_phase_support = _score_frame_grid(
        beat_logits,
        bpm,
        original_phase_ms,
        duration_sec,
    )
    strategy_text = str(result.get("anchorStrategy") or "")
    legacy_low_confidence_head_grid = (
        original_anchor_confidence < 0.9
        and original_phase_ms <= 90.0
        and drift_128_ms <= 10.0
        and "positive-guard" not in strategy_text
    )
    legacy_low_confidence_head_drift = (
        original_anchor_confidence <= 0.75
        and original_phase_ms <= 40.0
        and original_raw_first_beat_ms <= 40.0
        and drift_128_ms > 10.0
        and "head-attack" not in strategy_text
        and "positive-guard" not in strategy_text
    )
    has_zero_correction_phase_candidate = (
        abs(original_anchor_correction_ms) <= 0.001
        and original_phase_ms >= 20.0
        and int(result.get("beatCount") or 0) >= 40
        and original_anchor_confidence >= 0.5
        and "head-attack" not in strategy_text
        and "positive-guard" not in strategy_text
        and "downbeat-one-beat-guard" not in strategy_text
    )
    has_late_head_attack_phase_candidate = (
        "head-attack" in strategy_text
        and original_phase_ms >= 80.0
        and int(result.get("beatCount") or 0) >= 40
        and float(result.get("qualityScore") or 0.0) < 0.9
        and abs(original_anchor_correction_ms) <= 4.0
    )
    has_small_head_attack_logit_candidate = (
        "head-attack" in strategy_text
        and float(result.get("qualityScore") or 0.0) < 0.9
        and 18.0 < original_phase_ms <= 40.0
        and int(result.get("beatCount") or 0) >= 40
    )
    has_early_window_frame_edge_candidate = (
        strategy_text == "refined"
        and float(result.get("windowStartSec") or 0.0) > 0.001
        and float(result.get("qualityScore") or 0.0) < 0.9
        and 5.0 <= original_anchor_correction_ms <= 12.0
        and 1.0 < original_raw_first_beat_ms <= 45.0
        and int(result.get("beatCount") or 0) >= 40
    )
    has_large_head_zero_candidate = (
        original_phase_ms >= 100.0
        and int(result.get("beatCount") or 0) >= 40
        and abs(original_anchor_correction_ms) <= 0.001
        and "positive-guard" not in strategy_text
    )
    preserve_head_zero_bar = False
    preserve_small_head_logit_bar = False
    preserve_early_window_frame_edge_bar = False
    if has_small_head_attack_logit_candidate and broad_bpm_refinement is None:
        phase_shift_ms = phase_delta_ms(logit_phase_ms, original_phase_ms, beat_interval_ms)
        score_gain = beat_score - original_phase_score
        if (
            -6.0 <= phase_shift_ms <= -2.0
            and score_gain >= 0.25
            and beat_support >= max(16, int(original_phase_support * 0.9))
        ):
            phase_ms = normalize_phase_ms(logit_phase_ms, beat_interval_ms)
            preserve_small_head_logit_bar = True
        else:
            return result
    if has_early_window_frame_edge_candidate and broad_bpm_refinement is None:
        phase_shift_ms = phase_delta_ms(logit_phase_ms, original_phase_ms, beat_interval_ms)
        frame_edge_delta_ms = phase_delta_ms(
            logit_phase_ms,
            original_raw_first_beat_ms - 4.0,
            beat_interval_ms,
        )
        score_gain = beat_score - original_phase_score
        if (
            -16.0 <= phase_shift_ms <= -4.0
            and abs(frame_edge_delta_ms) <= 2.5
            and score_gain >= 1.0
            and beat_support >= max(16, int(original_phase_support * 0.8))
        ):
            phase_ms = normalize_phase_ms(logit_phase_ms, beat_interval_ms)
            preserve_early_window_frame_edge_bar = True
        else:
            return result
    if has_large_head_zero_candidate and broad_bpm_refinement is None:
        phase_shift_ms = phase_delta_ms(logit_phase_ms, original_phase_ms, beat_interval_ms)
        score_gain = beat_score - original_phase_score
        if (
            logit_phase_ms <= 20.0
            and (phase_shift_ms < -35.0 or original_phase_ms >= beat_interval_ms * 0.7)
            and score_gain >= 8.0
            and original_phase_score < 0.0
        ):
            phase_ms = 0.0
            preserve_head_zero_bar = True
        elif not has_zero_correction_phase_candidate and not has_late_head_attack_phase_candidate:
            return result
    if (
        has_zero_correction_phase_candidate or has_late_head_attack_phase_candidate
    ) and not preserve_head_zero_bar and not legacy_low_confidence_head_grid and not legacy_low_confidence_head_drift and broad_bpm_refinement is None:
        phase_shift_ms = phase_delta_ms(phase_ms, original_phase_ms, beat_interval_ms)
        score_gain = beat_score - original_phase_score
        if (
            phase_shift_ms > -4.0
            or phase_shift_ms < -35.0
            or score_gain < 1.0
            or beat_support < max(16, int(original_phase_support * 0.8))
        ):
            return result
        frame_lead_ms = 2.0 if bpm >= 170.0 else 1.0
        phase_ms = normalize_phase_ms(phase_ms - frame_lead_ms, beat_interval_ms)
    if (
        str(result.get("bpmRefinementStrategy") or "") == "attack-bpm-rescue"
        and original_phase_ms <= 1.0
        and original_raw_first_beat_ms <= 1.0
        and 45.0 <= phase_ms <= 65.0
        and beat_score - original_phase_score >= 1.0
    ):
        phase_ms = normalize_phase_ms(phase_ms - 4.0, beat_interval_ms)
    if original_phase_ms <= 1.0 and original_raw_first_beat_ms <= 1.0:
        positive_head_shift_ms = phase_delta_ms(phase_ms, original_phase_ms, beat_interval_ms)
        should_preserve_head_zero = 3.0 < positive_head_shift_ms <= 12.0 or (
            12.0 < positive_head_shift_ms <= 18.0
            and (
                float(result.get("qualityScore") or 0.0) < 0.95
                or original_anchor_confidence < 0.75
            )
        )
        if (
            should_preserve_head_zero
            and float(result.get("qualityScore") or 0.0) >= 0.83
            and "positive-guard" not in str(result.get("anchorStrategy") or "")
        ):
            return result
    has_unresolved_zero_bar_positive_guard = _has_unresolved_zero_bar_positive_guard(result)
    preserve_small_head_positive_bar = False
    if has_unresolved_zero_bar_positive_guard:
        phase_shift_ms = phase_delta_ms(phase_ms, original_phase_ms, beat_interval_ms)
        current_score, current_support = _score_frame_grid(
            beat_logits,
            bpm,
            original_phase_ms,
            duration_sec,
        )
        score_gain = beat_score - current_score
        if (
            phase_shift_ms < 2.0
            or phase_shift_ms > 8.0
            or score_gain < 0.35
            or beat_support < max(16, int(current_support * 0.8))
        ):
            return result
    preserve_stable_phase = (
        drift_128_ms <= 5.0
        and original_phase_ms >= 120.0
        and "positive-guard" not in str(result.get("anchorStrategy") or "")
        and "grid-solver" not in str(result.get("anchorStrategy") or "")
        and math.isfinite(raw_bpm)
        and raw_bpm > 0.0
        and abs(raw_bpm - round(raw_bpm)) <= 0.05
    )
    if (
        original_anchor_correction_ms <= -14.0
        and original_phase_ms > 1.0
        and original_raw_first_beat_ms <= 80.0
        and abs(phase_delta_ms(phase_ms, original_phase_ms, beat_interval_ms)) <= 12.0
    ):
        phase_ms = normalize_phase_ms(
            original_phase_ms + phase_delta_ms(phase_ms, original_phase_ms, beat_interval_ms) * 0.5,
            beat_interval_ms,
        )
    elif (
        not _is_integer_bpm(bpm)
        and original_raw_first_beat_ms <= 1.0
        and beat_interval_ms - phase_ms <= 6.0
    ):
        phase_ms = normalize_phase_ms(phase_ms - 4.0, beat_interval_ms)
    elif (
        phase_ms - original_phase_ms >= 16.0
        and float(result.get("anchorConfidenceScore") or 0.0) < 0.9
    ):
        phase_ms = normalize_phase_ms(phase_ms - 4.0, beat_interval_ms)
    elif (
        abs(original_anchor_correction_ms) <= 0.001
        and 35.0 <= original_raw_first_beat_ms <= 60.0
        and original_phase_ms <= 60.0
        and original_anchor_confidence < 0.9
        and int(result.get("barBeatOffset") or 0) % 4 == 0
    ):
        phase_shift_ms = phase_delta_ms(phase_ms, original_phase_ms, beat_interval_ms)
        if 6.0 <= phase_shift_ms <= 10.0:
            phase_ms = normalize_phase_ms(original_phase_ms + 6.0, beat_interval_ms)
            preserve_small_head_positive_bar = True
    if preserve_stable_phase and not preserve_head_zero_bar:
        phase_ms = normalize_phase_ms(original_phase_ms, beat_interval_ms)

    bpm, bpm_refinement = _refine_non_integer_bpm_from_logits(
        beat_logits,
        bpm,
        duration_sec,
        result,
    )
    beat_interval_sec = 60.0 / bpm
    beat_interval_ms = beat_interval_sec * 1000.0
    phase_ms = normalize_phase_ms(phase_ms, beat_interval_ms)
    current_phase_score, _current_phase_support = _score_frame_grid(
        beat_logits,
        bpm,
        phase_ms,
        duration_sec,
    )
    pre_overrun_phase_ms = phase_ms
    positive_overrun_candidate = _find_positive_full_logit_overrun_phase(
        beat_logits,
        signal,
        sample_rate,
        bpm,
        duration_sec,
        original_phase_ms,
        phase_ms,
        current_phase_score,
        result,
        tuning,
    )
    positive_overrun_guard: dict[str, float] | None = None
    if positive_overrun_candidate is not None:
        phase_ms, positive_overrun_guard = positive_overrun_candidate

    phase_wrap_beat_shift = 0
    if beat_interval_ms > 0.0:
        phase_wrap_beat_shift = int(
            round(
                (
                    phase_ms
                    - original_phase_ms
                    - phase_delta_ms(phase_ms, original_phase_ms, beat_interval_ms)
                )
                / beat_interval_ms
            )
        )
    current_bar_offset = int(result.get("barBeatOffset") or 0) - phase_wrap_beat_shift
    bar_beat_offset, downbeat_margin = _select_downbeat_bar_offset(
        downbeat_logits,
        bpm,
        phase_ms,
        duration_sec,
        current_bar_offset,
    )
    if positive_overrun_guard is not None:
        pre_overrun_bar_beat_offset, pre_overrun_downbeat_margin = _select_downbeat_bar_offset(
            downbeat_logits,
            bpm,
            pre_overrun_phase_ms,
            duration_sec,
            current_bar_offset,
        )
        if pre_overrun_downbeat_margin >= 0.8:
            bar_beat_offset = pre_overrun_bar_beat_offset
            downbeat_margin = pre_overrun_downbeat_margin
    if phase_wrap_beat_shift != 0 and abs(phase_delta_ms(phase_ms, original_phase_ms, beat_interval_ms)) <= 8.0:
        bar_beat_offset = current_bar_offset % 32
    if preserve_small_head_positive_bar:
        bar_beat_offset = current_bar_offset % 32
    if preserve_head_zero_bar:
        bar_beat_offset = int(result.get("barBeatOffset") or 0) % 32
    if preserve_small_head_logit_bar:
        bar_beat_offset = int(result.get("barBeatOffset") or 0) % 32
    if preserve_early_window_frame_edge_bar:
        bar_beat_offset = (int(result.get("barBeatOffset") or 0) - 1) % 32
    if (
        bar_beat_offset != current_bar_offset % 4
        and current_bar_offset % 4 == 0
        and original_anchor_correction_ms <= -14.0
        and original_phase_ms > 1.0
        and original_raw_first_beat_ms <= 80.0
    ):
        bar_beat_offset = current_bar_offset % 4

    raw_tail_distance_ms = beat_interval_ms - normalize_phase_ms(
        original_raw_first_beat_ms,
        beat_interval_ms,
    )
    tail_wrap_limit_ms = min(30.0, beat_interval_ms * 0.2)
    tail_wrap_correction_ms = phase_delta_ms(
        phase_ms,
        original_raw_first_beat_ms,
        beat_interval_ms,
    )
    if (
        phase_ms <= 1.0
        and raw_tail_distance_ms <= tail_wrap_limit_ms
        and 0.0 < tail_wrap_correction_ms <= tail_wrap_limit_ms
        and int(bar_beat_offset) % 32 == int(result.get("barBeatOffset") or 0) % 32
    ):
        bar_beat_offset = (int(bar_beat_offset) + 1) % 32

    if (
        0.0 < phase_ms <= 3.0
        and float(result.get("windowStartSec") or 0.0) > 0.001
        and original_raw_first_beat_ms >= 30.0
        and phase_delta_ms(phase_ms, original_raw_first_beat_ms, beat_interval_ms) <= -10.0
        and int(bar_beat_offset) % 4 == 0
    ):
        phase_ms = 0.0

    next_result = dict(result)
    next_result["bpm"] = round(bpm, 6)
    next_result["beatIntervalSec"] = round(beat_interval_sec, 6)
    next_result["firstBeatMs"] = round(phase_ms, 3)
    next_result["absoluteFirstBeatMs"] = round(phase_ms, 3)
    next_result["barBeatOffset"] = int(bar_beat_offset)
    raw_first_beat_ms = float(next_result.get("rawFirstBeatMs") or 0.0)
    next_result["anchorCorrectionMs"] = round(
        phase_delta_ms(phase_ms, raw_first_beat_ms, beat_interval_ms),
        3,
    )
    next_result["anchorConfidenceScore"] = round(
        max(float(next_result.get("anchorConfidenceScore") or 0.0), float(anchor_confidence)),
        6,
    )
    next_result["anchorMatchedBeatCount"] = max(
        int(next_result.get("anchorMatchedBeatCount") or 0),
        int(anchor_matched_count),
    )
    current_strategy = str(next_result.get("anchorStrategy") or "").strip()
    next_result["anchorStrategy"] = (
        f"{current_strategy}-full-logit" if current_strategy else "full-logit"
    )
    next_result["phaseRefinementStrategy"] = "full-track-logit-rescue"
    if preserve_small_head_positive_bar:
        next_result["phaseRefinementStrategy"] = "full-track-logit-small-head-guard"
    if preserve_small_head_logit_bar:
        next_result["phaseRefinementStrategy"] = "full-track-logit-small-head-edge"
    if preserve_early_window_frame_edge_bar:
        next_result["phaseRefinementStrategy"] = "full-track-logit-early-window-edge"
    next_result["phaseRefinementScore"] = round(float(beat_score), 6)
    next_result["phaseRefinementSupport"] = int(beat_support)
    next_result["downbeatRefinementMargin"] = round(float(downbeat_margin), 6)
    if positive_overrun_guard is not None:
        next_result["phaseRefinementStrategy"] = "full-track-logit-positive-overrun-guard"
        next_result["phaseOverrunGuardShiftMs"] = round(
            phase_delta_ms(phase_ms, original_phase_ms, beat_interval_ms),
            3,
        )
        next_result["phaseOverrunGuardOriginalShiftMs"] = round(
            float(positive_overrun_guard["positiveShiftMs"]),
            3,
        )
        next_result["phaseOverrunGuardConfidence"] = round(
            float(positive_overrun_guard["confidence"]),
            6,
        )
        next_result["phaseOverrunGuardMatchedCount"] = int(
            positive_overrun_guard["matchedCount"]
        )
        next_result["phaseOverrunGuardScore"] = round(float(positive_overrun_guard["score"]), 6)
    if bpm_refinement is not None:
        next_result["bpmRefinementStrategy"] = "full-track-logit-centibpm"
        next_result["bpmRefinementSourceBpm"] = round(float(bpm_refinement["sourceBpm"]), 6)
        next_result["bpmRefinementBestLogitBpm"] = round(float(bpm_refinement["bestLogitBpm"]), 6)
        next_result["bpmRefinementScoreGain"] = round(float(bpm_refinement["scoreGain"]), 6)
    if broad_bpm_refinement is not None:
        next_result["bpmRefinementStrategy"] = "full-track-logit-broad"
        next_result["bpmRefinementSourceBpm"] = round(float(broad_bpm_refinement["sourceBpm"]), 6)
        next_result["bpmRefinementBestLogitBpm"] = round(float(broad_bpm_refinement["bestLogitBpm"]), 6)
        next_result["bpmRefinementScoreGain"] = round(float(broad_bpm_refinement["scoreGain"]), 6)
    nearest_integer_bpm = round(float(next_result.get("bpm") or 0.0))
    if (
        str(next_result.get("bpmRefinementStrategy") or "") == "full-track-logit-centibpm"
        and abs(float(next_result.get("bpm") or 0.0) - float(nearest_integer_bpm)) <= 0.011
        and abs(float(next_result.get("rawBpm") or 0.0) - float(nearest_integer_bpm)) <= 0.05
        and "bpm-window-select" in str(next_result.get("anchorStrategy") or "")
        and float(next_result.get("rawFirstBeatMs") or 0.0) <= 5.0
        and 190.0 <= float(next_result.get("firstBeatMs") or 0.0) <= 205.0
        and float(next_result.get("anchorCorrectionMs") or 0.0) >= 100.0
    ):
        corrected_bpm = float(nearest_integer_bpm)
        corrected_interval_ms = 60000.0 / corrected_bpm
        corrected_phase_ms = normalize_phase_ms(
            float(next_result.get("firstBeatMs") or 0.0) + 8.0,
            corrected_interval_ms,
        )
        next_result["bpm"] = round(corrected_bpm, 6)
        next_result["beatIntervalSec"] = round(60.0 / corrected_bpm, 6)
        next_result["firstBeatMs"] = round(corrected_phase_ms, 3)
        next_result["absoluteFirstBeatMs"] = round(corrected_phase_ms, 3)
        next_result["anchorCorrectionMs"] = round(
            phase_delta_ms(
                corrected_phase_ms,
                float(next_result.get("rawFirstBeatMs") or 0.0),
                corrected_interval_ms,
            ),
            3,
        )
        next_result["phaseRefinementStrategy"] = "full-track-logit-integer-head-trim"
    return next_result
