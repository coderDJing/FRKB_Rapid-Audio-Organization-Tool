import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

from rkb_beatgrid_lab_common import BENCHMARK_OUTPUT_DIR, atomic_write_json
from rkb_phase_ranker_diagnostic import (
    DEFAULT_BLIND_BENCHMARK,
    DEFAULT_BLIND_FEATURE_CACHE,
    DEFAULT_BLIND_SPLITS,
    DEFAULT_CURRENT_BENCHMARK,
    DEFAULT_CURRENT_FEATURE_CACHE,
    DEFAULT_CURRENT_SPLITS,
    _candidate_examples,
    _candidate_probability_summary,
    _configure_utf8_stdio,
    _score_rows,
    _train_logistic_regression,
)
from rkb_phase_ranker_rising_edge_diagnostic import (
    RANK_LIMIT,
    _dataset_rows,
    _load_signal_bundle,
    _split_metrics_for_config,
    _track_row,
    _tracks,
)
from rkb_beatgrid_lab_common import build_feature_index_map

VERSION = "rkb-phase-ranker-rising-edge-posthoc-locked-replay-v1"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "phase-ranker-rising-edge-locked-replay-latest.json"
LOCKED_CONFIG = {
    "l2": 0.3,
    "mode": "ranked-top16",
    "rankLimit": 16,
    "requireSameMod4": False,
    "threshold": 0.93,
}


def _sealed_dataset_rows(
    *,
    name: str,
    benchmark_path: Path,
    feature_cache_dir: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    index_map = build_feature_index_map(feature_cache_dir)
    rows: list[dict[str, Any]] = []
    skipped = 0
    for track in _tracks(benchmark_path):
        signal_bundle = _load_signal_bundle(track=track, feature_cache_dir=feature_cache_dir, index_map=index_map)
        if signal_bundle is None:
            skipped += 1
        rows.append(
            _track_row(
                dataset=name,
                split="holdout",
                track=track,
                signal_bundle=signal_bundle,
                max_rank=RANK_LIMIT,
            )
        )
    return rows, {
        "benchmark": str(benchmark_path),
        "splitPath": None,
        "featureCacheDir": str(feature_cache_dir),
        "trackTotal": len(rows),
        "skipped": {"missingFeatureCache": skipped} if skipped else {},
        "splitPolicy": "sealed-eval all tracks treated as holdout; never used for training or threshold selection",
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
        _append_sealed_rows(
            args,
            {"current": current_rows, "blind": blind_rows},
            {"current": current_metadata, "blind": blind_metadata},
        )
    )


def _append_sealed_rows(
    args: argparse.Namespace,
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    metadata_by_dataset: dict[str, dict[str, Any]],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, dict[str, Any]]]:
    sealed_benchmark = str(args.sealed_benchmark or "").strip()
    if not sealed_benchmark:
        return rows_by_dataset, metadata_by_dataset
    sealed_name = str(args.sealed_name or "sealed-eval").strip() or "sealed-eval"
    sealed_feature_cache = str(args.sealed_feature_cache or "").strip()
    if not sealed_feature_cache:
        raise SystemExit("--sealed-feature-cache is required when --sealed-benchmark is provided")
    sealed_rows, sealed_metadata = _sealed_dataset_rows(
        name=sealed_name,
        benchmark_path=Path(sealed_benchmark),
        feature_cache_dir=Path(sealed_feature_cache),
    )
    return (
        {**rows_by_dataset, sealed_name: sealed_rows},
        {**metadata_by_dataset, sealed_name: sealed_metadata},
    )


def _promotion_blockers(metrics: dict[str, dict[str, Any]]) -> list[str]:
    blockers: list[str] = []
    for dataset in metrics:
        for split in ("tune", "holdout", "all"):
            item = metrics[dataset][split]
            if int(item["passToFail"]) > 0:
                blockers.append(f"{dataset}/{split} pass->fail={item['passToFail']}")
            if int(item["netPassDelta"]) < 0:
                blockers.append(f"{dataset}/{split} net={item['netPassDelta']}")
    return blockers


