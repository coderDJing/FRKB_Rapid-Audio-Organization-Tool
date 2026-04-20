import argparse
import importlib.util
import json
import math
import statistics
import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANUAL_TRUTH = REPO_ROOT / "grid-analysis-lab" / "manual-truth" / "truth-sample.json"
DEFAULT_FFMPEG = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe"
DEFAULT_OUTPUT = REPO_ROOT / "grid-analysis-lab" / "manual-truth" / "benchmark-latest.json"
BEAT_THIS_BRIDGE = REPO_ROOT / "scripts" / "beat_this_bridge.py"
SAMPLE_RATE = 44100
CHANNELS = 2
WINDOW_SEC = 30.0
MAX_SCAN_SEC = 120.0
WINDOW_MIN_DURATION_SEC = 8.0
QUALITY_EARLY_STOP_THRESHOLD = 0.72
QUALITY_MIN_BEAT_COUNT = 32


def _load_bridge_module():
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


def _derive_manual_ground_truth(track: dict[str, Any]) -> dict[str, Any] | None:
    file_name = str(track.get("fileName") or "").strip().lower()
    file_path = str(track.get("filePath") or "").strip()
    bpm = _to_float(track.get("bpm"))
    first_beat_ms = _to_float(track.get("firstBeatMs"))
    bar_beat_offset = track.get("barBeatOffset")
    if not file_name or not file_path or bpm is None or bpm <= 0 or first_beat_ms is None or first_beat_ms < 0:
        return None
    try:
        normalized_offset = int(bar_beat_offset) % 4
    except Exception:
        normalized_offset = 0
    first_label = _resolve_first_beat_label_from_offset(normalized_offset)
    beat_interval_sec = 60.0 / bpm
    synthetic_grid = [
        {
            "beat": ((first_label - 1 + index) % 4) + 1,
            "bpm": bpm,
            "timeSec": (first_beat_ms / 1000.0) + index * beat_interval_sec,
        }
        for index in range(128)
    ]
    return {
        "trackTitle": str(track.get("title") or "").strip(),
        "artist": str(track.get("artist") or "").strip(),
        "fileName": file_name,
        "filePath": file_path,
        "bpm": round(float(bpm), 6),
        "firstBeatMs": round(float(first_beat_ms), 3),
        "firstBeatLabel": first_label,
        "barBeatOffset": normalized_offset,
        "grid": synthetic_grid,
        "dynamic": False,
        "uniqueBpms": [round(float(bpm), 6)],
        "truthSource": str(track.get("source") or "manual"),
    }


def _resolve_first_beat_label_from_offset(bar_beat_offset: int) -> int:
    normalized = int(bar_beat_offset) % 4
    return ((5 - normalized - 1) % 4) + 1


