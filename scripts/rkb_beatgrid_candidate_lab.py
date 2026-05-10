import argparse
import math
import statistics
import time
from pathlib import Path
from typing import Any

import numpy as np

from beat_this_full_logit_utils import (
    _find_best_logit_phase_ms,
    _score_frame_grid,
    _score_downbeat_bars,
)
from beat_this_grid_solver import moving_average
from rkb_runtime_candidate_utils import sigmoid_clip_range, to_float

def _sigmoid(values: np.ndarray) -> np.ndarray:
    min_value, max_value = sigmoid_clip_range()
    clipped = np.clip(values.astype("float64", copy=False), min_value, max_value)
    return 1.0 / (1.0 + np.exp(-clipped))
def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, value))
def _phase_delta_ms(value_ms: float, reference_ms: float, interval_ms: float) -> float:
    if not math.isfinite(interval_ms) or interval_ms <= 0.0:
        return value_ms - reference_ms
    return ((value_ms - reference_ms + interval_ms * 0.5) % interval_ms) - interval_ms * 0.5
def _normalize_phase_ms(value_ms: float, interval_ms: float) -> float:
    if not math.isfinite(value_ms) or not math.isfinite(interval_ms) or interval_ms <= 0.0:
        return 0.0
    return value_ms % interval_ms
def _window_weight(window: dict[str, Any]) -> float:
    quality = _clamp01(float(window.get("qualityScore") or 0.0))
    stability = _clamp01(float(window.get("beatStabilityScore") or 0.0))
    coverage = _clamp01(float(window.get("beatCoverageScore") or 0.0))
    beat_factor = _clamp01(float(window.get("beatCount") or 0.0) / 64.0)
    return max(0.001, quality * 0.45 + stability * 0.25 + coverage * 0.20 + beat_factor * 0.10)
def _is_integer_bpm(value: float) -> bool:
    return math.isfinite(value) and abs(value - round(value)) <= 0.000001
def _is_centibpm(value: float) -> bool:
    return math.isfinite(value) and abs(value * 100.0 - round(value * 100.0)) <= 0.0001
def _dedupe_candidates(
    candidates: list[dict[str, Any]],
    *,
    bpm_tolerance: float,
    phase_tolerance_ms: float | None = None,
    limit: int,
    bar_sensitive: bool = False,
) -> list[dict[str, Any]]:
    ordered = sorted(candidates, key=lambda item: float(item.get("score") or 0.0), reverse=True)
    deduped: list[dict[str, Any]] = []
    for candidate in ordered:
        bpm = float(candidate.get("bpm") or 0.0)
        phase = to_float(candidate.get("firstBeatMs"))
        duplicate = False
        for item in deduped:
            if abs(bpm - float(item.get("bpm") or 0.0)) > bpm_tolerance:
                continue
            if bar_sensitive and (
                int(candidate.get("barBeatOffset") or 0) % 4
                != int(item.get("barBeatOffset") or 0) % 4
            ):
                continue
            if phase_tolerance_ms is None:
                duplicate = True
                break
            item_phase = to_float(item.get("firstBeatMs"))
            if item_phase is not None and phase is not None and abs(item_phase - phase) <= phase_tolerance_ms:
                duplicate = True
                break
        if duplicate:
            continue
        deduped.append(candidate)
        if limit > 0 and len(deduped) >= limit:
            break
    return deduped
def _add_tempo_candidate(
    candidates: list[dict[str, Any]],
    *,
    bpm: float,
    source: str,
    score: float,
    window: dict[str, Any] | None,
    raw_bpm: float,
    octave_variant: str | None = None,
) -> None:
    if not math.isfinite(bpm) or bpm <= 0.0:
        return
    quantized_score = 1.0 if _is_integer_bpm(bpm) else (0.88 if _is_centibpm(bpm) else 0.35)
    octave_penalty = 0.18 if octave_variant else 0.0
    final_score = _clamp01(score * 0.72 + quantized_score * 0.28 - octave_penalty)
    features: dict[str, Any] = {
        "tempoScore": round(final_score, 6),
        "tempoBaseScore": round(score, 6),
        "tempoQuantizedScore": round(quantized_score, 6),
        "rawBpm": round(raw_bpm, 6),
    }
    if window is not None:
        features["windowIndex"] = int(window.get("windowIndex") or 0)
        features["windowWeight"] = round(_window_weight(window), 6)
    if octave_variant:
        features["octaveVariant"] = octave_variant
        features["octavePenalty"] = round(octave_penalty, 6)
    candidates.append(
        {
            "bpm": round(bpm, 6),
            "score": round(final_score, 6),
            "source": source,
            "features": features,
        }
    )

