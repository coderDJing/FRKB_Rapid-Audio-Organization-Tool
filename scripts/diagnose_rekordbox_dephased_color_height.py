import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from compare_rekordbox_waveform_reference import (  # noqa: E402
    DEFAULT_APP_ATTACK_RISE,
    DEFAULT_APP_ATTACK_WEIGHT,
    DEFAULT_APP_GATE,
    DEFAULT_APP_GAMMA,
    DEFAULT_APP_RANGE_MODE,
    DEFAULT_APP_RELEASE,
    DEFAULT_APP_SCALE_PERCENTILE,
    DEFAULT_APP_SMOOTH_CURRENT_WEIGHT,
    DEFAULT_APP_SMOOTH_PREV1_WEIGHT,
    DEFAULT_APP_SMOOTH_PREV2_WEIGHT,
    _compute_app_raw_energy_series,
    _decode_audio_stereo,
    _render_app_energy_candidate,
)
from render_rekordbox_waveform_contact import (  # noqa: E402
    DEFAULT_FFMPEG,
    DEFAULT_REKORDBOX_DB,
    _app_rgb,
    _app_rgb_height_amp,
    _compute_app_raw_mean_signal,
    _first_nonzero,
    _height_metrics_values,
    _load_pwv5_color_rows,
    _load_selected_rows,
    _load_selection_rows,
    _raw_fft_ratios,
    _selection_track_ids,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SELECTION = REPO_ROOT / "out" / "research" / "rekordbox-simple-window-candidates.json"
DEFAULT_OUTPUT = REPO_ROOT / "out" / "research" / "rekordbox-dephased-color-height-diagnostic.json"
DEFAULT_SAMPLE_RATE = 44100
DEFAULT_RAW_RATE = 4800.0


def _build_candidate(reference_size: int, stereo: np.ndarray, sample_rate: int, raw_rate: float) -> np.ndarray:
    energy = _compute_app_raw_energy_series(stereo, sample_rate, raw_rate)
    duration = stereo.shape[0] / sample_rate if sample_rate > 0 else 0
    return _render_app_energy_candidate(
        energy,
        raw_rate,
        int(reference_size),
        duration,
        DEFAULT_APP_SCALE_PERCENTILE,
        DEFAULT_APP_GAMMA,
        DEFAULT_APP_RANGE_MODE,
        DEFAULT_APP_RELEASE,
        DEFAULT_APP_GATE,
        DEFAULT_APP_ATTACK_WEIGHT,
        DEFAULT_APP_ATTACK_RISE,
        DEFAULT_APP_SMOOTH_PREV2_WEIGHT,
        DEFAULT_APP_SMOOTH_PREV1_WEIGHT,
        DEFAULT_APP_SMOOTH_CURRENT_WEIGHT,
    )


def _entry_color_and_height(
    candidate: np.ndarray,
    mono: np.ndarray,
    raw_rate: float,
    reference_size: int,
    entry: int,
) -> tuple[np.ndarray, float]:
    pcm_start = int(round((entry / reference_size) * mono.size))
    pcm_end = max(pcm_start, int(round(((entry + 1) / reference_size) * mono.size)) - 1)
    ratios = _raw_fft_ratios(mono, raw_rate, pcm_start, pcm_end)
    rgb = _app_rgb(mono, raw_rate, pcm_start, pcm_end)
    amp = _app_rgb_height_amp(float(candidate[entry]) if entry < candidate.size else 0.0, ratios)
    return rgb, amp


def _diagnose_track(
    args: argparse.Namespace,
    metadata: dict[str, Any],
    reference: np.ndarray,
    reference_colors: np.ndarray,
    start: int,
    entries: int,
    radius: int,
) -> dict[str, Any]:
    track = metadata["track"]
    audio_path = Path(str(track.get("filePath") or ""))
    stereo = _decode_audio_stereo(Path(args.ffmpeg), audio_path, int(args.sample_rate))
    candidate = _build_candidate(int(reference.size), stereo, int(args.sample_rate), float(args.raw_rate))
    mono = _compute_app_raw_mean_signal(stereo, int(args.sample_rate), float(args.raw_rate))
    n = int(reference.size)
    safe_start = max(0, min(max(0, n - entries), start))
    safe_end = min(n, safe_start + entries)

    # height candidate with per-entry rgb height shaping, computed for the full window range we need
    shaped = candidate.copy()
    for entry in range(max(0, safe_start - radius), min(n, safe_end + radius)):
        _, amp = _entry_color_and_height(candidate, mono, float(args.raw_rate), n, entry)
        shaped[entry] = amp

    # find the local best shift on height (proven linear; this confirms + gives the aligning shift)
    ref_window = reference[safe_start:safe_end]
    best_shift = 0
    best_mae = _height_metrics_values(ref_window, shaped[safe_start:safe_end])["heightActiveMae"]
    base_height_mae = best_mae
    for shift in range(-radius, radius + 1):
        idx0 = max(safe_start, -shift)
        idx1 = min(safe_end, shaped.size - shift)
        if idx1 - idx0 < entries // 2:
            continue
        mae = _height_metrics_values(reference[idx0:idx1], shaped[idx0 + shift : idx1 + shift])["heightActiveMae"]
        if mae < best_mae - 1e-6:
            best_mae = mae
            best_shift = shift

    # color error at base (shift 0) and at best shift, only on entries with reference activity
    # height convention: reference[e] <-> shaped[e + shift]; color must match -> sample FRKB at e + shift
    def _color_mae(shift: int) -> float:
        errors: list[float] = []
        for entry in range(safe_start, safe_end):
            src = entry + shift
            if src < 0 or src >= n:
                continue
            if reference[entry] <= 0.02:
                continue
            rgb, _ = _entry_color_and_height(candidate, mono, float(args.raw_rate), n, src)
            errors.append(float(np.mean(np.abs(rgb - reference_colors[entry]))))
        return float(np.mean(errors)) if errors else 0.0

    base_color_mae = _color_mae(0)
    aligned_color_mae = _color_mae(best_shift)

    return {
        "title": track.get("title"),
        "artist": track.get("artist"),
        "trackId": track.get("trackId"),
        "startIndex": int(safe_start),
        "entries": int(safe_end - safe_start),
        "bestShift": int(best_shift),
        "baseHeightActiveMae": float(base_height_mae),
        "alignedHeightActiveMae": float(best_mae),
        "baseColorMae": float(base_color_mae),
        "alignedColorMae": float(aligned_color_mae),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure FRKB vs Rekordbox color/height error at the phase-aligned position (de-phased)."
    )
    parser.add_argument("--db", default=str(DEFAULT_REKORDBOX_DB))
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE)
    parser.add_argument("--raw-rate", type=float, default=DEFAULT_RAW_RATE)
    parser.add_argument("--selection-json", default=str(DEFAULT_SELECTION))
    parser.add_argument("--selection-limit", type=int, default=16)
    parser.add_argument("--entries", type=int, default=360)
    parser.add_argument("--radius", type=int, default=6)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    selection_rows = _load_selection_rows(str(args.selection_json), int(args.selection_limit))
    starts = {
        track_id: max(0, int(row.get("startIndex") or 0))
        for row in selection_rows
        for track_id in _selection_track_ids([row])
    }
    track_ids = _selection_track_ids(selection_rows)
    selected = _load_selected_rows(args, track_ids)
    color_rows = _load_pwv5_color_rows(args, set(track_ids))

    diagnostics: list[dict[str, Any]] = []
    for metadata, reference in selected:
        track_id = int(metadata["track"].get("trackId") or 0)
        reference_colors = color_rows.get(track_id)
        if reference_colors is None:
            continue
        start = starts.get(track_id, max(0, _first_nonzero(reference) - 18))
        diagnostics.append(
            _diagnose_track(args, metadata, reference, reference_colors, start, int(args.entries), int(args.radius))
        )

    summary = {
        "type": "rekordbox-dephased-color-height-diagnostic",
        "trackCount": len(diagnostics),
        "avgBaseHeightActiveMae": float(np.mean([d["baseHeightActiveMae"] for d in diagnostics])) if diagnostics else 0.0,
        "avgAlignedHeightActiveMae": float(np.mean([d["alignedHeightActiveMae"] for d in diagnostics])) if diagnostics else 0.0,
        "avgBaseColorMae": float(np.mean([d["baseColorMae"] for d in diagnostics])) if diagnostics else 0.0,
        "avgAlignedColorMae": float(np.mean([d["alignedColorMae"] for d in diagnostics])) if diagnostics else 0.0,
        "tracks": diagnostics,
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "tracks"}, ensure_ascii=False, indent=2))
    print("\nper-track:")
    for d in sorted(diagnostics, key=lambda x: -x["alignedColorMae"]):
        print(
            f"  {str(d['title'])[:32]:32s} shift={d['bestShift']:+d} "
            f"colorMae {d['baseColorMae']:.3f}->{d['alignedColorMae']:.3f}  "
            f"heightMae {d['baseHeightActiveMae']:.3f}->{d['alignedHeightActiveMae']:.3f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
