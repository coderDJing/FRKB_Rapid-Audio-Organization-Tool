import math
import statistics
from typing import Any

import numpy as np

from beat_this_full_logit_utils import _grid_times_for_phase

SIGNAL_ORDER = ("beatLogit", "downbeatLogit", "fullAttack", "lowAttack")
PROFILE_KEYS = (
    "support",
    "blockCount",
    "medianOffsetMs",
    "offsetMadMs",
    "segmentAgreement",
    "meanBestScore",
    "meanCenterScore",
    "meanMargin",
)
NUMERIC_FEATURE_KEYS = (
    "tempoScore",
    "tempoBaseScore",
    "tempoQuantizedScore",
    "phaseScore",
    "phaseSupportRatio",
    "phaseCompactness",
    "phaseSupport",
    "attackPhaseScore",
    "attackPhaseSupport",
    "leadingEdgeScore",
    "leadingEdgeTargetScore",
    "leadingEdgeConsistencyScore",
    "leadingEdgePeakScore",
    "leadingEdgeSupport",
    "leadingEdgePeakOffsetMadMs",
    "leadingEdgePeakOffsetMedianMs",
    "leadingEdgeTargetOffsetMs",
    "introLeadingEdgeScore",
    "introLeadingEdgeTargetScore",
    "introLeadingEdgeConsistencyScore",
    "introLeadingEdgePeakScore",
    "introLeadingEdgeSupport",
    "introLeadingEdgePeakOffsetMadMs",
    "introLeadingEdgePeakOffsetMedianMs",
    "introLeadingEdgeTargetOffsetMs",
    "dpBeatMean",
    "dpBeatSegmentAgreement",
    "dpBeatSegmentMin",
    "dpBeatSupport",
    "dpFullAttackMean",
    "dpFullAttackSegmentAgreement",
    "dpLowAttackMean",
    "dpLowAttackSegmentAgreement",
    "phasePathScore",
    "phasePathTargetScore",
    "phasePathSegmentAgreement",
    "phasePathPeakScore",
    "phasePathIntroReliability",
    "phasePathStableSegmentCount",
    "phasePathSupport",
    "phasePathPeakOffsetMadMs",
    "phasePathPeakOffsetMedianMs",
    "phasePathTargetOffsetMs",
    "constantGridDpScore",
    "constantGridDpPhaseEvidenceSwitchScore",
    "constantGridDpPhaseEvidenceRank",
    "downbeatScore",
    "downbeatMargin",
    "downbeatDeltaToBest",
    "downbeatRank",
    "downbeatSupport",
    "constantGridDpDownbeatAlternativePenalty",
    "constantGridDpNegativeEdgeBonus",
    "constantGridDpOctavePenalty",
    "phaseShiftMs",
    "timelineQuantizationShiftMs",
    "windowWeight",
    "onsetFootScore",
    "onsetFootAgreementScore",
    "onsetFootSupport",
    "fullFootScore",
    "fullFootTargetScore",
    "fullFootConsistencyScore",
    "fullFootPeakDelayScore",
    "fullFootContrastScore",
    "fullFootSegmentAgreement",
    "fullFootFootOffsetMedianMs",
    "fullFootFootOffsetMadMs",
    "fullFootPeakOffsetMedianMs",
    "fullFootRiseMsMedian",
    "fullFootSupport",
    "lowFootScore",
    "lowFootTargetScore",
    "lowFootConsistencyScore",
    "lowFootPeakDelayScore",
    "lowFootContrastScore",
    "lowFootSegmentAgreement",
    "lowFootFootOffsetMedianMs",
    "lowFootFootOffsetMadMs",
    "lowFootPeakOffsetMedianMs",
    "lowFootRiseMsMedian",
    "lowFootSupport",
)
RISING_FEATURE_KEYS = (
    "risingEdgeScore",
    "risingEdgeAgreementScore",
    "fullRiseScore",
    "fullRiseTarget0Score",
    "fullRiseTargetPos8Score",
    "fullRiseTargetNeg8Score",
    "fullRiseConsistencyScore",
    "fullRisePeakOffsetMedianMs",
    "fullRisePeakOffsetMadMs",
    "fullRisePeakAmplitudeMean",
    "fullRiseSupport",
    "lowRiseScore",
    "lowRiseTarget0Score",
    "lowRiseTargetPos8Score",
    "lowRiseTargetNeg8Score",
    "lowRiseConsistencyScore",
    "lowRisePeakOffsetMedianMs",
    "lowRisePeakOffsetMadMs",
    "lowRisePeakAmplitudeMean",
    "lowRiseSupport",
)
BLOCK_SIZE = 16
BEAT_LIMIT = 64
OFFSET_LIMIT_MS = 24.0
OFFSET_STEP_MS = 2.0


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _safe_float(value: Any, default: float = 0.0) -> float:
    numeric = _to_float(value)
    return numeric if numeric is not None else default


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))


