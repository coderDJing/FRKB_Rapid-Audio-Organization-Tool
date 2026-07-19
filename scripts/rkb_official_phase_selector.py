import math
import statistics
from typing import Any

import numpy as np
import soxr


SELECTOR_VERSION = "rkb-official-style-fixed-phase-selector-v1"
HIGH_ATTACK_VERSION = "rkb-official-high-attack-frequency-domain-v1"
SEARCH_RADIUS_SEC = 0.05
OFFICIAL_QUARTER_RATE = 11025.0
OVERALL_SMOOTH_SAMPLES = 32
OVERALL_SUSTAIN_SAMPLES = 8
MOD4_SUSTAIN_SAMPLES = 5
MOD4_DISTANCE_SAMPLES = 20
OVERALL_MOD4_GAP_SAMPLES = 35


def _finite_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _moving_average_same(values: np.ndarray, width: int) -> np.ndarray:
    numeric = np.asarray(values, dtype="float64")
    if numeric.size == 0 or width <= 1:
        return numeric.copy()
    width = min(int(width), int(numeric.size))
    kernel = np.ones(width, dtype="float64") / float(width)
    return np.convolve(numeric, kernel, mode="same")


def _cosine_frequency_mask(
    frequencies: np.ndarray,
    *,
    pass_edge_hz: float,
    stop_edge_hz: float,
    high_pass: bool,
) -> np.ndarray:
    values = np.asarray(frequencies, dtype="float64")
    lower = min(pass_edge_hz, stop_edge_hz)
    upper = max(pass_edge_hz, stop_edge_hz)
    if upper <= lower:
        raise ValueError("frequency mask edges must differ")
    position = np.clip((values - lower) / (upper - lower), 0.0, 1.0)
    ramp = 0.5 - 0.5 * np.cos(np.pi * position)
    return ramp if high_pass else 1.0 - ramp


def build_high_attack_envelope(
    mono: np.ndarray,
    *,
    sample_rate: int = 11025,
    output_rate: int = 4000,
) -> tuple[np.ndarray, int]:
    values = np.asarray(mono, dtype="float64").reshape(-1)
    if values.size < 64 or sample_rate <= 0 or output_rate <= 0:
        return np.asarray([], dtype="float32"), output_rate
    frequencies = np.fft.rfftfreq(values.size, d=1.0 / float(sample_rate))
    high_mask = _cosine_frequency_mask(
        frequencies,
        pass_edge_hz=2200.0,
        stop_edge_hz=1800.0,
        high_pass=True,
    )
    high = np.fft.irfft(np.fft.rfft(values) * high_mask, n=values.size)
    rectified = np.abs(high)
    low_mask = _cosine_frequency_mask(
        frequencies,
        pass_edge_hz=800.0,
        stop_edge_hz=1200.0,
        high_pass=False,
    )
    envelope = np.fft.irfft(np.fft.rfft(rectified) * low_mask, n=values.size)
    envelope = np.maximum(envelope, 0.0)
    if output_rate != sample_rate:
        output_count = max(1, int(round(values.size * output_rate / sample_rate)))
        source_positions = np.arange(values.size, dtype="float64")
        target_positions = np.linspace(0.0, float(values.size - 1), output_count)
        envelope = np.interp(target_positions, source_positions, envelope)
    peak = float(np.max(envelope)) if envelope.size else 0.0
    if not math.isfinite(peak) or peak <= 1e-12:
        return np.zeros(envelope.size, dtype="float32"), output_rate
    return np.asarray(envelope / peak, dtype="float32"), output_rate


