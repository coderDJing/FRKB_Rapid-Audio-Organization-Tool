import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

from rkb_dataset_contract import sha256_file, sha256_json
from rkb_multiscale_ranker_study import _fit_ridge, _model_json
from rkb_nested_lobo_contract import read_json_object


FREEZE_VERSION = "rkb-multiscale-usable-grid-frozen-candidate-v1"
EXPECTED_STUDY_VERSION = "rkb-multiscale-ridge-usable-grid-development-v3"
EXPECTED_ROW_VERSION = "rkb-multiscale-usable-grid-training-row-v1"
DEFAULT_STUDY_DIR = (
    "grid-analysis-lab/rkb-rekordbox-benchmark/multiscale-studies/"
    "rkb-multiscale-ridge-usable-grid-development-v3"
)
DEFAULT_TRACKED_OUTPUT = (
    Path(__file__).resolve().parent
    / "models"
    / "rkb-multiscale-usable-grid-candidate-v1.json"
)
FORBIDDEN_FEATURE_TOKENS = (
    "truth",
    "filename",
    "artist",
    "title",
    "sourcepath",
    "batchid",
    "instanceid",
    "category",
    "pass",
    "fail",
)


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _atomic_write_compact_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(path)


def _source_report_hash(report: dict[str, Any]) -> str:
    payload = {key: value for key, value in report.items() if key != "reportSha256"}
    return sha256_json(payload)


def _modal_fold_config(configs: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, int]]:
    non_baseline = [item for item in configs if item.get("family") != "baseline"]
    if not non_baseline:
        raise RuntimeError("study selected no trainable fold config")
    counts = Counter(str(item["configId"]) for item in non_baseline)
    selected_id, selected_count = max(counts.items(), key=lambda item: (item[1], item[0]))
    selected_configs = [item for item in non_baseline if str(item["configId"]) == selected_id]
    template = selected_configs[0]
    for item in selected_configs[1:]:
        for key in ("family", "l2", "mode", "threshold"):
            if item.get(key) != template.get(key):
                raise RuntimeError(f"modal config fields drifted for {selected_id}:{key}")
    return (
        {
            "configId": selected_id,
            "family": str(template["family"]),
            "l2": float(template["l2"]),
            "mode": str(template["mode"]),
            "threshold": float(template["threshold"]),
            "selectedFoldCount": selected_count,
            "totalFoldCount": len(configs),
        },
        dict(sorted(counts.items())),
    )


def _load_corrected_rows(row_cache_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    index_entries: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for path in sorted(row_cache_dir.glob("row-*.json"), key=lambda item: item.name.casefold()):
        row = read_json_object(path)
        if row.get("type") != EXPECTED_ROW_VERSION:
            raise RuntimeError(f"corrected row version mismatch: {path}")
        instance_id = str(row.get("instanceId") or "")
        if not instance_id or instance_id.casefold() in seen_ids:
            raise RuntimeError(f"corrected row identity is invalid/duplicate: {instance_id}")
        seen_ids.add(instance_id.casefold())
        rows.append(row)
        index_entries.append(
            {
                "instanceId": instance_id,
                "batchId": str(row.get("batchId") or ""),
                "path": str(path.resolve()).replace("\\", "/"),
                "fileSha256": sha256_file(path),
                "cacheKey": str(row.get("cacheKey") or ""),
            }
        )
    if len(rows) != 3388:
        raise RuntimeError(f"corrected row cache count must be 3388, got {len(rows)}")
    return rows, index_entries


def freeze_candidate(args: argparse.Namespace) -> dict[str, Any]:
    study_dir = Path(args.study_dir).resolve()
    report_path = study_dir / "report.json"
    report = read_json_object(report_path)
    if report.get("studyVersion") != EXPECTED_STUDY_VERSION:
        raise RuntimeError("study version is not the corrected usable-grid v3")
    if _source_report_hash(report) != report.get("reportSha256"):
        raise RuntimeError("study report hash is invalid")
    if not bool((report.get("aggregate") or {}).get("passed")):
        raise RuntimeError("study did not pass development gates")
    if bool(report.get("freshProofEligible")):
        raise RuntimeError("development study must not claim fresh eligibility")

    fold_configs: list[dict[str, Any]] = []
    fold_result_hashes: dict[str, str] = {}
    for fold in report.get("folds") or []:
        batch_id = str(fold["batchId"])
        fold_path = study_dir / "folds" / batch_id / "result.json"
        fold_result = read_json_object(fold_path)
        fold_configs.append(dict(fold_result["selectedConfig"]))
        fold_result_hashes[batch_id] = sha256_file(fold_path)
    config, config_counts = _modal_fold_config(fold_configs)
    row_cache_dir = study_dir / "corrected-row-cache"
    rows, index_entries = _load_corrected_rows(row_cache_dir)
    index = {
        "schemaVersion": 1,
        "type": "rkb-multiscale-usable-grid-corrected-row-index",
        "rowVersion": EXPECTED_ROW_VERSION,
        "trackCount": len(index_entries),
        "entries": index_entries,
    }
    index["indexSha256"] = sha256_json(index)
    index_path = study_dir / "corrected-row-index.json"
    _atomic_write_json(index_path, index)

    model = _fit_ridge(rows, str(config["family"]), float(config["l2"]))
    forbidden = [
        name
        for name in model["featureNames"]
        if any(token in str(name).casefold() for token in FORBIDDEN_FEATURE_TOKENS)
    ]
    if forbidden:
        raise RuntimeError(f"frozen model contains forbidden feature names: {forbidden[0]}")
    candidate = {
        "schemaVersion": 1,
        "type": "rkb-multiscale-usable-grid-frozen-candidate",
        "freezeVersion": FREEZE_VERSION,
        "locked": True,
        "productionEligible": False,
        "freshProofEligible": False,
        "parameterSelectionAllowed": False,
        "selectionBasis": {
            "rule": "modal exact config among six fold inner-selected configs",
            "outerMetricsUsedForConfigSelection": False,
            "configCounts": config_counts,
        },
        "config": config,
        "model": _model_json(model),
        "training": {
            "trackCount": len(rows),
            "candidateCount": int(model["trainCandidateCount"]),
            "positiveRate": float(model["trainPositiveRate"]),
            "correctedRowIndexPath": str(index_path.resolve()).replace("\\", "/"),
            "correctedRowIndexFileSha256": sha256_file(index_path),
            "correctedRowIndexEmbeddedSha256": index["indexSha256"],
        },
        "sourceStudy": {
            "path": str(report_path.resolve()).replace("\\", "/"),
            "fileSha256": sha256_file(report_path),
            "embeddedReportSha256": report["reportSha256"],
            "foldResultSha256": dict(sorted(fold_result_hashes.items())),
        },
    }
    candidate["candidateSha256"] = sha256_json(candidate)
    output_path = study_dir / "frozen-candidate.json"
    _atomic_write_json(output_path, candidate)
    tracked_output = Path(args.tracked_output).resolve()
    _atomic_write_compact_json(tracked_output, candidate)
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fit and freeze the final corrected usable-grid candidate after v3 development"
    )
    parser.add_argument("--study-dir", default=DEFAULT_STUDY_DIR)
    parser.add_argument("--tracked-output", default=str(DEFAULT_TRACKED_OUTPUT))
    args = parser.parse_args()
    candidate = freeze_candidate(args)
    print(
        json.dumps(
            {
                "candidateSha256": candidate["candidateSha256"],
                "config": candidate["config"],
                "training": candidate["training"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
