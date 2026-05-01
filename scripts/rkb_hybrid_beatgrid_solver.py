import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from rkb_beatgrid_candidate_lab import _build_grid_candidates
from rkb_beatgrid_lab_common import (
    DEFAULT_FEATURE_CACHE_DIR,
    build_feature_index_map,
    configure_utf8_stdio,
    normalize_lookup_key,
    print_json,
    read_feature_metadata,
    resolve_feature_arrays_path,
    resolve_feature_entry,
)

DEFAULT_MIN_BPM = 70.0
DEFAULT_MAX_BPM = 200.0
DEFAULT_TEMPO_STEP_BPM = 0.5
DEFAULT_TEMPO_LIMIT = 24
DEFAULT_PHASE_STEP_MS = 2.0
DEFAULT_MAX_CANDIDATES = 640
LEGACY_GRID_SOURCE = "beat-this-current-global-solver"


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric if math.isfinite(numeric) else default


def _candidate_source(candidate: dict[str, Any]) -> str:
    tempo_source = str(candidate.get("tempoSource") or "tempo")
    phase_source = str(candidate.get("phaseSource") or "phase")
    bar_source = str(candidate.get("barSource") or "bar")
    return f"hybrid:{tempo_source}:{phase_source}:{bar_source}"


def _candidate_sort_key(candidate: dict[str, Any]) -> tuple[float, float, float, float]:
    features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    return (
        _to_float(candidate.get("score")),
        _to_float(features.get("phaseScore")),
        _to_float(features.get("tempoScore")),
        _to_float(features.get("downbeatScore")),
    )


def _metadata_legacy_candidate(metadata: dict[str, Any]) -> dict[str, Any] | None:
    payload = metadata.get("legacyGridSolver") if isinstance(metadata.get("legacyGridSolver"), dict) else None
    result = payload.get("result") if isinstance(payload, dict) and isinstance(payload.get("result"), dict) else None
    if result is None:
        return None
    bpm = _to_float(result.get("bpm"))
    first_beat_ms = _to_float(result.get("firstBeatMs"))
    if bpm <= 0.0 or not math.isfinite(first_beat_ms):
        return None
    features = result.get("gridSolverFeatures") if isinstance(result.get("gridSolverFeatures"), dict) else {}
    legacy_score = _to_float(result.get("gridSolverScore"))
    anchor_confidence = _to_float(result.get("anchorConfidenceScore"))
    drift_128_ms = abs(_to_float(result.get("beatThisEstimatedDrift128Ms")))
    confidence_score = max(0.0, min(1.0, anchor_confidence))
    drift_score = max(0.0, min(1.0, (24.0 - min(24.0, drift_128_ms)) / 24.0))
    return {
        "source": "hybrid-legacy-source",
        "tempoSource": LEGACY_GRID_SOURCE,
        "phaseSource": "legacy-selected-phase",
        "barSource": "legacy-selected-downbeat",
        "bpm": round(bpm, 6),
        "firstBeatMs": round(first_beat_ms, 3),
        "barBeatOffset": int(result.get("barBeatOffset") or 0) % 32,
        "score": round(2.0 + confidence_score * 0.2 + drift_score * 0.1, 6),
        "features": {
            "tempoScore": round(max(0.0, min(1.0, drift_score)), 6),
            "phaseScore": round(confidence_score, 6),
            "downbeatScore": round(_to_float(features.get("downbeatConsensusScore")), 6),
            "legacyGridSolverScore": round(legacy_score, 6),
            "legacyGridSolverSelectedSource": str(result.get("gridSolverSelectedSource") or ""),
            "anchorConfidenceScore": round(anchor_confidence, 6),
            "beatThisEstimatedDrift128Ms": round(drift_128_ms, 3),
        },
    }


