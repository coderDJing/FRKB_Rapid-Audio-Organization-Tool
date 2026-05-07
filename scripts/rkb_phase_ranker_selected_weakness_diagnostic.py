import argparse
import json
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
    MODE_CONFIGS,
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
    _simulate,
    _split_map,
    _split_metrics_for_config,
    _tracks,
    _train_logistic_regression,
)

VERSION = "rkb-phase-ranker-selected-weakness-diagnostic-v1"
DEFAULT_CURRENT_FEATURE_CACHE = BENCHMARK_OUTPUT_DIR / "feature-cache"
DEFAULT_BLIND_ROOT = BENCHMARK_OUTPUT_DIR / "blind-rekordbox-truth"
DEFAULT_BLIND_FEATURE_CACHE = DEFAULT_BLIND_ROOT / "feature-cache"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "phase-ranker-selected-weakness-diagnostic-latest.json"

SELECTED_WEAKNESS_KEYS = (
    "anchorConfidenceScore",
    "beatThisEstimatedDrift128Ms",
    "constantGridDpConfidence",
    "constantGridDpLegacyWeaknessScore",
    "constantGridDpPhaseEvidenceSwitchScore",
    "constantGridDpPhaseEvidenceRank",
    "constantGridDpUsedNewCandidate",
    "legacyGridSolverScore",
)


def _feature_value(candidate: dict[str, Any], key: str) -> float:
    features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    return _safe_float(features.get(key))


def _feature_vector_with_selected_weakness(
    *,
    candidate: dict[str, Any],
    selected: dict[str, Any],
    candidate_profiles: dict[str, dict[str, Any]],
) -> tuple[list[float], list[str]]:
    values, names = _feature_vector(
        candidate=candidate,
        selected=selected,
        candidate_profiles=candidate_profiles,
    )
    for key in SELECTED_WEAKNESS_KEYS:
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
        candidate = {
            **candidate,
            "features": {**dict(candidate.get("features") or {}), **onset_features},
        }
        profiles = _signal_profiles(candidate=candidate, signal_bundle=signal_bundle, duration_sec=duration_sec)
        vector, names = _feature_vector_with_selected_weakness(
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
    max_rank: int,
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
                max_rank=max_rank,
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
        for mode_config in MODE_CONFIGS:
            mode = str(mode_config["name"])
            rank_limit = int(mode_config["rankLimit"])
            for threshold in THRESHOLD_GRID:
                tune_metrics = {
                    dataset: _simulate(
                        rows,
                        mode=mode,
                        rank_limit=rank_limit,
                        threshold=float(threshold),
                        splits={"tune"},
                    )
                    for dataset, rows in rows_by_dataset.items()
                }
                configs.append(
                    {
                        "l2": float(l2),
                        "mode": mode,
                        "rankLimit": rank_limit,
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
        include_details=detail_limit > 0,
    )

    top_configs: list[dict[str, Any]] = []
    for config in configs[:12]:
        config_model = config["model"]
        for rows in rows_by_dataset.values():
            _score_rows(rows, config_model)
        config_metrics = _split_metrics_for_config(
            rows_by_dataset,
            mode=str(config["mode"]),
            rank_limit=int(config["rankLimit"]),
            threshold=float(config["threshold"]),
            include_details=False,
        )
        top_configs.append(
            {
                "l2": config["l2"],
                "mode": config["mode"],
                "rankLimit": config["rankLimit"],
                "threshold": config["threshold"],
                "selectionScore": config["selectionScore"],
                "metrics": config_metrics,
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
            "Diagnostic only. Adds selected legacy/anchor numeric weakness features to the same "
            "phase-ranker protocol. This is not production evidence and must be retested on fresh truth."
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
            "addedFeatureFamily": list(SELECTED_WEAKNESS_KEYS),
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
            "reason": "current/blind have already been inspected; requires locked fresh-truth replay",
        },
    }


def _load_rows(args: argparse.Namespace) -> tuple[dict[str, list[dict[str, Any]]], dict[str, dict[str, Any]]]:
    current_rows, current_metadata = _dataset_rows(
        name="current",
        benchmark_path=Path(args.current_benchmark),
        split_path=Path(args.current_splits),
        feature_cache_dir=Path(args.current_feature_cache),
        max_rank=16,
    )
    blind_rows, blind_metadata = _dataset_rows(
        name="blind",
        benchmark_path=Path(args.blind_benchmark),
        split_path=Path(args.blind_splits),
        feature_cache_dir=Path(args.blind_feature_cache),
        max_rank=16,
    )
    return (
        {"current": current_rows, "blind": blind_rows},
        {"current": current_metadata, "blind": blind_metadata},
    )


def main() -> int:
    _configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Diagnose selected-weakness features for the phase ranker")
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
        "promotion": report["promotionRecommendation"],
    }
    print(json.dumps(compact, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
