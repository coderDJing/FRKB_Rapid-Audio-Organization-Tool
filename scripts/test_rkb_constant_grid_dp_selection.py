import unittest

from rkb_constant_grid_dp_selection import preserve_locked_phase_switch_downbeat_ordinal


class LockedPhaseDownbeatOrdinalTest(unittest.TestCase):
    def _candidate(
        self,
        *,
        bpm: float,
        first_beat_ms: float,
        bar_beat_offset: int,
    ) -> dict[str, object]:
        return {
            "bpm": bpm,
            "firstBeatMs": first_beat_ms,
            "barBeatOffset": bar_beat_offset,
            "score": 0.95,
            "source": "constant-grid-dp",
            "features": {"marker": 1},
        }

    def test_no_wrap_preserves_legacy_downbeat_ordinal(self) -> None:
        candidate = self._candidate(bpm=120.0, first_beat_ms=30.0, bar_beat_offset=2)
        legacy = self._candidate(bpm=120.0, first_beat_ms=20.0, bar_beat_offset=5)

        selected, meta = preserve_locked_phase_switch_downbeat_ordinal(
            candidate=candidate,
            legacy_candidate=legacy,
        )

        self.assertFalse(meta["applied"])
        self.assertEqual("no-phase-wrap", meta["reason"])
        self.assertEqual(0, meta["phaseWrapBeats"])
        self.assertIs(candidate, selected)
        self.assertEqual(2, selected["barBeatOffset"])

    def test_tail_wrap_subtracts_one_beat_from_legacy_bar(self) -> None:
        candidate = self._candidate(bpm=120.0, first_beat_ms=490.0, bar_beat_offset=0)
        legacy = self._candidate(bpm=120.0, first_beat_ms=20.0, bar_beat_offset=0)

        selected, meta = preserve_locked_phase_switch_downbeat_ordinal(
            candidate=candidate,
            legacy_candidate=legacy,
        )

        self.assertEqual(1, meta["phaseWrapBeats"])
        self.assertEqual(31, selected["barBeatOffset"])
        self.assertEqual(
            legacy["barBeatOffset"] % 32,
            (selected["barBeatOffset"] + meta["phaseWrapBeats"]) % 32,
        )

    def test_reverse_wrap_adds_one_beat_to_legacy_bar(self) -> None:
        candidate = self._candidate(bpm=120.0, first_beat_ms=10.0, bar_beat_offset=3)
        legacy = self._candidate(bpm=120.0, first_beat_ms=490.0, bar_beat_offset=31)

        selected, meta = preserve_locked_phase_switch_downbeat_ordinal(
            candidate=candidate,
            legacy_candidate=legacy,
        )

        self.assertEqual(-1, meta["phaseWrapBeats"])
        self.assertEqual(0, selected["barBeatOffset"])
        self.assertEqual(
            legacy["barBeatOffset"] % 32,
            (selected["barBeatOffset"] + meta["phaseWrapBeats"]) % 32,
        )

    def test_bpm_change_is_not_adjusted(self) -> None:
        candidate = self._candidate(bpm=120.1, first_beat_ms=490.0, bar_beat_offset=2)
        legacy = self._candidate(bpm=120.0, first_beat_ms=20.0, bar_beat_offset=0)

        selected, meta = preserve_locked_phase_switch_downbeat_ordinal(
            candidate=candidate,
            legacy_candidate=legacy,
        )

        self.assertFalse(meta["applied"])
        self.assertEqual("bpm-delta-too-large", meta["reason"])
        self.assertIs(candidate, selected)
        self.assertEqual(2, selected["barBeatOffset"])

    def test_large_circular_phase_change_is_not_adjusted(self) -> None:
        candidate = self._candidate(bpm=120.0, first_beat_ms=400.0, bar_beat_offset=2)
        legacy = self._candidate(bpm=120.0, first_beat_ms=20.0, bar_beat_offset=0)

        selected, meta = preserve_locked_phase_switch_downbeat_ordinal(
            candidate=candidate,
            legacy_candidate=legacy,
        )

        self.assertFalse(meta["applied"])
        self.assertEqual("phase-delta-too-large", meta["reason"])
        self.assertEqual(1, meta["phaseWrapBeats"])
        self.assertIs(candidate, selected)

    def test_adjustment_only_changes_bar_and_diagnostics(self) -> None:
        candidate = self._candidate(bpm=155.0, first_beat_ms=381.943, bar_beat_offset=1)
        legacy = self._candidate(bpm=155.0, first_beat_ms=20.0, bar_beat_offset=0)
        original = dict(candidate)

        selected, meta = preserve_locked_phase_switch_downbeat_ordinal(
            candidate=candidate,
            legacy_candidate=legacy,
        )

        self.assertTrue(meta["applied"])
        for key in ("bpm", "firstBeatMs", "score", "source"):
            self.assertEqual(original[key], selected[key])
        self.assertEqual({"marker": 1}, candidate["features"])
        self.assertTrue(
            selected["features"]["constantGridDpLockedPhaseDownbeatOrdinalPreserved"]
        )

    def test_missing_legacy_is_not_adjusted(self) -> None:
        candidate = self._candidate(bpm=120.0, first_beat_ms=490.0, bar_beat_offset=2)

        selected, meta = preserve_locked_phase_switch_downbeat_ordinal(
            candidate=candidate,
            legacy_candidate=None,
        )

        self.assertFalse(meta["applied"])
        self.assertEqual("no-legacy-candidate", meta["reason"])
        self.assertIs(candidate, selected)


if __name__ == "__main__":
    unittest.main()
