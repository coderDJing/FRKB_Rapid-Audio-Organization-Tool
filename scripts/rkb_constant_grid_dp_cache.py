import json
from pathlib import Path
from typing import Any

import numpy as np

from rkb_constant_grid_dp_solver import (
    DEFAULT_MAX_BPM,
    DEFAULT_MAX_CANDIDATES,
    DEFAULT_MIN_BPM,
    DEFAULT_PHASE_STEP_MS,
    DEFAULT_TEMPO_LIMIT,
    DEFAULT_TEMPO_STEP_BPM,
    solve_constant_grid_dp,
)


def solve_constant_grid_dp_from_cache(
    *,
    track: dict[str, Any],
    feature_cache_dir: Path,
    feature_index_map: dict[str, dict[str, Any]] | None = None,
    official_high_attack_cache_dir: Path | None = None,
    min_bpm: float = DEFAULT_MIN_BPM,
    max_bpm: float = DEFAULT_MAX_BPM,
    tempo_step_bpm: float = DEFAULT_TEMPO_STEP_BPM,
    tempo_limit: int = DEFAULT_TEMPO_LIMIT,
    phase_step_ms: float = DEFAULT_PHASE_STEP_MS,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
) -> dict[str, Any]:
    from rkb_beatgrid_lab_common import (
        build_feature_index_map,
        read_feature_metadata,
        resolve_feature_arrays_path,
        resolve_feature_entry,
    )

    index_map = (
        feature_index_map
        if feature_index_map is not None
        else build_feature_index_map(feature_cache_dir)
    )
    entry = resolve_feature_entry(track=track, index_map=index_map)
    if entry is None:
        file_name = str(track.get("fileName") or "")
        raise RuntimeError(f"constant-grid-dp feature cache missing for {file_name}")
    metadata = read_feature_metadata(feature_cache_dir, entry, track=track)
    arrays_path = resolve_feature_arrays_path(feature_cache_dir, entry, metadata)
    if not arrays_path.exists():
        raise RuntimeError(f"constant-grid-dp feature arrays missing: {arrays_path}")
    with np.load(arrays_path, allow_pickle=False) as cached_arrays:
        arrays: dict[str, Any] = {name: cached_arrays[name] for name in cached_arrays.files}
    if official_high_attack_cache_dir is not None:
        cache_key = str(entry.get("cacheKey") or "").strip()
        if not cache_key:
            raise RuntimeError("official high-attack sidecar requires feature cacheKey")
        sidecar_root = Path(official_high_attack_cache_dir)
        sidecar_json = sidecar_root / f"high-attack-{cache_key}.json"
        sidecar_npz = sidecar_root / f"high-attack-{cache_key}.npz"
        if not sidecar_json.exists() or not sidecar_npz.exists():
            raise RuntimeError(
                "official high-attack sidecar missing for "
                f"{cache_key}: {sidecar_json.name}, {sidecar_npz.name}"
            )
        sidecar_metadata = json.loads(sidecar_json.read_text(encoding="utf-8"))
        if str(sidecar_metadata.get("sourceCacheKey") or "") != cache_key:
            raise RuntimeError(f"official high-attack sidecar cache key mismatch: {cache_key}")
        with np.load(sidecar_npz, allow_pickle=False) as sidecar_arrays:
            if "highAttackEnvelope" not in sidecar_arrays.files or "sampleRate" not in sidecar_arrays.files:
                raise RuntimeError(f"official high-attack sidecar arrays invalid: {sidecar_npz}")
            arrays["officialHighAttackEnvelope"] = np.asarray(
                sidecar_arrays["highAttackEnvelope"], dtype="float64"
            )
            arrays["officialHighAttackSampleRate"] = np.asarray(
                sidecar_arrays["sampleRate"], dtype="int32"
            )
    return solve_constant_grid_dp(
        metadata=metadata,
        arrays=arrays,
        min_bpm=min_bpm,
        max_bpm=max_bpm,
        tempo_step_bpm=tempo_step_bpm,
        tempo_limit=tempo_limit,
        phase_step_ms=phase_step_ms,
        max_candidates=max_candidates,
    )
