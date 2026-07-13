import json
import tempfile
import unittest
from pathlib import Path

from rkb_constant_grid_dp_lab import _load_split_map


class ConstantGridDpLabSplitMapTest(unittest.TestCase):
    def _write(self, path: Path, payload: dict[str, object]) -> None:
        path.write_text(json.dumps(payload), encoding="utf-8")

    def test_loads_instance_id_split_schema(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "splits.json"
            self._write(
                path,
                {
                    "identityKey": "instanceId",
                    "splits": {
                        "train": ["batch-a:asset-a"],
                        "holdout": ["batch-b:asset-b"],
                    },
                },
            )

            result = _load_split_map(path)

            self.assertEqual("train", result["instance:batch-a:asset-a"])
            self.assertEqual("holdout", result["instance:batch-b:asset-b"])
            self.assertNotIn("file:batch-a:asset-a", result)

    def test_keeps_legacy_filename_split_schema(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "splits.json"
            self._write(path, {"splits": {"tune": ["Same.FLAC"]}})

            result = _load_split_map(path)

            self.assertEqual("tune", result["file:same.flac"])


if __name__ == "__main__":
    unittest.main()
