import math
import statistics
from typing import Any

from beat_this_grid_solver import phase_delta_ms


def compare_window_result(left: dict[str, Any], right: dict[str, Any]) -> int:
    left_quality = float(left.get("qualityScore") or 0.0)
    right_quality = float(right.get("qualityScore") or 0.0)
    if abs(left_quality - right_quality) > 0.000001:
        return -1 if left_quality < right_quality else 1
    left_beats = int(left.get("beatCount") or 0)
    right_beats = int(right.get("beatCount") or 0)
    if left_beats != right_beats:
        return -1 if left_beats < right_beats else 1
    left_downbeats = int(left.get("downbeatCount") or 0)
    right_downbeats = int(right.get("downbeatCount") or 0)
    if left_downbeats != right_downbeats:
        return -1 if left_downbeats < right_downbeats else 1
    return 0


def _is_window_good_enough(result: dict[str, Any]) -> bool:
    return float(result.get("qualityScore") or 0.0) >= 0.72 and int(result.get("beatCount") or 0) >= 32


def _window_bpm_for_consensus(result: dict[str, Any]) -> float:
    bpm = float(result.get("rawBpm") or result.get("bpm") or 0.0)
    return bpm if math.isfinite(bpm) and bpm > 0.0 else 0.0


def _bpm_consensus_tolerance(bpm: float) -> float:
    return max(0.18, min(0.25, bpm * 0.0016))


def _best_window_result(results: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not results:
        return None
    best_result = results[0]
    for candidate in results[1:]:
        if compare_window_result(candidate, best_result) > 0:
            best_result = candidate
    return best_result


def _prefer_stable_head_candidate(
    cluster: list[dict[str, Any]],
    best_source: dict[str, Any],
) -> dict[str, Any]:
    best_quality = float(best_source.get("qualityScore") or 0.0)
    best_beats = int(best_source.get("beatCount") or 0)
    head_candidates = [
        item
        for item in cluster
        if float(item.get("firstBeatMs") or 0.0) <= 1.0
        and float(item.get("rawFirstBeatMs") or 0.0) <= 1.0
        and float(item.get("qualityScore") or 0.0) + 0.01 >= best_quality
        and int(item.get("beatCount") or 0) + 1 >= best_beats
        and float(item.get("anchorConfidenceScore") or 0.0) >= 0.55
    ]
    preferred = _best_window_result(head_candidates)
    return preferred if preferred is not None else best_source


def _cluster_direct_bpm_candidates(
    candidates: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], float]:
    best_cluster: list[dict[str, Any]] = []
    best_center = 0.0
    for candidate in candidates:
        center = _window_bpm_for_consensus(candidate)
        tolerance = _bpm_consensus_tolerance(center)
        cluster = [
            item
            for item in candidates
            if abs(_window_bpm_for_consensus(item) - center) <= tolerance
        ]
        if len(cluster) < 2:
            continue
        cluster_quality = statistics.fmean(float(item.get("qualityScore") or 0.0) for item in cluster)
        best_quality = (
            statistics.fmean(float(item.get("qualityScore") or 0.0) for item in best_cluster)
            if best_cluster
            else -1.0
        )
        if len(cluster) > len(best_cluster) or (
            len(cluster) == len(best_cluster) and cluster_quality > best_quality
        ):
            best_cluster = cluster
            best_center = statistics.median(_window_bpm_for_consensus(item) for item in cluster)
    return best_cluster, best_center


def _has_half_double_relationship(left_bpm: float, right_bpm: float) -> bool:
    if left_bpm <= 0.0 or right_bpm <= 0.0:
        return False
    higher = max(left_bpm, right_bpm)
    lower = min(left_bpm, right_bpm)
    return abs(higher - lower * 2.0) <= max(0.35, higher * 0.0025)