def _phase_delta_ms(a_ms: float, b_ms: float, beat_interval_ms: float) -> float:
    if beat_interval_ms <= 0.0:
        return a_ms - b_ms
    return (a_ms - b_ms + beat_interval_ms / 2.0) % beat_interval_ms - beat_interval_ms / 2.0


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float | None:
    if values.size == 0 or values.size != weights.size:
        return None
    total = float(np.sum(weights))
    if not math.isfinite(total) or total <= 0.0:
        return None
    order = np.argsort(values)
    sorted_values = values[order]
    sorted_weights = weights[order]
    cumulative = np.cumsum(sorted_weights)
    index = int(np.searchsorted(cumulative, total * 0.5, side="left"))
    index = max(0, min(index, sorted_values.size - 1))
    return float(sorted_values[index])


def _grid_times_for_candidate(candidate: dict[str, Any], duration_sec: float, limit: int) -> np.ndarray:
    bpm = _safe_float(candidate.get("bpm"))
    first_beat_ms = _safe_float(candidate.get("firstBeatMs"))
    if bpm <= 0.0 or duration_sec <= 0.0:
        return np.asarray([], dtype="float64")
    interval_sec = 60.0 / bpm
    start_sec = first_beat_ms / 1000.0
    values: list[float] = []
    index = 0
    while len(values) < limit:
        time_sec = start_sec + float(index) * interval_sec
        if time_sec > min(duration_sec, 120.0):
            break
        if time_sec >= 0.0:
            values.append(time_sec)
        index += 1
    return np.asarray(values, dtype="float64")


def _empty_foot_profile(prefix: str) -> dict[str, Any]:
    return {
        f"{prefix}Score": 0.0,
        f"{prefix}TargetScore": 0.0,
        f"{prefix}ConsistencyScore": 0.0,
        f"{prefix}PeakDelayScore": 0.0,
        f"{prefix}ContrastScore": 0.0,
        f"{prefix}SegmentAgreement": 0.0,
        f"{prefix}FootOffsetMedianMs": 999.0,
        f"{prefix}FootOffsetMadMs": 999.0,
        f"{prefix}PeakOffsetMedianMs": 999.0,
        f"{prefix}RiseMsMedian": 999.0,
        f"{prefix}Support": 0,
        f"{prefix}SegmentCount": 0,
    }


