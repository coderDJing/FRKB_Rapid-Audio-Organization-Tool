import copy
import json
import tempfile
import unittest
from pathlib import Path

from rkb_dataset_contract import normalize_path, sha256_json
from rkb_nested_lobo_contract import PRIMARY_EVIDENCE_ROLE, NestedLoboError
from rkb_nested_lobo_ledger import append_exposure_event, guard_ledger, load_ledger


def _universe(
    *,
    instance: str,
    asset: str,
    family: str,
    pcm: str | None = None,
    canonical_family: str | None = None,
) -> dict[str, list[str]]:
    return {
        "instanceIds": [instance],
        "assetSha256s": [asset],
        "pcmSha256s": [pcm or f"pcm-{instance}"],
        "familyIds": [canonical_family or f"family-{instance}"],
        "isolationFamilyIds": [family],
    }


def _study_lock(
    ledger_path: Path,
    ledger: dict[str, object],
    *,
    lock_hash: str,
    dataset: str,
    universe: dict[str, list[str]],
) -> dict[str, object]:
    return {
        "lockHash": lock_hash,
        "locked": {
            "datasetContractSha256": dataset,
            "studyId": lock_hash,
            "evidenceRole": PRIMARY_EVIDENCE_ROLE,
            "runIdentitySha256": f"run-{lock_hash}",
            "workDir": normalize_path(ledger_path.parent / lock_hash),
            "ledgerPath": normalize_path(ledger_path),
            "ledgerId": ledger["ledgerId"],
            "ledgerGenesisSha256": ledger["genesisSha256"],
            "primaryEvidenceUniverse": universe,
            "primaryEvidenceUniverseSha256": sha256_json(universe),
        },
    }


def _selection_index(label: str) -> dict[str, str]:
    return {"selectionPlanSha256": f"selection-{label}"}


class RkbNestedLoboLedgerTest(unittest.TestCase):
    def test_hash_chain_rejects_event_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ledger.json"
            ledger = load_ledger(path, create=True)
            study = _study_lock(
                path,
                ledger,
                lock_hash="study-a",
                dataset="dataset-a",
                universe=_universe(instance="i-a", asset="a-a", family="f-a"),
            )
            append_exposure_event(
                ledger_path=path,
                ledger=ledger,
                study_lock=study,
                selection_index=_selection_index("a"),
                fold_batch_id="*",
                event="selections-locked",
            )
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["events"][0]["selectionPlanSha256"] = "tampered"
            path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(NestedLoboError, "hash chain"):
                load_ledger(path)

    def test_stale_writer_cannot_overwrite_a_concurrent_append(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ledger.json"
            first = load_ledger(path, create=True)
            stale = copy.deepcopy(first)
            study = _study_lock(
                path,
                first,
                lock_hash="study-a",
                dataset="dataset-a",
                universe=_universe(instance="i-a", asset="a-a", family="f-a"),
            )
            append_exposure_event(
                ledger_path=path,
                ledger=first,
                study_lock=study,
                selection_index=_selection_index("a"),
                fold_batch_id="*",
                event="selections-locked",
            )

            with self.assertRaisesRegex(NestedLoboError, "changed concurrently"):
                append_exposure_event(
                    ledger_path=path,
                    ledger=stale,
                    study_lock=study,
                    selection_index=_selection_index("a"),
                    fold_batch_id="blind608",
                    event="outer-exposed",
                )

    def test_path_independent_family_overlap_blocks_second_primary_claim(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ledger.json"
            ledger = load_ledger(path, create=True)
            first = _study_lock(
                path,
                ledger,
                lock_hash="study-a",
                dataset="dataset-a",
                universe=_universe(instance="i-a", asset="a-a", family="shared-family"),
            )
            first_index = _selection_index("a")
            append_exposure_event(
                ledger_path=path,
                ledger=ledger,
                study_lock=first,
                selection_index=first_index,
                fold_batch_id="*",
                event="selections-locked",
            )
            append_exposure_event(
                ledger_path=path,
                ledger=ledger,
                study_lock=first,
                selection_index=first_index,
                fold_batch_id="blind608",
                event="outer-exposed",
            )
            second = _study_lock(
                path,
                ledger,
                lock_hash="study-b",
                dataset="rebuilt-dataset-b",
                universe=_universe(instance="i-b", asset="a-b", family="SHARED-FAMILY"),
            )
            second_index = _selection_index("b")
            append_exposure_event(
                ledger_path=path,
                ledger=ledger,
                study_lock=second,
                selection_index=second_index,
                fold_batch_id="*",
                event="selections-locked",
            )

            with self.assertRaisesRegex(NestedLoboError, "evidence universe"):
                guard_ledger(
                    ledger=ledger,
                    dataset_contract_sha256="rebuilt-dataset-b",
                    study_lock=second,
                    selection_plan_sha256=second_index["selectionPlanSha256"],
                )

    def test_reencoded_asset_with_same_pcm_cannot_be_claimed_as_fresh(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ledger.json"
            ledger = load_ledger(path, create=True)
            first = _study_lock(
                path,
                ledger,
                lock_hash="study-a",
                dataset="dataset-a",
                universe=_universe(
                    instance="old-instance",
                    asset="old-container-sha",
                    pcm="shared-pcm",
                    family="old-isolation-family",
                ),
            )
            first_index = _selection_index("a")
            append_exposure_event(
                ledger_path=path,
                ledger=ledger,
                study_lock=first,
                selection_index=first_index,
                fold_batch_id="*",
                event="selections-locked",
            )
            append_exposure_event(
                ledger_path=path,
                ledger=ledger,
                study_lock=first,
                selection_index=first_index,
                fold_batch_id="blind608",
                event="outer-exposed",
            )
            second = _study_lock(
                path,
                ledger,
                lock_hash="study-b",
                dataset="rebuilt-dataset-b",
                universe=_universe(
                    instance="new-instance",
                    asset="new-container-sha",
                    pcm="SHARED-PCM",
                    family="new-isolation-family",
                ),
            )
            second_index = _selection_index("b")
            append_exposure_event(
                ledger_path=path,
                ledger=ledger,
                study_lock=second,
                selection_index=second_index,
                fold_batch_id="*",
                event="selections-locked",
            )

            with self.assertRaisesRegex(NestedLoboError, "evidence universe"):
                guard_ledger(
                    ledger=ledger,
                    dataset_contract_sha256="rebuilt-dataset-b",
                    study_lock=second,
                    selection_plan_sha256=second_index["selectionPlanSha256"],
                )

    def test_rehashed_selection_plan_cannot_replace_the_ledger_anchor(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ledger.json"
            ledger = load_ledger(path, create=True)
            study = _study_lock(
                path,
                ledger,
                lock_hash="study-a",
                dataset="dataset-a",
                universe=_universe(instance="i-a", asset="a-a", family="f-a"),
            )
            original_index = _selection_index("original")
            append_exposure_event(
                ledger_path=path,
                ledger=ledger,
                study_lock=study,
                selection_index=original_index,
                fold_batch_id="*",
                event="selections-locked",
            )

            with self.assertRaisesRegex(NestedLoboError, "immutable run identity"):
                guard_ledger(
                    ledger=ledger,
                    dataset_contract_sha256="dataset-a",
                    study_lock=study,
                    selection_plan_sha256="selection-hand-picked-after-tune",
                )


if __name__ == "__main__":
    unittest.main()
