import argparse
import json
import tempfile
import unittest
from pathlib import Path

from rkb_dataset_contract import (
    attach_benchmark_result_digest,
    build_benchmark_provenance_from_args,
    validate_truth_contract,
)
from run_parallel_rkb_rekordbox_benchmark import (
    _enrich_tracks_from_registry,
    _load_existing_shard_payload,
    _merge_payloads,
    _partition_tracks,
    _select_tracks,
    _write_shard_truth,
)


class ParallelRkbRekordboxBenchmarkIdentityTest(unittest.TestCase):
    def _track(self, batch_id: str, asset_sha256: str, source_path: Path) -> dict[str, object]:
        return {
            "fileName": "Same Song.mp3",
            "title": "Same Song",
            "artist": "Tester",
            "instanceId": f"{batch_id}:{asset_sha256}",
            "batchId": batch_id,
            "assetSha256": asset_sha256,
            "familyId": f"family-{asset_sha256}",
            "isolationFamilyId": f"isolation-{asset_sha256}",
            "sourcePath": str(source_path),
        }

    def _row(self, track: dict[str, object]) -> dict[str, object]:
        return {
            **track,
            "filePath": track["sourcePath"],
            "truth": {"bpm": 120.0, "barBeatOffset": 0},
            "analysis": {"bpm": 120.0, "barBeatOffset": 0},
            "currentTimeline": {
                "category": "pass",
                "firstBeatPhaseStatus": "pass",
                "barBeatOffsetMatchedMod4": True,
                "barBeatOffsetMatchedExact32": True,
            },
        }

    def _args(
        self,
        root: Path,
        truth_tracks: list[dict[str, object]] | None = None,
    ) -> argparse.Namespace:
        root.mkdir(parents=True, exist_ok=True)
        truth_path = root / "truth.json"
        truth_path.write_text(
            json.dumps({"tracks": truth_tracks or [{"fileName": "placeholder.mp3"}]}),
            encoding="utf-8",
        )
        ffmpeg_path = root / "ffmpeg.exe"
        ffprobe_path = root / "ffprobe.exe"
        ffmpeg_path.write_bytes(b"ffmpeg")
        ffprobe_path.write_bytes(b"ffprobe")
        feature_cache_dir = root / "feature-cache"
        feature_cache_dir.mkdir(exist_ok=True)
        (feature_cache_dir / "index.json").write_text(
            json.dumps({"entries": []}), encoding="utf-8"
        )
        return argparse.Namespace(
            truth=str(truth_path),
            truth_batch_id="",
            registry=str(root / "registry.json"),
            audio_root=str(root),
            ffmpeg=str(ffmpeg_path),
            ffprobe=str(ffprobe_path),
            device="cpu",
            solver="constant-grid-dp",
            feature_cache_dir=str(feature_cache_dir),
            no_prediction_cache=True,
            prediction_cache_dir=str(root / "prediction-cache"),
            shard_dir=str(root / "shards"),
        )

    def _write_resume_fixture(
        self,
        *,
        root: Path,
        tracks: list[dict[str, object]],
    ) -> tuple[argparse.Namespace, Path, Path]:
        args = self._args(root, tracks)
        source_truth_path = Path(args.truth)
        source_payload = json.loads(source_truth_path.read_text(encoding="utf-8"))
        source_contract = validate_truth_contract(source_truth_path, source_payload)
        shard_truth_path = root / "truth-shard-1.json"
        _write_shard_truth(
            base_payload=source_payload,
            tracks=tracks,
            shard_path=shard_truth_path,
            shard_index=0,
            shard_count=1,
            source_truth_path=source_truth_path,
            source_contract=source_contract,
        )
        output_path = root / "output-shard-1.json"
        provenance = build_benchmark_provenance_from_args(
            args, validate_truth_contract(shard_truth_path)
        )
        output_path.write_text(
            json.dumps(
                attach_benchmark_result_digest(
                    {
                        "summary": {"runProvenance": provenance},
                        "tracks": [self._row(track) for track in reversed(tracks)],
                        "errors": [],
                    }
                )
            ),
            encoding="utf-8",
        )
        return args, shard_truth_path, output_path

    def test_selection_partition_and_merge_keep_cross_batch_same_filename_instances(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = self._track("batch-a", "asset-a", root / "batch-a" / "Same Song.mp3")
            second = self._track("batch-b", "asset-b", root / "batch-b" / "Same Song.mp3")

            selected = _select_tracks([first, second, dict(first)], only_filters=[], limit=0)
            shards = _partition_tracks(selected, 2)
            self.assertEqual(2, len(selected))
            self.assertEqual(2, sum(len(shard) for shard in shards))

            payload = _merge_payloads(
                shard_payloads=[
                    {"summary": {}, "tracks": [self._row(second)], "errors": []},
                    {"summary": {}, "tracks": [self._row(first)], "errors": []},
                ],
                selected_tracks=selected,
                args=self._args(root, [first, second]),
                duration_sec=1.0,
                job_count=2,
                shard_count=2,
                status="complete",
            )

            self.assertEqual(2, payload["summary"]["trackTotal"])
            self.assertEqual(
                ["batch-a:asset-a", "batch-b:asset-b"],
                [row["instanceId"] for row in payload["tracks"]],
            )
            self.assertEqual(
                ["Same Song.mp3", "Same Song.mp3"],
                [row["fileName"] for row in payload["tracks"]],
            )
            self.assertEqual(
                "constant-grid-dp",
                payload["summary"]["runProvenance"]["configuration"]["solver"],
            )

    def test_registry_batch_enrichment_supplies_authoritative_fresh_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            registry_source = root / "sealed-intake" / "Same Song.mp3"
            registry_source.parent.mkdir()
            registry_source.write_bytes(b"fresh")
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
                                "sourcePath": str(registry_source),
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            enriched = _enrich_tracks_from_registry(
                [
                    {
                        "fileName": "Same Song.mp3",
                        "bpm": 120.0,
                        "firstBeatMs": 0.0,
                        "sourcePath": str(root / "stale" / "Same Song.mp3"),
                    }
                ],
                registry_path=registry_path,
                batch_id="fresh-a",
            )

            self.assertEqual("fresh-a:asset-a", enriched[0]["instanceId"])
            self.assertEqual("fresh-a", enriched[0]["batchId"])
            self.assertEqual("asset-a", enriched[0]["assetSha256"])
            self.assertEqual("pcm-a", enriched[0]["pcmSha256"])
            self.assertEqual("family-a", enriched[0]["familyId"])
            self.assertEqual(str(registry_source), enriched[0]["sourcePath"])

    def test_resume_shard_validation_uses_instance_identity_not_filename(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = self._track("batch-a", "asset-a", root / "batch-a" / "Same Song.mp3")
            second = self._track("batch-b", "asset-b", root / "batch-b" / "Same Song.mp3")
            args, shard_truth_path, output_path = self._write_resume_fixture(
                root=root,
                tracks=[first, second],
            )

            payload = _load_existing_shard_payload(
                shard_index=0,
                shard_count=1,
                shard_output_path=output_path,
                shard_truth_path=shard_truth_path,
                expected_tracks=[first, second],
                args=args,
            )

            self.assertIsNotNone(payload)
            self.assertEqual(2, len(payload["tracks"]))

            stale_first = self._row(first)
            stale_first.pop("sourcePath")
            stale_payload = attach_benchmark_result_digest(
                {
                    "summary": {
                        key: value
                        for key, value in payload["summary"].items()
                        if key != "resultBodySha256"
                    },
                    "tracks": [stale_first, self._row(second)],
                    "errors": [],
                }
            )
            output_path.write_text(
                json.dumps(stale_payload),
                encoding="utf-8",
            )
            self.assertIsNone(
                _load_existing_shard_payload(
                    shard_index=0,
                    shard_count=1,
                    shard_output_path=output_path,
                    shard_truth_path=shard_truth_path,
                    expected_tracks=[first, second],
                    args=args,
                )
            )

    def test_resume_shard_rejects_truth_solver_config_or_provenance_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            track = self._track("batch-a", "asset-a", root / "Same Song.mp3")

            with self.subTest("solver"):
                args, shard_truth_path, output_path = self._write_resume_fixture(
                    root=root / "solver",
                    tracks=[track],
                )
                changed = argparse.Namespace(**{**vars(args), "solver": "hybrid"})
                self.assertIsNone(
                    _load_existing_shard_payload(
                        shard_index=0,
                        shard_count=1,
                        shard_output_path=output_path,
                        shard_truth_path=shard_truth_path,
                        expected_tracks=[track],
                        args=changed,
                    )
                )

            with self.subTest("configuration"):
                args, shard_truth_path, output_path = self._write_resume_fixture(
                    root=root / "config",
                    tracks=[track],
                )
                Path(args.ffmpeg).write_bytes(b"changed ffmpeg")
                self.assertIsNone(
                    _load_existing_shard_payload(
                        shard_index=0,
                        shard_count=1,
                        shard_output_path=output_path,
                        shard_truth_path=shard_truth_path,
                        expected_tracks=[track],
                        args=args,
                    )
                )

            with self.subTest("truth"):
                args, shard_truth_path, output_path = self._write_resume_fixture(
                    root=root / "truth",
                    tracks=[track],
                )
                source_truth_path = Path(args.truth)
                source_payload = json.loads(source_truth_path.read_text(encoding="utf-8"))
                source_payload["tracks"][0]["title"] = "changed"
                source_truth_path.write_text(json.dumps(source_payload), encoding="utf-8")
                self.assertIsNone(
                    _load_existing_shard_payload(
                        shard_index=0,
                        shard_count=1,
                        shard_output_path=output_path,
                        shard_truth_path=shard_truth_path,
                        expected_tracks=[track],
                        args=args,
                    )
                )

            with self.subTest("stored provenance"):
                args, shard_truth_path, output_path = self._write_resume_fixture(
                    root=root / "provenance",
                    tracks=[track],
                )
                payload = json.loads(output_path.read_text(encoding="utf-8"))
                payload["summary"]["runProvenance"]["truthSha256"] = "tampered"
                attach_benchmark_result_digest(payload)
                output_path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertIsNone(
                    _load_existing_shard_payload(
                        shard_index=0,
                        shard_count=1,
                        shard_output_path=output_path,
                        shard_truth_path=shard_truth_path,
                        expected_tracks=[track],
                        args=args,
                    )
                )

    def test_resume_shard_rejects_result_metric_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            track = self._track("batch-a", "asset-a", root / "Same Song.mp3")
            args, shard_truth_path, output_path = self._write_resume_fixture(
                root=root,
                tracks=[track],
            )
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            payload["tracks"][0]["currentTimeline"]["category"] = "bpm-big-error"
            output_path.write_text(json.dumps(payload), encoding="utf-8")

            self.assertIsNone(
                _load_existing_shard_payload(
                    shard_index=0,
                    shard_count=1,
                    shard_output_path=output_path,
                    shard_truth_path=shard_truth_path,
                    expected_tracks=[track],
                    args=args,
                )
            )


if __name__ == "__main__":
    unittest.main()
