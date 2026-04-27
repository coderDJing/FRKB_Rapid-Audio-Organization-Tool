import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BRIDGE = REPO_ROOT / "resources" / "rekordboxDesktopLibrary" / "bridge.py"
DEFAULT_TRUTH = REPO_ROOT / "resources" / "rkbRekordboxGridSnapshot.json"
DEFAULT_AUDIO_ROOT = Path("D:/FRKB_database-B/library/FilterLibrary/new")


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric


def _to_int(value: Any) -> int | None:
    numeric = _to_float(value)
    if numeric is None:
        return None
    return int(round(numeric))


def _run_bridge(bridge_path: Path, command: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = json.dumps({"command": command, "payload": payload}, ensure_ascii=False)
    result = subprocess.run(
        [sys.executable, str(bridge_path)],
        input=request,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "").strip() or f"bridge failed: {command}")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError(f"bridge returned empty response: {command}")
    response = json.loads(lines[-1])
    if not response.get("ok"):
        error = response.get("error") if isinstance(response, dict) else None
        message = error.get("message") if isinstance(error, dict) else None
        raise RuntimeError(str(message or f"bridge returned error: {command}"))
    result_payload = response.get("result")
    if not isinstance(result_payload, dict):
        raise RuntimeError(f"bridge returned invalid result: {command}")
    return result_payload


def _bridge_payload(db_path: str) -> dict[str, Any]:
    return {"dbPath": db_path} if db_path.strip() else {}


def _resolve_playlist_id(bridge_path: Path, playlist_name: str, db_path: str) -> tuple[int, str]:
    tree = _run_bridge(bridge_path, "load-tree", _bridge_payload(db_path))
    nodes = tree.get("nodes")
    if not isinstance(nodes, list):
        raise RuntimeError("Rekordbox playlist tree is invalid")

    expected = _normalize_key(playlist_name)
    matches = [
        item
        for item in nodes
        if isinstance(item, dict)
        and not item.get("isFolder")
        and _normalize_key(item.get("name")) == expected
    ]
    if not matches:
        available = ", ".join(str(item.get("name")) for item in nodes if isinstance(item, dict))
        raise RuntimeError(f"playlist not found: {playlist_name}; available: {available}")
    if len(matches) > 1:
        ids = ", ".join(str(item.get("id")) for item in matches)
        raise RuntimeError(f"playlist name is ambiguous: {playlist_name}; ids: {ids}")

    match = matches[0]
    playlist_id = _to_int(match.get("id")) or 0
    resolved_name = str(match.get("name") or playlist_name).strip()
    if playlist_id <= 0:
        raise RuntimeError(f"playlist id is invalid: {playlist_name}")
    return playlist_id, resolved_name


def _truth_track_from_rekordbox_track(track: dict[str, Any]) -> dict[str, Any]:
    file_name = str(track.get("fileName") or "").strip()
    bpm = _to_float(track.get("gridBpm"))
    first_beat_ms = _to_float(track.get("gridFirstBeatMs"))
    first_beat_label = _to_int(track.get("gridFirstBeatLabel"))
    bar_beat_offset = _to_int(track.get("gridBarBeatOffset"))

    if not file_name:
        raise RuntimeError("track has no fileName")
    if bpm is None or bpm <= 0:
        raise RuntimeError(f"track has invalid gridBpm: {file_name}")
    if first_beat_ms is None or first_beat_ms < 0:
        raise RuntimeError(f"track has invalid gridFirstBeatMs: {file_name}")
    if first_beat_label is None or first_beat_label < 1 or first_beat_label > 4:
        raise RuntimeError(f"track has invalid gridFirstBeatLabel: {file_name}")
    if bar_beat_offset is None:
        raise RuntimeError(f"track has invalid gridBarBeatOffset: {file_name}")

    return {
        "fileName": file_name,
        "title": str(track.get("title") or "").strip(),
        "artist": str(track.get("artist") or "").strip(),
        "bpm": round(float(bpm), 6),
        "firstBeatMs": round(float(first_beat_ms), 3),
        "firstBeatLabel": int(first_beat_label),
        "barBeatOffset": int(bar_beat_offset) % 4,
    }


