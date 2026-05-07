import argparse
import json
import math
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from rkb_beatgrid_lab_common import BENCHMARK_OUTPUT_DIR, atomic_write_json, build_feature_index_map
from rkb_phase_trajectory_diagnostic import (
    _evaluated_candidates,
    _load_signal_bundle,
    _split_map,
    _to_float,
    _tracks,
)
import benchmark_rkb_rekordbox_truth as benchmark

VERSION = "rkb-onset-foot-phase-diagnostic-v1"
DEFAULT_CURRENT_BENCHMARK = BENCHMARK_OUTPUT_DIR / "frkb-current-latest.json"
DEFAULT_CURRENT_SPLITS = BENCHMARK_OUTPUT_DIR / "rkb-dataset-splits-current.json"
DEFAULT_CURRENT_FEATURE_CACHE = BENCHMARK_OUTPUT_DIR / "feature-cache"
DEFAULT_BLIND_ROOT = BENCHMARK_OUTPUT_DIR / "blind-rekordbox-truth"
DEFAULT_BLIND_BENCHMARK = DEFAULT_BLIND_ROOT / "frkb-blind-constant-grid-dp-phasepath-diagnostic.json"
DEFAULT_BLIND_SPLITS = DEFAULT_BLIND_ROOT / "rkb-blind-dataset-splits.json"
DEFAULT_BLIND_FEATURE_CACHE = DEFAULT_BLIND_ROOT / "feature-cache"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "onset-foot-phase-diagnostic-latest.json"

DATASET_ORDER = ("current", "blind")
RANK_LIMITS = (1, 3, 5, 10, 20)
THRESHOLDS = (0.64, 0.68, 0.72, 0.76, 0.80, 0.84, 0.88, 0.92)
MIN_SUPPORTS = (16, 24, 32)
MAX_EVALUATED_RANK = max(RANK_LIMITS)


def _configure_utf8_stdio() -> None:
    try:
        import sys

        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))


def _rate(count: int, total: int) -> float:
    return round(count / total, 6) if total > 0 else 0.0


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 6) if values else None


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float | None:
    if values.size == 0 or values.size != weights.size:
        return None
    total = float(np.sum(weights))
    if not math.isfinite(total) or total <= 0.0:
        return None
    order = np.argsort(values)
    sorted_values = values[order]
    sorted_weights = weights[order]
    cumulative = np.cumsum(sorted_weights)
    index = int(np.searchsorted(cumulative, total * 0.5, side="left"))
    index = max(0, min(index, sorted_values.size - 1))
    return float(sorted_values[index])


def _grid_times_for_candidate(candidate: dict[str, Any], duration_sec: float, limit: int) -> np.ndarray:
    bpm = float(candidate["bpm"])
    first_beat_ms = float(candidate["firstBeatMs"])
    if bpm <= 0.0 or duration_sec <= 0.0:
        return np.asarray([], dtype="float64")
    interval_sec = 60.0 / bpm
    start_sec = first_beat_ms / 1000.0
    values: list[float] = []
    index = 0
    while len(values) < limit:
        time_sec = start_sec + index * interval_sec
        if time_sec > min(duration_sec, 120.0):
            break
        if time_sec >= 0.0:
            values.append(time_sec)
        index += 1
    return np.asarray(values, dtype="float64")


def _empty_profile(prefix: str) -> dict[str, Any]:
    return {
        f"{prefix}Score": 0.0,
        f"{prefix}TargetScore": 0.0,
        f"{prefix}ConsistencyScore": 0.0,
        f"{prefix}PeakDelayScore": 0.0,
        f"{prefix}ContrastScore": 0.0,
        f"{prefix}SegmentAgreement": 0.0,
        f"{prefix}FootOffsetMedianMs": 999.0,
        f"{prefix}FootOffsetMadMs": 999.0,
        f"{prefix}PeakOffsetMedianMs": 999.0,
        f"{prefix}RiseMsMedian": 999.0,
        f"{prefix}Support": 0,
        f"{prefix}SegmentCount": 0,
    }


