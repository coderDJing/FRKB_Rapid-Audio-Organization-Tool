"""Move Rekordbox tracks whose displayed BPM is non-integer into a review playlist.

Default behavior is a dry-run over the full ``Upan`` playlist. Add ``--apply`` to create or
reuse ``upanNonIntegerBpm``, append the matching tracks there, and remove those playlist entries
from ``Upan``. This script uses the Rekordbox content BPM exposed as ``bpm`` by the bridge,
because that is the value closest to Rekordbox's BPM column. ``gridBpm`` is reported only for
manual inspection.
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
    _bridge_payload,
    _run_bridge,
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "upan-non-integer-bpm-latest.json"
DEFAULT_SOURCE_PLAYLIST = "Upan"
DEFAULT_TARGET_PLAYLIST = "upanNonIntegerBpm"
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


def _source_row_keys(tracks: list[dict[str, Any]]) -> list[str]:
    row_keys: list[str] = []
    seen: set[str] = set()
    for track in tracks:
        row_key = str(track.get("rowKey") or "").strip()
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


def _validate_move_payload(tracks: list[dict[str, Any]]) -> None:
    missing_track_ids = [
        str(track.get("fileName") or "")
        for track in tracks
        if (_to_int(track.get("trackId")) or 0) <= 0
    ]
    if missing_track_ids:
        preview = ", ".join(missing_track_ids[:8])
        raise RuntimeError(f"cannot move tracks without Rekordbox trackId: {preview}")

    missing_row_keys = [
        str(track.get("fileName") or "")
        for track in tracks
        if not str(track.get("rowKey") or "").strip()
    ]
    if missing_row_keys:
        preview = ", ".join(missing_row_keys[:8])
        raise RuntimeError(f"cannot remove source playlist entries without rowKey: {preview}")


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


def _apply_move(
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
    _probe_writable_database(bridge_path, db_path)
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


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def _build_report(
    *,
    source_node: dict[str, Any],
    target_playlist_name: str,
    tracks: list[dict[str, Any]],
    selected_tracks: list[dict[str, Any]],
    missing_bpm_tracks: list[dict[str, Any]],
    tolerance: float,
    dry_run: bool,
    elapsed_sec: float,
    preview_limit: int,
    apply_result: dict[str, Any] | None,
) -> dict[str, Any]:
    selected_reports = [_report_track(track) for track in selected_tracks]
    missing_bpm_reports = [_report_track(track) for track in missing_bpm_tracks]
    return {
        "summary": {
            "sourcePlaylist": {
                "playlistId": _playlist_id(source_node),
                "playlistName": str(source_node.get("name") or "").strip(),
                "trackTotal": len(tracks),
            },
            "targetPlaylistName": target_playlist_name,
            "mode": "dry-run" if dry_run else "move",
            "bpmField": "bpm",
            "integerTolerance": tolerance,
            "nonIntegerBpmTrackCount": len(selected_tracks),
            "integerOrUnknownBpmTrackCount": len(tracks) - len(selected_tracks),
            "missingOrInvalidBpmTrackCount": len(missing_bpm_tracks),
            "trackIdCount": len(_track_ids(selected_tracks)),
            "rowKeyCount": len(_source_row_keys(selected_tracks)),
            "outputPreviewLimit": preview_limit,
            "elapsedSec": round(elapsed_sec, 3),
            "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "applyResult": apply_result,
        },
        "nonIntegerBpmTracks": selected_reports,
        "nonIntegerBpmPreview": selected_reports[:preview_limit],
        "missingOrInvalidBpmTracks": missing_bpm_reports,
        "missingOrInvalidBpmPreview": missing_bpm_reports[:preview_limit],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Move full-playlist Rekordbox tracks with non-integer displayed BPM to review.",
    )
    parser.add_argument("--source", default=DEFAULT_SOURCE_PLAYLIST)
    parser.add_argument("--target", default=DEFAULT_TARGET_PLAYLIST)
    parser.add_argument("--target-parent-id", type=int, default=0)
    parser.add_argument("--bridge", default=str(DEFAULT_BRIDGE))
    parser.add_argument("--db-path", default="")
    parser.add_argument("--tolerance", type=float, default=DEFAULT_BPM_TOLERANCE)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--preview-limit", type=int, default=DEFAULT_PREVIEW_LIMIT)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually create/append/remove Rekordbox playlist entries. Default is dry-run.",
    )
    args = parser.parse_args()

    bridge_path = Path(args.bridge)
    if not bridge_path.exists():
        raise SystemExit(f"bridge not found: {bridge_path}")

    tolerance = abs(float(args.tolerance))
    source_name = str(args.source or DEFAULT_SOURCE_PLAYLIST)
    target_name = str(args.target or DEFAULT_TARGET_PLAYLIST)
    db_path = str(args.db_path or "")
    started_at = time.time()

    source_node = _resolve_playlist_node(bridge_path, source_name, db_path, required=True)
    if source_node is None:
        raise RuntimeError(f"playlist not found: {source_name}")
    if source_node.get("isSmartPlaylist"):
        raise RuntimeError(f"source playlist is smart and cannot be moved from: {source_name}")
    source_playlist_id = _playlist_id(source_node)
    if source_playlist_id <= 0:
        raise RuntimeError(f"source playlist id is invalid: {source_name}")

    target_node = _resolve_playlist_node(bridge_path, target_name, db_path, required=False)
    if target_node is not None and _playlist_id(target_node) == source_playlist_id:
        raise RuntimeError("source playlist and target playlist are the same; refusing to move")

    print(f"正在扫描源歌单: {source_node.get('name')} (id={source_playlist_id})", flush=True)
    tracks = _load_playlist_tracks(bridge_path, source_playlist_id, db_path)
    print(f"源歌单共 {len(tracks)} 首曲目", flush=True)

    selected_tracks = [track for track in tracks if _is_non_integer_bpm(track.get("bpm"), tolerance)]
    missing_bpm_tracks = [
        track for track in tracks if (_to_float(track.get("bpm")) is None or (_to_float(track.get("bpm")) or 0) <= 0)
    ]
    print(f"UI BPM 非整数曲目: {len(selected_tracks)} 首", flush=True)
    print(f"UI BPM 缺失或无效曲目: {len(missing_bpm_tracks)} 首", flush=True)

    dry_run = not bool(args.apply)
    apply_result = None
    if not dry_run:
        apply_result = _apply_move(
            bridge_path,
            db_path,
            source_playlist_id=source_playlist_id,
            target_playlist_name=target_name,
            target_parent_id=int(args.target_parent_id or 0),
            tracks=selected_tracks,
        )

    output_path = Path(str(args.output or DEFAULT_OUTPUT))
    report = _build_report(
        source_node=source_node,
        target_playlist_name=target_name,
        tracks=tracks,
        selected_tracks=selected_tracks,
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
                "targetPlaylistName": target_name,
                "mode": report["summary"]["mode"],
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
