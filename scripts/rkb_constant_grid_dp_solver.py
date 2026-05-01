import argparse
import math
import statistics
from pathlib import Path
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
from rkb_beatgrid_lab_common import (
    DEFAULT_FEATURE_CACHE_DIR,
    build_feature_index_map,
    configure_utf8_stdio,
    normalize_lookup_key,
    print_json,
    read_feature_metadata,
    resolve_feature_arrays_path,
    resolve_feature_entry,
)
from rkb_hybrid_beatgrid_solver import _metadata_legacy_candidate, _window_summary

DEFAULT_MIN_BPM = 70.0
DEFAULT_MAX_BPM = 200.0
DEFAULT_TEMPO_STEP_BPM = 0.5
DEFAULT_TEMPO_LIMIT = 24
DEFAULT_PHASE_STEP_MS = 2.0
DEFAULT_MAX_CANDIDATES = 640
SOLVER_VERSION = "constant-grid-dp-cache-v1"


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric if math.isfinite(numeric) else default


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))


def _candidate_source(candidate: dict[str, Any]) -> str:
    tempo_source = str(candidate.get("tempoSource") or "tempo")
    phase_source = str(candidate.get("phaseSource") or "phase")
    bar_source = str(candidate.get("barSource") or "bar")
    return f"constant-grid-dp:{tempo_source}:{phase_source}:{bar_source}"


def _round_feature(value: float) -> float:
    return round(float(value), 6) if math.isfinite(float(value)) else 0.0


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


def _confidence_from_selected(
    *,
    selected: dict[str, Any],
    ranked: list[dict[str, Any]],
    legacy_candidate: dict[str, Any] | None,
) -> tuple[float, str, list[str]]:
    selected_features = selected.get("features") if isinstance(selected.get("features"), dict) else {}
    selected_score = _to_float(selected.get("score"))
    next_score = _to_float(ranked[1].get("score")) if len(ranked) > 1 else selected_score
    margin = selected_score - next_score
    downbeat_margin = _to_float(selected_features.get("downbeatMargin"))
    beat_agreement = _to_float(selected_features.get("dpBeatSegmentAgreement"))
    full_agreement = _to_float(selected_features.get("dpFullAttackSegmentAgreement"))
    phase_shift = _to_float(selected_features.get("phaseShiftMs"), 0.0)
    leading_mad = _to_float(selected_features.get("leadingEdgePeakOffsetMadMs"), 14.0)

    confidence = 0.0
    confidence += _clamp01(margin / 0.08) * 0.24
    confidence += _clamp01(downbeat_margin / 0.18) * 0.16
    confidence += _clamp01(beat_agreement) * 0.18
    confidence += _clamp01(full_agreement) * 0.12
    confidence += _clamp01((14.0 - leading_mad) / 14.0) * 0.12
    confidence += (0.12 if -24.0 <= phase_shift <= -3.0 else 0.02)
    if legacy_candidate is not None:
        legacy_features = legacy_candidate.get("features") if isinstance(legacy_candidate.get("features"), dict) else {}
        legacy_score = _to_float(legacy_features.get("legacyGridSolverScore"))
        confidence += _clamp01((6.0 - legacy_score) / 6.0) * 0.06

    reasons: list[str] = []
    if margin < 0.035:
        reasons.append("weak-phase-margin")
    if downbeat_margin < 0.08:
        reasons.append("weak-downbeat-margin")
    if beat_agreement < 0.55:
        reasons.append("weak-beat-segment-agreement")
    if leading_mad > 8.0:
        reasons.append("wide-leading-edge-offset")
    if not (-28.0 <= phase_shift <= 4.0):
        reasons.append("untrusted-leading-edge-shift")

    confidence = _clamp01(confidence)
    if confidence >= 0.98 and not reasons and margin >= 0.16 and downbeat_margin >= 0.18:
        return confidence, "high", []
    if confidence >= 0.58 and len(reasons) <= 2:
        return confidence, "medium", reasons
    return confidence, "low", reasons


