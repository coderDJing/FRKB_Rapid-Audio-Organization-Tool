import argparse
import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import numpy as np

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_dataset_contract import sha256_file, sha256_json
from rkb_multiscale_spectral import (
    MULTISCALE_SPECTRAL_VERSION,
    array_stats,
    build_multiscale_spectral_flux,
    multiscale_spectral_policy,
)


SIDECAR_CACHE_VERSION = 1
INDEX_NAME = "index.json"


def _configure_utf8_stdio() -> None:
    try:
        import sys

        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"expected JSON object: {path}")
    return payload


def _source_paths(source_cache_dir: Path, entry: dict[str, Any]) -> tuple[Path, Path]:
    metadata_path = source_cache_dir / str(entry.get("metadataPath") or "")
    arrays_path = source_cache_dir / str(entry.get("arraysPath") or "")
    if not metadata_path.is_file() or not arrays_path.is_file():
        raise RuntimeError(f"source feature members are missing: {entry.get('instanceId')}")
    return metadata_path, arrays_path


def _asset_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _decode_signal(ffmpeg_path: Path, audio_path: Path) -> np.ndarray:
    pcm = benchmark._decode_pcm_window(ffmpeg_path, audio_path, benchmark.MAX_SCAN_SEC)
    values = np.frombuffer(pcm, dtype="<f4")
    channels = int(benchmark.CHANNELS)
    if values.size == 0 or channels <= 0 or values.size % channels != 0:
        raise RuntimeError(f"decoded PCM shape is invalid: {audio_path}")
    return values.reshape(-1, channels)


def _cache_payload(
    *,
    entry: dict[str, Any],
    audio_path: Path,
    asset_sha256: str,
    source_metadata_path: Path,
    source_arrays_path: Path,
) -> dict[str, Any]:
    stat = audio_path.stat()
    return {
        "sidecarCacheVersion": SIDECAR_CACHE_VERSION,
        "spectralPolicy": multiscale_spectral_policy(),
        "instanceId": str(entry.get("instanceId") or ""),
        "batchId": str(entry.get("batchId") or ""),
        "assetSha256": asset_sha256,
        "audioFile": {
            "path": str(audio_path.resolve()).replace("\\", "/").casefold(),
            "size": int(stat.st_size),
            "mtimeNs": int(stat.st_mtime_ns),
        },
        "sourceFeature": {
            "cacheKey": str(entry.get("cacheKey") or ""),
            "metadataSha256": sha256_file(source_metadata_path),
            "arraysSha256": sha256_file(source_arrays_path),
        },
    }


def _output_paths(output_cache_dir: Path, cache_key: str) -> tuple[Path, Path]:
    return (
        output_cache_dir / f"multiscale-{cache_key}.json",
        output_cache_dir / f"multiscale-{cache_key}.npz",
    )


def _existing_hit(metadata_path: Path, arrays_path: Path, cache_key: str) -> dict[str, Any] | None:
    if not metadata_path.is_file() or not arrays_path.is_file():
        return None
    try:
        metadata = _load_json(metadata_path)
    except (OSError, json.JSONDecodeError, RuntimeError):
        return None
    if metadata.get("cacheKey") != cache_key or metadata.get("spectralVersion") != MULTISCALE_SPECTRAL_VERSION:
        return None
    expected_arrays_sha256 = str(metadata.get("arraysSha256") or "")
    if not expected_arrays_sha256 or sha256_file(arrays_path) != expected_arrays_sha256:
        return None
    return metadata


