import math
from typing import Any

import numpy as np

FRAME_SIZE = 256
HOP_SIZE = 128
MIN_BPM = 55.0
MAX_BPM = 210.0
MIN_DURATION_SEC = 8.0
PHASE_PEAK_RADIUS_FRAMES = 5
MAX_TEMPO_CANDIDATES = 14
MAX_PHASE_CANDIDATES_PER_TEMPO = 8
BPM_INTEGER_SNAP_THRESHOLD = 0.18
HEAD_PREZERO_THRESHOLD_MS = 2.0
SUBDIVISION_RESCUE_GRID_FLOOR = 0.62
SUBDIVISION_RESCUE_SCORE_DROP_LIMIT = 0.13
SUBDIVISION_RESCUE_RULES = (
    ("third-subdivision", 1.5, (1.0 / 3.0, 2.0 / 3.0), 0.82, 118.0),
    ("half-subdivision", 2.0, (0.5,), 0.68, 78.0),
    ("fifth-subdivision", 2.5, (0.4, 0.6, 0.8), 0.82, 84.0),
)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(np.median(np.asarray(values, dtype=np.float64)))


def _percentile(values: np.ndarray | list[float], ratio: float) -> float:
    array = np.asarray(values, dtype=np.float64)
    if array.size <= 0:
        return 0.0
    return float(np.percentile(array, _clamp01(ratio) * 100.0))


def _decode_signal(pcm_bytes: bytes, channels: int) -> np.ndarray:
    if channels <= 0:
        raise RuntimeError("channels must be positive")
    samples = np.frombuffer(pcm_bytes, dtype="<f4")
    usable_samples = samples.size - (samples.size % channels)
    if usable_samples <= 0:
        raise RuntimeError("PCM data is empty")
    samples = samples[:usable_samples]
    if channels == 1:
        return samples.astype("float64", copy=False)
    return samples.reshape((-1, channels)).mean(axis=1).astype("float64", copy=False)


def _window_sums(values: np.ndarray, frame_count: int) -> np.ndarray:
    starts = np.arange(frame_count, dtype=np.int64) * HOP_SIZE
    cumulative = np.concatenate(([0.0], np.cumsum(values, dtype=np.float64)))
    return cumulative[starts + FRAME_SIZE] - cumulative[starts]


