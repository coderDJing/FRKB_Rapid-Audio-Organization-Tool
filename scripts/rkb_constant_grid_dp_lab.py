import argparse
import json
import time
from pathlib import Path
from typing import Any

import numpy as np

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_beatgrid_lab_common import (
    BENCHMARK_OUTPUT_DIR,
    DEFAULT_BASELINE,
    DEFAULT_FEATURE_CACHE_DIR,
    atomic_write_json,
    baseline_summary,
    build_feature_index_map,
    configure_utf8_stdio,
    load_selected_truth_tracks,
    normalize_lookup_key,
    print_json,
    read_feature_metadata,
    resolve_feature_arrays_path,
    resolve_feature_entry,
    track_identity_key,
)
from rkb_constant_grid_dp_solver import (
    DEFAULT_MAX_BPM,
    DEFAULT_MAX_CANDIDATES,
    DEFAULT_MIN_BPM,
    DEFAULT_PHASE_STEP_MS,
    DEFAULT_TEMPO_LIMIT,
    DEFAULT_TEMPO_STEP_BPM,
    solve_constant_grid_dp,
)

DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "constant-grid-dp-lab-latest.json"
DEFAULT_SPLITS = BENCHMARK_OUTPUT_DIR / "rkb-dataset-splits-current.json"