def _tempo_from_windows(
    metadata: dict[str, Any],
    *,
    min_bpm: float,
    max_bpm: float,
) -> list[dict[str, Any]]:
    windows = ((metadata.get("beatThis") or {}).get("windows")) or []
    candidates: list[dict[str, Any]] = []
    for window in windows:
        if not isinstance(window, dict):
            continue
        bpm = to_float(window.get("rawBpm"))
        if bpm is None or bpm <= 0.0:
            continue
        base_score = (
            float(window.get("qualityScore") or 0.0) * 0.5
            + float(window.get("beatStabilityScore") or 0.0) * 0.3
            + float(window.get("beatCoverageScore") or 0.0) * 0.2
        )
        for candidate_bpm, label, multiplier, variant_penalty in (
            (bpm, "raw", 1.0, 0.10),
            (round(bpm, 2), "centibpm", 1.0, 0.0),
            (float(round(bpm)), "integer", 1.0, 0.0),
            (bpm * 2.0, "double-raw", 2.0, 0.16),
            (round(bpm * 2.0, 2), "double-centibpm", 2.0, 0.12),
            (float(round(bpm * 2.0)), "double-integer", 2.0, 0.08),
            (bpm * 0.5, "half-raw", 0.5, 0.22),
            (round(bpm * 0.5, 2), "half-centibpm", 0.5, 0.18),
            (float(round(bpm * 0.5)), "half-integer", 0.5, 0.14),
        ):
            if not (min_bpm <= candidate_bpm <= max_bpm):
                continue
            source = "window-tempo" if label == "raw" else f"window-tempo-{label}"
            octave_variant = None if multiplier == 1.0 else ("double" if multiplier > 1.0 else "half")
            _add_tempo_candidate(
                candidates,
                bpm=float(candidate_bpm),
                source=source,
                score=max(0.0, base_score - variant_penalty),
                window=window,
                raw_bpm=float(bpm),
                octave_variant=octave_variant,
            )
    return candidates

def _autocorrelation_tempo_candidates(
    values: np.ndarray,
    *,
    frame_rate: float,
    source: str,
    min_bpm: float,
    max_bpm: float,
    step_bpm: float,
    limit: int,
) -> list[dict[str, Any]]:
    if values.size < 128 or frame_rate <= 0.0:
        return []
    series = values.astype("float64", copy=False)
    series = series[np.isfinite(series)]
    if series.size < 128:
        return []
    if series.size > 60000:
        stride = int(math.ceil(series.size / 60000.0))
        series = series[::stride]
        frame_rate = frame_rate / float(stride)
    series = series - float(np.mean(series))
    std = float(np.std(series))
    if std <= 1e-9:
        return []
    series = series / std

    candidates: list[dict[str, Any]] = []
    step_count = int(math.floor((max_bpm - min_bpm) / step_bpm)) + 1
    for index in range(step_count):
        bpm = min_bpm + float(index) * step_bpm
        lag = int(round((60.0 / bpm) * frame_rate))
        if lag <= 0 or lag >= series.size:
            continue
        left = series[:-lag]
        right = series[lag:]
        score = float(np.mean(left * right))
        if not math.isfinite(score):
            continue
        normalized_score = _clamp01((score + 1.0) * 0.5)
        candidates.append(
            {
                "bpm": round(bpm, 6),
                "score": round(normalized_score, 6),
                "source": source,
                "features": {
                    "tempoScore": round(normalized_score, 6),
                    "rawAutocorrScore": round(score, 6),
                    "lag": lag,
                },
            }
        )
    return _dedupe_candidates(candidates, bpm_tolerance=0.3, limit=limit, phase_tolerance_ms=None)


def _with_octave_variants(
    candidates: list[dict[str, Any]],
    *,
    min_bpm: float,
    max_bpm: float,
) -> list[dict[str, Any]]:
    result = list(candidates)
    for candidate in candidates:
        bpm = float(candidate.get("bpm") or 0.0)
        score = float(candidate.get("score") or 0.0) * 0.72
        for multiplier, label in ((0.5, "half"), (2.0, "double")):
            next_bpm = bpm * multiplier
            if min_bpm <= next_bpm <= max_bpm:
                result.append(
                    {
                        "bpm": round(next_bpm, 6),
                        "score": round(score, 6),
                        "source": f"{candidate.get('source')}-{label}",
                        "features": {
                            **dict(candidate.get("features") or {}),
                            "tempoScore": round(score, 6),
                            "octaveVariant": label,
                            "octavePenalty": 0.18,
                        },
                    }
                )
    return result


def _grid_positions(
    *,
    phase_ms: float,
    bpm: float,
    duration_sec: float,
    sample_rate: int,
    beat_step: int = 1,
) -> np.ndarray:
    if bpm <= 0.0 or duration_sec <= 0.0 or sample_rate <= 0:
        return np.asarray([], dtype="int64")
    interval_sec = (60.0 / bpm) * float(beat_step)
    if interval_sec <= 0.0:
        return np.asarray([], dtype="int64")
    phase_sec = phase_ms / 1000.0
    start_index = int(math.ceil((-phase_sec) / interval_sec))
    end_index = int(math.floor((duration_sec - phase_sec) / interval_sec))
    if end_index < start_index:
        return np.asarray([], dtype="int64")
    times_sec = phase_sec + np.arange(start_index, end_index + 1, dtype="float64") * interval_sec
    positions = np.rint(times_sec * float(sample_rate)).astype("int64", copy=False)
    return positions[(positions >= 0) & (positions < int(duration_sec * sample_rate))]


