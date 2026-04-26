import math
from typing import Any

import numpy as np
import soxr
import torch

from beat_this.inference import Audio2Beats, split_predict_aggregate
from beat_this.preprocessing import LogMelSpect

def _uses_accelerated_device(device: str) -> bool:
    normalized = str(device or "").strip().lower()
    return normalized not in {"", "cpu"}


def _predict_frame_logits_with_accelerated_device(
    predictor: Audio2Beats,
    cpu_spect: LogMelSpect,
    signal: np.ndarray,
    sample_rate: int,
) -> tuple[np.ndarray, np.ndarray]:
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

    return (
        beat_logits.detach().cpu().numpy().astype("float64", copy=False),
        downbeat_logits.detach().cpu().numpy().astype("float64", copy=False),
    )


def _predict_frame_logits(
    predictor: Audio2Beats,
    signal: np.ndarray,
    sample_rate: int,
    device: str,
    cpu_spect: LogMelSpect | None,
) -> tuple[np.ndarray, np.ndarray]:
    if cpu_spect is not None and _uses_accelerated_device(device):
        return _predict_frame_logits_with_accelerated_device(
            predictor,
            cpu_spect,
            signal,
            sample_rate,
        )

    spect = predictor.signal2spect(signal, sample_rate)
    beat_logits, downbeat_logits = predictor.spect2frames(spect)
    return (
        beat_logits.detach().cpu().numpy().astype("float64", copy=False),
        downbeat_logits.detach().cpu().numpy().astype("float64", copy=False),
    )


def _sample_frame_values(frame_values: np.ndarray, times_sec: np.ndarray) -> np.ndarray:
    if frame_values.size == 0 or times_sec.size == 0:
        return np.asarray([], dtype="float64")
    frame_positions = times_sec.astype("float64", copy=False) * 50.0
    valid_mask = (frame_positions >= 0.0) & (frame_positions <= float(frame_values.size - 1))
    if not np.any(valid_mask):
        return np.asarray([], dtype="float64")

    valid_positions = frame_positions[valid_mask]
    left_indices = np.floor(valid_positions).astype(np.int64, copy=False)
    fractions = valid_positions - left_indices
    right_indices = np.minimum(left_indices + 1, frame_values.size - 1)
    return frame_values[left_indices] * (1.0 - fractions) + frame_values[right_indices] * fractions


def _grid_times_for_phase(
    phase_ms: float,
    bpm: float,
    duration_sec: float,
    *,
    beat_step: int = 1,
) -> np.ndarray:
    if (
        not math.isfinite(phase_ms)
        or not math.isfinite(bpm)
        or bpm <= 0.0
        or not math.isfinite(duration_sec)
        or duration_sec <= 0.0
        or beat_step <= 0
    ):
        return np.asarray([], dtype="float64")

    interval_sec = (60.0 / bpm) * float(beat_step)
    if interval_sec <= 0.0:
        return np.asarray([], dtype="float64")

    phase_sec = phase_ms / 1000.0
    start_index = int(math.ceil((-phase_sec) / interval_sec))
    end_index = int((duration_sec - phase_sec) / interval_sec) + 1
    if end_index < start_index:
        return np.asarray([], dtype="float64")

    indices = np.arange(start_index, end_index + 1, dtype="float64")
    times = phase_sec + indices * interval_sec
    return times[(times >= 0.0) & (times < duration_sec)]


def _score_frame_grid(
    frame_values: np.ndarray,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
    *,
    beat_step: int = 1,
) -> tuple[float, int]:
    times_sec = _grid_times_for_phase(phase_ms, bpm, duration_sec, beat_step=beat_step)
    values = _sample_frame_values(frame_values, times_sec)
    if values.size == 0:
        return -999.0, 0
    return float(np.mean(values)), int(values.size)


