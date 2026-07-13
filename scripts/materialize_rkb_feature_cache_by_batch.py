from __future__ import annotations

import argparse
import copy
import filecmp
import hashlib
import json
import os
import shutil
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from rkb_beatgrid_lab_common import (
    atomic_write_json,
    load_feature_index,
    normalize_lookup_key,
    print_json,
    validate_feature_metadata_identity,
    write_feature_index,
)


def _load_json_object(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RuntimeError(f"JSON file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"invalid JSON file: {path}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"JSON root must be an object: {path}")
    return payload


def _load_isolation_family_ids(
    *,
    splits_path: Path,
    batch_id: str,
    roster: list[dict[str, Any]],
) -> dict[str, dict[str, str]]:
    payload = _load_json_object(splits_path)
    raw_instances = payload.get("instances")
    if not isinstance(raw_instances, list):
        raise RuntimeError(f"split instances must be a list: {splits_path}")

    by_instance: dict[str, dict[str, Any]] = {}
    for row in raw_instances:
        if not isinstance(row, dict) or str(row.get("batchId") or "").strip() != batch_id:
            continue
        instance_id = str(row.get("instanceId") or "").strip()
        isolation_family_id = str(row.get("isolationFamilyId") or "").strip()
        if not instance_id or not isolation_family_id:
            raise RuntimeError(
                f"split instance is missing identity/isolationFamilyId: batch={batch_id}"
            )
        if instance_id.casefold() in by_instance:
            raise RuntimeError(f"split contains duplicate instanceId: {instance_id}")
        by_instance[instance_id.casefold()] = row

    identity_by_instance: dict[str, dict[str, str]] = {}
    for roster_row in roster:
        asset_sha256 = str(roster_row.get("assetSha256") or "").strip()
        family_id = str(roster_row.get("familyId") or "").strip()
        instance_id = f"{batch_id}:{asset_sha256}"
        split_row = by_instance.get(instance_id.casefold())
        if split_row is None:
            raise RuntimeError(f"split has no instance for batch roster entry: {instance_id}")
        if str(split_row.get("assetSha256") or "").strip().casefold() != asset_sha256.casefold():
            raise RuntimeError(f"split asset identity mismatch: {instance_id}")
        if str(split_row.get("familyId") or "").strip().casefold() != family_id.casefold():
            raise RuntimeError(f"split family identity mismatch: {instance_id}")
        isolation_family_id = str(split_row.get("isolationFamilyId") or "").strip()
        source_path = str(split_row.get("sourcePath") or "").strip()
        if not isolation_family_id or not source_path:
            raise RuntimeError(f"split source/isolation identity is missing: {instance_id}")
        identity_by_instance[instance_id.casefold()] = {
            "isolationFamilyId": isolation_family_id,
            "sourcePath": source_path,
        }
    return identity_by_instance


def _cache_member(cache_dir: Path, value: Any, fallback_name: str) -> Path:
    raw_name = str(value or fallback_name).strip()
    if not raw_name:
        raise RuntimeError("feature cache entry is missing a cache member name")
    relative = Path(raw_name)
    if relative.is_absolute() or len(relative.parts) != 1 or relative.name != raw_name:
        raise RuntimeError(f"feature cache member must be a file name: {raw_name!r}")
    return cache_dir / relative


def _nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float) and value.is_integer() and value >= 0:
        return int(value)
    return None


def _metadata_audio_file(metadata: dict[str, Any]) -> dict[str, Any] | None:
    cache_payload = metadata.get("cachePayload")
    if not isinstance(cache_payload, dict):
        return None
    audio_file = cache_payload.get("audioFile")
    return audio_file if isinstance(audio_file, dict) else None


def _metadata_audio_size(metadata: dict[str, Any]) -> int | None:
    audio_file = _metadata_audio_file(metadata)
    return _nonnegative_int(audio_file.get("size")) if audio_file is not None else None


def _normalized_path(value: Any) -> str:
    raw_path = str(value or "").strip()
    if not raw_path:
        return ""
    return os.path.normcase(str(Path(raw_path).resolve()))


def _sha256_file(path: Path, cache: dict[str, str]) -> str:
    cache_key = _normalized_path(path)
    if cache_key in cache:
        return cache[cache_key]
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    value = digest.hexdigest()
    cache[cache_key] = value
    return value


