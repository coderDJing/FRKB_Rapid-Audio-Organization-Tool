import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

PYREKORDBOX_IMPORT_ERROR: Optional[str] = None

try:
    from pyrekordbox import Rekordbox6Database, get_config, update_config
    from pyrekordbox.config import get_pioneer_app_dir, read_rekordbox6_options
    from pyrekordbox.db6 import tables
except Exception as exc:  # pragma: no cover
    PYREKORDBOX_IMPORT_ERROR = str(exc)
    Rekordbox6Database = None  # type: ignore[assignment]
    get_config = None  # type: ignore[assignment]
    update_config = None  # type: ignore[assignment]
    get_pioneer_app_dir = None  # type: ignore[assignment]
    read_rekordbox6_options = None  # type: ignore[assignment]
    tables = None  # type: ignore[assignment]

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def _ok(result: Any) -> Dict[str, Any]:
    return {"ok": True, "result": result}


def _error(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


def _write_response(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def _read_request() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty request")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("request must be a JSON object")
    return data


def _normalize_path(path_value: Any) -> str:
    value = str(path_value or "").strip()
    if not value:
        return ""
    return os.path.normpath(value)


def _normalize_rel_path(path_value: Any) -> str:
    value = str(path_value or "").strip().replace("\\", "/")
    return value.lstrip("/")


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value).strip())
    except Exception:
        return default


def _parse_float(value: Any) -> Optional[float]:
    try:
        num = float(value)
    except Exception:
        return None
    if not (num == num):
        return None
    return num


def _normalize_bpm(value: Any) -> Optional[float]:
    num = _parse_float(value)
    if num is None or num <= 0:
        return None
    return num / 100.0 if num > 1000 else num


def _format_duration(seconds: Any) -> str:
    total = max(0, _parse_int(seconds, 0))
    minutes = total // 60
    remainder = total % 60
    return f"{minutes:02d}:{remainder:02d}"


def _derive_file_name(file_path: str, fallback: Any = "") -> str:
    normalized = _normalize_path(file_path)
    if normalized:
        return Path(normalized).name
    return str(fallback or "").strip()


def _derive_file_format(file_name: str, file_path: str) -> str:
    source = file_name or file_path
    suffix = Path(str(source or "")).suffix
    return suffix[1:].upper() if suffix.startswith(".") else ""