def _find_window_bpm_consensus(
    results: list[dict[str, Any]],
    earliest_result: dict[str, Any],
) -> dict[str, Any] | None:
    candidates = [
        item
        for item in results
        if float(item.get("qualityScore") or 0.0) >= 0.9 and _window_bpm_for_consensus(item) > 0.0
    ]
    if len(candidates) < 2:
        candidates = [
            item
            for item in results
            if float(item.get("qualityScore") or 0.0) >= 0.8
            and _window_bpm_for_consensus(item) > 0.0
        ]
    if len(candidates) < 2:
        return None

    best_cluster, best_center = _cluster_direct_bpm_candidates(candidates)
    min_support = 3 if len(candidates) >= 4 else 2
    if len(best_cluster) < min_support:
        return None

    earliest_bpm = _window_bpm_for_consensus(earliest_result)
    if earliest_bpm <= 0.0:
        return None
    if abs(earliest_bpm - best_center) <= _bpm_consensus_tolerance(best_center):
        return None

    earliest_quality = float(earliest_result.get("qualityScore") or 0.0)
    best_source = _best_window_result(best_cluster)
    if best_source is None:
        return None
    best_source = _prefer_stable_head_candidate(best_cluster, best_source)
    best_quality = float(best_source.get("qualityScore") or 0.0)
    min_quality_gain = 0.02 if len(best_cluster) >= 3 else 0.03
    if best_quality - earliest_quality >= min_quality_gain:
        return best_source

    earliest_beats = max(1, int(earliest_result.get("beatCount") or 0))
    source_beats = int(best_source.get("beatCount") or 0)
    if (
        _has_half_double_relationship(earliest_bpm, best_center)
        and len(best_cluster) >= 3
        and source_beats >= int(math.ceil(earliest_beats * 1.75))
        and best_quality + 0.035 >= earliest_quality
    ):
        return best_source

    return None


def _find_later_high_density_bpm_candidate(
    results: list[dict[str, Any]],
    earliest_result: dict[str, Any],
) -> dict[str, Any] | None:
    earliest_bpm = _window_bpm_for_consensus(earliest_result)
    earliest_quality = float(earliest_result.get("qualityScore") or 0.0)
    earliest_beats = max(1, int(earliest_result.get("beatCount") or 0))
    if not (55.0 <= earliest_bpm <= 96.0):
        return None

    candidates: list[dict[str, Any]] = []
    for item in results:
        if int(item.get("windowIndex") or 0) <= int(earliest_result.get("windowIndex") or 0):
            continue
        item_bpm = _window_bpm_for_consensus(item)
        item_quality = float(item.get("qualityScore") or 0.0)
        item_beats = int(item.get("beatCount") or 0)
        if item_bpm < 145.0 or item_bpm > 190.0:
            continue
        if item_beats < int(math.ceil(earliest_beats * 1.65)):
            continue
        if item_quality < 0.94 or item_quality + 0.03 < earliest_quality:
            continue
        candidates.append(item)

    if not candidates:
        return None
    best_candidate = _best_window_result(candidates)
    if best_candidate is None:
        return None

    candidate_bpms = [_window_bpm_for_consensus(item) for item in candidates]
    if len(candidates) >= 3 and max(candidate_bpms) - min(candidate_bpms) <= 0.75:
        return best_candidate

    direct_support = [
        item
        for item in candidates
        if abs(_window_bpm_for_consensus(item) - _window_bpm_for_consensus(best_candidate))
        <= _bpm_consensus_tolerance(_window_bpm_for_consensus(best_candidate))
    ]
    if len(direct_support) >= 2:
        return _best_window_result(direct_support)

    best_quality = float(best_candidate.get("qualityScore") or 0.0)
    best_confidence = float(best_candidate.get("anchorConfidenceScore") or 0.0)
    if best_quality - earliest_quality >= 0.08 and best_confidence >= 0.85:
        return best_candidate
    return None


