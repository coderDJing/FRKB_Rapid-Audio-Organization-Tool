import math
from typing import Any

import numpy as np
import soxr
import torch

from beat_this.inference import Audio2Beats, split_predict_aggregate
from beat_this.preprocessing import LogMelSpect
from beat_this_grid_solver import (
    estimate_anchor_correction,
    normalize_phase_ms,
    phase_delta_ms,
)


def _uses_accelerated_device(device: str) -> bool:
    normalized = str(device or "").strip().lower()
    return normalized not in {"", "cpu"}


def _predict_frame_logits_with_accelerated_device(
    predictor: Audio2Beats,
    cpu_spect: LogMelSpect,
    signal: np.ndarray,
    sample_rate: int,
) -> tuple[np.ndarray, np.ndarray]:
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

    return (
        beat_logits.detach().cpu().numpy().astype("float64", copy=False),
        downbeat_logits.detach().cpu().numpy().astype("float64", copy=False),
    )


def _predict_frame_logits(
    predictor: Audio2Beats,
    signal: np.ndarray,
    sample_rate: int,
    device: str,
    cpu_spect: LogMelSpect | None,
) -> tuple[np.ndarray, np.ndarray]:
    if cpu_spect is not None and _uses_accelerated_device(device):
        return _predict_frame_logits_with_accelerated_device(
            predictor,
            cpu_spect,
            signal,
            sample_rate,
        )

    spect = predictor.signal2spect(signal, sample_rate)
    beat_logits, downbeat_logits = predictor.spect2frames(spect)
    return (
        beat_logits.detach().cpu().numpy().astype("float64", copy=False),
        downbeat_logits.detach().cpu().numpy().astype("float64", copy=False),
    )


def _sample_frame_values(frame_values: np.ndarray, times_sec: np.ndarray) -> np.ndarray:
    if frame_values.size == 0 or times_sec.size == 0:
        return np.asarray([], dtype="float64")
    frame_positions = times_sec.astype("float64", copy=False) * 50.0
    valid_mask = (frame_positions >= 0.0) & (frame_positions <= float(frame_values.size - 1))
    if not np.any(valid_mask):
        return np.asarray([], dtype="float64")

    valid_positions = frame_positions[valid_mask]
    left_indices = np.floor(valid_positions).astype(np.int64, copy=False)
    fractions = valid_positions - left_indices
    right_indices = np.minimum(left_indices + 1, frame_values.size - 1)
    return frame_values[left_indices] * (1.0 - fractions) + frame_values[right_indices] * fractions


def _grid_times_for_phase(
    phase_ms: float,
    bpm: float,
    duration_sec: float,
    *,
    beat_step: int = 1,
) -> np.ndarray:
    if (
        not math.isfinite(phase_ms)
        or not math.isfinite(bpm)
        or bpm <= 0.0
        or not math.isfinite(duration_sec)
        or duration_sec <= 0.0
        or beat_step <= 0
    ):
        return np.asarray([], dtype="float64")

    interval_sec = (60.0 / bpm) * float(beat_step)
    if interval_sec <= 0.0:
        return np.asarray([], dtype="float64")

    phase_sec = phase_ms / 1000.0
    start_index = int(math.ceil((-phase_sec) / interval_sec))
    end_index = int((duration_sec - phase_sec) / interval_sec) + 1
    if end_index < start_index:
        return np.asarray([], dtype="float64")

    indices = np.arange(start_index, end_index + 1, dtype="float64")
    times = phase_sec + indices * interval_sec
    return times[(times >= 0.0) & (times < duration_sec)]


def _score_frame_grid(
    frame_values: np.ndarray,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
    *,
    beat_step: int = 1,
) -> tuple[float, int]:
    times_sec = _grid_times_for_phase(phase_ms, bpm, duration_sec, beat_step=beat_step)
    values = _sample_frame_values(frame_values, times_sec)
    if values.size == 0:
        return -999.0, 0
    return float(np.mean(values)), int(values.size)


def _find_best_logit_phase_ms(
    beat_logits: np.ndarray,
    bpm: float,
    duration_sec: float,
) -> tuple[float, float, int] | None:
    if beat_logits.size == 0 or not math.isfinite(bpm) or bpm <= 0.0:
        return None

    beat_interval_ms = 60000.0 / bpm
    if not math.isfinite(beat_interval_ms) or beat_interval_ms <= 0.0:
        return None

    best_score = -999.0
    best_phase_ms = 0.0
    best_support = 0

    phase_ms = -30.0
    while phase_ms < beat_interval_ms:
        score, support = _score_frame_grid(beat_logits, bpm, phase_ms, duration_sec)
        if support >= 16 and score > best_score:
            best_score = score
            best_phase_ms = phase_ms % beat_interval_ms
            best_support = support
        phase_ms += 1.0

    phase_ms = best_phase_ms - 3.0
    while phase_ms <= best_phase_ms + 3.0:
        score, support = _score_frame_grid(beat_logits, bpm, phase_ms, duration_sec)
        if support >= 16 and score > best_score:
            best_score = score
            best_phase_ms = phase_ms % beat_interval_ms
            best_support = support
        phase_ms += 0.25

    if best_support < 16:
        return None
    return best_phase_ms, best_score, best_support