def _find_best_logit_phase_ms(
    beat_logits: np.ndarray,
    bpm: float,
    duration_sec: float,
) -> tuple[float, float, int] | None:
    if beat_logits.size == 0 or not math.isfinite(bpm) or bpm <= 0.0:
        return None

    beat_interval_ms = 60000.0 / bpm
    if not math.isfinite(beat_interval_ms) or beat_interval_ms <= 0.0:
        return None

    best_score = -999.0
    best_phase_ms = 0.0
    best_support = 0

    phase_ms = -30.0
    while phase_ms < beat_interval_ms:
        score, support = _score_frame_grid(beat_logits, bpm, phase_ms, duration_sec)
        if support >= 16 and score > best_score:
            best_score = score
            best_phase_ms = phase_ms % beat_interval_ms
            best_support = support
        phase_ms += 1.0

    phase_ms = best_phase_ms - 3.0
    while phase_ms <= best_phase_ms + 3.0:
        score, support = _score_frame_grid(beat_logits, bpm, phase_ms, duration_sec)
        if support >= 16 and score > best_score:
            best_score = score
            best_phase_ms = phase_ms % beat_interval_ms
            best_support = support
        phase_ms += 0.25

    if best_support < 16:
        return None
    return best_phase_ms, best_score, best_support


def _signed_phase_ms(phase_ms: float, beat_interval_ms: float) -> float:
    if not math.isfinite(phase_ms) or not math.isfinite(beat_interval_ms) or beat_interval_ms <= 0.0:
        return phase_ms
    normalized = phase_ms % beat_interval_ms
    return normalized - beat_interval_ms if beat_interval_ms - normalized <= 80.0 else normalized


def _score_downbeat_bars(
    downbeat_logits: np.ndarray,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
) -> list[tuple[int, float, int]]:
    beat_interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
    if beat_interval_ms <= 0.0:
        return []
    signed_phase_ms = _signed_phase_ms(phase_ms, beat_interval_ms)
    scores: list[tuple[int, float, int]] = []
    for bar_offset in range(4):
        score, support = _score_frame_grid(
            downbeat_logits,
            bpm,
            signed_phase_ms + float(bar_offset) * beat_interval_ms,
            duration_sec,
            beat_step=4,
        )
        scores.append((bar_offset, score, support))
    return scores


def _select_downbeat_bar_offset(
    downbeat_logits: np.ndarray,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
    current_bar_offset: int,
) -> tuple[int, float]:
    scores = _score_downbeat_bars(downbeat_logits, bpm, phase_ms, duration_sec)
    valid_scores = [item for item in scores if item[2] >= 4 and math.isfinite(item[1])]
    if not valid_scores:
        return current_bar_offset % 4, 0.0
    ordered = sorted(valid_scores, key=lambda item: item[1], reverse=True)
    best_bar, best_score, _support = ordered[0]
    current_score = next(
        (score for bar, score, support in valid_scores if bar == current_bar_offset % 4 and support >= 4),
        -999.0,
    )
    margin = best_score - current_score
    if best_bar != current_bar_offset % 4 and margin < 1.0:
        return current_bar_offset % 4, margin
    return best_bar % 4, margin


def _is_integer_bpm(value: float) -> bool:
    return math.isfinite(value) and abs(value - round(value)) <= 0.000001


def _select_full_track_rescue_bpm(result: dict[str, Any]) -> float:
    bpm = float(result.get("bpm") or 0.0)
    raw_bpm = float(result.get("rawBpm") or bpm)
    first_beat_ms = float(result.get("firstBeatMs") or 0.0)
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    if not math.isfinite(bpm) or bpm <= 0.0:
        return bpm
    if (
        _is_integer_bpm(bpm)
        and math.isfinite(raw_bpm)
        and raw_bpm > 0.0
        and raw_bpm < bpm
        and bpm < 175.0
        and first_beat_ms <= 1.0
        and 0.0125 < bpm - raw_bpm <= 0.025
        and 4.0 < drift_128_ms <= 10.0
    ):
        return round(raw_bpm, 2)
    return bpm


def _is_centibpm_quantized(value: float) -> bool:
    return math.isfinite(value) and abs(value * 100.0 - round(value * 100.0)) <= 0.0001


