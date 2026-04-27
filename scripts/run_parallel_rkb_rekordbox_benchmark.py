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

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_SCRIPT = REPO_ROOT / "scripts" / "benchmark_rkb_rekordbox_truth.py"
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
INTAKE_TRUTH = BENCHMARK_OUTPUT_DIR / "intake-current-truth.json"
CURRENT_TRUTH = BENCHMARK_OUTPUT_DIR / "rekordbox-current-truth.json"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "parallel-latest.json"
PROFILE_DEFAULTS: dict[str, dict[str, str]] = {
    "current": {
        "truth": str(CURRENT_TRUTH),
        "audio_root": str(benchmark.DEFAULT_AUDIO_ROOT),
        "output": str(BENCHMARK_OUTPUT_DIR / "frkb-current-latest.json"),
    },
    "intake": {
        "truth": str(INTAKE_TRUTH),
        "audio_root": "D:/FRKB_database-B/library/FilterLibrary/new",
        "output": str(BENCHMARK_OUTPUT_DIR / "intake-current-latest.json"),
    },
}


def _arg_supplied(argv: list[str], *names: str) -> bool:
    for arg in argv:
        for name in names:
            if arg == name or arg.startswith(f"{name}="):
                return True
    return False


def _apply_profile_defaults(args: argparse.Namespace, argv: list[str]) -> None:
    profile = str(args.profile or "").strip()
    if not profile:
        return
    defaults = PROFILE_DEFAULTS.get(profile)
    if defaults is None:
        raise SystemExit(f"unsupported profile: {profile}")
    if not _arg_supplied(argv, "--truth"):
        args.truth = defaults["truth"]
    if not _arg_supplied(argv, "--audio-root"):
        args.audio_root = defaults["audio_root"]
    if not _arg_supplied(argv, "--output"):
        args.output = defaults["output"]