def _signed_phase_ms(phase_ms: float, beat_interval_ms: float) -> float:
    if not math.isfinite(phase_ms) or not math.isfinite(beat_interval_ms) or beat_interval_ms <= 0.0:
        return phase_ms
    normalized = phase_ms % beat_interval_ms
    return normalized - beat_interval_ms if beat_interval_ms - normalized <= 80.0 else normalized


def _score_downbeat_bars(
    downbeat_logits: np.ndarray,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
) -> list[tuple[int, float, int]]:
    beat_interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
    if beat_interval_ms <= 0.0:
        return []
    signed_phase_ms = _signed_phase_ms(phase_ms, beat_interval_ms)
    scores: list[tuple[int, float, int]] = []
    for bar_offset in range(4):
        score, support = _score_frame_grid(
            downbeat_logits,
            bpm,
            signed_phase_ms + float(bar_offset) * beat_interval_ms,
            duration_sec,
            beat_step=4,
        )
        scores.append((bar_offset, score, support))
    return scores


def _select_downbeat_bar_offset(
    downbeat_logits: np.ndarray,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
    current_bar_offset: int,
) -> tuple[int, float]:
    scores = _score_downbeat_bars(downbeat_logits, bpm, phase_ms, duration_sec)
    valid_scores = [item for item in scores if item[2] >= 4 and math.isfinite(item[1])]
    if not valid_scores:
        return current_bar_offset % 4, 0.0
    ordered = sorted(valid_scores, key=lambda item: item[1], reverse=True)
    best_bar, best_score, _support = ordered[0]
    current_score = next(
        (score for bar, score, support in valid_scores if bar == current_bar_offset % 4 and support >= 4),
        -999.0,
    )
    margin = best_score - current_score
    if best_bar != current_bar_offset % 4 and margin < 1.0:
        return current_bar_offset % 4, margin
    return best_bar % 4, margin


def _is_integer_bpm(value: float) -> bool:
    return math.isfinite(value) and abs(value - round(value)) <= 0.000001


def _select_full_track_rescue_bpm(result: dict[str, Any]) -> float:
    bpm = float(result.get("bpm") or 0.0)
    raw_bpm = float(result.get("rawBpm") or bpm)
    first_beat_ms = float(result.get("firstBeatMs") or 0.0)
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    if not math.isfinite(bpm) or bpm <= 0.0:
        return bpm
    if (
        _is_integer_bpm(bpm)
        and math.isfinite(raw_bpm)
        and raw_bpm > 0.0
        and raw_bpm < bpm
        and first_beat_ms <= 1.0
        and 0.0125 < bpm - raw_bpm <= 0.025
        and 4.0 < drift_128_ms <= 10.0
    ):
        return round(raw_bpm, 2)
    return bpm


def _is_centibpm_quantized(value: float) -> bool:
    return math.isfinite(value) and abs(value * 100.0 - round(value * 100.0)) <= 0.0001


def _refine_non_integer_bpm_from_logits(
    beat_logits: np.ndarray,
    bpm: float,
    duration_sec: float,
    result: dict[str, Any],
) -> tuple[float, dict[str, float] | None]:
    if _is_integer_bpm(bpm) or _is_centibpm_quantized(bpm):
        return bpm, None
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    if drift_128_ms < 8.0:
        return bpm, None

    current_candidate = _find_best_logit_phase_ms(beat_logits, bpm, duration_sec)
    if current_candidate is None:
        return bpm, None
    _current_phase_ms, current_score, _current_support = current_candidate

    best_bpm = bpm
    best_score = float(current_score)
    for step in range(-30, 31):
        candidate_bpm = bpm + float(step) * 0.001
        if candidate_bpm <= 0.0:
            continue
        candidate = _find_best_logit_phase_ms(beat_logits, candidate_bpm, duration_sec)
        if candidate is None:
            continue
        _phase_ms, score, _support = candidate
        if score > best_score:
            best_score = float(score)
            best_bpm = candidate_bpm

    score_gain = (best_score - float(current_score)) / max(1e-9, best_score, float(current_score))
    quantized_bpm = round(best_bpm, 2)
    if score_gain < 0.01 or abs(quantized_bpm - bpm) < 0.0005:
        return bpm, None
    return quantized_bpm, {
        "sourceBpm": bpm,
        "bestLogitBpm": best_bpm,
        "scoreGain": score_gain,
    }


def _should_attempt_broad_logit_bpm_rescue(result: dict[str, Any]) -> bool:
    bpm = float(result.get("bpm") or 0.0)
    if not math.isfinite(bpm) or bpm <= 0.0:
        return False
    quality = float(result.get("qualityScore") or 0.0)
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    beat_count = int(result.get("beatCount") or 0)
    return 90.0 <= bpm <= 180.0 and quality < 0.72 and drift_128_ms >= 1000.0 and beat_count >= 32


