import os
import json
import math
import statistics
import sys
from typing import Any

ENV_BEAT_THIS_EXTRA_SITE_DIRS = "FRKB_BEAT_THIS_EXTRA_SITE_DIRS"
ENV_BEAT_THIS_EXTRA_DLL_DIRS = "FRKB_BEAT_THIS_EXTRA_DLL_DIRS"
_DLL_DIR_HANDLES: list[Any] = []


def _split_env_paths(env_name: str) -> list[str]:
    raw_value = str(os.environ.get(env_name) or "").strip()
    if not raw_value:
        return []
    return [part for part in raw_value.split(os.pathsep) if part]


def _bootstrap_extra_paths() -> None:
    if os.name == "nt" and hasattr(os, "add_dll_directory"):
        for dll_dir in _split_env_paths(ENV_BEAT_THIS_EXTRA_DLL_DIRS):
            try:
                if os.path.isdir(dll_dir):
                    _DLL_DIR_HANDLES.append(os.add_dll_directory(dll_dir))
            except Exception:
                continue

    for site_dir in _split_env_paths(ENV_BEAT_THIS_EXTRA_SITE_DIRS):
        if os.path.isdir(site_dir) and site_dir not in sys.path:
            sys.path.append(site_dir)


_bootstrap_extra_paths()

import numpy as np
import soxr
import torch

from beat_this.inference import Audio2Beats, split_predict_aggregate
from beat_this.preprocessing import LogMelSpect


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _read_exact(byte_length: int) -> bytes:
    remaining = max(0, int(byte_length))
    chunks: list[bytes] = []
    while remaining > 0:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            raise RuntimeError(f"expected {byte_length} bytes of PCM data, got EOF")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _to_float_list(values: Any) -> list[float]:
    if values is None:
        return []
    if hasattr(values, "tolist"):
        values = values.tolist()
    result: list[float] = []
    for value in values:
        try:
            numeric = float(value)
        except Exception:
            continue
        if not math.isfinite(numeric) or numeric < 0.0:
            continue
        result.append(numeric)
    return result


def _derive_bpm(beats: list[float]) -> float | None:
    if len(beats) < 2:
        return None
    intervals = [
        current - previous
        for previous, current in zip(beats[:-1], beats[1:])
        if 0.18 <= current - previous <= 2.0
    ]
    if not intervals:
        return None

    if len(beats) >= 8:
        indices = list(range(len(beats)))
        mean_index = statistics.fmean(indices)
        mean_beat = statistics.fmean(beats)
        numerator = sum(
            (index - mean_index) * (beat - mean_beat)
            for index, beat in zip(indices, beats)
        )
        denominator = sum((index - mean_index) ** 2 for index in indices)
        beat_interval = numerator / denominator if denominator > 0 else statistics.median(intervals)
    else:
        beat_interval = statistics.median(intervals)

    if not math.isfinite(beat_interval) or beat_interval <= 0.0:
        return None
    bpm = 60.0 / beat_interval
    return bpm if math.isfinite(bpm) and bpm > 0.0 else None


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, value))


def _derive_interval(beats: list[float]) -> float | None:
    if len(beats) < 2:
        return None
    intervals = [
        current - previous
        for previous, current in zip(beats[:-1], beats[1:])
        if 0.18 <= current - previous <= 2.0
    ]
    if not intervals:
        return None
    return statistics.median(intervals)


def _derive_stability(events: list[float], target_interval: float, multiplier: float = 1.0) -> float:
    if len(events) < 3 or not math.isfinite(target_interval) or target_interval <= 0.0:
        return 0.0
    intervals = [
        current - previous
        for previous, current in zip(events[:-1], events[1:])
        if 0.18 <= current - previous <= 8.0
    ]
    if len(intervals) < 2:
        return 0.0
    expected = target_interval * multiplier
    deviations = [abs(interval - expected) / expected for interval in intervals if expected > 0]
    if not deviations:
        return 0.0
    mad = statistics.median(deviations)
    return _clamp01(1.0 - mad / 0.2)


def _derive_bar_beat_offset(beats: list[float], downbeats: list[float]) -> int:
    if not beats or not downbeats:
        return 0
    first_downbeat = downbeats[0]
    nearest_index = min(range(len(beats)), key=lambda index: abs(beats[index] - first_downbeat))
    if abs(beats[nearest_index] - first_downbeat) > 0.12:
        return 0
    return nearest_index % 32


def _decode_signal(pcm_bytes: bytes, channels: int) -> np.ndarray:
    if channels <= 0:
        raise RuntimeError("channels must be positive")
    signal = np.frombuffer(pcm_bytes, dtype="<f4")
    usable_samples = signal.size - (signal.size % channels)
    if usable_samples <= 0:
        raise RuntimeError("PCM data is empty")
    signal = signal[:usable_samples]
    if channels == 1:
        return signal.astype("float64", copy=False)
    return signal.reshape((-1, channels)).astype("float64", copy=False)


def _uses_accelerated_device(device: str) -> bool:
    normalized = str(device or "").strip().lower()
    return normalized not in {"", "cpu"}


