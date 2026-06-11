import argparse
from pathlib import Path

from rkb_constant_grid_dp_cache import solve_constant_grid_dp_from_cache
from rkb_constant_grid_dp_solver import (
    DEFAULT_MAX_BPM,
    DEFAULT_MAX_CANDIDATES,
    DEFAULT_MIN_BPM,
    DEFAULT_PHASE_STEP_MS,
    DEFAULT_TEMPO_LIMIT,
    DEFAULT_TEMPO_STEP_BPM,
)


def main() -> int:
    from rkb_beatgrid_lab_common import (
        DEFAULT_FEATURE_CACHE_DIR,
        configure_utf8_stdio,
        normalize_lookup_key,
        print_json,
    )

    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Solve one cached track with constant-grid-dp")
    parser.add_argument("--feature-cache-dir", default=str(DEFAULT_FEATURE_CACHE_DIR))
    parser.add_argument("--file-name", required=True)
    parser.add_argument("--min-bpm", type=float, default=DEFAULT_MIN_BPM)
    parser.add_argument("--max-bpm", type=float, default=DEFAULT_MAX_BPM)
    parser.add_argument("--tempo-step-bpm", type=float, default=DEFAULT_TEMPO_STEP_BPM)
    parser.add_argument("--tempo-limit", type=int, default=DEFAULT_TEMPO_LIMIT)
    parser.add_argument("--phase-step-ms", type=float, default=DEFAULT_PHASE_STEP_MS)
    parser.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
    args = parser.parse_args()

    result = solve_constant_grid_dp_from_cache(
        track={"fileName": str(args.file_name), "lookupKey": normalize_lookup_key(args.file_name)},
        feature_cache_dir=Path(args.feature_cache_dir),
        min_bpm=float(args.min_bpm),
        max_bpm=float(args.max_bpm),
        tempo_step_bpm=float(args.tempo_step_bpm),
        tempo_limit=int(args.tempo_limit),
        phase_step_ms=float(args.phase_step_ms),
        max_candidates=int(args.max_candidates),
    )
    print_json({"result": result})
    return 0
