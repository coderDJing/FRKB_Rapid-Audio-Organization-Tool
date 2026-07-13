import json
import math
from pathlib import Path
from typing import Any

from rkb_dataset_contract import (
    attach_benchmark_result_digest,
    canonical_json,
    normalize_name,
    sha256_json,
    validate_benchmark_result_digest,
)


SCHEMA_VERSION = 1
PRIMARY_EVIDENCE_ROLE = "primary-consumed-nested-estimate"
POST_OUTER_DIAGNOSTIC_ROLE = "post-outer-development-diagnostic"
CANDIDATE_TYPE = "rkb-nested-lobo-candidate-set"
SELECTION_OBJECTIVE_VERSION = "primary-inner-batch-lexicographic-v1"
SOLVER_MODE = "constant-grid-dp-fixed-no-fit"
MAX_CANDIDATE_COUNT = 64
PARAMETER_DEFAULTS: dict[str, float | int] = {
    "minBpm": 70.0,
    "maxBpm": 200.0,
    "tempoStepBpm": 0.5,
    "tempoLimit": 24,
    "phaseStepMs": 2.0,
    "maxCandidates": 640,
}


class NestedLoboError(RuntimeError):
    pass


def primary_estimate_eligible(evidence_role: str, aggregate: dict[str, Any]) -> bool:
    return evidence_role == PRIMARY_EVIDENCE_ROLE and aggregate.get("passed") is True


def read_json_object(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise NestedLoboError(f"failed to read JSON object {path}: {error}") from error
    if not isinstance(payload, dict):
        raise NestedLoboError(f"JSON root must be an object: {path}")
    return payload


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def write_json_new(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
    except FileExistsError as error:
        raise NestedLoboError(f"immutable file already exists: {path}") from error


def _required_text(row: dict[str, Any], field: str, owner: str) -> str:
    value = str(row.get(field) or "").strip()
    if not value:
        raise NestedLoboError(f"{owner} is missing {field}")
    return value


def _finite_float(value: Any, field: str) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError) as error:
        raise NestedLoboError(f"{field} must be numeric") from error
    if not math.isfinite(numeric):
        raise NestedLoboError(f"{field} must be finite")
    return numeric


def _rate(value: Any, field: str) -> float:
    numeric = _finite_float(value, field)
    if numeric < 0.0 or numeric > 1.0:
        raise NestedLoboError(f"{field} must be between 0 and 1")
    return numeric


def _nonnegative_int(value: Any, field: str) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError) as error:
        raise NestedLoboError(f"{field} must be an integer") from error
    if numeric < 0:
        raise NestedLoboError(f"{field} must be nonnegative")
    return numeric