def build_high_attack_from_signal(
    signal: np.ndarray,
    *,
    sample_rate: int,
    output_rate: int = 4000,
) -> tuple[np.ndarray, int]:
    values = np.asarray(signal, dtype="float64")
    if values.ndim == 2:
        mono = np.mean(values, axis=1)
    elif values.ndim == 1:
        mono = values
    else:
        mono = values.reshape(-1)
    if mono.size < 64 or sample_rate <= 0:
        return np.asarray([], dtype="float32"), output_rate
    quarter_rate = max(5000, int(round(sample_rate / 4.0)))
    if quarter_rate != sample_rate:
        mono = soxr.resample(mono, in_rate=sample_rate, out_rate=quarter_rate)
    return build_high_attack_envelope(
        mono,
        sample_rate=quarter_rate,
        output_rate=output_rate,
    )


def _scaled_samples(frame_rate: float, official_samples: int, *, minimum: int = 1) -> int:
    return max(minimum, int(round(frame_rate * official_samples / OFFICIAL_QUARTER_RATE)))


def _grid_positions(
    *,
    bpm: float,
    first_beat_ms: float,
    duration_sec: float,
    frame_rate: float,
) -> tuple[np.ndarray, np.ndarray]:
    if bpm <= 0.0 or duration_sec <= 0.0 or frame_rate <= 0.0:
        return np.asarray([], dtype="int64"), np.asarray([], dtype="int64")
    interval_sec = 60.0 / bpm
    first_sec = first_beat_ms / 1000.0
    start_index = int(math.ceil((0.0 - first_sec) / interval_sec))
    end_index = int(math.floor((duration_sec - first_sec) / interval_sec))
    if end_index < start_index:
        return np.asarray([], dtype="int64"), np.asarray([], dtype="int64")
    beat_indices = np.arange(start_index, end_index + 1, dtype="int64")
    times_sec = first_sec + beat_indices.astype("float64") * interval_sec
    positions = np.rint(times_sec * frame_rate).astype("int64", copy=False)
    return positions, beat_indices


def build_phase_trajectories(
    values: np.ndarray,
    *,
    frame_rate: float,
    bpm: float,
    first_beat_ms: float,
    duration_sec: float,
) -> dict[str, Any]:
    numeric = np.asarray(values, dtype="float64")
    half_window = max(1, int(frame_rate * SEARCH_RADIUS_SEC))
    offsets = np.arange(-half_window, half_window + 1, dtype="int64")
    empty = {
        "offsetSamples": offsets,
        "overall": np.zeros(offsets.size, dtype="float64"),
        "mod4": [np.zeros(offsets.size, dtype="float64") for _ in range(4)],
        "overallSupport": 0,
        "mod4Support": [0, 0, 0, 0],
    }
    if numeric.size == 0:
        return empty
    positions, beat_indices = _grid_positions(
        bpm=bpm,
        first_beat_ms=first_beat_ms,
        duration_sec=duration_sec,
        frame_rate=frame_rate,
    )
    if positions.size < 8:
        return empty
    valid_beats = (positions - half_window >= 0) & (positions + half_window < numeric.size)
    positions = positions[valid_beats]
    beat_indices = beat_indices[valid_beats]
    if positions.size < 8:
        return empty
    samples = numeric[positions[:, None] + offsets[None, :]]
    overall = np.mean(samples, axis=0)
    mod4: list[np.ndarray] = []
    mod4_support: list[int] = []
    for group in range(4):
        mask = np.mod(beat_indices, 4) == group
        support = int(np.count_nonzero(mask))
        mod4_support.append(support)
        if support > 0:
            mod4.append(np.mean(samples[mask], axis=0))
        else:
            mod4.append(np.zeros(offsets.size, dtype="float64"))
    return {
        "offsetSamples": offsets,
        "overall": overall,
        "mod4": mod4,
        "overallSupport": int(positions.size),
        "mod4Support": mod4_support,
    }