def _find_later_single_high_quality_bpm_candidate(
    results: list[dict[str, Any]],
    earliest_result: dict[str, Any],
) -> dict[str, Any] | None:
    earliest_bpm = _window_bpm_for_consensus(earliest_result)
    earliest_quality = float(earliest_result.get("qualityScore") or 0.0)
    earliest_beats = max(1, int(earliest_result.get("beatCount") or 0))
    if not math.isfinite(earliest_bpm) or earliest_bpm <= 0.0:
        return None
    if earliest_quality >= 0.88:
        return None

    candidates: list[dict[str, Any]] = []
    for item in results:
        if int(item.get("windowIndex") or 0) <= int(earliest_result.get("windowIndex") or 0):
            continue
        item_bpm = _window_bpm_for_consensus(item)
        item_quality = float(item.get("qualityScore") or 0.0)
        item_beats = int(item.get("beatCount") or 0)
        item_stabilized_bpm = float(item.get("bpm") or 0.0)
        if not math.isfinite(item_bpm) or item_bpm <= 0.0:
            continue
        if item_quality < 0.96 or item_quality - earliest_quality < 0.10:
            continue
        if item_beats + 1 < earliest_beats:
            continue
        if abs(item_stabilized_bpm - earliest_bpm) < max(0.5, earliest_bpm * 0.004):
            continue
        if abs(item_stabilized_bpm - round(item_stabilized_bpm)) > 0.000001:
            continue
        if abs(item_bpm - item_stabilized_bpm) > 0.08:
            continue
        candidates.append(item)

    if len(candidates) != 1:
        return None
    return candidates[0]


def _find_later_integer_cluster_bpm_candidate(
    results: list[dict[str, Any]],
    earliest_result: dict[str, Any],
) -> dict[str, Any] | None:
    earliest_bpm = _window_bpm_for_consensus(earliest_result)
    earliest_quality = float(earliest_result.get("qualityScore") or 0.0)
    earliest_beats = max(1, int(earliest_result.get("beatCount") or 0))
    if not math.isfinite(earliest_bpm) or earliest_bpm <= 0.0:
        return None
    if earliest_quality < 0.9:
        return None

    support_candidates: list[dict[str, Any]] = []
    integer_sources: list[dict[str, Any]] = []
    for item in results:
        if int(item.get("windowIndex") or 0) <= int(earliest_result.get("windowIndex") or 0):
            continue
        item_quality = float(item.get("qualityScore") or 0.0)
        item_beats = int(item.get("beatCount") or 0)
        item_bpm = _window_bpm_for_consensus(item)
        stabilized_bpm = float(item.get("bpm") or 0.0)
        nearest_integer = round(stabilized_bpm)
        nearest_raw_integer = round(item_bpm)
        if item_quality + 0.012 < earliest_quality:
            continue
        if item_beats < earliest_beats:
            continue
        if abs(item_bpm - nearest_raw_integer) > 0.12:
            continue
        if abs(float(nearest_raw_integer) - earliest_bpm) < max(0.35, earliest_bpm * 0.0025):
            continue
        support_candidates.append(item)
        if abs(stabilized_bpm - nearest_integer) <= 0.000001:
            integer_sources.append(item)

    best_cluster: list[dict[str, Any]] = []
    for candidate in integer_sources:
        candidate_bpm = float(candidate.get("bpm") or 0.0)
        cluster = [
            item
            for item in support_candidates
            if abs(_window_bpm_for_consensus(item) - candidate_bpm) <= 0.12
        ]
        if len(cluster) > len(best_cluster):
            best_cluster = cluster
        elif len(cluster) == len(best_cluster) and cluster:
            cluster_quality = statistics.fmean(float(item.get("qualityScore") or 0.0) for item in cluster)
            best_quality = statistics.fmean(
                float(item.get("qualityScore") or 0.0) for item in best_cluster
            )
            if cluster_quality > best_quality:
                best_cluster = cluster

    if len(best_cluster) < 2:
        return None
    best_source = _best_window_result(best_cluster)
    if best_source is None:
        return None
    if int(best_source.get("beatCount") or 0) < earliest_beats + 1:
        return None
    return best_source


