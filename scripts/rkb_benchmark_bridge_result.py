from typing import Any


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    if numeric != numeric:
        return None
    return numeric


def _normalize_bar_offset(value: Any, modulo: int) -> int:
    try:
        numeric = int(value)
    except Exception:
        numeric = 0
    return ((numeric % modulo) + modulo) % modulo


def _normalize_feature_map(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    normalized: dict[str, Any] = {}
    for key, item in value.items():
        numeric = _to_float(item)
        normalized[str(key)] = round(numeric, 6) if numeric is not None else item
    return normalized


def _normalize_candidates(value: Any, limit: int | None = None) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, Any]] = []
    items = value if limit is None else value[:limit]
    for item in items:
        if not isinstance(item, dict):
            continue
        normalized.append(
            {
                "source": str(item.get("source") or "").strip() or "unknown",
                "score": round(_to_float(item.get("score")) or 0.0, 6),
                "bpm": round(_to_float(item.get("bpm")) or 0.0, 6),
                "firstBeatMs": round(_to_float(item.get("firstBeatMs")) or 0.0, 3),
                "barBeatOffset": _normalize_bar_offset(item.get("barBeatOffset"), 32),
                "features": _normalize_feature_map(item.get("features")),
            }
        )
    return normalized


def normalize_bridge_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "bpm": round(_to_float(result.get("bpm")) or 0.0, 6),
        "rawBpm": round(_to_float(result.get("rawBpm")) or 0.0, 6),
        "firstBeatMs": round(_to_float(result.get("firstBeatMs")) or 0.0, 3),
        "rawFirstBeatMs": round(_to_float(result.get("rawFirstBeatMs")) or 0.0, 3),
        "absoluteFirstBeatMs": round(_to_float(result.get("absoluteFirstBeatMs")) or 0.0, 3),
        "absoluteRawFirstBeatMs": round(_to_float(result.get("absoluteRawFirstBeatMs")) or 0.0, 3),
        "barBeatOffset": _normalize_bar_offset(result.get("barBeatOffset"), 32),
        "beatCount": int(result.get("beatCount") or 0),
        "downbeatCount": int(result.get("downbeatCount") or 0),
        "durationSec": round(_to_float(result.get("durationSec")) or 0.0, 3),
        "beatIntervalSec": round(_to_float(result.get("beatIntervalSec")) or 0.0, 6),
        "qualityScore": round(_to_float(result.get("qualityScore")) or 0.0, 6),
        "anchorCorrectionMs": round(_to_float(result.get("anchorCorrectionMs")) or 0.0, 3),
        "anchorConfidenceScore": round(_to_float(result.get("anchorConfidenceScore")) or 0.0, 6),
        "anchorMatchedBeatCount": int(result.get("anchorMatchedBeatCount") or 0),
        "anchorStrategy": str(result.get("anchorStrategy") or "").strip() or None,
        "windowIndex": int(result.get("windowIndex") or 0),
        "windowStartSec": round(_to_float(result.get("windowStartSec")) or 0.0, 3),
        "windowDurationSec": round(_to_float(result.get("windowDurationSec")) or 0.0, 3),
        "beatThisEstimatedDrift128Ms": round(
            _to_float(result.get("beatThisEstimatedDrift128Ms")) or 0.0,
            3,
        ),
        "beatThisWindowCount": int(result.get("beatThisWindowCount") or 0),
        "gridSolverSelectedSource": str(result.get("gridSolverSelectedSource") or "").strip()
        or None,
        "gridSolverCandidateCount": int(result.get("gridSolverCandidateCount") or 0),
        "gridSolverScore": round(_to_float(result.get("gridSolverScore")) or 0.0, 6),
        "gridSolverSelectionGuard": str(result.get("gridSolverSelectionGuard") or "").strip() or None,
        "gridSolverSelectionGuardScoreMargin": round(
            _to_float(result.get("gridSolverSelectionGuardScoreMargin")) or 0.0,
            6,
        ),
        "gridSolverFeatures": _normalize_feature_map(result.get("gridSolverFeatures")),
        "gridSolverTopCandidates": _normalize_candidates(result.get("gridSolverTopCandidates"), 10),
        "gridSolverCandidates": _normalize_candidates(result.get("gridSolverCandidates")),
    }
