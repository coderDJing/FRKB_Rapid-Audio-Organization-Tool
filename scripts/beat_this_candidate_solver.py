import math
import statistics
from typing import Any

import numpy as np

from beat_this_grid_solver import build_attack_envelope, moving_average

_SCORER_FEATURE_KEYS = [
    "qualityScore",
    "beatStabilityScore",
    "downbeatStabilityScore",
    "anchorConfidenceScore",
    "anchorMatchedRatio",
    "driftScore",
    "integerBpmScore",
    "timelineQuantizationScore",
    "bpmRefinementScore",
    "bpmRefinementSupportScore",
    "unsupportedRefinementRisk",
    "anchorCorrectionRisk",
    "bpmConsensusScore",
    "phaseConsensusScore",
    "downbeatConsensusScore",
    "attackPhaseScore",
    "attackLocalPeakRatio",
    "attackLocalPeakDistanceScore",
    "attackGlobalPeakRatio",
    "attackGlobalPeakDistanceScore",
    "candidateBpmPeerScore",
    "candidatePhase4PeerScore",
    "candidatePhase8PeerScore",
    "candidatePhase16PeerScore",
    "candidateDownbeat4PeerScore",
    "candidateDownbeat8PeerScore",
    "signalScore",
    "logBpm",
    "bpmFractionAbs",
    "firstBeatFrac",
    "firstBeatSin",
    "firstBeatCos",
    "timelineUnsupported",
    "timelineAnchorRisk",
    "timelineLowPhase",
    "timelineLowDownbeat",
    "timelineLowAttack",
    "nonTimelinePhasePeer",
    "nonTimelineDownbeatPeer",
    "nonTimelineLowRisk",
    "refinementNoSupport",
    "octavePeerRisk",
]

_SCORER_FEATURE_MEAN = [
    0.9278661,
    0.92109295,
    0.68629957,
    0.86403111,
    0.59178867,
    0.56635577,
    0.80934198,
    0.16764615,
    0.12116496,
    0.00317043,
    0.11830384,
    0.06247848,
    0.87277623,
    0.44868408,
    0.34612848,
    0.06958785,
    0.40274528,
    0.45167028,
    0.33192937,
    0.24192062,
    0.91406435,
    0.46185938,
    0.53329202,
    0.66797019,
    0.40846991,
    0.45780304,
    0.92348849,
    0.04437809,
    0.02911116,
    0.26634632,
    0.2496444,
    0.46989522,
    0.04953059,
    0.02288642,
    0.10555766,
    0.134205,
    0.13395963,
    0.43946952,
    0.38186034,
    0.79276179,
    0.11830384,
    0.00824765,
]

_SCORER_FEATURE_SCALE = [
    0.08076605,
    0.11382186,
    0.44224923,
    0.20183241,
    0.29199804,
    0.35512922,
    0.34927532,
    0.37355176,
    0.31710946,
    0.05464788,
    0.31338228,
    0.11519764,
    0.21701055,
    0.23723533,
    0.249158,
    0.07718068,
    0.33692535,
    0.32474594,
    0.30108211,
    0.34949814,
    0.20091683,
    0.25476147,
    0.27016381,
    0.28622165,
    0.23689671,
    0.25314799,
    0.12206928,
    0.1120187,
    0.07436263,
    0.30276131,
    0.48305601,
    0.69536541,
    0.21158597,
    0.08459703,
    0.25411848,
    0.31525328,
    0.31572211,
    0.31983275,
    0.29032391,
    0.36632238,
    0.31338228,
    0.06513149,
]

_SCORER_WEIGHTS = [
    -0.87794299,
    -0.54427002,
    -0.80638574,
    -0.63256897,
    0.42568143,
    -0.82696936,
    -0.32435499,
    0.8016765,
    -1.14402719,
    -0.09177958,
    0.73288056,
    0.2045058,
    -0.83294058,
    -0.40438125,
    -1.23633647,
    -0.32707829,
    -0.39239762,
    0.23453001,
    -2.54380868,
    0.51904755,
    1.64988924,
    0.38111957,
    0.49680001,
    0.91815039,
    -0.81783361,
    0.02920269,
    1.01309745,
    1.26760942,
    -3.3348666,
    -1.24203614,
    -2.24394282,
    -0.39465601,
    -0.48718197,
    -0.28954883,
    -0.20758238,
    0.41255587,
    0.91195039,
    -0.3538945,
    0.38524708,
    0.30859491,
    0.6710242,
    -0.17960469,
]


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, value))


