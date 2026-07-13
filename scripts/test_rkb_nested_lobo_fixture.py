import json
import unittest
from pathlib import Path

from rkb_nested_lobo_contract import (
    CANDIDATE_TYPE,
    PARAMETER_DEFAULTS,
    SELECTION_OBJECTIVE_VERSION,
    normalize_candidate_manifest,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
CANDIDATE_FIXTURE = REPO_ROOT / 'drafts' / 'rkb-nested-lobo-candidates.example.json'


class RkbNestedLoboFixtureTest(unittest.TestCase):
    def test_candidate_fixture_is_accepted_by_contract(self) -> None:
        payload = json.loads(CANDIDATE_FIXTURE.read_text(encoding='utf-8'))

        normalized = normalize_candidate_manifest(payload)

        self.assertEqual(normalized['type'], CANDIDATE_TYPE)
        self.assertEqual(
            normalized['selectionPolicy']['objectiveVersion'],
            SELECTION_OBJECTIVE_VERSION,
        )
        self.assertEqual(len(normalized['candidates']), 2)
        no_op = [candidate for candidate in normalized['candidates'] if candidate['isNoOp']]
        non_no_op = [candidate for candidate in normalized['candidates'] if not candidate['isNoOp']]
        self.assertEqual(len(no_op), 1)
        self.assertEqual(no_op[0]['parameters'], PARAMETER_DEFAULTS)
        self.assertEqual(no_op[0]['complexityRank'], 0)
        self.assertEqual(len(non_no_op), 1)
        self.assertNotEqual(non_no_op[0]['parameters'], PARAMETER_DEFAULTS)
        self.assertEqual(len(normalized['manifestContractSha256']), 64)


if __name__ == '__main__':
    unittest.main()
