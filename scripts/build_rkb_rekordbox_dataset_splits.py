import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from rkb_audio_isolation_families import (
    build_audio_isolation_families,
    canonical_json_sha256,
)
from rkb_dataset_registry import verify_registry_baseline
from rkb_dataset_relocation import resolve_root_remap_for_registry
from rkb_sealed_batch_common import build_registry_payload, rebuild_registry


REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_REGISTRY = BENCHMARK_OUTPUT_DIR / "rkb-dataset-registry.json"
DEFAULT_BASELINE = BENCHMARK_OUTPUT_DIR / "rkb-dataset-registry-baseline.json"
DEFAULT_BATCHES_ROOT = BENCHMARK_OUTPUT_DIR / "sealed-batches"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "rkb-dataset-splits-current.json"
CANONICAL_SEED = "frkb-rkb-grid-v2"
CANONICAL_TUNE_RATIO = 0.2
CANONICAL_HOLDOUT_RATIO = 0.2


def _normalize_text(value: Any) -> str:
    return str(value or "").strip().casefold()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"json is not an object: {path}")
    return payload


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _registry_source_sha256(payload: dict[str, Any]) -> str:
    return canonical_json_sha256(
        {key: value for key, value in payload.items() if key != "generatedAt"}
    )


def _registry_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_rows = payload.get("tracks")
    if isinstance(raw_rows, list):
        return [row for row in raw_rows if isinstance(row, dict)]
    if isinstance(raw_rows, dict):
        rows: list[dict[str, Any]] = []
        for file_name, raw_row in raw_rows.items():
            if not isinstance(raw_row, dict):
                continue
            row = dict(raw_row)
            row.setdefault("fileName", file_name)
            rows.append(row)
        return rows
    raise RuntimeError("dataset registry must contain a tracks array or object")


def _stable_family_id(row: dict[str, Any]) -> str:
    explicit = _normalize_text(row.get("familyId") or row.get("recordingFamilyId"))
    if explicit:
        return explicit
    raise RuntimeError(f"registry row is missing immutable familyId: {row.get('fileName')!r}")


def _instance_id(batch_id: str, asset_sha256: str) -> str:
    normalized_batch = _normalize_text(batch_id)
    normalized_asset = _normalize_text(asset_sha256)
    if not normalized_batch or not normalized_asset:
        raise RuntimeError("instance identity requires batchId and assetSha256")
    return f"{normalized_batch}:{normalized_asset}"


