import argparse
import json
import math
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from export_rekordbox_waveform_reference import (
    DEFAULT_REKORDBOX_DB,
    REPO_ROOT,
    _decode_pwv5,
    _find_track,
    _import_pyrekordbox,
    _resolve_analyze_paths,
    _track_payload,
)

DEFAULT_FFMPEG = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "out" / "research" / "rekordbox-waveform-compare"
TARGET_RATE = 150.0
DEFAULT_APP_RAW_RATE = 4800.0
DEFAULT_APP_SCALE_PERCENTILE = 99.99
DEFAULT_APP_GAMMA = 1.74
DEFAULT_APP_RANGE_MODE = "blend55"
DEFAULT_APP_RELEASE = 0.42
DEFAULT_APP_GATE = 0.02
DEFAULT_APP_ATTACK_WEIGHT = 0.78
DEFAULT_APP_ATTACK_RISE = 0.105
DEFAULT_APP_FULL_TRACK_START_SEC = 20.0
DEFAULT_APP_FULL_TRACK_TARGET_SEC = 45.0
DEFAULT_APP_FULL_TRACK_PEAK_BLEND_WEIGHT = 1.0
DEFAULT_APP_FULL_TRACK_GAMMA = 1.5
DEFAULT_APP_FULL_TRACK_ATTACK_WEIGHT = 0.0
DEFAULT_APP_CANVAS_SMOOTH = True
DEFAULT_APP_SMOOTH_PREV2_WEIGHT = 0.04
DEFAULT_APP_SMOOTH_PREV1_WEIGHT = 0.16
DEFAULT_APP_SMOOTH_CURRENT_WEIGHT = 0.8
APP_RANGE_MODES = ("rms", "mean", "blend25", "blend40", "blend42", "blend55", "blend60")
APP_SMOOTH_PROFILES = (
    ("current", 0.04, 0.16, 0.8),
    ("light", 0.04, 0.18, 0.78),
    ("lighter", 0.0, 0.12, 0.88),
    ("balanced", 0.08, 0.22, 0.7),
    ("heavy", 0.18, 0.3, 0.52),
)
APP_COLUMN_ATTACK_MIN_AMP = 0.06
APP_COLUMN_ATTACK_MIN_RISE = 0.04
APP_COLUMN_ATTACK_RELATIVE_RISE = 0.65
SAMPLER_LOOP_TITLES = {
    "house 1",
    "house 2",
    "techno 1",
    "breaks 1",
    "house 3",
    "house 4",
    "breaks 2",
    "breaks 3",
}
SAMPLER_LOOP_PATH_MARKER = "sampler/groove circuit/preset/4-floor breaks kit/"


