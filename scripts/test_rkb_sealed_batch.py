import hashlib
import json
import os
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

import rkb_sealed_batch as sealed
import rkb_sealed_batch_prepare_support as prepare_support
from rkb_dataset_contract import (
    DATASET_LOCK_NAME,
    DatasetContractError,
    attach_benchmark_result_digest,
    validate_sealed_benchmark_output,
)
from rkb_sealed_batch_common import (
    SealedBatchError,
    load_json,
    registry_identity_index,
    transition_state,
)


class SealedBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.batches = self.root / "batches"
        self.registry = self.root / "registry.json"
        self.baseline = self.root / "baseline.json"
        self.intake = self.root / "sealed-intake"
        self.archive = self.root / "sealed-eval"
        self.sources = self.root / "sources"
        self.sources.mkdir()
        self.current_truth = self.root / "current-truth.json"
        self.current_truth.write_text('{"source": {}, "tracks": []}\n', encoding="utf-8")
        self.checkpoint = self.root / "final0.ckpt"
        self.checkpoint.write_bytes(b"checkpoint-v1")
        self.ffmpeg = self.root / "ffmpeg.exe"
        self.ffprobe = self.root / "ffprobe.exe"
        self.ffmpeg.write_bytes(b"fake")
        self.ffprobe.write_bytes(b"fake")
        self.bridge = self.root / "bridge.py"
        self.bridge.write_text("# fake\n", encoding="utf-8")
        self.playlist_json = self.root / "playlist.json"
        self.sync_script = self._write_script("fake_sync.py", FAKE_SYNC)
        self.capture_script = self._write_script("fake_capture.py", FAKE_CAPTURE)
        self.feature_script = self._write_script("fake_feature.py", FAKE_FEATURE)
        self.benchmark_script = self._write_script("fake_benchmark.py", FAKE_BENCHMARK)
        self.identity_helper = self._write_script("fake_identity.mjs", FAKE_IDENTITY)
        self.environment = patch.dict(
            os.environ,
            {"FAKE_PLAYLIST_JSON": str(self.playlist_json)},
            clear=False,
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temp.cleanup()

    def _write_script(self, name: str, source: str) -> Path:
        path = self.root / name
        path.write_text(textwrap.dedent(source).lstrip(), encoding="utf-8")
        return path

    def _write_playlist(self, rows: list[dict[str, object]]) -> None:
        self.playlist_json.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    def _v2_truth_track(self, file_name: str, **extra: object) -> dict[str, object]:
        return {
            "fileName": file_name,
            "beatGridMap": {
                "version": 2,
                "source": "manual",
                "signature": "sbgm_test",
                "clips": [
                    {
                        "startSec": 0,
                        "anchorSec": 0,
                        "bpm": 120.0,
                        "downbeatBeatOffset": 0,
                    }
                ],
            },
            **extra,
        }

    def _storage_args(self) -> list[str]:
        return [
            "--batches-root",
            str(self.batches),
            "--registry",
            str(self.registry),
            "--baseline",
            str(self.baseline),
        ]

    def _identity_args(self) -> list[str]:
        return [
            "--node",
            "node",
            "--identity-helper",
            str(self.identity_helper),
            "--identity-cache-dir",
            str(self.root / "identity-cache"),
            "--identity-chunk-size",
            "2",
        ]

    def _import_baseline(self, *, content: bytes = b"old-audio") -> None:
        audio_root = self.root / "consumed-audio"
        audio_root.mkdir(exist_ok=True)
        (audio_root / "old.wav").write_bytes(content)
        truth = self.root / "consumed-truth.json"
        truth.write_text(
            json.dumps(
                {
                    "source": {"type": "test"},
                    "tracks": [
                        self._v2_truth_track(
                            "old.wav",
                            title="old",
                            artist="tester",
                        )
                    ],
                }
            ),
            encoding="utf-8",
        )
        sealed.run(
            [
                "import-consumed",
                *self._storage_args(),
                *self._identity_args(),
                "--batch-id",
                "consumed-current",
                "--truth",
                str(truth),
                "--audio-root",
                str(audio_root),
            ]
        )
        sealed.run(
            [
                "initialize-registry",
                *self._storage_args(),
                "--expected-track-count",
                "1",
                "--expected-batch",
                "consumed-current=1",
            ]
        )

    def test_initialize_registry_rejects_wrong_expected_batch_plan(self) -> None:
        audio_root = self.root / "consumed-audio"
        audio_root.mkdir()
        (audio_root / "old.wav").write_bytes(b"old-audio")
        truth = self.root / "consumed-truth.json"
        truth.write_text(json.dumps({"tracks": [self._v2_truth_track("old.wav")]}), encoding="utf-8")
        sealed.run(
            [
                "import-consumed",
                *self._storage_args(),
                *self._identity_args(),
                "--batch-id",
                "consumed-current",
                "--truth",
                str(truth),
                "--audio-root",
                str(audio_root),
            ]
        )

        with self.assertRaisesRegex(SealedBatchError, "do not match --expected-batch"):
            sealed.run(
                [
                    "initialize-registry",
                    *self._storage_args(),
                    "--expected-track-count",
                    "1",
                    "--expected-batch",
                    "wrong-batch=1",
                ]
            )

    def test_import_consumed_is_disabled_after_registry_baseline_initialization(self) -> None:
        self._import_baseline()
        audio_root = self.root / "late-consumed-audio"
        audio_root.mkdir()
        (audio_root / "late.wav").write_bytes(b"late-consumed")
        truth = self.root / "late-consumed-truth.json"
        truth.write_text(json.dumps({"tracks": [self._v2_truth_track("late.wav")]}), encoding="utf-8")

        with self.assertRaisesRegex(SealedBatchError, "disabled after registry baseline"):
            sealed.run(
                [
                    "import-consumed",
                    *self._storage_args(),
                    *self._identity_args(),
                    "--batch-id",
                    "late-consumed",
                    "--truth",
                    str(truth),
                    "--audio-root",
                    str(audio_root),
                ]
            )

    def test_root_remap_cli_creates_immutable_sidecar_and_rebuilds_registry(self) -> None:
        self._import_baseline()
        target_root = self.root / "relocated-database"
        target_audio = target_root / "consumed-audio"
        target_audio.mkdir(parents=True)
        shutil.copyfile(self.root / "consumed-audio" / "old.wav", target_audio / "old.wav")

        sidecar = sealed.run(
            [
                "create-root-remap",
                *self._storage_args(),
                "--source-root",
                str(self.root),
                "--target-root",
                str(target_root),
            ]
        )
        rebuilt = sealed.run(["rebuild-registry", *self._storage_args()])

        self.assertTrue(Path(str(sidecar["sidecar"])).is_file())
        self.assertEqual(str(target_root), rebuilt["sourcePathRelocation"]["targetRoot"])
        registry = load_json(self.registry)
        self.assertEqual(
            str(target_audio / "old.wav"),
            registry["tracks"][0]["sourcePath"],
        )

        self.assertFalse((self.batches / "late-consumed").exists())
        self.assertEqual(load_json(self.registry)["trackCount"], 1)

    def _prepare(self, file_name: str = "fresh.wav", content: bytes = b"fresh-audio") -> dict[str, object]:
        source = self.sources / file_name
        source.write_bytes(content)
        self._write_playlist(
            [
                {
                    "fileName": file_name,
                    "filePath": str(source),
                    "title": "fresh",
                    "artist": "tester",
                    "gridBpm": 128.0,
                    "gridFirstBeatMs": 10.0,
                    "gridFirstBeatLabel": 1,
                    "gridBarBeatOffset": 0,
                }
            ]
        )
        return sealed.run(
            [
                "prepare",
                *self._storage_args(),
                *self._identity_args(),
                "--playlist",
                "test",
                "--python",
                sys.executable,
                "--checkpoint",
                str(self.checkpoint),
                "--audio-intake-root",
                str(self.intake),
                "--audio-archive-root",
                str(self.archive),
                "--bridge",
                str(self.bridge),
                "--current-truth",
                str(self.current_truth),
                "--sync-script",
                str(self.sync_script),
                "--capture-script",
                str(self.capture_script),
                "--feature-cache-script",
                str(self.feature_script),
                "--benchmark-script",
                str(self.benchmark_script),
                "--ffmpeg",
                str(self.ffmpeg),
                "--ffprobe",
                str(self.ffprobe),
            ]
        )

    def test_prepare_requires_initialized_consumed_registry(self) -> None:
        with self.assertRaisesRegex(SealedBatchError, "uninitialized"):
            self._prepare()

    def test_reviewed_development_prepare_consumes_without_fresh_evaluation(self) -> None:
        self._import_baseline()
        source = self.sources / "reviewed.wav"
        content = b"reviewed-audio"
        source.write_bytes(content)
        self._write_playlist(
            [
                {
                    "fileName": "reviewed.wav",
                    "filePath": str(source),
                    "title": "reviewed",
                    "artist": "tester",
                    "gridBpm": 128.0,
                    "gridFirstBeatMs": 10.0,
                    "gridFirstBeatLabel": 1,
                    "gridBarBeatOffset": 0,
                }
            ]
        )
        report_path = self.root / "pre-review.json"
        report_path.write_text("{}\n", encoding="utf-8")
        report = {
            "summary": {"mode": "dry-run", "errorTrackCount": 0},
            "workflowGuard": {
                "mode": "pre-review-label-qa",
                "denominatorAudioIdentities": [
                    {
                        "fileName": "reviewed.wav",
                        "assetSha256": hashlib.sha256(content).hexdigest(),
                    }
                ],
            },
            "batch": {"denominatorEntries": [{"fileName": "reviewed.wav"}]},
        }
        with patch.object(prepare_support, "load_report_for_apply", return_value=report):
            result = sealed.run(
                [
                    "prepare",
                    *self._storage_args(),
                    *self._identity_args(),
                    "--playlist",
                    "review",
                    "--reviewed-development",
                    "--triage-report",
                    str(report_path),
                    "--python",
                    sys.executable,
                    "--audio-intake-root",
                    str(self.intake),
                    "--audio-archive-root",
                    str(self.archive),
                    "--bridge",
                    str(self.bridge),
                    "--current-truth",
                    str(self.current_truth),
                    "--sync-script",
                    str(self.sync_script),
                    "--capture-script",
                    str(self.capture_script),
                    "--feature-cache-script",
                    str(self.feature_script),
                    "--benchmark-script",
                    str(self.benchmark_script),
                ]
            )

        self.assertEqual(result["status"], "consumed")
        self.assertFalse(result["freshProofEligible"])
        batch_dir = Path(str(result["batchDir"]))
        state = load_json(batch_dir / "state.json")
        self.assertEqual(state["evaluation"]["status"], "reviewed-development")
        self.assertFalse((batch_dir / DATASET_LOCK_NAME).exists())
        self.assertFalse((batch_dir / "solver-lock.json").exists())
        self.assertTrue(Path(str(result["batchDir"])).is_dir())
        self.assertTrue((self.archive / str(result["batchId"])).is_dir())

    def test_prepare_rejects_tampered_consumed_baseline_state(self) -> None:
        self._import_baseline()
        state_path = self.batches / "consumed-current" / "state.json"
        state = load_json(state_path)
        state["status"] = "fresh"
        state_path.write_text(json.dumps(state), encoding="utf-8")

        with self.assertRaisesRegex(
            SealedBatchError, "baseline consumed state changed|imported registry batch is not consumed"
        ):
            self._prepare()

    def test_consumed_state_cannot_return_to_fresh(self) -> None:
        state = {"status": "consumed", "history": []}
        with self.assertRaisesRegex(SealedBatchError, "consumed -> fresh"):
            transition_state(state, "fresh", "illegal-reset")

    def test_consumed_truth_exact_file_path_disambiguates_duplicate_names(self) -> None:
        first_root = self.root / "first-archive"
        second_root = self.root / "second-archive"
        first_root.mkdir()
        second_root.mkdir()
        (first_root / "duplicate.wav").write_bytes(b"old-version")
        expected = second_root / "duplicate.wav"
        expected.write_bytes(b"new-version")
        truth = self.root / "duplicate-truth.json"
        truth.write_text(
            json.dumps(
                {
                    "tracks": [
                        self._v2_truth_track(
                            "duplicate.wav",
                            filePath=str(expected),
                        )
                    ]
                }
            ),
            encoding="utf-8",
        )

        resolved = sealed._find_consumed_audio(truth, [first_root, second_root])

        self.assertEqual(resolved, [expected.resolve()])

    def test_consumed_truth_ignores_source_file_path_outside_archive_roots(self) -> None:
        source_root = self.root / "original-source"
        archive_root = self.root / "consumed-archive"
        source_root.mkdir()
        archive_root.mkdir()
        source = source_root / "track.wav"
        source.write_bytes(b"original-source")
        archived = archive_root / "track.wav"
        archived.write_bytes(b"frozen-archive")
        truth = self.root / "source-path-truth.json"
        truth.write_text(
            json.dumps(
                {
                    "tracks": [
                        self._v2_truth_track(
                            "track.wav",
                            filePath=str(source),
                        )
                    ]
                }
            ),
            encoding="utf-8",
        )

        resolved = sealed._find_consumed_audio(truth, [archive_root])

        self.assertEqual(resolved, [archived.resolve()])

    def test_identity_cache_resumes_only_missing_or_changed_audio(self) -> None:
        first = self.sources / "cache-a.wav"
        second = self.sources / "cache-b.wav"
        first.write_bytes(b"cache-a-v1")
        second.write_bytes(b"cache-b")
        request_log = self.root / "identity-requests.jsonl"
        identity = {
            "node": "node",
            "helperPath": str(self.identity_helper),
            "maxLengthSeconds": 120,
            "cacheDir": str(self.root / "identity-cache"),
            "chunkSize": 1,
        }

        with patch.dict(
            os.environ,
            {"FAKE_IDENTITY_REQUEST_LOG": str(request_log)},
            clear=False,
        ):
            sealed._build_roster([first], identity)
            sealed._build_roster([first, second], identity)
            first.write_bytes(b"cache-a-v2-changed")
            sealed._build_roster([first], identity)

        requests = [json.loads(line) for line in request_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([[Path(item).name for item in row] for row in requests], [
            ["cache-a.wav"],
            ["cache-b.wav"],
            ["cache-a.wav"],
        ])

    def test_acceptance_policy_uses_inclusive_eighty_percent_boundary(self) -> None:
        policy = {
            "minimumStrictAccuracy": 0.8,
            "maximumErrorRate": 0.0,
            "maximumBpmBigErrorRate": 0.05,
            "minimumCandidateOracleRate": 0.94,
        }
        passing = sealed._evaluate_policy(
            {
                "trackTotal": 5,
                "categoryCounts": {"pass": 4, "first-beat-phase": 1},
                "errorTrackCount": 0,
                "bpmBigErrorCount": 0,
                "candidateOracle": {"candidatePassRate": 0.95},
            },
            policy,
        )
        failing = sealed._evaluate_policy(
            {
                "trackTotal": 5,
                "categoryCounts": {"pass": 3, "first-beat-phase": 2},
                "errorTrackCount": 0,
                "bpmBigErrorCount": 0,
                "candidateOracle": {"candidatePassRate": 0.95},
            },
            policy,
        )
        self.assertTrue(passing["passed"])
        self.assertFalse(failing["passed"])

    def test_acceptance_policy_rejects_invalid_rates_and_error_bypass(self) -> None:
        parser = sealed._build_parser()
        invalid = parser.parse_args(["prepare", "--minimum-strict-accuracy", "1.1"])
        with self.assertRaisesRegex(SealedBatchError, "between 0 and 1"):
            sealed._acceptance_policy(invalid)
        error_bypass = parser.parse_args(["prepare", "--maximum-error-rate", "0.01"])
        with self.assertRaisesRegex(SealedBatchError, "maximumErrorRate = 0"):
            sealed._acceptance_policy(error_bypass)

    def test_benchmark_validation_rejects_category_count_mismatch(self) -> None:
        output = self.root / "bad-benchmark.json"
        output.write_text(
            json.dumps(
                attach_benchmark_result_digest({
                    "summary": {
                        "solver": "constant-grid-dp",
                        "trackTotal": 1,
                        "analyzedTrackCount": 1,
                        "errorTrackCount": 0,
                        "categoryCounts": {"pass": 0},
                    },
                    "tracks": [{"fileName": "track.wav"}],
                    "errors": [],
                })
            ),
            encoding="utf-8",
        )
        policy = {
            "minimumStrictAccuracy": 0.8,
            "maximumErrorRate": 0.0,
            "maximumBpmBigErrorRate": 0.05,
            "minimumCandidateOracleRate": 0.94,
        }

        with self.assertRaisesRegex(DatasetContractError, "category counts"):
            validate_sealed_benchmark_output(
                output,
                expected_track_count=1,
                exit_code=0,
                maximum_error_rate=float(policy["maximumErrorRate"]),
            )

    def test_registry_identity_index_covers_all_identity_types(self) -> None:
        index = registry_identity_index(
            {
                "tracks": [
                    {
                        "batchId": "old",
                        "fileName": "a.wav",
                        "assetSha256": "asset",
                        "pcmSha256": "pcm",
                        "fingerprintSha256": "fingerprint",
                    }
                ]
            }
        )
        self.assertEqual(index["assetSha256"]["asset"][0]["batchId"], "old")
        self.assertEqual(index["pcmSha256"]["pcm"][0]["fileName"], "a.wav")
        self.assertIn("fingerprint", index["fingerprintSha256"])

    def test_prepare_creates_pcm_chromaprint_manifest_and_registry(self) -> None:
        self._import_baseline()
        self.intake.mkdir()
        (self.intake / ".frkb.uuid").write_text("stable-library-node", encoding="utf-8")
        result = self._prepare()
        batch_dir = self.batches / str(result["batchId"])
        manifest = load_json(batch_dir / "manifest.json")
        state = load_json(batch_dir / "state.json")
        registry = load_json(self.registry)
        track = manifest["audioRoster"][0]
        self.assertEqual(state["status"], "fresh")
        self.assertTrue(track["pcmSha256"])
        self.assertTrue(track["fingerprint"])
        self.assertTrue(str(track["familyId"]).startswith("chromaprint:"))
        self.assertNotEqual(track["familyId"], f"asset:{track['assetSha256']}")
        self.assertEqual(manifest["acceptancePolicy"]["minimumStrictAccuracy"], 0.8)
        self.assertEqual(
            manifest["audioIsolationGuard"]["policySha256"],
            "e7e52a9df88ea17686bb7825c9ab017edbdf459dfe0a110cc65c2c5b1185be98",
        )
        self.assertEqual(
            manifest["audioIsolationGuard"]["registrySha256"],
            state["audioIsolationGuard"]["registrySha256"],
        )
        self.assertEqual(manifest["audioIsolationGuard"]["stats"]["freshKeptCount"], 1)
        self.assertEqual(result["excludedIsolationDuplicateCount"], 0)
        self.assertEqual(registry["trackCount"], 2)
        self.assertEqual(registry["tracks"][-1]["batchId"], result["batchId"])
        self.assertTrue((batch_dir / DATASET_LOCK_NAME).is_file())
        self.assertEqual(load_json(batch_dir / DATASET_LOCK_NAME)["lockHash"], result["datasetLockHash"])
        self.assertTrue((self.intake / ".frkb.uuid").is_file())

    def test_evaluate_rejects_registry_identity_drift_after_prepare(self) -> None:
        self._import_baseline()
        prepared = self._prepare()
        registry = load_json(self.registry)
        replacement = self.root / "relocated-fresh-audio.wav"
        shutil.copy2(Path(registry["tracks"][-1]["sourcePath"]), replacement)
        registry["tracks"][-1]["sourcePath"] = str(replacement)
        self.registry.write_text(json.dumps(registry), encoding="utf-8")

        with self.assertRaisesRegex(SealedBatchError, "dataset lock"):
            sealed.run(
                [
                    "evaluate",
                    *self._storage_args(),
                    "--batch",
                    str(prepared["batchId"]),
                ]
            )

    def test_registry_duplicate_is_rejected_before_sealed_evaluation(self) -> None:
        self._import_baseline(content=b"same-recording")
        with self.assertRaisesRegex(SealedBatchError, "no unseen tracks"):
            self._prepare(file_name="renamed.wav", content=b"same-recording")
        self.assertEqual(len([item for item in self.batches.iterdir() if item.is_dir()]), 1)

    def test_evaluate_rejects_changed_identity_helper(self) -> None:
        self._import_baseline()
        prepared = self._prepare()
        self.identity_helper.write_text("process.stdout.write('{}\\n')\n", encoding="utf-8")

        with self.assertRaisesRegex(SealedBatchError, "identity helper hash mismatch"):
            sealed.run(
                [
                    "evaluate",
                    *self._storage_args(),
                    "--batch",
                    str(prepared["batchId"]),
                ]
            )

    def test_evaluate_rejects_changed_runtime_binary(self) -> None:
        self._import_baseline()
        prepared = self._prepare()
        self.ffmpeg.write_bytes(b"changed-ffmpeg")

        with self.assertRaisesRegex(SealedBatchError, "solver lock changed"):
            sealed.run(
                [
                    "evaluate",
                    *self._storage_args(),
                    "--batch",
                    str(prepared["batchId"]),
                ]
            )

    def test_prepare_rejects_a_second_active_batch_and_unmanaged_intake(self) -> None:
        self._import_baseline()
        self._prepare()
        with self.assertRaisesRegex(SealedBatchError, "another sealed batch is still active"):
            self._prepare(file_name="second.wav", content=b"second")

        fresh_batch = next(
            item
            for item in self.batches.iterdir()
            if item.is_dir() and load_json(item / "state.json")["status"] == "fresh"
        )
        shutil_target = self.intake / fresh_batch.name
        shutil.rmtree(fresh_batch)
        shutil.rmtree(shutil_target)
        (self.intake / "orphan.tmp").write_text("orphan", encoding="utf-8")
        with self.assertRaisesRegex(SealedBatchError, "unmanaged residual"):
            self._prepare(file_name="third.wav", content=b"third")

    def test_resume_requires_identical_lock_and_complete_run_is_one_shot(self) -> None:
        self._import_baseline()
        prepared = self._prepare()
        batch_id = str(prepared["batchId"])
        fail_marker = self.root / "feature-failed-once"
        with patch.dict(os.environ, {"FAKE_FEATURE_FAIL_ONCE": str(fail_marker)}, clear=False):
            with self.assertRaisesRegex(SealedBatchError, "feature-cache failed"):
                sealed.run(["evaluate", *self._storage_args(), "--batch", batch_id])
            state = load_json(self.batches / batch_id / "state.json")
            self.assertEqual(state["status"], "exposed")
            self.assertEqual(state["evaluation"]["status"], "failed")
            sealed.run(["rebuild-registry", *self._storage_args()])
            original_checkpoint = self.checkpoint.read_bytes()
            self.checkpoint.write_bytes(b"changed-checkpoint")
            with self.assertRaisesRegex(SealedBatchError, "solver lock changed"):
                sealed.run(["evaluate", *self._storage_args(), "--batch", batch_id, "--resume"])
            self.checkpoint.write_bytes(original_checkpoint)
            evaluated = sealed.run(
                ["evaluate", *self._storage_args(), "--batch", batch_id, "--resume"]
            )
        self.assertTrue(evaluated["acceptance"]["passed"])
        with self.assertRaisesRegex(SealedBatchError, "cannot be rerun"):
            sealed.run(["evaluate", *self._storage_args(), "--batch", batch_id, "--resume"])
        finalized = sealed.run(
            [
                "finalize",
                *self._storage_args(),
                "--batch",
                batch_id,
                "--decision",
                "eligible",
            ]
        )
        self.assertEqual(finalized["status"], "consumed")
        self.assertFalse((self.intake / batch_id).exists())
        self.assertTrue((self.archive / batch_id).is_dir())

    def test_eligible_decision_is_blocked_when_locked_policy_fails(self) -> None:
        self._import_baseline()
        prepared = self._prepare(file_name="hard.wav", content=b"hard-audio")
        batch_id = str(prepared["batchId"])
        with patch.dict(os.environ, {"FAKE_BENCHMARK_PASS_COUNT": "0"}, clear=False):
            evaluated = sealed.run(["evaluate", *self._storage_args(), "--batch", batch_id])
        self.assertFalse(evaluated["acceptance"]["passed"])
        with self.assertRaisesRegex(SealedBatchError, "not eligible"):
            sealed.run(
                [
                    "finalize",
                    *self._storage_args(),
                    "--batch",
                    batch_id,
                    "--decision",
                    "eligible",
                ]
            )
        rejected = sealed.run(
            [
                "finalize",
                *self._storage_args(),
                "--batch",
                batch_id,
                "--decision",
                "reject",
            ]
        )
        self.assertEqual(rejected["decision"], "reject")


FAKE_SYNC = r"""
import argparse
import json
import os
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--target-root', required=True)
parser.add_argument('--dry-run', action='store_true')
parser.add_argument('--playlist', default='test')
args, _ = parser.parse_known_args()
rows = json.loads(Path(os.environ['FAKE_PLAYLIST_JSON']).read_text(encoding='utf-8'))
target = Path(args.target_root)
copied = []
for row in rows:
    source = Path(row['filePath'])
    destination = target / row['fileName']
    copied.append({'fileName': row['fileName'], 'source': str(source), 'destination': str(destination)})
    if not args.dry_run:
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
print(json.dumps({
    'playlistName': args.playlist,
    'playlistId': 123,
    'playlistTrackCount': len(rows),
    'copyCount': len(rows),
    'skippedCount': 0,
    'copied': copied,
    'skipped': [],
}))
"""


FAKE_CAPTURE = r"""
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--playlist', default='test')
args, _ = parser.parse_known_args()
rows = json.loads(Path(os.environ['FAKE_PLAYLIST_JSON']).read_text(encoding='utf-8'))
tracks = [{
    'fileName': row['fileName'],
    'title': row.get('title', ''),
    'artist': row.get('artist', ''),
    'beatGridMap': {
        'version': 2,
        'source': 'manual',
        'signature': 'sbgm_test',
        'clips': [{
            'startSec': 0,
            'anchorSec': round(float(row.get('gridFirstBeatMs', 0.0)) / 1000.0, 6),
            'bpm': row.get('gridBpm', 120.0),
            'downbeatBeatOffset': int(row.get('gridBarBeatOffset', 0)) % 4,
        }],
    },
} for row in rows]
Path(args.output).write_text(json.dumps({'type': 'frkb-grid-truth-v2', 'schemaVersion': 2, 'source': {'playlistName': args.playlist}, 'tracks': tracks}), encoding='utf-8')
print(json.dumps({'playlistName': args.playlist, 'playlistId': 123, 'capturedTrackCount': len(tracks)}))
"""


FAKE_FEATURE = r"""
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--cache-dir', required=True)
parser.add_argument('--truth', required=True)
args, _ = parser.parse_known_args()
marker = os.environ.get('FAKE_FEATURE_FAIL_ONCE', '')
if marker and not Path(marker).exists():
    Path(marker).write_text('failed', encoding='utf-8')
    raise SystemExit(2)
Path(args.cache_dir).mkdir(parents=True, exist_ok=True)
dataset_lock = json.loads(
    (Path(args.truth).parent / 'dataset-lock.json').read_text(encoding='utf-8')
)
locked = dataset_lock['locked']
print(json.dumps({'summary': {
    'selectedTrackCount': locked['registryBatchTrackCount'],
    'indexedFeatureCount': locked['registryBatchTrackCount'],
    'registryBatchId': locked['batchId'],
    'identityProjectionSha256': locked['registryBatchIdentityProjectionSha256'],
}}))
"""


FAKE_BENCHMARK = r"""
import argparse
import hashlib
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--truth', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--solver', required=True)
parser.add_argument('--truth-batch-id', required=True)
parser.add_argument('--registry', required=True)
args, _ = parser.parse_known_args()
truth = json.loads(Path(args.truth).read_text(encoding='utf-8'))
total = len(truth['tracks'])
pass_count = int(os.environ.get('FAKE_BENCHMARK_PASS_COUNT', str(total)))
registry = json.loads(Path(args.registry).read_text(encoding='utf-8'))
result_rows = []
for item in registry['tracks']:
    if str(item.get('batchId', '')).casefold() != args.truth_batch_id.casefold():
        continue
    asset_sha256 = item['assetSha256']
    result_rows.append({
        'instanceId': f"{item['batchId']}:{asset_sha256}",
        'batchId': item['batchId'],
        'fileName': item['fileName'],
        'assetSha256': asset_sha256,
        'pcmSha256': item['pcmSha256'],
        'familyId': item['familyId'],
        'sourcePath': item['sourcePath'],
    })
summary = {
    'solver': args.solver,
    'trackTotal': total,
    'analyzedTrackCount': total,
    'errorTrackCount': 0,
    'categoryCounts': {'pass': pass_count, 'first-beat-phase': total - pass_count},
    'bpmBigErrorCount': 0,
    'candidateOracle': {'candidatePassRate': 1.0},
}
payload = {'summary': summary, 'errors': [], 'tracks': result_rows}
body = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
summary['resultBodySha256'] = hashlib.sha256(body.encode('utf-8')).hexdigest()
Path(args.output).parent.mkdir(parents=True, exist_ok=True)
Path(args.output).write_text(
    json.dumps(payload),
    encoding='utf-8',
)
print(json.dumps({'summary': summary, 'output': args.output}))
"""


FAKE_IDENTITY = r"""
import crypto from 'node:crypto'
import fs from 'node:fs'

function packCodes(values, width) {
  const output = Buffer.alloc(Math.ceil(values.length * width / 8))
  let bitOffset = 0
  for (const value of values) {
    for (let bit = 0; bit < width; bit += 1) {
      if (value & (1 << bit)) {
        const absoluteBit = bitOffset + bit
        output[absoluteBit >> 3] |= 1 << (absoluteBit & 7)
      }
    }
    bitOffset += width
  }
  return output
}

function encodeFingerprint(frames) {
  const normalCodes = []
  const exceptionalCodes = []
  let previous = 0
  for (const frame of frames) {
    let value = (frame ^ previous) >>> 0
    previous = frame
    let lastBit = 0
    let bit = 1
    while (value) {
      if (value & 1) {
        const delta = bit - lastBit
        if (delta >= 7) {
          normalCodes.push(7)
          exceptionalCodes.push(delta - 7)
        } else {
          normalCodes.push(delta)
        }
        lastBit = bit
      }
      value >>>= 1
      bit += 1
    }
    normalCodes.push(0)
  }
  const header = Buffer.alloc(4)
  header[0] = 1
  header.writeUIntBE(frames.length, 1, 3)
  return Buffer.concat([
    header,
    packCodes(normalCodes, 3),
    packCodes(exceptionalCodes, 5),
  ]).toString('base64url')
}

function fingerprintFrames(bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest()
  let state = digest.readUInt32LE(0) || 1
  const frames = []
  for (let index = 0; index < 700; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    frames.push(state)
  }
  return frames
}

let source = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) source += chunk
const request = JSON.parse(source)
if (process.env.FAKE_IDENTITY_REQUEST_LOG) {
  fs.appendFileSync(process.env.FAKE_IDENTITY_REQUEST_LOG, `${JSON.stringify(request.paths)}\n`)
}
const tracks = request.paths.map((filePath) => {
  const bytes = fs.readFileSync(filePath)
  const pcmSha256 = crypto.createHash('sha256').update('pcm').update(bytes).digest('hex')
  const fingerprint = encodeFingerprint(fingerprintFrames(bytes))
  return { filePath, pcmSha256, fingerprint, duration: 120 }
})
process.stdout.write(`${JSON.stringify({ tracks })}\n`)
"""


if __name__ == "__main__":
    unittest.main()
