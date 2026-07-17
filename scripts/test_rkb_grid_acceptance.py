import unittest

from rkb_grid_acceptance import assess_usable_grid


def _truth() -> dict:
    return {
        "bpm": 128.0,
        "firstBeatMs": 100.0,
        "downbeatBeatOffset": 0,
    }


class GridAcceptanceTests(unittest.TestCase):
    def test_exact_grid_remains_strict_and_usable_pass(self) -> None:
        result = assess_usable_grid(
            result_bpm=128.0,
            result_first_beat_timeline_ms=100.0,
            result_downbeat_beat_offset=0,
            truth=_truth(),
        )
        self.assertEqual(result["strictCategory"], "pass")
        self.assertTrue(result["usablePass"])
        self.assertEqual(result["tempoRelation"], "same-bpm")

    def test_half_bpm_with_aligned_lines_is_usable(self) -> None:
        result = assess_usable_grid(
            result_bpm=64.0,
            result_first_beat_timeline_ms=100.0,
            result_downbeat_beat_offset=0,
            truth=_truth(),
        )
        self.assertEqual(result["strictCategory"], "half-or-double-bpm")
        self.assertEqual(result["tempoRelation"], "half-bpm")
        self.assertTrue(result["octaveEquivalentLinesPass"])
        self.assertTrue(result["usablePass"])

    def test_double_bpm_with_aligned_lines_is_usable(self) -> None:
        result = assess_usable_grid(
            result_bpm=256.0,
            result_first_beat_timeline_ms=100.0,
            result_downbeat_beat_offset=0,
            truth=_truth(),
        )
        self.assertEqual(result["tempoRelation"], "double-bpm")
        self.assertTrue(result["usablePass"])

    def test_octave_bpm_with_bad_phase_is_not_usable(self) -> None:
        result = assess_usable_grid(
            result_bpm=64.0,
            result_first_beat_timeline_ms=110.0,
            result_downbeat_beat_offset=0,
            truth=_truth(),
        )
        self.assertFalse(result["octaveEquivalentLinesPass"])
        self.assertFalse(result["usablePass"])

    def test_triple_bpm_is_not_octave_equivalent(self) -> None:
        result = assess_usable_grid(
            result_bpm=384.0,
            result_first_beat_timeline_ms=100.0,
            result_downbeat_beat_offset=0,
            truth=_truth(),
        )
        self.assertFalse(result["octaveEquivalentLinesPass"])
        self.assertFalse(result["usablePass"])

    def test_exact_downbeat_failure_stays_failed(self) -> None:
        result = assess_usable_grid(
            result_bpm=128.0,
            result_first_beat_timeline_ms=100.0,
            result_downbeat_beat_offset=1,
            truth=_truth(),
        )
        self.assertEqual(result["strictCategory"], "downbeat")
        self.assertFalse(result["usablePass"])

    def test_historical_bar_beat_offset_is_normalized(self) -> None:
        truth = _truth()
        truth.pop("downbeatBeatOffset")
        truth["barBeatOffset"] = 2
        result = assess_usable_grid(
            result_bpm=128.0,
            result_first_beat_timeline_ms=100.0,
            result_downbeat_beat_offset=2,
            truth=truth,
        )
        self.assertEqual(result["strictCategory"], "pass")
        self.assertTrue(result["usablePass"])


if __name__ == "__main__":
    unittest.main()
