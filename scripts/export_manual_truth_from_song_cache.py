import argparse
import json
import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPO_ROOT / "grid-analysis-lab" / "manual-truth" / "truth-sample.json"


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
        tracks.append(
            {
                "fileName": str(row["file_path"] or "").strip().lower(),
                "filePath": str(info.get("filePath") or "").strip(),
                "title": str(info.get("title") or "").strip(),
                "artist": str(info.get("artist") or "").strip(),
                "bpm": info.get("bpm"),
                "firstBeatMs": info.get("firstBeatMs"),
                "barBeatOffset": info.get("barBeatOffset"),
                "confirmed": True,
                "source": f"manual-song-cache:{list_root}",
            }
        )

    payload = {
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