def _window_summary(metadata: dict[str, Any]) -> dict[str, Any]:
    windows = ((metadata.get("beatThis") or {}).get("windows")) or []
    valid = [item for item in windows if isinstance(item, dict)]
    if not valid:
        return {
            "beatCount": 0,
            "downbeatCount": 0,
            "qualityScore": 0.0,
            "windowIndex": 0,
            "windowDurationSec": 0.0,
            "windowCount": 0,
        }
    best = max(valid, key=lambda item: _to_float(item.get("qualityScore")))
    return {
        "beatCount": int(best.get("beatCount") or 0),
        "downbeatCount": int(best.get("downbeatCount") or 0),
        "qualityScore": round(_to_float(best.get("qualityScore")), 6),
        "windowIndex": int(best.get("windowIndex") or 0),
        "windowDurationSec": round(_to_float(best.get("windowDurationSec")), 3),
        "windowCount": len(valid),
    }


def _diagnostic_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": _candidate_source(candidate),
        "score": round(_to_float(candidate.get("score")), 6),
        "bpm": round(_to_float(candidate.get("bpm")), 6),
        "firstBeatMs": round(_to_float(candidate.get("firstBeatMs")), 3),
        "barBeatOffset": int(candidate.get("barBeatOffset") or 0) % 32,
        "features": {
            **dict(candidate.get("features") or {}),
            "tempoSource": str(candidate.get("tempoSource") or ""),
            "phaseSource": str(candidate.get("phaseSource") or ""),
            "barSource": str(candidate.get("barSource") or ""),
        },
    }


def build_hybrid_grid_candidates(
    *,
    metadata: dict[str, Any],
    arrays: dict[str, Any],
    min_bpm: float = DEFAULT_MIN_BPM,
    max_bpm: float = DEFAULT_MAX_BPM,
    tempo_step_bpm: float = DEFAULT_TEMPO_STEP_BPM,
    tempo_limit: int = DEFAULT_TEMPO_LIMIT,
    phase_step_ms: float = DEFAULT_PHASE_STEP_MS,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
) -> list[dict[str, Any]]:
    return _build_grid_candidates(
        metadata=metadata,
        arrays=arrays,
        min_bpm=min_bpm,
        max_bpm=max_bpm,
        tempo_step_bpm=tempo_step_bpm,
        tempo_limit=tempo_limit,
        coarse_phase_step_ms=phase_step_ms,
        max_candidates=max_candidates,
    )