def _apply_manual_truth(
    ground_truth: dict[str, Any],
    manual_truth_map: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if not ground_truth:
        return ground_truth
    manual = manual_truth_map.get(str(ground_truth.get("fileName") or "").lower())
    if not manual:
        return ground_truth

    bpm = _to_float(manual.get("bpm"))
    if bpm is None or bpm <= 0:
        bpm = float(ground_truth["bpm"])
    first_beat_ms = _to_float(manual.get("firstBeatMs"))
    if first_beat_ms is None or first_beat_ms < 0:
        first_beat_ms = float(ground_truth["firstBeatMs"])
    manual_bar_beat_offset = manual.get("barBeatOffset")
    if manual_bar_beat_offset is None:
        manual_bar_beat_offset = ground_truth["barBeatOffset"]
    manual_bar_beat_offset = int(manual_bar_beat_offset)
    first_label = _resolve_first_beat_label_from_offset(manual_bar_beat_offset)

    beat_interval_sec = 60.0 / bpm
    manual_grid = []
    original_grid = ground_truth.get("grid") or []
    for index, row in enumerate(original_grid):
        beat_label = int(row.get("beat") or ((first_label - 1 + index) % 4) + 1)
        time_sec = (first_beat_ms / 1000.0) + index * beat_interval_sec
        manual_grid.append({"beat": beat_label, "bpm": bpm, "timeSec": time_sec})

    if not manual_grid:
        manual_grid = list(original_grid)

    patched = dict(ground_truth)
    patched.update(
        {
            "bpm": round(float(bpm), 6),
            "firstBeatMs": round(float(first_beat_ms), 3),
            "firstBeatLabel": first_label,
            "barBeatOffset": manual_bar_beat_offset,
            "grid": manual_grid,
            "dynamic": False,
            "uniqueBpms": [round(float(bpm), 6)],
            "truthSource": str(manual.get("source") or "manual"),
        }
    )
def _decode_pcm_window(ffmpeg_path: Path, file_path: str, duration_sec: float) -> bytes:
    cmd = [
        str(ffmpeg_path),
        "-v",
        "error",
        "-ss",
        "0",
        "-t",
        str(duration_sec),
        "-i",
        file_path,
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


def _normalize_result(result: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(result, dict):
        return None
    bpm = _to_float(result.get("bpm"))
    first_beat_ms = _to_float(result.get("firstBeatMs"))
    beat_count = int(result.get("beatCount") or 0)
    downbeat_count = int(result.get("downbeatCount") or 0)
    quality_score = _to_float(result.get("qualityScore")) or 0.0
    if bpm is None or bpm <= 0 or first_beat_ms is None or first_beat_ms < 0:
        return None
    return {
        "bpm": round(bpm, 6),
        "firstBeatMs": round(first_beat_ms, 3),
        "rawFirstBeatMs": round(_to_float(result.get("rawFirstBeatMs")) or first_beat_ms, 3),
        "barBeatOffset": int(result.get("barBeatOffset") or 0),
        "beatCount": max(0, beat_count),
        "downbeatCount": max(0, downbeat_count),
        "qualityScore": max(0.0, min(1.0, quality_score)),
        "anchorCorrectionMs": round(_to_float(result.get("anchorCorrectionMs")) or 0.0, 3),
        "anchorConfidenceScore": round(
            max(0.0, min(1.0, _to_float(result.get("anchorConfidenceScore")) or 0.0)), 6
        ),
        "anchorMatchedBeatCount": int(result.get("anchorMatchedBeatCount") or 0),
        "anchorStrategy": str(result.get("anchorStrategy") or "").strip() or None,
        "windowIndex": int(result.get("windowIndex") or 0),
        "windowStartSec": round(_to_float(result.get("windowStartSec")) or 0.0, 3),
        "windowDurationSec": round(_to_float(result.get("windowDurationSec")) or 0.0, 3),
    }


def _is_window_good_enough(result: dict[str, Any]) -> bool:
    return (
        float(result.get("qualityScore") or 0.0) >= QUALITY_EARLY_STOP_THRESHOLD
        and int(result.get("beatCount") or 0) >= QUALITY_MIN_BEAT_COUNT
    )


def _compare_window_result(left: dict[str, Any], right: dict[str, Any]) -> int:
    left_quality = float(left.get("qualityScore") or 0.0)
    right_quality = float(right.get("qualityScore") or 0.0)
    if abs(left_quality - right_quality) > 0.000001:
        return -1 if left_quality < right_quality else 1
    left_beats = int(left.get("beatCount") or 0)
    right_beats = int(right.get("beatCount") or 0)
    if left_beats != right_beats:
        return -1 if left_beats < right_beats else 1
    left_downbeats = int(left.get("downbeatCount") or 0)
    right_downbeats = int(right.get("downbeatCount") or 0)
    if left_downbeats != right_downbeats:
        return -1 if left_downbeats < right_downbeats else 1
    return 0


def _slice_pcm_window(pcm_data: bytes, start_sec: float, duration_sec: float) -> tuple[bytes, float]:
    total_samples = len(pcm_data) // 4
    total_frames = total_samples // CHANNELS
    start_frame = max(0, int(max(0.0, start_sec) * SAMPLE_RATE))
    duration_frames = max(1, int(max(0.0, duration_sec) * SAMPLE_RATE))
    end_frame = min(total_frames, start_frame + duration_frames)
    actual_frames = max(0, end_frame - start_frame)
    if actual_frames <= 0:
        return b"", 0.0
    byte_offset = start_frame * CHANNELS * 4
    byte_length = actual_frames * CHANNELS * 4
    return pcm_data[byte_offset : byte_offset + byte_length], actual_frames / SAMPLE_RATE


def _analyze_pcm_windows(
    bridge: Any,
    predictor: Any,
    pcm_data: bytes,
    source_file_path: str,
    use_legacy_anchor: bool,
) -> dict[str, Any]:
    total_samples = len(pcm_data) // 4
    total_frames = total_samples // CHANNELS
    total_duration_sec = total_frames / SAMPLE_RATE
    scan_limit_sec = min(total_duration_sec, MAX_SCAN_SEC)

    best_result: dict[str, Any] | None = None
    for window_index, window_start_sec in enumerate(
        [offset for offset in range(0, int(scan_limit_sec), int(WINDOW_SEC))]
    ):
        remaining_sec = scan_limit_sec - float(window_start_sec)
        if remaining_sec < WINDOW_MIN_DURATION_SEC:
            break
        window_duration_sec = min(WINDOW_SEC, remaining_sec)
        window_pcm, actual_duration_sec = _slice_pcm_window(
            pcm_data, float(window_start_sec), window_duration_sec
        )
        if actual_duration_sec < WINDOW_MIN_DURATION_SEC or not window_pcm:
            break

        signal = bridge._decode_signal(window_pcm, CHANNELS)
        beats, downbeats = bridge._predict_beats(predictor, signal, SAMPLE_RATE, "cpu", None)
        beat_list = bridge._to_float_list(beats)
        downbeat_list = bridge._to_float_list(downbeats)
        bpm = bridge._derive_bpm(beat_list)
        raw_beat_interval = bridge._derive_interval(beat_list)
        if bpm is None or raw_beat_interval is None or not beat_list:
            continue
        tuning = bridge._resolve_anchor_tuning()
        bpm = bridge._stabilize_bpm_for_grid(bpm, tuning)
        beat_interval = 60.0 / bpm if bpm > 0 else raw_beat_interval

        raw_first_beat_ms = beat_list[0] * 1000.0
        if use_legacy_anchor:
            anchor_correction_ms = 0.0
            anchor_confidence_score = 0.0
            anchor_matched_beat_count = 0
            corrected_first_beat_ms = raw_first_beat_ms
            anchor_strategy = "legacy"
        else:
            (
                anchor_correction_ms,
                anchor_confidence_score,
                anchor_matched_beat_count,
            ) = bridge._estimate_anchor_correction(signal, SAMPLE_RATE, beat_list, raw_beat_interval)
            corrected_first_beat_ms = max(0.0, raw_first_beat_ms + anchor_correction_ms)
            anchor_strategy = "refined"

        expected_beat_count = actual_duration_sec / beat_interval if beat_interval > 0 else 0.0
        expected_downbeat_count = expected_beat_count / 4.0 if expected_beat_count > 0 else 0.0
        beat_coverage_score = bridge._clamp01(
            len(beat_list)
            / max(8.0, expected_beat_count * 0.85 if expected_beat_count > 0 else 8.0)
        )
        downbeat_coverage_score = bridge._clamp01(
            len(downbeat_list)
            / max(2.0, expected_downbeat_count * 0.6 if expected_downbeat_count > 0 else 2.0)
        )
        beat_stability_score = bridge._derive_stability(beat_list, raw_beat_interval, 1.0)
        downbeat_stability_score = bridge._derive_stability(downbeat_list, raw_beat_interval, 4.0)
        quality_score = (
            beat_coverage_score * 0.4
            + beat_stability_score * 0.35
            + downbeat_coverage_score * 0.1
            + downbeat_stability_score * 0.15
        )

        result = _normalize_result(
            {
                "bpm": bpm,
                "firstBeatMs": corrected_first_beat_ms + float(window_start_sec) * 1000.0,
                "rawFirstBeatMs": raw_first_beat_ms + float(window_start_sec) * 1000.0,
                "barBeatOffset": bridge._derive_bar_beat_offset(beat_list, downbeat_list),
                "beatCount": len(beat_list),
                "downbeatCount": len(downbeat_list),
                "qualityScore": quality_score,
                "anchorCorrectionMs": anchor_correction_ms,
                "anchorConfidenceScore": anchor_confidence_score,
                "anchorMatchedBeatCount": anchor_matched_beat_count,
                "anchorStrategy": anchor_strategy,
                "windowIndex": window_index,
                "windowStartSec": float(window_start_sec),
                "windowDurationSec": actual_duration_sec,
            }
        )
        if not result:
            continue

        if best_result is None or _compare_window_result(result, best_result) > 0:
            best_result = result
        if _is_window_good_enough(result):
            return result

    if best_result is None:
        raise RuntimeError(f"no valid beat-this result for {source_file_path}")
    return best_result


def _derive_grid_metrics(result: dict[str, Any], ground_truth: dict[str, Any]) -> dict[str, Any]:
    predicted_bpm = float(result["bpm"])
    predicted_first_sec = float(result["firstBeatMs"]) / 1000.0
    beat_interval_sec = 60.0 / predicted_bpm if predicted_bpm > 0 else 0.0
    gt_grid = ground_truth["grid"]
    compare_count = min(len(gt_grid), 128)

    abs_errors_ms: list[float] = []
    signed_errors_ms: list[float] = []
    for index in range(compare_count):
        predicted_sec = predicted_first_sec + index * beat_interval_sec
        gt_sec = float(gt_grid[index]["timeSec"])
        error_ms = (predicted_sec - gt_sec) * 1000.0
        signed_errors_ms.append(error_ms)
        abs_errors_ms.append(abs(error_ms))

    rmse_ms = math.sqrt(sum(error * error for error in signed_errors_ms) / max(1, compare_count))
    mean_abs_ms = sum(abs_errors_ms) / max(1, compare_count)

    return {
        "bpmError": round(predicted_bpm - float(ground_truth["bpm"]), 6),
        "absBpmError": round(abs(predicted_bpm - float(ground_truth["bpm"])), 6),
        "firstBeatErrorMs": round(float(result["firstBeatMs"]) - float(ground_truth["firstBeatMs"]), 3),
        "absFirstBeatErrorMs": round(
            abs(float(result["firstBeatMs"]) - float(ground_truth["firstBeatMs"])), 3
        ),
        "barBeatOffsetMatches": int(result["barBeatOffset"]) == int(ground_truth["barBeatOffset"]),
        "gridCompareCount": compare_count,
        "gridRmseMs": round(rmse_ms, 3),
        "gridMeanAbsMs": round(mean_abs_ms, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark FRKB beat-grid result against manual truth")
    parser.add_argument("--manual-truth", default=str(DEFAULT_MANUAL_TRUTH))
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    ffmpeg_path = Path(args.ffmpeg)
    manual_truth_path = Path(args.manual_truth)
    output_path = Path(args.output)

    if not ffmpeg_path.exists():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    if not manual_truth_path.exists():
        raise SystemExit(f"manual truth not found: {manual_truth_path}")

    manual_truth_payload = json.loads(manual_truth_path.read_text(encoding="utf-8"))
    truth_tracks = manual_truth_payload.get("tracks")
    if not isinstance(truth_tracks, list) or not truth_tracks:
        raise SystemExit("manual truth contains no tracks")
    bridge = _load_bridge_module()
    predictor = bridge.Audio2Beats(checkpoint_path=bridge._resolve_checkpoint_path(), device="cpu", dbn=False)

    benchmark_rows: list[dict[str, Any]] = []
    refined_grid_errors: list[float] = []
    legacy_grid_errors: list[float] = []

    for track in truth_tracks:
        if not isinstance(track, dict):
            continue
        ground_truth = _derive_manual_ground_truth(track)
        if not ground_truth:
            continue
        file_path = str(ground_truth.get("filePath") or "").strip()
        if not ground_truth or not file_path:
            continue
        pcm_data = _decode_pcm_window(ffmpeg_path, file_path, MAX_SCAN_SEC)
        refined_result = _analyze_pcm_windows(
            bridge,
            predictor,
            pcm_data,
            file_path,
            use_legacy_anchor=False,
        )
        legacy_result = _analyze_pcm_windows(
            bridge,
            predictor,
            pcm_data,
            file_path,
            use_legacy_anchor=True,
        )
        refined_metrics = _derive_grid_metrics(refined_result, ground_truth)
        legacy_metrics = _derive_grid_metrics(legacy_result, ground_truth)
        refined_grid_errors.append(float(refined_metrics["gridMeanAbsMs"]))
        legacy_grid_errors.append(float(legacy_metrics["gridMeanAbsMs"]))

        benchmark_rows.append(
            {
                "title": ground_truth["trackTitle"],
                "artist": ground_truth["artist"],
                "filePath": ground_truth["filePath"],
                "truth": {
                    "bpm": ground_truth["bpm"],
                    "firstBeatMs": ground_truth["firstBeatMs"],
                    "firstBeatLabel": ground_truth["firstBeatLabel"],
                    "barBeatOffset": ground_truth["barBeatOffset"],
                    "dynamic": ground_truth["dynamic"],
                    "truthSource": ground_truth.get("truthSource"),
                },
                "refined": {**refined_result, **refined_metrics},
                "legacy": {**legacy_result, **legacy_metrics},
                "deltaVsLegacy": {
                    "gridMeanAbsMs": round(
                        float(refined_metrics["gridMeanAbsMs"]) - float(legacy_metrics["gridMeanAbsMs"]),
                        3,
                    ),
                    "firstBeatErrorMs": round(
                        float(refined_metrics["firstBeatErrorMs"])
                        - float(legacy_metrics["firstBeatErrorMs"]),
                        3,
                    ),
                },
            }
        )

    summary = {
        "playlistId": None,
        "playlistName": str(manual_truth_payload.get("listRoot") or "manual-truth"),
        "trackTotal": len(benchmark_rows),
        "manualTruthCount": sum(
            1 for item in benchmark_rows if item["truth"].get("truthSource") != "rekordbox"
        ),
        "refinedMeanGridAbsMs": round(
            sum(refined_grid_errors) / max(1, len(refined_grid_errors)), 3
        ),
        "legacyMeanGridAbsMs": round(
            sum(legacy_grid_errors) / max(1, len(legacy_grid_errors)), 3
        ),
    }

    payload = {
        "summary": summary,
        "tracks": benchmark_rows,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": summary, "output": str(output_path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
