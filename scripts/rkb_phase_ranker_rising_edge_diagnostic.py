import argparse
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_beatgrid_lab_common import BENCHMARK_OUTPUT_DIR, atomic_write_json, build_feature_index_map
from rkb_onset_foot_phase_diagnostic import _candidate_onset_features
from rkb_phase_ranker_diagnostic import (
    DATASET_ORDER,
    DEFAULT_BLIND_BENCHMARK,
    DEFAULT_BLIND_FEATURE_CACHE,
    DEFAULT_BLIND_SPLITS,
    DEFAULT_CURRENT_BENCHMARK,
    DEFAULT_CURRENT_FEATURE_CACHE,
    DEFAULT_CURRENT_SPLITS,
    L2_GRID,
    THRESHOLD_GRID,
    _candidate_examples,
    _candidate_probability_summary,
    _configure_utf8_stdio,
    _evaluated_candidates,
    _feature_vector,
    _is_legacy_source,
    _load_signal_bundle,
    _safe_float,
    _score_config_for_tune,
    _score_rows,
    _selected_profile,
    _signal_profiles,
    _split_map,
    _tracks,
    _train_logistic_regression,
)

VERSION = "rkb-phase-ranker-rising-edge-diagnostic-v1"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "phase-ranker-rising-edge-diagnostic-latest.json"
RANK_LIMIT = 16
RISING_FEATURE_KEYS = (
    "risingEdgeScore",
    "risingEdgeAgreementScore",
    "fullRiseScore",
    "fullRiseTarget0Score",
    "fullRiseTargetPos8Score",
    "fullRiseTargetNeg8Score",
    "fullRiseConsistencyScore",
    "fullRisePeakOffsetMedianMs",
    "fullRisePeakOffsetMadMs",
    "fullRisePeakAmplitudeMean",
    "fullRiseSupport",
    "lowRiseScore",
    "lowRiseTarget0Score",
    "lowRiseTargetPos8Score",
    "lowRiseTargetNeg8Score",
    "lowRiseConsistencyScore",
    "lowRisePeakOffsetMedianMs",
    "lowRisePeakOffsetMadMs",
    "lowRisePeakAmplitudeMean",
    "lowRiseSupport",
)
RISING_MODE_CONFIGS = (
    {"name": "top-new", "rankLimit": 1, "requireSameMod4": False},
    {"name": "ranked-top16", "rankLimit": 16, "requireSameMod4": False},
    {"name": "top-new-same-mod4", "rankLimit": 1, "requireSameMod4": True},
    {"name": "ranked-top16-same-mod4", "rankLimit": 16, "requireSameMod4": True},
)


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))


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


def _grid_times_for_candidate(candidate: dict[str, Any], duration_sec: float, limit: int = 64) -> np.ndarray:
    bpm = _safe_float(candidate.get("bpm"))
    first_beat_ms = _safe_float(candidate.get("firstBeatMs"))
    if bpm <= 0.0 or duration_sec <= 0.0:
        return np.asarray([], dtype="float64")
    interval_sec = 60.0 / bpm
    start_sec = first_beat_ms / 1000.0
    values: list[float] = []
    index = 0
    while len(values) < limit:
        time_sec = start_sec + float(index) * interval_sec
        if time_sec > min(duration_sec, 120.0):
            break
        if time_sec >= 0.0:
            values.append(time_sec)
        index += 1
    return np.asarray(values, dtype="float64")


def _empty_rise_profile(prefix: str) -> dict[str, Any]:
    return {
        f"{prefix}Score": 0.0,
        f"{prefix}Target0Score": 0.0,
        f"{prefix}TargetPos8Score": 0.0,
        f"{prefix}TargetNeg8Score": 0.0,
        f"{prefix}ConsistencyScore": 0.0,
        f"{prefix}PeakOffsetMedianMs": 999.0,
        f"{prefix}PeakOffsetMadMs": 999.0,
        f"{prefix}PeakAmplitudeMean": 0.0,
        f"{prefix}Support": 0,
    }


