import math
from typing import Any

PHASE_EVIDENCE_SWITCH_THRESHOLD = 0.905
PHASE_EVIDENCE_LEGACY_WEAKNESS_THRESHOLD = 0.6
LEGACY_INTEGER_BPM_SNAP_MAX_DELTA = 0.04
RANK1_LOCKED_LEGACY_WEAKNESS_PROBABILITY_THRESHOLD = 0.9
RANK1_LOCKED_LEGACY_WEAKNESS_SCORE_MAX = 2.6
RANK1_LOCKED_LEGACY_WEAKNESS_MIN_PHASE_DELTA_MS = 5.0
RANK1_LOCKED_LEGACY_WEAKNESS_VERSION = "rank1-locked-legacy-weakness-v3"
RANK1_STRUCTURAL_PHASE_PROBABILITY_THRESHOLD = 0.86
RANK1_STRUCTURAL_PHASE_LOW_PROBABILITY_THRESHOLD = 0.85
RANK1_STRUCTURAL_PHASE_LEGACY_SCORE_MAX = 6.0
RANK1_STRUCTURAL_PHASE_MIN_PHASE_DELTA_MS = 15.0
RANK1_STRUCTURAL_PHASE_MIN_GRID_SCORE = 0.8
RANK1_STRUCTURAL_PHASE_MIN_DOWNBEAT_MARGIN = 0.1
RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_GRID_SCORE = 0.88
RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_DOWNBEAT_MARGIN = 0.5
RANK1_STRUCTURAL_PHASE_MAX_BPM_DELTA = 0.08
RANK1_STRUCTURAL_PHASE_VERSION = "rank1-structural-phase-v2"
HEAD_NEAR_ZERO_RANK_LIMIT = 8
HEAD_NEAR_ZERO_SCORE_DELTA_MAX = 0.08
HEAD_NEAR_ZERO_TARGET_MAX_MS = 8.0
HEAD_NEAR_ZERO_TOP_MIN_FIRST_BEAT_MS = 90.0
HEAD_NEAR_ZERO_MAX_BPM_DELTA = 0.5
HEAD_NEAR_ZERO_LEGACY_WEAKNESS_MIN = 0.2
HEAD_NEAR_ZERO_VERSION = "head-near-zero-v1"
RANK1_NEGATIVE_LEGACY_SCORE_MIN_GRID_SCORE = 0.85
RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_PATH_SCORE = 0.8
RANK1_NEGATIVE_LEGACY_SCORE_MAX_LEGACY_SCORE = 0.0
RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_DELTA_MS = 5.0
RANK1_NEGATIVE_LEGACY_SCORE_MAX_BPM_DELTA = 0.08
RANK1_NEGATIVE_LEGACY_SCORE_VERSION = "rank1-negative-legacy-score-v1"


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric if math.isfinite(numeric) else default


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))


def _round_feature(value: float) -> float:
    return round(float(value), 6) if math.isfinite(float(value)) else 0.0


def _candidate_source(candidate: dict[str, Any]) -> str:
    tempo_source = str(candidate.get("tempoSource") or "tempo")
    phase_source = str(candidate.get("phaseSource") or "phase")
    bar_source = str(candidate.get("barSource") or "bar")
    return f"constant-grid-dp:{tempo_source}:{phase_source}:{bar_source}"


def _phase_delta_ms(candidate_phase_ms: float, selected_phase_ms: float, interval_ms: float) -> float:
    if interval_ms <= 0.0:
        return candidate_phase_ms - selected_phase_ms
    return (candidate_phase_ms - selected_phase_ms + interval_ms / 2.0) % interval_ms - interval_ms / 2.0