def _peak_shape_candidate(
    trajectory: np.ndarray,
    *,
    frame_rate: float,
    strong_rise_ratio: float,
    sustain_official_samples: int,
    minimum_support: int,
    support: int,
) -> dict[str, Any]:
    values = np.asarray(trajectory, dtype="float64")
    if values.size < 8 or support < minimum_support or not np.isfinite(values).all():
        return {"valid": False, "reason": "insufficient-support"}
    smooth_width = _scaled_samples(frame_rate, OVERALL_SMOOTH_SAMPLES)
    smooth = _moving_average_same(values, smooth_width)
    minimum = float(np.min(smooth))
    maximum = float(np.max(smooth))
    dynamic_range = maximum - minimum
    if not math.isfinite(dynamic_range) or dynamic_range <= 1e-9 or maximum <= 1e-9:
        return {"valid": False, "reason": "flat-trajectory"}
    energy = np.clip((smooth - minimum) / dynamic_range, 0.0, 1.0)
    lag = max(1, smooth_width)
    rise = np.zeros_like(smooth)
    rise[lag:] = smooth[lag:] - smooth[:-lag]
    positive_rise = np.maximum(rise, 0.0)
    max_rise = float(np.max(positive_rise))
    if max_rise <= 1e-12:
        peak_index = int(np.argmax(smooth))
        return {
            "valid": True,
            "reason": "protected-main-peak",
            "index": peak_index,
            "energy": float(energy[peak_index]),
            "dynamicRange": dynamic_range,
            "maxRise": 0.0,
        }

    strong = (positive_rise > strong_rise_ratio * max_rise) & (energy > 0.25)
    strong_indices = np.flatnonzero(strong)
    sustain = _scaled_samples(frame_rate, sustain_official_samples)
    for strong_index_raw in strong_indices:
        strong_index = int(strong_index_raw)
        end = min(values.size, strong_index + sustain)
        if end - strong_index < sustain:
            continue
        confirmed = (
            positive_rise[strong_index:end] > 0.25 * max_rise
        ) & (energy[strong_index:end] > 0.40)
        if not bool(np.all(confirmed)):
            continue
        selected = strong_index
        while selected > 0:
            previous = selected - 1
            if positive_rise[previous] <= 0.25 * max_rise or energy[previous] <= 0.25:
                break
            selected = previous
        return {
            "valid": True,
            "reason": "sustained-rising-edge",
            "index": selected,
            "strongIndex": strong_index,
            "energy": float(energy[selected]),
            "dynamicRange": dynamic_range,
            "maxRise": max_rise,
        }

    peak_index = int(np.argmax(smooth))
    peak_energy = float(energy[peak_index])
    if peak_energy < 0.70:
        return {"valid": False, "reason": "peak-shape-rejected"}
    return {
        "valid": True,
        "reason": "protected-main-peak",
        "index": peak_index,
        "energy": peak_energy,
        "dynamicRange": dynamic_range,
        "maxRise": max_rise,
    }


