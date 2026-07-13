import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import run_rkb_nested_lobo as runner
from rkb_nested_lobo_contract import NestedLoboError


REPO_ROOT = Path(__file__).resolve().parents[1]
CANDIDATES = REPO_ROOT / "drafts" / "rkb-nested-lobo-candidates.example.json"


class RunRkbNestedLoboTest(unittest.TestCase):
    def test_plan_never_loads_truth_sources(self) -> None:
        with patch.object(runner, "load_truth_catalog") as truth_loader:
            payload = runner.run(
                [
                    "plan",
                    "--study-id",
                    "plan-no-truth",
                    "--candidates",
                    str(CANDIDATES),
                ]
            )

        truth_loader.assert_not_called()
        self.assertFalse(payload["outerTruthRead"])
        self.assertEqual(len(payload["primaryFoldIds"]), 6)
        self.assertEqual(payload["diagnosticFoldIds"], ["new357"])

    def test_primary_commands_reject_noncanonical_ledger_before_io(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            custom_ledger = Path(temp_dir) / "replacement-ledger.json"
            with self.assertRaisesRegex(NestedLoboError, "canonical central exposure ledger"):
                runner.run(
                    [
                        "select",
                        "--study-id",
                        "custom-ledger",
                        "--candidates",
                        str(CANDIDATES),
                        "--feature-cache-dir",
                        temp_dir,
                        "--ledger",
                        str(custom_ledger),
                    ]
                )

    def test_diagnostic_command_is_registered(self) -> None:
        parser = runner._build_parser()
        args = parser.parse_args(
            [
                "diagnostic",
                "--study-id",
                "diagnostic-parser",
                "--candidates",
                str(CANDIDATES),
            ]
        )

        self.assertEqual(args.command, "diagnostic")

    def test_resume_after_report_write_only_finalizes_without_rereading_outer_truth(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            work_dir = Path(temp_dir)
            (work_dir / runner.PRIMARY_REPORT_NAME).write_text("{}\n", encoding="utf-8")
            (work_dir / runner.STATE_NAME).write_text(
                '{"studyId":"crash-finalize","studyLockHash":"study-lock",'
                '"status":"outer_running"}\n',
                encoding="utf-8",
            )
            args = Namespace(
                study_id="crash-finalize",
                work_dir=str(work_dir),
                ledger=str(work_dir / "ledger.json"),
                resume=True,
            )
            inputs = {
                "foldPlan": {"primaryFolds": []},
            }
            study_lock = {
                "lockHash": "study-lock",
                "locked": {
                    "datasetContractSha256": "dataset",
                    "primaryEvidenceUniverse": {},
                },
            }
            selection_index = {"selectionPlanSha256": "selection-plan"}
            report = {
                "primaryNestedEstimateEligible": False,
                "summary": {"resultBodySha256": "report-body"},
            }
            aggregate = {"aggregateSha256": "aggregate-body"}

            with (
                patch.object(runner, "_load_metadata_inputs", return_value=inputs),
                patch.object(runner, "load_ledger", return_value={"events": []}),
                patch.object(runner, "_ensure_feature_contract", return_value=({}, {})),
                patch.object(runner, "_ensure_study_lock", return_value=study_lock),
                patch.object(
                    runner,
                    "_load_selection_locks",
                    return_value=({}, selection_index),
                ),
                patch.object(runner, "validate_ledger_covers_prior_artifacts"),
                patch.object(runner, "guard_ledger"),
                patch.object(runner, "revalidate_selection_evidence"),
                patch.object(
                    runner,
                    "validate_existing_primary_report",
                    return_value=(report, aggregate),
                ),
                patch.object(runner, "append_exposure_event") as append_event,
                patch.object(runner, "load_truth_catalog") as truth_loader,
                patch.object(runner, "evaluate_fixed_configs") as evaluator,
            ):
                payload = runner.run_evaluate(args)

            truth_loader.assert_not_called()
            evaluator.assert_not_called()
            append_event.assert_called_once()
            self.assertEqual(append_event.call_args.kwargs["event"], "primary-complete")
            self.assertEqual(
                append_event.call_args.kwargs["event_details"],
                {
                    "primaryReportBodySha256": "report-body",
                    "aggregateSha256": "aggregate-body",
                },
            )
            self.assertTrue(payload["resumedFinalizationOnly"])


if __name__ == "__main__":
    unittest.main()
