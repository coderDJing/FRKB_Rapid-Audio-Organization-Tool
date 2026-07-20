import math
import statistics
from typing import Any

import numpy as np

from beat_this_full_logit_utils import _grid_times_for_phase, _score_downbeat_bars
from beat_this_grid_solver import moving_average
from rkb_beatgrid_candidate_lab import (
    _build_grid_candidates,
    _phase_delta_ms,
    _score_leading_edge_grid,
    _sigmoid,
)
from rkb_constant_grid_dp_high_structural import (
    choose_rank1_high_structural_score_candidate,
    rank1_high_structural_score_diagnostic_features,
)
from rkb_constant_grid_dp_phase_path import _score_phase_path_grid, _weighted_median
from rkb_constant_grid_dp_selection import (
    PHASE_EVIDENCE_LEGACY_WEAKNESS_THRESHOLD,
    PHASE_EVIDENCE_SWITCH_THRESHOLD,
    choose_rank1_locked_legacy_weakness_candidate,
    choose_rank1_negative_legacy_score_candidate,
    choose_rank1_structural_phase_candidate,
    choose_head_near_zero_candidate,
    confidence_from_selected,
    head_near_zero_switch_diagnostic_features,
    legacy_weakness_score,
    passes_conservative_switch_guard,
    preserve_locked_phase_switch_downbeat_ordinal,
    rank1_negative_legacy_score_diagnostic_features,
    rank1_switch_diagnostic_features,
    select_phase_evidence_candidate,
    snap_legacy_integer_bpm,
)
from rkb_constant_grid_dp_octave import (
    choose_rank1_octave_down_candidate,
    rank1_octave_down_diagnostic_features,
)
from rkb_locked_phase_ranker import choose_locked_rising_edge_candidate
from rkb_official_downbeat_selector import (
    build_downbeat_rotation_evidence,
    load_linear_downbeat_artifact,
    select_downbeat_rotation_with_linear_model,
)
from rkb_official_phase_selector import refine_fixed_bpm_candidate
from rkb_runtime_grid_common import (
    candidate_is_within_bpm_range as _candidate_is_within_bpm_range,
    clamp01 as _clamp01,
    metadata_legacy_candidate as _metadata_legacy_candidate,
    round_feature as _round_feature,
    to_float as _to_float,
    window_summary as _window_summary,
)

DEFAULT_MIN_BPM = 70.0
DEFAULT_MAX_BPM = 200.0
DEFAULT_TEMPO_STEP_BPM = 0.5
DEFAULT_TEMPO_LIMIT = 24
DEFAULT_PHASE_STEP_MS = 2.0
DEFAULT_MAX_CANDIDATES = 640
SOLVER_VERSION = "constant-grid-dp-cache-v3-locked-rising-edge-ranker-locked-phase-downbeat-ordinal-v1-integer-bpm-snap-rank1-material-legacy-weakness-v3-rank1-structural-phase-v2-rank1-high-structural-score-v1-rank1-negative-legacy-score-v2-head-near-zero-v1-rank1-octave-down-v1-official-high-attack-phase-v1-official-downbeat-rotation-v1"
OFFICIAL_DOWNBEAT_ARTIFACT = load_linear_downbeat_artifact()


def _candidate_source(candidate: dict[str, Any]) -> str:
    tempo_source = str(candidate.get("tempoSource") or "tempo")
    phase_source = str(candidate.get("phaseSource") or "phase")
    bar_source = str(candidate.get("barSource") or "bar")
    return f"constant-grid-dp:{tempo_source}:{phase_source}:{bar_source}"