def _rise_profile(
    values: np.ndarray,
    *,
    frame_rate: float,
    candidate: dict[str, Any],
    duration_sec: float,
    prefix: str,
) -> dict[str, Any]:
    if values.size < 16 or frame_rate <= 0.0:
        return _empty_rise_profile(prefix)
    times_sec = _grid_times_for_candidate(candidate, duration_sec)
    if times_sec.size < 8:
        return _empty_rise_profile(prefix)

    derivative = np.diff(values.astype("float64", copy=False), prepend=float(values[0]))
    derivative = np.maximum(derivative, 0.0)
    offset_step_ms = max(1.0, 1000.0 / frame_rate)
    offset_ms = np.arange(-40.0, 50.0 + 0.001, offset_step_ms, dtype="float64")
    offset_samples = np.rint(offset_ms * frame_rate / 1000.0).astype("int64", copy=False)
    keep = np.unique(offset_samples, return_index=True)[1]
    keep.sort()
    offset_ms = offset_ms[keep]
    offset_samples = offset_samples[keep]
    if offset_samples.size < 8:
        return _empty_rise_profile(prefix)

    positions = np.rint(times_sec * frame_rate).astype("int64", copy=False)
    indices = positions[:, None] + offset_samples[None, :]
    valid = (indices >= 0) & (indices < derivative.size)
    if not bool(np.any(valid)):
        return _empty_rise_profile(prefix)
    clipped = np.clip(indices, 0, max(0, derivative.size - 1))
    sampled = derivative[clipped].astype("float64", copy=False)
    sampled = np.where(valid, sampled, np.nan)

    peak_offsets: list[float] = []
    peak_amplitudes: list[float] = []
    for row in sampled:
        finite = np.isfinite(row)
        if int(np.count_nonzero(finite)) < 8:
            continue
        peak_value = float(np.nanmax(row))
        if not math.isfinite(peak_value) or peak_value <= 1e-8:
            continue
        peak_index = int(np.nanargmax(row))
        peak_offsets.append(float(offset_ms[peak_index]))
        peak_amplitudes.append(peak_value)

    if len(peak_offsets) < 8:
        return _empty_rise_profile(prefix)
    offset_array = np.asarray(peak_offsets, dtype="float64")
    amplitude_array = np.asarray(peak_amplitudes, dtype="float64")
    median_offset = _weighted_median(offset_array, amplitude_array)
    if median_offset is None:
        return _empty_rise_profile(prefix)
    offset_mad = _weighted_median(np.abs(offset_array - median_offset), amplitude_array)
    if offset_mad is None:
        offset_mad = 999.0

    target0 = _clamp01(1.0 - abs(float(median_offset)) / 10.0)
    target_pos8 = _clamp01(1.0 - abs(float(median_offset) - 8.0) / 12.0)
    target_neg8 = _clamp01(1.0 - abs(float(median_offset) + 8.0) / 12.0)
    consistency = _clamp01(1.0 - float(offset_mad) / 12.0)
    amp_mean = float(np.mean(amplitude_array))
    amp_score = _clamp01(amp_mean * 400.0)
    score = _clamp01(target_pos8 * 0.42 + target0 * 0.22 + consistency * 0.24 + amp_score * 0.12)
    return {
        f"{prefix}Score": round(score, 6),
        f"{prefix}Target0Score": round(target0, 6),
        f"{prefix}TargetPos8Score": round(target_pos8, 6),
        f"{prefix}TargetNeg8Score": round(target_neg8, 6),
        f"{prefix}ConsistencyScore": round(consistency, 6),
        f"{prefix}PeakOffsetMedianMs": round(float(median_offset), 3),
        f"{prefix}PeakOffsetMadMs": round(float(offset_mad), 3),
        f"{prefix}PeakAmplitudeMean": round(amp_mean, 9),
        f"{prefix}Support": int(len(peak_offsets)),
    }


