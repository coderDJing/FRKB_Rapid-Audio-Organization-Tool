import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from search_rekordbox_like_rgb_detail import (  # noqa: E402
    DEFAULT_CACHE,
    _build_candidate,
    _load_cache,
)
from compare_rekordbox_waveform_reference import (  # noqa: E402
    DEFAULT_APP_FULL_TRACK_ATTACK_WEIGHT,
    DEFAULT_APP_FULL_TRACK_GAMMA,
    DEFAULT_APP_FULL_TRACK_PEAK_BLEND_WEIGHT,
    DEFAULT_APP_RELEASE,
    DEFAULT_APP_SCALE_PERCENTILE,
    DEFAULT_APP_SMOOTH_CURRENT_WEIGHT,
    DEFAULT_APP_SMOOTH_PREV1_WEIGHT,
    DEFAULT_APP_SMOOTH_PREV2_WEIGHT,
)
from render_rekordbox_waveform_contact import _height_metrics_values  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPO_ROOT / "out" / "research" / "rekordbox-phase-alignment-diagnostic.json"


def _default_params() -> dict[str, Any]:
    return {
        "scalePercentile": DEFAULT_APP_SCALE_PERCENTILE,
        "fullTrackPeakBlendWeight": DEFAULT_APP_FULL_TRACK_PEAK_BLEND_WEIGHT,
        "fullTrackGamma": DEFAULT_APP_FULL_TRACK_GAMMA,
        "fullTrackAttackWeight": DEFAULT_APP_FULL_TRACK_ATTACK_WEIGHT,
        "release": DEFAULT_APP_RELEASE,
        "smoothPrev2Weight": DEFAULT_APP_SMOOTH_PREV2_WEIGHT,
        "smoothPrev1Weight": DEFAULT_APP_SMOOTH_PREV1_WEIGHT,
        "smoothCurrentWeight": DEFAULT_APP_SMOOTH_CURRENT_WEIGHT,
    }


def _local_best_shift(
    reference: np.ndarray,
    candidate: np.ndarray,
    center: int,
    half_window: int,
    radius: int,
) -> dict[str, float] | None:
    start = max(0, center - half_window)
    end = min(reference.size, candidate.size, center + half_window)
    if end - start < max(8, half_window):
        return None
    ref_window = reference[start:end]
    # require enough active energy in the reference window to be meaningful
    if float(np.mean(ref_window > 0.02)) < 0.25:
        return None
    baseline = _height_metrics_values(ref_window, candidate[start:end])
    best_shift = 0
    best_mae = baseline["heightActiveMae"]
    for shift in range(-radius, radius + 1):
        index_start = max(start, -shift)
        index_end = min(end, candidate.size - shift)
        if index_end - index_start < max(8, half_window):
            continue
        metrics = _height_metrics_values(
            reference[index_start:index_end],
            candidate[index_start + shift : index_end + shift],
        )
        if metrics["heightActiveMae"] < best_mae - 1e-6:
            best_mae = metrics["heightActiveMae"]
            best_shift = shift
    return {
        "center": float(center),
        "bestShift": float(best_shift),
        "baselineActiveMae": float(baseline["heightActiveMae"]),
        "bestActiveMae": float(best_mae),
    }


