import unittest

import run_rkb_post_outer_diagnostic as diagnostic
from rkb_nested_lobo_contract import NestedLoboError


class RunRkbPostOuterDiagnosticTest(unittest.TestCase):
    def test_parser_uses_a_distinct_post_outer_study_id(self) -> None:
        args = diagnostic._build_parser().parse_args(
            [
                "--candidates",
                "drafts/rkb-nested-lobo-candidates.example.json",
                "--feature-cache-dir",
                "cache/new357",
            ]
        )

        self.assertEqual(args.parent_study_id, diagnostic.DEFAULT_PARENT_STUDY_ID)
        self.assertNotEqual(args.study_id, args.parent_study_id)

    def test_diagnostic_fold_rejects_anything_except_new357(self) -> None:
        with self.assertRaisesRegex(NestedLoboError, "new357"):
            diagnostic._diagnostic_fold(
                {
                    "foldPlan": {
                        "diagnosticFolds": [
                            {
                                "batchId": "test353",
                            }
                        ]
                    }
                }
            )


if __name__ == "__main__":
    unittest.main()
