import argparse
import json
import math
import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPO_ROOT / "grid-analysis-lab" / "manual-truth" / "truth-sample.v2.json"


def _is_v2_map(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("version") != 2 or value.get("source") not in {"manual", "analysis"}:
        return False
    if not isinstance(value.get("signature"), str) or not value["signature"].strip():
        return False
    clips = value.get("clips")
    if not isinstance(clips, list) or not clips:
        return False
    previous_start_sec = -1.0
    for index, clip in enumerate(clips):
        if not isinstance(clip, dict):
            return False
        try:
            start_sec = float(clip["startSec"])
            anchor_sec = float(clip["anchorSec"])
            bpm = float(clip["bpm"])
        except (KeyError, TypeError, ValueError):
            return False
        downbeat_beat_offset = clip.get("downbeatBeatOffset")
        if (
            not math.isfinite(start_sec)
            or not math.isfinite(anchor_sec)
            or not math.isfinite(bpm)
            or start_sec < 0
            or anchor_sec < 0
            or bpm <= 0
            or (index == 0 and abs(start_sec) > 0.000001)
            or (index > 0 and start_sec <= previous_start_sec)
            or not isinstance(downbeat_beat_offset, int)
            or not 0 <= downbeat_beat_offset < 4
        ):
            return False
        previous_start_sec = start_sec
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Export current FRKB song_cache rows as manual truth")
    parser.add_argument("--db", required=True, help="Path to FRKB.database.sqlite")
    parser.add_argument("--list-root", required=True, help="song_cache list_root")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    db_path = Path(args.db)
    output_path = Path(args.output)
    list_root = str(args.list_root).strip().lower()
    if not db_path.exists():
        raise SystemExit(f"db not found: {db_path}")
    if not list_root:
        raise SystemExit("list_root is empty")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "select file_path, info_json from song_cache where lower(list_root) = ? order by file_path",
            (list_root,),
        ).fetchall()
    finally:
        conn.close()

    tracks = []
    for row in rows:
        try:
            info = json.loads(row["info_json"])
        except Exception:
            continue
        if not isinstance(info, dict):
            continue
        beat_grid_map = info.get("beatGridMap")
        if not _is_v2_map(beat_grid_map):
            continue
        tracks.append(
            {
                "fileName": str(row["file_path"] or "").strip().lower(),
                "filePath": str(info.get("filePath") or "").strip(),
                "title": str(info.get("title") or "").strip(),
                "artist": str(info.get("artist") or "").strip(),
                "confirmed": True,
                "source": f"manual-song-cache:{list_root}",
                "beatGridMap": beat_grid_map,
            }
        )

    payload = {
        "type": "frkb-grid-truth-v2",
        "schemaVersion": 2,
        "db": str(db_path),
        "listRoot": list_root,
        "trackCount": len(tracks),
        "tracks": tracks,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output_path), "trackCount": len(tracks)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
