from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rkb_dataset_contract import attach_benchmark_result_digest, normalize_path
from rkb_nested_lobo_contract import (
    NestedLoboError,
    build_compact_result,
    build_provenance,
    read_json_object,
    write_json_atomic,
    write_json_new,
)
from rkb_nested_lobo_evaluator import (
    build_feature_contract,
    evaluate_fixed_configs,
    load_truth_catalog,
    materialize_subset_truth,
    validate_feature_contract,
)


DIAGNOSTIC_REPORT_NAME = "diagnostic-report.json"
DIAGNOSTIC_FEATURE_CONTRACT_NAME = "feature-contract-new357.json"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _instance_catalog(split: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = split.get("instances")
    if not isinstance(rows, list):
        raise NestedLoboError("parent split contains no instance metadata")
    return {
        str(row.get("instanceId") or "").casefold(): row
        for row in rows
        if isinstance(row, dict) and str(row.get("instanceId") or "").strip()
    }


def _write_or_validate(path: Path, expected: dict[str, Any]) -> None:
    if path.is_file():
        if read_json_object(path) != expected:
            raise NestedLoboError(f"immutable diagnostic artifact drifted: {path}")
    else:
        write_json_new(path, expected)


def _diagnostic_feature_contract(
    *,
    args: Any,
    inputs: dict[str, Any],
    work_dir: Path,
    instance_ids: list[str],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    path = work_dir / DIAGNOSTIC_FEATURE_CONTRACT_NAME
    if path.is_file():
        payload = read_json_object(path)
    else:
        try:
            payload = build_feature_contract(
                cache_dirs=[Path(item).resolve() for item in args.feature_cache_dir],
                instance_ids=instance_ids,
                catalog=_instance_catalog(inputs["split"]),
                output_path=path,
                scope="diagnostic-new357-only",
            )
        except NestedLoboError as error:
            raise NestedLoboError(
                "new357 diagnostic requires strong-identity features for its complete frozen roster; "
                f"materialize/recompute the missing cache first: {error}"
            ) from error
    return payload, validate_feature_contract(payload, expected_instance_ids=instance_ids)


def execute_new357_diagnostic(
    *,
    args: Any,
    inputs: dict[str, Any],
    work_dir: Path,
    study_lock: dict[str, Any],
    selection_index: dict[str, Any],
    selection_locks: dict[str, dict[str, Any]],
    primary_report: dict[str, Any],
    primary_aggregate: dict[str, Any],
    state_path: Path,
    primary_feature_contract: dict[str, Any] | None = None,
    diagnostic_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    diagnostic_folds = inputs["foldPlan"]["diagnosticFolds"]
    if len(diagnostic_folds) != 1 or diagnostic_folds[0]["batchId"] != "new357":
        raise NestedLoboError("nested LOBO diagnostic roster must contain only new357")
    diagnostic_fold = diagnostic_folds[0]
    instance_ids = diagnostic_fold["outerHoldout"]
    feature_contract, feature_rows = _diagnostic_feature_contract(
        args=args,
        inputs=inputs,
        work_dir=work_dir,
        instance_ids=instance_ids,
    )
    if primary_feature_contract is None:
        primary_feature_contract = read_json_object(work_dir / "feature-contract-primary.json")
    if (
        primary_feature_contract.get("featureContractSha256")
        != study_lock["locked"]["featureContractSha256"]
    ):
        raise NestedLoboError("primary feature contract differs from the immutable study lock")
    locked_primary_policy_sha256 = str(
        study_lock["locked"].get("primaryFeatureGenerationPolicySha256")
        or primary_feature_contract.get("featureGenerationPolicySha256")
        or ""
    )
    if feature_contract.get("featureGenerationPolicySha256") != locked_primary_policy_sha256:
        raise NestedLoboError(
            "new357 diagnostic feature policy differs from the locked primary feature policy"
        )
    catalog = load_truth_catalog(
        inputs["splitPath"],
        inputs["split"],
        instance_ids=instance_ids,
    )
    truth_path = work_dir / "diagnostics" / "new357" / "truth.json"
    _, truth_contract, tracks = materialize_subset_truth(
        instance_ids=instance_ids,
        catalog=catalog,
        output_path=truth_path,
        split_path=inputs["splitPath"],
        split_sha256=inputs["splitSha256"],
        fold_batch_id="new357",
        role="post-outer-development-diagnostic",
        membership_sha256=diagnostic_fold["outerHoldoutRosterSha256"],
        ffprobe_path=Path(args.ffprobe).resolve(),
        time_basis_cache={},
    )
    candidates = {
        str(candidate["configSha256"]): candidate
        for candidate in inputs["candidates"]["candidates"]
    }
    selected_locks_by_config: dict[str, list[str]] = {}
    for selection_lock in selection_locks.values():
        config_sha = str(selection_lock["locked"]["selectedConfigSha256"])
        selected_locks_by_config.setdefault(config_sha, []).append(selection_lock["lockHash"])
    selected_candidates = [candidates[key] for key in sorted(selected_locks_by_config)]
    baselines = [candidate for candidate in candidates.values() if candidate.get("isNoOp") is True]
    if len(baselines) != 1:
        raise NestedLoboError("diagnostic replay requires the unique no-op comparator")
    evaluation_candidates = list(selected_candidates)
    if baselines[0]["configSha256"] not in selected_locks_by_config:
        evaluation_candidates.append(baselines[0])
    evaluated = evaluate_fixed_configs(
        tracks=tracks,
        candidates=evaluation_candidates,
        feature_contract_rows=feature_rows,
    )
    context = diagnostic_context or {}
    result_provenance_context = {
        key: context[key]
        for key in (
            "diagnosticStudyLockHash",
            "diagnosticSolverContractSha256",
            "diagnosticSolverMatchesPrimary",
        )
        if key in context
    }
    result_rows: list[dict[str, Any]] = []
    for candidate in selected_candidates:
        config_sha = str(candidate["configSha256"])
        referenced_locks = sorted(selected_locks_by_config[config_sha])
        provenance = build_provenance(
            {
                "stage": "post-outer-new357-diagnostic",
                "studyLockHash": study_lock["lockHash"],
                "selectionPlanSha256": selection_index["selectionPlanSha256"],
                "referencedSelectionLockHashes": referenced_locks,
                "diagnosticBatchId": "new357",
                "diagnosticRosterSha256": diagnostic_fold["outerHoldoutRosterSha256"],
                "candidateId": candidate["candidateId"],
                "configSha256": config_sha,
                "truthContractSha256": truth_contract["contractSha256"],
                "featureContractSha256": feature_contract["featureContractSha256"],
                "solverContractSha256": study_lock["locked"]["solverContractSha256"],
                "selectionPerformed": False,
                "primaryAggregateEligible": False,
                **result_provenance_context,
            }
        )
        result = build_compact_result(
            result_type="rkb-nested-lobo-diagnostic-result",
            provenance=provenance,
            candidate=candidate,
            rows=evaluated[config_sha],
        )
        result_path = work_dir / "diagnostics" / "new357" / "results" / f"{config_sha}.json"
        _write_or_validate(result_path, result)
        result_rows.append(
            {
                "candidateId": candidate["candidateId"],
                "configSha256": config_sha,
                "referencedSelectionLockHashes": referenced_locks,
                "metrics": result["overall"],
                "resultBodySha256": result["summary"]["resultBodySha256"],
                "resultPath": normalize_path(result_path),
            }
        )
    report_path = work_dir / DIAGNOSTIC_REPORT_NAME
    report_payload: dict[str, Any] = {
        "schemaVersion": 1,
        "type": "rkb-nested-lobo-diagnostic-report",
        "studyId": args.study_id,
        "studyLockHash": study_lock["lockHash"],
        "selectionPlanSha256": selection_index["selectionPlanSha256"],
        "diagnosticBatchId": "new357",
        "selectionPerformed": False,
        "primaryAggregateEligible": False,
        "freshProofEligible": False,
        "primaryReportBodySha256": primary_report["summary"]["resultBodySha256"],
        "primaryAggregateSha256": primary_aggregate["aggregateSha256"],
        "diagnosticFeatureContractSha256": feature_contract["featureContractSha256"],
        "configs": result_rows,
        "summary": {
            "trackTotal": len(instance_ids),
            "uniqueSelectedConfigCount": len(result_rows),
        },
        "tracks": [],
        "errors": [],
    }
    report_payload.update(context)
    report = attach_benchmark_result_digest(report_payload)
    write_json_new(report_path, report)
    state_payload: dict[str, Any] = {
        "schemaVersion": 1,
        "studyId": args.study_id,
        "status": "diagnostic_complete",
        "studyLockHash": study_lock["lockHash"],
        "selectionPlanSha256": selection_index["selectionPlanSha256"],
        "primaryReportBodySha256": primary_report["summary"]["resultBodySha256"],
        "diagnosticReportBodySha256": report["summary"]["resultBodySha256"],
        "updatedAt": _utc_now(),
    }
    state_payload.update(context)
    write_json_atomic(state_path, state_payload)
    return {
        "studyId": args.study_id,
        "status": "diagnostic_complete",
        "diagnosticBatchId": "new357",
        "uniqueSelectedConfigCount": len(result_rows),
        "selectionPerformed": False,
        "report": str(report_path),
    }