def _onset_foot_profile(
    values: np.ndarray,
    *,
    frame_rate: float,
    candidate: dict[str, Any],
    duration_sec: float,
    prefix: str,
) -> dict[str, Any]:
    if values.size == 0 or frame_rate <= 0.0:
        return _empty_foot_profile(prefix)
    times_sec = _grid_times_for_candidate(candidate, duration_sec, limit=64)
    if times_sec.size < 8:
        return _empty_foot_profile(prefix)
    offset_step_ms = max(1.0, 1000.0 / frame_rate)
    offset_ms = np.arange(-36.0, 48.0 + 0.001, offset_step_ms, dtype="float64")
    offset_samples = np.rint(offset_ms * frame_rate / 1000.0).astype("int64", copy=False)
    keep = np.unique(offset_samples, return_index=True)[1]
    keep.sort()
    offset_ms = offset_ms[keep]
    offset_samples = offset_samples[keep]
    if offset_samples.size < 8:
        return _empty_foot_profile(prefix)

    positions = np.rint(times_sec * frame_rate).astype("int64", copy=False)
    indices = positions[:, None] + offset_samples[None, :]
    valid = (indices >= 0) & (indices < values.size)
    clipped = np.clip(indices, 0, max(0, values.size - 1))
    sampled = values[clipped].astype("float64", copy=False)
    sampled = np.where(valid, sampled, np.nan)

    pre_mask = (offset_ms >= -34.0) & (offset_ms <= -8.0)
    peak_mask = (offset_ms >= -4.0) & (offset_ms <= 42.0)
    post_mask = (offset_ms >= 0.0) & (offset_ms <= 30.0)
    search_min = int(np.searchsorted(offset_ms, -28.0, side="left"))
    if not bool(np.any(pre_mask)) or not bool(np.any(peak_mask)):
        return _empty_foot_profile(prefix)

    foot_offsets: list[float] = []
    peak_offsets: list[float] = []
    rise_values: list[float] = []
    contrasts: list[float] = []
    weights: list[float] = []
    block_medians: list[float] = []
    for row in sampled:
        finite = np.isfinite(row)
        if int(np.count_nonzero(finite)) < 8:
            continue
        pre_values = row[pre_mask]
        peak_values = row[peak_mask]
        if not np.isfinite(pre_values).any() or not np.isfinite(peak_values).any():
            continue
        baseline = float(np.nanpercentile(pre_values, 35.0))
        peak_local_index = int(np.nanargmax(peak_values))
        peak_indices = np.flatnonzero(peak_mask)
        peak_index = int(peak_indices[peak_local_index])
        peak_value = float(row[peak_index])
        amplitude = peak_value - baseline
        if not math.isfinite(amplitude) or amplitude <= 0.001:
            continue
        threshold = baseline + amplitude * 0.22
        end_index = max(search_min, peak_index)
        search_values = row[search_min : end_index + 1]
        crossing = np.flatnonzero(np.isfinite(search_values) & (search_values >= threshold))
        if crossing.size == 0:
            continue
        foot_index = int(search_min + crossing[0])
        pre_mean = float(np.nanmean(pre_values)) if np.isfinite(pre_values).any() else baseline
        post_values = row[post_mask]
        post_mean = float(np.nanmean(post_values)) if np.isfinite(post_values).any() else peak_value
        contrast = (post_mean - pre_mean) / max(0.001, abs(peak_value))
        foot_offset = float(offset_ms[foot_index])
        peak_offset = float(offset_ms[peak_index])
        foot_offsets.append(foot_offset)
        peak_offsets.append(peak_offset)
        rise_values.append(max(0.0, peak_offset - foot_offset))
        contrasts.append(contrast)
        weights.append(max(0.001, amplitude))

    if len(foot_offsets) < 8:
        return _empty_foot_profile(prefix)
    foot_array = np.asarray(foot_offsets, dtype="float64")
    peak_array = np.asarray(peak_offsets, dtype="float64")
    rise_array = np.asarray(rise_values, dtype="float64")
    contrast_array = np.asarray(contrasts, dtype="float64")
    weight_array = np.asarray(weights, dtype="float64")
    median_foot = _weighted_median(foot_array, weight_array)
    if median_foot is None:
        return _empty_foot_profile(prefix)
    foot_mad = _weighted_median(np.abs(foot_array - median_foot), weight_array)
    if foot_mad is None:
        foot_mad = 999.0
    median_peak = _weighted_median(peak_array, weight_array)
    if median_peak is None:
        median_peak = 999.0
    median_rise = _weighted_median(rise_array, weight_array)
    if median_rise is None:
        median_rise = 999.0

    for start in range(0, len(foot_offsets), 16):
        block = foot_array[start : start + 16]
        block_weights = weight_array[start : start + 16]
        if block.size >= 8:
            value = _weighted_median(block, block_weights)
            if value is not None:
                block_medians.append(value)
    segment_mad = statistics.median([abs(value - median_foot) for value in block_medians]) if block_medians else 999.0
    target_score = _clamp01(1.0 - abs(float(median_foot)) / 8.0)
    consistency_score = _clamp01(1.0 - float(foot_mad) / 8.0)
    peak_delay_score = _clamp01(1.0 - abs(float(median_peak) - 14.0) / 22.0)
    contrast_score = _clamp01(float(np.nanmean(contrast_array)) * 2.0)
    segment_agreement = _clamp01(1.0 - float(segment_mad) / 10.0)
    score = _clamp01(
        target_score * 0.38
        + consistency_score * 0.24
        + peak_delay_score * 0.16
        + contrast_score * 0.12
        + segment_agreement * 0.10
    )
    return {
        f"{prefix}Score": round(score, 6),
        f"{prefix}TargetScore": round(target_score, 6),
        f"{prefix}ConsistencyScore": round(consistency_score, 6),
        f"{prefix}PeakDelayScore": round(peak_delay_score, 6),
        f"{prefix}ContrastScore": round(contrast_score, 6),
        f"{prefix}SegmentAgreement": round(segment_agreement, 6),
        f"{prefix}FootOffsetMedianMs": round(float(median_foot), 3),
        f"{prefix}FootOffsetMadMs": round(float(foot_mad), 3),
        f"{prefix}PeakOffsetMedianMs": round(float(median_peak), 3),
        f"{prefix}RiseMsMedian": round(float(median_rise), 3),
        f"{prefix}Support": int(len(foot_offsets)),
        f"{prefix}SegmentCount": int(len(block_medians)),
    }


