import argparse
import json
import math
import subprocess
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from compare_rekordbox_waveform_reference import (
    DEFAULT_APP_ATTACK_RISE,
    DEFAULT_APP_ATTACK_WEIGHT,
    DEFAULT_APP_GATE,
    DEFAULT_APP_GAMMA,
    DEFAULT_APP_RANGE_MODE,
    DEFAULT_APP_RAW_RATE,
    DEFAULT_APP_RELEASE,
    DEFAULT_APP_SCALE_PERCENTILE,
    DEFAULT_APP_SMOOTH_CURRENT_WEIGHT,
    DEFAULT_APP_SMOOTH_PREV1_WEIGHT,
    DEFAULT_APP_SMOOTH_PREV2_WEIGHT,
    DEFAULT_FFMPEG,
    _compute_app_raw_energy_series,
    _decode_audio_stereo,
    _is_sampler_loop,
    _load_all_existing_rows,
    _load_rekordbox_reference_for_content,
    _load_sampler_loop_rows,
    _render_app_energy_candidate,
)
from export_rekordbox_waveform_reference import (
    DEFAULT_REKORDBOX_DB,
    _decode_pwv5,
    _decode_pwv7,
    _import_pyrekordbox,
    _resolve_analyze_paths,
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

RAW_FFT_MIN_SIZE = 128
RAW_FFT_MAX_SIZE = 512
RAW_FFT_LOW_RATIO = 0.05
RAW_FFT_MID_RATIO = 0.50
RAW_FFT_EPSILON = 1e-9
LOW_LAYER_COLOR = np.asarray([0, 72, 255], dtype=np.float64) / 255.0
MID_LAYER_COLOR = np.asarray([255, 92, 22], dtype=np.float64) / 255.0
HIGH_LAYER_COLOR = np.asarray([246, 250, 255], dtype=np.float64) / 255.0
LOW_LAYER_ALPHA_BASE = 0.72
MID_LAYER_ALPHA_BASE = 0.88
HIGH_LAYER_ALPHA_BASE = 0.76
APP_RGB_HEIGHT_BLEND = 0.7
APP_RGB_HEIGHT_MIN = 0.65
APP_RGB_HEIGHT_MAX = 1.45
APP_RGB_HEIGHT_MODEL = np.asarray(
    [
        -0.20727584881057212,
        -1.1089910180387275,
        -0.80612393020295,
        1.3458833113691815,
        0.48550939516603503,
        0.1675900273481133,
        -0.9171718984789596,
        0.5689150178041793,
        0.14729608628360905,
        0.2411855818375205,
        1.4148689280909756,
        -0.6614876294854295,
    ],
    dtype=np.float64,
)
APP_COLOR_POST_SCALE = np.asarray([1.325, 1.175, 1.55], dtype=np.float64)
APP_COLOR_POST_BIAS = np.asarray([-0.15, -0.04, -0.19], dtype=np.float64)
APP_COLOR_MATRIX = np.asarray(
    [
        [0.024414379853462606, 1.3636302364020418, 0.2989517565735422, -0.3884425100136458, -0.35741143012885634, 0.008116662915967665, 0.3361939675898044, -0.250935778789153, -0.725448776843492, -0.3195350634886557],
        [-0.14293297157393708, 0.36715035356422454, 0.6807664576342686, 0.9935343561143009, -0.23351820697954215, 0.0965735433048458, -0.5783088220953909, -0.38132003981655993, 0.11861979929562144, -0.7978326242039837],
        [-0.07339664560521961, 0.4463074073131864, 0.38938560328908056, 3.3819092381294453, -0.30625297330072865, -0.0075926875815697705, -2.1912640541959587, -0.26423814319873595, 0.04164532971471235, -0.661780296917216],
    ],
    dtype=np.float64,
)
PWV7_REFERENCE_SOURCES = {
    "pwv7-max",
    "pwv7-rms3",
    "pwv7-mid",
    "pwv7-high",
    "pwv7-low",
}


def _ffprobe_path_from_ffmpeg(ffmpeg_path: Path) -> Path:
    suffix = ".exe" if ffmpeg_path.name.lower().endswith(".exe") else ""
    return ffmpeg_path.with_name(f"ffprobe{suffix}")


def _parse_positive_number(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    return parsed if math.isfinite(parsed) and parsed > 0 else 0.0


def _probe_ffmpeg_time_basis_offset_ms(ffmpeg_path: Path, file_path: Path) -> float:
    ffprobe_path = _ffprobe_path_from_ffmpeg(ffmpeg_path)
    if not ffprobe_path.exists():
        return 0.0
    command = [
        str(ffprobe_path),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "stream=start_time,sample_rate:stream_tags=encoder:packet_side_data=side_data_type,skip_samples",
        "-show_packets",
        "-read_intervals",
        "%+#1",
        "-select_streams",
        "a:0",
        str(file_path),
    ]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=5)
        if result.returncode != 0:
            return 0.0
        payload = json.loads(result.stdout.decode("utf-8", errors="replace") or "{}")
    except Exception:
        return 0.0
    stream = (payload.get("streams") or [{}])[0]
    packet = (payload.get("packets") or [{}])[0]
    start_time_ms = _parse_positive_number(stream.get("start_time")) * 1000.0
    sample_rate = _parse_positive_number(stream.get("sample_rate"))
    skip_samples = 0.0
    for side_data in packet.get("side_data_list") or []:
        if side_data.get("side_data_type") == "Skip Samples":
            skip_samples = _parse_positive_number(side_data.get("skip_samples"))
            break
    skip_samples_ms = (skip_samples / sample_rate) * 1000.0 if sample_rate > 0 else 0.0
    encoder = str((stream.get("tags") or {}).get("encoder") or "").strip()
    gapless_skip_ms = skip_samples_ms if skip_samples_ms > 0 and encoder.startswith("LAME") else 0.0
    return round(start_time_ms + gapless_skip_ms, 3)


def _shift_values_by_time_basis(values: np.ndarray, offset_entries: float) -> np.ndarray:
    if values.size <= 0 or abs(offset_entries) <= 1e-9:
        return values.copy()
    indexes = np.arange(values.size, dtype=np.float64)
    source_indexes = indexes - offset_entries
    return np.interp(source_indexes, indexes, values, left=0.0, right=0.0)


def _next_power_of_two(value: int) -> int:
    target = max(2, int(value))
    target -= 1
    target |= target >> 1
    target |= target >> 2
    target |= target >> 4
    target |= target >> 8
    target |= target >> 16
    return target + 1


def _raw_fft_size(span: int) -> int:
    return _next_power_of_two(max(RAW_FFT_MIN_SIZE, min(RAW_FFT_MAX_SIZE, span)))


def _compute_app_raw_mean_signal(stereo: np.ndarray, sample_rate: int, target_rate: float) -> np.ndarray:
    if stereo.size == 0 or sample_rate <= 0 or target_rate <= 0:
        return np.zeros(0, dtype=np.float64)
    total_frames = int(stereo.shape[0])
    step = float(sample_rate) / float(target_rate)
    expected_frames = int(math.floor(total_frames / step)) + 1
    signal = np.zeros(expected_frames, dtype=np.float64)
    out_index = 0
    position = 0.0
    next_store = step
    sum_left = 0.0
    sum_right = 0.0
    count = 0
    for frame in range(total_frames):
        left = float(stereo[frame, 0])
        right = float(stereo[frame, 1]) if stereo.shape[1] > 1 else left
        sum_left += left
        sum_right += right
        count += 1
        position += 1.0
        if position >= next_store:
            signal[out_index] = ((sum_left / count) + (sum_right / count)) * 0.5 if count else 0.0
            out_index += 1
            sum_left = 0.0
            sum_right = 0.0
            count = 0
            next_store += step
            if out_index >= expected_frames:
                break
    if out_index < expected_frames and count > 0:
        signal[out_index:] = ((sum_left / count) + (sum_right / count)) * 0.5
    return signal


def _raw_fft_ratios(signal: np.ndarray, sample_rate: float, start: int, end: int) -> np.ndarray:
    size = _raw_fft_size(max(1, end - start + 1))
    center = (start + end) // 2
    half = size // 2
    window = np.zeros(size, dtype=np.float64)
    for index in range(size):
        source = center - half + index
        if 0 <= source < signal.size:
            window[index] = signal[source]
    if size > 1:
        window *= np.hanning(size)

    spectrum = np.fft.rfft(window)
    magnitude = spectrum.real * spectrum.real + spectrum.imag * spectrum.imag
    nyquist = sample_rate * 0.5
    low_upper_hz = max(80.0, nyquist * RAW_FFT_LOW_RATIO)
    mid_upper_hz = max(low_upper_hz + 60.0, nyquist * RAW_FFT_MID_RATIO)
    bands = np.zeros(3, dtype=np.float64)
    for bin_index in range(1, magnitude.size):
        frequency = (bin_index * sample_rate) / size
        if frequency <= low_upper_hz:
            bands[0] += magnitude[bin_index]
        elif frequency <= mid_upper_hz:
            bands[1] += magnitude[bin_index]
        else:
            bands[2] += magnitude[bin_index]
    bands = np.sqrt(np.maximum(bands, 0.0))
    return bands / max(float(np.max(bands)), RAW_FFT_EPSILON)


def _color_features(ratios: np.ndarray) -> np.ndarray:
    low, mid, high = [float(value) for value in ratios]
    return np.asarray(
        [1.0, low, mid, high, low * low, mid * mid, high * high, low * mid, low * high, mid * high],
        dtype=np.float64,
    )


def _height_features(ratios: np.ndarray, amp: float) -> np.ndarray:
    low, mid, high = [float(value) for value in ratios]
    safe_amp = max(0.0, min(1.0, float(amp)))
    return np.asarray(
        [
            1.0,
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
        ],
        dtype=np.float64,
    )


def _app_rgb_height_amp(amp: float, ratios: np.ndarray) -> float:
    safe_amp = max(0.0, min(1.0, float(amp)))
    if safe_amp <= 0:
        return 0.0
    multiplier = float(np.exp(_height_features(ratios, safe_amp) @ APP_RGB_HEIGHT_MODEL))
    multiplier = max(APP_RGB_HEIGHT_MIN, min(APP_RGB_HEIGHT_MAX, multiplier))
    adjusted = max(0.0, min(1.0, safe_amp * multiplier))
    return max(
        0.0,
        min(1.0, safe_amp * (1.0 - APP_RGB_HEIGHT_BLEND) + adjusted * APP_RGB_HEIGHT_BLEND),
    )


def _post_shape_color(rgb: np.ndarray) -> np.ndarray:
    return np.clip(rgb * APP_COLOR_POST_SCALE + APP_COLOR_POST_BIAS, 0.0, 1.0)


def _app_rgb_from_ratios(ratios: np.ndarray) -> np.ndarray:
    return _post_shape_color(np.clip(_color_features(ratios) @ APP_COLOR_MATRIX.T, 0.0, 1.0))


def _app_column_profile_from_ratios(ratios: np.ndarray) -> dict[str, Any]:
    return {
        "base": _app_rgb_from_ratios(ratios),
    }


def _app_rgb(signal: np.ndarray, sample_rate: float, start: int, end: int) -> np.ndarray:
    return _app_rgb_from_ratios(_raw_fft_ratios(signal, sample_rate, start, end))


def _app_column_profile(signal: np.ndarray, sample_rate: float, start: int, end: int) -> dict[str, Any]:
    ratios = _raw_fft_ratios(signal, sample_rate, start, end)
    return _app_column_profile_from_ratios(ratios)


def _draw_app_column(
    image: np.ndarray,
    x: int,
    baseline: int,
    scale: int,
    bar_height: int,
    profile: dict[str, Any],
) -> None:
    top = baseline - bar_height
    rgb = tuple(int(round(value * 255.0)) for value in np.clip(profile["base"], 0.0, 1.0))
    _draw_rect(image, x, top, x + scale, baseline, rgb)


def _parse_track_ids(values: list[str] | None) -> list[int]:
    if not values:
        return []
    result: list[int] = []
    for value in values:
        for item in str(value).split(","):
            text = item.strip()
            if not text:
                continue
            try:
                track_id = int(text)
            except ValueError as exc:
                raise SystemExit(f"Invalid --track-id value: {text}") from exc
            if track_id not in result:
                result.append(track_id)
    return result


def _load_selected_rows(args: argparse.Namespace, track_ids: list[int]) -> list[tuple[dict[str, Any], np.ndarray]]:
    if not track_ids:
        return _load_all_existing_rows(args)

    rekordbox_db_cls, anlz_file_cls = _import_pyrekordbox()
    db_path = Path(args.db).expanduser()
    db = rekordbox_db_cls(path=str(db_path), db_dir=str(db_path.parent))
    try:
        loaded_by_id: dict[int, tuple[dict[str, Any], np.ndarray]] = {}
        for track_id in track_ids:
            content = db.get_content(ID=track_id)
            if content is None:
                continue
            loaded = _load_rekordbox_reference_for_content(db, content, anlz_file_cls)
            if loaded is not None:
                loaded_by_id[track_id] = loaded
        missing = [track_id for track_id in track_ids if track_id not in loaded_by_id]
        if missing:
            raise SystemExit(f"Selected tracks have no existing audio/PWV5 data: {missing}")
        return [loaded_by_id[track_id] for track_id in track_ids]
    finally:
        close = getattr(db, "close", None)
        if callable(close):
            close()


def _write_bmp(path: Path, image: np.ndarray) -> None:
    height, width, _channels = image.shape
    row_stride = (width * 3 + 3) & ~3
    padding = row_stride - width * 3
    size = 54 + row_stride * height
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(b"BM")
        handle.write(struct.pack("<IHHI", size, 0, 0, 54))
        handle.write(
            struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, row_stride * height, 2835, 2835, 0, 0)
        )
        for y in range(height - 1, -1, -1):
            handle.write(image[y, :, ::-1].astype(np.uint8).tobytes())
            handle.write(b"\0" * padding)


