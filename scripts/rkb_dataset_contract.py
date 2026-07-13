import hashlib
import json
import os
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
DATASET_LOCK_NAME = "dataset-lock.json"
PARENT_SPLIT_FIELDS = (
    "parentSplitPath",
    "parentSplitFileSha256",
    "splitRosterSha256",
    "registrySha256",
    "truthSourcesSha256",
    "seed",
    "tuneRatio",
    "holdoutRatio",
    "assignmentDigestSha256",
    "splitAssignmentsSha256",
    "audioIsolationPolicySha256",
)
RESULT_IDENTITY_FIELDS = (
    "instanceId",
    "batchId",
    "fileName",
    "assetSha256",
    "pcmSha256",
    "familyId",
    "sourcePath",
)
OUTPUT_IDENTITY_FIELDS = (
    "instanceId",
    "batchId",
    "assetSha256",
    "pcmSha256",
    "familyId",
    "isolationFamilyId",
    "sourcePath",
)
TRUTH_LABEL_EXCLUDED_FIELDS = {
    "instanceId",
    "batchId",
    "assetSha256",
    "pcmSha256",
    "familyId",
    "isolationFamilyId",
    "assignmentKey",
    "sourcePath",
    "filePath",
    "batchStatus",
}


class DatasetContractError(RuntimeError):
    pass


def canonical_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(payload: Any) -> str:
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def registry_content_sha256(payload: dict[str, Any]) -> str:
    return sha256_json({key: value for key, value in payload.items() if key != "generatedAt"})


def registry_stable_projection(payload: dict[str, Any]) -> dict[str, Any]:
    batches: list[dict[str, Any]] = []
    for raw in payload.get("batches") or []:
        if not isinstance(raw, dict):
            raise DatasetContractError("registry contains an invalid batch row")
        batches.append(
            {
                field: raw.get(field)
                for field in (
                    "batchId",
                    "origin",
                    "trackCount",
                    "manifestSha256",
                    "audioRosterHash",
                )
            }
        )
    batches.sort(key=lambda row: normalize_name(row.get("batchId")))
    tracks: list[dict[str, Any]] = []
    for raw in payload.get("tracks") or []:
        if not isinstance(raw, dict):
            raise DatasetContractError("registry contains an invalid track row")
        tracks.append(
            {
                field: raw.get(field)
                for field in (
                    "batchId",
                    "fileName",
                    "assetSha256",
                    "pcmSha256",
                    "fingerprintSha256",
                    "familyId",
                    "sourcePath",
                )
            }
        )
    tracks.sort(
        key=lambda row: (
            normalize_name(row.get("batchId")),
            normalize_name(row.get("fileName")),
            normalize_name(row.get("assetSha256")),
        )
    )
    return {
        "schemaVersion": payload.get("schemaVersion"),
        "type": payload.get("type"),
        "source": payload.get("source"),
        "batchesRoot": normalize_path(payload.get("batchesRoot")),
        "sourcePathRelocation": payload.get("sourcePathRelocation"),
        "batchCount": payload.get("batchCount"),
        "trackCount": payload.get("trackCount"),
        "uniqueIdentityCounts": payload.get("uniqueIdentityCounts"),
        "identityPolicy": payload.get("identityPolicy"),
        "batches": batches,
        "tracks": tracks,
    }


def registry_stable_content_sha256(payload: dict[str, Any]) -> str:
    return sha256_json(registry_stable_projection(payload))


def normalize_name(value: Any) -> str:
    return str(value or "").strip().casefold()