def _candidate_onset_features(
    *,
    candidate: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]] | None,
    duration_sec: float,
) -> dict[str, Any]:
    if signal_bundle is None:
        return {
            **_empty_foot_profile("fullFoot"),
            **_empty_foot_profile("lowFoot"),
            "onsetFootScore": 0.0,
            "onsetFootAgreementScore": 0.0,
            "onsetFootSupport": 0,
        }
    full_values, full_rate = signal_bundle["fullAttack"]
    low_values, low_rate = signal_bundle["lowAttack"]
    full = _onset_foot_profile(
        full_values,
        frame_rate=full_rate,
        candidate=candidate,
        duration_sec=duration_sec,
        prefix="fullFoot",
    )
    low = _onset_foot_profile(
        low_values,
        frame_rate=low_rate,
        candidate=candidate,
        duration_sec=duration_sec,
        prefix="lowFoot",
    )
    full_offset = float(full["fullFootFootOffsetMedianMs"])
    low_offset = float(low["lowFootFootOffsetMedianMs"])
    agreement = _clamp01(1.0 - abs(full_offset - low_offset) / 8.0)
    full_score = float(full["fullFootScore"])
    low_score = float(low["lowFootScore"])
    score = _clamp01(full_score * 0.62 + low_score * 0.28 + agreement * 0.10)
    return {
        **full,
        **low,
        "onsetFootScore": round(score, 6),
        "onsetFootAgreementScore": round(agreement, 6),
        "onsetFootSupport": int(full["fullFootSupport"]) + int(low["lowFootSupport"]),
    }


def _empty_rise_profile(prefix: str) -> dict[str, Any]:
    return {
        f"{prefix}Score": 0.0,
        f"{prefix}Target0Score": 0.0,
        f"{prefix}TargetPos8Score": 0.0,
        f"{prefix}TargetNeg8Score": 0.0,
        f"{prefix}ConsistencyScore": 0.0,
        f"{prefix}PeakOffsetMedianMs": 999.0,
        f"{prefix}PeakOffsetMadMs": 999.0,
        f"{prefix}PeakAmplitudeMean": 0.0,
        f"{prefix}Support": 0,
    }