def _draw_rect(image: np.ndarray, x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
    height, width, _channels = image.shape
    left = max(0, min(width, x0))
    right = max(0, min(width, x1))
    top = max(0, min(height, y0))
    bottom = max(0, min(height, y1))
    if right > left and bottom > top:
        image[top:bottom, left:right] = color


def _draw_blend_rect(image: np.ndarray, x0: int, y0: int, x1: int, y1: int, color: np.ndarray, alpha: float) -> None:
    height, width, _channels = image.shape
    left = max(0, min(width, x0))
    right = max(0, min(width, x1))
    top = max(0, min(height, y0))
    bottom = max(0, min(height, y1))
    if right <= left or bottom <= top:
        return
    base = image[top:bottom, left:right].astype(np.float64) / 255.0
    blended = np.clip(color * alpha + base * (1.0 - alpha), 0.0, 1.0)
    image[top:bottom, left:right] = np.rint(blended * 255.0).astype(np.uint8)


def _first_nonzero(values: np.ndarray, threshold: float = 0.02) -> int:
    indexes = np.flatnonzero(values > threshold)
    return int(indexes[0]) if indexes.size else 0


def _height_metrics_values(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    length = min(reference.size, candidate.size)
    if length <= 0:
        return {"heightMae": 1.0, "heightActiveMae": 1.0, "heightCorr": 0.0}
    ref = reference[:length]
    cand = candidate[:length]
    diff = cand - ref
    active = ref > 0.02
    if float(np.std(ref)) > 0 and float(np.std(cand)) > 0:
        corr = float(np.corrcoef(ref, cand)[0, 1])
    else:
        corr = 0.0
    return {
        "heightMae": float(np.mean(np.abs(diff))),
        "heightActiveMae": float(np.mean(np.abs(diff[active]))) if np.any(active) else float(np.mean(np.abs(diff))),
        "heightCorr": corr,
    }


def _height_metrics(reference: np.ndarray, candidate: np.ndarray, start: int, end: int) -> dict[str, float]:
    safe_start = max(0, start)
    safe_end = max(safe_start, min(reference.size, candidate.size, end))
    return _height_metrics_values(reference[safe_start:safe_end], candidate[safe_start:safe_end])


def _best_shifted_height_metrics(
    reference: np.ndarray,
    candidate: np.ndarray,
    start: int,
    end: int,
    radius: int,
) -> dict[str, float | int]:
    safe_radius = max(0, int(radius))
    baseline = _height_metrics(reference, candidate, start, end)
    best_shift = 0
    best_metrics = baseline
    for shift in range(-safe_radius, safe_radius + 1):
        index_start = max(start, 0, -shift)
        index_end = min(end, reference.size, candidate.size - shift)
        if index_end <= index_start:
            continue
        metrics = _height_metrics_values(
            reference[index_start:index_end],
            candidate[index_start + shift : index_end + shift],
        )
        best_key = (best_metrics["heightActiveMae"], best_metrics["heightMae"], -best_metrics["heightCorr"])
        candidate_key = (metrics["heightActiveMae"], metrics["heightMae"], -metrics["heightCorr"])
        if candidate_key < best_key:
            best_shift = shift
            best_metrics = metrics
    return {
        "bestShiftEntries": int(best_shift),
        "bestShiftHeightMae": float(best_metrics["heightMae"]),
        "bestShiftHeightActiveMae": float(best_metrics["heightActiveMae"]),
        "bestShiftHeightCorr": float(best_metrics["heightCorr"]),
        "shiftActiveMaeImprovement": float(
            baseline["heightActiveMae"] - best_metrics["heightActiveMae"]
        ),
    }


def _load_pwv5_color_rows(args: argparse.Namespace, track_ids: set[int] | None = None) -> dict[int, np.ndarray]:
    rekordbox_db_cls, anlz_file_cls = _import_pyrekordbox()
    db_path = Path(args.db).expanduser()
    db = rekordbox_db_cls(path=str(db_path), db_dir=str(db_path.parent))
    try:
        result: dict[int, np.ndarray] = {}
        if track_ids is None:
            contents = db.get_content().all()
        else:
            contents = [db.get_content(ID=track_id) for track_id in sorted(track_ids)]
        for content in contents:
            if content is None:
                continue
            track_id = int(getattr(content, "ID", 0) or 0)
            analyze_paths = _resolve_analyze_paths(db, content)
            ext_path = analyze_paths.get("ext")
            if not ext_path or not Path(ext_path).exists():
                continue
            ext = anlz_file_cls.parse_file(ext_path)
            if "PWV5" not in ext:
                continue
            result[track_id] = np.asarray(_decode_pwv5(ext.get_tag("PWV5"))["colors3BitRgb"], dtype=np.float64) / 7.0
        return result
    finally:
        close = getattr(db, "close", None)
        if callable(close):
            close()


def _load_pwv7_rows(args: argparse.Namespace, track_ids: set[int] | None = None) -> dict[int, np.ndarray]:
    rekordbox_db_cls, anlz_file_cls = _import_pyrekordbox()
    db_path = Path(args.db).expanduser()
    db = rekordbox_db_cls(path=str(db_path), db_dir=str(db_path.parent))
    try:
        result: dict[int, np.ndarray] = {}
        if track_ids is None:
            contents = db.get_content().all()
        else:
            contents = [db.get_content(ID=track_id) for track_id in sorted(track_ids)]
        for content in contents:
            if content is None:
                continue
            track_id = int(getattr(content, "ID", 0) or 0)
            analyze_paths = _resolve_analyze_paths(db, content)
            two_ex_path = analyze_paths.get("2ex")
            if not two_ex_path or not Path(two_ex_path).exists():
                continue
            two_ex = anlz_file_cls.parse_file(two_ex_path)
            if "PWV7" not in two_ex:
                continue
            result[track_id] = np.asarray(_decode_pwv7(two_ex.get_tag("PWV7"))["triples"], dtype=np.float64)
        return result
    finally:
        close = getattr(db, "close", None)
        if callable(close):
            close()


def _resolve_pwv7_reference_values(pwv7_rows: np.ndarray, source: str) -> np.ndarray:
    if pwv7_rows.size == 0:
        return np.zeros(0, dtype=np.float64)
    bands = np.clip(pwv7_rows / 255.0, 0.0, 1.0)
    mid = bands[:, 0]
    high = bands[:, 1]
    low = bands[:, 2]
    if source == "pwv7-rms3":
        return np.sqrt((mid * mid + high * high + low * low) / 3.0)
    if source == "pwv7-mid":
        return mid
    if source == "pwv7-high":
        return high
    if source == "pwv7-low":
        return low
    return np.max(bands, axis=1)


def _resolve_pwv7_reference_colors(pwv7_rows: np.ndarray) -> np.ndarray:
    if pwv7_rows.size == 0:
        return np.zeros((0, 3), dtype=np.float64)
    bands = np.clip(pwv7_rows / 255.0, 0.0, 1.0)
    mid = bands[:, 0:1]
    high = bands[:, 1:2]
    low = bands[:, 2:3]
    weighted = low * LOW_LAYER_COLOR + mid * MID_LAYER_COLOR + high * HIGH_LAYER_COLOR
    peak = np.maximum(np.max(weighted, axis=1, keepdims=True), RAW_FFT_EPSILON)
    active = np.maximum(np.max(bands, axis=1, keepdims=True), RAW_FFT_EPSILON)
    return np.clip((weighted / peak) * active, 0.0, 1.0)


def _resolve_pwv7_reference_bands(pwv7_rows: np.ndarray) -> np.ndarray:
    if pwv7_rows.size == 0:
        return np.zeros((0, 3), dtype=np.float64)
    bands = np.clip(pwv7_rows / 255.0, 0.0, 1.0)
    return np.column_stack([bands[:, 2], bands[:, 0], bands[:, 1]])


def _draw_pwv7_reference_column(
    image: np.ndarray,
    x: int,
    baseline: int,
    scale: int,
    max_height: int,
    bands: np.ndarray,
) -> None:
    low, mid, high = (float(bands[0]), float(bands[1]), float(bands[2]))
    for value, color, alpha in (
        (low, LOW_LAYER_COLOR, LOW_LAYER_ALPHA_BASE),
        (mid, MID_LAYER_COLOR, MID_LAYER_ALPHA_BASE),
        (high, HIGH_LAYER_COLOR, HIGH_LAYER_ALPHA_BASE),
    ):
        if value <= 0:
            continue
        layer_height = max(1, int(round(value * max_height)))
        _draw_blend_rect(image, x, baseline - layer_height, x + scale, baseline, color, alpha)


def _load_selection_rows(path_value: str | None, limit: int | None = None) -> list[dict[str, Any]]:
    if not path_value:
        return []
    path = Path(path_value).expanduser()
    payload = json.loads(path.read_text(encoding="utf-8"))
    source_rows = payload.get("top") if isinstance(payload, dict) else payload
    if not isinstance(source_rows, list):
        raise SystemExit(f"Invalid selection JSON: {path}")
    rows = [row for row in source_rows if isinstance(row, dict)]
    if limit is not None and limit > 0:
        rows = rows[:limit]
    return rows


def _selection_track_ids(selection_rows: list[dict[str, Any]]) -> list[int]:
    result: list[int] = []
    for row in selection_rows:
        track = row.get("track") if isinstance(row.get("track"), dict) else {}
        track_id = int(track.get("trackId") or row.get("trackId") or 0)
        if track_id and track_id not in result:
            result.append(track_id)
    return result


def _render_contact_sheet(args: argparse.Namespace) -> dict[str, Any]:
    selection_json = getattr(args, "selection_json", None)
    selection_limit = int(getattr(args, "selection_limit", 0) or 0)
    selection_rows = _load_selection_rows(selection_json, selection_limit)
    selection_starts = {
        track_id: max(0, int(row.get("startIndex") or 0))
        for row in selection_rows
        for track_id in _selection_track_ids([row])
    }
    selected_track_ids = _parse_track_ids(args.track_id)
    if not selected_track_ids and selection_rows:
        selected_track_ids = _selection_track_ids(selection_rows)
    if selected_track_ids:
        loaded_rows = _load_selected_rows(args, selected_track_ids)
    elif args.sampler_loops:
        loaded_rows = _load_sampler_loop_rows(args)
    else:
        loaded_rows = _load_all_existing_rows(args)
    if args.sampler_loops and selected_track_ids:
        loaded_rows = [(metadata, reference) for metadata, reference in loaded_rows if _is_sampler_loop(metadata)]
    if not loaded_rows:
        raise SystemExit("No Rekordbox tracks with existing audio and PWV5 data were found")

    color_track_ids = {int(metadata["track"].get("trackId") or 0) for metadata, _reference in loaded_rows}
    colors_by_id = _load_pwv5_color_rows(args, color_track_ids)
    pwv7_by_id = _load_pwv7_rows(args, color_track_ids) if args.reference_source in PWV7_REFERENCE_SOURCES else {}
    row_height = 46
    track_gap = 12
    left_pad = 18
    width = left_pad + args.entries * args.scale + 18
    height = len(loaded_rows) * (row_height * 2 + track_gap) + 8
    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[:] = (15, 17, 20)
    summary = []
    y = 8
    for metadata, reference in loaded_rows:
        track = metadata["track"]
        track_id = int(track.get("trackId") or 0)
        reference_colors = colors_by_id.get(track_id)
        reference_values = reference
        reference_bands: np.ndarray | None = None
        if args.reference_source in PWV7_REFERENCE_SOURCES:
            pwv7_rows = pwv7_by_id.get(track_id)
            if pwv7_rows is None:
                continue
            reference_values = _resolve_pwv7_reference_values(pwv7_rows, args.reference_source)
            reference_colors = _resolve_pwv7_reference_colors(pwv7_rows)
            reference_bands = _resolve_pwv7_reference_bands(pwv7_rows)
        if reference_colors is None:
            continue
        audio_path = Path(str(track.get("filePath") or ""))
        time_basis_offset_ms = (
            _probe_ffmpeg_time_basis_offset_ms(Path(args.ffmpeg), audio_path)
            if args.time_basis_mode == "ffmpeg"
            else 0.0
        )
        stereo = _decode_audio_stereo(Path(args.ffmpeg), audio_path, args.sample_rate)
        energy = _compute_app_raw_energy_series(stereo, args.sample_rate, args.raw_rate)
        candidate = _render_app_energy_candidate(
            energy,
            args.raw_rate,
            int(reference_values.size),
            stereo.shape[0] / args.sample_rate if args.sample_rate > 0 else 0,
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
        duration_sec = stereo.shape[0] / args.sample_rate if args.sample_rate > 0 else 0
        time_basis_offset_entries = (
            (time_basis_offset_ms / 1000.0) * (reference_values.size / duration_sec)
            if duration_sec > 0
            else 0.0
        )
        candidate = _shift_values_by_time_basis(candidate, time_basis_offset_entries)
        stereo = _decode_audio_stereo(Path(args.ffmpeg), audio_path, int(args.sample_rate))
        mono = _compute_app_raw_mean_signal(stereo, int(args.sample_rate), float(args.raw_rate))
        default_start = max(0, _first_nonzero(reference_values) - 18)
        start = selection_starts.get(track_id, default_start)
        start = max(0, min(reference_values.size - args.entries, start))
        end = min(reference_values.size, start + args.entries)
        adjusted_candidate = candidate.copy()
        profiles: dict[int, dict[str, Any]] = {}
        for entry in range(start, end):
            audio_entry = entry - time_basis_offset_entries
            if audio_entry < 0 or audio_entry >= reference_values.size:
                adjusted_candidate[entry] = 0.0
                continue
            pcm_start = int(round((audio_entry / reference_values.size) * mono.size))
            pcm_end = max(
                pcm_start,
                int(round(((audio_entry + 1) / reference_values.size) * mono.size)) - 1,
            )
            ratios = _raw_fft_ratios(mono, float(args.raw_rate), pcm_start, pcm_end)
            profiles[entry] = _app_column_profile_from_ratios(ratios)
            if entry < adjusted_candidate.size:
                adjusted_candidate[entry] = _app_rgb_height_amp(float(candidate[entry]), ratios)
        color_errors = []
        for lane_index, values in enumerate((reference_values, adjusted_candidate)):
            baseline = y + lane_index * row_height + row_height - 6
            _draw_rect(image, left_pad, baseline, width - 18, baseline + 1, (45, 49, 56))
            for entry in range(start, end):
                x = left_pad + (entry - start) * args.scale
                amp = float(values[entry]) if entry < values.size else 0.0
                if amp <= 0:
                    continue
                bar_height = max(1, int(round(amp * (row_height - 10))))
                if lane_index == 0:
                    if reference_bands is not None:
                        _draw_pwv7_reference_column(
                            image,
                            x,
                            baseline,
                            args.scale,
                            row_height - 10,
                            reference_bands[entry],
                        )
                    else:
                        rgb = tuple(int(round(value * 255)) for value in reference_colors[entry])
                        _draw_rect(image, x, baseline - bar_height, x + args.scale, baseline, rgb)
                else:
                    audio_entry = entry - time_basis_offset_entries
                    if audio_entry < 0 or audio_entry >= reference_values.size:
                        continue
                    pcm_start = int(round((audio_entry / reference_values.size) * mono.size))
                    pcm_end = max(
                        pcm_start,
                        int(round(((audio_entry + 1) / reference_values.size) * mono.size)) - 1,
                    )
                    app_rgb = _app_rgb(mono, float(args.raw_rate), pcm_start, pcm_end)
                    target_rgb = reference_colors[entry]
                    color_errors.append(float(np.mean(np.abs(app_rgb - target_rgb))))
                    profile = profiles.get(entry) or _app_column_profile(mono, float(args.raw_rate), pcm_start, pcm_end)
                    _draw_app_column(image, x, baseline, args.scale, bar_height, profile)
        height_metrics = _height_metrics(reference_values, adjusted_candidate, start, end)
        shifted_height_metrics = _best_shifted_height_metrics(
            reference_values,
            adjusted_candidate,
            start,
            end,
            int(args.shift_radius),
        )
        summary.append(
            {
                "track": track,
                "startIndex": int(start),
                "entryCount": int(end - start),
                "timeBasisOffsetMs": float(time_basis_offset_ms),
                "timeBasisOffsetEntries": float(time_basis_offset_entries),
                **height_metrics,
                **shifted_height_metrics,
                "activeColorMae": float(np.mean(color_errors)) if color_errors else 0.0,
            }
        )
        y += row_height * 2 + track_gap

    output_path = Path(args.output).expanduser()
    _write_bmp(output_path, image)
    json_path = output_path.with_suffix(".json")
    payload = {
        "type": "rekordbox-frkb-waveform-contact-sheet",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "image": str(output_path),
        "lanes": "each track: Rekordbox reference heights, then FRKB current candidate",
        "referenceSource": args.reference_source,
        "timeBasisMode": args.time_basis_mode,
        "selectionJson": str(Path(selection_json).expanduser()) if selection_json else None,
        "summary": summary,
        "avgHeightMae": float(np.mean([row["heightMae"] for row in summary])) if summary else 0.0,
        "avgHeightActiveMae": float(np.mean([row["heightActiveMae"] for row in summary])) if summary else 0.0,
        "avgHeightCorr": float(np.mean([row["heightCorr"] for row in summary])) if summary else 0.0,
        "avgBestShiftHeightActiveMae": float(np.mean([row["bestShiftHeightActiveMae"] for row in summary]))
        if summary
        else 0.0,
        "avgShiftActiveMaeImprovement": float(np.mean([row["shiftActiveMaeImprovement"] for row in summary]))
        if summary
        else 0.0,
        "bestShiftDistribution": {
            str(shift): sum(1 for row in summary if int(row["bestShiftEntries"]) == shift)
            for shift in range(-int(args.shift_radius), int(args.shift_radius) + 1)
        },
        "avgActiveColorMae": float(np.mean([row["activeColorMae"] for row in summary])) if summary else 0.0,
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a Rekordbox vs FRKB waveform contact sheet.")
    parser.add_argument("--db", default=str(DEFAULT_REKORDBOX_DB), help="Path to rekordbox master.db")
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG), help="Path to ffmpeg")
    parser.add_argument("--raw-rate", type=float, default=DEFAULT_APP_RAW_RATE)
    parser.add_argument("--sample-rate", type=int, default=44100)
    parser.add_argument("--entries", type=int, default=260)
    parser.add_argument("--scale", type=int, default=3)
    parser.add_argument("--sampler-loops", action="store_true", help="Limit to simple Rekordbox sampler loop files")
    parser.add_argument(
        "--track-id",
        action="append",
        help="Render selected Rekordbox track IDs; can be repeated or comma-separated",
    )
    parser.add_argument(
        "--selection-json",
        help="JSON file with top[] rows containing track.trackId and startIndex window selections",
    )
    parser.add_argument("--selection-limit", type=int, default=0, help="Limit rows read from --selection-json")
    parser.add_argument(
        "--shift-radius",
        type=int,
        default=3,
        help="Measure best candidate height alignment within +/- this many entries",
    )
    parser.add_argument(
        "--time-basis-mode",
        choices=("none", "ffmpeg"),
        default="none",
        help="Shift the app candidate using the same ffmpeg-derived time basis style as the product",
    )
    parser.add_argument(
        "--reference-source",
        choices=("pwv5", "pwv7-max", "pwv7-rms3", "pwv7-mid", "pwv7-high", "pwv7-low"),
        default="pwv5",
        help="Rekordbox waveform source used for the reference lane",
    )
    parser.add_argument(
        "--output",
        default=str(Path("out") / "research" / "rekordbox-frkb-waveform-contact.bmp"),
        help="Output BMP path",
    )
    args = parser.parse_args()
    payload = _render_contact_sheet(args)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
