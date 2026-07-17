import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from rkb_multiscale_feature_cache import _rebuild_output_index, _repair_output_hashes


class MultiscaleFeatureCacheTests(unittest.TestCase):
    def test_rebuild_index_recovers_all_metadata(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_index = root / "source-index.json"
            source_index.write_text('{"entries":[]}', encoding="utf-8")
            for label in ("a", "b"):
                arrays_path = root / f"multiscale-{label}.npz"
                with arrays_path.open("wb") as output:
                    np.savez_compressed(output, frameRate=np.asarray(100.0, dtype="float32"))
                from rkb_dataset_contract import sha256_file

                (root / f"multiscale-{label}.json").write_text(
                    json.dumps(
                        {
                            "cacheKey": label,
                            "createdAt": 1.0,
                            "spectralVersion": "rkb-multiscale-spectral-v1",
                            "fileName": label,
                            "lookupKey": label,
                            "instanceId": f"batch:{label}",
                            "batchId": "batch",
                            "assetSha256": label * 64,
                            "sourcePath": label,
                            "arraysPath": arrays_path.name,
                            "arraysSha256": sha256_file(arrays_path),
                        }
                    ),
                    encoding="utf-8",
                )
            result = _rebuild_output_index(root, source_index)
            index = json.loads((root / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(result["entryCount"], 2)
        self.assertEqual(index["entryCount"], 2)

    def test_repair_hashes_updates_metadata_and_index(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            metadata_path = root / "multiscale-a.json"
            arrays_path = root / "multiscale-a.npz"
            metadata_path.write_text('{"cacheKey":"a"}', encoding="utf-8")
            with arrays_path.open("wb") as output:
                np.savez_compressed(output, frameRate=np.asarray(100.0, dtype="float32"))
            (root / "index.json").write_text(
                json.dumps(
                    {
                        "entries": [
                            {
                                "instanceId": "batch:a",
                                "metadataPath": metadata_path.name,
                                "arraysPath": arrays_path.name,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            result = _repair_output_hashes(root)
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            index = json.loads((root / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(result["repairedMetadataCount"], 1)
        self.assertEqual(metadata["arraysSha256"], index["entries"][0]["arraysSha256"])


if __name__ == "__main__":
    unittest.main()
