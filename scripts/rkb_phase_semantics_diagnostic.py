import argparse
import json
import math
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_beatgrid_lab_common import BENCHMARK_OUTPUT_DIR, atomic_write_json

VERSION = "rkb-phase-semantics-diagnostic-v1"
DEFAULT_CURRENT_BENCHMARK = BENCHMARK_OUTPUT_DIR / "frkb-current-latest.json"
DEFAULT_CURRENT_SPLITS = BENCHMARK_OUTPUT_DIR / "rkb-dataset-splits-current.json"
DEFAULT_BLIND_ROOT = BENCHMARK_OUTPUT_DIR / "blind-rekordbox-truth"
DEFAULT_BLIND_BENCHMARK = DEFAULT_BLIND_ROOT / "frkb-blind-constant-grid-dp-phasepath-diagnostic.json"
DEFAULT_BLIND_SPLITS = DEFAULT_BLIND_ROOT / "rkb-blind-dataset-splits.json"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "phase-semantics-diagnostic-latest.json"

FEATURES_HIGHER_IS_BETTER = (
    "score",
    "tempoScore",
    "phaseScore",
    "phaseSupportRatio",
    "phaseCompactness",
    "leadingEdgeScore",
    "leadingEdgeTargetScore",
    "leadingEdgeConsistencyScore",
    "leadingEdgePeakScore",
    "attackPhaseScore",
    "dpBeatMean",
    "dpBeatSegmentAgreement",
    "dpFullAttackMean",
    "dpFullAttackSegmentAgreement",
    "dpLowAttackMean",
    "dpLowAttackSegmentAgreement",
    "introLeadingEdgeScore",
    "introLeadingEdgeTargetScore",
    "introLeadingEdgeConsistencyScore",
    "introLeadingEdgePeakScore",
    "phasePathScore",
    "phasePathTargetScore",
    "phasePathSegmentAgreement",
    "phasePathPeakScore",
    "phasePathIntroReliability",
    "constantGridDpPhaseEvidenceSwitchScore",
)

FEATURES_LOWER_IS_BETTER = (
    "leadingEdgePeakOffsetMadMs",
    "introLeadingEdgePeakOffsetMadMs",
    "phasePathPeakOffsetMadMs",
)

FEATURES_OFFSET_MS = (
    "leadingEdgeTargetOffsetMs",
    "leadingEdgePeakOffsetMedianMs",
    "introLeadingEdgeTargetOffsetMs",
    "introLeadingEdgePeakOffsetMedianMs",
    "phasePathTargetOffsetMs",
    "phasePathPeakOffsetMedianMs",
    "phaseShiftMs",
    "timelineQuantizationShiftMs",
)

FEATURE_KEYS = FEATURES_HIGHER_IS_BETTER + FEATURES_LOWER_IS_BETTER + FEATURES_OFFSET_MS
RANK_BUCKETS = (1, 3, 5, 10, 20, 40, 80, 160)
PHASE_BUCKETS_MS = (5, 10, 20, 40, 80, 160, 320)


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _round(value: Any, digits: int = 6) -> float | None:
    numeric = _to_float(value)
    if numeric is None:
        return None
    return round(numeric, digits)


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 6) if values else None


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 6) if values else None


def _rate(count: int, total: int) -> float:
    return round(count / total, 6) if total > 0 else 0.0


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"expected JSON object: {path}")
    return payload


def _split_map(path: Path) -> dict[str, str]:
    payload = _load_json(path)
    splits = payload.get("splits") if isinstance(payload.get("splits"), dict) else {}
    result: dict[str, str] = {}
    for split_name, names in splits.items():
        if not isinstance(names, list):
            continue
        for name in names:
            key = benchmark._normalize_lookup_key(name)
            if key:
                result[key] = str(split_name)
    return result


def _tracks(path: Path) -> list[dict[str, Any]]:
    payload = _load_json(path)
    tracks = payload.get("tracks")
    if not isinstance(tracks, list):
        raise RuntimeError(f"benchmark contains no tracks: {path}")
    return [track for track in tracks if isinstance(track, dict)]


