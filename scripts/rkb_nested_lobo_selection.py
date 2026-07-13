from pathlib import Path
from typing import Any

from rkb_dataset_contract import sha256_json, validate_truth_contract
from rkb_nested_lobo_contract import (
    NestedLoboError,
    build_provenance,
    read_json_object,
    select_candidate,
    validate_compact_result,
)


def fit_artifact(
    *,
    study_lock: dict[str, Any],
    fold: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    locked = {
        "schemaVersion": 1,
        "fitMode": "fixed-no-fit",
        "studyLockHash": study_lock["lockHash"],
        "foldBatchId": fold["batchId"],
        "foldMembershipSha256": fold["foldMembershipSha256"],
        "effectiveDevelopmentTrainRosterSha256": fold[
            "effectiveDevelopmentTrainRosterSha256"
        ],
        "effectiveDevelopmentTrainTrackCount": fold[
            "effectiveDevelopmentTrainTrackCount"
        ],
        "filteredDiagnosticTrainRosterSha256": fold[
            "filteredDiagnosticTrainRosterSha256"
        ],
        "candidateId": candidate["candidateId"],
        "configSha256": candidate["configSha256"],
        "parameters": candidate["parameters"],
        "trainerInvoked": False,
    }
    return {
        "schemaVersion": 1,
        "type": "rkb-nested-lobo-fixed-fit-artifact",
        "locked": locked,
        "modelHash": sha256_json(locked),
    }


def tune_provenance(
    *,
    study_lock: dict[str, Any],
    fold: dict[str, Any],
    candidate: dict[str, Any],
    fit: dict[str, Any],
    truth_contract: dict[str, Any],
) -> dict[str, Any]:
    return build_provenance(
        {
            "stage": "development-tune-selection",
            "studyLockHash": study_lock["lockHash"],
            "foldBatchId": fold["batchId"],
            "foldMembershipSha256": fold["foldMembershipSha256"],
            "effectiveTuneRosterSha256": fold["effectiveDevelopmentTuneRosterSha256"],
            "candidateId": candidate["candidateId"],
            "configSha256": candidate["configSha256"],
            "modelHash": fit["modelHash"],
            "truthContractSha256": truth_contract["contractSha256"],
            "featureContractSha256": study_lock["locked"]["featureContractSha256"],
            "solverContractSha256": study_lock["locked"]["solverContractSha256"],
            "outerTruthRead": False,
        }
    )


def selection_lock_expected(
    *,
    study_lock: dict[str, Any],
    fold: dict[str, Any],
    selected: dict[str, Any],
    ranking: list[dict[str, Any]],
    fit: dict[str, Any],
    result_digests: list[dict[str, str]],
) -> dict[str, Any]:
    locked = {
        "schemaVersion": 1,
        "studyLockHash": study_lock["lockHash"],
        "foldBatchId": fold["batchId"],
        "foldMembershipSha256": fold["foldMembershipSha256"],
        "parentDevelopmentTrainRosterSha256": fold["parentDevelopmentTrainRosterSha256"],
        "parentDevelopmentTuneRosterSha256": fold["parentDevelopmentTuneRosterSha256"],
        "effectiveDevelopmentTrainRosterSha256": fold[
            "effectiveDevelopmentTrainRosterSha256"
        ],
        "effectiveDevelopmentTuneRosterSha256": fold[
            "effectiveDevelopmentTuneRosterSha256"
        ],
        "filteredDiagnosticTrainRosterSha256": fold[
            "filteredDiagnosticTrainRosterSha256"
        ],
        "filteredDiagnosticTuneRosterSha256": fold[
            "filteredDiagnosticTuneRosterSha256"
        ],
        "selectedCandidateId": selected["candidateId"],
        "selectedConfigSha256": selected["configSha256"],
        "selectedModelHash": fit["modelHash"],
        "selectionRanking": ranking,
        "tuneResultDigests": sorted(result_digests, key=lambda item: item["configSha256"]),
        "outerTruthRead": False,
        "freshProofEligible": False,
    }
    return {
        "schemaVersion": 1,
        "type": "rkb-nested-lobo-selection-lock",
        "locked": locked,
        "lockHash": sha256_json(locked),
    }


def revalidate_selection_evidence(
    *,
    work_dir: Path,
    inputs: dict[str, Any],
    study_lock: dict[str, Any],
    selection_locks: dict[str, dict[str, Any]],
) -> None:
    candidate_by_hash = {
        str(candidate["configSha256"]): candidate
        for candidate in inputs["candidates"]["candidates"]
    }
    for fold in inputs["foldPlan"]["primaryFolds"]:
        batch_id = str(fold["batchId"])
        fold_dir = work_dir / "folds" / batch_id
        truth_path = fold_dir / "truth-development-tune.json"
        truth_payload = read_json_object(truth_path)
        truth_contract = validate_truth_contract(truth_path, truth_payload)
        subset = (
            truth_payload.get("nestedLoboSubset")
            if isinstance(truth_payload.get("nestedLoboSubset"), dict)
            else {}
        )
        if (
            subset.get("foldBatchId") != batch_id
            or subset.get("role") != "effective-development-tune"
            or subset.get("membershipSha256") != fold["effectiveDevelopmentTuneRosterSha256"]
        ):
            raise NestedLoboError(f"materialized tune truth provenance mismatch: {batch_id}")
        expected_batches = [
            item for item in inputs["foldPlan"]["primaryBatchIds"] if item != batch_id
        ]
        fits: dict[str, dict[str, Any]] = {}
        results: dict[str, dict[str, Any]] = {}
        digests: list[dict[str, str]] = []
        for config_sha, candidate in candidate_by_hash.items():
            fit = read_json_object(fold_dir / "fit" / f"{config_sha}.json")
            expected_fit = fit_artifact(study_lock=study_lock, fold=fold, candidate=candidate)
            if fit != expected_fit:
                raise NestedLoboError(f"fixed/no-fit artifact drifted: {batch_id}:{config_sha}")
            fits[config_sha] = fit
            result = read_json_object(fold_dir / "tune-results" / f"{config_sha}.json")
            provenance = tune_provenance(
                study_lock=study_lock,
                fold=fold,
                candidate=candidate,
                fit=fit,
                truth_contract=truth_contract,
            )
            validate_compact_result(
                result,
                expected_provenance=provenance,
                expected_instance_ids=fold["effectiveDevelopmentTune"],
                expected_batch_ids=expected_batches,
            )
            if (
                result.get("candidateId") != candidate["candidateId"]
                or result.get("configSha256") != config_sha
                or result.get("complexityRank") != candidate["complexityRank"]
            ):
                raise NestedLoboError(f"tune result candidate identity drifted: {batch_id}:{config_sha}")
            results[config_sha] = result
            digests.append(
                {
                    "configSha256": config_sha,
                    "resultBodySha256": str(result["summary"]["resultBodySha256"]),
                }
            )
        selected, ranking = select_candidate(
            [results[key] for key in sorted(results)],
            inputs["candidates"]["selectionPolicy"],
            primary_batch_ids=expected_batches,
        )
        selected_candidate = candidate_by_hash[str(selected["configSha256"])]
        expected_lock = selection_lock_expected(
            study_lock=study_lock,
            fold=fold,
            selected=selected_candidate,
            ranking=ranking,
            fit=fits[str(selected["configSha256"])],
            result_digests=digests,
        )
        if selection_locks[batch_id] != expected_lock:
            raise NestedLoboError(f"selection winner/evidence drifted after ledger lock: {batch_id}")
