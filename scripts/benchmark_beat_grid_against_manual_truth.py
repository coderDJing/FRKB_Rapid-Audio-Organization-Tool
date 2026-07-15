import argparse
import importlib.util
import json
import math
import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANUAL_TRUTH = REPO_ROOT / "grid-analysis-lab" / "manual-truth" / "truth-sample.v2.json"
DEFAULT_FFMPEG = REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe"
DEFAULT_OUTPUT = REPO_ROOT / "grid-analysis-lab" / "manual-truth" / "benchmark-latest.v2.json"
BEAT_THIS_BRIDGE = REPO_ROOT / "scripts" / "beat_this_bridge.py"
SAMPLE_RATE = 44100
CHANNELS = 2
WINDOW_SEC = 30.0
MAX_SCAN_SEC = 120.0
DRIFT_BEAT_HORIZONS = (32, 64, 128)
SIGNATURE_HASH_OFFSET = 2166136261
SIGNATURE_HASH_PRIME = 16777619


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


def _calculate_map_signature(clip: dict[str, Any]) -> str:
    payload = "v2:{startSec:.6f},{anchorSec:.6f},{bpm:.6f},{downbeatBeatOffset}".format(**clip)
    value = SIGNATURE_HASH_OFFSET
    for character in payload:
        value ^= ord(character)
        value = (value * SIGNATURE_HASH_PRIME) & 0xFFFFFFFF
    return f"sbgm_{value:08x}"


def _read_fixed_truth_map(track: dict[str, Any]) -> dict[str, Any] | None:
    beat_grid_map = track.get("beatGridMap")
    if not isinstance(beat_grid_map, dict):
        return None
    if beat_grid_map.get("version") != 2 or beat_grid_map.get("source") not in {"manual", "analysis"}:
        return None
    clips = beat_grid_map.get("clips")
    if not isinstance(clips, list) or len(clips) != 1 or not isinstance(clips[0], dict):
        return None
    clip = clips[0]
    start_sec = _to_float(clip.get("startSec"))
    anchor_sec = _to_float(clip.get("anchorSec"))
    bpm = _to_float(clip.get("bpm"))
    downbeat_beat_offset = clip.get("downbeatBeatOffset")
    if (
        start_sec is None
        or abs(start_sec) > 0.000001
        or anchor_sec is None
        or anchor_sec < 0
        or bpm is None
        or bpm <= 0
    ):
        return None
    if not isinstance(downbeat_beat_offset, int) or not 0 <= downbeat_beat_offset < 4:
        return None
    normalized_clip = {
        "startSec": 0,
        "anchorSec": round(anchor_sec, 6),
        "bpm": round(bpm, 6),
        "downbeatBeatOffset": downbeat_beat_offset,
    }
    signature = str(beat_grid_map.get("signature") or "").strip()
    if signature != _calculate_map_signature(normalized_clip):
        return None
    return {
        "version": 2,
        "source": beat_grid_map["source"],
        "clips": [normalized_clip],
        "signature": signature,
    }


def _derive_manual_ground_truth(track: dict[str, Any]) -> dict[str, Any] | None:
    file_name = str(track.get("fileName") or "").strip().lower()
    file_path = str(track.get("filePath") or "").strip()
    beat_grid_map = _read_fixed_truth_map(track)
    if not file_name or not file_path or not beat_grid_map:
        return None
    clip = beat_grid_map["clips"][0]
    bpm = float(clip["bpm"])
    first_beat_ms = float(clip["anchorSec"]) * 1000.0
    beat_interval_sec = 60.0 / bpm
    return {
        "trackTitle": str(track.get("title") or "").strip(),
        "artist": str(track.get("artist") or "").strip(),
        "fileName": file_name,
        "filePath": file_path,
        "bpm": round(float(bpm), 6),
        "firstBeatMs": round(float(first_beat_ms), 3),
        "downbeatBeatOffset": int(clip["downbeatBeatOffset"]),
        "referenceBeatTimesSec": [
            round(float(clip["anchorSec"]) + index * beat_interval_sec, 6) for index in range(128)
        ],
        "beatGridMap": beat_grid_map,
    }


