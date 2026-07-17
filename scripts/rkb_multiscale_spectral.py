import math
from typing import Any

import numpy as np


MULTISCALE_SPECTRAL_VERSION = "rkb-multiscale-spectral-v1"
DEFAULT_SAMPLE_RATE = 44100
DEFAULT_HOP_LENGTH = 441
DEFAULT_FRAME_LENGTHS = {
    "short": 1024,
    "medium": 2048,
    "long": 4096,
}
DEFAULT_BANDS_HZ = {
    "low": (30.0, 220.0),
    "mid": (220.0, 2000.0),
    "high": (2000.0, 9000.0),
    "full": (30.0, 11000.0),
}


def multiscale_spectral_policy() -> dict[str, Any]:
    return {
        "version": MULTISCALE_SPECTRAL_VERSION,
        "sampleRate": DEFAULT_SAMPLE_RATE,
        "hopLength": DEFAULT_HOP_LENGTH,
        "frameLengths": dict(DEFAULT_FRAME_LENGTHS),
        "bandsHz": {key: list(value) for key, value in DEFAULT_BANDS_HZ.items()},
        "window": "hann-periodic-false",
        "center": True,
        "magnitude": "log1p-abs-rfft",
        "novelty": "positive-binwise-spectral-flux-mean",
        "normalization": "positive-p99-clip4",
    }


def mix_to_mono(signal: np.ndarray) -> np.ndarray:
    values = np.asarray(signal, dtype="float32")
    if values.ndim == 1:
        return values
    if values.ndim != 2 or values.shape[1] <= 0:
        raise ValueError(f"invalid audio signal shape: {values.shape}")
    return np.mean(values, axis=1, dtype="float32")


def _normalize_flux(values: np.ndarray) -> np.ndarray:
    flux = np.asarray(values, dtype="float32")
    flux = np.where(np.isfinite(flux), np.maximum(flux, 0.0), 0.0)
    positive = flux[flux > 0.0]
    if positive.size == 0:
        return np.zeros_like(flux, dtype="float32")
    scale = float(np.percentile(positive, 99.0))
    if not math.isfinite(scale) or scale <= 1e-9:
        scale = float(np.max(positive))
    if not math.isfinite(scale) or scale <= 1e-9:
        return np.zeros_like(flux, dtype="float32")
    return np.clip(flux / scale, 0.0, 4.0).astype("float32", copy=False)


def _band_slices(sample_rate: int, frame_length: int) -> dict[str, slice]:
    bin_hz = float(sample_rate) / float(frame_length)
    bin_count = frame_length // 2 + 1
    result: dict[str, slice] = {}
    for name, (low_hz, high_hz) in DEFAULT_BANDS_HZ.items():
        start = max(0, min(bin_count - 1, int(math.ceil(low_hz / bin_hz))))
        stop = max(start + 1, min(bin_count, int(math.floor(high_hz / bin_hz)) + 1))
        result[name] = slice(start, stop)
    return result


def _scale_flux(
    mono: np.ndarray,
    *,
    sample_rate: int,
    frame_length: int,
    hop_length: int,
    chunk_frames: int,
) -> dict[str, np.ndarray]:
    half = frame_length // 2
    padded = np.pad(mono, (half, half), mode="constant")
    frame_count = 1 + max(0, (padded.size - frame_length) // hop_length)
    if frame_count <= 0:
        return {name: np.asarray([], dtype="float32") for name in DEFAULT_BANDS_HZ}

    window = np.hanning(frame_length).astype("float32", copy=False)
    offsets = np.arange(frame_length, dtype="int64")
    slices = _band_slices(sample_rate, frame_length)
    chunks: dict[str, list[np.ndarray]] = {name: [] for name in slices}
    previous_magnitude: np.ndarray | None = None

    for chunk_start in range(0, frame_count, max(1, chunk_frames)):
        chunk_stop = min(frame_count, chunk_start + max(1, chunk_frames))
        starts = np.arange(chunk_start, chunk_stop, dtype="int64") * hop_length
        frames = padded[starts[:, None] + offsets[None, :]]
        spectrum = np.fft.rfft(frames * window[None, :], axis=1)
        magnitude = np.log1p(np.abs(spectrum)).astype("float32", copy=False)
        if previous_magnitude is None:
            previous_magnitude = magnitude[0].copy()
        extended = np.concatenate((previous_magnitude[None, :], magnitude), axis=0)
        positive_delta = np.maximum(np.diff(extended, axis=0), 0.0)
        for name, band_slice in slices.items():
            chunks[name].append(np.mean(positive_delta[:, band_slice], axis=1, dtype="float32"))
        previous_magnitude = magnitude[-1].copy()

    return {
        name: _normalize_flux(np.concatenate(parts) if parts else np.asarray([], dtype="float32"))
        for name, parts in chunks.items()
    }


def build_multiscale_spectral_flux(
    signal: np.ndarray,
    sample_rate: int,
    *,
    hop_length: int = DEFAULT_HOP_LENGTH,
    frame_lengths: dict[str, int] | None = None,
    chunk_frames: int = 256,
) -> tuple[dict[str, np.ndarray], float]:
    if sample_rate != DEFAULT_SAMPLE_RATE:
        raise ValueError(
            f"multiscale spectral v1 requires {DEFAULT_SAMPLE_RATE} Hz PCM, got {sample_rate}"
        )
    if hop_length <= 0:
        raise ValueError("hop_length must be positive")
    mono = mix_to_mono(signal)
    if mono.size < 64:
        return {}, float(sample_rate) / float(hop_length)
    scales = dict(frame_lengths or DEFAULT_FRAME_LENGTHS)
    output: dict[str, np.ndarray] = {}
    expected_count: int | None = None
    for scale_name, frame_length in scales.items():
        if frame_length <= 0:
            raise ValueError(f"invalid frame length for {scale_name}: {frame_length}")
        scale = _scale_flux(
            mono,
            sample_rate=sample_rate,
            frame_length=int(frame_length),
            hop_length=hop_length,
            chunk_frames=chunk_frames,
        )
        for band_name, values in scale.items():
            key = f"{scale_name}{band_name.capitalize()}Flux"
            output[key] = values
            if expected_count is None:
                expected_count = int(values.size)
            elif int(values.size) != expected_count:
                raise RuntimeError("multiscale spectral envelopes are not time aligned")
    return output, float(sample_rate) / float(hop_length)


def array_stats(values: np.ndarray) -> dict[str, Any]:
    finite = np.asarray(values, dtype="float64")
    finite = finite[np.isfinite(finite)]
    if finite.size == 0:
        return {"count": int(np.asarray(values).size), "mean": 0.0, "p95": 0.0, "max": 0.0}
    return {
        "count": int(finite.size),
        "mean": round(float(np.mean(finite)), 6),
        "p95": round(float(np.percentile(finite, 95.0)), 6),
        "max": round(float(np.max(finite)), 6),
    }