def _score_envelope_grid(
    envelope: np.ndarray,
    *,
    envelope_rate: int,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
) -> tuple[float, int]:
    positions = _grid_positions(
        phase_ms=phase_ms,
        bpm=bpm,
        duration_sec=duration_sec,
        sample_rate=envelope_rate,
    )
    if positions.size == 0 or envelope.size == 0:
        return 0.0, 0
    positions = positions[positions < envelope.size]
    if positions.size == 0:
        return 0.0, 0
    values = envelope[positions].astype("float64", copy=False)
    if values.size == 0:
        return 0.0, 0
    ordered = np.sort(values)
    low_count = max(1, int(values.size * 0.25))
    score = float(np.mean(values)) * 0.75 + float(np.mean(ordered[:low_count])) * 0.25
    return score, int(values.size)


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float | None:
    if values.size == 0 or weights.size == 0 or values.size != weights.size:
        return None
    total_weight = float(np.sum(weights))
    if not math.isfinite(total_weight) or total_weight <= 0.0:
        return None
    order = np.argsort(values)
    sorted_values = values[order]
    sorted_weights = weights[order]
    cumulative = np.cumsum(sorted_weights)
    index = int(np.searchsorted(cumulative, total_weight * 0.5, side="left"))
    index = max(0, min(index, sorted_values.size - 1))
    value = float(sorted_values[index])
    return value if math.isfinite(value) else None


def _score_leading_edge_grid(
    envelope: np.ndarray,
    *,
    envelope_rate: int,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
    target_peak_offset_ms: float,
) -> dict[str, float | int] | None:
    positions = _grid_positions(
        phase_ms=phase_ms,
        bpm=bpm,
        duration_sec=duration_sec,
        sample_rate=envelope_rate,
    )
    if positions.size < 16 or envelope.size == 0 or envelope_rate <= 0:
        return None
    if positions.size > 192:
        step = int(math.ceil(positions.size / 192.0))
        positions = positions[::step]
    positions = positions[(positions >= 0) & (positions < envelope.size)]
    if positions.size < 16:
        return None

    start_offset = int(round(envelope_rate * -0.012))
    end_offset = int(round(envelope_rate * 0.034))
    offset_samples = np.arange(start_offset, end_offset + 1, dtype="int64")
    if offset_samples.size == 0:
        return None
    indices = positions[:, None] + offset_samples[None, :]
    valid = (indices >= 0) & (indices < envelope.size)
    if not bool(np.any(valid)):
        return None
    clipped = np.clip(indices, 0, max(0, envelope.size - 1))
    values = envelope[clipped].astype("float64", copy=False)
    values = np.where(valid, values, -np.inf)
    best_columns = np.argmax(values, axis=1)
    row_indices = np.arange(values.shape[0])
    peak_values = values[row_indices, best_columns]
    finite_mask = np.isfinite(peak_values)
    if int(np.count_nonzero(finite_mask)) < 16:
        return None

    peak_values = peak_values[finite_mask]
    peak_offsets_ms = (
        offset_samples[best_columns[finite_mask]].astype("float64", copy=False)
        * 1000.0
        / float(envelope_rate)
    )
    weights = np.maximum(peak_values, 0.000001)
    median_offset = _weighted_median(peak_offsets_ms, weights)
    if median_offset is None:
        return None
    mad = _weighted_median(np.abs(peak_offsets_ms - median_offset), weights)
    if mad is None:
        mad = 999.0
    target_score = _clamp01(1.0 - abs(float(median_offset) - target_peak_offset_ms) / 16.0)
    consistency_score = _clamp01(1.0 - float(mad) / 14.0)
    peak_score = _clamp01(float(np.mean(peak_values)) * 4.0)
    score = _clamp01(target_score * 0.48 + consistency_score * 0.34 + peak_score * 0.18)
    return {
        "leadingEdgeScore": round(score, 6),
        "leadingEdgeTargetScore": round(target_score, 6),
        "leadingEdgeConsistencyScore": round(consistency_score, 6),
        "leadingEdgePeakScore": round(peak_score, 6),
        "leadingEdgePeakOffsetMedianMs": round(float(median_offset), 3),
        "leadingEdgePeakOffsetMadMs": round(float(mad), 3),
        "leadingEdgeSupport": int(peak_values.size),
    }


def _find_best_envelope_phase_ms(
    envelope: np.ndarray,
    *,
    envelope_rate: int,
    bpm: float,
    duration_sec: float,
    coarse_step_ms: float,
) -> tuple[float, float, int] | None:
    if envelope.size < 64 or envelope_rate <= 0 or bpm <= 0.0:
        return None
    interval_ms = 60000.0 / bpm
    if interval_ms <= 0.0:
        return None

    best_phase = 0.0
    best_score = -999.0
    best_support = 0
    phase = 0.0
    step = max(0.5, coarse_step_ms)
    while phase < interval_ms:
        score, support = _score_envelope_grid(
            envelope,
            envelope_rate=envelope_rate,
            bpm=bpm,
            phase_ms=phase,
            duration_sec=duration_sec,
        )
        if support >= 16 and score > best_score:
            best_phase = phase
            best_score = score
            best_support = support
        phase += step

    refine_start = best_phase - step
    refine_end = best_phase + step
    phase = refine_start
    while phase <= refine_end + 0.000001:
        normalized_phase = phase % interval_ms
        score, support = _score_envelope_grid(
            envelope,
            envelope_rate=envelope_rate,
            bpm=bpm,
            phase_ms=normalized_phase,
            duration_sec=duration_sec,
        )
        if support >= 16 and score > best_score:
            best_phase = normalized_phase
            best_score = score
            best_support = support
        phase += 0.25

    if best_support < 16:
        return None
    return best_phase % interval_ms, best_score, best_support


