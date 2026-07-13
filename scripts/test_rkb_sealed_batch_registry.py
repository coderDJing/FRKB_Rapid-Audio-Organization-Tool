import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable

from rkb_sealed_batch_common import (
    BENCHMARK_NAME,
    FINALIZATION_NAME,
    MANIFEST_NAME,
    SOLVER_LOCK_NAME,
    STATE_NAME,
    TRUTH_NAME,
    SealedBatchError,
    audio_roster_hash,
    build_registry_payload,
    rebuild_registry,
    sha256_file,
    sha256_json,
)
from rkb_dataset_relocation import ROOT_REMAP_FILE_NAME, create_root_remap_sidecar


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _row(label: str) -> dict[str, Any]:
    fingerprint = f"fingerprint-{label}"
    fingerprint_sha256 = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
    return {
        "fileName": f"{label}.wav",
        "normalizedFileName": f"{label}.wav",
        "size": len(label),
        "mtimeNs": 1,
        "assetSha256": hashlib.sha256(f"asset-{label}".encode()).hexdigest(),
        "pcmSha256": hashlib.sha256(f"pcm-{label}".encode()).hexdigest(),
        "fingerprint": fingerprint,
        "fingerprintSha256": fingerprint_sha256,
        "fingerprintDurationSec": 120.0,
        "familyId": f"chromaprint:{fingerprint_sha256}",
        "sourcePath": f"G:/FRKB_database-E/library/{label}.wav",
    }


class RegistryConsumedProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.batches = self.root / "sealed-batches"
        self.batches.mkdir()
        imported = self._create_imported("history-import")
        _write_json(
            self.root / "rkb-dataset-registry-baseline.json",
            {
                "schemaVersion": 1,
                "type": "rkb-dataset-registry-baseline",
                "expectedTrackCount": 1,
                "batches": [imported],
            },
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _truth_and_manifest(
        self, batch_id: str, origin: str
    ) -> tuple[Path, dict[str, Any], dict[str, Any]]:
        batch_dir = self.batches / batch_id
        batch_dir.mkdir()
        row = _row(batch_id)
        truth_path = batch_dir / TRUTH_NAME
        _write_json(truth_path, {"source": {}, "tracks": [{"fileName": row["fileName"]}]})
        audio = {
            "rosterHash": audio_roster_hash([row]),
            "trackCount": 1,
            "identityVersion": "asset+pcm+chromaprint-v1",
        }
        if origin in {"sealed-fresh", "reviewed-development"}:
            audio.update(
                {
                    "stagingRoot": f"G:/FRKB_database-E/library/sealed-intake/{batch_id}",
                    "archiveRoot": f"G:/FRKB_database-E/library/sealed-eval/{batch_id}",
                }
            )
        manifest = {
            "schemaVersion": 1,
            "type": (
                "rkb-consumed-dataset-manifest"
                if origin == "import-consumed"
                else "rkb-sealed-batch-manifest"
            ),
            "origin": {"kind": origin},
            "batchId": batch_id,
            "truth": {
                "path": str(truth_path),
                "sha256": sha256_file(truth_path),
                "trackCount": 1,
            },
            "audio": audio,
            "audioRoster": [row],
        }
        _write_json(batch_dir / MANIFEST_NAME, manifest)
        return batch_dir, manifest, row

    def _create_reviewed_development(self, batch_id: str = "reviewed-proof") -> Path:
        batch_dir, manifest, _row_data = self._truth_and_manifest(
            batch_id, "reviewed-development"
        )
        report_path = self.root / f"{batch_id}-pre-review.json"
        report_path.write_text('{"report":"pre-review"}\n', encoding="utf-8")
        manifest["origin"]["preReviewReport"] = {
            "path": str(report_path),
            "sha256": sha256_file(report_path),
        }
        _write_json(batch_dir / MANIFEST_NAME, manifest)
        finalization = {
            "schemaVersion": 1,
            "type": "rkb-reviewed-development-finalization",
            "batchId": batch_id,
            "decision": "consume",
            "evaluationStatus": "reviewed-development",
            "preReviewReportSha256": sha256_file(report_path),
            "freshProofEligible": False,
        }
        _write_json(batch_dir / FINALIZATION_NAME, finalization)
        state = {
            "schemaVersion": 1,
            "type": "rkb-sealed-batch-state",
            "batchId": batch_id,
            "status": "consumed",
            "manifestSha256": sha256_file(batch_dir / MANIFEST_NAME),
            "evaluation": {
                "status": "reviewed-development",
                "preReviewReportSha256": sha256_file(report_path),
                "freshProofEligible": False,
            },
            "finalization": {
                "decision": "consume",
                "path": str(batch_dir / FINALIZATION_NAME),
                "sha256": sha256_file(batch_dir / FINALIZATION_NAME),
            },
            "history": [
                {"from": None, "to": "consumed", "event": "prepare-reviewed-development"}
            ],
        }
        _write_json(batch_dir / STATE_NAME, state)
        return batch_dir

    def _create_imported(self, batch_id: str) -> dict[str, Any]:
        batch_dir, _, _ = self._truth_and_manifest(batch_id, "import-consumed")
        state = {
            "schemaVersion": 1,
            "type": "rkb-sealed-batch-state",
            "batchId": batch_id,
            "status": "consumed",
            "manifestSha256": sha256_file(batch_dir / MANIFEST_NAME),
            "evaluation": {"status": "imported-consumed"},
            "finalization": {"decision": "import-consumed"},
            "history": [{"from": None, "to": "consumed", "event": "import-consumed"}],
        }
        _write_json(batch_dir / STATE_NAME, state)
        return {
            "batchId": batch_id,
            "manifestSha256": sha256_file(batch_dir / MANIFEST_NAME),
            "stateSha256": sha256_file(batch_dir / STATE_NAME),
            "trackCount": 1,
        }

    def _create_active(self, batch_id: str) -> Path:
        batch_dir, _, _ = self._truth_and_manifest(batch_id, "sealed-fresh")
        locked = {"batchId": batch_id, "historicalSource": "does-not-exist-anymore.py"}
        solver_lock = {
            "schemaVersion": 1,
            "type": "rkb-sealed-solver-lock",
            "batchId": batch_id,
            "lockHash": sha256_json(locked),
            "locked": locked,
        }
        _write_json(batch_dir / SOLVER_LOCK_NAME, solver_lock)
        state = {
            "schemaVersion": 1,
            "type": "rkb-sealed-batch-state",
            "batchId": batch_id,
            "status": "fresh",
            "manifestSha256": sha256_file(batch_dir / MANIFEST_NAME),
            "solverLockFileSha256": sha256_file(batch_dir / SOLVER_LOCK_NAME),
            "solverLockHash": solver_lock["lockHash"],
            "evaluation": {"status": "not-started"},
            "finalization": None,
            "history": [{"from": None, "to": "fresh", "event": "prepare"}],
        }
        _write_json(batch_dir / STATE_NAME, state)
        return batch_dir

    def _create_finalized(self, batch_id: str = "sealed-proof") -> Path:
        batch_dir = self._create_active(batch_id)
        return self._finalize_active(batch_dir)

    def _finalize_active(self, batch_dir: Path) -> Path:
        batch_id = batch_dir.name
        solver_lock = json.loads((batch_dir / SOLVER_LOCK_NAME).read_text(encoding="utf-8"))
        _write_json(batch_dir / BENCHMARK_NAME, {"summary": {"trackTotal": 1}})
        benchmark_sha256 = sha256_file(batch_dir / BENCHMARK_NAME)
        finalization = {
            "schemaVersion": 1,
            "type": "rkb-sealed-batch-finalization",
            "batchId": batch_id,
            "decision": "consume",
            "evaluationStatus": "complete",
            "solverLockHash": solver_lock["lockHash"],
            "benchmarkSha256": benchmark_sha256,
        }
        _write_json(batch_dir / FINALIZATION_NAME, finalization)
        state = json.loads((batch_dir / STATE_NAME).read_text(encoding="utf-8"))
        state.update(
            {
                "status": "consumed",
                "evaluation": {
                    "status": "complete",
                    "benchmark": str(batch_dir / BENCHMARK_NAME),
                    "benchmarkSha256": benchmark_sha256,
                },
                "finalization": {
                    "decision": "consume",
                    "path": str(batch_dir / FINALIZATION_NAME),
                    "sha256": sha256_file(batch_dir / FINALIZATION_NAME),
                },
                "history": [
                    {"from": None, "to": "fresh", "event": "prepare"},
                    {"from": "fresh", "to": "evaluating", "event": "evaluate-start"},
                    {"from": "evaluating", "to": "exposed", "event": "evaluate-exposed"},
                    {"from": "exposed", "to": "consumed", "event": "finalize-consume"},
                ],
            }
        )
        _write_json(batch_dir / STATE_NAME, state)
        return batch_dir

    @staticmethod
    def _mutate_json(path: Path, mutate: Callable[[dict[str, Any]], None]) -> None:
        payload = json.loads(path.read_text(encoding="utf-8"))
        mutate(payload)
        _write_json(path, payload)

    def test_legal_finalized_batch_passes_without_current_source_lock_recalculation(self) -> None:
        self._create_finalized()

        registry = build_registry_payload(self.batches)

        self.assertEqual(registry["trackCount"], 2)
        sealed = next(item for item in registry["batches"] if item["batchId"] == "sealed-proof")
        self.assertEqual(sealed["status"], "consumed")
        self.assertEqual(sealed["origin"], "sealed-fresh")
        imported_track = next(
            item for item in registry["tracks"] if item["batchId"] == "history-import"
        )
        self.assertEqual(
            imported_track["sourcePath"],
            "G:/FRKB_database-E/library/history-import.wav",
        )

    def test_sealed_fresh_source_path_switches_from_staging_to_archive(self) -> None:
        batch_dir = self._create_active("path-switch")
        fresh_registry = build_registry_payload(self.batches)
        fresh_track = next(
            item for item in fresh_registry["tracks"] if item["batchId"] == "path-switch"
        )
        self.assertEqual(
            fresh_track["sourcePath"],
            str(
                Path("G:/FRKB_database-E/library/sealed-intake/path-switch")
                / "path-switch.wav"
            ),
        )

        self._finalize_active(batch_dir)
        consumed_registry = build_registry_payload(self.batches)
        consumed_track = next(
            item for item in consumed_registry["tracks"] if item["batchId"] == "path-switch"
        )
        self.assertEqual(
            consumed_track["sourcePath"],
            str(
                Path("G:/FRKB_database-E/library/sealed-eval/path-switch")
                / "path-switch.wav"
            ),
        )

    def test_reviewed_development_batch_is_consumed_but_not_fresh_proof(self) -> None:
        self._create_reviewed_development()

        registry = build_registry_payload(self.batches)

        reviewed = next(item for item in registry["batches"] if item["batchId"] == "reviewed-proof")
        self.assertEqual(reviewed["origin"], "reviewed-development")
        self.assertEqual(reviewed["status"], "consumed")
        reviewed_track = next(item for item in registry["tracks"] if item["batchId"] == "reviewed-proof")
        self.assertEqual(
            reviewed_track["sourcePath"],
            str(Path("G:/FRKB_database-E/library/sealed-eval/reviewed-proof") / "reviewed-proof.wav"),
        )

    def test_manually_forged_consumed_status_cannot_enter_registry(self) -> None:
        batch_dir = self._create_active("forged-consumed")
        self._mutate_json(batch_dir / STATE_NAME, lambda state: state.update(status="consumed"))

        with self.assertRaisesRegex(SealedBatchError, "proof is incomplete"):
            build_registry_payload(self.batches)

    def test_consumed_import_outside_initialized_baseline_is_rejected(self) -> None:
        self._create_imported("late-import")

        with self.assertRaisesRegex(SealedBatchError, "outside dataset baseline"):
            build_registry_payload(self.batches)

    def test_tampered_frozen_hash_chain_is_rejected(self) -> None:
        batch_dir = self._create_finalized()
        proof_paths = [
            batch_dir / MANIFEST_NAME,
            batch_dir / STATE_NAME,
            batch_dir / SOLVER_LOCK_NAME,
            batch_dir / TRUTH_NAME,
            batch_dir / BENCHMARK_NAME,
            batch_dir / FINALIZATION_NAME,
        ]
        originals = {path: path.read_bytes() for path in proof_paths}

        def restore() -> None:
            for path, payload in originals.items():
                path.write_bytes(payload)

        cases: list[tuple[str, Callable[[], None], str]] = [
            (
                "manifest-file-hash",
                lambda: self._mutate_json(
                    batch_dir / STATE_NAME,
                    lambda state: state.update(manifestSha256="0" * 64),
                ),
                "manifest hash mismatch",
            ),
            (
                "solver-lock-file-hash",
                lambda: self._mutate_json(
                    batch_dir / STATE_NAME,
                    lambda state: state.update(solverLockFileSha256="0" * 64),
                ),
                "solver-lock file hash",
            ),
            (
                "state-lock-hash",
                lambda: self._mutate_json(
                    batch_dir / STATE_NAME,
                    lambda state: state.update(solverLockHash="0" * 64),
                ),
                "solver-lock file hash",
            ),
            (
                "truth-hash",
                lambda: (batch_dir / TRUTH_NAME).write_text("{}\n", encoding="utf-8"),
                "truth contains no tracks|truth/roster hash",
            ),
            (
                "benchmark-hash",
                lambda: self._mutate_json(
                    batch_dir / STATE_NAME,
                    lambda state: state["evaluation"].update(benchmarkSha256="0" * 64),
                ),
                "benchmark hash/status",
            ),
            (
                "finalization-file-hash",
                lambda: self._mutate_json(
                    batch_dir / STATE_NAME,
                    lambda state: state["finalization"].update(sha256="0" * 64),
                ),
                "finalization file hash",
            ),
        ]
        for name, tamper, message in cases:
            with self.subTest(name=name):
                tamper()
                with self.assertRaisesRegex(SealedBatchError, message):
                    build_registry_payload(self.batches)
                restore()

    def test_internal_lock_finalization_hashes_and_history_are_cross_checked(self) -> None:
        batch_dir = self._create_finalized()
        proof_paths = [
            batch_dir / STATE_NAME,
            batch_dir / SOLVER_LOCK_NAME,
            batch_dir / FINALIZATION_NAME,
        ]
        originals = {path: path.read_bytes() for path in proof_paths}

        def restore() -> None:
            for path, payload in originals.items():
                path.write_bytes(payload)

        def tamper_internal_lock() -> None:
            self._mutate_json(
                batch_dir / SOLVER_LOCK_NAME,
                lambda lock: lock.update(lockHash="1" * 64),
            )
            self._mutate_json(
                batch_dir / STATE_NAME,
                lambda state: state.update(
                    solverLockFileSha256=sha256_file(batch_dir / SOLVER_LOCK_NAME),
                    solverLockHash="1" * 64,
                ),
            )

        def tamper_finalization_lock() -> None:
            self._mutate_json(
                batch_dir / FINALIZATION_NAME,
                lambda finalization: finalization.update(solverLockHash="2" * 64),
            )
            self._mutate_json(
                batch_dir / STATE_NAME,
                lambda state: state["finalization"].update(
                    sha256=sha256_file(batch_dir / FINALIZATION_NAME)
                ),
            )

        def tamper_finalization_benchmark() -> None:
            self._mutate_json(
                batch_dir / FINALIZATION_NAME,
                lambda finalization: finalization.update(benchmarkSha256="3" * 64),
            )
            self._mutate_json(
                batch_dir / STATE_NAME,
                lambda state: state["finalization"].update(
                    sha256=sha256_file(batch_dir / FINALIZATION_NAME)
                ),
            )

        def tamper_history() -> None:
            self._mutate_json(
                batch_dir / STATE_NAME,
                lambda state: state.update(history=[state["history"][0], state["history"][-1]]),
            )

        cases = [
            ("internal-lock", tamper_internal_lock, "internally inconsistent"),
            ("finalization-lock", tamper_finalization_lock, "finalization proof mismatch"),
            (
                "finalization-benchmark",
                tamper_finalization_benchmark,
                "finalization proof mismatch",
            ),
            ("history", tamper_history, "lifecycle history"),
        ]
        for name, tamper, message in cases:
            with self.subTest(name=name):
                tamper()
                with self.assertRaisesRegex(SealedBatchError, message):
                    build_registry_payload(self.batches)
                restore()

    def test_batch_ids_and_truth_roster_alignment_are_cross_checked(self) -> None:
        batch_dir = self._create_finalized()
        proof_paths = [
            batch_dir / MANIFEST_NAME,
            batch_dir / STATE_NAME,
            batch_dir / TRUTH_NAME,
        ]
        originals = {path: path.read_bytes() for path in proof_paths}

        def restore() -> None:
            for path, payload in originals.items():
                path.write_bytes(payload)

        def tamper_manifest_batch_id() -> None:
            self._mutate_json(
                batch_dir / MANIFEST_NAME,
                lambda manifest: manifest.update(batchId="other-batch"),
            )
            self._mutate_json(
                batch_dir / STATE_NAME,
                lambda state: state.update(manifestSha256=sha256_file(batch_dir / MANIFEST_NAME)),
            )

        def tamper_truth_alignment() -> None:
            _write_json(
                batch_dir / TRUTH_NAME,
                {"source": {}, "tracks": [{"fileName": "different.wav"}]},
            )
            self._mutate_json(
                batch_dir / MANIFEST_NAME,
                lambda manifest: manifest["truth"].update(
                    sha256=sha256_file(batch_dir / TRUTH_NAME)
                ),
            )
            self._mutate_json(
                batch_dir / STATE_NAME,
                lambda state: state.update(manifestSha256=sha256_file(batch_dir / MANIFEST_NAME)),
            )

        cases = [
            (
                "state-batch-id",
                lambda: self._mutate_json(
                    batch_dir / STATE_NAME,
                    lambda state: state.update(batchId="other-batch"),
                ),
                "state batchId mismatch",
            ),
            ("manifest-batch-id", tamper_manifest_batch_id, "manifest batchId mismatch"),
            ("truth-roster", tamper_truth_alignment, "roster alignment mismatch"),
        ]
        for name, tamper, message in cases:
            with self.subTest(name=name):
                tamper()
                with self.assertRaisesRegex(SealedBatchError, message):
                    build_registry_payload(self.batches)
                restore()


class RegistryRootRemapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.batches = self.root / "sealed-batches"
        self.batches.mkdir()
        self.source_root = self.root / "source-database"
        self.target_root = self.root / "target-database"
        self.source_file = self.source_root / "library" / "history-import.wav"
        self.target_file = self.target_root / "library" / "history-import.wav"
        self.source_file.parent.mkdir(parents=True)
        self.target_file.parent.mkdir(parents=True)
        payload = b"root-remap-audio"
        self.source_file.write_bytes(payload)
        self.target_file.write_bytes(payload)
        fingerprint = "root-remap-fingerprint"
        row = {
            "fileName": self.source_file.name,
            "normalizedFileName": self.source_file.name,
            "size": len(payload),
            "mtimeNs": 1,
            "assetSha256": sha256_file(self.source_file),
            "pcmSha256": hashlib.sha256(b"root-remap-pcm").hexdigest(),
            "fingerprint": fingerprint,
            "fingerprintSha256": hashlib.sha256(fingerprint.encode("utf-8")).hexdigest(),
            "fingerprintDurationSec": 120.0,
            "familyId": "chromaprint:root-remap",
            "sourcePath": str(self.source_file),
        }
        self.batch_dir = self.batches / "history-import"
        self.batch_dir.mkdir()
        truth_path = self.batch_dir / TRUTH_NAME
        _write_json(truth_path, {"source": {}, "tracks": [{"fileName": row["fileName"]}]})
        self.manifest_path = self.batch_dir / MANIFEST_NAME
        _write_json(
            self.manifest_path,
            {
                "schemaVersion": 1,
                "type": "rkb-consumed-dataset-manifest",
                "origin": {"kind": "import-consumed"},
                "batchId": "history-import",
                "truth": {
                    "path": str(truth_path),
                    "sha256": sha256_file(truth_path),
                    "trackCount": 1,
                },
                "audio": {"rosterHash": audio_roster_hash([row]), "trackCount": 1},
                "audioRoster": [row],
            },
        )
        self.state_path = self.batch_dir / STATE_NAME
        _write_json(
            self.state_path,
            {
                "schemaVersion": 1,
                "type": "rkb-sealed-batch-state",
                "batchId": "history-import",
                "status": "consumed",
                "manifestSha256": sha256_file(self.manifest_path),
                "evaluation": {"status": "imported-consumed"},
                "finalization": {"decision": "import-consumed"},
                "history": [{"from": None, "to": "consumed", "event": "import-consumed"}],
            },
        )
        self.baseline_path = self.root / "rkb-dataset-registry-baseline.json"
        _write_json(
            self.baseline_path,
            {
                "schemaVersion": 1,
                "type": "rkb-dataset-registry-baseline",
                "expectedTrackCount": 1,
                "batches": [
                    {
                        "batchId": "history-import",
                        "manifestSha256": sha256_file(self.manifest_path),
                        "stateSha256": sha256_file(self.state_path),
                        "trackCount": 1,
                    }
                ],
            },
        )
        self.registry_path = self.root / "rkb-dataset-registry.json"
        self.sidecar_path = self.root / ROOT_REMAP_FILE_NAME

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _create_sidecar(self) -> dict[str, Any]:
        return create_root_remap_sidecar(
            batches_root=self.batches,
            source_root=self.source_root,
            target_root=self.target_root,
            sidecar_path=self.sidecar_path,
            baseline_path=self.baseline_path,
        )

    def test_rebuild_maps_only_derived_registry_and_revalidates_target_audio(self) -> None:
        source_manifest = self.manifest_path.read_bytes()
        source_baseline = self.baseline_path.read_bytes()
        source_registry = build_registry_payload(self.batches, self.baseline_path)
        remap = self._create_sidecar()

        rebuilt = rebuild_registry(self.batches, self.registry_path, self.baseline_path)

        self.assertEqual(source_manifest, self.manifest_path.read_bytes())
        self.assertEqual(source_baseline, self.baseline_path.read_bytes())
        self.assertEqual(str(self.target_file), rebuilt["tracks"][0]["sourcePath"])
        self.assertEqual(remap["lockSha256"], rebuilt["sourcePathRelocation"]["lockSha256"])
        self.assertNotEqual(source_registry["tracks"][0]["sourcePath"], rebuilt["tracks"][0]["sourcePath"])
        for field in ("batchId", "fileName", "assetSha256", "pcmSha256", "familyId"):
            self.assertEqual(source_registry["tracks"][0][field], rebuilt["tracks"][0][field])
        with self.assertRaisesRegex(SealedBatchError, "immutable output already exists"):
            self._create_sidecar()

    def test_remap_rejects_mismatched_target_audio(self) -> None:
        self._create_sidecar()
        self.target_file.write_bytes(b"wrong-audio")

        with self.assertRaisesRegex(SealedBatchError, "target audio validation failed"):
            rebuild_registry(self.batches, self.registry_path, self.baseline_path)

    def test_remap_sidecar_cannot_be_rebound_to_another_source_registry(self) -> None:
        self._create_sidecar()
        sidecar = json.loads(self.sidecar_path.read_text(encoding="utf-8"))
        sidecar["locked"]["sourceRegistrySha256"] = "0" * 64
        sidecar["lockSha256"] = sha256_json(sidecar["locked"])
        _write_json(self.sidecar_path, sidecar)

        with self.assertRaisesRegex(SealedBatchError, "source registry hash"):
            rebuild_registry(self.batches, self.registry_path, self.baseline_path)

    def test_remap_rejects_a_manifest_path_outside_the_declared_source_root(self) -> None:
        outside_file = self.root / "outside.wav"
        outside_file.write_bytes(self.source_file.read_bytes())
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest["audioRoster"][0]["sourcePath"] = str(outside_file)
        manifest["audio"]["rosterHash"] = audio_roster_hash(manifest["audioRoster"])
        _write_json(self.manifest_path, manifest)
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        state["manifestSha256"] = sha256_file(self.manifest_path)
        _write_json(self.state_path, state)
        baseline = json.loads(self.baseline_path.read_text(encoding="utf-8"))
        baseline["batches"][0]["manifestSha256"] = sha256_file(self.manifest_path)
        baseline["batches"][0]["stateSha256"] = sha256_file(self.state_path)
        _write_json(self.baseline_path, baseline)

        with self.assertRaisesRegex(SealedBatchError, "not inside root remap sourceRoot"):
            self._create_sidecar()


if __name__ == "__main__":
    unittest.main()
