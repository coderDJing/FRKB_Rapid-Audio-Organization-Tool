import argparse
import json
import os
import re
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any

from frkb_database_paths import FRKB_FILTER_SEALED_INTAKE_ROOT, FRKB_FILTER_SEALED_ROOT
from rkb_dataset_contract import (
    DATASET_LOCK_NAME,
    DatasetContractError,
    build_dataset_lock,
    load_last_json_object,
    validate_dataset_lock,
    validate_feature_result_summary,
    validate_sealed_benchmark_output,
)
from rkb_dataset_registry import verify_registry_baseline
from rkb_multiscale_usable_grid_fresh_eval import validate_fresh_candidate_output
from rkb_sealed_batch_prepare_support import (
    acceptance_policy as _acceptance_policy,
    build_roster as _build_roster,
    evaluate_policy as _evaluate_policy,
    filter_registry_duplicates as _filter_registry_duplicates,
    identity_tool as _identity_tool,
    load_reviewed_development_report as _load_reviewed_development_report,
    reviewed_report_file_names as _reviewed_report_file_names,
    verify_reviewed_development_roster as _verify_reviewed_development_roster,
)
from rkb_sealed_batch_parser import build_parser as _build_parser
from rkb_sealed_batch_relocation_cli import create_root_remap
from rkb_sealed_batch_solver_cli import build_usable_grid_cli_payload as _lock_cli_payload
from rkb_sealed_batch_common import (
    MANIFEST_NAME,
    SCHEMA_VERSION,
    SOLVER_LOCK_NAME,
    STATE_NAME,
    SealedBatchError,
    assert_truth_audio_alignment,
    audio_roster_hash,
    batch_directories,
    build_audio_roster,
    build_solver_lock,
    exclusive_lock,
    load_json,
    normalize_name,
    rebuild_registry,
    registry_identity_index,
    resolve_batch_dir,
    resolve_checkpoint,
    resolve_executable,
    run_json_command,
    run_logged_command,
    sha256_file,
    sha256_json,
    transition_state,
    truth_tracks,
    utc_now,
    verify_manifest_and_lock,
    verify_roster_from_manifest,
    write_json_atomic,
    write_json_new,
)
from rkb_sealed_batch_isolation import apply_fresh_audio_isolation_guard


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_ROOT = REPO_ROOT / "scripts"
BENCHMARK_ROOT = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_BATCHES_ROOT = BENCHMARK_ROOT / "sealed-batches"
DEFAULT_REGISTRY = BENCHMARK_ROOT / "rkb-dataset-registry.json"
DEFAULT_BASELINE = BENCHMARK_ROOT / "rkb-dataset-registry-baseline.json"
DEFAULT_CURRENT_TRUTH = BENCHMARK_ROOT / "rekordbox-current-truth.v2.json"
DEFAULT_PREDICTION_CACHE_DIR = BENCHMARK_ROOT / "beatthis-prediction-cache"
DEFAULT_SYNC_SCRIPT = SCRIPTS_ROOT / "sync_rekordbox_playlist_audio.py"
DEFAULT_CAPTURE_SCRIPT = SCRIPTS_ROOT / "capture_rekordbox_playlist_truth.py"
DEFAULT_FEATURE_SCRIPT = SCRIPTS_ROOT / "run_parallel_rkb_beatgrid_feature_cache.py"
DEFAULT_BENCHMARK_SCRIPT = SCRIPTS_ROOT / "run_parallel_rkb_rekordbox_benchmark.py"
DEFAULT_MULTISCALE_FEATURE_SCRIPT = SCRIPTS_ROOT / "rkb_multiscale_feature_cache.py"
DEFAULT_USABLE_GRID_EVAL_SCRIPT = SCRIPTS_ROOT / "rkb_multiscale_usable_grid_fresh_eval.py"
DEFAULT_USABLE_GRID_CANDIDATE = (
    SCRIPTS_ROOT / "models" / "rkb-multiscale-usable-grid-candidate-v1.json"
)
DEFAULT_IDENTITY_HELPER = SCRIPTS_ROOT / "rkb_sealed_audio_identity.mjs"
DEFAULT_IDENTITY_CACHE_DIR = BENCHMARK_ROOT / "audio-identity-cache"
DEFAULT_BRIDGE = REPO_ROOT / "resources" / "rekordboxDesktopLibrary" / "bridge.py"
DEFAULT_FFMPEG = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe"
DEFAULT_FFPROBE = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffprobe.exe"
DEFAULT_SOLVER_ENTRYPOINTS = (
    SCRIPTS_ROOT / "rkb_constant_grid_dp_cache.py",
    SCRIPTS_ROOT / "rkb_constant_grid_dp_solver.py",
    SCRIPTS_ROOT / "models" / "rkb-official-downbeat-rotation-candidate-v1.json",
    SCRIPTS_ROOT / "rkb_beatgrid_feature_cache.py",
    SCRIPTS_ROOT / "benchmark_rkb_rekordbox_truth.py",
    DEFAULT_FEATURE_SCRIPT,
    DEFAULT_BENCHMARK_SCRIPT,
    DEFAULT_MULTISCALE_FEATURE_SCRIPT,
    DEFAULT_USABLE_GRID_EVAL_SCRIPT,
    DEFAULT_IDENTITY_HELPER,
    Path(__file__).resolve(),
)
TRUTH_NAME = "truth.json"
BENCHMARK_NAME = "benchmark.json"
FINALIZATION_NAME = "finalization.json"
BATCH_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,95}$")
INTAKE_METADATA_NAMES = {".frkb.uuid"}
REVIEWED_DEVELOPMENT_ORIGIN = "reviewed-development"


