import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from rkb_dataset_contract import (
    attach_benchmark_result_digest,
    normalize_path,
    path_signature,
    sha256_file,
    sha256_json,
)
from rkb_nested_lobo_contract import (
    POST_OUTER_DIAGNOSTIC_ROLE,
    PRIMARY_EVIDENCE_ROLE,
    NestedLoboError,
    build_compact_result,
    build_fold_plan,
    normalize_candidate_manifest,
    primary_estimate_eligible,
    primary_aggregate,
    read_json_object,
    select_candidate,
    stable_study_id,
    validate_compact_result,
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
from rkb_nested_lobo_diagnostic import DIAGNOSTIC_REPORT_NAME, execute_new357_diagnostic
from rkb_nested_lobo_ledger import (
    EXPOSURE_EVENTS,
    append_exposure_event,
    guard_ledger,
    load_ledger,
    load_or_initialize_ledger_for_select,
    validate_ledger_covers_prior_artifacts,
)
from rkb_nested_lobo_selection import (
    fit_artifact,
    revalidate_selection_evidence,
    selection_lock_expected,
    tune_provenance,
)
from rkb_nested_lobo_reporting import outer_provenance, validate_existing_primary_report
from rkb_sealed_batch_common import (
    SealedBatchError,
    _python_runtime_payload,
    collect_dependency_files,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_ROOT = REPO_ROOT / "scripts"
BENCHMARK_ROOT = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_SPLITS = BENCHMARK_ROOT / "rkb-dataset-splits-current.json"
DEFAULT_WORK_ROOT = BENCHMARK_ROOT / "nested-lobo"
DEFAULT_LEDGER = BENCHMARK_ROOT / "nested-lobo-outer-exposure-ledger.json"
DEFAULT_FFPROBE = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffprobe.exe"
STUDY_LOCK_NAME = "study-lock.json"
FOLD_PLAN_NAME = "fold-plan.json"
FEATURE_CONTRACT_NAME = "feature-contract-primary.json"
STATE_NAME = "state.json"
SELECTION_INDEX_NAME = "selection-index.json"
PRIMARY_REPORT_NAME = "primary-report.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _candidate_by_hash(candidates: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item["configSha256"]): item for item in candidates["candidates"]}


def _baseline_candidate(candidates: dict[str, Any]) -> dict[str, Any]:
    rows = [item for item in candidates["candidates"] if item.get("isNoOp") is True]
    if len(rows) != 1:
        raise NestedLoboError("candidate contract contains no unique no-op baseline")
    return rows[0]


def _load_metadata_inputs(args: argparse.Namespace) -> dict[str, Any]:
    split_path = Path(args.splits).resolve()
    candidate_path = Path(args.candidates).resolve()
    if not split_path.is_file() or not candidate_path.is_file():
        raise NestedLoboError("split/candidate manifest is missing")
    split = read_json_object(split_path)
    fold_plan = build_fold_plan(split)
    candidates = normalize_candidate_manifest(read_json_object(candidate_path))
    return {
        "splitPath": split_path,
        "splitSha256": sha256_file(split_path),
        "split": split,
        "foldPlan": fold_plan,
        "candidatePath": candidate_path,
        "candidates": candidates,
    }


def _instance_catalog(inputs: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = inputs["split"].get("instances")
    if not isinstance(rows, list):
        raise NestedLoboError("parent split contains no instance metadata")
    catalog: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise NestedLoboError("parent split contains invalid instance metadata")
        instance_id = str(row.get("instanceId") or "").strip()
        key = instance_id.casefold()
        if not key or key in catalog:
            raise NestedLoboError(f"parent split contains invalid/duplicate instanceId: {instance_id}")
        catalog[key] = row
    return catalog


def _primary_instance_ids(inputs: dict[str, Any]) -> list[str]:
    primary = {str(item).casefold() for item in inputs["foldPlan"]["primaryBatchIds"]}
    return sorted(
        [
            str(track["instanceId"])
            for track in _instance_catalog(inputs).values()
            if str(track.get("batchId") or "").casefold() in primary
        ],
        key=str.casefold,
    )


def _solver_contract() -> dict[str, Any]:
    entrypoints = [
        Path(__file__).resolve(),
        SCRIPTS_ROOT / "rkb_nested_lobo_contract.py",
        SCRIPTS_ROOT / "rkb_nested_lobo_evaluator.py",
        SCRIPTS_ROOT / "rkb_constant_grid_dp_solver.py",
        SCRIPTS_ROOT / "models" / "rkb-official-downbeat-rotation-candidate-v1.json",
        SCRIPTS_ROOT / "rkb_beatgrid_candidate_lab.py",
    ]
    dependencies = collect_dependency_files(entrypoints, SCRIPTS_ROOT)
    signatures = [path_signature(path) for path in dependencies]
    signatures.sort(key=lambda item: str(item.get("path") or ""))
    try:
        runtime = _python_runtime_payload(str(Path(sys.executable).resolve()))
    except SealedBatchError as error:
        raise NestedLoboError(f"failed to lock nested LOBO Python runtime: {error}") from error
    payload = {
        "entrypoints": [normalize_path(path) for path in entrypoints],
        "dependencies": signatures,
        "python": path_signature(Path(sys.executable)),
        "runtime": runtime,
        "numpyVersion": str(np.__version__),
    }
    return {**payload, "solverContractSha256": sha256_json(payload)}


def _dataset_contract(inputs: dict[str, Any]) -> dict[str, Any]:
    split = inputs["split"]
    primary_batches = {
        str(item).casefold() for item in inputs["foldPlan"]["primaryBatchIds"]
    }
    primary_instances = [
        row
        for row in _instance_catalog(inputs).values()
        if str(row.get("batchId") or "").casefold() in primary_batches
    ]
    evidence_universe = {
        "instanceIds": sorted(
            {str(row.get("instanceId") or "").casefold() for row in primary_instances}
        ),
        "assetSha256s": sorted(
            {str(row.get("assetSha256") or "").casefold() for row in primary_instances}
        ),
        "pcmSha256s": sorted(
            {str(row.get("pcmSha256") or "").casefold() for row in primary_instances}
        ),
        "familyIds": sorted(
            {str(row.get("familyId") or "").casefold() for row in primary_instances}
        ),
        "isolationFamilyIds": sorted(
            {str(row.get("isolationFamilyId") or "").casefold() for row in primary_instances}
        ),
    }
    if any(not values or "" in values for values in evidence_universe.values()):
        raise NestedLoboError("primary evidence universe contains missing identity fields")
    payload = {
        "parentSplitPath": normalize_path(inputs["splitPath"]),
        "parentSplitFileSha256": inputs["splitSha256"],
        "registrySha256": str(split.get("registrySha256") or ""),
        "truthSourcesSha256": str(split.get("truthSourcesSha256") or ""),
        "assignmentDigestSha256": str(split.get("assignmentDigestSha256") or ""),
        "splitAssignmentsSha256": str(split.get("splitAssignmentsSha256") or ""),
        "audioIsolationPolicySha256": str(split.get("audioIsolationPolicySha256") or ""),
        "primaryEvidenceUniverse": evidence_universe,
        "primaryEvidenceUniverseSha256": sha256_json(evidence_universe),
    }
    return {**payload, "datasetContractSha256": sha256_json(payload)}


def _ensure_scoped_feature_contract(
    args: argparse.Namespace,
    inputs: dict[str, Any],
    work_dir: Path,
    *,
    file_name: str,
    instance_ids: list[str],
    scope: str,
    create: bool,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    path = work_dir / file_name
    if path.is_file():
        payload = read_json_object(path)
    elif create:
        payload = build_feature_contract(
            cache_dirs=[Path(item).resolve() for item in args.feature_cache_dir],
            instance_ids=instance_ids,
            catalog=_instance_catalog(inputs),
            output_path=path,
            scope=scope,
        )
    else:
        raise NestedLoboError(f"primary feature contract is missing: {path}")
    rows = validate_feature_contract(payload, expected_instance_ids=instance_ids)
    return payload, rows


def _ensure_feature_contract(
    args: argparse.Namespace,
    inputs: dict[str, Any],
    work_dir: Path,
    *,
    create: bool,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    return _ensure_scoped_feature_contract(
        args,
        inputs,
        work_dir,
        file_name=FEATURE_CONTRACT_NAME,
        instance_ids=_primary_instance_ids(inputs),
        scope="primary-batches-only",
        create=create,
    )


def _study_locked_payload(
    args: argparse.Namespace,
    inputs: dict[str, Any],
    feature_contract: dict[str, Any],
    work_dir: Path,
    ledger: dict[str, Any],
) -> dict[str, Any]:
    candidates = inputs["candidates"]
    dataset = _dataset_contract(inputs)
    solver = _solver_contract()
    work_dir_path = normalize_path(work_dir)
    ledger_path = normalize_path(Path(args.ledger).resolve())
    run_identity = {
        "studyId": stable_study_id(args.study_id),
        "workDir": work_dir_path,
        "ledgerPath": ledger_path,
        "ledgerId": str(ledger["ledgerId"]),
        "ledgerGenesisSha256": str(ledger["genesisSha256"]),
        "datasetContractSha256": dataset["datasetContractSha256"],
        "candidateSetSha256": candidates["candidateSetSha256"],
        "featureContractSha256": feature_contract["featureContractSha256"],
        "primaryFeatureGenerationPolicySha256": feature_contract[
            "featureGenerationPolicySha256"
        ],
        "foldPlanSha256": inputs["foldPlan"]["foldPlanSha256"],
    }
    return {
        "schemaVersion": 1,
        "studyId": stable_study_id(args.study_id),
        "evidenceRole": str(args.evidence_role),
        "workDir": work_dir_path,
        "ledgerPath": ledger_path,
        "ledgerId": str(ledger["ledgerId"]),
        "ledgerGenesisSha256": str(ledger["genesisSha256"]),
        "runIdentitySha256": sha256_json(run_identity),
        **dataset,
        "candidateSetSha256": candidates["candidateSetSha256"],
        "candidateManifestContractSha256": candidates["manifestContractSha256"],
        "featureContractSha256": feature_contract["featureContractSha256"],
        "solverContractSha256": solver["solverContractSha256"],
        "runtime": solver["runtime"],
        "ffprobe": path_signature(Path(args.ffprobe).resolve()),
        "selectionPolicy": candidates["selectionPolicy"],
        "selectionPolicySha256": candidates["selectionPolicySha256"],
        "aggregatePolicy": candidates["aggregatePolicy"],
        "foldPlanSha256": inputs["foldPlan"]["foldPlanSha256"],
        "primaryFoldIds": inputs["foldPlan"]["primaryBatchIds"],
        "diagnosticFoldIds": inputs["foldPlan"]["diagnosticBatchIds"],
        "outerResultsMayTuneRules": False,
        "freshProofEligible": False,
        "fixedNoFitOnly": True,
    }


def _ensure_study_lock(
    args: argparse.Namespace,
    inputs: dict[str, Any],
    feature_contract: dict[str, Any],
    work_dir: Path,
    ledger: dict[str, Any],
    *,
    create: bool,
) -> dict[str, Any]:
    locked = _study_locked_payload(args, inputs, feature_contract, work_dir, ledger)
    expected = {
        "schemaVersion": 1,
        "type": "rkb-nested-lobo-study-lock",
        "locked": locked,
        "lockHash": sha256_json(locked),
    }
    path = work_dir / STUDY_LOCK_NAME
    if path.is_file():
        actual = read_json_object(path)
        if actual != expected:
            raise NestedLoboError("study lock drifted; use a new studyId/work directory")
        return actual
    if not create:
        raise NestedLoboError(f"study lock is missing: {path}")
    write_json_new(path, expected)
    return expected


def _write_or_validate_immutable(path: Path, expected: dict[str, Any]) -> None:
    if path.is_file():
        if read_json_object(path) != expected:
            raise NestedLoboError(f"immutable artifact drifted: {path}")
    else:
        write_json_new(path, expected)


def run_select(args: argparse.Namespace) -> dict[str, Any]:
    inputs = _load_metadata_inputs(args)
    work_dir = Path(args.work_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    study_lock_path = work_dir / STUDY_LOCK_NAME
    if args.resume and not study_lock_path.is_file():
        raise NestedLoboError("selection resume requires an existing study lock in the same workDir")
    if not args.resume and study_lock_path.exists():
        raise NestedLoboError("study already exists; use --resume only for incomplete selection")
    ledger_path = Path(args.ledger).resolve()
    if args.resume:
        ledger = load_ledger(ledger_path)
    else:
        dataset = _dataset_contract(inputs)
        ledger = load_or_initialize_ledger_for_select(
            ledger_path,
            benchmark_root=BENCHMARK_ROOT,
            dataset_contract_sha256=dataset["datasetContractSha256"],
            primary_evidence_universe=dataset["primaryEvidenceUniverse"],
            study_lock_name=STUDY_LOCK_NAME,
            state_name=STATE_NAME,
            primary_report_name=PRIMARY_REPORT_NAME,
        )
    feature_contract, feature_rows = _ensure_feature_contract(
        args, inputs, work_dir, create=True
    )
    study_lock = _ensure_study_lock(
        args, inputs, feature_contract, work_dir, ledger, create=True
    )
    validate_ledger_covers_prior_artifacts(
        ledger,
        benchmark_root=BENCHMARK_ROOT,
        dataset_contract_sha256=study_lock["locked"]["datasetContractSha256"],
        primary_evidence_universe=study_lock["locked"]["primaryEvidenceUniverse"],
        study_lock_name=STUDY_LOCK_NAME,
        state_name=STATE_NAME,
        primary_report_name=PRIMARY_REPORT_NAME,
    )
    state_path = work_dir / STATE_NAME
    if state_path.is_file():
        state = read_json_object(state_path)
        if (
            state.get("studyLockHash") != study_lock["lockHash"]
            or state.get("studyId") != args.study_id
        ):
            raise NestedLoboError("study state belongs to another immutable run")
        if not args.resume:
            raise NestedLoboError("study already exists; use --resume only for incomplete selection")
        if state.get("status") != "selection_running":
            raise NestedLoboError(
                f"selection cannot resume from state {state.get('status')!r}; state transitions are one-way"
            )
    elif not args.resume and any(work_dir.iterdir()):
        allowed = {FEATURE_CONTRACT_NAME, STUDY_LOCK_NAME}
        unexpected = [path.name for path in work_dir.iterdir() if path.name not in allowed]
        if unexpected:
            raise NestedLoboError(f"fresh selection workDir is not empty: {sorted(unexpected)}")
    write_json_atomic(
        state_path,
        {
            "schemaVersion": 1,
            "studyId": args.study_id,
            "status": "selection_running",
            "studyLockHash": study_lock["lockHash"],
            "updatedAt": utc_now(),
        },
    )
    write_json_atomic(work_dir / FOLD_PLAN_NAME, inputs["foldPlan"])
    time_basis_cache: dict[str, dict[str, Any]] = {}
    selection_locks: list[dict[str, Any]] = []
    candidate_by_hash = _candidate_by_hash(inputs["candidates"])
    for fold in inputs["foldPlan"]["primaryFolds"]:
        fold_dir = work_dir / "folds" / str(fold["batchId"])
        fold_dir.mkdir(parents=True, exist_ok=True)
        fit_artifacts: dict[str, dict[str, Any]] = {}
        for candidate in inputs["candidates"]["candidates"]:
            fit = fit_artifact(study_lock=study_lock, fold=fold, candidate=candidate)
            fit_path = fold_dir / "fit" / f"{candidate['configSha256']}.json"
            _write_or_validate_immutable(fit_path, fit)
            fit_artifacts[str(candidate["configSha256"])] = fit
        tune_path = fold_dir / "truth-development-tune.json"
        tune_catalog = load_truth_catalog(
            inputs["splitPath"],
            inputs["split"],
            instance_ids=fold["effectiveDevelopmentTune"],
        )
        _, truth_contract, tune_tracks = materialize_subset_truth(
            instance_ids=fold["effectiveDevelopmentTune"],
            catalog=tune_catalog,
            output_path=tune_path,
            split_path=inputs["splitPath"],
            split_sha256=inputs["splitSha256"],
            fold_batch_id=str(fold["batchId"]),
            role="effective-development-tune",
            membership_sha256=fold["effectiveDevelopmentTuneRosterSha256"],
            ffprobe_path=Path(args.ffprobe).resolve(),
            time_basis_cache=time_basis_cache,
        )
        expected_inner_batches = [
            batch_id
            for batch_id in inputs["foldPlan"]["primaryBatchIds"]
            if batch_id != fold["batchId"]
        ]
        result_payloads: dict[str, dict[str, Any]] = {}
        missing_candidates: list[dict[str, Any]] = []
        for candidate in inputs["candidates"]["candidates"]:
            config_sha = str(candidate["configSha256"])
            result_path = fold_dir / "tune-results" / f"{config_sha}.json"
            provenance = tune_provenance(
                study_lock=study_lock,
                fold=fold,
                candidate=candidate,
                fit=fit_artifacts[config_sha],
                truth_contract=truth_contract,
            )
            if result_path.is_file():
                payload = read_json_object(result_path)
                validate_compact_result(
                    payload,
                    expected_provenance=provenance,
                    expected_instance_ids=fold["effectiveDevelopmentTune"],
                    expected_batch_ids=expected_inner_batches,
                )
                result_payloads[config_sha] = payload
            else:
                missing_candidates.append(candidate)
        if missing_candidates:
            baseline = _baseline_candidate(inputs["candidates"])
            configs_to_run = list(missing_candidates)
            if all(item["configSha256"] != baseline["configSha256"] for item in configs_to_run):
                configs_to_run.append(baseline)
            evaluated = evaluate_fixed_configs(
                tracks=tune_tracks,
                candidates=configs_to_run,
                feature_contract_rows=feature_rows,
            )
            for candidate in missing_candidates:
                config_sha = str(candidate["configSha256"])
                provenance = tune_provenance(
                    study_lock=study_lock,
                    fold=fold,
                    candidate=candidate,
                    fit=fit_artifacts[config_sha],
                    truth_contract=truth_contract,
                )
                payload = build_compact_result(
                    result_type="rkb-nested-lobo-tune-result",
                    provenance=provenance,
                    candidate=candidate,
                    rows=evaluated[config_sha],
                    expected_batch_ids=expected_inner_batches,
                )
                result_path = fold_dir / "tune-results" / f"{config_sha}.json"
                write_json_new(result_path, payload)
                result_payloads[config_sha] = payload
        selector_inputs = [result_payloads[key] for key in sorted(candidate_by_hash)]
        selected, ranking = select_candidate(
            selector_inputs,
            inputs["candidates"]["selectionPolicy"],
            primary_batch_ids=expected_inner_batches,
        )
        selected_candidate = candidate_by_hash[str(selected["configSha256"])]
        selected_fit = fit_artifacts[str(selected["configSha256"])]
        result_digests = [
            {
                "configSha256": config_sha,
                "resultBodySha256": str(payload["summary"]["resultBodySha256"]),
            }
            for config_sha, payload in result_payloads.items()
        ]
        selection_lock = selection_lock_expected(
            study_lock=study_lock,
            fold=fold,
            selected=selected_candidate,
            ranking=ranking,
            fit=selected_fit,
            result_digests=result_digests,
        )
        selection_path = fold_dir / "selection-lock.json"
        _write_or_validate_immutable(selection_path, selection_lock)
        selection_locks.append(selection_lock)
    index_locked = {
        "schemaVersion": 1,
        "studyLockHash": study_lock["lockHash"],
        "foldSelectionLocks": sorted(
            [
                {
                    "batchId": lock["locked"]["foldBatchId"],
                    "selectionLockHash": lock["lockHash"],
                    "selectedConfigSha256": lock["locked"]["selectedConfigSha256"],
                }
                for lock in selection_locks
            ],
            key=lambda item: item["batchId"].casefold(),
        ),
    }
    selection_index = {
        "schemaVersion": 1,
        "type": "rkb-nested-lobo-selection-index",
        "locked": index_locked,
        "selectionPlanSha256": sha256_json(index_locked),
    }
    _write_or_validate_immutable(work_dir / SELECTION_INDEX_NAME, selection_index)
    append_exposure_event(
        ledger_path=ledger_path,
        ledger=ledger,
        study_lock=study_lock,
        selection_index=selection_index,
        fold_batch_id="*",
        event="selections-locked",
    )
    write_json_atomic(
        state_path,
        {
            "schemaVersion": 1,
            "studyId": args.study_id,
            "status": "primary_selections_locked",
            "studyLockHash": study_lock["lockHash"],
            "selectionPlanSha256": selection_index["selectionPlanSha256"],
            "updatedAt": utc_now(),
        },
    )
    return {
        "studyId": args.study_id,
        "status": "primary_selections_locked",
        "selectionPlanSha256": selection_index["selectionPlanSha256"],
        "primaryFoldCount": len(selection_locks),
    }


def _load_selection_locks(
    work_dir: Path,
    fold_plan: dict[str, Any],
    study_lock: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    index = read_json_object(work_dir / SELECTION_INDEX_NAME)
    locked = index.get("locked") if isinstance(index.get("locked"), dict) else {}
    if index.get("selectionPlanSha256") != sha256_json(locked):
        raise NestedLoboError("selection index digest mismatch")
    if locked.get("studyLockHash") != study_lock["lockHash"]:
        raise NestedLoboError("selection index belongs to another study lock")
    selection_locks: dict[str, dict[str, Any]] = {}
    for fold in fold_plan["primaryFolds"]:
        path = work_dir / "folds" / str(fold["batchId"]) / "selection-lock.json"
        payload = read_json_object(path)
        lock_payload = payload.get("locked") if isinstance(payload.get("locked"), dict) else {}
        if payload.get("lockHash") != sha256_json(lock_payload):
            raise NestedLoboError(f"selection lock digest mismatch: {fold['batchId']}")
        if (
            lock_payload.get("studyLockHash") != study_lock["lockHash"]
            or lock_payload.get("foldMembershipSha256") != fold["foldMembershipSha256"]
        ):
            raise NestedLoboError(f"selection lock provenance mismatch: {fold['batchId']}")
        selection_locks[str(fold["batchId"])] = payload
    expected_index_rows = sorted(
        [
            {
                "batchId": batch_id,
                "selectionLockHash": payload["lockHash"],
                "selectedConfigSha256": payload["locked"]["selectedConfigSha256"],
            }
            for batch_id, payload in selection_locks.items()
        ],
        key=lambda item: item["batchId"].casefold(),
    )
    if locked.get("foldSelectionLocks") != expected_index_rows:
        raise NestedLoboError("selection index does not cover the six immutable fold selections")
    return selection_locks, index


def run_evaluate(args: argparse.Namespace) -> dict[str, Any]:
    inputs = _load_metadata_inputs(args)
    work_dir = Path(args.work_dir).resolve()
    report_path = work_dir / PRIMARY_REPORT_NAME
    ledger_path = Path(args.ledger).resolve()
    ledger = load_ledger(ledger_path)
    feature_contract, feature_rows = _ensure_feature_contract(
        args, inputs, work_dir, create=False
    )
    study_lock = _ensure_study_lock(
        args, inputs, feature_contract, work_dir, ledger, create=False
    )
    selection_locks, selection_index = _load_selection_locks(
        work_dir, inputs["foldPlan"], study_lock
    )
    validate_ledger_covers_prior_artifacts(
        ledger,
        benchmark_root=BENCHMARK_ROOT,
        dataset_contract_sha256=study_lock["locked"]["datasetContractSha256"],
        primary_evidence_universe=study_lock["locked"]["primaryEvidenceUniverse"],
        study_lock_name=STUDY_LOCK_NAME,
        state_name=STATE_NAME,
        primary_report_name=PRIMARY_REPORT_NAME,
    )
    guard_ledger(
        ledger=ledger,
        dataset_contract_sha256=study_lock["locked"]["datasetContractSha256"],
        study_lock=study_lock,
        selection_plan_sha256=selection_index["selectionPlanSha256"],
    )
    revalidate_selection_evidence(
        work_dir=work_dir,
        inputs=inputs,
        study_lock=study_lock,
        selection_locks=selection_locks,
    )
    state_path = work_dir / STATE_NAME
    state = read_json_object(state_path)
    if (
        state.get("studyId") != args.study_id
        or state.get("studyLockHash") != study_lock["lockHash"]
    ):
        raise NestedLoboError("study state belongs to another immutable run")
    completed_events = [
        event
        for event in ledger["events"]
        if isinstance(event, dict)
        and event.get("studyLockHash") == study_lock["lockHash"]
        and event.get("event") == "primary-complete"
    ]
    if len(completed_events) > 1:
        raise NestedLoboError("outer exposure ledger contains duplicate primary-complete events")
    if report_path.exists():
        if not args.resume or state.get("status") != "outer_running":
            raise NestedLoboError("primary outer report is complete and cannot be rerun")
        report, aggregate = validate_existing_primary_report(
            report_path=report_path,
            work_dir=work_dir,
            inputs=inputs,
            study_lock=study_lock,
            selection_index=selection_index,
            selection_locks=selection_locks,
        )
        completion_details = {
            "primaryReportBodySha256": report["summary"]["resultBodySha256"],
            "aggregateSha256": aggregate["aggregateSha256"],
        }
        if completed_events:
            if completed_events[0].get("details") != completion_details:
                raise NestedLoboError("primary-complete ledger event does not match the report")
        else:
            append_exposure_event(
                ledger_path=ledger_path,
                ledger=ledger,
                study_lock=study_lock,
                selection_index=selection_index,
                fold_batch_id="*",
                event="primary-complete",
                event_details=completion_details,
            )
        write_json_atomic(
            state_path,
            {
                "schemaVersion": 1,
                "studyId": args.study_id,
                "status": "primary_complete",
                "studyLockHash": study_lock["lockHash"],
                "selectionPlanSha256": selection_index["selectionPlanSha256"],
                "primaryReportBodySha256": report["summary"]["resultBodySha256"],
                "updatedAt": utc_now(),
            },
        )
        return {
            "studyId": args.study_id,
            "status": "primary_complete",
            "primaryNestedEstimateEligible": report["primaryNestedEstimateEligible"],
            "aggregate": aggregate,
            "report": str(report_path),
            "resumedFinalizationOnly": True,
        }
    if completed_events:
        raise NestedLoboError("ledger marks primary complete but the immutable primary report is missing")
    prior_exposure = any(
        isinstance(event, dict)
        and event.get("studyLockHash") == study_lock["lockHash"]
        and event.get("event") in EXPOSURE_EVENTS
        for event in ledger["events"]
    )
    if prior_exposure and not args.resume:
        raise NestedLoboError("outer evaluation was already exposed; use --resume for an incomplete study")
    expected_state = "outer_running" if args.resume else "primary_selections_locked"
    if state.get("status") != expected_state:
        raise NestedLoboError(
            f"evaluate cannot {'resume' if args.resume else 'start'} from state "
            f"{state.get('status')!r}; expected {expected_state!r}"
        )
    write_json_atomic(
        state_path,
        {
            "schemaVersion": 1,
            "studyId": args.study_id,
            "status": "outer_running",
            "studyLockHash": study_lock["lockHash"],
            "selectionPlanSha256": selection_index["selectionPlanSha256"],
            "updatedAt": utc_now(),
        },
    )
    candidate_by_hash = _candidate_by_hash(inputs["candidates"])
    baseline = _baseline_candidate(inputs["candidates"])
    time_basis_cache: dict[str, dict[str, Any]] = {}
    fold_report_rows: list[dict[str, Any]] = []
    for fold in inputs["foldPlan"]["primaryFolds"]:
        batch_id = str(fold["batchId"])
        selection_lock = selection_locks[batch_id]
        selected_sha = str(selection_lock["locked"]["selectedConfigSha256"])
        selected = candidate_by_hash.get(selected_sha)
        if selected is None:
            raise NestedLoboError(f"selection lock references an unknown config: {batch_id}")
        fold_dir = work_dir / "folds" / batch_id
        outer_truth_path = fold_dir / "truth-outer-holdout.json"
        result_path = fold_dir / "outer-result.json"
        exposure_event = next(
            (
                event
                for event in ledger["events"]
                if isinstance(event, dict)
                and event.get("studyLockHash") == study_lock["lockHash"]
                and event.get("foldBatchId") == batch_id
                and event.get("event") == "outer-exposed"
            ),
            None,
        )
        if result_path.is_file() and exposure_event is None:
            raise NestedLoboError(f"outer result exists without a prior exposure ledger event: {batch_id}")
        if not result_path.is_file() and exposure_event is None:
            append_exposure_event(
                ledger_path=ledger_path,
                ledger=ledger,
                study_lock=study_lock,
                selection_index=selection_index,
                fold_batch_id=batch_id,
                event="outer-exposed",
            )
        outer_catalog = load_truth_catalog(
            inputs["splitPath"],
            inputs["split"],
            instance_ids=fold["outerHoldout"],
        )
        _, truth_contract, outer_tracks = materialize_subset_truth(
            instance_ids=fold["outerHoldout"],
            catalog=outer_catalog,
            output_path=outer_truth_path,
            split_path=inputs["splitPath"],
            split_sha256=inputs["splitSha256"],
            fold_batch_id=batch_id,
            role="primary-outer-holdout",
            membership_sha256=fold["outerHoldoutRosterSha256"],
            ffprobe_path=Path(args.ffprobe).resolve(),
            time_basis_cache=time_basis_cache,
        )
        provenance = outer_provenance(
            study_lock=study_lock,
            selection_index=selection_index,
            selection_lock=selection_lock,
            fold=fold,
            candidate=selected,
            truth_contract=truth_contract,
        )
        if result_path.is_file():
            if not args.resume:
                raise NestedLoboError(f"outer result already exists: {batch_id}")
            payload = read_json_object(result_path)
            validate_compact_result(
                payload,
                expected_provenance=provenance,
                expected_instance_ids=fold["outerHoldout"],
            )
        else:
            configs = [baseline]
            if selected["configSha256"] != baseline["configSha256"]:
                configs.append(selected)
            evaluated = evaluate_fixed_configs(
                tracks=outer_tracks,
                candidates=configs,
                feature_contract_rows=feature_rows,
            )
            payload = build_compact_result(
                result_type="rkb-nested-lobo-outer-result",
                provenance=provenance,
                candidate=selected,
                rows=evaluated[selected_sha],
            )
            write_json_new(result_path, payload)
        fold_report_rows.append(
            {
                "batchId": batch_id,
                "selectionLockHash": selection_lock["lockHash"],
                "selectedCandidateId": selected["candidateId"],
                "selectedConfigSha256": selected_sha,
                "metrics": payload["overall"],
                "resultBodySha256": payload["summary"]["resultBodySha256"],
                "resultPath": normalize_path(result_path),
            }
        )
    aggregate = primary_aggregate(
        fold_report_rows,
        primary_batch_ids=inputs["foldPlan"]["primaryBatchIds"],
        aggregate_policy=inputs["candidates"]["aggregatePolicy"],
    )
    primary_claim = primary_estimate_eligible(
        study_lock["locked"]["evidenceRole"], aggregate
    )
    report = attach_benchmark_result_digest(
        {
            "schemaVersion": 1,
            "type": "rkb-nested-lobo-primary-report",
            "studyId": args.study_id,
            "studyLockHash": study_lock["lockHash"],
            "selectionPlanSha256": selection_index["selectionPlanSha256"],
            "primaryNestedEstimateEligible": primary_claim,
            "freshProofEligible": False,
            "aggregate": aggregate,
            "diagnosticReplays": {},
            "summary": {
                "trackTotal": sum(int(row["metrics"]["trackCount"]) for row in fold_report_rows),
                "errorTrackCount": sum(
                    int(row["metrics"]["errorTrackCount"]) for row in fold_report_rows
                ),
            },
            "tracks": [],
            "errors": [],
            "folds": fold_report_rows,
        }
    )
    write_json_new(report_path, report)
    append_exposure_event(
        ledger_path=ledger_path,
        ledger=ledger,
        study_lock=study_lock,
        selection_index=selection_index,
        fold_batch_id="*",
        event="primary-complete",
        event_details={
            "primaryReportBodySha256": report["summary"]["resultBodySha256"],
            "aggregateSha256": aggregate["aggregateSha256"],
        },
    )
    write_json_atomic(
        state_path,
        {
            "schemaVersion": 1,
            "studyId": args.study_id,
            "status": "primary_complete",
            "studyLockHash": study_lock["lockHash"],
            "selectionPlanSha256": selection_index["selectionPlanSha256"],
            "primaryReportBodySha256": report["summary"]["resultBodySha256"],
            "updatedAt": utc_now(),
        },
    )
    return {
        "studyId": args.study_id,
        "status": "primary_complete",
        "primaryNestedEstimateEligible": primary_claim,
        "aggregate": aggregate,
        "report": str(work_dir / PRIMARY_REPORT_NAME),
    }


def run_diagnostic(args: argparse.Namespace) -> dict[str, Any]:
    inputs = _load_metadata_inputs(args)
    work_dir = Path(args.work_dir).resolve()
    report_path = work_dir / DIAGNOSTIC_REPORT_NAME
    if report_path.exists():
        raise NestedLoboError("new357 diagnostic report is immutable and cannot be rerun")
    ledger_path = Path(args.ledger).resolve()
    ledger = load_ledger(ledger_path)
    primary_feature_contract, _ = _ensure_feature_contract(
        args, inputs, work_dir, create=False
    )
    study_lock = _ensure_study_lock(
        args, inputs, primary_feature_contract, work_dir, ledger, create=False
    )
    selection_locks, selection_index = _load_selection_locks(
        work_dir, inputs["foldPlan"], study_lock
    )
    validate_ledger_covers_prior_artifacts(
        ledger,
        benchmark_root=BENCHMARK_ROOT,
        dataset_contract_sha256=study_lock["locked"]["datasetContractSha256"],
        primary_evidence_universe=study_lock["locked"]["primaryEvidenceUniverse"],
        study_lock_name=STUDY_LOCK_NAME,
        state_name=STATE_NAME,
        primary_report_name=PRIMARY_REPORT_NAME,
    )
    guard_ledger(
        ledger=ledger,
        dataset_contract_sha256=study_lock["locked"]["datasetContractSha256"],
        study_lock=study_lock,
        selection_plan_sha256=selection_index["selectionPlanSha256"],
    )
    revalidate_selection_evidence(
        work_dir=work_dir,
        inputs=inputs,
        study_lock=study_lock,
        selection_locks=selection_locks,
    )
    state_path = work_dir / STATE_NAME
    state = read_json_object(state_path)
    if (
        state.get("studyLockHash") != study_lock["lockHash"]
        or state.get("status") != "primary_complete"
    ):
        raise NestedLoboError("new357 diagnostic requires an immutable completed primary study")
    primary_report, primary_aggregate_payload = validate_existing_primary_report(
        report_path=work_dir / PRIMARY_REPORT_NAME,
        work_dir=work_dir,
        inputs=inputs,
        study_lock=study_lock,
        selection_index=selection_index,
        selection_locks=selection_locks,
    )
    return execute_new357_diagnostic(
        args=args,
        inputs=inputs,
        work_dir=work_dir,
        study_lock=study_lock,
        selection_index=selection_index,
        selection_locks=selection_locks,
        primary_report=primary_report,
        primary_aggregate=primary_aggregate_payload,
        state_path=state_path,
    )


def run_plan(args: argparse.Namespace) -> dict[str, Any]:
    inputs = _load_metadata_inputs(args)
    return {
        "studyId": stable_study_id(args.study_id),
        "parentSplitFileSha256": inputs["splitSha256"],
        "candidateSetSha256": inputs["candidates"]["candidateSetSha256"],
        "foldPlanSha256": inputs["foldPlan"]["foldPlanSha256"],
        "primaryFoldIds": inputs["foldPlan"]["primaryBatchIds"],
        "diagnosticFoldIds": inputs["foldPlan"]["diagnosticBatchIds"],
        "filteredDiagnosticTuneCounts": {
            fold["batchId"]: fold["filteredDiagnosticTuneTrackCount"]
            for fold in inputs["foldPlan"]["primaryFolds"]
        },
        "fixedNoFitOnly": True,
        "outerTruthRead": False,
    }


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--study-id", required=True)
    parser.add_argument("--work-dir", default="")
    parser.add_argument("--splits", default=str(DEFAULT_SPLITS))
    parser.add_argument("--candidates", required=True)
    parser.add_argument(
        "--feature-cache-dir",
        action="append",
        default=[],
        help="Repeat for each instance-safe feature cache. Conflicting duplicate proofs fail closed.",
    )
    parser.add_argument("--ffprobe", default=str(DEFAULT_FFPROBE))
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run leakage-safe two-stage nested LOBO for fixed/no-fit beatgrid configs"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    _add_common_args(plan)
    select = commands.add_parser("select")
    _add_common_args(select)
    select.add_argument(
        "--evidence-role",
        choices=[PRIMARY_EVIDENCE_ROLE, POST_OUTER_DIAGNOSTIC_ROLE],
        default=PRIMARY_EVIDENCE_ROLE,
    )
    select.add_argument("--resume", action="store_true")
    evaluate = commands.add_parser("evaluate")
    _add_common_args(evaluate)
    evaluate.add_argument(
        "--evidence-role",
        choices=[PRIMARY_EVIDENCE_ROLE, POST_OUTER_DIAGNOSTIC_ROLE],
        default=PRIMARY_EVIDENCE_ROLE,
    )
    evaluate.add_argument("--resume", action="store_true")
    diagnostic = commands.add_parser("diagnostic")
    _add_common_args(diagnostic)
    diagnostic.add_argument(
        "--evidence-role",
        choices=[PRIMARY_EVIDENCE_ROLE, POST_OUTER_DIAGNOSTIC_ROLE],
        default=PRIMARY_EVIDENCE_ROLE,
    )
    return parser


def run(argv: list[str] | None = None) -> dict[str, Any]:
    args = _build_parser().parse_args(argv)
    stable_study_id(args.study_id)
    if not str(args.work_dir or "").strip():
        args.work_dir = str(DEFAULT_WORK_ROOT / args.study_id)
    if args.command in {"select", "evaluate", "diagnostic"} and not args.feature_cache_dir:
        raise NestedLoboError(
            "select/evaluate/diagnostic requires at least one --feature-cache-dir"
        )
    if (
        args.command in {"select", "evaluate", "diagnostic"}
        and args.evidence_role == PRIMARY_EVIDENCE_ROLE
        and Path(args.ledger).resolve() != DEFAULT_LEDGER.resolve()
    ):
        raise NestedLoboError("primary nested LOBO must use the canonical central exposure ledger")
    if args.command == "plan":
        return run_plan(args)
    if args.command == "select":
        return run_select(args)
    if args.command == "evaluate":
        return run_evaluate(args)
    if args.command == "diagnostic":
        return run_diagnostic(args)
    raise NestedLoboError(f"unknown command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    try:
        payload = run(argv)
    except NestedLoboError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