def _predict_beats_with_accelerated_device(
    predictor: Audio2Beats,
    cpu_spect: LogMelSpect,
    signal: np.ndarray,
    sample_rate: int,
) -> tuple[Any, Any]:
    if signal.ndim == 2:
        signal = signal.mean(1)
    elif signal.ndim != 1:
        raise RuntimeError(f"expected mono/stereo signal, got shape {signal.shape}")

    if sample_rate != 22050:
        signal = soxr.resample(signal, in_rate=sample_rate, out_rate=22050)

    signal_tensor = torch.tensor(signal, dtype=torch.float32, device="cpu")
    spect = cpu_spect(signal_tensor).detach().to(predictor.device)

    with torch.no_grad():
        model_prediction = split_predict_aggregate(
            spect=spect,
            chunk_size=1500,
            border_size=6,
            overlap_mode="keep_first",
            model=predictor.model,
        )
        beat_logits = model_prediction["beat"].float()
        downbeat_logits = model_prediction["downbeat"].float()

    return predictor.frames2beats(beat_logits, downbeat_logits)


def _predict_beats(
    predictor: Audio2Beats,
    signal: np.ndarray,
    sample_rate: int,
    device: str,
    cpu_spect: LogMelSpect | None,
) -> tuple[Any, Any]:
    if cpu_spect is None or not _uses_accelerated_device(device):
        return predictor(signal, sample_rate)
    return _predict_beats_with_accelerated_device(predictor, cpu_spect, signal, sample_rate)


def serve(device: str, dbn: bool) -> int:
    predictor = Audio2Beats(checkpoint_path="final0", device=device, dbn=dbn)
    cpu_spect = LogMelSpect(device="cpu") if _uses_accelerated_device(device) else None
    _emit({"type": "ready"})

    while True:
        header_line = sys.stdin.buffer.readline()
        if not header_line:
            return 0

        try:
            header = json.loads(header_line.decode("utf-8"))
        except Exception as error:
            _emit({"type": "fatal", "error": f"invalid header json: {error}"})
            return 1

        command = str(header.get("type") or "").strip()
        request_id = str(header.get("requestId") or "").strip()

        if command == "shutdown":
            _emit({"type": "shutdown", "requestId": request_id})
            return 0

        if command != "analyze_pcm":
            _emit(
                {
                    "type": "error",
                    "requestId": request_id,
                    "error": f"unsupported command: {command or '<empty>'}",
                }
            )
            continue

        try:
            sample_rate = int(header.get("sampleRate") or 0)
            channels = int(header.get("channels") or 0)
            byte_length = int(header.get("byteLength") or 0)
            if sample_rate <= 0:
                raise RuntimeError("sampleRate must be positive")
            if channels <= 0:
                raise RuntimeError("channels must be positive")
            if byte_length <= 0:
                raise RuntimeError("byteLength must be positive")

            pcm_bytes = _read_exact(byte_length)
            signal = _decode_signal(pcm_bytes, channels)
            duration_sec = signal.shape[0] / float(sample_rate) if sample_rate > 0 else 0.0
            beats, downbeats = _predict_beats(predictor, signal, sample_rate, device, cpu_spect)
            beat_list = _to_float_list(beats)
            downbeat_list = _to_float_list(downbeats)
            bpm = _derive_bpm(beat_list)
            if bpm is None:
                raise RuntimeError("Beat This! did not produce a valid BPM")
            if not beat_list:
                raise RuntimeError("Beat This! did not produce any beats")
            beat_interval = _derive_interval(beat_list)
            if beat_interval is None:
                raise RuntimeError("Beat This! did not produce a stable beat interval")

            expected_beat_count = duration_sec / beat_interval if beat_interval > 0 else 0.0
            expected_downbeat_count = expected_beat_count / 4.0 if expected_beat_count > 0 else 0.0
            beat_coverage_score = _clamp01(
                len(beat_list) / max(8.0, expected_beat_count * 0.85 if expected_beat_count > 0 else 8.0)
            )
            downbeat_coverage_score = _clamp01(
                len(downbeat_list)
                / max(2.0, expected_downbeat_count * 0.6 if expected_downbeat_count > 0 else 2.0)
            )
            beat_stability_score = _derive_stability(beat_list, beat_interval, 1.0)
            downbeat_stability_score = _derive_stability(downbeat_list, beat_interval, 4.0)
            quality_score = (
                beat_coverage_score * 0.4
                + beat_stability_score * 0.35
                + downbeat_coverage_score * 0.1
                + downbeat_stability_score * 0.15
            )

            _emit(
                {
                    "type": "result",
                    "requestId": request_id,
                    "result": {
                        "bpm": bpm,
                        "firstBeatMs": beat_list[0] * 1000.0,
                        "barBeatOffset": _derive_bar_beat_offset(beat_list, downbeat_list),
                        "beatCount": len(beat_list),
                        "downbeatCount": len(downbeat_list),
                        "durationSec": duration_sec,
                        "beatIntervalSec": beat_interval,
                        "beatCoverageScore": beat_coverage_score,
                        "beatStabilityScore": beat_stability_score,
                        "downbeatCoverageScore": downbeat_coverage_score,
                        "downbeatStabilityScore": downbeat_stability_score,
                        "qualityScore": quality_score,
                    },
                }
            )
        except Exception as error:
            _emit({"type": "error", "requestId": request_id, "error": str(error)})


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--serve":
        device = args[1] if len(args) >= 2 and args[1].strip() else "cpu"
        dbn = len(args) >= 3 and args[2].strip().lower() in {"1", "true", "yes", "on"}
        return serve(device=device, dbn=dbn)

    _emit({"type": "fatal", "error": "bridge only supports --serve mode"})
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