def _present_float(result: dict[str, Any], key: str, default: float = 0.0) -> float:
    try:
        value = float(result.get(key, default))
    except Exception:
        return default
    return value if math.isfinite(value) else default


def _present_int(result: dict[str, Any], key: str, default: int = 0) -> int:
    try:
        return int(result.get(key, default))
    except Exception:
        return default


def _window_weight(item: dict[str, Any]) -> float:
    quality = _clamp01(_present_float(item, "qualityScore"))
    anchor_confidence = _clamp01(_present_float(item, "anchorConfidenceScore"))
    beat_factor = _clamp01(_present_float(item, "beatCount") / 64.0)
    downbeat_factor = _clamp01(_present_float(item, "downbeatCount") / 16.0)
    return max(0.001, quality * (0.45 + anchor_confidence * 0.2 + beat_factor * 0.2 + downbeat_factor * 0.15))


def _window_bpm(item: dict[str, Any]) -> float:
    bpm = _present_float(item, "rawBpm") or _present_float(item, "bpm")
    return bpm if math.isfinite(bpm) and bpm > 0.0 else 0.0


def _candidate_bpm(result: dict[str, Any]) -> float:
    bpm = _present_float(result, "bpm")
    return bpm if math.isfinite(bpm) and bpm > 0.0 else 0.0


def _bpm_close(left_bpm: float, right_bpm: float) -> bool:
    if left_bpm <= 0.0 or right_bpm <= 0.0:
        return False
    return abs(left_bpm - right_bpm) <= max(0.25, left_bpm * 0.002)


def _bpm_octave_close(candidate_bpm: float, window_bpm: float) -> bool:
    if candidate_bpm <= 0.0 or window_bpm <= 0.0:
        return False
    tolerance = max(0.35, candidate_bpm * 0.0028)
    return (
        abs(candidate_bpm - window_bpm * 2.0) <= tolerance
        or abs(candidate_bpm * 2.0 - window_bpm) <= tolerance
    )


def _phase_delta_ms(value_ms: float, reference_ms: float, interval_ms: float) -> float:
    if not math.isfinite(interval_ms) or interval_ms <= 0.0:
        return 0.0
    return ((value_ms - reference_ms + interval_ms * 0.5) % interval_ms) - interval_ms * 0.5


def _weighted_ratio(weighted_value: float, total_weight: float) -> float:
    if not math.isfinite(total_weight) or total_weight <= 0.0:
        return 0.0
    return _clamp01(weighted_value / total_weight)


def _safe_ratio(value: float, reference: float) -> float:
    if not math.isfinite(value) or not math.isfinite(reference) or reference <= 1e-9:
        return 0.0
    return _clamp01(value / reference)


def _support_features(
    result: dict[str, Any],
    window_results: list[dict[str, Any]],
) -> dict[str, float]:
    bpm = _candidate_bpm(result)
    if bpm <= 0.0 or not window_results:
        return {
            "bpmConsensusScore": 0.0,
            "bpmOctaveConsensusScore": 0.0,
            "phaseConsensusScore": 0.0,
            "downbeatConsensusScore": 0.0,
        }

    interval_ms = 60000.0 / bpm
    first_beat_ms = _present_float(result, "firstBeatMs")
    bar_mod = _present_int(result, "barBeatOffset") % 4
    total_weight = 0.0
    bpm_weight = 0.0
    octave_weight = 0.0
    phase_weight = 0.0
    downbeat_weight = 0.0

    for item in window_results:
        weight = _window_weight(item)
        total_weight += weight
        item_bpm = _window_bpm(item)
        if _bpm_close(bpm, item_bpm):
            bpm_weight += weight
            item_phase_ms = _present_float(item, "firstBeatMs")
            phase_error_ms = abs(_phase_delta_ms(item_phase_ms, first_beat_ms, interval_ms))
            if phase_error_ms <= 20.0:
                phase_weight += weight * _clamp01((20.0 - phase_error_ms) / 20.0)
                if phase_error_ms <= 8.0 and _present_int(item, "barBeatOffset") % 4 == bar_mod:
                    downbeat_weight += weight
        elif _bpm_octave_close(bpm, item_bpm):
            octave_weight += weight * 0.55
            item_phase_ms = _present_float(item, "firstBeatMs")
            phase_error_ms = abs(_phase_delta_ms(item_phase_ms, first_beat_ms, interval_ms))
            if phase_error_ms <= 20.0:
                phase_weight += weight * 0.65 * _clamp01((20.0 - phase_error_ms) / 20.0)
                if phase_error_ms <= 8.0 and _present_int(item, "barBeatOffset") % 4 == bar_mod:
                    downbeat_weight += weight * 0.65

    return {
        "bpmConsensusScore": round(_weighted_ratio(bpm_weight, total_weight), 6),
        "bpmOctaveConsensusScore": round(_weighted_ratio(octave_weight, total_weight), 6),
        "phaseConsensusScore": round(_weighted_ratio(phase_weight, total_weight), 6),
        "downbeatConsensusScore": round(_weighted_ratio(downbeat_weight, total_weight), 6),
    }