def select_official_style_phase(
    trajectories: dict[str, Any],
    *,
    frame_rate: float,
) -> dict[str, Any]:
    offsets = np.asarray(trajectories.get("offsetSamples"), dtype="int64")
    overall_values = np.asarray(trajectories.get("overall"), dtype="float64")
    support = int(trajectories.get("overallSupport") or 0)
    if offsets.size == 0 or overall_values.size != offsets.size or support < 8:
        return {"valid": False, "reason": "insufficient-overall-support"}
    center_index = int(np.argmin(np.abs(offsets)))
    argmax_index = int(np.argmax(overall_values))
    overall = _peak_shape_candidate(
        overall_values,
        frame_rate=frame_rate,
        strong_rise_ratio=0.65,
        sustain_official_samples=OVERALL_SUSTAIN_SAMPLES,
        minimum_support=8,
        support=support,
    )
    if not overall.get("valid"):
        return {"valid": False, "reason": f"overall:{overall.get('reason')}"}

    mod4_candidates: list[dict[str, Any]] = []
    mod4_values = trajectories.get("mod4") if isinstance(trajectories.get("mod4"), list) else []
    mod4_support = (
        trajectories.get("mod4Support") if isinstance(trajectories.get("mod4Support"), list) else []
    )
    distance_gate = _scaled_samples(frame_rate, MOD4_DISTANCE_SAMPLES)
    for group in range(4):
        values = np.asarray(mod4_values[group], dtype="float64") if group < len(mod4_values) else np.asarray([])
        group_support = int(mod4_support[group]) if group < len(mod4_support) else 0
        candidate = _peak_shape_candidate(
            values,
            frame_rate=frame_rate,
            strong_rise_ratio=0.75,
            sustain_official_samples=MOD4_SUSTAIN_SAMPLES,
            minimum_support=5,
            support=group_support,
        )
        candidate = {**candidate, "group": group, "support": group_support}
        if candidate.get("valid") and abs(int(candidate["index"]) - int(overall["index"])) <= distance_gate:
            candidate["nearOverall"] = True
        else:
            candidate["nearOverall"] = False
        mod4_candidates.append(candidate)

    valid_mod4 = [item for item in mod4_candidates if item.get("valid")]
    phase_candidate_index = max((int(item["index"]) for item in valid_mod4), default=None)
    gap = _scaled_samples(frame_rate, OVERALL_MOD4_GAP_SAMPLES)
    selected_index = int(overall["index"])
    selected_source = "overall"
    if phase_candidate_index is not None and selected_index <= phase_candidate_index - gap:
        selected_index = phase_candidate_index
        selected_source = "mod4"
    selected_index = max(0, min(selected_index, offsets.size - 1))
    return {
        "valid": True,
        "centerIndex": center_index,
        "argmaxIndex": argmax_index,
        "argmaxShiftMs": round(float(offsets[argmax_index]) * 1000.0 / frame_rate, 6),
        "overall": overall,
        "overallShiftMs": round(float(offsets[int(overall["index"])]) * 1000.0 / frame_rate, 6),
        "mod4": mod4_candidates,
        "validMod4Count": len(valid_mod4),
        "selectedIndex": selected_index,
        "selectedSource": selected_source,
        "selectedShiftMs": round(float(offsets[selected_index]) * 1000.0 / frame_rate, 6),
        "selectedEnergy": float(overall.get("energy") or 0.0),
        "selectedDynamicRange": float(overall.get("dynamicRange") or 0.0),
    }


def _window_relationship(raw_bpm: float, bpm: float) -> str | None:
    tolerance = max(0.42, bpm * 0.0035)
    if abs(raw_bpm - bpm) <= tolerance:
        return "direct"
    if abs(raw_bpm * 2.0 - bpm) <= tolerance:
        return "half"
    if abs(raw_bpm * 0.5 - bpm) <= tolerance:
        return "double"
    return None


def _beat_events(metadata: dict[str, Any], bpm: float) -> list[float]:
    events: list[float] = []
    windows = ((metadata.get("beatThis") or {}).get("windows")) or []
    for window in windows:
        if not isinstance(window, dict):
            continue
        raw_bpm = _finite_float(window.get("rawBpm"))
        beats = window.get("beats")
        if raw_bpm is None or not isinstance(beats, list):
            continue
        relationship = _window_relationship(raw_bpm, bpm)
        if relationship is None:
            continue
        window_start_ms = (_finite_float(window.get("windowStartSec")) or 0.0) * 1000.0
        for beat_index, beat_raw in enumerate(beats):
            beat_sec = _finite_float(beat_raw)
            if beat_sec is None:
                continue
            if relationship == "double" and beat_index % 2 != 0:
                continue
            events.append(window_start_ms + beat_sec * 1000.0)
    return sorted(events)


