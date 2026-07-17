import unittest
from collections import Counter

from rkb_multiscale_usable_grid_replay import _finalize_metrics, _record_metrics


def _assessment(*, strict: bool, usable: bool, bpm_failure: bool = False) -> dict:
    return {
        "sourceStrictPass": strict,
        "sourceStrictBpmDriftFailure": bpm_failure,
        "sourceDownbeatFailure": False,
        "usablePass": usable,
        "downbeatFailure": False,
    }


class UsableGridReplayTests(unittest.TestCase):
    def test_octave_only_strict_regression_is_not_usable_regression(self) -> None:
        counters = Counter()
        _record_metrics(
            counters,
            _assessment(strict=True, usable=True),
            _assessment(strict=False, usable=True, bpm_failure=True),
            switched=True,
        )
        metrics = _finalize_metrics(counters, Counter(), Counter())
        self.assertEqual(metrics["strictPassToFail"], 1)
        self.assertEqual(metrics["usablePassToFail"], 0)
        self.assertEqual(metrics["selectedUsablePass"], metrics["baselineUsablePass"])

    def test_real_phase_regression_remains_usable_regression(self) -> None:
        counters = Counter()
        _record_metrics(
            counters,
            _assessment(strict=True, usable=True),
            _assessment(strict=False, usable=False),
            switched=True,
        )
        metrics = _finalize_metrics(counters, Counter(), Counter())
        self.assertEqual(metrics["strictPassToFail"], 1)
        self.assertEqual(metrics["usablePassToFail"], 1)


if __name__ == "__main__":
    unittest.main()