def _prepare(args: argparse.Namespace) -> dict[str, Any]:
    reviewed_report_info = _load_reviewed_development_report(args)
    reviewed_development = bool(getattr(args, "reviewed_development", False))
    fresh_validation = bool(getattr(args, "fresh_validation", False))
    reviewed_file_names = (
        _reviewed_report_file_names(reviewed_report_info[1]) if reviewed_report_info is not None else []
    )
    batches_root = Path(args.batches_root).resolve()
    registry_path = Path(args.registry).resolve()
    baseline_path = Path(args.baseline).resolve()
    if not registry_path.is_file() or not baseline_path.is_file():
        raise SealedBatchError("registry baseline is uninitialized; import consumed datasets before prepare")
    registry = rebuild_registry(batches_root, registry_path)
    verify_registry_baseline(
        batches_root=batches_root, registry_path=registry_path, baseline_path=baseline_path
    )
    consumed_registry_sha256 = sha256_file(registry_path)
    python = resolve_executable(args.python)
    checkpoint = None if reviewed_development else resolve_checkpoint(python, args.checkpoint, REPO_ROOT)
    identity = _identity_tool(args)
    policy = (
        {
            "kind": "reviewed-development",
            "freshProofEligible": False,
            "developmentOnly": True,
        }
        if reviewed_development
        else _acceptance_policy(args)
    )
    if int(args.jobs) <= 0:
        raise SealedBatchError("--jobs must be positive")
    scripts = {
        "sync": Path(args.sync_script).resolve(),
        "capture": Path(args.capture_script).resolve(),
        "feature": Path(args.feature_cache_script).resolve(),
        "benchmark": Path(args.benchmark_script).resolve(),
        "multiscale": Path(args.multiscale_feature_script).resolve(),
        "usableGridEval": Path(args.usable_grid_eval_script).resolve(),
        "usableGridCandidate": Path(args.usable_grid_candidate).resolve(),
    }
    for path in scripts.values():
        if not path.is_file():
            raise SealedBatchError(f"required script not found: {path}")
    audio_intake = Path(args.audio_intake_root).resolve()
    audio_archive = Path(args.audio_archive_root).resolve()
    batches_root.mkdir(parents=True, exist_ok=True)
    audio_intake.mkdir(parents=True, exist_ok=True)
    with exclusive_lock(
        batches_root / ".prepare.lock",
        {"pid": os.getpid(), "startedAt": utc_now(), "operation": "prepare"},
    ):
        active_batches: list[str] = []
        for existing_batch in batch_directories(batches_root):
            existing_state = load_json(existing_batch / STATE_NAME)
            if str(existing_state.get("status") or "") in {"fresh", "evaluating", "exposed"}:
                active_batches.append(f"{existing_batch.name}:{existing_state.get('status')}")
        if active_batches:
            raise SealedBatchError(
                f"another sealed batch is still active; finalize it first: {', '.join(active_batches)}"
            )
        intake_residuals = sorted(
            item.name
            for item in audio_intake.iterdir()
            if normalize_name(item.name) not in INTAKE_METADATA_NAMES
        )
        if intake_residuals:
            raise SealedBatchError(
                "sealed-intake contains unmanaged residual entries; archive or clear them before prepare: "
                + ", ".join(intake_residuals[:12])
            )
        token = uuid.uuid4().hex
        temp_batch = batches_root / f".prepare-{token}"
        temp_audio = audio_intake / f".prepare-{token}"
        temp_batch.mkdir(exist_ok=False)
        reviewed_file_list = temp_batch / "reviewed-file-names.txt"
        if reviewed_file_names:
            reviewed_file_list.write_text("\n".join(reviewed_file_names) + "\n", encoding="utf-8")
        committed_batch: Path | None = None
        committed_audio: Path | None = None
        try:
            sync = [
                python,
                str(scripts["sync"]),
                "--playlist",
                str(args.playlist),
                "--bridge",
                str(Path(args.bridge).resolve()),
                "--current-truth",
                str(Path(args.current_truth).resolve()),
                "--target-root",
                str(temp_audio),
            ]
            if str(args.db_path or "").strip():
                sync.extend(["--db-path", str(args.db_path)])
            if reviewed_file_names:
                sync.extend(["--file-list", str(reviewed_file_list)])
            dry_run = run_json_command([*sync, "--dry-run"], REPO_ROOT)
            if int(dry_run.get("copyCount") or 0) <= 0:
                raise SealedBatchError("playlist contains no new audio after current-truth filtering")
            applied = run_json_command(sync, REPO_ROOT)
            if int(applied.get("copyCount") or 0) != int(dry_run.get("copyCount") or 0):
                raise SealedBatchError("sync apply count changed after dry-run")
            truth_temp = temp_batch / TRUTH_NAME
            capture = [
                python,
                str(scripts["capture"]),
                "--playlist",
                str(args.playlist),
                "--bridge",
                str(Path(args.bridge).resolve()),
                "--audio-root",
                str(temp_audio),
                "--truth",
                str(Path(args.current_truth).resolve()),
                "--output",
                str(truth_temp),
            ]
            if str(args.db_path or "").strip():
                capture.extend(["--db-path", str(args.db_path)])
            if reviewed_file_names:
                capture.extend(["--file-list", str(reviewed_file_list)])
            captured = run_json_command(capture, REPO_ROOT)
            captured_truth = load_json(truth_temp)
            _assert_v2_truth_maps(truth_temp, truth_tracks(captured_truth, truth_temp))
            paths = [item for item in temp_audio.iterdir() if item.is_file()]
            roster = _build_roster(paths, identity)
            assert_truth_audio_alignment(truth_temp, roster)
            roster, excluded = _filter_registry_duplicates(
                truth_path=truth_temp, audio_root=temp_audio, roster=roster, registry=registry
            )
            assert_truth_audio_alignment(truth_temp, roster)
            roster, isolation_excluded, isolation_audit = apply_fresh_audio_isolation_guard(
                truth_path=truth_temp,
                audio_root=temp_audio,
                roster=roster,
                registry=registry,
                registry_sha256=consumed_registry_sha256,
            )
            assert_truth_audio_alignment(truth_temp, roster)
            if reviewed_report_info is not None:
                _verify_reviewed_development_roster(report=reviewed_report_info[1], roster=roster)
            truth_count = len(truth_tracks(load_json(truth_temp), truth_temp))
            truth_hash = sha256_file(truth_temp)
            roster_hash = audio_roster_hash(roster)
            batch_seed: dict[str, str] = {"truth": truth_hash, "roster": roster_hash}
            if reviewed_report_info is not None:
                batch_seed["preReviewReport"] = sha256_file(reviewed_report_info[0])
            batch_prefix = "rkb-reviewed" if reviewed_development else "rkb"
            batch_id = f"{batch_prefix}-{sha256_json(batch_seed)[:16]}"
            batch_dir = batches_root / batch_id
            final_audio = audio_intake / batch_id
            archive_audio = audio_archive / batch_id
            if batch_dir.exists() or final_audio.exists() or archive_audio.exists():
                raise SealedBatchError(f"fixed sealed batch path already exists: {batch_id}")
            final_truth = batch_dir / TRUTH_NAME
            created_at = utc_now()
            origin: dict[str, Any] = {
                "kind": (
                    REVIEWED_DEVELOPMENT_ORIGIN
                    if reviewed_development
                    else "sealed-fresh-reviewed"
                    if fresh_validation
                    else "sealed-fresh"
                ),
                "playlist": str(args.playlist),
            }
            if reviewed_report_info is not None:
                report_path, report = reviewed_report_info
                summary = report.get("summary") if isinstance(report.get("summary"), dict) else {}
                origin["preReviewReport"] = {
                    "path": str(report_path),
                    "sha256": sha256_file(report_path),
                    "batchId": str(summary.get("batchId") or ""),
                    "solverConfigSha256": str(summary.get("solverConfigSha256") or ""),
                    "trackCount": int(summary.get("originalDenominatorTrackCount") or 0),
                }
            manifest = {
                "schemaVersion": SCHEMA_VERSION,
                "type": "rkb-sealed-batch-manifest",
                "origin": origin,
                "batchId": batch_id,
                "createdAt": created_at,
                "playlist": {
                    "name": str(applied.get("playlistName") or args.playlist),
                    "id": applied.get("playlistId"),
                    "playlistTrackCount": int(applied.get("playlistTrackCount") or 0),
                    "syncCopyCount": int(applied.get("copyCount") or 0),
                    "syncSkippedCount": int(applied.get("skippedCount") or 0),
                    "capturedTrackCount": int(captured.get("capturedTrackCount") or 0),
                    "snapshotHash": sha256_json(
                        {"playlistId": applied.get("playlistId"), "copied": dry_run.get("copied") or []}
                    ),
                },
                "truth": {"path": str(final_truth), "sha256": truth_hash, "trackCount": truth_count},
                "audio": {
                    "stagingRoot": str(final_audio),
                    "archiveRoot": str(archive_audio),
                    "rosterHash": roster_hash,
                    "trackCount": len(roster),
                    "identityVersion": "asset+pcm+chromaprint-v1",
                },
                "audioRoster": roster,
                "excludedRegistryDuplicates": excluded,
                "excludedIsolationDuplicates": isolation_excluded,
                "audioIsolationGuard": isolation_audit,
                "identityTool": identity,
                "acceptancePolicy": policy,
                "lifecyclePolicy": {
                    "transitions": (
                        ["consumed"]
                        if reviewed_development
                        else ["fresh", "evaluating", "exposed", "consumed"]
                    ),
                    "freshProofEligible": False if reviewed_development else True,
                    "freshEvaluationCount": 0 if reviewed_development else 1,
                    "resumeRequiresSameLockHash": False if reviewed_development else True,
                    "consumedNeverReturnsToFresh": True,
                },
            }
            solver_lock: dict[str, Any] | None = None
            if not reviewed_development:
                manifest["solverLockPath"] = str(batch_dir / SOLVER_LOCK_NAME)
                cli = _lock_cli_payload(
                    python=python,
                    feature_script=scripts["feature"],
                    benchmark_script=scripts["benchmark"],
                    multiscale_script=scripts["multiscale"],
                    candidate_eval_script=scripts["usableGridEval"],
                    candidate_path=scripts["usableGridCandidate"],
                    truth=final_truth,
                    audio=final_audio,
                    batch=batch_dir,
                    args=args,
                )
                solver_lock = build_solver_lock(
                    manifest=manifest,
                    cli_payload=cli,
                    checkpoint_path=checkpoint,
                    dependency_entrypoints=[
                        *DEFAULT_SOLVER_ENTRYPOINTS,
                        scripts["feature"],
                        scripts["benchmark"],
                        scripts["multiscale"],
                        scripts["usableGridEval"],
                    ],
                    repo_root=REPO_ROOT,
                    scripts_root=SCRIPTS_ROOT,
                )
            write_json_new(temp_batch / MANIFEST_NAME, manifest)
            if solver_lock is not None:
                write_json_new(temp_batch / SOLVER_LOCK_NAME, solver_lock)
            if reviewed_development:
                report_path, _report = reviewed_report_info
                finalization = {
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "rkb-reviewed-development-finalization",
                    "batchId": batch_id,
                    "finalizedAt": created_at,
                    "decision": "consume",
                    "evaluationStatus": "reviewed-development",
                    "preReviewReportSha256": sha256_file(report_path),
                    "freshProofEligible": False,
                    "audioArchiveRoot": str(archive_audio),
                }
                write_json_new(temp_batch / FINALIZATION_NAME, finalization)
                state = {
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "rkb-sealed-batch-state",
                    "batchId": batch_id,
                    "createdAt": created_at,
                    "updatedAt": created_at,
                    "status": "consumed",
                    "manifestSha256": sha256_file(temp_batch / MANIFEST_NAME),
                    "audio": {"activeRoot": str(archive_audio), "archived": True},
                    "audioIsolationGuard": isolation_audit,
                    "evaluation": {
                        "status": "reviewed-development",
                        "attemptCount": 0,
                        "preReviewReport": str(report_path),
                        "preReviewReportSha256": sha256_file(report_path),
                        "freshProofEligible": False,
                    },
                    "finalization": {
                        "decision": "consume",
                        "finalizedAt": created_at,
                        "path": str(batch_dir / FINALIZATION_NAME),
                        "sha256": sha256_file(temp_batch / FINALIZATION_NAME),
                    },
                    "history": [
                        {
                            "at": created_at,
                            "from": None,
                            "to": "consumed",
                            "event": "prepare-reviewed-development",
                        }
                    ],
                }
                write_json_new(temp_batch / STATE_NAME, state)
                archive_audio.parent.mkdir(parents=True, exist_ok=True)
                temp_audio.rename(archive_audio)
                committed_audio = archive_audio
                temp_batch.rename(batch_dir)
                committed_batch = batch_dir
                current_registry = rebuild_registry(batches_root, registry_path)
                return {
                    "batchId": batch_id,
                    "status": "consumed",
                    "truthTrackCount": truth_count,
                    "excludedRegistryDuplicateCount": len(excluded),
                    "excludedIsolationDuplicateCount": len(isolation_excluded),
                    "batchDir": str(batch_dir),
                    "registryTrackCount": current_registry["trackCount"],
                    "freshProofEligible": False,
                    "next": "development-only; do not evaluate this batch as fresh proof",
                }

            if solver_lock is None:
                raise SealedBatchError("fresh batch has no solver lock")
            state = {
                "schemaVersion": SCHEMA_VERSION,
                "type": "rkb-sealed-batch-state",
                "batchId": batch_id,
                "createdAt": created_at,
                "updatedAt": created_at,
                "status": "fresh",
                "manifestSha256": sha256_file(temp_batch / MANIFEST_NAME),
                "solverLockFileSha256": sha256_file(temp_batch / SOLVER_LOCK_NAME),
                "solverLockHash": solver_lock["lockHash"],
                "audio": {"activeRoot": str(final_audio), "archived": False},
                "audioIsolationGuard": isolation_audit,
                "evaluation": {"status": "not-started", "attemptCount": 0, "lockHash": solver_lock["lockHash"]},
                "finalization": None,
                "history": [{"at": created_at, "from": None, "to": "fresh", "event": "prepare"}],
            }
            write_json_new(temp_batch / STATE_NAME, state)
            temp_audio.rename(final_audio)
            committed_audio = final_audio
            temp_batch.rename(batch_dir)
            committed_batch = batch_dir
            current_registry = rebuild_registry(batches_root, registry_path)
            dataset_lock = build_dataset_lock(
                registry_path=registry_path, registry=current_registry, manifest=manifest
            )
            write_json_new(batch_dir / DATASET_LOCK_NAME, dataset_lock)
            return {
                "batchId": batch_id,
                "status": "fresh",
                "truthTrackCount": truth_count,
                "excludedRegistryDuplicateCount": len(excluded),
                "excludedIsolationDuplicateCount": len(isolation_excluded),
                "batchDir": str(batch_dir),
                "solverLockHash": solver_lock["lockHash"],
                "datasetLockHash": dataset_lock["lockHash"],
                "registryTrackCount": current_registry["trackCount"],
                "next": f"evaluate --batch {batch_id}",
            }
        except Exception:
            shutil.rmtree(temp_batch, ignore_errors=True)
            shutil.rmtree(temp_audio, ignore_errors=True)
            if committed_batch is not None:
                shutil.rmtree(committed_batch, ignore_errors=True)
            if committed_audio is not None:
                shutil.rmtree(committed_audio, ignore_errors=True)
            if committed_batch is not None:
                rebuild_registry(batches_root, registry_path)
            raise