def _merge_bpm_from_window(
    phase_source: dict[str, Any],
    bpm_source: dict[str, Any],
    *,
    use_bpm_source_bar: bool,
) -> dict[str, Any] | None:
    bpm = float(bpm_source.get("bpm") or 0.0)
    if not math.isfinite(bpm) or bpm <= 0.0:
        return None

    merged = dict(phase_source)
    previous_bpm = float(merged.get("bpm") or 0.0)
    previous_interval_ms = 60000.0 / previous_bpm if previous_bpm > 0.0 else 0.0
    next_interval_ms = 60000.0 / bpm
    previous_first_beat_ms = float(merged.get("firstBeatMs") or 0.0)
    previous_bar_beat_offset = int(merged.get("barBeatOffset") or 0)

    merged["bpm"] = round(bpm, 6)
    merged["rawBpm"] = round(float(bpm_source.get("rawBpm") or bpm), 6)
    merged["beatIntervalSec"] = round(60.0 / bpm, 6)

    absolute_first_beat_ms = float(merged.get("absoluteFirstBeatMs") or previous_first_beat_ms)
    absolute_raw_first_beat_ms = float(
        merged.get("absoluteRawFirstBeatMs") or merged.get("rawFirstBeatMs") or previous_first_beat_ms
    )
    if (
        previous_interval_ms > 0.0
        and next_interval_ms > 0.0
        and math.isfinite(absolute_first_beat_ms)
        and math.isfinite(absolute_raw_first_beat_ms)
        and abs(previous_bpm - bpm) >= 0.5
    ):
        next_first_beat_ms = round(absolute_first_beat_ms % next_interval_ms, 3)
        next_raw_first_beat_ms = round(absolute_raw_first_beat_ms % next_interval_ms, 3)
        previous_beat_shift = int(
            round((absolute_first_beat_ms - previous_first_beat_ms) / previous_interval_ms)
        )
        next_beat_shift = int(
            round((absolute_first_beat_ms - next_first_beat_ms) / next_interval_ms)
        )
        merged["firstBeatMs"] = next_first_beat_ms
        merged["rawFirstBeatMs"] = next_raw_first_beat_ms
        merged["barBeatOffset"] = (
            previous_bar_beat_offset - previous_beat_shift + next_beat_shift
        ) % 32
        merged["anchorCorrectionMs"] = round(
            phase_delta_ms(next_first_beat_ms, next_raw_first_beat_ms, next_interval_ms),
            3,
        )

    if use_bpm_source_bar:
        merged["barBeatOffset"] = int(bpm_source.get("barBeatOffset") or 0) % 32

    merged["qualityScore"] = max(
        float(phase_source.get("qualityScore") or 0.0),
        float(bpm_source.get("qualityScore") or 0.0),
    )
    merged["bpmRefinementStrategy"] = "quality-window-bpm"
    strategy = str(merged.get("anchorStrategy") or "").strip()
    merged["anchorStrategy"] = f"{strategy}-bpm-window-select" if strategy else "bpm-window-select"
    return merged


