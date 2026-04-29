from typing import Any, Callable

GridMetricsFn = Callable[..., dict[str, Any]]
ClassifyFn = Callable[[dict[str, Any], float, float], dict[str, str]]
ToFloatFn = Callable[[Any], float | None]
NormalizeBarOffsetFn = Callable[[Any, int], int]


def _evaluate_grid_candidate(
    candidate: dict[str, Any],
    truth: dict[str, Any],
    *,
    offset_ms: float,
    rank: int,
    compare_count: int,
    derive_grid_metrics: GridMetricsFn,
    classify: ClassifyFn,
    to_float: ToFloatFn,
    normalize_bar_offset: NormalizeBarOffsetFn,
) -> dict[str, Any] | None:
    bpm = to_float(candidate.get("bpm"))
    first_beat_ms = to_float(candidate.get("firstBeatMs"))
    if bpm is None or bpm <= 0.0 or first_beat_ms is None:
        return None
    bar_beat_offset = normalize_bar_offset(candidate.get("barBeatOffset"), 32)
    timeline_first_beat_ms = float(first_beat_ms) + offset_ms
    metrics = derive_grid_metrics(
        result_bpm=float(bpm),
        result_first_beat_timeline_ms=timeline_first_beat_ms,
        result_bar_beat_offset=bar_beat_offset,
        truth=truth,
        compare_count=compare_count,
    )
    classification = classify(metrics, float(bpm), float(truth["bpm"]))
    return {
        "rank": rank,
        "source": str(candidate.get("source") or "unknown"),
        "score": round(to_float(candidate.get("score")) or 0.0, 6),
        "bpm": round(float(bpm), 6),
        "firstBeatMs": round(float(first_beat_ms), 3),
        "timelineFirstBeatMs": round(timeline_first_beat_ms, 3),
        "barBeatOffset": bar_beat_offset,
        "category": classification["category"],
        "firstBeatPhaseAbsErrorMs": metrics["firstBeatPhaseAbsErrorMs"],
        "gridMaxAbsMs": metrics["gridMaxAbsMs"],
        "bpmOnlyDrift128BeatsMs": metrics["bpmOnlyDrift128BeatsMs"],
        "barBeatOffsetMatchedMod4": metrics["barBeatOffsetMatchedMod4"],
    }


def derive_candidate_oracle(
    analysis: dict[str, Any],
    truth: dict[str, Any],
    *,
    offset_ms: float,
    compare_count: int,
    derive_grid_metrics: GridMetricsFn,
    classify: ClassifyFn,
    to_float: ToFloatFn,
    normalize_bar_offset: NormalizeBarOffsetFn,
) -> dict[str, Any]:
    raw_candidates = analysis.get("gridSolverCandidates")
    if not isinstance(raw_candidates, list):
        raw_candidates = analysis.get("gridSolverTopCandidates")
    evaluated: list[dict[str, Any]] = []
    for index, candidate in enumerate(raw_candidates or [], start=1):
        if not isinstance(candidate, dict):
            continue
        item = _evaluate_grid_candidate(
            candidate,
            truth,
            offset_ms=offset_ms,
            rank=index,
            compare_count=compare_count,
            derive_grid_metrics=derive_grid_metrics,
            classify=classify,
            to_float=to_float,
            normalize_bar_offset=normalize_bar_offset,
        )
        if item is not None:
            evaluated.append(item)

    passing = [item for item in evaluated if item["category"] == "pass"]
    best_passing = min(passing, key=lambda item: item["rank"], default=None)
    best_phase = min(evaluated, key=lambda item: float(item["firstBeatPhaseAbsErrorMs"]), default=None)
    best_grid = min(evaluated, key=lambda item: float(item["gridMaxAbsMs"]), default=None)
    return {
        "candidateCount": len(evaluated),
        "passingCandidateCount": len(passing),
        "hasPassingCandidate": bool(passing),
        "bestPassingRank": best_passing["rank"] if best_passing else None,
        "bestPassingCandidate": best_passing,
        "bestPhaseCandidate": best_phase,
        "bestGridCandidate": best_grid,
        "topCandidates": evaluated[:10],
    }