def _evaluate(args: argparse.Namespace) -> dict[str, Any]:
    batches_root = Path(args.batches_root).resolve()
    registry_path = Path(args.registry).resolve()
    batch_dir = resolve_batch_dir(batches_root, str(args.batch), {"fresh", "evaluating", "exposed"})
    with exclusive_lock(
        batch_dir / ".operation.lock",
        {"pid": os.getpid(), "startedAt": utc_now(), "operation": "evaluate"},
    ):
        manifest, state, solver_lock = verify_manifest_and_lock(
            batch_dir=batch_dir, repo_root=REPO_ROOT, scripts_root=SCRIPTS_ROOT
        )
        status = str(state.get("status") or "")
        evaluation = state.get("evaluation") if isinstance(state.get("evaluation"), dict) else {}
        evaluation_status = str(evaluation.get("status") or "")
        if evaluation_status == "complete" or (batch_dir / BENCHMARK_NAME).exists():
            raise SealedBatchError("sealed evaluation is complete and cannot be rerun")
        registry = load_json(registry_path)
        try:
            dataset_locked = validate_dataset_lock(
                load_json(batch_dir / DATASET_LOCK_NAME),
                registry_path=registry_path,
                registry=registry,
                manifest=manifest,
            )
        except DatasetContractError as error:
            raise SealedBatchError(str(error)) from error
        if args.resume:
            if status not in {"evaluating", "exposed"} or evaluation_status not in {"running", "failed"}:
                raise SealedBatchError("--resume requires an interrupted or failed exposed evaluation")
        elif status != "fresh":
            raise SealedBatchError("non-fresh batch requires --resume with the identical lockHash")
        if status == "fresh":
            state = transition_state(state, "evaluating", "evaluate-start")
        attempt = int(evaluation.get("attemptCount") or 0) + 1
        state["evaluation"] = {
            **evaluation,
            "status": "running",
            "attemptCount": attempt,
            "lockHash": solver_lock["lockHash"],
            "startedAt": utc_now(),
            "resumed": bool(args.resume),
        }
        write_json_atomic(batch_dir / STATE_NAME, state)
        if state["status"] == "evaluating":
            state = transition_state(state, "exposed", "analysis-command-launch")
            write_json_atomic(batch_dir / STATE_NAME, state)
        cli = (solver_lock.get("locked") or {}).get("cli") or {}
        feature_command = [str(item) for item in cli.get("featureCache") or []]
        baseline_template = [str(item) for item in cli.get("baselineBenchmarkTemplate") or []]
        multiscale_command = [str(item) for item in cli.get("multiscaleFeatureCache") or []]
        candidate_template = [str(item) for item in cli.get("candidateEvaluationTemplate") or []]
        if not feature_command or not baseline_template or not multiscale_command or not candidate_template:
            raise SealedBatchError("solver lock contains no evaluation commands")
        work = batch_dir / "work"
        work.mkdir(parents=True, exist_ok=True)
        feature_stdout = work / f"feature-cache-attempt-{attempt}.stdout.log"
        feature_stderr = work / f"feature-cache-attempt-{attempt}.stderr.log"
        feature_exit = run_logged_command(feature_command, feature_stdout, feature_stderr, REPO_ROOT)
        if feature_exit != 0:
            return _mark_failed(
                batch_dir, "feature-cache", feature_exit, feature_stdout, feature_stderr, solver_lock
            )
        try:
            validate_feature_result_summary(
                (load_last_json_object(feature_stdout).get("summary") or {}),
                locked=dataset_locked,
            )
        except DatasetContractError:
            return _mark_failed(
                batch_dir, "feature-cache", feature_exit, feature_stdout, feature_stderr, solver_lock
            )
        expected_track_count = int((manifest.get("truth") or {}).get("trackCount") or 0)
        baseline_output = work / f"baseline-benchmark-attempt-{attempt}.json"
        command = [item.replace("{baselineOutput}", str(baseline_output)) for item in baseline_template]
        if args.resume:
            command.append("--resume-existing-shards")
        baseline_stdout = work / f"baseline-benchmark-attempt-{attempt}.stdout.log"
        baseline_stderr = work / f"baseline-benchmark-attempt-{attempt}.stderr.log"
        baseline_exit = run_logged_command(command, baseline_stdout, baseline_stderr, REPO_ROOT)
        try:
            validate_sealed_benchmark_output(
                baseline_output,
                expected_track_count=expected_track_count,
                exit_code=baseline_exit,
                maximum_error_rate=0.0,
                manifest=manifest,
                registry=registry,
            )
        except DatasetContractError:
            _mark_failed(
                batch_dir,
                "baseline-benchmark",
                baseline_exit,
                baseline_stdout,
                baseline_stderr,
                solver_lock,
            )
            raise
        multiscale_stdout = work / f"multiscale-feature-cache-attempt-{attempt}.stdout.log"
        multiscale_stderr = work / f"multiscale-feature-cache-attempt-{attempt}.stderr.log"
        multiscale_exit = run_logged_command(
            multiscale_command, multiscale_stdout, multiscale_stderr, REPO_ROOT
        )
        try:
            multiscale_result = load_last_json_object(multiscale_stdout)
            stats = multiscale_result.get("stats") if isinstance(multiscale_result.get("stats"), dict) else {}
            if (
                multiscale_exit != 0
                or int(multiscale_result.get("entryCount") or 0) != expected_track_count
                or int(stats.get("error") or 0) != 0
            ):
                raise SealedBatchError("multiscale feature cache did not cover the sealed denominator")
        except (DatasetContractError, SealedBatchError):
            _mark_failed(
                batch_dir,
                "multiscale-feature-cache",
                multiscale_exit,
                multiscale_stdout,
                multiscale_stderr,
                solver_lock,
            )
            raise
        attempt_output = work / f"usable-grid-attempt-{attempt}.json"
        candidate_command = [
            item.replace("{baselineOutput}", str(baseline_output)).replace(
                "{attemptOutput}", str(attempt_output)
            )
            for item in candidate_template
        ]
        candidate_stdout = work / f"usable-grid-attempt-{attempt}.stdout.log"
        candidate_stderr = work / f"usable-grid-attempt-{attempt}.stderr.log"
        candidate_exit = run_logged_command(
            candidate_command, candidate_stdout, candidate_stderr, REPO_ROOT
        )
        try:
            payload = validate_fresh_candidate_output(
                attempt_output,
                expected_track_count=expected_track_count,
                exit_code=candidate_exit,
                manifest=manifest,
            )
            policy_result = _evaluate_policy(payload["summary"], manifest["acceptancePolicy"])
        except (DatasetContractError, SealedBatchError):
            _mark_failed(
                batch_dir,
                "usable-grid-candidate",
                candidate_exit,
                candidate_stdout,
                candidate_stderr,
                solver_lock,
            )
            raise
        final_output = batch_dir / BENCHMARK_NAME
        if final_output.exists():
            raise SealedBatchError(f"immutable benchmark output already exists: {final_output}")
        attempt_output.rename(final_output)
        verify_manifest_and_lock(batch_dir=batch_dir, repo_root=REPO_ROOT, scripts_root=SCRIPTS_ROOT)
        state = load_json(batch_dir / STATE_NAME)
        summary = payload["summary"]
        state["evaluation"] = {
            **state.get("evaluation", {}),
            "status": "complete",
            "exitCode": candidate_exit,
            "finishedAt": utc_now(),
            "benchmark": str(final_output),
            "benchmarkSha256": sha256_file(final_output),
            "baselineBenchmark": str(baseline_output),
            "baselineBenchmarkSha256": sha256_file(baseline_output),
            "summary": summary,
            "acceptance": policy_result,
            "stdout": str(candidate_stdout),
            "stderr": str(candidate_stderr),
        }
        write_json_atomic(batch_dir / STATE_NAME, state)
        rebuild_registry(batches_root, registry_path)
        return {
            "batchId": manifest["batchId"],
            "status": "exposed",
            "evaluationStatus": "complete",
            "acceptance": policy_result,
            "benchmark": str(final_output),
            "next": f"finalize --batch {manifest['batchId']} --decision eligible|reject|consume",
        }


