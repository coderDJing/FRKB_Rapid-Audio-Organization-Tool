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
    _decode_audio_stereo,
    _is_sampler_loop,
    _load_sampler_loop_rows,
)
from render_rekordbox_waveform_contact import (  # noqa: E402
    DEFAULT_FFMPEG,
    DEFAULT_REKORDBOX_DB,
    _compute_app_raw_mean_signal,
    _first_nonzero,
    _load_pwv5_color_rows,
    _load_selected_rows,
    _load_selection_rows,
    _raw_fft_ratios,
    _selection_track_ids,
)
from diagnose_rekordbox_dephased_color_height import _build_candidate  # noqa: E402
from render_rekordbox_waveform_contact import _app_rgb_height_amp, _height_metrics_values  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SELECTION = REPO_ROOT / "out" / "research" / "rekordbox-simple-window-candidates.json"
DEFAULT_OUTPUT = REPO_ROOT / "out" / "research" / "rekordbox-aligned-color-dataset.npz"
DEFAULT_SAMPLE_RATE = 44100
DEFAULT_RAW_RATE = 4800.0


def _aligned_shift(reference: np.ndarray, shaped: np.ndarray, start: int, end: int, radius: int) -> int:
    best_shift = 0
    best = _height_metrics_values(reference[start:end], shaped[start:end])["heightActiveMae"]
    for shift in range(-radius, radius + 1):
        idx0 = max(start, -shift)
        idx1 = min(end, shaped.size - shift)
        if idx1 - idx0 < (end - start) // 2:
            continue
        mae = _height_metrics_values(reference[idx0:idx1], shaped[idx0 + shift : idx1 + shift])["heightActiveMae"]
        if mae < best - 1e-6:
            best = mae
            best_shift = shift
    return best_shift


def _collect_track(
    args: argparse.Namespace,
    metadata: dict[str, Any],
    reference: np.ndarray,
    reference_colors: np.ndarray,
    start: int,
    entries: int,
    radius: int,
    group: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    track = metadata["track"]
    audio_path = Path(str(track.get("filePath") or ""))
    if not audio_path.exists():
        return None
    stereo = _decode_audio_stereo(Path(args.ffmpeg), audio_path, int(args.sample_rate))
    n = int(reference.size)
    candidate = _build_candidate(n, stereo, int(args.sample_rate), float(args.raw_rate))
    mono = _compute_app_raw_mean_signal(stereo, int(args.sample_rate), float(args.raw_rate))
    safe_start = max(0, min(max(0, n - entries), start))
    safe_end = min(n, safe_start + entries)

    # shaped heights for shift estimation
    shaped = candidate.copy()
    ratios_by_entry: dict[int, np.ndarray] = {}
    for entry in range(max(0, safe_start - radius), min(n, safe_end + radius)):
        pcm_start = int(round((entry / n) * mono.size))
        pcm_end = max(pcm_start, int(round(((entry + 1) / n) * mono.size)) - 1)
        ratios = _raw_fft_ratios(mono, float(args.raw_rate), pcm_start, pcm_end)
        ratios_by_entry[entry] = ratios
        shaped[entry] = _app_rgb_height_amp(float(candidate[entry]), ratios)

    shift = _aligned_shift(reference, shaped, safe_start, safe_end, radius) if group == "simple" else 0

    feats: list[np.ndarray] = []
    targets: list[np.ndarray] = []
    weights: list[float] = []
    for entry in range(safe_start, safe_end):
        src = entry + shift
        if src not in ratios_by_entry:
            continue
        if reference[entry] <= 0.02:
            continue
        ratios = ratios_by_entry[src]
        feats.append(ratios.astype(np.float64))
        targets.append(reference_colors[entry].astype(np.float64))
        weights.append(float(reference[entry]))
    if not feats:
        return None
    return np.asarray(feats), np.asarray(targets), np.asarray(weights)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract phase-aligned (band-ratios -> reference PWV5 RGB) dataset for color model fitting."
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

    feats_all: list[np.ndarray] = []
    targets_all: list[np.ndarray] = []
    weights_all: list[np.ndarray] = []
    group_all: list[str] = []
    track_index: list[int] = []

    def _add(group: str, metadata, reference, reference_colors, start, idx):
        result = _collect_track(args, metadata, reference, reference_colors, start, int(args.entries), int(args.radius), group)
        if result is None:
            return
        feats, targets, weights = result
        feats_all.append(feats)
        targets_all.append(targets)
        weights_all.append(weights)
        group_all.extend([group] * feats.shape[0])
        track_index.extend([idx] * feats.shape[0])

    for idx, (metadata, reference) in enumerate(selected):
        track_id = int(metadata["track"].get("trackId") or 0)
        reference_colors = color_rows.get(track_id)
        if reference_colors is None:
            continue
        start = starts.get(track_id, max(0, _first_nonzero(reference) - 18))
        _add("simple", metadata, reference, reference_colors, start, idx)

    sampler = _load_sampler_loop_rows(args)
    sampler_color_ids = {int(m["track"].get("trackId") or 0) for m, _ in sampler}
    sampler_colors = _load_pwv5_color_rows(args, sampler_color_ids)
    for j, (metadata, reference) in enumerate(sampler):
        track_id = int(metadata["track"].get("trackId") or 0)
        reference_colors = sampler_colors.get(track_id)
        if reference_colors is None:
            continue
        start = max(0, _first_nonzero(reference) - 18)
        _add("sampler", metadata, reference, reference_colors, start, 1000 + j)

    feats = np.concatenate(feats_all, axis=0)
    targets = np.concatenate(targets_all, axis=0)
    weights = np.concatenate(weights_all, axis=0)
    groups = np.asarray(group_all)
    tracks = np.asarray(track_index, dtype=np.int64)

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(args.output, feats=feats, targets=targets, weights=weights, groups=groups, tracks=tracks)
    print(json.dumps({
        "rows": int(feats.shape[0]),
        "simpleRows": int(np.sum(groups == "simple")),
        "samplerRows": int(np.sum(groups == "sampler")),
        "tracks": int(np.unique(tracks).size),
        "output": str(args.output),
        "featMean": [round(float(x), 4) for x in feats.mean(axis=0)],
        "targetMean": [round(float(x), 4) for x in targets.mean(axis=0)],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
