import json
import tempfile
import unittest
from pathlib import Path

from rkb_beatgrid_lab_common import read_feature_metadata, validate_feature_metadata_identity


class RkbBeatgridLabCommonIdentityTest(unittest.TestCase):
    def _track(self, source_path: Path) -> dict[str, object]:
        return {
            "fileName": "Track.mp3",
            "instanceId": "batch-a:asset-a",
            "batchId": "batch-a",
            "assetSha256": "asset-a",
            "pcmSha256": "pcm-a",
            "familyId": "family-a",
            "sourcePath": str(source_path),
            "filePath": str(source_path),
        }

    def _entry(self) -> dict[str, object]:
        return {
            "fileName": "Track.mp3",
            "lookupKey": "track.mp3",
            "instanceId": "batch-a:asset-a",
            "batchId": "batch-a",
            "assetSha256": "asset-a",
            "cacheKey": "cache-a",
            "metadataPath": "feature-cache-a.json",
            "arraysPath": "arrays-cache-a.npz",
        }

    def _metadata(self, audio_path: Path) -> dict[str, object]:
        return {
            "cacheKey": "cache-a",
            "cachePayload": {"audioFile": {"path": str(audio_path), "size": 10}},
            "instanceId": "batch-a:asset-a",
            "batchId": "batch-a",
            "assetSha256": "asset-a",
            "pcmSha256": "pcm-a",
            "familyId": "family-a",
            "sourcePath": str(audio_path),
        }

    def test_accepts_direct_feature_metadata_for_the_same_instance(self) -> None:
        source_path = Path("G:/audio/Track.mp3")

        validate_feature_metadata_identity(
            track=self._track(source_path),
            entry=self._entry(),
            metadata=self._metadata(source_path),
        )

    def test_rejects_index_or_metadata_identity_mismatch(self) -> None:
        source_path = Path("G:/audio/Track.mp3")
        wrong_entry = self._entry()
        wrong_entry["instanceId"] = "batch-b:asset-b"
        with self.assertRaisesRegex(RuntimeError, "index instanceId mismatch"):
            validate_feature_metadata_identity(
                track=self._track(source_path),
                entry=wrong_entry,
                metadata=self._metadata(source_path),
            )

        wrong_metadata = self._metadata(source_path)
        wrong_metadata["assetSha256"] = "asset-b"
        with self.assertRaisesRegex(RuntimeError, "metadata assetSha256 mismatch"):
            validate_feature_metadata_identity(
                track=self._track(source_path),
                entry=self._entry(),
                metadata=wrong_metadata,
            )

    def test_rejects_moved_metadata_without_identity_proof(self) -> None:
        track_path = Path("G:/audio/Track.mp3")
        metadata = self._metadata(Path("D:/old/Track.mp3"))
        metadata["sourcePath"] = str(track_path)
        with self.assertRaisesRegex(RuntimeError, "source identity proof missing"):
            validate_feature_metadata_identity(
                track=self._track(track_path),
                entry=self._entry(),
                metadata=metadata,
            )

    def test_accepts_moved_metadata_with_matching_identity_proof(self) -> None:
        track_path = Path("G:/audio/Track.mp3")
        metadata = self._metadata(Path("D:/old/Track.mp3"))
        metadata["sourcePath"] = str(track_path)
        metadata["identityProof"] = {
            "schemaVersion": 1,
            "kind": "legacy-source-asset-sha256",
            "sourceCacheKey": "cache-a",
            "batchId": "batch-a",
            "assetSha256": "asset-a",
            "pcmSha256": "pcm-a",
            "familyId": "family-a",
        }

        validate_feature_metadata_identity(
            track=self._track(track_path),
            entry=self._entry(),
            metadata=metadata,
        )

    def test_read_rejects_metadata_cache_key_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_dir = Path(temp_dir)
            metadata = self._metadata(Path("G:/audio/Track.mp3"))
            metadata["cacheKey"] = "wrong-cache"
            (cache_dir / "feature-cache-a.json").write_text(
                json.dumps(metadata),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, "cacheKey mismatch"):
                read_feature_metadata(cache_dir, self._entry())


if __name__ == "__main__":
    unittest.main()