def _mark_failed(
    batch_dir: Path,
    stage: str,
    exit_code: int,
    stdout: Path,
    stderr: Path,
    solver_lock: dict[str, Any],
) -> dict[str, Any]:
    current = load_json(batch_dir / STATE_NAME)
    current["evaluation"] = {
        **current.get("evaluation", {}),
        "status": "failed",
        "failedStage": stage,
        "exitCode": exit_code,
        "finishedAt": utc_now(),
        "stdout": str(stdout),
        "stderr": str(stderr),
    }
    write_json_atomic(batch_dir / STATE_NAME, current)
    raise SealedBatchError(
        f"sealed {stage} failed; resume is allowed only with lockHash {solver_lock.get('lockHash')}"
    )


def _archive_audio(manifest: dict[str, Any]) -> Path:
    staging = Path(str(manifest["audio"]["stagingRoot"]))
    archive = Path(str(manifest["audio"]["archiveRoot"]))
    if staging.is_dir() and not archive.exists():
        archive.parent.mkdir(parents=True, exist_ok=True)
        staging.rename(archive)
    elif not staging.exists() and archive.is_dir():
        pass
    else:
        raise SealedBatchError(f"cannot archive sealed audio; staging={staging.exists()}, archive={archive.exists()}")
    verify_roster_from_manifest(manifest, archive, REPO_ROOT)
    return archive


