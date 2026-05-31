import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from compare_rekordbox_waveform_reference import (  # noqa: E402
    APP_COLUMN_ATTACK_MIN_AMP,
    APP_COLUMN_ATTACK_MIN_RISE,
    APP_COLUMN_ATTACK_RELATIVE_RISE,
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
    DEFAULT_APP_FULL_TRACK_ATTACK_WEIGHT,
    DEFAULT_APP_FULL_TRACK_GAMMA,
    DEFAULT_APP_FULL_TRACK_PEAK_BLEND_WEIGHT,
    DEFAULT_APP_FULL_TRACK_START_SEC,
    DEFAULT_APP_FULL_TRACK_TARGET_SEC,
    _compute_app_raw_energy_series,
    _decode_audio_stereo,
    _load_sampler_loop_rows,
    _resolve_blend_weight,
)
from render_rekordbox_waveform_contact import (  # noqa: E402
    APP_RGB_HEIGHT_BLEND,
    APP_RGB_HEIGHT_MAX,
    APP_RGB_HEIGHT_MIN,
    APP_RGB_HEIGHT_MODEL,
    DEFAULT_FFMPEG,
    DEFAULT_REKORDBOX_DB,
    _app_column_profile_from_ratios,
    _compute_app_raw_mean_signal,
    _height_metrics,
    _load_selected_rows,
    _load_selection_rows,
    _raw_fft_ratios,
    _selection_track_ids,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CACHE = REPO_ROOT / "out" / "research" / "rekordbox-like-rgb-detail-search-cache.npz"
DEFAULT_OUTPUT = REPO_ROOT / "out" / "research" / "rekordbox-like-rgb-detail-search-summary.json"
DEFAULT_SELECTION = REPO_ROOT / "out" / "research" / "rekordbox-simple-window-candidates.json"
DEFAULT_SAMPLE_RATE = 44100
DEFAULT_RAW_RATE = 4800.0
DEFAULT_WINDOW_ENTRIES = 360
SEARCH_SMOOTH_PROFILES = (
    ("current", DEFAULT_APP_SMOOTH_PREV2_WEIGHT, DEFAULT_APP_SMOOTH_PREV1_WEIGHT, DEFAULT_APP_SMOOTH_CURRENT_WEIGHT),
    ("light", 0.0, 0.1, 0.9),
    ("none", 0.0, 0.0, 1.0),
)


def _lerp(start: float, end: float, ratio: float) -> float:
    return start + (end - start) * max(0.0, min(1.0, ratio))


def _duration_ratio(duration_sec: float) -> float:
    if duration_sec <= 0 or DEFAULT_APP_FULL_TRACK_TARGET_SEC <= DEFAULT_APP_FULL_TRACK_START_SEC:
        return 0.0
    return max(
        0.0,
        min(
            1.0,
            (duration_sec - DEFAULT_APP_FULL_TRACK_START_SEC)
            / (DEFAULT_APP_FULL_TRACK_TARGET_SEC - DEFAULT_APP_FULL_TRACK_START_SEC),
        ),
    )


def _resolve_peak_blend(short_range_mode: str, full_track_peak_blend: float, duration_sec: float) -> float:
    short_blend = _resolve_blend_weight(short_range_mode)
    if short_blend is None:
        short_blend = 0.0
    return _lerp(float(short_blend), full_track_peak_blend, _duration_ratio(duration_sec))


def _resolve_gamma(short_gamma: float, full_track_gamma: float, duration_sec: float) -> float:
    return _lerp(short_gamma, full_track_gamma, _duration_ratio(duration_sec))


def _resolve_attack_weight(short_attack_weight: float, full_track_attack_weight: float, duration_sec: float) -> float:
    return _lerp(short_attack_weight, full_track_attack_weight, _duration_ratio(duration_sec))


def _entry_mean_peak(energy: np.ndarray, rate: float, entry_count: int, duration_sec: float) -> tuple[np.ndarray, np.ndarray]:
    mean = np.zeros(entry_count, dtype=np.float32)
    peak = np.zeros(entry_count, dtype=np.float32)
    if energy.size <= 0 or entry_count <= 0 or rate <= 0 or duration_sec <= 0:
        return mean, peak
    for index in range(entry_count):
        start_time = (index / entry_count) * duration_sec
        end_time = ((index + 1) / entry_count) * duration_sec
        start_frame = max(0, min(energy.size - 1, int(math.floor(start_time * rate))))
        end_frame = max(start_frame, min(energy.size - 1, int(math.ceil(end_time * rate))))
        window = energy[start_frame : end_frame + 1]
        if window.size <= 0:
            continue
        mean[index] = float(np.mean(window))
        peak[index] = float(np.max(window))
    return mean, peak


def _height_adjust(values: np.ndarray, ratios: np.ndarray, blend: float = APP_RGB_HEIGHT_BLEND) -> np.ndarray:
    if values.size <= 0:
        return values.copy()
    low = np.clip(ratios[:, 0], 0.0, 1.0)
    mid = np.clip(ratios[:, 1], 0.0, 1.0)
    high = np.clip(ratios[:, 2], 0.0, 1.0)
    safe_amp = np.clip(values.astype(np.float64), 0.0, 1.0)
    features = np.column_stack(
        (
            np.ones_like(safe_amp),
            low,
            mid,
            high,
            low * low,
            mid * mid,
            high * high,
            low * mid,
            low * high,
            mid * high,
            safe_amp,
            safe_amp * safe_amp,
        )
    )
    multiplier = np.clip(np.exp(features @ APP_RGB_HEIGHT_MODEL), APP_RGB_HEIGHT_MIN, APP_RGB_HEIGHT_MAX)
    adjusted = np.clip(safe_amp * multiplier, 0.0, 1.0)
    safe_blend = max(0.0, min(1.0, float(blend)))
    return np.clip(safe_amp * (1.0 - safe_blend) + adjusted * safe_blend, 0.0, 1.0)


def _apply_smooth(values: np.ndarray, prev2_weight: float, prev1_weight: float, current_weight: float) -> np.ndarray:
    if values.size <= 0:
        return values.copy()
    if prev2_weight <= 0 and prev1_weight <= 0:
        return values.copy()
    output = np.zeros_like(values)
    for index, value in enumerate(values):
        previous_value = float(values[index - 1]) if index > 0 else 0.0
        rise = float(value) - previous_value
        is_attack = float(value) >= APP_COLUMN_ATTACK_MIN_AMP and rise >= max(
            APP_COLUMN_ATTACK_MIN_RISE,
            previous_value * APP_COLUMN_ATTACK_RELATIVE_RISE,
        )
        if is_attack:
            output[index] = value
            continue
        total = float(value) * current_weight
        weight = current_weight
        if index >= 2 and prev2_weight > 0:
            total += float(values[index - 2]) * prev2_weight
            weight += prev2_weight
        if index >= 1 and prev1_weight > 0:
            total += float(values[index - 1]) * prev1_weight
            weight += prev1_weight
        output[index] = total / weight if weight > 0 else value
    return output


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


def _build_candidate(row: dict[str, Any], params: dict[str, Any]) -> np.ndarray:
    mean = row["mean"]
    peak = row["peak"]
    active = row["energyActive"]
    scale = float(np.percentile(active, params["scalePercentile"])) if active.size > 0 else 1.0
    if not math.isfinite(scale) or scale <= 0:
        scale = float(np.max(active)) if active.size > 0 else 1.0
    scale = max(0.04, min(1.0, scale))
    duration = float(row["duration"])
    peak_blend = _resolve_peak_blend(DEFAULT_APP_RANGE_MODE, float(params["fullTrackPeakBlendWeight"]), duration)
    gamma = _resolve_gamma(DEFAULT_APP_GAMMA, float(params["fullTrackGamma"]), duration)
    attack_weight = _resolve_attack_weight(
        DEFAULT_APP_ATTACK_WEIGHT,
        float(params["fullTrackAttackWeight"]),
        duration,
    )
    normalized_mean = np.clip(mean / scale, 0.0, 1.0)
    normalized_peak = np.clip(peak / scale, 0.0, 1.0)
    base = normalized_mean * (1.0 - peak_blend) + normalized_peak * peak_blend
    values = base.copy()
    if attack_weight > 0:
        previous_base = np.concatenate(([0.0], base[:-1]))
        attack_mask = (base - previous_base >= DEFAULT_APP_ATTACK_RISE) & (normalized_peak > base)
        values[attack_mask] = (
            base[attack_mask] * (1.0 - attack_weight) + normalized_peak[attack_mask] * attack_weight
        )
    if gamma != 1:
        values = np.power(np.clip(values, 0.0, 1.0), gamma)
    values = np.where(values < DEFAULT_APP_GATE, 0.0, values)
    values = _apply_smooth(
        values,
        float(params["smoothPrev2Weight"]),
        float(params["smoothPrev1Weight"]),
        float(params["smoothCurrentWeight"]),
    )
    return _apply_release(values, float(params["release"]))


def _row_metrics(row: dict[str, Any], candidate: np.ndarray, params: dict[str, Any]) -> dict[str, float]:
    start = int(row["start"])
    end = int(row["end"])
    window = candidate[start:end].copy()
    if row["ratios"].size == window.size * 3:
        window = _height_adjust(window, row["ratios"], float(params.get("heightBlend", APP_RGB_HEIGHT_BLEND)))
    adjusted = candidate.copy()
    adjusted[start:end] = window
    return _height_metrics(row["reference"], adjusted, start, end)


def _average_metrics(rows: list[dict[str, Any]], params: dict[str, Any]) -> dict[str, float]:
    metrics = [_row_metrics(row, _build_candidate(row, params), params) for row in rows]
    if not metrics:
        return {"heightMae": 1.0, "heightActiveMae": 1.0, "heightCorr": 0.0}
    return {
        "heightMae": float(np.mean([item["heightMae"] for item in metrics])),
        "heightActiveMae": float(np.mean([item["heightActiveMae"] for item in metrics])),
        "heightCorr": float(np.mean([item["heightCorr"] for item in metrics])),
    }


def _parameter_grid() -> list[dict[str, Any]]:
    params: list[dict[str, Any]] = []
    for scale_percentile in (99.95, 99.99):
        for full_peak_blend in (0.98, 1.0):
            for full_gamma in (1.45, 1.5, 1.55):
                for release in (0.0, 0.25, 0.42):
                    for smooth_name, prev2, prev1, current in SEARCH_SMOOTH_PROFILES[:2]:
                        for height_blend in (0.55, 0.7, 0.75, 0.85, 1.0):
                            params.append(
                                {
                                    "scalePercentile": scale_percentile,
                                    "fullTrackPeakBlendWeight": full_peak_blend,
                                    "fullTrackGamma": full_gamma,
                                    "fullTrackAttackWeight": DEFAULT_APP_FULL_TRACK_ATTACK_WEIGHT,
                                    "release": release,
                                    "smoothProfile": smooth_name,
                                    "smoothPrev2Weight": prev2,
                                    "smoothPrev1Weight": prev1,
                                    "smoothCurrentWeight": current,
                                    "heightBlend": height_blend,
                                }
                            )
    return params


def _row_payload(
    args: argparse.Namespace,
    group: str,
    metadata: dict[str, Any],
    reference: np.ndarray,
    start: int,
    entries: int,
) -> dict[str, Any]:
    track = metadata["track"]
    audio_path = Path(str(track.get("filePath") or ""))
    stereo = _decode_audio_stereo(Path(args.ffmpeg), audio_path, int(args.sample_rate))
    duration = stereo.shape[0] / int(args.sample_rate) if args.sample_rate > 0 else float(track.get("durationSec") or 0)
    energy = _compute_app_raw_energy_series(stereo, int(args.sample_rate), float(args.raw_rate))
    mean, peak = _entry_mean_peak(energy, float(args.raw_rate), int(reference.size), duration)
    mono = _compute_app_raw_mean_signal(stereo, int(args.sample_rate), float(args.raw_rate))
    safe_start = max(0, min(max(0, reference.size - entries), start))
    safe_end = min(reference.size, safe_start + entries)
    ratios = np.zeros((safe_end - safe_start, 3), dtype=np.float32)
    for offset, entry in enumerate(range(safe_start, safe_end)):
        pcm_start = int(round((entry / reference.size) * mono.size))
        pcm_end = max(pcm_start, int(round(((entry + 1) / reference.size) * mono.size)) - 1)
        ratios[offset] = _raw_fft_ratios(mono, float(args.raw_rate), pcm_start, pcm_end).astype(np.float32)
    return {
        "group": group,
        "track": track,
        "reference": reference.astype(np.float32),
        "mean": mean,
        "peak": peak,
        "energyActive": energy[energy > 1e-6].astype(np.float32),
        "ratios": ratios,
        "duration": duration,
        "start": safe_start,
        "end": safe_end,
    }


def _first_nonzero(values: np.ndarray, threshold: float = 0.02) -> int:
    indexes = np.flatnonzero(values > threshold)
    return int(indexes[0]) if indexes.size else 0


def _build_rows(args: argparse.Namespace) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    selection_rows = _load_selection_rows(str(args.selection_json), int(args.selection_limit))
    starts = {
        track_id: max(0, int(row.get("startIndex") or 0))
        for row in selection_rows
        for track_id in _selection_track_ids([row])
    }
    selected = _load_selected_rows(args, _selection_track_ids(selection_rows))
    for metadata, reference in selected:
        track_id = int(metadata["track"].get("trackId") or 0)
        rows.append(
            _row_payload(
                args,
                "simple",
                metadata,
                reference,
                starts.get(track_id, max(0, _first_nonzero(reference) - 18)),
                int(args.entries),
            )
        )
    sampler_rows = _load_sampler_loop_rows(args)
    for metadata, reference in sampler_rows:
        rows.append(
            _row_payload(
                args,
                "sampler",
                metadata,
                reference,
                max(0, _first_nonzero(reference) - 18),
                int(args.entries),
            )
        )
    return rows


def _save_cache(path: Path, rows: list[dict[str, Any]]) -> None:
    arrays: dict[str, Any] = {"row_count": np.asarray([len(rows)], dtype=np.int32)}
    metadata: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        metadata.append(
            {
                "group": row["group"],
                "track": row["track"],
                "duration": row["duration"],
                "start": row["start"],
                "end": row["end"],
            }
        )
        for key in ("reference", "mean", "peak", "energyActive", "ratios"):
            arrays[f"row{index}_{key}"] = row[key]
    arrays["metadata_json"] = np.asarray([json.dumps(metadata, ensure_ascii=False)], dtype=object)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, **arrays)


