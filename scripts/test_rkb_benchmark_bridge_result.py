import unittest

from rkb_benchmark_bridge_result import normalize_bridge_result


class RkbBenchmarkBridgeResultTest(unittest.TestCase):
    def test_public_result_exposes_downbeat_phase_not_legacy_hierarchy(self) -> None:
        normalized = normalize_bridge_result(
            {
                "bpm": 130,
                "firstBeatMs": 10,
                "barBeatOffset": 31,
                "gridSolverCandidates": [
                    {"source": "test", "bpm": 130, "firstBeatMs": 10, "barBeatOffset": 7}
                ],
            }
        )

        self.assertEqual(3, normalized["downbeatBeatOffset"])
        self.assertNotIn("barBeatOffset", normalized)
        self.assertEqual(3, normalized["gridSolverCandidates"][0]["downbeatBeatOffset"])
        self.assertNotIn("barBeatOffset", normalized["gridSolverCandidates"][0])


if __name__ == "__main__":
    unittest.main()