def _onset_foot_profile(
    values: np.ndarray,
    *,
    frame_rate: float,
    candidate: dict[str, Any],
    duration_sec: float,
    prefix: str,
) -> dict[str, Any]:
    if values.size == 0 or frame_rate <= 0.0:
        return _empty_profile(prefix)
    times_sec = _grid_times_for_candidate(candidate, duration_sec, limit=64)
    if times_sec.size < 8:
        return _empty_profile(prefix)
    offset_step_ms = max(1.0, 1000.0 / frame_rate)
    offset_ms = np.arange(-36.0, 48.0 + 0.001, offset_step_ms, dtype="float64")
    offset_samples = np.rint(offset_ms * frame_rate / 1000.0).astype("int64", copy=False)
    keep = np.unique(offset_samples, return_index=True)[1]
    keep.sort()
    offset_ms = offset_ms[keep]
    offset_samples = offset_samples[keep]
    if offset_samples.size < 8:
        return _empty_profile(prefix)

    positions = np.rint(times_sec * frame_rate).astype("int64", copy=False)
    indices = positions[:, None] + offset_samples[None, :]
    valid = (indices >= 0) & (indices < values.size)
    clipped = np.clip(indices, 0, max(0, values.size - 1))
    sampled = values[clipped].astype("float64", copy=False)
    sampled = np.where(valid, sampled, np.nan)

    pre_mask = (offset_ms >= -34.0) & (offset_ms <= -8.0)
    peak_mask = (offset_ms >= -4.0) & (offset_ms <= 42.0)
    post_mask = (offset_ms >= 0.0) & (offset_ms <= 30.0)
    search_min = int(np.searchsorted(offset_ms, -28.0, side="left"))
    if not bool(np.any(pre_mask)) or not bool(np.any(peak_mask)):
        return _empty_profile(prefix)

    foot_offsets: list[float] = []
    peak_offsets: list[float] = []
    rise_values: list[float] = []
    contrasts: list[float] = []
    weights: list[float] = []
    block_medians: list[float] = []
    for row_index in range(sampled.shape[0]):
        row = sampled[row_index]
        finite = np.isfinite(row)
        if int(np.count_nonzero(finite)) < 8:
            continue
        pre_values = row[pre_mask]
        peak_values = row[peak_mask]
        if not np.isfinite(pre_values).any() or not np.isfinite(peak_values).any():
            continue
        baseline = float(np.nanpercentile(pre_values, 35.0))
        peak_local_index = int(np.nanargmax(peak_values))
        peak_indices = np.flatnonzero(peak_mask)
        peak_index = int(peak_indices[peak_local_index])
        peak_value = float(row[peak_index])
        amplitude = peak_value - baseline
        if not math.isfinite(amplitude) or amplitude <= 0.001:
            continue
        threshold = baseline + amplitude * 0.22
        end_index = max(search_min, peak_index)
        search_values = row[search_min : end_index + 1]
        crossing = np.flatnonzero(np.isfinite(search_values) & (search_values >= threshold))
        if crossing.size == 0:
            continue
        foot_index = int(search_min + crossing[0])
        pre_mean = float(np.nanmean(pre_values)) if np.isfinite(pre_values).any() else baseline
        post_values = row[post_mask]
        post_mean = float(np.nanmean(post_values)) if np.isfinite(post_values).any() else peak_value
        contrast = (post_mean - pre_mean) / max(0.001, abs(peak_value))
        foot_offset = float(offset_ms[foot_index])
        peak_offset = float(offset_ms[peak_index])
        rise_ms = max(0.0, peak_offset - foot_offset)
        foot_offsets.append(foot_offset)
        peak_offsets.append(peak_offset)
        rise_values.append(rise_ms)
        contrasts.append(contrast)
        weights.append(max(0.001, amplitude))

    if len(foot_offsets) < 8:
        return _empty_profile(prefix)
    foot_array = np.asarray(foot_offsets, dtype="float64")
    peak_array = np.asarray(peak_offsets, dtype="float64")
    rise_array = np.asarray(rise_values, dtype="float64")
    contrast_array = np.asarray(contrasts, dtype="float64")
    weight_array = np.asarray(weights, dtype="float64")
    median_foot = _weighted_median(foot_array, weight_array)
    if median_foot is None:
        return _empty_profile(prefix)
    foot_mad = _weighted_median(np.abs(foot_array - median_foot), weight_array)
    if foot_mad is None:
        foot_mad = 999.0
    median_peak = _weighted_median(peak_array, weight_array)
    if median_peak is None:
        median_peak = 999.0
    median_rise = _weighted_median(rise_array, weight_array)
    if median_rise is None:
        median_rise = 999.0

    for start in range(0, len(foot_offsets), 16):
        block = foot_array[start : start + 16]
        block_weights = weight_array[start : start + 16]
        if block.size >= 8:
            value = _weighted_median(block, block_weights)
            if value is not None:
                block_medians.append(value)
    segment_mad = statistics.median([abs(value - median_foot) for value in block_medians]) if block_medians else 999.0
    target_score = _clamp01(1.0 - abs(float(median_foot)) / 8.0)
    consistency_score = _clamp01(1.0 - float(foot_mad) / 8.0)
    peak_delay_score = _clamp01(1.0 - abs(float(median_peak) - 14.0) / 22.0)
    contrast_score = _clamp01(float(np.nanmean(contrast_array)) * 2.0)
    segment_agreement = _clamp01(1.0 - float(segment_mad) / 10.0)
    score = _clamp01(
        target_score * 0.38
        + consistency_score * 0.24
        + peak_delay_score * 0.16
        + contrast_score * 0.12
        + segment_agreement * 0.10
    )
    return {
        f"{prefix}Score": round(score, 6),
        f"{prefix}TargetScore": round(target_score, 6),
        f"{prefix}ConsistencyScore": round(consistency_score, 6),
        f"{prefix}PeakDelayScore": round(peak_delay_score, 6),
        f"{prefix}ContrastScore": round(contrast_score, 6),
        f"{prefix}SegmentAgreement": round(segment_agreement, 6),
        f"{prefix}FootOffsetMedianMs": round(float(median_foot), 3),
        f"{prefix}FootOffsetMadMs": round(float(foot_mad), 3),
        f"{prefix}PeakOffsetMedianMs": round(float(median_peak), 3),
        f"{prefix}RiseMsMedian": round(float(median_rise), 3),
        f"{prefix}Support": int(len(foot_offsets)),
        f"{prefix}SegmentCount": int(len(block_medians)),
    }


