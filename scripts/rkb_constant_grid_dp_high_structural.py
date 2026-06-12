from typing import Any

from rkb_constant_grid_dp_selection import _phase_delta_ms, _round_feature, _to_float, _to_int

RANK1_HIGH_STRUCTURAL_SCORE_MIN = 0.96
RANK1_HIGH_STRUCTURAL_PROBABILITY_MIN = 0.82
RANK1_HIGH_STRUCTURAL_DOWNBEAT_MARGIN_MIN = 0.35
RANK1_HIGH_STRUCTURAL_PHASE_PATH_MIN = 0.7
RANK1_HIGH_STRUCTURAL_TEMPO_MIN = 0.95
RANK1_HIGH_STRUCTURAL_MIN_PHASE_DELTA_MS = 15.0
RANK1_HIGH_STRUCTURAL_MAX_BPM_DELTA = 0.08
RANK1_HIGH_STRUCTURAL_LEADING_MAD_MAX_MS = 8.0
RANK1_HIGH_STRUCTURAL_LEGACY_FIRST_BEAT_MIN_MS = 20.0
RANK1_HIGH_STRUCTURAL_VERSION = "rank1-high-structural-score-v1"


def choose_rank1_high_structural_score_candidate(
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
        "probabilityMin": RANK1_HIGH_STRUCTURAL_PROBABILITY_MIN,
        "gridScore": 0.0,
        "gridScoreMin": RANK1_HIGH_STRUCTURAL_SCORE_MIN,
        "downbeatMargin": 0.0,
        "downbeatMarginMin": RANK1_HIGH_STRUCTURAL_DOWNBEAT_MARGIN_MIN,
        "phasePathScore": 0.0,
        "phasePathScoreMin": RANK1_HIGH_STRUCTURAL_PHASE_PATH_MIN,
        "tempoScore": 0.0,
        "tempoScoreMin": RANK1_HIGH_STRUCTURAL_TEMPO_MIN,
        "phaseDeltaAbsMs": 0.0,
        "minPhaseDeltaAbsMs": RANK1_HIGH_STRUCTURAL_MIN_PHASE_DELTA_MS,
        "bpmDelta": 999.0,
        "maxBpmDelta": RANK1_HIGH_STRUCTURAL_MAX_BPM_DELTA,
        "leadingEdgePeakOffsetMadMs": 99.0,
        "leadingEdgePeakOffsetMadMaxMs": RANK1_HIGH_STRUCTURAL_LEADING_MAD_MAX_MS,
        "legacyFirstBeatMs": 0.0,
        "legacyFirstBeatMinMs": RANK1_HIGH_STRUCTURAL_LEGACY_FIRST_BEAT_MIN_MS,
        "downbeatRank": 0,
        "sameBarBeatOffsetMod4": False,
        "version": RANK1_HIGH_STRUCTURAL_VERSION,
    }
    if "legacy" not in selected_source.lower():
        return None, {**meta, "reason": "selected-source-not-legacy"}
    if legacy_candidate is None:
        return None, {**meta, "reason": "no-legacy-candidate"}
    if not candidates:
        return None, {**meta, "reason": "no-candidates"}

    rank1 = candidates[0]
    rank1_features = rank1.get("features") if isinstance(rank1.get("features"), dict) else {}
    probability = _to_float(rank1_features.get("lockedRisingEdgeRankerProbability"))
    grid_score = _to_float(rank1.get("score"))
    downbeat_margin = _to_float(rank1_features.get("downbeatMargin"))
    phase_path_score = _to_float(rank1_features.get("phasePathScore"))
    tempo_score = _to_float(rank1_features.get("tempoScore"))
    leading_mad = _to_float(rank1_features.get("leadingEdgePeakOffsetMadMs"), 99.0)
    downbeat_rank = _to_int(rank1_features.get("downbeatRank"))
    rank1_bpm = _to_float(rank1.get("bpm"))
    legacy_bpm = _to_float(legacy_candidate.get("bpm"))
    bpm_delta = abs(rank1_bpm - legacy_bpm)
    interval_ms = 60000.0 / rank1_bpm if rank1_bpm > 0.0 else 0.0
    legacy_first_beat_ms = _to_float(legacy_candidate.get("firstBeatMs"))
    phase_delta_abs_ms = abs(
        _phase_delta_ms(
            _to_float(rank1.get("firstBeatMs")),
            legacy_first_beat_ms,
            interval_ms,
        )
    )
    same_bar_beat_offset_mod4 = (_to_int(rank1.get("barBeatOffset")) % 4) == (
        _to_int(legacy_candidate.get("barBeatOffset")) % 4
    )
    next_meta = {
        **meta,
        "probability": round(probability, 9),
        "gridScore": _round_feature(grid_score),
        "downbeatMargin": _round_feature(downbeat_margin),
        "phasePathScore": _round_feature(phase_path_score),
        "tempoScore": _round_feature(tempo_score),
        "phaseDeltaAbsMs": _round_feature(phase_delta_abs_ms),
        "bpmDelta": _round_feature(bpm_delta),
        "leadingEdgePeakOffsetMadMs": _round_feature(leading_mad),
        "legacyFirstBeatMs": _round_feature(legacy_first_beat_ms),
        "downbeatRank": downbeat_rank,
        "sameBarBeatOffsetMod4": same_bar_beat_offset_mod4,
    }
    if legacy_first_beat_ms <= RANK1_HIGH_STRUCTURAL_LEGACY_FIRST_BEAT_MIN_MS:
        return None, {**next_meta, "reason": "legacy-anchor-too-close-to-head"}
    if probability < RANK1_HIGH_STRUCTURAL_PROBABILITY_MIN:
        return None, {**next_meta, "reason": "probability-too-low"}
    if grid_score < RANK1_HIGH_STRUCTURAL_SCORE_MIN:
        return None, {**next_meta, "reason": "grid-score-too-low"}
    if tempo_score < RANK1_HIGH_STRUCTURAL_TEMPO_MIN:
        return None, {**next_meta, "reason": "tempo-score-too-low"}
    if downbeat_rank != 0:
        return None, {**next_meta, "reason": "downbeat-rank-not-zero"}
    if downbeat_margin < RANK1_HIGH_STRUCTURAL_DOWNBEAT_MARGIN_MIN:
        return None, {**next_meta, "reason": "downbeat-margin-too-low"}
    if phase_path_score < RANK1_HIGH_STRUCTURAL_PHASE_PATH_MIN:
        return None, {**next_meta, "reason": "phase-path-score-too-low"}
    if phase_delta_abs_ms <= RANK1_HIGH_STRUCTURAL_MIN_PHASE_DELTA_MS:
        return None, {**next_meta, "reason": "phase-delta-not-material"}
    if bpm_delta > RANK1_HIGH_STRUCTURAL_MAX_BPM_DELTA:
        return None, {**next_meta, "reason": "bpm-delta-too-large"}
    if not same_bar_beat_offset_mod4:
        return None, {**next_meta, "reason": "bar-offset-mod4-mismatch"}
    if leading_mad > RANK1_HIGH_STRUCTURAL_LEADING_MAD_MAX_MS:
        return None, {**next_meta, "reason": "leading-edge-mad-too-wide"}

    features = dict(rank1_features)
    features.update(
        {
            "constantGridDpRank1HighStructuralScoreSwitch": True,
            "constantGridDpRank1HighStructuralScoreProbability": round(probability, 9),
            "constantGridDpRank1HighStructuralScoreProbabilityMin": (
                RANK1_HIGH_STRUCTURAL_PROBABILITY_MIN
            ),
            "constantGridDpRank1HighStructuralScoreGridScore": _round_feature(grid_score),
            "constantGridDpRank1HighStructuralScoreGridScoreMin": (
                RANK1_HIGH_STRUCTURAL_SCORE_MIN
            ),
            "constantGridDpRank1HighStructuralScoreDownbeatMargin": (
                _round_feature(downbeat_margin)
            ),
            "constantGridDpRank1HighStructuralScoreDownbeatMarginMin": (
                RANK1_HIGH_STRUCTURAL_DOWNBEAT_MARGIN_MIN
            ),
            "constantGridDpRank1HighStructuralScorePhasePathScore": (
                _round_feature(phase_path_score)
            ),
            "constantGridDpRank1HighStructuralScorePhasePathScoreMin": (
                RANK1_HIGH_STRUCTURAL_PHASE_PATH_MIN
            ),
            "constantGridDpRank1HighStructuralScoreTempoScore": _round_feature(tempo_score),
            "constantGridDpRank1HighStructuralScoreTempoScoreMin": (
                RANK1_HIGH_STRUCTURAL_TEMPO_MIN
            ),
            "constantGridDpRank1HighStructuralScorePhaseDeltaAbsMs": (
                _round_feature(phase_delta_abs_ms)
            ),
            "constantGridDpRank1HighStructuralScoreMinPhaseDeltaMs": (
                RANK1_HIGH_STRUCTURAL_MIN_PHASE_DELTA_MS
            ),
            "constantGridDpRank1HighStructuralScoreBpmDelta": _round_feature(bpm_delta),
            "constantGridDpRank1HighStructuralScoreMaxBpmDelta": (
                RANK1_HIGH_STRUCTURAL_MAX_BPM_DELTA
            ),
            "constantGridDpRank1HighStructuralScoreLeadingEdgeMadMs": (
                _round_feature(leading_mad)
            ),
            "constantGridDpRank1HighStructuralScoreLeadingEdgeMadMaxMs": (
                RANK1_HIGH_STRUCTURAL_LEADING_MAD_MAX_MS
            ),
            "constantGridDpRank1HighStructuralScoreLegacyFirstBeatMs": (
                _round_feature(legacy_first_beat_ms)
            ),
            "constantGridDpRank1HighStructuralScoreLegacyFirstBeatMinMs": (
                RANK1_HIGH_STRUCTURAL_LEGACY_FIRST_BEAT_MIN_MS
            ),
            "constantGridDpRank1HighStructuralScoreDownbeatRank": downbeat_rank,
            "constantGridDpRank1HighStructuralScoreSameBarBeatOffsetMod4": (
                same_bar_beat_offset_mod4
            ),
            "constantGridDpRank1HighStructuralScoreVersion": RANK1_HIGH_STRUCTURAL_VERSION,
        }
    )
    return {**rank1, "features": features}, {**next_meta, "selected": True, "reason": "selected"}