def _build_onset_envelope(signal: np.ndarray) -> np.ndarray:
    frame_count = int((signal.shape[0] - FRAME_SIZE) // HOP_SIZE) + 1
    if frame_count <= 4:
        return np.zeros((0,), dtype=np.float64)

    squared = signal * signal
    delta = np.diff(signal, prepend=signal[0])
    high_squared = delta * delta
    energy = np.log1p((_window_sums(squared, frame_count) / float(FRAME_SIZE)) * 10000.0)
    high_energy = np.log1p((_window_sums(high_squared, frame_count) / float(FRAME_SIZE)) * 10000.0)

    onset = np.zeros((frame_count,), dtype=np.float64)
    for index in range(1, frame_count):
        energy_base = max(float(energy[index - 1]), float(energy[index - 2]) * 0.96 if index > 1 else 0.0)
        high_base = max(
            float(high_energy[index - 1]),
            float(high_energy[index - 2]) * 0.94 if index > 1 else 0.0,
        )
        onset[index] = max(0.0, float(energy[index]) - energy_base) + max(
            0.0,
            float(high_energy[index]) - high_base,
        ) * 0.8

    positive = onset[onset > 0.0]
    floor = _percentile(positive, 0.45) * 0.55
    onset = np.maximum(0.0, onset - floor)
    mean = float(np.mean(onset)) if onset.size else 0.0
    std = float(np.std(onset)) if onset.size else 0.0
    scale = std or mean or 1.0
    return np.sqrt(np.maximum(0.0, (onset - mean * 0.3) / scale))


def _normalized_correlation(envelope: np.ndarray, lag: int) -> float:
    if lag <= 1 or lag >= envelope.shape[0]:
        return 0.0
    left = envelope[lag:]
    right = envelope[:-lag]
    numerator = float(np.sum(left * right))
    denominator = math.sqrt(float(np.sum(left * left)) * float(np.sum(right * right)))
    return numerator / denominator if denominator > 0.0 else 0.0


def _score_tempo_lag(envelope: np.ndarray, lag: int) -> float:
    direct = _normalized_correlation(envelope, lag)
    double = _normalized_correlation(envelope, lag * 2) if lag * 2 < envelope.shape[0] else 0.0
    triple = _normalized_correlation(envelope, lag * 3) if lag * 3 < envelope.shape[0] else 0.0
    half = _normalized_correlation(envelope, max(2, round(lag / 2.0))) if lag > 3 else 0.0
    return direct + double * 0.48 + triple * 0.18 - half * 0.1


def _add_tempo_candidate(candidates: list[dict[str, float]], candidate: dict[str, float]) -> None:
    bpm = float(candidate["bpm"])
    if not math.isfinite(bpm) or bpm < MIN_BPM or bpm > MAX_BPM:
        return
    if any(abs(float(item["bpm"]) - bpm) < 0.35 for item in candidates):
        return
    candidates.append(candidate)


def _estimate_tempo_candidates(envelope: np.ndarray, hop_sec: float) -> list[dict[str, float]]:
    min_lag = max(2, int(math.floor(60.0 / MAX_BPM / hop_sec)))
    max_lag = min(envelope.shape[0] - 2, int(math.ceil(60.0 / MIN_BPM / hop_sec)))
    scored: list[dict[str, float]] = []
    for lag in range(min_lag, max_lag + 1):
        score = _score_tempo_lag(envelope, lag)
        if score > 0.0:
            scored.append({"lag": float(lag), "score": score})

    scored.sort(key=lambda item: float(item["score"]), reverse=True)
    candidates: list[dict[str, float]] = []
    for item in scored[:28]:
        lag = int(item["lag"])
        center_score = float(item["score"])
        previous_score = _score_tempo_lag(envelope, lag - 1)
        next_score = _score_tempo_lag(envelope, lag + 1)
        denominator = previous_score - center_score * 2.0 + next_score
        delta = (
            max(-0.45, min(0.45, (previous_score - next_score) / (2.0 * denominator)))
            if abs(denominator) > 0.000001
            else 0.0
        )
        lag_frames = max(2.0, float(lag) + delta)
        bpm = 60.0 / (lag_frames * hop_sec)
        _add_tempo_candidate(candidates, {"bpm": bpm, "lagFrames": lag_frames, "score": center_score})
        if bpm < 105.0:
            _add_tempo_candidate(
                candidates,
                {"bpm": bpm * 2.0, "lagFrames": lag_frames / 2.0, "score": center_score * 0.94},
            )
        if bpm > 135.0:
            _add_tempo_candidate(
                candidates,
                {"bpm": bpm / 2.0, "lagFrames": lag_frames * 2.0, "score": center_score * 0.82},
            )
        if len(candidates) >= MAX_TEMPO_CANDIDATES:
            break
    candidates.sort(key=lambda item: float(item["score"]), reverse=True)
    return candidates


def _sample_envelope(envelope: np.ndarray, frame_index: float) -> float:
    index = int(round(frame_index))
    if index < 0 or index >= envelope.shape[0]:
        return 0.0
    return float(envelope[index])


def _local_peak(envelope: np.ndarray, center_frame: float, radius: int) -> tuple[float, float, float]:
    start = max(0, int(math.floor(center_frame - float(radius))))
    end = min(envelope.shape[0] - 1, int(math.ceil(center_frame + float(radius))))
    if end < start:
        return center_frame, 0.0, 0.0
    window = envelope[start : end + 1]
    relative_index = int(np.argmax(window))
    frame = float(start + relative_index)
    value = float(window[relative_index])
    return frame, value, frame - center_frame


def _score_phase_seed(envelope: np.ndarray, lag_frames: float, phase_frame: float, hit_threshold: float) -> dict[str, float]:
    strength = 0.0
    hits = 0
    beats = 0
    midpoint_strength = 0.0
    beat_frame = phase_frame
    while beat_frame < envelope.shape[0]:
        _frame, value, _offset = _local_peak(envelope, beat_frame, PHASE_PEAK_RADIUS_FRAMES)
        strength += value
        if value >= hit_threshold:
            hits += 1
        midpoint_strength += _local_peak(envelope, beat_frame + lag_frames * 0.5, 2)[1]
        beats += 1
        beat_frame += lag_frames
    mean_strength = strength / float(beats) if beats > 0 else 0.0
    midpoint_ratio = midpoint_strength / strength if strength > 0.0 else 0.0
    coverage = float(hits) / float(beats) if beats > 0 else 0.0
    score = mean_strength * (0.65 + coverage * 0.35) * (1.0 - _clamp01(midpoint_ratio) * 0.28)
    return {"phaseFrame": phase_frame, "score": score}


def _select_phase_seeds(envelope: np.ndarray, lag_frames: float, hit_threshold: float) -> list[dict[str, float]]:
    phase_limit = max(2, int(round(lag_frames)))
    seeds = [_score_phase_seed(envelope, lag_frames, float(phase), hit_threshold) for phase in range(phase_limit)]
    seeds.sort(key=lambda item: float(item["score"]), reverse=True)
    selected: list[dict[str, float]] = []
    min_distance = max(2.0, lag_frames * 0.06)
    for seed in seeds:
        phase = float(seed["phaseFrame"])
        too_close = False
        for item in selected:
            distance = abs(float(item["phaseFrame"]) - phase)
            if min(distance, lag_frames - distance) < min_distance:
                too_close = True
                break
        if too_close:
            continue
        selected.append(seed)
        if len(selected) >= MAX_PHASE_CANDIDATES_PER_TEMPO:
            break
    return selected


def _refine_phase_frame(envelope: np.ndarray, lag_frames: float, phase_frame: float) -> float:
    weighted_offset = 0.0
    weight_sum = 0.0
    beat_frame = phase_frame
    while beat_frame < envelope.shape[0]:
        _frame, value, offset = _local_peak(envelope, beat_frame, PHASE_PEAK_RADIUS_FRAMES)
        weighted_offset += offset * value
        weight_sum += value
        beat_frame += lag_frames
    if weight_sum <= 0.0:
        return phase_frame
    correction = max(-float(PHASE_PEAK_RADIUS_FRAMES), min(float(PHASE_PEAK_RADIUS_FRAMES), weighted_offset / weight_sum))
    return phase_frame + correction


def _estimate_downbeat(envelope: np.ndarray, lag_frames: float, phase_frame: float) -> tuple[int, float]:
    scores = [0.0, 0.0, 0.0, 0.0]
    counts = [0, 0, 0, 0]
    beat_index = 0
    beat_frame = phase_frame
    while beat_frame < envelope.shape[0]:
        modulo = beat_index % 4
        _frame, value, _offset = _local_peak(envelope, beat_frame, PHASE_PEAK_RADIUS_FRAMES)
        next_value = _local_peak(envelope, beat_frame + lag_frames, PHASE_PEAK_RADIUS_FRAMES)[1]
        scores[modulo] += value + max(0.0, value - next_value) * 0.18
        counts[modulo] += 1
        beat_index += 1
        beat_frame += lag_frames

    normalized = [scores[index] / counts[index] if counts[index] > 0 else 0.0 for index in range(4)]
    best_offset = max(range(4), key=lambda index: normalized[index])
    average = sum(normalized) / 4.0 or 1.0
    return best_offset, _clamp01((normalized[best_offset] - average) / max(average, 0.0001))


def _score_grid(
    envelope: np.ndarray,
    bpm: float,
    lag_frames: float,
    phase_frame: float,
    hop_sec: float,
    hit_threshold: float,
) -> dict[str, float]:
    refined_phase = _refine_phase_frame(envelope, lag_frames, phase_frame)
    interval_ms = 60000.0 / bpm
    frame_center_offset_sec = (float(FRAME_SIZE) / (2.0 * float(HOP_SIZE))) * hop_sec
    raw_phase_ms = (refined_phase * hop_sec + frame_center_offset_sec) * 1000.0
    phase_ms = raw_phase_ms % interval_ms
    strengths: list[float] = []
    errors: list[float] = []
    midpoint_strength = 0.0
    hits = 0
    beat_frame = refined_phase
    while beat_frame < envelope.shape[0]:
        _frame, value, offset = _local_peak(envelope, beat_frame, PHASE_PEAK_RADIUS_FRAMES)
        strengths.append(value)
        errors.append(abs(offset))
        if value >= hit_threshold:
            hits += 1
        midpoint_strength += _local_peak(envelope, beat_frame + lag_frames * 0.5, 2)[1]
        beat_frame += lag_frames

    beat_count = len(strengths)
    strength_sum = sum(strengths)
    mean_strength = strength_sum / float(beat_count) if beat_count > 0 else 0.0
    median_error_frames = _median(errors)
    coverage = _clamp01(float(hits) / float(beat_count)) if beat_count > 0 else 0.0
    consistency = _clamp01(1.0 - (median_error_frames * hop_sec * 1000.0) / 18.0)
    midpoint_penalty = _clamp01(midpoint_strength / strength_sum) if strength_sum > 0.0 else 0.0
    downbeat_offset, downbeat_score = _estimate_downbeat(envelope, lag_frames, refined_phase)
    score = (
        _clamp01(mean_strength / 2.2) * 0.28
        + coverage * 0.22
        + consistency * 0.22
        + downbeat_score * 0.08
        + (1.0 - midpoint_penalty) * 0.2
    )
    return {
        "phaseFrame": refined_phase,
        "phaseMs": phase_ms,
        "score": _clamp01(score),
        "beatCount": float(beat_count),
        "hitCount": float(hits),
        "meanBeatStrength": mean_strength,
        "medianErrorFrames": median_error_frames,
        "coverageScore": coverage,
        "consistencyScore": consistency,
        "midpointPenalty": midpoint_penalty,
        "downbeatOffset": float(downbeat_offset),
        "downbeatScore": downbeat_score,
    }


def _fractional_support_ratio(
    envelope: np.ndarray,
    lag_frames: float,
    phase_frame: float,
    fractions: tuple[float, ...],
) -> float:
    beat_strength = 0.0
    subdivision_strength = 0.0
    beat_count = 0
    subdivision_count = 0
    beat_frame = phase_frame
    while beat_frame < envelope.shape[0]:
        beat_strength += _local_peak(envelope, beat_frame, PHASE_PEAK_RADIUS_FRAMES)[1]
        beat_count += 1
        for fraction in fractions:
            subdivision_strength += _local_peak(envelope, beat_frame + lag_frames * fraction, 2)[1]
            subdivision_count += 1
        beat_frame += lag_frames

    if beat_count <= 0 or subdivision_count <= 0 or beat_strength <= 0.0:
        return 0.0
    return (subdivision_strength / float(subdivision_count)) / (beat_strength / float(beat_count))


def _snap_integer_bpm(bpm: float) -> float:
    rounded = round(bpm)
    if abs(float(bpm) - float(rounded)) <= BPM_INTEGER_SNAP_THRESHOLD:
        return float(rounded)
    return bpm


def _normalize_head_phase_ms(phase_ms: float, interval_ms: float) -> float:
    if interval_ms <= 0.0 or not math.isfinite(interval_ms):
        return phase_ms
    if interval_ms - phase_ms <= HEAD_PREZERO_THRESHOLD_MS:
        return phase_ms - interval_ms
    return phase_ms


def _select_subdivision_rescue(
    envelope: np.ndarray,
    hop_sec: float,
    hit_threshold: float,
    base_bpm: float,
    base_grid: dict[str, float],
) -> tuple[str, float, dict[str, float]] | None:
    if base_bpm <= 0.0 or not math.isfinite(base_bpm):
        return None

    base_lag_frames = 60.0 / base_bpm / hop_sec
    base_phase_frame = float(base_grid["phaseFrame"])
    base_score = float(base_grid["score"])
    best: tuple[float, str, float, dict[str, float]] | None = None

    for label, multiplier, fractions, min_support, max_base_bpm in SUBDIVISION_RESCUE_RULES:
        if base_bpm > max_base_bpm:
            continue
        support_ratio = _fractional_support_ratio(
            envelope,
            base_lag_frames,
            base_phase_frame,
            fractions,
        )
        if support_ratio < min_support:
            continue

        candidate_bpm = _snap_integer_bpm(base_bpm * multiplier)
        if candidate_bpm < MIN_BPM or candidate_bpm > MAX_BPM:
            continue

        candidate_lag_frames = 60.0 / candidate_bpm / hop_sec
        if candidate_lag_frames <= 1.0 or not math.isfinite(candidate_lag_frames):
            continue

        candidate_phase_frame = base_phase_frame % candidate_lag_frames
        candidate_grid = _score_grid(
            envelope,
            candidate_bpm,
            candidate_lag_frames,
            candidate_phase_frame,
            hop_sec,
            hit_threshold,
        )
        candidate_score = float(candidate_grid["score"])
        if candidate_score < SUBDIVISION_RESCUE_GRID_FLOOR:
            continue
        if candidate_score + SUBDIVISION_RESCUE_SCORE_DROP_LIMIT < base_score:
            continue

        ranking_score = candidate_score + min(1.25, support_ratio) * 0.08
        if best is None or ranking_score > best[0]:
            best = (ranking_score, label, candidate_bpm, candidate_grid)

    if best is None:
        return None
    _ranking_score, label, candidate_bpm, candidate_grid = best
    return label, candidate_bpm, candidate_grid


def _solve_classic_grid_lines(envelope: np.ndarray, hop_sec: float, duration_sec: float) -> dict[str, Any]:
    tempo_candidates = _estimate_tempo_candidates(envelope, hop_sec)
    if not tempo_candidates:
        raise RuntimeError("classic grid-line analyzer found no stable tempo candidate")

    positive = envelope[envelope > 0.0]
    hit_threshold = max(0.08, _percentile(positive, 0.72))
    best_tempo = tempo_candidates[0]
    best_grid: dict[str, float] | None = None
    best_score = -1.0
    for tempo in tempo_candidates:
        lag_frames = float(tempo["lagFrames"])
        for seed in _select_phase_seeds(envelope, lag_frames, hit_threshold):
            grid = _score_grid(
                envelope,
                float(tempo["bpm"]),
                lag_frames,
                float(seed["phaseFrame"]),
                hop_sec,
                hit_threshold,
            )
            tempo_confidence = _clamp01(float(tempo["score"]) / max(float(tempo["score"]) + 0.16, 0.0001))
            candidate_score = float(grid["score"]) * 0.82 + tempo_confidence * 0.18
            if candidate_score > best_score:
                best_tempo = tempo
                best_grid = grid
                best_score = candidate_score

    if best_grid is None:
        raise RuntimeError("classic grid-line analyzer found no stable phase candidate")

    bpm = float(best_tempo["bpm"])
    raw_bpm = bpm
    anchor_strategy = "classic-grid-line-lattice-v3"
    rescue = _select_subdivision_rescue(envelope, hop_sec, hit_threshold, bpm, best_grid)
    if rescue is not None:
        rescue_label, bpm, best_grid = rescue
        anchor_strategy = f"classic-grid-line-lattice-v3-{rescue_label}"

    beat_interval_sec = 60.0 / bpm
    interval_ms = beat_interval_sec * 1000.0
    first_beat_ms = _normalize_head_phase_ms(float(best_grid["phaseMs"]), interval_ms)
    tempo_score = _clamp01(float(best_tempo["score"]) / max(float(best_tempo["score"]) + 0.16, 0.0001))
    quality = _clamp01(float(best_grid["score"]) * 0.75 + tempo_score * 0.25)
    return {
        "bpm": round(bpm, 6),
        "rawBpm": round(raw_bpm, 6),
        "firstBeatMs": round(first_beat_ms, 3),
        "rawFirstBeatMs": round(first_beat_ms, 3),
        "absoluteFirstBeatMs": round(first_beat_ms, 3),
        "absoluteRawFirstBeatMs": round(first_beat_ms, 3),
        "barBeatOffset": int(best_grid["downbeatOffset"]) % 32,
        "beatCount": int(best_grid["beatCount"]),
        "downbeatCount": int(best_grid["beatCount"]) // 4,
        "durationSec": round(duration_sec, 3),
        "beatIntervalSec": round(beat_interval_sec, 6),
        "beatCoverageScore": round(float(best_grid["coverageScore"]), 6),
        "beatStabilityScore": round(float(best_grid["consistencyScore"]), 6),
        "downbeatCoverageScore": round(float(best_grid["coverageScore"]), 6),
        "downbeatStabilityScore": round(float(best_grid["downbeatScore"]), 6),
        "qualityScore": round(quality, 6),
        "anchorCorrectionMs": 0.0,
        "anchorConfidenceScore": round(float(best_grid["score"]), 6),
        "anchorMatchedBeatCount": int(best_grid["hitCount"]),
        "anchorStrategy": anchor_strategy,
        "windowStartSec": 0.0,
        "windowDurationSec": round(duration_sec, 3),
        "windowIndex": 0,
    }


def analyze_pcm(
    pcm_bytes: bytes,
    sample_rate: int,
    channels: int,
    source_file_path: str = "",
    max_scan_sec: float = 120.0,
    time_basis: dict[str, Any] | None = None,
) -> dict[str, Any]:
    del source_file_path, time_basis
    signal = _decode_signal(pcm_bytes, channels)
    usable_frames = min(signal.shape[0], int(max_scan_sec * sample_rate))
    signal = signal[:usable_frames]
    duration_sec = signal.shape[0] / float(sample_rate) if sample_rate > 0 else 0.0
    if duration_sec < MIN_DURATION_SEC:
        raise RuntimeError("classic grid-line analysis requires at least 8 seconds of PCM")

    envelope = _build_onset_envelope(signal)
    if envelope.shape[0] <= 4:
        raise RuntimeError("classic grid-line analyzer decoded too little onset data")

    result = _solve_classic_grid_lines(envelope, HOP_SIZE / float(sample_rate), duration_sec)
    return {"analyzerProvider": "classic", **result}