def _build_report(
    *,
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    metadata_by_dataset: dict[str, dict[str, Any]],
    detail_limit: int,
) -> dict[str, Any]:
    train_rows = rows_by_dataset["current"] + rows_by_dataset["blind"]
    X_train, y_train = _candidate_examples(train_rows, {"train"})
    model = _train_logistic_regression(X_train, y_train, l2=float(LOCKED_CONFIG["l2"]))
    for rows in rows_by_dataset.values():
        _score_rows(rows, model)
    metrics = _split_metrics_for_config(
        rows_by_dataset,
        mode=str(LOCKED_CONFIG["mode"]),
        rank_limit=int(LOCKED_CONFIG["rankLimit"]),
        threshold=float(LOCKED_CONFIG["threshold"]),
        require_same_mod4=bool(LOCKED_CONFIG["requireSameMod4"]),
        include_details=detail_limit > 0,
    )
    blockers = _promotion_blockers(metrics)
    return {
        "version": VERSION,
        "scope": (
            "Replay of a post-hoc contaminated rising-edge phase-ranker hypothesis. The locked "
            "config was selected after viewing current/blind diagnostic reports, so this replay "
            "is only a future-data hypothesis and is not fresh promotion evidence."
        ),
        "lockedConfig": LOCKED_CONFIG,
        "datasets": metadata_by_dataset,
        "training": {
            "trainExamples": int(X_train.shape[0]),
            "trainPositiveCount": int(np.sum(y_train)),
            "trainPositiveRate": round(float(np.mean(y_train)), 6) if X_train.size else 0.0,
        },
        "metrics": metrics,
        "probabilitySummary": {
            dataset: {
                split: _candidate_probability_summary([row for row in rows_by_dataset[dataset] if row["split"] == split])
                for split in ("train", "tune", "holdout")
            }
            for dataset in rows_by_dataset
        },
        "promotionRecommendation": {
            "safeToPromoteFromThisReplay": False,
            "replayHasNoMeasuredRegression": not blockers,
            "blockers": blockers,
            "freshEvidenceDatasets": [
                dataset for dataset in rows_by_dataset if dataset not in {"current", "blind"}
            ],
            "reason": (
                "this script never auto-promotes; current/blind replay is contaminated, and any sealed "
                "dataset result still requires explicit review against the locked acceptance rules"
            ),
        },
    }


def main() -> int:
    _configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Replay the post-hoc locked rising-edge ranker hypothesis")
    parser.add_argument("--current-benchmark", default=str(DEFAULT_CURRENT_BENCHMARK))
    parser.add_argument("--current-splits", default=str(DEFAULT_CURRENT_SPLITS))
    parser.add_argument("--current-feature-cache", default=str(DEFAULT_CURRENT_FEATURE_CACHE))
    parser.add_argument("--blind-benchmark", default=str(DEFAULT_BLIND_BENCHMARK))
    parser.add_argument("--blind-splits", default=str(DEFAULT_BLIND_SPLITS))
    parser.add_argument("--blind-feature-cache", default=str(DEFAULT_BLIND_FEATURE_CACHE))
    parser.add_argument("--sealed-name", default="sealed-eval")
    parser.add_argument("--sealed-benchmark", default="")
    parser.add_argument("--sealed-feature-cache", default="")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--detail-limit", type=int, default=20)
    args = parser.parse_args()

    rows_by_dataset, metadata_by_dataset = _load_rows(args)
    report = _build_report(
        rows_by_dataset=rows_by_dataset,
        metadata_by_dataset=metadata_by_dataset,
        detail_limit=int(args.detail_limit),
    )
    output_path = Path(args.output)
    atomic_write_json(output_path, report)
    compact = {
        "output": str(output_path),
        "lockedConfig": LOCKED_CONFIG,
        "holdout": {dataset: report["metrics"][dataset]["holdout"] for dataset in report["metrics"]},
        "all": {dataset: report["metrics"][dataset]["all"] for dataset in report["metrics"]},
        "promotion": report["promotionRecommendation"],
    }
    print(json.dumps(compact, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
