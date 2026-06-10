"""前置脚本：从源歌单取前 N 首曲目移动到目标歌单，然后可选地启动分拣流程。

用法示例：
  # dry-run：只看会移动哪些曲目
  python scripts/prep_move_tracks_between_playlists.py --source Upan --target test --limit 500

  # 实际移动
  python scripts/prep_move_tracks_between_playlists.py --source Upan --target test --limit 500 --apply

  # 移动后自动跑分拣 dry-run
  python scripts/prep_move_tracks_between_playlists.py --source Upan --target test --limit 500 --apply --then-triage

  # 移动后自动跑分拣 apply（error=0 时自动 apply）
  python scripts/prep_move_tracks_between_playlists.py --source Upan --target test --limit 500 --apply --then-triage --triage-apply
"""

import argparse
import json
import subprocess
import sys
import time
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
DEFAULT_TRIAGE_SCRIPT = REPO_ROOT / "scripts" / "move_rekordbox_playlist_grid_diffs.py"


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except Exception:
        return None


def _to_int(value: Any) -> int | None:
    num = _to_float(value)
    return int(round(num)) if num is not None else None


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
) -> dict[str, Any]:
    expected = _normalize_key(playlist_name)
    nodes = _load_tree_nodes(bridge_path, db_path)
    matches = [
        item
        for item in nodes
        if not item.get("isFolder") and _normalize_key(item.get("name")) == expected
    ]
    if not matches:
        available = ", ".join(str(item.get("name") or "") for item in nodes if not item.get("isFolder"))
        raise RuntimeError(f"playlist not found: {playlist_name}; available: {available}")
    if len(matches) > 1:
        ids = ", ".join(str(item.get("id") or "") for item in matches)
        raise RuntimeError(f"playlist name is ambiguous: {playlist_name}; ids: {ids}")
    return matches[0]


def _playlist_id(node: dict[str, Any]) -> int:
    num = _to_float(node.get("id"))
    return int(num) if num is not None and num > 0 else 0


def _load_playlist_tracks(bridge_path: Path, playlist_id: int, db_path: str) -> list[dict[str, Any]]:
    payload = _run_bridge(
        bridge_path,
        "load-playlist-tracks",
        {**_bridge_payload(db_path), "playlistId": playlist_id},
    )
    raw_tracks = payload.get("tracks")
    if not isinstance(raw_tracks, list):
        raise RuntimeError(f"failed to load tracks from playlist {playlist_id}")
    return [t for t in raw_tracks if isinstance(t, dict)]


def _move_tracks(
    bridge_path: Path,
    db_path: str,
    *,
    source_playlist_name: str,
    target_playlist_name: str,
    limit: int,
    dry_run: bool,
) -> dict[str, Any]:
    print(f"正在解析歌单...", flush=True)
    source_node = _resolve_playlist_node(bridge_path, source_playlist_name, db_path)
    target_node = _resolve_playlist_node(bridge_path, target_playlist_name, db_path)

    source_id = _playlist_id(source_node)
    target_id = _playlist_id(target_node)
    if source_id <= 0:
        raise RuntimeError(f"source playlist id is invalid: {source_playlist_name}")
    if target_id <= 0:
        raise RuntimeError(f"target playlist id is invalid: {target_playlist_name}")
    if source_id == target_id:
        raise RuntimeError("source and target playlist are the same")

    print(f"源歌单: {source_node.get('name')} (id={source_id})", flush=True)
    print(f"目标歌单: {target_node.get('name')} (id={target_id})", flush=True)

    print(f"正在加载源歌单曲目...", flush=True)
    tracks = _load_playlist_tracks(bridge_path, source_id, db_path)
    print(f"源歌单共 {len(tracks)} 首曲目", flush=True)

    if limit > 0:
        selected = tracks[:limit]
    else:
        selected = tracks
    print(f"选取前 {len(selected)} 首曲目", flush=True)

    track_ids = []
    row_keys = []
    for t in selected:
        tid = _to_int(t.get("trackId"))
        if tid is not None and tid > 0:
            track_ids.append(tid)
        rk = str(t.get("rowKey") or "").strip()
        if rk:
            row_keys.append(rk)

    preview = []
    for i, t in enumerate(selected[:10], 1):
        preview.append(f"  {i}. {t.get('title', '')} - {t.get('artist', '')} [{t.get('fileName', '')}]")
    if len(selected) > 10:
        preview.append(f"  ... 共 {len(selected)} 首")

    result: dict[str, Any] = {
        "sourcePlaylist": source_node.get("name"),
        "sourcePlaylistId": source_id,
        "targetPlaylist": target_node.get("name"),
        "targetPlaylistId": target_id,
        "sourceTrackTotal": len(tracks),
        "selectedCount": len(selected),
        "trackIdCount": len(track_ids),
        "rowKeyCount": len(row_keys),
        "preview": preview,
    }

    if dry_run:
        print(f"\n--- dry-run 预览 ---", flush=True)
        for line in preview:
            print(line, flush=True)
        print(f"\n将追加 {len(track_ids)} 首到 '{target_playlist_name}'，从 '{source_playlist_name}' 移除 {len(row_keys)} 首", flush=True)
        print(f"（加 --apply 执行实际操作）", flush=True)
        return result

    # Step 1: append to target
    print(f"\n正在追加 {len(track_ids)} 首曲目到 '{target_playlist_name}'...", flush=True)
    append_result = _run_bridge(
        bridge_path,
        "append-existing-playlist-tracks",
        {
            **_bridge_payload(db_path),
            "playlistId": target_id,
            "trackIds": track_ids,
        },
    )
    result["appendResult"] = append_result
    added = append_result.get("addedToPlaylistCount", 0)
    skipped = append_result.get("skippedDuplicateCount", 0)
    print(f"  追加完成: 新增 {added} 首, 跳过重复 {skipped} 首", flush=True)

    # Step 2: remove from source
    print(f"正在从 '{source_playlist_name}' 移除 {len(row_keys)} 首曲目...", flush=True)
    remove_result = _run_bridge(
        bridge_path,
        "remove-playlist-tracks",
        {
            **_bridge_payload(db_path),
            "playlistId": source_id,
            "rowKeys": row_keys,
        },
    )
    result["removeResult"] = remove_result
    removed = remove_result.get("removedCount", 0)
    print(f"  移除完成: 删除 {removed} 首", flush=True)

    return result