def _phase_delta_ms(a_ms: float, b_ms: float, beat_interval_ms: float) -> float:
    if beat_interval_ms <= 0.0:
        return a_ms - b_ms
    delta = (a_ms - b_ms + beat_interval_ms / 2.0) % beat_interval_ms - beat_interval_ms / 2.0
    return delta


def _candidate_metrics(
    *,
    candidate: dict[str, Any],
    truth: dict[str, Any],
    offset_ms: float,
    rank: int,
) -> dict[str, Any] | None:
    bpm = _to_float(candidate.get("bpm"))
    first_beat_ms = _to_float(candidate.get("firstBeatMs"))
    truth_bpm = _to_float(truth.get("bpm"))
    if bpm is None or bpm <= 0.0 or first_beat_ms is None or truth_bpm is None or truth_bpm <= 0.0:
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
    classification = benchmark._classify(metrics, bpm, truth_bpm)
    features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    return {
        "rank": rank,
        "source": str(candidate.get("source") or ""),
        "score": _round(candidate.get("score")) or 0.0,
        "bpm": round(bpm, 6),
        "firstBeatMs": round(first_beat_ms, 3),
        "timelineFirstBeatMs": round(timeline_first_beat_ms, 3),
        "barBeatOffset": bar_beat_offset,
        "category": classification["category"],
        "firstBeatPhaseErrorMs": metrics["firstBeatPhaseErrorMs"],
        "firstBeatPhaseAbsErrorMs": metrics["firstBeatPhaseAbsErrorMs"],
        "gridMaxAbsMs": metrics["gridMaxAbsMs"],
        "bpmOnlyDrift128BeatsMs": metrics["bpmOnlyDrift128BeatsMs"],
        "barBeatOffsetMatchedMod4": metrics["barBeatOffsetMatchedMod4"],
        "features": features,
    }


def _candidate_list(track: dict[str, Any]) -> list[dict[str, Any]]:
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    candidates = analysis.get("gridSolverCandidates")
    return [item for item in candidates if isinstance(item, dict)] if isinstance(candidates, list) else []


def _evaluated_candidates(track: dict[str, Any]) -> list[dict[str, Any]]:
    truth = track.get("truth") if isinstance(track.get("truth"), dict) else {}
    offset_ms = _to_float((truth.get("timeBasis") or {}).get("offsetMs")) or 0.0
    result: list[dict[str, Any]] = []
    for rank, candidate in enumerate(_candidate_list(track), start=1):
        evaluated = _candidate_metrics(candidate=candidate, truth=truth, offset_ms=offset_ms, rank=rank)
        if evaluated is not None:
            result.append(evaluated)
    return result


def _selected_profile(track: dict[str, Any]) -> dict[str, Any]:
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    timeline = track.get("currentTimeline") if isinstance(track.get("currentTimeline"), dict) else {}
    features = analysis.get("gridSolverFeatures") if isinstance(analysis.get("gridSolverFeatures"), dict) else {}
    return {
        "source": str(analysis.get("gridSolverSelectedSource") or ""),
        "score": _round(analysis.get("gridSolverScore")) or 0.0,
        "bpm": _round(analysis.get("bpm")) or 0.0,
        "firstBeatMs": _round(analysis.get("firstBeatMs"), 3) or 0.0,
        "timelineFirstBeatMs": _round(timeline.get("firstBeatMs"), 3) or 0.0,
        "barBeatOffset": int(analysis.get("barBeatOffset") or 0) % 32,
        "category": str(timeline.get("category") or ""),
        "firstBeatPhaseErrorMs": _round(timeline.get("firstBeatPhaseErrorMs"), 3) or 0.0,
        "firstBeatPhaseAbsErrorMs": _round(timeline.get("firstBeatPhaseAbsErrorMs"), 3) or 0.0,
        "gridMaxAbsMs": _round(timeline.get("gridMaxAbsMs"), 3) or 0.0,
        "features": features,
    }


