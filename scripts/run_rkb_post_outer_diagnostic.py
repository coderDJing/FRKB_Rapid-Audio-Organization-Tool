import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import run_rkb_nested_lobo as primary_runner
from rkb_dataset_contract import normalize_path, path_signature
from rkb_nested_lobo_contract import (
    NestedLoboError,
    POST_OUTER_DIAGNOSTIC_ROLE,
    read_json_object,
    sha256_json,
    stable_study_id,
    write_json_atomic,
    write_json_new,
)
from rkb_nested_lobo_diagnostic import (
    DIAGNOSTIC_FEATURE_CONTRACT_NAME,
    DIAGNOSTIC_REPORT_NAME,
    _diagnostic_feature_contract,
    execute_new357_diagnostic,
)
from rkb_nested_lobo_evaluator import validate_feature_contract
from rkb_nested_lobo_reporting import validate_existing_primary_report


REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_ROOT = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_PARENT_STUDY_ID = "rkb-primary-nested-lobo-v2-groot"
DEFAULT_DIAGNOSTIC_STUDY_ID = f"{DEFAULT_PARENT_STUDY_ID}-post-outer-new357-v1"
DEFAULT_WORK_ROOT = BENCHMARK_ROOT / "post-outer-diagnostics"
DIAGNOSTIC_LOCK_NAME = "diagnostic-study-lock.json"
STATE_NAME = "state.json"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _diagnostic_fold(inputs: dict[str, Any]) -> dict[str, Any]:
    folds = inputs["foldPlan"].get("diagnosticFolds")
    if not isinstance(folds, list) or len(folds) != 1:
        raise NestedLoboError("post-outer diagnostic requires exactly one frozen diagnostic fold")
    fold = folds[0]
    if not isinstance(fold, dict) or fold.get("batchId") != "new357":
        raise NestedLoboError("post-outer diagnostic is restricted to the frozen new357 batch")
    return fold


def _parent_work_dir(args: argparse.Namespace) -> Path:
    raw = str(args.parent_work_dir or "").strip()
    if raw:
        return Path(raw).resolve()
    return (primary_runner.DEFAULT_WORK_ROOT / args.parent_study_id).resolve()


def _diagnostic_work_dir(args: argparse.Namespace) -> Path:
    raw = str(args.work_dir or "").strip()
    if raw:
        return Path(raw).resolve()
    return (DEFAULT_WORK_ROOT / args.study_id).resolve()


def _require_same_text(
    actual: Any,
    expected: Any,
    field: str,
) -> None:
    if str(actual or "") != str(expected or ""):
        raise NestedLoboError(f"parent primary study {field} differs from the diagnostic input")


def _load_verified_parent(
    *,
    args: argparse.Namespace,
    inputs: dict[str, Any],
    parent_work_dir: Path,
) -> tuple[
    dict[str, Any],
    dict[str, Any],
    dict[str, dict[str, Any]],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
]:
    study_lock = read_json_object(parent_work_dir / primary_runner.STUDY_LOCK_NAME)
    locked = study_lock.get("locked")
    if not isinstance(locked, dict) or study_lock.get("lockHash") != sha256_json(locked):
        raise NestedLoboError("parent study lock digest is invalid")
    _require_same_text(locked.get("studyId"), args.parent_study_id, "studyId")
    _require_same_text(
        locked.get("parentSplitFileSha256"),
        inputs["splitSha256"],
        "parent split digest",
    )
    _require_same_text(
        locked.get("candidateSetSha256"),
        inputs["candidates"].get("candidateSetSha256"),
        "candidate-set digest",
    )
    _require_same_text(
        locked.get("foldPlanSha256"),
        inputs["foldPlan"].get("foldPlanSha256"),
        "fold-plan digest",
    )
    parent_state = read_json_object(parent_work_dir / primary_runner.STATE_NAME)
    if (
        parent_state.get("studyId") != args.parent_study_id
        or parent_state.get("studyLockHash") != study_lock["lockHash"]
        or parent_state.get("status") != "primary_complete"
    ):
        raise NestedLoboError("parent primary study is not an immutable completed primary result")
    primary_feature_contract = read_json_object(
        parent_work_dir / primary_runner.FEATURE_CONTRACT_NAME
    )
    validate_feature_contract(
        primary_feature_contract,
        expected_instance_ids=primary_runner._primary_instance_ids(inputs),
    )
    _require_same_text(
        primary_feature_contract.get("featureContractSha256"),
        locked.get("featureContractSha256"),
        "primary feature-contract digest",
    )
    selection_locks, selection_index = primary_runner._load_selection_locks(
        parent_work_dir,
        inputs["foldPlan"],
        study_lock,
    )
    primary_report, primary_aggregate = validate_existing_primary_report(
        report_path=parent_work_dir / primary_runner.PRIMARY_REPORT_NAME,
        work_dir=parent_work_dir,
        inputs=inputs,
        study_lock=study_lock,
        selection_index=selection_index,
        selection_locks=selection_locks,
    )
    return (
        study_lock,
        primary_feature_contract,
        selection_locks,
        selection_index,
        primary_report,
        primary_aggregate,
    )