def _tempo_window_relationship(raw_bpm: float, bpm: float) -> str | None:
    if raw_bpm <= 0.0 or bpm <= 0.0:
        return None
    tolerance = max(0.42, bpm * 0.0035)
    if abs(raw_bpm - bpm) <= tolerance:
        return "direct"
    if abs(raw_bpm * 2.0 - bpm) <= tolerance:
        return "double"
    if abs(raw_bpm * 0.5 - bpm) <= tolerance:
        return "half"
    return None


def _phase_events_from_windows(
    *,
    metadata: dict[str, Any],
    bpm: float,
) -> list[dict[str, Any]]:
    interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
    if interval_ms <= 0.0:
        return []
    events: list[dict[str, Any]] = []
    for window in ((metadata.get("beatThis") or {}).get("windows")) or []:
        if not isinstance(window, dict):
            continue
        raw_bpm = to_float(window.get("rawBpm"))
        beats = window.get("beats")
        if raw_bpm is None or not isinstance(beats, list) or not beats:
            continue
        relationship = _tempo_window_relationship(float(raw_bpm), bpm)
        if relationship is None:
            continue
        weight = _window_weight(window)
        if relationship != "direct":
            weight *= 0.72
        window_start_ms = float(window.get("windowStartSec") or 0.0) * 1000.0
        for beat_index, beat_sec_raw in enumerate(beats):
            beat_sec = to_float(beat_sec_raw)
            if beat_sec is None:
                continue
            absolute_ms = window_start_ms + beat_sec * 1000.0
            events.append(
                {
                    "phaseMs": round(_normalize_phase_ms(absolute_ms, interval_ms), 3),
                    "weight": round(weight, 6),
                    "windowIndex": int(window.get("windowIndex") or 0),
                    "beatIndex": int(beat_index),
                    "relationship": relationship,
                }
            )
    return events


def _cluster_phase_events(
    events: list[dict[str, Any]],
    *,
    interval_ms: float,
    limit: int,
) -> list[dict[str, Any]]:
    if not events or interval_ms <= 0.0:
        return []
    total_weight = sum(float(item.get("weight") or 0.0) for item in events)
    if total_weight <= 0.0:
        return []

    cluster_radius_ms = min(24.0, max(10.0, interval_ms * 0.035))
    raw_candidates: list[dict[str, Any]] = []
    for event in events:
        center = float(event.get("phaseMs") or 0.0)
        members: list[dict[str, Any]] = []
        for item in events:
            phase = float(item.get("phaseMs") or 0.0)
            delta = abs(_phase_delta_ms(phase, center, interval_ms))
            if delta <= cluster_radius_ms:
                members.append(item)
        if not members:
            continue
        member_weight = sum(float(item.get("weight") or 0.0) for item in members)
        if member_weight <= 0.0:
            continue
        weighted_delta = sum(
            _phase_delta_ms(float(item.get("phaseMs") or 0.0), center, interval_ms)
            * float(item.get("weight") or 0.0)
            for item in members
        ) / member_weight
        mean_phase = _normalize_phase_ms(center + weighted_delta, interval_ms)
        deviations = [
            abs(_phase_delta_ms(float(item.get("phaseMs") or 0.0), mean_phase, interval_ms))
            for item in members
        ]
        compactness = _clamp01(1.0 - (statistics.fmean(deviations) / cluster_radius_ms))
        support_ratio = _clamp01(member_weight / total_weight)
        score = _clamp01(support_ratio * 0.62 + compactness * 0.30 + min(1.0, len(members) / 64.0) * 0.08)
        raw_candidates.append(
            {
                "firstBeatMs": round(mean_phase, 3),
                "score": round(score, 6),
                "phaseSource": "window-beat-cluster",
                "features": {
                    "phaseScore": round(score, 6),
                    "phaseSupport": int(len(members)),
                    "phaseSupportRatio": round(support_ratio, 6),
                    "phaseCompactness": round(compactness, 6),
                },
            }
        )
        raw_candidates.append(
            {
                "firstBeatMs": round(center, 3),
                "score": round(max(score - 0.025, 0.0), 6),
                "phaseSource": "window-beat-phase",
                "features": {
                    "phaseScore": round(max(score - 0.025, 0.0), 6),
                    "phaseSupport": int(len(members)),
                    "phaseSupportRatio": round(support_ratio, 6),
                    "phaseCompactness": round(compactness, 6),
                    "seedWindowIndex": int(event.get("windowIndex") or 0),
                },
            }
        )
    return _dedupe_candidates(
        raw_candidates,
        bpm_tolerance=9999.0,
        phase_tolerance_ms=1.5,
        limit=limit,
    )


