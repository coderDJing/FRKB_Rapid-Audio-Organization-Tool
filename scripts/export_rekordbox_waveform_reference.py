import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "out" / "research" / "rekordbox-waveform-reference"
DEFAULT_REKORDBOX_DB = (
    Path(os.environ.get("APPDATA", ""))
    / "Pioneer"
    / "rekordbox"
    / "master.db"
)


def _import_pyrekordbox() -> tuple[Any, Any]:
    try:
        from pyrekordbox import Rekordbox6Database
        from pyrekordbox.anlz import AnlzFile

        return Rekordbox6Database, AnlzFile
    except Exception as exc:
        runtime_python = (
            REPO_ROOT
            / "vendor"
            / "rekordbox-desktop-runtime"
            / "win32-x64"
            / "python"
            / "python.exe"
        )
        raise SystemExit(
            "pyrekordbox is not available in this Python. "
            f"Run with the bundled runtime: {runtime_python}"
        ) from exc


def _normalize_path_key(value: Any) -> str:
    text = str(value or "").strip().replace("\\", "/")
    return text.casefold() if os.name == "nt" else text


def _slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    return slug.strip("-._")[:80] or "rekordbox-waveform"


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _parse_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if numeric == numeric else None


def _normalize_bpm(value: Any) -> float | None:
    numeric = _parse_float(value)
    if numeric is None or numeric <= 0:
        return None
    return numeric / 100 if numeric > 1000 else numeric


def _track_payload(content: Any) -> dict[str, Any]:
    return {
        "trackId": _parse_int(getattr(content, "ID", 0)),
        "title": str(getattr(content, "Title", "") or "").strip(),
        "artist": str(getattr(getattr(content, "Artist", None), "Name", "") or "").strip(),
        "filePath": str(getattr(content, "FolderPath", "") or "").strip(),
        "durationSec": _parse_float(getattr(content, "Length", None)),
        "bpm": _normalize_bpm(getattr(content, "BPM", None)),
        "sampleRate": _parse_int(getattr(content, "SampleRate", 0)) or None,
    }


def _iter_contents(db: Any) -> list[Any]:
    query = db.get_content()
    return list(query.all())


def _find_track(db: Any, args: argparse.Namespace) -> Any:
    contents = _iter_contents(db)
    if args.track_id:
        wanted_id = str(args.track_id).strip()
        matches = [item for item in contents if str(getattr(item, "ID", "")).strip() == wanted_id]
    elif args.file:
        wanted_file = _normalize_path_key(args.file)
        matches = [
            item
            for item in contents
            if _normalize_path_key(getattr(item, "FolderPath", "")) == wanted_file
        ]
    elif args.title:
        wanted_title = str(args.title).strip().casefold()
        matches = [
            item
            for item in contents
            if wanted_title in str(getattr(item, "Title", "") or "").strip().casefold()
        ]
    else:
        raise SystemExit("Specify one selector: --file, --title, or --track-id")

    if not matches:
        raise SystemExit("No Rekordbox track matched the selector")
    if len(matches) > 1 and not args.first:
        preview = [_track_payload(item) for item in matches[:20]]
        raise SystemExit(
            "Multiple Rekordbox tracks matched. Re-run with --first or use --track-id.\n"
            + json.dumps(preview, ensure_ascii=False, indent=2)
        )
    return matches[0]


def _resolve_analyze_paths(db: Any, content: Any) -> dict[str, str | None]:
    paths: dict[str, str | None] = {}
    for file_type in ("DAT", "EXT", "2EX"):
        try:
            value = db.get_anlz_path(content, file_type)
        except Exception:
            value = None
        paths[file_type.lower()] = str(value) if value else None
    return paths


def _decode_pwv5(tag: Any) -> dict[str, Any]:
    entries = list(getattr(tag.content, "entries", []) or [])
    heights: list[int] = []
    colors: list[list[int]] = []
    for value in entries:
        raw = int(value)
        heights.append((raw >> 2) & 0x1F)
        colors.append([(raw >> 13) & 0x7, (raw >> 10) & 0x7, (raw >> 7) & 0x7])
    return {
        "entryCount": len(entries),
        "heightMax": 31,
        "heights": heights,
        "colors3BitRgb": colors,
    }


def _decode_pwv7(tag: Any) -> dict[str, Any]:
    raw_entries = bytes(getattr(tag.content, "entries", b"") or b"")
    triples = [
        [raw_entries[i], raw_entries[i + 1], raw_entries[i + 2]]
        for i in range(0, len(raw_entries) - 2, 3)
    ]
    return {
        "entryCount": len(triples),
        "byteOrder": "raw 3-byte records from PWV7; reverse-engineered order is mid, high, low",
        "triples": triples,
    }