def _candidate_onset_features(
    *,
    candidate: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]] | None,
    duration_sec: float,
) -> dict[str, Any]:
    if signal_bundle is None:
        return {
            **_empty_profile("fullFoot"),
            **_empty_profile("lowFoot"),
            "onsetFootScore": 0.0,
            "onsetFootAgreementScore": 0.0,
            "onsetFootSupport": 0,
        }
    full_values, full_rate = signal_bundle["fullAttack"]
    low_values, low_rate = signal_bundle["lowAttack"]
    full = _onset_foot_profile(
        full_values,
        frame_rate=full_rate,
        candidate=candidate,
        duration_sec=duration_sec,
        prefix="fullFoot",
    )
    low = _onset_foot_profile(
        low_values,
        frame_rate=low_rate,
        candidate=candidate,
        duration_sec=duration_sec,
        prefix="lowFoot",
    )
    full_offset = float(full["fullFootFootOffsetMedianMs"])
    low_offset = float(low["lowFootFootOffsetMedianMs"])
    agreement = _clamp01(1.0 - abs(full_offset - low_offset) / 8.0)
    full_score = float(full["fullFootScore"])
    low_score = float(low["lowFootScore"])
    score = _clamp01(full_score * 0.62 + low_score * 0.28 + agreement * 0.10)
    return {
        **full,
        **low,
        "onsetFootScore": round(score, 6),
        "onsetFootAgreementScore": round(agreement, 6),
        "onsetFootSupport": int(full["fullFootSupport"]) + int(low["lowFootSupport"]),
    }


