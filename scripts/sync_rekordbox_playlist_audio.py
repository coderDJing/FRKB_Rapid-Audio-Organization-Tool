import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from capture_rekordbox_playlist_truth import (
    DEFAULT_BRIDGE,
    _bridge_payload,
    _current_truth_duplicate_match,
    _load_current_truth_duplicate_index,
    _resolve_playlist_id,
    _run_bridge,
)
from frkb_database_paths import FRKB_FILTER_NEW_ROOT

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_CURRENT_TRUTH = BENCHMARK_OUTPUT_DIR / "rekordbox-current-truth.json"
DEFAULT_TARGET_ROOT = FRKB_FILTER_NEW_ROOT


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _select_requested_tracks(tracks: list[dict[str, Any]], requested_names: list[str]) -> list[dict[str, Any]]:
    requested = [_normalize_key(name) for name in requested_names if _normalize_key(name)]
    if not requested:
        return tracks
    if len(set(requested)) != len(requested):
        raise SystemExit("--file-name contains duplicate values")
    by_name: dict[str, dict[str, Any]] = {}
    for track in tracks:
        name = _normalize_key(track.get("fileName"))
        if not name or name in by_name:
            raise SystemExit("playlist contains duplicate or empty fileName values")
        by_name[name] = track
    missing = [name for name in requested if name not in by_name]
    if missing:
        raise SystemExit("requested playlist tracks are missing: " + ", ".join(missing[:8]))
    return [by_name[name] for name in requested]


def _requested_file_names(args: argparse.Namespace) -> list[str]:
    requested = [str(value) for value in args.file_name]
    raw_list_path = str(args.file_list or "").strip()
    if raw_list_path:
        list_path = Path(raw_list_path)
        if not list_path.is_file():
            raise SystemExit(f"file list not found: {list_path}")
        requested.extend(list_path.read_text(encoding="utf-8").splitlines())
    return requested


def _load_playlist_tracks(
    *,
    bridge_path: Path,
    playlist_name: str,
    db_path: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    playlist_id, resolved_name = _resolve_playlist_id(bridge_path, playlist_name, db_path)
    payload = _run_bridge(
        bridge_path,
        "load-playlist-tracks",
        {
            **_bridge_payload(db_path),
            "playlistId": playlist_id,
        },
    )
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise RuntimeError(f"playlist has no tracks: {resolved_name}")
    return payload, [track for track in tracks if isinstance(track, dict)]


def _resolve_copy_plan(
    *,
    tracks: list[dict[str, Any]],
    target_root: Path,
    existing_truth_index: dict[str, Any],
    overwrite: bool,
) -> tuple[list[dict[str, str]], list[dict[str, str]], list[str]]:
    copy_items: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    errors: list[str] = []
    planned_destinations: set[str] = set()

    for track in tracks:
        source_path = Path(str(track.get("filePath") or "").strip())
        file_name = str(track.get("fileName") or source_path.name).strip()
        key = _normalize_key(file_name)
        if not key:
            errors.append("playlist track has no fileName")
            continue
        duplicate_match = _current_truth_duplicate_match(track, existing_truth_index)
        if duplicate_match is not None:
            skipped.append({"fileName": file_name, **duplicate_match})
            continue
        if not source_path.exists() or not source_path.is_file():
            errors.append(f"source file missing: {source_path}")
            continue

        destination_path = target_root / file_name
        destination_key = _normalize_key(destination_path)
        if destination_key in planned_destinations:
            errors.append(f"duplicate destination fileName in playlist: {file_name}")
            continue
        planned_destinations.add(destination_key)

        if destination_path.exists() and not overwrite:
            if destination_path.stat().st_size == source_path.stat().st_size:
                skipped.append({"fileName": file_name, "reason": "already-in-new"})
                continue
            errors.append(f"destination collision: {destination_path}")
            continue

        copy_items.append(
            {
                "fileName": file_name,
                "source": str(source_path),
                "destination": str(destination_path),
            }
        )

    return copy_items, skipped, errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Copy new Rekordbox playlist audio files into FRKB new staging")
    parser.add_argument("--playlist", default="test")
    parser.add_argument("--bridge", default=str(DEFAULT_BRIDGE))
    parser.add_argument("--db-path", default="")
    parser.add_argument("--current-truth", default=str(DEFAULT_CURRENT_TRUTH))
    parser.add_argument("--target-root", default=str(DEFAULT_TARGET_ROOT))
    parser.add_argument(
        "--file-name",
        action="append",
        default=[],
        help="Require and copy only these exact playlist file names. Can be repeated.",
    )
    parser.add_argument(
        "--file-list",
        default="",
        help="UTF-8 text file containing one exact playlist file name per line.",
    )
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    bridge_path = Path(args.bridge)
    target_root = Path(args.target_root)
    current_truth_path = Path(args.current_truth)

    if not bridge_path.exists():
        raise SystemExit(f"bridge not found: {bridge_path}")

    payload, tracks = _load_playlist_tracks(
        bridge_path=bridge_path,
        playlist_name=str(args.playlist),
        db_path=str(args.db_path or ""),
    )
    tracks = _select_requested_tracks(tracks, _requested_file_names(args))
    existing_truth_index = _load_current_truth_duplicate_index(current_truth_path)
    copy_items, skipped, errors = _resolve_copy_plan(
        tracks=tracks,
        target_root=target_root,
        existing_truth_index=existing_truth_index,
        overwrite=bool(args.overwrite),
    )

    if errors:
        preview = "\n".join(errors[:10])
        raise SystemExit(f"sync plan has errors:\n{preview}")

    if not args.dry_run:
        target_root.mkdir(parents=True, exist_ok=True)
        for item in copy_items:
            destination = Path(item["destination"])
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item["source"], destination)

    print(
        json.dumps(
            {
                "playlistName": payload.get("playlistName"),
                "playlistId": payload.get("playlistId"),
                "playlistTrackCount": len(tracks),
                "currentTruthTrackCount": int(existing_truth_index.get("trackCount") or 0),
                "copyCount": len(copy_items),
                "skippedCount": len(skipped),
                "targetRoot": str(target_root),
                "dryRun": bool(args.dry_run),
                "copied": copy_items,
                "skipped": skipped[:20],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
