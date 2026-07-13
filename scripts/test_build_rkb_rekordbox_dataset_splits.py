import base64
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_rkb_rekordbox_dataset_splits as split_builder
from build_rkb_rekordbox_dataset_splits import (
    CANONICAL_HOLDOUT_RATIO,
    CANONICAL_SEED,
    CANONICAL_TUNE_RATIO,
    DEFAULT_BASELINE,
    DEFAULT_BATCHES_ROOT,
    DEFAULT_OUTPUT,
    DEFAULT_REGISTRY,
    _assign_split,
    _prepare_canonical_registry,
    _validate_output_contract,
    build_splits,
)
from rkb_audio_isolation_families import canonical_json_sha256
from rkb_sealed_batch_common import (
    audio_roster_hash,
    build_registry_payload,
    sha256_file,
)


def _pack_lsb_codes(values: list[int], width: int) -> bytes:
    output = bytearray((len(values) * width + 7) // 8)
    bit_offset = 0
    for value in values:
        for bit in range(width):
            if value & (1 << bit):
                absolute_bit = bit_offset + bit
                output[absolute_bit // 8] |= 1 << (absolute_bit % 8)
        bit_offset += width
    return bytes(output)


def _encode_fingerprint(frames: list[int], algorithm: int = 1) -> str:
    normal_codes: list[int] = []
    exceptional_codes: list[int] = []
    previous = 0
    for raw_value in frames:
        value = int(raw_value) ^ previous
        previous = int(raw_value)
        last_bit = 0
        bit = 1
        while value:
            if value & 1:
                delta = bit - last_bit
                if delta >= 7:
                    normal_codes.append(7)
                    exceptional_codes.append(delta - 7)
                else:
                    normal_codes.append(delta)
                last_bit = bit
            value >>= 1
            bit += 1
        normal_codes.append(0)
    compressed = (
        bytes([algorithm])
        + len(frames).to_bytes(3, "big")
        + _pack_lsb_codes(normal_codes, 3)
        + _pack_lsb_codes(exceptional_codes, 5)
    )
    return base64.urlsafe_b64encode(compressed).decode("ascii").rstrip("=")


def _test_frames(seed: str, count: int = 620) -> list[int]:
    state = int.from_bytes(hashlib.sha256(seed.encode("utf-8")).digest()[:4], "big")
    frames: list[int] = []
    for _ in range(count):
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        frames.append(state)
    return frames


def _add_test_fingerprint(row: dict[str, object]) -> None:
    if "fingerprint" not in row:
        seed = str(row.get("familyId") or row.get("assetSha256") or "test-audio")
        row["fingerprint"] = _encode_fingerprint(_test_frames(seed))
    fingerprint = str(row.get("fingerprint") or "")
    if fingerprint and "fingerprintSha256" not in row:
        row["fingerprintSha256"] = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()


class BuildRekordboxDatasetSplitsTest(unittest.TestCase):
    def _write_json(self, path: Path, payload: dict[str, object]) -> None:
        serializable = copy.deepcopy(payload)
        if path.name == "registry.json":
            for row in serializable.get("tracks") or []:
                if isinstance(row, dict):
                    _add_test_fingerprint(row)
        path.write_text(json.dumps(serializable), encoding="utf-8")

    def _write_sealed_batch(
        self,
        batches_root: Path,
        batch_id: str,
        tracks: list[dict[str, object]],
        *,
        source: dict[str, object] | None = None,
        origin: str = "import-consumed",
        status: str = "consumed",
    ) -> dict[str, object]:
        batch_dir = batches_root / batch_id
        batch_dir.mkdir(parents=True)
        truth_path = batch_dir / "truth.json"
        self._write_json(truth_path, {"source": source or {}, "tracks": tracks})
        roster: list[dict[str, object]] = []
        for index, track in enumerate(tracks):
            file_name = str(track["fileName"])
            row: dict[str, object] = {
                "fileName": file_name,
                "size": 1000 + index,
                "assetSha256": f"asset-{batch_id}-{index}",
                "pcmSha256": f"pcm-{batch_id}-{index}",
                "familyId": f"family-{batch_id}-{index}",
                "sourcePath": str(batch_dir / file_name),
            }
            _add_test_fingerprint(row)
            roster.append(row)
        audio: dict[str, object] = {
            "trackCount": len(roster),
            "rosterHash": audio_roster_hash(roster),
        }
        if origin == "sealed-fresh":
            audio["stagingRoot"] = str(batch_dir / "audio")
        manifest_path = batch_dir / "manifest.json"
        self._write_json(
            manifest_path,
            {
                "batchId": batch_id,
                "origin": {"kind": origin},
                "truth": {
                    "path": str(truth_path),
                    "sha256": sha256_file(truth_path),
                    "trackCount": len(tracks),
                },
                "audio": audio,
                "audioRoster": roster,
            },
        )
        state_path = batch_dir / "state.json"
        self._write_json(
            state_path,
            {
                "batchId": batch_id,
                "status": status,
                "manifestSha256": sha256_file(manifest_path),
                "finalization": (
                    {"decision": "import-consumed"} if origin == "import-consumed" else None
                ),
            },
        )
        return {
            "batchId": batch_id,
            "manifestSha256": sha256_file(manifest_path),
            "stateSha256": sha256_file(state_path),
            "trackCount": len(tracks),
        }

    def test_groups_recording_family_and_builds_lobo(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            truth_path = root / "truth.json"
            registry_path = root / "registry.json"
            self._write_json(
                truth_path,
                {
                    "tracks": [
                        {"fileName": "a.flac", "category": "pass"},
                        {"fileName": "a-remaster.flac", "category": "fail"},
                        {"fileName": "b.flac", "category": "pass"},
                    ]
                },
            )
            self._write_json(
                registry_path,
                {
                    "tracks": [
                        {
                            "fileName": "a.flac",
                            "familyId": "recording-a",
                            "batchId": "batch-a",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-a",
                        },
                        {
                            "fileName": "a-remaster.flac",
                            "familyId": "recording-a",
                            "batchId": "batch-a",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-a-remaster",
                        },
                        {
                            "fileName": "b.flac",
                            "familyId": "recording-b",
                            "pcmSha256": "bbb",
                            "batchId": "batch-b",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-b",
                        },
                        {
                            "fileName": "unrelated-fresh.flac",
                            "familyId": "fresh-recording",
                            "batchId": "fresh-batch",
                            "batchStatus": "fresh",
                            "assetSha256": "asset-fresh",
                        },
                    ]
                },
            )

            payload = build_splits(
                truth_path,
                registry_path,
                seed="test-seed",
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )

            family = next(
                row for row in payload["families"] if "recording-a" in row["exactFamilyIds"]
            )
            self.assertEqual(
                family["assignmentKey"], canonical_json_sha256(family["exactFamilyIds"])
            )
            self.assertEqual(
                family["split"], _assign_split(family["assignmentKey"], "test-seed", 0.2, 0.2)
            )
            assigned = payload["splits"][family["split"]]
            self.assertIn("batch-a:asset-a", assigned)
            self.assertIn("batch-a:asset-a-remaster", assigned)
            self.assertFalse(payload["splitPolicy"]["categoryOrPredictionUsed"])
            self.assertEqual(2, payload["summary"]["batchCount"])
            lobo = {row["batchId"]: row for row in payload["leaveOneBatchOut"]}
            self.assertEqual(
                ["batch-a:asset-a", "batch-a:asset-a-remaster"],
                lobo["batch-a"]["holdout"],
            )
            self.assertEqual(["batch-b:asset-b"], lobo["batch-a"]["development"])

    def test_lobo_excludes_cross_batch_family_from_development(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            truth_path = root / "truth.json"
            registry_path = root / "registry.json"
            self._write_json(
                truth_path,
                {"tracks": [{"fileName": "a.flac"}, {"fileName": "duplicate-a.mp3"}]},
            )
            self._write_json(
                registry_path,
                {
                    "tracks": [
                        {
                            "fileName": "a.flac",
                            "familyId": "recording-a",
                            "batchId": "old",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-old",
                        },
                        {
                            "fileName": "duplicate-a.mp3",
                            "familyId": "recording-a",
                            "batchId": "fresh",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-fresh",
                        },
                    ]
                },
            )

            payload = build_splits(
                truth_path,
                registry_path,
                seed="test-seed",
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )

            self.assertEqual(payload["summary"]["crossBatchFamilyCount"], 1)
            lobo = {row["batchId"]: row for row in payload["leaveOneBatchOut"]}
            self.assertEqual(lobo["old"]["holdout"], ["old:asset-old"])
            self.assertEqual(
                lobo["old"]["excludedDevelopmentIsolationFamilyLeakage"],
                ["fresh:asset-fresh"],
            )
            self.assertEqual(lobo["old"]["development"], [])

    def test_near_duplicate_exact_families_never_cross_split_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            truth_path = root / "truth.json"
            registry_path = root / "registry.json"
            base_frames = _test_frames("near-duplicate-base")
            near_frames = [value ^ 1 for value in base_frames]
            base_fingerprint = _encode_fingerprint(base_frames)
            near_fingerprint = _encode_fingerprint(near_frames)
            self._write_json(
                truth_path,
                {
                    "tracks": [
                        {"fileName": "near-a.flac"},
                        {"fileName": "near-b.flac"},
                        {"fileName": "unrelated.flac"},
                    ]
                },
            )
            self._write_json(
                registry_path,
                {
                    "tracks": [
                        {
                            "fileName": "near-a.flac",
                            "familyId": "exact-a",
                            "batchId": "batch-a",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-a",
                            "fingerprint": base_fingerprint,
                            "fingerprintSha256": hashlib.sha256(
                                base_fingerprint.encode("utf-8")
                            ).hexdigest(),
                        },
                        {
                            "fileName": "near-b.flac",
                            "familyId": "exact-b",
                            "batchId": "batch-b",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-b",
                            "fingerprint": near_fingerprint,
                            "fingerprintSha256": hashlib.sha256(
                                near_fingerprint.encode("utf-8")
                            ).hexdigest(),
                        },
                        {
                            "fileName": "unrelated.flac",
                            "familyId": "exact-c",
                            "batchId": "batch-c",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-c",
                        },
                    ]
                },
            )

            payload = build_splits(
                truth_path,
                registry_path,
                seed="test-seed",
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )

            instances = {row["instanceId"]: row for row in payload["instances"]}
            near_a = "batch-a:asset-a"
            near_b = "batch-b:asset-b"
            self.assertNotEqual(instances[near_a]["familyId"], instances[near_b]["familyId"])
            self.assertEqual(
                instances[near_a]["isolationFamilyId"],
                instances[near_b]["isolationFamilyId"],
            )
            self.assertEqual(payload["summary"]["exactFamilyCount"], 3)
            self.assertEqual(payload["summary"]["isolationFamilyCount"], 2)
            self.assertEqual(payload["audioIsolationStats"]["acceptedApproximateLinkCount"], 1)
            self.assertEqual(
                payload["audioIsolationPolicySha256"],
                payload["splitPolicy"]["audioIsolationPolicySha256"],
            )
            self.assertFalse(payload["splitPolicy"]["audioIsolationUsesTruthOrOutcome"])
            self.assertTrue(
                any(near_a in values and near_b in values for values in payload["splits"].values())
            )

            lobo = {row["batchId"]: row for row in payload["leaveOneBatchOut"]}
            self.assertEqual(
                lobo["batch-a"]["excludedDevelopmentIsolationFamilyLeakage"],
                [near_b],
            )
            self.assertNotIn(near_b, lobo["batch-a"]["development"])
            self.assertIn(near_a, lobo["batch-c"]["development"])
            self.assertIn(near_b, lobo["batch-c"]["development"])
            inner_train = set(lobo["batch-c"]["developmentTrain"])
            inner_tune = set(lobo["batch-c"]["developmentTune"])
            self.assertEqual(near_a in inner_train, near_b in inner_train)
            self.assertEqual(near_a in inner_tune, near_b in inner_tune)
            assignment_key = instances[near_a]["assignmentKey"]
            expected_inner = _assign_split(
                assignment_key,
                "test-seed:lobo:batch-c:inner",
                0.2,
                0.0,
            )
            self.assertEqual(near_a in inner_tune, expected_inner == "tune")

    def test_fresh_audio_cannot_drift_consumed_isolation_or_require_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            batches_root = root / "sealed-batches"
            consumed_dir = batches_root / "consumed"
            consumed_dir.mkdir(parents=True)
            registry_path = root / "registry.json"
            self._write_json(
                consumed_dir / "truth.json",
                {"tracks": [{"fileName": "consumed.flac"}]},
            )
            consumed_frames = _test_frames("consumed-stable-audio")
            consumed_fingerprint = _encode_fingerprint(consumed_frames)
            near_fresh_fingerprint = _encode_fingerprint(
                [value ^ 1 for value in consumed_frames]
            )

            def registry_payload(fresh_fingerprint: str) -> dict[str, object]:
                fresh_sha256 = (
                    hashlib.sha256(fresh_fingerprint.encode("utf-8")).hexdigest()
                    if fresh_fingerprint
                    else ""
                )
                return {
                    "batchesRoot": str(batches_root),
                    "tracks": [
                        {
                            "fileName": "consumed.flac",
                            "familyId": "exact-consumed",
                            "batchId": "consumed",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-consumed",
                            "fingerprint": consumed_fingerprint,
                            "fingerprintSha256": hashlib.sha256(
                                consumed_fingerprint.encode("utf-8")
                            ).hexdigest(),
                        },
                        {
                            "fileName": "fresh.flac",
                            "familyId": "exact-fresh",
                            "batchId": "fresh",
                            "batchStatus": "fresh",
                            "assetSha256": "asset-fresh",
                            "fingerprint": fresh_fingerprint,
                            "fingerprintSha256": fresh_sha256,
                        },
                    ],
                }

            self._write_json(registry_path, registry_payload(""))
            without_fresh_identity = build_splits(
                consumed_dir / "truth.json",
                registry_path,
                truth_batch_id="consumed",
                seed="test-seed",
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )
            self._write_json(registry_path, registry_payload(near_fresh_fingerprint))
            with_near_fresh = build_splits(
                consumed_dir / "truth.json",
                registry_path,
                truth_batch_id="consumed",
                seed="test-seed",
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )

            for key in ("summary", "instances", "families", "splits", "leaveOneBatchOut"):
                self.assertEqual(without_fresh_identity[key], with_near_fresh[key])
            self.assertEqual(
                without_fresh_identity["audioIsolationStats"],
                with_near_fresh["audioIsolationStats"],
            )
            self.assertEqual(with_near_fresh["excludedNonConsumedBatches"], [])
            self.assertEqual(with_near_fresh["audioIsolationStats"]["instanceCount"], 1)
            self.assertEqual(
                with_near_fresh["audioIsolationRegistryScope"],
                "batchStatus=consumed",
            )

    def test_fails_closed_when_registry_fingerprint_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            truth_path = root / "truth.json"
            registry_path = root / "registry.json"
            self._write_json(truth_path, {"tracks": [{"fileName": "missing.flac"}]})
            self._write_json(
                registry_path,
                {
                    "tracks": [
                        {
                            "fileName": "missing.flac",
                            "familyId": "exact-a",
                            "batchId": "batch-a",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-a",
                            "fingerprint": "",
                            "fingerprintSha256": "",
                        }
                    ]
                },
            )

            with self.assertRaisesRegex(RuntimeError, "missing fingerprint"):
                build_splits(
                    truth_path,
                    registry_path,
                    seed="test-seed",
                    tune_ratio=0.2,
                    holdout_ratio=0.2,
                )

    def test_fails_closed_without_exact_family_instead_of_pcm_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            truth_path = root / "truth.json"
            registry_path = root / "registry.json"
            self._write_json(truth_path, {"tracks": [{"fileName": "missing-family.flac"}]})
            self._write_json(
                registry_path,
                {
                    "tracks": [
                        {
                            "fileName": "missing-family.flac",
                            "pcmSha256": "pcm-only-is-not-enough",
                            "batchId": "batch-a",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-a",
                        }
                    ]
                },
            )

            with self.assertRaisesRegex(RuntimeError, "missing immutable familyId"):
                build_splits(
                    truth_path,
                    registry_path,
                    seed="test-seed",
                    tune_ratio=0.2,
                    holdout_ratio=0.2,
                )

    def test_rejects_duplicate_truth_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            truth_path = root / "truth.json"
            registry_path = root / "registry.json"
            self._write_json(
                truth_path,
                {"tracks": [{"fileName": "same.flac"}, {"fileName": "SAME.FLAC"}]},
            )
            self._write_json(
                registry_path,
                {
                    "tracks": [
                        {
                            "fileName": "same.flac",
                            "familyId": "recording",
                            "batchId": "batch",
                            "batchStatus": "consumed",
                            "assetSha256": "asset",
                        }
                    ]
                },
            )

            with self.assertRaisesRegex(RuntimeError, "duplicate instanceId"):
                build_splits(
                    truth_path,
                    registry_path,
                    seed="test-seed",
                    tune_ratio=0.2,
                    holdout_ratio=0.2,
                )

    def test_rejects_fresh_track_from_development_split(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            truth_path = root / "truth.json"
            registry_path = root / "registry.json"
            self._write_json(truth_path, {"tracks": [{"fileName": "fresh.flac"}]})
            self._write_json(
                registry_path,
                {
                    "tracks": [
                        {
                            "fileName": "fresh.flac",
                            "familyId": "recording",
                            "batchId": "fresh-batch",
                            "batchStatus": "fresh",
                            "assetSha256": "asset",
                        }
                    ]
                },
            )

            with self.assertRaisesRegex(
                RuntimeError, "not consumed|no consumed audio isolation rows"
            ):
                build_splits(
                    truth_path,
                    registry_path,
                    seed="test-seed",
                    tune_ratio=0.2,
                    holdout_ratio=0.2,
                )

    def test_explicit_truth_propagates_diagnostic_evidence_policy_and_v4_truth(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            truth_path = root / "truth.json"
            registry_path = root / "registry.json"
            self._write_json(
                truth_path,
                {
                    "source": {
                        "batchId": "recovered-batch",
                        "referenceScope": "current-db-recovered-reference",
                        "isHistoricalFrozenSnapshot": False,
                        "allowedUses": ["development-labeling"],
                        "forbiddenUses": [
                            "historical-fresh-proof",
                            "historical-benchmark-reconstruction",
                        ],
                    },
                    "tracks": [{"fileName": "recovered.flac"}],
                },
            )
            self._write_json(
                registry_path,
                {
                    "tracks": [
                        {
                            "fileName": "recovered.flac",
                            "familyId": "exact-recovered",
                            "batchId": "recovered-batch",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-recovered",
                        }
                    ]
                },
            )

            payload = build_splits(
                truth_path,
                registry_path,
                seed="test-seed",
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )

            policy = payload["truthSources"][0]["evidencePolicy"]
            self.assertEqual(payload["truthSources"][0]["batchId"], "recovered-batch")
            self.assertEqual(policy["scope"], "current-db-recovered-reference")
            self.assertFalse(policy["primaryEvaluationEligible"])
            self.assertFalse(policy["freshProofEligible"])
            self.assertEqual(payload["summary"]["primaryEvaluationBatchCount"], 0)
            self.assertEqual(payload["summary"]["diagnosticOnlyBatchCount"], 1)
            lobo = payload["leaveOneBatchOut"][0]
            self.assertFalse(lobo["primaryAggregateEligible"])
            self.assertFalse(lobo["freshProofEligible"])
            self.assertEqual(lobo["evaluationRole"], "diagnostic-development-reference")
            expected_assignment_hash = canonical_json_sha256(
                {
                    "seed": payload["seed"],
                    "audioIsolationPolicySha256": payload[
                        "audioIsolationPolicySha256"
                    ],
                    "assignmentDigestSha256": payload["assignmentDigestSha256"],
                }
            )
            self.assertEqual(payload["splitAssignmentsSha256"], expected_assignment_hash)
            self.assertEqual(
                payload["splitPolicy"]["splitAssignmentsSha256"],
                expected_assignment_hash,
            )
            for split_name, truth_split in payload["truthSplits"].items():
                self.assertEqual(truth_split["version"], 4)
                self.assertEqual(truth_split["groupKey"], "isolationFamilyId")
                self.assertEqual(truth_split["trackCount"], len(payload["splits"][split_name]))
                self.assertTrue(
                    all("isolationFamilyId" in track for track in truth_split["tracks"])
                )
                self.assertTrue(all("assignmentKey" in track for track in truth_split["tracks"]))
                parent = truth_split["parentSplit"]
                self.assertEqual(parent["registrySha256"], payload["registrySha256"])
                self.assertEqual(parent["truthSourcesSha256"], payload["truthSourcesSha256"])
                self.assertEqual(parent["seed"], payload["seed"])
                self.assertEqual(parent["tuneRatio"], 0.2)
                self.assertEqual(parent["holdoutRatio"], 0.2)
                self.assertEqual(
                    parent["assignmentDigestSha256"], payload["assignmentDigestSha256"]
                )
                self.assertEqual(
                    parent["splitAssignmentsSha256"], payload["splitAssignmentsSha256"]
                )

    def test_auto_loads_consumed_batches_with_cross_batch_same_filename(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            batches_root = root / "sealed-batches"
            registry_path = root / "registry.json"
            snapshot_a = self._write_sealed_batch(
                batches_root,
                "batch-a",
                [{"fileName": "same-name.flac", "bpm": 128.0}],
            )
            snapshot_b = self._write_sealed_batch(
                batches_root,
                "batch-b",
                [{"fileName": "same-name.flac", "bpm": 130.0}],
                source={
                    "referenceScope": "current-db-recovered-reference",
                    "isHistoricalFrozenSnapshot": False,
                    "forbiddenUses": ["historical-benchmark-reconstruction"],
                },
            )
            self._write_sealed_batch(
                batches_root,
                "future",
                [{"fileName": "future.flac", "bpm": 132.0}],
                origin="sealed-fresh",
                status="fresh",
            )
            self._write_json(registry_path, build_registry_payload(batches_root))

            payload = build_splits(
                None,
                registry_path,
                batches_root=batches_root,
                baseline_payload={"batches": [snapshot_a, snapshot_b]},
                seed="test-seed",
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )

            self.assertEqual(2, payload["summary"]["trackCount"])
            self.assertEqual(2, payload["summary"]["batchCount"])
            self.assertEqual(1, payload["summary"]["primaryEvaluationBatchCount"])
            self.assertEqual(1, payload["summary"]["diagnosticOnlyBatchCount"])
            self.assertEqual(["future"], payload["excludedNonConsumedBatches"])
            self.assertEqual(
                {"batch-a:asset-batch-a-0", "batch-b:asset-batch-b-0"},
                {row["instanceId"] for row in payload["instances"]},
            )
            split_truth_instances = {
                track["instanceId"]
                for split in payload["truthSplits"].values()
                for track in split["tracks"]
            }
            self.assertEqual(
                {"batch-a:asset-batch-a-0", "batch-b:asset-batch-b-0"},
                split_truth_instances,
            )
            lobo = {row["batchId"]: row for row in payload["leaveOneBatchOut"]}
            self.assertEqual(["batch-a:asset-batch-a-0"], lobo["batch-a"]["holdout"])
            self.assertEqual(["batch-b:asset-batch-b-0"], lobo["batch-a"]["development"])
            self.assertTrue(lobo["batch-a"]["primaryAggregateEligible"])
            self.assertFalse(lobo["batch-b"]["primaryAggregateEligible"])
            self.assertEqual(
                "diagnostic-development-reference",
                lobo["batch-b"]["evaluationRole"],
            )
            self.assertEqual(
                set(lobo["batch-a"]["development"]),
                set(lobo["batch-a"]["developmentTrain"])
                | set(lobo["batch-a"]["developmentTune"]),
            )

    def test_canonical_output_locks_seed_ratios_and_truth_files(self) -> None:
        _validate_output_contract(
            output_path=DEFAULT_OUTPUT,
            write_truth_files=True,
            seed=CANONICAL_SEED,
            tune_ratio=CANONICAL_TUNE_RATIO,
            holdout_ratio=CANONICAL_HOLDOUT_RATIO,
        )
        with self.assertRaisesRegex(RuntimeError, "locked seed"):
            _validate_output_contract(
                output_path=DEFAULT_OUTPUT,
                write_truth_files=True,
                seed="cherry-picked-seed",
                tune_ratio=CANONICAL_TUNE_RATIO,
                holdout_ratio=CANONICAL_HOLDOUT_RATIO,
            )
        with self.assertRaisesRegex(RuntimeError, "non-canonical diagnostic"):
            _validate_output_contract(
                output_path=DEFAULT_OUTPUT,
                write_truth_files=False,
                seed=CANONICAL_SEED,
                tune_ratio=CANONICAL_TUNE_RATIO,
                holdout_ratio=CANONICAL_HOLDOUT_RATIO,
            )
        for kwargs, message in (
            ({"truth_path": Path("subset.json")}, "forbids --truth"),
            ({"truth_batch_id": "alternate"}, "forbids --truth"),
            ({"registry_path": Path("alternate-registry.json")}, "default dataset registry"),
            ({"batches_root": Path("alternate-batches")}, "default sealed batches root"),
        ):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(RuntimeError, message):
                _validate_output_contract(
                    output_path=DEFAULT_OUTPUT,
                    write_truth_files=True,
                    seed=CANONICAL_SEED,
                    tune_ratio=CANONICAL_TUNE_RATIO,
                    holdout_ratio=CANONICAL_HOLDOUT_RATIO,
                    **kwargs,
                )
        _validate_output_contract(
            output_path=DEFAULT_OUTPUT,
            write_truth_files=True,
            seed=CANONICAL_SEED,
            tune_ratio=CANONICAL_TUNE_RATIO,
            holdout_ratio=CANONICAL_HOLDOUT_RATIO,
            batches_root=DEFAULT_BATCHES_ROOT,
        )
        _validate_output_contract(
            output_path=Path("diagnostic-split.json"),
            write_truth_files=False,
            seed="diagnostic-seed",
            tune_ratio=0.1,
            holdout_ratio=0.3,
        )

    def test_canonical_registry_is_rebuilt_then_verified_before_use(self) -> None:
        rebuilt = {"generatedAt": "first", "tracks": []}
        verified = {"generatedAt": "second", "tracks": []}
        baseline = {"type": "rkb-dataset-registry-baseline", "batches": []}
        with patch.object(split_builder, "rebuild_registry", return_value=rebuilt) as rebuild:
            with patch.object(
                split_builder,
                "verify_registry_baseline",
                return_value=(verified, baseline),
            ) as verify:
                self.assertEqual(_prepare_canonical_registry(), (verified, baseline))
        rebuild.assert_called_once_with(
            DEFAULT_BATCHES_ROOT,
            DEFAULT_REGISTRY,
            baseline_path=DEFAULT_BASELINE,
            use_auto_root_remap=True,
        )
        verify.assert_called_once_with(
            batches_root=DEFAULT_BATCHES_ROOT,
            registry_path=DEFAULT_REGISTRY,
            baseline_path=DEFAULT_BASELINE,
        )

    def test_hand_edited_consumed_registry_cannot_override_authoritative_fresh_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            registry_path = root / "registry.json"
            self._write_json(
                registry_path,
                {
                    "batches": [{"batchId": "batch-a", "status": "consumed"}],
                    "tracks": [
                        {
                            "fileName": "a.flac",
                            "familyId": "family-a",
                            "batchId": "batch-a",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-a",
                        }
                    ],
                },
            )
            authoritative = json.loads(registry_path.read_text(encoding="utf-8"))
            authoritative["batches"][0]["status"] = "fresh"
            authoritative["tracks"][0]["batchStatus"] = "fresh"
            with self.assertRaisesRegex(RuntimeError, "authoritative sealed batch artifacts"):
                build_splits(
                    None,
                    registry_path,
                    authoritative_registry_payload=authoritative,
                    seed="test-seed",
                    tune_ratio=0.2,
                    holdout_ratio=0.2,
                )

    def test_automatic_truth_requires_evidence_before_primary_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            batches_root = root / "sealed-batches"
            registry_path = root / "registry.json"
            self._write_sealed_batch(
                batches_root,
                "batch-a",
                [{"fileName": "a.flac", "bpm": 128.0}],
            )
            self._write_json(registry_path, build_registry_payload(batches_root))
            payload = build_splits(
                None,
                registry_path,
                batches_root=batches_root,
                seed="test-seed",
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )
            policy = payload["truthSources"][0]["evidencePolicy"]
            self.assertFalse(policy["primaryEvaluationEligible"])
            self.assertFalse(policy["evidence"]["baselineSnapshotVerified"])
            self.assertEqual(payload["summary"]["primaryEvaluationBatchCount"], 0)

    def test_automatic_truth_uses_authoritative_registry_archive_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            batches_root = root / "sealed-batches"
            registry_path = root / "registry.json"
            snapshot = self._write_sealed_batch(
                batches_root,
                "batch-a",
                [{"fileName": "a.flac", "bpm": 128.0}],
            )
            registry = build_registry_payload(batches_root)
            archive_path = "G:/archive/batch-a/a.flac"
            registry["tracks"][0]["sourcePath"] = archive_path
            self._write_json(registry_path, registry)
            payload = build_splits(
                None,
                registry_path,
                batches_root=batches_root,
                authoritative_registry_payload=registry,
                baseline_payload={"batches": [snapshot]},
                seed="test-seed",
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )
            derived_tracks = [
                track for truth in payload["truthSplits"].values() for track in truth["tracks"]
            ]
            self.assertEqual(payload["instances"][0]["sourcePath"], archive_path)
            self.assertEqual(derived_tracks[0]["sourcePath"], archive_path)

    def test_automatic_truth_rejects_subset_alternate_and_tampered_artifacts(self) -> None:
        for variant in ("subset", "alternate", "labels", "manifest-sha", "roster"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                batches_root = root / "sealed-batches"
                batch_dir = batches_root / "batch-a"
                registry_path = root / "registry.json"
                self._write_sealed_batch(
                    batches_root,
                    "batch-a",
                    [{"fileName": "a.flac", "bpm": 128.0}, {"fileName": "b.flac", "bpm": 130.0}],
                )
                self._write_json(registry_path, build_registry_payload(batches_root))
                truth_path = batch_dir / "truth.json"
                manifest_path = batch_dir / "manifest.json"
                state_path = batch_dir / "state.json"
                if variant in {"subset", "alternate", "labels"}:
                    truth = json.loads(truth_path.read_text(encoding="utf-8"))
                    if variant == "subset": truth["tracks"].pop()
                    if variant == "alternate": truth["tracks"][0]["fileName"] = "other.flac"
                    if variant == "labels": truth["tracks"][0]["bpm"] = 64.0
                    self._write_json(truth_path, truth)
                else:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    if variant == "manifest-sha": manifest["truth"]["sha256"] = "0" * 64
                    if variant == "roster": manifest["audioRoster"][0]["fileName"] = "other.flac"
                    self._write_json(manifest_path, manifest)
                    state = json.loads(state_path.read_text(encoding="utf-8"))
                    state["manifestSha256"] = sha256_file(manifest_path)
                    self._write_json(state_path, state)
                with self.assertRaisesRegex(RuntimeError, "truth|roster|alignment"):
                    build_splits(
                        None,
                        registry_path,
                        batches_root=batches_root,
                        seed="test-seed",
                        tune_ratio=0.2,
                        holdout_ratio=0.2,
                    )

    def test_cli_writes_truth_files_by_default_and_protects_canonical_no_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            truth_path = root / "truth.json"
            registry_path = root / "registry.json"
            output_path = root / "cli-splits.json"
            self._write_json(
                truth_path,
                {
                    "source": {"batchId": "batch-a"},
                    "tracks": [{"fileName": "a.flac"}],
                },
            )
            self._write_json(
                registry_path,
                {
                    "tracks": [
                        {
                            "fileName": "a.flac",
                            "familyId": "exact-a",
                            "batchId": "batch-a",
                            "batchStatus": "consumed",
                            "assetSha256": "asset-a",
                        }
                    ]
                },
            )
            script_path = Path(__file__).with_name("build_rkb_rekordbox_dataset_splits.py")
            subprocess.run(
                [
                    sys.executable,
                    str(script_path),
                    "--truth",
                    str(truth_path),
                    "--registry",
                    str(registry_path),
                    "--output",
                    str(output_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )

            main_payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(main_payload["registryPath"], str(registry_path.resolve()))
            parent_file_sha256 = sha256_file(output_path)
            for split in ("train", "tune", "holdout"):
                truth_output = output_path.with_name(f"{output_path.stem}-{split}-truth.json")
                self.assertTrue(truth_output.is_file())
                truth_payload = json.loads(truth_output.read_text(encoding="utf-8"))
                parent = truth_payload["parentSplit"]
                self.assertEqual(
                    parent["parentSplitPath"], str(output_path.resolve())
                )
                self.assertEqual(parent["parentSplitFileSha256"], parent_file_sha256)
                roster = sorted(
                    (
                        {
                            "instanceId": track["instanceId"],
                            "assignmentKey": track["assignmentKey"],
                            "isolationFamilyId": track["isolationFamilyId"],
                        }
                        for track in truth_payload["tracks"]
                    ),
                    key=lambda row: (
                        row["instanceId"], row["assignmentKey"], row["isolationFamilyId"]
                    ),
                )
                self.assertEqual(parent["splitRosterSha256"], canonical_json_sha256(roster))
                self.assertEqual(parent["registrySha256"], main_payload["registrySha256"])
                self.assertEqual(
                    parent["truthSourcesSha256"], main_payload["truthSourcesSha256"]
                )
                self.assertEqual(parent["seed"], main_payload["seed"])
                self.assertEqual(parent["tuneRatio"], main_payload["splitPolicy"]["tuneRatio"])
                self.assertEqual(
                    parent["holdoutRatio"], main_payload["splitPolicy"]["holdoutRatio"]
                )
                self.assertEqual(
                    parent["assignmentDigestSha256"], main_payload["assignmentDigestSha256"]
                )
                self.assertEqual(
                    parent["splitAssignmentsSha256"], main_payload["splitAssignmentsSha256"]
                )

            protected = subprocess.run(
                [sys.executable, str(script_path), "--no-write-truth-files"],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(protected.returncode, 0)
            self.assertIn(
                "requires a non-canonical diagnostic --output path",
                protected.stderr,
            )


if __name__ == "__main__":
    unittest.main()
