import argparse
import importlib.util
import json
import math
import statistics
import subprocess
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TRUTH = REPO_ROOT / "resources" / "rkbRekordboxGridSnapshot.json"
DEFAULT_AUDIO_ROOT = Path("D:/FRKB_database-B/library/FilterLibrary/rkb")
DEFAULT_FFMPEG = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe"
DEFAULT_FFPROBE = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffprobe.exe"
DEFAULT_OUTPUT = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark" / "latest.json"
BEAT_THIS_BRIDGE = REPO_ROOT / "scripts" / "beat_this_bridge.py"

SAMPLE_RATE = 44100
CHANNELS = 2
WINDOW_SEC = 30.0
MAX_SCAN_SEC = 120.0
DRIFT_BEAT_HORIZONS = (32, 64, 128)
STRICT_TOLERANCE_MS = 2.0


def _load_bridge_module() -> Any:
    spec = importlib.util.spec_from_file_location("beat_this_bridge", BEAT_THIS_BRIDGE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load bridge module: {BEAT_THIS_BRIDGE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _normalize_lookup_key(value: Any) -> str:
    return str(value or "").strip().lower()


def _phase_delta_ms(candidate_ms: float, reference_ms: float, interval_ms: float) -> float:
    if not math.isfinite(interval_ms) or interval_ms <= 0.0:
        return candidate_ms - reference_ms
    return ((candidate_ms - reference_ms + interval_ms * 0.5) % interval_ms) - interval_ms * 0.5


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = int(math.ceil((percentile / 100.0) * len(ordered))) - 1
    return ordered[min(max(index, 0), len(ordered) - 1)]


def _status_from_error(value: float, tolerance_ms: float = STRICT_TOLERANCE_MS) -> str:
    absolute = abs(float(value))
    return "pass" if absolute <= tolerance_ms else "fail"


def _normalize_bar_offset(value: Any, modulo: int) -> int:
    numeric = _to_float(value)
    if numeric is None:
        return 0
    rounded = int(round(numeric))
    return ((rounded % modulo) + modulo) % modulo


def _resolve_first_beat_label_from_offset(bar_beat_offset: int) -> int:
    normalized = int(bar_beat_offset) % 4
    return ((5 - normalized - 1) % 4) + 1


def _decode_pcm_window(ffmpeg_path: Path, file_path: Path, duration_sec: float) -> bytes:
    cmd = [
        str(ffmpeg_path),
        "-v",
        "error",
        "-ss",
        "0",
        "-t",
        str(duration_sec),
        "-i",
        str(file_path),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ac",
        str(CHANNELS),
        "-ar",
        str(SAMPLE_RATE),
        "pipe:1",
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return result.stdout


def _resolve_first_packet_skip_samples(packet: dict[str, Any] | None) -> float:
    side_data_list = packet.get("side_data_list") if isinstance(packet, dict) else None
    if not isinstance(side_data_list, list):
        return 0.0
    for side_data in side_data_list:
        if not isinstance(side_data, dict):
            continue
        if str(side_data.get("side_data_type") or "") != "Skip Samples":
            continue
        return max(0.0, _to_float(side_data.get("skip_samples")) or 0.0)
    return 0.0


def _probe_time_basis(ffprobe_path: Path, file_path: Path) -> dict[str, Any]:
    cmd = [
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
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, text=True)
    payload = json.loads(result.stdout or "{}")
    streams = payload.get("streams") if isinstance(payload, dict) else None
    packets = payload.get("packets") if isinstance(payload, dict) else None
    stream = streams[0] if isinstance(streams, list) and streams else {}
    packet = packets[0] if isinstance(packets, list) and packets else {}
    tags = stream.get("tags") if isinstance(stream, dict) else None
    encoder = str(tags.get("encoder") or "").strip() if isinstance(tags, dict) else ""
    start_time_sec = max(0.0, _to_float(stream.get("start_time")) or 0.0)
    sample_rate = max(0.0, _to_float(stream.get("sample_rate")) or 0.0)
    skip_samples = _resolve_first_packet_skip_samples(packet)
    skip_samples_ms = (skip_samples / sample_rate) * 1000.0 if sample_rate > 0.0 else 0.0
    gapless_skip_offset_ms = skip_samples_ms if skip_samples_ms > 0.0 and encoder.startswith("LAME") else 0.0
    start_time_ms = start_time_sec * 1000.0
    return {
        "offsetMs": round(start_time_ms + gapless_skip_offset_ms, 3),
        "streamStartTimeMs": round(start_time_ms, 3),
        "sampleRate": int(sample_rate) if sample_rate > 0.0 else None,
        "encoder": encoder,
        "skipSamples": int(skip_samples) if skip_samples > 0.0 else 0,
        "skipSamplesMs": round(skip_samples_ms, 3),
        "appliedGaplessSkipMs": round(gapless_skip_offset_ms, 3),
    }


def _load_truth_tracks(truth_path: Path, audio_root: Path, ffprobe_path: Path) -> list[dict[str, Any]]:
    payload = json.loads(truth_path.read_text(encoding="utf-8"))
    tracks = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(tracks, list) or not tracks:
        raise RuntimeError(f"truth contains no tracks: {truth_path}")

    resolved: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for item in tracks:
        if not isinstance(item, dict):
            continue
        file_name = str(item.get("fileName") or "").strip()
        lookup_key = _normalize_lookup_key(file_name)
        if not file_name or lookup_key in seen_keys:
            continue
        seen_keys.add(lookup_key)

        bpm = _to_float(item.get("bpm"))
        first_beat_ms = _to_float(item.get("firstBeatMs"))
        if bpm is None or bpm <= 0.0 or first_beat_ms is None or first_beat_ms < 0.0:
            continue

        file_path = audio_root / file_name
        bar_beat_offset = _normalize_bar_offset(item.get("barBeatOffset"), 32)
        first_beat_label = int(item.get("firstBeatLabel") or _resolve_first_beat_label_from_offset(bar_beat_offset))
        resolved.append(
            {
                "fileName": file_name,
                "filePath": str(file_path),
                "title": str(item.get("title") or "").strip(),
                "artist": str(item.get("artist") or "").strip(),
                "bpm": round(float(bpm), 6),
                "firstBeatMs": round(float(first_beat_ms), 3),
                "firstBeatLabel": first_beat_label,
                "barBeatOffset": bar_beat_offset,
                "fileExists": file_path.exists(),
                "timeBasis": _probe_time_basis(ffprobe_path, file_path) if file_path.exists() else None,
            }
        )
    return resolved


def _matches_only_filters(track: dict[str, Any], filters: list[str]) -> bool:
    if not filters:
        return True
    haystack = " ".join(
        [
            str(track.get("fileName") or ""),
            str(track.get("title") or ""),
            str(track.get("artist") or ""),
        ]
    ).lower()
    return any(item in haystack for item in filters)


def _derive_grid_metrics(
    *,
    result_bpm: float,
    result_first_beat_timeline_ms: float,
    result_bar_beat_offset: int,
    truth: dict[str, Any],
    compare_count: int,
) -> dict[str, Any]:
    truth_bpm = float(truth["bpm"])
    truth_interval_ms = 60000.0 / truth_bpm if truth_bpm > 0.0 else 0.0
    result_interval_ms = 60000.0 / result_bpm if result_bpm > 0.0 else 0.0
    interval_error_ms = result_interval_ms - truth_interval_ms
    raw_first_beat_delta_ms = result_first_beat_timeline_ms - float(truth["firstBeatMs"])
    phase_error_ms = _phase_delta_ms(
        result_first_beat_timeline_ms,
        float(truth["firstBeatMs"]),
        truth_interval_ms,
    )
    signed_errors = [phase_error_ms + index * interval_error_ms for index in range(compare_count)]
    abs_errors = [abs(value) for value in signed_errors]
    rmse_ms = math.sqrt(sum(value * value for value in signed_errors) / max(1, len(signed_errors)))
    bpm_error = result_bpm - truth_bpm
    bpm_only_drift = {
        f"bpmOnlyDrift{horizon}BeatsMs": round(interval_error_ms * horizon, 3)
        for horizon in DRIFT_BEAT_HORIZONS
    }
    grid_drift = {
        f"gridDrift{horizon}BeatsMs": round(
            signed_errors[min(max(horizon - 1, 0), len(signed_errors) - 1)],
            3,
        )
        for horizon in DRIFT_BEAT_HORIZONS
    }
    truth_bar_mod4 = _normalize_bar_offset(truth.get("barBeatOffset"), 4)
    result_bar_mod4 = _normalize_bar_offset(result_bar_beat_offset, 4)
    truth_bar_exact32 = _normalize_bar_offset(truth.get("barBeatOffset"), 32)
    result_bar_exact32 = _normalize_bar_offset(result_bar_beat_offset, 32)
    first_beat_shift = 0
    if truth_interval_ms > 0.0:
        first_beat_shift = int(round((raw_first_beat_delta_ms - phase_error_ms) / truth_interval_ms))
    adjusted_result_bar_mod4 = _normalize_bar_offset(result_bar_beat_offset + first_beat_shift, 4)
    adjusted_result_bar_exact32 = _normalize_bar_offset(
        result_bar_beat_offset + first_beat_shift,
        32,
    )
    return {
        "bpmError": round(bpm_error, 6),
        "bpmAbsError": round(abs(bpm_error), 6),
        "beatIntervalErrorMs": round(interval_error_ms, 6),
        "firstBeatShiftBeats": first_beat_shift,
        "firstBeatPhaseErrorMs": round(phase_error_ms, 3),
        "firstBeatPhaseAbsErrorMs": round(abs(phase_error_ms), 3),
        "gridCompareCount": compare_count,
        "gridMeanAbsMs": round(statistics.fmean(abs_errors), 3) if abs_errors else 0.0,
        "gridP95AbsMs": round(_percentile(abs_errors, 95.0), 3),
        "gridMaxAbsMs": round(max(abs_errors, default=0.0), 3),
        "gridRmseMs": round(rmse_ms, 3),
        "barBeatOffsetMatchedMod4": adjusted_result_bar_mod4 == truth_bar_mod4,
        "barBeatOffsetMatchedExact32": adjusted_result_bar_exact32 == truth_bar_exact32,
        "rawBarBeatOffsetMatchedMod4": result_bar_mod4 == truth_bar_mod4,
        "rawBarBeatOffsetMatchedExact32": result_bar_exact32 == truth_bar_exact32,
        "adjustedBarBeatOffsetMod4": adjusted_result_bar_mod4,
        "adjustedBarBeatOffsetExact32": adjusted_result_bar_exact32,
        **bpm_only_drift,
        **grid_drift,
    }


def _is_half_or_double_bpm(result_bpm: float, truth_bpm: float) -> bool:
    if result_bpm <= 0.0 or truth_bpm <= 0.0:
        return False
    return abs(result_bpm * 2.0 - truth_bpm) <= 0.08 or abs(result_bpm / 2.0 - truth_bpm) <= 0.08


def _classify(metrics: dict[str, Any], result_bpm: float, truth_bpm: float) -> dict[str, str]:
    bpm_drift_status = _status_from_error(float(metrics["bpmOnlyDrift128BeatsMs"]))
    phase_status = _status_from_error(float(metrics["firstBeatPhaseAbsErrorMs"]))
    grid_max_status = _status_from_error(float(metrics["gridMaxAbsMs"]))
    bar_status = "pass" if metrics["barBeatOffsetMatchedMod4"] else "fail"

    if _is_half_or_double_bpm(result_bpm, truth_bpm):
        category = "half-or-double-bpm"
    elif bpm_drift_status == "fail":
        category = "bpm"
    elif phase_status == "fail":
        category = "first-beat-phase"
    elif grid_max_status == "fail":
        category = "grid-drift"
    elif bar_status == "fail":
        category = "downbeat"
    else:
        category = "pass"

    return {
        "category": category,
        "bpmDriftStatus": bpm_drift_status,
        "firstBeatPhaseStatus": phase_status,
        "gridMaxStatus": grid_max_status,
        "barBeatOffsetStatus": bar_status,
    }


def _normalize_bridge_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "bpm": round(_to_float(result.get("bpm")) or 0.0, 6),
        "rawBpm": round(_to_float(result.get("rawBpm")) or 0.0, 6),
        "firstBeatMs": round(_to_float(result.get("firstBeatMs")) or 0.0, 3),
        "rawFirstBeatMs": round(_to_float(result.get("rawFirstBeatMs")) or 0.0, 3),
        "absoluteFirstBeatMs": round(_to_float(result.get("absoluteFirstBeatMs")) or 0.0, 3),
        "absoluteRawFirstBeatMs": round(_to_float(result.get("absoluteRawFirstBeatMs")) or 0.0, 3),
        "barBeatOffset": _normalize_bar_offset(result.get("barBeatOffset"), 32),
        "beatCount": int(result.get("beatCount") or 0),
        "downbeatCount": int(result.get("downbeatCount") or 0),
        "durationSec": round(_to_float(result.get("durationSec")) or 0.0, 3),
        "beatIntervalSec": round(_to_float(result.get("beatIntervalSec")) or 0.0, 6),
        "qualityScore": round(_to_float(result.get("qualityScore")) or 0.0, 6),
        "anchorCorrectionMs": round(_to_float(result.get("anchorCorrectionMs")) or 0.0, 3),
        "anchorConfidenceScore": round(_to_float(result.get("anchorConfidenceScore")) or 0.0, 6),
        "anchorMatchedBeatCount": int(result.get("anchorMatchedBeatCount") or 0),
        "anchorStrategy": str(result.get("anchorStrategy") or "").strip() or None,
        "windowIndex": int(result.get("windowIndex") or 0),
        "windowStartSec": round(_to_float(result.get("windowStartSec")) or 0.0, 3),
        "windowDurationSec": round(_to_float(result.get("windowDurationSec")) or 0.0, 3),
        "beatThisEstimatedDrift128Ms": round(
            _to_float(result.get("beatThisEstimatedDrift128Ms")) or 0.0,
            3,
        ),
        "beatThisWindowCount": int(result.get("beatThisWindowCount") or 0),
    }


def _analyze_track(
    *,
    bridge: Any,
    predictor: Any,
    cpu_spect: Any,
    ffmpeg_path: Path,
    device: str,
    truth: dict[str, Any],
) -> dict[str, Any]:
    file_path = Path(str(truth["filePath"]))
    pcm_data = _decode_pcm_window(ffmpeg_path, file_path, MAX_SCAN_SEC)
    signal = bridge._decode_signal(pcm_data, CHANNELS)
    duration_sec = signal.shape[0] / SAMPLE_RATE if SAMPLE_RATE > 0 else 0.0
    tuning = bridge._resolve_anchor_tuning()
    prepared_windows = bridge._prepare_analysis_windows(
        predictor,
        cpu_spect,
        signal,
        SAMPLE_RATE,
        device,
        WINDOW_SEC,
        MAX_SCAN_SEC,
    )
    result = bridge._analyze_prepared_windows_to_track_result(
        prepared_windows,
        signal,
        SAMPLE_RATE,
        min(duration_sec, MAX_SCAN_SEC),
        tuning,
        str(file_path),
        force_legacy_anchor=False,
        use_global_solver=True,
        predictor=predictor,
        cpu_spect=cpu_spect,
        device=device,
    )
    return _normalize_bridge_result(result)


def _build_track_report(analysis: dict[str, Any], truth: dict[str, Any]) -> dict[str, Any]:
    offset_ms = float((truth.get("timeBasis") or {}).get("offsetMs") or 0.0)
    compare_count = 128
    current_timeline_first_beat_ms = float(analysis["firstBeatMs"]) + offset_ms
    absolute_timeline_first_beat_ms = float(analysis["absoluteFirstBeatMs"]) + offset_ms
    raw_timeline_first_beat_ms = float(analysis["rawFirstBeatMs"]) + offset_ms

    current_metrics = _derive_grid_metrics(
        result_bpm=float(analysis["bpm"]),
        result_first_beat_timeline_ms=current_timeline_first_beat_ms,
        result_bar_beat_offset=int(analysis["barBeatOffset"]),
        truth=truth,
        compare_count=compare_count,
    )
    absolute_metrics = _derive_grid_metrics(
        result_bpm=float(analysis["bpm"]),
        result_first_beat_timeline_ms=absolute_timeline_first_beat_ms,
        result_bar_beat_offset=int(analysis["barBeatOffset"]),
        truth=truth,
        compare_count=compare_count,
    )
    raw_metrics = _derive_grid_metrics(
        result_bpm=float(analysis["bpm"]),
        result_first_beat_timeline_ms=raw_timeline_first_beat_ms,
        result_bar_beat_offset=int(analysis["barBeatOffset"]),
        truth=truth,
        compare_count=compare_count,
    )
    classification = _classify(current_metrics, float(analysis["bpm"]), float(truth["bpm"]))

    return {
        "fileName": truth["fileName"],
        "title": truth.get("title"),
        "artist": truth.get("artist"),
        "filePath": truth["filePath"],
        "truth": {
            "bpm": truth["bpm"],
            "firstBeatMs": truth["firstBeatMs"],
            "firstBeatLabel": truth["firstBeatLabel"],
            "barBeatOffset": truth["barBeatOffset"],
            "timeBasis": truth.get("timeBasis"),
        },
        "analysis": analysis,
        "currentTimeline": {
            "coordinate": "analysis.firstBeatMs + timeBasisOffsetMs",
            "firstBeatMs": round(current_timeline_first_beat_ms, 3),
            **current_metrics,
            **classification,
        },
        "absoluteTimelineCandidate": {
            "coordinate": "analysis.absoluteFirstBeatMs + timeBasisOffsetMs",
            "firstBeatMs": round(absolute_timeline_first_beat_ms, 3),
            **absolute_metrics,
            **_classify(absolute_metrics, float(analysis["bpm"]), float(truth["bpm"])),
        },
        "rawTimelineCandidate": {
            "coordinate": "analysis.rawFirstBeatMs + timeBasisOffsetMs",
            "firstBeatMs": round(raw_timeline_first_beat_ms, 3),
            **raw_metrics,
        },
    }


def _summarize_metric(rows: list[dict[str, Any]], metric_path: tuple[str, ...]) -> dict[str, float]:
    values: list[float] = []
    for row in rows:
        value: Any = row
        for key in metric_path:
            value = value.get(key) if isinstance(value, dict) else None
        numeric = _to_float(value)
        if numeric is not None:
            values.append(abs(numeric))
    if not values:
        return {"mean": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0}
    return {
        "mean": round(statistics.fmean(values), 3),
        "median": round(statistics.median(values), 3),
        "p95": round(_percentile(values, 95.0), 3),
        "max": round(max(values), 3),
    }


def _build_summary(rows: list[dict[str, Any]], error_rows: list[dict[str, Any]]) -> dict[str, Any]:
    categories: dict[str, int] = {}
    for row in rows:
        category = str((row.get("currentTimeline") or {}).get("category") or "unknown")
        categories[category] = categories.get(category, 0) + 1

    worst_tracks = sorted(
        rows,
        key=lambda row: float((row.get("currentTimeline") or {}).get("gridMeanAbsMs") or 0.0),
        reverse=True,
    )[:8]

    return {
        "trackTotal": len(rows) + len(error_rows),
        "analyzedTrackCount": len(rows),
        "errorTrackCount": len(error_rows),
        "categoryCounts": categories,
        "currentTimeline": {
            "firstBeatPhaseAbsErrorMs": _summarize_metric(rows, ("currentTimeline", "firstBeatPhaseAbsErrorMs")),
            "gridMeanAbsMs": _summarize_metric(rows, ("currentTimeline", "gridMeanAbsMs")),
            "gridP95AbsMs": _summarize_metric(rows, ("currentTimeline", "gridP95AbsMs")),
            "gridMaxAbsMs": _summarize_metric(rows, ("currentTimeline", "gridMaxAbsMs")),
            "bpmOnlyDrift128BeatsMs": _summarize_metric(rows, ("currentTimeline", "bpmOnlyDrift128BeatsMs")),
        },
        "absoluteTimelineCandidate": {
            "firstBeatPhaseAbsErrorMs": _summarize_metric(
                rows,
                ("absoluteTimelineCandidate", "firstBeatPhaseAbsErrorMs"),
            ),
            "gridMeanAbsMs": _summarize_metric(rows, ("absoluteTimelineCandidate", "gridMeanAbsMs")),
            "gridP95AbsMs": _summarize_metric(rows, ("absoluteTimelineCandidate", "gridP95AbsMs")),
            "gridMaxAbsMs": _summarize_metric(rows, ("absoluteTimelineCandidate", "gridMaxAbsMs")),
        },
        "downbeatMismatchMod4Count": sum(
            1 for row in rows if not bool((row.get("currentTimeline") or {}).get("barBeatOffsetMatchedMod4"))
        ),
        "exact32OffsetMismatchCount": sum(
            1 for row in rows if not bool((row.get("currentTimeline") or {}).get("barBeatOffsetMatchedExact32"))
        ),
        "worstTracks": [
            {
                "fileName": row["fileName"],
                "category": (row.get("currentTimeline") or {}).get("category"),
                "bpm": (row.get("analysis") or {}).get("bpm"),
                "truthBpm": (row.get("truth") or {}).get("bpm"),
                "firstBeatPhaseAbsErrorMs": (row.get("currentTimeline") or {}).get("firstBeatPhaseAbsErrorMs"),
                "gridMeanAbsMs": (row.get("currentTimeline") or {}).get("gridMeanAbsMs"),
                "gridMaxAbsMs": (row.get("currentTimeline") or {}).get("gridMaxAbsMs"),
                "bpmOnlyDrift128BeatsMs": (row.get("currentTimeline") or {}).get("bpmOnlyDrift128BeatsMs"),
                "barBeatOffset": (row.get("analysis") or {}).get("barBeatOffset"),
                "truthBarBeatOffset": (row.get("truth") or {}).get("barBeatOffset"),
                "anchorStrategy": (row.get("analysis") or {}).get("anchorStrategy"),
            }
            for row in worst_tracks
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark FRKB BeatThis grid against rkb Rekordbox truth")
    parser.add_argument("--truth", default=str(DEFAULT_TRUTH))
    parser.add_argument("--audio-root", default=str(DEFAULT_AUDIO_ROOT))
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    parser.add_argument("--ffprobe", default=str(DEFAULT_FFPROBE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        help="Filter tracks by case-insensitive file/title/artist substring. Can be repeated.",
    )
    args = parser.parse_args()

    truth_path = Path(args.truth)
    audio_root = Path(args.audio_root)
    ffmpeg_path = Path(args.ffmpeg)
    ffprobe_path = Path(args.ffprobe)
    output_path = Path(args.output)
    device = str(args.device or "cpu").strip() or "cpu"

    if not truth_path.exists():
        raise SystemExit(f"truth not found: {truth_path}")
    if not audio_root.exists():
        raise SystemExit(f"audio root not found: {audio_root}")
    if not ffmpeg_path.exists():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    if not ffprobe_path.exists():
        raise SystemExit(f"ffprobe not found: {ffprobe_path}")

    started_at = time.time()
    truth_tracks = _load_truth_tracks(truth_path, audio_root, ffprobe_path)
    missing_tracks = [item for item in truth_tracks if not item["fileExists"]]
    if missing_tracks:
        missing_names = ", ".join(item["fileName"] for item in missing_tracks[:5])
        raise SystemExit(f"truth tracks missing from audio root: {missing_names}")
    only_filters = [_normalize_lookup_key(item) for item in args.only if _normalize_lookup_key(item)]
    truth_tracks = [item for item in truth_tracks if _matches_only_filters(item, only_filters)]
    if args.limit and args.limit > 0:
        truth_tracks = truth_tracks[: args.limit]

    bridge = _load_bridge_module()
    predictor = bridge.Audio2Beats(checkpoint_path=bridge._resolve_checkpoint_path(), device=device, dbn=False)
    cpu_spect = bridge.LogMelSpect(device="cpu") if bridge._uses_accelerated_device(device) else None

    rows: list[dict[str, Any]] = []
    error_rows: list[dict[str, Any]] = []
    for index, truth in enumerate(truth_tracks, start=1):
        label = f"[{index}/{len(truth_tracks)}] {truth['fileName']}"
        print(label, flush=True)
        try:
            analysis = _analyze_track(
                bridge=bridge,
                predictor=predictor,
                cpu_spect=cpu_spect,
                ffmpeg_path=ffmpeg_path,
                device=device,
                truth=truth,
            )
            rows.append(_build_track_report(analysis, truth))
        except Exception as error:
            error_rows.append(
                {
                    "fileName": truth["fileName"],
                    "filePath": truth["filePath"],
                    "error": str(error),
                }
            )
            print(f"  error: {error}", flush=True)

    summary = _build_summary(rows, error_rows)
    payload = {
        "summary": {
            **summary,
            "truthPath": str(truth_path),
            "audioRoot": str(audio_root),
            "device": device,
            "windowSec": WINDOW_SEC,
            "maxScanSec": MAX_SCAN_SEC,
            "strictToleranceMs": STRICT_TOLERANCE_MS,
            "durationSec": round(time.time() - started_at, 3),
        },
        "errors": error_rows,
        "tracks": rows,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": payload["summary"], "output": str(output_path)}, ensure_ascii=False, indent=2))
    return 0 if not error_rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