def _candidate_rising_edge_features(
    *,
    candidate: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]] | None,
    duration_sec: float,
) -> dict[str, Any]:
    if signal_bundle is None:
        return {
            **_empty_rise_profile("fullRise"),
            **_empty_rise_profile("lowRise"),
            "risingEdgeScore": 0.0,
            "risingEdgeAgreementScore": 0.0,
        }
    full_values, full_rate = signal_bundle["fullAttack"]
    low_values, low_rate = signal_bundle["lowAttack"]
    full = _rise_profile(
        full_values,
        frame_rate=full_rate,
        candidate=candidate,
        duration_sec=duration_sec,
        prefix="fullRise",
    )
    low = _rise_profile(
        low_values,
        frame_rate=low_rate,
        candidate=candidate,
        duration_sec=duration_sec,
        prefix="lowRise",
    )
    full_score = _safe_float(full.get("fullRiseScore"))
    low_score = _safe_float(low.get("lowRiseScore"))
    agreement = _clamp01(
        1.0
        - abs(_safe_float(full.get("fullRisePeakOffsetMedianMs")) - _safe_float(low.get("lowRisePeakOffsetMedianMs")))
        / 16.0
    )
    return {
        **full,
        **low,
        "risingEdgeScore": round(_clamp01(full_score * 0.62 + low_score * 0.26 + agreement * 0.12), 6),
        "risingEdgeAgreementScore": round(agreement, 6),
    }


def _feature_value(candidate: dict[str, Any], key: str) -> float:
    features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    return _safe_float(features.get(key))


def _feature_vector_with_rising_edge(
    *,
    candidate: dict[str, Any],
    selected: dict[str, Any],
    candidate_profiles: dict[str, dict[str, Any]],
) -> tuple[list[float], list[str]]:
    values, names = _feature_vector(candidate=candidate, selected=selected, candidate_profiles=candidate_profiles)
    for key in RISING_FEATURE_KEYS:
        candidate_value = _feature_value(candidate, key)
        selected_value = _feature_value(selected, key)
        values.append(candidate_value)
        names.append(f"candidate.{key}")
        values.append(candidate_value - selected_value)
        names.append(f"delta.{key}")
    return values, names


def _track_row(
    *,
    dataset: str,
    split: str,
    track: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]] | None,
    max_rank: int,
) -> dict[str, Any]:
    selected = _selected_profile(track, signal_bundle)
    candidates = _evaluated_candidates(track)
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    duration_sec = _safe_float(analysis.get("durationSec"), 120.0)
    candidate_rows: list[dict[str, Any]] = []
    feature_names: list[str] | None = None
    for candidate in candidates:
        if bool(candidate.get("isLegacy")) or int(candidate["rank"]) > max_rank:
            continue
        onset_features = _candidate_onset_features(
            candidate=candidate,
            signal_bundle=signal_bundle,
            duration_sec=duration_sec,
        )
        rising_features = _candidate_rising_edge_features(
            candidate=candidate,
            signal_bundle=signal_bundle,
            duration_sec=duration_sec,
        )
        candidate = {
            **candidate,
            "features": {**dict(candidate.get("features") or {}), **onset_features, **rising_features},
        }
        profiles = _signal_profiles(candidate=candidate, signal_bundle=signal_bundle, duration_sec=duration_sec)
        vector, names = _feature_vector_with_rising_edge(
            candidate=candidate,
            selected=selected,
            candidate_profiles=profiles,
        )
        if feature_names is None:
            feature_names = names
        candidate_rows.append(
            {
                "rank": int(candidate["rank"]),
                "category": str(candidate["category"]),
                "isPass": str(candidate["category"]) == "pass",
                "score": float(candidate["score"]),
                "source": str(candidate["source"]),
                "barBeatOffsetSameMod4": int(candidate["barBeatOffset"]) % 4 == int(selected["barBeatOffset"]) % 4,
                "barBeatOffsetSameExact32": int(candidate["barBeatOffset"]) % 32 == int(selected["barBeatOffset"]) % 32,
                "featureVector": vector,
            }
        )
    return {
        "dataset": dataset,
        "split": split,
        "fileName": str(track.get("fileName") or ""),
        "baselineCategory": str(selected["category"]),
        "selectedSource": str(selected["source"]),
        "isLegacySelected": _is_legacy_source(str(selected["source"])),
        "candidates": candidate_rows,
        "featureNames": feature_names or [],
    }


