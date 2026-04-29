import statistics
from typing import Any


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    if numeric != numeric:
        return None
    return numeric


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * (percentile / 100.0)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _summarize_metric(rows: list[dict[str, Any]], metric_path: tuple[str, ...]) -> dict[str, float]:
    values: list[float] = []
    for row in rows:
        value: Any = row
        for key in metric_path:
            value = value.get(key) if isinstance(value, dict) else None
        numeric = _to_float(value)
        if numeric is not None:
            values.append(abs(numeric))
    if not values:
        return {"mean": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0}
    return {
        "mean": round(statistics.fmean(values), 3),
        "median": round(statistics.median(values), 3),
        "p95": round(_percentile(values, 95.0), 3),
        "max": round(max(values), 3),
    }


def build_summary(
    rows: list[dict[str, Any]],
    error_rows: list[dict[str, Any]],
    *,
    strict_tolerance_ms: float,
) -> dict[str, Any]:
    categories: dict[str, int] = {}
    grid_solver_source_counts: dict[str, int] = {}
    oracle_pass_count = 0
    oracle_missed_count = 0
    oracle_selected_fail_count = 0
    best_passing_ranks: list[float] = []
    bpm_big_error_count = 0
    phase_fail_count = 0
    for row in rows:
        timeline = row.get("currentTimeline") or {}
        category = str(timeline.get("category") or "unknown")
        categories[category] = categories.get(category, 0) + 1
        analysis = row.get("analysis") or {}
        source = str(analysis.get("gridSolverSelectedSource") or "unknown")
        grid_solver_source_counts[source] = grid_solver_source_counts.get(source, 0) + 1
        oracle = row.get("candidateOracle") if isinstance(row.get("candidateOracle"), dict) else {}
        if bool(oracle.get("hasPassingCandidate")):
            oracle_pass_count += 1
            rank = _to_float(oracle.get("bestPassingRank"))
            if rank is not None:
                best_passing_ranks.append(rank)
            if category != "pass":
                oracle_selected_fail_count += 1
        else:
            oracle_missed_count += 1
        if abs(float(timeline.get("bpmOnlyDrift128BeatsMs") or 0.0)) > strict_tolerance_ms:
            bpm_big_error_count += 1
        if str(timeline.get("firstBeatPhaseStatus") or "") == "fail":
            phase_fail_count += 1

    worst_tracks = sorted(
        rows,
        key=lambda row: float((row.get("currentTimeline") or {}).get("gridMeanAbsMs") or 0.0),
        reverse=True,
    )[:8]

    return {
        "trackTotal": len(rows) + len(error_rows),
        "analyzedTrackCount": len(rows),
        "errorTrackCount": len(error_rows),
        "categoryCounts": categories,
        "gridSolverSelectedSourceCounts": grid_solver_source_counts,
        "gridSolverCandidateCount": _summarize_metric(rows, ("analysis", "gridSolverCandidateCount")),
        "gridSolverScore": _summarize_metric(rows, ("analysis", "gridSolverScore")),
        "candidateOracle": {
            "candidatePassCount": oracle_pass_count,
            "candidatePassRate": round(oracle_pass_count / max(1, len(rows)), 6),
            "candidateMissCount": oracle_missed_count,
            "oracleSelectedFailCount": oracle_selected_fail_count,
            "bestPassingRank": {
                "mean": round(statistics.fmean(best_passing_ranks), 3) if best_passing_ranks else 0.0,
                "median": round(statistics.median(best_passing_ranks), 3) if best_passing_ranks else 0.0,
                "p95": round(_percentile(best_passing_ranks, 95.0), 3) if best_passing_ranks else 0.0,
                "max": round(max(best_passing_ranks), 3) if best_passing_ranks else 0.0,
            },
        },
        "bpmBigErrorCount": bpm_big_error_count,
        "phaseFailCount": phase_fail_count,
        "currentTimeline": {
            "firstBeatPhaseAbsErrorMs": _summarize_metric(rows, ("currentTimeline", "firstBeatPhaseAbsErrorMs")),
            "gridMeanAbsMs": _summarize_metric(rows, ("currentTimeline", "gridMeanAbsMs")),
            "gridP95AbsMs": _summarize_metric(rows, ("currentTimeline", "gridP95AbsMs")),
            "gridMaxAbsMs": _summarize_metric(rows, ("currentTimeline", "gridMaxAbsMs")),
            "bpmOnlyDrift128BeatsMs": _summarize_metric(rows, ("currentTimeline", "bpmOnlyDrift128BeatsMs")),
        },
        "absoluteTimelineCandidate": {
            "firstBeatPhaseAbsErrorMs": _summarize_metric(
                rows,
                ("absoluteTimelineCandidate", "firstBeatPhaseAbsErrorMs"),
            ),
            "gridMeanAbsMs": _summarize_metric(rows, ("absoluteTimelineCandidate", "gridMeanAbsMs")),
            "gridP95AbsMs": _summarize_metric(rows, ("absoluteTimelineCandidate", "gridP95AbsMs")),
            "gridMaxAbsMs": _summarize_metric(rows, ("absoluteTimelineCandidate", "gridMaxAbsMs")),
        },
        "downbeatMismatchMod4Count": sum(
            1 for row in rows if not bool((row.get("currentTimeline") or {}).get("barBeatOffsetMatchedMod4"))
        ),
        "exact32OffsetMismatchCount": sum(
            1 for row in rows if not bool((row.get("currentTimeline") or {}).get("barBeatOffsetMatchedExact32"))
        ),
        "worstTracks": [
            {
                "fileName": row["fileName"],
                "category": (row.get("currentTimeline") or {}).get("category"),
                "bpm": (row.get("analysis") or {}).get("bpm"),
                "truthBpm": (row.get("truth") or {}).get("bpm"),
                "firstBeatPhaseAbsErrorMs": (row.get("currentTimeline") or {}).get("firstBeatPhaseAbsErrorMs"),
                "gridMeanAbsMs": (row.get("currentTimeline") or {}).get("gridMeanAbsMs"),
                "gridMaxAbsMs": (row.get("currentTimeline") or {}).get("gridMaxAbsMs"),
                "bpmOnlyDrift128BeatsMs": (row.get("currentTimeline") or {}).get("bpmOnlyDrift128BeatsMs"),
                "barBeatOffset": (row.get("analysis") or {}).get("barBeatOffset"),
                "truthBarBeatOffset": (row.get("truth") or {}).get("barBeatOffset"),
                "anchorStrategy": (row.get("analysis") or {}).get("anchorStrategy"),
                "gridSolverSelectedSource": (row.get("analysis") or {}).get("gridSolverSelectedSource"),
                "candidateOracle": row.get("candidateOracle"),
            }
            for row in worst_tracks
        ],
    }