def _track_rows(
    *,
    dataset: str,
    split: str,
    track: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]] | None,
) -> dict[str, Any]:
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    duration_sec = float(_to_float(analysis.get("durationSec")) or 120.0)
    baseline_category = str(((track.get("currentTimeline") or {}).get("category")) or "unknown")
    selected_source = str(analysis.get("gridSolverSelectedSource") or "")
    candidates: list[dict[str, Any]] = []
    for candidate in _evaluated_candidates(track):
        if bool(candidate.get("isLegacy")) or int(candidate["rank"]) > MAX_EVALUATED_RANK:
            continue
        features = _candidate_onset_features(
            candidate=candidate,
            signal_bundle=signal_bundle,
            duration_sec=duration_sec,
        )
        candidates.append(
            {
                "rank": int(candidate["rank"]),
                "category": str(candidate["category"]),
                "isPass": str(candidate["category"]) == "pass",
                "source": str(candidate["source"]),
                "score": float(candidate["score"]),
                "onsetFootScore": float(features["onsetFootScore"]),
                "onsetFootSupport": int(features["onsetFootSupport"]),
                "features": features,
            }
        )
    return {
        "dataset": dataset,
        "split": split,
        "fileName": str(track.get("fileName") or ""),
        "baselineCategory": baseline_category,
        "selectedSource": selected_source,
        "isLegacySelected": "legacy-fallback" in selected_source,
        "candidates": candidates,
    }