def _dataset_rows(
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
        signal_bundle = _load_signal_bundle(track=track, feature_cache_dir=feature_cache_dir, index_map=index_map)
        if signal_bundle is None:
            skipped["missingFeatureCache"] += 1
        split = split_map.get(benchmark._normalize_lookup_key(track.get("fileName")), "unknown")
        rows.append(
            _track_row(
                dataset=name,
                split=split,
                track=track,
                signal_bundle=signal_bundle,
                max_rank=RANK_LIMIT,
            )
        )
    return rows, {
        "benchmark": str(benchmark_path),
        "splitPath": str(split_path),
        "featureCacheDir": str(feature_cache_dir),
        "trackTotal": len(rows),
        "skipped": dict(skipped),
    }


def _top_weights(model: dict[str, Any], feature_names: list[str], limit: int = 24) -> list[dict[str, Any]]:
    weights = np.asarray(model.get("weights"), dtype="float64")
    ranked = sorted(
        [
            {
                "feature": feature_names[index] if index < len(feature_names) else f"feature{index}",
                "weight": round(float(weight), 6),
            }
            for index, weight in enumerate(weights)
        ],
        key=lambda item: abs(float(item["weight"])),
        reverse=True,
    )
    return ranked[:limit]


def _choose_candidate(
    row: dict[str, Any],
    *,
    mode: str,
    rank_limit: int,
    require_same_mod4: bool,
) -> dict[str, Any] | None:
    candidates = [candidate for candidate in row["candidates"] if int(candidate["rank"]) <= rank_limit]
    if require_same_mod4:
        candidates = [candidate for candidate in candidates if bool(candidate.get("barBeatOffsetSameMod4"))]
    if not candidates:
        return None
    if mode.startswith("top-new"):
        return min(candidates, key=lambda item: int(item["rank"]))
    return max(candidates, key=lambda item: (float(item.get("rankerProbability") or 0.0), -int(item["rank"])))


def _simulate(
    rows: list[dict[str, Any]],
    *,
    mode: str,
    rank_limit: int,
    threshold: float,
    require_same_mod4: bool,
    splits: set[str] | None = None,
    detail_limit: int = 0,
) -> dict[str, Any]:
    selected_pass = 0
    baseline_pass = 0
    switch_count = 0
    fail_to_pass = 0
    pass_to_fail = 0
    category_counts: Counter[str] = Counter()
    baseline_counts: Counter[str] = Counter()
    details: list[dict[str, Any]] = []
    scoped_rows = [row for row in rows if splits is None or row["split"] in splits]
    for row in scoped_rows:
        baseline_category = str(row["baselineCategory"])
        next_category = baseline_category
        chosen = None
        if bool(row["isLegacySelected"]):
            candidate = _choose_candidate(
                row,
                mode=mode,
                rank_limit=rank_limit,
                require_same_mod4=require_same_mod4,
            )
            if candidate is not None and float(candidate.get("rankerProbability") or 0.0) >= threshold:
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
                    "rankerProbability": chosen.get("rankerProbability"),
                    "barBeatOffsetSameMod4": chosen.get("barBeatOffsetSameMod4"),
                    "barBeatOffsetSameExact32": chosen.get("barBeatOffsetSameExact32"),
                    "source": chosen.get("source"),
                }
            )
    total = len(scoped_rows)
    return {
        "trackTotal": total,
        "baselinePass": baseline_pass,
        "selectedPass": selected_pass,
        "baselineRate": round(baseline_pass / total, 6) if total else 0.0,
        "selectedRate": round(selected_pass / total, 6) if total else 0.0,
        "netPassDelta": selected_pass - baseline_pass,
        "failToPass": fail_to_pass,
        "passToFail": pass_to_fail,
        "switchCount": switch_count,
        "baselineCategoryCounts": dict(baseline_counts),
        "selectedCategoryCounts": dict(category_counts),
        "details": details,
    }