def _rise_profile(
    values: np.ndarray,
    *,
    frame_rate: float,
    candidate: dict[str, Any],
    duration_sec: float,
    prefix: str,
) -> dict[str, Any]:
    if values.size < 16 or frame_rate <= 0.0:
        return _empty_rise_profile(prefix)
    times_sec = _grid_times_for_candidate(candidate, duration_sec, limit=64)
    if times_sec.size < 8:
        return _empty_rise_profile(prefix)

    derivative = np.diff(values.astype("float64", copy=False), prepend=float(values[0]))
    derivative = np.maximum(derivative, 0.0)
    offset_step_ms = max(1.0, 1000.0 / frame_rate)
    offset_ms = np.arange(-40.0, 50.0 + 0.001, offset_step_ms, dtype="float64")
    offset_samples = np.rint(offset_ms * frame_rate / 1000.0).astype("int64", copy=False)
    keep = np.unique(offset_samples, return_index=True)[1]
    keep.sort()
    offset_ms = offset_ms[keep]
    offset_samples = offset_samples[keep]
    if offset_samples.size < 8:
        return _empty_rise_profile(prefix)

    positions = np.rint(times_sec * frame_rate).astype("int64", copy=False)
    indices = positions[:, None] + offset_samples[None, :]
    valid = (indices >= 0) & (indices < derivative.size)
    if not bool(np.any(valid)):
        return _empty_rise_profile(prefix)
    clipped = np.clip(indices, 0, max(0, derivative.size - 1))
    sampled = derivative[clipped].astype("float64", copy=False)
    sampled = np.where(valid, sampled, np.nan)

    peak_offsets: list[float] = []
    peak_amplitudes: list[float] = []
    for row in sampled:
        finite = np.isfinite(row)
        if int(np.count_nonzero(finite)) < 8:
            continue
        peak_value = float(np.nanmax(row))
        if not math.isfinite(peak_value) or peak_value <= 1e-8:
            continue
        peak_index = int(np.nanargmax(row))
        peak_offsets.append(float(offset_ms[peak_index]))
        peak_amplitudes.append(peak_value)

    if len(peak_offsets) < 8:
        return _empty_rise_profile(prefix)
    offset_array = np.asarray(peak_offsets, dtype="float64")
    amplitude_array = np.asarray(peak_amplitudes, dtype="float64")
    median_offset = _weighted_median(offset_array, amplitude_array)
    if median_offset is None:
        return _empty_rise_profile(prefix)
    offset_mad = _weighted_median(np.abs(offset_array - median_offset), amplitude_array)
    if offset_mad is None:
        offset_mad = 999.0

    target0 = _clamp01(1.0 - abs(float(median_offset)) / 10.0)
    target_pos8 = _clamp01(1.0 - abs(float(median_offset) - 8.0) / 12.0)
    target_neg8 = _clamp01(1.0 - abs(float(median_offset) + 8.0) / 12.0)
    consistency = _clamp01(1.0 - float(offset_mad) / 12.0)
    amp_mean = float(np.mean(amplitude_array))
    amp_score = _clamp01(amp_mean * 400.0)
    score = _clamp01(target_pos8 * 0.42 + target0 * 0.22 + consistency * 0.24 + amp_score * 0.12)
    return {
        f"{prefix}Score": round(score, 6),
        f"{prefix}Target0Score": round(target0, 6),
        f"{prefix}TargetPos8Score": round(target_pos8, 6),
        f"{prefix}TargetNeg8Score": round(target_neg8, 6),
        f"{prefix}ConsistencyScore": round(consistency, 6),
        f"{prefix}PeakOffsetMedianMs": round(float(median_offset), 3),
        f"{prefix}PeakOffsetMadMs": round(float(offset_mad), 3),
        f"{prefix}PeakAmplitudeMean": round(amp_mean, 9),
        f"{prefix}Support": int(len(peak_offsets)),
    }