def _refine_non_integer_bpm_from_logits(
    beat_logits: np.ndarray,
    bpm: float,
    duration_sec: float,
    result: dict[str, Any],
) -> tuple[float, dict[str, float] | None]:
    if _is_integer_bpm(bpm) or _is_centibpm_quantized(bpm):
        return bpm, None
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    if drift_128_ms < 8.0:
        return bpm, None

    current_candidate = _find_best_logit_phase_ms(beat_logits, bpm, duration_sec)
    if current_candidate is None:
        return bpm, None
    _current_phase_ms, current_score, _current_support = current_candidate

    best_bpm = bpm
    best_score = float(current_score)
    for step in range(-30, 31):
        candidate_bpm = bpm + float(step) * 0.001
        if candidate_bpm <= 0.0:
            continue
        candidate = _find_best_logit_phase_ms(beat_logits, candidate_bpm, duration_sec)
        if candidate is None:
            continue
        _phase_ms, score, _support = candidate
        if score > best_score:
            best_score = float(score)
            best_bpm = candidate_bpm

    nearest_integer = round(bpm)
    if abs(bpm - float(nearest_integer)) <= 0.05:
        integer_candidate = _find_best_logit_phase_ms(
            beat_logits,
            float(nearest_integer),
            duration_sec,
        )
        if integer_candidate is not None:
            _phase_ms, score, _support = integer_candidate
            if score > best_score:
                best_score = float(score)
                best_bpm = float(nearest_integer)

    score_gain = (best_score - float(current_score)) / max(1e-9, best_score, float(current_score))
    quantized_bpm = round(best_bpm, 2)
    required_score_gain = 0.005 if abs(best_bpm - float(round(best_bpm))) <= 0.000001 else 0.01
    if score_gain < required_score_gain or abs(quantized_bpm - bpm) < 0.0005:
        return bpm, None
    return quantized_bpm, {
        "sourceBpm": bpm,
        "bestLogitBpm": best_bpm,
        "scoreGain": score_gain,
    }


def _should_attempt_broad_logit_bpm_rescue(result: dict[str, Any]) -> bool:
    bpm = float(result.get("bpm") or 0.0)
    if not math.isfinite(bpm) or bpm <= 0.0:
        return False
    quality = float(result.get("qualityScore") or 0.0)
    drift_128_ms = abs(float(result.get("beatThisEstimatedDrift128Ms") or 0.0))
    beat_count = int(result.get("beatCount") or 0)
    has_low_quality_large_drift = quality < 0.72 and drift_128_ms >= 1000.0 and beat_count >= 32
    has_high_quality_non_integer_drift = (
        quality >= 0.9
        and not _is_integer_bpm(bpm)
        and drift_128_ms >= 100.0
        and beat_count >= 48
    )
    return 90.0 <= bpm <= 180.0 and (
        has_low_quality_large_drift or has_high_quality_non_integer_drift
    )


def _find_broad_logit_bpm_candidate(
    beat_logits: np.ndarray,
    bpm: float,
    duration_sec: float,
) -> dict[str, float] | None:
    current_candidate = _find_best_logit_phase_ms(beat_logits, bpm, duration_sec)
    if current_candidate is None:
        return None
    current_phase_ms, current_score, current_support = current_candidate

    best_bpm = bpm
    best_phase_ms = current_phase_ms
    best_score = float(current_score)
    best_support = int(current_support)

    for step in range(360):
        candidate_bpm = 90.0 + float(step) * 0.25
        candidate = _find_best_logit_phase_ms(beat_logits, candidate_bpm, duration_sec)
        if candidate is None:
            continue
        phase_ms, score, support = candidate
        if score > best_score:
            best_bpm = candidate_bpm
            best_phase_ms = phase_ms
            best_score = float(score)
            best_support = int(support)

    refined_start = best_bpm - 0.24
    for step in range(49):
        candidate_bpm = refined_start + float(step) * 0.01
        if candidate_bpm < 90.0 or candidate_bpm > 180.0:
            continue
        candidate = _find_best_logit_phase_ms(beat_logits, candidate_bpm, duration_sec)
        if candidate is None:
            continue
        phase_ms, score, support = candidate
        if score > best_score:
            best_bpm = candidate_bpm
            best_phase_ms = phase_ms
            best_score = float(score)
            best_support = int(support)

    score_gain = best_score - float(current_score)
    if score_gain < 0.12 or abs(best_bpm - bpm) < max(0.5, bpm * 0.004):
        return None

    return {
        "sourceBpm": bpm,
        "sourcePhaseMs": current_phase_ms,
        "sourceScore": float(current_score),
        "sourceSupport": float(current_support),
        "bestBpm": round(best_bpm),
        "bestLogitBpm": best_bpm,
        "bestPhaseMs": best_phase_ms,
        "bestScore": best_score,
        "bestSupport": float(best_support),
        "scoreGain": score_gain,
    }

