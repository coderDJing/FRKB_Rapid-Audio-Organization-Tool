import statistics
from typing import Any

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_beatgrid_lab_common import to_float


def _safe_mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def _evaluate_candidate(
    *,
    candidate: dict[str, Any],
    truth: dict[str, Any],
    offset_ms: float,
    rank: int,
) -> dict[str, Any] | None:
    bpm = to_float(candidate.get("bpm"))
    first_beat_ms = to_float(candidate.get("firstBeatMs"))
    if bpm is None or bpm <= 0.0 or first_beat_ms is None:
        return None
    bar_beat_offset = benchmark._normalize_bar_offset(candidate.get("barBeatOffset"), 32)
    timeline_first_beat_ms = first_beat_ms + offset_ms
    metrics = benchmark._derive_grid_metrics(
        result_bpm=bpm,
        result_first_beat_timeline_ms=timeline_first_beat_ms,
        result_bar_beat_offset=bar_beat_offset,
        truth=truth,
        compare_count=128,
    )
    classification = benchmark._classify(metrics, bpm, float(truth["bpm"]))
    return {
        "rank": rank,
        "source": candidate.get("source"),
        "tempoSource": candidate.get("tempoSource"),
        "phaseSource": candidate.get("phaseSource"),
        "barSource": candidate.get("barSource"),
        "score": round(float(candidate.get("score") or 0.0), 6),
        "bpm": round(bpm, 6),
        "firstBeatMs": round(first_beat_ms, 3),
        "timelineFirstBeatMs": round(timeline_first_beat_ms, 3),
        "barBeatOffset": bar_beat_offset,
        "category": classification["category"],
        "firstBeatPhaseAbsErrorMs": metrics["firstBeatPhaseAbsErrorMs"],
        "gridMaxAbsMs": metrics["gridMaxAbsMs"],
        "bpmOnlyDrift128BeatsMs": metrics["bpmOnlyDrift128BeatsMs"],
        "barBeatOffsetMatchedMod4": metrics["barBeatOffsetMatchedMod4"],
        "features": candidate.get("features"),
    }


def build_candidate_track_report(
    *,
    track: dict[str, Any],
    metadata: dict[str, Any],
    candidates: list[dict[str, Any]],
    strict_tolerance_ms: float,
) -> dict[str, Any]:
    offset_ms = float((track.get("timeBasis") or {}).get("offsetMs") or 0.0)
    evaluated = [
        item
        for index, candidate in enumerate(candidates, start=1)
        if (
            item := _evaluate_candidate(
                candidate=candidate,
                truth=track,
                offset_ms=offset_ms,
                rank=index,
            )
        )
        is not None
    ]
    selected = evaluated[0] if evaluated else None
    tempo_pass = [
        item for item in evaluated if abs(float(item["bpmOnlyDrift128BeatsMs"])) <= strict_tolerance_ms
    ]
    phase_pass = [
        item for item in tempo_pass if float(item["firstBeatPhaseAbsErrorMs"]) <= strict_tolerance_ms
    ]
    downbeat_pass = [item for item in phase_pass if bool(item["barBeatOffsetMatchedMod4"])]
    grid_pass = [item for item in evaluated if item["category"] == "pass"]
    return {
        "fileName": track["fileName"],
        "truth": {
            "bpm": track["bpm"],
            "firstBeatMs": track["firstBeatMs"],
            "barBeatOffset": track["barBeatOffset"],
            "timeBasis": track.get("timeBasis"),
        },
        "featureCacheKey": metadata.get("cacheKey"),
        "candidateCount": len(evaluated),
        "selectedCandidate": selected,
        "candidateRecall": {
            "hasTempoCandidate": bool(tempo_pass),
            "hasPhaseCandidate": bool(phase_pass),
            "hasDownbeatCandidate": bool(downbeat_pass),
            "hasGridCandidate": bool(grid_pass),
            "bestTempoCandidate": min(
                tempo_pass,
                key=lambda item: abs(float(item["bpmOnlyDrift128BeatsMs"])),
                default=None,
            ),
            "bestPhaseCandidate": min(
                phase_pass,
                key=lambda item: float(item["firstBeatPhaseAbsErrorMs"]),
                default=None,
            ),
            "bestGridCandidate": min(
                grid_pass,
                key=lambda item: int(item["rank"]),
                default=None,
            ),
        },
        "topCandidates": evaluated[:20],
    }


def _summarize(rows: list[dict[str, Any]], errors: list[dict[str, Any]]) -> dict[str, Any]:
    selected_pass = [
        row for row in rows if ((row.get("selectedCandidate") or {}).get("category") == "pass")
    ]
    tempo_pass = [row for row in rows if (row.get("candidateRecall") or {}).get("hasTempoCandidate")]
    phase_pass = [row for row in rows if (row.get("candidateRecall") or {}).get("hasPhaseCandidate")]
    downbeat_pass = [row for row in rows if (row.get("candidateRecall") or {}).get("hasDownbeatCandidate")]
    grid_pass = [row for row in rows if (row.get("candidateRecall") or {}).get("hasGridCandidate")]
    candidate_counts = [float(row.get("candidateCount") or 0.0) for row in rows]
    selected_categories: dict[str, int] = {}
    for row in rows:
        category = str(((row.get("selectedCandidate") or {}).get("category")) or "none")
        selected_categories[category] = selected_categories.get(category, 0) + 1
    analyzed_count = len(rows)
    return {
        "trackTotal": len(rows) + len(errors),
        "analyzedTrackCount": analyzed_count,
        "errorTrackCount": len(errors),
        "tempoCandidatePassCount": len(tempo_pass),
        "tempoCandidatePassRate": round(len(tempo_pass) / max(1, analyzed_count), 6),
        "phaseCandidatePassCount": len(phase_pass),
        "phaseCandidatePassRate": round(len(phase_pass) / max(1, analyzed_count), 6),
        "downbeatCandidatePassCount": len(downbeat_pass),
        "downbeatCandidatePassRate": round(len(downbeat_pass) / max(1, analyzed_count), 6),
        "gridCandidatePassCount": len(grid_pass),
        "gridCandidatePassRate": round(len(grid_pass) / max(1, analyzed_count), 6),
        "selectedPassCount": len(selected_pass),
        "selectedPassRate": round(len(selected_pass) / max(1, analyzed_count), 6),
        "selectedCategoryCounts": selected_categories,
        "candidateCount": {
            "mean": round(_safe_mean(candidate_counts), 3),
            "median": round(statistics.median(candidate_counts), 3) if candidate_counts else 0.0,
            "max": round(max(candidate_counts), 3) if candidate_counts else 0.0,
        },
    }