def _run_triage(
    *,
    triage_script: Path,
    triage_source: str,
    triage_target: str,
    bridge_path: Path,
    db_path: str,
    triage_apply: bool,
    extra_args: list[str],
) -> int:
    cmd = [
        sys.executable,
        str(triage_script),
        "--source-playlist", triage_source,
        "--target-playlist", triage_target,
        "--bridge", str(bridge_path),
    ]
    if db_path:
        cmd.extend(["--db-path", db_path])
    if triage_apply:
        cmd.append("--apply")
    cmd.extend(extra_args)

    print(f"\n{'='*60}", flush=True)
    print(f"启动分拣流程: {' '.join(cmd)}", flush=True)
    print(f"{'='*60}\n", flush=True)

    return subprocess.call(cmd)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Move tracks from one Rekordbox playlist to another, then optionally run triage.",
    )
    parser.add_argument("--source", default="Upan", help="Source playlist name (default: Upan)")
    parser.add_argument("--target", default="test", help="Target playlist name (default: test)")
    parser.add_argument("--limit", type=int, default=500, help="Max tracks to move (default: 500)")
    parser.add_argument("--bridge", default=str(DEFAULT_BRIDGE))
    parser.add_argument("--db-path", default="")
    parser.add_argument("--apply", action="store_true", help="Actually move tracks. Default is dry-run.")
    parser.add_argument(
        "--then-triage",
        action="store_true",
        help="Run triage script after moving tracks.",
    )
    parser.add_argument(
        "--triage-apply",
        action="store_true",
        help="Pass --apply to the triage script (only with --then-triage).",
    )
    parser.add_argument(
        "--triage-source",
        default="test",
        help="Triage source playlist (default: test).",
    )
    parser.add_argument(
        "--triage-target",
        default="needReview",
        help="Triage target playlist (default: needReview).",
    )
    parser.add_argument(
        "--triage-script",
        default=str(DEFAULT_TRIAGE_SCRIPT),
    )
    args, triage_extra = parser.parse_known_args()

    bridge_path = Path(args.bridge)
    if not bridge_path.exists():
        raise SystemExit(f"bridge not found: {bridge_path}")

    started_at = time.time()
    result = _move_tracks(
        bridge_path,
        str(args.db_path or ""),
        source_playlist_name=str(args.source),
        target_playlist_name=str(args.target),
        limit=int(args.limit),
        dry_run=not bool(args.apply),
    )
    elapsed = time.time() - started_at

    result["dryRun"] = not bool(args.apply)
    result["elapsedSec"] = round(elapsed, 3)

    print(f"\n--- 结果 ---", flush=True)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)

    if args.then_triage and args.apply:
        triage_apply = bool(args.triage_apply)
        ret = _run_triage(
            triage_script=Path(args.triage_script),
            triage_source=str(args.triage_source),
            triage_target=str(args.triage_target),
            bridge_path=bridge_path,
            db_path=str(args.db_path or ""),
            triage_apply=triage_apply,
            extra_args=triage_extra,
        )
        if ret != 0:
            print(f"\n分拣脚本退出码: {ret}", flush=True)
            return ret

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)