def _best_passing_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    passing = [item for item in candidates if item["category"] == "pass"]
    return min(passing, key=lambda item: int(item["rank"]), default=None)


def _feature_delta(best: dict[str, Any], selected: dict[str, Any], key: str) -> float | None:
    if key == "score":
        best_value = _to_float(best.get("score"))
        selected_value = _to_float(selected.get("score"))
    else:
        best_value = _to_float((best.get("features") or {}).get(key))
        selected_value = _to_float((selected.get("features") or {}).get(key))
    if best_value is None or selected_value is None:
        return None
    return best_value - selected_value


def _candidate_feature_delta(best: dict[str, Any], baseline: dict[str, Any], key: str) -> float | None:
    if key == "score":
        best_value = _to_float(best.get("score"))
        baseline_value = _to_float(baseline.get("score"))
    else:
        best_value = _to_float((best.get("features") or {}).get(key))
        baseline_value = _to_float((baseline.get("features") or {}).get(key))
    if best_value is None or baseline_value is None:
        return None
    return best_value - baseline_value


def _rank_bucket(rank: int | None) -> str:
    if rank is None:
        return "none"
    for bucket in RANK_BUCKETS:
        if rank <= bucket:
            return f"<= {bucket}"
    return "> 160"


def _phase_bucket(value_ms: float | None) -> str:
    if value_ms is None:
        return "none"
    abs_value = abs(value_ms)
    for bucket in PHASE_BUCKETS_MS:
        if abs_value <= bucket:
            return f"<= {bucket}ms"
    return "> 320ms"


def _candidate_row(dataset: str, split: str, track: dict[str, Any]) -> dict[str, Any] | None:
    selected = _selected_profile(track)
    candidates = _evaluated_candidates(track)
    best = _best_passing_candidate(candidates)
    top = candidates[0] if candidates else None
    if best is None or top is None:
        return None
    truth = track.get("truth") if isinstance(track.get("truth"), dict) else {}
    truth_bpm = _to_float(truth.get("bpm")) or 0.0
    beat_interval_ms = 60000.0 / truth_bpm if truth_bpm > 0.0 else 0.0
    selected_to_best_phase_delta_ms = _phase_delta_ms(
        selected["timelineFirstBeatMs"],
        best["timelineFirstBeatMs"],
        beat_interval_ms,
    )
    top_to_best_phase_delta_ms = _phase_delta_ms(
        top["timelineFirstBeatMs"],
        best["timelineFirstBeatMs"],
        beat_interval_ms,
    )
    deltas = {
        key: _feature_delta(best, selected, key)
        for key in FEATURE_KEYS
        if _feature_delta(best, selected, key) is not None
    }
    top_deltas = {
        key: _candidate_feature_delta(best, top, key)
        for key in FEATURE_KEYS
        if _candidate_feature_delta(best, top, key) is not None
    }
    return {
        "dataset": dataset,
        "split": split,
        "fileName": str(track.get("fileName") or ""),
        "selectedCategory": selected["category"],
        "bestPassingRank": best["rank"],
        "bestPassingSource": best["source"],
        "selectedSource": selected["source"],
        "topCandidateCategory": top["category"],
        "topCandidateSource": top["source"],
        "selectedPhaseErrorMs": selected["firstBeatPhaseErrorMs"],
        "topCandidatePhaseErrorMs": top["firstBeatPhaseErrorMs"],
        "bestPassingPhaseErrorMs": best["firstBeatPhaseErrorMs"],
        "selectedToBestPhaseDeltaMs": round(selected_to_best_phase_delta_ms, 3),
        "selectedToBestPhaseAbsDeltaMs": round(abs(selected_to_best_phase_delta_ms), 3),
        "topToBestPhaseDeltaMs": round(top_to_best_phase_delta_ms, 3),
        "topToBestPhaseAbsDeltaMs": round(abs(top_to_best_phase_delta_ms), 3),
        "selectedScore": selected["score"],
        "topCandidateScore": top["score"],
        "bestPassingScore": best["score"],
        "featureDeltas": deltas,
        "bestVsTopFeatureDeltas": top_deltas,
    }