def _write_arrays(path: Path, envelopes: dict[str, np.ndarray], frame_rate: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    with temporary.open("wb") as output:
        np.savez_compressed(
            output,
            frameRate=np.asarray(frame_rate, dtype="float32"),
            **{
                key: np.asarray(values, dtype="float16")
                for key, values in sorted(envelopes.items())
            },
        )
    temporary.replace(path)


def _index_entry(metadata: dict[str, Any], metadata_path: Path, arrays_path: Path) -> dict[str, Any]:
    return {
        "fileName": metadata["fileName"],
        "lookupKey": metadata["lookupKey"],
        "instanceId": metadata["instanceId"],
        "batchId": metadata["batchId"],
        "assetSha256": metadata["assetSha256"],
        "pcmSha256": metadata.get("pcmSha256"),
        "familyId": metadata.get("familyId"),
        "isolationFamilyId": metadata.get("isolationFamilyId"),
        "sourcePath": metadata["sourcePath"],
        "cacheKey": metadata["cacheKey"],
        "metadataPath": metadata_path.name,
        "arraysPath": arrays_path.name,
        "arraysSha256": metadata["arraysSha256"],
        "spectralVersion": metadata["spectralVersion"],
        "updatedAt": metadata["createdAt"],
    }


def _process_entry(
    *,
    entry: dict[str, Any],
    source_cache_dir: Path,
    output_cache_dir: Path,
    ffmpeg_path: Path,
    force: bool,
) -> dict[str, Any]:
    instance_id = str(entry.get("instanceId") or "").strip()
    source_path = Path(str(entry.get("sourcePath") or ""))
    if not instance_id or not source_path.is_file():
        raise RuntimeError(f"sidecar source identity is invalid: {instance_id}:{source_path}")
    expected_asset_sha256 = str(entry.get("assetSha256") or "").strip().casefold()
    actual_asset_sha256 = _asset_sha256(source_path)
    if not expected_asset_sha256 or actual_asset_sha256 != expected_asset_sha256:
        raise RuntimeError(f"asset SHA-256 mismatch: {instance_id}")
    source_metadata_path, source_arrays_path = _source_paths(source_cache_dir, entry)
    source_metadata = _load_json(source_metadata_path)
    if str(source_metadata.get("instanceId") or "").casefold() != instance_id.casefold():
        raise RuntimeError(f"source feature identity mismatch: {instance_id}")
    payload = _cache_payload(
        entry=entry,
        audio_path=source_path,
        asset_sha256=actual_asset_sha256,
        source_metadata_path=source_metadata_path,
        source_arrays_path=source_arrays_path,
    )
    cache_key = sha256_json(payload)
    metadata_path, arrays_path = _output_paths(output_cache_dir, cache_key)
    if not force and (metadata := _existing_hit(metadata_path, arrays_path, cache_key)) is not None:
        return {"status": "hit", "entry": _index_entry(metadata, metadata_path, arrays_path)}

    signal = _decode_signal(ffmpeg_path, source_path)
    envelopes, frame_rate = build_multiscale_spectral_flux(signal, benchmark.SAMPLE_RATE)
    if not envelopes:
        raise RuntimeError(f"multiscale extraction produced no envelopes: {instance_id}")
    _write_arrays(arrays_path, envelopes, frame_rate)
    arrays_sha256 = sha256_file(arrays_path)
    created_at = round(time.time(), 3)
    metadata = {
        "cacheKey": cache_key,
        "cachePayload": payload,
        "createdAt": created_at,
        "sidecarCacheVersion": SIDECAR_CACHE_VERSION,
        "spectralVersion": MULTISCALE_SPECTRAL_VERSION,
        "fileName": str(entry.get("fileName") or source_metadata.get("fileName") or ""),
        "lookupKey": str(entry.get("lookupKey") or source_metadata.get("lookupKey") or ""),
        "instanceId": instance_id,
        "batchId": str(entry.get("batchId") or ""),
        "assetSha256": actual_asset_sha256,
        "pcmSha256": entry.get("pcmSha256"),
        "familyId": entry.get("familyId"),
        "isolationFamilyId": entry.get("isolationFamilyId"),
        "sourcePath": str(source_path.resolve()),
        "arraysPath": arrays_path.name,
        "arraysSha256": arrays_sha256,
        "audio": {
            "sampleRate": int(benchmark.SAMPLE_RATE),
            "channels": int(benchmark.CHANNELS),
            "durationSec": round(signal.shape[0] / float(benchmark.SAMPLE_RATE), 3),
        },
        "spectral": {
            "frameRate": round(frame_rate, 6),
            "policy": multiscale_spectral_policy(),
            "arrays": {key: array_stats(values) for key, values in sorted(envelopes.items())},
        },
    }
    _atomic_write_json(metadata_path, metadata)
    return {"status": "miss", "entry": _index_entry(metadata, metadata_path, arrays_path)}


def _repair_output_hashes(output_cache_dir: Path) -> dict[str, Any]:
    index_path = output_cache_dir / INDEX_NAME
    index = _load_json(index_path)
    entries = index.get("entries")
    if not isinstance(entries, list):
        raise RuntimeError("multiscale output index has no entries")
    repaired = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        metadata_path = output_cache_dir / str(entry.get("metadataPath") or "")
        arrays_path = output_cache_dir / str(entry.get("arraysPath") or "")
        if not metadata_path.is_file() or not arrays_path.is_file():
            raise RuntimeError(f"multiscale output member is missing: {entry.get('instanceId')}")
        arrays_sha256 = sha256_file(arrays_path)
        metadata = _load_json(metadata_path)
        if metadata.get("arraysSha256") != arrays_sha256:
            metadata["arraysSha256"] = arrays_sha256
            _atomic_write_json(metadata_path, metadata)
            repaired += 1
        entry["arraysSha256"] = arrays_sha256
    index["entries"] = entries
    index["updatedAt"] = round(time.time(), 3)
    index["hashRepair"] = {
        "version": 1,
        "repairedMetadataCount": repaired,
        "completedAt": round(time.time(), 3),
    }
    _atomic_write_json(index_path, index)
    return {"entryCount": len(entries), "repairedMetadataCount": repaired}


def _rebuild_output_index(output_cache_dir: Path, source_index_path: Path) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for metadata_path in sorted(output_cache_dir.glob("multiscale-*.json")):
        metadata = _load_json(metadata_path)
        arrays_path = output_cache_dir / str(metadata.get("arraysPath") or "")
        if not arrays_path.is_file():
            raise RuntimeError(f"multiscale arrays are missing: {metadata.get('instanceId')}")
        arrays_sha256 = sha256_file(arrays_path)
        if metadata.get("arraysSha256") != arrays_sha256:
            raise RuntimeError(f"multiscale arrays SHA-256 mismatch: {metadata.get('instanceId')}")
        entries.append(_index_entry(metadata, metadata_path, arrays_path))
    instance_ids = [str(entry.get("instanceId") or "").casefold() for entry in entries]
    if not entries or len(set(instance_ids)) != len(instance_ids):
        raise RuntimeError("rebuilt multiscale index has empty/duplicate identities")
    entries.sort(key=lambda item: str(item.get("instanceId") or "").casefold())
    index_payload = {
        "schemaVersion": 1,
        "type": "rkb-multiscale-spectral-sidecar-index",
        "sidecarCacheVersion": SIDECAR_CACHE_VERSION,
        "spectralPolicy": multiscale_spectral_policy(),
        "sourceFeatureIndex": {
            "path": str(source_index_path).replace("\\", "/").casefold(),
            "sha256": sha256_file(source_index_path),
        },
        "entryCount": len(entries),
        "entries": entries,
        "stats": {"hit": len(entries), "miss": 0, "error": 0},
        "errors": [],
        "updatedAt": round(time.time(), 3),
        "rebuild": {"version": 1, "completedAt": round(time.time(), 3)},
    }
    _atomic_write_json(output_cache_dir / INDEX_NAME, index_payload)
    return {"entryCount": len(entries)}


def main() -> int:
    _configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Build instance-safe multiscale spectral sidecar cache")
    parser.add_argument(
        "--source-cache-dir",
        default="grid-analysis-lab/rkb-rekordbox-benchmark/feature-cache-by-batch/primary",
    )
    parser.add_argument(
        "--output-cache-dir",
        default="grid-analysis-lab/rkb-rekordbox-benchmark/multiscale-feature-cache/primary",
    )
    parser.add_argument("--ffmpeg", default=str(benchmark.DEFAULT_FFMPEG))
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", action="append", default=[])
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--repair-hashes-only", action="store_true")
    parser.add_argument("--rebuild-index-from-metadata", action="store_true")
    args = parser.parse_args()

    source_cache_dir = Path(args.source_cache_dir).resolve()
    output_cache_dir = Path(args.output_cache_dir).resolve()
    ffmpeg_path = Path(args.ffmpeg).resolve()
    source_index_path = source_cache_dir / INDEX_NAME
    if args.repair_hashes_only:
        result = _repair_output_hashes(output_cache_dir)
        print(json.dumps(result, indent=2))
        return 0
    if args.rebuild_index_from_metadata:
        result = _rebuild_output_index(output_cache_dir, source_index_path)
        print(json.dumps(result, indent=2))
        return 0
    if not source_index_path.is_file():
        raise SystemExit(f"source feature index not found: {source_index_path}")
    if not ffmpeg_path.is_file():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    source_index = _load_json(source_index_path)
    raw_entries = source_index.get("entries")
    if not isinstance(raw_entries, list):
        raise SystemExit("source feature index contains no entries")
    filters = [str(value).casefold() for value in args.only if str(value).strip()]
    entries = [
        entry
        for entry in raw_entries
        if isinstance(entry, dict)
        and (
            not filters
            or any(
                value in f"{entry.get('fileName', '')} {entry.get('instanceId', '')}".casefold()
                for value in filters
            )
        )
    ]
    if int(args.limit or 0) > 0:
        entries = entries[: int(args.limit)]
    if not entries:
        raise SystemExit("no source feature entries selected")

    output_cache_dir.mkdir(parents=True, exist_ok=True)
    stats = {"hit": 0, "miss": 0, "error": 0}
    completed_entries: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    started_at = time.time()
    with ThreadPoolExecutor(max_workers=max(1, int(args.workers))) as executor:
        future_map = {
            executor.submit(
                _process_entry,
                entry=entry,
                source_cache_dir=source_cache_dir,
                output_cache_dir=output_cache_dir,
                ffmpeg_path=ffmpeg_path,
                force=bool(args.force),
            ): entry
            for entry in entries
        }
        for completed, future in enumerate(as_completed(future_map), start=1):
            source_entry = future_map[future]
            try:
                result = future.result()
                status = str(result["status"])
                stats[status] += 1
                completed_entries.append(result["entry"])
                print(
                    f"[{completed}/{len(entries)}] {status} {source_entry.get('fileName')}",
                    flush=True,
                )
            except Exception as error:
                stats["error"] += 1
                errors.append(
                    {
                        "instanceId": str(source_entry.get("instanceId") or ""),
                        "fileName": str(source_entry.get("fileName") or ""),
                        "error": f"{type(error).__name__}: {error}",
                    }
                )
                print(
                    f"[{completed}/{len(entries)}] error {source_entry.get('fileName')}: {error}",
                    flush=True,
                )

    existing_entries: list[dict[str, Any]] = []
    output_index_path = output_cache_dir / INDEX_NAME
    if output_index_path.is_file():
        existing = _load_json(output_index_path).get("entries")
        if isinstance(existing, list):
            existing_entries = [item for item in existing if isinstance(item, dict)]
    selected_ids = {
        str(entry.get("instanceId") or "").casefold()
        for entry in entries
        if str(entry.get("instanceId") or "").strip()
    }
    merged_entries = [
        item
        for item in existing_entries
        if str(item.get("instanceId") or "").casefold() not in selected_ids
    ]
    merged_entries.extend(completed_entries)
    merged_entries.sort(key=lambda item: str(item.get("instanceId") or "").casefold())
    index_payload = {
        "schemaVersion": 1,
        "type": "rkb-multiscale-spectral-sidecar-index",
        "sidecarCacheVersion": SIDECAR_CACHE_VERSION,
        "spectralPolicy": multiscale_spectral_policy(),
        "sourceFeatureIndex": {
            "path": str(source_index_path).replace("\\", "/").casefold(),
            "sha256": sha256_file(source_index_path),
        },
        "entryCount": len(merged_entries),
        "processedEntryCount": len(entries),
        "entries": merged_entries,
        "stats": stats,
        "errors": errors,
        "elapsedSec": round(time.time() - started_at, 3),
        "updatedAt": round(time.time(), 3),
    }
    _atomic_write_json(output_cache_dir / INDEX_NAME, index_payload)
    print(json.dumps({key: index_payload[key] for key in ("entryCount", "stats", "elapsedSec")}, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
