from pathlib import Path
from typing import Any

from rkb_dataset_contract import (
    normalize_path,
    validate_benchmark_result_digest,
    validate_truth_contract,
)
from rkb_nested_lobo_contract import (
    NestedLoboError,
    build_provenance,
    primary_aggregate,
    primary_estimate_eligible,
    read_json_object,
    validate_compact_result,
)


def outer_provenance(
    *,
    study_lock: dict[str, Any],
    selection_index: dict[str, Any],
    selection_lock: dict[str, Any],
    fold: dict[str, Any],
    candidate: dict[str, Any],
    truth_contract: dict[str, Any],
) -> dict[str, Any]:
    return build_provenance(
        {
            "stage": "primary-outer-one-shot",
            "studyLockHash": study_lock["lockHash"],
            "selectionPlanSha256": selection_index["selectionPlanSha256"],
            "selectionLockHash": selection_lock["lockHash"],
            "foldBatchId": fold["batchId"],
            "outerRosterSha256": fold["outerHoldoutRosterSha256"],
            "candidateId": candidate["candidateId"],
            "configSha256": candidate["configSha256"],
            "modelHash": selection_lock["locked"]["selectedModelHash"],
            "truthContractSha256": truth_contract["contractSha256"],
            "featureContractSha256": study_lock["locked"]["featureContractSha256"],
            "solverContractSha256": study_lock["locked"]["solverContractSha256"],
            "outerResultsMayTuneRules": False,
        }
    )


def validate_existing_primary_report(
    *,
    report_path: Path,
    work_dir: Path,
    inputs: dict[str, Any],
    study_lock: dict[str, Any],
    selection_index: dict[str, Any],
    selection_locks: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    report = read_json_object(report_path)
    validate_benchmark_result_digest(report)
    if (
        report.get("type") != "rkb-nested-lobo-primary-report"
        or report.get("studyId") != study_lock["locked"]["studyId"]
        or report.get("studyLockHash") != study_lock["lockHash"]
        or report.get("selectionPlanSha256") != selection_index["selectionPlanSha256"]
        or report.get("diagnosticReplays") != {}
    ):
        raise NestedLoboError("existing primary report provenance/type drifted")
    candidate_by_hash = {
        str(candidate["configSha256"]): candidate
        for candidate in inputs["candidates"]["candidates"]
    }
    fold_rows: list[dict[str, Any]] = []
    for fold in inputs["foldPlan"]["primaryFolds"]:
        batch_id = str(fold["batchId"])
        selection_lock = selection_locks[batch_id]
        selected_sha = str(selection_lock["locked"]["selectedConfigSha256"])
        selected = candidate_by_hash.get(selected_sha)
        if selected is None:
            raise NestedLoboError(f"selection lock references an unknown config: {batch_id}")
        fold_dir = work_dir / "folds" / batch_id
        truth_path = fold_dir / "truth-outer-holdout.json"
        truth_payload = read_json_object(truth_path)
        truth_contract = validate_truth_contract(truth_path, truth_payload)
        subset = (
            truth_payload.get("nestedLoboSubset")
            if isinstance(truth_payload.get("nestedLoboSubset"), dict)
            else {}
        )
        if (
            subset.get("foldBatchId") != batch_id
            or subset.get("role") != "primary-outer-holdout"
            or subset.get("membershipSha256") != fold["outerHoldoutRosterSha256"]
        ):
            raise NestedLoboError(f"materialized outer truth provenance mismatch: {batch_id}")
        result_path = fold_dir / "outer-result.json"
        result = read_json_object(result_path)
        provenance = outer_provenance(
            study_lock=study_lock,
            selection_index=selection_index,
            selection_lock=selection_lock,
            fold=fold,
            candidate=selected,
            truth_contract=truth_contract,
        )
        validate_compact_result(
            result,
            expected_provenance=provenance,
            expected_instance_ids=fold["outerHoldout"],
        )
        fold_rows.append(
            {
                "batchId": batch_id,
                "selectionLockHash": selection_lock["lockHash"],
                "selectedCandidateId": selected["candidateId"],
                "selectedConfigSha256": selected_sha,
                "metrics": result["overall"],
                "resultBodySha256": result["summary"]["resultBodySha256"],
                "resultPath": normalize_path(result_path),
            }
        )
    aggregate = primary_aggregate(
        fold_rows,
        primary_batch_ids=inputs["foldPlan"]["primaryBatchIds"],
        aggregate_policy=inputs["candidates"]["aggregatePolicy"],
    )
    if report.get("folds") != fold_rows or report.get("aggregate") != aggregate:
        raise NestedLoboError("existing primary report no longer matches the six immutable fold results")
    expected_eligible = primary_estimate_eligible(
        study_lock["locked"]["evidenceRole"], aggregate
    )
    if report.get("primaryNestedEstimateEligible") is not expected_eligible:
        raise NestedLoboError("existing primary report eligibility disagrees with aggregate gates")
    expected_summary = {
        "trackTotal": sum(int(row["metrics"]["trackCount"]) for row in fold_rows),
        "errorTrackCount": sum(int(row["metrics"]["errorTrackCount"]) for row in fold_rows),
        "resultBodySha256": report["summary"]["resultBodySha256"],
    }
    if report.get("summary") != expected_summary:
        raise NestedLoboError("existing primary report summary is inconsistent")
    return report, aggregate