def _read_waveform_tags(paths: dict[str, str | None], anlz_file_cls: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    ext_path = paths.get("ext")
    if ext_path and Path(ext_path).exists():
        ext = anlz_file_cls.parse_file(ext_path)
        result["extTags"] = list(ext.tag_types)
        if "PWV5" in ext:
            result["pwv5"] = _decode_pwv5(ext.get_tag("PWV5"))
    two_ex_path = paths.get("2ex")
    if two_ex_path and Path(two_ex_path).exists():
        two_ex = anlz_file_cls.parse_file(two_ex_path)
        result["2exTags"] = list(two_ex.tag_types)
        if "PWV7" in two_ex:
            result["pwv7"] = _decode_pwv7(two_ex.get_tag("PWV7"))
    return result


def _add_rate_estimates(payload: dict[str, Any]) -> None:
    duration = payload.get("track", {}).get("durationSec")
    if not isinstance(duration, (int, float)) or duration <= 0:
        return
    for key in ("pwv5", "pwv7"):
        entry_count = payload.get("waveform", {}).get(key, {}).get("entryCount")
        if isinstance(entry_count, int) and entry_count > 0:
            payload["waveform"][key]["entriesPerSecondEstimate"] = entry_count / duration


def _first_nonzero_index(values: list[Any]) -> int | None:
    for index, value in enumerate(values):
        if isinstance(value, list):
            if any(item != 0 for item in value):
                return index
        elif value != 0:
            return index
    return None


def _window(values: list[Any], center: int | None, before: int = 12, after: int = 24) -> list[Any]:
    if center is None:
        return []
    start = max(0, center - before)
    end = min(len(values), center + after)
    return values[start:end]


def _summarize(payload: dict[str, Any]) -> dict[str, Any]:
    waveform = payload.get("waveform", {})
    pwv5 = waveform.get("pwv5") or {}
    pwv7 = waveform.get("pwv7") or {}
    pwv5_heights = pwv5.get("heights") or []
    pwv7_triples = pwv7.get("triples") or []
    pwv5_first_nonzero = _first_nonzero_index(pwv5_heights)
    pwv7_first_nonzero = _first_nonzero_index(pwv7_triples)
    return {
        "track": payload.get("track"),
        "analyzePaths": payload.get("analyzePaths"),
        "extTags": waveform.get("extTags"),
        "2exTags": waveform.get("2exTags"),
        "pwv5": {
            "entryCount": pwv5.get("entryCount"),
            "entriesPerSecondEstimate": pwv5.get("entriesPerSecondEstimate"),
            "firstNonzeroHeightIndex": pwv5_first_nonzero,
            "firstHeights": pwv5_heights[:24],
            "firstNonzeroHeightWindow": _window(pwv5_heights, pwv5_first_nonzero),
            "firstColors": (pwv5.get("colors3BitRgb") or [])[:8],
        },
        "pwv7": {
            "entryCount": pwv7.get("entryCount"),
            "entriesPerSecondEstimate": pwv7.get("entriesPerSecondEstimate"),
            "firstNonzeroTripleIndex": pwv7_first_nonzero,
            "firstTriples": pwv7_triples[:8],
            "firstNonzeroTripleWindow": _window(pwv7_triples, pwv7_first_nonzero),
        },
    }


def _default_output_path(track: dict[str, Any]) -> Path:
    name = f"{track.get('trackId') or 'track'}-{track.get('title') or 'untitled'}"
    return DEFAULT_OUTPUT_DIR / f"{_slugify(str(name))}.json"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export Rekordbox PWV5/PWV7 waveform reference data for one track."
    )
    parser.add_argument("--db", default=str(DEFAULT_REKORDBOX_DB), help="Path to master.db")
    parser.add_argument("--file", help="Exact audio file path in Rekordbox")
    parser.add_argument("--title", help="Case-insensitive title substring")
    parser.add_argument("--track-id", help="Exact Rekordbox content ID")
    parser.add_argument("--first", action="store_true", help="Use the first match when selector is ambiguous")
    parser.add_argument("--output", help="JSON output path; defaults to out/research/... when omitted")
    parser.add_argument("--summary-only", action="store_true", help="Print summary without writing JSON")
    args = parser.parse_args()

    rekordbox_db_cls, anlz_file_cls = _import_pyrekordbox()
    db_path = Path(args.db).expanduser()
    if not db_path.exists():
        raise SystemExit(f"Rekordbox master.db not found: {db_path}")

    db = rekordbox_db_cls(path=str(db_path), db_dir=str(db_path.parent))
    try:
        content = _find_track(db, args)
        track = _track_payload(content)
        analyze_paths = _resolve_analyze_paths(db, content)
        payload = {
            "type": "rekordbox-waveform-reference",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "dbPath": str(db_path),
            "track": track,
            "analyzePaths": analyze_paths,
            "waveform": _read_waveform_tags(analyze_paths, anlz_file_cls),
        }
        _add_rate_estimates(payload)
    finally:
        close = getattr(db, "close", None)
        if callable(close):
            close()

    summary = _summarize(payload)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.summary_only:
        return 0

    output_path = Path(args.output).expanduser() if args.output else _default_output_path(payload["track"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