def _load_split_map(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    splits = payload.get("splits") if isinstance(payload, dict) else None
    if not isinstance(splits, dict):
        return {}
    identity_key = str(payload.get("identityKey") or "fileName")
    result: dict[str, str] = {}
    for split_name, names in splits.items():
        if not isinstance(names, list):
            continue
        for name in names:
            raw_name = str(name or "").strip()
            if not raw_name:
                continue
            key = (
                f"instance:{raw_name.casefold()}"
                if identity_key == "instanceId"
                else f"file:{normalize_lookup_key(raw_name)}"
            )
            if key:
                result[key] = str(split_name)
    return result


def _baseline_category_map(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return {}
    result: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        key = track_identity_key(row)
        file_key = normalize_lookup_key(row.get("fileName"))
        category = str(((row.get("currentTimeline") or {}).get("category")) or "")
        if key and category:
            result[key] = category
        if file_key and category:
            result.setdefault(f"file:{file_key}", category)
    return result


def _evaluate_result(
    *,
    analysis: dict[str, Any],
    truth: dict[str, Any],
) -> dict[str, Any]:
    offset_ms = float((truth.get("timeBasis") or {}).get("offsetMs") or 0.0)
    timeline_first_beat_ms = float(analysis["firstBeatMs"]) + offset_ms
    metrics = benchmark._derive_grid_metrics(
        result_bpm=float(analysis["bpm"]),
        result_first_beat_timeline_ms=timeline_first_beat_ms,
        result_bar_beat_offset=int(analysis["barBeatOffset"]),
        truth=truth,
        compare_count=128,
    )
    classification = benchmark._classify(metrics, float(analysis["bpm"]), float(truth["bpm"]))
    return {
        "firstBeatMs": round(timeline_first_beat_ms, 3),
        **metrics,
        **classification,
    }


def _evaluate_candidate(
    *,
    candidate: dict[str, Any],
    truth: dict[str, Any],
    offset_ms: float,
    rank: int,
) -> dict[str, Any] | None:
    bpm = float(candidate.get("bpm") or 0.0)
    first_beat_ms = float(candidate.get("firstBeatMs") or 0.0)
    if bpm <= 0.0:
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
        "source": str(candidate.get("source") or ""),
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
    }


def _candidate_recall(*, analysis: dict[str, Any], truth: dict[str, Any]) -> dict[str, Any]:
    offset_ms = float((truth.get("timeBasis") or {}).get("offsetMs") or 0.0)
    raw_candidates = analysis.get("gridSolverCandidates")
    candidates = raw_candidates if isinstance(raw_candidates, list) else []
    evaluated = [
        item
        for index, candidate in enumerate(candidates, start=1)
        if isinstance(candidate, dict)
        and (
            item := _evaluate_candidate(
                candidate=candidate,
                truth=truth,
                offset_ms=offset_ms,
                rank=index,
            )
        )
        is not None
    ]
    grid_pass = [item for item in evaluated if item["category"] == "pass"]
    new_grid_pass = [
        item
        for item in grid_pass
        if "legacy" not in str(item.get("source") or "")
        and "beat-this-current-global-solver" not in str(item.get("source") or "")
    ]
    return {
        "candidateCount": len(evaluated),
        "hasGridCandidate": bool(grid_pass),
        "hasNewGridCandidate": bool(new_grid_pass),
        "bestGridCandidate": min(grid_pass, key=lambda item: int(item["rank"]), default=None),
        "bestNewGridCandidate": min(new_grid_pass, key=lambda item: int(item["rank"]), default=None),
    }


def _summarize_split(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows)
    pass_rows = [row for row in rows if row["currentTimeline"]["category"] == "pass"]
    legacy_pass_rows = [row for row in rows if row.get("legacyCategory") == "pass"]
    new_used_rows = [
        row
        for row in rows
        if bool(((row.get("analysis") or {}).get("gridSolverFeatures") or {}).get("constantGridDpUsedNewCandidate"))
    ]
    rescued_rows = [
        row
        for row in new_used_rows
        if row.get("legacyCategory") != "pass" and row["currentTimeline"]["category"] == "pass"
    ]
    hurt_rows = [
        row
        for row in new_used_rows
        if row.get("legacyCategory") == "pass" and row["currentTimeline"]["category"] != "pass"
    ]
    confidence_counts: dict[str, int] = {}
    for row in rows:
        features = ((row.get("analysis") or {}).get("gridSolverFeatures") or {})
        level = str(features.get("constantGridDpConfidenceLevel") or "unknown")
        confidence_counts[level] = confidence_counts.get(level, 0) + 1
    high_confidence_rows = [
        row
        for row in rows
        if str(((row.get("analysis") or {}).get("gridSolverFeatures") or {}).get("constantGridDpConfidenceLevel") or "")
        == "high"
    ]
    high_confidence_pass_rows = [
        row for row in high_confidence_rows if row["currentTimeline"]["category"] == "pass"
    ]
    candidate_pass_rows = [
        row for row in rows if bool((row.get("candidateRecall") or {}).get("hasGridCandidate"))
    ]
    new_candidate_pass_rows = [
        row for row in rows if bool((row.get("candidateRecall") or {}).get("hasNewGridCandidate"))
    ]
    oracle_selected_fail_rows = [
        row
        for row in candidate_pass_rows
        if row["currentTimeline"]["category"] != "pass"
    ]
    return {
        "trackTotal": total,
        "selectedPassCount": len(pass_rows),
        "selectedPassRate": round(len(pass_rows) / max(1, total), 6),
        "legacyPassCount": len(legacy_pass_rows),
        "legacyPassRate": round(len(legacy_pass_rows) / max(1, total), 6),
        "newCandidateUsedCount": len(new_used_rows),
        "legacyFailRescuedCount": len(rescued_rows),
        "legacyPassHurtCount": len(hurt_rows),
        "confidenceLevelCounts": confidence_counts,
        "highConfidence": {
            "trackCount": len(high_confidence_rows),
            "coverageRate": round(len(high_confidence_rows) / max(1, total), 6),
            "passCount": len(high_confidence_pass_rows),
            "passRate": round(len(high_confidence_pass_rows) / max(1, len(high_confidence_rows)), 6),
        },
        "candidateOracle": {
            "candidatePassCount": len(candidate_pass_rows),
            "candidatePassRate": round(len(candidate_pass_rows) / max(1, total), 6),
            "candidateMissCount": total - len(candidate_pass_rows),
            "oracleSelectedFailCount": len(oracle_selected_fail_rows),
        },
        "newCandidateOracle": {
            "candidatePassCount": len(new_candidate_pass_rows),
            "candidatePassRate": round(len(new_candidate_pass_rows) / max(1, total), 6),
            "candidateMissCount": total - len(new_candidate_pass_rows),
        },
    }


def _summarize(rows: list[dict[str, Any]], errors: list[dict[str, Any]]) -> dict[str, Any]:
    by_split: dict[str, list[dict[str, Any]]] = {"train": [], "tune": [], "holdout": [], "all": list(rows)}
    for row in rows:
        split = str(row.get("split") or "")
        if split in by_split:
            by_split[split].append(row)
    category_counts: dict[str, int] = {}
    for row in rows:
        category = str((row.get("currentTimeline") or {}).get("category") or "unknown")
        category_counts[category] = category_counts.get(category, 0) + 1
    return {
        "trackTotal": len(rows) + len(errors),
        "analyzedTrackCount": len(rows),
        "errorTrackCount": len(errors),
        "categoryCounts": category_counts,
        "splits": {split: _summarize_split(split_rows) for split, split_rows in by_split.items()},
    }


def _build_track_report(
    *,
    track: dict[str, Any],
    split: str,
    legacy_category: str | None,
    metadata: dict[str, Any],
    arrays: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    analysis = solve_constant_grid_dp(
        metadata=metadata,
        arrays=arrays,
        min_bpm=float(args.min_bpm),
        max_bpm=float(args.max_bpm),
        tempo_step_bpm=float(args.tempo_step_bpm),
        tempo_limit=int(args.tempo_limit),
        phase_step_ms=float(args.phase_step_ms),
        max_candidates=int(args.max_candidates),
    )
    return {
        "fileName": track["fileName"],
        "instanceId": track.get("instanceId"),
        "batchId": track.get("batchId"),
        "split": split,
        "legacyCategory": legacy_category,
        "truth": {
            "bpm": track["bpm"],
            "firstBeatMs": track["firstBeatMs"],
            "barBeatOffset": track["barBeatOffset"],
            "timeBasis": track.get("timeBasis"),
        },
        "featureCacheKey": metadata.get("cacheKey"),
        "analysis": analysis,
        "currentTimeline": _evaluate_result(analysis=analysis, truth=track),
        "candidateRecall": _candidate_recall(analysis=analysis, truth=track),
    }


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Run the constant-grid-dp beatgrid lab")
    parser.add_argument("--truth", default=str(benchmark.DEFAULT_TRUTH))
    parser.add_argument("--audio-root", default=str(benchmark.DEFAULT_AUDIO_ROOT))
    parser.add_argument("--ffprobe", default=str(benchmark.DEFAULT_FFPROBE))
    parser.add_argument("--feature-cache-dir", default=str(DEFAULT_FEATURE_CACHE_DIR))
    parser.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    parser.add_argument("--splits", default=str(DEFAULT_SPLITS))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--min-bpm", type=float, default=DEFAULT_MIN_BPM)
    parser.add_argument("--max-bpm", type=float, default=DEFAULT_MAX_BPM)
    parser.add_argument("--tempo-step-bpm", type=float, default=DEFAULT_TEMPO_STEP_BPM)
    parser.add_argument("--tempo-limit", type=int, default=DEFAULT_TEMPO_LIMIT)
    parser.add_argument("--phase-step-ms", type=float, default=DEFAULT_PHASE_STEP_MS)
    parser.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", action="append", default=[])
    args = parser.parse_args()

    truth_path = Path(args.truth)
    ffprobe_path = Path(args.ffprobe)
    cache_dir = Path(args.feature_cache_dir)
    output_path = Path(args.output)
    if not truth_path.exists():
        raise SystemExit(f"truth not found: {truth_path}")
    if not ffprobe_path.exists():
        raise SystemExit(f"ffprobe not found: {ffprobe_path}")
    if not cache_dir.exists():
        raise SystemExit(f"feature cache dir not found: {cache_dir}")

    only_filters = [normalize_lookup_key(item) for item in args.only if normalize_lookup_key(item)]
    selected_tracks = load_selected_truth_tracks(
        truth_path=truth_path,
        audio_root=str(args.audio_root),
        ffprobe_path=ffprobe_path,
        only_filters=only_filters,
        limit=int(args.limit or 0),
    )
    if not selected_tracks:
        raise SystemExit("no tracks selected")

    started_at = time.time()
    split_map = _load_split_map(Path(args.splits))
    legacy_categories = _baseline_category_map(Path(args.baseline))
    index_map = build_feature_index_map(cache_dir)
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for index, track in enumerate(selected_tracks, start=1):
        print(f"[{index}/{len(selected_tracks)}] {track['fileName']}", flush=True)
        try:
            entry = resolve_feature_entry(track=track, index_map=index_map)
            if entry is None:
                raise RuntimeError("feature cache missing; run rkb_beatgrid_feature_cache.py first")
            metadata = read_feature_metadata(cache_dir, entry, track=track)
            arrays_path = resolve_feature_arrays_path(cache_dir, entry, metadata)
            if not arrays_path.exists():
                raise RuntimeError(f"feature arrays missing: {arrays_path}")
            lookup_key = track_identity_key(track)
            file_lookup_key = f"file:{normalize_lookup_key(track['fileName'])}"
            with np.load(arrays_path, allow_pickle=False) as arrays:
                rows.append(
                    _build_track_report(
                        track=track,
                        split=split_map.get(lookup_key, "unknown"),
                        legacy_category=(
                            legacy_categories.get(lookup_key)
                            or legacy_categories.get(file_lookup_key)
                        ),
                        metadata=metadata,
                        arrays=arrays,
                        args=args,
                    )
                )
        except Exception as error:
            errors.append(
                {
                    "fileName": track.get("fileName"),
                    "instanceId": track.get("instanceId"),
                    "batchId": track.get("batchId"),
                    "error": str(error),
                }
            )
            print(f"  error: {error}", flush=True)

    summary = {
        **_summarize(rows, errors),
        "truthPath": str(truth_path),
        "featureCacheDir": str(cache_dir),
        "strictToleranceMs": benchmark.STRICT_TOLERANCE_MS,
        "baseline": baseline_summary(Path(args.baseline)),
        "durationSec": round(time.time() - started_at, 3),
    }
    payload = {"summary": summary, "errors": errors, "tracks": rows}
    atomic_write_json(output_path, payload)
    print_json({"summary": summary, "output": str(output_path)})
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
