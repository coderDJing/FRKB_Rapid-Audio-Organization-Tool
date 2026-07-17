import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from rkb_multiscale_ranker_study import (
    _fast_grid_profile,
    _fit_ridge,
    _metrics,
    _score_candidates,
)
from rkb_multiscale_study_inputs import iter_benchmark_tracks


def _row(instance: str, baseline_category: str, candidate_category: str, base_value: float) -> dict:
    return {
        "instanceId": instance,
        "batchId": "batch-a",
        "baseline": {
            "category": baseline_category,
            "bpmBigError": False,
            "downbeatFailure": False,
            "isLegacySelected": True,
        },
        "featureNames": {"base": ["x"], "multiscale": ["x", "ms"]},
        "candidates": [
            {
                "rank": 1,
                "category": candidate_category,
                "bpmBigError": False,
                "downbeatFailure": False,
                "barBeatOffsetSameMod4": True,
                "baseVector": [base_value],
                "multiscaleVector": [base_value, base_value],
            }
        ],
    }


class MultiscaleRankerStudyTests(unittest.TestCase):
    def test_fast_grid_profile_finds_positive_offset(self) -> None:
        values = np.zeros(1000, dtype="float64")
        for beat in range(10, 900, 50):
            values[beat + 2] = 1.0
        profile = _fast_grid_profile(
            values=values,
            frame_rate=100.0,
            candidate={"bpm": 120.0, "firstBeatMs": 100.0},
            duration_sec=9.0,
        )
        self.assertEqual(profile["medianOffsetMs"], 20.0)
        self.assertGreater(profile["meanBestScore"], profile["meanCenterScore"])

    def test_streams_only_top_level_tracks_array(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "benchmark.json"
            path.write_text(
                json.dumps(
                    {
                        "summary": {"tracks": ["not-the-target"]},
                        "tracks": [{"fileName": "a"}, {"fileName": "b"}],
                        "errors": [],
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            rows = list(iter_benchmark_tracks(path))
        self.assertEqual([row["fileName"] for row in rows], ["a", "b"])

    def test_ridge_scores_positive_examples_higher(self) -> None:
        rows = [
            _row("a", "first-beat-phase", "pass", 1.0),
            _row("b", "first-beat-phase", "pass", 0.8),
            _row("c", "first-beat-phase", "first-beat-phase", -0.8),
            _row("d", "first-beat-phase", "downbeat", -1.0),
        ]
        model = _fit_ridge(rows, "base", 0.1)
        _score_candidates(rows, model)
        scores = np.asarray([row["candidates"][0]["rankerScore"] for row in rows])
        self.assertGreater(float(np.mean(scores[:2])), float(np.mean(scores[2:])))

    def test_metrics_counts_rescue_and_regression(self) -> None:
        rows = [
            _row("a", "first-beat-phase", "pass", 1.0),
            _row("b", "pass", "downbeat", 1.0),
        ]
        for row in rows:
            row["candidates"][0]["rankerScore"] = 1.0
        metrics = _metrics(rows, mode="ranked-top16", threshold=0.5)
        self.assertEqual(metrics["failToPass"], 1)
        self.assertEqual(metrics["passToFail"], 1)
        self.assertEqual(metrics["selectedPass"], metrics["baselinePass"])


if __name__ == "__main__":
    unittest.main()
