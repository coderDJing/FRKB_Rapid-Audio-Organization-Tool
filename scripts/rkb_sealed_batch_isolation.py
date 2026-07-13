from __future__ import annotations

import copy
from collections import Counter
from pathlib import Path
from typing import Any, Mapping

from rkb_audio_isolation_families import (
    ISOLATION_POLICY_SHA256,
    ISOLATION_POLICY_V1,
    build_audio_isolation_families,
)
from rkb_sealed_batch_common import (
    SealedBatchError,
    load_json,
    normalize_name,
    truth_tracks,
    write_json_atomic,
)


FRESH_BATCH_ID = "fresh-pending"
_IDENTITY_FIELDS = (
    "assetSha256",
    "pcmSha256",
    "fingerprint",
    "fingerprintSha256",
    "familyId",
)


def _required_identity(row: Mapping[str, Any], field: str, scope: str) -> str:
    value = str(row.get(field) or "").strip()
    if not value:
        raise SealedBatchError(f"audio isolation guard missing {field} for {scope}")
    return value


def _project_audio_row(
    row: Mapping[str, Any], *, batch_id: str, scope: str
) -> tuple[str, dict[str, str], dict[str, str]]:
    identity = {field: _required_identity(row, field, scope) for field in _IDENTITY_FIELDS}
    asset_sha256 = identity["assetSha256"].casefold()
    instance_id = f"{batch_id}:{asset_sha256}"
    projected = {
        "instanceId": instance_id,
        "batchId": batch_id,
        "familyId": identity["familyId"],
        "pcmSha256": identity["pcmSha256"],
        "fingerprint": identity["fingerprint"],
        "fingerprintSha256": identity["fingerprintSha256"],
    }
    stable_identity = {
        "assetSha256": asset_sha256,
        "pcmSha256": identity["pcmSha256"].casefold(),
        "fingerprintSha256": identity["fingerprintSha256"].casefold(),
    }
    return instance_id, projected, stable_identity


def _stable_identity_key(identity: Mapping[str, str]) -> tuple[str, str, str]:
    return (
        str(identity["assetSha256"]),
        str(identity["pcmSha256"]),
        str(identity["fingerprintSha256"]),
    )