def _candidate_rising_edge_features(
    *,
    candidate: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]] | None,
    duration_sec: float,
) -> dict[str, Any]:
    if signal_bundle is None:
        return {
            **_empty_rise_profile("fullRise"),
            **_empty_rise_profile("lowRise"),
            "risingEdgeScore": 0.0,
            "risingEdgeAgreementScore": 0.0,
        }
    full_values, full_rate = signal_bundle["fullAttack"]
    low_values, low_rate = signal_bundle["lowAttack"]
    full = _rise_profile(
        full_values,
        frame_rate=full_rate,
        candidate=candidate,
        duration_sec=duration_sec,
        prefix="fullRise",
    )
    low = _rise_profile(
        low_values,
        frame_rate=low_rate,
        candidate=candidate,
        duration_sec=duration_sec,
        prefix="lowRise",
    )
    full_score = _safe_float(full.get("fullRiseScore"))
    low_score = _safe_float(low.get("lowRiseScore"))
    agreement = _clamp01(
        1.0
        - abs(_safe_float(full.get("fullRisePeakOffsetMedianMs")) - _safe_float(low.get("lowRisePeakOffsetMedianMs")))
        / 16.0
    )
    return {
        **full,
        **low,
        "risingEdgeScore": round(_clamp01(full_score * 0.62 + low_score * 0.26 + agreement * 0.12), 6),
        "risingEdgeAgreementScore": round(agreement, 6),
    }


def _empty_trajectory_profile() -> dict[str, Any]:
    return {
        "support": 0,
        "blockCount": 0,
        "medianOffsetMs": None,
        "offsetMadMs": None,
        "segmentAgreement": 0.0,
        "meanBestScore": None,
        "meanCenterScore": None,
        "meanMargin": None,
        "positiveOffsetCount": 0,
        "negativeOffsetCount": 0,
        "zeroOffsetCount": 0,
    }


def _trajectory_profile(
    *,
    values: np.ndarray,
    frame_rate: float,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
) -> dict[str, Any]:
    if values.size == 0 or frame_rate <= 0.0 or bpm <= 0.0 or duration_sec <= 0.0:
        return _empty_trajectory_profile()
    times_sec = _grid_times_for_phase(phase_ms, bpm, min(duration_sec, 120.0))
    times_sec = times_sec[times_sec >= 0.0][:BEAT_LIMIT]
    if times_sec.size < 8:
        return _empty_trajectory_profile()

    offset_ms = np.arange(-OFFSET_LIMIT_MS, OFFSET_LIMIT_MS + 0.001, OFFSET_STEP_MS, dtype="float64")
    offset_samples = np.rint(offset_ms * frame_rate / 1000.0).astype("int64", copy=False)
    unique_indices = np.unique(offset_samples, return_index=True)[1]
    offset_samples = offset_samples[np.sort(unique_indices)]
    offset_ms = offset_ms[np.sort(unique_indices)]
    if offset_samples.size == 0:
        return _empty_trajectory_profile()
    center_index = int(np.argmin(np.abs(offset_ms)))

    block_offsets: list[float] = []
    block_weights: list[float] = []
    best_scores: list[float] = []
    center_scores: list[float] = []
    margins: list[float] = []
    support = 0
    for start in range(0, int(times_sec.size), BLOCK_SIZE):
        block_times = times_sec[start : start + BLOCK_SIZE]
        if block_times.size < 8:
            continue
        positions = np.rint(block_times * frame_rate).astype("int64", copy=False)
        indices = positions[:, None] + offset_samples[None, :]
        valid = (indices >= 0) & (indices < values.size)
        if not bool(np.any(valid)):
            continue
        clipped = np.clip(indices, 0, max(0, values.size - 1))
        sampled = values[clipped].astype("float64", copy=False)
        sampled = np.where(valid, sampled, np.nan)
        scores = np.nanmean(sampled, axis=0)
        finite = np.isfinite(scores)
        if int(np.count_nonzero(finite)) < 3:
            continue
        best_index = int(np.nanargmax(scores))
        best_score = float(scores[best_index])
        center_score = float(scores[center_index]) if math.isfinite(float(scores[center_index])) else 0.0
        margin = best_score - center_score
        block_offsets.append(float(offset_ms[best_index]))
        best_scores.append(best_score)
        center_scores.append(center_score)
        margins.append(margin)
        block_weights.append(max(0.001, best_score * float(block_times.size)))
        support += int(block_times.size)

    if not block_offsets:
        return _empty_trajectory_profile()
    offsets = np.asarray(block_offsets, dtype="float64")
    weights = np.asarray(block_weights, dtype="float64")
    median_offset = _weighted_median(offsets, weights)
    if median_offset is None:
        return _empty_trajectory_profile()
    offset_mad = _weighted_median(np.abs(offsets - median_offset), weights)
    if offset_mad is None:
        offset_mad = 999.0
    segment_agreement = _clamp01(1.0 - float(offset_mad) / 12.0)
    return {
        "support": int(support),
        "blockCount": len(block_offsets),
        "medianOffsetMs": round(float(median_offset), 3),
        "offsetMadMs": round(float(offset_mad), 3),
        "segmentAgreement": round(segment_agreement, 6),
        "meanBestScore": round(statistics.fmean(best_scores), 6),
        "meanCenterScore": round(statistics.fmean(center_scores), 6),
        "meanMargin": round(statistics.fmean(margins), 6),
        "positiveOffsetCount": int(np.count_nonzero(offsets > 0.0)),
        "negativeOffsetCount": int(np.count_nonzero(offsets < 0.0)),
        "zeroOffsetCount": int(np.count_nonzero(offsets == 0.0)),
    }