def _registry_index(path: Path, authoritative_payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = authoritative_payload if authoritative_payload is not None else _load_json(path)
    batch_metadata: dict[str, dict[str, Any]] = {}
    for raw_batch in payload.get("batches") or []:
        if not isinstance(raw_batch, dict):
            continue
        batch_id = str(raw_batch.get("batchId") or "").strip()
        batch_key = _normalize_text(batch_id)
        if not batch_key:
            raise RuntimeError("dataset registry contains a batch without batchId")
        if batch_key in batch_metadata:
            raise RuntimeError(f"dataset registry contains duplicate batchId: {batch_id!r}")
        batch_metadata[batch_key] = {
            "batchId": batch_id,
            "status": str(raw_batch.get("status") or "").strip().casefold(),
            "origin": str(raw_batch.get("origin") or "").strip(),
            "manifestSha256": str(raw_batch.get("manifestSha256") or "").strip(),
            "stateSha256": str(raw_batch.get("stateSha256") or "").strip(),
            "audioRosterHash": str(raw_batch.get("audioRosterHash") or "").strip(),
            "trackCount": int(raw_batch.get("trackCount") or 0),
        }

    by_instance: dict[str, dict[str, str]] = {}
    by_batch_name: dict[tuple[str, str], dict[str, str]] = {}
    by_name: dict[str, list[dict[str, str]]] = {}
    rows_by_batch: dict[str, list[dict[str, str]]] = {}
    for raw_row in _registry_rows(payload):
        file_name = str(raw_row.get("fileName") or raw_row.get("trackKey") or "").strip()
        file_key = _normalize_text(file_name)
        if not file_key:
            raise RuntimeError("dataset registry contains a row without fileName/trackKey")
        batch_id = str(raw_row.get("batchId") or "").strip()
        batch_key = _normalize_text(batch_id)
        if not batch_key:
            raise RuntimeError(f"registry row is missing batchId: {file_name!r}")
        metadata_status = (batch_metadata.get(batch_key) or {}).get("status", "")
        row_status = str(raw_row.get("batchStatus") or raw_row.get("status") or "").strip().casefold()
        if metadata_status and row_status and metadata_status != row_status:
            raise RuntimeError(f"registry batch status mismatch: {batch_id!r}")
        batch_status = row_status or metadata_status
        asset_sha256 = str(raw_row.get("assetSha256") or raw_row.get("fileSha256") or "").strip()
        instance_id = _instance_id(batch_id, asset_sha256)
        if instance_id in by_instance:
            raise RuntimeError(f"dataset registry contains duplicate instanceId: {instance_id}")
        batch_name_key = (batch_key, file_key)
        if batch_name_key in by_batch_name:
            raise RuntimeError(
                f"dataset registry contains duplicate fileName inside batch {batch_id!r}: {file_name!r}"
            )
        row = {
            "instanceId": instance_id,
            "fileName": file_name,
            "fileKey": file_key,
            "familyId": _stable_family_id(raw_row),
            "batchId": batch_id,
            "batchKey": batch_key,
            "batchStatus": batch_status,
            "pcmSha256": str(
                raw_row.get("pcmSha256")
                or raw_row.get("pcmHash")
                or raw_row.get("audioHash")
                or raw_row.get("sha256Hash")
                or ""
            ).strip(),
            "assetSha256": asset_sha256,
            "fingerprint": str(raw_row.get("fingerprint") or "").strip(),
            "fingerprintSha256": str(raw_row.get("fingerprintSha256") or "").strip(),
            "sourcePath": str(raw_row.get("sourcePath") or "").strip(),
        }
        by_instance[instance_id] = row
        by_batch_name[batch_name_key] = row
        by_name.setdefault(file_key, []).append(row)
        rows_by_batch.setdefault(batch_key, []).append(row)
        batch_metadata.setdefault(
            batch_key,
            {
                "batchId": batch_id,
                "status": batch_status,
                "origin": "",
                "manifestSha256": "",
                "stateSha256": "",
                "audioRosterHash": "",
                "trackCount": 0,
            },
        )

    if not by_instance:
        raise RuntimeError("dataset registry contains no track instances")
    return {
        "payload": payload,
        "batchMetadata": batch_metadata,
        "byInstance": by_instance,
        "byBatchName": by_batch_name,
        "byName": by_name,
        "rowsByBatch": rows_by_batch,
    }


def _build_registry_audio_isolation(registry: dict[str, Any]) -> dict[str, Any]:
    consumed_rows = [
        row
        for row in registry["byInstance"].values()
        if row["batchStatus"] == "consumed"
    ]
    if not consumed_rows:
        raise RuntimeError("dataset registry contains no consumed audio isolation rows")
    registry_rows = [
        {
            "instanceId": row["instanceId"],
            "familyId": row["familyId"],
            "pcmSha256": row["pcmSha256"],
            "fingerprint": row["fingerprint"],
            "fingerprintSha256": row["fingerprintSha256"],
            "batchId": row["batchId"],
        }
        for row in consumed_rows
    ]
    isolation = build_audio_isolation_families(registry_rows)
    mapping = isolation.get("instanceIsolationFamilyIds")
    if not isinstance(mapping, dict):
        raise RuntimeError("audio isolation result is missing instance family mapping")
    assignment_mapping = isolation.get("instanceAssignmentKeys")
    if not isinstance(assignment_mapping, dict):
        raise RuntimeError("audio isolation result is missing instance assignment mapping")
    expected_instances = {row["instanceId"] for row in consumed_rows}
    mapped_instances = {str(instance_id) for instance_id in mapping}
    if mapped_instances != expected_instances:
        raise RuntimeError(
            "audio isolation instance mapping is incomplete: "
            f"missing={len(expected_instances - mapped_instances)}, "
            f"extra={len(mapped_instances - expected_instances)}"
        )
    assigned_instances = {str(instance_id) for instance_id in assignment_mapping}
    if assigned_instances != expected_instances:
        raise RuntimeError(
            "audio isolation assignment mapping is incomplete: "
            f"missing={len(expected_instances - assigned_instances)}, "
            f"extra={len(assigned_instances - expected_instances)}"
        )
    return isolation


def _truth_tracks(payload: dict[str, Any], path: Path) -> list[dict[str, Any]]:
    raw_tracks = payload.get("tracks")
    if not isinstance(raw_tracks, list) or not raw_tracks:
        raise RuntimeError(f"truth contains no tracks: {path}")
    return [track for track in raw_tracks if isinstance(track, dict)]


def _truth_evidence_policy(
    payload: dict[str, Any], *, evidence: dict[str, Any] | None = None
) -> dict[str, Any]:
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    forbidden_uses = [str(value) for value in source.get("forbiddenUses") or []]
    proof = evidence or {}
    primary_evidence = bool(
        proof.get("baselineSnapshotVerified")
        or proof.get("sealedFreshFinalizationVerified")
    )
    explicitly_disqualified = (
        source.get("isHistoricalFrozenSnapshot") is False
        or "historical-benchmark-reconstruction" in forbidden_uses
    )
    return {
        "scope": str(source.get("referenceScope") or proof.get("scope") or "consumed-reference"),
        "developmentEligible": True,
        "primaryEvaluationEligible": primary_evidence and not explicitly_disqualified,
        "freshProofEligible": False,
        "allowedUses": [str(value) for value in source.get("allowedUses") or []],
        "forbiddenUses": forbidden_uses,
        "evidence": proof,
    }


def _attach_identity(
    track: dict[str, Any],
    identity: dict[str, str],
    *,
    source_path: str = "",
) -> dict[str, Any]:
    enriched = dict(track)
    enriched.update(
        {
            "instanceId": identity["instanceId"],
            "batchId": identity["batchId"],
            "assetSha256": identity["assetSha256"],
            "familyId": identity["familyId"],
        }
    )
    if identity.get("pcmSha256"):
        enriched["pcmSha256"] = identity["pcmSha256"]
    if source_path:
        enriched["sourcePath"] = source_path
    return enriched


def _align_batch_truth(
    *,
    truth_path: Path,
    batch_key: str,
    registry: dict[str, Any],
    evidence: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    payload = _load_json(truth_path)
    tracks = _truth_tracks(payload, truth_path)
    truth_by_name: dict[str, dict[str, Any]] = {}
    for track in tracks:
        file_name = str(track.get("fileName") or "").strip()
        file_key = _normalize_text(file_name)
        if not file_key:
            raise RuntimeError(f"truth contains a track without fileName: {truth_path}")
        if file_key in truth_by_name:
            raise RuntimeError(
                f"truth contains duplicate fileName inside batch {batch_key!r}: {file_name!r}"
            )
        truth_by_name[file_key] = track

    registry_rows = registry["rowsByBatch"].get(batch_key) or []
    registry_by_name = {row["fileKey"]: row for row in registry_rows}
    missing_registry = sorted(set(truth_by_name) - set(registry_by_name))
    missing_truth = sorted(set(registry_by_name) - set(truth_by_name))
    if missing_registry or missing_truth:
        raise RuntimeError(
            "sealed truth and registry roster do not align for batch "
            f"{batch_key!r}: missingRegistry={len(missing_registry)}, missingTruth={len(missing_truth)}"
        )

    enriched = [
        _attach_identity(
            truth_by_name[file_key],
            registry_by_name[file_key],
            source_path=registry_by_name[file_key]["sourcePath"],
        )
        for file_key in sorted(truth_by_name)
    ]
    batch_id = registry_rows[0]["batchId"] if registry_rows else batch_key
    return enriched, {
        "batchId": batch_id,
        "path": str(truth_path),
        "sha256": _sha256_file(truth_path),
        "trackCount": len(enriched),
        "evidencePolicy": _truth_evidence_policy(payload, evidence=evidence),
    }


def _resolve_batches_root(
    registry_path: Path,
    registry_payload: dict[str, Any],
    batches_root: Path | None,
) -> Path:
    if batches_root is not None:
        return batches_root
    local_root = registry_path.parent / "sealed-batches"
    if local_root.is_dir():
        return local_root
    configured = str(registry_payload.get("batchesRoot") or "").strip()
    return Path(configured) if configured else local_root


def _baseline_snapshots(payload: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if payload is None:
        return {}
    return {
        str(row.get("batchId") or ""): row
        for row in payload.get("batches") or []
        if isinstance(row, dict) and str(row.get("batchId") or "")
    }


def _automatic_batch_evidence(
    metadata: dict[str, Any], baseline_snapshot: dict[str, Any] | None
) -> dict[str, Any]:
    batch_id = str(metadata.get("batchId") or "")
    required = ("origin", "manifestSha256", "stateSha256", "audioRosterHash")
    if any(not str(metadata.get(key) or "") for key in required):
        raise RuntimeError(f"consumed batch evidence is incomplete: {batch_id}")
    baseline_verified = False
    if baseline_snapshot is not None:
        baseline_verified = (
            str(baseline_snapshot.get("manifestSha256") or "")
            == str(metadata.get("manifestSha256") or "")
            and str(baseline_snapshot.get("stateSha256") or "")
            == str(metadata.get("stateSha256") or "")
            and int(baseline_snapshot.get("trackCount") or -1)
            == int(metadata.get("trackCount") or 0)
        )
        if not baseline_verified:
            raise RuntimeError(f"baseline batch evidence mismatch: {batch_id}")
    origin = str(metadata.get("origin") or "")
    sealed_finalization_verified = origin == "sealed-fresh"
    scope = "consumed-development-reference"
    if baseline_verified:
        scope = "consumed-baseline-snapshot"
    elif sealed_finalization_verified:
        scope = "sealed-fresh-finalized"
    elif origin == "reviewed-development":
        scope = "reviewed-development"
    return {
        "scope": scope,
        "origin": origin,
        "manifestSha256": str(metadata.get("manifestSha256") or ""),
        "stateSha256": str(metadata.get("stateSha256") or ""),
        "audioRosterHash": str(metadata.get("audioRosterHash") or ""),
        "truthAndRosterVerified": True,
        "baselineSnapshotVerified": baseline_verified,
        "sealedFreshFinalizationVerified": sealed_finalization_verified,
    }


def _load_consumed_truth(
    *,
    registry_path: Path,
    registry: dict[str, Any],
    batches_root: Path | None,
    baseline_payload: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    root = _resolve_batches_root(registry_path, registry["payload"], batches_root)
    snapshots = _baseline_snapshots(baseline_payload)
    tracks: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    excluded_batches: list[str] = []
    for batch_key in sorted(registry["rowsByBatch"]):
        rows = registry["rowsByBatch"][batch_key]
        statuses = {row["batchStatus"] for row in rows}
        if len(statuses) != 1:
            raise RuntimeError(f"registry batch contains mixed statuses: {batch_key!r}")
        status = next(iter(statuses))
        batch_id = rows[0]["batchId"]
        if status != "consumed":
            excluded_batches.append(batch_id)
            continue
        metadata = registry["batchMetadata"].get(batch_key) or {}
        evidence = _automatic_batch_evidence(metadata, snapshots.get(batch_id))
        batch_dir = root / batch_id
        truth_path = batch_dir / "truth.json"
        if not truth_path.is_file():
            raise RuntimeError(f"consumed batch truth is missing: {truth_path}")
        batch_tracks, source = _align_batch_truth(
            truth_path=truth_path,
            batch_key=batch_key,
            registry=registry,
            evidence=evidence,
        )
        tracks.extend(batch_tracks)
        sources.append(source)
    if not tracks:
        raise RuntimeError("dataset registry contains no consumed truth tracks")
    return tracks, sources, excluded_batches


def _load_explicit_truth(
    *,
    truth_path: Path,
    truth_batch_id: str,
    registry: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    payload = _load_json(truth_path)
    tracks = _truth_tracks(payload, truth_path)
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    top_level_batch = (
        truth_batch_id
        or str(payload.get("batchId") or "").strip()
        or str(source.get("batchId") or "").strip()
    )
    enriched: list[dict[str, Any]] = []
    seen_instances: set[str] = set()
    for track in tracks:
        file_name = str(track.get("fileName") or "").strip()
        file_key = _normalize_text(file_name)
        if not file_key:
            raise RuntimeError(f"truth contains a track without fileName: {truth_path}")
        explicit_instance = _normalize_text(track.get("instanceId"))
        if explicit_instance:
            identity = registry["byInstance"].get(explicit_instance)
            if identity is None:
                raise RuntimeError(f"truth instanceId is missing from registry: {explicit_instance}")
        else:
            batch_id = str(track.get("batchId") or top_level_batch).strip()
            if batch_id:
                identity = registry["byBatchName"].get((_normalize_text(batch_id), file_key))
                if identity is None:
                    raise RuntimeError(
                        f"truth track is missing from registry batch {batch_id!r}: {file_name!r}"
                    )
            else:
                matches = registry["byName"].get(file_key) or []
                if len(matches) != 1:
                    raise RuntimeError(
                        "explicit truth track identity is ambiguous; provide --truth-batch-id or instanceId: "
                        f"{file_name!r}"
                    )
                identity = matches[0]
        if identity["batchStatus"] != "consumed":
            raise RuntimeError(
                "registry row is not consumed and cannot enter development splits: "
                f"{file_name!r} ({identity['batchStatus'] or 'missing status'})"
            )
        instance_id = identity["instanceId"]
        if instance_id in seen_instances:
            raise RuntimeError(f"truth contains duplicate instanceId: {instance_id}")
        seen_instances.add(instance_id)
        enriched.append(
            _attach_identity(
                track,
                identity,
                source_path=str(track.get("sourcePath") or "").strip(),
            )
        )
    return enriched, [
        {
            "batchId": top_level_batch,
            "path": str(truth_path),
            "sha256": _sha256_file(truth_path),
            "trackCount": len(enriched),
            "evidencePolicy": _truth_evidence_policy(payload),
        }
    ], []


def _validated_automatic_registry_payload(
    *,
    registry_path: Path,
    batches_root: Path | None,
    authoritative_payload: dict[str, Any] | None,
    use_auto_root_remap: bool = True,
) -> tuple[dict[str, Any], Path]:
    persisted = _load_json(registry_path)
    root = _resolve_batches_root(registry_path, persisted, batches_root)
    remap = (
        resolve_root_remap_for_registry(registry_path=registry_path, batches_root=root)
        if use_auto_root_remap
        else None
    )
    rebuilt = authoritative_payload or build_registry_payload(root, root_remap=remap)
    if _registry_source_sha256(persisted) != _registry_source_sha256(rebuilt):
        raise RuntimeError(
            "dataset registry does not match authoritative sealed batch artifacts"
        )
    return rebuilt, root


def _stable_unit_interval(text: str, seed: str) -> float:
    digest = hashlib.sha256(f"{seed}\0{text}".encode("utf-8")).hexdigest()
    return int(digest[:12], 16) / float(0xFFFFFFFFFFFF)


def _assign_split(
    assignment_key: str, seed: str, tune_ratio: float, holdout_ratio: float
) -> str:
    value = _stable_unit_interval(assignment_key, seed)
    if value < holdout_ratio:
        return "holdout"
    if value < holdout_ratio + tune_ratio:
        return "tune"
    return "train"


def _build_split_truth(
    tracks: list[dict[str, Any]],
    split: str,
    truth_sources: list[dict[str, Any]],
    parent_split: dict[str, Any],
) -> dict[str, Any]:
    roster = sorted(
        (
            {
                "instanceId": str(track.get("instanceId") or ""),
                "assignmentKey": str(track.get("assignmentKey") or ""),
                "isolationFamilyId": str(track.get("isolationFamilyId") or ""),
            }
            for track in tracks
        ),
        key=lambda row: (
            row["instanceId"],
            row["assignmentKey"],
            row["isolationFamilyId"],
        ),
    )
    parent = dict(parent_split)
    parent["splitRosterSha256"] = canonical_json_sha256(roster)
    return {
        "type": "rkb-rekordbox-truth-split",
        "version": 4,
        "split": split,
        "identityKey": "instanceId",
        "groupKey": "isolationFamilyId",
        "trackCount": len(tracks),
        "truthSources": truth_sources,
        "parentSplit": parent,
        "tracks": tracks,
    }


def _build_lobo(
    *,
    batches: dict[str, list[str]],
    all_instances: list[str],
    instance_isolation_families: dict[str, str],
    instance_assignment_keys: dict[str, str],
    batch_evidence_policies: dict[str, dict[str, Any]],
    seed: str,
    tune_ratio: float,
) -> list[dict[str, Any]]:
    all_instance_set = set(all_instances)
    rows: list[dict[str, Any]] = []
    for batch_id in sorted(batches, key=str.casefold):
        holdout = set(batches[batch_id])
        holdout_families = {
            instance_isolation_families[instance_id] for instance_id in holdout
        }
        leakage = {
            instance_id
            for instance_id in all_instance_set - holdout
            if instance_isolation_families[instance_id] in holdout_families
        }
        development = all_instance_set - holdout - leakage
        inner_seed = f"{seed}:lobo:{batch_id}:inner"
        inner_assignment_split = {
            assignment_key: (
                "tune"
                if _stable_unit_interval(assignment_key, inner_seed) < tune_ratio
                else "train"
            )
            for assignment_key in {
                instance_assignment_keys[instance_id] for instance_id in development
            }
        }
        development_train = {
            instance_id
            for instance_id in development
            if inner_assignment_split[instance_assignment_keys[instance_id]] == "train"
        }
        development_tune = development - development_train
        evidence_policy = batch_evidence_policies.get(batch_id) or {}
        primary_eligible = bool(evidence_policy.get("primaryEvaluationEligible", False))
        rows.append(
            {
                "batchId": batch_id,
                "evaluationRole": (
                    "consumed-lobo-development-estimate"
                    if primary_eligible
                    else "diagnostic-development-reference"
                ),
                "primaryAggregateEligible": primary_eligible,
                "freshProofEligible": False,
                "identityKey": "instanceId",
                "groupKey": "isolationFamilyId",
                "development": sorted(development),
                "developmentTrain": sorted(development_train),
                "developmentTune": sorted(development_tune),
                "holdout": sorted(holdout),
                "excludedDevelopmentIsolationFamilyLeakage": sorted(leakage),
                "developmentTrackCount": len(development),
                "developmentTrainTrackCount": len(development_train),
                "developmentTuneTrackCount": len(development_tune),
                "holdoutTrackCount": len(holdout),
                "excludedDevelopmentIsolationFamilyLeakageTrackCount": len(leakage),
            }
        )
    return rows


def build_splits(
    truth_path: Path | None,
    registry_path: Path,
    *,
    batches_root: Path | None = None,
    truth_batch_id: str = "",
    authoritative_registry_payload: dict[str, Any] | None = None,
    baseline_payload: dict[str, Any] | None = None,
    use_auto_root_remap: bool = True,
    seed: str,
    tune_ratio: float,
    holdout_ratio: float,
) -> dict[str, Any]:
    if tune_ratio < 0.0 or holdout_ratio < 0.0 or tune_ratio + holdout_ratio >= 1.0:
        raise RuntimeError(
            "tune_ratio and holdout_ratio must be non-negative and sum to less than 1"
        )

    effective_batches_root = batches_root
    registry_payload = authoritative_registry_payload
    if truth_path is None:
        registry_payload, effective_batches_root = _validated_automatic_registry_payload(
            registry_path=registry_path,
            batches_root=batches_root,
            authoritative_payload=authoritative_registry_payload,
            use_auto_root_remap=use_auto_root_remap,
        )
    registry = _registry_index(registry_path, registry_payload)
    audio_isolation = _build_registry_audio_isolation(registry)
    raw_isolation_mapping = audio_isolation["instanceIsolationFamilyIds"]
    isolation_mapping = {
        str(instance_id): str(isolation_family_id)
        for instance_id, isolation_family_id in raw_isolation_mapping.items()
    }
    raw_assignment_mapping = audio_isolation["instanceAssignmentKeys"]
    assignment_mapping = {
        str(instance_id): str(assignment_key)
        for instance_id, assignment_key in raw_assignment_mapping.items()
    }
    if truth_path is None:
        tracks, truth_sources, excluded_batches = _load_consumed_truth(
            registry_path=registry_path,
            registry=registry,
            batches_root=effective_batches_root,
            baseline_payload=baseline_payload,
        )
    else:
        tracks, truth_sources, excluded_batches = _load_explicit_truth(
            truth_path=truth_path,
            truth_batch_id=truth_batch_id,
            registry=registry,
        )

    tracks_by_instance: dict[str, dict[str, Any]] = {}
    exact_families: dict[str, list[str]] = {}
    isolation_families: dict[str, list[str]] = {}
    batches: dict[str, list[str]] = {}
    isolation_family_batches: dict[str, set[str]] = {}
    isolation_exact_families: dict[str, set[str]] = {}
    isolation_assignment_keys: dict[str, set[str]] = {}
    instance_exact_families: dict[str, str] = {}
    instance_isolation_families: dict[str, str] = {}
    instance_assignment_keys: dict[str, str] = {}
    for track in tracks:
        instance_id = str(track.get("instanceId") or "")
        if not instance_id or instance_id in tracks_by_instance:
            raise RuntimeError(f"truth contains invalid or duplicate instanceId: {instance_id!r}")
        family_id = str(track.get("familyId") or "")
        batch_id = str(track.get("batchId") or "")
        isolation_family_id = isolation_mapping.get(instance_id, "")
        assignment_key = assignment_mapping.get(instance_id, "")
        if not isolation_family_id:
            raise RuntimeError(
                f"audio isolation family mapping is missing truth instance: {instance_id!r}"
            )
        if not assignment_key:
            raise RuntimeError(
                f"audio isolation assignment mapping is missing truth instance: {instance_id!r}"
            )
        enriched_track = dict(track)
        enriched_track["isolationFamilyId"] = isolation_family_id
        enriched_track["assignmentKey"] = assignment_key
        tracks_by_instance[instance_id] = enriched_track
        exact_families.setdefault(family_id, []).append(instance_id)
        isolation_families.setdefault(isolation_family_id, []).append(instance_id)
        batches.setdefault(batch_id, []).append(instance_id)
        isolation_family_batches.setdefault(isolation_family_id, set()).add(batch_id)
        isolation_exact_families.setdefault(isolation_family_id, set()).add(family_id)
        isolation_assignment_keys.setdefault(isolation_family_id, set()).add(assignment_key)
        instance_exact_families[instance_id] = family_id
        instance_isolation_families[instance_id] = isolation_family_id
        instance_assignment_keys[instance_id] = assignment_key

    if any(len(values) != 1 for values in isolation_assignment_keys.values()):
        raise RuntimeError("an audio isolation family has multiple split assignment keys")

    cross_batch_isolation_families = {
        isolation_family_id: sorted(batch_ids, key=str.casefold)
        for isolation_family_id, batch_ids in isolation_family_batches.items()
        if len(batch_ids) > 1
    }
    assignments: dict[str, str] = {}
    split_instances: dict[str, list[str]] = {"train": [], "tune": [], "holdout": []}
    for isolation_family_id in sorted(isolation_families):
        assignment_key = next(iter(isolation_assignment_keys[isolation_family_id]))
        split = _assign_split(assignment_key, seed, tune_ratio, holdout_ratio)
        assignments[isolation_family_id] = split
        split_instances[split].extend(isolation_families[isolation_family_id])
    for split in split_instances:
        split_instances[split].sort()
    for batch_instances in batches.values():
        batch_instances.sort()

    all_instances = sorted(tracks_by_instance)
    identity_rows = [
        {
            "instanceId": instance_id,
            "batchId": str(tracks_by_instance[instance_id].get("batchId") or ""),
            "fileName": str(tracks_by_instance[instance_id].get("fileName") or ""),
            "familyId": instance_exact_families[instance_id],
            "isolationFamilyId": instance_isolation_families[instance_id],
            "assignmentKey": instance_assignment_keys[instance_id],
            "assetSha256": str(tracks_by_instance[instance_id].get("assetSha256") or ""),
            "pcmSha256": str(tracks_by_instance[instance_id].get("pcmSha256") or ""),
            "sourcePath": str(tracks_by_instance[instance_id].get("sourcePath") or ""),
        }
        for instance_id in all_instances
    ]
    family_rows = [
        {
            "isolationFamilyId": isolation_family_id,
            "assignmentKey": next(iter(isolation_assignment_keys[isolation_family_id])),
            "exactFamilyIds": sorted(isolation_exact_families[isolation_family_id]),
            "batchIds": sorted(
                isolation_family_batches[isolation_family_id], key=str.casefold
            ),
            "split": split,
            "trackCount": len(isolation_families[isolation_family_id]),
        }
        for isolation_family_id, split in sorted(assignments.items())
    ]
    exact_family_isolation_ids: dict[str, set[str]] = {}
    for instance_id, family_id in instance_exact_families.items():
        exact_family_isolation_ids.setdefault(family_id, set()).add(
            instance_isolation_families[instance_id]
        )
    if any(len(values) != 1 for values in exact_family_isolation_ids.values()):
        raise RuntimeError("an exact family was split across multiple audio isolation families")
    exact_family_rows = [
        {
            "familyId": family_id,
            "isolationFamilyId": next(iter(exact_family_isolation_ids[family_id])),
            "assignmentKey": instance_assignment_keys[exact_families[family_id][0]],
            "trackCount": len(exact_families[family_id]),
        }
        for family_id in sorted(exact_families)
    ]
    truth_source_digest = canonical_json_sha256(truth_sources)
    registry_sha256 = _registry_source_sha256(registry["payload"])
    assignment_manifest = sorted(
        (
            {
                "assignmentKey": next(
                    iter(isolation_assignment_keys[isolation_family_id])
                ),
                "exactFamilyIds": sorted(isolation_exact_families[isolation_family_id]),
                "split": split,
            }
            for isolation_family_id, split in assignments.items()
        ),
        key=lambda row: row["assignmentKey"],
    )
    assignment_digest_sha256 = canonical_json_sha256(assignment_manifest)
    split_assignments_sha256 = canonical_json_sha256(
        {
            "seed": seed,
            "audioIsolationPolicySha256": audio_isolation["policySha256"],
            "assignmentDigestSha256": assignment_digest_sha256,
        }
    )
    parent_split_metadata = {
        "registrySha256": registry_sha256,
        "truthSourcesSha256": truth_source_digest,
        "seed": seed,
        "tuneRatio": tune_ratio,
        "holdoutRatio": holdout_ratio,
        "audioIsolationPolicySha256": str(audio_isolation["policySha256"]),
        "assignmentDigestSha256": assignment_digest_sha256,
        "splitAssignmentsSha256": split_assignments_sha256,
    }
    batch_evidence_policies = {
        str(source.get("batchId") or ""): source.get("evidencePolicy") or {}
        for source in truth_sources
        if str(source.get("batchId") or "")
    }
    primary_batch_count = sum(
        1
        for batch_id in batches
        if bool(
            (batch_evidence_policies.get(batch_id) or {}).get(
                "primaryEvaluationEligible", False
            )
        )
    )
    return {
        "type": "rkb-rekordbox-dataset-splits",
        "version": 4,
        "seed": seed,
        "identityKey": "instanceId",
        "groupKey": "isolationFamilyId",
        "truthSources": truth_sources,
        "truthSourcesSha256": truth_source_digest,
        "registryPath": str(registry_path.resolve()),
        "registrySha256": registry_sha256,
        "assignmentDigestSha256": assignment_digest_sha256,
        "splitAssignmentsSha256": split_assignments_sha256,
        "splitPolicy": {
            "seed": seed,
            "instanceKey": "normalized batchId + raw asset sha256",
            "truthJoinKey": "normalized fileName within immutable batchId",
            "exactFamilyKey": "immutable Chromaprint familyId",
            "groupKey": "audio-only isolationFamilyId",
            "assignmentKey": "sha256(canonical sorted component exactFamilyIds)",
            "assignmentDigestSha256": assignment_digest_sha256,
            "splitAssignmentsSha256": split_assignments_sha256,
            "audioIsolationRegistryScope": "batchStatus=consumed",
            "audioIsolationPolicySha256": audio_isolation["policySha256"],
            "audioIsolationUsesTruthOrOutcome": False,
            "batchKey": "immutable batchId",
            "categoryOrPredictionUsed": False,
            "tuneRatio": tune_ratio,
            "holdoutRatio": holdout_ratio,
            "loboInnerTuneRatio": tune_ratio,
            "outerHoldoutMayTuneRules": False,
        },
        "summary": {
            "trackCount": len(all_instances),
            "familyCount": len(isolation_families),
            "isolationFamilyCount": len(isolation_families),
            "exactFamilyCount": len(exact_families),
            "batchCount": len(batches),
            "primaryEvaluationBatchCount": primary_batch_count,
            "diagnosticOnlyBatchCount": len(batches) - primary_batch_count,
            "excludedNonConsumedBatchCount": len(excluded_batches),
            "crossBatchFamilyCount": len(cross_batch_isolation_families),
            "crossBatchIsolationFamilyCount": len(cross_batch_isolation_families),
            "train": len(split_instances["train"]),
            "tune": len(split_instances["tune"]),
            "holdout": len(split_instances["holdout"]),
        },
        "excludedNonConsumedBatches": excluded_batches,
        "batchEvidencePolicies": batch_evidence_policies,
        "audioIsolationRegistryScope": "batchStatus=consumed",
        "audioIsolationPolicy": audio_isolation["policy"],
        "audioIsolationPolicySha256": audio_isolation["policySha256"],
        "audioIsolationStats": audio_isolation["stats"],
        "instances": identity_rows,
        "families": family_rows,
        "exactFamilies": exact_family_rows,
        "crossBatchFamilies": [
            {
                "isolationFamilyId": isolation_family_id,
                "assignmentKey": next(
                    iter(isolation_assignment_keys[isolation_family_id])
                ),
                "exactFamilyIds": sorted(isolation_exact_families[isolation_family_id]),
                "batchIds": batch_ids,
                "trackCount": len(isolation_families[isolation_family_id]),
            }
            for isolation_family_id, batch_ids in sorted(
                cross_batch_isolation_families.items()
            )
        ],
        "batches": [
            {
                "batchId": batch_id,
                "trackCount": len(batch_instances),
                "instances": batch_instances,
            }
            for batch_id, batch_instances in sorted(
                batches.items(), key=lambda item: item[0].casefold()
            )
        ],
        "splits": split_instances,
        "leaveOneBatchOut": _build_lobo(
            batches=batches,
            all_instances=all_instances,
            instance_isolation_families=instance_isolation_families,
            instance_assignment_keys=instance_assignment_keys,
            batch_evidence_policies=batch_evidence_policies,
            seed=seed,
            tune_ratio=tune_ratio,
        ),
        "truthSplits": {
            split: _build_split_truth(
                [tracks_by_instance[instance_id] for instance_id in split_instances[split]],
                split,
                truth_sources,
                parent_split_metadata,
            )
            for split in ("train", "tune", "holdout")
        },
    }


def _validate_output_contract(
    *,
    output_path: Path,
    write_truth_files: bool,
    seed: str,
    tune_ratio: float,
    holdout_ratio: float,
    truth_path: Path | None = None,
    truth_batch_id: str = "",
    registry_path: Path = DEFAULT_REGISTRY,
    batches_root: Path | None = None,
) -> bool:
    if output_path.resolve() != DEFAULT_OUTPUT.resolve():
        return False
    if not write_truth_files:
        raise RuntimeError(
            "--no-write-truth-files requires a non-canonical diagnostic --output path"
        )
    if truth_path is not None or truth_batch_id:
        raise RuntimeError(
            "canonical split output forbids --truth and --truth-batch-id; "
            "use the complete authoritative consumed registry"
        )
    if registry_path.resolve() != DEFAULT_REGISTRY.resolve():
        raise RuntimeError("canonical split output requires the default dataset registry")
    if batches_root is not None and batches_root.resolve() != DEFAULT_BATCHES_ROOT.resolve():
        raise RuntimeError("canonical split output requires the default sealed batches root")
    if (
        seed != CANONICAL_SEED
        or tune_ratio != CANONICAL_TUNE_RATIO
        or holdout_ratio != CANONICAL_HOLDOUT_RATIO
    ):
        raise RuntimeError(
            "canonical split output requires the locked seed/tune/holdout policy; "
            "use a non-canonical diagnostic --output for protocol experiments"
        )
    return True


def _prepare_canonical_registry(
    *, use_auto_root_remap: bool = True
) -> tuple[dict[str, Any], dict[str, Any]]:
    rebuilt = rebuild_registry(
        DEFAULT_BATCHES_ROOT,
        DEFAULT_REGISTRY,
        baseline_path=DEFAULT_BASELINE,
        use_auto_root_remap=use_auto_root_remap,
    )
    verified, baseline = verify_registry_baseline(
        batches_root=DEFAULT_BATCHES_ROOT,
        registry_path=DEFAULT_REGISTRY,
        baseline_path=DEFAULT_BASELINE,
    )
    if _registry_source_sha256(rebuilt) != _registry_source_sha256(verified):
        raise RuntimeError("rebuilt dataset registry changed before baseline verification")
    return verified, baseline


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Build immutable-instance, family-safe and leave-one-batch-out splits for Rekordbox grid validation"
        )
    )
    parser.add_argument(
        "--truth",
        default="",
        help="Optional explicit truth subset. Omit to load every consumed sealed-batches/<batchId>/truth.json.",
    )
    parser.add_argument(
        "--truth-batch-id",
        default="",
        help="Batch identity for an explicit legacy truth file whose tracks do not contain instanceId.",
    )
    parser.add_argument("--registry", default=str(DEFAULT_REGISTRY))
    parser.add_argument("--batches-root", default="")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--seed", default=CANONICAL_SEED)
    parser.add_argument("--tune-ratio", type=float, default=CANONICAL_TUNE_RATIO)
    parser.add_argument("--holdout-ratio", type=float, default=CANONICAL_HOLDOUT_RATIO)
    parser.add_argument(
        "--root-remap",
        default="",
        help="Omit to auto-load the registry sidecar; pass none to use immutable sealed source paths.",
    )
    truth_output_group = parser.add_mutually_exclusive_group()
    truth_output_group.add_argument(
        "--write-truth-files",
        dest="write_truth_files",
        action="store_true",
        help="Write the three derived truth files (default).",
    )
    truth_output_group.add_argument(
        "--no-write-truth-files",
        dest="write_truth_files",
        action="store_false",
        help="Diagnostic-only: write just a non-canonical main split output.",
    )
    parser.set_defaults(write_truth_files=True)
    args = parser.parse_args()

    truth_value = str(args.truth or "").strip()
    disable_auto_root_remap = str(args.root_remap or "").strip().casefold() == "none"
    batches_root_value = str(args.batches_root or "").strip()
    output_path = Path(args.output)
    truth_path = Path(truth_value) if truth_value else None
    registry_path = Path(args.registry)
    batches_root = Path(batches_root_value) if batches_root_value else None
    canonical_output = _validate_output_contract(
        output_path=output_path,
        write_truth_files=bool(args.write_truth_files),
        seed=str(args.seed),
        tune_ratio=float(args.tune_ratio),
        holdout_ratio=float(args.holdout_ratio),
        truth_path=truth_path,
        truth_batch_id=str(args.truth_batch_id or "").strip(),
        registry_path=registry_path,
        batches_root=batches_root,
    )
    authoritative_registry = None
    baseline_payload = None
    if canonical_output:
        authoritative_registry, baseline_payload = _prepare_canonical_registry(
            use_auto_root_remap=not disable_auto_root_remap
        )
        batches_root = DEFAULT_BATCHES_ROOT
    payload = build_splits(
        truth_path,
        registry_path,
        batches_root=batches_root,
        truth_batch_id=str(args.truth_batch_id or "").strip(),
        authoritative_registry_payload=authoritative_registry,
        baseline_payload=baseline_payload,
        use_auto_root_remap=not disable_auto_root_remap,
        seed=str(args.seed),
        tune_ratio=float(args.tune_ratio),
        holdout_ratio=float(args.holdout_ratio),
    )
    truth_splits = payload.pop("truthSplits")
    _write_json(output_path, payload)
    if args.write_truth_files:
        parent_split_path = str(output_path.resolve())
        parent_split_sha256 = _sha256_file(output_path)
        for split, split_payload in truth_splits.items():
            split_payload["parentSplit"].update(
                {
                    "parentSplitPath": parent_split_path,
                    "parentSplitFileSha256": parent_split_sha256,
                }
            )
            split_path = output_path.with_name(f"{output_path.stem}-{split}-truth.json")
            _write_json(split_path, split_payload)
    print(
        json.dumps(
            {"output": str(output_path), "summary": payload["summary"]},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
