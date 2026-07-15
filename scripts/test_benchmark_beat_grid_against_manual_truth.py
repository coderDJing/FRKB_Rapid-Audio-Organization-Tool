import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "benchmark_beat_grid_against_manual_truth.py"


def _load_benchmark_module():
    spec = importlib.util.spec_from_file_location("benchmark_manual_truth", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


benchmark = _load_benchmark_module()


class BenchmarkManualTruthV2Test(unittest.TestCase):
    def _track(self, downbeat_beat_offset: int = 3) -> dict:
        clip = {
            "startSec": 0,
            "anchorSec": 0.125,
            "bpm": 128,
            "downbeatBeatOffset": downbeat_beat_offset,
        }
        track = {
            "fileName": "example.mp3",
            "filePath": "D:/library/example.mp3",
            "title": "Example",
            "artist": "FRKB",
            "beatGridMap": {
                "version": 2,
                "source": "manual",
                "clips": [clip],
                "signature": benchmark._calculate_map_signature(clip),
            },
        }
        return track

    def test_uses_only_a_fixed_v2_map_for_truth(self):
        ground_truth = benchmark._derive_manual_ground_truth(self._track())

        self.assertIsNotNone(ground_truth)
        assert ground_truth is not None
        self.assertEqual(128.0, ground_truth["bpm"])
        self.assertEqual(125.0, ground_truth["firstBeatMs"])
        self.assertEqual(3, ground_truth["downbeatBeatOffset"])
        self.assertEqual(128, len(ground_truth["referenceBeatTimesSec"]))
        self.assertNotIn("barBeatOffset", ground_truth)
        self.assertEqual(2, ground_truth["beatGridMap"]["version"])

    def test_rejects_legacy_roots_and_dynamic_maps(self):
        legacy_track = self._track()
        legacy_track.pop("beatGridMap")
        legacy_track.update({"bpm": 128, "firstBeatMs": 125, "barBeatOffset": 3})
        self.assertIsNone(benchmark._derive_manual_ground_truth(legacy_track))

        dynamic_track = self._track()
        dynamic_track["beatGridMap"]["clips"].append(
            {"startSec": 30, "anchorSec": 30, "bpm": 130, "downbeatBeatOffset": 0}
        )
        self.assertIsNone(benchmark._derive_manual_ground_truth(dynamic_track))

        invalid_signature = self._track()
        invalid_signature["beatGridMap"]["signature"] = "sbgm_invalid"
        self.assertIsNone(benchmark._derive_manual_ground_truth(invalid_signature))

    def test_result_and_metric_use_downbeat_offset_only(self):
        ground_truth = benchmark._derive_manual_ground_truth(self._track())
        assert ground_truth is not None
        result = benchmark._normalize_result(
            {
                "bpm": 128,
                "firstBeatMs": 125,
                "downbeatBeatOffset": 3,
                "beatCount": 40,
                "downbeatCount": 10,
            }
        )

        self.assertIsNotNone(result)
        assert result is not None
        metrics = benchmark._derive_grid_metrics(result, ground_truth)
        self.assertTrue(metrics["downbeatBeatOffsetMatches"])
        self.assertNotIn("barBeatOffsetMatches", metrics)
        self.assertIsNone(
            benchmark._normalize_result(
                {"bpm": 128, "firstBeatMs": 125, "barBeatOffset": 3}
            )
        )


if __name__ == "__main__":
    unittest.main()