def plan_fresh_audio_isolation_guard(
    *, registry: dict[str, Any], roster: list[dict[str, Any]], registry_sha256: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    if len(str(registry_sha256 or "")) != 64:
        raise SealedBatchError("audio isolation guard requires the frozen registry SHA-256")
    if not roster:
        raise SealedBatchError("audio isolation guard received an empty fresh roster")

    registry_rows = [item for item in registry.get("tracks") or [] if isinstance(item, dict)]
    if len(registry_rows) != int(registry.get("trackCount") or 0):
        raise SealedBatchError("audio isolation guard registry trackCount is inconsistent")
    non_consumed = [
        f"{item.get('batchId')}:{item.get('assetSha256')}"
        for item in registry_rows
        if str(item.get("batchStatus") or "") != "consumed"
    ]
    if non_consumed:
        raise SealedBatchError(
            "audio isolation guard accepts only consumed registry rows; "
            f"invalid={non_consumed[:8]}"
        )

    projected_rows: list[dict[str, str]] = []
    consumed_metadata: dict[str, dict[str, str]] = {}
    for row in registry_rows:
        batch_id = _required_identity(row, "batchId", "consumed registry row")
        instance_id, projected, identity = _project_audio_row(
            row,
            batch_id=batch_id,
            scope=f"consumed registry instance {batch_id}",
        )
        if instance_id in consumed_metadata:
            raise SealedBatchError(f"duplicate consumed audio instance identity: {instance_id}")
        consumed_metadata[instance_id] = {**identity, "batchId": batch_id}
        projected_rows.append(projected)

    fresh_rows: dict[str, dict[str, Any]] = {}
    fresh_identities: dict[str, dict[str, str]] = {}
    for row in roster:
        instance_id, projected, identity = _project_audio_row(
            row,
            batch_id=FRESH_BATCH_ID,
            scope="fresh roster instance",
        )
        if instance_id in fresh_rows:
            raise SealedBatchError(f"duplicate fresh audio instance identity: {instance_id}")
        fresh_rows[instance_id] = row
        fresh_identities[instance_id] = identity
        projected_rows.append(projected)

    try:
        isolation = build_audio_isolation_families(projected_rows)
    except Exception as error:
        raise SealedBatchError(f"audio isolation guard failed closed: {error}") from error
    if str(isolation.get("policySha256") or "") != ISOLATION_POLICY_SHA256:
        raise SealedBatchError("audio isolation guard policy hash changed during preparation")

    instance_families = isolation.get("instanceIsolationFamilyIds")
    if not isinstance(instance_families, dict):
        raise SealedBatchError("audio isolation guard returned no instance-family mapping")
    expected_instances = set(consumed_metadata) | set(fresh_rows)
    if set(instance_families) != expected_instances:
        raise SealedBatchError("audio isolation guard returned an incomplete instance-family mapping")

    consumed_by_family: dict[str, list[str]] = {}
    for instance_id in consumed_metadata:
        family_id = str(instance_families[instance_id])
        consumed_by_family.setdefault(family_id, []).append(instance_id)
    fresh_by_family: dict[str, list[str]] = {}
    for instance_id in fresh_rows:
        family_id = str(instance_families[instance_id])
        fresh_by_family.setdefault(family_id, []).append(instance_id)

    exclusions: dict[str, tuple[str, list[str]]] = {}
    for family_id, instance_ids in fresh_by_family.items():
        consumed_matches = sorted(consumed_by_family.get(family_id, []))
        if consumed_matches:
            for instance_id in instance_ids:
                exclusions[instance_id] = ("duplicate-isolation-family", consumed_matches)
            continue
        if len(instance_ids) <= 1:
            continue
        representative = min(
            instance_ids, key=lambda item: _stable_identity_key(fresh_identities[item])
        )
        for instance_id in instance_ids:
            if instance_id != representative:
                exclusions[instance_id] = (
                    "duplicate-current-batch-isolation-family",
                    [representative],
                )

    kept = [
        row
        for row in roster
        if f"{FRESH_BATCH_ID}:{str(row.get('assetSha256') or '').strip().casefold()}"
        not in exclusions
    ]
    excluded: list[dict[str, Any]] = []
    fresh_instances: dict[str, dict[str, Any]] = {}
    reason_counts: Counter[str] = Counter()
    for instance_id in sorted(fresh_rows):
        row = fresh_rows[instance_id]
        family_id = str(instance_families[instance_id])
        reason, matched_ids = exclusions.get(instance_id, ("", []))
        if reason:
            reason_counts[reason] += 1
            matches = []
            for matched_id in matched_ids:
                metadata = consumed_metadata.get(matched_id) or fresh_identities[matched_id]
                matches.append(
                    {
                        "instanceId": matched_id,
                        "batchId": str(metadata.get("batchId") or FRESH_BATCH_ID),
                        "assetSha256": str(metadata["assetSha256"]),
                    }
                )
            excluded.append(
                {
                    **row,
                    "reason": reason,
                    "isolationInstanceId": instance_id,
                    "isolationFamilyId": family_id,
                    "matches": matches,
                }
            )
        fresh_instances[instance_id] = {
            **fresh_identities[instance_id],
            "isolationFamilyId": family_id,
            "disposition": "excluded" if reason else "kept",
            "reason": reason,
            "matchedInstanceIds": matched_ids,
        }

    fresh_ids = set(fresh_rows)
    touching_links = [
        link
        for link in isolation.get("acceptedLinks") or []
        if isinstance(link, dict)
        and (
            str(link.get("leftInstanceId") or "") in fresh_ids
            or str(link.get("rightInstanceId") or "") in fresh_ids
        )
    ]
    audit = {
        "policy": copy.deepcopy(ISOLATION_POLICY_V1),
        "policySha256": ISOLATION_POLICY_SHA256,
        "registrySha256": registry_sha256,
        "stats": {
            "consumedInputCount": len(consumed_metadata),
            "freshInputCount": len(fresh_rows),
            "freshKeptCount": len(kept),
            "freshExcludedCount": len(excluded),
            "excludedByReason": dict(sorted(reason_counts.items())),
            "combinedIsolation": copy.deepcopy(isolation.get("stats") or {}),
        },
        "freshInstances": fresh_instances,
        "acceptedLinksTouchingFresh": touching_links,
    }
    return kept, excluded, audit


def apply_fresh_audio_isolation_guard(
    *,
    truth_path: Path,
    audio_root: Path,
    roster: list[dict[str, Any]],
    registry: dict[str, Any],
    registry_sha256: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    kept, excluded, audit = plan_fresh_audio_isolation_guard(
        registry=registry,
        roster=roster,
        registry_sha256=registry_sha256,
    )
    if not kept:
        raise SealedBatchError("sealed batch contains no unseen tracks after audio isolation checks")

    truth = load_json(truth_path)
    tracks = truth_tracks(truth, truth_path)
    track_by_name = {normalize_name(item.get("fileName")): item for item in tracks}
    if len(track_by_name) != len(tracks):
        raise SealedBatchError("fresh truth contains duplicate normalized file names")
    kept_names = {normalize_name(item.get("fileName")) for item in kept}
    filtered_tracks = [track_by_name[name] for name in track_by_name if name in kept_names]
    if len(filtered_tracks) != len(kept):
        raise SealedBatchError("failed to align isolation-filtered truth and audio")

    excluded_paths = [audio_root / str(item.get("fileName") or "") for item in excluded]
    missing_paths = [str(path) for path in excluded_paths if not path.is_file()]
    if missing_paths:
        raise SealedBatchError(f"isolation-filtered audio is missing: {missing_paths[:8]}")
    for path in excluded_paths:
        path.unlink()

    truth["tracks"] = filtered_tracks
    source = truth.get("source") if isinstance(truth.get("source"), dict) else {}
    truth["source"] = {
        **source,
        "trackCount": len(filtered_tracks),
        "sealedBatchExcludedIsolationDuplicateCount": len(excluded),
        "sealedBatchExcludedIsolationDuplicateReasonCounts": audit["stats"]["excludedByReason"],
    }
    write_json_atomic(truth_path, truth)
    return kept, excluded, audit
