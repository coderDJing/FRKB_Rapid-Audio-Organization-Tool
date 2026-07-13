import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_beatgrid_lab_common import (
    DEFAULT_FEATURE_CACHE_DIR,
    track_identity_key,
    validate_feature_cache_coverage,
    validate_feature_metadata_identity,
    write_feature_index,
)
from rkb_dataset_contract import (
    build_derived_shard_metadata,
    enrich_truth_tracks_from_registry,
    identity_projection_sha256,
    materialize_registry_enriched_truth,
    validate_truth_contract,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
FEATURE_CACHE_SCRIPT = REPO_ROOT / "scripts" / "rkb_beatgrid_feature_cache.py"
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
CURRENT_TRUTH = BENCHMARK_OUTPUT_DIR / "rekordbox-current-truth.json"
DEFAULT_REGISTRY = BENCHMARK_OUTPUT_DIR / "rkb-dataset-registry.json"
DEFAULT_SHARD_DIR = BENCHMARK_OUTPUT_DIR / "feature-cache-shards"


def _load_raw_truth_tracks(truth_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = json.loads(truth_path.read_text(encoding="utf-8"))
    validate_truth_contract(truth_path, payload)
    tracks = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(tracks, list) or not tracks:
        raise RuntimeError(f"truth contains no tracks: {truth_path}")
    return payload, [item for item in tracks if isinstance(item, dict)]


def _normalize_lookup_key(value: Any) -> str:
    return benchmark._normalize_lookup_key(value)


def _enrich_tracks_from_registry(
    tracks: list[dict[str, Any]],
    *,
    registry_path: Path,
    batch_id: str,
) -> list[dict[str, Any]]:
    _, enriched = enrich_truth_tracks_from_registry(
        tracks,
        registry_path=registry_path,
        batch_id=batch_id,
    )
    return enriched


def _matches_only_filters(track: dict[str, Any], filters: list[str]) -> bool:
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


def _select_tracks(tracks: list[dict[str, Any]], filters: list[str], limit: int) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for track in tracks:
        file_name = str(track.get("fileName") or "").strip()
        identity_key = track_identity_key(track)
        if not file_name or not identity_key or identity_key in seen:
            continue
        if not _matches_only_filters(track, filters):
            continue
        seen.add(identity_key)
        selected.append(track)
        if limit > 0 and len(selected) >= limit:
            break
    return selected


def _resolve_job_count(requested_jobs: int, track_count: int) -> int:
    if track_count <= 1:
        return max(1, track_count)
    if requested_jobs > 0:
        return max(1, min(requested_jobs, track_count))
    return max(1, min(track_count, os.cpu_count() or 1, 4))


def _partition_tracks(tracks: list[dict[str, Any]], job_count: int) -> list[list[dict[str, Any]]]:
    shards = [[] for _ in range(job_count)]
    for index, track in enumerate(tracks):
        shards[index % job_count].append(track)
    return [shard for shard in shards if shard]


def _write_shard_truth(
    *,
    base_payload: dict[str, Any],
    tracks: list[dict[str, Any]],
    path: Path,
    index: int,
    count: int,
    source_truth_path: Path | None = None,
    source_contract: dict[str, Any] | None = None,
) -> None:
    payload = {
        key: value
        for key, value in base_payload.items()
        if key not in {"tracks", "trackCount", "sourcePlaylists", "registryEnrichedTruth"}
    }
    payload["note"] = f"feature cache shard {index + 1}/{count}"
    payload["trackCount"] = len(tracks)
    payload["tracks"] = tracks
    if source_truth_path is not None and source_contract is not None:
        payload["derivedShard"] = build_derived_shard_metadata(
            source_truth_path=source_truth_path,
            source_contract=source_contract,
            tracks=tracks,
            shard_index=index,
            shard_count=count,
        )
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _run_shard(
    *,
    shard_index: int,
    shard_count: int,
    shard_truth_path: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    cmd = [
        sys.executable,
        "-B",
        str(FEATURE_CACHE_SCRIPT),
        "--truth",
        str(shard_truth_path),
        "--audio-root",
        str(args.audio_root),
        "--ffmpeg",
        str(args.ffmpeg),
        "--ffprobe",
        str(args.ffprobe),
        "--cache-dir",
        str(args.cache_dir),
        "--prediction-cache-dir",
        str(args.prediction_cache_dir),
        "--device",
        str(args.device),
    ]
    if args.no_prediction_cache:
        cmd.append("--no-prediction-cache")
    if args.force:
        cmd.append("--force")
    cmd.append("--no-index-update")

    print(f"[feature shard {shard_index + 1}/{shard_count}] start", flush=True)
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        print(result.stdout, flush=True)
        raise RuntimeError(f"feature shard {shard_index + 1}/{shard_count} failed")
    print(f"[feature shard {shard_index + 1}/{shard_count}] done", flush=True)
    return {"shardIndex": shard_index + 1}


def _rebuild_index_from_metadata(
    cache_dir: Path,
    truth_tracks: list[dict[str, Any]],
) -> int:
    truth_by_identity = {
        identity_key: track
        for track in truth_tracks
        if (identity_key := track_identity_key(track))
    }
    entries_by_identity: dict[str, dict[str, Any]] = {}
    for metadata_path in cache_dir.glob("feature-*.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(metadata, dict):
            continue
        cache_key = str(metadata.get("cacheKey") or "").strip()
        lookup_key = str(metadata.get("lookupKey") or "").strip()
        file_name = str(metadata.get("fileName") or "").strip()
        arrays_path = str(metadata.get("arraysPath") or "").strip()
        if not cache_key or not lookup_key or not arrays_path:
            continue
        if not (cache_dir / arrays_path).exists():
            continue
        entry = {
            "fileName": file_name,
            "lookupKey": lookup_key,
            "instanceId": metadata.get("instanceId"),
            "batchId": metadata.get("batchId"),
            "assetSha256": metadata.get("assetSha256"),
            "pcmSha256": metadata.get("pcmSha256"),
            "familyId": metadata.get("familyId"),
            "sourcePath": metadata.get("sourcePath"),
            "cacheKey": cache_key,
            "metadataPath": metadata_path.name,
            "arraysPath": arrays_path,
            "durationSec": (metadata.get("audio") or {}).get("durationSec"),
            "featureCacheVersion": metadata.get("featureCacheVersion"),
            "updatedAt": metadata.get("createdAt"),
        }
        identity_key = track_identity_key(metadata)
        track = truth_by_identity.get(identity_key)
        if not identity_key or track is None:
            continue
        try:
            validate_feature_metadata_identity(track=track, entry=entry, metadata=metadata)
        except RuntimeError:
            continue
        previous = entries_by_identity.get(identity_key)
        previous_key = (
            int(previous.get("featureCacheVersion") or 0) if previous else -1,
            float(previous.get("updatedAt") or 0.0) if previous else -1.0,
        )
        next_key = (
            int(entry.get("featureCacheVersion") or 0),
            float(entry.get("updatedAt") or 0.0),
        )
        if previous is None or next_key >= previous_key:
            entries_by_identity[identity_key] = entry
    entries = list(entries_by_identity.values())
    write_feature_index(cache_dir, entries)
    return len(entries)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build hybrid beatgrid feature cache in parallel")
    parser.add_argument("--truth", default=str(CURRENT_TRUTH))
    parser.add_argument("--truth-batch-id", default="")
    parser.add_argument("--registry", default=str(DEFAULT_REGISTRY))
    parser.add_argument("--audio-root", default=str(benchmark.DEFAULT_AUDIO_ROOT))
    parser.add_argument("--ffmpeg", default=str(benchmark.DEFAULT_FFMPEG))
    parser.add_argument("--ffprobe", default=str(benchmark.DEFAULT_FFPROBE))
    parser.add_argument("--cache-dir", default=str(DEFAULT_FEATURE_CACHE_DIR))
    parser.add_argument("--prediction-cache-dir", default=str(benchmark.DEFAULT_PREDICTION_CACHE_DIR))
    parser.add_argument("--no-prediction-cache", action="store_true")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--jobs", type=int, default=0)
    parser.add_argument("--shard-dir", default=str(DEFAULT_SHARD_DIR))
    parser.add_argument("--keep-shards", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", action="append", default=[])
    args = parser.parse_args()

    truth_path = Path(args.truth)
    shard_dir = Path(args.shard_dir)
    if shard_dir.exists():
        shutil.rmtree(shard_dir)
    shard_dir.mkdir(parents=True, exist_ok=True)
    base_payload, raw_tracks = _load_raw_truth_tracks(truth_path)
    truth_contract = validate_truth_contract(truth_path, base_payload)
    shard_source_path = truth_path
    truth_batch_id = str(args.truth_batch_id or "").strip()
    if truth_batch_id:
        shard_source_path = shard_dir / "authoritative-enriched-truth.json"
        base_payload, truth_contract, raw_tracks = materialize_registry_enriched_truth(
            source_truth_path=truth_path,
            registry_path=Path(args.registry),
            batch_id=truth_batch_id,
            output_path=shard_source_path,
        )
    filters = [_normalize_lookup_key(item) for item in args.only if _normalize_lookup_key(item)]
    selected_tracks = _select_tracks(raw_tracks, filters, int(args.limit or 0))
    if not selected_tracks:
        raise SystemExit("no tracks selected")

    started_at = time.time()
    job_count = _resolve_job_count(int(args.jobs or 0), len(selected_tracks))
    shards = _partition_tracks(selected_tracks, job_count)

    failures: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=len(shards)) as executor:
        futures = {}
        for index, tracks in enumerate(shards):
            shard_truth = shard_dir / f"truth-shard-{index + 1}.json"
            _write_shard_truth(
                base_payload=base_payload,
                tracks=tracks,
                path=shard_truth,
                index=index,
                count=len(shards),
                source_truth_path=shard_source_path,
                source_contract=truth_contract,
            )
            future = executor.submit(
                _run_shard,
                shard_index=index,
                shard_count=len(shards),
                shard_truth_path=shard_truth,
                args=args,
            )
            futures[future] = index
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as error:
                failures.append({"shardIndex": futures[future] + 1, "error": str(error)})

    if failures:
        print(json.dumps({"failures": failures}, ensure_ascii=False, indent=2), flush=True)
        return 1

    indexed_count = _rebuild_index_from_metadata(Path(args.cache_dir), selected_tracks)
    validated_count = validate_feature_cache_coverage(Path(args.cache_dir), selected_tracks)
    if indexed_count != validated_count:
        raise RuntimeError("feature index rebuild/validation count mismatch")
    identity_sha256 = (
        identity_projection_sha256(selected_tracks)
        if all(str(track.get("instanceId") or "").strip() for track in selected_tracks)
        else ""
    )
    if not args.keep_shards:
        shutil.rmtree(shard_dir, ignore_errors=True)
    print(
        json.dumps(
            {
                "summary": {
                    "selectedTrackCount": len(selected_tracks),
                    "indexedFeatureCount": indexed_count,
                    "registryBatchId": truth_batch_id or None,
                    "identityProjectionSha256": identity_sha256 or None,
                    "truthContractSha256": truth_contract["contractSha256"],
                    "jobs": job_count,
                    "cacheDir": str(args.cache_dir),
                    "durationSec": round(time.time() - started_at, 3),
                }
            },
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