def _proof_matches_roster(
    proof: Any,
    *,
    roster_row: dict[str, Any],
    batch_id: str,
    cache_key: str,
) -> bool:
    if not isinstance(proof, dict) or int(proof.get("schemaVersion") or 0) != 1:
        return False
    if str(proof.get("kind") or "") not in {
        "legacy-source-asset-sha256",
        "source-metadata-identity",
    }:
        return False
    if str(proof.get("sourceCacheKey") or "") != cache_key:
        return False
    expected = {
        "batchId": batch_id,
        "assetSha256": str(roster_row.get("assetSha256") or ""),
        "pcmSha256": str(roster_row.get("pcmSha256") or ""),
        "familyId": str(roster_row.get("familyId") or ""),
    }
    return all(
        not value or str(proof.get(field) or "").strip().casefold() == value.casefold()
        for field, value in expected.items()
    )


def _candidate_identity_proof(
    *,
    batch_id: str,
    roster_row: dict[str, Any],
    metadata: dict[str, Any],
    asset_hash_cache: dict[str, str],
) -> tuple[dict[str, Any] | None, str]:
    asset_sha256 = str(roster_row.get("assetSha256") or "").strip()
    pcm_sha256 = str(roster_row.get("pcmSha256") or "").strip()
    family_id = str(roster_row.get("familyId") or "").strip()
    instance_id = f"{batch_id}:{asset_sha256}"
    expected_identity = {
        "instanceId": instance_id,
        "batchId": batch_id,
        "assetSha256": asset_sha256,
        "pcmSha256": pcm_sha256,
        "familyId": family_id,
    }
    verified_fields: list[str] = []
    for field, expected in expected_identity.items():
        actual = str(metadata.get(field) or "").strip()
        if not actual:
            continue
        if not expected or actual.casefold() != expected.casefold():
            return None, f"sourceMetadata{field[0].upper()}{field[1:]}Mismatch"
        verified_fields.append(field)

    cache_key = str(metadata.get("cacheKey") or "").strip()
    audio_file = _metadata_audio_file(metadata)
    source_audio_path = Path(str((audio_file or {}).get("path") or ""))
    source_path_matches_payload = (
        _normalized_path(metadata.get("sourcePath"))
        and _normalized_path(metadata.get("sourcePath")) == _normalized_path(source_audio_path)
    )
    inherited_proof = _proof_matches_roster(
        metadata.get("identityProof"),
        roster_row=roster_row,
        batch_id=batch_id,
        cache_key=cache_key,
    )
    has_strong_metadata_identity = "assetSha256" in verified_fields or "pcmSha256" in verified_fields
    if has_strong_metadata_identity and (source_path_matches_payload or inherited_proof):
        if inherited_proof:
            proof_kind = "source-metadata-identity"
            verified_audio_path = source_audio_path
        else:
            verified_audio_path = source_audio_path
            if not verified_audio_path.is_file():
                verified_audio_path = Path(str(roster_row.get("sourcePath") or ""))
            if not verified_audio_path.is_file():
                return None, "sourceIdentityAudioMissing"
            if _nonnegative_int(verified_audio_path.stat().st_size) != _nonnegative_int(
                roster_row.get("size")
            ):
                return None, "sourceIdentitySizeMismatch"
            try:
                actual_asset_sha256 = _sha256_file(verified_audio_path, asset_hash_cache)
            except OSError:
                return None, "sourceIdentityAudioUnreadable"
            if actual_asset_sha256.casefold() != asset_sha256.casefold():
                return None, "sourceIdentityAssetMismatch"
            proof_kind = "source-metadata-identity"
        return (
            {
                "schemaVersion": 1,
                "kind": proof_kind,
                "sourceCacheKey": cache_key,
                "sourceAudioPath": str(verified_audio_path),
                "batchId": batch_id,
                "assetSha256": asset_sha256,
                "pcmSha256": pcm_sha256,
                "familyId": family_id,
                "verifiedFields": sorted(verified_fields),
            },
            "",
        )

    if not source_audio_path.is_file():
        return None, "sourceIdentityUnavailable"
    actual_size = _nonnegative_int(source_audio_path.stat().st_size)
    if actual_size != _metadata_audio_size(metadata):
        return None, "sourceIdentitySizeMismatch"
    try:
        actual_asset_sha256 = _sha256_file(source_audio_path, asset_hash_cache)
    except OSError:
        return None, "sourceIdentityAudioUnreadable"
    if actual_asset_sha256.casefold() != asset_sha256.casefold():
        return None, "sourceIdentityAssetMismatch"
    return (
        {
            "schemaVersion": 1,
            "kind": "legacy-source-asset-sha256",
            "sourceCacheKey": cache_key,
            "sourceAudioPath": str(source_audio_path),
            "batchId": batch_id,
            "assetSha256": asset_sha256,
            "pcmSha256": pcm_sha256,
            "familyId": family_id,
            "verifiedFields": ["assetSha256"],
        },
        "",
    )