def _finalize(args: argparse.Namespace) -> dict[str, Any]:
    batches_root = Path(args.batches_root).resolve()
    registry_path = Path(args.registry).resolve()
    batch_dir = resolve_batch_dir(batches_root, str(args.batch), {"exposed"})
    with exclusive_lock(
        batch_dir / ".operation.lock",
        {"pid": os.getpid(), "startedAt": utc_now(), "operation": "finalize"},
    ):
        manifest, state, solver_lock = verify_manifest_and_lock(
            batch_dir=batch_dir, repo_root=REPO_ROOT, scripts_root=SCRIPTS_ROOT
        )
        evaluation = state.get("evaluation") if isinstance(state.get("evaluation"), dict) else {}
        evaluation_status = str(evaluation.get("status") or "")
        decision = str(args.decision)
        if decision == "eligible":
            acceptance = evaluation.get("acceptance") if isinstance(evaluation.get("acceptance"), dict) else {}
            if evaluation_status != "complete" or not bool(acceptance.get("passed")):
                raise SealedBatchError("model is not eligible under the preregistered acceptance policy")
        elif evaluation_status not in {"complete", "failed"}:
            raise SealedBatchError(f"cannot finalize evaluation status: {evaluation_status}")
        finalization_path = batch_dir / FINALIZATION_NAME
        existing_finalization = load_json(finalization_path) if finalization_path.is_file() else None
        if existing_finalization and str(existing_finalization.get("decision") or "") != decision:
            raise SealedBatchError("immutable finalization already exists with a different decision")
        archive = _archive_audio(manifest)
        finalized_at = str(existing_finalization.get("finalizedAt") or utc_now()) if existing_finalization else utc_now()
        finalization = existing_finalization or {
            "schemaVersion": SCHEMA_VERSION,
            "type": "rkb-sealed-batch-finalization",
            "batchId": manifest["batchId"],
            "finalizedAt": finalized_at,
            "decision": decision,
            "note": str(args.note or ""),
            "evaluationStatus": evaluation_status,
            "acceptance": evaluation.get("acceptance"),
            "solverLockHash": solver_lock["lockHash"],
            "benchmarkSha256": str(evaluation.get("benchmarkSha256") or ""),
            "audioArchiveRoot": str(archive),
        }
        if existing_finalization is None:
            write_json_new(finalization_path, finalization)
        state = load_json(batch_dir / STATE_NAME)
        state["audio"] = {"activeRoot": str(archive), "archived": True}
        state["finalization"] = {
            "decision": decision,
            "finalizedAt": finalized_at,
            "path": str(finalization_path),
            "sha256": sha256_file(finalization_path),
        }
        state = transition_state(state, "consumed", f"finalize-{decision}")
        write_json_atomic(batch_dir / STATE_NAME, state)
        registry = rebuild_registry(batches_root, registry_path)
        return {
            "batchId": manifest["batchId"],
            "status": "consumed",
            "decision": decision,
            "audioArchiveRoot": str(archive),
            "registryTrackCount": registry["trackCount"],
        }


