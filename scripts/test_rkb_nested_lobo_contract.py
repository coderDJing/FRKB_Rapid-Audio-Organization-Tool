import copy
import json
import unittest
from pathlib import Path
from typing import Any

from rkb_nested_lobo_contract import (
    MAX_CANDIDATE_COUNT,
    NestedLoboError,
    build_fold_plan,
    normalize_candidate_manifest,
    primary_aggregate,
    primary_estimate_eligible,
    select_candidate,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
CANDIDATE_FIXTURE = REPO_ROOT / "drafts" / "rkb-nested-lobo-candidates.example.json"
PRIMARY_BATCHES = ["blind608", "current1407", "old377", "test316", "test327", "test353"]


def _candidate_manifest() -> dict[str, Any]:
    return json.loads(CANDIDATE_FIXTURE.read_text(encoding="utf-8"))


def _fold_plan_fixture_with_case_only_inner_leak() -> dict[str, Any]:
    instances: list[dict[str, Any]] = []
    ids_by_batch: dict[str, list[str]] = {}
    for batch_id in PRIMARY_BATCHES:
        ids_by_batch[batch_id] = []
        for index in range(2):
            instance_id = f"{batch_id}:{index}"
            family = f"family-{batch_id}-{index}"
            if batch_id == "current1407":
                family = "Inner-Leak-Family" if index == 0 else "inner-leak-family"
            instances.append(
                {
                    "instanceId": instance_id,
                    "batchId": batch_id,
                    "fileName": f"{instance_id}.wav",
                    "assetSha256": f"asset-{instance_id}",
                    "pcmSha256": f"pcm-{instance_id}",
                    "familyId": f"family-id-{instance_id}",
                    "isolationFamilyId": family,
                    "assignmentKey": f"assignment-{instance_id}",
                    "sourcePath": f"C:/audio/{instance_id}.wav",
                }
            )
            ids_by_batch[batch_id].append(instance_id)
    ids_by_batch["new357"] = ["new357:0"]
    instances.append(
        {
            "instanceId": "new357:0",
            "batchId": "new357",
            "fileName": "new357.wav",
            "assetSha256": "asset-new357",
            "pcmSha256": "pcm-new357",
            "familyId": "family-new357",
            "isolationFamilyId": "isolation-new357",
            "assignmentKey": "assignment-new357",
            "sourcePath": "C:/audio/new357.wav",
        }
    )
    folds: list[dict[str, Any]] = []
    all_primary_ids = [item for batch in PRIMARY_BATCHES for item in ids_by_batch[batch]]
    for batch_id in [*PRIMARY_BATCHES, "new357"]:
        holdout = ids_by_batch[batch_id]
        if batch_id == "new357":
            train: list[str] = []
            tune = list(all_primary_ids)
            role = "diagnostic-development-reference"
            primary = False
        elif batch_id == "blind608":
            train = [ids_by_batch["current1407"][1], "new357:0"]
            tune = [
                item
                for item in all_primary_ids
                if item not in holdout and item != ids_by_batch["current1407"][1]
            ]
            role = "consumed-lobo-development-estimate"
            primary = True
        else:
            train = ["new357:0"]
            tune = [item for item in all_primary_ids if item not in holdout]
            role = "consumed-lobo-development-estimate"
            primary = True
        folds.append(
            {
                "batchId": batch_id,
                "developmentTrain": train,
                "developmentTune": tune,
                "development": [*train, *tune],
                "holdout": holdout,
                "excludedDevelopmentIsolationFamilyLeakage": [],
                "identityKey": "instanceId",
                "groupKey": "isolationFamilyId",
                "freshProofEligible": False,
                "evaluationRole": role,
                "primaryAggregateEligible": primary,
            }
        )
    return {
        "type": "rkb-rekordbox-dataset-splits",
        "version": 4,
        "identityKey": "instanceId",
        "groupKey": "isolationFamilyId",
        "assignmentDigestSha256": "assignment",
        "splitAssignmentsSha256": "split",
        "audioIsolationPolicySha256": "isolation",
        "registrySha256": "registry",
        "truthSourcesSha256": "truth",
        "instances": instances,
        "batchEvidencePolicies": {
            **{batch_id: {"primaryEvaluationEligible": True} for batch_id in PRIMARY_BATCHES},
            "new357": {"primaryEvaluationEligible": False},
        },
        "leaveOneBatchOut": folds,
    }


def _aggregate_metrics() -> dict[str, Any]:
    return {
        "trackCount": 10,
        "baselinePassCount": 5,
        "selectedPassCount": 5,
        "baselineStrictAccuracy": 0.5,
        "selectedStrictAccuracy": 0.5,
        "netPassDelta": 0,
        "netStrictAccuracyDeltaRate": 0.0,
        "failToPassCount": 0,
        "passToFailCount": 0,
        "passToFailRate": 0.0,
        "switchCount": 0,
        "switchRate": 0.0,
        "errorTrackCount": 0,
        "baselineErrorTrackCount": 0,
        "selectedErrorTrackCount": 0,
        "errorRate": 0.0,
        "baselineBpmBigErrorCount": 0,
        "selectedBpmBigErrorCount": 0,
        "bpmBigErrorRateIncrease": 0.0,
        "baselineDownbeatFailureCount": 0,
        "selectedDownbeatFailureCount": 0,
        "downbeatFailureRateIncrease": 0.0,
        "categoryMigration": {"pass->pass": 10},
    }


class RkbNestedLoboContractTest(unittest.TestCase):
    def test_execution_config_cannot_be_duplicated_by_relabeling_no_op(self) -> None:
        payload = _candidate_manifest()
        duplicate = copy.deepcopy(payload["candidates"][0])
        duplicate.update({"candidateId": "same-default-different-label", "isNoOp": False})
        payload["candidates"].append(duplicate)

        with self.assertRaisesRegex(NestedLoboError, "execution config is duplicated"):
            normalize_candidate_manifest(payload)

    def test_candidate_count_is_bounded_before_evaluation(self) -> None:
        payload = _candidate_manifest()
        payload["candidates"] = [copy.deepcopy(payload["candidates"][0])] * (
            MAX_CANDIDATE_COUNT + 1
        )

        with self.assertRaisesRegex(NestedLoboError, "safety limit"):
            normalize_candidate_manifest(payload)

    def test_inner_isolation_family_comparison_is_case_insensitive(self) -> None:
        with self.assertRaisesRegex(NestedLoboError, "inner tune isolation family"):
            build_fold_plan(_fold_plan_fixture_with_case_only_inner_leak())

    def test_selector_rejects_diagnostic_batch_even_with_valid_metrics_shape(self) -> None:
        with self.assertRaisesRegex(NestedLoboError, "primary inner batch allowlist"):
            select_candidate(
                [{"byBatch": {"new357": {}}, "configSha256": "a"}],
                _candidate_manifest()["selectionPolicy"],
                primary_batch_ids=["old377"],
            )

    def test_aggregate_maximum_ties_are_input_order_independent(self) -> None:
        rows = [
            {
                "batchId": batch_id,
                "metrics": _aggregate_metrics(),
                "resultBodySha256": f"digest-{batch_id}",
            }
            for batch_id in PRIMARY_BATCHES
        ]
        policy = _candidate_manifest()["aggregatePolicy"]

        forward = primary_aggregate(
            rows,
            primary_batch_ids=PRIMARY_BATCHES,
            aggregate_policy=policy,
        )
        reverse = primary_aggregate(
            list(reversed(rows)),
            primary_batch_ids=PRIMARY_BATCHES,
            aggregate_policy=policy,
        )

        self.assertEqual(forward, reverse)
        for metric in forward["maximumRegressions"].values():
            self.assertEqual(metric["batchId"], "test353")

    def test_primary_eligibility_requires_the_aggregate_gate_to_pass(self) -> None:
        self.assertFalse(
            primary_estimate_eligible("primary-consumed-nested-estimate", {"passed": False})
        )
        self.assertTrue(
            primary_estimate_eligible("primary-consumed-nested-estimate", {"passed": True})
        )
        self.assertFalse(
            primary_estimate_eligible("post-outer-development-diagnostic", {"passed": True})
        )


if __name__ == "__main__":
    unittest.main()