def _signal_profiles(
    *,
    candidate: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]] | None,
    duration_sec: float,
) -> dict[str, dict[str, Any]]:
    if signal_bundle is None:
        return {}
    result: dict[str, dict[str, Any]] = {}
    for signal_name in SIGNAL_ORDER:
        values, frame_rate = signal_bundle[signal_name]
        result[signal_name] = _trajectory_profile(
            values=values,
            frame_rate=frame_rate,
            bpm=float(candidate["bpm"]),
            phase_ms=float(candidate["firstBeatMs"]),
            duration_sec=duration_sec,
        )
    return result


def _feature_value(candidate: dict[str, Any], key: str) -> float:
    if key == "score":
        return _safe_float(candidate.get("score"))
    features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    return _safe_float(features.get(key))


def _add_feature(result: list[float], names: list[str], name: str, value: Any) -> None:
    result.append(_safe_float(value))
    names.append(name)


def _add_sincos(result: list[float], names: list[str], prefix: str, value: float, period: float) -> None:
    if period <= 0.0:
        result.extend([0.0, 0.0])
    else:
        angle = 2.0 * math.pi * (value % period) / period
        result.extend([math.sin(angle), math.cos(angle)])
    names.extend([f"{prefix}Sin", f"{prefix}Cos"])


def _append_profile_features(
    *,
    result: list[float],
    names: list[str],
    prefix: str,
    profiles: dict[str, dict[str, Any]],
) -> None:
    for signal_name in SIGNAL_ORDER:
        profile = profiles.get(signal_name) if isinstance(profiles.get(signal_name), dict) else {}
        for key in PROFILE_KEYS:
            _add_feature(result, names, f"{prefix}.{signal_name}.{key}", profile.get(key))
        median_offset = _safe_float(profile.get("medianOffsetMs"))
        _add_feature(result, names, f"{prefix}.{signal_name}.absMedianOffsetMs", abs(median_offset))
        support = max(1.0, _safe_float(profile.get("support"), 1.0))
        _add_feature(
            result,
            names,
            f"{prefix}.{signal_name}.positiveOffsetRatio",
            _safe_float(profile.get("positiveOffsetCount")) / support,
        )
        _add_feature(
            result,
            names,
            f"{prefix}.{signal_name}.negativeOffsetRatio",
            _safe_float(profile.get("negativeOffsetCount")) / support,
        )
        _add_feature(
            result,
            names,
            f"{prefix}.{signal_name}.zeroOffsetRatio",
            _safe_float(profile.get("zeroOffsetCount")) / support,
        )


