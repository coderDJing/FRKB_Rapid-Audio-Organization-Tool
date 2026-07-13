from typing import Any

from rkb_playlist_triage_report import (
    _normalize_key,
    _require_dict,
    _row_key_map,
    _to_int,
    build_batch_snapshot,
    select_raw_tracks,
)


def validate_live_source_playlist(
    *,
    batch: dict[str, Any],
    differences: list[dict[str, Any]],
    live_payload: dict[str, Any],
) -> int:
    playlist_id = _to_int(batch.get("sourcePlaylistId")) or 0
    raw_tracks_payload = live_payload.get("tracks")
    if not isinstance(raw_tracks_payload, list):
        raise RuntimeError("live source playlist tracks are invalid")
    raw_tracks = [item for item in raw_tracks_payload if isinstance(item, dict)]
    selection = _require_dict(batch.get("selection"), "batch.selection")
    only_filters = [
        _normalize_key(item)
        for item in selection.get("onlyFilters") or []
        if _normalize_key(item)
    ]
    limit = max(0, int(selection.get("limit") or 0))
    selected_tracks = select_raw_tracks(raw_tracks, only_filters=only_filters, limit=limit)
    live_batch = build_batch_snapshot(
        playlist_id=playlist_id,
        playlist_name=str(live_payload.get("playlistName") or batch.get("sourcePlaylistName") or "").strip(),
        raw_tracks=raw_tracks,
        selected_tracks=selected_tracks,
        only_filters=only_filters,
        limit=limit,
    )
    keys = (
        "batchId",
        "playlistSnapshotSha256",
        "denominatorSnapshotSha256",
        "sourcePlaylistTrackCount",
        "originalDenominatorTrackCount",
    )
    changed_key = next((key for key in keys if live_batch.get(key) != batch.get(key)), None)
    if changed_key:
        raise RuntimeError(
            f"source playlist changed after dry-run ({changed_key}); rerun dry-run before applying"
        )
    live_by_row = _row_key_map(live_batch["denominatorEntries"], "live denominator")
    expected_by_row = _row_key_map(batch["denominatorEntries"], "batch.denominatorEntries")
    if live_by_row != expected_by_row:
        raise RuntimeError("source playlist rowKey mapping changed after dry-run")
    for difference in differences:
        row_key = str(difference.get("sourceRowKey") or "").strip()
        live_entry = live_by_row.get(row_key)
        if live_entry is None:
            raise RuntimeError(f"difference rowKey is no longer in source playlist: {row_key}")
        if _to_int(live_entry.get("trackId")) != _to_int(difference.get("sourceTrackId")):
            raise RuntimeError(f"difference rowKey now maps to another trackId: {row_key}")
    return playlist_id
