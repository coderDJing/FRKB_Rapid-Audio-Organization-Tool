from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, correlate, find_peaks, sosfiltfilt


ANALYZER_VERSION = "master-tempo-ab-transient-analyzer-v2"
HOP_FRAMES = 16
MAX_LAG_MS = 100.0
EVENT_SEARCH_RADIUS_MS = 50.0
EVENT_THRESHOLDS = (0.10, 0.20, 0.25, 0.30)


def read_stereo_float(path: Path) -> tuple[int, np.ndarray]:
    sample_rate, samples = wavfile.read(path)
    samples = np.asarray(samples, dtype=np.float64)
    if samples.ndim != 2 or samples.shape[1] != 2:
        raise ValueError(f"expected stereo WAV: {path}")
    if not np.isfinite(samples).all():
        raise ValueError(f"non-finite PCM samples: {path}")
    return int(sample_rate), samples


def transient_envelope(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    mono = samples.mean(axis=1)
    sos = butter(4, [35.0, 220.0], btype="bandpass", fs=sample_rate, output="sos")
    filtered = sosfiltfilt(sos, mono)
    smooth_frames = max(1, round(sample_rate * 0.008))
    energy = np.convolve(
        filtered * filtered,
        np.ones(smooth_frames, dtype=np.float64) / smooth_frames,
        mode="same",
    )
    positive_change = np.maximum(np.diff(energy, prepend=energy[0]), 0.0)
    usable = len(positive_change) // HOP_FRAMES * HOP_FRAMES
    envelope = positive_change[:usable].reshape(-1, HOP_FRAMES).max(axis=1)
    scale = float(np.median(envelope)) + 1e-12
    return np.log1p(envelope / scale)


def lag_windows(
    reference: np.ndarray,
    candidate: np.ndarray,
    sample_rate: int,
    target_bpm: float,
) -> list[dict[str, float]]:
    envelope_rate = sample_rate / HOP_FRAMES
    beat_seconds = 60.0 / target_bpm
    window_frames = round(8.0 * beat_seconds * envelope_rate)
    step_frames = round(2.0 * beat_seconds * envelope_rate)
    max_lag_frames = round(MAX_LAG_MS / 1000.0 * envelope_rate)
    length = min(len(reference), len(candidate))
    rows: list[dict[str, float]] = []
    for start in range(0, length - window_frames + 1, step_frames):
        ref = reference[start : start + window_frames]
        test = candidate[start : start + window_frames]
        ref = (ref - ref.mean()) / (ref.std() + 1e-12)
        test = (test - test.mean()) / (test.std() + 1e-12)
        correlation = correlate(test, ref, mode="full", method="fft")
        center = window_frames - 1
        local = correlation[
            center - max_lag_frames : center + max_lag_frames + 1
        ] / window_frames
        peak_index = int(np.argmax(local))
        fractional_peak = float(peak_index)
        if 0 < peak_index < len(local) - 1:
            left = float(local[peak_index - 1])
            center_value = float(local[peak_index])
            right = float(local[peak_index + 1])
            denominator = left - 2.0 * center_value + right
            if abs(denominator) > 1e-12:
                fractional_peak += 0.5 * (left - right) / denominator
        lag_ms = (fractional_peak - max_lag_frames) / envelope_rate * 1000.0
        rows.append(
            {
                "centerSec": (start + window_frames / 2.0) / envelope_rate,
                "lagMs": lag_ms,
                "correlation": float(local[peak_index]),
            }
        )
    return rows


def percentile(values: np.ndarray, value: float) -> float:
    return float(np.percentile(values, value)) if len(values) else 0.0


def fixed_reference_events(
    envelope: np.ndarray, sample_rate: int, target_bpm: float
) -> np.ndarray:
    envelope_rate = sample_rate / HOP_FRAMES
    beat_seconds = 60.0 / target_bpm
    distance = max(1, round(0.25 * beat_seconds * envelope_rate))
    prominence = max(float(np.percentile(envelope, 75)), 1e-9)
    peaks, _ = find_peaks(envelope, distance=distance, prominence=prominence)
    edge = round(0.1 * envelope_rate)
    return peaks[(peaks >= edge) & (peaks < len(envelope) - edge)]


def match_fixed_events(
    reference: np.ndarray,
    candidate: np.ndarray,
    reference_events: np.ndarray,
    sample_rate: int,
    baseline_lag_ms: float,
    threshold: float,
) -> list[dict[str, float | int]]:
    envelope_rate = sample_rate / HOP_FRAMES
    baseline_frames = baseline_lag_ms / 1000.0 * envelope_rate
    radius = round(EVENT_SEARCH_RADIUS_MS / 1000.0 * envelope_rate)
    rows: list[dict[str, float | int]] = []
    for event_id, reference_index in enumerate(reference_events):
        expected = float(reference_index) + baseline_frames
        start = max(1, round(expected) - radius)
        end = min(len(candidate) - 1, round(expected) + radius + 1)
        if end - start < 3:
            continue
        local_peaks, _ = find_peaks(candidate[start:end])
        if len(local_peaks) == 0:
            continue
        candidates = local_peaks + start
        local_max = float(np.max(candidate[candidates]))
        eligible = candidates[candidate[candidates] >= local_max * threshold]
        if len(eligible) == 0:
            continue
        candidate_index = int(eligible[np.argmin(np.abs(eligible - expected))])
        lag_ms = (candidate_index - int(reference_index)) / envelope_rate * 1000.0
        rows.append(
            {
                "eventId": event_id,
                "referenceSec": float(reference_index / envelope_rate),
                "referenceStrength": float(reference[reference_index]),
                "candidateStrength": float(candidate[candidate_index]),
                "lagMs": lag_ms,
            }
        )
    return rows


def summarize_event_rows(rows: list[dict[str, float | int]]) -> dict[str, float | int]:
    lags = np.asarray([float(row["lagMs"]) for row in rows], dtype=np.float64)
    fixed_lag = float(np.median(lags)) if len(lags) else 0.0
    residuals = lags - fixed_lag
    jumps = np.diff(lags)
    for row, residual in zip(rows, residuals, strict=True):
        row["residualLagMs"] = float(residual)
    absolute_jumps = np.abs(jumps)
    return {
        "matchedEventCount": len(rows),
        "fixedLagMs": fixed_lag,
        "residualAbsoluteP50Ms": percentile(np.abs(residuals), 50),
        "residualAbsoluteP95Ms": percentile(np.abs(residuals), 95),
        "residualAbsoluteMaxMs": float(np.max(np.abs(residuals))) if len(residuals) else 0.0,
        "adjacentJumpAbsoluteP50Ms": percentile(absolute_jumps, 50),
        "adjacentJumpAbsoluteP95Ms": percentile(absolute_jumps, 95),
        "adjacentJumpAbsoluteMaxMs": float(np.max(absolute_jumps)) if len(absolute_jumps) else 0.0,
        "adjacentJumpOver3MsCount": int(np.count_nonzero(absolute_jumps > 3.0)),
        "adjacentJumpOver5MsCount": int(np.count_nonzero(absolute_jumps > 5.0)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.input_dir.resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    target_bpm = float(manifest["input"]["targetBpm"])
    sample_rate, mt_off = read_stereo_float(root / "mt-off.wav")
    r3_sample_rate, mt_on = read_stereo_float(root / "mt-on-r3.wav")
    if sample_rate != r3_sample_rate:
        raise ValueError("MT-off and R3 WAV sample rates differ")

    reference_envelope = transient_envelope(mt_off, sample_rate)
    candidate_envelope = transient_envelope(mt_on, sample_rate)
    rows = lag_windows(reference_envelope, candidate_envelope, sample_rate, target_bpm)
    if len(rows) < 4:
        raise ValueError("decoded duration is too short for transient lag analysis")

    lags = np.asarray([row["lagMs"] for row in rows], dtype=np.float64)
    times = np.asarray([row["centerSec"] for row in rows], dtype=np.float64)
    correlations = np.asarray([row["correlation"] for row in rows], dtype=np.float64)
    baseline_count = min(4, len(rows))
    baseline_lag = float(np.median(lags[:baseline_count]))
    residuals = lags - baseline_lag
    slope = float(np.polyfit(times, residuals, 1)[0])
    for row, residual in zip(rows, residuals, strict=True):
        row["residualLagMs"] = float(residual)

    reference_events = fixed_reference_events(reference_envelope, sample_rate, target_bpm)
    if len(reference_events) < 8:
        raise ValueError("too few fixed reference events for transient analysis")
    event_identity = hashlib.sha256(
        np.asarray(reference_events, dtype="<i8").tobytes()
    ).hexdigest()
    event_rows_by_threshold: dict[str, list[dict[str, float | int]]] = {}
    event_metrics: dict[str, dict[str, float | int]] = {}
    for threshold in EVENT_THRESHOLDS:
        key = f"{round(threshold * 100)}pct"
        event_rows = match_fixed_events(
            reference_envelope,
            candidate_envelope,
            reference_events,
            sample_rate,
            baseline_lag,
            threshold,
        )
        event_rows_by_threshold[key] = event_rows
        event_metrics[key] = summarize_event_rows(event_rows)

    metrics = {
        "schemaVersion": 1,
        "analyzerVersion": ANALYZER_VERSION,
        "contract": (
            "same source PCM, same start frame, same target BPM; "
            "MT-off is timing reference"
        ),
        "transientFeature": "35-220Hz positive energy change",
        "lagResolutionMs": HOP_FRAMES / sample_rate * 1000.0,
        "sampleRate": sample_rate,
        "mtOffFrames": int(mt_off.shape[0]),
        "mtOnR3Frames": int(mt_on.shape[0]),
        "durationDeltaMs": (mt_on.shape[0] - mt_off.shape[0]) / sample_rate * 1000.0,
        "windowCount": len(rows),
        "windowBeats": 8,
        "stepBeats": 2,
        "baselineLagMs": baseline_lag,
        "medianCorrelation": float(np.median(correlations)),
        "residualAbsoluteP50Ms": percentile(np.abs(residuals), 50),
        "residualAbsoluteP95Ms": percentile(np.abs(residuals), 95),
        "residualAbsoluteMaxMs": float(np.max(np.abs(residuals))),
        "residualLagRangeMs": float(np.max(residuals) - np.min(residuals)),
        "residualLagSlopeMsPerSec": slope,
        "fixedEventAnalysis": {
            "referenceEventCount": int(len(reference_events)),
            "referenceEventIdentitySha256": event_identity,
            "referenceSelection": (
                "MT-off envelope peaks; minimum spacing 0.25 beat; "
                "prominence at reference P75"
            ),
            "candidateSelection": (
                "nearest local peak to baseline lag within +/-50ms "
                "after local strength threshold"
            ),
            "thresholds": event_metrics,
        },
        "windows": rows,
    }
    (root / "transient-metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with (root / "transient-lag.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["centerSec", "lagMs", "residualLagMs", "correlation"],
        )
        writer.writeheader()
        writer.writerows(rows)

    with (root / "transient-events.csv").open(
        "w", encoding="utf-8", newline=""
    ) as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "threshold",
                "eventId",
                "referenceSec",
                "referenceStrength",
                "candidateStrength",
                "lagMs",
                "residualLagMs",
            ],
        )
        writer.writeheader()
        for threshold, event_rows in event_rows_by_threshold.items():
            for event_row in event_rows:
                writer.writerow({"threshold": threshold, **event_row})

    figure, (lag_axis, correlation_axis) = plt.subplots(2, 1, figsize=(12, 7), sharex=True)
    lag_axis.axhline(0.0, color="#555555", linewidth=1.0)
    lag_axis.plot(times, residuals, color="#d1495b", marker="o", markersize=3)
    lag_axis.set_ylabel("R3 transient residual (ms)")
    lag_axis.grid(alpha=0.25)
    correlation_axis.plot(times, correlations, color="#00798c", marker="o", markersize=3)
    correlation_axis.set_xlabel("Output time (s)")
    correlation_axis.set_ylabel("Envelope correlation")
    correlation_axis.set_ylim(-0.05, 1.05)
    correlation_axis.grid(alpha=0.25)
    figure.suptitle(
        f"Master Tempo A/B: {manifest['input']['sourceBpm']} -> {target_bpm} BPM"
    )
    figure.tight_layout()
    figure.savefig(root / "transient-lag.png", dpi=160)
    plt.close(figure)

    event_figure, event_axis = plt.subplots(figsize=(12, 5))
    for threshold, event_rows in event_rows_by_threshold.items():
        event_axis.plot(
            [float(row["referenceSec"]) for row in event_rows],
            [float(row["residualLagMs"]) for row in event_rows],
            marker=".",
            markersize=3,
            linewidth=0.8,
            label=threshold,
        )
    event_axis.axhline(0.0, color="#555555", linewidth=1.0)
    event_axis.set_xlabel("MT-off reference time (s)")
    event_axis.set_ylabel("Fixed-event residual (ms)")
    event_axis.grid(alpha=0.25)
    event_axis.legend(title="Local strength")
    event_figure.tight_layout()
    event_figure.savefig(root / "transient-events.png", dpi=160)
    plt.close(event_figure)

    primary_events = event_metrics["20pct"]
    print(
        "[master-tempo-ab] "
        f"event20.fixed={primary_events['fixedLagMs']:.3f}ms "
        f"event20.jumpP95={primary_events['adjacentJumpAbsoluteP95Ms']:.3f}ms "
        f"event20.jumpMax={primary_events['adjacentJumpAbsoluteMaxMs']:.3f}ms "
        f"events={primary_events['matchedEventCount']}/{len(reference_events)} "
        f"windowCorr={metrics['medianCorrelation']:.3f}"
    )


if __name__ == "__main__":
    main()