def solve_hybrid_beatgrid(
    *,
    metadata: dict[str, Any],
    arrays: dict[str, Any],
    min_bpm: float = DEFAULT_MIN_BPM,
    max_bpm: float = DEFAULT_MAX_BPM,
    tempo_step_bpm: float = DEFAULT_TEMPO_STEP_BPM,
    tempo_limit: int = DEFAULT_TEMPO_LIMIT,
    phase_step_ms: float = DEFAULT_PHASE_STEP_MS,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
) -> dict[str, Any]:
    candidates = build_hybrid_grid_candidates(
        metadata=metadata,
        arrays=arrays,
        min_bpm=min_bpm,
        max_bpm=max_bpm,
        tempo_step_bpm=tempo_step_bpm,
        tempo_limit=tempo_limit,
        phase_step_ms=phase_step_ms,
        max_candidates=max_candidates,
    )
    legacy_candidate = _metadata_legacy_candidate(metadata)
    if legacy_candidate is not None:
        candidates.append(legacy_candidate)
    if not candidates:
        raise RuntimeError("hybrid solver candidate pool is empty")

    ranked_candidates = sorted(candidates, key=_candidate_sort_key, reverse=True)
    selected = ranked_candidates[0]
    selected_bpm = _to_float(selected.get("bpm"))
    selected_first_beat_ms = _to_float(selected.get("firstBeatMs"))
    beat_interval_sec = 60.0 / selected_bpm if selected_bpm > 0.0 else 0.0
    audio = metadata.get("audio") if isinstance(metadata.get("audio"), dict) else {}
    duration_sec = _to_float(audio.get("durationSec"))
    window = _window_summary(metadata)
    selected_features = dict(selected.get("features") or {})
    selected_score = _to_float(selected.get("score"))

    return {
        "bpm": round(selected_bpm, 6),
        "rawBpm": round(selected_bpm, 6),
        "firstBeatMs": round(selected_first_beat_ms, 3),
        "rawFirstBeatMs": round(selected_first_beat_ms, 3),
        "absoluteFirstBeatMs": round(selected_first_beat_ms, 3),
        "absoluteRawFirstBeatMs": round(selected_first_beat_ms, 3),
        "barBeatOffset": int(selected.get("barBeatOffset") or 0) % 32,
        "beatCount": int(window["beatCount"]),
        "downbeatCount": int(window["downbeatCount"]),
        "durationSec": round(duration_sec, 3),
        "beatIntervalSec": round(beat_interval_sec, 6),
        "qualityScore": float(window["qualityScore"]),
        "anchorCorrectionMs": 0.0,
        "anchorConfidenceScore": round(max(0.0, min(1.0, selected_score)), 6),
        "anchorMatchedBeatCount": 0,
        "anchorStrategy": "hybrid-grid-solver",
        "windowIndex": int(window["windowIndex"]),
        "windowStartSec": 0.0,
        "windowDurationSec": float(window["windowDurationSec"]),
        "beatThisEstimatedDrift128Ms": 0.0,
        "beatThisWindowCount": int(window["windowCount"]),
        "gridSolverSelectedSource": _candidate_source(selected),
        "gridSolverCandidateCount": len(ranked_candidates),
        "gridSolverScore": round(selected_score, 6),
        "gridSolverFeatures": {
            **selected_features,
            "solverVersion": "hybrid-cache-v1",
        },
        "gridSolverTopCandidates": [_diagnostic_candidate(item) for item in ranked_candidates[:10]],
        "gridSolverCandidates": [_diagnostic_candidate(item) for item in ranked_candidates],
    }


def solve_hybrid_beatgrid_from_cache(
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
    index_map = build_feature_index_map(feature_cache_dir)
    entry = resolve_feature_entry(track=track, index_map=index_map)
    if entry is None:
        file_name = str(track.get("fileName") or "")
        raise RuntimeError(f"hybrid feature cache missing for {file_name}")
    metadata = read_feature_metadata(feature_cache_dir, entry)
    arrays_path = resolve_feature_arrays_path(feature_cache_dir, entry, metadata)
    if not arrays_path.exists():
        raise RuntimeError(f"hybrid feature arrays missing: {arrays_path}")
    with np.load(arrays_path, allow_pickle=False) as arrays:
        return solve_hybrid_beatgrid(
            metadata=metadata,
            arrays=arrays,
            min_bpm=min_bpm,
            max_bpm=max_bpm,
            tempo_step_bpm=tempo_step_bpm,
            tempo_limit=tempo_limit,
            phase_step_ms=phase_step_ms,
            max_candidates=max_candidates,
        )


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Solve one cached track with the hybrid beatgrid solver")
    parser.add_argument("--feature-cache-dir", default=str(DEFAULT_FEATURE_CACHE_DIR))
    parser.add_argument("--file-name", required=True)
    parser.add_argument("--min-bpm", type=float, default=DEFAULT_MIN_BPM)
    parser.add_argument("--max-bpm", type=float, default=DEFAULT_MAX_BPM)
    parser.add_argument("--tempo-step-bpm", type=float, default=DEFAULT_TEMPO_STEP_BPM)
    parser.add_argument("--tempo-limit", type=int, default=DEFAULT_TEMPO_LIMIT)
    parser.add_argument("--phase-step-ms", type=float, default=DEFAULT_PHASE_STEP_MS)
    parser.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
    args = parser.parse_args()

    result = solve_hybrid_beatgrid_from_cache(
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


if __name__ == "__main__":
    raise SystemExit(main())
