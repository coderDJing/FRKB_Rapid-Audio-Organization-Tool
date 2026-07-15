import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "replay_consumed_grid_v2_metrics.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("consumed_v2_replay", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


replay = _load_module()


class ReplayConsumedGridV2MetricsTest(unittest.TestCase):
    def _truth(self, offset: int = 3) -> dict:
        return {
            "tracks": [
                {
                    "fileName": "example.wav",
                    "beatGridMap": {
                        "version": 2,
                        "source": "manual",
                        "signature": "sbgm_test",
                        "clips": [
                            {
                                "startSec": 0,
                                "anchorSec": 0,
                                "bpm": 120,
                                "downbeatBeatOffset": offset,
                            }
                        ],
                    },
                }
            ]
        }

    def _benchmark(self, legacy_match: bool = True) -> dict:
        return {
            "tracks": [
                {
                    "fileName": "example.wav",
                    "analysis": {"barBeatOffset": 31},
                    "currentTimeline": {
                        "firstBeatShiftBeats": 0,
                        "barBeatOffsetMatchedMod4": legacy_match,
                        "category": "pass" if legacy_match else "downbeat",
                        "bpmDriftStatus": "pass",
                        "firstBeatPhaseStatus": "pass",
                        "gridMaxStatus": "pass",
                    },
                }
            ]
        }

    def test_replays_the_same_mod4_downbeat_outcome_from_v2_truth(self):
        result = replay.replay(self._benchmark(), self._truth())

        self.assertEqual(0, result["downbeatMismatchCount"])
        self.assertEqual(0, result["categoryMismatchCount"])
        self.assertTrue(result["tracks"][0]["v2DownbeatBeatOffsetMatches"])
        self.assertEqual("pass", result["tracks"][0]["v2Category"])

    def test_fails_closed_when_the_frozen_mod4_outcome_changes(self):
        result = replay.replay(self._benchmark(legacy_match=False), self._truth())

        self.assertEqual(1, result["downbeatMismatchCount"])
        self.assertEqual(1, result["categoryMismatchCount"])


if __name__ == "__main__":
    unittest.main()
