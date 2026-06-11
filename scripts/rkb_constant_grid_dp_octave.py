import math
from typing import Any

RANK1_OCTAVE_DOWN_SCORE_MIN = 0.86
RANK1_OCTAVE_DOWN_DOWNBEAT_MARGIN_MIN = 0.5
RANK1_OCTAVE_DOWN_PHASE_PATH_SCORE_MIN = 0.7
RANK1_OCTAVE_DOWN_LEADING_EDGE_MAD_MAX_MS = 8.0
RANK1_OCTAVE_DOWN_TEMPO_SCORE_MIN = 0.74
RANK1_OCTAVE_DOWN_CONFIDENCE_MAX = 0.82
RANK1_OCTAVE_DOWN_BPM_DELTA_MAX = 0.08
RANK1_OCTAVE_DOWN_VERSION = "rank1-octave-down-v1"


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


def _round_feature(value: float) -> float:
    return round(float(value), 6) if math.isfinite(float(value)) else 0.0


def _candidate_source(candidate: dict[str, Any]) -> str:
    tempo_source = str(candidate.get("tempoSource") or "tempo")
    phase_source = str(candidate.get("phaseSource") or "phase")
    bar_source = str(candidate.get("barSource") or "bar")
    return f"constant-grid-dp:{tempo_source}:{phase_source}:{bar_source}"