def _apply_official_phase_refiner(
    *,
    selected: dict[str, Any],
    arrays: dict[str, Any],
    duration_sec: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if "officialHighAttackEnvelope" not in arrays or "officialHighAttackSampleRate" not in arrays:
        return selected, {
            "applied": False,
            "reason": "missing-high-attack-envelope",
        }
    high_attack = np.asarray(arrays["officialHighAttackEnvelope"], dtype="float64")
    high_attack_rate = _to_float(np.asarray(arrays["officialHighAttackSampleRate"]).item())
    return refine_fixed_bpm_candidate(
        selected,
        high_attack=high_attack,
        frame_rate=high_attack_rate,
        duration_sec=duration_sec,
    )


def _apply_official_downbeat_selector(
    *,
    selected: dict[str, Any],
    arrays: dict[str, Any],
    duration_sec: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    current_rotation = int(selected.get("barBeatOffset") or 0) % 4
    evidence = build_downbeat_rotation_evidence(
        arrays=arrays,
        bpm=_to_float(selected.get("bpm")),
        first_beat_ms=_to_float(selected.get("firstBeatMs")),
        duration_sec=duration_sec,
    )
    meta = select_downbeat_rotation_with_linear_model(
        evidence=evidence,
        current_rotation=current_rotation,
        artifact=OFFICIAL_DOWNBEAT_ARTIFACT,
    )
    if not meta.get("applied"):
        return selected, meta
    selected_rotation = int(meta.get("selectedRotation") or 0) % 4
    features = dict(selected.get("features") or {})
    features.update(
        {
            "officialDownbeatRotationApplied": True,
            "officialDownbeatRotationVersion": str(meta.get("version") or ""),
            "officialDownbeatRotationArtifactVersion": str(meta.get("artifactVersion") or ""),
            "officialDownbeatRotationOriginal": current_rotation,
            "officialDownbeatRotationSelected": selected_rotation,
            "officialDownbeatRotationAdvantage": _round_feature(_to_float(meta.get("advantage"))),
            "officialDownbeatRotationMargin": _round_feature(_to_float(meta.get("margin"))),
            "officialDownbeatRotationBlockAgreement": _round_feature(_to_float(meta.get("blockAgreement"))),
        }
    )
    return {
        **selected,
        "barBeatOffset": selected_rotation,
        "features": features,
    }, meta


def _sample_values_at_rate(values: np.ndarray, times_sec: np.ndarray, frame_rate: float) -> np.ndarray:
    if values.size == 0 or times_sec.size == 0 or frame_rate <= 0.0:
        return np.asarray([], dtype="float64")
    positions = times_sec.astype("float64", copy=False) * float(frame_rate)
    valid_mask = (positions >= 0.0) & (positions <= float(values.size - 1))
    if not bool(np.any(valid_mask)):
        return np.asarray([], dtype="float64")
    valid_positions = positions[valid_mask]
    left_indices = np.floor(valid_positions).astype(np.int64, copy=False)
    fractions = valid_positions - left_indices
    right_indices = np.minimum(left_indices + 1, values.size - 1)
    return values[left_indices] * (1.0 - fractions) + values[right_indices] * fractions


def _score_intro_leading_edge_grid(
    envelope: np.ndarray,
    *,
    envelope_rate: int,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
    target_peak_offset_ms: float = 10.0,
    beat_limit: int = 32,
) -> dict[str, float | int]:
    if envelope.size == 0 or envelope_rate <= 0 or bpm <= 0.0 or duration_sec <= 0.0:
        return {
            "introLeadingEdgeScore": 0.0,
            "introLeadingEdgeTargetScore": 0.0,
            "introLeadingEdgeConsistencyScore": 0.0,
            "introLeadingEdgePeakScore": 0.0,
            "introLeadingEdgePeakOffsetMedianMs": 999.0,
            "introLeadingEdgePeakOffsetMadMs": 999.0,
            "introLeadingEdgeSupport": 0,
        }

    times_sec = _grid_times_for_phase(phase_ms, bpm, min(duration_sec, 75.0))
    times_sec = times_sec[times_sec >= 0.0][:beat_limit]
    if times_sec.size < 8:
        return {
            "introLeadingEdgeScore": 0.0,
            "introLeadingEdgeTargetScore": 0.0,
            "introLeadingEdgeConsistencyScore": 0.0,
            "introLeadingEdgePeakScore": 0.0,
            "introLeadingEdgePeakOffsetMedianMs": 999.0,
            "introLeadingEdgePeakOffsetMadMs": 999.0,
            "introLeadingEdgeSupport": int(times_sec.size),
        }

    start_offset = int(round(float(envelope_rate) * -0.014))
    end_offset = int(round(float(envelope_rate) * 0.036))
    offset_samples = np.arange(start_offset, end_offset + 1, dtype="int64")
    positions = np.rint(times_sec * float(envelope_rate)).astype("int64", copy=False)
    indices = positions[:, None] + offset_samples[None, :]
    valid = (indices >= 0) & (indices < envelope.size)
    if not bool(np.any(valid)):
        return {
            "introLeadingEdgeScore": 0.0,
            "introLeadingEdgeTargetScore": 0.0,
            "introLeadingEdgeConsistencyScore": 0.0,
            "introLeadingEdgePeakScore": 0.0,
            "introLeadingEdgePeakOffsetMedianMs": 999.0,
            "introLeadingEdgePeakOffsetMadMs": 999.0,
            "introLeadingEdgeSupport": 0,
        }

    clipped = np.clip(indices, 0, max(0, envelope.size - 1))
    values = envelope[clipped].astype("float64", copy=False)
    values = np.where(valid, values, -np.inf)
    best_columns = np.argmax(values, axis=1)
    row_indices = np.arange(values.shape[0])
    peak_values = values[row_indices, best_columns]
    finite_mask = np.isfinite(peak_values)
    if int(np.count_nonzero(finite_mask)) < 8:
        return {
            "introLeadingEdgeScore": 0.0,
            "introLeadingEdgeTargetScore": 0.0,
            "introLeadingEdgeConsistencyScore": 0.0,
            "introLeadingEdgePeakScore": 0.0,
            "introLeadingEdgePeakOffsetMedianMs": 999.0,
            "introLeadingEdgePeakOffsetMadMs": 999.0,
            "introLeadingEdgeSupport": int(np.count_nonzero(finite_mask)),
        }

    peak_values = peak_values[finite_mask]
    peak_offsets_ms = (
        offset_samples[best_columns[finite_mask]].astype("float64", copy=False)
        * 1000.0
        / float(envelope_rate)
    )
    weights = np.maximum(peak_values, 0.000001)
    median_offset = _weighted_median(peak_offsets_ms, weights)
    if median_offset is None:
        median_offset = 999.0
    mad = _weighted_median(np.abs(peak_offsets_ms - median_offset), weights)
    if mad is None:
        mad = 999.0

    target_score = _clamp01(1.0 - abs(float(median_offset) - target_peak_offset_ms) / 16.0)
    consistency_score = _clamp01(1.0 - float(mad) / 14.0)
    peak_score = _clamp01(float(np.mean(peak_values)) * 4.0)
    score = _clamp01(target_score * 0.50 + consistency_score * 0.34 + peak_score * 0.16)
    return {
        "introLeadingEdgeScore": _round_feature(score),
        "introLeadingEdgeTargetScore": _round_feature(target_score),
        "introLeadingEdgeConsistencyScore": _round_feature(consistency_score),
        "introLeadingEdgePeakScore": _round_feature(peak_score),
        "introLeadingEdgePeakOffsetMedianMs": round(float(median_offset), 3),
        "introLeadingEdgePeakOffsetMadMs": round(float(mad), 3),
        "introLeadingEdgeSupport": int(peak_values.size),
    }


def _series_segment_stats(
    values: np.ndarray,
    *,
    frame_rate: float,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
    segment_count: int = 8,
) -> dict[str, float | int]:
    if values.size == 0 or frame_rate <= 0.0 or bpm <= 0.0 or duration_sec <= 0.0:
        return {
            "mean": 0.0,
            "median": 0.0,
            "minimum": 0.0,
            "std": 0.0,
            "agreement": 0.0,
            "support": 0,
        }

    times_sec = _grid_times_for_phase(phase_ms, bpm, duration_sec)
    if times_sec.size == 0:
        return {
            "mean": 0.0,
            "median": 0.0,
            "minimum": 0.0,
            "std": 0.0,
            "agreement": 0.0,
            "support": 0,
        }

    segment_scores: list[float] = []
    support = 0
    segment_duration = duration_sec / float(max(1, segment_count))
    for segment_index in range(max(1, segment_count)):
        start_sec = segment_duration * float(segment_index)
        end_sec = duration_sec if segment_index == segment_count - 1 else start_sec + segment_duration
        segment_times = times_sec[(times_sec >= start_sec) & (times_sec < end_sec)]
        sampled = _sample_values_at_rate(values, segment_times, frame_rate)
        sampled = sampled[np.isfinite(sampled)]
        if sampled.size < 4:
            continue
        support += int(sampled.size)
        ordered = np.sort(sampled.astype("float64", copy=False))
        low_count = max(1, int(round(ordered.size * 0.25)))
        robust_score = float(np.mean(sampled)) * 0.72 + float(np.mean(ordered[:low_count])) * 0.28
        segment_scores.append(robust_score)

    if not segment_scores:
        return {
            "mean": 0.0,
            "median": 0.0,
            "minimum": 0.0,
            "std": 0.0,
            "agreement": 0.0,
            "support": 0,
        }

    mean_value = float(statistics.fmean(segment_scores))
    median_value = float(statistics.median(segment_scores))
    min_value = float(min(segment_scores))
    std_value = float(statistics.pstdev(segment_scores)) if len(segment_scores) > 1 else 0.0
    agreement = _clamp01((min_value / max(1e-9, median_value)) * 0.72 + (1.0 - std_value) * 0.28)
    return {
        "mean": _round_feature(mean_value),
        "median": _round_feature(median_value),
        "minimum": _round_feature(min_value),
        "std": _round_feature(std_value),
        "agreement": _round_feature(agreement),
        "support": support,
    }


def _downbeat_lattice(
    *,
    downbeat_logits: np.ndarray,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
) -> list[dict[str, float | int]]:
    scores = _score_downbeat_bars(downbeat_logits, bpm, phase_ms, duration_sec)
    valid = [item for item in scores if int(item[2]) >= 4 and math.isfinite(float(item[1]))]
    if not valid:
        return [{"barBeatOffset": 0, "score": 0.0, "margin": 0.0, "support": 0}]
    ordered = sorted(valid, key=lambda item: float(item[1]), reverse=True)
    best_score = float(ordered[0][1])
    second_score = float(ordered[1][1]) if len(ordered) > 1 else best_score
    return [
        {
            "barBeatOffset": int(bar) % 4,
            "score": _round_feature(float(score)),
            "margin": _round_feature(best_score - second_score if index == 0 else float(score) - best_score),
            "rank": index,
            "deltaToBest": _round_feature(best_score - float(score)),
            "support": int(support),
        }
        for index, (bar, score, support) in enumerate(ordered[:4])
    ]


def _candidate_signal_features(
    *,
    candidate: dict[str, Any],
    beat_logits: np.ndarray,
    raw_full_attack: np.ndarray,
    full_attack: np.ndarray,
    low_attack: np.ndarray,
    full_attack_rate: int,
    low_attack_rate: int,
    duration_sec: float,
) -> dict[str, Any]:
    bpm = _to_float(candidate.get("bpm"))
    phase_ms = _to_float(candidate.get("firstBeatMs"))
    beat_stats = _series_segment_stats(
        beat_logits,
        frame_rate=50.0,
        bpm=bpm,
        phase_ms=phase_ms,
        duration_sec=duration_sec,
    )
    full_stats = _series_segment_stats(
        full_attack,
        frame_rate=float(full_attack_rate),
        bpm=bpm,
        phase_ms=phase_ms,
        duration_sec=duration_sec,
    )
    low_stats = _series_segment_stats(
        low_attack,
        frame_rate=float(low_attack_rate),
        bpm=bpm,
        phase_ms=phase_ms,
        duration_sec=duration_sec,
    )
    intro_edge_stats = _score_intro_leading_edge_grid(
        raw_full_attack,
        envelope_rate=full_attack_rate,
        bpm=bpm,
        phase_ms=phase_ms,
        duration_sec=duration_sec,
    )

    edge_stats: dict[str, Any] = {}
    for target_offset_ms in (8.0, 10.0, 12.0):
        stats = _score_leading_edge_grid(
            full_attack,
            envelope_rate=full_attack_rate,
            bpm=bpm,
            phase_ms=phase_ms,
            duration_sec=duration_sec,
            target_peak_offset_ms=target_offset_ms,
        )
        if stats is None:
            continue
        if not edge_stats or float(stats["leadingEdgeScore"]) > float(edge_stats["leadingEdgeScore"]):
            edge_stats = dict(stats)
            edge_stats["leadingEdgeTargetOffsetMs"] = target_offset_ms

    return {
        "dpBeatMean": beat_stats["mean"],
        "dpBeatSegmentAgreement": beat_stats["agreement"],
        "dpBeatSegmentMin": beat_stats["minimum"],
        "dpBeatSupport": beat_stats["support"],
        "dpFullAttackMean": full_stats["mean"],
        "dpFullAttackSegmentAgreement": full_stats["agreement"],
        "dpLowAttackMean": low_stats["mean"],
        "dpLowAttackSegmentAgreement": low_stats["agreement"],
        **intro_edge_stats,
        **edge_stats,
    }


def _score_constant_candidate(candidate: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    features = dict(candidate.get("features") or {})
    source = str(candidate.get("source") or "")
    tempo_source = str(candidate.get("tempoSource") or "")
    phase_source = str(candidate.get("phaseSource") or "")

    tempo_score = _to_float(features.get("tempoScore"))
    phase_score = _to_float(features.get("phaseScore"))
    downbeat_score = _to_float(features.get("downbeatScore"))
    support_ratio = _to_float(features.get("phaseSupportRatio"))
    compactness = _to_float(features.get("phaseCompactness"))
    beat_agreement = _to_float(features.get("dpBeatSegmentAgreement"))
    full_agreement = _to_float(features.get("dpFullAttackSegmentAgreement"))
    low_agreement = _to_float(features.get("dpLowAttackSegmentAgreement"))
    leading_edge = _to_float(features.get("leadingEdgeScore"))
    leading_consistency = _to_float(features.get("leadingEdgeConsistencyScore"))
    leading_mad = _to_float(features.get("leadingEdgePeakOffsetMadMs"), 14.0)
    phase_shift = _to_float(features.get("phaseShiftMs"), 0.0)
    downbeat_rank = int(features.get("downbeatRank") or 0)
    downbeat_delta = max(0.0, _to_float(features.get("downbeatDeltaToBest")))

    quantized_tempo_bonus = 0.025 if abs(_to_float(candidate.get("bpm")) - round(_to_float(candidate.get("bpm")))) <= 0.000001 else 0.0
    octave_penalty = 0.16 if "half" in tempo_source or "double" in tempo_source or "half" in source or "double" in source else 0.0
    leading_source_bonus = 0.035 if phase_source == "window-beat-leading-edge" else 0.0
    negative_edge_bonus = 0.055 if -24.0 <= phase_shift <= -3.0 else (-0.035 if phase_shift > 0.0 else 0.0)
    edge_mad_penalty = 0.08 * min(1.0, max(0.0, leading_mad) / 14.0)
    downbeat_alternative_penalty = min(0.08, float(downbeat_rank) * 0.006 + downbeat_delta * 0.18)

    score = (
        tempo_score * 0.16
        + phase_score * 0.11
        + downbeat_score * 0.10
        + support_ratio * 0.12
        + compactness * 0.08
        + beat_agreement * 0.13
        + full_agreement * 0.08
        + low_agreement * 0.06
        + leading_edge * 0.09
        + leading_consistency * 0.07
        + quantized_tempo_bonus
        + leading_source_bonus
        + negative_edge_bonus
        - edge_mad_penalty
        - downbeat_alternative_penalty
        - octave_penalty
    )
    features["constantGridDpScore"] = _round_feature(score)
    features["constantGridDpNegativeEdgeBonus"] = _round_feature(negative_edge_bonus)
    features["constantGridDpOctavePenalty"] = _round_feature(octave_penalty)
    features["constantGridDpDownbeatAlternativePenalty"] = _round_feature(downbeat_alternative_penalty)
    return score, features


def _diagnostic_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": _candidate_source(candidate),
        "score": round(_to_float(candidate.get("score")), 6),
        "bpm": round(_to_float(candidate.get("bpm")), 6),
        "firstBeatMs": round(_to_float(candidate.get("firstBeatMs")), 3),
        "barBeatOffset": int(candidate.get("barBeatOffset") or 0) % 32,
        "features": dict(candidate.get("features") or {}),
    }


def _dedupe_ranked_candidates(candidates: list[dict[str, Any]], *, limit: int) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda item: _to_float(item.get("score")), reverse=True):
        bpm = _to_float(candidate.get("bpm"))
        phase_ms = _to_float(candidate.get("firstBeatMs"))
        bar = int(candidate.get("barBeatOffset") or 0) % 4
        duplicate = False
        for item in deduped:
            if abs(bpm - _to_float(item.get("bpm"))) > 0.035:
                continue
            if bar != int(item.get("barBeatOffset") or 0) % 4:
                continue
            interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
            if abs(_phase_delta_ms(phase_ms, _to_float(item.get("firstBeatMs")), interval_ms)) <= 0.5:
                duplicate = True
                break
        if duplicate:
            continue
        deduped.append(candidate)
        if limit > 0 and len(deduped) >= limit:
            break
    return deduped


def _add_phase_path_features(
    candidates: list[dict[str, Any]],
    *,
    envelope: np.ndarray,
    envelope_rate: int,
    duration_sec: float,
    limit: int = 40,
) -> None:
    for candidate in candidates[: max(0, limit)]:
        features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
        phase_path_stats = _score_phase_path_grid(
            envelope,
            envelope_rate=envelope_rate,
            bpm=_to_float(candidate.get("bpm")),
            phase_ms=_to_float(candidate.get("firstBeatMs")),
            duration_sec=duration_sec,
        )
        candidate["features"] = {**features, **phase_path_stats}


def build_constant_grid_dp_candidates(
    *,
    metadata: dict[str, Any],
    arrays: dict[str, Any],
    min_bpm: float = DEFAULT_MIN_BPM,
    max_bpm: float = DEFAULT_MAX_BPM,
    tempo_step_bpm: float = DEFAULT_TEMPO_STEP_BPM,
    tempo_limit: int = DEFAULT_TEMPO_LIMIT,
    phase_step_ms: float = DEFAULT_PHASE_STEP_MS,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
) -> list[dict[str, Any]]:
    duration_sec = _to_float((metadata.get("audio") or {}).get("durationSec"))
    beat_logits = _sigmoid(np.asarray(arrays["beatLogits"], dtype="float64"))
    downbeat_logits = _sigmoid(np.asarray(arrays["downbeatLogits"], dtype="float64"))
    full_attack = np.asarray(arrays["fullAttackEnvelope"], dtype="float64")
    low_attack = np.asarray(arrays["lowrateAttackEnvelope"], dtype="float64")
    full_attack_rate = int(np.asarray(arrays["fullAttackSampleRate"]).item())
    low_attack_rate = int(np.asarray(arrays["lowrateAttackSampleRate"]).item())
    full_window = max(1, int(round(float(full_attack_rate) * 0.008)))
    low_window = max(1, int(round(float(low_attack_rate) * 0.012)))
    score_full_attack = moving_average(full_attack, full_window)
    score_low_attack = moving_average(low_attack, low_window)

    seed_candidates = _build_grid_candidates(
        metadata=metadata,
        arrays=arrays,
        min_bpm=min_bpm,
        max_bpm=max_bpm,
        tempo_step_bpm=tempo_step_bpm,
        tempo_limit=tempo_limit,
        coarse_phase_step_ms=phase_step_ms,
        max_candidates=max_candidates,
    )

    rescored: list[dict[str, Any]] = []
    for candidate in seed_candidates:
        signal_features = _candidate_signal_features(
            candidate=candidate,
            beat_logits=beat_logits,
            raw_full_attack=full_attack,
            full_attack=score_full_attack,
            low_attack=score_low_attack,
            full_attack_rate=full_attack_rate,
            low_attack_rate=low_attack_rate,
            duration_sec=duration_sec,
        )
        candidate_features = {**dict(candidate.get("features") or {}), **signal_features}
        downbeat_lattice = _downbeat_lattice(
            downbeat_logits=downbeat_logits,
            bpm=_to_float(candidate.get("bpm")),
            phase_ms=_to_float(candidate.get("firstBeatMs")),
            duration_sec=duration_sec,
        )
        for best_downbeat in downbeat_lattice:
            next_features = dict(candidate_features)
            next_features["downbeatScore"] = best_downbeat["score"]
            next_features["downbeatMargin"] = best_downbeat["margin"]
            next_features["downbeatRank"] = best_downbeat["rank"]
            next_features["downbeatDeltaToBest"] = best_downbeat["deltaToBest"]
            next_features["downbeatSupport"] = best_downbeat["support"]
            next_candidate = {
                **candidate,
                "barBeatOffset": int(best_downbeat["barBeatOffset"]) % 4,
                "features": next_features,
            }
            score, features = _score_constant_candidate(next_candidate)
            next_candidate["score"] = round(score, 6)
            next_candidate["features"] = features
            next_candidate["source"] = "constant-grid-dp"
            rescored.append(next_candidate)

    ranked = _dedupe_ranked_candidates(rescored, limit=max_candidates)
    _add_phase_path_features(
        ranked,
        envelope=score_full_attack,
        envelope_rate=full_attack_rate,
        duration_sec=duration_sec,
    )
    return ranked


def solve_constant_grid_dp(
    *,
    metadata: dict[str, Any],
    arrays: dict[str, Any],
    min_bpm: float = DEFAULT_MIN_BPM,
    max_bpm: float = DEFAULT_MAX_BPM,
    tempo_step_bpm: float = DEFAULT_TEMPO_STEP_BPM,
    tempo_limit: int = DEFAULT_TEMPO_LIMIT,
    phase_step_ms: float = DEFAULT_PHASE_STEP_MS,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
) -> dict[str, Any]:
    candidates = build_constant_grid_dp_candidates(
        metadata=metadata,
        arrays=arrays,
        min_bpm=min_bpm,
        max_bpm=max_bpm,
        tempo_step_bpm=tempo_step_bpm,
        tempo_limit=tempo_limit,
        phase_step_ms=phase_step_ms,
        max_candidates=max_candidates,
    )
    raw_legacy_candidate = _metadata_legacy_candidate(metadata)
    legacy_outside_configured_range = bool(
        raw_legacy_candidate is not None
        and not _candidate_is_within_bpm_range(raw_legacy_candidate, min_bpm, max_bpm)
    )
    legacy_candidate = None if legacy_outside_configured_range else raw_legacy_candidate
    if not candidates and legacy_candidate is None:
        if legacy_outside_configured_range:
            raise RuntimeError("constant-grid-dp has no candidate within configured BPM range")
        raise RuntimeError("constant-grid-dp candidate pool is empty")

    new_selected = candidates[0] if candidates else None
    if new_selected is not None:
        confidence, confidence_level, low_reasons = confidence_from_selected(
            selected=new_selected,
            ranked=candidates,
            legacy_candidate=legacy_candidate,
        )
    else:
        confidence, confidence_level, low_reasons = 0.0, "low", ["no-constant-grid-candidate"]

    conservative_switch = bool(
        new_selected is not None
        and confidence_level != "high"
        and passes_conservative_switch_guard(
            selected=new_selected,
            legacy_candidate=legacy_candidate,
        )
    )
    phase_evidence_selected, phase_evidence_score, phase_evidence_rank = select_phase_evidence_candidate(
        candidates
    )
    legacy_weakness = legacy_weakness_score(legacy_candidate)
    phase_evidence_switch = bool(
        legacy_candidate is not None
        and phase_evidence_selected is not None
        and phase_evidence_score >= PHASE_EVIDENCE_SWITCH_THRESHOLD
        and legacy_weakness >= PHASE_EVIDENCE_LEGACY_WEAKNESS_THRESHOLD
    )
    primary_new_switch = bool(new_selected is not None and (confidence_level == "high" or conservative_switch))
    use_new = bool(primary_new_switch or phase_evidence_switch or legacy_candidate is None)
    if primary_new_switch or legacy_candidate is None:
        selected = new_selected
    elif phase_evidence_switch and phase_evidence_selected is not None:
        selected = phase_evidence_selected
    else:
        selected = legacy_candidate
    audio = metadata.get("audio") if isinstance(metadata.get("audio"), dict) else {}
    duration_sec = _to_float(audio.get("durationSec"))
    baseline_selected_source = _candidate_source(selected) if use_new else "constant-grid-dp:legacy-fallback"
    baseline_ranker_selected = {
        **selected,
        "features": {
            **dict(selected.get("features") or {}),
            "constantGridDpConfidence": round(confidence, 6),
            "constantGridDpConfidenceLevel": confidence_level,
            "constantGridDpLowConfidenceReasons": low_reasons,
            "constantGridDpUsedNewCandidate": use_new,
            "constantGridDpConservativeSwitch": conservative_switch,
            "constantGridDpPhaseEvidenceSwitch": phase_evidence_switch,
            "constantGridDpPhaseEvidenceSwitchScore": phase_evidence_score,
            "constantGridDpPhaseEvidenceRank": phase_evidence_rank,
            "constantGridDpLegacyWeaknessScore": legacy_weakness,
        },
    }
    locked_ranker_selected, locked_ranker_meta = choose_locked_rising_edge_candidate(
        candidates=candidates,
        selected=baseline_ranker_selected,
        selected_source=baseline_selected_source,
        arrays=arrays,
        duration_sec=duration_sec,
    )
    locked_phase_downbeat_meta: dict[str, Any] = {
        "applied": False,
        "reason": "locked-ranker-not-selected",
    }
    if locked_ranker_selected is not None:
        locked_ranker_selected, locked_phase_downbeat_meta = (
            preserve_locked_phase_switch_downbeat_ordinal(
                candidate=locked_ranker_selected,
                legacy_candidate=legacy_candidate,
            )
        )
    locked_ranker_switch = locked_ranker_selected is not None
    if locked_ranker_switch:
        selected = locked_ranker_selected
        use_new = True
    rank1_legacy_weakness_selected, rank1_legacy_weakness_meta = (
        choose_rank1_locked_legacy_weakness_candidate(
            candidates=candidates,
            selected_source=baseline_selected_source,
            legacy_candidate=legacy_candidate,
        )
    )
    rank1_legacy_weakness_switch = bool(
        not locked_ranker_switch and rank1_legacy_weakness_selected is not None
    )
    if rank1_legacy_weakness_switch:
        selected = rank1_legacy_weakness_selected
        use_new = True
    rank1_structural_phase_selected, rank1_structural_phase_meta = (
        choose_rank1_structural_phase_candidate(
            candidates=candidates,
            selected_source=baseline_selected_source,
            legacy_candidate=legacy_candidate,
        )
    )
    rank1_structural_phase_switch = bool(
        not locked_ranker_switch
        and not rank1_legacy_weakness_switch
        and rank1_structural_phase_selected is not None
    )
    if (
        not rank1_structural_phase_switch
        and (locked_ranker_switch or rank1_legacy_weakness_switch)
        and rank1_structural_phase_selected is not None
    ):
        rank1_structural_phase_meta = {
            **rank1_structural_phase_meta,
            "selected": False,
            "reason": "previous-switch-selected",
        }
    if rank1_structural_phase_switch:
        selected = rank1_structural_phase_selected
        use_new = True
    rank1_high_structural_score_selected, rank1_high_structural_score_meta = (
        choose_rank1_high_structural_score_candidate(
            candidates=candidates,
            selected_source=baseline_selected_source,
            legacy_candidate=legacy_candidate,
        )
    )
    rank1_high_structural_score_switch = bool(
        not locked_ranker_switch
        and not rank1_legacy_weakness_switch
        and not rank1_structural_phase_switch
        and rank1_high_structural_score_selected is not None
    )
    if (
        not rank1_high_structural_score_switch
        and (locked_ranker_switch or rank1_legacy_weakness_switch or rank1_structural_phase_switch)
        and rank1_high_structural_score_selected is not None
    ):
        rank1_high_structural_score_meta = {
            **rank1_high_structural_score_meta,
            "selected": False,
            "reason": "previous-switch-selected",
        }
    if rank1_high_structural_score_switch:
        selected = rank1_high_structural_score_selected
        use_new = True
    previous_switch_selected = bool(
        locked_ranker_switch
        or rank1_legacy_weakness_switch
        or rank1_structural_phase_switch
        or rank1_high_structural_score_switch
        or use_new
    )
    if previous_switch_selected:
        head_near_zero_selected, head_near_zero_meta = None, {"reason": "previous-switch-selected"}
    else:
        head_near_zero_selected, head_near_zero_meta = choose_head_near_zero_candidate(
            candidates=candidates,
            selected_source=baseline_selected_source,
            legacy_candidate=legacy_candidate,
        )
    head_near_zero_switch = bool(not previous_switch_selected and head_near_zero_selected is not None)
    if head_near_zero_switch:
        selected = head_near_zero_selected
        use_new = True
    rank1_negative_legacy_score_selected, rank1_negative_legacy_score_meta = (
        choose_rank1_negative_legacy_score_candidate(
            candidates=candidates,
            selected_source=baseline_selected_source,
            legacy_candidate=legacy_candidate,
        )
    )
    rank1_negative_legacy_score_switch = bool(
        not previous_switch_selected
        and not head_near_zero_switch
        and rank1_negative_legacy_score_selected is not None
    )
    if (
        not rank1_negative_legacy_score_switch
        and (previous_switch_selected or head_near_zero_switch)
        and rank1_negative_legacy_score_selected is not None
    ):
        rank1_negative_legacy_score_meta = {
            **rank1_negative_legacy_score_meta,
            "selected": False,
            "reason": "previous-switch-selected",
        }
    if rank1_negative_legacy_score_switch:
        selected = rank1_negative_legacy_score_selected
        use_new = True
    rank1_octave_down_selected, rank1_octave_down_meta = choose_rank1_octave_down_candidate(
        candidates=candidates,
        selected_source=baseline_selected_source,
        legacy_candidate=legacy_candidate,
        confidence=confidence,
    )
    rank1_octave_down_switch = bool(
        not previous_switch_selected
        and not head_near_zero_switch
        and not rank1_negative_legacy_score_switch
        and rank1_octave_down_selected is not None
    )
    if not rank1_octave_down_switch and rank1_octave_down_selected is not None:
        rank1_octave_down_meta = {
            **rank1_octave_down_meta,
            "selected": False,
            "reason": "previous-switch-selected",
        }
    if rank1_octave_down_switch:
        selected = rank1_octave_down_selected
        use_new = True
    integer_bpm_snap_meta: dict[str, Any] = {
        "snapped": False,
        "originalBpm": _round_feature(_to_float(selected.get("bpm"))),
        "snappedBpm": _round_feature(_to_float(selected.get("bpm"))),
        "deltaBpm": 0.0,
        "maxDeltaBpm": 0.04,
    }
    if not use_new:
        selected, integer_bpm_snap_meta = snap_legacy_integer_bpm(
            selected=selected,
            selected_source=baseline_selected_source,
        )

    selected, official_phase_meta = _apply_official_phase_refiner(
        selected=selected,
        arrays=arrays,
        duration_sec=duration_sec,
    )
    official_phase_applied = bool(official_phase_meta.get("applied"))
    selected, official_downbeat_meta = _apply_official_downbeat_selector(
        selected=selected,
        arrays=arrays,
        duration_sec=duration_sec,
    )
    official_downbeat_applied = bool(official_downbeat_meta.get("applied"))

    selected_bpm = _to_float(selected.get("bpm"))
    selected_first_beat_ms = _to_float(selected.get("firstBeatMs"))
    beat_interval_sec = 60.0 / selected_bpm if selected_bpm > 0.0 else 0.0
    window = _window_summary(metadata)
    selected_score = _to_float(selected.get("score"))
    selected_features = dict(selected.get("features") or {})
    candidate_payload = [_diagnostic_candidate(item) for item in candidates]
    if legacy_candidate is not None:
        legacy_payload = selected if bool(integer_bpm_snap_meta.get("snapped")) else legacy_candidate
        candidate_payload.append(_diagnostic_candidate(legacy_payload))

    if locked_ranker_switch:
        guard = "constant-grid-dp-locked-rising-edge-ranker"
    elif rank1_legacy_weakness_switch:
        guard = "constant-grid-dp-rank1-locked-legacy-weakness-switch"
    elif rank1_structural_phase_switch:
        guard = "constant-grid-dp-rank1-structural-phase-switch"
    elif rank1_high_structural_score_switch:
        guard = "constant-grid-dp-rank1-high-structural-score-switch"
    elif rank1_negative_legacy_score_switch:
        guard = "constant-grid-dp-rank1-negative-legacy-score-switch"
    elif rank1_octave_down_switch:
        guard = "constant-grid-dp-rank1-octave-down-switch"
    elif head_near_zero_switch:
        guard = "constant-grid-dp-head-near-zero-switch"
    elif confidence_level == "high" and use_new:
        guard = "constant-grid-dp-high-confidence"
    elif conservative_switch and use_new:
        guard = "constant-grid-dp-conservative-switch"
    elif phase_evidence_switch and use_new:
        guard = "constant-grid-dp-phase-evidence-switch"
    elif legacy_outside_configured_range and use_new:
        guard = "constant-grid-dp-configured-bpm-range"
    elif bool(integer_bpm_snap_meta.get("snapped")):
        guard = "legacy-fallback-integer-bpm-snap"
    else:
        guard = "legacy-fallback-low-confidence"
    original_guard = guard
    if official_phase_applied:
        guard = f"{guard}+official-high-attack-overall-shape"
    if official_phase_applied:
        original_source = _candidate_source(selected) if use_new else baseline_selected_source
        selected_source = f"{original_source}:official-high-attack-overall-shape"
        refined_payload = _diagnostic_candidate(selected)
        refined_payload["source"] = selected_source
        candidate_payload.append(refined_payload)
    elif use_new:
        selected_source = _candidate_source(selected)
    else:
        selected_source = "constant-grid-dp:legacy-fallback"
    if official_downbeat_applied:
        guard = f"{guard}+official-downbeat-rotation"
        selected_source = f"{selected_source}:official-downbeat-rotation"
        downbeat_payload = _diagnostic_candidate(selected)
        downbeat_payload["source"] = selected_source
        candidate_payload.append(downbeat_payload)
    anchor_confidence_score = (
        _to_float(locked_ranker_meta.get("probability"))
        if locked_ranker_switch
        else _to_float(rank1_legacy_weakness_meta.get("probability"))
        if rank1_legacy_weakness_switch
        else _to_float(rank1_structural_phase_meta.get("probability"))
        if rank1_structural_phase_switch
        else _to_float(rank1_high_structural_score_meta.get("gridScore"))
        if rank1_high_structural_score_switch
        else _to_float(rank1_negative_legacy_score_meta.get("gridScore"))
        if rank1_negative_legacy_score_switch
        else _to_float(rank1_octave_down_meta.get("gridScore"))
        if rank1_octave_down_switch
        else selected_score
        if head_near_zero_switch
        else confidence if use_new else _to_float(selected.get("score"))
    )

    return {
        "bpm": round(selected_bpm, 6),
        "rawBpm": round(selected_bpm, 6),
        "firstBeatMs": round(selected_first_beat_ms, 3),
        "rawFirstBeatMs": round(selected_first_beat_ms, 3),
        "absoluteFirstBeatMs": round(selected_first_beat_ms, 3),
        "absoluteRawFirstBeatMs": round(selected_first_beat_ms, 3),
        "barBeatOffset": int(selected.get("barBeatOffset") or 0) % 32,
        "beatCount": int(window["beatCount"]),
        "downbeatCount": int(window["downbeatCount"]),
        "durationSec": round(duration_sec, 3),
        "beatIntervalSec": round(beat_interval_sec, 6),
        "qualityScore": float(window["qualityScore"]),
        "anchorCorrectionMs": 0.0,
        "anchorConfidenceScore": round(anchor_confidence_score, 6),
        "anchorMatchedBeatCount": 0,
        "anchorStrategy": "constant-grid-dp",
        "windowIndex": int(window["windowIndex"]),
        "windowStartSec": 0.0,
        "windowDurationSec": float(window["windowDurationSec"]),
        "beatThisEstimatedDrift128Ms": 0.0,
        "beatThisWindowCount": int(window["windowCount"]),
        "gridSolverSelectedSource": selected_source,
        "gridSolverCandidateCount": len(candidate_payload),
        "gridSolverScore": round(selected_score, 6),
        "gridSolverSelectionGuard": guard,
        "gridSolverSelectionGuardScoreMargin": round(
            _to_float((new_selected or {}).get("score")) - _to_float(candidates[1].get("score")) if len(candidates) > 1 else 0.0,
            6,
        ),
        "gridSolverFeatures": {
            **selected_features,
            "solverVersion": SOLVER_VERSION,
            "constantGridDpConfidence": round(confidence, 6),
            "constantGridDpConfidenceLevel": confidence_level,
            "constantGridDpLowConfidenceReasons": low_reasons,
            "constantGridDpUsedNewCandidate": use_new,
            "constantGridDpConservativeSwitch": conservative_switch,
            "constantGridDpPhaseEvidenceSwitch": phase_evidence_switch,
            "constantGridDpPhaseEvidenceSwitchScore": phase_evidence_score,
            "constantGridDpPhaseEvidenceRank": phase_evidence_rank,
            "constantGridDpLegacyWeaknessScore": legacy_weakness,
            "constantGridDpLegacyOutsideConfiguredBpmRange": legacy_outside_configured_range,
            "constantGridDpConfiguredMinBpm": round(float(min_bpm), 6),
            "constantGridDpConfiguredMaxBpm": round(float(max_bpm), 6),
            "constantGridDpLegacyIntegerBpmSnap": bool(integer_bpm_snap_meta.get("snapped")),
            "constantGridDpLegacyIntegerBpmOriginalBpm": _to_float(
                integer_bpm_snap_meta.get("originalBpm")
            ),
            "constantGridDpLegacyIntegerBpmSnappedBpm": _to_float(
                integer_bpm_snap_meta.get("snappedBpm")
            ),
            "constantGridDpLegacyIntegerBpmDelta": _to_float(integer_bpm_snap_meta.get("deltaBpm")),
            "constantGridDpLegacyIntegerBpmMaxDelta": _to_float(
                integer_bpm_snap_meta.get("maxDeltaBpm"), 0.04
            ),
            "officialHighAttackPhaseApplied": official_phase_applied,
            "officialHighAttackPhaseReason": str(official_phase_meta.get("reason") or ""),
            "officialHighAttackPhaseVersion": str(official_phase_meta.get("version") or ""),
            "officialHighAttackPhaseOriginalGuard": original_guard,
            "officialHighAttackPhaseOriginalFirstBeatMs": _to_float(
                official_phase_meta.get("originalFirstBeatMs")
            ),
            "officialHighAttackPhaseRefinedFirstBeatMs": _to_float(
                official_phase_meta.get("refinedFirstBeatMs")
            ),
            "officialHighAttackPhaseShiftMs": _to_float(official_phase_meta.get("shiftMs")),
            "officialDownbeatRotationApplied": official_downbeat_applied,
            "officialDownbeatRotationReason": str(official_downbeat_meta.get("reason") or ""),
            "officialDownbeatRotationVersion": str(official_downbeat_meta.get("version") or ""),
            "officialDownbeatRotationArtifactVersion": str(official_downbeat_meta.get("artifactVersion") or ""),
            "officialDownbeatRotationOriginal": int(
                official_downbeat_meta.get("currentRotation") or 0
            ),
            "officialDownbeatRotationSelected": int(
                official_downbeat_meta.get("selectedRotation") or 0
            ),
            "officialDownbeatRotationEvidenceTop": int(
                official_downbeat_meta.get("evidenceTopRotation") or 0
            ),
            "officialDownbeatRotationAdvantage": _to_float(
                official_downbeat_meta.get("advantage")
            ),
            "officialDownbeatRotationMargin": _to_float(
                official_downbeat_meta.get("margin")
            ),
            "officialDownbeatRotationBlockAgreement": _to_float(
                official_downbeat_meta.get("blockAgreement")
            ),
            "constantGridDpLockedRisingEdgeRankerSwitch": locked_ranker_switch,
            "constantGridDpLockedRisingEdgeRankerReason": str(locked_ranker_meta.get("reason") or ""),
            "constantGridDpLockedRisingEdgeRankerProbability": round(_to_float(locked_ranker_meta.get("probability")), 9),
            "constantGridDpLockedRisingEdgeRankerCandidateRank": int(locked_ranker_meta.get("candidateRank") or 0),
            "constantGridDpLockedRisingEdgeRankerThreshold": _to_float(locked_ranker_meta.get("threshold"), 0.93),
            "constantGridDpLockedRisingEdgeRankerVersion": str(locked_ranker_meta.get("version") or ""),
            "constantGridDpLockedPhaseDownbeatOrdinalPreserved": bool(
                locked_phase_downbeat_meta.get("applied")
            ),
            "constantGridDpLockedPhaseDownbeatOrdinalReason": str(
                locked_phase_downbeat_meta.get("reason") or ""
            ),
            "constantGridDpLockedPhaseDownbeatOriginalBarBeatOffset": int(
                locked_phase_downbeat_meta.get("originalBarBeatOffset") or 0
            ),
            "constantGridDpLockedPhaseDownbeatLegacyBarBeatOffset": int(
                locked_phase_downbeat_meta.get("legacyBarBeatOffset") or 0
            ),
            "constantGridDpLockedPhaseDownbeatAdjustedBarBeatOffset": int(
                locked_phase_downbeat_meta.get("adjustedBarBeatOffset") or 0
            ),
            "constantGridDpLockedPhaseDownbeatPhaseWrapBeats": int(
                locked_phase_downbeat_meta.get("phaseWrapBeats") or 0
            ),
            "constantGridDpLockedPhaseDownbeatVersion": str(
                locked_phase_downbeat_meta.get("version") or ""
            ),
            **rank1_switch_diagnostic_features(
                rank1_legacy_weakness_switch=rank1_legacy_weakness_switch,
                rank1_legacy_weakness_meta=rank1_legacy_weakness_meta,
                rank1_structural_phase_switch=rank1_structural_phase_switch,
                rank1_structural_phase_meta=rank1_structural_phase_meta,
            ),
            **rank1_high_structural_score_diagnostic_features(
                rank1_high_structural_score_switch=rank1_high_structural_score_switch,
                rank1_high_structural_score_meta=rank1_high_structural_score_meta,
            ),
            **rank1_negative_legacy_score_diagnostic_features(
                rank1_negative_legacy_score_switch=rank1_negative_legacy_score_switch,
                rank1_negative_legacy_score_meta=rank1_negative_legacy_score_meta,
            ),
            **rank1_octave_down_diagnostic_features(
                rank1_octave_down_switch=rank1_octave_down_switch,
                rank1_octave_down_meta=rank1_octave_down_meta,
            ),
            **head_near_zero_switch_diagnostic_features(
                head_near_zero_switch=head_near_zero_switch,
                head_near_zero_meta=head_near_zero_meta,
            ),
        },
        "gridSolverTopCandidates": candidate_payload[:10],
        "gridSolverCandidates": candidate_payload,
    }


def solve_constant_grid_dp_from_cache(**kwargs: Any) -> dict[str, Any]:
    from rkb_constant_grid_dp_cache import solve_constant_grid_dp_from_cache as solve_from_cache
    return solve_from_cache(**kwargs)


if __name__ == "__main__":
    from rkb_constant_grid_dp_cli import main as _main
    raise SystemExit(_main())