def _feature_vector(
    *,
    candidate: dict[str, Any],
    selected: dict[str, Any],
    candidate_profiles: dict[str, dict[str, Any]],
) -> tuple[list[float], list[str]]:
    result: list[float] = []
    names: list[str] = []
    bpm = max(1e-6, float(candidate["bpm"]))
    selected_bpm = max(1e-6, float(selected["bpm"]))
    beat_interval_ms = 60000.0 / bpm
    selected_beat_interval_ms = 60000.0 / selected_bpm
    phase_delta = _phase_delta_ms(
        float(candidate["timelineFirstBeatMs"]),
        float(selected["timelineFirstBeatMs"]),
        beat_interval_ms,
    )

    _add_feature(result, names, "rank", candidate["rank"])
    _add_feature(result, names, "invRank", 1.0 / max(1.0, float(candidate["rank"])))
    _add_feature(result, names, "candidateScore", candidate["score"])
    _add_feature(result, names, "selectedScore", selected["score"])
    _add_feature(result, names, "scoreMinusSelected", float(candidate["score"]) - float(selected["score"]))
    _add_feature(result, names, "bpm", bpm)
    _add_feature(result, names, "beatIntervalMs", beat_interval_ms)
    _add_feature(result, names, "bpmMinusSelected", bpm - selected_bpm)
    _add_feature(result, names, "absBpmMinusSelected", abs(bpm - selected_bpm))
    _add_feature(result, names, "beatIntervalMinusSelected", beat_interval_ms - selected_beat_interval_ms)
    _add_feature(result, names, "candidateToSelectedPhaseDeltaMs", phase_delta)
    _add_feature(result, names, "candidateToSelectedPhaseAbsDeltaMs", abs(phase_delta))
    _add_feature(
        result,
        names,
        "barBeatOffsetSameMod4",
        1.0 if int(candidate["barBeatOffset"]) % 4 == int(selected["barBeatOffset"]) % 4 else 0.0,
    )
    _add_feature(
        result,
        names,
        "barBeatOffsetSameExact32",
        1.0 if int(candidate["barBeatOffset"]) % 32 == int(selected["barBeatOffset"]) % 32 else 0.0,
    )
    _add_sincos(result, names, "phaseWithinBeat", float(candidate["firstBeatMs"]), beat_interval_ms)
    _add_sincos(result, names, "barBeatOffset32", float(candidate["barBeatOffset"]), 32.0)
    _add_sincos(result, names, "barBeatOffset4", float(candidate["barBeatOffset"]), 4.0)

    for key in NUMERIC_FEATURE_KEYS:
        candidate_value = _feature_value(candidate, key)
        selected_value = _feature_value(selected, key)
        _add_feature(result, names, f"candidate.{key}", candidate_value)
        _add_feature(result, names, f"delta.{key}", candidate_value - selected_value)

    _append_profile_features(result=result, names=names, prefix="candidateProfile", profiles=candidate_profiles)
    selected_profiles = selected.get("profiles") if isinstance(selected.get("profiles"), dict) else {}
    for signal_name in SIGNAL_ORDER:
        candidate_profile = candidate_profiles.get(signal_name) if isinstance(candidate_profiles.get(signal_name), dict) else {}
        selected_profile = selected_profiles.get(signal_name) if isinstance(selected_profiles.get(signal_name), dict) else {}
        for key in PROFILE_KEYS:
            _add_feature(
                result,
                names,
                f"profileDelta.{signal_name}.{key}",
                _safe_float(candidate_profile.get(key)) - _safe_float(selected_profile.get(key)),
            )
    return result, names


def _feature_vector_with_rising_edge(
    *,
    candidate: dict[str, Any],
    selected: dict[str, Any],
    candidate_profiles: dict[str, dict[str, Any]],
) -> tuple[list[float], list[str]]:
    values, names = _feature_vector(candidate=candidate, selected=selected, candidate_profiles=candidate_profiles)
    for key in RISING_FEATURE_KEYS:
        candidate_value = _feature_value(candidate, key)
        selected_value = _feature_value(selected, key)
        values.append(candidate_value)
        names.append(f"candidate.{key}")
        values.append(candidate_value - selected_value)
        names.append(f"delta.{key}")
    return values, names
