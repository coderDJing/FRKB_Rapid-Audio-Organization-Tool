"""Clean the Rekordbox Upan playlist before sample triage.

Default behavior is a dry-run over the full ``Upan`` playlist. The cleanup order is fixed:

1. Remove duplicates from ``Upan``.
   - Tracks already present in current truth are removed completely.
   - Tracks duplicated only inside ``Upan`` keep the first playlist entry and remove extras.
2. Move remaining tracks whose displayed BPM is non-integer into ``upanNonIntegerBpm``.

The displayed BPM check uses the Rekordbox content BPM exposed as ``bpm`` by the bridge,
because that is closest to Rekordbox's BPM column. ``gridBpm`` is reported only for manual
inspection.
"""

import argparse
import json
import math
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from capture_rekordbox_playlist_truth import (
    DEFAULT_BRIDGE,
    DUPLICATE_BPM_TOLERANCE,
    _bridge_payload,
    _current_truth_duplicate_match,
    _duplicate_bpm,
    _duplicate_metadata_key,
    _load_current_truth_duplicate_index,
    _run_bridge,
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_CURRENT_TRUTH = BENCHMARK_OUTPUT_DIR / "rekordbox-current-truth.json"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "upan-source-cleanup-latest.json"
DEFAULT_SOURCE_PLAYLIST = "Upan"
DEFAULT_NON_INTEGER_TARGET_PLAYLIST = "upanNonIntegerBpm"
DEFAULT_BPM_TOLERANCE = 0.001
DEFAULT_PREVIEW_LIMIT = 20


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
    return int(round(numeric)) if numeric is not None else None


def _load_tree_nodes(bridge_path: Path, db_path: str) -> list[dict[str, Any]]:
    payload = _run_bridge(bridge_path, "load-tree", _bridge_payload(db_path))
    nodes = payload.get("nodes")
    if not isinstance(nodes, list):
        raise RuntimeError("Rekordbox playlist tree is invalid")
    return [item for item in nodes if isinstance(item, dict)]


def _resolve_playlist_node(
    bridge_path: Path,
    playlist_name: str,
    db_path: str,
    *,
    required: bool,
) -> dict[str, Any] | None:
    expected = _normalize_key(playlist_name)
    nodes = _load_tree_nodes(bridge_path, db_path)
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


def _load_playlist_tracks(bridge_path: Path, playlist_id: int, db_path: str) -> list[dict[str, Any]]:
    payload = _run_bridge(
        bridge_path,
        "load-playlist-tracks",
        {**_bridge_payload(db_path), "playlistId": playlist_id},
    )
    raw_tracks = payload.get("tracks")
    if not isinstance(raw_tracks, list):
        raise RuntimeError(f"failed to load tracks from playlist {playlist_id}")
    return [track for track in raw_tracks if isinstance(track, dict)]


def _empty_source_duplicate_index() -> dict[str, Any]:
    return {
        "trackIds": {},
        "fileNames": {},
        "metadata": {},
    }


def _register_source_unique_track(index: dict[str, Any], track: dict[str, Any]) -> None:
    track_id = _to_int(track.get("trackId"))
    if track_id is not None and track_id > 0:
        index["trackIds"][track_id] = track

    file_key = _normalize_key(track.get("fileName"))
    if file_key:
        index["fileNames"][file_key] = track

    metadata_key = _duplicate_metadata_key(track)
    bpm = _duplicate_bpm(track)
    if metadata_key is not None and bpm is not None:
        index["metadata"].setdefault(metadata_key, []).append(track)


def _source_duplicate_match(
    track: dict[str, Any],
    index: dict[str, Any],
) -> dict[str, Any] | None:
    track_id = _to_int(track.get("trackId"))
    if track_id is not None and track_id > 0:
        matched = index["trackIds"].get(track_id)
        if isinstance(matched, dict):
            return {
                "reason": "duplicate-in-source-playlist-track-id",
                "matchedTrack": matched,
            }

    file_key = _normalize_key(track.get("fileName"))
    if file_key:
        matched = index["fileNames"].get(file_key)
        if isinstance(matched, dict):
            return {
                "reason": "duplicate-in-source-playlist-file-name",
                "matchedTrack": matched,
            }

    metadata_key = _duplicate_metadata_key(track)
    bpm = _duplicate_bpm(track)
    if metadata_key is None or bpm is None:
        return None

    candidates = index["metadata"].get(metadata_key)
    if not isinstance(candidates, list):
        return None
    for matched in candidates:
        if not isinstance(matched, dict):
            continue
        matched_bpm = _duplicate_bpm(matched)
        if matched_bpm is None:
            continue
        if abs(bpm - matched_bpm) <= DUPLICATE_BPM_TOLERANCE:
            return {
                "reason": "duplicate-in-source-playlist-metadata",
                "matchedTrack": matched,
            }
    return None


def _dedupe_upan_tracks(
    tracks: list[dict[str, Any]],
    *,
    current_truth_path: Path,
) -> dict[str, Any]:
    current_truth_index = _load_current_truth_duplicate_index(current_truth_path)
    source_index = _empty_source_duplicate_index()
    kept_tracks: list[dict[str, Any]] = []
    current_truth_duplicates: list[dict[str, Any]] = []
    source_duplicate_extras: list[dict[str, Any]] = []
    reason_counts: dict[str, int] = {}

    for track in tracks:
        current_match = _current_truth_duplicate_match(track, current_truth_index)
        if current_match is not None:
            reason = str(current_match.get("reason") or "already-in-current-truth")
            reason_counts[reason] = reason_counts.get(reason, 0) + 1
            current_truth_duplicates.append(
                {
                    **_report_track(track),
                    "reason": reason,
                    "matchedFileName": current_match.get("matchedFileName"),
                }
            )
            continue

        source_match = _source_duplicate_match(track, source_index)
        if source_match is not None:
            reason = str(source_match.get("reason") or "duplicate-in-source-playlist")
            reason_counts[reason] = reason_counts.get(reason, 0) + 1
            matched_track = source_match.get("matchedTrack")
            item = {
                **_report_track(track),
                "reason": reason,
            }
            if isinstance(matched_track, dict):
                item["keptTrack"] = _report_track(matched_track)
            source_duplicate_extras.append(item)
            continue

        _register_source_unique_track(source_index, track)
        kept_tracks.append(track)

    return {
        "currentTruthPath": str(current_truth_path),
        "currentTruthTrackCount": int(current_truth_index.get("trackCount") or 0),
        "keptTracks": kept_tracks,
        "currentTruthDuplicates": current_truth_duplicates,
        "sourceDuplicateExtras": source_duplicate_extras,
        "duplicateRemovalTracks": current_truth_duplicates + source_duplicate_extras,
        "reasonCounts": reason_counts,
    }


def _is_non_integer_bpm(value: Any, tolerance: float) -> bool:
    bpm = _to_float(value)
    if bpm is None or bpm <= 0:
        return False
    return abs(bpm - round(bpm)) > tolerance


def _report_track(track: dict[str, Any]) -> dict[str, Any]:
    return {
        "fileName": str(track.get("fileName") or "").strip(),
        "title": str(track.get("title") or "").strip(),
        "artist": str(track.get("artist") or "").strip(),
        "bpm": track.get("bpm"),
        "gridBpm": track.get("gridBpm"),
        "trackId": track.get("trackId"),
        "rowKey": str(track.get("rowKey") or "").strip(),
    }


def _source_row_keys(items: list[dict[str, Any]]) -> list[str]:
    row_keys: list[str] = []
    seen: set[str] = set()
    for item in items:
        row_key = str(item.get("rowKey") or "").strip()
        if not row_key or row_key in seen:
            continue
        seen.add(row_key)
        row_keys.append(row_key)
    return row_keys


def _track_ids(tracks: list[dict[str, Any]]) -> list[int]:
    track_ids: list[int] = []
    for track in tracks:
        track_id = _to_int(track.get("trackId"))
        if track_id is not None and track_id > 0:
            track_ids.append(track_id)
    return track_ids


def _validate_remove_payload(items: list[dict[str, Any]], *, label: str) -> None:
    missing_row_keys = [
        str(item.get("fileName") or "")
        for item in items
        if not str(item.get("rowKey") or "").strip()
    ]
    if missing_row_keys:
        preview = ", ".join(missing_row_keys[:8])
        raise RuntimeError(f"cannot remove {label} without rowKey: {preview}")


def _validate_move_payload(tracks: list[dict[str, Any]]) -> None:
    missing_track_ids = [
        str(track.get("fileName") or "")
        for track in tracks
        if (_to_int(track.get("trackId")) or 0) <= 0
    ]
    if missing_track_ids:
        preview = ", ".join(missing_track_ids[:8])
        raise RuntimeError(f"cannot move tracks without Rekordbox trackId: {preview}")
    _validate_remove_payload(tracks, label="non-integer BPM playlist tracks")


def _probe_writable_database(bridge_path: Path, db_path: str) -> None:
    write_status = _run_bridge(bridge_path, "probe-write", _bridge_payload(db_path))
    if write_status.get("writable") is False:
        message = str(write_status.get("errorMessage") or "Rekordbox database is not writable")
        raise RuntimeError(message)


def _ensure_target_playlist(
    bridge_path: Path,
    db_path: str,
    *,
    target_playlist_name: str,
    target_parent_id: int,
) -> dict[str, Any]:
    node = _resolve_playlist_node(bridge_path, target_playlist_name, db_path, required=False)
    if node is not None:
        if node.get("isSmartPlaylist"):
            raise RuntimeError(f"target playlist is smart and cannot be written: {target_playlist_name}")
        playlist_id = _playlist_id(node)
        if playlist_id <= 0:
            raise RuntimeError(f"target playlist id is invalid: {target_playlist_name}")
        return {
            "playlistId": playlist_id,
            "playlistName": str(node.get("name") or target_playlist_name).strip(),
            "created": False,
        }

    payload = _run_bridge(
        bridge_path,
        "create-empty-playlist",
        {
            **_bridge_payload(db_path),
            "playlistName": target_playlist_name,
            "parentId": target_parent_id,
        },
    )
    return {
        "playlistId": int(payload.get("playlistId") or 0),
        "playlistName": str(payload.get("playlistName") or target_playlist_name).strip(),
        "created": True,
    }


def _remove_tracks(
    bridge_path: Path,
    db_path: str,
    *,
    source_playlist_id: int,
    tracks: list[dict[str, Any]],
    label: str,
) -> dict[str, Any]:
    if not tracks:
        return {
            "applied": True,
            "removeResult": None,
        }

    _validate_remove_payload(tracks, label=label)
    remove_result = _run_bridge(
        bridge_path,
        "remove-playlist-tracks",
        {
            **_bridge_payload(db_path),
            "playlistId": source_playlist_id,
            "rowKeys": _source_row_keys(tracks),
        },
    )
    return {
        "applied": True,
        "removeResult": remove_result,
    }


def _move_non_integer_tracks(
    bridge_path: Path,
    db_path: str,
    *,
    source_playlist_id: int,
    target_playlist_name: str,
    target_parent_id: int,
    tracks: list[dict[str, Any]],
) -> dict[str, Any]:
    if not tracks:
        return {
            "applied": True,
            "targetPlaylist": None,
            "appendResult": None,
            "removeResult": None,
        }

    _validate_move_payload(tracks)
    target = _ensure_target_playlist(
        bridge_path,
        db_path,
        target_playlist_name=target_playlist_name,
        target_parent_id=target_parent_id,
    )
    target_playlist_id = int(target.get("playlistId") or 0)
    if target_playlist_id <= 0:
        raise RuntimeError(f"target playlist id is invalid: {target_playlist_name}")
    if target_playlist_id == source_playlist_id:
        raise RuntimeError("source playlist and target playlist are the same; refusing to move")

    append_result = _run_bridge(
        bridge_path,
        "append-existing-playlist-tracks",
        {
            **_bridge_payload(db_path),
            "playlistId": target_playlist_id,
            "trackIds": _track_ids(tracks),
        },
    )
    remove_result = _run_bridge(
        bridge_path,
        "remove-playlist-tracks",
        {
            **_bridge_payload(db_path),
            "playlistId": source_playlist_id,
            "rowKeys": _source_row_keys(tracks),
        },
    )

    return {
        "applied": True,
        "targetPlaylist": target,
        "appendResult": append_result,
        "removeResult": remove_result,
    }


def _apply_cleanup(
    bridge_path: Path,
    db_path: str,
    *,
    source_playlist_id: int,
    non_integer_target_playlist: str,
    target_parent_id: int,
    duplicate_removal_tracks: list[dict[str, Any]],
    non_integer_tracks: list[dict[str, Any]],
) -> dict[str, Any]:
    _probe_writable_database(bridge_path, db_path)
    duplicate_remove_result = _remove_tracks(
        bridge_path,
        db_path,
        source_playlist_id=source_playlist_id,
        tracks=duplicate_removal_tracks,
        label="duplicate playlist tracks",
    )
    non_integer_move_result = _move_non_integer_tracks(
        bridge_path,
        db_path,
        source_playlist_id=source_playlist_id,
        target_playlist_name=non_integer_target_playlist,
        target_parent_id=target_parent_id,
        tracks=non_integer_tracks,
    )
    return {
        "applied": True,
        "duplicateRemoveResult": duplicate_remove_result,
        "nonIntegerMoveResult": non_integer_move_result,
    }


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def _build_report(
    *,
    source_node: dict[str, Any],
    non_integer_target_playlist: str,
    tracks: list[dict[str, Any]],
    dedupe: dict[str, Any],
    non_integer_tracks: list[dict[str, Any]],
    missing_bpm_tracks: list[dict[str, Any]],
    tolerance: float,
    dry_run: bool,
    elapsed_sec: float,
    preview_limit: int,
    apply_result: dict[str, Any] | None,
) -> dict[str, Any]:
    current_truth_duplicates = dedupe["currentTruthDuplicates"]
    source_duplicate_extras = dedupe["sourceDuplicateExtras"]
    duplicate_removal_tracks = dedupe["duplicateRemovalTracks"]
    non_integer_reports = [_report_track(track) for track in non_integer_tracks]
    missing_bpm_reports = [_report_track(track) for track in missing_bpm_tracks]
    return {
        "summary": {
            "sourcePlaylist": {
                "playlistId": _playlist_id(source_node),
                "playlistName": str(source_node.get("name") or "").strip(),
                "trackTotal": len(tracks),
            },
            "nonIntegerTargetPlaylistName": non_integer_target_playlist,
            "mode": "dry-run" if dry_run else "cleanup",
            "cleanupOrder": [
                "remove current-truth duplicates and source duplicate extras from source playlist",
                "move remaining non-integer displayed BPM tracks to review playlist",
            ],
            "currentTruthPath": dedupe["currentTruthPath"],
            "currentTruthTrackCount": dedupe["currentTruthTrackCount"],
            "duplicateRemovalTrackCount": len(duplicate_removal_tracks),
            "currentTruthDuplicateTrackCount": len(current_truth_duplicates),
            "sourceDuplicateExtraTrackCount": len(source_duplicate_extras),
            "postDedupeTrackCount": len(dedupe["keptTracks"]),
            "duplicateReasonCounts": dedupe["reasonCounts"],
            "bpmField": "bpm",
            "integerTolerance": tolerance,
            "nonIntegerBpmTrackCount": len(non_integer_tracks),
            "postCleanupTrackCount": len(dedupe["keptTracks"]) - len(non_integer_tracks),
            "missingOrInvalidBpmTrackCount": len(missing_bpm_tracks),
            "duplicateRowKeyCount": len(_source_row_keys(duplicate_removal_tracks)),
            "nonIntegerTrackIdCount": len(_track_ids(non_integer_tracks)),
            "nonIntegerRowKeyCount": len(_source_row_keys(non_integer_tracks)),
            "outputPreviewLimit": preview_limit,
            "elapsedSec": round(elapsed_sec, 3),
            "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "applyResult": apply_result,
        },
        "currentTruthDuplicateTracks": current_truth_duplicates,
        "currentTruthDuplicatePreview": current_truth_duplicates[:preview_limit],
        "sourceDuplicateExtraTracks": source_duplicate_extras,
        "sourceDuplicateExtraPreview": source_duplicate_extras[:preview_limit],
        "nonIntegerBpmTracks": non_integer_reports,
        "nonIntegerBpmPreview": non_integer_reports[:preview_limit],
        "missingOrInvalidBpmTracks": missing_bpm_reports,
        "missingOrInvalidBpmPreview": missing_bpm_reports[:preview_limit],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Clean Upan duplicates, then move remaining non-integer displayed BPM tracks.",
    )
    parser.add_argument("--source", default=DEFAULT_SOURCE_PLAYLIST)
    parser.add_argument("--target", default=DEFAULT_NON_INTEGER_TARGET_PLAYLIST)
    parser.add_argument("--target-parent-id", type=int, default=0)
    parser.add_argument("--bridge", default=str(DEFAULT_BRIDGE))
    parser.add_argument("--db-path", default="")
    parser.add_argument("--current-truth", default=str(DEFAULT_CURRENT_TRUTH))
    parser.add_argument("--tolerance", type=float, default=DEFAULT_BPM_TOLERANCE)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--preview-limit", type=int, default=DEFAULT_PREVIEW_LIMIT)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually remove duplicates and move non-integer BPM tracks. Default is dry-run.",
    )
    args = parser.parse_args()

    bridge_path = Path(args.bridge)
    if not bridge_path.exists():
        raise SystemExit(f"bridge not found: {bridge_path}")

    tolerance = abs(float(args.tolerance))
    source_name = str(args.source or DEFAULT_SOURCE_PLAYLIST)
    target_name = str(args.target or DEFAULT_NON_INTEGER_TARGET_PLAYLIST)
    db_path = str(args.db_path or "")
    current_truth_path = Path(str(args.current_truth or DEFAULT_CURRENT_TRUTH))
    started_at = time.time()

    source_node = _resolve_playlist_node(bridge_path, source_name, db_path, required=True)
    if source_node is None:
        raise RuntimeError(f"playlist not found: {source_name}")
    if source_node.get("isSmartPlaylist"):
        raise RuntimeError(f"source playlist is smart and cannot be cleaned: {source_name}")
    source_playlist_id = _playlist_id(source_node)
    if source_playlist_id <= 0:
        raise RuntimeError(f"source playlist id is invalid: {source_name}")

    target_node = _resolve_playlist_node(bridge_path, target_name, db_path, required=False)
    if target_node is not None and _playlist_id(target_node) == source_playlist_id:
        raise RuntimeError("source playlist and target playlist are the same; refusing to move")

    print(f"正在扫描源歌单: {source_node.get('name')} (id={source_playlist_id})", flush=True)
    tracks = _load_playlist_tracks(bridge_path, source_playlist_id, db_path)
    print(f"源歌单共 {len(tracks)} 首曲目", flush=True)

    dedupe = _dedupe_upan_tracks(tracks, current_truth_path=current_truth_path)
    kept_tracks = dedupe["keptTracks"]
    non_integer_tracks = [track for track in kept_tracks if _is_non_integer_bpm(track.get("bpm"), tolerance)]
    missing_bpm_tracks = [
        track
        for track in kept_tracks
        if (_to_float(track.get("bpm")) is None or (_to_float(track.get("bpm")) or 0) <= 0)
    ]
    print(f"待移除重复条目: {len(dedupe['duplicateRemovalTracks'])} 首", flush=True)
    print(f"  current truth 重复: {len(dedupe['currentTruthDuplicates'])} 首", flush=True)
    print(f"  源歌单内部重复多余项: {len(dedupe['sourceDuplicateExtras'])} 首", flush=True)
    print(f"去重后剩余: {len(kept_tracks)} 首", flush=True)
    print(f"UI BPM 非整数曲目: {len(non_integer_tracks)} 首", flush=True)
    print(f"UI BPM 缺失或无效曲目: {len(missing_bpm_tracks)} 首", flush=True)

    dry_run = not bool(args.apply)
    apply_result = None
    if not dry_run:
        apply_result = _apply_cleanup(
            bridge_path,
            db_path,
            source_playlist_id=source_playlist_id,
            non_integer_target_playlist=target_name,
            target_parent_id=int(args.target_parent_id or 0),
            duplicate_removal_tracks=dedupe["duplicateRemovalTracks"],
            non_integer_tracks=non_integer_tracks,
        )

    output_path = Path(str(args.output or DEFAULT_OUTPUT))
    report = _build_report(
        source_node=source_node,
        non_integer_target_playlist=target_name,
        tracks=tracks,
        dedupe=dedupe,
        non_integer_tracks=non_integer_tracks,
        missing_bpm_tracks=missing_bpm_tracks,
        tolerance=tolerance,
        dry_run=dry_run,
        elapsed_sec=time.time() - started_at,
        preview_limit=max(0, int(args.preview_limit or 0)),
        apply_result=apply_result,
    )
    _atomic_write_json(output_path, report)

    print(
        json.dumps(
            {
                "sourcePlaylist": report["summary"]["sourcePlaylist"],
                "nonIntegerTargetPlaylistName": target_name,
                "mode": report["summary"]["mode"],
                "duplicateRemovalTrackCount": report["summary"]["duplicateRemovalTrackCount"],
                "currentTruthDuplicateTrackCount": report["summary"]["currentTruthDuplicateTrackCount"],
                "sourceDuplicateExtraTrackCount": report["summary"]["sourceDuplicateExtraTrackCount"],
                "postDedupeTrackCount": report["summary"]["postDedupeTrackCount"],
                "bpmField": report["summary"]["bpmField"],
                "integerTolerance": report["summary"]["integerTolerance"],
                "nonIntegerBpmTrackCount": report["summary"]["nonIntegerBpmTrackCount"],
                "missingOrInvalidBpmTrackCount": report["summary"]["missingOrInvalidBpmTrackCount"],
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