def _diagnostic_lock(
    *,
    args: argparse.Namespace,
    inputs: dict[str, Any],
    parent_work_dir: Path,
    study_lock: dict[str, Any],
    primary_feature_contract: dict[str, Any],
    selection_locks: dict[str, dict[str, Any]],
    selection_index: dict[str, Any],
    primary_report: dict[str, Any],
    diagnostic_feature_contract: dict[str, Any],
) -> dict[str, Any]:
    diagnostic_fold = _diagnostic_fold(inputs)
    diagnostic_solver_contract = primary_runner._solver_contract()
    lock_payload = {
        "schemaVersion": 1,
        "type": "rkb-post-outer-diagnostic-lock",
        "studyId": stable_study_id(args.study_id),
        "evidenceRole": POST_OUTER_DIAGNOSTIC_ROLE,
        "parentStudy": {
            "studyId": study_lock["locked"]["studyId"],
            "workDir": normalize_path(parent_work_dir),
            "studyLockHash": study_lock["lockHash"],
            "primaryReportBodySha256": primary_report["summary"]["resultBodySha256"],
            "selectionPlanSha256": selection_index["selectionPlanSha256"],
            "solverContractSha256": study_lock["locked"]["solverContractSha256"],
        },
        "diagnosticRunner": path_signature(Path(__file__).resolve()),
        "diagnosticSolverContractSha256": diagnostic_solver_contract["solverContractSha256"],
        "diagnosticSolverMatchesPrimary": (
            diagnostic_solver_contract["solverContractSha256"]
            == study_lock["locked"]["solverContractSha256"]
        ),
        "primaryFeatureContractSha256": primary_feature_contract["featureContractSha256"],
        "featureGenerationPolicySha256": primary_feature_contract[
            "featureGenerationPolicySha256"
        ],
        "diagnosticFeatureContractSha256": diagnostic_feature_contract["featureContractSha256"],
        "diagnosticBatchId": "new357",
        "diagnosticRosterSha256": diagnostic_fold["outerHoldoutRosterSha256"],
        "selectionLockHashes": {
            batch_id: payload["lockHash"]
            for batch_id, payload in sorted(selection_locks.items(), key=lambda item: item[0].casefold())
        },
        "selectionPerformed": False,
        "primaryAggregateEligible": False,
        "freshProofEligible": False,
        "parameterSelectionAllowed": False,
    }
    return {
        "schemaVersion": 1,
        "type": "rkb-post-outer-diagnostic-study-lock",
        "locked": lock_payload,
        "lockHash": sha256_json(lock_payload),
    }


def _write_or_validate_lock(path: Path, expected: dict[str, Any]) -> None:
    if path.is_file():
        if read_json_object(path) != expected:
            raise NestedLoboError("post-outer diagnostic lock drifted; use a new diagnostic studyId")
        return
    write_json_new(path, expected)


def _write_running_state(
    *,
    state_path: Path,
    args: argparse.Namespace,
    diagnostic_lock: dict[str, Any],
    study_lock: dict[str, Any],
    selection_index: dict[str, Any],
    primary_report: dict[str, Any],
) -> None:
    if state_path.is_file():
        state = read_json_object(state_path)
        if (
            state.get("studyId") != args.study_id
            or state.get("diagnosticStudyLockHash") != diagnostic_lock["lockHash"]
            or state.get("status") != "diagnostic_running"
        ):
            raise NestedLoboError("diagnostic state belongs to another immutable run")
        return
    write_json_atomic(
        state_path,
        {
            "schemaVersion": 1,
            "studyId": args.study_id,
            "status": "diagnostic_running",
            "diagnosticStudyLockHash": diagnostic_lock["lockHash"],
            "parentStudyLockHash": study_lock["lockHash"],
            "selectionPlanSha256": selection_index["selectionPlanSha256"],
            "primaryReportBodySha256": primary_report["summary"]["resultBodySha256"],
            "updatedAt": _utc_now(),
        },
    )