def _assert_v2_truth_maps(truth_path: Path, tracks: list[dict[str, Any]]) -> None:
    for track in tracks:
        beat_grid_map = track.get("beatGridMap")
        if not isinstance(beat_grid_map, dict) or beat_grid_map.get("version") != 2:
            raise SealedBatchError(f"truth must use v2 beatGridMap: {truth_path}")
        if beat_grid_map.get("source") not in {"manual", "analysis"}:
            raise SealedBatchError(f"truth map has invalid source: {truth_path}")
        if not isinstance(beat_grid_map.get("signature"), str) or not beat_grid_map["signature"].strip():
            raise SealedBatchError(f"truth map is missing signature: {truth_path}")
        clips = beat_grid_map.get("clips")
        if not isinstance(clips, list) or not clips:
            raise SealedBatchError(f"truth map has no clips: {truth_path}")
        for clip in clips:
            phase = clip.get("downbeatBeatOffset") if isinstance(clip, dict) else None
            if not isinstance(phase, int) or not 0 <= phase < 4:
                raise SealedBatchError(f"truth map has invalid four-beat phase: {truth_path}")


def _find_consumed_audio(truth_path: Path, audio_roots: list[Path]) -> list[Path]:
    truth = load_json(truth_path)
    tracks = truth_tracks(truth, truth_path)
    _assert_v2_truth_maps(truth_path, tracks)
    resolved_roots = [root.resolve() for root in audio_roots]
    indices: dict[str, list[Path]] = {}
    for root in resolved_roots:
        if not root.is_dir():
            raise SealedBatchError(f"consumed audio root not found: {root}")
        for path in root.iterdir():
            if path.is_file():
                indices.setdefault(normalize_name(path.name), []).append(path.resolve())
    paths: list[Path] = []
    for track in tracks:
        file_name = str(track.get("fileName") or "")
        raw_file_path = str(track.get("filePath") or "").strip()
        if raw_file_path:
            exact_path = Path(raw_file_path)
            if exact_path.is_absolute():
                exact_path = exact_path.resolve()
                inside_audio_root = any(
                    exact_path == root or root in exact_path.parents for root in resolved_roots
                )
                if inside_audio_root:
                    if not exact_path.is_file():
                        raise SealedBatchError(
                            f"consumed truth exact audio path not found for {file_name}: {exact_path}"
                        )
                    if normalize_name(exact_path.name) != normalize_name(file_name):
                        raise SealedBatchError(
                            f"consumed truth filePath/fileName mismatch: {exact_path} != {file_name}"
                        )
                    paths.append(exact_path)
                    continue
        matches = indices.get(normalize_name(file_name), [])
        if len(matches) != 1:
            raise SealedBatchError(f"consumed truth audio resolution is ambiguous for {file_name}: {matches}")
        paths.append(matches[0])
    return paths