def _refine_phase_around_seed(
    envelope: np.ndarray,
    *,
    envelope_rate: int,
    bpm: float,
    seed_phase_ms: float,
    duration_sec: float,
) -> tuple[float, float, int] | None:
    if envelope.size < 64 or envelope_rate <= 0 or bpm <= 0.0:
        return None
    interval_ms = 60000.0 / bpm
    if interval_ms <= 0.0:
        return None
    best_phase = _normalize_phase_ms(seed_phase_ms, interval_ms)
    best_score, best_support = _score_envelope_grid(
        envelope,
        envelope_rate=envelope_rate,
        bpm=bpm,
        phase_ms=best_phase,
        duration_sec=duration_sec,
    )
    search_radius_ms = min(18.0, max(8.0, interval_ms * 0.025))
    phase = seed_phase_ms - search_radius_ms
    while phase <= seed_phase_ms + search_radius_ms + 0.000001:
        normalized_phase = _normalize_phase_ms(phase, interval_ms)
        score, support = _score_envelope_grid(
            envelope,
            envelope_rate=envelope_rate,
            bpm=bpm,
            phase_ms=normalized_phase,
            duration_sec=duration_sec,
        )
        if support >= 16 and score > best_score:
            best_phase = normalized_phase
            best_score = score
            best_support = support
        phase += 0.5
    if best_support < 16:
        return None
    return best_phase, best_score, best_support


def _phase_candidates_for_tempo(
    *,
    metadata: dict[str, Any],
    arrays: dict[str, Any],
    beat_logits: np.ndarray,
    score_envelope: np.ndarray,
    score_envelope_rate: int,
    tempo: dict[str, Any],
    duration_sec: float,
    coarse_step_ms: float,
) -> list[dict[str, Any]]:
    bpm = float(tempo["bpm"])
    interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
    if interval_ms <= 0.0:
        return []
    events = _phase_events_from_windows(metadata=metadata, bpm=bpm)
    candidates = _cluster_phase_events(events, interval_ms=interval_ms, limit=28)

    leading_edge_candidates: list[dict[str, Any]] = []
    for candidate in candidates:
        source = str(candidate.get("phaseSource") or "")
        if not source.startswith("window-beat"):
            continue
        seed_phase = float(candidate.get("firstBeatMs") or 0.0)
        for target_offset_ms in (8.0, 10.0, 12.0):
            edge_stats = _score_leading_edge_grid(
                score_envelope,
                envelope_rate=score_envelope_rate,
                bpm=bpm,
                phase_ms=seed_phase,
                duration_sec=duration_sec,
                target_peak_offset_ms=target_offset_ms,
            )
            if edge_stats is None:
                continue
            median_offset = float(edge_stats["leadingEdgePeakOffsetMedianMs"])
            phase_shift_ms = median_offset - target_offset_ms
            if abs(phase_shift_ms) < 0.75 or abs(phase_shift_ms) > 24.0:
                continue
            refined_phase = _normalize_phase_ms(seed_phase + phase_shift_ms, interval_ms)
            refined_stats = _score_leading_edge_grid(
                score_envelope,
                envelope_rate=score_envelope_rate,
                bpm=bpm,
                phase_ms=refined_phase,
                duration_sec=duration_sec,
                target_peak_offset_ms=target_offset_ms,
            )
            if refined_stats is None:
                continue
            seed_score = float(candidate.get("score") or 0.0)
            edge_score = float(refined_stats["leadingEdgeScore"])
            score = _clamp01(seed_score * 0.62 + edge_score * 0.38 - min(0.08, abs(phase_shift_ms) / 240.0))
            leading_edge_candidates.append(
                {
                    "firstBeatMs": round(float(refined_phase), 3),
                    "score": round(score, 6),
                    "phaseSource": "window-beat-leading-edge",
                    "features": {
                        **dict(candidate.get("features") or {}),
                        **refined_stats,
                        "phaseScore": round(score, 6),
                        "leadingEdgeTargetOffsetMs": round(target_offset_ms, 3),
                        "phaseShiftMs": round(phase_shift_ms, 3),
                    },
                }
            )
    candidates.extend(leading_edge_candidates)

    refined_candidates: list[dict[str, Any]] = []
    for candidate in candidates:
        seed_phase = float(candidate.get("firstBeatMs") or 0.0)
        refined = _refine_phase_around_seed(
            score_envelope,
            envelope_rate=score_envelope_rate,
            bpm=bpm,
            seed_phase_ms=seed_phase,
            duration_sec=duration_sec,
        )
        if refined is None:
            continue
        phase_ms, attack_score, support = refined
        seed_score = float(candidate.get("score") or 0.0)
        phase_shift_ms = abs(_phase_delta_ms(phase_ms, seed_phase, interval_ms))
        score = _clamp01(seed_score * 0.76 + float(attack_score) * 0.24 - min(0.12, phase_shift_ms / 180.0))
        refined_candidates.append(
            {
                "firstBeatMs": round(float(phase_ms), 3),
                "score": round(score, 6),
                "phaseSource": "window-beat-attack-refined",
                "features": {
                    **dict(candidate.get("features") or {}),
                    "phaseScore": round(score, 6),
                    "attackPhaseScore": round(float(attack_score), 6),
                    "phaseSupport": int(support),
                    "phaseShiftMs": round(phase_shift_ms, 3),
                },
            }
        )
    candidates.extend(refined_candidates)

    logit_phase = _find_best_logit_phase_ms(beat_logits, bpm, duration_sec)
    if logit_phase is not None:
        phase_ms, score, support = logit_phase
        normalized_score = _clamp01(float(score))
        candidates.append(
            {
                "firstBeatMs": round(float(phase_ms), 3),
                "score": round(normalized_score * 0.72, 6),
                "phaseSource": "beat-logit-phase",
                "features": {
                    "phaseScore": round(normalized_score * 0.72, 6),
                    "beatLogitScore": round(normalized_score, 6),
                    "phaseSupport": int(support),
                },
            }
        )

    envelope_phase = _find_best_envelope_phase_ms(
        score_envelope,
        envelope_rate=score_envelope_rate,
        bpm=bpm,
        duration_sec=duration_sec,
        coarse_step_ms=coarse_step_ms,
    )
    if envelope_phase is not None:
        phase_ms, score, support = envelope_phase
        normalized_score = _clamp01(float(score))
        candidates.append(
            {
                "firstBeatMs": round(float(phase_ms), 3),
                "score": round(normalized_score * 0.68, 6),
                "phaseSource": "attack-envelope-phase",
                "features": {
                    "phaseScore": round(normalized_score * 0.68, 6),
                    "attackPhaseScore": round(normalized_score, 6),
                    "phaseSupport": int(support),
                },
            }
        )
    return _dedupe_candidates(
        candidates,
        bpm_tolerance=9999.0,
        phase_tolerance_ms=1.0,
        limit=56,
    )


