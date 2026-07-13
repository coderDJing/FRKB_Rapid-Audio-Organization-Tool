import os
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rkb_dataset_contract import normalize_path, sha256_json
from rkb_nested_lobo_contract import (
    PRIMARY_EVIDENCE_ROLE,
    NestedLoboError,
    read_json_object,
    write_json_atomic,
    write_json_new,
)


LEDGER_SCHEMA_VERSION = 2
EXPOSURE_EVENTS = {"outer-exposed", "primary-complete"}
STUDY_EVENTS = {"selections-locked", *EXPOSURE_EVENTS}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@contextmanager
def _ledger_write_lock(path: Path):
    lock_path = path.with_name(f"{path.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise NestedLoboError(f"outer exposure ledger is busy: {lock_path}") from error
    try:
        os.write(descriptor, f"pid={os.getpid()}\n".encode("ascii"))
        yield
    finally:
        os.close(descriptor)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def load_ledger(path: Path, *, create: bool = False) -> dict[str, Any]:
    if not path.is_file():
        if not create:
            raise NestedLoboError(f"outer exposure ledger is missing: {path}")
        genesis = {
            "schemaVersion": LEDGER_SCHEMA_VERSION,
            "type": "rkb-nested-lobo-outer-exposure-ledger",
            "ledgerId": str(uuid.uuid4()),
            "createdAt": _utc_now(),
        }
        payload = {
            **genesis,
            "genesisSha256": sha256_json(genesis),
            "eventCount": 0,
            "headEventSha256": "",
            "events": [],
        }
        write_json_new(path, payload)
        return payload
    payload = read_json_object(path)
    if (
        payload.get("schemaVersion") != LEDGER_SCHEMA_VERSION
        or payload.get("type") != "rkb-nested-lobo-outer-exposure-ledger"
        or not isinstance(payload.get("events"), list)
    ):
        raise NestedLoboError("outer exposure ledger is invalid")
    genesis = {
        "schemaVersion": payload.get("schemaVersion"),
        "type": payload.get("type"),
        "ledgerId": payload.get("ledgerId"),
        "createdAt": payload.get("createdAt"),
    }
    if (
        not str(payload.get("ledgerId") or "").strip()
        or payload.get("genesisSha256") != sha256_json(genesis)
    ):
        raise NestedLoboError("outer exposure ledger genesis identity is invalid")
    previous_hash = ""
    for sequence, event in enumerate(payload["events"], start=1):
        if not isinstance(event, dict):
            raise NestedLoboError("outer exposure ledger contains a non-object event")
        stored_hash = str(event.get("eventSha256") or "")
        body = {key: value for key, value in event.items() if key != "eventSha256"}
        if (
            event.get("sequence") != sequence
            or event.get("previousEventSha256") != previous_hash
            or stored_hash != sha256_json(body)
        ):
            raise NestedLoboError(f"outer exposure ledger hash chain is invalid at event {sequence}")
        previous_hash = stored_hash
    if (
        payload.get("eventCount") != len(payload["events"])
        or payload.get("headEventSha256") != previous_hash
    ):
        raise NestedLoboError("outer exposure ledger head/count is inconsistent")
    return payload


def _discover_prior_outer_lock_hashes(
    *,
    benchmark_root: Path,
    dataset_contract_sha256: str,
    primary_evidence_universe: dict[str, Any],
    study_lock_name: str,
    state_name: str,
    primary_report_name: str,
) -> set[str]:
    exposed: set[str] = set()
    for lock_path in benchmark_root.rglob(study_lock_name):
        try:
            lock = read_json_object(lock_path)
        except NestedLoboError:
            continue
        locked = lock.get("locked") if isinstance(lock.get("locked"), dict) else {}
        same_dataset = locked.get("datasetContractSha256") == dataset_contract_sha256
        overlaps_universe = False
        prior_universe = locked.get("primaryEvidenceUniverse")
        if isinstance(prior_universe, dict):
            current_sets = _universe_sets(primary_evidence_universe)
            prior_sets = _universe_sets(prior_universe)
            overlaps_universe = any(
                current_sets[field] & prior_sets[field] for field in current_sets
            )
        if not same_dataset and not overlaps_universe:
            continue
        work_dir = Path(str(locked.get("workDir") or lock_path.parent)).resolve()
        state_path = work_dir / state_name
        state_status = ""
        if state_path.is_file():
            try:
                state_status = str(read_json_object(state_path).get("status") or "")
            except NestedLoboError:
                state_status = "invalid"
        has_outer_artifact = (
            (work_dir / primary_report_name).is_file()
            or state_status in {"outer_running", "primary_complete", "invalid"}
            or any(work_dir.glob("folds/*/outer-result.json"))
        )
        lock_hash = str(lock.get("lockHash") or "")
        if has_outer_artifact and lock_hash:
            exposed.add(lock_hash)
    return exposed


def load_or_initialize_ledger_for_select(
    path: Path,
    *,
    benchmark_root: Path,
    dataset_contract_sha256: str,
    primary_evidence_universe: dict[str, Any],
    study_lock_name: str,
    state_name: str,
    primary_report_name: str,
) -> dict[str, Any]:
    prior_lock_hashes = _discover_prior_outer_lock_hashes(
        benchmark_root=benchmark_root,
        dataset_contract_sha256=dataset_contract_sha256,
        primary_evidence_universe=primary_evidence_universe,
        study_lock_name=study_lock_name,
        state_name=state_name,
        primary_report_name=primary_report_name,
    )
    if path.is_file():
        ledger = load_ledger(path)
    else:
        if prior_lock_hashes:
            raise NestedLoboError(
                "outer exposure ledger is missing but prior outer artifacts exist; refusing a new genesis"
            )
        ledger = load_ledger(path, create=True)
    validate_ledger_covers_prior_artifacts(
        ledger,
        benchmark_root=benchmark_root,
        dataset_contract_sha256=dataset_contract_sha256,
        primary_evidence_universe=primary_evidence_universe,
        study_lock_name=study_lock_name,
        state_name=state_name,
        primary_report_name=primary_report_name,
    )
    return ledger


def validate_ledger_covers_prior_artifacts(
    ledger: dict[str, Any],
    *,
    benchmark_root: Path,
    dataset_contract_sha256: str,
    primary_evidence_universe: dict[str, Any],
    study_lock_name: str,
    state_name: str,
    primary_report_name: str,
) -> None:
    prior_lock_hashes = _discover_prior_outer_lock_hashes(
        benchmark_root=benchmark_root,
        dataset_contract_sha256=dataset_contract_sha256,
        primary_evidence_universe=primary_evidence_universe,
        study_lock_name=study_lock_name,
        state_name=state_name,
        primary_report_name=primary_report_name,
    )
    recorded_lock_hashes = {
        str(event.get("studyLockHash") or "")
        for event in ledger["events"]
        if isinstance(event, dict) and event.get("event") in EXPOSURE_EVENTS
    }
    if prior_lock_hashes - recorded_lock_hashes:
        raise NestedLoboError(
            "outer exposure ledger does not cover existing outer artifacts; possible ledger replacement"
        )


def _universe_sets(universe: Any) -> dict[str, set[str]]:
    if not isinstance(universe, dict):
        raise NestedLoboError("ledger evidence universe is missing")
    result: dict[str, set[str]] = {}
    for field in (
        "instanceIds",
        "assetSha256s",
        "pcmSha256s",
        "familyIds",
        "isolationFamilyIds",
    ):
        values = universe.get(field)
        if not isinstance(values, list) or any(not str(item or "").strip() for item in values):
            raise NestedLoboError(f"ledger evidence universe has invalid {field}")
        normalized = {str(item).casefold() for item in values}
        if len(normalized) != len(values):
            raise NestedLoboError(f"ledger evidence universe has duplicate {field}")
        result[field] = normalized
    return result


def guard_ledger(
    *,
    ledger: dict[str, Any],
    dataset_contract_sha256: str,
    study_lock: dict[str, Any],
    selection_plan_sha256: str,
) -> None:
    locked = study_lock["locked"]
    same_lock_events = [
        event
        for event in ledger["events"]
        if isinstance(event, dict)
        and event.get("studyLockHash") == study_lock["lockHash"]
        and event.get("event") in STUDY_EVENTS
    ]
    for event in same_lock_events:
        if (
            event.get("datasetContractSha256") != dataset_contract_sha256
            or event.get("studyId") != locked["studyId"]
            or event.get("runIdentitySha256") != locked["runIdentitySha256"]
            or event.get("workDir") != locked["workDir"]
            or event.get("ledgerPath") != locked["ledgerPath"]
            or event.get("ledgerId") != locked["ledgerId"]
            or event.get("ledgerGenesisSha256") != locked["ledgerGenesisSha256"]
            or event.get("selectionPlanSha256") != selection_plan_sha256
            or event.get("primaryEvidenceUniverseSha256")
            != locked["primaryEvidenceUniverseSha256"]
        ):
            raise NestedLoboError("outer exposure ledger event does not match the immutable run identity")
    selection_events = [
        event
        for event in same_lock_events
        if event.get("event") == "selections-locked"
    ]
    if len(selection_events) != 1:
        raise NestedLoboError("evaluate requires exactly one ledger-anchored selection plan")
    selection_event = selection_events[0]
    if (
        selection_event.get("primaryEvidenceUniverse") != locked["primaryEvidenceUniverse"]
        or sha256_json(selection_event["primaryEvidenceUniverse"])
        != locked["primaryEvidenceUniverseSha256"]
    ):
        raise NestedLoboError("ledger-anchored evidence universe differs from the study lock")
    if locked["evidenceRole"] != PRIMARY_EVIDENCE_ROLE:
        return
    current_universe = _universe_sets(locked["primaryEvidenceUniverse"])
    prior_exposure_locks = {
        str(event.get("studyLockHash") or "")
        for event in ledger["events"]
        if isinstance(event, dict)
        and event.get("event") in EXPOSURE_EVENTS
        and event.get("studyLockHash") != study_lock["lockHash"]
    }
    for prior_lock_hash in prior_exposure_locks:
        anchors = [
            event
            for event in ledger["events"]
            if isinstance(event, dict)
            and event.get("studyLockHash") == prior_lock_hash
            and event.get("event") == "selections-locked"
        ]
        if len(anchors) != 1:
            raise NestedLoboError("prior outer exposure has no unique selection/evidence anchor")
        prior_universe = _universe_sets(anchors[0].get("primaryEvidenceUniverse"))
        if any(current_universe[field] & prior_universe[field] for field in current_universe):
            raise NestedLoboError(
                "prior outer exposure overlaps this path-independent evidence universe; "
                "new work is diagnostic-only"
            )


def append_exposure_event(
    *,
    ledger_path: Path,
    ledger: dict[str, Any],
    study_lock: dict[str, Any],
    selection_index: dict[str, Any],
    fold_batch_id: str,
    event: str,
    event_details: dict[str, Any] | None = None,
) -> None:
    locked = study_lock["locked"]
    if normalize_path(ledger_path) != locked["ledgerPath"]:
        raise NestedLoboError("exposure ledger path does not match the immutable study lock")
    semantic = {
        "event": event,
        "datasetContractSha256": locked["datasetContractSha256"],
        "studyId": locked["studyId"],
        "studyLockHash": study_lock["lockHash"],
        "runIdentitySha256": locked["runIdentitySha256"],
        "workDir": locked["workDir"],
        "ledgerPath": locked["ledgerPath"],
        "ledgerId": locked["ledgerId"],
        "ledgerGenesisSha256": locked["ledgerGenesisSha256"],
        "selectionPlanSha256": selection_index["selectionPlanSha256"],
        "primaryEvidenceUniverseSha256": locked["primaryEvidenceUniverseSha256"],
        "foldBatchId": fold_batch_id,
    }
    if event == "selections-locked":
        semantic["primaryEvidenceUniverse"] = locked["primaryEvidenceUniverse"]
    if event_details is not None:
        semantic["details"] = event_details
    duplicates = [
        item
        for item in ledger["events"]
        if isinstance(item, dict)
        and item.get("studyLockHash") == study_lock["lockHash"]
        and item.get("foldBatchId") == fold_batch_id
        and item.get("event") == event
    ]
    if len(duplicates) > 1:
        raise NestedLoboError("outer exposure ledger contains duplicate semantic events")
    if duplicates:
        duplicate = duplicates[0]
        if any(duplicate.get(key) != value for key, value in semantic.items()):
            raise NestedLoboError("outer exposure ledger duplicate conflicts with immutable provenance")
        return
    expected_head = str(ledger.get("headEventSha256") or "")
    with _ledger_write_lock(ledger_path):
        current = load_ledger(ledger_path)
        if (
            current.get("ledgerId") != ledger.get("ledgerId")
            or current.get("genesisSha256") != ledger.get("genesisSha256")
            or current.get("headEventSha256") != expected_head
        ):
            raise NestedLoboError("outer exposure ledger changed concurrently; retry after reloading")
        body = {
            "sequence": len(current["events"]) + 1,
            "previousEventSha256": expected_head,
            "at": _utc_now(),
            **semantic,
        }
        event_row = {**body, "eventSha256": sha256_json(body)}
        current["events"].append(event_row)
        current["eventCount"] = len(current["events"])
        current["headEventSha256"] = event_row["eventSha256"]
        write_json_atomic(ledger_path, current)
        ledger.clear()
        ledger.update(current)
