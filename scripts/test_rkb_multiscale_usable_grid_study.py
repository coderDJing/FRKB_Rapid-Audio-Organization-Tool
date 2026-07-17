import unittest

from rkb_multiscale_usable_grid_study import _metrics, _usable_flags


def _truth() -> dict:
    return {
        "bpm": 128.0,
        "firstBeatMs": 100.0,
        "barBeatOffset": 0,
    }


def _raw(bpm: float, first_beat_ms: float = 100.0, downbeat: int = 0) -> dict:
    return {
        "bpm": bpm,
        "timelineFirstBeatMs": first_beat_ms,
        "downbeatBeatOffset": downbeat,
    }


def _row(baseline: dict, candidate: dict) -> dict:
    return {
        "batchId": "batch-a",
        "baseline": {**baseline, "isLegacySelected": True},
        "candidates": [
            {
                **candidate,
                "rank": 1,
                "rankerScore": 1.0,
                "barBeatOffsetSameMod4": True,
            }
        ],
    }


class UsableGridStudyTests(unittest.TestCase):
    def test_octave_aligned_candidate_is_positive_training_label(self) -> None:
        flags = _usable_flags(_raw(256.0), _truth())
        self.assertEqual(flags["category"], "pass")
        self.assertEqual(flags["usableCategory"], "octave-equivalent-pass")

    def test_triple_bpm_candidate_stays_negative(self) -> None:
        flags = _usable_flags(_raw(384.0), _truth())
        self.assertNotEqual(flags["category"], "pass")

    def test_metrics_ignore_exact_bpm_octave_mismatch_as_regression(self) -> None:
        baseline = _usable_flags(_raw(128.0), _truth())
        candidate = _usable_flags(_raw(256.0), _truth())
        metrics = _metrics([_row(baseline, candidate)], mode="ranked-top16", threshold=0.5)
        self.assertEqual(metrics["usablePassToFail"], 0)
        self.assertEqual(metrics["selectedUsablePass"], metrics["baselineUsablePass"])

    def test_downbeat_regression_remains_visible(self) -> None:
        baseline = _usable_flags(_raw(128.0), _truth())
        candidate = _usable_flags(_raw(128.0, downbeat=1), _truth())
        metrics = _metrics([_row(baseline, candidate)], mode="ranked-top16", threshold=0.5)
        self.assertEqual(metrics["usablePassToFail"], 1)
        self.assertEqual(metrics["selectedDownbeatFailure"], 1)


if __name__ == "__main__":
    unittest.main()
