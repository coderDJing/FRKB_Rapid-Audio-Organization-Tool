import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rkb_dataset_contract import sha256_json
from rkb_nested_lobo_contract import NestedLoboError, compact_outcome_metrics
from rkb_nested_lobo_evaluator import _error_analysis, _switched, build_feature_contract


def _success() -> dict[str, object]:
    return {
        "category": "pass",
        "bpm": 128.0,
        "firstBeatMs": 10.0,
        "barBeatOffset": 0,
        "bpmOnlyDrift128BeatsMs": 0.0,
        "firstBeatPhaseAbsErrorMs": 0.0,
        "gridMaxAbsMs": 0.0,
        "barBeatOffsetMatchedMod4": True,
        "bpmBigError": False,
        "downbeatFailure": False,
        "selectedSource": "baseline",
        "hadError": False,
        "error": None,
    }


class RkbNestedLoboEvaluatorTest(unittest.TestCase):
    def test_empty_exception_message_is_still_counted_as_error(self) -> None:
        error = _error_analysis(Exception(""))
        rows = [{"baseline": error, "selected": error, "switched": _switched(error, error)}]

        metrics = compact_outcome_metrics(rows)

        self.assertTrue(error["hadError"])
        self.assertTrue(str(error["error"]).startswith("Exception:"))
        self.assertEqual(metrics["errorTrackCount"], 1)
        self.assertEqual(metrics["baselineErrorTrackCount"], 1)
        self.assertEqual(metrics["selectedErrorTrackCount"], 1)
        self.assertFalse(rows[0]["switched"])

    def test_error_to_success_switch_does_not_cast_none_to_float(self) -> None:
        error = _error_analysis(RuntimeError("boom"))

        self.assertTrue(_switched(error, _success()))
        self.assertTrue(_switched(_success(), error))

    def test_primary_feature_contract_rejects_mixed_generation_policies(self) -> None:
        base_policy = {
            "featureCacheVersion": 2,
            "sampleRate": 44100,
            "channels": 2,
            "maxScanSec": 120.0,
            "device": "cpu",
            "checkpoint": {"sha": "checkpoint"},
            "beatThisInference": {"sha": "inference"},
            "beatThisPreprocessing": {"sha": "preprocessing"},
            "featureFunctions": {"analyzePreparedWindows": {"sourceSha256": "old"}},
        }
        newer_policy = json.loads(json.dumps(base_policy))
        newer_policy["featureFunctions"]["analyzePreparedWindows"]["sourceSha256"] = "new"

        def row(instance_id: str, policy: dict[str, object]) -> dict[str, object]:
            return {
                "instanceId": instance_id,
                "featureGenerationPolicySha256": sha256_json(policy),
                "featureProofSha256": "proof",
                "_featureGenerationPolicy": policy,
            }

        with tempfile.TemporaryDirectory() as temp_dir:
            cache_dir = Path(temp_dir) / "cache"
            cache_dir.mkdir()
            (cache_dir / "index.json").write_text('{"entries": []}\n', encoding="utf-8")
            with patch(
                "rkb_nested_lobo_evaluator._feature_contract_row",
                side_effect=[row("one", base_policy), row("two", newer_policy)],
            ):
                with self.assertRaisesRegex(NestedLoboError, "different policies"):
                    build_feature_contract(
                        cache_dirs=[cache_dir],
                        instance_ids=["one", "two"],
                        catalog={"one": {}, "two": {}},
                        output_path=Path(temp_dir) / "contract.json",
                        scope="test",
                    )


if __name__ == "__main__":
    unittest.main()
