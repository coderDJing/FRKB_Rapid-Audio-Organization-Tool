import math
from typing import Any

PHASE_EVIDENCE_SWITCH_THRESHOLD = 0.905
PHASE_EVIDENCE_LEGACY_WEAKNESS_THRESHOLD = 0.6
LEGACY_INTEGER_BPM_SNAP_MAX_DELTA = 0.04
RANK1_LOCKED_LEGACY_WEAKNESS_PROBABILITY_THRESHOLD = 0.9
RANK1_LOCKED_LEGACY_WEAKNESS_SCORE_MAX = 2.5
RANK1_LOCKED_LEGACY_WEAKNESS_MIN_PHASE_DELTA_MS = 5.0
RANK1_LOCKED_LEGACY_WEAKNESS_VERSION = "rank1-locked-legacy-weakness-v2"


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


def _round_feature(value: float) -> float:
    return round(float(value), 6) if math.isfinite(float(value)) else 0.0


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