def _load_raw_truth_tracks(truth_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = json.loads(truth_path.read_text(encoding="utf-8"))
    tracks = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(tracks, list) or not tracks:
        raise RuntimeError(f"truth contains no tracks: {truth_path}")
    return payload, [item for item in tracks if isinstance(item, dict)]


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


def _select_tracks(
    tracks: list[dict[str, Any]],
    *,
    only_filters: list[str],
    limit: int,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for track in tracks:
        file_name = str(track.get("fileName") or "").strip()
        lookup_key = benchmark._normalize_lookup_key(file_name)
        if not file_name or lookup_key in seen_keys:
            continue
        if not _matches_only_filters(track, only_filters):
            continue
        seen_keys.add(lookup_key)
        selected.append(track)
        if limit > 0 and len(selected) >= limit:
            break
    return selected


def _resolve_job_count(requested_jobs: int, track_count: int) -> int:
    if track_count <= 1:
        return max(1, track_count)
    if requested_jobs > 0:
        return max(1, min(requested_jobs, track_count))
    cpu_count = os.cpu_count() or 1
    return max(1, min(track_count, cpu_count, 4))


def _partition_tracks(tracks: list[dict[str, Any]], job_count: int) -> list[list[dict[str, Any]]]:
    shards = [[] for _ in range(job_count)]
    for index, track in enumerate(tracks):
        shards[index % job_count].append(track)
    return [shard for shard in shards if shard]


def _write_shard_truth(
    *,
    base_payload: dict[str, Any],
    tracks: list[dict[str, Any]],
    shard_path: Path,
    shard_index: int,
    shard_count: int,
) -> None:
    payload = {
        key: value
        for key, value in base_payload.items()
        if key not in {"tracks", "trackCount", "sourcePlaylists"}
    }
    payload["note"] = f"parallel benchmark shard {shard_index + 1}/{shard_count}"
    payload["trackCount"] = len(tracks)
    payload["tracks"] = tracks
    shard_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _run_shard(
    *,
    shard_index: int,
    shard_count: int,
    shard_truth_path: Path,
    shard_output_path: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    cmd = [
        sys.executable,
        "-B",
        str(BENCHMARK_SCRIPT),
        "--truth",
        str(shard_truth_path),
        "--audio-root",
        str(args.audio_root),
        "--ffmpeg",
        str(args.ffmpeg),
        "--ffprobe",
        str(args.ffprobe),
        "--output",
        str(shard_output_path),
        "--device",
        str(args.device),
        "--prediction-cache-dir",
        str(args.prediction_cache_dir),
    ]
    if args.no_prediction_cache:
        cmd.append("--no-prediction-cache")

    print(f"[shard {shard_index + 1}/{shard_count}] start {shard_truth_path.name}", flush=True)
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
        raise RuntimeError(f"shard {shard_index + 1}/{shard_count} failed with {result.returncode}")
    print(f"[shard {shard_index + 1}/{shard_count}] done", flush=True)
    return json.loads(shard_output_path.read_text(encoding="utf-8"))


def _load_existing_shard_payload(
    *,
    shard_index: int,
    shard_count: int,
    shard_output_path: Path,
    expected_tracks: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not shard_output_path.exists():
        return None
    try:
        payload = json.loads(shard_output_path.read_text(encoding="utf-8"))
    except Exception as error:
        print(
            f"[shard {shard_index + 1}/{shard_count}] ignore unreadable existing output: {error}",
            flush=True,
        )
        return None
    if not isinstance(payload, dict) or "summary" not in payload or "tracks" not in payload:
        print(f"[shard {shard_index + 1}/{shard_count}] ignore invalid existing output", flush=True)
        return None
    expected_names = [
        benchmark._normalize_lookup_key(track.get("fileName"))
        for track in expected_tracks
        if benchmark._normalize_lookup_key(track.get("fileName"))
    ]
    actual_rows = list(payload.get("tracks") or []) + list(payload.get("errors") or [])
    actual_names = [
        benchmark._normalize_lookup_key(row.get("fileName"))
        for row in actual_rows
        if isinstance(row, dict) and benchmark._normalize_lookup_key(row.get("fileName"))
    ]
    if actual_names != expected_names:
        print(
            f"[shard {shard_index + 1}/{shard_count}] ignore stale existing output",
            flush=True,
        )
        return None
    print(f"[shard {shard_index + 1}/{shard_count}] reuse {shard_output_path.name}", flush=True)
    return payload


def _sum_prediction_cache_stats(shard_payloads: list[dict[str, Any]]) -> dict[str, int]:
    keys = [
        "windowHits",
        "windowMisses",
        "windowWrites",
        "logitHits",
        "logitMisses",
        "logitWrites",
        "errors",
    ]
    totals = {key: 0 for key in keys}
    for payload in shard_payloads:
        cache = (payload.get("summary") or {}).get("predictionCache") or {}
        for key in keys:
            totals[key] += int(cache.get(key) or 0)
    return totals


def _merge_payloads(
    *,
    shard_payloads: list[dict[str, Any]],
    selected_tracks: list[dict[str, Any]],
    args: argparse.Namespace,
    duration_sec: float,
    job_count: int,
    shard_count: int,
    status: str,
    shard_failures: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    order = {
        benchmark._normalize_lookup_key(track.get("fileName")): index
        for index, track in enumerate(selected_tracks)
    }
    rows = [row for payload in shard_payloads for row in payload.get("tracks", [])]
    errors = [row for payload in shard_payloads for row in payload.get("errors", [])]
    rows.sort(key=lambda row: order.get(benchmark._normalize_lookup_key(row.get("fileName")), 999999))
    errors.sort(key=lambda row: order.get(benchmark._normalize_lookup_key(row.get("fileName")), 999999))

    summary = benchmark._build_summary(rows, errors)
    return {
        "summary": {
            **summary,
            "truthPath": str(args.truth),
            "audioRoot": str(args.audio_root),
            "device": str(args.device),
            "windowSec": benchmark.WINDOW_SEC,
            "maxScanSec": benchmark.MAX_SCAN_SEC,
            "strictToleranceMs": benchmark.STRICT_TOLERANCE_MS,
            "predictionCache": {
                "enabled": not bool(args.no_prediction_cache),
                "dir": str(args.prediction_cache_dir) if not args.no_prediction_cache else None,
                **_sum_prediction_cache_stats(shard_payloads),
            },
            "parallel": {
                "jobs": job_count,
                "shards": len(shard_payloads),
                "plannedShards": shard_count,
                "completedShards": len(shard_payloads),
                "failedShards": len(shard_failures or []),
                "status": status,
                "shardDir": str(args.shard_dir),
            },
            "durationSec": round(duration_sec, 3),
        },
        "errors": errors,
        "shardFailures": shard_failures or [],
        "tracks": rows,
    }


def _resolve_progress_output_path(args: argparse.Namespace, output_path: Path) -> Path:
    explicit_path = str(args.progress_output or "").strip()
    if explicit_path:
        return Path(explicit_path)
    suffix = output_path.suffix or ".json"
    return output_path.with_name(f"{output_path.stem}.progress{suffix}")


def _resolve_shard_dir(args: argparse.Namespace, output_path: Path) -> tuple[Path, bool]:
    explicit_path = str(args.shard_dir or "").strip()
    if explicit_path:
        return Path(explicit_path), False
    return output_path.with_name(f"{output_path.stem}.shards"), True


def _prepare_auto_shard_dir(shard_dir: Path, *, resume_existing_shards: bool) -> None:
    if resume_existing_shards:
        shard_dir.mkdir(parents=True, exist_ok=True)
        return
    if shard_dir.exists():
        shutil.rmtree(shard_dir)
    shard_dir.mkdir(parents=True, exist_ok=True)


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def _write_progress_payload(
    *,
    progress_path: Path,
    shard_payloads: list[dict[str, Any]],
    selected_tracks: list[dict[str, Any]],
    args: argparse.Namespace,
    started_at: float,
    job_count: int,
    shard_count: int,
    status: str,
    shard_failures: list[dict[str, Any]],
) -> dict[str, Any]:
    payload = _merge_payloads(
        shard_payloads=shard_payloads,
        selected_tracks=selected_tracks,
        args=args,
        duration_sec=time.time() - started_at,
        job_count=job_count,
        shard_count=shard_count,
        status=status,
        shard_failures=shard_failures,
    )
    payload["summary"]["progressOutput"] = str(progress_path)
    payload["summary"]["parallel"]["selectedTrackCount"] = len(selected_tracks)
    _write_json_atomic(progress_path, payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Rekordbox truth benchmark shards in parallel")
    parser.add_argument(
        "--profile",
        choices=sorted(PROFILE_DEFAULTS.keys()),
        default="",
        help="Use fixed truth/audio/output paths for a maintained benchmark record.",
    )
    parser.add_argument("--truth", default=str(benchmark.DEFAULT_TRUTH))
    parser.add_argument("--audio-root", default=str(benchmark.DEFAULT_AUDIO_ROOT))
    parser.add_argument("--ffmpeg", default=str(benchmark.DEFAULT_FFMPEG))
    parser.add_argument("--ffprobe", default=str(benchmark.DEFAULT_FFPROBE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--prediction-cache-dir", default=str(benchmark.DEFAULT_PREDICTION_CACHE_DIR))
    parser.add_argument("--no-prediction-cache", action="store_true")
    parser.add_argument("--jobs", type=int, default=0)
    parser.add_argument("--shard-dir", default="")
    parser.add_argument("--progress-output", default="")
    parser.add_argument(
        "--resume-existing-shards",
        action="store_true",
        help="Reuse valid output-shard-*.json files in --shard-dir instead of recomputing them.",
    )
    parser.add_argument(
        "--keep-shards",
        action="store_true",
        help="Keep auto-created shard files after a successful run for inspection or resume.",
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        help="Filter tracks by case-insensitive file/title/artist substring. Can be repeated.",
    )
    args = parser.parse_args()
    _apply_profile_defaults(args, sys.argv[1:])

    truth_path = Path(args.truth)
    output_path = Path(args.output)
    base_payload, raw_tracks = _load_raw_truth_tracks(truth_path)
    only_filters = [benchmark._normalize_lookup_key(item) for item in args.only if benchmark._normalize_lookup_key(item)]
    selected_tracks = _select_tracks(raw_tracks, only_filters=only_filters, limit=int(args.limit or 0))
    if not selected_tracks:
        raise SystemExit("no tracks selected")

    job_count = _resolve_job_count(int(args.jobs or 0), len(selected_tracks))
    shards = _partition_tracks(selected_tracks, job_count)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    progress_path = _resolve_progress_output_path(args, output_path)
    started_at = time.time()

    tmp_path, auto_shard_dir = _resolve_shard_dir(args, output_path)
    args.shard_dir = str(tmp_path)
    if auto_shard_dir:
        _prepare_auto_shard_dir(tmp_path, resume_existing_shards=bool(args.resume_existing_shards))
    else:
        tmp_path.mkdir(parents=True, exist_ok=True)
    shard_payloads: list[dict[str, Any]] = []
    shard_failures: list[dict[str, Any]] = []
    future_to_shard: dict[Any, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=len(shards)) as executor:
        for shard_index, shard_tracks in enumerate(shards):
            shard_truth_path = tmp_path / f"truth-shard-{shard_index + 1}.json"
            shard_output_path = tmp_path / f"output-shard-{shard_index + 1}.json"
            _write_shard_truth(
                base_payload=base_payload,
                tracks=shard_tracks,
                shard_path=shard_truth_path,
                shard_index=shard_index,
                shard_count=len(shards),
            )
            existing_payload = (
                _load_existing_shard_payload(
                    shard_index=shard_index,
                    shard_count=len(shards),
                    shard_output_path=shard_output_path,
                    expected_tracks=shard_tracks,
                )
                if args.resume_existing_shards
                else None
            )
            if existing_payload is not None:
                shard_payloads.append(existing_payload)
                _write_progress_payload(
                    progress_path=progress_path,
                    shard_payloads=shard_payloads,
                    selected_tracks=selected_tracks,
                    args=args,
                    started_at=started_at,
                    job_count=job_count,
                    shard_count=len(shards),
                    status="running",
                    shard_failures=shard_failures,
                )
                continue
            future = executor.submit(
                _run_shard,
                shard_index=shard_index,
                shard_count=len(shards),
                shard_truth_path=shard_truth_path,
                shard_output_path=shard_output_path,
                args=args,
            )
            future_to_shard[future] = {
                "index": shard_index,
                "truthPath": str(shard_truth_path),
                "outputPath": str(shard_output_path),
            }

        for future in as_completed(future_to_shard):
            shard_meta = future_to_shard[future]
            try:
                shard_payloads.append(future.result())
            except Exception as error:
                shard_failures.append(
                    {
                        "shardIndex": int(shard_meta["index"]) + 1,
                        "truthPath": shard_meta["truthPath"],
                        "outputPath": shard_meta["outputPath"],
                        "error": str(error),
                    }
                )
            _write_progress_payload(
                progress_path=progress_path,
                shard_payloads=shard_payloads,
                selected_tracks=selected_tracks,
                args=args,
                started_at=started_at,
                job_count=job_count,
                shard_count=len(shards),
                status="failed" if shard_failures else "running",
                shard_failures=shard_failures,
            )

    if shard_failures:
        progress_payload = _write_progress_payload(
            progress_path=progress_path,
            shard_payloads=shard_payloads,
            selected_tracks=selected_tracks,
            args=args,
            started_at=started_at,
            job_count=job_count,
            shard_count=len(shards),
            status="failed",
            shard_failures=shard_failures,
        )
        print(
            json.dumps(
                {"summary": progress_payload["summary"], "progress": str(progress_path)},
                ensure_ascii=False,
                indent=2,
            ),
            flush=True,
        )
        return 1

    payload = _merge_payloads(
        shard_payloads=shard_payloads,
        selected_tracks=selected_tracks,
        args=args,
        duration_sec=time.time() - started_at,
        job_count=job_count,
        shard_count=len(shards),
        status="complete",
    )
    payload["summary"]["progressOutput"] = str(progress_path)
    payload["summary"]["parallel"]["selectedTrackCount"] = len(selected_tracks)
    _write_json_atomic(output_path, payload)
    _write_json_atomic(progress_path, payload)
    if auto_shard_dir and not args.keep_shards and not args.resume_existing_shards:
        shutil.rmtree(tmp_path, ignore_errors=True)
    print(
        json.dumps(
            {"summary": payload["summary"], "output": str(output_path), "progress": str(progress_path)},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if not payload["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
