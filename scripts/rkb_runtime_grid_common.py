import math
from typing import Any

LEGACY_GRID_SOURCE = "beat-this-current-global-solver"


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


def metadata_legacy_candidate(metadata: dict[str, Any]) -> dict[str, Any] | None:
    payload = metadata.get("legacyGridSolver") if isinstance(metadata.get("legacyGridSolver"), dict) else None
    result = payload.get("result") if isinstance(payload, dict) and isinstance(payload.get("result"), dict) else None
    if result is None:
        return None
    bpm = _to_float(result.get("bpm"))
    first_beat_ms = _to_float(result.get("firstBeatMs"))
    if bpm <= 0.0 or not math.isfinite(first_beat_ms):
        return None
    features = result.get("gridSolverFeatures") if isinstance(result.get("gridSolverFeatures"), dict) else {}
    legacy_score = _to_float(result.get("gridSolverScore"))
    anchor_confidence = _to_float(result.get("anchorConfidenceScore"))
    drift_128_ms = abs(_to_float(result.get("beatThisEstimatedDrift128Ms")))
    confidence_score = _clamp01(anchor_confidence)
    drift_score = _clamp01((24.0 - min(24.0, drift_128_ms)) / 24.0)
    return {
        "source": "hybrid-legacy-source",
        "tempoSource": LEGACY_GRID_SOURCE,
        "phaseSource": "legacy-selected-phase",
        "barSource": "legacy-selected-downbeat",
        "bpm": round(bpm, 6),
        "firstBeatMs": round(first_beat_ms, 3),
        "barBeatOffset": int(result.get("barBeatOffset") or 0) % 32,
        "score": round(2.0 + confidence_score * 0.2 + drift_score * 0.1, 6),
        "features": {
            "tempoScore": round(drift_score, 6),
            "phaseScore": round(confidence_score, 6),
            "downbeatScore": round(_to_float(features.get("downbeatConsensusScore")), 6),
            "legacyGridSolverScore": round(legacy_score, 6),
            "legacyGridSolverSelectedSource": str(result.get("gridSolverSelectedSource") or ""),
            "anchorConfidenceScore": round(anchor_confidence, 6),
            "beatThisEstimatedDrift128Ms": round(drift_128_ms, 3),
        },
    }


def window_summary(metadata: dict[str, Any]) -> dict[str, Any]:
    windows = ((metadata.get("beatThis") or {}).get("windows")) or []
    valid = [item for item in windows if isinstance(item, dict)]
    if not valid:
        return {
            "beatCount": 0,
            "downbeatCount": 0,
            "qualityScore": 0.0,
            "windowIndex": 0,
            "windowDurationSec": 0.0,
            "windowCount": 0,
        }
    best = max(valid, key=lambda item: _to_float(item.get("qualityScore")))
    return {
        "beatCount": int(best.get("beatCount") or 0),
        "downbeatCount": int(best.get("downbeatCount") or 0),
        "qualityScore": round(_to_float(best.get("qualityScore")), 6),
        "windowIndex": int(best.get("windowIndex") or 0),
        "windowDurationSec": round(_to_float(best.get("windowDurationSec")), 3),
        "windowCount": len(valid),
    }
