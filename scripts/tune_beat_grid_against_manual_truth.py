import importlib.util
import itertools
import json
import os
import statistics
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_SCRIPT = REPO_ROOT / "scripts" / "benchmark_beat_grid_against_manual_truth.py"
OUTPUT_PATH = REPO_ROOT / "grid-analysis-lab" / "manual-truth" / "tuning-latest.json"


def _load_module(module_path: Path, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


benchmark = _load_module(BENCHMARK_SCRIPT, "benchmark_beat_grid_against_manual_truth")


def _prepare_selected_track(
    bridge: Any,
    predictor: Any,
    track: dict[str, Any],
    ffmpeg_path: Path,
) -> dict[str, Any] | None:
    ground_truth = benchmark._derive_manual_ground_truth(track)
    file_path = str(ground_truth.get("filePath") or "") if ground_truth else ""
    if not ground_truth or not file_path:
        return None

    pcm_data = benchmark._decode_pcm_window(ffmpeg_path, file_path, benchmark.MAX_SCAN_SEC)
    signal = bridge._decode_signal(pcm_data, benchmark.CHANNELS)
    total_duration_sec = signal.shape[0] / benchmark.SAMPLE_RATE
    scan_duration_sec = min(total_duration_sec, benchmark.MAX_SCAN_SEC)
    prepared_windows = bridge._prepare_analysis_windows(
        predictor,
        None,
        signal,
        benchmark.SAMPLE_RATE,
        "cpu",
        benchmark.WINDOW_SEC,
        benchmark.MAX_SCAN_SEC,
    )
    if not prepared_windows:
        return None
    legacy_result = bridge._analyze_prepared_windows_to_track_result(
        prepared_windows,
        signal,
        benchmark.SAMPLE_RATE,
        scan_duration_sec,
        bridge._resolve_anchor_tuning(),
        file_path,
        force_legacy_anchor=True,
        use_global_solver=False,
    )
    legacy_metrics = benchmark._derive_grid_metrics(legacy_result, ground_truth)

    return {
        "title": ground_truth["trackTitle"],
        "artist": ground_truth["artist"],
        "filePath": file_path,
        "groundTruth": ground_truth,
        "signal": signal,
        "scanDurationSec": scan_duration_sec,
        "preparedWindows": prepared_windows,
        "legacyResult": {**legacy_result, **legacy_metrics},
    }


def _evaluate_candidate(
    bridge: Any,
    prepared_tracks: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    os.environ[bridge.ENV_BEAT_THIS_ANCHOR_TUNING_JSON] = json.dumps(config, separators=(",", ":"))

    rows: list[dict[str, Any]] = []
    refined_errors: list[float] = []
    deltas: list[float] = []
    tuning = bridge._resolve_anchor_tuning()

    for track in prepared_tracks:
        signal = track["signal"]
        scan_duration_sec = float(track["scanDurationSec"])
        prepared_windows = list(track["preparedWindows"])
        ground_truth = track["groundTruth"]
        legacy_result = track["legacyResult"]

        refined_result = benchmark._normalize_result(
            bridge._analyze_prepared_windows_to_track_result(
                prepared_windows,
                signal,
                benchmark.SAMPLE_RATE,
                scan_duration_sec,
                tuning,
                track["filePath"],
                force_legacy_anchor=False,
                use_global_solver=True,
            )
        )
        if not refined_result:
            continue
        refined_metrics = benchmark._derive_grid_metrics(refined_result, ground_truth)
        refined_errors.append(float(refined_metrics["gridMeanAbsMs"]))
        delta = float(refined_metrics["gridMeanAbsMs"]) - float(legacy_result["gridMeanAbsMs"])
        deltas.append(delta)
        rows.append(
            {
                "title": track["title"],
                "artist": track["artist"],
                "legacyGridMeanAbsMs": legacy_result["gridMeanAbsMs"],
                "refinedGridMeanAbsMs": refined_metrics["gridMeanAbsMs"],
                "deltaVsLegacyMs": round(delta, 3),
                "legacyFirstBeatMs": legacy_result["firstBeatMs"],
                "refinedFirstBeatMs": refined_result["firstBeatMs"],
                "truthFirstBeatMs": ground_truth["firstBeatMs"],
                "anchorCorrectionMs": refined_result["anchorCorrectionMs"],
            }
        )

    mean_grid = statistics.fmean(refined_errors) if refined_errors else 999.0
    median_grid = statistics.median(refined_errors) if refined_errors else 999.0
    worst_grid = max(refined_errors) if refined_errors else 999.0
    improved_count = sum(1 for delta in deltas if delta < -0.001)
    worsened_count = sum(1 for delta in deltas if delta > 0.001)
    max_worsening = max((delta for delta in deltas if delta > 0.0), default=0.0)

    leave_one_out_means: list[float] = []
    for index in range(len(refined_errors)):
        sample = refined_errors[:index] + refined_errors[index + 1 :]
        if sample:
            leave_one_out_means.append(statistics.fmean(sample))

    loo_worst_mean = max(leave_one_out_means) if leave_one_out_means else mean_grid
    loo_std = statistics.pstdev(leave_one_out_means) if len(leave_one_out_means) >= 2 else 0.0
    complexity_penalty = 0.0
    if str(config.get("positiveShiftPolicy")) == "allow":
        complexity_penalty += 0.15
        default_positive_max_shift_ms = float(
            bridge.DEFAULT_ANCHOR_TUNING["positiveMaxShiftMs"]
        )
        complexity_penalty += (
            max(0.0, float(config.get("positiveMaxShiftMs") or 0.0) - default_positive_max_shift_ms)
            * 0.03
        )
        complexity_penalty += max(0.0, 6.0 - float(config.get("positiveMinShiftMs") or 0.0)) * 0.04

    stable_score = (
        mean_grid
        + max_worsening * 0.35
        + worsened_count * 0.6
        + loo_std * 0.5
        + complexity_penalty
    )

    return {
        "config": config,
        "summary": {
            "meanGridAbsMs": round(mean_grid, 3),
            "medianGridAbsMs": round(median_grid, 3),
            "worstGridAbsMs": round(worst_grid, 3),
            "improvedTrackCount": improved_count,
            "worsenedTrackCount": worsened_count,
            "maxWorseningVsLegacyMs": round(max_worsening, 3),
            "leaveOneOutWorstMeanGridAbsMs": round(loo_worst_mean, 3),
            "leaveOneOutStdMeanGridAbsMs": round(loo_std, 3),
            "stableScore": round(stable_score, 3),
        },
        "tracks": rows,
    }


def main() -> int:
    manual_truth_path = benchmark.DEFAULT_MANUAL_TRUTH
    ffmpeg_path = benchmark.DEFAULT_FFMPEG

    bridge = benchmark._load_bridge_module()
    predictor = bridge.Audio2Beats(checkpoint_path=bridge._resolve_checkpoint_path(), device="cpu", dbn=False)
    dump_payload = json.loads(manual_truth_path.read_text(encoding="utf-8"))
    tracks = dump_payload.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise SystemExit("manual truth contains no tracks")

    prepared_tracks = []
    for track in tracks:
        if not isinstance(track, dict):
            continue
        prepared = _prepare_selected_track(bridge, predictor, track, ffmpeg_path)
        if prepared:
            prepared_tracks.append(prepared)

    if not prepared_tracks:
        raise SystemExit("no prepared tracks available for tuning")

    candidate_configs: list[dict[str, Any]] = [dict(bridge.DEFAULT_ANCHOR_TUNING)]
    for (
        positive_policy,
        positive_min_raw_first_beat_ms,
        positive_min_shift_ms,
        positive_max_shift_ms,
        positive_confidence_min,
        positive_relative_gain_min,
        positive_score_contrast_min,
        backtrack_threshold_ratio,
        backtrack_threshold_floor,
    ) in itertools.product(
        ["zero", "allow"],
        [8.0, 12.0],
        [4.0, 6.0],
        [10.0, 14.0, 18.0],
        [0.78, 0.82],
        [0.08],
        [0.025],
        [0.1, 0.12],
        [0.004, 0.006],
    ):
        config = dict(bridge.DEFAULT_ANCHOR_TUNING)
        config.update(
            {
                "positiveShiftPolicy": positive_policy,
                "positiveMinRawFirstBeatMs": positive_min_raw_first_beat_ms,
                "positiveMinShiftMs": positive_min_shift_ms,
                "positiveMaxShiftMs": positive_max_shift_ms,
                "positiveConfidenceMin": positive_confidence_min,
                "positiveRelativeGainMin": positive_relative_gain_min,
                "positiveScoreContrastMin": positive_score_contrast_min,
                "backtrackThresholdRatio": backtrack_threshold_ratio,
                "backtrackThresholdFloor": backtrack_threshold_floor,
            }
        )
        if positive_policy == "zero" and (
            positive_min_raw_first_beat_ms != bridge.DEFAULT_ANCHOR_TUNING["positiveMinRawFirstBeatMs"]
            or
            positive_min_shift_ms != bridge.DEFAULT_ANCHOR_TUNING["positiveMinShiftMs"]
            or positive_max_shift_ms != bridge.DEFAULT_ANCHOR_TUNING["positiveMaxShiftMs"]
            or positive_confidence_min != bridge.DEFAULT_ANCHOR_TUNING["positiveConfidenceMin"]
            or positive_relative_gain_min != bridge.DEFAULT_ANCHOR_TUNING["positiveRelativeGainMin"]
            or positive_score_contrast_min != bridge.DEFAULT_ANCHOR_TUNING["positiveScoreContrastMin"]
        ):
            continue
        candidate_configs.append(config)

    unique_configs: list[dict[str, Any]] = []
    seen = set()
    for config in candidate_configs:
        key = json.dumps(config, sort_keys=True, separators=(",", ":"))
        if key in seen:
            continue
        seen.add(key)
        unique_configs.append(config)

    evaluations = [_evaluate_candidate(bridge, prepared_tracks, config) for config in unique_configs]
    evaluations.sort(key=lambda item: float(item["summary"]["stableScore"]))

    accepted = [
        item
        for item in evaluations
        if int(item["summary"]["worsenedTrackCount"]) <= 2
        and float(item["summary"]["maxWorseningVsLegacyMs"]) <= 8.0
    ]
    best = accepted[0] if accepted else evaluations[0]

    payload = {
        "playlistId": None,
        "playlistName": str(dump_payload.get("listRoot") or "manual-truth"),
        "trackTotal": len(prepared_tracks),
        "evaluatedConfigCount": len(evaluations),
        "bestAccepted": best,
        "top10": evaluations[:10],
    }
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT_PATH), "bestAccepted": best["summary"], "config": best["config"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
