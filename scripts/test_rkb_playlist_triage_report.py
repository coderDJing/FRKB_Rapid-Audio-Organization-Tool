import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import move_rekordbox_playlist_grid_diffs as triage
import rkb_playlist_triage_report as report
from rkb_playlist_triage_live_snapshot import validate_live_source_playlist


def _track(row_key: str, track_id: int, file_name: str, file_path: Path | None = None) -> dict:
    return {
        "rowKey": row_key,
        "trackId": track_id,
        "entryIndex": track_id,
        "fileName": file_name,
        "filePath": str(file_path or f"D:/music/{file_name}"),
        "title": Path(file_name).stem,
        "artist": "artist",
        "gridBpm": 128.0,
        "gridFirstBeatMs": 10.0,
        "gridFirstBeatLabel": 1,
        "gridBarBeatOffset": 0,
    }


def _solver() -> dict:
    config = {
        "device": "cpu",
        "sampleRate": 44100,
        "channels": 2,
        "windowSec": 30.0,
        "maxScanSec": 120.0,
        "tuning": {"gridSolverPolicy": "conservative"},
        "runtimeConstantGridEnabled": True,
    }
    combined = {
        "mode": report.PRODUCTION_SOLVER_MODE,
        "solverVersion": "test-solver-v1",
        "sourceSha256": "a" * 64,
        "checkpointSha256": "b" * 64,
        "configSha256": report.stable_json_sha256(config),
    }
    return {
        **combined,
        "checkpointSize": 123,
        "config": config,
        "solverConfigSha256": report.stable_json_sha256(combined),
    }


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _audio_tracks(root: Path, names: list[str]) -> list[dict]:
    audio_root = root / "audio"
    audio_root.mkdir(exist_ok=True)
    tracks: list[dict] = []
    for index, name in enumerate(names, start=1):
        path = audio_root / name
        path.write_bytes(f"audio-{index}-{name}".encode("utf-8"))
        tracks.append(_track(f"row-{index}", index, name, path))
    return tracks


def _write_consumed_batch(
    root: Path,
    registry_path: Path,
    tracks: list[dict],
    *,
    origin: str = "sealed-fresh",
) -> tuple[str, Path]:
    batch_id = "rkb-test-batch"
    batch_dir = root / batch_id
    batch_dir.mkdir(parents=True)
    truth_path = batch_dir / report.TRUTH_NAME
    benchmark_path = batch_dir / report.BENCHMARK_NAME
    solver_lock_path = batch_dir / report.SOLVER_LOCK_NAME
    finalization_path = batch_dir / report.FINALIZATION_NAME
    truth_path.write_text(
        json.dumps({"tracks": [{"fileName": item["fileName"]} for item in tracks]}),
        encoding="utf-8",
    )
    benchmark_path.write_text(json.dumps({"summary": {}}), encoding="utf-8")
    solver_lock_path.write_text(json.dumps({"lockHash": "a" * 64}), encoding="utf-8")
    finalization_path.write_text(
        json.dumps(
            {
                "batchId": batch_id,
                "decision": "consume",
                "solverLockHash": "a" * 64,
                "benchmarkSha256": _sha256(benchmark_path),
            }
        ),
        encoding="utf-8",
    )
    manifest_path = batch_dir / report.MANIFEST_NAME
    roster = []
    for track in tracks:
        path = Path(track["filePath"])
        asset_sha256 = _sha256(path)
        roster.append(
            {
                "fileName": track["fileName"],
                "size": path.stat().st_size,
                "assetSha256": asset_sha256,
                "pcmSha256": asset_sha256,
                "fingerprint": f"fingerprint-{track['trackId']}",
                "fingerprintSha256": asset_sha256,
                "familyId": f"chromaprint:{asset_sha256}",
                "sourcePath": str(path),
            }
        )
    manifest_path.write_text(
        json.dumps(
            {
                "batchId": batch_id,
                "origin": {"kind": origin},
                "playlist": {"id": 123, "name": "test"},
                "truth": {"sha256": _sha256(truth_path), "trackCount": len(tracks)},
                "audio": {
                    "trackCount": len(roster),
                    "rosterHash": report.audio_roster_hash(roster),
                },
                "audioRoster": roster,
            }
        ),
        encoding="utf-8",
    )
    state_path = batch_dir / report.STATE_NAME
    state_path.write_text(
        json.dumps(
            {
                "batchId": batch_id,
                "status": "consumed",
                "manifestSha256": _sha256(manifest_path),
                "solverLockFileSha256": _sha256(solver_lock_path),
                "solverLockHash": "a" * 64,
                "evaluation": {
                    "status": "complete",
                    "benchmarkSha256": _sha256(benchmark_path),
                },
                "finalization": {"sha256": _sha256(finalization_path)},
                "history": [
                    {"to": "fresh"},
                    {"to": "evaluating"},
                    {"to": "exposed"},
                    {"to": "consumed"},
                ],
            }
        ),
        encoding="utf-8",
    )
    registry_path.write_text(
        json.dumps(
            {
                "batches": [
                    {
                        "batchId": batch_id,
                        "status": "consumed",
                        "trackCount": len(roster),
                        "manifestSha256": _sha256(manifest_path),
                        "stateSha256": _sha256(state_path),
                    }
                ],
                "tracks": [
                    {
                        "fileName": row["fileName"],
                        "batchId": batch_id,
                        "batchStatus": "consumed",
                        "assetSha256": row["assetSha256"],
                    }
                    for row in roster
                ],
            }
        ),
        encoding="utf-8",
    )
    return batch_id, batch_dir