def stable_range_residual(
    metadata: dict[str, Any],
    *,
    bpm: float,
    first_beat_ms: float,
) -> dict[str, Any]:
    interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
    if interval_ms <= 0.0:
        return {"valid": False, "reason": "invalid-bpm"}
    raw_events = _beat_events(metadata, bpm)
    if len(raw_events) < 12:
        return {"valid": False, "reason": "insufficient-beat-events", "eventCount": len(raw_events)}

    by_index: dict[int, list[float]] = {}
    for event_ms in raw_events:
        beat_index = int(round((event_ms - first_beat_ms) / interval_ms))
        predicted_ms = first_beat_ms + beat_index * interval_ms
        residual = event_ms - predicted_ms
        if abs(residual) <= interval_ms * 0.45:
            by_index.setdefault(beat_index, []).append(event_ms)
    sequence = [
        (beat_index, statistics.median(events))
        for beat_index, events in sorted(by_index.items())
        if events
    ]
    if len(sequence) < 12:
        return {"valid": False, "reason": "insufficient-mapped-events", "eventCount": len(sequence)}

    def longest_run(tolerance_ms: float) -> list[tuple[int, float]]:
        best: list[tuple[int, float]] = []
        current = [sequence[0]]
        for previous, item in zip(sequence, sequence[1:]):
            index_delta = item[0] - previous[0]
            interval = item[1] - previous[1]
            stable = index_delta == 1 and abs(interval - interval_ms) <= tolerance_ms
            if stable:
                current.append(item)
            else:
                if len(current) > len(best):
                    best = current
                current = [item]
        if len(current) > len(best):
            best = current
        return best

    stable = longest_run(10.0)
    stable_tolerance_ms = 10.0
    if len(stable) < 8:
        stable = longest_run(20.0)
        stable_tolerance_ms = 20.0
    if len(stable) < 8:
        return {"valid": False, "reason": "no-stable-run", "eventCount": len(sequence)}

    residuals = [event_ms - (first_beat_ms + beat_index * interval_ms) for beat_index, event_ms in stable]
    mean_residual = statistics.fmean(residuals)
    residual_mad = statistics.median(abs(value - statistics.median(residuals)) for value in residuals)
    stable_indices = {item[0] for item in stable}
    outside_residuals = [
        event_ms - (first_beat_ms + beat_index * interval_ms)
        for beat_index, event_ms in sequence
        if beat_index not in stable_indices
    ]
    outside_ratio = len(outside_residuals) / len(sequence)
    outside_mean_abs_ratio = (
        statistics.fmean(abs(value) for value in outside_residuals) / interval_ms
        if outside_residuals
        else 0.0
    )
    half_cycle_ratio = (
        sum(abs(abs(value) / interval_ms - 0.5) < 0.10 for value in outside_residuals)
        / len(outside_residuals)
        if outside_residuals
        else 0.0
    )
    half_shift_ms = 0.0
    if outside_mean_abs_ratio > 0.3 and outside_ratio > 0.5 and half_cycle_ratio < 0.4:
        signed_sum = sum(outside_residuals)
        half_shift_ms = interval_ms * 0.5 if signed_sum > 0.0 else -interval_ms * 0.5
    return {
        "valid": True,
        "eventCount": len(sequence),
        "stableStartIndex": int(stable[0][0]),
        "stableEndIndex": int(stable[-1][0]),
        "stableLength": len(stable),
        "stableCoveredRatio": round(len(stable) / len(sequence), 6),
        "stableToleranceMs": stable_tolerance_ms,
        "meanResidualMs": round(mean_residual, 6),
        "residualMadMs": round(residual_mad, 6),
        "outsideMeanAbsRatio": round(outside_mean_abs_ratio, 6),
        "outsideRatio": round(outside_ratio, 6),
        "halfCycleConflictScore": round(half_cycle_ratio, 6),
        "halfShiftProposalMs": round(half_shift_ms, 6),
    }