def _dataset_report(
    *,
    name: str,
    benchmark_path: Path,
    split_path: Path,
    feature_cache_dir: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    split_map = _split_map(split_path)
    index_map = build_feature_index_map(feature_cache_dir)
    rows: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    for track in _tracks(benchmark_path):
        try:
            signal_bundle = _load_signal_bundle(
                track=track,
                feature_cache_dir=feature_cache_dir,
                index_map=index_map,
            )
        except Exception:
            signal_bundle = None
        if signal_bundle is None:
            skipped["missingFeatureCache"] += 1
        key = benchmark._normalize_lookup_key(track.get("fileName"))
        rows.append(
            _track_rows(
                dataset=name,
                split=split_map.get(key, "unknown"),
                track=track,
                signal_bundle=signal_bundle,
            )
        )
    return rows, {
        "benchmark": str(benchmark_path),
        "splitPath": str(split_path),
        "featureCacheDir": str(feature_cache_dir),
        "trackTotal": len(rows),
        "skipped": dict(skipped),
    }

def _choose_candidate(row: dict[str, Any], *, rank_limit: int, min_support: int) -> dict[str, Any] | None:
    candidates = [
        item
        for item in row["candidates"]
        if int(item["rank"]) <= rank_limit and int(item["onsetFootSupport"]) >= min_support
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda item: (float(item["onsetFootScore"]), -int(item["rank"])))


def _simulate(
    rows: list[dict[str, Any]],
    *,
    rank_limit: int,
    threshold: float,
    min_support: int,
    split: str | None,
    detail_limit: int = 0,
) -> dict[str, Any]:
    scoped = [row for row in rows if split is None or row["split"] == split]
    baseline_pass = 0
    selected_pass = 0
    switch_count = 0
    fail_to_pass = 0
    pass_to_fail = 0
    category_counts: Counter[str] = Counter()
    baseline_counts: Counter[str] = Counter()
    details: list[dict[str, Any]] = []
    for row in scoped:
        baseline_category = str(row["baselineCategory"])
        next_category = baseline_category
        chosen = None
        if bool(row["isLegacySelected"]):
            candidate = _choose_candidate(row, rank_limit=rank_limit, min_support=min_support)
            if candidate is not None and float(candidate["onsetFootScore"]) >= threshold:
                chosen = candidate
                next_category = str(candidate["category"])
                switch_count += 1
        if baseline_category == "pass":
            baseline_pass += 1
        if next_category == "pass":
            selected_pass += 1
        if baseline_category != "pass" and next_category == "pass":
            fail_to_pass += 1
        if baseline_category == "pass" and next_category != "pass":
            pass_to_fail += 1
        baseline_counts[baseline_category] += 1
        category_counts[next_category] += 1
        if chosen is not None and len(details) < detail_limit:
            details.append(
                {
                    "dataset": row["dataset"],
                    "split": row["split"],
                    "fileName": row["fileName"],
                    "baselineCategory": baseline_category,
                    "nextCategory": next_category,
                    "candidateRank": chosen["rank"],
                    "onsetFootScore": chosen["onsetFootScore"],
                    "onsetFootSupport": chosen["onsetFootSupport"],
                    "features": {
                        key: chosen["features"][key]
                        for key in (
                            "fullFootFootOffsetMedianMs",
                            "fullFootFootOffsetMadMs",
                            "fullFootPeakOffsetMedianMs",
                            "lowFootFootOffsetMedianMs",
                            "lowFootFootOffsetMadMs",
                            "onsetFootAgreementScore",
                        )
                    },
                    "source": chosen["source"],
                }
            )
    return {
        "trackTotal": len(scoped),
        "baselinePass": baseline_pass,
        "selectedPass": selected_pass,
        "baselineRate": _rate(baseline_pass, len(scoped)),
        "selectedRate": _rate(selected_pass, len(scoped)),
        "netPassDelta": selected_pass - baseline_pass,
        "failToPass": fail_to_pass,
        "passToFail": pass_to_fail,
        "switchCount": switch_count,
        "baselineCategoryCounts": dict(baseline_counts),
        "selectedCategoryCounts": dict(category_counts),
        "details": details,
    }


def _selection_score(metrics: dict[str, dict[str, Any]]) -> tuple[int, int, int, int, float]:
    current = metrics["current"]
    blind = metrics["blind"]
    current_net = int(current["netPassDelta"])
    blind_net = int(blind["netPassDelta"])
    total_net = current_net + blind_net
    total_hurt = int(current["passToFail"]) + int(blind["passToFail"])
    total_switch = int(current["switchCount"]) + int(blind["switchCount"])
    return (min(current_net, blind_net), total_net, -total_hurt, -total_switch, min(float(current["selectedRate"]), float(blind["selectedRate"])))


def _metrics_for_config(
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    *,
    rank_limit: int,
    threshold: float,
    min_support: int,
    include_details: bool,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for dataset, rows in rows_by_dataset.items():
        result[dataset] = {
            split: _simulate(
                rows,
                rank_limit=rank_limit,
                threshold=threshold,
                min_support=min_support,
                split=split,
                detail_limit=12 if include_details and split == "holdout" else 0,
            )
            for split in ("train", "tune", "holdout")
        }
        result[dataset]["all"] = _simulate(
            rows,
            rank_limit=rank_limit,
            threshold=threshold,
            min_support=min_support,
            split=None,
            detail_limit=20 if include_details else 0,
        )
    return result


def _feature_separation(rows: list[dict[str, Any]], split: str) -> dict[str, Any]:
    pass_scores: list[float] = []
    fail_scores: list[float] = []
    for row in rows:
        if row["split"] != split:
            continue
        for candidate in row["candidates"]:
            if bool(candidate["isPass"]):
                pass_scores.append(float(candidate["onsetFootScore"]))
            else:
                fail_scores.append(float(candidate["onsetFootScore"]))
    return {
        "passCount": len(pass_scores),
        "failCount": len(fail_scores),
        "passMedian": _median(pass_scores),
        "failMedian": _median(fail_scores),
        "passAbove080Rate": _rate(sum(1 for value in pass_scores if value >= 0.80), len(pass_scores)),
        "failAbove080Rate": _rate(sum(1 for value in fail_scores if value >= 0.80), len(fail_scores)),
    }


def _build_output(
    *,
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    metadata_by_dataset: dict[str, dict[str, Any]],
    detail_limit: int,
) -> dict[str, Any]:
    configs: list[dict[str, Any]] = []
    for rank_limit in RANK_LIMITS:
        for min_support in MIN_SUPPORTS:
            for threshold in THRESHOLDS:
                tune_metrics = {
                    dataset: _simulate(
                        rows,
                        rank_limit=rank_limit,
                        threshold=threshold,
                        min_support=min_support,
                        split="tune",
                    )
                    for dataset, rows in rows_by_dataset.items()
                }
                configs.append(
                    {
                        "rankLimit": rank_limit,
                        "minSupport": min_support,
                        "threshold": threshold,
                        "selectionScore": list(_selection_score(tune_metrics)),
                    }
                )
    configs.sort(key=lambda item: tuple(item["selectionScore"]), reverse=True)
    selected = configs[0]
    metrics = _metrics_for_config(
        rows_by_dataset,
        rank_limit=int(selected["rankLimit"]),
        threshold=float(selected["threshold"]),
        min_support=int(selected["minSupport"]),
        include_details=detail_limit > 0,
    )
    top_configs: list[dict[str, Any]] = []
    for item in configs[:12]:
        item_metrics = _metrics_for_config(
            rows_by_dataset,
            rank_limit=int(item["rankLimit"]),
            threshold=float(item["threshold"]),
            min_support=int(item["minSupport"]),
            include_details=False,
        )
        top_configs.append(
            {
                **item,
                "metrics": {
                    dataset: {
                        "tune": item_metrics[dataset]["tune"],
                        "holdout": item_metrics[dataset]["holdout"],
                    }
                    for dataset in DATASET_ORDER
                },
            }
        )
    blockers: list[str] = []
    for dataset in DATASET_ORDER:
        for split in ("tune", "holdout", "all"):
            item = metrics[dataset][split]
            if int(item["passToFail"]) > 0:
                blockers.append(f"{dataset}/{split} pass->fail={item['passToFail']}")
            if int(item["netPassDelta"]) < 0:
                blockers.append(f"{dataset}/{split} net={item['netPassDelta']}")
    holdout_positive = (
        int(metrics["current"]["holdout"]["netPassDelta"]) > 0
        and int(metrics["blind"]["holdout"]["netPassDelta"]) > 0
        and int(metrics["current"]["holdout"]["passToFail"]) == 0
        and int(metrics["blind"]["holdout"]["passToFail"]) == 0
    )
    return {
        "version": VERSION,
        "scope": (
            "Diagnostic only. Onset-foot evidence tests whether candidate grid lines align with the "
            "pre-peak ramp foot in full/low attack envelopes. Truth is used only for offline labels."
        ),
        "leakageControls": {
            "productionSolverModified": False,
            "thresholdSelectionSplits": ["current/tune", "blind/tune"],
            "finalValidationSplits": ["current/holdout", "blind/holdout"],
            "excludedFromScoring": ["fileName", "artist", "title", "path", "truth", "benchmark category", "source one-hot"],
        },
        "datasets": metadata_by_dataset,
        "selectedConfig": selected,
        "metrics": metrics,
        "featureSeparation": {
            dataset: {
                split: _feature_separation(rows_by_dataset[dataset], split)
                for split in ("train", "tune", "holdout")
            }
            for dataset in DATASET_ORDER
        },
        "topConfigsByTune": top_configs,
        "promotionRecommendation": {
            "safeToPromote": holdout_positive and not blockers,
            "holdoutSignalPositive": holdout_positive,
            "blockers": blockers,
        },
    }


def main() -> int:
    _configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Build onset-foot phase evidence diagnostics")
    parser.add_argument("--current-benchmark", default=str(DEFAULT_CURRENT_BENCHMARK))
    parser.add_argument("--current-splits", default=str(DEFAULT_CURRENT_SPLITS))
    parser.add_argument("--current-feature-cache", default=str(DEFAULT_CURRENT_FEATURE_CACHE))
    parser.add_argument("--blind-benchmark", default=str(DEFAULT_BLIND_BENCHMARK))
    parser.add_argument("--blind-splits", default=str(DEFAULT_BLIND_SPLITS))
    parser.add_argument("--blind-feature-cache", default=str(DEFAULT_BLIND_FEATURE_CACHE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--detail-limit", type=int, default=20)
    args = parser.parse_args()

    current_rows, current_metadata = _dataset_report(
        name="current",
        benchmark_path=Path(args.current_benchmark),
        split_path=Path(args.current_splits),
        feature_cache_dir=Path(args.current_feature_cache),
    )
    blind_rows, blind_metadata = _dataset_report(
        name="blind",
        benchmark_path=Path(args.blind_benchmark),
        split_path=Path(args.blind_splits),
        feature_cache_dir=Path(args.blind_feature_cache),
    )
    output = _build_output(
        rows_by_dataset={"current": current_rows, "blind": blind_rows},
        metadata_by_dataset={"current": current_metadata, "blind": blind_metadata},
        detail_limit=int(args.detail_limit),
    )
    output_path = Path(args.output)
    atomic_write_json(output_path, output)
    compact = {
        "output": str(output_path),
        "selectedConfig": output["selectedConfig"],
        "holdout": {
            dataset: output["metrics"][dataset]["holdout"]
            for dataset in DATASET_ORDER
        },
        "safeToPromote": output["promotionRecommendation"]["safeToPromote"],
    }
    print(json.dumps(compact, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
