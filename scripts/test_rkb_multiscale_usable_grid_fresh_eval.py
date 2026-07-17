import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from rkb_multiscale_usable_grid_fresh_eval import _summary, _truth_catalog


def _track(
    *,
    baseline_pass: bool,
    selected_pass: bool,
    baseline_downbeat: bool = False,
    selected_downbeat: bool = False,
    switched: bool = True,
    normalized_bpm_pass: bool = True,
) -> dict:
    return {
        "baseline": {
            "usablePass": baseline_pass,
            "usableCategory": "pass" if baseline_pass else "first-beat-phase",
            "downbeatFailure": baseline_downbeat,
        },
        "selected": {
            "usablePass": selected_pass,
            "usableCategory": "pass" if selected_pass else "first-beat-phase",
            "downbeatFailure": selected_downbeat,
            "normalizedBpmPass": normalized_bpm_pass,
        },
        "selection": {"switched": switched},
        "candidateOracleUsablePass": True,
    }


class FreshUsableGridEvaluationTests(unittest.TestCase):
    def test_sealed_truth_catalog_does_not_require_registry_identity_fields(self) -> None:
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "truth.json"
            path.write_text(
                json.dumps(
                    {
                        "tracks": [
                            {
                                "fileName": "fresh.wav",
                                "bpm": 128.0,
                                "firstBeatMs": 10.0,
                                "barBeatOffset": 0,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            catalog = _truth_catalog(path, "fresh-batch")
        self.assertEqual(catalog["fresh.wav"]["batchId"], "fresh-batch")

    def test_summary_exposes_relative_and_raw_downbeat_metrics(self) -> None:
        summary = _summary(
            [
                _track(baseline_pass=False, selected_pass=True),
                _track(
                    baseline_pass=True,
                    selected_pass=True,
                    baseline_downbeat=False,
                    selected_downbeat=True,
                ),
                _track(
                    baseline_pass=True,
                    selected_pass=True,
                    baseline_downbeat=True,
                    selected_downbeat=False,
                ),
            ],
            [],
        )
        self.assertEqual(summary["usableGridNetPassCount"], 1)
        self.assertEqual(summary["newDownbeatFailureCount"], 1)
        self.assertEqual(summary["fixedDownbeatFailureCount"], 1)
        self.assertEqual(summary["downbeatFailureCountIncrease"], 0)

    def test_non_octave_failure_counts_only_switched_candidate(self) -> None:
        summary = _summary(
            [
                _track(
                    baseline_pass=True,
                    selected_pass=False,
                    switched=True,
                    normalized_bpm_pass=False,
                ),
                _track(
                    baseline_pass=False,
                    selected_pass=False,
                    switched=False,
                    normalized_bpm_pass=False,
                ),
            ],
            [],
        )
        self.assertEqual(summary["nonOctaveTempoFailureCount"], 1)


if __name__ == "__main__":
    unittest.main()
