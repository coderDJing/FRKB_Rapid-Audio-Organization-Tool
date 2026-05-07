import json
import math
import time
from pathlib import Path
from typing import Any

import benchmark_rkb_rekordbox_truth as benchmark

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_FEATURE_CACHE_DIR = BENCHMARK_OUTPUT_DIR / "feature-cache"
DEFAULT_CANDIDATE_LAB_OUTPUT = BENCHMARK_OUTPUT_DIR / "hybrid-candidate-lab-latest.json"
DEFAULT_BASELINE = BENCHMARK_OUTPUT_DIR / "frkb-current-latest.json"
FEATURE_CACHE_VERSION = 2
FEATURE_INDEX_NAME = "index.json"


def configure_utf8_stdio() -> None:
    try:
        import sys

        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def normalize_lookup_key(value: Any) -> str:
    return benchmark._normalize_lookup_key(value)


def to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def parse_audio_roots(value: str) -> list[Path]:
    return benchmark._parse_audio_roots(value)


def _load_raw_truth_tracks(truth_path: Path) -> list[dict[str, Any]]:
    payload = json.loads(truth_path.read_text(encoding="utf-8"))
    tracks = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(tracks, list) or not tracks:
        raise RuntimeError(f"truth contains no tracks: {truth_path}")
    return [item for item in tracks if isinstance(item, dict)]


def _prepare_truth_track(
    *,
    raw_track: dict[str, Any],
    audio_roots: list[Path],
    ffprobe_path: Path,
) -> dict[str, Any] | None:
    file_name = str(raw_track.get("fileName") or "").strip()
    if not file_name:
        return None
    bpm = to_float(raw_track.get("bpm"))
    first_beat_ms = to_float(raw_track.get("firstBeatMs"))
    if bpm is None or bpm <= 0.0 or first_beat_ms is None or first_beat_ms < 0.0:
        return None
    file_path = benchmark._resolve_audio_path(audio_roots, file_name)
    bar_beat_offset = benchmark._normalize_bar_offset(raw_track.get("barBeatOffset"), 32)
    first_beat_label = int(
        raw_track.get("firstBeatLabel")
        or benchmark._resolve_first_beat_label_from_offset(bar_beat_offset)
    )
    return {
        "fileName": file_name,
        "filePath": str(file_path),
        "title": str(raw_track.get("title") or "").strip(),
        "artist": str(raw_track.get("artist") or "").strip(),
        "bpm": round(float(bpm), 6),
        "firstBeatMs": round(float(first_beat_ms), 3),
        "firstBeatLabel": first_beat_label,
        "barBeatOffset": bar_beat_offset,
        "fileExists": file_path.exists(),
        "timeBasis": benchmark._probe_time_basis(ffprobe_path, file_path) if file_path.exists() else None,
    }


def matches_only_filters(track: dict[str, Any], filters: list[str]) -> bool:
    if not filters:
        return True
    haystack = " ".join(
        [
            str(track.get("fileName") or ""),
            str(track.get("title") or ""),
            str(track.get("artist") or ""),
        ]
    ).lower()
    return any(item in haystack for item in filters)


def load_selected_truth_tracks(
    *,
    truth_path: Path,
    audio_root: str,
    ffprobe_path: Path,
    only_filters: list[str],
    limit: int,
) -> list[dict[str, Any]]:
    audio_roots = parse_audio_roots(audio_root)
    selected: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for raw_track in _load_raw_truth_tracks(truth_path):
        file_name = str(raw_track.get("fileName") or "").strip()
        lookup_key = normalize_lookup_key(file_name)
        if not file_name or lookup_key in seen_keys:
            continue
        if not matches_only_filters(raw_track, only_filters):
            continue
        prepared = _prepare_truth_track(
            raw_track=raw_track,
            audio_roots=audio_roots,
            ffprobe_path=ffprobe_path,
        )
        if prepared is None:
            continue
        seen_keys.add(lookup_key)
        selected.append(prepared)
        if limit > 0 and len(selected) >= limit:
            break
    return selected


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def stable_hash(payload: dict[str, Any]) -> str:
    return benchmark._stable_cache_hash(payload)


