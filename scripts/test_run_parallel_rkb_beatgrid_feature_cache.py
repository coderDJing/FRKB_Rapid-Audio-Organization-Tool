import json
import tempfile
import unittest
from pathlib import Path

from rkb_beatgrid_lab_common import load_feature_index
from rkb_dataset_contract import materialize_registry_enriched_truth, validate_truth_contract
from run_parallel_rkb_beatgrid_feature_cache import (
    _enrich_tracks_from_registry,
    _partition_tracks,
    _rebuild_index_from_metadata,
    _select_tracks,
    _write_shard_truth,
)


class ParallelRkbFeatureCacheTest(unittest.TestCase):
    def _track(self, *, instance_id: str, asset_sha256: str, source_path: Path) -> dict[str, object]:
        return {
            "fileName": "Same Song.mp3",
            "title": "Same Song",
            "artist": "Tester",
            "instanceId": instance_id,
            "batchId": instance_id.split(":", 1)[0],
            "assetSha256": asset_sha256,
            "pcmSha256": f"pcm-{asset_sha256}",
            "familyId": f"family-{asset_sha256}",
            "sourcePath": str(source_path),
            "bpm": 120.0,
            "firstBeatMs": 0.0,
        }

    def _write_feature(
        self,
        *,
        cache_dir: Path,
        track: dict[str, object],
        cache_key: str,
        created_at: float,
        instance_id: str | None = None,
    ) -> None:
        metadata = {
            "cacheKey": cache_key,
            "cachePayload": {
                "audioFile": {
                    "path": track["sourcePath"],
                    "size": 10,
                }
            },
            "createdAt": created_at,
            "featureCacheVersion": 2,
            "fileName": track["fileName"],
            "lookupKey": "same song.mp3",
            "arraysPath": f"arrays-{cache_key}.npz",
            "instanceId": instance_id or track["instanceId"],
            "batchId": track["batchId"],
            "assetSha256": track["assetSha256"],
            "pcmSha256": track["pcmSha256"],
            "familyId": track["familyId"],
            "sourcePath": track["sourcePath"],
            "audio": {"durationSec": 120.0},
        }
        (cache_dir / f"feature-{cache_key}.json").write_text(
            json.dumps(metadata),
            encoding="utf-8",
        )
        (cache_dir / f"arrays-{cache_key}.npz").write_bytes(cache_key.encode("utf-8"))

    def test_selection_and_partition_keep_same_name_instances(self) -> None:
        first = self._track(
            instance_id="batch-a:asset-a",
            asset_sha256="asset-a",
            source_path=Path("A:/Same Song.mp3"),
        )
        second = self._track(
            instance_id="batch-b:asset-b",
            asset_sha256="asset-b",
            source_path=Path("B:/Same Song.mp3"),
        )

        selected = _select_tracks([first, second, dict(first)], [], 0)
        shards = _partition_tracks(selected, 2)

        self.assertEqual(2, len(selected))
        self.assertEqual(
            {"batch-a:asset-a", "batch-b:asset-b"},
            {track["instanceId"] for shard in shards for track in shard},
        )

    def test_enriches_a_sealed_batch_truth_from_registry_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "Same Song.mp3"
            registry_path = root / "registry.json"
            registry_path.write_text(
                json.dumps(
                    {
                        "tracks": [
                            {
                                "fileName": "Same Song.mp3",
                                "batchId": "batch-a",
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

            enriched = _enrich_tracks_from_registry(
                [{"fileName": "Same Song.mp3", "filePath": str(source_path)}],
                registry_path=registry_path,
                batch_id="batch-a",
            )

            self.assertEqual("batch-a:asset-a", enriched[0]["instanceId"])
            self.assertEqual("batch-a", enriched[0]["batchId"])
            self.assertEqual("asset-a", enriched[0]["assetSha256"])
            self.assertEqual(str(source_path), enriched[0]["sourcePath"])

    def test_shard_truth_preserves_instance_identity_fields(self) -> None:
        track = self._track(
            instance_id="batch-a:asset-a",
            asset_sha256="asset-a",
            source_path=Path("A:/Same Song.mp3"),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "shard.json"

            _write_shard_truth(
                base_payload={"source": {"type": "test"}, "tracks": []},
                tracks=[track],
                path=path,
                index=0,
                count=1,
            )

            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual("batch-a:asset-a", payload["tracks"][0]["instanceId"])
            self.assertEqual("batch-a", payload["tracks"][0]["batchId"])
            self.assertEqual("asset-a", payload["tracks"][0]["assetSha256"])

    def test_registry_enrichment_materializes_authoritative_truth_before_sharding(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            audio_path = root / "Fresh Song.mp3"
            audio_path.write_bytes(b"fresh-audio")
            source_truth_path = root / "truth.json"
            source_truth_path.write_text(
                json.dumps(
                    {
                        "tracks": [
                            {
                                "fileName": audio_path.name,
                                "title": "Fresh Song",
                                "bpm": 123.0,
                                "firstBeatMs": 42.0,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            registry_path = root / "registry.json"
            registry_path.write_text(
                json.dumps(
                    {
                        "generatedAt": "first-build",
                        "tracks": [
                            {
                                "batchId": "fresh-batch",
                                "batchStatus": "fresh",
                                "fileName": audio_path.name,
                                "assetSha256": "asset-fresh",
                                "pcmSha256": "pcm-fresh",
                                "familyId": "family-fresh",
                                "sourcePath": str(audio_path),
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            authoritative_path = root / "work" / "authoritative.json"
            payload, contract, tracks = materialize_registry_enriched_truth(
                source_truth_path=source_truth_path,
                registry_path=registry_path,
                batch_id="fresh-batch",
                output_path=authoritative_path,
            )
            shard_path = root / "work" / "truth-shard-1.json"
            _write_shard_truth(
                base_payload=payload,
                tracks=tracks,
                path=shard_path,
                index=0,
                count=1,
                source_truth_path=authoritative_path,
                source_contract=contract,
            )

            shard_contract = validate_truth_contract(shard_path)

            self.assertTrue(contract["registryEnrichedTruth"])
            self.assertTrue(shard_contract["derivedShard"])
            self.assertEqual("fresh-batch:asset-fresh", tracks[0]["instanceId"])

    def test_rebuild_index_keeps_same_name_instances_and_rejects_wrong_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_dir = Path(temp_dir)
            first = self._track(
                instance_id="batch-a:asset-a",
                asset_sha256="asset-a",
                source_path=cache_dir / "audio-a.mp3",
            )
            second = self._track(
                instance_id="batch-b:asset-b",
                asset_sha256="asset-b",
                source_path=cache_dir / "audio-b.mp3",
            )
            self._write_feature(
                cache_dir=cache_dir,
                track=first,
                cache_key="first-old",
                created_at=1.0,
            )
            self._write_feature(
                cache_dir=cache_dir,
                track=first,
                cache_key="first-new",
                created_at=2.0,
            )
            self._write_feature(
                cache_dir=cache_dir,
                track=second,
                cache_key="second",
                created_at=1.0,
            )
            self._write_feature(
                cache_dir=cache_dir,
                track=first,
                cache_key="wrong-instance",
                created_at=3.0,
                instance_id="batch-x:asset-x",
            )

            indexed_count = _rebuild_index_from_metadata(cache_dir, [first, second])

            entries = load_feature_index(cache_dir)["entries"]
            self.assertEqual(2, indexed_count)
            self.assertEqual(2, len(entries))
            self.assertEqual(
                {"batch-a:asset-a", "batch-b:asset-b"},
                {entry["instanceId"] for entry in entries},
            )
            self.assertEqual(
                "first-new",
                next(entry for entry in entries if entry["instanceId"] == "batch-a:asset-a")[
                    "cacheKey"
                ],
            )


if __name__ == "__main__":
    unittest.main()
