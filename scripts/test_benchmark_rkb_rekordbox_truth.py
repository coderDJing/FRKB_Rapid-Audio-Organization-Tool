import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_dataset_contract import (
    DatasetContractError,
    registry_content_sha256,
    sha256_file,
    sha256_json,
    split_roster_sha256,
)


class BenchmarkRkbRekordboxTruthIdentityTest(unittest.TestCase):
    def _track(
        self,
        *,
        batch_id: str,
        asset_sha256: str,
        source_path: Path | None,
    ) -> dict[str, object]:
        track: dict[str, object] = {
            "fileName": "Same Song.mp3",
            "title": "Same Song",
            "artist": "Tester",
            "bpm": 120.0,
            "firstBeatMs": 10.0,
            "firstBeatLabel": 1,
            "barBeatOffset": 0,
            "instanceId": f"{batch_id}:{asset_sha256}",
            "batchId": batch_id,
            "assetSha256": asset_sha256,
            "pcmSha256": f"pcm-{asset_sha256}",
            "familyId": f"family-{asset_sha256}",
            "isolationFamilyId": f"isolation-{asset_sha256}",
        }
        if source_path is not None:
            track["sourcePath"] = str(source_path)
        return track

    def _write_truth(self, path: Path, tracks: list[dict[str, object]]) -> None:
        path.write_text(json.dumps({"tracks": tracks}), encoding="utf-8")

    def _write_parent_split_truth(self, root: Path, source_path: Path) -> tuple[Path, Path]:
        track = {
            **self._track(batch_id="batch-a", asset_sha256="asset-a", source_path=source_path),
            "assignmentKey": "assignment-a",
        }
        source_truth_path = root / "source-truth.json"
        source_truth_path.write_text(json.dumps({"tracks": [track]}), encoding="utf-8")
        truth_sources = [
            {
                "path": str(source_truth_path),
                "sha256": sha256_file(source_truth_path),
                "trackCount": 1,
            }
        ]
        registry_path = root / "registry.json"
        registry = {
            "generatedAt": "ignored-by-canonical-registry-hash",
            "tracks": [
                {
                    "fileName": track["fileName"],
                    "batchId": track["batchId"],
                    "assetSha256": track["assetSha256"],
                    "pcmSha256": track["pcmSha256"],
                    "familyId": track["familyId"],
                    "sourcePath": track["sourcePath"],
                }
            ],
        }
        registry_path.write_text(json.dumps(registry), encoding="utf-8")
        parent_path = root / "dataset-splits.json"
        parent = {
            "type": "rkb-rekordbox-dataset-splits",
            "registryPath": str(registry_path),
            "registrySha256": registry_content_sha256(registry),
            "truthSources": truth_sources,
            "truthSourcesSha256": sha256_json(truth_sources),
            "seed": 20260710,
            "splitPolicy": {"tuneRatio": 0.2, "holdoutRatio": 0.2},
            "assignmentDigestSha256": "assignment-digest",
            "splitAssignmentsSha256": "split-assignments",
            "audioIsolationPolicySha256": "isolation-policy",
            "instances": [track],
            "families": [
                {
                    "isolationFamilyId": track["isolationFamilyId"],
                    "assignmentKey": track["assignmentKey"],
                    "split": "holdout",
                }
            ],
            "summary": {"train": 0, "tune": 0, "holdout": 1},
        }
        parent_path.write_text(json.dumps(parent), encoding="utf-8")
        parent_meta = {
            "parentSplitPath": str(parent_path),
            "parentSplitFileSha256": sha256_file(parent_path),
            "splitRosterSha256": split_roster_sha256([track]),
            "registrySha256": parent["registrySha256"],
            "truthSourcesSha256": parent["truthSourcesSha256"],
            "seed": parent["seed"],
            "tuneRatio": parent["splitPolicy"]["tuneRatio"],
            "holdoutRatio": parent["splitPolicy"]["holdoutRatio"],
            "assignmentDigestSha256": parent["assignmentDigestSha256"],
            "splitAssignmentsSha256": parent["splitAssignmentsSha256"],
            "audioIsolationPolicySha256": parent["audioIsolationPolicySha256"],
        }
        truth_path = root / "holdout-truth.json"
        truth_path.write_text(
            json.dumps(
                {
                    "type": "rkb-rekordbox-truth-split",
                    "split": "holdout",
                    "trackCount": 1,
                    "truthSources": truth_sources,
                    "parentSplit": parent_meta,
                    "tracks": [track],
                }
            ),
            encoding="utf-8",
        )
        return truth_path, parent_path

    def test_loads_cross_batch_same_filename_from_exact_source_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first_path = root / "batch-a" / "Same Song.mp3"
            second_path = root / "batch-b" / "Same Song.mp3"
            first_path.parent.mkdir()
            second_path.parent.mkdir()
            first_path.write_bytes(b"first")
            second_path.write_bytes(b"second")
            first = self._track(batch_id="batch-a", asset_sha256="asset-a", source_path=first_path)
            second = self._track(batch_id="batch-b", asset_sha256="asset-b", source_path=second_path)
            truth_path = root / "truth.json"
            self._write_truth(truth_path, [first, second])

            with patch.object(benchmark, "_probe_time_basis", return_value={"offsetMs": 0.0}):
                tracks = benchmark._load_truth_tracks(truth_path, [root], root / "ffprobe.exe")

            self.assertEqual(2, len(tracks))
            self.assertEqual(
                {"batch-a:asset-a", "batch-b:asset-b"},
                {track["instanceId"] for track in tracks},
            )
            self.assertEqual({str(first_path), str(second_path)}, {track["filePath"] for track in tracks})
            self.assertEqual(
                {"isolation-asset-a", "isolation-asset-b"},
                {track["isolationFamilyId"] for track in tracks},
            )
            report = benchmark._build_track_report(
                {
                    "bpm": 120.0,
                    "firstBeatMs": 10.0,
                    "absoluteFirstBeatMs": 10.0,
                    "rawFirstBeatMs": 10.0,
                    "barBeatOffset": 0,
                    "gridSolverCandidates": [],
                },
                tracks[0],
            )
            for field in (
                "instanceId",
                "batchId",
                "assetSha256",
                "familyId",
                "isolationFamilyId",
                "sourcePath",
            ):
                self.assertEqual(tracks[0][field], report[field])

    def test_duplicate_instance_truth_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "Same Song.mp3"
            source_path.write_bytes(b"audio")
            track = self._track(batch_id="batch-a", asset_sha256="asset-a", source_path=source_path)
            truth_path = root / "truth.json"
            self._write_truth(truth_path, [track, dict(track)])

            with self.assertRaisesRegex(DatasetContractError, "duplicate identity"):
                benchmark._load_truth_tracks(truth_path, [root], root / "ffprobe.exe")

    def test_parent_split_source_path_contract_is_enforced_by_loader(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "Same Song.mp3"
            source_path.write_bytes(b"audio")
            truth_path, _ = self._write_parent_split_truth(root, source_path)

            with patch.object(benchmark, "_probe_time_basis", return_value={"offsetMs": 0.0}):
                tracks = benchmark._load_truth_tracks(truth_path, [root], root / "ffprobe.exe")
            self.assertEqual(str(source_path), tracks[0]["sourcePath"])

            payload = json.loads(truth_path.read_text(encoding="utf-8"))
            payload["tracks"][0]["sourcePath"] = str(root / "swapped.mp3")
            truth_path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(DatasetContractError, "sourcePath mismatch"):
                benchmark._load_truth_tracks(truth_path, [root], root / "ffprobe.exe")

    def test_instance_source_path_is_required_and_never_falls_back_to_filename(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "Same Song.mp3").write_bytes(b"legacy fallback must not be used")
            truth_path = root / "truth.json"

            missing_source = self._track(
                batch_id="batch-a",
                asset_sha256="asset-a",
                source_path=None,
            )
            self._write_truth(truth_path, [missing_source])
            with self.assertRaisesRegex(RuntimeError, "missing sourcePath"):
                benchmark._load_truth_tracks(truth_path, [root], root / "ffprobe.exe")

            invalid_source = self._track(
                batch_id="batch-a",
                asset_sha256="asset-a",
                source_path=root / "missing" / "Same Song.mp3",
            )
            self._write_truth(truth_path, [invalid_source])
            with self.assertRaisesRegex(RuntimeError, "sourcePath is not an existing file"):
                benchmark._load_truth_tracks(truth_path, [root], root / "ffprobe.exe")

    def test_single_benchmark_enriches_fresh_truth_from_registry_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "sealed-intake" / "Same Song.mp3"
            source_path.parent.mkdir()
            source_path.write_bytes(b"fresh")
            truth_path = root / "truth.json"
            self._write_truth(
                truth_path,
                [
                    {
                        "fileName": "Same Song.mp3",
                        "bpm": 120.0,
                        "firstBeatMs": 0.0,
                        "sourcePath": str(root / "stale" / "Same Song.mp3"),
                    }
                ],
            )
            registry_path = root / "registry.json"
            registry_path.write_text(
                json.dumps(
                    {
                        "tracks": [
                            {
                                "fileName": "Same Song.mp3",
                                "batchId": "fresh-a",
                                "assetSha256": "asset-a",
                                "pcmSha256": "pcm-a",
                                "familyId": "family-a",
                                "sourcePath": str(source_path),
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            with patch.object(benchmark, "_probe_time_basis", return_value={"offsetMs": 0.0}):
                tracks = benchmark._load_truth_tracks(
                    truth_path,
                    [root],
                    root / "ffprobe.exe",
                    truth_batch_id="fresh-a",
                    registry_path=registry_path,
                )

            self.assertEqual("fresh-a:asset-a", tracks[0]["instanceId"])
            self.assertEqual("pcm-a", tracks[0]["pcmSha256"])
            self.assertEqual(str(source_path), tracks[0]["sourcePath"])

    def test_legacy_truth_without_instance_keeps_filename_audio_root_compatibility(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            audio_path = root / "Legacy Song.mp3"
            audio_path.write_bytes(b"legacy")
            truth_path = root / "truth.json"
            self._write_truth(
                truth_path,
                [{"fileName": audio_path.name, "bpm": 120.0, "firstBeatMs": 0.0}],
            )

            with patch.object(benchmark, "_probe_time_basis", return_value={"offsetMs": 0.0}):
                tracks = benchmark._load_truth_tracks(truth_path, [root], root / "ffprobe.exe")

            self.assertEqual(1, len(tracks))
            self.assertEqual(str(audio_path), tracks[0]["filePath"])
            self.assertNotIn("instanceId", tracks[0])

    def test_main_writes_run_provenance_into_output_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            audio_path = root / "Legacy Song.mp3"
            audio_path.write_bytes(b"audio")
            truth_path = root / "truth.json"
            self._write_truth(
                truth_path,
                [{"fileName": audio_path.name, "bpm": 120.0, "firstBeatMs": 0.0}],
            )
            ffmpeg_path = root / "ffmpeg.exe"
            ffprobe_path = root / "ffprobe.exe"
            ffmpeg_path.write_bytes(b"ffmpeg")
            ffprobe_path.write_bytes(b"ffprobe")
            feature_cache_dir = root / "feature-cache"
            feature_cache_dir.mkdir()
            (feature_cache_dir / "index.json").write_text(
                json.dumps({"entries": []}), encoding="utf-8"
            )
            prediction_cache_dir = root / "prediction-cache"
            output_path = root / "output.json"
            argv = [
                "benchmark_rkb_rekordbox_truth.py",
                "--truth", str(truth_path),
                "--audio-root", str(root),
                "--ffmpeg", str(ffmpeg_path),
                "--ffprobe", str(ffprobe_path),
                "--output", str(output_path),
                "--solver", "constant-grid-dp",
                "--feature-cache-dir", str(feature_cache_dir),
                "--prediction-cache-dir", str(prediction_cache_dir),
            ]
            analysis = {
                "bpm": 120.0,
                "firstBeatMs": 0.0,
                "absoluteFirstBeatMs": 0.0,
                "rawFirstBeatMs": 0.0,
                "barBeatOffset": 0,
                "gridSolverCandidates": [],
            }
            with (
                patch.object(sys, "argv", argv),
                patch.object(benchmark, "_probe_time_basis", return_value={"offsetMs": 0.0}),
                patch.object(benchmark, "_load_constant_grid_dp_solver_module", return_value=object()),
                patch.object(benchmark, "_analyze_track_constant_grid_dp", return_value=analysis),
            ):
                self.assertEqual(0, benchmark.main())

            payload = json.loads(output_path.read_text(encoding="utf-8"))
            provenance = payload["summary"]["runProvenance"]
            self.assertEqual("constant-grid-dp", provenance["configuration"]["solver"])
            self.assertEqual(sha256_file(truth_path), provenance["truthSha256"])
            self.assertTrue(provenance["provenanceSha256"])


if __name__ == "__main__":
    unittest.main()