def _feature_summary(rows: list[dict[str, Any]], *, delta_key: str) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for key in FEATURE_KEYS:
        values = [row[delta_key][key] for row in rows if key in row.get(delta_key, {})]
        if not values:
            continue
        if key in FEATURES_LOWER_IS_BETTER:
            favorable_count = sum(1 for value in values if value < 0.0)
        elif key in FEATURES_OFFSET_MS:
            favorable_count = sum(1 for value in values if abs(value) <= 4.0)
        else:
            favorable_count = sum(1 for value in values if value > 0.0)
        summary[key] = {
            "count": len(values),
            "meanDelta": _mean(values),
            "medianDelta": _median(values),
            "favorableRate": _rate(favorable_count, len(values)),
        }
    return summary


def _group_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    rank_counts = Counter(_rank_bucket(int(row["bestPassingRank"])) for row in rows)
    phase_counts = Counter(_phase_bucket(_to_float(row.get("selectedToBestPhaseDeltaMs"))) for row in rows)
    top_phase_counts = Counter(_phase_bucket(_to_float(row.get("topToBestPhaseDeltaMs"))) for row in rows)
    top_category_counts = Counter(str(row.get("topCandidateCategory") or "unknown") for row in rows)
    selected_phase_errors = [
        abs(float(row["selectedPhaseErrorMs"])) for row in rows if _to_float(row.get("selectedPhaseErrorMs")) is not None
    ]
    top_phase_errors = [
        abs(float(row["topCandidatePhaseErrorMs"]))
        for row in rows
        if _to_float(row.get("topCandidatePhaseErrorMs")) is not None
    ]
    best_ranks = [int(row["bestPassingRank"]) for row in rows]
    phase_deltas = [
        abs(float(row["selectedToBestPhaseDeltaMs"]))
        for row in rows
        if _to_float(row.get("selectedToBestPhaseDeltaMs")) is not None
    ]
    signed_phase_deltas = [
        float(row["selectedToBestPhaseDeltaMs"])
        for row in rows
        if _to_float(row.get("selectedToBestPhaseDeltaMs")) is not None
    ]
    top_phase_deltas = [
        abs(float(row["topToBestPhaseDeltaMs"]))
        for row in rows
        if _to_float(row.get("topToBestPhaseDeltaMs")) is not None
    ]
    signed_top_phase_deltas = [
        float(row["topToBestPhaseDeltaMs"])
        for row in rows
        if _to_float(row.get("topToBestPhaseDeltaMs")) is not None
    ]
    signed_phase_counts = Counter("positive" if value > 0 else "negative" if value < 0 else "zero" for value in signed_phase_deltas)
    signed_top_phase_counts = Counter(
        "positive" if value > 0 else "negative" if value < 0 else "zero" for value in signed_top_phase_deltas
    )
    return {
        "trackCount": len(rows),
        "bestPassingRank": {
            "mean": _mean([float(item) for item in best_ranks]),
            "median": _median([float(item) for item in best_ranks]),
            "buckets": dict(sorted(rank_counts.items())),
        },
        "selectedPhaseAbsErrorMs": {
            "mean": _mean(selected_phase_errors),
            "median": _median(selected_phase_errors),
        },
        "topCandidateCategoryCounts": dict(top_category_counts),
        "topCandidatePhaseAbsErrorMs": {
            "mean": _mean(top_phase_errors),
            "median": _median(top_phase_errors),
        },
        "selectedToBestPhaseAbsDeltaMs": {
            "mean": _mean(phase_deltas),
            "median": _median(phase_deltas),
            "buckets": dict(sorted(phase_counts.items())),
        },
        "selectedToBestPhaseSignedDeltaMs": {
            "mean": _mean(signed_phase_deltas),
            "median": _median(signed_phase_deltas),
            "signCounts": dict(signed_phase_counts),
        },
        "topToBestPhaseAbsDeltaMs": {
            "mean": _mean(top_phase_deltas),
            "median": _median(top_phase_deltas),
            "buckets": dict(sorted(top_phase_counts.items())),
        },
        "topToBestPhaseSignedDeltaMs": {
            "mean": _mean(signed_top_phase_deltas),
            "median": _median(signed_top_phase_deltas),
            "signCounts": dict(signed_top_phase_counts),
        },
        "bestVsSelectedFeatureSummary": _feature_summary(rows, delta_key="featureDeltas"),
        "bestVsTopFeatureSummary": _feature_summary(rows, delta_key="bestVsTopFeatureDeltas"),
    }