def _decode_audio_mono(ffmpeg_path: Path, file_path: Path, sample_rate: int) -> np.ndarray:
    if not ffmpeg_path.exists():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    if not file_path.exists():
        raise SystemExit(f"audio file not found: {file_path}")
    command = [
        str(ffmpeg_path),
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(file_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "pipe:1",
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise SystemExit(result.stderr.decode("utf-8", errors="replace").strip())
    if not result.stdout:
        raise SystemExit("ffmpeg returned empty PCM")
    return np.frombuffer(result.stdout, dtype=np.float32).astype(np.float64)


def _decode_audio_stereo(ffmpeg_path: Path, file_path: Path, sample_rate: int) -> np.ndarray:
    if not ffmpeg_path.exists():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    if not file_path.exists():
        raise SystemExit(f"audio file not found: {file_path}")
    command = [
        str(ffmpeg_path),
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(file_path),
        "-vn",
        "-ac",
        "2",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "pipe:1",
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise SystemExit(result.stderr.decode("utf-8", errors="replace").strip())
    if not result.stdout:
        raise SystemExit("ffmpeg returned empty PCM")
    samples = np.frombuffer(result.stdout, dtype=np.float32).astype(np.float64)
    return samples[: samples.size - (samples.size % 2)].reshape(-1, 2)


def _segment_signal(signal: np.ndarray, entry_count: int) -> tuple[np.ndarray, np.ndarray]:
    peaks = np.zeros(entry_count, dtype=np.float64)
    rms = np.zeros(entry_count, dtype=np.float64)
    if entry_count <= 0 or signal.size == 0:
        return peaks, rms
    total = signal.size
    for index in range(entry_count):
        start = int(round((index / entry_count) * total))
        end = int(round(((index + 1) / entry_count) * total))
        if end <= start:
            end = min(total, start + 1)
        window = signal[start:end]
        if window.size == 0:
            continue
        absolute = np.abs(window)
        peaks[index] = float(np.max(absolute))
        rms[index] = float(np.sqrt(np.mean(window * window)))
    return peaks, rms


def _normalize_base(values: np.ndarray, percentile: float, gamma: float) -> np.ndarray:
    if values.size == 0:
        return values
    active = values[values > 0]
    if active.size == 0:
        return np.zeros_like(values)
    scale = float(np.percentile(active, percentile))
    if not math.isfinite(scale) or scale <= 0:
        scale = float(np.max(active))
    if scale <= 0:
        return np.zeros_like(values)
    normalized = np.clip(values / scale, 0.0, 1.0)
    if gamma != 1:
        normalized = np.power(normalized, gamma)
    return normalized


def _apply_release(values: np.ndarray, release: float) -> np.ndarray:
    if release <= 0:
        return values.copy()
    output = np.zeros_like(values)
    previous = 0.0
    for index, value in enumerate(values):
        current = max(float(value), previous * release)
        output[index] = current
        previous = current
    return output


def _lerp(start: float, end: float, ratio: float) -> float:
    return start + (end - start) * max(0.0, min(1.0, ratio))


def _resolve_blend_weight(range_mode: str) -> float | None:
    if not range_mode.startswith("blend"):
        return None
    try:
        return float(range_mode.removeprefix("blend")) / 100.0
    except ValueError:
        return None


def _resolve_app_energy_shape(
    duration_sec: float,
    range_mode: str,
    gamma: float,
    attack_weight: float,
) -> dict[str, float | None]:
    ratio = 0.0
    if duration_sec > 0 and DEFAULT_APP_FULL_TRACK_TARGET_SEC > DEFAULT_APP_FULL_TRACK_START_SEC:
        ratio = (duration_sec - DEFAULT_APP_FULL_TRACK_START_SEC) / (
            DEFAULT_APP_FULL_TRACK_TARGET_SEC - DEFAULT_APP_FULL_TRACK_START_SEC
        )
    peak_blend_weight = _resolve_blend_weight(range_mode)
    if peak_blend_weight is not None:
        peak_blend_weight = _lerp(
            peak_blend_weight,
            DEFAULT_APP_FULL_TRACK_PEAK_BLEND_WEIGHT,
            ratio,
        )
    return {
        "peakBlendWeight": peak_blend_weight,
        "gamma": _lerp(gamma, DEFAULT_APP_FULL_TRACK_GAMMA, ratio),
        "attackWeight": _lerp(attack_weight, DEFAULT_APP_FULL_TRACK_ATTACK_WEIGHT, ratio),
    }


def _candidate(
    peaks: np.ndarray,
    rms: np.ndarray,
    peak_weight: float,
    percentile: float,
    gamma: float,
    release: float,
) -> np.ndarray:
    base = peaks * peak_weight + rms * (1.0 - peak_weight)
    normalized = _normalize_base(base, percentile, gamma)
    return _apply_release(normalized, release)


def _compute_app_raw_rms_energy(
    stereo: np.ndarray,
    sample_rate: int,
    reference_entries: int,
    duration_sec: float,
    raw_rate: float,
    scale_percentile: float = DEFAULT_APP_SCALE_PERCENTILE,
    gamma: float = DEFAULT_APP_GAMMA,
    range_mode: str = DEFAULT_APP_RANGE_MODE,
    release: float = DEFAULT_APP_RELEASE,
    gate: float = DEFAULT_APP_GATE,
    attack_weight: float = DEFAULT_APP_ATTACK_WEIGHT,
    attack_rise: float = DEFAULT_APP_ATTACK_RISE,
    smooth_prev2_weight: float = DEFAULT_APP_SMOOTH_PREV2_WEIGHT,
    smooth_prev1_weight: float = DEFAULT_APP_SMOOTH_PREV1_WEIGHT,
    smooth_current_weight: float = DEFAULT_APP_SMOOTH_CURRENT_WEIGHT,
) -> np.ndarray:
    energy = _compute_app_raw_energy_series(stereo, sample_rate, raw_rate)
    return _render_app_energy_candidate(
        energy,
        max(1.0, min(float(raw_rate), float(sample_rate))),
        reference_entries,
        stereo.shape[0] / sample_rate if sample_rate > 0 and stereo.size else duration_sec,
        scale_percentile,
        gamma,
        range_mode,
        release,
        gate,
        attack_weight,
        attack_rise,
        smooth_prev2_weight,
        smooth_prev1_weight,
        smooth_current_weight,
    )


def _compute_app_raw_energy_series(
    stereo: np.ndarray,
    sample_rate: int,
    raw_rate: float,
) -> np.ndarray:
    if stereo.size == 0 or sample_rate <= 0 or raw_rate <= 0:
        return np.zeros(0, dtype=np.float64)
    total_frames = stereo.shape[0]
    rate = max(1.0, min(float(raw_rate), float(sample_rate)))
    step = sample_rate / rate
    expected_frames = int(math.floor(total_frames / step)) + 1
    rms_left = np.zeros(expected_frames, dtype=np.float64)
    rms_right = np.zeros(expected_frames, dtype=np.float64)
    out_index = 0
    position = 0.0
    next_store = step
    sum_sq_left = 0.0
    sum_sq_right = 0.0
    sample_count = 0

    for frame in range(total_frames):
        left = float(stereo[frame, 0])
        right = float(stereo[frame, 1])
        sum_sq_left += left * left
        sum_sq_right += right * right
        sample_count += 1
        position += 1.0
        if position >= next_store:
            if out_index >= expected_frames:
                break
            rms_left[out_index] = math.sqrt(sum_sq_left / sample_count) if sample_count else 0.0
            rms_right[out_index] = math.sqrt(sum_sq_right / sample_count) if sample_count else 0.0
            out_index += 1
            sum_sq_left = 0.0
            sum_sq_right = 0.0
            sample_count = 0
            next_store += step

    if out_index < expected_frames and sample_count > 0:
        rms_left[out_index:] = math.sqrt(sum_sq_left / sample_count)
        rms_right[out_index:] = math.sqrt(sum_sq_right / sample_count)

    energy = np.sqrt((rms_left * rms_left + rms_right * rms_right) / 2.0)
    return energy


def _aggregate_app_energy_window(
    window: np.ndarray,
    range_mode: str,
    peak_blend_weight: float | None = None,
) -> float:
    if window.size == 0:
        return 0.0
    if peak_blend_weight is not None:
        weight = max(0.0, min(1.0, peak_blend_weight))
        mean_value = float(np.mean(window))
        max_value = float(np.max(window))
        return mean_value * (1.0 - weight) + max_value * weight
    if range_mode == "mean":
        return float(np.mean(window))
    if range_mode.startswith("blend"):
        weight = _resolve_blend_weight(range_mode)
        if weight is None:
            return float(np.mean(window))
        mean_value = float(np.mean(window))
        max_value = float(np.max(window))
        return mean_value * (1.0 - weight) + max_value * weight
    if range_mode == "max":
        return float(np.max(window))
    if range_mode == "p90":
        return float(np.percentile(window, 90.0))
    return math.sqrt(float(np.mean(window * window)))


def _render_app_energy_candidate(
    energy: np.ndarray,
    rate: float,
    reference_entries: int,
    duration_sec: float,
    scale_percentile: float,
    gamma: float,
    range_mode: str,
    release: float,
    gate: float,
    attack_weight: float,
    attack_rise: float,
    smooth_prev2_weight: float,
    smooth_prev1_weight: float,
    smooth_current_weight: float,
    canvas_smooth: bool = DEFAULT_APP_CANVAS_SMOOTH,
) -> np.ndarray:
    if energy.size == 0 or reference_entries <= 0 or rate <= 0:
        return np.zeros(reference_entries, dtype=np.float64)
    active = energy[energy > 1e-6]
    if active.size == 0:
        return np.zeros(reference_entries, dtype=np.float64)
    scale = float(np.percentile(active, scale_percentile))
    if not math.isfinite(scale) or scale <= 0:
        scale = float(np.max(active))
    scale = min(1.0, max(0.04, scale))
    resolved_duration = duration_sec if math.isfinite(duration_sec) and duration_sec > 0 else 0
    shape = _resolve_app_energy_shape(resolved_duration, range_mode, gamma, attack_weight)
    peak_blend_weight = shape["peakBlendWeight"]
    output_gamma = float(shape["gamma"] or gamma)
    resolved_attack_weight = float(shape["attackWeight"] or attack_weight)

    candidate = np.zeros(reference_entries, dtype=np.float64)
    raw_candidate = np.zeros(reference_entries, dtype=np.float64)
    expected_frames = energy.size
    previous_base = 0.0
    for index in range(reference_entries):
        start_time = (index / reference_entries) * resolved_duration
        end_time = ((index + 1) / reference_entries) * resolved_duration
        start_frame = max(0, min(expected_frames - 1, int(math.floor(start_time * rate))))
        end_frame = max(start_frame, min(expected_frames - 1, int(math.ceil(end_time * rate))))
        window = energy[start_frame : end_frame + 1]
        if window.size == 0:
            continue
        if isinstance(peak_blend_weight, float):
            mean_value = min(1.0, float(np.mean(window)) / scale)
            peak = min(1.0, float(np.max(window)) / scale)
            base = mean_value * (1.0 - peak_blend_weight) + peak * peak_blend_weight
        else:
            base = min(1.0, _aggregate_app_energy_window(window, range_mode) / scale)
            peak = min(1.0, float(np.max(window)) / scale)
        value = base
        if resolved_attack_weight > 0 and base - previous_base >= attack_rise and peak > base:
            value = min(1.0, base * (1.0 - resolved_attack_weight) + peak * resolved_attack_weight)
        if output_gamma != 1:
            value = math.pow(value, output_gamma)
        raw_candidate[index] = 0.0 if value < gate else value
        previous_base = base
    if canvas_smooth:
        for index, value in enumerate(raw_candidate):
            previous_value = raw_candidate[index - 1] if index > 0 else 0.0
            rise = value - previous_value
            is_attack = value >= APP_COLUMN_ATTACK_MIN_AMP and rise >= max(
                APP_COLUMN_ATTACK_MIN_RISE,
                previous_value * APP_COLUMN_ATTACK_RELATIVE_RISE,
            )
            if is_attack:
                candidate[index] = value
                continue
            total = 0.0
            weight = 0.0
            if index >= 2:
                total += raw_candidate[index - 2] * smooth_prev2_weight
                weight += smooth_prev2_weight
            if index >= 1:
                total += raw_candidate[index - 1] * smooth_prev1_weight
                weight += smooth_prev1_weight
            total += value * smooth_current_weight
            weight += smooth_current_weight
            candidate[index] = total / weight if weight > 0 else value
    else:
        candidate = raw_candidate
    return _apply_release(candidate, release)


def _metrics(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    length = min(reference.size, candidate.size)
    if length <= 0:
        return {"mae": 1.0, "rmse": 1.0, "activeMae": 1.0, "corr": 0.0, "score": 1.0}
    ref = reference[:length]
    cand = candidate[:length]
    diff = cand - ref
    mae = float(np.mean(np.abs(diff)))
    rmse = float(np.sqrt(np.mean(diff * diff)))
    active_mask = ref > 0.02
    active_mae = float(np.mean(np.abs(diff[active_mask]))) if np.any(active_mask) else mae
    if float(np.std(ref)) > 0 and float(np.std(cand)) > 0:
        corr = float(np.corrcoef(ref, cand)[0, 1])
    else:
        corr = 0.0
    score = active_mae * 0.55 + mae * 0.3 + rmse * 0.15 - max(0.0, corr) * 0.05
    return {"mae": mae, "rmse": rmse, "activeMae": active_mae, "corr": corr, "score": score}


def _search_candidates(peaks: np.ndarray, rms: np.ndarray, reference: np.ndarray) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for peak_weight in (0.0, 0.25, 0.45, 0.6, 0.75, 0.9, 1.0):
        for percentile in (95.0, 97.0, 98.5, 99.0, 99.5, 99.8):
            for gamma in (0.35, 0.45, 0.55, 0.65, 0.8, 1.0):
                for release in (0.0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.88):
                    cand = _candidate(peaks, rms, peak_weight, percentile, gamma, release)
                    metric = _metrics(reference, cand)
                    results.append(
                        {
                            "peakWeight": peak_weight,
                            "percentile": percentile,
                            "gamma": gamma,
                            "release": release,
                            **metric,
                        }
                    )
    return sorted(results, key=lambda item: item["score"])


def _parameter_grid() -> list[dict[str, float]]:
    return [
        {
            "peakWeight": peak_weight,
            "percentile": percentile,
            "gamma": gamma,
            "release": release,
        }
        for peak_weight in (0.0, 0.25, 0.45, 0.6, 0.75, 0.9, 1.0)
        for percentile in (95.0, 97.0, 98.5, 99.0, 99.5, 99.8)
        for gamma in (0.35, 0.45, 0.55, 0.65, 0.8, 1.0)
        for release in (0.0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.88)
    ]


def _search_global_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for params in _parameter_grid():
        per_track: list[dict[str, float]] = []
        for row in rows:
            cand = _candidate(
                row["peaks"],
                row["rms"],
                params["peakWeight"],
                params["percentile"],
                params["gamma"],
                params["release"],
            )
            per_track.append(_metrics(row["reference"], cand))
        if not per_track:
            continue
        results.append(
            {
                **params,
                "trackCount": len(per_track),
                "mae": float(np.mean([item["mae"] for item in per_track])),
                "rmse": float(np.mean([item["rmse"] for item in per_track])),
                "activeMae": float(np.mean([item["activeMae"] for item in per_track])),
                "corr": float(np.mean([item["corr"] for item in per_track])),
                "score": float(np.mean([item["score"] for item in per_track])),
            }
        )
    return sorted(results, key=lambda item: item["score"])


def _app_parameter_grid() -> list[dict[str, Any]]:
    return [
        {
            "scalePercentile": scale_percentile,
            "gamma": gamma,
            "rangeMode": range_mode,
            "release": release,
            "gate": gate,
            "attackWeight": attack_weight,
            "attackRise": attack_rise,
            "smoothProfile": smooth_profile,
            "smoothPrev2Weight": smooth_prev2_weight,
            "smoothPrev1Weight": smooth_prev1_weight,
            "smoothCurrentWeight": smooth_current_weight,
        }
        for scale_percentile in (99.5, 99.8)
        for gamma in (1.15, 1.3)
        for range_mode in ("mean", "rms", "blend20", "blend30", "blend40")
        for release in (0.0,)
        for gate in (0.02,)
        for attack_weight in (0.0, 0.2, 0.35, 0.5, 0.7)
        for attack_rise in (0.06, 0.1, 0.14, 0.2)
        for smooth_profile, smooth_prev2_weight, smooth_prev1_weight, smooth_current_weight in APP_SMOOTH_PROFILES
    ]


def _app_candidate_from_row(row: dict[str, Any], params: dict[str, Any]) -> np.ndarray:
    return _render_app_energy_candidate(
        row["energy"],
        row["rawRate"],
        int(row["reference"].size),
        row["duration"],
        float(params["scalePercentile"]),
        float(params["gamma"]),
        str(params["rangeMode"]),
        float(params["release"]),
        float(params["gate"]),
        float(params["attackWeight"]),
        float(params["attackRise"]),
        float(params["smoothPrev2Weight"]),
        float(params["smoothPrev1Weight"]),
        float(params["smoothCurrentWeight"]),
    )


def _search_app_rms_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for params in _app_parameter_grid():
        per_track = [_metrics(row["reference"], _app_candidate_from_row(row, params)) for row in rows]
        if not per_track:
            continue
        results.append(
            {
                **params,
                "trackCount": len(per_track),
                **_average_metrics(per_track),
            }
        )
    return sorted(results, key=lambda item: item["score"])


def _average_metrics(per_track: list[dict[str, float]]) -> dict[str, float]:
    if not per_track:
        return {"mae": 1.0, "rmse": 1.0, "activeMae": 1.0, "corr": 0.0, "score": 1.0}
    return {
        "mae": float(np.mean([item["mae"] for item in per_track])),
        "rmse": float(np.mean([item["rmse"] for item in per_track])),
        "activeMae": float(np.mean([item["activeMae"] for item in per_track])),
        "corr": float(np.mean([item["corr"] for item in per_track])),
        "score": float(np.mean([item["score"] for item in per_track])),
    }


def _default_app_rms_parameters(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "algorithm": "app-rms-energy",
        "rawRate": args.raw_rate,
        "sampleRate": args.sample_rate,
        "scalePercentile": DEFAULT_APP_SCALE_PERCENTILE,
        "gamma": DEFAULT_APP_GAMMA,
        "rangeMode": DEFAULT_APP_RANGE_MODE,
        "release": DEFAULT_APP_RELEASE,
        "gate": DEFAULT_APP_GATE,
        "attackWeight": DEFAULT_APP_ATTACK_WEIGHT,
        "attackRise": DEFAULT_APP_ATTACK_RISE,
        "fullTrackStartSec": DEFAULT_APP_FULL_TRACK_START_SEC,
        "fullTrackTargetSec": DEFAULT_APP_FULL_TRACK_TARGET_SEC,
        "fullTrackPeakBlendWeight": DEFAULT_APP_FULL_TRACK_PEAK_BLEND_WEIGHT,
        "fullTrackGamma": DEFAULT_APP_FULL_TRACK_GAMMA,
        "fullTrackAttackWeight": DEFAULT_APP_FULL_TRACK_ATTACK_WEIGHT,
        "canvasSmooth": DEFAULT_APP_CANVAS_SMOOTH,
        "smoothPrev2Weight": DEFAULT_APP_SMOOTH_PREV2_WEIGHT,
        "smoothPrev1Weight": DEFAULT_APP_SMOOTH_PREV1_WEIGHT,
        "smoothCurrentWeight": DEFAULT_APP_SMOOTH_CURRENT_WEIGHT,
    }


def _first_nonzero(values: np.ndarray, threshold: float = 0.02) -> int:
    indexes = np.flatnonzero(values > threshold)
    return int(indexes[0]) if indexes.size else 0


def _render_svg(
    output_path: Path,
    reference: np.ndarray,
    candidate: np.ndarray,
    start_index: int,
    entry_count: int,
    title: str,
) -> None:
    start = max(0, start_index)
    end = min(reference.size, start + entry_count)
    ref = reference[start:end]
    cand = candidate[start:end]
    width = max(1, ref.size)
    scale = 4
    svg_width = width * scale + 80
    lane_height = 96
    svg_height = lane_height * 2 + 70

    def bars(values: np.ndarray, top: int, color: str) -> str:
        parts: list[str] = []
        baseline = top + lane_height - 8
        max_height = lane_height - 16
        for index, value in enumerate(values):
            h = max(1, int(round(float(value) * max_height)))
            x = 40 + index * scale
            y = baseline - h
            parts.append(f'<rect x="{x}" y="{y}" width="{scale}" height="{h}" fill="{color}" />')
        return "\n".join(parts)

    body = "\n".join(
        [
            f'<text x="40" y="22" fill="#ddd" font-size="14">{title}</text>',
            '<text x="40" y="48" fill="#9cc8ff" font-size="12">rekordbox PWV5 height</text>',
            '<text x="40" y="144" fill="#ffcf7a" font-size="12">candidate</text>',
            bars(ref, 50, "#54a6ff"),
            bars(cand, 146, "#ffb84d"),
        ]
    )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{svg_width}" height="{svg_height}" '
        f'viewBox="0 0 {svg_width} {svg_height}">'
        '<rect width="100%" height="100%" fill="#101114" />'
        f"{body}</svg>"
    )
    output_path.write_text(svg, encoding="utf-8")


def _load_rekordbox_reference(args: argparse.Namespace) -> tuple[dict[str, Any], np.ndarray]:
    rekordbox_db_cls, anlz_file_cls = _import_pyrekordbox()
    db_path = Path(args.db).expanduser()
    db = rekordbox_db_cls(path=str(db_path), db_dir=str(db_path.parent))
    try:
        content = _find_track(db, args)
        track = _track_payload(content)
        analyze_paths = _resolve_analyze_paths(db, content)
    finally:
        close = getattr(db, "close", None)
        if callable(close):
            close()
    ext_path = analyze_paths.get("ext")
    if not ext_path or not Path(ext_path).exists():
        raise SystemExit("Rekordbox EXT analysis file not found for selected track")
    ext = anlz_file_cls.parse_file(ext_path)
    if "PWV5" not in ext:
        raise SystemExit("Selected Rekordbox EXT file has no PWV5 tag")
    pwv5 = _decode_pwv5(ext.get_tag("PWV5"))
    reference = np.asarray(pwv5["heights"], dtype=np.float64) / float(pwv5["heightMax"])
    return {"track": track, "analyzePaths": analyze_paths}, reference


def _load_rekordbox_reference_for_content(
    db: Any,
    content: Any,
    anlz_file_cls: Any,
) -> tuple[dict[str, Any], np.ndarray] | None:
    track = _track_payload(content)
    audio_path = Path(str(track.get("filePath") or ""))
    if not audio_path.exists():
        return None
    analyze_paths = _resolve_analyze_paths(db, content)
    ext_path = analyze_paths.get("ext")
    if not ext_path or not Path(ext_path).exists():
        return None
    ext = anlz_file_cls.parse_file(ext_path)
    if "PWV5" not in ext:
        return None
    pwv5 = _decode_pwv5(ext.get_tag("PWV5"))
    reference = np.asarray(pwv5["heights"], dtype=np.float64) / float(pwv5["heightMax"])
    if reference.size <= 0:
        return None
    return {"track": track, "analyzePaths": analyze_paths}, reference


def _load_all_existing_rows(args: argparse.Namespace) -> list[tuple[dict[str, Any], np.ndarray]]:
    rekordbox_db_cls, anlz_file_cls = _import_pyrekordbox()
    db_path = Path(args.db).expanduser()
    db = rekordbox_db_cls(path=str(db_path), db_dir=str(db_path.parent))
    try:
        rows = []
        for content in db.get_content().all():
            loaded = _load_rekordbox_reference_for_content(db, content, anlz_file_cls)
            if loaded is not None:
                rows.append(loaded)
        return rows
    finally:
        close = getattr(db, "close", None)
        if callable(close):
            close()


def _is_sampler_loop_track(track: dict[str, Any]) -> bool:
    title = str(track.get("title") or "").strip().casefold()
    file_path = str(track.get("filePath") or "").replace("\\", "/").casefold()
    return title in SAMPLER_LOOP_TITLES or SAMPLER_LOOP_PATH_MARKER in file_path


def _is_sampler_loop(metadata: dict[str, Any]) -> bool:
    track = metadata.get("track") or {}
    return _is_sampler_loop_track(track)


def _load_sampler_loop_rows(args: argparse.Namespace) -> list[tuple[dict[str, Any], np.ndarray]]:
    rekordbox_db_cls, anlz_file_cls = _import_pyrekordbox()
    db_path = Path(args.db).expanduser()
    db = rekordbox_db_cls(path=str(db_path), db_dir=str(db_path.parent))
    try:
        rows = []
        for content in db.get_content().all():
            track = _track_payload(content)
            if not _is_sampler_loop_track(track):
                continue
            loaded = _load_rekordbox_reference_for_content(db, content, anlz_file_cls)
            if loaded is not None:
                rows.append(loaded)
        return rows
    finally:
        close = getattr(db, "close", None)
        if callable(close):
            close()


def _prepare_candidate_row(
    args: argparse.Namespace,
    metadata: dict[str, Any],
    reference: np.ndarray,
) -> dict[str, Any]:
    audio_path = Path(str(metadata["track"].get("filePath") or ""))
    if args.algorithm in ("app-rms-energy", "app-rms-search"):
        stereo = _decode_audio_stereo(Path(args.ffmpeg), audio_path, args.sample_rate)
        raw_rate = max(1.0, min(float(args.raw_rate), float(args.sample_rate)))
        duration = float(metadata["track"].get("durationSec") or 0)
        decoded_duration = stereo.shape[0] / args.sample_rate if args.sample_rate > 0 else duration
        if args.algorithm == "app-rms-search":
            return {
                "metadata": metadata,
                "reference": reference,
                "energy": _compute_app_raw_energy_series(stereo, args.sample_rate, args.raw_rate),
                "rawRate": raw_rate,
                "duration": decoded_duration if decoded_duration > 0 else duration,
            }
        candidate = _compute_app_raw_rms_energy(
            stereo,
            args.sample_rate,
            int(reference.size),
            decoded_duration if decoded_duration > 0 else duration,
            args.raw_rate,
        )
        return {"metadata": metadata, "reference": reference, "candidate": candidate}

    signal = _decode_audio_mono(Path(args.ffmpeg), audio_path, args.sample_rate)
    peaks, rms = _segment_signal(signal, int(reference.size))
    return {"metadata": metadata, "reference": reference, "peaks": peaks, "rms": rms}


def _write_outputs(
    output_dir: Path,
    metadata: dict[str, Any],
    reference: np.ndarray,
    candidate_values: np.ndarray,
    best: dict[str, Any],
    top_results: list[dict[str, Any]],
) -> dict[str, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    track = metadata["track"]
    slug = f"{track.get('trackId')}-{track.get('title')}".replace("/", "-").replace("\\", "-")
    safe_slug = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in slug)[:90]
    json_path = output_dir / f"{safe_slug}-metrics.json"
    svg_path = output_dir / f"{safe_slug}-first-onset.svg"
    onset = _first_nonzero(reference)
    _render_svg(
        svg_path,
        reference,
        candidate_values,
        max(0, onset - 36),
        240,
        f"{track.get('title')} / onset index {onset}",
    )
    payload = {
        "type": "rekordbox-waveform-candidate-comparison",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "track": track,
        "analyzePaths": metadata["analyzePaths"],
        "reference": {
            "source": "PWV5 height",
            "entryCount": int(reference.size),
            "firstNonzeroIndex": onset,
        },
        "best": best,
        "top": top_results[:20],
        "svg": str(svg_path),
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"json": str(json_path), "svg": str(svg_path)}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare a local candidate waveform algorithm against Rekordbox PWV5 heights."
    )
    parser.add_argument("--db", default=str(DEFAULT_REKORDBOX_DB), help="Path to rekordbox master.db")
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG), help="Path to ffmpeg")
    parser.add_argument("--file", help="Exact audio file path in Rekordbox")
    parser.add_argument("--title", help="Case-insensitive title substring")
    parser.add_argument("--track-id", help="Exact Rekordbox content ID")
    parser.add_argument("--all-existing", action="store_true", help="Search one global parameter set across all tracks whose audio files still exist")
    parser.add_argument("--sampler-loops", action="store_true", help="Limit --all-existing to simple Rekordbox sampler loop files")
    parser.add_argument("--algorithm", choices=("grid", "app-rms-energy", "app-rms-search"), default="grid")
    parser.add_argument("--raw-rate", type=float, default=DEFAULT_APP_RAW_RATE)
    parser.add_argument("--first", action="store_true", help="Use the first match when selector is ambiguous")
    parser.add_argument("--sample-rate", type=int, default=44100)
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    args = parser.parse_args()

    if args.all_existing:
        loaded_rows = _load_sampler_loop_rows(args) if args.sampler_loops else _load_all_existing_rows(args)
        if not loaded_rows:
            raise SystemExit("No Rekordbox tracks with existing audio and PWV5 data were found")
        rows = [_prepare_candidate_row(args, metadata, reference) for metadata, reference in loaded_rows]
        output_dir = Path(args.output_dir)
        if args.algorithm == "app-rms-energy":
            best = _default_app_rms_parameters(args)
            per_track_outputs = []
            per_track_metrics = []
            for row in rows:
                metrics = _metrics(row["reference"], row["candidate"])
                per_track_metrics.append(metrics)
                outputs = _write_outputs(
                    output_dir,
                    row["metadata"],
                    row["reference"],
                    row["candidate"],
                    {**best, **metrics},
                    [],
                )
                per_track_outputs.append(
                    {
                        "track": row["metadata"]["track"],
                        "metrics": metrics,
                        "outputs": outputs,
                    }
                )
            summary = {
                "mode": "all-existing",
                "filter": "sampler-loops" if args.sampler_loops else "none",
                "trackCount": len(rows),
                "best": {**best, **_average_metrics(per_track_metrics)},
                "tracks": per_track_outputs,
            }
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "summary.json").write_text(
                json.dumps(summary, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return 0

        if args.algorithm == "app-rms-search":
            results = _search_app_rms_candidates(rows)
            best = results[0]
            per_track_outputs = []
            for row in rows:
                best_values = _app_candidate_from_row(row, best)
                outputs = _write_outputs(
                    output_dir,
                    row["metadata"],
                    row["reference"],
                    best_values,
                    best,
                    results,
                )
                per_track_outputs.append(
                    {
                        "track": row["metadata"]["track"],
                        "metrics": _metrics(row["reference"], best_values),
                        "outputs": outputs,
                    }
                )
            summary = {
                "mode": "all-existing",
                "filter": "sampler-loops" if args.sampler_loops else "none",
                "trackCount": len(rows),
                "best": best,
                "top": results[:10],
                "tracks": per_track_outputs,
            }
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "summary.json").write_text(
                json.dumps(summary, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return 0

        results = _search_global_candidates(rows)
        best = results[0]
        per_track_outputs = []
        for row in rows:
            best_values = _candidate(
                row["peaks"],
                row["rms"],
                best["peakWeight"],
                best["percentile"],
                best["gamma"],
                best["release"],
            )
            outputs = _write_outputs(
                output_dir,
                row["metadata"],
                row["reference"],
                best_values,
                best,
                results,
            )
            per_track_outputs.append(
                {
                    "track": row["metadata"]["track"],
                    "metrics": _metrics(row["reference"], best_values),
                    "outputs": outputs,
                }
            )
        summary = {
            "mode": "all-existing",
            "filter": "sampler-loops" if args.sampler_loops else "none",
            "trackCount": len(rows),
            "best": best,
            "top": results[:10],
            "tracks": per_track_outputs,
        }
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    metadata, reference = _load_rekordbox_reference(args)
    row = _prepare_candidate_row(args, metadata, reference)
    if args.algorithm == "app-rms-energy":
        metrics = _metrics(reference, row["candidate"])
        best = {**_default_app_rms_parameters(args), **metrics}
        outputs = _write_outputs(Path(args.output_dir), metadata, reference, row["candidate"], best, [])
        summary = {
            "track": metadata["track"],
            "entryCount": int(reference.size),
            "best": best,
            "outputs": outputs,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    if args.algorithm == "app-rms-search":
        results = _search_app_rms_candidates([row])
        best = results[0]
        best_values = _app_candidate_from_row(row, best)
        outputs = _write_outputs(Path(args.output_dir), metadata, reference, best_values, best, results)
        summary = {
            "track": metadata["track"],
            "entryCount": int(reference.size),
            "best": best,
            "outputs": outputs,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    peaks = row["peaks"]
    rms = row["rms"]
    results = _search_candidates(peaks, rms, reference)
    best = results[0]
    best_values = _candidate(
        peaks,
        rms,
        best["peakWeight"],
        best["percentile"],
        best["gamma"],
        best["release"],
    )
    outputs = _write_outputs(Path(args.output_dir), metadata, reference, best_values, best, results)
    summary = {
        "track": metadata["track"],
        "entryCount": int(reference.size),
        "best": best,
        "outputs": outputs,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
