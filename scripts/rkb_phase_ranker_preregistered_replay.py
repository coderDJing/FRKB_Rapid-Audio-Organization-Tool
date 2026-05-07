import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

from rkb_beatgrid_lab_common import BENCHMARK_OUTPUT_DIR, atomic_write_json
from rkb_phase_ranker_diagnostic import (
    DATASET_ORDER,
    DEFAULT_BLIND_BENCHMARK,
    DEFAULT_BLIND_FEATURE_CACHE,
    DEFAULT_BLIND_SPLITS,
    DEFAULT_CURRENT_BENCHMARK,
    DEFAULT_CURRENT_FEATURE_CACHE,
    DEFAULT_CURRENT_SPLITS,
    _candidate_examples,
    _candidate_probability_summary,
    _configure_utf8_stdio,
    _dataset_rows,
    _score_rows,
    _split_metrics_for_config,
    _train_logistic_regression,
)

VERSION = "rkb-phase-ranker-posthoc-locked-replay-v1"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "phase-ranker-preregistered-replay-latest.json"
LOCKED_CONFIG = {
    "l2": 0.3,
    "mode": "ranked-top16",
    "rankLimit": 16,
    "threshold": 0.94,
}


def _load_rows(args: argparse.Namespace) -> tuple[dict[str, list[dict[str, Any]]], dict[str, dict[str, Any]]]:
    current_rows, current_metadata = _dataset_rows(
        name="current",
        benchmark_path=Path(args.current_benchmark),
        split_path=Path(args.current_splits),
        feature_cache_dir=Path(args.current_feature_cache),
        max_rank=int(LOCKED_CONFIG["rankLimit"]),
    )
    blind_rows, blind_metadata = _dataset_rows(
        name="blind",
        benchmark_path=Path(args.blind_benchmark),
        split_path=Path(args.blind_splits),
        feature_cache_dir=Path(args.blind_feature_cache),
        max_rank=int(LOCKED_CONFIG["rankLimit"]),
    )
    return (
        {"current": current_rows, "blind": blind_rows},
        {"current": current_metadata, "blind": blind_metadata},
    )


def _promotion_blockers(metrics: dict[str, dict[str, Any]]) -> list[str]:
    blockers: list[str] = []
    for dataset in DATASET_ORDER:
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
        include_details=detail_limit > 0,
    )
    blockers = _promotion_blockers(metrics)
    holdout_signal_positive = (
        int(metrics["current"]["holdout"]["netPassDelta"]) > 0
        and int(metrics["blind"]["holdout"]["netPassDelta"]) > 0
        and int(metrics["current"]["holdout"]["passToFail"]) == 0
        and int(metrics["blind"]["holdout"]["passToFail"]) == 0
    )
    return {
        "version": VERSION,
        "scope": (
            "Replay of a post-hoc contaminated phase-ranker hypothesis. The locked config was "
            "identified after viewing current/blind validation reports, so this replay is only a "
            "future-data hypothesis and is not fresh promotion evidence."
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
            for dataset in DATASET_ORDER
        },
        "promotionRecommendation": {
            "safeToPromoteFromThisReplay": False,
            "replayHasNoMeasuredRegression": not blockers,
            "holdoutSignalPositive": holdout_signal_positive,
            "blockers": blockers,
            "reason": (
                "requires fresh blind or new truth because this config was selected after viewing "
                "current/blind reports; current replay is post-hoc contaminated"
            ),
        },
    }


def main() -> int:
    _configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Replay the post-hoc locked phase-ranker hypothesis")
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
        "holdout": {dataset: report["metrics"][dataset]["holdout"] for dataset in DATASET_ORDER},
        "replayHasNoMeasuredRegression": report["promotionRecommendation"]["replayHasNoMeasuredRegression"],
    }
    print(json.dumps(compact, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
