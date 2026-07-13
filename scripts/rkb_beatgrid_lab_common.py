import json
import math
import os
import time
from pathlib import Path
from typing import Any

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_dataset_contract import validate_truth_contract

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_FEATURE_CACHE_DIR = BENCHMARK_OUTPUT_DIR / "feature-cache"
DEFAULT_CANDIDATE_LAB_OUTPUT = BENCHMARK_OUTPUT_DIR / "hybrid-candidate-lab-latest.json"
DEFAULT_BASELINE = BENCHMARK_OUTPUT_DIR / "frkb-current-latest.json"
FEATURE_CACHE_VERSION = 2
FEATURE_INDEX_NAME = "index.json"


def configure_utf8_stdio() -> None:
    try:
        import sys

        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def normalize_lookup_key(value: Any) -> str:
    return benchmark._normalize_lookup_key(value)


def track_identity_key(track: dict[str, Any]) -> str:
    instance_id = str(track.get("instanceId") or "").strip().casefold()
    if instance_id:
        return f"instance:{instance_id}"
    lookup_key = normalize_lookup_key(track.get("fileName"))
    return f"file:{lookup_key}" if lookup_key else ""


def to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def parse_audio_roots(value: str) -> list[Path]:
    return benchmark._parse_audio_roots(value)


def _load_raw_truth_tracks(truth_path: Path) -> list[dict[str, Any]]:
    payload = json.loads(truth_path.read_text(encoding="utf-8"))
    validate_truth_contract(truth_path, payload)
    tracks = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(tracks, list) or not tracks:
        raise RuntimeError(f"truth contains no tracks: {truth_path}")
    return [item for item in tracks if isinstance(item, dict)]


def _prepare_truth_track(
    *,
    raw_track: dict[str, Any],
    audio_roots: list[Path],
    ffprobe_path: Path,
) -> dict[str, Any] | None:
    file_name = str(raw_track.get("fileName") or "").strip()
    if not file_name:
        return None
    bpm = to_float(raw_track.get("bpm"))
    first_beat_ms = to_float(raw_track.get("firstBeatMs"))
    if bpm is None or bpm <= 0.0 or first_beat_ms is None or first_beat_ms < 0.0:
        return None
    instance_id = str(raw_track.get("instanceId") or "").strip()
    source_path_value = str(raw_track.get("sourcePath") or "").strip()
    source_path = Path(source_path_value) if source_path_value else None
    if instance_id and source_path is None:
        raise RuntimeError(f"instance truth track is missing sourcePath: {instance_id}")
    if source_path is not None and not source_path.is_file():
        raise RuntimeError(f"truth sourcePath is not an existing file: {source_path}")
    file_path = source_path if source_path is not None else benchmark._resolve_audio_path(audio_roots, file_name)
    bar_beat_offset = benchmark._normalize_bar_offset(raw_track.get("barBeatOffset"), 32)
    first_beat_label = int(
        raw_track.get("firstBeatLabel")
        or benchmark._resolve_first_beat_label_from_offset(bar_beat_offset)
    )
    prepared = {
        "fileName": file_name,
        "filePath": str(file_path),
        "title": str(raw_track.get("title") or "").strip(),
        "artist": str(raw_track.get("artist") or "").strip(),
        "bpm": round(float(bpm), 6),
        "firstBeatMs": round(float(first_beat_ms), 3),
        "firstBeatLabel": first_beat_label,
        "barBeatOffset": bar_beat_offset,
        "fileExists": file_path.exists(),
        "timeBasis": (
            raw_track.get("timeBasis")
            if isinstance(raw_track.get("timeBasis"), dict)
            else benchmark._probe_time_basis(ffprobe_path, file_path) if file_path.exists() else None
        ),
    }
    for key in (
        "instanceId",
        "batchId",
        "assetSha256",
        "pcmSha256",
        "familyId",
        "isolationFamilyId",
        "sourcePath",
    ):
        value = raw_track.get(key)
        if value not in (None, ""):
            prepared[key] = value
    return prepared