def _load_cache(path: Path) -> list[dict[str, Any]]:
    data = np.load(path, allow_pickle=True)
    metadata = json.loads(str(data["metadata_json"][0]))
    rows: list[dict[str, Any]] = []
    for index, meta in enumerate(metadata):
        rows.append(
            {
                "group": meta["group"],
                "track": meta["track"],
                "duration": float(meta["duration"]),
                "start": int(meta["start"]),
                "end": int(meta["end"]),
                "reference": data[f"row{index}_reference"].astype(np.float64),
                "mean": data[f"row{index}_mean"].astype(np.float64),
                "peak": data[f"row{index}_peak"].astype(np.float64),
                "energyActive": data[f"row{index}_energyActive"].astype(np.float64),
                "ratios": data[f"row{index}_ratios"].astype(np.float64),
            }
        )
    return rows


def _score(simple: dict[str, float], sampler: dict[str, float]) -> float:
    sampler_penalty = max(0.0, sampler["heightActiveMae"] - 0.06) * 4.0
    return (
        simple["heightActiveMae"] * 0.72
        + simple["heightMae"] * 0.18
        - max(0.0, simple["heightCorr"]) * 0.04
        + sampler["heightActiveMae"] * 0.12
        + sampler_penalty
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Search FRKB-owned Rekordbox-like RGB detail height parameters.")
    parser.add_argument("--db", default=str(DEFAULT_REKORDBOX_DB))
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE)
    parser.add_argument("--raw-rate", type=float, default=DEFAULT_RAW_RATE)
    parser.add_argument("--selection-json", default=str(DEFAULT_SELECTION))
    parser.add_argument("--selection-limit", type=int, default=16)
    parser.add_argument("--entries", type=int, default=DEFAULT_WINDOW_ENTRIES)
    parser.add_argument("--cache", default=str(DEFAULT_CACHE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--rebuild-cache", action="store_true")
    args = parser.parse_args()

    cache_path = Path(args.cache)
    if args.rebuild_cache or not cache_path.exists():
        rows = _build_rows(args)
        _save_cache(cache_path, rows)
    else:
        rows = _load_cache(cache_path)

    simple_rows = [row for row in rows if row["group"] == "simple"]
    sampler_rows = [row for row in rows if row["group"] == "sampler"]
    results: list[dict[str, Any]] = []
    for params in _parameter_grid():
        simple_metrics = _average_metrics(simple_rows, params)
        sampler_metrics = _average_metrics(sampler_rows, params)
        results.append(
            {
                **params,
                "score": _score(simple_metrics, sampler_metrics),
                "simple": simple_metrics,
                "sampler": sampler_metrics,
            }
        )
    results.sort(key=lambda item: item["score"])
    default_params = {
        "scalePercentile": DEFAULT_APP_SCALE_PERCENTILE,
        "fullTrackPeakBlendWeight": DEFAULT_APP_FULL_TRACK_PEAK_BLEND_WEIGHT,
        "fullTrackGamma": DEFAULT_APP_FULL_TRACK_GAMMA,
        "fullTrackAttackWeight": DEFAULT_APP_FULL_TRACK_ATTACK_WEIGHT,
        "release": DEFAULT_APP_RELEASE,
        "smoothProfile": "current",
        "smoothPrev2Weight": DEFAULT_APP_SMOOTH_PREV2_WEIGHT,
        "smoothPrev1Weight": DEFAULT_APP_SMOOTH_PREV1_WEIGHT,
        "smoothCurrentWeight": DEFAULT_APP_SMOOTH_CURRENT_WEIGHT,
        "heightBlend": APP_RGB_HEIGHT_BLEND,
    }
    payload = {
        "type": "rekordbox-like-rgb-detail-search",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "cache": str(cache_path),
        "rowCount": len(rows),
        "simpleRowCount": len(simple_rows),
        "samplerRowCount": len(sampler_rows),
        "default": {
            **default_params,
            "simple": _average_metrics(simple_rows, default_params),
            "sampler": _average_metrics(sampler_rows, default_params),
        },
        "best": results[0] if results else None,
        "top": results[:20],
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