def _phase_delta_ms(candidate_ms: float, reference_ms: float, interval_ms: float) -> float:
    if not math.isfinite(interval_ms) or interval_ms <= 0:
        return candidate_ms - reference_ms
    delta = (candidate_ms - reference_ms) % interval_ms
    if delta > interval_ms / 2:
        delta -= interval_ms
    return delta


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
    downbeat_beat_offset = result.get("downbeatBeatOffset")
    beat_count = int(result.get("beatCount") or 0)
    downbeat_count = int(result.get("downbeatCount") or 0)
    quality_score = _to_float(result.get("qualityScore")) or 0.0
    if (
        bpm is None
        or bpm <= 0
        or first_beat_ms is None
        or first_beat_ms < 0
        or not isinstance(downbeat_beat_offset, int)
        or not 0 <= downbeat_beat_offset < 4
    ):
        return None
    return {
        "bpm": round(bpm, 6),
        "firstBeatMs": round(first_beat_ms, 3),
        "rawFirstBeatMs": round(_to_float(result.get("rawFirstBeatMs")) or first_beat_ms, 3),
        "downbeatBeatOffset": downbeat_beat_offset,
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


def _derive_grid_metrics(result: dict[str, Any], ground_truth: dict[str, Any]) -> dict[str, Any]:
    predicted_bpm = float(result["bpm"])
    beat_interval_sec = 60.0 / predicted_bpm if predicted_bpm > 0 else 0.0
    truth_bpm = float(ground_truth["bpm"])
    truth_beat_interval_sec = 60.0 / truth_bpm if truth_bpm > 0 else 0.0
    beat_interval_error_ms = (beat_interval_sec - truth_beat_interval_sec) * 1000.0
    compare_count = min(len(ground_truth["referenceBeatTimesSec"]), 128)
    phase_error_ms = _phase_delta_ms(
        float(result["firstBeatMs"]),
        float(ground_truth["firstBeatMs"]),
        truth_beat_interval_sec * 1000.0,
    )

    abs_errors_ms: list[float] = []
    signed_errors_ms: list[float] = []
    for index in range(compare_count):
        error_ms = phase_error_ms + index * (beat_interval_sec - truth_beat_interval_sec) * 1000.0
        signed_errors_ms.append(error_ms)
        abs_errors_ms.append(abs(error_ms))

    rmse_ms = math.sqrt(sum(error * error for error in signed_errors_ms) / max(1, compare_count))
    mean_abs_ms = sum(abs_errors_ms) / max(1, compare_count)
    drift_metrics = {
        "beatIntervalErrorMs": round(beat_interval_error_ms, 6),
    }
    for horizon in DRIFT_BEAT_HORIZONS:
        drift_ms = beat_interval_error_ms * horizon
        drift_metrics[f"drift{horizon}BeatsMs"] = round(drift_ms, 3)
        drift_metrics[f"absDrift{horizon}BeatsMs"] = round(abs(drift_ms), 3)

    return {
        "bpmError": round(predicted_bpm - float(ground_truth["bpm"]), 6),
        "absBpmError": round(abs(predicted_bpm - float(ground_truth["bpm"])), 6),
        "firstBeatErrorMs": round(phase_error_ms, 3),
        "absFirstBeatErrorMs": round(abs(phase_error_ms), 3),
        "downbeatBeatOffsetMatches": int(result["downbeatBeatOffset"])
        == int(ground_truth["downbeatBeatOffset"]),
        "gridCompareCount": compare_count,
        "gridRmseMs": round(rmse_ms, 3),
        "gridMeanAbsMs": round(mean_abs_ms, 3),
        **drift_metrics,
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
        legacy_path = manual_truth_path.with_name("truth-sample.json")
        raise SystemExit(
            "v2 manual truth not found: "
            f"{manual_truth_path}. Generate a derived file without touching {legacy_path} with: "
            f'py -3 scripts/convert_legacy_grid_truth_to_v2.py --input "{legacy_path}" '
            f'--output "{manual_truth_path}" --apply'
        )

    manual_truth_payload = json.loads(manual_truth_path.read_text(encoding="utf-8"))
    truth_tracks = manual_truth_payload.get("tracks")
    if not isinstance(truth_tracks, list) or not truth_tracks:
        raise SystemExit("manual truth contains no tracks")
    bridge = _load_bridge_module()
    predictor = bridge.Audio2Beats(checkpoint_path=bridge._resolve_checkpoint_path(), device="cpu", dbn=False)

    benchmark_rows: list[dict[str, Any]] = []
    refined_grid_errors: list[float] = []
    legacy_grid_errors: list[float] = []
    refined_abs_bpm_errors: list[float] = []
    legacy_abs_bpm_errors: list[float] = []
    refined_abs_drift_errors: dict[int, list[float]] = {horizon: [] for horizon in DRIFT_BEAT_HORIZONS}
    legacy_abs_drift_errors: dict[int, list[float]] = {horizon: [] for horizon in DRIFT_BEAT_HORIZONS}

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
        signal = bridge._decode_signal(pcm_data, CHANNELS)
        duration_sec = signal.shape[0] / SAMPLE_RATE if SAMPLE_RATE > 0 else 0.0
        tuning = bridge._resolve_anchor_tuning()
        prepared_windows = bridge._prepare_analysis_windows(
            predictor,
            None,
            signal,
            SAMPLE_RATE,
            "cpu",
            WINDOW_SEC,
            MAX_SCAN_SEC,
        )
        refined_result = bridge._analyze_prepared_windows_to_track_result(
            prepared_windows,
            signal,
            SAMPLE_RATE,
            min(duration_sec, MAX_SCAN_SEC),
            tuning,
            file_path,
            force_legacy_anchor=False,
            use_global_solver=True,
        )
        legacy_result = bridge._analyze_prepared_windows_to_track_result(
            prepared_windows,
            signal,
            SAMPLE_RATE,
            min(duration_sec, MAX_SCAN_SEC),
            tuning,
            file_path,
            force_legacy_anchor=True,
            use_global_solver=False,
        )
        refined_result = _normalize_result(bridge._to_public_downbeat_result(refined_result))
        legacy_result = _normalize_result(bridge._to_public_downbeat_result(legacy_result))
        if not refined_result or not legacy_result:
            continue
        refined_metrics = _derive_grid_metrics(refined_result, ground_truth)
        legacy_metrics = _derive_grid_metrics(legacy_result, ground_truth)
        refined_grid_errors.append(float(refined_metrics["gridMeanAbsMs"]))
        legacy_grid_errors.append(float(legacy_metrics["gridMeanAbsMs"]))
        refined_abs_bpm_errors.append(float(refined_metrics["absBpmError"]))
        legacy_abs_bpm_errors.append(float(legacy_metrics["absBpmError"]))
        for horizon in DRIFT_BEAT_HORIZONS:
            refined_abs_drift_errors[horizon].append(float(refined_metrics[f"absDrift{horizon}BeatsMs"]))
            legacy_abs_drift_errors[horizon].append(float(legacy_metrics[f"absDrift{horizon}BeatsMs"]))

        benchmark_rows.append(
            {
                "title": ground_truth["trackTitle"],
                "artist": ground_truth["artist"],
                "filePath": ground_truth["filePath"],
                "truth": {
                    "beatGridMap": ground_truth["beatGridMap"],
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
            1
            for item in benchmark_rows
            if (item["truth"].get("beatGridMap") or {}).get("source") == "manual"
        ),
        "refinedMeanGridAbsMs": round(
            sum(refined_grid_errors) / max(1, len(refined_grid_errors)), 3
        ),
        "legacyMeanGridAbsMs": round(
            sum(legacy_grid_errors) / max(1, len(legacy_grid_errors)), 3
        ),
        "refinedMeanAbsBpmError": round(
            sum(refined_abs_bpm_errors) / max(1, len(refined_abs_bpm_errors)), 6
        ),
        "legacyMeanAbsBpmError": round(
            sum(legacy_abs_bpm_errors) / max(1, len(legacy_abs_bpm_errors)), 6
        ),
        "refinedWorstAbsBpmError": round(max(refined_abs_bpm_errors, default=0.0), 6),
        "legacyWorstAbsBpmError": round(max(legacy_abs_bpm_errors, default=0.0), 6),
    }
    for horizon in DRIFT_BEAT_HORIZONS:
        summary[f"refinedMeanAbsDrift{horizon}BeatsMs"] = round(
            sum(refined_abs_drift_errors[horizon]) / max(1, len(refined_abs_drift_errors[horizon])),
            3,
        )
        summary[f"legacyMeanAbsDrift{horizon}BeatsMs"] = round(
            sum(legacy_abs_drift_errors[horizon]) / max(1, len(legacy_abs_drift_errors[horizon])),
            3,
        )
        summary[f"refinedWorstAbsDrift{horizon}BeatsMs"] = round(
            max(refined_abs_drift_errors[horizon], default=0.0),
            3,
        )
        summary[f"legacyWorstAbsDrift{horizon}BeatsMs"] = round(
            max(legacy_abs_drift_errors[horizon], default=0.0),
            3,
        )

    payload = {
        "summary": summary,
        "tracks": benchmark_rows,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": summary, "output": str(output_path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