def rank1_high_structural_score_diagnostic_features(
    *,
    rank1_high_structural_score_switch: bool,
    rank1_high_structural_score_meta: dict[str, Any],
) -> dict[str, Any]:
    return {
        "constantGridDpRank1HighStructuralScoreSwitch": rank1_high_structural_score_switch,
        "constantGridDpRank1HighStructuralScoreReason": str(
            rank1_high_structural_score_meta.get("reason") or ""
        ),
        "constantGridDpRank1HighStructuralScoreCandidateRank": _to_int(
            rank1_high_structural_score_meta.get("candidateRank")
        ),
        "constantGridDpRank1HighStructuralScoreProbability": round(
            _to_float(rank1_high_structural_score_meta.get("probability")), 9
        ),
        "constantGridDpRank1HighStructuralScoreProbabilityMin": _to_float(
            rank1_high_structural_score_meta.get("probabilityMin"),
            RANK1_HIGH_STRUCTURAL_PROBABILITY_MIN,
        ),
        "constantGridDpRank1HighStructuralScoreGridScore": _to_float(
            rank1_high_structural_score_meta.get("gridScore")
        ),
        "constantGridDpRank1HighStructuralScoreGridScoreMin": _to_float(
            rank1_high_structural_score_meta.get("gridScoreMin"),
            RANK1_HIGH_STRUCTURAL_SCORE_MIN,
        ),
        "constantGridDpRank1HighStructuralScoreDownbeatMargin": _to_float(
            rank1_high_structural_score_meta.get("downbeatMargin")
        ),
        "constantGridDpRank1HighStructuralScoreDownbeatMarginMin": _to_float(
            rank1_high_structural_score_meta.get("downbeatMarginMin"),
            RANK1_HIGH_STRUCTURAL_DOWNBEAT_MARGIN_MIN,
        ),
        "constantGridDpRank1HighStructuralScorePhasePathScore": _to_float(
            rank1_high_structural_score_meta.get("phasePathScore")
        ),
        "constantGridDpRank1HighStructuralScorePhasePathScoreMin": _to_float(
            rank1_high_structural_score_meta.get("phasePathScoreMin"),
            RANK1_HIGH_STRUCTURAL_PHASE_PATH_MIN,
        ),
        "constantGridDpRank1HighStructuralScoreTempoScore": _to_float(
            rank1_high_structural_score_meta.get("tempoScore")
        ),
        "constantGridDpRank1HighStructuralScoreTempoScoreMin": _to_float(
            rank1_high_structural_score_meta.get("tempoScoreMin"),
            RANK1_HIGH_STRUCTURAL_TEMPO_MIN,
        ),
        "constantGridDpRank1HighStructuralScorePhaseDeltaAbsMs": _to_float(
            rank1_high_structural_score_meta.get("phaseDeltaAbsMs")
        ),
        "constantGridDpRank1HighStructuralScoreMinPhaseDeltaMs": _to_float(
            rank1_high_structural_score_meta.get("minPhaseDeltaAbsMs"),
            RANK1_HIGH_STRUCTURAL_MIN_PHASE_DELTA_MS,
        ),
        "constantGridDpRank1HighStructuralScoreBpmDelta": _to_float(
            rank1_high_structural_score_meta.get("bpmDelta")
        ),
        "constantGridDpRank1HighStructuralScoreMaxBpmDelta": _to_float(
            rank1_high_structural_score_meta.get("maxBpmDelta"),
            RANK1_HIGH_STRUCTURAL_MAX_BPM_DELTA,
        ),
        "constantGridDpRank1HighStructuralScoreLeadingEdgeMadMs": _to_float(
            rank1_high_structural_score_meta.get("leadingEdgePeakOffsetMadMs"), 99.0
        ),
        "constantGridDpRank1HighStructuralScoreLeadingEdgeMadMaxMs": _to_float(
            rank1_high_structural_score_meta.get("leadingEdgePeakOffsetMadMaxMs"),
            RANK1_HIGH_STRUCTURAL_LEADING_MAD_MAX_MS,
        ),
        "constantGridDpRank1HighStructuralScoreLegacyFirstBeatMs": _to_float(
            rank1_high_structural_score_meta.get("legacyFirstBeatMs")
        ),
        "constantGridDpRank1HighStructuralScoreLegacyFirstBeatMinMs": _to_float(
            rank1_high_structural_score_meta.get("legacyFirstBeatMinMs"),
            RANK1_HIGH_STRUCTURAL_LEGACY_FIRST_BEAT_MIN_MS,
        ),
        "constantGridDpRank1HighStructuralScoreDownbeatRank": _to_int(
            rank1_high_structural_score_meta.get("downbeatRank")
        ),
        "constantGridDpRank1HighStructuralScoreSameBarBeatOffsetMod4": bool(
            rank1_high_structural_score_meta.get("sameBarBeatOffsetMod4")
        ),
        "constantGridDpRank1HighStructuralScoreVersion": str(
            rank1_high_structural_score_meta.get("version") or ""
        ),
    }