def metadata_path_for_key(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / f"feature-{cache_key}.json"


def arrays_path_for_key(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / f"arrays-{cache_key}.npz"


def feature_index_path(cache_dir: Path) -> Path:
    return cache_dir / FEATURE_INDEX_NAME


def load_feature_index(cache_dir: Path) -> dict[str, Any]:
    path = feature_index_path(cache_dir)
    if not path.exists():
        return {"version": FEATURE_CACHE_VERSION, "updatedAt": 0.0, "entries": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"version": FEATURE_CACHE_VERSION, "updatedAt": 0.0, "entries": []}
    if not isinstance(payload, dict):
        return {"version": FEATURE_CACHE_VERSION, "updatedAt": 0.0, "entries": []}
    entries = payload.get("entries")
    if not isinstance(entries, list):
        payload["entries"] = []
    return payload


def write_feature_index(cache_dir: Path, entries: list[dict[str, Any]]) -> None:
    entries.sort(key=lambda item: str(item.get("lookupKey") or ""))
    atomic_write_json(
        feature_index_path(cache_dir),
        {
            "version": FEATURE_CACHE_VERSION,
            "updatedAt": round(time.time(), 3),
            "entries": entries,
        },
    )


def update_feature_index_entry(cache_dir: Path, entry: dict[str, Any]) -> None:
    payload = load_feature_index(cache_dir)
    entries = [item for item in payload.get("entries", []) if isinstance(item, dict)]
    lookup_key = str(entry.get("lookupKey") or "")
    next_entries = [item for item in entries if str(item.get("lookupKey") or "") != lookup_key]
    next_entries.append(entry)
    write_feature_index(cache_dir, next_entries)


def build_feature_index_map(cache_dir: Path) -> dict[str, dict[str, Any]]:
    payload = load_feature_index(cache_dir)
    result: dict[str, dict[str, Any]] = {}
    for item in payload.get("entries", []):
        if not isinstance(item, dict):
            continue
        lookup_key = str(item.get("lookupKey") or "")
        if lookup_key:
            result[lookup_key] = item
    return result


def resolve_feature_entry(
    *,
    track: dict[str, Any],
    index_map: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    return index_map.get(normalize_lookup_key(track.get("fileName")))


def read_feature_metadata(cache_dir: Path, entry: dict[str, Any]) -> dict[str, Any]:
    metadata_name = str(entry.get("metadataPath") or "").strip()
    if not metadata_name:
        metadata_name = metadata_path_for_key(cache_dir, str(entry.get("cacheKey") or "")).name
    path = cache_dir / metadata_name
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"invalid feature metadata: {path}")
    return payload


def resolve_feature_arrays_path(cache_dir: Path, entry: dict[str, Any], metadata: dict[str, Any]) -> Path:
    arrays_name = str(entry.get("arraysPath") or metadata.get("arraysPath") or "").strip()
    if not arrays_name:
        arrays_name = arrays_path_for_key(cache_dir, str(entry.get("cacheKey") or "")).name
    return cache_dir / arrays_name


def baseline_summary(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    summary = payload.get("summary") if isinstance(payload, dict) else None
    if not isinstance(summary, dict):
        return None
    oracle = summary.get("candidateOracle") if isinstance(summary.get("candidateOracle"), dict) else {}
    return {
        "trackTotal": summary.get("trackTotal"),
        "analyzedTrackCount": summary.get("analyzedTrackCount"),
        "errorTrackCount": summary.get("errorTrackCount"),
        "categoryCounts": summary.get("categoryCounts"),
        "candidateOracle": {
            "candidatePassCount": oracle.get("candidatePassCount"),
            "candidatePassRate": oracle.get("candidatePassRate"),
            "candidateMissCount": oracle.get("candidateMissCount"),
            "oracleSelectedFailCount": oracle.get("oracleSelectedFailCount"),
        },
        "bpmBigErrorCount": summary.get("bpmBigErrorCount"),
        "phaseFailCount": summary.get("phaseFailCount"),
        "downbeatMismatchMod4Count": summary.get("downbeatMismatchMod4Count"),
        "exact32OffsetMismatchCount": summary.get("exact32OffsetMismatchCount"),
    }


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