def matches_only_filters(track: dict[str, Any], filters: list[str]) -> bool:
    if not filters:
        return True
    haystack = " ".join(
        [
            str(track.get("fileName") or ""),
            str(track.get("title") or ""),
            str(track.get("artist") or ""),
        ]
    ).lower()
    return any(item in haystack for item in filters)


def load_selected_truth_tracks(
    *,
    truth_path: Path,
    audio_root: str,
    ffprobe_path: Path,
    only_filters: list[str],
    limit: int,
) -> list[dict[str, Any]]:
    audio_roots = parse_audio_roots(audio_root)
    selected: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for raw_track in _load_raw_truth_tracks(truth_path):
        file_name = str(raw_track.get("fileName") or "").strip()
        identity_key = track_identity_key(raw_track)
        if not file_name or not identity_key or identity_key in seen_keys:
            continue
        if not matches_only_filters(raw_track, only_filters):
            continue
        prepared = _prepare_truth_track(
            raw_track=raw_track,
            audio_roots=audio_roots,
            ffprobe_path=ffprobe_path,
        )
        if prepared is None:
            continue
        seen_keys.add(identity_key)
        selected.append(prepared)
        if limit > 0 and len(selected) >= limit:
            break
    return selected


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def stable_hash(payload: dict[str, Any]) -> str:
    return benchmark._stable_cache_hash(payload)