def _score_grid_phase(
    score_envelope: np.ndarray,
    envelope_sample_rate: int,
    bpm: float,
    phase_ms: float,
    max_beats: int,
) -> tuple[float, int]:
    if (
        score_envelope.size == 0
        or envelope_sample_rate <= 0
        or not math.isfinite(bpm)
        or bpm <= 0.0
        or not math.isfinite(phase_ms)
        or max_beats <= 0
    ):
        return 0.0, 0

    beat_interval_samples = (60.0 / bpm) * float(envelope_sample_rate)
    if beat_interval_samples <= 0.0:
        return 0.0, 0

    values: list[float] = []
    position = (phase_ms / 1000.0) * float(envelope_sample_rate)
    while len(values) < max_beats and position < float(score_envelope.size):
        rounded = int(round(position))
        if 0 <= rounded < score_envelope.size:
            values.append(float(score_envelope[rounded]))
        position += beat_interval_samples

    if len(values) < 16:
        return 0.0, len(values)
    ordered = sorted(values)
    lower_quarter = ordered[: max(1, len(ordered) // 4)]
    return statistics.fmean(values) * 0.75 + statistics.fmean(lower_quarter) * 0.25, len(values)


def _build_attack_context(
    signal: np.ndarray | None,
    sample_rate: int,
    tuning: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if signal is None or sample_rate <= 0 or not isinstance(tuning, dict):
        return None
    attack_tuning = dict(tuning)
    attack_tuning["focusMode"] = "full"
    attack_tuning["envelopeSampleRateFull"] = max(4000, int(attack_tuning["envelopeSampleRateFull"]))
    attack_tuning["scoreWindowMs"] = min(float(attack_tuning["scoreWindowMs"]), 4.0)
    attack_result = build_attack_envelope(signal, sample_rate, attack_tuning)
    if attack_result is None:
        return None
    attack_envelope, envelope_sample_rate = attack_result
    if attack_envelope.size < 64:
        return None
    score_window = max(
        1,
        int(round(envelope_sample_rate * (float(attack_tuning["scoreWindowMs"]) / 1000.0))),
    )
    return {
        "scoreEnvelope": moving_average(attack_envelope, score_window),
        "envelopeSampleRate": int(envelope_sample_rate),
        "maxBeats": max(192, int(attack_tuning["maxBeats"]) * 4),
        "globalPhaseCache": {},
    }


def _find_best_global_attack_phase(
    attack_context: dict[str, Any],
    bpm: float,
) -> tuple[float, float, int] | None:
    cache = attack_context["globalPhaseCache"]
    cache_key = round(float(bpm), 6)
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
    if interval_ms <= 0.0:
        return None

    best_phase_ms = 0.0
    best_score = 0.0
    best_support = 0
    phase_ms = 0.0
    while phase_ms < interval_ms:
        score, support = _score_grid_phase(
            attack_context["scoreEnvelope"],
            int(attack_context["envelopeSampleRate"]),
            bpm,
            phase_ms,
            int(attack_context["maxBeats"]),
        )
        if support >= 64 and score > best_score:
            best_phase_ms = phase_ms
            best_score = score
            best_support = support
        phase_ms += 1.0

    result = (best_phase_ms, best_score, best_support) if best_support >= 64 else None
    cache[cache_key] = result
    return result


def _attack_features(
    result: dict[str, Any],
    attack_context: dict[str, Any] | None,
) -> dict[str, float]:
    bpm = _candidate_bpm(result)
    if attack_context is None or bpm <= 0.0:
        return {
            "attackPhaseScore": 0.0,
            "attackPhaseSupportScore": 0.0,
            "attackLocalPeakRatio": 0.0,
            "attackLocalPeakDistanceScore": 0.0,
            "attackGlobalPeakRatio": 0.0,
            "attackGlobalPeakDistanceScore": 0.0,
        }

    phase_ms = _present_float(result, "firstBeatMs")
    current_score, support = _score_grid_phase(
        attack_context["scoreEnvelope"],
        int(attack_context["envelopeSampleRate"]),
        bpm,
        phase_ms,
        int(attack_context["maxBeats"]),
    )
    local_best_score = 0.0
    local_best_distance_ms = 999.0
    for shift_ms in range(-30, 31):
        score, _support = _score_grid_phase(
            attack_context["scoreEnvelope"],
            int(attack_context["envelopeSampleRate"]),
            bpm,
            phase_ms + float(shift_ms),
            int(attack_context["maxBeats"]),
        )
        if score > local_best_score:
            local_best_score = score
            local_best_distance_ms = abs(float(shift_ms))

    global_peak = _find_best_global_attack_phase(attack_context, bpm)
    if global_peak is None:
        global_best_score = 0.0
        global_peak_distance_ms = 999.0
    else:
        global_phase_ms, global_best_score, _global_support = global_peak
        global_peak_distance_ms = abs(
            _phase_delta_ms(phase_ms, global_phase_ms, 60000.0 / bpm)
        )

    return {
        "attackPhaseScore": round(_clamp01(current_score), 6),
        "attackPhaseSupportScore": round(_clamp01(float(support) / 192.0), 6),
        "attackLocalPeakRatio": round(_safe_ratio(current_score, local_best_score), 6),
        "attackLocalPeakDistanceScore": round(_clamp01((24.0 - min(24.0, local_best_distance_ms)) / 24.0), 6),
        "attackGlobalPeakRatio": round(_safe_ratio(current_score, global_best_score), 6),
        "attackGlobalPeakDistanceScore": round(
            _clamp01((32.0 - min(32.0, global_peak_distance_ms)) / 32.0),
            6,
        ),
    }


def _base_score_features(
    result: dict[str, Any],
    window_results: list[dict[str, Any]],
    attack_context: dict[str, Any] | None,
) -> dict[str, float]:
    support = _support_features(result, window_results)
    quality = _clamp01(_present_float(result, "qualityScore"))
    beat_stability = _clamp01(_present_float(result, "beatStabilityScore"))
    downbeat_stability = _clamp01(_present_float(result, "downbeatStabilityScore"))
    beat_coverage = _clamp01(_present_float(result, "beatCoverageScore"))
    downbeat_coverage = _clamp01(_present_float(result, "downbeatCoverageScore"))
    anchor_confidence = _clamp01(_present_float(result, "anchorConfidenceScore"))
    matched_ratio = _clamp01(_present_float(result, "anchorMatchedBeatCount") / max(1.0, _present_float(result, "beatCount")))
    drift_128_ms = abs(_present_float(result, "beatThisEstimatedDrift128Ms", 24.0))
    drift_score = _clamp01((24.0 - min(24.0, drift_128_ms)) / 24.0)
    correction_risk = _clamp01(abs(_present_float(result, "anchorCorrectionMs")) / 80.0)
    timeline_quantization_shift_ms = abs(_present_float(result, "timelineQuantizationShiftMs", 999.0))
    timeline_quantization_score = 1.0 if timeline_quantization_shift_ms <= 0.5 else 0.0
    has_bpm_refinement = result.get("bpmRefinementScoreGain") is not None
    bpm_refinement_gain = _present_float(result, "bpmRefinementScoreGain") if has_bpm_refinement else 0.0
    bpm_refinement_score = _clamp01((bpm_refinement_gain + 0.04) / 0.16) if has_bpm_refinement else 0.0
    bpm_refinement_support_score = max(
        _clamp01(_present_float(result, "bpmRefinementSupport") / 128.0),
        _clamp01(_present_float(result, "bpmRefinementWindowSupport") / 4.0),
    )
    bpm = _candidate_bpm(result)
    integer_bpm_score = 0.0
    if bpm > 0.0:
        integer_bpm_score = _clamp01((0.08 - min(0.08, abs(bpm - round(bpm)))) / 0.08)

    features = {
        "qualityScore": round(quality, 6),
        "beatCoverageScore": round(beat_coverage, 6),
        "beatStabilityScore": round(beat_stability, 6),
        "downbeatCoverageScore": round(downbeat_coverage, 6),
        "downbeatStabilityScore": round(downbeat_stability, 6),
        "anchorConfidenceScore": round(anchor_confidence, 6),
        "anchorMatchedRatio": round(matched_ratio, 6),
        "driftScore": round(drift_score, 6),
        "integerBpmScore": round(integer_bpm_score, 6),
        "timelineQuantizationScore": round(timeline_quantization_score, 6),
        "bpmRefinementScore": round(bpm_refinement_score, 6),
        "bpmRefinementSupportScore": round(bpm_refinement_support_score, 6),
        "anchorCorrectionRisk": round(correction_risk, 6),
        **support,
        **_attack_features(result, attack_context),
    }
    features["signalScore"] = round(
        quality * 0.21
        + beat_stability * 0.11
        + downbeat_stability * 0.07
        + beat_coverage * 0.05
        + downbeat_coverage * 0.04
        + anchor_confidence * 0.12
        + matched_ratio * 0.06
        + support["bpmConsensusScore"] * 0.12
        + support["bpmOctaveConsensusScore"] * 0.04
        + support["phaseConsensusScore"] * 0.10
        + support["downbeatConsensusScore"] * 0.04
        + drift_score * 0.09
        + integer_bpm_score * 0.03
        + timeline_quantization_score * 0.01
        + bpm_refinement_score * 0.12
        + bpm_refinement_support_score * 0.07
        - correction_risk * 0.08
        + features["attackPhaseScore"] * 0.04
        + features["attackLocalPeakRatio"] * 0.08
        + features["attackLocalPeakDistanceScore"] * 0.08
        + features["attackGlobalPeakRatio"] * 0.05
        + features["attackGlobalPeakDistanceScore"] * 0.05,
        6,
    )
    features["solverScore"] = features["signalScore"]
    return features


def _candidate_weight(candidate: dict[str, Any]) -> float:
    features = candidate["features"]
    return max(
        0.001,
        float(features["qualityScore"]) * 0.35
        + float(features["anchorConfidenceScore"]) * 0.20
        + float(features["beatStabilityScore"]) * 0.15
        + float(features["downbeatStabilityScore"]) * 0.15
        + float(features["attackLocalPeakRatio"]) * 0.15,
    )


def _attach_candidate_pool_features(scored_candidates: list[dict[str, Any]]) -> None:
    total_weight = sum(_candidate_weight(candidate) for candidate in scored_candidates)
    if total_weight <= 0.0:
        total_weight = 1.0
    for candidate in scored_candidates:
        result = candidate["result"]
        bpm = _candidate_bpm(result)
        interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
        first_beat_ms = _present_float(result, "firstBeatMs")
        bar_mod = _present_int(result, "barBeatOffset") % 4
        bpm_weight = 0.0
        octave_weight = 0.0
        phase_4_weight = 0.0
        phase_8_weight = 0.0
        phase_16_weight = 0.0
        downbeat_4_weight = 0.0
        downbeat_8_weight = 0.0

        for peer in scored_candidates:
            peer_result = peer["result"]
            peer_bpm = _candidate_bpm(peer_result)
            weight = _candidate_weight(peer)
            if _bpm_close(bpm, peer_bpm):
                bpm_weight += weight
                phase_error_ms = abs(
                    _phase_delta_ms(
                        _present_float(peer_result, "firstBeatMs"),
                        first_beat_ms,
                        interval_ms,
                    )
                )
                if phase_error_ms <= 4.0:
                    phase_4_weight += weight
                    if _present_int(peer_result, "barBeatOffset") % 4 == bar_mod:
                        downbeat_4_weight += weight
                if phase_error_ms <= 8.0:
                    phase_8_weight += weight
                    if _present_int(peer_result, "barBeatOffset") % 4 == bar_mod:
                        downbeat_8_weight += weight
                if phase_error_ms <= 16.0:
                    phase_16_weight += weight
            elif _bpm_octave_close(bpm, peer_bpm):
                octave_weight += weight * 0.55

        features = candidate["features"]
        features["candidateBpmPeerScore"] = round(_weighted_ratio(bpm_weight, total_weight), 6)
        features["candidateBpmOctavePeerScore"] = round(_weighted_ratio(octave_weight, total_weight), 6)
        features["candidatePhase4PeerScore"] = round(_weighted_ratio(phase_4_weight, total_weight), 6)
        features["candidatePhase8PeerScore"] = round(_weighted_ratio(phase_8_weight, total_weight), 6)
        features["candidatePhase16PeerScore"] = round(_weighted_ratio(phase_16_weight, total_weight), 6)
        features["candidateDownbeat4PeerScore"] = round(_weighted_ratio(downbeat_4_weight, total_weight), 6)
        features["candidateDownbeat8PeerScore"] = round(_weighted_ratio(downbeat_8_weight, total_weight), 6)


def _finalize_solver_scores(scored_candidates: list[dict[str, Any]]) -> None:
    for candidate in scored_candidates:
        features = candidate["features"]
        unsupported_refinement = float(features["bpmRefinementScore"]) * (
            1.0 - float(features["bpmRefinementSupportScore"])
        )
        features["unsupportedRefinementRisk"] = round(unsupported_refinement, 6)
        features["solverScore"] = round(_model_score(candidate), 6)


def _engineered_feature_value(candidate: dict[str, Any], key: str) -> float:
    result = candidate["result"]
    features = candidate["features"]
    if key in features:
        return float(features[key])

    bpm = _candidate_bpm(result)
    first_beat_ms = _present_float(result, "firstBeatMs")
    interval_ms = 60000.0 / bpm if bpm > 0.0 else 0.0
    first_beat_fraction = (first_beat_ms % interval_ms) / interval_ms if interval_ms > 0.0 else 0.0
    timeline_score = float(features["timelineQuantizationScore"])
    non_timeline_score = 1.0 - timeline_score

    if key == "logBpm":
        return math.log(max(1e-6, bpm) / 128.0)
    if key == "bpmFractionAbs":
        return abs(bpm - round(bpm)) if bpm > 0.0 else 1.0
    if key == "firstBeatFrac":
        return first_beat_fraction
    if key == "firstBeatSin":
        return math.sin(first_beat_fraction * math.tau)
    if key == "firstBeatCos":
        return math.cos(first_beat_fraction * math.tau)
    if key == "timelineUnsupported":
        return timeline_score * float(features["unsupportedRefinementRisk"])
    if key == "timelineAnchorRisk":
        return timeline_score * float(features["anchorCorrectionRisk"])
    if key == "timelineLowPhase":
        return timeline_score * (1.0 - float(features["phaseConsensusScore"]))
    if key == "timelineLowDownbeat":
        return timeline_score * (1.0 - float(features["downbeatConsensusScore"]))
    if key == "timelineLowAttack":
        return timeline_score * (1.0 - float(features["attackLocalPeakRatio"]))
    if key == "nonTimelinePhasePeer":
        return non_timeline_score * float(features["candidatePhase8PeerScore"])
    if key == "nonTimelineDownbeatPeer":
        return non_timeline_score * float(features["candidateDownbeat8PeerScore"])
    if key == "nonTimelineLowRisk":
        return non_timeline_score * (1.0 - float(features["anchorCorrectionRisk"]))
    if key == "refinementNoSupport":
        return float(features["bpmRefinementScore"]) * (1.0 - float(features["bpmRefinementSupportScore"]))
    if key == "octavePeerRisk":
        return float(features["candidateBpmOctavePeerScore"]) + float(features["bpmOctaveConsensusScore"])
    return 0.0


def _model_score(candidate: dict[str, Any]) -> float:
    score = 0.0
    for key, mean, scale, weight in zip(
        _SCORER_FEATURE_KEYS,
        _SCORER_FEATURE_MEAN,
        _SCORER_FEATURE_SCALE,
        _SCORER_WEIGHTS,
    ):
        safe_scale = scale if abs(scale) > 1e-9 else 1.0
        score += ((_engineered_feature_value(candidate, key) - mean) / safe_scale) * weight
    return score


def _passes_precision_guard(candidate: dict[str, Any]) -> bool:
    features = candidate["features"]
    return (
        float(features["timelineQuantizationScore"]) >= 0.5
        and float(features["integerBpmScore"]) >= 0.9
        and float(features["candidateBpmPeerScore"]) >= 0.5
        and float(features["signalScore"]) >= 0.85
        and float(features["anchorCorrectionRisk"]) <= 0.35
    )


def _select_scored_candidate(scored_candidates: list[dict[str, Any]]) -> dict[str, Any]:
    selected = scored_candidates[0]
    quantized_candidates = [candidate for candidate in scored_candidates if _passes_precision_guard(candidate)]
    if not quantized_candidates:
        return selected
    quantized = max(quantized_candidates, key=_candidate_sort_key)
    score_margin = float(selected["features"]["solverScore"]) - float(quantized["features"]["solverScore"])
    if score_margin <= 1.8:
        quantized["selectionGuard"] = "timeline-precision"
        quantized["selectionGuardScoreMargin"] = round(score_margin, 6)
        return quantized
    return selected


def build_grid_candidate(
    source: str,
    result: dict[str, Any],
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "source": str(source or "unknown"),
        "result": dict(result),
        "details": dict(details or {}),
    }


def _candidate_sort_key(candidate: dict[str, Any]) -> tuple[float, float, float, float, float, int]:
    features = candidate["features"]
    result = candidate["result"]
    return (
        float(features["solverScore"]),
        float(features["phaseConsensusScore"]),
        float(features["bpmConsensusScore"]),
        float(features["downbeatConsensusScore"]),
        float(features["driftScore"]),
        int(result.get("beatCount") or 0),
    )


def _diagnostic_summary(candidate: dict[str, Any]) -> dict[str, Any]:
    result = candidate["result"]
    return {
        "source": candidate["source"],
        "score": candidate["features"]["solverScore"],
        "bpm": round(_candidate_bpm(result), 6),
        "firstBeatMs": round(_present_float(result, "firstBeatMs"), 3),
        "barBeatOffset": _present_int(result, "barBeatOffset") % 32,
        "features": candidate["features"],
    }


def select_grid_candidate(
    candidates: list[dict[str, Any]],
    window_results: list[dict[str, Any]],
    *,
    signal: np.ndarray | None = None,
    sample_rate: int = 0,
    tuning: dict[str, Any] | None = None,
) -> dict[str, Any]:
    attack_context = _build_attack_context(signal, sample_rate, tuning)
    scored_candidates: list[dict[str, Any]] = []
    for candidate in candidates:
        result = candidate.get("result") if isinstance(candidate, dict) else None
        if not isinstance(result, dict) or _candidate_bpm(result) <= 0.0:
            continue
        if not math.isfinite(_present_float(result, "firstBeatMs")):
            continue
        next_candidate = dict(candidate)
        next_candidate["result"] = dict(result)
        next_candidate["features"] = _base_score_features(result, window_results, attack_context)
        scored_candidates.append(next_candidate)

    if not scored_candidates:
        raise RuntimeError("grid solver candidate pool is empty")

    _attach_candidate_pool_features(scored_candidates)
    _finalize_solver_scores(scored_candidates)
    scored_candidates.sort(key=_candidate_sort_key, reverse=True)
    selected = _select_scored_candidate(scored_candidates)
    result = dict(selected["result"])
    result["gridSolverSelectedSource"] = selected["source"]
    result["gridSolverCandidateCount"] = len(scored_candidates)
    result["gridSolverScore"] = selected["features"]["solverScore"]
    result["gridSolverFeatures"] = selected["features"]
    if selected.get("selectionGuard"):
        result["gridSolverSelectionGuard"] = selected["selectionGuard"]
        result["gridSolverSelectionGuardScoreMargin"] = selected.get("selectionGuardScoreMargin")
    result["gridSolverTopCandidates"] = [_diagnostic_summary(item) for item in scored_candidates[:10]]
    result["gridSolverCandidates"] = [_diagnostic_summary(item) for item in scored_candidates]
    return result