def _find_broad_logit_bpm_candidate(
    beat_logits: np.ndarray,
    bpm: float,
    duration_sec: float,
) -> dict[str, float] | None:
    current_candidate = _find_best_logit_phase_ms(beat_logits, bpm, duration_sec)
    if current_candidate is None:
        return None
    current_phase_ms, current_score, current_support = current_candidate

    best_bpm = bpm
    best_phase_ms = current_phase_ms
    best_score = float(current_score)
    best_support = int(current_support)

    for step in range(360):
        candidate_bpm = 90.0 + float(step) * 0.25
        candidate = _find_best_logit_phase_ms(beat_logits, candidate_bpm, duration_sec)
        if candidate is None:
            continue
        phase_ms, score, support = candidate
        if score > best_score:
            best_bpm = candidate_bpm
            best_phase_ms = phase_ms
            best_score = float(score)
            best_support = int(support)

    refined_start = best_bpm - 0.24
    for step in range(49):
        candidate_bpm = refined_start + float(step) * 0.01
        if candidate_bpm < 90.0 or candidate_bpm > 180.0:
            continue
        candidate = _find_best_logit_phase_ms(beat_logits, candidate_bpm, duration_sec)
        if candidate is None:
            continue
        phase_ms, score, support = candidate
        if score > best_score:
            best_bpm = candidate_bpm
            best_phase_ms = phase_ms
            best_score = float(score)
            best_support = int(support)

    score_gain = best_score - float(current_score)
    if score_gain < 0.12 or abs(best_bpm - bpm) < max(0.5, bpm * 0.004):
        return None

    return {
        "sourceBpm": bpm,
        "sourcePhaseMs": current_phase_ms,
        "sourceScore": float(current_score),
        "sourceSupport": float(current_support),
        "bestBpm": round(best_bpm),
        "bestLogitBpm": best_bpm,
        "bestPhaseMs": best_phase_ms,
        "bestScore": best_score,
        "bestSupport": float(best_support),
        "scoreGain": score_gain,
    }


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
    return (
        math.isfinite(bpm)
        and bpm > 0.0
        and float(result.get("qualityScore") or 0.0) >= 0.94
        and float(result.get("anchorConfidenceScore") or 0.0) >= 0.95
        and int(result.get("beatCount") or 0) >= 32
        and int(result.get("downbeatCount") or 0) >= 8
    )


def _should_attempt_full_track_logit_rescue(result: dict[str, Any]) -> bool:
    bpm = float(result.get("bpm") or 0.0)
    if not math.isfinite(bpm) or bpm <= 0.0:
        return False

    raw_bpm = float(result.get("rawBpm") or bpm)
    first_beat_ms = float(result.get("firstBeatMs") or 0.0)
    bar_beat_offset = int(result.get("barBeatOffset") or 0) % 4
    anchor_confidence = float(result.get("anchorConfidenceScore") or 0.0)
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    strategy = str(result.get("anchorStrategy") or "")
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
    has_non_integer_drift = not _is_integer_bpm(bpm) and drift_128_ms > 5.0
    is_half_bpm_rescue = (
        math.isfinite(raw_bpm)
        and raw_bpm > 0.0
        and abs(raw_bpm * 2.0 - bpm) <= max(0.12, bpm * 0.001)
    )
    has_large_negative_correction = (
        float(result.get("anchorCorrectionMs") or 0.0) <= -14.0
        and first_beat_ms > 1.0
        and float(result.get("rawFirstBeatMs") or 0.0) <= 80.0
        and drift_128_ms > 5.0
        and not is_half_bpm_rescue
    )
    has_low_confidence_head_phase = (
        anchor_confidence < 0.75
        and 1.0 < first_beat_ms <= 24.0
        and 1.0 < float(result.get("rawFirstBeatMs") or 0.0) <= 24.0
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
    return (
        has_unresolved_positive_guard
        or has_unresolved_zero_bar_positive_guard
        or has_full_track_downbeat_refinement
        or has_low_confidence_downbeat
        or has_non_integer_drift
        or has_large_negative_correction
        or has_low_confidence_head_phase
        or has_integer_head_unsnap
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

    phase_candidate = _find_best_logit_phase_ms(beat_logits, bpm, duration_sec)
    if phase_candidate is None:
        return result

    phase_ms, beat_score, beat_support = phase_candidate
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
    original_raw_first_beat_ms = float(result.get("rawFirstBeatMs") or 0.0)
    raw_bpm = float(result.get("rawBpm") or bpm)
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    has_unresolved_zero_bar_positive_guard = _has_unresolved_zero_bar_positive_guard(result)
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
    if preserve_stable_phase:
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
    if (
        bar_beat_offset != current_bar_offset % 4
        and current_bar_offset % 4 == 0
        and original_anchor_correction_ms <= -14.0
        and original_phase_ms > 1.0
        and original_raw_first_beat_ms <= 80.0
    ):
        bar_beat_offset = current_bar_offset % 4

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
    return next_result
