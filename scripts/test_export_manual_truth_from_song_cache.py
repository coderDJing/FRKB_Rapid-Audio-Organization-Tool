import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "export_manual_truth_from_song_cache.py"


def _load_exporter_module():
    spec = importlib.util.spec_from_file_location("export_manual_truth", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


exporter = _load_exporter_module()


class ExportManualTruthV2Test(unittest.TestCase):
    def _map(self) -> dict:
        return {
            "version": 2,
            "source": "manual",
            "signature": "sbgm_example",
            "clips": [
                {
                    "startSec": 0,
                    "anchorSec": 0.1,
                    "bpm": 128,
                    "downbeatBeatOffset": 2,
                }
            ],
        }

    def test_accepts_only_a_valid_v2_map(self):
        self.assertTrue(exporter._is_v2_map(self._map()))

        legacy = self._map()
        legacy.pop("version")
        legacy["barBeatOffset"] = 2
        self.assertFalse(exporter._is_v2_map(legacy))

        invalid_phase = self._map()
        invalid_phase["clips"][0]["downbeatBeatOffset"] = 4
        self.assertFalse(exporter._is_v2_map(invalid_phase))

        invalid_clip_order = self._map()
        invalid_clip_order["clips"].append(
            {"startSec": 0, "anchorSec": 10, "bpm": 128, "downbeatBeatOffset": 0}
        )
        self.assertFalse(exporter._is_v2_map(invalid_clip_order))


if __name__ == "__main__":
    unittest.main()