def run(args: argparse.Namespace) -> dict[str, Any]:
    stable_study_id(args.study_id)
    stable_study_id(args.parent_study_id)
    inputs = primary_runner._load_metadata_inputs(args)
    parent_work_dir = _parent_work_dir(args)
    work_dir = _diagnostic_work_dir(args)
    if work_dir == parent_work_dir:
        raise NestedLoboError("post-outer diagnostic workDir must differ from the immutable parent study")
    report_path = work_dir / DIAGNOSTIC_REPORT_NAME
    if report_path.exists():
        raise NestedLoboError("post-outer diagnostic report is immutable and cannot be rerun")
    work_dir.mkdir(parents=True, exist_ok=True)
    (
        study_lock,
        primary_feature_contract,
        selection_locks,
        selection_index,
        primary_report,
        primary_aggregate,
    ) = _load_verified_parent(
        args=args,
        inputs=inputs,
        parent_work_dir=parent_work_dir,
    )
    diagnostic_fold = _diagnostic_fold(inputs)
    diagnostic_feature_contract, _ = _diagnostic_feature_contract(
        args=args,
        inputs=inputs,
        work_dir=work_dir,
        instance_ids=diagnostic_fold["outerHoldout"],
    )
    if (
        diagnostic_feature_contract.get("featureGenerationPolicySha256")
        != primary_feature_contract.get("featureGenerationPolicySha256")
    ):
        raise NestedLoboError(
            "new357 diagnostic feature policy differs from the immutable primary feature policy"
        )
    diagnostic_lock = _diagnostic_lock(
        args=args,
        inputs=inputs,
        parent_work_dir=parent_work_dir,
        study_lock=study_lock,
        primary_feature_contract=primary_feature_contract,
        selection_locks=selection_locks,
        selection_index=selection_index,
        primary_report=primary_report,
        diagnostic_feature_contract=diagnostic_feature_contract,
    )
    _write_or_validate_lock(work_dir / DIAGNOSTIC_LOCK_NAME, diagnostic_lock)
    state_path = work_dir / STATE_NAME
    _write_running_state(
        state_path=state_path,
        args=args,
        diagnostic_lock=diagnostic_lock,
        study_lock=study_lock,
        selection_index=selection_index,
        primary_report=primary_report,
    )
    context = {
        "diagnosticStudyLockHash": diagnostic_lock["lockHash"],
        "diagnosticSolverContractSha256": diagnostic_lock["locked"][
            "diagnosticSolverContractSha256"
        ],
        "diagnosticSolverMatchesPrimary": diagnostic_lock["locked"][
            "diagnosticSolverMatchesPrimary"
        ],
        "parentStudyId": study_lock["locked"]["studyId"],
        "parentStudyLockHash": study_lock["lockHash"],
        "parameterSelectionAllowed": False,
    }
    return execute_new357_diagnostic(
        args=args,
        inputs=inputs,
        work_dir=work_dir,
        study_lock=study_lock,
        selection_index=selection_index,
        selection_locks=selection_locks,
        primary_report=primary_report,
        primary_aggregate=primary_aggregate,
        state_path=state_path,
        primary_feature_contract=primary_feature_contract,
        diagnostic_context=context,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a sealed post-outer new357 diagnostic without modifying its primary study"
    )
    parser.add_argument("--study-id", default=DEFAULT_DIAGNOSTIC_STUDY_ID)
    parser.add_argument("--parent-study-id", default=DEFAULT_PARENT_STUDY_ID)
    parser.add_argument("--parent-work-dir", default="")
    parser.add_argument("--work-dir", default="")
    parser.add_argument("--splits", default=str(primary_runner.DEFAULT_SPLITS))
    parser.add_argument("--candidates", required=True)
    parser.add_argument("--feature-cache-dir", action="append", default=[])
    parser.add_argument("--ffprobe", default=str(primary_runner.DEFAULT_FFPROBE))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if not args.feature_cache_dir:
        print("error: post-outer diagnostic requires at least one --feature-cache-dir", file=sys.stderr)
        return 1
    try:
        payload = run(args)
    except NestedLoboError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