def _downbeat_offsets_for_candidate(
    *,
    downbeat_logits: np.ndarray,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
) -> list[dict[str, Any]]:
    scores = _score_downbeat_bars(downbeat_logits, bpm, phase_ms, duration_sec)
    valid = [item for item in scores if int(item[2]) >= 4 and math.isfinite(float(item[1]))]
    if not valid:
        return [{"barBeatOffset": 0, "downbeatScore": 0.0, "downbeatSupport": 0}]
    ordered = sorted(valid, key=lambda item: float(item[1]), reverse=True)[:4]
    return [
        {
            "barBeatOffset": int(bar) % 4,
            "downbeatScore": round(float(score), 6),
            "downbeatSupport": int(support),
        }
        for bar, score, support in ordered
    ]


def _apply_leading_edge_adjustment(candidates: list[dict[str, Any]]) -> None:
    groups: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for candidate in candidates:
        bpm = float(candidate.get("bpm") or 0.0)
        if bpm <= 0.0:
            continue
        key = (int(round(bpm * 100.0)), int(candidate.get("barBeatOffset") or 0) % 4)
        groups.setdefault(key, []).append(candidate)

    for group in groups.values():
        if len(group) < 2:
            continue
        top = max(group, key=lambda item: float(item.get("score") or 0.0))
        top_score = float(top.get("score") or 0.0)
        bpm = float(top.get("bpm") or 0.0)
        interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
        top_phase = float(top.get("firstBeatMs") or 0.0)
        if interval_ms <= 0.0:
            continue

        for candidate in group:
            source = str(candidate.get("phaseSource") or "")
            if not source.startswith("window-beat"):
                continue
            score = float(candidate.get("score") or 0.0)
            if score < top_score - 0.10:
                continue
            phase = float(candidate.get("firstBeatMs") or 0.0)
            if phase > interval_ms - 40.0 and top_phase < 40.0:
                continue
            delta_ms = _phase_delta_ms(phase, top_phase, interval_ms)
            if not (-18.0 <= delta_ms <= -2.0):
                continue
            center_distance = abs(abs(delta_ms) - 10.0)
            bonus = 0.075 * _clamp01(1.0 - center_distance / 11.0)
            if bonus <= 0.0:
                continue
            candidate["score"] = round(score + bonus, 6)
            features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
            features["leadingEdgeBonus"] = round(bonus, 6)
            features["leadingEdgeDeltaMs"] = round(delta_ms, 3)
            candidate["features"] = features


def _timeline_quantized_phase(
    *,
    phase_ms: float,
    bpm: float,
    offset_ms: float,
) -> tuple[float, float]:
    interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
    if interval_ms <= 0.0:
        return phase_ms, 0.0
    timeline_ms = phase_ms + offset_ms
    shift_ms = round(timeline_ms) - timeline_ms
    if abs(shift_ms) < 0.0005 or abs(shift_ms) > 0.5:
        return phase_ms, 0.0
    return _normalize_phase_ms(phase_ms + shift_ms, interval_ms), shift_ms