def _import_consumed(args: argparse.Namespace) -> dict[str, Any]:
    batch_id = str(args.batch_id).strip()
    if not BATCH_ID_PATTERN.fullmatch(batch_id):
        raise SealedBatchError("--batch-id must use only letters, digits, dot, underscore, and dash")
    batches_root = Path(args.batches_root).resolve()
    registry_path = Path(args.registry).resolve()
    baseline_path = Path(args.baseline).resolve()
    if baseline_path.exists():
        raise SealedBatchError(
            "import-consumed is disabled after registry baseline initialization; "
            "use the sealed fresh lifecycle"
        )
    batch_dir = batches_root / batch_id
    if batch_dir.exists():
        raise SealedBatchError(f"fixed consumed batch path already exists: {batch_dir}")
    truth_source = Path(args.truth).resolve()
    if not truth_source.is_file():
        raise SealedBatchError(f"consumed truth not found: {truth_source}")
    identity = _identity_tool(args)
    audio_roots = [Path(item).resolve() for item in args.audio_root]
    paths = _find_consumed_audio(truth_source, audio_roots)
    roster = _build_roster(paths, identity, include_source=True)
    batches_root.mkdir(parents=True, exist_ok=True)
    temp_dir = batches_root / f".import-{uuid.uuid4().hex}"
    temp_dir.mkdir(exist_ok=False)
    committed_batch = False
    try:
        truth_copy = temp_dir / TRUTH_NAME
        shutil.copy2(truth_source, truth_copy)
        assert_truth_audio_alignment(truth_copy, roster)
        created_at = utc_now()
        manifest = {
            "schemaVersion": SCHEMA_VERSION,
            "type": "rkb-consumed-dataset-manifest",
            "origin": {"kind": "import-consumed", "sourceTruth": str(truth_source)},
            "batchId": batch_id,
            "createdAt": created_at,
            "truth": {
                "path": str(batch_dir / TRUTH_NAME),
                "sha256": sha256_file(truth_copy),
                "trackCount": len(roster),
            },
            "audio": {
                "roots": [str(item) for item in audio_roots],
                "rosterHash": audio_roster_hash(roster),
                "trackCount": len(roster),
                "identityVersion": "asset+pcm+chromaprint-v1",
                "externalArchive": True,
            },
            "audioRoster": roster,
            "identityTool": identity,
            "lifecyclePolicy": {"importedAs": "consumed", "consumedNeverReturnsToFresh": True},
        }
        write_json_new(temp_dir / MANIFEST_NAME, manifest)
        state = {
            "schemaVersion": SCHEMA_VERSION,
            "type": "rkb-sealed-batch-state",
            "batchId": batch_id,
            "createdAt": created_at,
            "updatedAt": created_at,
            "status": "consumed",
            "manifestSha256": sha256_file(temp_dir / MANIFEST_NAME),
            "audio": {"activeRoots": [str(item) for item in audio_roots], "archived": True},
            "evaluation": {"status": "imported-consumed"},
            "finalization": {"decision": "import-consumed", "finalizedAt": created_at},
            "history": [{"at": created_at, "from": None, "to": "consumed", "event": "import-consumed"}],
        }
        write_json_new(temp_dir / STATE_NAME, state)
        temp_dir.rename(batch_dir)
        committed_batch = True
        registry = rebuild_registry(batches_root, registry_path)
        return {
            "batchId": batch_id,
            "status": "consumed",
            "trackCount": len(roster),
            "manifest": str(batch_dir / MANIFEST_NAME),
            "registryTrackCount": registry["trackCount"],
        }
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        if committed_batch:
            shutil.rmtree(batch_dir, ignore_errors=True)
        raise