def _split_metrics_for_config(
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    *,
    mode: str,
    rank_limit: int,
    threshold: float,
    require_same_mod4: bool,
    include_details: bool,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for dataset, rows in rows_by_dataset.items():
        dataset_result: dict[str, Any] = {}
        for split in ("train", "tune", "holdout"):
            dataset_result[split] = _simulate(
                rows,
                mode=mode,
                rank_limit=rank_limit,
                threshold=threshold,
                require_same_mod4=require_same_mod4,
                splits={split},
                detail_limit=12 if include_details and split == "holdout" else 0,
            )
        dataset_result["all"] = _simulate(
            rows,
            mode=mode,
            rank_limit=rank_limit,
            threshold=threshold,
            require_same_mod4=require_same_mod4,
            splits=None,
            detail_limit=20 if include_details else 0,
        )
        result[dataset] = dataset_result
    return result


def _build_report(
    *,
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    metadata_by_dataset: dict[str, dict[str, Any]],
    feature_names: list[str],
    detail_limit: int,
) -> dict[str, Any]:
    train_rows = rows_by_dataset["current"] + rows_by_dataset["blind"]
    X_train, y_train = _candidate_examples(train_rows, {"train"})
    if X_train.size == 0:
        raise RuntimeError("no train candidate examples")

    configs: list[dict[str, Any]] = []
    for l2 in L2_GRID:
        model = _train_logistic_regression(X_train, y_train, l2=float(l2))
        for rows in rows_by_dataset.values():
            _score_rows(rows, model)
        for mode_config in RISING_MODE_CONFIGS:
            mode = str(mode_config["name"])
            rank_limit = int(mode_config["rankLimit"])
            require_same_mod4 = bool(mode_config.get("requireSameMod4"))
            for threshold in THRESHOLD_GRID:
                tune_metrics = {
                    dataset: _simulate(
                        rows,
                        mode=mode,
                        rank_limit=rank_limit,
                        threshold=float(threshold),
                        require_same_mod4=require_same_mod4,
                        splits={"tune"},
                    )
                    for dataset, rows in rows_by_dataset.items()
                }
                configs.append(
                    {
                        "l2": float(l2),
                        "mode": mode,
                        "rankLimit": rank_limit,
                        "requireSameMod4": require_same_mod4,
                        "threshold": float(threshold),
                        "tuneMetrics": tune_metrics,
                        "selectionScore": list(_score_config_for_tune(tune_metrics)),
                        "model": model,
                    }
                )

    configs.sort(key=lambda item: tuple(item["selectionScore"]), reverse=True)
    selected = configs[0]
    model = selected["model"]
    for rows in rows_by_dataset.values():
        _score_rows(rows, model)
    metrics = _split_metrics_for_config(
        rows_by_dataset,
        mode=str(selected["mode"]),
        rank_limit=int(selected["rankLimit"]),
        threshold=float(selected["threshold"]),
        require_same_mod4=bool(selected["requireSameMod4"]),
        include_details=detail_limit > 0,
    )
    top_configs: list[dict[str, Any]] = []
    for config in configs[:12]:
        config_model = config["model"]
        for rows in rows_by_dataset.values():
            _score_rows(rows, config_model)
        top_configs.append(
            {
                "l2": config["l2"],
                "mode": config["mode"],
                "rankLimit": config["rankLimit"],
                "requireSameMod4": config["requireSameMod4"],
                "threshold": config["threshold"],
                "selectionScore": config["selectionScore"],
                "metrics": _split_metrics_for_config(
                    rows_by_dataset,
                    mode=str(config["mode"]),
                    rank_limit=int(config["rankLimit"]),
                    threshold=float(config["threshold"]),
                    require_same_mod4=bool(config["requireSameMod4"]),
                    include_details=False,
                ),
            }
        )
    for rows in rows_by_dataset.values():
        _score_rows(rows, model)

    blockers: list[str] = []
    for dataset in DATASET_ORDER:
        for split in ("tune", "holdout", "all"):
            item = metrics[dataset][split]
            if int(item["passToFail"]) > 0:
                blockers.append(f"{dataset}/{split} pass->fail={item['passToFail']}")
            if int(item["netPassDelta"]) < 0:
                blockers.append(f"{dataset}/{split} net={item['netPassDelta']}")

    return {
        "version": VERSION,
        "scope": (
            "Diagnostic only. Rising-edge derivative features were explored after inspecting existing "
            "current/blind reports, so any positive replay is a post-hoc hypothesis requiring fresh truth."
        ),
        "leakageControls": {
            "excludedFromFeatures": [
                "fileName",
                "artist",
                "title",
                "path",
                "split identity",
                "truth values",
                "benchmark category",
                "firstBeatPhaseErrorMs",
                "source string one-hot",
            ],
            "addedFeatureFamily": list(RISING_FEATURE_KEYS),
            "trainSplits": ["current/train", "blind/train"],
            "modelSelectionSplits": ["current/tune", "blind/tune"],
            "finalValidationSplits": ["current/holdout", "blind/holdout"],
            "productionSolverModified": False,
        },
        "training": {
            "featureCount": int(X_train.shape[1]),
            "featureNames": feature_names,
            "trainExamples": int(X_train.shape[0]),
            "trainPositiveCount": int(np.sum(y_train)),
            "trainPositiveRate": round(float(np.mean(y_train)), 6),
        },
        "datasets": metadata_by_dataset,
        "selectedConfig": {
            "l2": selected["l2"],
            "mode": selected["mode"],
            "rankLimit": selected["rankLimit"],
            "requireSameMod4": selected["requireSameMod4"],
            "threshold": selected["threshold"],
            "selectionRule": (
                "Prefer zero tune pass->fail, then maximize min(current tune net, blind tune net), "
                "then lower switch count, then total tune net."
            ),
            "selectionScore": selected["selectionScore"],
            "topWeights": _top_weights(model, feature_names),
        },
        "probabilitySummary": {
            dataset: {
                split: _candidate_probability_summary(
                    [row for row in rows_by_dataset[dataset] if row["split"] == split]
                )
                for split in ("train", "tune", "holdout")
            }
            for dataset in DATASET_ORDER
        },
        "metrics": metrics,
        "topConfigsByTune": top_configs,
        "promotionRecommendation": {
            "safeToPromoteFromThisDiagnostic": False,
            "diagnosticHasNoMeasuredRegression": not blockers,
            "blockers": blockers,
            "reason": "rising-edge feature family was introduced after existing reports; requires fresh-truth replay",
        },
    }


def _load_rows(args: argparse.Namespace) -> tuple[dict[str, list[dict[str, Any]]], dict[str, dict[str, Any]]]:
    current_rows, current_metadata = _dataset_rows(
        name="current",
        benchmark_path=Path(args.current_benchmark),
        split_path=Path(args.current_splits),
        feature_cache_dir=Path(args.current_feature_cache),
    )
    blind_rows, blind_metadata = _dataset_rows(
        name="blind",
        benchmark_path=Path(args.blind_benchmark),
        split_path=Path(args.blind_splits),
        feature_cache_dir=Path(args.blind_feature_cache),
    )
    return (
        {"current": current_rows, "blind": blind_rows},
        {"current": current_metadata, "blind": blind_metadata},
    )


def main() -> int:
    _configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Diagnose rising-edge derivative features for phase ranking")
    parser.add_argument("--current-benchmark", default=str(DEFAULT_CURRENT_BENCHMARK))
    parser.add_argument("--current-splits", default=str(DEFAULT_CURRENT_SPLITS))
    parser.add_argument("--current-feature-cache", default=str(DEFAULT_CURRENT_FEATURE_CACHE))
    parser.add_argument("--blind-benchmark", default=str(DEFAULT_BLIND_BENCHMARK))
    parser.add_argument("--blind-splits", default=str(DEFAULT_BLIND_SPLITS))
    parser.add_argument("--blind-feature-cache", default=str(DEFAULT_BLIND_FEATURE_CACHE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--detail-limit", type=int, default=20)
    args = parser.parse_args()

    rows_by_dataset, metadata_by_dataset = _load_rows(args)
    feature_names: list[str] = []
    for rows in rows_by_dataset.values():
        for row in rows:
            names = row.get("featureNames")
            if isinstance(names, list) and names:
                feature_names = [str(item) for item in names]
                break
        if feature_names:
            break
    report = _build_report(
        rows_by_dataset=rows_by_dataset,
        metadata_by_dataset=metadata_by_dataset,
        feature_names=feature_names,
        detail_limit=int(args.detail_limit),
    )
    output_path = Path(args.output)
    atomic_write_json(output_path, report)
    compact = {
        "output": str(output_path),
        "selectedConfig": report["selectedConfig"],
        "holdout": {dataset: report["metrics"][dataset]["holdout"] for dataset in DATASET_ORDER},
        "all": {dataset: report["metrics"][dataset]["all"] for dataset in DATASET_ORDER},
        "promotion": report["promotionRecommendation"],
    }
    print(json.dumps(compact, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