def _normalize_date(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            return str(value.isoformat())
        except Exception:
            return str(value)
    text = str(value).strip()
    return text or None


def _resolve_candidate_path(raw_path: Any, candidates: Iterable[str]) -> str:
    normalized_raw = str(raw_path or "").strip()
    if not normalized_raw:
        return ""
    path_value = Path(normalized_raw)
    if path_value.is_absolute():
        return _normalize_path(path_value)

    stripped = normalized_raw.lstrip("/\\")
    normalized_candidates = [Path(candidate) for candidate in candidates if str(candidate).strip()]
    for base in normalized_candidates:
        candidate = base / stripped
        if candidate.exists():
            return _normalize_path(candidate)
    if normalized_candidates:
        return _normalize_path(normalized_candidates[0] / stripped)
    return _normalize_path(path_value)


def _resolve_track_analyze_path(db: Any, content: Any, share_dir: str) -> str:
    if db is None or content is None:
        return ""
    for file_type in ("DAT", "EXT", "EX2"):
        try:
            analyze_path = db.get_anlz_path(content, file_type)
        except Exception:
            analyze_path = None
        if analyze_path:
            try:
                relative = Path(analyze_path).relative_to(Path(share_dir))
                return _normalize_rel_path(relative)
            except Exception:
                return _normalize_rel_path(analyze_path)
    return ""


def _resolve_artist_name(content: Any) -> str:
    artist = getattr(content, "ArtistName", None)
    if artist:
        return str(artist).strip()
    relation = getattr(content, "Artist", None)
    if relation is not None:
        name = getattr(relation, "Name", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_album_name(content: Any) -> str:
    album = getattr(content, "AlbumName", None)
    if album:
        return str(album).strip()
    relation = getattr(content, "Album", None)
    if relation is not None:
        name = getattr(relation, "Name", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_genre_name(content: Any) -> str:
    genre = getattr(content, "GenreName", None)
    if genre:
        return str(genre).strip()
    relation = getattr(content, "Genre", None)
    if relation is not None:
        name = getattr(relation, "Name", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_label_name(content: Any) -> str:
    relation = getattr(content, "Label", None)
    if relation is not None:
        name = getattr(relation, "Name", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_key_name(content: Any) -> str:
    relation = getattr(content, "Key", None)
    if relation is not None:
        name = getattr(relation, "ScaleName", None)
        if name:
            return str(name).strip()
    return ""


def _resolve_rekordbox_config() -> Dict[str, Any]:
    if PYREKORDBOX_IMPORT_ERROR:
        return {
            "available": False,
            "supported": sys.platform in ("win32", "darwin"),
            "errorCode": "PYREKORDBOX_UNAVAILABLE",
            "errorMessage": f"pyrekordbox 不可用: {PYREKORDBOX_IMPORT_ERROR}",
        }

    if sys.platform not in ("win32", "darwin"):
        return {
            "available": False,
            "supported": False,
            "errorCode": "UNSUPPORTED_PLATFORM",
            "errorMessage": "当前平台暂不支持 Rekordbox 本机库。",
        }

    update_config()
    config = {}
    for key in ("rekordbox7", "rekordbox6"):
        current = get_config(key) or {}
        if current.get("db_path"):
            config = current
            break

    if not config:
        try:
            pioneer_app_dir = get_pioneer_app_dir()
            options = read_rekordbox6_options(pioneer_app_dir)
            db_path = _normalize_path(options.get("db-path"))
            db_dir = os.path.dirname(db_path) if db_path else ""
            if db_path and os.path.exists(db_path):
                config = {
                    "version": "",
                    "db_path": db_path,
                    "db_dir": db_dir,
                }
        except Exception:
            config = {}

    db_path = _normalize_path(config.get("db_path"))
    db_dir = _normalize_path(config.get("db_dir") or os.path.dirname(db_path))
    share_dir = _normalize_path(os.path.join(db_dir, "share")) if db_dir else ""
    if not db_path or not os.path.exists(db_path):
        return {
            "available": False,
            "supported": True,
            "errorCode": "REKORDBOX_NOT_FOUND",
            "errorMessage": "未检测到 Rekordbox master.db。",
        }

    return {
        "available": True,
        "supported": True,
        "sourceKey": f"rekordbox-desktop:{db_path}",
        "sourceName": "Rekordbox 本机库",
        "sourceRootPath": share_dir,
        "dbPath": db_path,
        "dbDir": db_dir,
        "shareDir": share_dir,
        "appVersion": str(config.get("version") or "").strip(),
    }


def _open_database(config: Dict[str, Any]) -> Any:
    db_path = _normalize_path(config.get("dbPath"))
    db_dir = _normalize_path(config.get("dbDir"))
    return Rekordbox6Database(path=db_path, db_dir=db_dir)


def _close_database(db: Any) -> None:
    if db is None:
        return
    close_method = getattr(db, "close", None)
    if callable(close_method):
        try:
            close_method()
        except Exception:
            pass


def _build_probe_payload(open_database: bool = True) -> Dict[str, Any]:
    config = _resolve_rekordbox_config()
    if not config.get("available"):
        return config
    if not open_database:
        return config

    db = None
    try:
        db = _open_database(config)
        config["playlistTotal"] = db.get_playlist().count()
        config["folderTotal"] = db.get_playlist(Attribute=1).count()
        config["trackTotal"] = db.get_content().count()
        return config
    except Exception as exc:
        message = str(exc).strip() or "打开 Rekordbox 数据库失败。"
        lowered = message.lower()
        config["available"] = False
        config["errorCode"] = "REKORDBOX_DB_BUSY" if ("busy" in lowered or "lock" in lowered) else "REKORDBOX_DB_OPEN_FAILED"
        config["errorMessage"] = message
        return config
    finally:
        _close_database(db)


def _resolve_request_config(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _build_probe_payload(open_database=False)
    db_path = _normalize_path(request_payload.get("dbPath")) or _normalize_path(config.get("dbPath"))
    db_dir = _normalize_path(request_payload.get("dbDir")) or _normalize_path(config.get("dbDir"))
    share_dir = _normalize_path(request_payload.get("shareDir")) or _normalize_path(config.get("shareDir"))
    return {
        **config,
        "available": bool(db_path and os.path.exists(db_path)),
        "dbPath": db_path,
        "dbDir": db_dir or os.path.dirname(db_path),
        "shareDir": share_dir or _normalize_path(os.path.join(db_dir or os.path.dirname(db_path), "share")),
        "sourceRootPath": share_dir or _normalize_path(os.path.join(db_dir or os.path.dirname(db_path), "share")),
    }


def _build_tree_nodes(db: Any) -> Any:
    query = db.get_playlist().order_by(tables.DjmdPlaylist.ParentID, tables.DjmdPlaylist.Seq)
    nodes = []
    for playlist in query.all():
        identifier = _parse_int(getattr(playlist, "ID", 0))
        name = str(getattr(playlist, "Name", "") or "").strip()
        if not identifier or not name:
            continue
        nodes.append(
            {
                "id": identifier,
                "parentId": _parse_int(getattr(playlist, "ParentID", 0)),
                "name": name,
                "isFolder": bool(getattr(playlist, "is_folder", False)),
                "order": _parse_int(getattr(playlist, "Seq", 0)),
            }
        )
    return nodes


def _build_track_record(
    db: Any,
    content: Any,
    playlist_id: int,
    playlist_name: str,
    entry_index: int,
    share_dir: str,
    db_dir: str,
) -> Dict[str, Any]:
    file_path = _normalize_path(getattr(content, "FolderPath", ""))
    file_name = _derive_file_name(file_path, getattr(content, "FileNameL", ""))
    file_format = _derive_file_format(file_name, file_path)
    track_id = _parse_int(getattr(content, "ID", 0))
    artwork_path = _resolve_candidate_path(
        getattr(content, "ImagePath", ""),
        (db_dir, share_dir),
    )

    return {
        "rowKey": f"rekordbox-desktop:{playlist_id}:{entry_index}:{track_id}",
        "playlistId": playlist_id,
        "playlistName": playlist_name,
        "trackId": track_id,
        "entryIndex": entry_index,
        "title": str(getattr(content, "Title", "") or "").strip(),
        "artist": _resolve_artist_name(content),
        "album": _resolve_album_name(content),
        "label": _resolve_label_name(content),
        "genre": _resolve_genre_name(content),
        "filePath": file_path,
        "fileName": file_name,
        "fileFormat": file_format,
        "container": file_format,
        "duration": _format_duration(getattr(content, "Length", 0)),
        "durationSec": _parse_int(getattr(content, "Length", 0)),
        "bpm": _normalize_bpm(getattr(content, "BPM", None)),
        "key": _resolve_key_name(content) or None,
        "bitrate": _parse_int(getattr(content, "BitRate", 0)) or None,
        "sampleRate": _parse_int(getattr(content, "SampleRate", 0)) or None,
        "sampleDepth": _parse_int(getattr(content, "BitDepth", 0)) or None,
        "trackNumber": _parse_int(getattr(content, "TrackNo", 0)) or None,
        "discNumber": _parse_int(getattr(content, "DiscNo", 0)) or None,
        "year": _parse_int(getattr(content, "ReleaseYear", 0)) or None,
        "analyzePath": _resolve_track_analyze_path(db, content, share_dir) or None,
        "comment": str(getattr(content, "Commnt", "") or "").strip() or None,
        "dateAdded": _normalize_date(getattr(content, "StockDate", None)),
        "artworkPath": artwork_path or None,
        "coverPath": artwork_path or None,
    }


def _build_playlist_tracks_payload(request_payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _resolve_request_config(request_payload)
    if not config.get("available"):
        raise RuntimeError(str(config.get("errorMessage") or "未检测到 Rekordbox 本机库。"))

    playlist_id = _parse_int(request_payload.get("playlistId"))
    if playlist_id <= 0:
        raise ValueError("playlistId 无效")

    db = None
    try:
        db = _open_database(config)
        playlist = db.get_playlist(ID=str(playlist_id)) or db.get_playlist(ID=playlist_id)
        if playlist is None:
            raise ValueError(f"未找到播放列表: {playlist_id}")

        playlist_name = str(getattr(playlist, "Name", "") or "").strip()
        share_dir = _normalize_path(config.get("shareDir"))
        db_dir = _normalize_path(config.get("dbDir"))
        tracks = []

        if bool(getattr(playlist, "is_smart_playlist", False)):
            contents = db.get_playlist_contents(playlist).all()
            for index, content in enumerate(contents, start=1):
                tracks.append(
                    _build_track_record(
                        db,
                        content,
                        playlist_id,
                        playlist_name,
                        index,
                        share_dir,
                        db_dir,
                    )
                )
        else:
            entries = (
                db.get_playlist_songs(PlaylistID=getattr(playlist, "ID", playlist_id))
                .order_by(tables.DjmdSongPlaylist.TrackNo)
                .all()
            )
            for index, entry in enumerate(entries, start=1):
                content = getattr(entry, "Content", None)
                if content is None:
                    continue
                entry_index = _parse_int(getattr(entry, "TrackNo", index), index)
                tracks.append(
                    _build_track_record(
                        db,
                        content,
                        playlist_id,
                        playlist_name,
                        entry_index,
                        share_dir,
                        db_dir,
                    )
                )

        return {
            "probe": config,
            "playlistId": playlist_id,
            "playlistName": playlist_name,
            "trackTotal": len(tracks),
            "tracks": tracks,
        }
    finally:
        _close_database(db)


def _handle_probe(_: Dict[str, Any]) -> Dict[str, Any]:
    return _build_probe_payload(open_database=True)

def _handle_load_tree(payload: Dict[str, Any]) -> Dict[str, Any]:
    config = _resolve_request_config(payload)
    if not config.get("available"):
        raise RuntimeError(str(config.get("errorMessage") or "未检测到 Rekordbox 本机库。"))

    db = None
    try:
        db = _open_database(config)
        return {
            "probe": config,
            "nodes": _build_tree_nodes(db),
        }
    finally:
        _close_database(db)


def _handle_load_playlist_tracks(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _build_playlist_tracks_payload(payload)


COMMANDS = {
    "probe": _handle_probe,
    "load-tree": _handle_load_tree,
    "load-playlist-tracks": _handle_load_playlist_tracks,
}


def main() -> int:
    try:
        request = _read_request()
        command = str(request.get("command") or "").strip()
        payload = request.get("payload") or {}
        if command not in COMMANDS:
            _write_response(_error("HELPER_PROTOCOL_ERROR", f"unsupported command: {command}"))
            return 1
        if not isinstance(payload, dict):
            _write_response(_error("HELPER_PROTOCOL_ERROR", "payload must be a JSON object"))
            return 1
        result = COMMANDS[command](payload)
        _write_response(_ok(result))
        return 0
    except ValueError as exc:
        _write_response(_error("HELPER_PROTOCOL_ERROR", str(exc)))
        return 1
    except RuntimeError as exc:
        message = str(exc).strip() or "运行 Rekordbox Desktop helper 失败。"
        code = "REKORDBOX_DB_BUSY" if ("busy" in message.lower() or "lock" in message.lower()) else "HELPER_RUNTIME_ERROR"
        _write_response(_error(code, message))
        return 1
    except Exception as exc:
        _write_response(_error("HELPER_RUNTIME_ERROR", str(exc).strip() or "unknown error"))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
