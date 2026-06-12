import math
import statistics
from typing import Any

import numpy as np

from beat_this_full_logit_utils import _grid_times_for_phase
from rkb_constant_grid_dp_selection import _clamp01, _round_feature

PHASE_PATH_TARGET_OFFSETS_MS = (8.0, 10.0, 12.0)


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float | None:
    if values.size == 0 or values.size != weights.size:
        return None
    total_weight = float(np.sum(weights))
    if not math.isfinite(total_weight) or total_weight <= 0.0:
        return None
    order = np.argsort(values)
    sorted_values = values[order]
    sorted_weights = weights[order]
    cumulative = np.cumsum(sorted_weights)
    index = int(np.searchsorted(cumulative, total_weight * 0.5, side="left"))
    index = max(0, min(index, sorted_values.size - 1))
    value = float(sorted_values[index])
    return value if math.isfinite(value) else None


def _empty_phase_path_stats(*, support: int = 0) -> dict[str, float | int]:
    return {
        "phasePathScore": 0.0,
        "phasePathTargetScore": 0.0,
        "phasePathSegmentAgreement": 0.0,
        "phasePathPeakScore": 0.0,
        "phasePathIntroReliability": 0.0,
        "phasePathPeakOffsetMedianMs": 999.0,
        "phasePathPeakOffsetMadMs": 999.0,
        "phasePathStableSegmentCount": 0,
        "phasePathSupport": int(support),
    }


def _score_phase_path_for_target(
    envelope: np.ndarray,
    *,
    envelope_rate: int,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
    target_peak_offset_ms: float,
    beat_limit: int = 64,
    block_size: int = 16,
) -> dict[str, float | int]:
    if envelope.size == 0 or envelope_rate <= 0 or bpm <= 0.0 or duration_sec <= 0.0:
        return _empty_phase_path_stats()

    times_sec = _grid_times_for_phase(phase_ms, bpm, min(duration_sec, 90.0))
    times_sec = times_sec[times_sec >= 0.0][:beat_limit]
    if times_sec.size < block_size:
        return _empty_phase_path_stats(support=int(times_sec.size))

    start_offset = int(round(float(envelope_rate) * -0.014))
    end_offset = int(round(float(envelope_rate) * 0.038))
    offset_step = max(1, int(round(float(envelope_rate) * 0.002)))
    offset_samples = np.arange(start_offset, end_offset + 1, offset_step, dtype="int64")
    if offset_samples.size == 0:
        return _empty_phase_path_stats()

    block_offsets: list[float] = []
    block_weights: list[float] = []
    block_scores: list[float] = []
    block_peak_scores: list[float] = []
    support = 0
    for start in range(0, int(times_sec.size), block_size):
        block_times = times_sec[start : start + block_size]
        if block_times.size < max(8, block_size // 2):
            continue
        positions = np.rint(block_times * float(envelope_rate)).astype("int64", copy=False)
        indices = positions[:, None] + offset_samples[None, :]
        valid = (indices >= 0) & (indices < envelope.size)
        if not bool(np.any(valid)):
            continue
        clipped = np.clip(indices, 0, max(0, envelope.size - 1))
        values = envelope[clipped].astype("float64", copy=False)
        values = np.where(valid, values, -np.inf)
        best_columns = np.argmax(values, axis=1)
        row_indices = np.arange(values.shape[0])
        peak_values = values[row_indices, best_columns]
        finite_mask = np.isfinite(peak_values)
        if int(np.count_nonzero(finite_mask)) < max(8, block_size // 2):
            continue
        peak_values = peak_values[finite_mask]
        peak_offsets_ms = (
            offset_samples[best_columns[finite_mask]].astype("float64", copy=False)
            * 1000.0
            / float(envelope_rate)
        )
        weights = np.maximum(peak_values, 0.000001)
        median_offset = _weighted_median(peak_offsets_ms, weights)
        if median_offset is None:
            continue
        mad = _weighted_median(np.abs(peak_offsets_ms - median_offset), weights)
        if mad is None:
            mad = 999.0
        target_score = _clamp01(1.0 - abs(float(median_offset) - target_peak_offset_ms) / 18.0)
        consistency_score = _clamp01(1.0 - float(mad) / 14.0)
        peak_score = _clamp01(float(np.mean(peak_values)) * 4.0)
        block_score = _clamp01(target_score * 0.48 + consistency_score * 0.36 + peak_score * 0.16)
        block_offsets.append(float(median_offset))
        block_peak_scores.append(peak_score)
        block_scores.append(block_score)
        block_weights.append(max(0.001, peak_score * float(peak_values.size)))
        support += int(peak_values.size)

    if not block_offsets:
        return _empty_phase_path_stats(support=support)

    offsets = np.asarray(block_offsets, dtype="float64")
    weights = np.asarray(block_weights, dtype="float64")
    median_offset = _weighted_median(offsets, weights)
    if median_offset is None:
        median_offset = 999.0
    offset_mad = _weighted_median(np.abs(offsets - median_offset), weights)
    if offset_mad is None:
        offset_mad = 999.0
    target_score = _clamp01(1.0 - abs(float(median_offset) - target_peak_offset_ms) / 16.0)
    segment_agreement = _clamp01(1.0 - float(offset_mad) / 10.0)
    peak_score = _clamp01(statistics.fmean(block_peak_scores))
    mean_block_score = _clamp01(statistics.fmean(block_scores))
    stable_count = sum(1 for score in block_scores if score >= 0.62)
    stable_ratio = _clamp01(stable_count / max(1.0, min(4.0, len(block_scores))))
    intro_reliability = _clamp01(block_scores[0])
    score = _clamp01(
        target_score * 0.34
        + segment_agreement * 0.26
        + mean_block_score * 0.22
        + peak_score * 0.10
        + stable_ratio * 0.08
    )
    return {
        "phasePathScore": _round_feature(score),
        "phasePathTargetScore": _round_feature(target_score),
        "phasePathSegmentAgreement": _round_feature(segment_agreement),
        "phasePathPeakScore": _round_feature(peak_score),
        "phasePathIntroReliability": _round_feature(intro_reliability),
        "phasePathPeakOffsetMedianMs": round(float(median_offset), 3),
        "phasePathPeakOffsetMadMs": round(float(offset_mad), 3),
        "phasePathStableSegmentCount": int(stable_count),
        "phasePathSupport": int(support),
    }


def _score_phase_path_grid(
    envelope: np.ndarray,
    *,
    envelope_rate: int,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
) -> dict[str, float | int]:
    best: dict[str, float | int] | None = None
    best_target = 0.0
    for target_offset_ms in PHASE_PATH_TARGET_OFFSETS_MS:
        stats = _score_phase_path_for_target(
            envelope,
            envelope_rate=envelope_rate,
            bpm=bpm,
            phase_ms=phase_ms,
            duration_sec=duration_sec,
            target_peak_offset_ms=target_offset_ms,
        )
        if best is None or float(stats["phasePathScore"]) > float(best["phasePathScore"]):
            best = stats
            best_target = target_offset_ms
    if best is None:
        return {**_empty_phase_path_stats(), "phasePathTargetOffsetMs": 0.0}
    return {**best, "phasePathTargetOffsetMs": round(float(best_target), 3)}