def _initialize_registry(args: argparse.Namespace) -> dict[str, Any]:
    batches_root = Path(args.batches_root).resolve()
    registry_path = Path(args.registry).resolve()
    baseline_path = Path(args.baseline).resolve()
    registry = rebuild_registry(batches_root, registry_path)
    expected = int(args.expected_track_count)
    if expected <= 0 or int(registry.get("trackCount") or 0) != expected:
        raise SealedBatchError(
            f"registry trackCount {registry.get('trackCount')} does not match --expected-track-count {expected}"
        )
    registry_tracks = [item for item in registry.get("tracks") or [] if isinstance(item, dict)]
    required_identity_fields = ("familyId", "assetSha256", "pcmSha256", "fingerprintSha256")
    incomplete_identities = [
        f"{item.get('batchId')}:{item.get('fileName')}"
        for item in registry_tracks
        if any(not str(item.get(field) or "").strip() for field in required_identity_fields)
    ]
    if len(registry_tracks) != expected or incomplete_identities:
        raise SealedBatchError(
            "registry baseline requires complete asset/PCM/Chromaprint identity for every track; "
            f"incomplete={incomplete_identities[:8]}"
        )
    imported_batches: list[dict[str, Any]] = []
    for item in registry.get("batches") or []:
        if not isinstance(item, dict) or item.get("origin") != "import-consumed" or item.get("status") != "consumed":
            raise SealedBatchError("initialize-registry requires only immutable imported consumed batches")
        imported_batches.append(
            {
                "batchId": str(item["batchId"]),
                "manifestSha256": str(item["manifestSha256"]),
                "stateSha256": str(item["stateSha256"]),
                "trackCount": int(item["trackCount"]),
            }
        )
    if not imported_batches:
        raise SealedBatchError("initialize-registry found no imported consumed batches")
    expected_batches: dict[str, int] = {}
    for raw_value in args.expected_batch:
        batch_id, separator, raw_count = str(raw_value or "").partition("=")
        batch_id = batch_id.strip()
        if not separator or not BATCH_ID_PATTERN.fullmatch(batch_id):
            raise SealedBatchError("--expected-batch must use BATCH_ID=TRACK_COUNT")
        try:
            track_count = int(raw_count)
        except ValueError as error:
            raise SealedBatchError("--expected-batch track count must be an integer") from error
        if track_count <= 0 or batch_id in expected_batches:
            raise SealedBatchError("--expected-batch ids must be unique with positive counts")
        expected_batches[batch_id] = track_count
    if expected_batches:
        actual_batches = {item["batchId"]: int(item["trackCount"]) for item in imported_batches}
        if actual_batches != expected_batches:
            missing = sorted(set(expected_batches) - set(actual_batches))
            extra = sorted(set(actual_batches) - set(expected_batches))
            mismatched = sorted(
                batch_id
                for batch_id in set(actual_batches) & set(expected_batches)
                if actual_batches[batch_id] != expected_batches[batch_id]
            )
            raise SealedBatchError(
                "registry batches do not match --expected-batch; "
                f"missing={missing}, extra={extra}, countMismatch={mismatched}"
            )
        if sum(expected_batches.values()) != expected:
            raise SealedBatchError("--expected-batch counts do not sum to --expected-track-count")
    baseline = {
        "schemaVersion": SCHEMA_VERSION,
        "type": "rkb-dataset-registry-baseline",
        "initializedAt": utc_now(),
        "expectedTrackCount": expected,
        "batchCount": len(imported_batches),
        "identityPolicy": registry["identityPolicy"],
        "batches": imported_batches,
        "expectedBatches": expected_batches,
    }
    write_json_new(baseline_path, baseline)
    verify_registry_baseline(
        batches_root=batches_root, registry_path=registry_path, baseline_path=baseline_path
    )
    return {
        "baseline": str(baseline_path),
        "expectedTrackCount": expected,
        "batchCount": len(imported_batches),
        "registry": str(registry_path),
    }


def run(argv: list[str] | None = None) -> dict[str, Any]:
    args = _build_parser().parse_args(argv)
    if args.command == "prepare":
        return _prepare(args)
    if args.command == "evaluate":
        return _evaluate(args)
    if args.command == "finalize":
        return _finalize(args)
    if args.command == "import-consumed":
        return _import_consumed(args)
    if args.command == "initialize-registry":
        return _initialize_registry(args)
    if args.command == "create-root-remap":
        return create_root_remap(args)
    if args.command == "rebuild-registry":
        root_remap_value = str(args.root_remap or "").strip()
        disable_auto_root_remap = root_remap_value.casefold() == "none"
        payload = rebuild_registry(
            Path(args.batches_root).resolve(),
            Path(args.registry).resolve(),
            root_remap_path=(
                Path(root_remap_value).resolve()
                if root_remap_value and not disable_auto_root_remap
                else None
            ),
            use_auto_root_remap=not disable_auto_root_remap,
        )
        return {
            "registry": str(Path(args.registry).resolve()),
            "batchCount": payload["batchCount"],
            "trackCount": payload["trackCount"],
            "sourcePathRelocation": payload.get("sourcePathRelocation"),
        }
    raise SealedBatchError(f"unknown command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    try:
        payload = run(argv)
    except SealedBatchError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
