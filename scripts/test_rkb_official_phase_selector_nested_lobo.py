import unittest

import numpy as np

from rkb_official_phase_selector_nested_lobo import (
    FEATURE_NAMES,
    _fit_ridge,
    _metrics,
    _score_rows,
)


def _assessment(strict_pass: bool) -> dict[str, object]:
    return {
        "strictPass": strict_pass,
        "usablePass": strict_pass,
        "category": "pass" if strict_pass else "first-beat-phase",
        "downbeatFailure": False,
        "strictBpmDriftFailure": False,
    }


def _row(value: float, *, baseline_pass: bool, refined_pass: bool) -> dict[str, object]:
    vector = [0.0] * len(FEATURE_NAMES)
    vector[0] = value
    vector[1] = value
    return {
        "instanceId": f"test:{value}:{baseline_pass}:{refined_pass}",
        "batchId": "test",
        "featureNames": list(FEATURE_NAMES),
        "featureVector": vector,
        "baseline": _assessment(baseline_pass),
        "refined": _assessment(refined_pass),
    }


class OfficialPhaseNestedLoboTests(unittest.TestCase):
    def test_ridge_scores_rescues_above_regressions(self) -> None:
        rows = [
            _row(0.9, baseline_pass=False, refined_pass=True),
            _row(0.8, baseline_pass=False, refined_pass=True),
            _row(0.2, baseline_pass=True, refined_pass=False),
            _row(0.1, baseline_pass=True, refined_pass=False),
        ]
        model = _fit_ridge(rows, l2=0.1)
        scores = _score_rows(rows, model)
        self.assertGreater(float(np.mean(scores[:2])), float(np.mean(scores[2:])))
        self.assertEqual(model["trainPositiveCount"], 2)
        self.assertEqual(model["trainNegativeCount"], 2)

    def test_metrics_abstain_below_threshold(self) -> None:
        rows = [
            _row(0.9, baseline_pass=False, refined_pass=True),
            _row(0.1, baseline_pass=True, refined_pass=False),
            _row(0.5, baseline_pass=True, refined_pass=True),
        ]
        metrics = _metrics(rows, np.asarray([0.9, 0.1, 0.2]), threshold=0.5)
        self.assertEqual(metrics["failToPass"], 1)
        self.assertEqual(metrics["passToFail"], 0)
        self.assertEqual(metrics["selectedPass"] - metrics["baselinePass"], 1)


if __name__ == "__main__":
    unittest.main()