def candidate_phase_evidence(
    values: np.ndarray,
    *,
    frame_rate: float,
    bpm: float,
    first_beat_ms: float,
    duration_sec: float,
) -> dict[str, Any]:
    trajectories = build_phase_trajectories(
        values,
        frame_rate=frame_rate,
        bpm=bpm,
        first_beat_ms=first_beat_ms,
        duration_sec=duration_sec,
    )
    selected = select_official_style_phase(trajectories, frame_rate=frame_rate)
    if not selected.get("valid"):
        return selected
    selected["overallSupport"] = int(trajectories.get("overallSupport") or 0)
    mod4_support = trajectories.get("mod4Support") if isinstance(trajectories.get("mod4Support"), list) else []
    selected["mod4SupportMin"] = min((int(value) for value in mod4_support), default=0)
    selected["mod4SupportMax"] = max((int(value) for value in mod4_support), default=0)
    overall = selected.get("overall") if isinstance(selected.get("overall"), dict) else {}
    selected["evidenceScore"] = round(
        float(selected.get("selectedEnergy") or 0.0) * 0.45
        + min(1.0, float(selected.get("selectedDynamicRange") or 0.0) * 4.0) * 0.30
        + min(1.0, int(selected.get("validMod4Count") or 0) / 4.0) * 0.15
        + (0.10 if overall.get("reason") == "sustained-rising-edge" else 0.0),
        6,
    )
    return selected


def refine_fixed_bpm_candidate(
    candidate: dict[str, Any],
    *,
    high_attack: np.ndarray,
    frame_rate: float,
    duration_sec: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    bpm = _finite_float(candidate.get("bpm"))
    first_beat_ms = _finite_float(candidate.get("firstBeatMs"))
    if bpm is None or bpm <= 0.0 or first_beat_ms is None:
        return candidate, {"applied": False, "reason": "invalid-candidate"}
    evidence = candidate_phase_evidence(
        high_attack,
        frame_rate=frame_rate,
        bpm=bpm,
        first_beat_ms=first_beat_ms,
        duration_sec=duration_sec,
    )
    if not evidence.get("valid"):
        return candidate, {
            "applied": False,
            "reason": str(evidence.get("reason") or "invalid-evidence"),
            "version": SELECTOR_VERSION,
        }
    shift_ms = float(evidence.get("overallShiftMs") or 0.0)
    if abs(shift_ms) <= 1e-9:
        return candidate, {
            "applied": False,
            "reason": "zero-shift",
            "version": SELECTOR_VERSION,
            "originalFirstBeatMs": round(first_beat_ms, 6),
            "refinedFirstBeatMs": round(first_beat_ms, 6),
            "shiftMs": 0.0,
            "evidence": evidence,
        }
    refined = {
        **candidate,
        "firstBeatMs": first_beat_ms + shift_ms,
        "features": {
            **dict(candidate.get("features") or {}),
            "officialHighAttackPhaseApplied": True,
            "officialHighAttackPhaseVersion": SELECTOR_VERSION,
            "officialHighAttackPhaseOriginalFirstBeatMs": round(first_beat_ms, 6),
            "officialHighAttackPhaseRefinedFirstBeatMs": round(first_beat_ms + shift_ms, 6),
            "officialHighAttackPhaseShiftMs": round(shift_ms, 6),
            "officialHighAttackPhaseEvidenceScore": round(
                float(evidence.get("evidenceScore") or 0.0),
                6,
            ),
            "officialHighAttackPhaseDynamicRange": round(
                float(evidence.get("selectedDynamicRange") or 0.0),
                9,
            ),
            "officialHighAttackPhaseSelectedEnergy": round(
                float(evidence.get("selectedEnergy") or 0.0),
                6,
            ),
            "officialHighAttackPhaseArgmaxShiftMs": round(
                float(evidence.get("argmaxShiftMs") or 0.0),
                6,
            ),
            "officialHighAttackPhaseOverallReason": str(
                ((evidence.get("overall") or {}).get("reason")) or ""
            ),
            "officialHighAttackPhaseOverallSupport": int(
                evidence.get("overallSupport") or 0
            ),
        },
    }
    return refined, {
        "applied": True,
        "reason": "overall-shape",
        "version": SELECTOR_VERSION,
        "originalFirstBeatMs": round(first_beat_ms, 6),
        "refinedFirstBeatMs": round(first_beat_ms + shift_ms, 6),
        "shiftMs": round(shift_ms, 6),
        "evidence": evidence,
    }