def _passes_conservative_switch_guard(
    *,
    selected: dict[str, Any],
    legacy_candidate: dict[str, Any] | None,
) -> bool:
    if legacy_candidate is None:
        return True
    selected_features = selected.get("features") if isinstance(selected.get("features"), dict) else {}
    legacy_features = (
        legacy_candidate.get("features") if isinstance(legacy_candidate.get("features"), dict) else {}
    )
    legacy_solver_score = _to_float(legacy_features.get("legacyGridSolverScore"), 999.0)
    selected_score = _to_float(selected.get("score"))
    downbeat_score = _to_float(selected_features.get("downbeatScore"))
    tempo_score = _to_float(selected_features.get("tempoScore"))
    return (
        legacy_solver_score <= 2.5
        and selected_score >= 0.84
        and tempo_score >= 0.85
        and downbeat_score <= 0.65
    )


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

    return _dedupe_ranked_candidates(rescored, limit=max_candidates)


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
    legacy_candidate = _metadata_legacy_candidate(metadata)
    if not candidates and legacy_candidate is None:
        raise RuntimeError("constant-grid-dp candidate pool is empty")

    new_selected = candidates[0] if candidates else None
    if new_selected is not None:
        confidence, confidence_level, low_reasons = _confidence_from_selected(
            selected=new_selected,
            ranked=candidates,
            legacy_candidate=legacy_candidate,
        )
    else:
        confidence, confidence_level, low_reasons = 0.0, "low", ["no-constant-grid-candidate"]

    conservative_switch = bool(
        new_selected is not None
        and confidence_level != "high"
        and _passes_conservative_switch_guard(
            selected=new_selected,
            legacy_candidate=legacy_candidate,
        )
    )
    use_new = bool(new_selected is not None and (confidence_level == "high" or conservative_switch))
    selected = new_selected if use_new or legacy_candidate is None else legacy_candidate
    selected_bpm = _to_float(selected.get("bpm"))
    selected_first_beat_ms = _to_float(selected.get("firstBeatMs"))
    beat_interval_sec = 60.0 / selected_bpm if selected_bpm > 0.0 else 0.0
    audio = metadata.get("audio") if isinstance(metadata.get("audio"), dict) else {}
    duration_sec = _to_float(audio.get("durationSec"))
    window = _window_summary(metadata)
    selected_score = _to_float(selected.get("score"))
    selected_features = dict(selected.get("features") or {})
    candidate_payload = [_diagnostic_candidate(item) for item in candidates]
    if legacy_candidate is not None:
        candidate_payload.append(_diagnostic_candidate(legacy_candidate))

    if confidence_level == "high" and use_new:
        guard = "constant-grid-dp-high-confidence"
    elif conservative_switch and use_new:
        guard = "constant-grid-dp-conservative-switch"
    else:
        guard = "legacy-fallback-low-confidence"
    if use_new:
        selected_source = _candidate_source(selected)
    else:
        selected_source = "constant-grid-dp:legacy-fallback"

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
        "anchorConfidenceScore": round(confidence if use_new else _to_float(selected.get("score")), 6),
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
        },
        "gridSolverTopCandidates": candidate_payload[:10],
        "gridSolverCandidates": candidate_payload,
    }


def solve_constant_grid_dp_from_cache(
    *,
    track: dict[str, Any],
    feature_cache_dir: Path,
    min_bpm: float = DEFAULT_MIN_BPM,
    max_bpm: float = DEFAULT_MAX_BPM,
    tempo_step_bpm: float = DEFAULT_TEMPO_STEP_BPM,
    tempo_limit: int = DEFAULT_TEMPO_LIMIT,
    phase_step_ms: float = DEFAULT_PHASE_STEP_MS,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
) -> dict[str, Any]:
    index_map = build_feature_index_map(feature_cache_dir)
    entry = resolve_feature_entry(track=track, index_map=index_map)
    if entry is None:
        file_name = str(track.get("fileName") or "")
        raise RuntimeError(f"constant-grid-dp feature cache missing for {file_name}")
    metadata = read_feature_metadata(feature_cache_dir, entry)
    arrays_path = resolve_feature_arrays_path(feature_cache_dir, entry, metadata)
    if not arrays_path.exists():
        raise RuntimeError(f"constant-grid-dp feature arrays missing: {arrays_path}")
    with np.load(arrays_path, allow_pickle=False) as arrays:
        return solve_constant_grid_dp(
            metadata=metadata,
            arrays=arrays,
            min_bpm=min_bpm,
            max_bpm=max_bpm,
            tempo_step_bpm=tempo_step_bpm,
            tempo_limit=tempo_limit,
            phase_step_ms=phase_step_ms,
            max_candidates=max_candidates,
        )


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Solve one cached track with constant-grid-dp")
    parser.add_argument("--feature-cache-dir", default=str(DEFAULT_FEATURE_CACHE_DIR))
    parser.add_argument("--file-name", required=True)
    parser.add_argument("--min-bpm", type=float, default=DEFAULT_MIN_BPM)
    parser.add_argument("--max-bpm", type=float, default=DEFAULT_MAX_BPM)
    parser.add_argument("--tempo-step-bpm", type=float, default=DEFAULT_TEMPO_STEP_BPM)
    parser.add_argument("--tempo-limit", type=int, default=DEFAULT_TEMPO_LIMIT)
    parser.add_argument("--phase-step-ms", type=float, default=DEFAULT_PHASE_STEP_MS)
    parser.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
    args = parser.parse_args()

    result = solve_constant_grid_dp_from_cache(
        track={"fileName": str(args.file_name), "lookupKey": normalize_lookup_key(args.file_name)},
        feature_cache_dir=Path(args.feature_cache_dir),
        min_bpm=float(args.min_bpm),
        max_bpm=float(args.max_bpm),
        tempo_step_bpm=float(args.tempo_step_bpm),
        tempo_limit=int(args.tempo_limit),
        phase_step_ms=float(args.phase_step_ms),
        max_candidates=int(args.max_candidates),
    )
    print_json({"result": result})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