def metadata_path_for_key(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / f"feature-{cache_key}.json"


def arrays_path_for_key(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / f"arrays-{cache_key}.npz"


def feature_index_path(cache_dir: Path) -> Path:
    return cache_dir / FEATURE_INDEX_NAME


def load_feature_index(cache_dir: Path) -> dict[str, Any]:
    path = feature_index_path(cache_dir)
    if not path.exists():
        return {"version": FEATURE_CACHE_VERSION, "updatedAt": 0.0, "entries": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"version": FEATURE_CACHE_VERSION, "updatedAt": 0.0, "entries": []}
    if not isinstance(payload, dict):
        return {"version": FEATURE_CACHE_VERSION, "updatedAt": 0.0, "entries": []}
    entries = payload.get("entries")
    if not isinstance(entries, list):
        payload["entries"] = []
    return payload


def write_feature_index(cache_dir: Path, entries: list[dict[str, Any]]) -> None:
    entries.sort(
        key=lambda item: (
            str(item.get("lookupKey") or ""),
            str(item.get("instanceId") or ""),
            str(item.get("cacheKey") or ""),
        )
    )
    atomic_write_json(
        feature_index_path(cache_dir),
        {
            "version": FEATURE_CACHE_VERSION,
            "updatedAt": round(time.time(), 3),
            "entries": entries,
        },
    )


def update_feature_index_entry(cache_dir: Path, entry: dict[str, Any]) -> None:
    payload = load_feature_index(cache_dir)
    entries = [item for item in payload.get("entries", []) if isinstance(item, dict)]
    lookup_key = str(entry.get("lookupKey") or "")
    instance_id = str(entry.get("instanceId") or "").strip().casefold()
    if instance_id:
        next_entries = [
            item
            for item in entries
            if str(item.get("instanceId") or "").strip().casefold() != instance_id
        ]
    else:
        next_entries = [
            item
            for item in entries
            if str(item.get("instanceId") or "").strip()
            or str(item.get("lookupKey") or "") != lookup_key
        ]
    next_entries.append(entry)
    write_feature_index(cache_dir, next_entries)


def build_feature_index_map(cache_dir: Path) -> dict[str, dict[str, Any]]:
    payload = load_feature_index(cache_dir)
    result: dict[str, dict[str, Any]] = {}
    by_lookup_key: dict[str, list[dict[str, Any]]] = {}
    for item in payload.get("entries", []):
        if not isinstance(item, dict):
            continue
        lookup_key = str(item.get("lookupKey") or "")
        if lookup_key:
            by_lookup_key.setdefault(lookup_key, []).append(item)
        instance_id = str(item.get("instanceId") or "").strip().casefold()
        if instance_id:
            result[f"instance:{instance_id}"] = item
        asset_sha256 = str(item.get("assetSha256") or "").strip().casefold()
        if asset_sha256:
            result[f"asset:{asset_sha256}"] = item
    for lookup_key, entries in by_lookup_key.items():
        unique_cache_keys = {str(item.get("cacheKey") or "") for item in entries}
        if len(entries) == 1 or len(unique_cache_keys) == 1:
            result[lookup_key] = entries[0]
            result[f"file:{lookup_key}"] = entries[0]
    return result


def resolve_feature_entry(
    *,
    track: dict[str, Any],
    index_map: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    identity_key = track_identity_key(track)
    if identity_key.startswith("instance:"):
        if identity_key in index_map:
            return index_map[identity_key]
        asset_sha256 = str(track.get("assetSha256") or "").strip().casefold()
        if asset_sha256:
            return index_map.get(f"asset:{asset_sha256}")
        return None
    lookup_key = normalize_lookup_key(track.get("fileName"))
    return index_map.get(f"file:{lookup_key}") or index_map.get(lookup_key)


def _normalized_identity_path(value: Any) -> str:
    raw_path = str(value or "").strip()
    if not raw_path:
        return ""
    return os.path.normcase(str(Path(raw_path).resolve()))


def _require_identity_match(
    *,
    owner: str,
    field: str,
    expected: str,
    actual: Any,
) -> None:
    actual_text = str(actual or "").strip()
    if not expected or actual_text.casefold() != expected.casefold():
        raise RuntimeError(
            f"feature cache {owner} {field} mismatch: expected {expected!r}, got {actual_text!r}"
        )


def _identity_proof_matches_track(
    *,
    proof: Any,
    track: dict[str, Any],
    metadata: dict[str, Any],
) -> bool:
    if not isinstance(proof, dict) or int(proof.get("schemaVersion") or 0) != 1:
        return False
    if str(proof.get("kind") or "") not in {
        "legacy-source-asset-sha256",
        "source-metadata-identity",
    }:
        return False
    if str(proof.get("sourceCacheKey") or "") != str(metadata.get("cacheKey") or ""):
        return False
    for field in ("batchId", "assetSha256", "pcmSha256", "familyId"):
        expected = str(track.get(field) or "").strip()
        if expected and str(proof.get(field) or "").strip().casefold() != expected.casefold():
            return False
    return True


def validate_feature_metadata_identity(
    *,
    track: dict[str, Any],
    entry: dict[str, Any],
    metadata: dict[str, Any],
) -> None:
    instance_id = str(track.get("instanceId") or "").strip()
    if not instance_id:
        return
    batch_id = str(track.get("batchId") or "").strip()
    asset_sha256 = str(track.get("assetSha256") or "").strip()
    if not batch_id or not asset_sha256:
        raise RuntimeError(
            f"instance track is missing batchId/assetSha256 identity: {instance_id!r}"
        )
    required_identity = {
        "instanceId": instance_id,
        "batchId": batch_id,
        "assetSha256": asset_sha256,
    }
    for field, expected in required_identity.items():
        _require_identity_match(owner="index", field=field, expected=expected, actual=entry.get(field))
        _require_identity_match(
            owner="metadata",
            field=field,
            expected=expected,
            actual=metadata.get(field),
        )
    for field in ("pcmSha256", "familyId", "isolationFamilyId"):
        expected = str(track.get(field) or "").strip()
        if expected:
            _require_identity_match(
                owner="metadata",
                field=field,
                expected=expected,
                actual=metadata.get(field),
            )

    track_audio_path = track.get("sourcePath") or track.get("filePath")
    if _normalized_identity_path(track_audio_path) != _normalized_identity_path(
        metadata.get("sourcePath")
    ):
        raise RuntimeError(
            f"feature cache metadata sourcePath mismatch for instance {instance_id!r}"
        )
    cache_payload = metadata.get("cachePayload")
    audio_file = cache_payload.get("audioFile") if isinstance(cache_payload, dict) else None
    cached_audio_path = audio_file.get("path") if isinstance(audio_file, dict) else None
    if (
        _normalized_identity_path(cached_audio_path)
        and _normalized_identity_path(cached_audio_path) == _normalized_identity_path(track_audio_path)
    ):
        return
    if _identity_proof_matches_track(
        proof=metadata.get("identityProof"),
        track=track,
        metadata=metadata,
    ):
        return
    raise RuntimeError(
        f"feature cache source identity proof missing for instance {instance_id!r}"
    )


def read_feature_metadata(
    cache_dir: Path,
    entry: dict[str, Any],
    *,
    track: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata_name = str(entry.get("metadataPath") or "").strip()
    if not metadata_name:
        metadata_name = metadata_path_for_key(cache_dir, str(entry.get("cacheKey") or "")).name
    path = cache_dir / metadata_name
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"invalid feature metadata: {path}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"invalid feature metadata: {path}")
    entry_cache_key = str(entry.get("cacheKey") or "").strip()
    metadata_cache_key = str(payload.get("cacheKey") or "").strip()
    if not entry_cache_key or metadata_cache_key != entry_cache_key:
        raise RuntimeError(
            f"feature metadata cacheKey mismatch: expected {entry_cache_key!r}, "
            f"got {metadata_cache_key!r}: {path}"
        )
    if track is not None:
        validate_feature_metadata_identity(track=track, entry=entry, metadata=payload)
    return payload


def validate_feature_cache_coverage(cache_dir: Path, tracks: list[dict[str, Any]]) -> int:
    expected: dict[str, dict[str, Any]] = {}
    for track in tracks:
        identity_key = track_identity_key(track)
        if not identity_key or identity_key in expected:
            raise RuntimeError(f"feature coverage has invalid truth identity: {identity_key}")
        expected[identity_key] = track
    entries: dict[str, dict[str, Any]] = {}
    for entry in load_feature_index(cache_dir).get("entries", []):
        if not isinstance(entry, dict):
            raise RuntimeError("feature index contains a non-object entry")
        identity_key = track_identity_key(entry)
        if not identity_key or identity_key in entries:
            raise RuntimeError(f"feature index has invalid or duplicate identity: {identity_key}")
        entries[identity_key] = entry
    if set(entries) != set(expected):
        raise RuntimeError("feature index identities do not exactly match selected truth tracks")
    for identity_key, track in expected.items():
        read_feature_metadata(cache_dir, entries[identity_key], track=track)
    return len(entries)


def resolve_feature_arrays_path(cache_dir: Path, entry: dict[str, Any], metadata: dict[str, Any]) -> Path:
    arrays_name = str(entry.get("arraysPath") or metadata.get("arraysPath") or "").strip()
    if not arrays_name:
        arrays_name = arrays_path_for_key(cache_dir, str(entry.get("cacheKey") or "")).name
    return cache_dir / arrays_name


def baseline_summary(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    summary = payload.get("summary") if isinstance(payload, dict) else None
    if not isinstance(summary, dict):
        return None
    oracle = summary.get("candidateOracle") if isinstance(summary.get("candidateOracle"), dict) else {}
    return {
        "trackTotal": summary.get("trackTotal"),
        "analyzedTrackCount": summary.get("analyzedTrackCount"),
        "errorTrackCount": summary.get("errorTrackCount"),
        "categoryCounts": summary.get("categoryCounts"),
        "candidateOracle": {
            "candidatePassCount": oracle.get("candidatePassCount"),
            "candidatePassRate": oracle.get("candidatePassRate"),
            "candidateMissCount": oracle.get("candidateMissCount"),
            "oracleSelectedFailCount": oracle.get("oracleSelectedFailCount"),
        },
        "bpmBigErrorCount": summary.get("bpmBigErrorCount"),
        "phaseFailCount": summary.get("phaseFailCount"),
        "downbeatMismatchMod4Count": summary.get("downbeatMismatchMod4Count"),
        "exact32OffsetMismatchCount": summary.get("exact32OffsetMismatchCount"),
    }


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
