import copy
import json
from pathlib import Path
from typing import Any

import numpy as np

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_beatgrid_lab_common import (
    build_feature_index_map,
    read_feature_metadata,
    resolve_feature_arrays_path,
    resolve_feature_entry,
)
from rkb_constant_grid_dp_lab import _evaluate_result
from rkb_constant_grid_dp_solver import solve_constant_grid_dp
from rkb_dataset_contract import (
    normalize_name,
    normalize_path,
    registry_content_sha256,
    sha256_file,
    sha256_json,
    truth_roster_sha256,
    validate_truth_contract,
)
from rkb_nested_lobo_contract import NestedLoboError, read_json_object, write_json_atomic


FEATURE_CONTRACT_TYPE = "rkb-nested-lobo-feature-contract"
SUBSET_TRUTH_TYPE = "rkb-nested-lobo-truth-subset"
FEATURE_POLICY_FIELDS = {
    "featureCacheVersion",
    "sampleRate",
    "channels",
    "maxScanSec",
    "device",
    "checkpoint",
    "beatThisInference",
    "beatThisPreprocessing",
    "featureFunctions",
}


def _resolved_reference(value: Any, anchor: Path) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise NestedLoboError(f"path reference is empty in {anchor}")
    path = Path(raw)
    if not path.is_absolute():
        path = anchor.parent / path
    return path.resolve()