def _report_payload(*, with_error: bool = False) -> tuple[dict, list[dict]]:
    tracks = [_track("row-1", 1, "one.mp3"), _track("row-2", 2, "two.mp3")]
    batch = report.build_batch_snapshot(
        playlist_id=123,
        playlist_name="test",
        raw_tracks=tracks,
        selected_tracks=tracks,
        only_filters=[],
        limit=0,
    )
    pass_row = {
        "fileName": "one.mp3",
        "sourceRowKey": "row-1",
        "sourceTrackId": 1,
        "currentTimeline": {"category": "pass"},
    }
    fail_row = {
        "fileName": "two.mp3",
        "sourceRowKey": "row-2",
        "sourceTrackId": 2,
        "currentTimeline": {"category": "first-beat-phase"},
    }
    error_row = {
        "fileName": "two.mp3",
        "sourceRowKey": "row-2",
        "sourceTrackId": 2,
        "error": "analysis failed",
    }
    rows = [pass_row] if with_error else [pass_row, fail_row]
    errors = [error_row] if with_error else []
    difference = {
        "fileName": "two.mp3",
        "sourceRowKey": "row-2",
        "sourceTrackId": 2,
        "category": "analysis-error" if with_error else "first-beat-phase",
    }
    solver = _solver()
    roster_names = ["one.mp3", "two.mp3"]
    identities = [
        {
            "fileName": name,
            "filePath": f"D:/music/{name}",
            "size": index,
            "assetSha256": str(index) * 64,
        }
        for index, name in enumerate(roster_names, start=1)
    ]
    summary = {
        "sourcePlaylist": {
            "playlistId": 123,
            "playlistName": "test",
            "trackTotal": 2,
            "selectedTrackCount": 2,
            "playlistSnapshotSha256": batch["playlistSnapshotSha256"],
        },
        "batchId": batch["batchId"],
        "originalDenominatorTrackCount": 2,
        "denominatorSnapshotSha256": batch["denominatorSnapshotSha256"],
        "solverConfigSha256": solver["solverConfigSha256"],
        "targetPlaylistName": "needReview",
        "targetParentId": 0,
        "requestedOperation": "move",
        "mode": "dry-run",
        "analyzedTrackCount": len(rows),
        "errorTrackCount": len(errors),
        "differenceTrackCount": 1,
        "passTrackCount": 1,
        "applyResult": None,
    }
    payload = report.attach_report_integrity(
        {
            "schemaVersion": report.REPORT_SCHEMA_VERSION,
            "reportType": report.REPORT_TYPE,
            "summary": summary,
            "batch": batch,
            "solver": solver,
            "workflowGuard": {
                "mode": "consumed-maintenance",
                "maintenanceOnly": True,
                "freshProofEligible": False,
                "lifecycleVerified": True,
                "registryVerified": True,
                "strongIdentityVerified": True,
                "activeSealedBatchCount": 0,
                "batchesRoot": "D:/sealed-batches",
                "batchId": "consumed-test",
                "batchOrigin": "import-consumed",
                "batchDir": "D:/sealed-batches/consumed-test",
                "sourcePlaylistId": 123,
                "sourcePlaylistName": "test",
                "batchRosterTrackCount": len(roster_names),
                "batchRosterFileNames": roster_names,
                "batchRosterFileNamesSha256": report.stable_json_sha256(roster_names),
                "denominatorAudioIdentities": identities,
                "denominatorAudioIdentitiesSha256": report.stable_json_sha256(identities),
                "manifestSha256": "c" * 64,
                "stateSha256": "d" * 64,
                "truthSha256": "e" * 64,
                "audioRosterHash": "f" * 64,
                "registryPath": "D:/registry.json",
                "registrySha256": "a" * 64,
            },
            "differences": [difference],
            "rows": rows,
            "errors": errors,
        }
    )
    return payload, tracks