def _load_playlist_truth(
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

    truth_tracks = [_truth_track_from_rekordbox_track(track) for track in tracks if isinstance(track, dict)]
    if len(truth_tracks) != len(tracks):
        raise RuntimeError(f"some playlist tracks are invalid: {resolved_name}")

    source = {
        "type": "rekordbox-playlist-grid-snapshot",
        "dbPath": str((payload.get("probe") or {}).get("dbPath") or ""),
        "playlistName": resolved_name,
        "playlistId": playlist_id,
        "trackCount": len(truth_tracks),
        "capturedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    return source, truth_tracks


def _validate_audio_root(audio_root: Path, tracks: list[dict[str, Any]]) -> list[str]:
    if not audio_root.exists():
        raise RuntimeError(f"audio root not found: {audio_root}")
    existing = {_normalize_key(item.name) for item in audio_root.iterdir() if item.is_file()}
    return [
        str(item.get("fileName") or "")
        for item in tracks
        if _normalize_key(item.get("fileName")) not in existing
    ]


def _build_snapshot(source: dict[str, Any], tracks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "source": source,
        "tracks": tracks,
    }


def _merge_truth(
    truth_path: Path,
    source: dict[str, Any],
    new_tracks: list[dict[str, Any]],
) -> dict[str, Any]:
    existing = json.loads(truth_path.read_text(encoding="utf-8"))
    if not isinstance(existing, dict):
        raise RuntimeError(f"truth is not an object: {truth_path}")

    existing_tracks = existing.get("tracks")
    if not isinstance(existing_tracks, list):
        raise RuntimeError(f"truth has no tracks array: {truth_path}")

    new_keys = {_normalize_key(item.get("fileName")) for item in new_tracks}
    merged_tracks = [
        item
        for item in existing_tracks
        if isinstance(item, dict) and _normalize_key(item.get("fileName")) not in new_keys
    ]
    merged_tracks.extend(new_tracks)

    existing_source = existing.get("source") if isinstance(existing.get("source"), dict) else {}
    source_playlists = existing_source.get("sourcePlaylists") if isinstance(existing_source, dict) else None
    playlist_summaries = [
        item
        for item in (source_playlists if isinstance(source_playlists, list) else [])
        if isinstance(item, dict) and _normalize_key(item.get("playlistName")) != _normalize_key(source.get("playlistName"))
    ]
    playlist_summaries.append(
        {
            "playlistName": source.get("playlistName"),
            "playlistId": source.get("playlistId"),
            "trackCount": len(new_tracks),
        }
    )

    merged_source = {
        **existing_source,
        "type": "rekordbox-truth-unified-grid-snapshot",
        "dbPath": source.get("dbPath") or existing_source.get("dbPath"),
        "sourcePlaylists": playlist_summaries,
        "playlistName": "rekordbox-truth-unified-samples",
        "trackCount": len(merged_tracks),
        "note": f"{datetime.now().strftime('%Y-%m-%d')} unified FRKB sample/new Rekordbox truth snapshot",
    }
    return {
        "source": merged_source,
        "tracks": merged_tracks,
    }


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture Rekordbox playlist grid truth")
    parser.add_argument("--playlist", required=True)
    parser.add_argument("--bridge", default=str(DEFAULT_BRIDGE))
    parser.add_argument("--audio-root", default=str(DEFAULT_AUDIO_ROOT))
    parser.add_argument("--truth", default=str(DEFAULT_TRUTH))
    parser.add_argument("--db-path", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--merge", action="store_true")
    args = parser.parse_args()

    bridge_path = Path(args.bridge)
    audio_root = Path(args.audio_root)
    truth_path = Path(args.truth)
    output_path = Path(args.output) if str(args.output or "").strip() else None

    if not bridge_path.exists():
        raise SystemExit(f"bridge not found: {bridge_path}")

    source, tracks = _load_playlist_truth(bridge_path, args.playlist, str(args.db_path or ""))
    missing_audio = _validate_audio_root(audio_root, tracks)
    if missing_audio:
        preview = ", ".join(missing_audio[:8])
        raise SystemExit(f"playlist tracks missing from audio root: {preview}")

    captured_payload = _build_snapshot(source, tracks)
    if output_path is not None:
        _write_json(output_path, captured_payload)

    if args.merge:
        if not truth_path.exists():
            raise SystemExit(f"truth not found: {truth_path}")
        merged_payload = _merge_truth(truth_path, source, tracks)
        _write_json(truth_path, merged_payload)
        merged_count = len(merged_payload.get("tracks") or [])
    else:
        merged_count = 0

    print(
        json.dumps(
            {
                "playlistName": source.get("playlistName"),
                "playlistId": source.get("playlistId"),
                "capturedTrackCount": len(tracks),
                "output": str(output_path) if output_path else "",
                "merged": bool(args.merge),
                "mergedTrackCount": merged_count,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