def _source_entries_by_lookup(source_cache_dir: Path) -> dict[str, list[dict[str, Any]]]:
    by_lookup: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for raw_entry in load_feature_index(source_cache_dir).get("entries", []):
        if not isinstance(raw_entry, dict):
            continue
        lookup_key = normalize_lookup_key(raw_entry.get("lookupKey") or raw_entry.get("fileName"))
        if lookup_key:
            by_lookup[lookup_key].append(raw_entry)
    return dict(by_lookup)


def _read_source_candidate(
    source_cache_dir: Path,
    entry: dict[str, Any],
) -> tuple[dict[str, Any], Path]:
    cache_key = str(entry.get("cacheKey") or "").strip()
    if not cache_key:
        raise RuntimeError("source index entry is missing cacheKey")
    metadata_path = _cache_member(
        source_cache_dir,
        entry.get("metadataPath"),
        f"feature-{cache_key}.json",
    )
    metadata = _load_json_object(metadata_path)
    if str(metadata.get("cacheKey") or "").strip() != cache_key:
        raise RuntimeError(f"metadata cacheKey does not match source index: {metadata_path}")
    arrays_path = _cache_member(
        source_cache_dir,
        entry.get("arraysPath") or metadata.get("arraysPath"),
        f"arrays-{cache_key}.npz",
    )
    if not arrays_path.is_file():
        raise RuntimeError(f"feature arrays not found: {arrays_path}")
    return metadata, arrays_path


def _missing_row(
    roster_row: dict[str, Any],
    *,
    reason: str,
    lookup_key: str,
    roster_size: int | None,
    candidate_count: int,
    size_match_count: int,
    identity_match_count: int = 0,
    candidate_errors: list[str] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "fileName": str(roster_row.get("fileName") or ""),
        "assetSha256": str(roster_row.get("assetSha256") or ""),
        "lookupKey": lookup_key,
        "size": roster_size,
        "reason": reason,
        "candidateCount": candidate_count,
        "sizeMatchCount": size_match_count,
        "identityMatchCount": identity_match_count,
    }
    if candidate_errors:
        result["candidateErrors"] = candidate_errors
    return result


