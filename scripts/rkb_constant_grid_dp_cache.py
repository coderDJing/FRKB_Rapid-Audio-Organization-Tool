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

    index_map = build_feature_index_map(feature_cache_dir)
    entry = resolve_feature_entry(track=track, index_map=index_map)
    if entry is None:
        file_name = str(track.get("fileName") or "")
        raise RuntimeError(f"constant-grid-dp feature cache missing for {file_name}")
    metadata = read_feature_metadata(feature_cache_dir, entry, track=track)
    arrays_path = resolve_feature_arrays_path(feature_cache_dir, entry, metadata)
    if not arrays_path.exists():
        raise RuntimeError(f"constant-grid-dp feature arrays missing: {arrays_path}")
    with np.load(arrays_path, allow_pickle=False) as arrays:
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