def normalize_path(value: Any, *, anchor: Path | None = None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    path = Path(raw)
    if not path.is_absolute() and anchor is not None:
        path = anchor.parent / path
    try:
        path = path.resolve()
    except OSError:
        path = path.absolute()
    return os.path.normcase(str(path))


def _resolved_reference(value: Any, anchor: Path) -> Path:
    normalized = normalize_path(value, anchor=anchor)
    if not normalized:
        raise DatasetContractError(f"contract path is empty: {anchor}")
    return Path(normalized)


def _text(row: dict[str, Any], field: str, owner: str) -> str:
    value = str(row.get(field) or "").strip()
    if not value:
        raise DatasetContractError(f"{owner} is missing {field}")
    return value


def track_identity_key(track: dict[str, Any]) -> str:
    instance_id = normalize_name(track.get("instanceId"))
    if instance_id:
        return f"instance:{instance_id}"
    file_name = normalize_name(track.get("fileName"))
    return f"file:{file_name}" if file_name else ""


def matches_track_filters(track: dict[str, Any], filters: list[str]) -> bool:
    if not filters:
        return True
    haystack = " ".join(
        str(track.get(field) or "") for field in ("fileName", "title", "artist")
    ).casefold()
    return any(item.casefold() in haystack for item in filters)


def split_roster_sha256(tracks: list[dict[str, Any]]) -> str:
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for track in tracks:
        instance_id = _text(track, "instanceId", "split track")
        assignment_key = _text(track, "assignmentKey", f"split track {instance_id}")
        isolation_family_id = _text(
            track, "isolationFamilyId", f"split track {instance_id}"
        )
        key = instance_id.casefold()
        if key in seen:
            raise DatasetContractError(f"split roster contains duplicate instanceId: {instance_id}")
        seen.add(key)
        rows.append(
            {
                "instanceId": instance_id,
                "assignmentKey": assignment_key,
                "isolationFamilyId": isolation_family_id,
            }
        )
    rows.sort(key=lambda row: (row["instanceId"], row["assignmentKey"], row["isolationFamilyId"]))
    return sha256_json(rows)


def truth_roster_sha256(tracks: list[dict[str, Any]]) -> str:
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for track in tracks:
        identity_key = track_identity_key(track)
        if not identity_key or identity_key in seen:
            raise DatasetContractError(f"truth roster has invalid or duplicate identity: {identity_key}")
        seen.add(identity_key)
        rows.append(
            {
                "identityKey": identity_key,
                "fileName": normalize_name(track.get("fileName")),
                "batchId": normalize_name(track.get("batchId")),
                "assetSha256": normalize_name(track.get("assetSha256")),
                "pcmSha256": normalize_name(track.get("pcmSha256")),
                "familyId": str(track.get("familyId") or "").strip(),
                "isolationFamilyId": str(track.get("isolationFamilyId") or "").strip(),
                "assignmentKey": str(track.get("assignmentKey") or "").strip(),
                "sourcePath": normalize_path(track.get("sourcePath")),
            }
        )
    rows.sort(key=lambda row: row["identityKey"])
    return sha256_json(rows)


def truth_label_projection_sha256(tracks: list[dict[str, Any]]) -> str:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for track in tracks:
        file_name = normalize_name(track.get("fileName"))
        if not file_name or file_name in seen:
            raise DatasetContractError(
                f"truth labels contain invalid or duplicate fileName: {file_name}"
            )
        seen.add(file_name)
        rows.append(
            {
                "fileName": file_name,
                "labels": {
                    key: value
                    for key, value in track.items()
                    if key not in TRUTH_LABEL_EXCLUDED_FIELDS and key != "fileName"
                },
            }
        )
    rows.sort(key=lambda row: row["fileName"])
    return sha256_json(rows)


def _truth_tracks(payload: dict[str, Any], path: Path) -> list[dict[str, Any]]:
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not tracks or any(not isinstance(row, dict) for row in tracks):
        raise DatasetContractError(f"truth contains invalid or empty tracks: {path}")
    return list(tracks)


def registry_batch_identity_rows(
    registry: dict[str, Any], batch_id: str
) -> list[dict[str, Any]]:
    normalized_batch_id = normalize_name(batch_id)
    if not normalized_batch_id:
        raise DatasetContractError("registry batchId is empty")
    rows: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    seen_instances: set[str] = set()
    for raw in registry.get("tracks") or []:
        if not isinstance(raw, dict) or normalize_name(raw.get("batchId")) != normalized_batch_id:
            continue
        file_name = _text(raw, "fileName", f"registry batch {batch_id}")
        asset_sha256 = _text(raw, "assetSha256", file_name).casefold()
        pcm_sha256 = _text(raw, "pcmSha256", file_name).casefold()
        family_id = _text(raw, "familyId", file_name)
        source_path = _text(raw, "sourcePath", file_name)
        row_batch_id = _text(raw, "batchId", file_name)
        instance_id = f"{row_batch_id}:{asset_sha256}"
        name_key = normalize_name(file_name)
        instance_key = instance_id.casefold()
        if name_key in seen_names or instance_key in seen_instances:
            raise DatasetContractError(
                f"registry batch contains duplicate identity: {batch_id}:{file_name}"
            )
        seen_names.add(name_key)
        seen_instances.add(instance_key)
        rows.append(
            {
                "instanceId": instance_id,
                "batchId": row_batch_id,
                "fileName": file_name,
                "assetSha256": asset_sha256,
                "pcmSha256": pcm_sha256,
                "familyId": family_id,
                "sourcePath": source_path,
                "batchStatus": str(raw.get("batchStatus") or ""),
            }
        )
    if not rows:
        raise DatasetContractError(f"registry contains no tracks for batch: {batch_id}")
    return sorted(rows, key=lambda row: str(row["instanceId"]).casefold())


def enrich_truth_tracks_from_registry(
    tracks: list[dict[str, Any]],
    *,
    registry_path: Path,
    batch_id: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    if not isinstance(registry, dict):
        raise DatasetContractError(f"dataset registry is not an object: {registry_path}")
    registry_rows = registry_batch_identity_rows(registry, batch_id)
    rows_by_name = {normalize_name(row["fileName"]): row for row in registry_rows}
    enriched: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for track in tracks:
        file_name = str(track.get("fileName") or "").strip()
        name_key = normalize_name(file_name)
        if not name_key or name_key in seen_names:
            raise DatasetContractError(
                f"truth contains invalid or duplicate fileName for registry enrichment: {file_name!r}"
            )
        row = rows_by_name.get(name_key)
        if row is None:
            raise DatasetContractError(
                f"truth track is missing from registry batch {batch_id!r}: {file_name!r}"
            )
        seen_names.add(name_key)
        enriched.append(
            {
                **{
                    key: value
                    for key, value in track.items()
                    if key not in {"sourcePath", "filePath", "batchStatus"}
                },
                **{key: row[key] for key in RESULT_IDENTITY_FIELDS},
            }
        )
    if seen_names != set(rows_by_name):
        raise DatasetContractError(
            f"truth/registry batch count mismatch: truth={len(enriched)}, registry={len(rows_by_name)}"
        )
    return registry, enriched


def _validate_parent_sources(parent: dict[str, Any], parent_path: Path) -> None:
    sources = parent.get("truthSources")
    if not isinstance(sources, list) or not sources:
        raise DatasetContractError("parent split contains no truthSources")
    if sha256_json(sources) != str(parent.get("truthSourcesSha256") or ""):
        raise DatasetContractError("parent split truthSourcesSha256 mismatch")
    for source in sources:
        if not isinstance(source, dict):
            raise DatasetContractError("parent split contains an invalid truth source")
        source_path = _resolved_reference(source.get("path"), parent_path)
        if not source_path.is_file() or sha256_file(source_path) != str(source.get("sha256") or ""):
            raise DatasetContractError(f"parent split truth source changed: {source_path}")
        source_payload = json.loads(source_path.read_text(encoding="utf-8"))
        source_tracks = source_payload.get("tracks") if isinstance(source_payload, dict) else None
        if not isinstance(source_tracks, list) or len(source_tracks) != int(source.get("trackCount") or -1):
            raise DatasetContractError(f"parent split truth source count mismatch: {source_path}")


def _validate_parent_split(
    truth_path: Path,
    payload: dict[str, Any],
    tracks: list[dict[str, Any]],
) -> dict[str, Any]:
    parent_meta = payload.get("parentSplit")
    if not isinstance(parent_meta, dict):
        raise DatasetContractError("canonical split truth is missing parentSplit")
    missing = [field for field in PARENT_SPLIT_FIELDS if parent_meta.get(field) in (None, "")]
    if missing:
        raise DatasetContractError(f"parentSplit is missing required fields: {missing}")
    parent_path = _resolved_reference(parent_meta["parentSplitPath"], truth_path)
    if not parent_path.is_file():
        raise DatasetContractError(f"parent split file is missing: {parent_path}")
    if sha256_file(parent_path) != str(parent_meta["parentSplitFileSha256"]):
        raise DatasetContractError("parent split file SHA256 mismatch")
    parent = json.loads(parent_path.read_text(encoding="utf-8"))
    if not isinstance(parent, dict) or parent.get("type") != "rkb-rekordbox-dataset-splits":
        raise DatasetContractError("parent split file has an invalid type")
    split_policy = parent.get("splitPolicy") if isinstance(parent.get("splitPolicy"), dict) else {}
    expected = {
        "registrySha256": parent.get("registrySha256"),
        "truthSourcesSha256": parent.get("truthSourcesSha256"),
        "seed": parent.get("seed"),
        "tuneRatio": split_policy.get("tuneRatio"),
        "holdoutRatio": split_policy.get("holdoutRatio"),
        "assignmentDigestSha256": parent.get("assignmentDigestSha256"),
        "splitAssignmentsSha256": parent.get("splitAssignmentsSha256"),
        "audioIsolationPolicySha256": parent.get("audioIsolationPolicySha256"),
    }
    for field, value in expected.items():
        if parent_meta.get(field) != value:
            raise DatasetContractError(f"parentSplit {field} mismatch")
    tune_ratio = float(parent_meta["tuneRatio"])
    holdout_ratio = float(parent_meta["holdoutRatio"])
    if tune_ratio < 0.0 or holdout_ratio < 0.0 or tune_ratio + holdout_ratio >= 1.0:
        raise DatasetContractError("parentSplit ratio contract is invalid")
    registry_path = _resolved_reference(parent.get("registryPath"), parent_path)
    registry = json.loads(registry_path.read_text(encoding="utf-8")) if registry_path.is_file() else None
    if not isinstance(registry, dict) or registry_content_sha256(registry) != str(parent_meta["registrySha256"]):
        raise DatasetContractError("parent split registry SHA256 mismatch")
    registry_by_instance: dict[str, dict[str, Any]] = {}
    for row in registry.get("tracks") or []:
        if not isinstance(row, dict):
            raise DatasetContractError("parent split registry contains an invalid track")
        instance_id = (
            f"{str(row.get('batchId') or '').strip()}:"
            f"{str(row.get('assetSha256') or '').strip()}"
        ).casefold()
        if instance_id in registry_by_instance:
            raise DatasetContractError(
                f"parent split registry contains duplicate instance: {instance_id}"
            )
        registry_by_instance[instance_id] = row
    _validate_parent_sources(parent, parent_path)
    if sha256_json(payload.get("truthSources")) != str(parent_meta["truthSourcesSha256"]):
        raise DatasetContractError("truth split truthSources contract mismatch")
    split = _text(payload, "split", "truth split")
    if split not in {"train", "tune", "holdout"}:
        raise DatasetContractError(f"truth split name is invalid: {split}")
    instances = parent.get("instances")
    families = parent.get("families")
    if not isinstance(instances, list) or not isinstance(families, list):
        raise DatasetContractError("parent split instances/families are invalid")
    family_map: dict[str, dict[str, Any]] = {}
    for row in families:
        if not isinstance(row, dict):
            raise DatasetContractError("parent split contains an invalid family")
        family_id = _text(row, "isolationFamilyId", "parent family")
        if family_id in family_map:
            raise DatasetContractError(f"parent split contains duplicate family: {family_id}")
        family_map[family_id] = row
    expected_instances: dict[str, dict[str, Any]] = {}
    for row in instances:
        if not isinstance(row, dict):
            raise DatasetContractError("parent split contains an invalid instance")
        instance_id = _text(row, "instanceId", "parent instance")
        family_id = _text(row, "isolationFamilyId", f"parent instance {instance_id}")
        family = family_map.get(family_id)
        if family is None:
            raise DatasetContractError(f"parent instance has no family: {instance_id}")
        if str(family.get("split") or "") == split:
            key = instance_id.casefold()
            if key in expected_instances:
                raise DatasetContractError(f"parent split contains duplicate instance: {instance_id}")
            expected_instances[key] = row
    actual_instances: dict[str, dict[str, Any]] = {}
    for track in tracks:
        instance_id = _text(track, "instanceId", "truth split track")
        key = instance_id.casefold()
        if key in actual_instances:
            raise DatasetContractError(f"truth split contains duplicate instance: {instance_id}")
        actual_instances[key] = track
    if set(actual_instances) != set(expected_instances):
        raise DatasetContractError("truth split roster does not match parent split assignment")
    compare_fields = (
        "instanceId", "batchId", "fileName", "familyId", "isolationFamilyId",
        "assignmentKey", "assetSha256", "pcmSha256", "sourcePath",
    )
    for key, track in actual_instances.items():
        parent_row = expected_instances[key]
        for field in compare_fields:
            actual_value = str(track.get(field) or "").strip()
            expected_value = str(parent_row.get(field) or "").strip()
            matches = (
                normalize_path(actual_value) == normalize_path(expected_value)
                if field == "sourcePath"
                else actual_value.casefold() == expected_value.casefold()
            )
            if not matches:
                raise DatasetContractError(f"truth split {field} mismatch for {track.get('instanceId')}")
        registry_row = registry_by_instance.get(key)
        if registry_row is None:
            raise DatasetContractError(f"truth split instance is missing from registry: {track.get('instanceId')}")
        expected_source = str(registry_row.get("sourcePath") or "")
        if not expected_source or normalize_path(track.get("sourcePath")) != normalize_path(expected_source):
            raise DatasetContractError(f"truth split sourcePath mismatch for {track.get('instanceId')}")
        family = family_map[str(track["isolationFamilyId"])]
        if str(family.get("assignmentKey") or "") != str(track.get("assignmentKey") or ""):
            raise DatasetContractError(f"truth split assignmentKey mismatch for {track.get('instanceId')}")
    roster_sha256 = split_roster_sha256(tracks)
    if roster_sha256 != str(parent_meta["splitRosterSha256"]):
        raise DatasetContractError("truth split roster SHA256 mismatch")
    if int(payload.get("trackCount") or -1) != len(tracks):
        raise DatasetContractError("truth split trackCount mismatch")
    if int((parent.get("summary") or {}).get(split) or -1) != len(tracks):
        raise DatasetContractError("parent split summary count mismatch")
    return {"parentSplitPath": str(parent_path), "parentSplitFileSha256": sha256_file(parent_path)}


def build_registry_enriched_truth_metadata(
    *,
    source_truth_path: Path,
    source_contract: dict[str, Any],
    source_tracks: list[dict[str, Any]],
    registry_path: Path,
    registry: dict[str, Any],
    batch_id: str,
    tracks: list[dict[str, Any]],
) -> dict[str, Any]:
    registry_rows = registry_batch_identity_rows(registry, batch_id)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sourceTruthPath": normalize_path(source_truth_path),
        "sourceTruthSha256": str(source_contract.get("truthSha256") or ""),
        "sourceTruthContractSha256": str(source_contract.get("contractSha256") or ""),
        "sourceTruthRosterSha256": str(source_contract.get("rosterSha256") or ""),
        "sourceTruthLabelProjectionSha256": truth_label_projection_sha256(source_tracks),
        "registryPath": normalize_path(registry_path),
        "registryStableContentSha256": registry_stable_content_sha256(registry),
        "registryBatchId": str(batch_id),
        "registryBatchIdentityProjectionSha256": identity_projection_sha256(registry_rows),
        "enrichedRosterSha256": truth_roster_sha256(tracks),
    }


def materialize_registry_enriched_truth(
    *,
    source_truth_path: Path,
    registry_path: Path,
    batch_id: str,
    output_path: Path,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    source_path = source_truth_path.resolve()
    source_payload = json.loads(source_path.read_text(encoding="utf-8"))
    if not isinstance(source_payload, dict):
        raise DatasetContractError(f"truth JSON is not an object: {source_path}")
    source_tracks = _truth_tracks(source_payload, source_path)
    source_contract = validate_truth_contract(source_path, source_payload)
    registry, enriched_tracks = enrich_truth_tracks_from_registry(
        source_tracks,
        registry_path=registry_path.resolve(),
        batch_id=batch_id,
    )
    payload = {
        key: value
        for key, value in source_payload.items()
        if key not in {"tracks", "trackCount", "derivedShard", "registryEnrichedTruth"}
    }
    payload["type"] = "rkb-rekordbox-registry-enriched-truth"
    payload["trackCount"] = len(enriched_tracks)
    payload["tracks"] = enriched_tracks
    payload["registryEnrichedTruth"] = build_registry_enriched_truth_metadata(
        source_truth_path=source_path,
        source_contract=source_contract,
        source_tracks=source_tracks,
        registry_path=registry_path.resolve(),
        registry=registry,
        batch_id=batch_id,
        tracks=enriched_tracks,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    contract = validate_truth_contract(output_path, payload)
    return payload, contract, enriched_tracks


def _validate_registry_enriched_truth(
    truth_path: Path,
    payload: dict[str, Any],
    tracks: list[dict[str, Any]],
    visited: set[str],
) -> dict[str, Any]:
    metadata = payload.get("registryEnrichedTruth")
    if not isinstance(metadata, dict):
        raise DatasetContractError("registry-enriched truth metadata is invalid")
    source_path = _resolved_reference(metadata.get("sourceTruthPath"), truth_path)
    source_key = normalize_path(source_path)
    if source_key in visited:
        raise DatasetContractError("registry-enriched truth provenance contains a cycle")
    source_contract = validate_truth_contract(source_path, _visited={*visited, source_key})
    expected_source_fields = {
        "sourceTruthSha256": source_contract["truthSha256"],
        "sourceTruthContractSha256": source_contract["contractSha256"],
        "sourceTruthRosterSha256": source_contract["rosterSha256"],
    }
    for field, expected in expected_source_fields.items():
        if str(metadata.get(field) or "") != str(expected):
            raise DatasetContractError(f"registry-enriched truth {field} mismatch")
    source_payload = json.loads(source_path.read_text(encoding="utf-8"))
    source_tracks = _truth_tracks(source_payload, source_path)
    label_sha256 = truth_label_projection_sha256(source_tracks)
    if (
        str(metadata.get("sourceTruthLabelProjectionSha256") or "") != label_sha256
        or truth_label_projection_sha256(tracks) != label_sha256
    ):
        raise DatasetContractError("registry-enriched truth labels differ from source truth")
    registry_path = _resolved_reference(metadata.get("registryPath"), truth_path)
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    if not isinstance(registry, dict):
        raise DatasetContractError("registry-enriched truth registry is invalid")
    if registry_stable_content_sha256(registry) != str(
        metadata.get("registryStableContentSha256") or ""
    ):
        raise DatasetContractError("registry-enriched truth stable registry content changed")
    batch_id = _text(metadata, "registryBatchId", "registry-enriched truth")
    registry_rows = registry_batch_identity_rows(registry, batch_id)
    if identity_projection_sha256(registry_rows) != str(
        metadata.get("registryBatchIdentityProjectionSha256") or ""
    ):
        raise DatasetContractError("registry-enriched truth batch identity changed")
    if identity_projection_sha256(tracks) != identity_projection_sha256(registry_rows):
        raise DatasetContractError("registry-enriched truth identity does not match registry batch")
    roster_sha256 = truth_roster_sha256(tracks)
    if roster_sha256 != str(metadata.get("enrichedRosterSha256") or ""):
        raise DatasetContractError("registry-enriched truth roster SHA256 mismatch")
    if int(payload.get("trackCount") or -1) != len(tracks):
        raise DatasetContractError("registry-enriched truth trackCount mismatch")
    return {
        "sourceTruthPath": str(source_path),
        "sourceTruthContractSha256": source_contract["contractSha256"],
        "registryPath": str(registry_path),
        "registryStableContentSha256": str(metadata["registryStableContentSha256"]),
        "registryBatchId": batch_id,
        "registryBatchIdentityProjectionSha256": str(
            metadata["registryBatchIdentityProjectionSha256"]
        ),
    }


def _validate_derived_shard(
    truth_path: Path,
    payload: dict[str, Any],
    tracks: list[dict[str, Any]],
    visited: set[str],
) -> dict[str, Any]:
    shard = payload.get("derivedShard")
    if not isinstance(shard, dict):
        raise DatasetContractError("derived shard metadata is invalid")
    source_path = _resolved_reference(shard.get("sourceTruthPath"), truth_path)
    source_key = normalize_path(source_path)
    if source_key in visited:
        raise DatasetContractError("truth shard provenance contains a cycle")
    source_contract = validate_truth_contract(source_path, _visited={*visited, source_key})
    if source_contract["truthSha256"] != str(shard.get("sourceTruthSha256") or ""):
        raise DatasetContractError("truth shard source SHA256 mismatch")
    if source_contract["contractSha256"] != str(shard.get("sourceTruthContractSha256") or ""):
        raise DatasetContractError("truth shard source contract mismatch")
    if source_contract["rosterSha256"] != str(shard.get("sourceRosterSha256") or ""):
        raise DatasetContractError("truth shard source roster mismatch")
    source_payload = json.loads(source_path.read_text(encoding="utf-8"))
    source_tracks = _truth_tracks(source_payload, source_path)
    source_by_key = {track_identity_key(row): row for row in source_tracks}
    if len(source_by_key) != len(source_tracks):
        raise DatasetContractError("truth shard source contains duplicate identities")
    for track in tracks:
        identity_key = track_identity_key(track)
        source = source_by_key.get(identity_key)
        if source is None or truth_roster_sha256([track]) != truth_roster_sha256([source]):
            raise DatasetContractError(f"truth shard track is not identical to source: {identity_key}")
    roster_sha256 = truth_roster_sha256(tracks)
    if roster_sha256 != str(shard.get("shardRosterSha256") or ""):
        raise DatasetContractError("truth shard roster SHA256 mismatch")
    if int(payload.get("trackCount") or -1) != len(tracks):
        raise DatasetContractError("truth shard trackCount mismatch")
    if payload.get("parentSplit") != source_payload.get("parentSplit"):
        raise DatasetContractError("truth shard parentSplit metadata mismatch")
    return {"sourceTruthPath": str(source_path), "sourceTruthContractSha256": source_contract["contractSha256"]}


def validate_truth_contract(
    truth_path: Path,
    payload: dict[str, Any] | None = None,
    *,
    _visited: set[str] | None = None,
) -> dict[str, Any]:
    path = truth_path.resolve()
    if not path.is_file():
        raise DatasetContractError(f"truth file is missing: {path}")
    loaded = payload if payload is not None else json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise DatasetContractError(f"truth JSON is not an object: {path}")
    tracks = _truth_tracks(loaded, path)
    visited = set(_visited or {normalize_path(path)})
    parent_meta: dict[str, Any] = {}
    if loaded.get("derivedShard") is not None:
        parent_meta = _validate_derived_shard(path, loaded, tracks, visited)
    elif loaded.get("registryEnrichedTruth") is not None:
        parent_meta = _validate_registry_enriched_truth(path, loaded, tracks, visited)
    elif loaded.get("parentSplit") is not None or loaded.get("type") == "rkb-rekordbox-truth-split":
        parent_meta = _validate_parent_split(path, loaded, tracks)
    roster_sha256 = truth_roster_sha256(tracks)
    contract = {
        "schemaVersion": SCHEMA_VERSION,
        "truthPath": normalize_path(path),
        "truthSha256": sha256_file(path),
        "trackCount": len(tracks),
        "rosterSha256": roster_sha256,
        "parentSplitSha256": sha256_json(loaded.get("parentSplit")) if loaded.get("parentSplit") else "",
        "derivedShard": bool(loaded.get("derivedShard")),
        "registryEnrichedTruth": bool(loaded.get("registryEnrichedTruth")),
        **parent_meta,
    }
    return {**contract, "contractSha256": sha256_json(contract)}


def build_derived_shard_metadata(
    *,
    source_truth_path: Path,
    source_contract: dict[str, Any],
    tracks: list[dict[str, Any]],
    shard_index: int,
    shard_count: int,
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sourceTruthPath": normalize_path(source_truth_path),
        "sourceTruthSha256": str(source_contract.get("truthSha256") or ""),
        "sourceTruthContractSha256": str(source_contract.get("contractSha256") or ""),
        "sourceRosterSha256": str(source_contract.get("rosterSha256") or ""),
        "shardIndex": shard_index + 1,
        "shardCount": shard_count,
        "shardRosterSha256": truth_roster_sha256(tracks),
    }


def _manifest_roster_projection(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    roster = manifest.get("audioRoster")
    if not isinstance(roster, list) or not roster:
        raise DatasetContractError("manifest contains no audioRoster")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in roster:
        if not isinstance(raw, dict):
            raise DatasetContractError("manifest audioRoster contains an invalid row")
        file_name = _text(raw, "fileName", "manifest audioRoster row")
        key = normalize_name(file_name)
        if key in seen:
            raise DatasetContractError(f"manifest audioRoster contains duplicate fileName: {file_name}")
        seen.add(key)
        rows.append(
            {
                "fileName": key,
                "size": int(raw.get("size") or 0),
                "assetSha256": _text(raw, "assetSha256", file_name).casefold(),
                "pcmSha256": _text(raw, "pcmSha256", file_name).casefold(),
                "fingerprintSha256": _text(raw, "fingerprintSha256", file_name).casefold(),
                "familyId": _text(raw, "familyId", file_name),
            }
        )
    return sorted(rows, key=lambda row: row["fileName"])


def expected_registry_identity_rows(
    manifest: dict[str, Any], registry: dict[str, Any]
) -> list[dict[str, Any]]:
    batch_id = _text(manifest, "batchId", "manifest")
    manifest_rows = {row["fileName"]: row for row in _manifest_roster_projection(manifest)}
    registry_rows: dict[str, dict[str, Any]] = {}
    for raw in registry.get("tracks") or []:
        if not isinstance(raw, dict) or normalize_name(raw.get("batchId")) != batch_id.casefold():
            continue
        file_name = _text(raw, "fileName", f"registry batch {batch_id}")
        key = normalize_name(file_name)
        if key in registry_rows:
            raise DatasetContractError(f"registry batch contains duplicate fileName: {file_name}")
        registry_rows[key] = raw
    if set(registry_rows) != set(manifest_rows):
        raise DatasetContractError(f"registry batch roster does not match manifest: {batch_id}")
    result: list[dict[str, Any]] = []
    for key, manifest_row in manifest_rows.items():
        registry_row = registry_rows[key]
        for field in ("assetSha256", "pcmSha256", "familyId", "fingerprintSha256"):
            if str(registry_row.get(field) or "").strip().casefold() != str(manifest_row[field]).casefold():
                raise DatasetContractError(f"registry {field} mismatch for {batch_id}:{key}")
        asset_sha256 = str(manifest_row["assetSha256"])
        source_path = _text(registry_row, "sourcePath", f"registry {batch_id}:{key}")
        result.append(
            {
                "instanceId": f"{batch_id}:{asset_sha256}",
                "batchId": batch_id,
                "fileName": str(registry_row.get("fileName") or ""),
                "assetSha256": asset_sha256,
                "pcmSha256": str(manifest_row["pcmSha256"]),
                "familyId": str(manifest_row["familyId"]),
                "sourcePath": normalize_path(source_path),
                "batchStatus": str(registry_row.get("batchStatus") or ""),
            }
        )
    return sorted(result, key=lambda row: str(row["instanceId"]).casefold())


def identity_projection_sha256(rows: list[dict[str, Any]]) -> str:
    projection: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        normalized = {
            "instanceId": _text(row, "instanceId", "identity row").casefold(),
            "batchId": _text(row, "batchId", "identity row").casefold(),
            "fileName": normalize_name(_text(row, "fileName", "identity row")),
            "assetSha256": _text(row, "assetSha256", "identity row").casefold(),
            "pcmSha256": _text(row, "pcmSha256", "identity row").casefold(),
            "familyId": _text(row, "familyId", "identity row"),
            "sourcePath": normalize_path(_text(row, "sourcePath", "identity row")),
        }
        if normalized["instanceId"] in seen:
            raise DatasetContractError(f"identity projection contains duplicate instanceId: {normalized['instanceId']}")
        seen.add(normalized["instanceId"])
        projection.append(normalized)
    projection.sort(key=lambda row: row["instanceId"])
    return sha256_json(projection)


def validate_result_identity_rows(
    rows: list[dict[str, Any]],
    *,
    manifest: dict[str, Any],
    registry: dict[str, Any],
    owner: str,
) -> str:
    expected = expected_registry_identity_rows(manifest, registry)
    expected_by_key = {str(row["instanceId"]).casefold(): row for row in expected}
    actual_by_key: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise DatasetContractError(f"{owner} contains a non-object row")
        instance_id = _text(row, "instanceId", owner).casefold()
        if instance_id in actual_by_key:
            raise DatasetContractError(f"{owner} contains duplicate instanceId: {instance_id}")
        actual_by_key[instance_id] = row
    if set(actual_by_key) != set(expected_by_key):
        raise DatasetContractError(f"{owner} identity roster does not match sealed manifest/registry")
    normalized_actual: list[dict[str, Any]] = []
    for instance_id, expected_row in expected_by_key.items():
        actual = actual_by_key[instance_id]
        for field in RESULT_IDENTITY_FIELDS:
            expected_value = str(expected_row.get(field) or "").strip()
            actual_value = str(actual.get(field) or "").strip()
            matches = (
                normalize_path(actual_value) == normalize_path(expected_value)
                if field == "sourcePath"
                else actual_value.casefold() == expected_value.casefold()
            )
            if not matches:
                raise DatasetContractError(f"{owner} {field} mismatch for {instance_id}")
        normalized_actual.append({**expected_row, "batchStatus": expected_row.get("batchStatus")})
    return identity_projection_sha256(normalized_actual)


def benchmark_result_body_sha256(payload: dict[str, Any]) -> str:
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    return sha256_json(
        {
            **payload,
            "summary": {
                key: value for key, value in summary.items() if key != "resultBodySha256"
            },
        }
    )


def attach_benchmark_result_digest(payload: dict[str, Any]) -> dict[str, Any]:
    summary = payload.get("summary")
    if not isinstance(summary, dict):
        raise DatasetContractError("benchmark result contains no summary")
    summary["resultBodySha256"] = benchmark_result_body_sha256(payload)
    return payload


def validate_benchmark_result_digest(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise DatasetContractError("benchmark result is not an object")
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    stored = str(summary.get("resultBodySha256") or "")
    if not stored or stored != benchmark_result_body_sha256(payload):
        raise DatasetContractError("benchmark result body digest mismatch")


def validate_sealed_benchmark_output(
    path: Path,
    *,
    expected_track_count: int,
    exit_code: int,
    maximum_error_rate: float,
    manifest: dict[str, Any] | None = None,
    registry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DatasetContractError(f"failed to read sealed benchmark {path}: {error}") from error
    if not isinstance(payload, dict):
        raise DatasetContractError("sealed benchmark output is not an object")
    validate_benchmark_result_digest(payload)
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    total = int(summary.get("trackTotal") or 0)
    analyzed = int(summary.get("analyzedTrackCount") or 0)
    errors = int(summary.get("errorTrackCount") or 0)
    rows = payload.get("tracks") if isinstance(payload.get("tracks"), list) else []
    error_rows = payload.get("errors") if isinstance(payload.get("errors"), list) else []
    if str(summary.get("solver") or "") != "constant-grid-dp" or total != expected_track_count:
        raise DatasetContractError("sealed benchmark solver or trackTotal mismatch")
    if analyzed + errors != total:
        raise DatasetContractError("sealed benchmark did not account for every truth track")
    if len(rows) != analyzed or len(error_rows) != errors:
        raise DatasetContractError("sealed benchmark row arrays do not match summary counts")
    categories = summary.get("categoryCounts")
    if not isinstance(categories, dict) or sum(int(value or 0) for value in categories.values()) != analyzed:
        raise DatasetContractError("sealed benchmark category counts do not match analyzedTrackCount")
    if exit_code != 0 or errors != 0 or analyzed != total:
        raise DatasetContractError("sealed benchmark must exit 0 with every track analyzed and zero errors")
    if errors / max(1, total) > float(maximum_error_rate):
        raise DatasetContractError("sealed benchmark exceeded its preregistered maximumErrorRate")
    if manifest is not None and registry is not None:
        validate_result_identity_rows(
            [*rows, *error_rows], manifest=manifest, registry=registry, owner="benchmark result"
        )
    return payload


def build_dataset_lock(
    *, registry_path: Path, registry: dict[str, Any], manifest: dict[str, Any]
) -> dict[str, Any]:
    expected_rows = expected_registry_identity_rows(manifest, registry)
    validate_registry_audio_assets(expected_rows)
    locked = {
        "schemaVersion": SCHEMA_VERSION,
        "batchId": _text(manifest, "batchId", "manifest"),
        "truthSha256": str((manifest.get("truth") or {}).get("sha256") or ""),
        "registryPath": normalize_path(registry_path),
        "registryStableContentSha256": registry_stable_content_sha256(registry),
        "registryBatchTrackCount": len(expected_rows),
        "registryBatchIdentityProjectionSha256": identity_projection_sha256(expected_rows),
        "manifestAudioRosterProjectionSha256": sha256_json(_manifest_roster_projection(manifest)),
        "manifestAudioRosterHash": str((manifest.get("audio") or {}).get("rosterHash") or ""),
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "type": "rkb-sealed-dataset-lock",
        "lockHash": sha256_json(locked),
        "locked": locked,
    }


def validate_registry_audio_assets(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        source_path = Path(_text(row, "sourcePath", "registry identity row"))
        asset_sha256 = _text(row, "assetSha256", str(row.get("instanceId") or "")).casefold()
        if not source_path.is_file() or sha256_file(source_path).casefold() != asset_sha256:
            raise DatasetContractError(
                f"registry sourcePath asset SHA256 mismatch: {row.get('instanceId')}:{source_path}"
            )


def validate_dataset_lock(
    lock: dict[str, Any],
    *,
    registry_path: Path,
    registry: dict[str, Any],
    manifest: dict[str, Any],
) -> dict[str, Any]:
    if lock.get("type") != "rkb-sealed-dataset-lock" or not isinstance(lock.get("locked"), dict):
        raise DatasetContractError("sealed dataset lock has an invalid type or payload")
    expected = build_dataset_lock(registry_path=registry_path, registry=registry, manifest=manifest)
    if lock.get("lockHash") != sha256_json(lock["locked"]):
        raise DatasetContractError("sealed dataset lockHash is internally inconsistent")
    if lock.get("lockHash") != expected["lockHash"] or lock.get("locked") != expected["locked"]:
        raise DatasetContractError("sealed dataset lock no longer matches registry/manifest identities")
    return dict(lock["locked"])


def path_signature(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if not resolved.is_file():
        return {"path": normalize_path(resolved), "exists": False}
    stat = resolved.stat()
    return {
        "path": normalize_path(resolved),
        "exists": True,
        "size": int(stat.st_size),
        "sha256": sha256_file(resolved),
    }


def build_benchmark_provenance(
    *,
    truth_contract: dict[str, Any],
    solver: str,
    device: str,
    audio_root: str,
    ffmpeg_path: Path,
    ffprobe_path: Path,
    feature_cache_dir: Path,
    prediction_cache_dir: Path,
    prediction_cache_enabled: bool,
) -> dict[str, Any]:
    configuration = {
        "solver": str(solver),
        "device": str(device),
        "audioRoots": [normalize_path(item) for item in str(audio_root).split(";") if item.strip()],
        "ffmpeg": path_signature(ffmpeg_path),
        "ffprobe": path_signature(ffprobe_path),
        "featureIndex": path_signature(feature_cache_dir / "index.json"),
        "predictionCache": {
            "enabled": bool(prediction_cache_enabled),
            "path": normalize_path(prediction_cache_dir),
        },
    }
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "truthContractSha256": str(truth_contract.get("contractSha256") or ""),
        "truthSha256": str(truth_contract.get("truthSha256") or ""),
        "truthRosterSha256": str(truth_contract.get("rosterSha256") or ""),
        "configuration": configuration,
        "configurationSha256": sha256_json(configuration),
    }
    return {**payload, "provenanceSha256": sha256_json(payload)}


def build_benchmark_provenance_from_args(
    args: Any, truth_contract: dict[str, Any]
) -> dict[str, Any]:
    return build_benchmark_provenance(
        truth_contract=truth_contract,
        solver=str(getattr(args, "solver", "legacy") or "legacy"),
        device=str(getattr(args, "device", "cpu") or "cpu"),
        audio_root=str(getattr(args, "audio_root", "") or ""),
        ffmpeg_path=Path(str(getattr(args, "ffmpeg", "") or "")),
        ffprobe_path=Path(str(getattr(args, "ffprobe", "") or "")),
        feature_cache_dir=Path(str(getattr(args, "feature_cache_dir", "") or "")),
        prediction_cache_dir=Path(str(getattr(args, "prediction_cache_dir", "") or "")),
        prediction_cache_enabled=not bool(getattr(args, "no_prediction_cache", False)),
    )


def validate_benchmark_provenance(payload: Any, expected: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise DatasetContractError("benchmark output is missing run provenance")
    stored = {key: value for key, value in payload.items() if key != "provenanceSha256"}
    if payload.get("provenanceSha256") != sha256_json(stored):
        raise DatasetContractError("benchmark run provenance hash is internally inconsistent")
    if payload != expected:
        raise DatasetContractError("benchmark run provenance does not match truth/solver/config")


def validate_feature_result_summary(
    summary: Any,
    *,
    locked: dict[str, Any],
) -> None:
    if not isinstance(summary, dict):
        raise DatasetContractError("feature result contains no summary")
    expected_count = int(locked.get("registryBatchTrackCount") or -1)
    if (
        int(summary.get("selectedTrackCount") or -1) != expected_count
        or int(summary.get("indexedFeatureCount") or -1) != expected_count
        or str(summary.get("registryBatchId") or "") != str(locked.get("batchId") or "")
        or str(summary.get("identityProjectionSha256") or "")
        != str(locked.get("registryBatchIdentityProjectionSha256") or "")
    ):
        raise DatasetContractError("feature result identity projection does not match dataset lock")


def load_last_json_object(path: Path) -> dict[str, Any]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise DatasetContractError(f"failed to read command output {path}: {error}") from error
    for line in reversed(lines):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    raise DatasetContractError(f"command output contains no JSON object: {path}")