def _source_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    selected_sources = Counter(str(row["selectedSource"]) for row in rows)
    top_sources = Counter(str(row["topCandidateSource"]) for row in rows)
    best_sources = Counter(str(row["bestPassingSource"]) for row in rows)
    return {
        "selectedSourceCounts": dict(selected_sources.most_common(12)),
        "topCandidateSourceCounts": dict(top_sources.most_common(12)),
        "bestPassingSourceCounts": dict(best_sources.most_common(12)),
    }


def _dataset_report(
    *,
    name: str,
    benchmark_path: Path,
    split_path: Path,
    focus_category: str,
    detail_limit: int,
) -> dict[str, Any]:
    split_map = _split_map(split_path)
    tracks = _tracks(benchmark_path)
    totals: Counter[str] = Counter()
    focus_rows: list[dict[str, Any]] = []
    all_fixable_rows: list[dict[str, Any]] = []
    split_category_counts: dict[str, Counter[str]] = {}
    for track in tracks:
        key = benchmark._normalize_lookup_key(track.get("fileName"))
        split = split_map.get(key, "unknown")
        timeline = track.get("currentTimeline") if isinstance(track.get("currentTimeline"), dict) else {}
        category = str(timeline.get("category") or "unknown")
        totals[category] += 1
        split_category_counts.setdefault(split, Counter())[category] += 1
        candidate_row = _candidate_row(name, split, track)
        if candidate_row is not None and category != "pass":
            all_fixable_rows.append(candidate_row)
        if candidate_row is not None and category == focus_category:
            focus_rows.append(candidate_row)

    by_split: dict[str, Any] = {}
    for split in ("train", "tune", "holdout", "unknown"):
        split_rows = [row for row in focus_rows if row["split"] == split]
        if not split_rows and split not in split_category_counts:
            continue
        by_split[split] = {
            "categoryCounts": dict(split_category_counts.get(split, Counter())),
            "focusFixableSummary": _group_summary(split_rows),
            "sourceSummary": _source_summary(split_rows),
        }

    detail_rows = sorted(
        focus_rows,
        key=lambda row: (
            int(row["bestPassingRank"]),
            -float(row["selectedToBestPhaseAbsDeltaMs"]),
            str(row["fileName"]),
        ),
    )[: max(0, detail_limit)]
    compact_details = [
        {
            "split": row["split"],
            "fileName": row["fileName"],
            "bestPassingRank": row["bestPassingRank"],
            "selectedToBestPhaseDeltaMs": row["selectedToBestPhaseDeltaMs"],
            "selectedSource": row["selectedSource"],
            "bestPassingSource": row["bestPassingSource"],
            "featureDeltas": {
                key: row["featureDeltas"][key]
                for key in (
                    "score",
                    "introLeadingEdgeScore",
                    "leadingEdgeTargetScore",
                    "phasePathScore",
                    "phasePathSegmentAgreement",
                    "dpBeatSegmentAgreement",
                    "dpFullAttackSegmentAgreement",
                    "leadingEdgePeakOffsetMadMs",
                    "phasePathPeakOffsetMadMs",
                )
                if key in row["featureDeltas"]
            },
            "bestVsTopFeatureDeltas": {
                key: row["bestVsTopFeatureDeltas"][key]
                for key in (
                    "score",
                    "tempoScore",
                    "phaseScore",
                    "introLeadingEdgeScore",
                    "leadingEdgeTargetScore",
                    "phasePathScore",
                    "phasePathSegmentAgreement",
                    "dpBeatSegmentAgreement",
                    "dpFullAttackSegmentAgreement",
                    "leadingEdgePeakOffsetMadMs",
                    "phasePathPeakOffsetMadMs",
                )
                if key in row["bestVsTopFeatureDeltas"]
            },
        }
        for row in detail_rows
    ]
    return {
        "benchmark": str(benchmark_path),
        "splitPath": str(split_path),
        "trackTotal": len(tracks),
        "categoryCounts": dict(totals),
        "focusCategory": focus_category,
        "focusFixableCount": len(focus_rows),
        "allFixableFailCount": len(all_fixable_rows),
        "focusFixableSummary": _group_summary(focus_rows),
        "sourceSummary": _source_summary(focus_rows),
        "bySplit": by_split,
        "detailRows": compact_details,
    }