def _fit_line(centers: np.ndarray, shifts: np.ndarray) -> dict[str, float]:
    if centers.size < 3:
        return {"slope": 0.0, "intercept": 0.0, "r2": 0.0}
    slope, intercept = np.polyfit(centers, shifts, 1)
    predicted = slope * centers + intercept
    ss_res = float(np.sum((shifts - predicted) ** 2))
    ss_tot = float(np.sum((shifts - np.mean(shifts)) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-9 else 0.0
    return {"slope": float(slope), "intercept": float(intercept), "r2": float(r2)}


def _active_mae(reference: np.ndarray, candidate: np.ndarray) -> float:
    length = min(reference.size, candidate.size)
    if length <= 0:
        return 1.0
    ref = reference[:length]
    cand = candidate[:length]
    active = ref > 0.02
    if not np.any(active):
        return float(np.mean(np.abs(cand - ref)))
    return float(np.mean(np.abs(cand[active] - ref[active])))


def _linear_warp(candidate: np.ndarray, slope: float, intercept: float) -> np.ndarray:
    # reference[i] best matches candidate[i + slope*i + intercept]
    indexes = np.arange(candidate.size, dtype=np.float64)
    source = indexes * (1.0 + slope) + intercept
    return np.interp(source, indexes, candidate, left=0.0, right=0.0)


def _diagnose_row(
    row: dict[str, Any],
    params: dict[str, Any],
    half_window: int,
    stride: int,
    radius: int,
) -> dict[str, Any]:
    reference = row["reference"]
    candidate = _build_candidate(row, params)
    n = int(reference.size)
    samples: list[dict[str, float]] = []
    for center in range(half_window, n - half_window, stride):
        result = _local_best_shift(reference, candidate, center, half_window, radius)
        if result is not None:
            samples.append(result)
    centers = np.asarray([item["center"] for item in samples], dtype=np.float64)
    shifts = np.asarray([item["bestShift"] for item in samples], dtype=np.float64)
    fit = _fit_line(centers, shifts)

    # quantify the ceiling of a per-file 2-parameter (offset + scale) time-base correction
    full_active_mae = _active_mae(reference, candidate)
    offset_only = _linear_warp(candidate, 0.0, fit["intercept"])
    offset_scale = _linear_warp(candidate, fit["slope"], fit["intercept"])
    full_active_mae_offset = _active_mae(reference, offset_only)
    full_active_mae_corrected = _active_mae(reference, offset_scale)
    # slope = (D_rb / D_decoded - 1): implied duration ratio of rekordbox vs decoded
    implied_duration_ratio = 1.0 + fit["slope"]
    # total drift across whole track in entries
    total_drift_entries = fit["slope"] * n
    duration = float(row["duration"])
    entries_per_sec = n / duration if duration > 0 else 0.0
    return {
        "title": row["track"].get("title"),
        "artist": row["track"].get("artist"),
        "trackId": row["track"].get("trackId"),
        "group": row["group"],
        "entryCount": n,
        "durationSec": duration,
        "entriesPerSec": entries_per_sec,
        "sampleCount": len(samples),
        "slope": fit["slope"],
        "interceptEntries": fit["intercept"],
        "r2": fit["r2"],
        "impliedDurationRatio": implied_duration_ratio,
        "totalDriftEntries": total_drift_entries,
        "interceptMs": (fit["intercept"] / entries_per_sec * 1000.0) if entries_per_sec > 0 else 0.0,
        "totalDriftMs": (total_drift_entries / entries_per_sec * 1000.0) if entries_per_sec > 0 else 0.0,
        "fullActiveMae": full_active_mae,
        "fullActiveMaeOffsetOnly": full_active_mae_offset,
        "fullActiveMaeCorrected": full_active_mae_corrected,
        "shiftSamples": samples,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Diagnose Rekordbox vs FRKB waveform phase alignment as window-local best shift vs position."
    )
    parser.add_argument("--cache", default=str(DEFAULT_CACHE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--half-window", type=int, default=60)
    parser.add_argument("--stride", type=int, default=40)
    parser.add_argument("--radius", type=int, default=8)
    args = parser.parse_args()

    rows = _load_cache(Path(args.cache))
    params = _default_params()
    diagnostics = [
        _diagnose_row(row, params, int(args.half_window), int(args.stride), int(args.radius))
        for row in rows
    ]

    simple = [item for item in diagnostics if item["group"] == "simple" and item["sampleCount"] >= 3]
    summary = {
        "type": "rekordbox-phase-alignment-diagnostic",
        "halfWindow": int(args.half_window),
        "stride": int(args.stride),
        "radius": int(args.radius),
        "simpleAvgSlope": float(np.mean([item["slope"] for item in simple])) if simple else 0.0,
        "simpleAvgInterceptEntries": float(np.mean([item["interceptEntries"] for item in simple])) if simple else 0.0,
        "simpleAvgR2": float(np.mean([item["r2"] for item in simple])) if simple else 0.0,
        "simpleAvgImpliedDurationRatio": float(np.mean([item["impliedDurationRatio"] for item in simple])) if simple else 0.0,
        "simpleAvgInterceptMs": float(np.mean([item["interceptMs"] for item in simple])) if simple else 0.0,
        "simpleAvgTotalDriftMs": float(np.mean([item["totalDriftMs"] for item in simple])) if simple else 0.0,
        "simpleAvgFullActiveMae": float(np.mean([item["fullActiveMae"] for item in simple])) if simple else 0.0,
        "simpleAvgFullActiveMaeOffsetOnly": float(np.mean([item["fullActiveMaeOffsetOnly"] for item in simple])) if simple else 0.0,
        "simpleAvgFullActiveMaeCorrected": float(np.mean([item["fullActiveMaeCorrected"] for item in simple])) if simple else 0.0,
        "tracks": diagnostics,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    # compact console view
    print(json.dumps({k: v for k, v in summary.items() if k != "tracks"}, ensure_ascii=False, indent=2))
    print("\nper-track (simple, sorted by |slope|):")
    for item in sorted(simple, key=lambda d: -abs(d["slope"])):
        print(
            f"  {item['title'][:34]:34s} slope={item['slope']:+.6f} "
            f"intercept={item['interceptEntries']:+.2f}e ({item['interceptMs']:+.1f}ms) "
            f"r2={item['r2']:.2f} driftTot={item['totalDriftEntries']:+.1f}e "
            f"ratio={item['impliedDurationRatio']:.5f} n={item['sampleCount']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