def _plan_materialization(
    *,
    batch_id: str,
    roster: list[dict[str, Any]],
    source_cache_dir: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_lookup = _source_entries_by_lookup(source_cache_dir)
    prepared_rows: list[tuple[dict[str, Any], str, int | None]] = []
    seen_instance_ids: set[str] = set()
    asset_hash_cache: dict[str, str] = {}

    for roster_row in roster:
        file_name = str(roster_row.get("fileName") or "").strip()
        lookup_key = normalize_lookup_key(roster_row.get("normalizedFileName") or file_name)
        roster_size = _nonnegative_int(roster_row.get("size"))
        asset_sha256 = str(roster_row.get("assetSha256") or "").strip()
        if asset_sha256:
            instance_id = f"{batch_id}:{asset_sha256}"
            normalized_instance_id = instance_id.casefold()
            if normalized_instance_id in seen_instance_ids:
                raise RuntimeError(f"batch manifest contains duplicate instanceId: {instance_id}")
            seen_instance_ids.add(normalized_instance_id)
        prepared_rows.append((roster_row, lookup_key, roster_size))

    selected: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for roster_row, lookup_key, roster_size in prepared_rows:
        candidates = by_lookup.get(lookup_key, [])
        asset_sha256 = str(roster_row.get("assetSha256") or "").strip()
        if not lookup_key or not asset_sha256 or roster_size is None:
            missing.append(
                _missing_row(
                    roster_row,
                    reason="invalidManifestIdentity",
                    lookup_key=lookup_key,
                    roster_size=roster_size,
                    candidate_count=len(candidates),
                    size_match_count=0,
                )
            )
            continue

        size_matches: list[tuple[dict[str, Any], dict[str, Any], Path]] = []
        identity_matches: list[tuple[dict[str, Any], dict[str, Any], Path, dict[str, Any]]] = []
        candidate_errors: list[str] = []
        identity_failures: list[str] = []
        for entry in candidates:
            try:
                metadata, arrays_path = _read_source_candidate(source_cache_dir, entry)
            except (OSError, RuntimeError) as error:
                candidate_errors.append(str(error))
                continue
            if _metadata_audio_size(metadata) == roster_size:
                size_matches.append((entry, metadata, arrays_path))
                identity_proof, identity_error = _candidate_identity_proof(
                    batch_id=batch_id,
                    roster_row=roster_row,
                    metadata=metadata,
                    asset_hash_cache=asset_hash_cache,
                )
                if identity_proof is not None:
                    identity_matches.append((entry, metadata, arrays_path, identity_proof))
                elif identity_error:
                    identity_failures.append(identity_error)

        if len(identity_matches) != 1:
            reason = "ambiguousSourceIdentityMatch" if len(identity_matches) > 1 else "sourceSizeMismatch"
            if not candidates:
                reason = "sourceLookupMissing"
            elif size_matches and not identity_matches:
                reason = (
                    "sourceIdentityMismatch"
                    if any("Mismatch" in item for item in identity_failures)
                    else "sourceIdentityUnavailable"
                )
            missing.append(
                _missing_row(
                    roster_row,
                    reason=reason,
                    lookup_key=lookup_key,
                    roster_size=roster_size,
                    candidate_count=len(candidates),
                    size_match_count=len(size_matches),
                    identity_match_count=len(identity_matches),
                    candidate_errors=[*candidate_errors, *identity_failures],
                )
            )
            continue

        entry, metadata, arrays_path, identity_proof = identity_matches[0]
        selected.append(
            {
                "roster": roster_row,
                "lookupKey": lookup_key,
                "instanceId": f"{batch_id}:{asset_sha256}",
                "sourceEntry": entry,
                "sourceMetadata": metadata,
                "sourceArraysPath": arrays_path,
                "identityProof": identity_proof,
            }
        )
    return selected, missing


def _materialized_member_names(instance_id: str) -> tuple[str, str]:
    instance_hash = hashlib.sha256(instance_id.encode("utf-8")).hexdigest()
    return f"feature-instance-{instance_hash}.json", f"arrays-instance-{instance_hash}.npz"


def _materialize_arrays(source: Path, target: Path, *, copy_arrays: bool) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if not target.is_file():
            raise RuntimeError(f"target arrays path is not a file: {target}")
        try:
            if os.path.samefile(source, target):
                return "existingHardlink"
        except OSError:
            pass
        if filecmp.cmp(source, target, shallow=False):
            return "existingCopy"
        raise RuntimeError(f"target arrays file conflicts with source: {target}")
    if copy_arrays:
        shutil.copy2(source, target)
        return "copied"
    try:
        os.link(source, target)
        return "hardlinked"
    except OSError:
        shutil.copy2(source, target)
        return "copied"


def _existing_target_entry_matches_roster(
    *,
    target_cache_dir: Path,
    entry: dict[str, Any],
    roster_row: dict[str, Any],
    batch_id: str,
) -> bool:
    asset_sha256 = str(roster_row.get("assetSha256") or "").strip()
    expected_instance_id = f"{batch_id}:{asset_sha256}"
    if str(entry.get("instanceId") or "").strip().casefold() != expected_instance_id.casefold():
        return False
    if str(entry.get("batchId") or "").strip().casefold() != batch_id.casefold():
        return False
    if str(entry.get("assetSha256") or "").strip().casefold() != asset_sha256.casefold():
        return False
    try:
        metadata, _arrays_path = _read_source_candidate(target_cache_dir, entry)
    except (OSError, RuntimeError):
        return False
    if _metadata_audio_size(metadata) != _nonnegative_int(roster_row.get("size")):
        return False
    track = {
        **roster_row,
        "instanceId": expected_instance_id,
        "batchId": batch_id,
        "filePath": str(roster_row.get("sourcePath") or ""),
    }
    try:
        validate_feature_metadata_identity(track=track, entry=entry, metadata=metadata)
    except RuntimeError:
        return False
    return True


def _target_entry(
    *,
    batch_id: str,
    selected: dict[str, Any],
    metadata_name: str,
    arrays_name: str,
    updated_at: float,
) -> dict[str, Any]:
    roster = selected["roster"]
    source_entry = selected["sourceEntry"]
    source_metadata = selected["sourceMetadata"]
    audio = source_metadata.get("audio") if isinstance(source_metadata.get("audio"), dict) else {}
    return {
        "fileName": str(roster.get("fileName") or ""),
        "lookupKey": selected["lookupKey"],
        "instanceId": selected["instanceId"],
        "batchId": batch_id,
        "assetSha256": str(roster.get("assetSha256") or ""),
        "pcmSha256": str(roster.get("pcmSha256") or ""),
        "familyId": str(roster.get("familyId") or ""),
        "isolationFamilyId": str(selected.get("isolationFamilyId") or ""),
        "sourcePath": str(selected.get("sourcePath") or roster.get("sourcePath") or ""),
        "cacheKey": str(source_entry.get("cacheKey") or ""),
        "metadataPath": metadata_name,
        "arraysPath": arrays_name,
        "durationSec": audio.get("durationSec"),
        "featureCacheVersion": source_metadata.get("featureCacheVersion"),
        "identityProofKind": str((selected.get("identityProof") or {}).get("kind") or ""),
        "updatedAt": updated_at,
    }


def materialize_batch_feature_cache(
    *,
    batch_id: str,
    batches_root: Path,
    source_cache_dir: Path,
    target_cache_dir: Path,
    splits_path: Path | None = None,
    copy_arrays: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    normalized_batch_id = str(batch_id or "").strip()
    if not normalized_batch_id:
        raise RuntimeError("batchId must not be empty")
    batch_path = Path(normalized_batch_id)
    if batch_path.is_absolute() or len(batch_path.parts) != 1 or batch_path.name != normalized_batch_id:
        raise RuntimeError(f"batchId must be a single path component: {normalized_batch_id!r}")
    if source_cache_dir.resolve() == target_cache_dir.resolve():
        raise RuntimeError("source and target feature cache directories must be different")
    manifest_path = batches_root / normalized_batch_id / "manifest.json"
    manifest = _load_json_object(manifest_path)
    manifest_batch_id = str(manifest.get("batchId") or "").strip()
    if manifest_batch_id != normalized_batch_id:
        raise RuntimeError(
            f"batch manifest id mismatch: expected {normalized_batch_id!r}, got {manifest_batch_id!r}"
        )
    raw_roster = manifest.get("audioRoster")
    if not isinstance(raw_roster, list):
        raise RuntimeError(f"batch manifest audioRoster must be a list: {manifest_path}")
    roster = [row for row in raw_roster if isinstance(row, dict)]
    if len(roster) != len(raw_roster):
        raise RuntimeError(f"batch manifest audioRoster contains a non-object row: {manifest_path}")

    split_identity_by_instance: dict[str, dict[str, str]] = {}
    if splits_path is not None:
        split_identity_by_instance = _load_isolation_family_ids(
            splits_path=splits_path,
            batch_id=normalized_batch_id,
            roster=roster,
        )

    selected, missing = _plan_materialization(
        batch_id=normalized_batch_id,
        roster=roster,
        source_cache_dir=source_cache_dir,
    )
    if splits_path is not None:
        for item in selected:
            instance_id = str(item["instanceId"] or "").strip()
            split_identity = split_identity_by_instance.get(instance_id.casefold())
            if split_identity is None:
                raise RuntimeError(f"split identity is missing: {instance_id}")
            item.update(split_identity)
    mode_counts: Counter[str] = Counter()
    target_entries: list[dict[str, Any]] = []
    preserved_existing = 0
    if not dry_run:
        target_cache_dir.mkdir(parents=True, exist_ok=True)
        updated_at = round(time.time(), 3)
        for item in selected:
            metadata_name, arrays_name = _materialized_member_names(item["instanceId"])
            arrays_mode = _materialize_arrays(
                item["sourceArraysPath"],
                target_cache_dir / arrays_name,
                copy_arrays=copy_arrays,
            )
            mode_counts[arrays_mode] += 1
            roster_row = item["roster"]
            metadata = copy.deepcopy(item["sourceMetadata"])
            metadata.update(
                {
                    "fileName": str(roster_row.get("fileName") or ""),
                    "lookupKey": item["lookupKey"],
                    "instanceId": item["instanceId"],
                    "batchId": normalized_batch_id,
                    "assetSha256": str(roster_row.get("assetSha256") or ""),
                    "pcmSha256": str(roster_row.get("pcmSha256") or ""),
                    "familyId": str(roster_row.get("familyId") or ""),
                    "isolationFamilyId": str(item.get("isolationFamilyId") or ""),
                    "sourcePath": str(item.get("sourcePath") or roster_row.get("sourcePath") or ""),
                    "arraysPath": arrays_name,
                    "identityProof": copy.deepcopy(item["identityProof"]),
                }
            )
            atomic_write_json(target_cache_dir / metadata_name, metadata)
            target_entries.append(
                _target_entry(
                    batch_id=normalized_batch_id,
                    selected=item,
                    metadata_name=metadata_name,
                    arrays_name=arrays_name,
                    updated_at=updated_at,
                )
            )

        existing_entries = [
            entry
            for entry in load_feature_index(target_cache_dir).get("entries", [])
            if isinstance(entry, dict)
        ]
        batch_prefix = f"{normalized_batch_id}:".casefold()
        selected_instance_ids = {
            str(entry.get("instanceId") or "").strip().casefold() for entry in target_entries
        }
        roster_by_instance = {
            f"{normalized_batch_id}:{str(row.get('assetSha256') or '').strip()}".casefold(): row
            for row in roster
            if str(row.get("assetSha256") or "").strip()
        }
        retained_entries: list[dict[str, Any]] = []
        for entry in existing_entries:
            entry_batch_id = str(entry.get("batchId") or "").strip().casefold()
            instance_id = str(entry.get("instanceId") or "").strip().casefold()
            is_current_batch = (
                entry_batch_id == normalized_batch_id.casefold()
                or instance_id.startswith(batch_prefix)
            )
            if not is_current_batch:
                retained_entries.append(entry)
                continue
            if instance_id in selected_instance_ids:
                continue
            roster_row = roster_by_instance.get(instance_id)
            if roster_row is not None and _existing_target_entry_matches_roster(
                target_cache_dir=target_cache_dir,
                entry=entry,
                roster_row=roster_row,
                batch_id=normalized_batch_id,
            ):
                retained_entries.append(entry)
                preserved_existing += 1
        write_feature_index(target_cache_dir, [*retained_entries, *target_entries])

    return {
        "batchId": normalized_batch_id,
        "manifestPath": str(manifest_path),
        "sourceCacheDir": str(source_cache_dir),
        "targetCacheDir": str(target_cache_dir),
        "dryRun": dry_run,
        "copyArrays": copy_arrays,
        "rosterCount": len(roster),
        "reused": len(selected),
        "missing": len(missing),
        "preservedExisting": preserved_existing,
        "arrays": {
            "hardlinked": mode_counts["hardlinked"],
            "copied": mode_counts["copied"],
            "existingHardlink": mode_counts["existingHardlink"],
            "existingCopy": mode_counts["existingCopy"],
        },
        "missingTracks": missing,
    }


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Materialize an instance-safe FRKB feature cache from a sealed batch manifest"
    )
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--batches-root", required=True)
    parser.add_argument("--source-cache-dir", required=True)
    parser.add_argument("--target-cache-dir", required=True)
    parser.add_argument("--splits", required=True)
    parser.add_argument("--copy-arrays", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    summary = materialize_batch_feature_cache(
        batch_id=args.batch_id,
        batches_root=Path(args.batches_root),
        source_cache_dir=Path(args.source_cache_dir),
        target_cache_dir=Path(args.target_cache_dir),
        splits_path=Path(args.splits),
        copy_arrays=bool(args.copy_arrays),
        dry_run=bool(args.dry_run),
    )
    print_json(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
