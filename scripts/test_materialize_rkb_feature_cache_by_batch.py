import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import materialize_rkb_feature_cache_by_batch as materializer
from rkb_beatgrid_lab_common import atomic_write_json, load_feature_index, write_feature_index


class MaterializeRkbFeatureCacheByBatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.batch_id = "batch-a"
        self.batches_root = self.root / "batches"
        self.source_cache = self.root / "source-cache"
        self.target_cache = self.root / "target-cache"
        self.source_cache.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_manifest(self, rows: list[dict[str, object]]) -> None:
        batch_dir = self.batches_root / self.batch_id
        batch_dir.mkdir(parents=True)
        atomic_write_json(
            batch_dir / "manifest.json",
            {
                "batchId": self.batch_id,
                "audioRoster": rows,
            },
        )

    def _roster_row(
        self,
        *,
        file_name: str = "Same Song.mp3",
        size: int = 222,
        asset_sha256: str = "asset-b",
        source_path: Path | None = None,
    ) -> dict[str, object]:
        return {
            "fileName": file_name,
            "normalizedFileName": file_name.casefold(),
            "size": size,
            "assetSha256": asset_sha256,
            "pcmSha256": f"pcm-{asset_sha256}",
            "familyId": f"chromaprint:{asset_sha256}",
            "sourcePath": str(source_path or self.root / "audio" / file_name),
        }

    def _identity_roster_row(
        self,
        *,
        file_name: str = "Same Song.mp3",
        content: bytes = b"identity-audio",
        directory: str = "audio",
    ) -> dict[str, object]:
        source_path = self.root / directory / file_name
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_bytes(content)
        return self._roster_row(
            file_name=file_name,
            size=len(content),
            asset_sha256=hashlib.sha256(content).hexdigest(),
            source_path=source_path,
        )

    def _source_entry(
        self,
        *,
        cache_key: str,
        file_name: str = "Same Song.mp3",
        size: int,
        arrays_bytes: bytes,
        identity_row: dict[str, object] | None = None,
        legacy_audio_path: Path | None = None,
    ) -> dict[str, object]:
        metadata_name = f"feature-{cache_key}.json"
        arrays_name = f"arrays-{cache_key}.npz"
        audio_path = legacy_audio_path or (
            Path(str(identity_row["sourcePath"])) if identity_row is not None else None
        )
        metadata: dict[str, object] = {
            "cacheKey": cache_key,
            "cachePayload": {
                "audioFile": {
                    "size": size,
                    "path": str(audio_path) if audio_path is not None else str(self.root / "missing.mp3"),
                }
            },
            "fileName": file_name,
            "lookupKey": file_name.casefold(),
            "arraysPath": arrays_name,
            "audio": {"durationSec": 120.0},
            "featureCacheVersion": 2,
        }
        if identity_row is not None:
            metadata.update(
                {
                    "instanceId": f"{self.batch_id}:{identity_row['assetSha256']}",
                    "batchId": self.batch_id,
                    "assetSha256": identity_row["assetSha256"],
                    "pcmSha256": identity_row["pcmSha256"],
                    "familyId": identity_row["familyId"],
                    "sourcePath": identity_row["sourcePath"],
                }
            )
        atomic_write_json(self.source_cache / metadata_name, metadata)
        (self.source_cache / arrays_name).write_bytes(arrays_bytes)
        return {
            "fileName": file_name,
            "lookupKey": file_name.casefold(),
            "cacheKey": cache_key,
            "metadataPath": metadata_name,
            "arraysPath": arrays_name,
            "durationSec": 120.0,
            "featureCacheVersion": 2,
        }

    def _write_source_index(self, entries: list[dict[str, object]]) -> None:
        write_feature_index(self.source_cache, entries)

    def _write_splits(self, roster_rows: list[dict[str, object]]) -> Path:
        splits_path = self.root / "splits.json"
        instances = []
        for row in roster_rows:
            asset_sha256 = str(row["assetSha256"])
            instances.append(
                {
                    "instanceId": f"{self.batch_id}:{asset_sha256}",
                    "batchId": self.batch_id,
                    "assetSha256": asset_sha256,
                    "familyId": row["familyId"],
                    "isolationFamilyId": f"isolation:{asset_sha256}",
                    "sourcePath": row["sourcePath"],
                }
            )
        atomic_write_json(splits_path, {"instances": instances})
        return splits_path

    def test_materializes_unique_size_match_and_keeps_same_name_instances(self) -> None:
        roster_row = self._identity_roster_row(content=b"right-audio")
        wrong = self._source_entry(
            cache_key="cache-wrong",
            size=int(roster_row["size"]) - 1,
            arrays_bytes=b"wrong",
        )
        selected = self._source_entry(
            cache_key="cache-right",
            size=int(roster_row["size"]),
            arrays_bytes=b"right",
            identity_row=roster_row,
        )
        self._write_source_index([wrong, selected])
        self._write_manifest([roster_row])
        self.target_cache.mkdir()
        write_feature_index(
            self.target_cache,
            [
                {
                    "fileName": "Same Song.mp3",
                    "lookupKey": "same song.mp3",
                    "instanceId": "other-batch:other-asset",
                    "batchId": "other-batch",
                    "cacheKey": "old-cache",
                    "metadataPath": "old.json",
                    "arraysPath": "old.npz",
                }
            ],
        )

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
        )

        self.assertEqual(1, summary["reused"])
        self.assertEqual(0, summary["missing"])
        self.assertEqual(1, summary["arrays"]["hardlinked"])
        entries = load_feature_index(self.target_cache)["entries"]
        self.assertEqual(2, len(entries))
        self.assertEqual({"same song.mp3"}, {entry["lookupKey"] for entry in entries})
        self.assertEqual(
            {"other-batch:other-asset", f"batch-a:{roster_row['assetSha256']}"},
            {entry["instanceId"] for entry in entries},
        )
        target_entry = next(entry for entry in entries if entry["batchId"] == self.batch_id)
        self.assertEqual("cache-right", target_entry["cacheKey"])
        target_metadata = json.loads(
            (self.target_cache / target_entry["metadataPath"]).read_text(encoding="utf-8")
        )
        self.assertEqual(f"batch-a:{roster_row['assetSha256']}", target_metadata["instanceId"])

        self.assertEqual("batch-a", target_metadata["batchId"])
        self.assertEqual(roster_row["assetSha256"], target_metadata["assetSha256"])
        self.assertEqual(roster_row["pcmSha256"], target_metadata["pcmSha256"])
        self.assertEqual(roster_row["familyId"], target_metadata["familyId"])
        self.assertEqual(roster_row["sourcePath"], target_metadata["sourcePath"])
        self.assertEqual("source-metadata-identity", target_metadata["identityProof"]["kind"])
        self.assertTrue(
            os.path.samefile(
                self.source_cache / selected["arraysPath"],
                self.target_cache / target_entry["arraysPath"],
            )
        )
        source_metadata = json.loads(
            (self.source_cache / selected["metadataPath"]).read_text(encoding="utf-8")
        )
        self.assertEqual(f"batch-a:{roster_row['assetSha256']}", source_metadata["instanceId"])
        self.assertNotIn("identityProof", source_metadata)

    def test_projects_isolation_family_from_canonical_split(self) -> None:
        roster_row = self._identity_roster_row(content=b"isolation-audio")
        selected = self._source_entry(
            cache_key="cache-isolation",
            size=int(roster_row["size"]),
            arrays_bytes=b"isolation",
            identity_row=roster_row,
        )
        self._write_source_index([selected])
        self._write_manifest([roster_row])
        splits_path = self._write_splits([roster_row])

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
            splits_path=splits_path,
        )

        self.assertEqual(0, summary["missing"])
        entry = load_feature_index(self.target_cache)["entries"][0]
        self.assertEqual(
            f"isolation:{roster_row['assetSha256']}", entry["isolationFamilyId"]
        )
        metadata = json.loads((self.target_cache / entry["metadataPath"]).read_text(encoding="utf-8"))
        self.assertEqual(
            f"isolation:{roster_row['assetSha256']}", metadata["isolationFamilyId"]
        )
        self.assertEqual(str(roster_row["sourcePath"]), metadata["sourcePath"])

    def test_size_mismatch_is_missing_and_does_not_create_an_entry(self) -> None:
        entry = self._source_entry(cache_key="cache-a", size=100, arrays_bytes=b"arrays")
        self._write_source_index([entry])
        self._write_manifest([self._roster_row(size=101)])

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
        )

        self.assertEqual(0, summary["reused"])
        self.assertEqual(1, summary["missing"])
        self.assertEqual("sourceSizeMismatch", summary["missingTracks"][0]["reason"])
        self.assertEqual([], load_feature_index(self.target_cache)["entries"])

    def test_legacy_name_and_size_without_identity_is_not_reused(self) -> None:
        entry = self._source_entry(cache_key="cache-a", size=222, arrays_bytes=b"arrays")
        self._write_source_index([entry])
        self._write_manifest([self._roster_row(size=222)])

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
        )

        self.assertEqual(0, summary["reused"])
        self.assertEqual(1, summary["missing"])
        self.assertEqual("sourceIdentityUnavailable", summary["missingTracks"][0]["reason"])

    def test_legacy_source_file_asset_hash_proves_identity(self) -> None:
        content = b"legacy-audio"
        legacy_audio_path = self.root / "legacy" / "Same Song.mp3"
        legacy_audio_path.parent.mkdir()
        legacy_audio_path.write_bytes(content)
        roster_row = self._roster_row(
            size=len(content),
            asset_sha256=hashlib.sha256(content).hexdigest(),
        )
        entry = self._source_entry(
            cache_key="cache-a",
            size=len(content),
            arrays_bytes=b"arrays",
            legacy_audio_path=legacy_audio_path,
        )
        self._write_source_index([entry])
        self._write_manifest([roster_row])

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
        )

        self.assertEqual(1, summary["reused"])
        target_entry = load_feature_index(self.target_cache)["entries"][0]
        target_metadata = json.loads(
            (self.target_cache / target_entry["metadataPath"]).read_text(encoding="utf-8")
        )
        self.assertEqual("legacy-source-asset-sha256", target_metadata["identityProof"]["kind"])

    def test_source_metadata_identity_mismatch_is_not_reused(self) -> None:
        roster_row = self._identity_roster_row(content=b"right-identity", directory="right")
        wrong_row = self._identity_roster_row(content=b"wrong-identity", directory="wrong")
        self.assertEqual(roster_row["size"], wrong_row["size"])
        entry = self._source_entry(
            cache_key="cache-a",
            size=int(roster_row["size"]),
            arrays_bytes=b"arrays",
            identity_row=wrong_row,
        )
        self._write_source_index([entry])
        self._write_manifest([roster_row])

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
        )

        self.assertEqual(0, summary["reused"])
        self.assertEqual("sourceIdentityMismatch", summary["missingTracks"][0]["reason"])

    def test_preserves_a_valid_recomputed_entry_for_a_source_size_mismatch(self) -> None:
        source_entry = self._source_entry(cache_key="old-cache", size=100, arrays_bytes=b"old")
        self._write_source_index([source_entry])
        roster_row = self._identity_roster_row(content=b"r" * 101)
        self._write_manifest([roster_row])
        self.target_cache.mkdir()
        target_metadata = {
            "cacheKey": "recomputed-cache",
            "cachePayload": {
                "audioFile": {"size": 101, "path": roster_row["sourcePath"]}
            },
            "fileName": roster_row["fileName"],
            "lookupKey": "same song.mp3",
            "arraysPath": "arrays-recomputed.npz",
            "instanceId": f"batch-a:{roster_row['assetSha256']}",
            "batchId": "batch-a",
            "assetSha256": roster_row["assetSha256"],
            "pcmSha256": roster_row["pcmSha256"],
            "familyId": roster_row["familyId"],
            "sourcePath": roster_row["sourcePath"],
            "audio": {"durationSec": 120.0},
            "featureCacheVersion": 2,
        }
        atomic_write_json(self.target_cache / "feature-recomputed.json", target_metadata)
        (self.target_cache / "arrays-recomputed.npz").write_bytes(b"recomputed")
        write_feature_index(
            self.target_cache,
            [
                {
                    "fileName": roster_row["fileName"],
                    "lookupKey": "same song.mp3",
                    "instanceId": f"batch-a:{roster_row['assetSha256']}",
                    "batchId": "batch-a",
                    "assetSha256": roster_row["assetSha256"],
                    "cacheKey": "recomputed-cache",
                    "metadataPath": "feature-recomputed.json",
                    "arraysPath": "arrays-recomputed.npz",
                    "durationSec": 120.0,
                    "featureCacheVersion": 2,
                }
            ],
        )

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
        )

        self.assertEqual(0, summary["reused"])
        self.assertEqual(1, summary["missing"])
        self.assertEqual(1, summary["preservedExisting"])
        entries = load_feature_index(self.target_cache)["entries"]
        self.assertEqual(1, len(entries))
        self.assertEqual("recomputed-cache", entries[0]["cacheKey"])

    def test_multiple_source_size_matches_are_missing(self) -> None:
        roster_row = self._identity_roster_row(content=b"same-size-audio")
        first = self._source_entry(
            cache_key="cache-a",
            size=int(roster_row["size"]),
            arrays_bytes=b"first",
            identity_row=roster_row,
        )
        second = self._source_entry(
            cache_key="cache-b",
            size=int(roster_row["size"]),
            arrays_bytes=b"second",
            identity_row=roster_row,
        )
        self._write_source_index([first, second])
        self._write_manifest([roster_row])

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
        )

        self.assertEqual(0, summary["reused"])
        self.assertEqual(1, summary["missing"])
        self.assertEqual("ambiguousSourceIdentityMatch", summary["missingTracks"][0]["reason"])
        self.assertEqual(2, summary["missingTracks"][0]["sizeMatchCount"])
        self.assertEqual(2, summary["missingTracks"][0]["identityMatchCount"])

    def test_same_manifest_lookup_and_size_uses_strong_identity(self) -> None:
        first_row = self._identity_roster_row(content=b"a" * 16, directory="audio-a")
        second_row = self._identity_roster_row(content=b"b" * 16, directory="audio-b")
        first = self._source_entry(
            cache_key="cache-a",
            size=16,
            arrays_bytes=b"first",
            identity_row=first_row,
        )
        second = self._source_entry(
            cache_key="cache-b",
            size=16,
            arrays_bytes=b"second",
            identity_row=second_row,
        )
        self._write_source_index([first, second])
        self._write_manifest([first_row, second_row])

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
        )

        self.assertEqual(2, summary["reused"])
        self.assertEqual(0, summary["missing"])
        self.assertEqual(
            {f"batch-a:{first_row['assetSha256']}", f"batch-a:{second_row['assetSha256']}"},
            {entry["instanceId"] for entry in load_feature_index(self.target_cache)["entries"]},
        )

    def test_copy_arrays_flag_and_hardlink_failure_use_copy2(self) -> None:
        roster_row = self._identity_roster_row(content=b"copy-audio")
        entry = self._source_entry(
            cache_key="cache-a",
            size=int(roster_row["size"]),
            arrays_bytes=b"arrays",
            identity_row=roster_row,
        )
        self._write_source_index([entry])
        self._write_manifest([roster_row])

        copied_target = self.root / "copied-target"
        copied = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=copied_target,
            copy_arrays=True,
        )
        copied_entry = load_feature_index(copied_target)["entries"][0]
        self.assertEqual(1, copied["arrays"]["copied"])
        self.assertFalse(
            os.path.samefile(
                self.source_cache / entry["arraysPath"],
                copied_target / copied_entry["arraysPath"],
            )
        )

        fallback_target = self.root / "fallback-target"
        with patch.object(materializer.os, "link", side_effect=OSError("cross-device")):
            fallback = materializer.materialize_batch_feature_cache(
                batch_id=self.batch_id,
                batches_root=self.batches_root,
                source_cache_dir=self.source_cache,
                target_cache_dir=fallback_target,
            )
        fallback_entry = load_feature_index(fallback_target)["entries"][0]
        self.assertEqual(1, fallback["arrays"]["copied"])
        self.assertEqual(
            b"arrays",
            (fallback_target / fallback_entry["arraysPath"]).read_bytes(),
        )

    def test_dry_run_does_not_touch_target_cache(self) -> None:
        roster_row = self._identity_roster_row(content=b"dry-run-audio")
        entry = self._source_entry(
            cache_key="cache-a",
            size=int(roster_row["size"]),
            arrays_bytes=b"arrays",
            identity_row=roster_row,
        )
        self._write_source_index([entry])
        self._write_manifest([roster_row])

        summary = materializer.materialize_batch_feature_cache(
            batch_id=self.batch_id,
            batches_root=self.batches_root,
            source_cache_dir=self.source_cache,
            target_cache_dir=self.target_cache,
            dry_run=True,
        )

        self.assertEqual(1, summary["reused"])
        self.assertEqual(0, summary["missing"])
        self.assertFalse(self.target_cache.exists())

    def test_rejects_using_the_source_cache_as_the_target(self) -> None:
        self._write_manifest([self._roster_row()])

        with self.assertRaisesRegex(RuntimeError, "must be different"):
            materializer.materialize_batch_feature_cache(
                batch_id=self.batch_id,
                batches_root=self.batches_root,
                source_cache_dir=self.source_cache,
                target_cache_dir=self.source_cache,
                dry_run=True,
            )


if __name__ == "__main__":
    unittest.main()