def _cross_dataset_summary(datasets: dict[str, dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in FEATURE_KEYS:
        entries = []
        for dataset_name, report in datasets.items():
            feature_summary = ((report.get("focusFixableSummary") or {}).get("bestVsTopFeatureSummary") or {}).get(key)
            if isinstance(feature_summary, dict) and feature_summary.get("count"):
                entries.append(
                    {
                        "dataset": dataset_name,
                        "count": feature_summary["count"],
                        "medianDelta": feature_summary["medianDelta"],
                        "favorableRate": feature_summary["favorableRate"],
                    }
                )
        if len(entries) >= 2:
            median_values = [
                float(item["medianDelta"])
                for item in entries
                if _to_float(item.get("medianDelta")) is not None
            ]
            favorable_values = [
                float(item["favorableRate"])
                for item in entries
                if _to_float(item.get("favorableRate")) is not None
            ]
            result[key] = {
                "datasets": entries,
                "medianDeltaSigns": sorted({1 if value > 0 else -1 if value < 0 else 0 for value in median_values}),
                "minFavorableRate": min(favorable_values) if favorable_values else None,
            }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Build offline phase semantics diagnostics from RKB benchmark JSON")
    parser.add_argument("--current-benchmark", default=str(DEFAULT_CURRENT_BENCHMARK))
    parser.add_argument("--current-splits", default=str(DEFAULT_CURRENT_SPLITS))
    parser.add_argument("--blind-benchmark", default=str(DEFAULT_BLIND_BENCHMARK))
    parser.add_argument("--blind-splits", default=str(DEFAULT_BLIND_SPLITS))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--focus-category", default="first-beat-phase")
    parser.add_argument("--detail-limit", type=int, default=40)
    args = parser.parse_args()

    datasets = {
        "current": _dataset_report(
            name="current",
            benchmark_path=Path(args.current_benchmark),
            split_path=Path(args.current_splits),
            focus_category=str(args.focus_category),
            detail_limit=int(args.detail_limit),
        ),
        "blind": _dataset_report(
            name="blind",
            benchmark_path=Path(args.blind_benchmark),
            split_path=Path(args.blind_splits),
            focus_category=str(args.focus_category),
            detail_limit=int(args.detail_limit),
        ),
    }
    output = {
        "version": VERSION,
        "scope": (
            "Offline diagnostics only. Feature deltas compare selected candidates against best passing "
            "candidates and must not be used directly as production scorer rules."
        ),
        "focusCategory": str(args.focus_category),
        "datasets": datasets,
        "crossDatasetFeatureSummary": _cross_dataset_summary(datasets),
    }
    output_path = Path(args.output)
    atomic_write_json(output_path, output)
    print(json.dumps({"output": str(output_path), "focusCategory": args.focus_category}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