def _build_grid_candidates(
    *,
    metadata: dict[str, Any],
    arrays: dict[str, Any],
    min_bpm: float,
    max_bpm: float,
    tempo_step_bpm: float,
    tempo_limit: int,
    coarse_phase_step_ms: float,
    max_candidates: int,
) -> list[dict[str, Any]]:
    duration_sec = float((metadata.get("audio") or {}).get("durationSec") or 0.0)
    audio = metadata.get("audio") if isinstance(metadata.get("audio"), dict) else {}
    time_basis = audio.get("timeBasis") if isinstance(audio.get("timeBasis"), dict) else {}
    time_basis_offset_ms = float(time_basis.get("offsetMs") or 0.0)
    beat_logits = _sigmoid(np.asarray(arrays["beatLogits"], dtype="float64"))
    downbeat_logits = _sigmoid(np.asarray(arrays["downbeatLogits"], dtype="float64"))
    full_attack = np.asarray(arrays["fullAttackEnvelope"], dtype="float64")
    full_attack_rate = int(np.asarray(arrays["fullAttackSampleRate"]).item())
    score_window = max(1, int(round(float(full_attack_rate) * 0.008)))
    score_envelope = moving_average(full_attack, score_window)

    tempo_candidates = _tempo_from_windows(metadata, min_bpm=min_bpm, max_bpm=max_bpm)
    tempo_candidates.extend(
        _autocorrelation_tempo_candidates(
            beat_logits,
            frame_rate=50.0,
            source="beat-logit-autocorr",
            min_bpm=min_bpm,
            max_bpm=max_bpm,
            step_bpm=tempo_step_bpm,
            limit=tempo_limit,
        )
    )
    tempo_candidates.extend(
        _autocorrelation_tempo_candidates(
            full_attack,
            frame_rate=float(full_attack_rate),
            source="attack-envelope-autocorr",
            min_bpm=min_bpm,
            max_bpm=max_bpm,
            step_bpm=max(tempo_step_bpm, 0.5),
            limit=max(4, tempo_limit // 2),
        )
    )
    tempo_candidates = _with_octave_variants(
        _dedupe_candidates(
            tempo_candidates,
            bpm_tolerance=0.04,
            phase_tolerance_ms=None,
            limit=tempo_limit * 3,
        ),
        min_bpm=min_bpm,
        max_bpm=max_bpm,
    )
    tempo_candidates = _dedupe_candidates(
        tempo_candidates,
        bpm_tolerance=0.035,
        phase_tolerance_ms=None,
        limit=tempo_limit * 4,
    )

    grid_candidates: list[dict[str, Any]] = []
    for tempo in tempo_candidates:
        phases = _phase_candidates_for_tempo(
            metadata=metadata,
            arrays=arrays,
            beat_logits=beat_logits,
            score_envelope=score_envelope,
            score_envelope_rate=full_attack_rate,
            tempo=tempo,
            duration_sec=duration_sec,
            coarse_step_ms=coarse_phase_step_ms,
        )
        for phase in phases:
            phase_ms = float(phase["firstBeatMs"])
            phase_ms, timeline_shift_ms = _timeline_quantized_phase(
                phase_ms=phase_ms,
                bpm=float(tempo["bpm"]),
                offset_ms=time_basis_offset_ms,
            )
            for downbeat in _downbeat_offsets_for_candidate(
                downbeat_logits=downbeat_logits,
                bpm=float(tempo["bpm"]),
                phase_ms=phase_ms,
                duration_sec=duration_sec,
            ):
                tempo_score = float((tempo.get("features") or {}).get("tempoScore") or tempo.get("score") or 0.0)
                phase_score = float((phase.get("features") or {}).get("phaseScore") or phase.get("score") or 0.0)
                downbeat_score = float(downbeat.get("downbeatScore") or 0.0)
                tempo_features = dict(tempo.get("features") or {})
                phase_features = dict(phase.get("features") or {})
                envelope_score, envelope_support = _score_envelope_grid(
                    score_envelope,
                    envelope_rate=full_attack_rate,
                    bpm=float(tempo["bpm"]),
                    phase_ms=phase_ms,
                    duration_sec=duration_sec,
                )
                phase_features["attackPhaseScore"] = round(float(envelope_score), 6)
                phase_features["attackPhaseSupport"] = int(envelope_support)
                if abs(timeline_shift_ms) > 0.0:
                    phase_features["timelineQuantizationShiftMs"] = round(timeline_shift_ms, 3)
                octave_penalty = float(tempo_features.get("octavePenalty") or 0.0)
                quantized_score = float(tempo_features.get("tempoQuantizedScore") or 0.0)
                phase_support_ratio = float(phase_features.get("phaseSupportRatio") or 0.0)
                phase_compactness = float(phase_features.get("phaseCompactness") or 0.0)
                leading_edge_score = float(phase_features.get("leadingEdgeScore") or 0.0)
                source = str(phase.get("phaseSource") or "")
                phase_source_bonus = 0.06 if source.startswith("window-beat") else -0.05
                score = (
                    tempo_score * 0.42
                    + phase_score * 0.20
                    + downbeat_score * 0.10
                    + quantized_score * 0.10
                    + phase_compactness * 0.12
                    + leading_edge_score * 0.10
                    + phase_source_bonus
                    - phase_support_ratio * 0.06
                    - octave_penalty
                )
                grid_candidates.append(
                    {
                        "source": "hybrid-lab",
                        "tempoSource": tempo.get("source"),
                        "phaseSource": phase.get("phaseSource"),
                        "barSource": "downbeat-logit-lattice",
                        "bpm": round(float(tempo["bpm"]), 6),
                        "firstBeatMs": round(phase_ms, 3),
                        "barBeatOffset": int(downbeat["barBeatOffset"]) % 4,
                        "score": round(score, 6),
                        "features": {
                            **tempo_features,
                            **phase_features,
                            "tempoScore": round(tempo_score, 6),
                            "phaseScore": round(phase_score, 6),
                            "downbeatScore": round(downbeat_score, 6),
                            "downbeatSupport": int(downbeat.get("downbeatSupport") or 0),
                        },
                    }
                )
    _apply_leading_edge_adjustment(grid_candidates)
    return _dedupe_candidates(
        grid_candidates,
        bpm_tolerance=0.04,
        phase_tolerance_ms=0.5,
        limit=max_candidates,
        bar_sensitive=True,
    )


def main() -> int:
    import benchmark_rkb_rekordbox_truth as benchmark
    from rkb_beatgrid_candidate_report import _summarize, build_candidate_track_report
    from rkb_beatgrid_lab_common import (
        DEFAULT_BASELINE,
        DEFAULT_CANDIDATE_LAB_OUTPUT,
        DEFAULT_FEATURE_CACHE_DIR,
        atomic_write_json,
        baseline_summary,
        build_feature_index_map,
        configure_utf8_stdio,
        load_selected_truth_tracks,
        normalize_lookup_key,
        print_json,
        read_feature_metadata,
        resolve_feature_arrays_path,
        resolve_feature_entry,
    )

    configure_utf8_stdio()
    strict_tolerance_ms = benchmark.STRICT_TOLERANCE_MS
    parser = argparse.ArgumentParser(description="Run FRKB hybrid beatgrid candidate coverage lab")
    parser.add_argument("--truth", default=str(benchmark.DEFAULT_TRUTH))
    parser.add_argument("--audio-root", default=str(benchmark.DEFAULT_AUDIO_ROOT))
    parser.add_argument("--ffprobe", default=str(benchmark.DEFAULT_FFPROBE))
    parser.add_argument("--feature-cache-dir", default=str(DEFAULT_FEATURE_CACHE_DIR))
    parser.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    parser.add_argument("--output", default=str(DEFAULT_CANDIDATE_LAB_OUTPUT))
    parser.add_argument("--min-bpm", type=float, default=70.0)
    parser.add_argument("--max-bpm", type=float, default=200.0)
    parser.add_argument("--tempo-step-bpm", type=float, default=0.5)
    parser.add_argument("--tempo-limit", type=int, default=24)
    parser.add_argument("--phase-step-ms", type=float, default=2.0)
    parser.add_argument("--max-candidates", type=int, default=320)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", action="append", default=[])
    args = parser.parse_args()

    truth_path = Path(args.truth)
    ffprobe_path = Path(args.ffprobe)
    cache_dir = Path(args.feature_cache_dir)
    output_path = Path(args.output)
    if not truth_path.exists():
        raise SystemExit(f"truth not found: {truth_path}")
    if not ffprobe_path.exists():
        raise SystemExit(f"ffprobe not found: {ffprobe_path}")
    if not cache_dir.exists():
        raise SystemExit(f"feature cache dir not found: {cache_dir}")

    only_filters = [normalize_lookup_key(item) for item in args.only if normalize_lookup_key(item)]
    selected_tracks = load_selected_truth_tracks(
        truth_path=truth_path,
        audio_root=str(args.audio_root),
        ffprobe_path=ffprobe_path,
        only_filters=only_filters,
        limit=int(args.limit or 0),
    )
    if not selected_tracks:
        raise SystemExit("no tracks selected")

    started_at = time.time()
    index_map = build_feature_index_map(cache_dir)
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for index, track in enumerate(selected_tracks, start=1):
        print(f"[{index}/{len(selected_tracks)}] {track['fileName']}", flush=True)
        try:
            entry = resolve_feature_entry(track=track, index_map=index_map)
            if entry is None:
                raise RuntimeError("feature cache missing; run rkb_beatgrid_feature_cache.py first")
            metadata = read_feature_metadata(cache_dir, entry)
            arrays_path = resolve_feature_arrays_path(cache_dir, entry, metadata)
            if not arrays_path.exists():
                raise RuntimeError(f"feature arrays missing: {arrays_path}")
            with np.load(arrays_path, allow_pickle=False) as arrays:
                candidates = _build_grid_candidates(
                    metadata=metadata,
                    arrays=arrays,
                    min_bpm=float(args.min_bpm),
                    max_bpm=float(args.max_bpm),
                    tempo_step_bpm=float(args.tempo_step_bpm),
                    tempo_limit=int(args.tempo_limit),
                    coarse_phase_step_ms=float(args.phase_step_ms),
                    max_candidates=int(args.max_candidates),
                )
                rows.append(
                    build_candidate_track_report(
                        track=track,
                        metadata=metadata,
                        candidates=candidates,
                        strict_tolerance_ms=strict_tolerance_ms,
                    )
                )
        except Exception as error:
            errors.append({"fileName": track.get("fileName"), "error": str(error)})
            print(f"  error: {error}", flush=True)

    summary = {
        **_summarize(rows, errors),
        "truthPath": str(truth_path),
        "featureCacheDir": str(cache_dir),
        "strictToleranceMs": strict_tolerance_ms,
        "baseline": baseline_summary(Path(args.baseline)),
        "durationSec": round(time.time() - started_at, 3),
    }
    payload = {"summary": summary, "errors": errors, "tracks": rows}
    atomic_write_json(output_path, payload)
    print_json({"summary": summary, "output": str(output_path)})
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