def confidence_from_selected(
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
    confidence += 0.12 if -24.0 <= phase_shift <= -3.0 else 0.02
    if legacy_candidate is not None:
        legacy_features = (
            legacy_candidate.get("features") if isinstance(legacy_candidate.get("features"), dict) else {}
        )
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


def passes_conservative_switch_guard(
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


def phase_evidence_switch_score(candidate: dict[str, Any], *, rank: int) -> float:
    features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    downbeat_rank = int(features.get("downbeatRank") or 0)
    rank_score = _clamp01(1.0 - float(max(0, rank - 1)) / 20.0)
    score = (
        _to_float(candidate.get("score")) * 0.42
        + max(0.0, _to_float(features.get("downbeatMargin"))) * 0.18
        + (0.08 if downbeat_rank == 0 else 0.0)
        + _to_float(features.get("introLeadingEdgeScore")) * 0.18
        + _to_float(features.get("leadingEdgeTargetScore")) * 0.08
        + rank_score * 0.06
    )
    return _round_feature(score)


def legacy_weakness_score(legacy_candidate: dict[str, Any] | None) -> float:
    if legacy_candidate is None:
        return 1.0
    features = legacy_candidate.get("features") if isinstance(legacy_candidate.get("features"), dict) else {}
    legacy_score = _to_float(features.get("legacyGridSolverScore"), 6.0)
    anchor_confidence = _to_float(features.get("anchorConfidenceScore"), 1.0)
    drift_128_ms = abs(_to_float(features.get("beatThisEstimatedDrift128Ms"), 0.0))
    weakness = (
        _clamp01((6.0 - legacy_score) / 8.0) * 0.45
        + _clamp01(1.0 - anchor_confidence) * 0.35
        + _clamp01(drift_128_ms / 40.0) * 0.20
    )
    return _round_feature(weakness)


def select_phase_evidence_candidate(
    candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, float, int]:
    best_candidate: dict[str, Any] | None = None
    best_score = -999.0
    best_rank = 0
    for rank, candidate in enumerate(candidates[:20], start=1):
        score = phase_evidence_switch_score(candidate, rank=rank)
        features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
        features["constantGridDpPhaseEvidenceSwitchScore"] = score
        features["constantGridDpPhaseEvidenceRank"] = rank
        candidate["features"] = features
        if score > best_score:
            best_candidate = candidate
            best_score = score
            best_rank = rank
    return best_candidate, _round_feature(best_score), best_rank


def snap_legacy_integer_bpm(
    *,
    selected: dict[str, Any],
    selected_source: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    bpm = _to_float(selected.get("bpm"))
    snapped_bpm = float(round(bpm))
    delta = abs(bpm - snapped_bpm)
    meta = {
        "snapped": False,
        "originalBpm": _round_feature(bpm),
        "snappedBpm": _round_feature(snapped_bpm),
        "deltaBpm": _round_feature(delta),
        "maxDeltaBpm": LEGACY_INTEGER_BPM_SNAP_MAX_DELTA,
    }
    if (
        "legacy" not in selected_source.lower()
        or bpm <= 0.0
        or snapped_bpm <= 0.0
        or delta <= 1e-9
        or delta > LEGACY_INTEGER_BPM_SNAP_MAX_DELTA
    ):
        return selected, meta

    features = dict(selected.get("features") or {})
    features.update(
        {
            "constantGridDpLegacyIntegerBpmSnap": True,
            "constantGridDpLegacyIntegerBpmOriginalBpm": _round_feature(bpm),
            "constantGridDpLegacyIntegerBpmSnappedBpm": _round_feature(snapped_bpm),
            "constantGridDpLegacyIntegerBpmDelta": _round_feature(delta),
            "constantGridDpLegacyIntegerBpmMaxDelta": LEGACY_INTEGER_BPM_SNAP_MAX_DELTA,
        }
    )
    return {**selected, "bpm": snapped_bpm, "features": features}, {**meta, "snapped": True}


def choose_rank1_locked_legacy_weakness_candidate(
    *,
    candidates: list[dict[str, Any]],
    selected_source: str,
    legacy_candidate: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    meta: dict[str, Any] = {
        "enabled": True,
        "selected": False,
        "reason": "not-evaluated",
        "candidateRank": 1,
        "probability": 0.0,
        "probabilityThreshold": RANK1_LOCKED_LEGACY_WEAKNESS_PROBABILITY_THRESHOLD,
        "legacyGridSolverScore": 999.0,
        "legacyGridSolverScoreMax": RANK1_LOCKED_LEGACY_WEAKNESS_SCORE_MAX,
        "phaseDeltaAbsMs": 0.0,
        "minPhaseDeltaAbsMs": RANK1_LOCKED_LEGACY_WEAKNESS_MIN_PHASE_DELTA_MS,
        "version": RANK1_LOCKED_LEGACY_WEAKNESS_VERSION,
    }
    if "legacy" not in selected_source.lower():
        return None, {**meta, "reason": "selected-source-not-legacy"}
    if legacy_candidate is None:
        return None, {**meta, "reason": "no-legacy-candidate"}
    if not candidates:
        return None, {**meta, "reason": "no-candidates"}

    legacy_features = (
        legacy_candidate.get("features") if isinstance(legacy_candidate.get("features"), dict) else {}
    )
    legacy_score = _to_float(legacy_features.get("legacyGridSolverScore"), 999.0)
    rank1 = candidates[0]
    rank1_features = rank1.get("features") if isinstance(rank1.get("features"), dict) else {}
    probability = _to_float(rank1_features.get("lockedRisingEdgeRankerProbability"))
    rank1_bpm = _to_float(rank1.get("bpm"))
    interval_ms = 60000.0 / rank1_bpm if rank1_bpm > 0.0 else 0.0
    phase_delta_abs_ms = abs(
        _phase_delta_ms(
            _to_float(rank1.get("firstBeatMs")),
            _to_float(legacy_candidate.get("firstBeatMs")),
            interval_ms,
        )
    )
    next_meta = {
        **meta,
        "probability": round(probability, 9),
        "legacyGridSolverScore": _round_feature(legacy_score),
        "phaseDeltaAbsMs": _round_feature(phase_delta_abs_ms),
    }
    if legacy_score > RANK1_LOCKED_LEGACY_WEAKNESS_SCORE_MAX:
        return None, {**next_meta, "reason": "legacy-score-too-strong"}
    if probability < RANK1_LOCKED_LEGACY_WEAKNESS_PROBABILITY_THRESHOLD:
        return None, {**next_meta, "reason": "below-threshold"}
    if phase_delta_abs_ms <= RANK1_LOCKED_LEGACY_WEAKNESS_MIN_PHASE_DELTA_MS:
        return None, {**next_meta, "reason": "phase-delta-not-material"}

    features = dict(rank1_features)
    features.update(
        {
            "constantGridDpRank1LockedLegacyWeaknessSwitch": True,
            "constantGridDpRank1LockedLegacyWeaknessProbability": round(probability, 9),
            "constantGridDpRank1LockedLegacyWeaknessThreshold": (
                RANK1_LOCKED_LEGACY_WEAKNESS_PROBABILITY_THRESHOLD
            ),
            "constantGridDpRank1LockedLegacyWeaknessLegacyScore": _round_feature(legacy_score),
            "constantGridDpRank1LockedLegacyWeaknessLegacyScoreMax": (
                RANK1_LOCKED_LEGACY_WEAKNESS_SCORE_MAX
            ),
            "constantGridDpRank1LockedLegacyWeaknessPhaseDeltaAbsMs": (
                _round_feature(phase_delta_abs_ms)
            ),
            "constantGridDpRank1LockedLegacyWeaknessMinPhaseDeltaMs": (
                RANK1_LOCKED_LEGACY_WEAKNESS_MIN_PHASE_DELTA_MS
            ),
            "constantGridDpRank1LockedLegacyWeaknessVersion": (
                RANK1_LOCKED_LEGACY_WEAKNESS_VERSION
            ),
        }
    )
    return {**rank1, "features": features}, {**next_meta, "selected": True, "reason": "selected"}


def choose_rank1_structural_phase_candidate(
    *,
    candidates: list[dict[str, Any]],
    selected_source: str,
    legacy_candidate: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    meta: dict[str, Any] = {
        "enabled": True,
        "selected": False,
        "reason": "not-evaluated",
        "candidateRank": 1,
        "probability": 0.0,
        "probabilityThreshold": RANK1_STRUCTURAL_PHASE_PROBABILITY_THRESHOLD,
        "lowProbabilityThreshold": RANK1_STRUCTURAL_PHASE_LOW_PROBABILITY_THRESHOLD,
        "legacyGridSolverScore": 999.0,
        "legacyGridSolverScoreMax": RANK1_STRUCTURAL_PHASE_LEGACY_SCORE_MAX,
        "phaseDeltaAbsMs": 0.0,
        "minPhaseDeltaAbsMs": RANK1_STRUCTURAL_PHASE_MIN_PHASE_DELTA_MS,
        "gridScore": 0.0,
        "gridScoreMin": RANK1_STRUCTURAL_PHASE_MIN_GRID_SCORE,
        "lowProbabilityGridScoreMin": RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_GRID_SCORE,
        "downbeatMargin": 0.0,
        "downbeatMarginMin": RANK1_STRUCTURAL_PHASE_MIN_DOWNBEAT_MARGIN,
        "lowProbabilityDownbeatMarginMin": (
            RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_DOWNBEAT_MARGIN
        ),
        "downbeatRank": 0,
        "bpmDelta": 999.0,
        "maxBpmDelta": RANK1_STRUCTURAL_PHASE_MAX_BPM_DELTA,
        "lowProbabilityHighEvidence": False,
        "sameBarBeatOffsetMod4": False,
        "version": RANK1_STRUCTURAL_PHASE_VERSION,
    }
    if "legacy" not in selected_source.lower():
        return None, {**meta, "reason": "selected-source-not-legacy"}
    if legacy_candidate is None:
        return None, {**meta, "reason": "no-legacy-candidate"}
    if not candidates:
        return None, {**meta, "reason": "no-candidates"}

    legacy_features = (
        legacy_candidate.get("features") if isinstance(legacy_candidate.get("features"), dict) else {}
    )
    legacy_score = _to_float(legacy_features.get("legacyGridSolverScore"), 999.0)
    rank1 = candidates[0]
    rank1_features = rank1.get("features") if isinstance(rank1.get("features"), dict) else {}
    probability = _to_float(rank1_features.get("lockedRisingEdgeRankerProbability"))
    grid_score = _to_float(rank1.get("score"))
    downbeat_margin = _to_float(rank1_features.get("downbeatMargin"))
    downbeat_rank = _to_int(rank1_features.get("downbeatRank"))
    rank1_bpm = _to_float(rank1.get("bpm"))
    legacy_bpm = _to_float(legacy_candidate.get("bpm"))
    bpm_delta = abs(rank1_bpm - legacy_bpm)
    interval_ms = 60000.0 / rank1_bpm if rank1_bpm > 0.0 else 0.0
    phase_delta_abs_ms = abs(
        _phase_delta_ms(
            _to_float(rank1.get("firstBeatMs")),
            _to_float(legacy_candidate.get("firstBeatMs")),
            interval_ms,
        )
    )
    same_bar_beat_offset_mod4 = (_to_int(rank1.get("barBeatOffset")) % 4) == (
        _to_int(legacy_candidate.get("barBeatOffset")) % 4
    )
    low_probability_high_evidence = (
        probability >= RANK1_STRUCTURAL_PHASE_LOW_PROBABILITY_THRESHOLD
        and probability < RANK1_STRUCTURAL_PHASE_PROBABILITY_THRESHOLD
        and grid_score >= RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_GRID_SCORE
        and downbeat_margin >= RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_DOWNBEAT_MARGIN
    )
    next_meta = {
        **meta,
        "probability": round(probability, 9),
        "legacyGridSolverScore": _round_feature(legacy_score),
        "phaseDeltaAbsMs": _round_feature(phase_delta_abs_ms),
        "gridScore": _round_feature(grid_score),
        "downbeatMargin": _round_feature(downbeat_margin),
        "downbeatRank": downbeat_rank,
        "bpmDelta": _round_feature(bpm_delta),
        "lowProbabilityHighEvidence": low_probability_high_evidence,
        "sameBarBeatOffsetMod4": same_bar_beat_offset_mod4,
    }
    if legacy_score > RANK1_STRUCTURAL_PHASE_LEGACY_SCORE_MAX:
        return None, {**next_meta, "reason": "legacy-score-too-strong"}
    if (
        probability < RANK1_STRUCTURAL_PHASE_PROBABILITY_THRESHOLD
        and not low_probability_high_evidence
    ):
        return None, {**next_meta, "reason": "below-threshold"}
    if phase_delta_abs_ms <= RANK1_STRUCTURAL_PHASE_MIN_PHASE_DELTA_MS:
        return None, {**next_meta, "reason": "phase-delta-not-material"}
    if bpm_delta > RANK1_STRUCTURAL_PHASE_MAX_BPM_DELTA:
        return None, {**next_meta, "reason": "bpm-delta-too-large"}
    if not same_bar_beat_offset_mod4:
        return None, {**next_meta, "reason": "bar-offset-mod4-mismatch"}
    if downbeat_rank != 0:
        return None, {**next_meta, "reason": "downbeat-rank-not-zero"}
    if downbeat_margin < RANK1_STRUCTURAL_PHASE_MIN_DOWNBEAT_MARGIN:
        return None, {**next_meta, "reason": "downbeat-margin-too-low"}
    if grid_score < RANK1_STRUCTURAL_PHASE_MIN_GRID_SCORE:
        return None, {**next_meta, "reason": "grid-score-too-low"}

    features = dict(rank1_features)
    features.update(
        {
            "constantGridDpRank1StructuralPhaseSwitch": True,
            "constantGridDpRank1StructuralPhaseProbability": round(probability, 9),
            "constantGridDpRank1StructuralPhaseThreshold": (
                RANK1_STRUCTURAL_PHASE_PROBABILITY_THRESHOLD
            ),
            "constantGridDpRank1StructuralPhaseLowProbabilityThreshold": (
                RANK1_STRUCTURAL_PHASE_LOW_PROBABILITY_THRESHOLD
            ),
            "constantGridDpRank1StructuralPhaseLegacyScore": _round_feature(legacy_score),
            "constantGridDpRank1StructuralPhaseLegacyScoreMax": (
                RANK1_STRUCTURAL_PHASE_LEGACY_SCORE_MAX
            ),
            "constantGridDpRank1StructuralPhasePhaseDeltaAbsMs": (
                _round_feature(phase_delta_abs_ms)
            ),
            "constantGridDpRank1StructuralPhaseMinPhaseDeltaMs": (
                RANK1_STRUCTURAL_PHASE_MIN_PHASE_DELTA_MS
            ),
            "constantGridDpRank1StructuralPhaseGridScore": _round_feature(grid_score),
            "constantGridDpRank1StructuralPhaseGridScoreMin": (
                RANK1_STRUCTURAL_PHASE_MIN_GRID_SCORE
            ),
            "constantGridDpRank1StructuralPhaseLowProbabilityGridScoreMin": (
                RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_GRID_SCORE
            ),
            "constantGridDpRank1StructuralPhaseDownbeatMargin": _round_feature(
                downbeat_margin
            ),
            "constantGridDpRank1StructuralPhaseDownbeatMarginMin": (
                RANK1_STRUCTURAL_PHASE_MIN_DOWNBEAT_MARGIN
            ),
            "constantGridDpRank1StructuralPhaseLowProbabilityDownbeatMarginMin": (
                RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_DOWNBEAT_MARGIN
            ),
            "constantGridDpRank1StructuralPhaseDownbeatRank": downbeat_rank,
            "constantGridDpRank1StructuralPhaseBpmDelta": _round_feature(bpm_delta),
            "constantGridDpRank1StructuralPhaseMaxBpmDelta": (
                RANK1_STRUCTURAL_PHASE_MAX_BPM_DELTA
            ),
            "constantGridDpRank1StructuralPhaseSameBarBeatOffsetMod4": (
                same_bar_beat_offset_mod4
            ),
            "constantGridDpRank1StructuralPhaseLowProbabilityHighEvidence": (
                low_probability_high_evidence
            ),
            "constantGridDpRank1StructuralPhaseVersion": RANK1_STRUCTURAL_PHASE_VERSION,
        }
    )
    return {**rank1, "features": features}, {**next_meta, "selected": True, "reason": "selected"}


def choose_head_near_zero_candidate(
    *,
    candidates: list[dict[str, Any]],
    selected_source: str,
    legacy_candidate: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    meta: dict[str, Any] = {
        "enabled": True,
        "selected": False,
        "reason": "not-evaluated",
        "candidateRank": 0,
        "rankLimit": HEAD_NEAR_ZERO_RANK_LIMIT,
        "scoreDeltaFromTop": 0.0,
        "scoreDeltaMax": HEAD_NEAR_ZERO_SCORE_DELTA_MAX,
        "candidateFirstBeatMs": 0.0,
        "targetMaxFirstBeatMs": HEAD_NEAR_ZERO_TARGET_MAX_MS,
        "topFirstBeatMs": 0.0,
        "topMinFirstBeatMs": HEAD_NEAR_ZERO_TOP_MIN_FIRST_BEAT_MS,
        "bpmDelta": 999.0,
        "maxBpmDelta": HEAD_NEAR_ZERO_MAX_BPM_DELTA,
        "legacyWeaknessScore": 0.0,
        "legacyWeaknessMin": HEAD_NEAR_ZERO_LEGACY_WEAKNESS_MIN,
        "sameTopBarBeatOffsetMod4": False,
        "candidateSource": "",
        "version": HEAD_NEAR_ZERO_VERSION,
    }
    if "legacy" not in selected_source.lower():
        return None, {**meta, "reason": "selected-source-not-legacy"}
    if legacy_candidate is None:
        return None, {**meta, "reason": "no-legacy-candidate"}
    if not candidates:
        return None, {**meta, "reason": "no-candidates"}

    top = candidates[0]
    top_score = _to_float(top.get("score"))
    top_first_beat_ms = _to_float(top.get("firstBeatMs"))
    top_bar_beat_offset_mod4 = _to_int(top.get("barBeatOffset")) % 4
    legacy_bpm = _to_float(legacy_candidate.get("bpm"))
    legacy_weakness = legacy_weakness_score(legacy_candidate)
    base_meta = {
        **meta,
        "topFirstBeatMs": _round_feature(top_first_beat_ms),
        "legacyWeaknessScore": legacy_weakness,
    }
    if legacy_weakness < HEAD_NEAR_ZERO_LEGACY_WEAKNESS_MIN:
        return None, {**base_meta, "reason": "legacy-weakness-too-low"}
    if top_first_beat_ms <= HEAD_NEAR_ZERO_TOP_MIN_FIRST_BEAT_MS:
        return None, {**base_meta, "reason": "top-candidate-already-near-head"}

    eligible: list[tuple[float, float, int, dict[str, Any], dict[str, Any]]] = []
    for rank, candidate in enumerate(candidates[:HEAD_NEAR_ZERO_RANK_LIMIT], start=1):
        candidate_source = _candidate_source(candidate)
        if "window-beat-leading-edge" not in candidate_source:
            continue
        candidate_first_beat_ms = _to_float(candidate.get("firstBeatMs"))
        if candidate_first_beat_ms > HEAD_NEAR_ZERO_TARGET_MAX_MS:
            continue
        candidate_score = _to_float(candidate.get("score"))
        score_delta = top_score - candidate_score
        if score_delta > HEAD_NEAR_ZERO_SCORE_DELTA_MAX:
            continue
        candidate_bpm = _to_float(candidate.get("bpm"))
        bpm_delta = abs(candidate_bpm - legacy_bpm)
        if bpm_delta > HEAD_NEAR_ZERO_MAX_BPM_DELTA:
            continue
        same_top_bar_beat_offset_mod4 = (
            _to_int(candidate.get("barBeatOffset")) % 4
        ) == top_bar_beat_offset_mod4
        if not same_top_bar_beat_offset_mod4:
            continue
        candidate_meta = {
            **base_meta,
            "candidateRank": rank,
            "scoreDeltaFromTop": _round_feature(score_delta),
            "candidateFirstBeatMs": _round_feature(candidate_first_beat_ms),
            "bpmDelta": _round_feature(bpm_delta),
            "sameTopBarBeatOffsetMod4": same_top_bar_beat_offset_mod4,
            "candidateSource": candidate_source,
        }
        eligible.append((candidate_first_beat_ms, -candidate_score, rank, candidate, candidate_meta))

    if not eligible:
        return None, {**base_meta, "reason": "no-eligible-head-candidate"}

    eligible.sort(key=lambda item: (item[0], item[1], item[2]))
    _, _, _, selected, selected_meta = eligible[0]
    selected_features = selected.get("features") if isinstance(selected.get("features"), dict) else {}
    features = dict(selected_features)
    features.update(
        {
            "constantGridDpHeadNearZeroSwitch": True,
            "constantGridDpHeadNearZeroCandidateRank": selected_meta["candidateRank"],
            "constantGridDpHeadNearZeroRankLimit": HEAD_NEAR_ZERO_RANK_LIMIT,
            "constantGridDpHeadNearZeroScoreDeltaFromTop": selected_meta[
                "scoreDeltaFromTop"
            ],
            "constantGridDpHeadNearZeroScoreDeltaMax": HEAD_NEAR_ZERO_SCORE_DELTA_MAX,
            "constantGridDpHeadNearZeroCandidateFirstBeatMs": selected_meta[
                "candidateFirstBeatMs"
            ],
            "constantGridDpHeadNearZeroTargetMaxFirstBeatMs": (
                HEAD_NEAR_ZERO_TARGET_MAX_MS
            ),
            "constantGridDpHeadNearZeroTopFirstBeatMs": selected_meta["topFirstBeatMs"],
            "constantGridDpHeadNearZeroTopMinFirstBeatMs": (
                HEAD_NEAR_ZERO_TOP_MIN_FIRST_BEAT_MS
            ),
            "constantGridDpHeadNearZeroBpmDelta": selected_meta["bpmDelta"],
            "constantGridDpHeadNearZeroMaxBpmDelta": HEAD_NEAR_ZERO_MAX_BPM_DELTA,
            "constantGridDpHeadNearZeroLegacyWeaknessScore": selected_meta[
                "legacyWeaknessScore"
            ],
            "constantGridDpHeadNearZeroLegacyWeaknessMin": (
                HEAD_NEAR_ZERO_LEGACY_WEAKNESS_MIN
            ),
            "constantGridDpHeadNearZeroSameTopBarBeatOffsetMod4": selected_meta[
                "sameTopBarBeatOffsetMod4"
            ],
            "constantGridDpHeadNearZeroCandidateSource": selected_meta[
                "candidateSource"
            ],
            "constantGridDpHeadNearZeroVersion": HEAD_NEAR_ZERO_VERSION,
        }
    )
    return {**selected, "features": features}, {**selected_meta, "selected": True, "reason": "selected"}


def choose_rank1_negative_legacy_score_candidate(
    *,
    candidates: list[dict[str, Any]],
    selected_source: str,
    legacy_candidate: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    meta: dict[str, Any] = {
        "enabled": True,
        "selected": False,
        "reason": "not-evaluated",
        "candidateRank": 1,
        "gridScore": 0.0,
        "gridScoreMin": RANK1_NEGATIVE_LEGACY_SCORE_MIN_GRID_SCORE,
        "phasePathScore": 0.0,
        "phasePathScoreMin": RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_PATH_SCORE,
        "legacyGridSolverScore": 999.0,
        "legacyGridSolverScoreMax": RANK1_NEGATIVE_LEGACY_SCORE_MAX_LEGACY_SCORE,
        "phaseDeltaAbsMs": 0.0,
        "minPhaseDeltaAbsMs": RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_DELTA_MS,
        "bpmDelta": 999.0,
        "maxBpmDelta": RANK1_NEGATIVE_LEGACY_SCORE_MAX_BPM_DELTA,
        "sameBarBeatOffsetMod4": False,
        "downbeatRank": 0,
        "version": RANK1_NEGATIVE_LEGACY_SCORE_VERSION,
    }
    if "legacy" not in selected_source.lower():
        return None, {**meta, "reason": "selected-source-not-legacy"}
    if legacy_candidate is None:
        return None, {**meta, "reason": "no-legacy-candidate"}
    if not candidates:
        return None, {**meta, "reason": "no-candidates"}

    legacy_features = (
        legacy_candidate.get("features") if isinstance(legacy_candidate.get("features"), dict) else {}
    )
    rank1 = candidates[0]
    rank1_features = rank1.get("features") if isinstance(rank1.get("features"), dict) else {}
    required_rank1_feature_keys = ("phasePathScore", "downbeatRank")
    missing_rank1_feature_keys = [
        key for key in required_rank1_feature_keys if key not in rank1_features
    ]
    required_candidate_keys = ("score", "bpm", "firstBeatMs", "barBeatOffset")
    missing_candidate_keys = [key for key in required_candidate_keys if key not in rank1]
    missing_legacy_keys = [
        key for key in ("bpm", "firstBeatMs", "barBeatOffset") if key not in legacy_candidate
    ]
    if "legacyGridSolverScore" not in legacy_features:
        return None, {**meta, "reason": "missing-legacy-score"}
    if missing_rank1_feature_keys:
        return None, {**meta, "reason": "missing-rank1-feature"}
    if missing_candidate_keys:
        return None, {**meta, "reason": "missing-rank1-field"}
    if missing_legacy_keys:
        return None, {**meta, "reason": "missing-legacy-field"}
    legacy_score = _to_float(legacy_features.get("legacyGridSolverScore"), 999.0)
    grid_score = _to_float(rank1.get("score"))
    phase_path_score = _to_float(rank1_features.get("phasePathScore"))
    downbeat_rank = _to_int(rank1_features.get("downbeatRank"))
    rank1_bpm = _to_float(rank1.get("bpm"))
    legacy_bpm = _to_float(legacy_candidate.get("bpm"))
    bpm_delta = abs(rank1_bpm - legacy_bpm)
    interval_ms = 60000.0 / rank1_bpm if rank1_bpm > 0.0 else 0.0
    phase_delta_abs_ms = abs(
        _phase_delta_ms(
            _to_float(rank1.get("firstBeatMs")),
            _to_float(legacy_candidate.get("firstBeatMs")),
            interval_ms,
        )
    )
    same_bar_beat_offset_mod4 = (_to_int(rank1.get("barBeatOffset")) % 4) == (
        _to_int(legacy_candidate.get("barBeatOffset")) % 4
    )
    next_meta = {
        **meta,
        "gridScore": _round_feature(grid_score),
        "phasePathScore": _round_feature(phase_path_score),
        "legacyGridSolverScore": _round_feature(legacy_score),
        "phaseDeltaAbsMs": _round_feature(phase_delta_abs_ms),
        "bpmDelta": _round_feature(bpm_delta),
        "sameBarBeatOffsetMod4": same_bar_beat_offset_mod4,
        "downbeatRank": downbeat_rank,
    }
    if legacy_score > RANK1_NEGATIVE_LEGACY_SCORE_MAX_LEGACY_SCORE:
        return None, {**next_meta, "reason": "legacy-score-not-negative"}
    if grid_score < RANK1_NEGATIVE_LEGACY_SCORE_MIN_GRID_SCORE:
        return None, {**next_meta, "reason": "grid-score-too-low"}
    if phase_path_score < RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_PATH_SCORE:
        return None, {**next_meta, "reason": "phase-path-score-too-low"}
    if phase_delta_abs_ms <= RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_DELTA_MS:
        return None, {**next_meta, "reason": "phase-delta-not-material"}
    if bpm_delta > RANK1_NEGATIVE_LEGACY_SCORE_MAX_BPM_DELTA:
        return None, {**next_meta, "reason": "bpm-delta-too-large"}
    if not same_bar_beat_offset_mod4:
        return None, {**next_meta, "reason": "bar-offset-mod4-mismatch"}
    if downbeat_rank != 0:
        return None, {**next_meta, "reason": "downbeat-rank-not-zero"}

    features = dict(rank1_features)
    features.update(
        {
            "constantGridDpRank1NegativeLegacyScoreSwitch": True,
            "constantGridDpRank1NegativeLegacyScoreGridScore": _round_feature(grid_score),
            "constantGridDpRank1NegativeLegacyScoreGridScoreMin": (
                RANK1_NEGATIVE_LEGACY_SCORE_MIN_GRID_SCORE
            ),
            "constantGridDpRank1NegativeLegacyScorePhasePathScore": _round_feature(
                phase_path_score
            ),
            "constantGridDpRank1NegativeLegacyScorePhasePathScoreMin": (
                RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_PATH_SCORE
            ),
            "constantGridDpRank1NegativeLegacyScoreLegacyScore": _round_feature(
                legacy_score
            ),
            "constantGridDpRank1NegativeLegacyScoreLegacyScoreMax": (
                RANK1_NEGATIVE_LEGACY_SCORE_MAX_LEGACY_SCORE
            ),
            "constantGridDpRank1NegativeLegacyScorePhaseDeltaAbsMs": (
                _round_feature(phase_delta_abs_ms)
            ),
            "constantGridDpRank1NegativeLegacyScoreMinPhaseDeltaMs": (
                RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_DELTA_MS
            ),
            "constantGridDpRank1NegativeLegacyScoreBpmDelta": _round_feature(bpm_delta),
            "constantGridDpRank1NegativeLegacyScoreMaxBpmDelta": (
                RANK1_NEGATIVE_LEGACY_SCORE_MAX_BPM_DELTA
            ),
            "constantGridDpRank1NegativeLegacyScoreSameBarBeatOffsetMod4": (
                same_bar_beat_offset_mod4
            ),
            "constantGridDpRank1NegativeLegacyScoreDownbeatRank": downbeat_rank,
            "constantGridDpRank1NegativeLegacyScoreVersion": (
                RANK1_NEGATIVE_LEGACY_SCORE_VERSION
            ),
        }
    )
    return {**rank1, "features": features}, {**next_meta, "selected": True, "reason": "selected"}


def rank1_switch_diagnostic_features(
    *,
    rank1_legacy_weakness_switch: bool,
    rank1_legacy_weakness_meta: dict[str, Any],
    rank1_structural_phase_switch: bool,
    rank1_structural_phase_meta: dict[str, Any],
) -> dict[str, Any]:
    return {
        "constantGridDpRank1LockedLegacyWeaknessSwitch": rank1_legacy_weakness_switch,
        "constantGridDpRank1LockedLegacyWeaknessReason": str(
            rank1_legacy_weakness_meta.get("reason") or ""
        ),
        "constantGridDpRank1LockedLegacyWeaknessProbability": round(
            _to_float(rank1_legacy_weakness_meta.get("probability")), 9
        ),
        "constantGridDpRank1LockedLegacyWeaknessCandidateRank": _to_int(
            rank1_legacy_weakness_meta.get("candidateRank")
        ),
        "constantGridDpRank1LockedLegacyWeaknessThreshold": _to_float(
            rank1_legacy_weakness_meta.get("probabilityThreshold"),
            RANK1_LOCKED_LEGACY_WEAKNESS_PROBABILITY_THRESHOLD,
        ),
        "constantGridDpRank1LockedLegacyWeaknessLegacyScore": _to_float(
            rank1_legacy_weakness_meta.get("legacyGridSolverScore")
        ),
        "constantGridDpRank1LockedLegacyWeaknessLegacyScoreMax": _to_float(
            rank1_legacy_weakness_meta.get("legacyGridSolverScoreMax"),
            RANK1_LOCKED_LEGACY_WEAKNESS_SCORE_MAX,
        ),
        "constantGridDpRank1LockedLegacyWeaknessPhaseDeltaAbsMs": _to_float(
            rank1_legacy_weakness_meta.get("phaseDeltaAbsMs")
        ),
        "constantGridDpRank1LockedLegacyWeaknessMinPhaseDeltaMs": _to_float(
            rank1_legacy_weakness_meta.get("minPhaseDeltaAbsMs"),
            RANK1_LOCKED_LEGACY_WEAKNESS_MIN_PHASE_DELTA_MS,
        ),
        "constantGridDpRank1LockedLegacyWeaknessVersion": str(
            rank1_legacy_weakness_meta.get("version") or ""
        ),
        "constantGridDpRank1StructuralPhaseSwitch": rank1_structural_phase_switch,
        "constantGridDpRank1StructuralPhaseReason": str(
            rank1_structural_phase_meta.get("reason") or ""
        ),
        "constantGridDpRank1StructuralPhaseProbability": round(
            _to_float(rank1_structural_phase_meta.get("probability")), 9
        ),
        "constantGridDpRank1StructuralPhaseCandidateRank": _to_int(
            rank1_structural_phase_meta.get("candidateRank")
        ),
        "constantGridDpRank1StructuralPhaseThreshold": _to_float(
            rank1_structural_phase_meta.get("probabilityThreshold"),
            RANK1_STRUCTURAL_PHASE_PROBABILITY_THRESHOLD,
        ),
        "constantGridDpRank1StructuralPhaseLowProbabilityThreshold": _to_float(
            rank1_structural_phase_meta.get("lowProbabilityThreshold"),
            RANK1_STRUCTURAL_PHASE_LOW_PROBABILITY_THRESHOLD,
        ),
        "constantGridDpRank1StructuralPhaseLegacyScore": _to_float(
            rank1_structural_phase_meta.get("legacyGridSolverScore")
        ),
        "constantGridDpRank1StructuralPhaseLegacyScoreMax": _to_float(
            rank1_structural_phase_meta.get("legacyGridSolverScoreMax"),
            RANK1_STRUCTURAL_PHASE_LEGACY_SCORE_MAX,
        ),
        "constantGridDpRank1StructuralPhasePhaseDeltaAbsMs": _to_float(
            rank1_structural_phase_meta.get("phaseDeltaAbsMs")
        ),
        "constantGridDpRank1StructuralPhaseMinPhaseDeltaMs": _to_float(
            rank1_structural_phase_meta.get("minPhaseDeltaAbsMs"),
            RANK1_STRUCTURAL_PHASE_MIN_PHASE_DELTA_MS,
        ),
        "constantGridDpRank1StructuralPhaseGridScore": _to_float(
            rank1_structural_phase_meta.get("gridScore")
        ),
        "constantGridDpRank1StructuralPhaseGridScoreMin": _to_float(
            rank1_structural_phase_meta.get("gridScoreMin"),
            RANK1_STRUCTURAL_PHASE_MIN_GRID_SCORE,
        ),
        "constantGridDpRank1StructuralPhaseLowProbabilityGridScoreMin": _to_float(
            rank1_structural_phase_meta.get("lowProbabilityGridScoreMin"),
            RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_GRID_SCORE,
        ),
        "constantGridDpRank1StructuralPhaseDownbeatMargin": _to_float(
            rank1_structural_phase_meta.get("downbeatMargin")
        ),
        "constantGridDpRank1StructuralPhaseDownbeatMarginMin": _to_float(
            rank1_structural_phase_meta.get("downbeatMarginMin"),
            RANK1_STRUCTURAL_PHASE_MIN_DOWNBEAT_MARGIN,
        ),
        "constantGridDpRank1StructuralPhaseLowProbabilityDownbeatMarginMin": _to_float(
            rank1_structural_phase_meta.get("lowProbabilityDownbeatMarginMin"),
            RANK1_STRUCTURAL_PHASE_LOW_PROB_MIN_DOWNBEAT_MARGIN,
        ),
        "constantGridDpRank1StructuralPhaseDownbeatRank": _to_int(
            rank1_structural_phase_meta.get("downbeatRank")
        ),
        "constantGridDpRank1StructuralPhaseBpmDelta": _to_float(
            rank1_structural_phase_meta.get("bpmDelta")
        ),
        "constantGridDpRank1StructuralPhaseMaxBpmDelta": _to_float(
            rank1_structural_phase_meta.get("maxBpmDelta"),
            RANK1_STRUCTURAL_PHASE_MAX_BPM_DELTA,
        ),
        "constantGridDpRank1StructuralPhaseSameBarBeatOffsetMod4": bool(
            rank1_structural_phase_meta.get("sameBarBeatOffsetMod4")
        ),
        "constantGridDpRank1StructuralPhaseLowProbabilityHighEvidence": bool(
            rank1_structural_phase_meta.get("lowProbabilityHighEvidence")
        ),
        "constantGridDpRank1StructuralPhaseVersion": str(
            rank1_structural_phase_meta.get("version") or ""
        ),
    }


def rank1_negative_legacy_score_diagnostic_features(
    *,
    rank1_negative_legacy_score_switch: bool,
    rank1_negative_legacy_score_meta: dict[str, Any],
) -> dict[str, Any]:
    return {
        "constantGridDpRank1NegativeLegacyScoreSwitch": rank1_negative_legacy_score_switch,
        "constantGridDpRank1NegativeLegacyScoreReason": str(
            rank1_negative_legacy_score_meta.get("reason") or ""
        ),
        "constantGridDpRank1NegativeLegacyScoreCandidateRank": _to_int(
            rank1_negative_legacy_score_meta.get("candidateRank")
        ),
        "constantGridDpRank1NegativeLegacyScoreGridScore": _to_float(
            rank1_negative_legacy_score_meta.get("gridScore")
        ),
        "constantGridDpRank1NegativeLegacyScoreGridScoreMin": _to_float(
            rank1_negative_legacy_score_meta.get("gridScoreMin"),
            RANK1_NEGATIVE_LEGACY_SCORE_MIN_GRID_SCORE,
        ),
        "constantGridDpRank1NegativeLegacyScorePhasePathScore": _to_float(
            rank1_negative_legacy_score_meta.get("phasePathScore")
        ),
        "constantGridDpRank1NegativeLegacyScorePhasePathScoreMin": _to_float(
            rank1_negative_legacy_score_meta.get("phasePathScoreMin"),
            RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_PATH_SCORE,
        ),
        "constantGridDpRank1NegativeLegacyScoreLegacyScore": _to_float(
            rank1_negative_legacy_score_meta.get("legacyGridSolverScore")
        ),
        "constantGridDpRank1NegativeLegacyScoreLegacyScoreMax": _to_float(
            rank1_negative_legacy_score_meta.get("legacyGridSolverScoreMax"),
            RANK1_NEGATIVE_LEGACY_SCORE_MAX_LEGACY_SCORE,
        ),
        "constantGridDpRank1NegativeLegacyScorePhaseDeltaAbsMs": _to_float(
            rank1_negative_legacy_score_meta.get("phaseDeltaAbsMs")
        ),
        "constantGridDpRank1NegativeLegacyScoreMinPhaseDeltaMs": _to_float(
            rank1_negative_legacy_score_meta.get("minPhaseDeltaAbsMs"),
            RANK1_NEGATIVE_LEGACY_SCORE_MIN_PHASE_DELTA_MS,
        ),
        "constantGridDpRank1NegativeLegacyScoreBpmDelta": _to_float(
            rank1_negative_legacy_score_meta.get("bpmDelta")
        ),
        "constantGridDpRank1NegativeLegacyScoreMaxBpmDelta": _to_float(
            rank1_negative_legacy_score_meta.get("maxBpmDelta"),
            RANK1_NEGATIVE_LEGACY_SCORE_MAX_BPM_DELTA,
        ),
        "constantGridDpRank1NegativeLegacyScoreSameBarBeatOffsetMod4": bool(
            rank1_negative_legacy_score_meta.get("sameBarBeatOffsetMod4")
        ),
        "constantGridDpRank1NegativeLegacyScoreDownbeatRank": _to_int(
            rank1_negative_legacy_score_meta.get("downbeatRank")
        ),
        "constantGridDpRank1NegativeLegacyScoreVersion": str(
            rank1_negative_legacy_score_meta.get("version") or ""
        ),
    }


def head_near_zero_switch_diagnostic_features(
    *,
    head_near_zero_switch: bool,
    head_near_zero_meta: dict[str, Any],
) -> dict[str, Any]:
    return {
        "constantGridDpHeadNearZeroSwitch": head_near_zero_switch,
        "constantGridDpHeadNearZeroReason": str(head_near_zero_meta.get("reason") or ""),
        "constantGridDpHeadNearZeroCandidateRank": _to_int(
            head_near_zero_meta.get("candidateRank")
        ),
        "constantGridDpHeadNearZeroRankLimit": _to_int(
            head_near_zero_meta.get("rankLimit"), HEAD_NEAR_ZERO_RANK_LIMIT
        ),
        "constantGridDpHeadNearZeroScoreDeltaFromTop": _to_float(
            head_near_zero_meta.get("scoreDeltaFromTop")
        ),
        "constantGridDpHeadNearZeroScoreDeltaMax": _to_float(
            head_near_zero_meta.get("scoreDeltaMax"), HEAD_NEAR_ZERO_SCORE_DELTA_MAX
        ),
        "constantGridDpHeadNearZeroCandidateFirstBeatMs": _to_float(
            head_near_zero_meta.get("candidateFirstBeatMs")
        ),
        "constantGridDpHeadNearZeroTargetMaxFirstBeatMs": _to_float(
            head_near_zero_meta.get("targetMaxFirstBeatMs"), HEAD_NEAR_ZERO_TARGET_MAX_MS
        ),
        "constantGridDpHeadNearZeroTopFirstBeatMs": _to_float(
            head_near_zero_meta.get("topFirstBeatMs")
        ),
        "constantGridDpHeadNearZeroTopMinFirstBeatMs": _to_float(
            head_near_zero_meta.get("topMinFirstBeatMs"), HEAD_NEAR_ZERO_TOP_MIN_FIRST_BEAT_MS
        ),
        "constantGridDpHeadNearZeroBpmDelta": _to_float(
            head_near_zero_meta.get("bpmDelta")
        ),
        "constantGridDpHeadNearZeroMaxBpmDelta": _to_float(
            head_near_zero_meta.get("maxBpmDelta"), HEAD_NEAR_ZERO_MAX_BPM_DELTA
        ),
        "constantGridDpHeadNearZeroLegacyWeaknessScore": _to_float(
            head_near_zero_meta.get("legacyWeaknessScore")
        ),
        "constantGridDpHeadNearZeroLegacyWeaknessMin": _to_float(
            head_near_zero_meta.get("legacyWeaknessMin"), HEAD_NEAR_ZERO_LEGACY_WEAKNESS_MIN
        ),
        "constantGridDpHeadNearZeroSameTopBarBeatOffsetMod4": bool(
            head_near_zero_meta.get("sameTopBarBeatOffsetMod4")
        ),
        "constantGridDpHeadNearZeroCandidateSource": str(
            head_near_zero_meta.get("candidateSource") or ""
        ),
        "constantGridDpHeadNearZeroVersion": str(head_near_zero_meta.get("version") or ""),
    }
