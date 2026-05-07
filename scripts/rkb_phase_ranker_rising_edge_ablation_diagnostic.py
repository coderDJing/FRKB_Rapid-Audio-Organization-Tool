import argparse
import copy
import json
from pathlib import Path
from typing import Any

from rkb_beatgrid_lab_common import BENCHMARK_OUTPUT_DIR, atomic_write_json
from rkb_phase_ranker_diagnostic import (
    DEFAULT_BLIND_BENCHMARK,
    DEFAULT_BLIND_FEATURE_CACHE,
    DEFAULT_BLIND_SPLITS,
    DEFAULT_CURRENT_BENCHMARK,
    DEFAULT_CURRENT_FEATURE_CACHE,
    DEFAULT_CURRENT_SPLITS,
    _configure_utf8_stdio,
)
from rkb_phase_ranker_rising_edge_diagnostic import _build_report, _dataset_rows

VERSION = "rkb-phase-ranker-rising-edge-ablation-diagnostic-v1"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "phase-ranker-rising-edge-ablation-diagnostic-latest.json"
BAR_PRIOR_FEATURES = {
    "barBeatOffsetSameMod4",
    "barBeatOffsetSameExact32",
    "barBeatOffset32Sin",
    "barBeatOffset32Cos",
    "barBeatOffset4Sin",
    "barBeatOffset4Cos",
}


def _first_feature_names(rows_by_dataset: dict[str, list[dict[str, Any]]]) -> list[str]:
    for rows in rows_by_dataset.values():
        for row in rows:
            names = row.get("featureNames")
            if isinstance(names, list) and names:
                return [str(item) for item in names]
    return []


def _copy_with_feature_filter(
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    keep_indices: list[int],
    next_feature_names: list[str],
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for dataset, rows in rows_by_dataset.items():
        next_rows: list[dict[str, Any]] = []
        for row in rows:
            next_row = {key: value for key, value in row.items() if key not in {"candidates", "featureNames"}}
            next_candidates: list[dict[str, Any]] = []
            for candidate in row.get("candidates", []):
                if not isinstance(candidate, dict):
                    continue
                vector = candidate.get("featureVector")
                if not isinstance(vector, list):
                    continue
                next_candidate = dict(candidate)
                next_candidate["featureVector"] = [float(vector[index]) for index in keep_indices]
                next_candidates.append(next_candidate)
            next_row["featureNames"] = next_feature_names
            next_row["candidates"] = next_candidates
            next_rows.append(next_row)
        result[dataset] = next_rows
    return result


def _drop_bar_prior_rows(
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    feature_names: list[str],
) -> tuple[dict[str, list[dict[str, Any]]], list[str]]:
    keep_indices = [
        index
        for index, name in enumerate(feature_names)
        if name not in BAR_PRIOR_FEATURES
    ]
    next_feature_names = [feature_names[index] for index in keep_indices]
    return _copy_with_feature_filter(rows_by_dataset, keep_indices, next_feature_names), next_feature_names


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
    parser = argparse.ArgumentParser(description="Ablate bar-prior features from the rising-edge ranker")
    parser.add_argument("--current-benchmark", default=str(DEFAULT_CURRENT_BENCHMARK))
    parser.add_argument("--current-splits", default=str(DEFAULT_CURRENT_SPLITS))
    parser.add_argument("--current-feature-cache", default=str(DEFAULT_CURRENT_FEATURE_CACHE))
    parser.add_argument("--blind-benchmark", default=str(DEFAULT_BLIND_BENCHMARK))
    parser.add_argument("--blind-splits", default=str(DEFAULT_BLIND_SPLITS))
    parser.add_argument("--blind-feature-cache", default=str(DEFAULT_BLIND_FEATURE_CACHE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--detail-limit", type=int, default=0)
    args = parser.parse_args()

    rows_by_dataset, metadata_by_dataset = _load_rows(args)
    feature_names = _first_feature_names(rows_by_dataset)
    no_bar_rows, no_bar_feature_names = _drop_bar_prior_rows(rows_by_dataset, feature_names)
    full_report = _build_report(
        rows_by_dataset=copy.deepcopy(rows_by_dataset),
        metadata_by_dataset=metadata_by_dataset,
        feature_names=feature_names,
        detail_limit=int(args.detail_limit),
    )
    no_bar_report = _build_report(
        rows_by_dataset=no_bar_rows,
        metadata_by_dataset=metadata_by_dataset,
        feature_names=no_bar_feature_names,
        detail_limit=int(args.detail_limit),
    )
    report = {
        "version": VERSION,
        "scope": (
            "Diagnostic only. Compares rising-edge ranker with and without absolute/same bar-prior "
            "features while keeping downbeat-logit score features. Current/blind are already inspected."
        ),
        "ablation": {
            "droppedFeatures": sorted(BAR_PRIOR_FEATURES),
            "keptFeatureCount": len(no_bar_feature_names),
            "fullFeatureCount": len(feature_names),
        },
        "variants": {
            "full": full_report,
            "noBarPriors": no_bar_report,
        },
        "promotionRecommendation": {
            "safeToPromoteFromThisDiagnostic": False,
            "reason": "ablation is diagnostic on inspected current/blind data; requires fresh-truth replay",
        },
    }
    output_path = Path(args.output)
    atomic_write_json(output_path, report)
    compact = {
        "output": str(output_path),
        "full": {
            "config": full_report["selectedConfig"],
            "currentAll": full_report["metrics"]["current"]["all"],
            "blindAll": full_report["metrics"]["blind"]["all"],
        },
        "noBarPriors": {
            "config": no_bar_report["selectedConfig"],
            "currentAll": no_bar_report["metrics"]["current"]["all"],
            "blindAll": no_bar_report["metrics"]["blind"]["all"],
        },
    }
    print(json.dumps(compact, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