def choose_rank1_octave_down_candidate(
    *,
    candidates: list[dict[str, Any]],
    selected_source: str,
    legacy_candidate: dict[str, Any] | None,
    confidence: float,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    meta: dict[str, Any] = {
        "selected": False,
        "reason": "not-evaluated",
        "candidateRank": 1,
        "gridScore": 0.0,
        "gridScoreMin": RANK1_OCTAVE_DOWN_SCORE_MIN,
        "downbeatMargin": 0.0,
        "downbeatMarginMin": RANK1_OCTAVE_DOWN_DOWNBEAT_MARGIN_MIN,
        "phasePathScore": 0.0,
        "phasePathScoreMin": RANK1_OCTAVE_DOWN_PHASE_PATH_SCORE_MIN,
        "leadingEdgePeakOffsetMadMs": 99.0,
        "leadingEdgePeakOffsetMadMaxMs": RANK1_OCTAVE_DOWN_LEADING_EDGE_MAD_MAX_MS,
        "tempoScore": 0.0,
        "tempoScoreMin": RANK1_OCTAVE_DOWN_TEMPO_SCORE_MIN,
        "confidence": _round_feature(confidence),
        "confidenceMax": RANK1_OCTAVE_DOWN_CONFIDENCE_MAX,
        "bpmDelta": 999.0,
        "maxBpmDelta": RANK1_OCTAVE_DOWN_BPM_DELTA_MAX,
        "downbeatRank": 0,
        "version": RANK1_OCTAVE_DOWN_VERSION,
    }
    if "legacy" not in selected_source.lower():
        return None, {**meta, "reason": "selected-source-not-legacy"}
    if legacy_candidate is None:
        return None, {**meta, "reason": "no-legacy-candidate"}
    if not candidates:
        return None, {**meta, "reason": "no-candidates"}

    rank1 = candidates[0]
    rank1_source = _candidate_source(rank1)
    rank1_features = rank1.get("features") if isinstance(rank1.get("features"), dict) else {}
    rank1_bpm = _to_float(rank1.get("bpm"))
    legacy_bpm = _to_float(legacy_candidate.get("bpm"))
    bpm_delta = abs(rank1_bpm * 2.0 - legacy_bpm)
    grid_score = _to_float(rank1.get("score"))
    downbeat_margin = _to_float(rank1_features.get("downbeatMargin"))
    phase_path_score = _to_float(rank1_features.get("phasePathScore"))
    leading_mad = _to_float(rank1_features.get("leadingEdgePeakOffsetMadMs"), 99.0)
    tempo_score = _to_float(rank1_features.get("tempoScore"))
    downbeat_rank = _to_int(rank1_features.get("downbeatRank"))
    next_meta = {
        **meta,
        "gridScore": _round_feature(grid_score),
        "downbeatMargin": _round_feature(downbeat_margin),
        "phasePathScore": _round_feature(phase_path_score),
        "leadingEdgePeakOffsetMadMs": _round_feature(leading_mad),
        "tempoScore": _round_feature(tempo_score),
        "bpmDelta": _round_feature(bpm_delta),
        "downbeatRank": downbeat_rank,
    }
    if confidence > RANK1_OCTAVE_DOWN_CONFIDENCE_MAX:
        return None, {**next_meta, "reason": "confidence-too-high"}
    if bpm_delta > RANK1_OCTAVE_DOWN_BPM_DELTA_MAX:
        return None, {**next_meta, "reason": "not-octave-down"}
    if "window-beat-leading-edge" not in rank1_source:
        return None, {**next_meta, "reason": "source-not-leading-edge"}
    if grid_score < RANK1_OCTAVE_DOWN_SCORE_MIN:
        return None, {**next_meta, "reason": "grid-score-too-low"}
    if downbeat_rank != 0:
        return None, {**next_meta, "reason": "downbeat-rank-not-zero"}
    if downbeat_margin < RANK1_OCTAVE_DOWN_DOWNBEAT_MARGIN_MIN:
        return None, {**next_meta, "reason": "downbeat-margin-too-low"}
    if phase_path_score < RANK1_OCTAVE_DOWN_PHASE_PATH_SCORE_MIN:
        return None, {**next_meta, "reason": "phase-path-score-too-low"}
    if leading_mad > RANK1_OCTAVE_DOWN_LEADING_EDGE_MAD_MAX_MS:
        return None, {**next_meta, "reason": "leading-edge-mad-too-wide"}
    if tempo_score < RANK1_OCTAVE_DOWN_TEMPO_SCORE_MIN:
        return None, {**next_meta, "reason": "tempo-score-too-low"}

    features = dict(rank1_features)
    features.update(
        {
            "constantGridDpRank1OctaveDownSwitch": True,
            "constantGridDpRank1OctaveDownGridScore": _round_feature(grid_score),
            "constantGridDpRank1OctaveDownGridScoreMin": RANK1_OCTAVE_DOWN_SCORE_MIN,
            "constantGridDpRank1OctaveDownDownbeatMargin": _round_feature(downbeat_margin),
            "constantGridDpRank1OctaveDownDownbeatMarginMin": (
                RANK1_OCTAVE_DOWN_DOWNBEAT_MARGIN_MIN
            ),
            "constantGridDpRank1OctaveDownPhasePathScore": _round_feature(phase_path_score),
            "constantGridDpRank1OctaveDownPhasePathScoreMin": (
                RANK1_OCTAVE_DOWN_PHASE_PATH_SCORE_MIN
            ),
            "constantGridDpRank1OctaveDownLeadingEdgeMadMs": _round_feature(leading_mad),
            "constantGridDpRank1OctaveDownLeadingEdgeMadMaxMs": (
                RANK1_OCTAVE_DOWN_LEADING_EDGE_MAD_MAX_MS
            ),
            "constantGridDpRank1OctaveDownTempoScore": _round_feature(tempo_score),
            "constantGridDpRank1OctaveDownTempoScoreMin": RANK1_OCTAVE_DOWN_TEMPO_SCORE_MIN,
            "constantGridDpRank1OctaveDownConfidence": _round_feature(confidence),
            "constantGridDpRank1OctaveDownConfidenceMax": RANK1_OCTAVE_DOWN_CONFIDENCE_MAX,
            "constantGridDpRank1OctaveDownBpmDelta": _round_feature(bpm_delta),
            "constantGridDpRank1OctaveDownMaxBpmDelta": RANK1_OCTAVE_DOWN_BPM_DELTA_MAX,
            "constantGridDpRank1OctaveDownDownbeatRank": downbeat_rank,
            "constantGridDpRank1OctaveDownVersion": RANK1_OCTAVE_DOWN_VERSION,
        }
    )
    return {**rank1, "features": features}, {**next_meta, "selected": True, "reason": "selected"}


def rank1_octave_down_diagnostic_features(
    *,
    rank1_octave_down_switch: bool,
    rank1_octave_down_meta: dict[str, Any],
) -> dict[str, Any]:
    return {
        "constantGridDpRank1OctaveDownSwitch": rank1_octave_down_switch,
        "constantGridDpRank1OctaveDownReason": str(rank1_octave_down_meta.get("reason") or ""),
        "constantGridDpRank1OctaveDownGridScore": _to_float(rank1_octave_down_meta.get("gridScore")),
        "constantGridDpRank1OctaveDownGridScoreMin": _to_float(
            rank1_octave_down_meta.get("gridScoreMin"), RANK1_OCTAVE_DOWN_SCORE_MIN
        ),
        "constantGridDpRank1OctaveDownDownbeatMargin": _to_float(
            rank1_octave_down_meta.get("downbeatMargin")
        ),
        "constantGridDpRank1OctaveDownDownbeatMarginMin": _to_float(
            rank1_octave_down_meta.get("downbeatMarginMin"),
            RANK1_OCTAVE_DOWN_DOWNBEAT_MARGIN_MIN,
        ),
        "constantGridDpRank1OctaveDownPhasePathScore": _to_float(
            rank1_octave_down_meta.get("phasePathScore")
        ),
        "constantGridDpRank1OctaveDownPhasePathScoreMin": _to_float(
            rank1_octave_down_meta.get("phasePathScoreMin"),
            RANK1_OCTAVE_DOWN_PHASE_PATH_SCORE_MIN,
        ),
        "constantGridDpRank1OctaveDownLeadingEdgeMadMs": _to_float(
            rank1_octave_down_meta.get("leadingEdgePeakOffsetMadMs"), 99.0
        ),
        "constantGridDpRank1OctaveDownLeadingEdgeMadMaxMs": _to_float(
            rank1_octave_down_meta.get("leadingEdgePeakOffsetMadMaxMs"),
            RANK1_OCTAVE_DOWN_LEADING_EDGE_MAD_MAX_MS,
        ),
        "constantGridDpRank1OctaveDownConfidence": _to_float(
            rank1_octave_down_meta.get("confidence")
        ),
        "constantGridDpRank1OctaveDownConfidenceMax": _to_float(
            rank1_octave_down_meta.get("confidenceMax"), RANK1_OCTAVE_DOWN_CONFIDENCE_MAX
        ),
        "constantGridDpRank1OctaveDownBpmDelta": _to_float(
            rank1_octave_down_meta.get("bpmDelta")
        ),
        "constantGridDpRank1OctaveDownMaxBpmDelta": _to_float(
            rank1_octave_down_meta.get("maxBpmDelta"), RANK1_OCTAVE_DOWN_BPM_DELTA_MAX
        ),
        "constantGridDpRank1OctaveDownDownbeatRank": _to_int(
            rank1_octave_down_meta.get("downbeatRank")
        ),
        "constantGridDpRank1OctaveDownVersion": str(rank1_octave_down_meta.get("version") or ""),
    }