def _find_nearby_grid_solver_phase_candidate(
    results: list[dict[str, Any]],
    earliest_result: dict[str, Any],
) -> dict[str, Any] | None:
    if int(earliest_result.get("windowIndex") or 0) != 0:
        return None
    if "grid-solver" in str(earliest_result.get("anchorStrategy") or ""):
        return None

    earliest_bpm = float(earliest_result.get("bpm") or 0.0)
    earliest_quality = float(earliest_result.get("qualityScore") or 0.0)
    if not math.isfinite(earliest_bpm) or earliest_bpm <= 0.0:
        return None
    if float(earliest_result.get("firstBeatMs") or 0.0) < 100.0:
        return None

    candidates: list[dict[str, Any]] = []
    for item in results:
        if int(item.get("windowIndex") or -1) != 1:
            continue
        if "grid-solver" not in str(item.get("anchorStrategy") or ""):
            continue
        item_bpm = float(item.get("bpm") or 0.0)
        if not math.isfinite(item_bpm) or abs(item_bpm - earliest_bpm) > _bpm_consensus_tolerance(earliest_bpm):
            continue
        correction_ms = abs(float(item.get("anchorCorrectionMs") or 0.0))
        if correction_ms < 5.0 or correction_ms > 12.0:
            continue
        if float(item.get("anchorConfidenceScore") or 0.0) < 0.95:
            continue
        if float(item.get("qualityScore") or 0.0) + 0.005 < earliest_quality:
            continue
        candidates.append(item)

    best_candidate = _best_window_result(candidates)
    if best_candidate is None:
        return None
    merged = dict(best_candidate)
    merged["barBeatOffset"] = int(earliest_result.get("barBeatOffset") or 0) % 32
    strategy = str(merged.get("anchorStrategy") or "").strip()
    merged["anchorStrategy"] = f"{strategy}-nearby-phase" if strategy else "nearby-phase"
    return merged


def select_anchor_window_result(finalized_results: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(finalized_results, key=lambda item: int(item.get("windowIndex") or 0))
    good_results = [item for item in ordered if _is_window_good_enough(item)]
    if good_results:
        earliest_good = good_results[0]
        consensus_good = _find_window_bpm_consensus(good_results, earliest_good)
        if consensus_good is None:
            consensus_good = _find_later_high_density_bpm_candidate(good_results, earliest_good)
        if consensus_good is None:
            consensus_good = _find_later_single_high_quality_bpm_candidate(
                good_results,
                earliest_good,
            )
        if consensus_good is None:
            consensus_good = _find_later_integer_cluster_bpm_candidate(
                good_results,
                earliest_good,
            )
        if consensus_good is not None:
            earliest_bpm = _window_bpm_for_consensus(earliest_good)
            consensus_bpm = _window_bpm_for_consensus(consensus_good)
            if (
                float(consensus_good.get("firstBeatMs") or 0.0) <= 1.0
                and float(consensus_good.get("rawFirstBeatMs") or 0.0) <= 1.0
                and float(earliest_good.get("firstBeatMs") or 0.0) > 1.0
                and int(consensus_good.get("beatCount") or 0) + 1
                >= int(earliest_good.get("beatCount") or 0)
                and float(consensus_good.get("qualityScore") or 0.0) + 0.01
                >= float(earliest_good.get("qualityScore") or 0.0)
            ):
                merged = dict(consensus_good)
                merged["bpmRefinementStrategy"] = "quality-window-bpm"
                strategy = str(merged.get("anchorStrategy") or "").strip()
                merged["anchorStrategy"] = (
                    f"{strategy}-bpm-window-select" if strategy else "bpm-window-select"
                )
                return merged
            use_bpm_source_bar = (
                "grid-solver" in str(earliest_good.get("anchorStrategy") or "")
                and float(earliest_good.get("qualityScore") or 0.0) < 0.82
            ) or _has_half_double_relationship(earliest_bpm, consensus_bpm)
            merged = _merge_bpm_from_window(
                earliest_good,
                consensus_good,
                use_bpm_source_bar=use_bpm_source_bar,
            )
            if merged is not None:
                return merged
        nearby_grid_solver = _find_nearby_grid_solver_phase_candidate(good_results, earliest_good)
        if nearby_grid_solver is not None:
            return nearby_grid_solver
        return earliest_good
    for item in ordered:
        if _is_window_good_enough(item):
            return item
    best_result = _best_window_result(ordered)
    return best_result if best_result is not None else finalized_results[0]
