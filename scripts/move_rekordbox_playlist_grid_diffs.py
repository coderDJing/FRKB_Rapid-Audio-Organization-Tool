import argparse
import json
import math
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import benchmark_rkb_rekordbox_truth as benchmark
from capture_rekordbox_playlist_truth import (
    DEFAULT_BRIDGE,
    _bridge_payload,
    _run_bridge,
    _truth_track_from_rekordbox_track,
)
from frkb_database_paths import FRKB_BENCHMARK_CURRENT_AUDIO_ROOT

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "rekordbox-test-need-review-latest.json"
DEFAULT_FFMPEG = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe"
DEFAULT_FFPROBE = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffprobe.exe"
DEFAULT_PREDICTION_CACHE_DIR = BENCHMARK_OUTPUT_DIR / "beatthis-prediction-cache"
DEFAULT_SOURCE_PLAYLIST = "test"
DEFAULT_TARGET_PLAYLIST = "needReview"


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _to_int(value: Any) -> int | None:
    numeric = _to_float(value)
    if numeric is None:
        return None
    return int(round(numeric))


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(path)


def _load_tree_nodes(bridge_path: Path, db_path: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    payload = _run_bridge(bridge_path, "load-tree", _bridge_payload(db_path))
    nodes = payload.get("nodes")
    if not isinstance(nodes, list):
        raise RuntimeError("Rekordbox playlist tree is invalid")
    return [item for item in nodes if isinstance(item, dict)], payload


def _resolve_playlist_node(
    bridge_path: Path,
    playlist_name: str,
    db_path: str,
    *,
    required: bool,
) -> dict[str, Any] | None:
    expected = _normalize_key(playlist_name)
    nodes, _ = _load_tree_nodes(bridge_path, db_path)
    matches = [
        item
        for item in nodes
        if not item.get("isFolder") and _normalize_key(item.get("name")) == expected
    ]
    if not matches:
        if not required:
            return None
        available = ", ".join(str(item.get("name") or "") for item in nodes if not item.get("isFolder"))
        raise RuntimeError(f"playlist not found: {playlist_name}; available: {available}")
    if len(matches) > 1:
        ids = ", ".join(str(item.get("id") or "") for item in matches)
        raise RuntimeError(f"playlist name is ambiguous: {playlist_name}; ids: {ids}")
    return matches[0]


def _playlist_id(node: dict[str, Any]) -> int:
    numeric = _to_float(node.get("id"))
    return int(numeric) if numeric is not None and numeric > 0 else 0


def _load_playlist_tracks(
    bridge_path: Path,
    playlist_id: int,
    db_path: str,
) -> dict[str, Any]:
    return _run_bridge(
        bridge_path,
        "load-playlist-tracks",
        {
            **_bridge_payload(db_path),
            "playlistId": playlist_id,
        },
    )


def _resolve_track_file_path(
    raw_track: dict[str, Any],
    audio_roots: list[Path],
) -> Path:
    raw_file_path = str(raw_track.get("filePath") or "").strip()
    if raw_file_path:
        file_path = Path(raw_file_path)
        if file_path.exists():
            return file_path

    file_name = str(raw_track.get("fileName") or "").strip()
    if file_name:
        return benchmark._resolve_audio_path(audio_roots, file_name)

    return Path(raw_file_path)


def _prepare_truth_track(
    raw_track: dict[str, Any],
    *,
    audio_roots: list[Path],
    ffprobe_path: Path,
) -> dict[str, Any]:
    truth = _truth_track_from_rekordbox_track(raw_track)
    file_path = _resolve_track_file_path(raw_track, audio_roots)
    if not file_path.exists():
        raise RuntimeError(f"audio file not found: {truth['fileName']} -> {file_path}")

    return {
        **truth,
        "filePath": str(file_path),
        "rowKey": str(raw_track.get("rowKey") or "").strip(),
        "trackId": raw_track.get("trackId"),
        "entryIndex": raw_track.get("entryIndex"),
        "fileExists": True,
        "timeBasis": benchmark._probe_time_basis(ffprobe_path, file_path),
    }


def _load_source_truth_tracks(
    bridge_path: Path,
    source_playlist: str,
    db_path: str,
    *,
    audio_roots: list[Path],
    ffprobe_path: Path,
    only_filters: list[str],
    limit: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    node = _resolve_playlist_node(bridge_path, source_playlist, db_path, required=True)
    if node is None:
        raise RuntimeError(f"playlist not found: {source_playlist}")
    if node.get("isSmartPlaylist"):
        raise RuntimeError(f"source playlist is smart and cannot be moved from: {source_playlist}")

    playlist_id = _playlist_id(node)
    if playlist_id <= 0:
        raise RuntimeError(f"source playlist id is invalid: {source_playlist}")

    payload = _load_playlist_tracks(bridge_path, playlist_id, db_path)
    raw_tracks = payload.get("tracks")
    if not isinstance(raw_tracks, list) or not raw_tracks:
        raise RuntimeError(f"playlist has no tracks: {source_playlist}")

    selected_raw_tracks: list[dict[str, Any]] = []
    for raw_track in raw_tracks:
        if not isinstance(raw_track, dict):
            continue
        haystack = " ".join(
            [
                str(raw_track.get("fileName") or ""),
                str(raw_track.get("title") or ""),
                str(raw_track.get("artist") or ""),
            ]
        ).casefold()
        if only_filters and not any(item in haystack for item in only_filters):
            continue
        selected_raw_tracks.append(raw_track)
        if limit > 0 and len(selected_raw_tracks) >= limit:
            break

    if not selected_raw_tracks:
        raise RuntimeError(f"no tracks selected from playlist: {source_playlist}")

    selected = [
        _prepare_truth_track(raw_track, audio_roots=audio_roots, ffprobe_path=ffprobe_path)
        for raw_track in selected_raw_tracks
    ]

    return {
        "playlistId": playlist_id,
        "playlistName": str(payload.get("playlistName") or source_playlist).strip(),
        "trackTotal": len(raw_tracks),
        "selectedTrackCount": len(selected),
        "probe": payload.get("probe") if isinstance(payload.get("probe"), dict) else {},
    }, selected


def _load_legacy_analyzer(device: str) -> dict[str, Any]:
    bridge = benchmark._load_bridge_module()
    benchmark._install_full_logit_prediction_cache(bridge)
    checkpoint_path = str(bridge._resolve_checkpoint_path())
    predictor = bridge.Audio2Beats(checkpoint_path=checkpoint_path, device=device, dbn=False)
    cpu_spect = bridge.LogMelSpect(device="cpu") if bridge._uses_accelerated_device(device) else None
    return {
        "bridge": bridge,
        "checkpointPath": checkpoint_path,
        "predictor": predictor,
        "cpuSpect": cpu_spect,
    }


def _analyze_playlist_tracks(
    tracks: list[dict[str, Any]],
    *,
    ffmpeg_path: Path,
    device: str,
    prediction_cache_dir: Path | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    analyzer = _load_legacy_analyzer(device)
    cache_stats = benchmark._cache_stats()
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for index, truth in enumerate(tracks, start=1):
        label = f"[{index}/{len(tracks)}] {truth['fileName']}"
        print(label, flush=True)
        try:
            analysis = benchmark._analyze_track(
                bridge=analyzer["bridge"],
                predictor=analyzer["predictor"],
                cpu_spect=analyzer["cpuSpect"],
                ffmpeg_path=ffmpeg_path,
                device=device,
                checkpoint_path=analyzer["checkpointPath"],
                prediction_cache_dir=prediction_cache_dir,
                prediction_cache_stats=cache_stats,
                truth=truth,
            )
            report = benchmark._build_track_report(analysis, truth)
            rows.append(
                {
                    **report,
                    "sourceRowKey": truth.get("rowKey"),
                    "sourceTrackId": truth.get("trackId"),
                    "sourceEntryIndex": truth.get("entryIndex"),
                }
            )
        except Exception as exc:
            errors.append(
                {
                    "fileName": truth.get("fileName"),
                    "filePath": truth.get("filePath"),
                    "title": truth.get("title"),
                    "artist": truth.get("artist"),
                    "sourceRowKey": truth.get("rowKey"),
                    "sourceTrackId": truth.get("trackId"),
                    "sourceEntryIndex": truth.get("entryIndex"),
                    "error": str(exc),
                }
            )
            print(f"  error: {exc}", flush=True)

    return rows, errors, cache_stats


def _difference_reasons(row: dict[str, Any]) -> list[str]:
    current = row.get("currentTimeline")
    if not isinstance(current, dict):
        return ["analysis result is missing current timeline"]

    reasons: list[str] = []
    category = str(current.get("category") or "")
    if category == "half-or-double-bpm":
        reasons.append("BPM is half/double different from Rekordbox")
    if current.get("bpmDriftStatus") == "fail":
        reasons.append(
            f"BPM drift exceeds ±{benchmark.STRICT_TOLERANCE_MS:g}ms over 128 beats"
        )
    if current.get("firstBeatPhaseStatus") == "fail":
        reasons.append(f"first beat grid differs by more than ±{benchmark.STRICT_TOLERANCE_MS:g}ms")
    if current.get("gridMaxStatus") == "fail":
        reasons.append(f"grid line drift exceeds ±{benchmark.STRICT_TOLERANCE_MS:g}ms")
    if current.get("barBeatOffsetStatus") == "fail":
        reasons.append("downbeat/barBeatOffset differs from Rekordbox")
    if not reasons and category and category != "pass":
        reasons.append(f"classified as {category}")
    return reasons


def _build_difference_rows(
    rows: list[dict[str, Any]],
    errors: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    differences: list[dict[str, Any]] = []
    for row in rows:
        current = row.get("currentTimeline")
        category = str(current.get("category") or "") if isinstance(current, dict) else "unknown"
        if category == "pass":
            continue
        differences.append(
            {
                "fileName": row.get("fileName"),
                "filePath": row.get("filePath"),
                "title": row.get("title"),
                "artist": row.get("artist"),
                "sourceRowKey": row.get("sourceRowKey"),
                "sourceTrackId": row.get("sourceTrackId"),
                "sourceEntryIndex": row.get("sourceEntryIndex"),
                "category": category,
                "reasons": _difference_reasons(row),
                "truth": row.get("truth"),
                "analysis": row.get("analysis"),
                "currentTimeline": current,
            }
        )

    for row in errors:
        differences.append(
            {
                "fileName": row.get("fileName"),
                "filePath": row.get("filePath"),
                "title": row.get("title"),
                "artist": row.get("artist"),
                "sourceRowKey": row.get("sourceRowKey"),
                "sourceTrackId": row.get("sourceTrackId"),
                "sourceEntryIndex": row.get("sourceEntryIndex"),
                "category": "analysis-error",
                "reasons": [str(row.get("error") or "analysis failed")],
                "error": row.get("error"),
            }
        )
    return differences


def _ensure_target_playlist(
    bridge_path: Path,
    target_playlist: str,
    db_path: str,
    *,
    target_parent_id: int,
) -> dict[str, Any]:
    node = _resolve_playlist_node(bridge_path, target_playlist, db_path, required=False)
    if node is not None:
        if node.get("isSmartPlaylist"):
            raise RuntimeError(f"target playlist is smart and cannot be written: {target_playlist}")
        playlist_id = _playlist_id(node)
        if playlist_id <= 0:
            raise RuntimeError(f"target playlist id is invalid: {target_playlist}")
        return {
            "playlistId": playlist_id,
            "playlistName": str(node.get("name") or target_playlist).strip(),
            "created": False,
        }

    payload = _run_bridge(
        bridge_path,
        "create-empty-playlist",
        {
            **_bridge_payload(db_path),
            "playlistName": target_playlist,
            "parentId": target_parent_id,
        },
    )
    return {
        "playlistId": int(payload.get("playlistId") or 0),
        "playlistName": str(payload.get("playlistName") or target_playlist).strip(),
        "created": True,
    }


def _validate_move_payload(
    differences: list[dict[str, Any]],
    *,
    copy_only: bool,
) -> None:
    missing_track_ids = [
        str(item.get("fileName") or "")
        for item in differences
        if int(item.get("sourceTrackId") or 0) <= 0
    ]
    if missing_track_ids:
        preview = ", ".join(missing_track_ids[:8])
        raise RuntimeError(f"cannot write tracks without Rekordbox trackId: {preview}")

    if copy_only:
        return

    missing_row_keys = [
        str(item.get("fileName") or "")
        for item in differences
        if not str(item.get("sourceRowKey") or "").strip()
    ]
    if missing_row_keys:
        preview = ", ".join(missing_row_keys[:8])
        raise RuntimeError(f"cannot move tracks without source rowKey: {preview}")


def _source_row_keys(items: list[dict[str, Any]]) -> list[str]:
    row_keys: list[str] = []
    seen: set[str] = set()
    for item in items:
        row_key = str(item.get("sourceRowKey") or "").strip()
        if not row_key or row_key in seen:
            continue
        seen.add(row_key)
        row_keys.append(row_key)
    return row_keys


def _probe_writable_database(bridge_path: Path, db_path: str) -> None:
    write_status = _run_bridge(bridge_path, "probe-write", _bridge_payload(db_path))
    if write_status.get("writable") is False:
        message = str(write_status.get("errorMessage") or "Rekordbox database is not writable")
        raise RuntimeError(message)


def _apply_playlist_updates(
    bridge_path: Path,
    db_path: str,
    *,
    source_playlist_id: int,
    target_playlist: str,
    target_parent_id: int,
    differences: list[dict[str, Any]],
    copy_only: bool,
) -> dict[str, Any]:
    if not differences:
        return {
            "applied": True,
            "targetPlaylist": None,
            "appendResult": None,
            "removeResult": None,
        }

    _validate_move_payload(differences, copy_only=copy_only)
    _probe_writable_database(bridge_path, db_path)

    target = None
    append_result = None
    if differences:
        target = _ensure_target_playlist(
            bridge_path,
            target_playlist,
            db_path,
            target_parent_id=target_parent_id,
        )
        target_playlist_id = int(target.get("playlistId") or 0)
        if target_playlist_id <= 0:
            raise RuntimeError(f"target playlist id is invalid: {target_playlist}")
        if target_playlist_id == source_playlist_id and not copy_only:
            raise RuntimeError("source playlist and target playlist are the same; refusing to move")

        track_ids = [int(item.get("sourceTrackId") or 0) for item in differences]
        append_result = _run_bridge(
            bridge_path,
            "append-existing-playlist-tracks",
            {
                **_bridge_payload(db_path),
                "playlistId": target_playlist_id,
                "trackIds": track_ids,
            },
        )

    remove_result = None
    if not copy_only:
        remove_result = _run_bridge(
            bridge_path,
            "remove-playlist-tracks",
            {
                **_bridge_payload(db_path),
                "playlistId": source_playlist_id,
                "rowKeys": _source_row_keys(differences),
            },
        )

    return {
        "applied": True,
        "targetPlaylist": target,
        "appendResult": append_result,
        "removeResult": remove_result,
    }


def _load_report_for_apply(
    report_path: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"report is invalid: {report_path}")
    summary = payload.get("summary")
    differences = payload.get("differences")
    if not isinstance(summary, dict):
        raise RuntimeError(f"report has no summary: {report_path}")
    if not isinstance(differences, list):
        raise RuntimeError(f"report has no differences array: {report_path}")
    return (
        summary,
        [item for item in differences if isinstance(item, dict)],
    )


def _apply_existing_report(
    *,
    report_path: Path,
    bridge_path: Path,
    db_path: str,
    target_playlist: str,
    target_parent_id: int,
    copy_only: bool,
) -> dict[str, Any]:
    summary, differences = _load_report_for_apply(report_path)
    source = summary.get("sourcePlaylist")
    if not isinstance(source, dict):
        raise RuntimeError(f"report has no sourcePlaylist summary: {report_path}")
    source_playlist_id = int(source.get("playlistId") or 0)
    if source_playlist_id <= 0:
        raise RuntimeError(f"report source playlist id is invalid: {report_path}")
    difference_apply_result = _apply_playlist_updates(
        bridge_path,
        db_path,
        source_playlist_id=source_playlist_id,
        target_playlist=target_playlist,
        target_parent_id=target_parent_id,
        differences=differences,
        copy_only=copy_only,
    )
    return difference_apply_result


def _build_summary(
    *,
    source: dict[str, Any],
    target_playlist: str,
    rows: list[dict[str, Any]],
    errors: list[dict[str, Any]],
    differences: list[dict[str, Any]],
    dry_run: bool,
    copy_only: bool,
    device: str,
    prediction_cache_dir: Path | None,
    cache_stats: dict[str, int],
    elapsed_sec: float,
) -> dict[str, Any]:
    category_counts: dict[str, int] = {}
    for item in differences:
        category = str(item.get("category") or "unknown")
        category_counts[category] = category_counts.get(category, 0) + 1

    return {
        "sourcePlaylist": {
            "playlistId": source.get("playlistId"),
            "playlistName": source.get("playlistName"),
            "trackTotal": source.get("trackTotal"),
            "selectedTrackCount": source.get("selectedTrackCount"),
        },
        "targetPlaylistName": target_playlist,
        "mode": "dry-run" if dry_run else ("copy" if copy_only else "move"),
        "strictToleranceMs": benchmark.STRICT_TOLERANCE_MS,
        "analyzedTrackCount": len(rows),
        "errorTrackCount": len(errors),
        "differenceTrackCount": len(differences),
        "passTrackCount": max(0, len(rows) - (len(differences) - len(errors))),
        "differenceCategoryCounts": category_counts,
        "device": device,
        "predictionCache": {
            "enabled": prediction_cache_dir is not None,
            "dir": str(prediction_cache_dir) if prediction_cache_dir is not None else None,
            **cache_stats,
        },
        "elapsedSec": round(elapsed_sec, 3),
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Move Rekordbox playlist tracks whose FRKB grid analysis differs from Rekordbox.",
    )
    parser.add_argument("--source-playlist", default=DEFAULT_SOURCE_PLAYLIST)
    parser.add_argument("--target-playlist", default=DEFAULT_TARGET_PLAYLIST)
    parser.add_argument("--target-parent-id", type=int, default=0)
    parser.add_argument("--bridge", default=str(DEFAULT_BRIDGE))
    parser.add_argument("--db-path", default="")
    parser.add_argument("--audio-root", default=str(FRKB_BENCHMARK_CURRENT_AUDIO_ROOT))
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    parser.add_argument("--ffprobe", default=str(DEFAULT_FFPROBE))
    parser.add_argument("--prediction-cache-dir", default=str(DEFAULT_PREDICTION_CACHE_DIR))
    parser.add_argument("--no-prediction-cache", action="store_true")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument(
        "--from-report",
        default="",
        help="Apply differences from an existing dry-run report without reanalyzing audio.",
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        help="Filter tracks by case-insensitive file/title/artist substring. Can be repeated.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually create/append/remove Rekordbox playlist entries. Default is dry-run.",
    )
    parser.add_argument(
        "--copy-only",
        action="store_true",
        help="Append differences to target playlist but keep them in the source playlist.",
    )
    args = parser.parse_args()

    bridge_path = Path(args.bridge)
    ffmpeg_path = Path(args.ffmpeg)
    ffprobe_path = Path(args.ffprobe)
    output_path = Path(args.output)
    from_report_path = Path(str(args.from_report or "")) if str(args.from_report or "").strip() else None
    audio_roots = benchmark._parse_audio_roots(str(args.audio_root or ""))
    prediction_cache_dir = None if args.no_prediction_cache else Path(args.prediction_cache_dir)
    device = str(args.device or "cpu").strip() or "cpu"
    only_filters = [_normalize_key(item) for item in args.only if _normalize_key(item)]

    if not bridge_path.exists():
        raise SystemExit(f"bridge not found: {bridge_path}")
    if from_report_path is not None:
        if not bool(args.apply):
            raise SystemExit("--from-report requires --apply")
        if not from_report_path.exists():
            raise SystemExit(f"report not found: {from_report_path}")
        apply_result = _apply_existing_report(
            report_path=from_report_path,
            bridge_path=bridge_path,
            db_path=str(args.db_path or ""),
            target_playlist=str(args.target_playlist or DEFAULT_TARGET_PLAYLIST),
            target_parent_id=int(args.target_parent_id or 0),
            copy_only=bool(args.copy_only),
        )
        print(json.dumps(apply_result, ensure_ascii=False, indent=2), flush=True)
        return 0

    if not ffmpeg_path.exists():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    if not ffprobe_path.exists():
        raise SystemExit(f"ffprobe not found: {ffprobe_path}")
    started_at = time.time()
    source, truth_tracks = _load_source_truth_tracks(
        bridge_path,
        str(args.source_playlist or DEFAULT_SOURCE_PLAYLIST),
        str(args.db_path or ""),
        audio_roots=audio_roots,
        ffprobe_path=ffprobe_path,
        only_filters=only_filters,
        limit=int(args.limit or 0),
    )
    dry_run = not bool(args.apply)

    rows, errors, cache_stats = _analyze_playlist_tracks(
        truth_tracks,
        ffmpeg_path=ffmpeg_path,
        device=device,
        prediction_cache_dir=prediction_cache_dir,
    )
    differences = _build_difference_rows(rows, errors)
    apply_result: dict[str, Any] | None = None
    if not dry_run:
        difference_apply_result = _apply_playlist_updates(
            bridge_path,
            str(args.db_path or ""),
            source_playlist_id=int(source["playlistId"]),
            target_playlist=str(args.target_playlist or DEFAULT_TARGET_PLAYLIST),
            target_parent_id=int(args.target_parent_id or 0),
            differences=differences,
            copy_only=bool(args.copy_only),
        )
        apply_result = difference_apply_result

    summary = _build_summary(
        source=source,
        target_playlist=str(args.target_playlist or DEFAULT_TARGET_PLAYLIST),
        rows=rows,
        errors=errors,
        differences=differences,
        dry_run=dry_run,
        copy_only=bool(args.copy_only),
        device=device,
        prediction_cache_dir=prediction_cache_dir,
        cache_stats=cache_stats,
        elapsed_sec=time.time() - started_at,
    )
    payload = {
        "summary": {
            **summary,
            "applyResult": apply_result,
        },
        "differences": differences,
        "rows": rows,
        "errors": errors,
    }
    _atomic_write_json(output_path, payload)

    print(
        json.dumps(
            {
                "sourcePlaylist": summary["sourcePlaylist"],
                "targetPlaylistName": summary["targetPlaylistName"],
                "mode": summary["mode"],
                "strictToleranceMs": summary["strictToleranceMs"],
                "differenceTrackCount": summary["differenceTrackCount"],
                "errorTrackCount": summary["errorTrackCount"],
                "output": str(output_path),
                "applyResult": apply_result,
            },
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)