def instance_roster_projection(
    instance_ids: list[str] | set[str], instance_map: dict[str, dict[str, Any]]
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw_id in instance_ids:
        instance_id = str(raw_id or "").strip()
        key = instance_id.casefold()
        if not instance_id or key in seen:
            raise NestedLoboError(f"roster contains invalid or duplicate instanceId: {instance_id}")
        row = instance_map.get(key)
        if row is None:
            raise NestedLoboError(f"roster instance is absent from parent split: {instance_id}")
        seen.add(key)
        rows.append(
            {
                "instanceId": _required_text(row, "instanceId", "split instance"),
                "isolationFamilyId": _required_text(
                    row, "isolationFamilyId", f"split instance {instance_id}"
                ),
                "assignmentKey": _required_text(
                    row, "assignmentKey", f"split instance {instance_id}"
                ),
            }
        )
    rows.sort(key=lambda item: item["instanceId"].casefold())
    return rows


def instance_roster_sha256(
    instance_ids: list[str] | set[str], instance_map: dict[str, dict[str, Any]]
) -> str:
    return sha256_json(instance_roster_projection(instance_ids, instance_map))


def _instance_map(split: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_instances = split.get("instances")
    if not isinstance(raw_instances, list) or not raw_instances:
        raise NestedLoboError("parent split contains no instances")
    result: dict[str, dict[str, Any]] = {}
    for row in raw_instances:
        if not isinstance(row, dict):
            raise NestedLoboError("parent split contains an invalid instance row")
        instance_id = _required_text(row, "instanceId", "parent split instance")
        key = instance_id.casefold()
        if key in result:
            raise NestedLoboError(f"parent split contains duplicate instanceId: {instance_id}")
        _required_text(row, "batchId", instance_id)
        _required_text(row, "isolationFamilyId", instance_id)
        _required_text(row, "assignmentKey", instance_id)
        result[key] = row
    return result


def _batch_policy_map(split: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = split.get("batchEvidencePolicies")
    if not isinstance(raw, dict):
        raise NestedLoboError("parent split contains no batchEvidencePolicies")
    result: dict[str, dict[str, Any]] = {}
    for batch_id, policy in raw.items():
        if not isinstance(policy, dict):
            raise NestedLoboError(f"batch policy is invalid: {batch_id}")
        result[str(batch_id)] = policy
    return result


def _fold_membership_list(fold: dict[str, Any], field: str) -> list[str]:
    values = fold.get(field)
    if not isinstance(values, list) or any(not str(item or "").strip() for item in values):
        raise NestedLoboError(f"LOBO fold {fold.get('batchId')} has invalid {field}")
    normalized = [str(item).strip() for item in values]
    if len({item.casefold() for item in normalized}) != len(normalized):
        raise NestedLoboError(f"LOBO fold {fold.get('batchId')} has duplicate {field}")
    return sorted(normalized, key=str.casefold)


def build_fold_plan(split: dict[str, Any]) -> dict[str, Any]:
    if split.get("type") != "rkb-rekordbox-dataset-splits" or int(split.get("version") or 0) < 4:
        raise NestedLoboError("nested LOBO requires canonical dataset split version 4+")
    if split.get("identityKey") != "instanceId" or split.get("groupKey") != "isolationFamilyId":
        raise NestedLoboError("nested LOBO requires instanceId/isolationFamilyId split keys")
    for field in (
        "assignmentDigestSha256",
        "splitAssignmentsSha256",
        "audioIsolationPolicySha256",
        "registrySha256",
        "truthSourcesSha256",
    ):
        if not str(split.get(field) or "").strip():
            raise NestedLoboError(f"parent split is missing {field}")
    instances = _instance_map(split)
    all_ids = set(instances)
    policies = _batch_policy_map(split)
    primary_batches = sorted(
        [batch_id for batch_id, policy in policies.items() if policy.get("primaryEvaluationEligible") is True],
        key=str.casefold,
    )
    diagnostic_batches = sorted(
        [batch_id for batch_id, policy in policies.items() if policy.get("primaryEvaluationEligible") is not True],
        key=str.casefold,
    )
    if len(primary_batches) != 6:
        raise NestedLoboError(f"nested LOBO requires exactly six primary batches: {primary_batches}")
    if diagnostic_batches != ["new357"]:
        raise NestedLoboError(f"nested LOBO requires new357 as the sole diagnostic batch: {diagnostic_batches}")
    raw_folds = split.get("leaveOneBatchOut")
    if not isinstance(raw_folds, list):
        raise NestedLoboError("parent split contains no leaveOneBatchOut rows")
    folds_by_batch: dict[str, dict[str, Any]] = {}
    for raw in raw_folds:
        if not isinstance(raw, dict):
            raise NestedLoboError("parent split contains an invalid LOBO fold")
        batch_id = _required_text(raw, "batchId", "LOBO fold")
        if batch_id in folds_by_batch:
            raise NestedLoboError(f"parent split contains duplicate LOBO fold: {batch_id}")
        folds_by_batch[batch_id] = raw
    if set(folds_by_batch) != set(policies):
        raise NestedLoboError("LOBO folds do not match batch evidence policies")

    primary_folds: list[dict[str, Any]] = []
    diagnostic_folds: list[dict[str, Any]] = []
    primary_batch_set = {item.casefold() for item in primary_batches}
    for batch_id in sorted(folds_by_batch, key=str.casefold):
        fold = folds_by_batch[batch_id]
        raw_train = _fold_membership_list(fold, "developmentTrain")
        raw_tune = _fold_membership_list(fold, "developmentTune")
        raw_development = _fold_membership_list(fold, "development")
        holdout = _fold_membership_list(fold, "holdout")
        leakage = _fold_membership_list(fold, "excludedDevelopmentIsolationFamilyLeakage")
        train_keys = {item.casefold() for item in raw_train}
        tune_keys = {item.casefold() for item in raw_tune}
        development_keys = {item.casefold() for item in raw_development}
        holdout_keys = {item.casefold() for item in holdout}
        leakage_keys = {item.casefold() for item in leakage}
        if train_keys & tune_keys or train_keys & holdout_keys or tune_keys & holdout_keys:
            raise NestedLoboError(f"LOBO fold {batch_id} has train/tune/outer overlap")
        if train_keys | tune_keys != development_keys:
            raise NestedLoboError(f"LOBO fold {batch_id} development roster mismatch")
        if development_keys | holdout_keys | leakage_keys != all_ids:
            raise NestedLoboError(f"LOBO fold {batch_id} does not account for every parent instance")
        if (development_keys | holdout_keys) & leakage_keys:
            raise NestedLoboError(f"LOBO fold {batch_id} leakage roster overlaps active membership")
        for key in holdout_keys:
            row = instances.get(key)
            if row is None or normalize_name(row.get("batchId")) != batch_id.casefold():
                raise NestedLoboError(f"LOBO fold {batch_id} holdout contains another batch")
        effective_train = [
            item for item in raw_train if normalize_name(instances[item.casefold()].get("batchId")) in primary_batch_set
        ]
        effective_tune = [
            item for item in raw_tune if normalize_name(instances[item.casefold()].get("batchId")) in primary_batch_set
        ]
        filtered_train = sorted(set(raw_train) - set(effective_train), key=str.casefold)
        filtered_tune = sorted(set(raw_tune) - set(effective_tune), key=str.casefold)
        effective_train_keys = {item.casefold() for item in effective_train}
        effective_tune_keys = {item.casefold() for item in effective_tune}
        outer_families = {
            str(instances[key]["isolationFamilyId"]).casefold() for key in holdout_keys
        }
        development_families = {
            str(instances[key]["isolationFamilyId"]).casefold()
            for key in effective_train_keys | effective_tune_keys
        }
        if outer_families & development_families:
            raise NestedLoboError(f"LOBO fold {batch_id} leaks an outer isolation family")
        train_families = {
            str(instances[key]["isolationFamilyId"]).casefold()
            for key in effective_train_keys
        }
        tune_families = {
            str(instances[key]["isolationFamilyId"]).casefold()
            for key in effective_tune_keys
        }
        if train_families & tune_families:
            raise NestedLoboError(f"LOBO fold {batch_id} leaks an inner tune isolation family")
        expected_primary = batch_id in primary_batches
        expected_role = (
            "consumed-lobo-development-estimate"
            if expected_primary
            else "diagnostic-development-reference"
        )
        if fold.get("identityKey") != "instanceId" or fold.get("groupKey") != "isolationFamilyId":
            raise NestedLoboError(f"LOBO fold {batch_id} has invalid identity/group keys")
        if fold.get("freshProofEligible") is not False:
            raise NestedLoboError(f"LOBO fold {batch_id} must never be fresh-proof eligible")
        if str(fold.get("evaluationRole") or "") != expected_role:
            raise NestedLoboError(f"LOBO fold {batch_id} has an invalid evaluationRole")
        record = {
            "batchId": batch_id,
            "evaluationRole": str(fold.get("evaluationRole") or ""),
            "primaryAggregateEligible": bool(fold.get("primaryAggregateEligible")),
            "selectionEligible": expected_primary,
            "freshProofEligible": bool(fold.get("freshProofEligible")),
            "parentDevelopmentTrain": raw_train,
            "parentDevelopmentTune": raw_tune,
            "effectiveDevelopmentTrain": effective_train,
            "effectiveDevelopmentTune": effective_tune,
            "filteredDiagnosticTrain": filtered_train,
            "filteredDiagnosticTune": filtered_tune,
            "outerHoldout": holdout,
            "excludedDevelopmentIsolationFamilyLeakage": leakage,
        }
        for field in (
            "parentDevelopmentTrain",
            "parentDevelopmentTune",
            "effectiveDevelopmentTrain",
            "effectiveDevelopmentTune",
            "filteredDiagnosticTrain",
            "filteredDiagnosticTune",
            "outerHoldout",
            "excludedDevelopmentIsolationFamilyLeakage",
        ):
            record[f"{field}RosterSha256"] = instance_roster_sha256(record[field], instances)
            record[f"{field}TrackCount"] = len(record[field])
        record["foldMembershipSha256"] = sha256_json(
            {key: value for key, value in record.items() if not key.endswith("TrackCount")}
        )
        if expected_primary:
            if record["primaryAggregateEligible"] is not True:
                raise NestedLoboError(f"primary fold is not marked primary eligible: {batch_id}")
            expected_inner_batches = {item.casefold() for item in primary_batches if item != batch_id}
            actual_inner_batches = {
                normalize_name(instances[item.casefold()].get("batchId")) for item in effective_tune
            }
            if actual_inner_batches != expected_inner_batches:
                raise NestedLoboError(
                    f"LOBO fold {batch_id} effective tune misses a primary batch: "
                    f"expected={sorted(expected_inner_batches)}, actual={sorted(actual_inner_batches)}"
                )
            if any(
                normalize_name(instances[item.casefold()].get("batchId")) not in primary_batch_set
                for item in [*effective_train, *effective_tune]
            ):
                raise NestedLoboError(f"LOBO fold {batch_id} effective development contains diagnostic data")
            primary_folds.append(record)
        else:
            if batch_id != "new357" or record["primaryAggregateEligible"]:
                raise NestedLoboError(f"invalid diagnostic fold role: {batch_id}")
            diagnostic_folds.append(record)
    plan = {
        "schemaVersion": SCHEMA_VERSION,
        "primaryBatchIds": primary_batches,
        "diagnosticBatchIds": diagnostic_batches,
        "primaryFolds": primary_folds,
        "diagnosticFolds": diagnostic_folds,
    }
    return {**plan, "foldPlanSha256": sha256_json(plan)}


def _normalize_parameters(raw: Any) -> dict[str, float | int]:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise NestedLoboError("candidate parameters must be an object")
    unknown = sorted(set(raw) - set(PARAMETER_DEFAULTS))
    if unknown:
        raise NestedLoboError(f"candidate parameters contain unsupported fields: {unknown}")
    result: dict[str, float | int] = dict(PARAMETER_DEFAULTS)
    for field in ("minBpm", "maxBpm", "tempoStepBpm", "phaseStepMs"):
        if field in raw:
            result[field] = _finite_float(raw[field], field)
    for field in ("tempoLimit", "maxCandidates"):
        if field in raw:
            result[field] = _nonnegative_int(raw[field], field)
    if float(result["minBpm"]) <= 0.0 or float(result["maxBpm"]) <= float(result["minBpm"]):
        raise NestedLoboError("candidate BPM range is invalid")
    if float(result["tempoStepBpm"]) <= 0.0 or float(result["phaseStepMs"]) <= 0.0:
        raise NestedLoboError("candidate tempo/phase steps must be positive")
    if int(result["tempoLimit"]) <= 0 or int(result["maxCandidates"]) <= 0:
        raise NestedLoboError("candidate limits must be positive")
    return result


def normalize_candidate_manifest(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("type") != CANDIDATE_TYPE:
        raise NestedLoboError(f"candidate manifest type must be {CANDIDATE_TYPE}")
    raw_selection = payload.get("selectionPolicy")
    raw_aggregate = payload.get("aggregatePolicy")
    if not isinstance(raw_selection, dict) or not isinstance(raw_aggregate, dict):
        raise NestedLoboError("candidate manifest requires selectionPolicy and aggregatePolicy")
    objective = str(raw_selection.get("objectiveVersion") or "")
    if objective != SELECTION_OBJECTIVE_VERSION:
        raise NestedLoboError(f"unsupported selection objective: {objective}")
    selection_policy = {
        "objectiveVersion": objective,
        "maximumErrorTrackCount": _nonnegative_int(
            raw_selection.get("maximumErrorTrackCount"), "maximumErrorTrackCount"
        ),
        "maximumPassToFailRate": _rate(
            raw_selection.get("maximumPassToFailRate"), "maximumPassToFailRate"
        ),
        "maximumBpmBigErrorRateIncrease": _rate(
            raw_selection.get("maximumBpmBigErrorRateIncrease"),
            "maximumBpmBigErrorRateIncrease",
        ),
        "maximumDownbeatFailureRateIncrease": _rate(
            raw_selection.get("maximumDownbeatFailureRateIncrease"),
            "maximumDownbeatFailureRateIncrease",
        ),
    }
    aggregate_policy = {
        "maximumErrorTrackCount": _nonnegative_int(
            raw_aggregate.get("maximumErrorTrackCount"), "aggregate maximumErrorTrackCount"
        ),
        "minimumPositivePrimaryFoldCount": _nonnegative_int(
            raw_aggregate.get("minimumPositivePrimaryFoldCount"),
            "minimumPositivePrimaryFoldCount",
        ),
        "minimumMacroNetStrictAccuracyDeltaRate": _finite_float(
            raw_aggregate.get("minimumMacroNetStrictAccuracyDeltaRate"),
            "minimumMacroNetStrictAccuracyDeltaRate",
        ),
        "minimumWorstFoldNetStrictAccuracyDeltaRate": _finite_float(
            raw_aggregate.get("minimumWorstFoldNetStrictAccuracyDeltaRate"),
            "minimumWorstFoldNetStrictAccuracyDeltaRate",
        ),
        "maximumWorstFoldPassToFailRate": _rate(
            raw_aggregate.get("maximumWorstFoldPassToFailRate"),
            "maximumWorstFoldPassToFailRate",
        ),
        "maximumWorstFoldBpmBigErrorRateIncrease": _rate(
            raw_aggregate.get("maximumWorstFoldBpmBigErrorRateIncrease"),
            "maximumWorstFoldBpmBigErrorRateIncrease",
        ),
        "maximumWorstFoldDownbeatFailureRateIncrease": _rate(
            raw_aggregate.get("maximumWorstFoldDownbeatFailureRateIncrease"),
            "maximumWorstFoldDownbeatFailureRateIncrease",
        ),
    }
    if aggregate_policy["minimumPositivePrimaryFoldCount"] < 4:
        raise NestedLoboError("six-fold majority gate requires at least four positive primary folds")
    if aggregate_policy["maximumErrorTrackCount"] != 0:
        raise NestedLoboError("primary outer aggregate requires maximumErrorTrackCount = 0")
    raw_candidates = payload.get("candidates")
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise NestedLoboError("candidate manifest contains no candidates")
    if len(raw_candidates) > MAX_CANDIDATE_COUNT:
        raise NestedLoboError(
            f"candidate manifest exceeds the {MAX_CANDIDATE_COUNT}-candidate safety limit"
        )
    candidates: list[dict[str, Any]] = []
    ids: set[str] = set()
    config_hashes: set[str] = set()
    no_op_count = 0
    for raw in raw_candidates:
        if not isinstance(raw, dict):
            raise NestedLoboError("candidate manifest contains a non-object candidate")
        candidate_id = _required_text(raw, "candidateId", "candidate")
        if candidate_id.casefold() in ids:
            raise NestedLoboError(f"candidateId is duplicated: {candidate_id}")
        ids.add(candidate_id.casefold())
        mode = str(raw.get("mode") or "")
        if mode != SOLVER_MODE:
            raise NestedLoboError(
                f"candidate {candidate_id} must use fixed/no-fit mode {SOLVER_MODE}; no trainer API exists"
            )
        complexity_rank = _nonnegative_int(raw.get("complexityRank"), "complexityRank")
        is_no_op = raw.get("isNoOp") is True
        parameters = _normalize_parameters(raw.get("parameters"))
        execution_config = {
            "mode": mode,
            "fitMode": "fixed-no-fit",
            "parameters": parameters,
        }
        config = {
            "candidateId": candidate_id,
            **execution_config,
            "isNoOp": is_no_op,
            "complexityRank": complexity_rank,
        }
        config_sha256 = sha256_json(execution_config)
        if config_sha256 in config_hashes:
            raise NestedLoboError(
                f"candidate execution config is duplicated under another label: {candidate_id}"
            )
        config_hashes.add(config_sha256)
        candidates.append({**config, "configSha256": config_sha256})
        no_op_count += int(is_no_op)
    if no_op_count != 1:
        raise NestedLoboError("candidate set must contain exactly one explicit no-op baseline")
    no_op = next(item for item in candidates if item["isNoOp"])
    default_configs = [item for item in candidates if item["parameters"] == PARAMETER_DEFAULTS]
    if len(default_configs) != 1 or default_configs[0]["configSha256"] != no_op["configSha256"]:
        raise NestedLoboError("the unique default execution config must be the explicit no-op")
    if no_op["complexityRank"] != 0:
        raise NestedLoboError("no-op baseline must use current solver defaults with complexityRank 0")
    candidates.sort(key=lambda item: str(item["configSha256"]))
    normalized = {
        "schemaVersion": SCHEMA_VERSION,
        "type": CANDIDATE_TYPE,
        "selectionPolicy": selection_policy,
        "aggregatePolicy": aggregate_policy,
        "candidates": candidates,
    }
    return {
        **normalized,
        "selectionPolicySha256": sha256_json(selection_policy),
        "candidateSetSha256": sha256_json(candidates),
        "manifestContractSha256": sha256_json(normalized),
    }


def compact_outcome_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows)
    if total <= 0:
        raise NestedLoboError("compact outcome contains no rows")
    baseline_pass = 0
    selected_pass = 0
    fail_to_pass = 0
    pass_to_fail = 0
    switches = 0
    errors = 0
    baseline_errors = 0
    selected_errors = 0
    baseline_bpm_big = 0
    selected_bpm_big = 0
    baseline_downbeat_fail = 0
    selected_downbeat_fail = 0
    migrations: dict[str, int] = {}
    for row in rows:
        baseline = row.get("baseline") if isinstance(row.get("baseline"), dict) else {}
        selected = row.get("selected") if isinstance(row.get("selected"), dict) else {}
        baseline_category = str(baseline.get("category") or "error")
        selected_category = str(selected.get("category") or "error")
        baseline_error = baseline.get("hadError") is True or baseline_category == "error"
        selected_error = selected.get("hadError") is True or selected_category == "error"
        baseline_ok = baseline_category == "pass" and not baseline_error
        selected_ok = selected_category == "pass" and not selected_error
        baseline_pass += int(baseline_ok)
        selected_pass += int(selected_ok)
        comparable = not baseline_error and not selected_error
        fail_to_pass += int(comparable and not baseline_ok and selected_ok)
        pass_to_fail += int(comparable and baseline_ok and not selected_ok)
        switches += int(bool(row.get("switched")))
        baseline_errors += int(baseline_error)
        selected_errors += int(selected_error)
        errors += int(baseline_error or selected_error)
        baseline_bpm_big += int(bool(baseline.get("bpmBigError")))
        selected_bpm_big += int(bool(selected.get("bpmBigError")))
        baseline_downbeat_fail += int(bool(baseline.get("downbeatFailure")))
        selected_downbeat_fail += int(bool(selected.get("downbeatFailure")))
        migration = f"{baseline_category}->{selected_category}"
        migrations[migration] = migrations.get(migration, 0) + 1
    return {
        "trackCount": total,
        "baselinePassCount": baseline_pass,
        "selectedPassCount": selected_pass,
        "baselineStrictAccuracy": round(baseline_pass / total, 9),
        "selectedStrictAccuracy": round(selected_pass / total, 9),
        "netPassDelta": selected_pass - baseline_pass,
        "netStrictAccuracyDeltaRate": round((selected_pass - baseline_pass) / total, 9),
        "failToPassCount": fail_to_pass,
        "passToFailCount": pass_to_fail,
        "passToFailRate": round(pass_to_fail / total, 9),
        "switchCount": switches,
        "switchRate": round(switches / total, 9),
        "errorTrackCount": errors,
        "baselineErrorTrackCount": baseline_errors,
        "selectedErrorTrackCount": selected_errors,
        "errorRate": round(errors / total, 9),
        "baselineBpmBigErrorCount": baseline_bpm_big,
        "selectedBpmBigErrorCount": selected_bpm_big,
        "bpmBigErrorRateIncrease": round((selected_bpm_big - baseline_bpm_big) / total, 9),
        "baselineDownbeatFailureCount": baseline_downbeat_fail,
        "selectedDownbeatFailureCount": selected_downbeat_fail,
        "downbeatFailureRateIncrease": round(
            (selected_downbeat_fail - baseline_downbeat_fail) / total, 9
        ),
        "categoryMigration": dict(sorted(migrations.items())),
    }


def summarize_by_batch(
    rows: list[dict[str, Any]], expected_batch_ids: list[str]
) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {batch_id: [] for batch_id in expected_batch_ids}
    for row in rows:
        batch_id = str(row.get("batchId") or "")
        if batch_id not in groups:
            raise NestedLoboError(f"compact outcome contains forbidden tune batch: {batch_id}")
        groups[batch_id].append(row)
    if any(not rows_for_batch for rows_for_batch in groups.values()):
        missing = [batch_id for batch_id, values in groups.items() if not values]
        raise NestedLoboError(f"compact outcome misses primary tune batches: {missing}")
    return {batch_id: compact_outcome_metrics(groups[batch_id]) for batch_id in sorted(groups)}


def _catastrophic_count(by_batch: dict[str, dict[str, Any]], policy: dict[str, Any]) -> int:
    count = 0
    for metrics in by_batch.values():
        violated = (
            int(metrics["errorTrackCount"]) > int(policy["maximumErrorTrackCount"])
            or float(metrics["passToFailRate"]) > float(policy["maximumPassToFailRate"])
            or float(metrics["bpmBigErrorRateIncrease"])
            > float(policy["maximumBpmBigErrorRateIncrease"])
            or float(metrics["downbeatFailureRateIncrease"])
            > float(policy["maximumDownbeatFailureRateIncrease"])
        )
        count += int(violated)
    return count


def candidate_selection_summary(
    result: dict[str, Any], selection_policy: dict[str, Any]
) -> dict[str, Any]:
    by_batch = result.get("byBatch")
    if not isinstance(by_batch, dict) or not by_batch:
        raise NestedLoboError("candidate tune result has no per-batch metrics")
    metrics = [value for value in by_batch.values() if isinstance(value, dict)]
    if len(metrics) != len(by_batch):
        raise NestedLoboError("candidate tune result contains invalid per-batch metrics")
    deltas = [float(item["netStrictAccuracyDeltaRate"]) for item in metrics]
    return {
        "catastrophicViolationBatchCount": _catastrophic_count(by_batch, selection_policy),
        "worstNetStrictAccuracyDeltaRate": round(min(deltas), 9),
        "macroNetStrictAccuracyDeltaRate": round(sum(deltas) / len(deltas), 9),
        "positivePrimaryInnerBatchCount": sum(1 for value in deltas if value > 0.0),
        "macroPassToFailRate": round(
            sum(float(item["passToFailRate"]) for item in metrics) / len(metrics), 9
        ),
        "overallSwitchRate": float((result.get("overall") or {}).get("switchRate") or 0.0),
    }


def candidate_selection_key(
    result: dict[str, Any], selection_policy: dict[str, Any]
) -> tuple[Any, ...]:
    summary = candidate_selection_summary(result, selection_policy)
    return (
        int(summary["catastrophicViolationBatchCount"]),
        -float(summary["worstNetStrictAccuracyDeltaRate"]),
        -float(summary["macroNetStrictAccuracyDeltaRate"]),
        -int(summary["positivePrimaryInnerBatchCount"]),
        float(summary["macroPassToFailRate"]),
        float(summary["overallSwitchRate"]),
        int(result.get("complexityRank") or 0),
        str(result.get("configSha256") or ""),
    )


def select_candidate(
    results: list[dict[str, Any]],
    selection_policy: dict[str, Any],
    *,
    primary_batch_ids: list[str],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not results:
        raise NestedLoboError("selector received no candidate results")
    expected_batches = {str(item).casefold() for item in primary_batch_ids if str(item).strip()}
    if not expected_batches or len(expected_batches) != len(primary_batch_ids):
        raise NestedLoboError("selector primary batch allowlist is invalid")
    for result in results:
        by_batch = result.get("byBatch")
        if not isinstance(by_batch, dict):
            raise NestedLoboError("selector candidate result has no per-batch metrics")
        actual_batches = {str(item).casefold() for item in by_batch}
        if actual_batches != expected_batches or len(actual_batches) != len(by_batch):
            raise NestedLoboError(
                "selector candidate result does not exactly match the primary inner batch allowlist"
            )
    ordered = sorted(results, key=lambda item: candidate_selection_key(item, selection_policy))
    ranking = [
        {
            "rank": index,
            "candidateId": item["candidateId"],
            "configSha256": item["configSha256"],
            "complexityRank": item["complexityRank"],
            **candidate_selection_summary(item, selection_policy),
            "resultBodySha256": str((item.get("summary") or {}).get("resultBodySha256") or ""),
        }
        for index, item in enumerate(ordered, start=1)
    ]
    return ordered[0], ranking


def build_compact_result(
    *,
    result_type: str,
    provenance: dict[str, Any],
    candidate: dict[str, Any],
    rows: list[dict[str, Any]],
    expected_batch_ids: list[str] | None = None,
) -> dict[str, Any]:
    overall = compact_outcome_metrics(rows)
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "type": result_type,
        "provenance": provenance,
        "candidateId": candidate["candidateId"],
        "configSha256": candidate["configSha256"],
        "complexityRank": candidate["complexityRank"],
        "fitMode": candidate["fitMode"],
        "overall": overall,
        "byBatch": summarize_by_batch(rows, expected_batch_ids) if expected_batch_ids else {},
        "summary": {
            "trackTotal": len(rows),
            "errorTrackCount": overall["errorTrackCount"],
        },
        "tracks": sorted(rows, key=lambda item: str(item.get("instanceId") or "").casefold()),
        "errors": [],
    }
    return attach_benchmark_result_digest(payload)


def validate_compact_result(
    payload: dict[str, Any],
    *,
    expected_provenance: dict[str, Any],
    expected_instance_ids: list[str],
    expected_batch_ids: list[str] | None = None,
) -> None:
    validate_benchmark_result_digest(payload)
    if payload.get("provenance") != expected_provenance:
        raise NestedLoboError("compact result provenance mismatch")
    rows = payload.get("tracks")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise NestedLoboError("compact result tracks are invalid")
    actual_ids = [str(row.get("instanceId") or "").casefold() for row in rows]
    expected_ids = [str(item).casefold() for item in expected_instance_ids]
    if sorted(actual_ids) != sorted(expected_ids) or len(set(actual_ids)) != len(actual_ids):
        raise NestedLoboError("compact result identity roster mismatch")
    recomputed_overall = compact_outcome_metrics(rows)
    if payload.get("overall") != recomputed_overall:
        raise NestedLoboError("compact result overall metrics mismatch")
    if expected_batch_ids is not None:
        if payload.get("byBatch") != summarize_by_batch(rows, expected_batch_ids):
            raise NestedLoboError("compact result per-batch metrics mismatch")
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    if int(summary.get("trackTotal") or -1) != len(expected_instance_ids):
        raise NestedLoboError("compact result denominator mismatch")


def primary_aggregate(
    fold_results: list[dict[str, Any]],
    *,
    primary_batch_ids: list[str],
    aggregate_policy: dict[str, Any],
) -> dict[str, Any]:
    expected = sorted(primary_batch_ids, key=str.casefold)
    by_batch: dict[str, dict[str, Any]] = {}
    for result in fold_results:
        batch_id = str(result.get("batchId") or "")
        if batch_id in by_batch:
            raise NestedLoboError(f"primary aggregate contains duplicate fold: {batch_id}")
        if batch_id not in expected:
            raise NestedLoboError(f"primary aggregate contains diagnostic/unknown fold: {batch_id}")
        metrics = result.get("metrics")
        if not isinstance(metrics, dict):
            raise NestedLoboError(f"primary fold has no metrics: {batch_id}")
        by_batch[batch_id] = result
    if sorted(by_batch, key=str.casefold) != expected:
        raise NestedLoboError("primary aggregate is incomplete")
    metrics = [by_batch[batch_id]["metrics"] for batch_id in expected]
    deltas = [float(item["netStrictAccuracyDeltaRate"]) for item in metrics]
    baseline_rates = [float(item["baselineStrictAccuracy"]) for item in metrics]
    selected_rates = [float(item["selectedStrictAccuracy"]) for item in metrics]
    worst = sorted(
        by_batch.values(),
        key=lambda item: (
            float(item["metrics"]["netStrictAccuracyDeltaRate"]),
            -float(item["metrics"]["passToFailRate"]),
            str(item["batchId"]).casefold(),
        ),
    )[0]
    positive = sum(1 for value in deltas if value > 0.0)
    neutral = sum(1 for value in deltas if value == 0.0)
    negative = len(deltas) - positive - neutral
    macro_delta = round(sum(deltas) / len(deltas), 9)
    worst_metrics = worst["metrics"]
    max_pass_to_fail = max(
        by_batch.values(),
        key=lambda item: (
            float(item["metrics"]["passToFailRate"]),
            str(item["batchId"]).casefold(),
        ),
    )
    max_bpm_increase = max(
        by_batch.values(),
        key=lambda item: (
            float(item["metrics"]["bpmBigErrorRateIncrease"]),
            str(item["batchId"]).casefold(),
        ),
    )
    max_downbeat_increase = max(
        by_batch.values(),
        key=lambda item: (
            float(item["metrics"]["downbeatFailureRateIncrease"]),
            str(item["batchId"]).casefold(),
        ),
    )
    max_errors = max(
        by_batch.values(),
        key=lambda item: (
            int(item["metrics"]["errorTrackCount"]),
            str(item["batchId"]).casefold(),
        ),
    )
    gates = {
        "maximumErrorTrackCount": int(max_errors["metrics"]["errorTrackCount"])
        <= int(aggregate_policy["maximumErrorTrackCount"]),
        "minimumPositivePrimaryFoldCount": positive
        >= int(aggregate_policy["minimumPositivePrimaryFoldCount"]),
        "minimumMacroNetStrictAccuracyDeltaRate": macro_delta
        >= float(aggregate_policy["minimumMacroNetStrictAccuracyDeltaRate"]),
        "minimumWorstFoldNetStrictAccuracyDeltaRate": float(
            worst_metrics["netStrictAccuracyDeltaRate"]
        )
        >= float(aggregate_policy["minimumWorstFoldNetStrictAccuracyDeltaRate"]),
        "maximumWorstFoldPassToFailRate": float(
            max_pass_to_fail["metrics"]["passToFailRate"]
        )
        <= float(aggregate_policy["maximumWorstFoldPassToFailRate"]),
        "maximumWorstFoldBpmBigErrorRateIncrease": float(
            max_bpm_increase["metrics"]["bpmBigErrorRateIncrease"]
        )
        <= float(aggregate_policy["maximumWorstFoldBpmBigErrorRateIncrease"]),
        "maximumWorstFoldDownbeatFailureRateIncrease": float(
            max_downbeat_increase["metrics"]["downbeatFailureRateIncrease"]
        )
        <= float(aggregate_policy["maximumWorstFoldDownbeatFailureRateIncrease"]),
    }
    fold_digests = sorted(
        [
            {
                "batchId": batch_id,
                "resultBodySha256": str(by_batch[batch_id]["resultBodySha256"]),
            }
            for batch_id in expected
        ],
        key=lambda item: item["batchId"].casefold(),
    )
    aggregate = {
        "schemaVersion": SCHEMA_VERSION,
        "primaryFoldCount": len(expected),
        "completedPrimaryFoldCount": len(by_batch),
        "positivePrimaryFoldCount": positive,
        "neutralPrimaryFoldCount": neutral,
        "negativePrimaryFoldCount": negative,
        "majorityPositiveRequired": len(expected) // 2 + 1,
        "macroBaselineStrictAccuracy": round(sum(baseline_rates) / len(baseline_rates), 9),
        "macroSelectedStrictAccuracy": round(sum(selected_rates) / len(selected_rates), 9),
        "macroNetStrictAccuracyDeltaRate": macro_delta,
        "worstFold": {
            "batchId": worst["batchId"],
            "netStrictAccuracyDeltaRate": worst_metrics["netStrictAccuracyDeltaRate"],
            "passToFailRate": worst_metrics["passToFailRate"],
            "bpmBigErrorRateIncrease": worst_metrics["bpmBigErrorRateIncrease"],
            "downbeatFailureRateIncrease": worst_metrics["downbeatFailureRateIncrease"],
        },
        "maximumRegressions": {
            "errorTrackCount": {
                "batchId": max_errors["batchId"],
                "value": max_errors["metrics"]["errorTrackCount"],
            },
            "passToFailRate": {
                "batchId": max_pass_to_fail["batchId"],
                "value": max_pass_to_fail["metrics"]["passToFailRate"],
            },
            "bpmBigErrorRateIncrease": {
                "batchId": max_bpm_increase["batchId"],
                "value": max_bpm_increase["metrics"]["bpmBigErrorRateIncrease"],
            },
            "downbeatFailureRateIncrease": {
                "batchId": max_downbeat_increase["batchId"],
                "value": max_downbeat_increase["metrics"]["downbeatFailureRateIncrease"],
            },
        },
        "gates": gates,
        "passed": all(gates.values()),
        "foldResultDigests": fold_digests,
        "microTotalsDiagnosticOnly": {
            "trackCount": sum(int(item["trackCount"]) for item in metrics),
            "baselinePassCount": sum(int(item["baselinePassCount"]) for item in metrics),
            "selectedPassCount": sum(int(item["selectedPassCount"]) for item in metrics),
            "netPassDelta": sum(int(item["netPassDelta"]) for item in metrics),
        },
        "freshProofEligible": False,
    }
    return {**aggregate, "aggregateSha256": sha256_json(aggregate)}


def build_provenance(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = {"schemaVersion": SCHEMA_VERSION, **payload}
    return {**normalized, "provenanceSha256": sha256_json(normalized)}


def validate_provenance(payload: Any, expected: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise NestedLoboError("result is missing provenance")
    stored = {key: value for key, value in payload.items() if key != "provenanceSha256"}
    if payload.get("provenanceSha256") != sha256_json(stored) or payload != expected:
        raise NestedLoboError("result provenance is inconsistent or stale")


def stable_study_id(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > 96:
        raise NestedLoboError("studyId must contain 1-96 characters")
    if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in normalized):
        raise NestedLoboError("studyId contains unsupported characters")
    return normalized


def canonical_config_text(candidate: dict[str, Any]) -> str:
    return canonical_json(
        {key: value for key, value in candidate.items() if key != "configSha256"}
    )