def _instance_map(split: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = split.get("instances")
    if not isinstance(rows, list) or not rows:
        raise NestedLoboError("split contains no instances")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise NestedLoboError("split contains an invalid instance")
        instance_id = str(row.get("instanceId") or "").strip()
        key = instance_id.casefold()
        if not key or key in result:
            raise NestedLoboError(f"split contains invalid/duplicate instanceId: {instance_id}")
        result[key] = row
    return result


def load_truth_catalog(
    split_path: Path,
    split: dict[str, Any],
    *,
    instance_ids: list[str] | None = None,
) -> dict[str, dict[str, Any]]:
    registry_path = _resolved_reference(split.get("registryPath"), split_path)
    registry = read_json_object(registry_path)
    if registry_content_sha256(registry) != str(split.get("registrySha256") or ""):
        raise NestedLoboError("split registry content hash mismatch")
    sources = split.get("truthSources")
    if not isinstance(sources, list) or not sources:
        raise NestedLoboError("split contains no truthSources")
    if sha256_json(sources) != str(split.get("truthSourcesSha256") or ""):
        raise NestedLoboError("split truthSources hash mismatch")
    instances = _instance_map(split)
    if instance_ids is None:
        requested_keys = set(instances)
    else:
        requested_keys = {str(item).casefold() for item in instance_ids if str(item).strip()}
        if len(requested_keys) != len(instance_ids):
            raise NestedLoboError("truth subset contains invalid/duplicate instanceId")
        missing = requested_keys - set(instances)
        if missing:
            raise NestedLoboError(f"truth subset references unknown instanceId: {sorted(missing)[0]}")
    instances_by_batch: dict[str, list[dict[str, Any]]] = {}
    requested_by_batch: dict[str, list[dict[str, Any]]] = {}
    for key, row in instances.items():
        batch_id = str(row.get("batchId") or "").strip()
        instances_by_batch.setdefault(batch_id, []).append(row)
        if key in requested_keys:
            requested_by_batch.setdefault(batch_id, []).append(row)
    catalog: dict[str, dict[str, Any]] = {}
    seen_batches: set[str] = set()
    for source in sources:
        if not isinstance(source, dict):
            raise NestedLoboError("truthSources contains an invalid row")
        batch_id = str(source.get("batchId") or "").strip()
        if not batch_id or batch_id in seen_batches:
            raise NestedLoboError(f"truthSources contains invalid/duplicate batchId: {batch_id}")
        seen_batches.add(batch_id)
        batch_instances = instances_by_batch.get(batch_id) or []
        requested_instances = requested_by_batch.get(batch_id) or []
        if not requested_instances:
            continue
        source_path = _resolved_reference(source.get("path"), split_path)
        if not source_path.is_file() or sha256_file(source_path) != str(source.get("sha256") or ""):
            raise NestedLoboError(f"truth source changed or is missing: {source_path}")
        payload = read_json_object(source_path)
        tracks = payload.get("tracks")
        if not isinstance(tracks, list) or any(not isinstance(row, dict) for row in tracks):
            raise NestedLoboError(f"truth source tracks are invalid: {source_path}")
        if len(tracks) != int(source.get("trackCount") or -1):
            raise NestedLoboError(f"truth source count mismatch: {source_path}")
        truth_by_name: dict[str, dict[str, Any]] = {}
        for track in tracks:
            file_name = str(track.get("fileName") or "").strip()
            key = normalize_name(file_name)
            if not key or key in truth_by_name:
                raise NestedLoboError(f"truth source contains duplicate fileName: {batch_id}:{file_name}")
            truth_by_name[key] = track
        if len(batch_instances) != len(truth_by_name):
            raise NestedLoboError(
                f"split/truth source count mismatch for {batch_id}: "
                f"instances={len(batch_instances)}, truth={len(truth_by_name)}"
            )
        batch_names = {
            normalize_name(str(identity.get("fileName") or "").strip())
            for identity in batch_instances
        }
        if not all(batch_names) or batch_names != set(truth_by_name):
            raise NestedLoboError(f"truth source roster mismatch for {batch_id}")
        for identity in requested_instances:
            file_name = str(identity.get("fileName") or "").strip()
            name_key = normalize_name(file_name)
            truth = truth_by_name.get(name_key)
            if truth is None:
                raise NestedLoboError(f"split instance is missing from truth source: {batch_id}:{file_name}")
            instance_id = str(identity.get("instanceId") or "").strip()
            catalog[instance_id.casefold()] = {
                **truth,
                "instanceId": instance_id,
                "batchId": batch_id,
                "fileName": file_name,
                "assetSha256": str(identity.get("assetSha256") or ""),
                "pcmSha256": str(identity.get("pcmSha256") or ""),
                "familyId": str(identity.get("familyId") or ""),
                "isolationFamilyId": str(identity.get("isolationFamilyId") or ""),
                "assignmentKey": str(identity.get("assignmentKey") or ""),
                "sourcePath": str(identity.get("sourcePath") or ""),
            }
    if set(instances_by_batch) != seen_batches:
        raise NestedLoboError("truthSources batch roster does not cover the parent split")
    if requested_keys != set(catalog):
        raise NestedLoboError("truth catalog does not cover the requested split subset")
    return catalog


def _track_with_time_basis(
    track: dict[str, Any], ffprobe_path: Path, cache: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    instance_id = str(track.get("instanceId") or "").casefold()
    cached = cache.get(instance_id)
    if cached is not None:
        return {**track, "timeBasis": cached}
    existing = track.get("timeBasis")
    if isinstance(existing, dict):
        time_basis = existing
    else:
        source_path = Path(str(track.get("sourcePath") or ""))
        if not source_path.is_file():
            raise NestedLoboError(f"truth sourcePath is missing: {track.get('instanceId')}:{source_path}")
        time_basis = benchmark._probe_time_basis(ffprobe_path, source_path)
    cache[instance_id] = time_basis
    return {**track, "timeBasis": time_basis}


def materialize_subset_truth(
    *,
    instance_ids: list[str],
    catalog: dict[str, dict[str, Any]],
    output_path: Path,
    split_path: Path,
    split_sha256: str,
    fold_batch_id: str,
    role: str,
    membership_sha256: str,
    ffprobe_path: Path,
    time_basis_cache: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    tracks: list[dict[str, Any]] = []
    for instance_id in sorted(instance_ids, key=str.casefold):
        track = catalog.get(instance_id.casefold())
        if track is None:
            raise NestedLoboError(f"subset instance is absent from truth catalog: {instance_id}")
        tracks.append(_track_with_time_basis(track, ffprobe_path, time_basis_cache))
    payload = {
        "schemaVersion": 1,
        "type": SUBSET_TRUTH_TYPE,
        "trackCount": len(tracks),
        "nestedLoboSubset": {
            "parentSplitPath": normalize_path(split_path),
            "parentSplitFileSha256": split_sha256,
            "foldBatchId": fold_batch_id,
            "role": role,
            "membershipSha256": membership_sha256,
        },
        "tracks": tracks,
    }
    write_json_atomic(output_path, payload)
    contract = validate_truth_contract(output_path, payload)
    if contract["rosterSha256"] != truth_roster_sha256(tracks):
        raise NestedLoboError("materialized subset truth roster hash mismatch")
    return payload, contract, tracks


def _feature_contract_candidate(
    *,
    cache_dir: Path,
    track: dict[str, Any],
    index_map: dict[str, Any],
) -> dict[str, Any] | None:
    entry = resolve_feature_entry(track=track, index_map=index_map)
    if entry is None:
        return None
    metadata_path = cache_dir / str(entry.get("metadataPath") or "")
    try:
        metadata = read_feature_metadata(cache_dir, entry, track=track)
    except RuntimeError as error:
        raise NestedLoboError(
            f"feature cache index matched stale/conflicting identity for "
            f"{track.get('instanceId')}: {cache_dir}: {error}"
        ) from error
    arrays_path = resolve_feature_arrays_path(cache_dir, entry, metadata)
    if not metadata_path.is_file() or not arrays_path.is_file():
        raise NestedLoboError(f"feature cache members are missing: {track.get('instanceId')}")
    cache_payload = metadata.get("cachePayload")
    if not isinstance(cache_payload, dict) or not FEATURE_POLICY_FIELDS.issubset(cache_payload):
        missing = sorted(FEATURE_POLICY_FIELDS - set(cache_payload or {}))
        raise NestedLoboError(
            f"feature cache lacks a complete generation policy for {track.get('instanceId')}: {missing}"
        )
    feature_policy = {
        key: copy.deepcopy(value) for key, value in cache_payload.items() if key != "audioFile"
    }
    policy_sha256 = sha256_json(feature_policy)
    row = {
        "instanceId": str(track.get("instanceId") or ""),
        "batchId": str(track.get("batchId") or ""),
        "assetSha256": str(track.get("assetSha256") or ""),
        "pcmSha256": str(track.get("pcmSha256") or ""),
        "familyId": str(track.get("familyId") or ""),
        "sourcePath": normalize_path(track.get("sourcePath")),
        "cacheKey": str(metadata.get("cacheKey") or entry.get("cacheKey") or ""),
        "cacheDir": normalize_path(cache_dir),
        "metadataPath": normalize_path(metadata_path),
        "metadataSha256": sha256_file(metadata_path),
        "arraysPath": normalize_path(arrays_path),
        "arraysSha256": sha256_file(arrays_path),
        "featureGenerationPolicySha256": policy_sha256,
    }
    return {
        **row,
        "featureProofSha256": sha256_json(row),
        "_featureGenerationPolicy": feature_policy,
    }


def _feature_contract_row(
    *,
    cache_dirs: list[Path],
    track: dict[str, Any],
    index_maps: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    candidates = [
        candidate
        for cache_dir in cache_dirs
        if (
            candidate := _feature_contract_candidate(
                cache_dir=cache_dir,
                track=track,
                index_map=index_maps[normalize_path(cache_dir)],
            )
        )
        is not None
    ]
    if not candidates:
        raise NestedLoboError(f"feature caches are missing strong identity: {track.get('instanceId')}")
    proof_keys = {
        sha256_json(
            {
                key: value
                for key, value in candidate.items()
                if key not in {
                    "cacheDir",
                    "metadataPath",
                    "arraysPath",
                    "featureProofSha256",
                    "_featureGenerationPolicy",
                }
            }
        )
        for candidate in candidates
    }
    if len(proof_keys) != 1:
        raise NestedLoboError(
            f"feature caches contain conflicting proofs for {track.get('instanceId')}"
        )
    return min(candidates, key=lambda item: str(item["metadataPath"]).casefold())


def build_feature_contract(
    *,
    cache_dirs: list[Path],
    instance_ids: list[str],
    catalog: dict[str, dict[str, Any]],
    output_path: Path,
    scope: str,
) -> dict[str, Any]:
    normalized_dirs = sorted(
        {normalize_path(path): path.resolve() for path in cache_dirs}.values(),
        key=lambda path: normalize_path(path),
    )
    if not normalized_dirs:
        raise NestedLoboError("at least one feature cache directory is required")
    index_maps: dict[str, dict[str, Any]] = {}
    indexes: list[dict[str, Any]] = []
    for cache_dir in normalized_dirs:
        index_path = cache_dir / "index.json"
        if not index_path.is_file():
            raise NestedLoboError(f"feature cache index is missing: {index_path}")
        index_maps[normalize_path(cache_dir)] = build_feature_index_map(cache_dir)
        indexes.append(
            {
                "cacheDir": normalize_path(cache_dir),
                "indexPath": normalize_path(index_path),
                "indexSha256": sha256_file(index_path),
            }
        )
    rows_with_policy = [
        _feature_contract_row(
            cache_dirs=normalized_dirs,
            track=catalog[instance_id.casefold()],
            index_maps=index_maps,
        )
        for instance_id in sorted(instance_ids, key=str.casefold)
    ]
    policies: dict[str, dict[str, Any]] = {}
    rows: list[dict[str, Any]] = []
    for row in rows_with_policy:
        policy = row.pop("_featureGenerationPolicy")
        policy_sha256 = str(row.get("featureGenerationPolicySha256") or "")
        if policy_sha256 != sha256_json(policy):
            raise NestedLoboError("feature generation policy digest mismatch during contract build")
        policies[policy_sha256] = policy
        rows.append(row)
    if len(policies) != 1:
        raise NestedLoboError(
            "primary feature caches were generated under different policies/checkpoints"
        )
    feature_policy_sha256, feature_policy = next(iter(policies.items()))
    payload = {
        "schemaVersion": 1,
        "type": FEATURE_CONTRACT_TYPE,
        "scope": scope,
        "cacheDirs": [normalize_path(path) for path in normalized_dirs],
        "indexes": indexes,
        "featureGenerationPolicy": feature_policy,
        "featureGenerationPolicySha256": feature_policy_sha256,
        "trackCount": len(rows),
        "rows": rows,
    }
    locked = {**payload, "featureContractSha256": sha256_json(payload)}
    write_json_atomic(output_path, locked)
    return locked


def validate_feature_contract(
    payload: dict[str, Any],
    *,
    expected_instance_ids: list[str],
) -> dict[str, dict[str, Any]]:
    if payload.get("type") != FEATURE_CONTRACT_TYPE:
        raise NestedLoboError("feature contract has an invalid type")
    stored = {key: value for key, value in payload.items() if key != "featureContractSha256"}
    if payload.get("featureContractSha256") != sha256_json(stored):
        raise NestedLoboError("feature contract digest mismatch")
    feature_policy = payload.get("featureGenerationPolicy")
    feature_policy_sha256 = str(payload.get("featureGenerationPolicySha256") or "")
    if (
        not isinstance(feature_policy, dict)
        or feature_policy_sha256 != sha256_json(feature_policy)
        or not FEATURE_POLICY_FIELDS.issubset(feature_policy)
        or "audioFile" in feature_policy
    ):
        raise NestedLoboError("feature contract generation policy is invalid")
    raw_cache_dirs = payload.get("cacheDirs")
    raw_indexes = payload.get("indexes")
    if (
        not isinstance(raw_cache_dirs, list)
        or not raw_cache_dirs
        or any(not str(item or "").strip() for item in raw_cache_dirs)
        or not isinstance(raw_indexes, list)
    ):
        raise NestedLoboError("feature contract cache/index roster is invalid")
    cache_dirs = [Path(str(item)).resolve() for item in raw_cache_dirs]
    normalized_cache_dirs = [normalize_path(path) for path in cache_dirs]
    if normalized_cache_dirs != sorted(set(normalized_cache_dirs)):
        raise NestedLoboError("feature contract cacheDirs are not unique and deterministic")
    expected_indexes: list[dict[str, Any]] = []
    index_maps: dict[str, dict[str, Any]] = {}
    for cache_dir in cache_dirs:
        index_path = (cache_dir / "index.json").resolve()
        if not index_path.is_file():
            raise NestedLoboError(f"feature cache index is missing: {index_path}")
        cache_key = normalize_path(cache_dir)
        expected_indexes.append(
            {
                "cacheDir": cache_key,
                "indexPath": normalize_path(index_path),
                "indexSha256": sha256_file(index_path),
            }
        )
        index_maps[cache_key] = build_feature_index_map(cache_dir)
    if raw_indexes != expected_indexes:
        raise NestedLoboError("feature contract cache index signatures changed")
    rows = payload.get("rows")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise NestedLoboError("feature contract rows are invalid")
    expected = sorted(str(item).casefold() for item in expected_instance_ids)
    actual = sorted(str(row.get("instanceId") or "").casefold() for row in rows)
    if actual != expected or len(set(actual)) != len(actual):
        raise NestedLoboError("feature contract identity roster mismatch")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        cache_dir = Path(str(row.get("cacheDir") or "")).resolve()
        cache_key = normalize_path(cache_dir)
        if cache_key not in index_maps:
            raise NestedLoboError(f"feature row references an unregistered cache: {row.get('instanceId')}")
        metadata_path = Path(str(row.get("metadataPath") or "")).resolve()
        arrays_path = Path(str(row.get("arraysPath") or "")).resolve()
        try:
            metadata_path.relative_to(cache_dir)
            arrays_path.relative_to(cache_dir)
        except ValueError as error:
            raise NestedLoboError(
                f"feature row escapes its cache directory: {row.get('instanceId')}"
            ) from error
        projection = {key: value for key, value in row.items() if key != "featureProofSha256"}
        if row.get("featureProofSha256") != sha256_json(projection):
            raise NestedLoboError(f"feature row proof mismatch: {row.get('instanceId')}")
        if not metadata_path.is_file() or sha256_file(metadata_path) != row.get("metadataSha256"):
            raise NestedLoboError(f"feature metadata changed: {row.get('instanceId')}")
        if not arrays_path.is_file() or sha256_file(arrays_path) != row.get("arraysSha256"):
            raise NestedLoboError(f"feature arrays changed: {row.get('instanceId')}")
        entry = resolve_feature_entry(track=row, index_map=index_maps[cache_key])
        if entry is None:
            raise NestedLoboError(f"feature row disappeared from its cache index: {row.get('instanceId')}")
        try:
            metadata = read_feature_metadata(cache_dir, entry, track=row)
        except RuntimeError as error:
            raise NestedLoboError(
                f"feature row identity no longer validates: {row.get('instanceId')}: {error}"
            ) from error
        resolved_metadata = (cache_dir / str(entry.get("metadataPath") or "")).resolve()
        resolved_arrays = resolve_feature_arrays_path(cache_dir, entry, metadata).resolve()
        if resolved_metadata != metadata_path or resolved_arrays != arrays_path:
            raise NestedLoboError(
                f"feature row paths no longer match the cache index: {row.get('instanceId')}"
            )
        cache_payload = metadata.get("cachePayload")
        if not isinstance(cache_payload, dict):
            raise NestedLoboError(f"feature row has no cachePayload: {row.get('instanceId')}")
        current_policy = {
            key: copy.deepcopy(value) for key, value in cache_payload.items() if key != "audioFile"
        }
        if (
            sha256_json(current_policy) != feature_policy_sha256
            or row.get("featureGenerationPolicySha256") != feature_policy_sha256
        ):
            raise NestedLoboError(
                f"feature row was generated under a conflicting policy: {row.get('instanceId')}"
            )
        result[str(row["instanceId"]).casefold()] = row
    return result


def _solver_kwargs(candidate: dict[str, Any]) -> dict[str, Any]:
    parameters = candidate["parameters"]
    return {
        "min_bpm": float(parameters["minBpm"]),
        "max_bpm": float(parameters["maxBpm"]),
        "tempo_step_bpm": float(parameters["tempoStepBpm"]),
        "tempo_limit": int(parameters["tempoLimit"]),
        "phase_step_ms": float(parameters["phaseStepMs"]),
        "max_candidates": int(parameters["maxCandidates"]),
    }


def _compact_analysis(analysis: dict[str, Any], truth: dict[str, Any]) -> dict[str, Any]:
    timeline = _evaluate_result(analysis=analysis, truth=truth)
    return {
        "category": timeline["category"],
        "bpm": round(float(analysis["bpm"]), 6),
        "firstBeatMs": round(float(analysis["firstBeatMs"]), 3),
        "barBeatOffset": int(analysis["barBeatOffset"]) % 32,
        "bpmOnlyDrift128BeatsMs": timeline["bpmOnlyDrift128BeatsMs"],
        "firstBeatPhaseAbsErrorMs": timeline["firstBeatPhaseAbsErrorMs"],
        "gridMaxAbsMs": timeline["gridMaxAbsMs"],
        "barBeatOffsetMatchedMod4": bool(timeline["barBeatOffsetMatchedMod4"]),
        "bpmBigError": abs(float(timeline["bpmOnlyDrift128BeatsMs"]))
        > benchmark.STRICT_TOLERANCE_MS,
        "downbeatFailure": not bool(timeline["barBeatOffsetMatchedMod4"]),
        "selectedSource": str(analysis.get("gridSolverSelectedSource") or ""),
        "hadError": False,
        "error": None,
    }


def _error_analysis(error: Exception) -> dict[str, Any]:
    return {
        "category": "error",
        "bpm": None,
        "firstBeatMs": None,
        "barBeatOffset": None,
        "bpmOnlyDrift128BeatsMs": None,
        "firstBeatPhaseAbsErrorMs": None,
        "gridMaxAbsMs": None,
        "barBeatOffsetMatchedMod4": False,
        "bpmBigError": True,
        "downbeatFailure": True,
        "selectedSource": "",
        "hadError": True,
        "error": f"{type(error).__name__}: {error}",
    }


def _switched(baseline: dict[str, Any], selected: dict[str, Any]) -> bool:
    baseline_error = baseline.get("hadError") is True or baseline.get("category") == "error"
    selected_error = selected.get("hadError") is True or selected.get("category") == "error"
    if baseline_error or selected_error:
        return baseline_error != selected_error
    return (
        abs(float(baseline["bpm"]) - float(selected["bpm"])) > 0.000001
        or abs(float(baseline["firstBeatMs"]) - float(selected["firstBeatMs"])) > 0.5
        or int(baseline["barBeatOffset"]) % 4 != int(selected["barBeatOffset"]) % 4
    )


def evaluate_fixed_configs(
    *,
    tracks: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    feature_contract_rows: dict[str, dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    baseline_candidates = [candidate for candidate in candidates if candidate.get("isNoOp") is True]
    if len(baseline_candidates) != 1:
        raise NestedLoboError("evaluation requires exactly one no-op baseline candidate")
    baseline_config = baseline_candidates[0]
    output: dict[str, list[dict[str, Any]]] = {
        str(candidate["configSha256"]): [] for candidate in candidates
    }
    for track in tracks:
        instance_key = str(track.get("instanceId") or "").casefold()
        proof = feature_contract_rows.get(instance_key)
        if proof is None:
            raise NestedLoboError(f"feature contract misses evaluation track: {track.get('instanceId')}")
        metadata_path = Path(str(proof["metadataPath"]))
        arrays_path = Path(str(proof["arraysPath"]))
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        analyses: dict[str, dict[str, Any]] = {}
        with np.load(arrays_path, allow_pickle=False) as arrays:
            for candidate in candidates:
                config_sha256 = str(candidate["configSha256"])
                try:
                    analysis = solve_constant_grid_dp(
                        metadata=metadata,
                        arrays=arrays,
                        **_solver_kwargs(candidate),
                    )
                    analyses[config_sha256] = _compact_analysis(analysis, track)
                except Exception as error:
                    analyses[config_sha256] = _error_analysis(error)
        baseline = analyses[str(baseline_config["configSha256"])]
        for candidate in candidates:
            config_sha256 = str(candidate["configSha256"])
            selected = analyses[config_sha256]
            output[config_sha256].append(
                {
                    "instanceId": str(track.get("instanceId") or ""),
                    "batchId": str(track.get("batchId") or ""),
                    "fileName": str(track.get("fileName") or ""),
                    "assetSha256": str(track.get("assetSha256") or ""),
                    "pcmSha256": str(track.get("pcmSha256") or ""),
                    "familyId": str(track.get("familyId") or ""),
                    "isolationFamilyId": str(track.get("isolationFamilyId") or ""),
                    "sourcePath": str(track.get("sourcePath") or ""),
                    "featureProofSha256": str(proof["featureProofSha256"]),
                    "baseline": copy.deepcopy(baseline),
                    "selected": copy.deepcopy(selected),
                    "switched": _switched(baseline, selected),
                }
            )
    return output