class PlaylistTriageReportTest(unittest.TestCase):
    def test_pre_review_guard_marks_complete_test_batch_as_exposed_development(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tracks = _audio_tracks(root, ["one.mp3", "two.mp3"])
            batch = report.build_batch_snapshot(
                playlist_id=123,
                playlist_name="test",
                raw_tracks=tracks,
                selected_tracks=tracks,
                only_filters=[],
                limit=0,
            )
            guard = triage._build_triage_workflow_guard(
                source_playlist="test",
                source={"playlistId": 123, "playlistName": "test"},
                batch=batch,
                truth_tracks=tracks,
                batches_root=root / "sealed-batches",
                registry_path=root / "registry.json",
                sealed_batch_id="",
                consumed_maintenance=False,
                consumed_batch_id="",
                pre_review=True,
            )

        self.assertEqual(guard["mode"], "pre-review-label-qa")
        self.assertTrue(guard["labelQaOnly"])
        self.assertFalse(guard["reportIsFreshProof"])
        self.assertEqual(guard["batchRosterTrackCount"], 2)

    def test_test_playlist_requires_sealed_proof_or_explicit_maintenance(self) -> None:
        tracks = [_track("row-1", 1, "one.mp3")]
        batch = report.build_batch_snapshot(
            playlist_id=123,
            playlist_name="test",
            raw_tracks=tracks,
            selected_tracks=tracks,
            only_filters=[],
            limit=0,
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(RuntimeError, "requires --sealed-batch-id"):
                triage._build_triage_workflow_guard(
                    source_playlist="test",
                    source={"playlistId": 123, "playlistName": "test"},
                    batch=batch,
                    truth_tracks=tracks,
                    batches_root=Path(temp_dir),
                    registry_path=Path(temp_dir) / "registry.json",
                    sealed_batch_id="",
                    consumed_maintenance=False,
                    consumed_batch_id="",
                )
            with self.assertRaisesRegex(RuntimeError, "requires --consumed-batch-id"):
                triage._build_triage_workflow_guard(
                    source_playlist="test",
                    source={"playlistId": 123, "playlistName": "test"},
                    batch=batch,
                    truth_tracks=tracks,
                    batches_root=Path(temp_dir),
                    registry_path=Path(temp_dir) / "registry.json",
                    sealed_batch_id="",
                    consumed_maintenance=True,
                    consumed_batch_id="",
                )

    def test_sealed_guard_verifies_lifecycle_and_current_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tracks = _audio_tracks(root, ["one.mp3", "two.mp3"])
            batch = report.build_batch_snapshot(
                playlist_id=123,
                playlist_name="test",
                raw_tracks=tracks,
                selected_tracks=tracks,
                only_filters=[],
                limit=0,
            )
            registry_path = root / "registry.json"
            batch_id, batch_dir = _write_consumed_batch(root, registry_path, tracks)
            identities = report.build_denominator_audio_identities(tracks)
            guard = report.build_sealed_triage_guard(
                batches_root=root,
                registry_path=registry_path,
                batch_id=batch_id,
                playlist_id=123,
                playlist_name="test",
                batch=batch,
                denominator_audio_identities=identities,
            )
            self.assertEqual("sealed-consumed", guard["mode"])
            self.assertFalse(guard["freshProofEligible"])
            report.validate_current_workflow_guard(
                report_guard=guard,
                batch=batch,
                batches_root=root,
                registry_path=registry_path,
            )
            (batch_dir / report.BENCHMARK_NAME).write_text("tampered", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "benchmark hash"):
                report.validate_current_workflow_guard(
                    report_guard=guard,
                    batch=batch,
                    batches_root=root,
                    registry_path=registry_path,
                )

    def test_sealed_guard_rejects_extra_playlist_tracks_and_filtered_denominators(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            frozen_tracks = _audio_tracks(root, ["one.mp3", "two.mp3"])
            extra_path = root / "audio" / "extra.mp3"
            extra_path.write_bytes(b"unfrozen-extra")
            extra = _track("row-3", 3, "extra.mp3", extra_path)
            registry_path = root / "registry.json"
            batch_id, _ = _write_consumed_batch(root, registry_path, frozen_tracks)
            all_tracks = [*frozen_tracks, extra]
            batch = report.build_batch_snapshot(
                playlist_id=123,
                playlist_name="test",
                raw_tracks=all_tracks,
                selected_tracks=all_tracks,
                only_filters=[],
                limit=0,
            )
            with self.assertRaisesRegex(RuntimeError, "exactly|extra tracks"):
                report.build_sealed_triage_guard(
                    batches_root=root,
                    registry_path=registry_path,
                    batch_id=batch_id,
                    playlist_id=123,
                    playlist_name="test",
                    batch=batch,
                    denominator_audio_identities=report.build_denominator_audio_identities(
                        all_tracks
                    ),
                )

            filtered_batch = report.build_batch_snapshot(
                playlist_id=123,
                playlist_name="test",
                raw_tracks=frozen_tracks,
                selected_tracks=frozen_tracks[:1],
                only_filters=["one"],
                limit=0,
            )
            with self.assertRaisesRegex(RuntimeError, "--only and --limit"):
                report.build_sealed_triage_guard(
                    batches_root=root,
                    registry_path=registry_path,
                    batch_id=batch_id,
                    playlist_id=123,
                    playlist_name="test",
                    batch=filtered_batch,
                    denominator_audio_identities=report.build_denominator_audio_identities(
                        frozen_tracks[:1]
                    ),
                )

    def test_consumed_maintenance_binds_registry_roster_and_rechecks_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tracks = _audio_tracks(root, ["one.mp3", "two.mp3"])
            batch = report.build_batch_snapshot(
                playlist_id=123,
                playlist_name="test",
                raw_tracks=tracks,
                selected_tracks=tracks,
                only_filters=[],
                limit=0,
            )
            registry_path = root / "registry.json"
            batch_id, _ = _write_consumed_batch(
                root, registry_path, tracks, origin="import-consumed"
            )
            guard = report.build_consumed_maintenance_guard(
                batches_root=root,
                registry_path=registry_path,
                batch_id=batch_id,
                playlist_id=123,
                playlist_name="test",
                batch=batch,
                denominator_audio_identities=report.build_denominator_audio_identities(tracks),
            )
            self.assertEqual(guard["mode"], "consumed-maintenance")
            self.assertTrue(guard["registryVerified"])
            self.assertTrue(guard["strongIdentityVerified"])
            report.validate_current_workflow_guard(
                report_guard=guard,
                batch=batch,
                batches_root=root,
                registry_path=registry_path,
            )
            Path(tracks[0]["filePath"]).write_bytes(b"changed-audio")
            with self.assertRaisesRegex(RuntimeError, "changed after dry-run"):
                report.validate_current_workflow_guard(
                    report_guard=guard,
                    batch=batch,
                    batches_root=root,
                    registry_path=registry_path,
                )

    def test_consumed_maintenance_is_blocked_by_active_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            active = root / "active"
            active.mkdir()
            (active / report.MANIFEST_NAME).write_text("{}", encoding="utf-8")
            (active / report.STATE_NAME).write_text(
                json.dumps({"status": "fresh"}), encoding="utf-8"
            )
            with self.assertRaisesRegex(RuntimeError, "sealed batch is active"):
                report.build_consumed_maintenance_guard(
                    batches_root=root,
                    registry_path=root / "registry.json",
                    batch_id="consumed",
                    playlist_id=123,
                    playlist_name="test",
                    batch={},
                    denominator_audio_identities=[],
                )

    def test_sealed_triage_is_blocked_by_active_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            active = root / "active"
            active.mkdir()
            (active / report.MANIFEST_NAME).write_text("{}", encoding="utf-8")
            (active / report.STATE_NAME).write_text(
                json.dumps({"status": "evaluating"}), encoding="utf-8"
            )
            with self.assertRaisesRegex(RuntimeError, "sealed triage.*sealed batch is active"):
                report.build_sealed_triage_guard(
                    batches_root=root,
                    registry_path=root / "registry.json",
                    batch_id="consumed",
                    playlist_id=123,
                    playlist_name="test",
                    batch={},
                    denominator_audio_identities=[],
                )

    def test_runtime_wrapper_matches_bridge_production_policy(self) -> None:
        class FakeBridge:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            def _analyze_prepared_windows_to_track_result(self, *args, **kwargs):
                self.calls.append(kwargs)
                return {"ok": True}

        bridge = FakeBridge()
        report.enable_production_runtime_constant_grid(bridge)
        bridge._analyze_prepared_windows_to_track_result(
            [], None, 44100, 120.0, {"gridSolverPolicy": "conservative"}, "song.mp3"
        )
        bridge._analyze_prepared_windows_to_track_result(
            [], None, 44100, 120.0, {"gridSolverPolicy": "off"}, "song.mp3"
        )
        self.assertTrue(bridge.calls[0]["use_runtime_constant_grid"])
        self.assertFalse(bridge.calls[1]["use_runtime_constant_grid"])

    def test_valid_report_and_live_playlist_snapshot(self) -> None:
        payload, tracks = _report_payload()
        report.validate_report_payload(payload)
        playlist_id = validate_live_source_playlist(
            batch=payload["batch"],
            differences=payload["differences"],
            live_payload={"playlistName": "test", "tracks": tracks},
        )
        self.assertEqual(playlist_id, 123)

    def test_integrity_and_live_row_mapping_reject_stale_report(self) -> None:
        payload, tracks = _report_payload()
        payload["differences"][0]["category"] = "tampered"
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            report.validate_report_payload(payload)

        payload, _ = _report_payload()
        stale_tracks = [dict(tracks[0]), {**tracks[1], "rowKey": "new-row"}]
        with self.assertRaisesRegex(RuntimeError, "changed after dry-run|rowKey"):
            validate_live_source_playlist(
                batch=payload["batch"],
                differences=payload["differences"],
                live_payload={"playlistName": "test", "tracks": stale_tracks},
            )

    def test_complete_denominator_and_solver_hash_are_enforced(self) -> None:
        payload, _ = _report_payload()
        payload["rows"] = payload["rows"][:1]
        payload["summary"]["analyzedTrackCount"] = 1
        payload = report.attach_report_integrity(payload)
        with self.assertRaisesRegex(RuntimeError, "complete original denominator"):
            report.validate_report_payload(payload)

        payload, _ = _report_payload()
        with self.assertRaisesRegex(RuntimeError, "solver/config changed"):
            report.validate_current_solver(
                payload["solver"], {"solverConfigSha256": "c" * 64}
            )

    def test_from_report_rejects_analysis_errors_before_write(self) -> None:
        payload, _ = _report_payload(with_error=True)
        with tempfile.TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "report.json"
            report_path.write_text(json.dumps(payload), encoding="utf-8")
            with mock.patch.object(triage, "_validate_current_solver") as solver_check:
                with self.assertRaisesRegex(RuntimeError, "analysis errors"):
                    triage._apply_existing_report(
                        report_path=report_path,
                        bridge_path=Path("bridge.py"),
                        db_path="",
                        target_playlist="needReview",
                        target_parent_id=0,
                        copy_only=False,
                    )
            solver_check.assert_not_called()

    def test_direct_apply_without_report_is_forbidden(self) -> None:
        argv = [
            "move_rekordbox_playlist_grid_diffs.py",
            "--bridge",
            str(Path(triage.__file__)),
            "--apply",
        ]
        with mock.patch.object(sys, "argv", argv):
            with self.assertRaisesRegex(SystemExit, "direct --apply is forbidden"):
                triage.main()

    def test_from_report_binds_target_parent_and_move_copy(self) -> None:
        payload, _ = _report_payload()
        cases = (
            {
                "target_playlist": "otherReview",
                "target_parent_id": 0,
                "copy_only": False,
            },
            {
                "target_playlist": "needReview",
                "target_parent_id": 42,
                "copy_only": False,
            },
            {
                "target_playlist": "needReview",
                "target_parent_id": 0,
                "copy_only": True,
            },
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "report.json"
            report_path.write_text(json.dumps(payload), encoding="utf-8")
            for apply_request in cases:
                with self.subTest(apply_request=apply_request):
                    with self.assertRaisesRegex(RuntimeError, "does not match the dry-run report"):
                        triage._apply_existing_report(
                            report_path=report_path,
                            bridge_path=Path("bridge.py"),
                            db_path="",
                            **apply_request,
                        )

    def test_from_report_runs_all_guards_before_write(self) -> None:
        payload, _ = _report_payload()
        with tempfile.TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "report.json"
            report_path.write_text(json.dumps(payload), encoding="utf-8")
            with (
                mock.patch.object(triage, "_validate_current_solver") as solver_check,
                mock.patch.object(
                    triage, "_validate_current_workflow_guard"
                ) as workflow_check,
                mock.patch.object(
                    triage, "_validate_live_source_playlist", return_value=123
                ) as live_check,
                mock.patch.object(
                    triage, "_apply_playlist_updates", return_value={"applied": True}
                ) as apply_updates,
            ):
                result = triage._apply_existing_report(
                    report_path=report_path,
                    bridge_path=Path("bridge.py"),
                    db_path="",
                    target_playlist="needReview",
                    target_parent_id=0,
                    copy_only=False,
                )
        self.assertTrue(result["applied"])
        solver_check.assert_called_once()
        workflow_check.assert_called_once()
        live_check.assert_called_once()
        apply_updates.assert_called_once()


if __name__ == "__main__":
    unittest.main()
