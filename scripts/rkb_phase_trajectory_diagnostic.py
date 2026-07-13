import argparse
import json
import math
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

import benchmark_rkb_rekordbox_truth as benchmark
from beat_this_full_logit_utils import _grid_times_for_phase
from beat_this_grid_solver import moving_average
from rkb_beatgrid_candidate_lab import _sigmoid
from rkb_beatgrid_lab_common import (
    BENCHMARK_OUTPUT_DIR,
    atomic_write_json,
    build_feature_index_map,
    read_feature_metadata,
    resolve_feature_arrays_path,
    resolve_feature_entry,
)

VERSION = "rkb-phase-trajectory-diagnostic-v1"
DEFAULT_CURRENT_BENCHMARK = BENCHMARK_OUTPUT_DIR / "frkb-current-latest.json"
DEFAULT_CURRENT_SPLITS = BENCHMARK_OUTPUT_DIR / "rkb-dataset-splits-current.json"
DEFAULT_CURRENT_FEATURE_CACHE = BENCHMARK_OUTPUT_DIR / "feature-cache"
DEFAULT_BLIND_ROOT = BENCHMARK_OUTPUT_DIR / "blind-rekordbox-truth"
DEFAULT_BLIND_BENCHMARK = DEFAULT_BLIND_ROOT / "frkb-blind-constant-grid-dp-phasepath-diagnostic.json"
DEFAULT_BLIND_SPLITS = DEFAULT_BLIND_ROOT / "rkb-blind-dataset-splits.json"
DEFAULT_BLIND_FEATURE_CACHE = DEFAULT_BLIND_ROOT / "feature-cache"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "phase-trajectory-diagnostic-latest.json"

SIGNAL_ORDER = ("beatLogit", "fullAttack", "lowAttack")
BLOCK_SIZE = 16
BEAT_LIMIT = 64
OFFSET_LIMIT_MS = 24.0
OFFSET_STEP_MS = 2.0
GUARD_CONFIGS = (
    {
        "name": "full-margin-0.20",
        "fullMinMargin": 0.20,
    },
    {
        "name": "low-margin-0.18",
        "lowMinMargin": 0.18,
    },
    {
        "name": "full-0.20-low-0.18",
        "fullMinMargin": 0.20,
        "lowMinMargin": 0.18,
    },
    {
        "name": "full-0.24-low-0.20",
        "fullMinMargin": 0.24,
        "lowMinMargin": 0.20,
    },
    {
        "name": "full-0.20-offset-6-12",
        "fullMinMargin": 0.20,
        "fullOffsetMinMs": 6.0,
        "fullOffsetMaxMs": 12.0,
    },
    {
        "name": "low-0.18-offset-8-14",
        "lowMinMargin": 0.18,
        "lowOffsetMinMs": 8.0,
        "lowOffsetMaxMs": 14.0,
    },
    {
        "name": "full-0.20-low-0.18-score-0.84",
        "fullMinMargin": 0.20,
        "lowMinMargin": 0.18,
        "topMinScore": 0.84,
    },
    {
        "name": "full-margin-0.35",
        "fullMinMargin": 0.35,
    },
    {
        "name": "low-margin-0.30",
        "lowMinMargin": 0.30,
    },
    {
        "name": "full-0.30-low-0.25",
        "fullMinMargin": 0.30,
        "lowMinMargin": 0.25,
    },
    {
        "name": "full-0.35-low-0.30",
        "fullMinMargin": 0.35,
        "lowMinMargin": 0.30,
    },
    {
        "name": "full-0.30-low-0.25-score-0.90",
        "fullMinMargin": 0.30,
        "lowMinMargin": 0.25,
        "topMinScore": 0.90,
    },
)


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _round(value: Any, digits: int = 6) -> float | None:
    numeric = _to_float(value)
    if numeric is None:
        return None
    return round(numeric, digits)


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 6) if values else None


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 6) if values else None


def _rate(count: int, total: int) -> float:
    return round(count / total, 6) if total > 0 else 0.0


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"expected JSON object: {path}")
    return payload


def _tracks(path: Path) -> list[dict[str, Any]]:
    tracks = _load_json(path).get("tracks")
    if not isinstance(tracks, list):
        raise RuntimeError(f"benchmark contains no tracks: {path}")
    return [track for track in tracks if isinstance(track, dict)]


def _split_map(path: Path) -> dict[str, str]:
    splits = _load_json(path).get("splits")
    result: dict[str, str] = {}
    if not isinstance(splits, dict):
        return result
    for split_name, names in splits.items():
        if not isinstance(names, list):
            continue
        for name in names:
            key = benchmark._normalize_lookup_key(name)
            if key:
                result[key] = str(split_name)
    return result


def _phase_delta_ms(a_ms: float, b_ms: float, beat_interval_ms: float) -> float:
    if beat_interval_ms <= 0.0:
        return a_ms - b_ms
    return (a_ms - b_ms + beat_interval_ms / 2.0) % beat_interval_ms - beat_interval_ms / 2.0


def _candidate_source(candidate: dict[str, Any]) -> str:
    return str(candidate.get("source") or "")


def _is_legacy_candidate(candidate: dict[str, Any]) -> bool:
    source = _candidate_source(candidate).lower()
    features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    legacy_source = str(features.get("legacyGridSolverSelectedSource") or "").lower()
    return "legacy" in source or bool(legacy_source)


def _candidate_metrics(
    *,
    candidate: dict[str, Any],
    truth: dict[str, Any],
    offset_ms: float,
    rank: int,
) -> dict[str, Any] | None:
    bpm = _to_float(candidate.get("bpm"))
    first_beat_ms = _to_float(candidate.get("firstBeatMs"))
    truth_bpm = _to_float(truth.get("bpm"))
    if bpm is None or bpm <= 0.0 or first_beat_ms is None or truth_bpm is None or truth_bpm <= 0.0:
        return None
    bar_beat_offset = benchmark._normalize_bar_offset(candidate.get("barBeatOffset"), 32)
    timeline_first_beat_ms = first_beat_ms + offset_ms
    metrics = benchmark._derive_grid_metrics(
        result_bpm=bpm,
        result_first_beat_timeline_ms=timeline_first_beat_ms,
        result_bar_beat_offset=bar_beat_offset,
        truth=truth,
        compare_count=128,
    )
    classification = benchmark._classify(metrics, bpm, truth_bpm)
    return {
        "rank": rank,
        "source": _candidate_source(candidate),
        "score": _round(candidate.get("score")) or 0.0,
        "bpm": round(bpm, 6),
        "firstBeatMs": round(first_beat_ms, 3),
        "timelineFirstBeatMs": round(timeline_first_beat_ms, 3),
        "barBeatOffset": bar_beat_offset,
        "category": classification["category"],
        "firstBeatPhaseErrorMs": metrics["firstBeatPhaseErrorMs"],
        "firstBeatPhaseAbsErrorMs": metrics["firstBeatPhaseAbsErrorMs"],
        "gridMaxAbsMs": metrics["gridMaxAbsMs"],
        "bpmOnlyDrift128BeatsMs": metrics["bpmOnlyDrift128BeatsMs"],
        "isLegacy": _is_legacy_candidate(candidate),
    }


def _evaluated_candidates(track: dict[str, Any]) -> list[dict[str, Any]]:
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    raw_candidates = analysis.get("gridSolverCandidates")
    candidates = [item for item in raw_candidates if isinstance(item, dict)] if isinstance(raw_candidates, list) else []
    truth = track.get("truth") if isinstance(track.get("truth"), dict) else {}
    offset_ms = _to_float((truth.get("timeBasis") or {}).get("offsetMs")) or 0.0
    result: list[dict[str, Any]] = []
    for rank, candidate in enumerate(candidates, start=1):
        evaluated = _candidate_metrics(candidate=candidate, truth=truth, offset_ms=offset_ms, rank=rank)
        if evaluated is not None:
            result.append(evaluated)
    return result


def _top_new_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    for candidate in candidates:
        if not bool(candidate.get("isLegacy")):
            return candidate
    return candidates[0] if candidates else None


def _best_passing_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    passing = [item for item in candidates if item["category"] == "pass"]
    return min(passing, key=lambda item: int(item["rank"]), default=None)


def _load_signal_bundle(
    *,
    track: dict[str, Any],
    feature_cache_dir: Path,
    index_map: dict[str, dict[str, Any]],
) -> dict[str, tuple[np.ndarray, float]] | None:
    entry = resolve_feature_entry(track=track, index_map=index_map)
    if entry is None:
        return None
    metadata = read_feature_metadata(feature_cache_dir, entry, track=track)
    arrays_path = resolve_feature_arrays_path(feature_cache_dir, entry, metadata)
    if not arrays_path.exists():
        return None
    with np.load(arrays_path, allow_pickle=False) as arrays:
        beat_logits = _sigmoid(np.asarray(arrays["beatLogits"], dtype="float64"))
        full_attack = np.asarray(arrays["fullAttackEnvelope"], dtype="float64")
        low_attack = np.asarray(arrays["lowrateAttackEnvelope"], dtype="float64")
        beat_rate = float(np.asarray(arrays["beatLogitFrameRate"]).item())
        full_rate = float(np.asarray(arrays["fullAttackSampleRate"]).item())
        low_rate = float(np.asarray(arrays["lowrateAttackSampleRate"]).item())
    full_window = max(1, int(round(full_rate * 0.008)))
    low_window = max(1, int(round(low_rate * 0.012)))
    return {
        "beatLogit": (beat_logits, beat_rate),
        "fullAttack": (moving_average(full_attack, full_window), full_rate),
        "lowAttack": (moving_average(low_attack, low_window), low_rate),
    }


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float | None:
    if values.size == 0 or values.size != weights.size:
        return None
    total = float(np.sum(weights))
    if not math.isfinite(total) or total <= 0.0:
        return None
    order = np.argsort(values)
    sorted_values = values[order]
    sorted_weights = weights[order]
    cumulative = np.cumsum(sorted_weights)
    index = int(np.searchsorted(cumulative, total * 0.5, side="left"))
    index = max(0, min(index, sorted_values.size - 1))
    return float(sorted_values[index])


def _trajectory_profile(
    *,
    values: np.ndarray,
    frame_rate: float,
    bpm: float,
    phase_ms: float,
    duration_sec: float,
) -> dict[str, Any]:
    empty = {
        "support": 0,
        "blockCount": 0,
        "medianOffsetMs": None,
        "offsetMadMs": None,
        "segmentAgreement": 0.0,
        "meanBestScore": None,
        "meanCenterScore": None,
        "meanMargin": None,
        "positiveOffsetCount": 0,
        "negativeOffsetCount": 0,
        "zeroOffsetCount": 0,
    }
    if values.size == 0 or frame_rate <= 0.0 or bpm <= 0.0 or duration_sec <= 0.0:
        return empty
    times_sec = _grid_times_for_phase(phase_ms, bpm, min(duration_sec, 120.0))
    times_sec = times_sec[times_sec >= 0.0][:BEAT_LIMIT]
    if times_sec.size < 8:
        return empty

    offset_ms = np.arange(-OFFSET_LIMIT_MS, OFFSET_LIMIT_MS + 0.001, OFFSET_STEP_MS, dtype="float64")
    offset_samples = np.rint(offset_ms * frame_rate / 1000.0).astype("int64", copy=False)
    unique_indices = np.unique(offset_samples, return_index=True)[1]
    offset_samples = offset_samples[np.sort(unique_indices)]
    offset_ms = offset_ms[np.sort(unique_indices)]
    if offset_samples.size == 0:
        return empty
    center_index = int(np.argmin(np.abs(offset_ms)))

    block_offsets: list[float] = []
    block_weights: list[float] = []
    best_scores: list[float] = []
    center_scores: list[float] = []
    margins: list[float] = []
    support = 0
    for start in range(0, int(times_sec.size), BLOCK_SIZE):
        block_times = times_sec[start : start + BLOCK_SIZE]
        if block_times.size < 8:
            continue
        positions = np.rint(block_times * frame_rate).astype("int64", copy=False)
        indices = positions[:, None] + offset_samples[None, :]
        valid = (indices >= 0) & (indices < values.size)
        if not bool(np.any(valid)):
            continue
        clipped = np.clip(indices, 0, max(0, values.size - 1))
        sampled = values[clipped].astype("float64", copy=False)
        sampled = np.where(valid, sampled, np.nan)
        scores = np.nanmean(sampled, axis=0)
        finite = np.isfinite(scores)
        if int(np.count_nonzero(finite)) < 3:
            continue
        best_index = int(np.nanargmax(scores))
        best_score = float(scores[best_index])
        center_score = float(scores[center_index]) if math.isfinite(float(scores[center_index])) else 0.0
        margin = best_score - center_score
        block_offsets.append(float(offset_ms[best_index]))
        best_scores.append(best_score)
        center_scores.append(center_score)
        margins.append(margin)
        block_weights.append(max(0.001, best_score * float(block_times.size)))
        support += int(block_times.size)

    if not block_offsets:
        return empty
    offsets = np.asarray(block_offsets, dtype="float64")
    weights = np.asarray(block_weights, dtype="float64")
    median_offset = _weighted_median(offsets, weights)
    if median_offset is None:
        return empty
    offset_mad = _weighted_median(np.abs(offsets - median_offset), weights)
    if offset_mad is None:
        offset_mad = 999.0
    segment_agreement = max(0.0, min(1.0, 1.0 - float(offset_mad) / 12.0))
    return {
        "support": int(support),
        "blockCount": len(block_offsets),
        "medianOffsetMs": round(float(median_offset), 3),
        "offsetMadMs": round(float(offset_mad), 3),
        "segmentAgreement": round(segment_agreement, 6),
        "meanBestScore": round(statistics.fmean(best_scores), 6),
        "meanCenterScore": round(statistics.fmean(center_scores), 6),
        "meanMargin": round(statistics.fmean(margins), 6),
        "positiveOffsetCount": int(np.count_nonzero(offsets > 0.0)),
        "negativeOffsetCount": int(np.count_nonzero(offsets < 0.0)),
        "zeroOffsetCount": int(np.count_nonzero(offsets == 0.0)),
    }


def _trajectory_comparison(
    *,
    top: dict[str, Any],
    best: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]],
    duration_sec: float,
    beat_interval_ms: float,
) -> dict[str, Any]:
    phase_delta_ms = _phase_delta_ms(
        float(top["timelineFirstBeatMs"]),
        float(best["timelineFirstBeatMs"]),
        beat_interval_ms,
    )
    result: dict[str, Any] = {
        "topToBestPhaseDeltaMs": round(phase_delta_ms, 3),
        "topToBestPhaseAbsDeltaMs": round(abs(phase_delta_ms), 3),
        "signals": {},
    }
    for signal_name in SIGNAL_ORDER:
        values, frame_rate = signal_bundle[signal_name]
        top_profile = _trajectory_profile(
            values=values,
            frame_rate=frame_rate,
            bpm=float(top["bpm"]),
            phase_ms=float(top["firstBeatMs"]),
            duration_sec=duration_sec,
        )
        best_profile = _trajectory_profile(
            values=values,
            frame_rate=frame_rate,
            bpm=float(best["bpm"]),
            phase_ms=float(best["firstBeatMs"]),
            duration_sec=duration_sec,
        )
        top_median = _to_float(top_profile.get("medianOffsetMs"))
        best_median = _to_float(best_profile.get("medianOffsetMs"))
        explain_error = None
        pull_toward_best = None
        if top_median is not None and best_median is not None:
            explain_error = abs((top_median - best_median) + phase_delta_ms)
        if top_median is not None:
            desired_correction = -phase_delta_ms
            before = abs(phase_delta_ms)
            after = abs(phase_delta_ms + top_median)
            pull_toward_best = after < before
            pull_error = abs(top_median - desired_correction)
        else:
            pull_error = None
        result["signals"][signal_name] = {
            "top": top_profile,
            "best": best_profile,
            "bestMinusTopSegmentAgreement": _round(
                (_to_float(best_profile.get("segmentAgreement")) or 0.0)
                - (_to_float(top_profile.get("segmentAgreement")) or 0.0)
            ),
            "bestMinusTopOffsetMadMs": _round(
                (_to_float(best_profile.get("offsetMadMs")) or 999.0)
                - (_to_float(top_profile.get("offsetMadMs")) or 999.0),
                3,
            ),
            "bestMinusTopMeanMargin": _round(
                (_to_float(best_profile.get("meanMargin")) or 0.0)
                - (_to_float(top_profile.get("meanMargin")) or 0.0)
            ),
            "trajectoryExplainsDeltaErrorMs": round(explain_error, 3) if explain_error is not None else None,
            "topPullTowardBest": pull_toward_best,
            "topPullErrorMs": round(pull_error, 3) if pull_error is not None else None,
        }
    return result


def _top_profiles(
    *,
    top: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]],
    duration_sec: float,
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for signal_name in SIGNAL_ORDER:
        values, frame_rate = signal_bundle[signal_name]
        result[signal_name] = _trajectory_profile(
            values=values,
            frame_rate=frame_rate,
            bpm=float(top["bpm"]),
            phase_ms=float(top["firstBeatMs"]),
            duration_sec=duration_sec,
        )
    return result


def _row_report(
    *,
    dataset: str,
    split: str,
    track: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]],
) -> dict[str, Any] | None:
    candidates = _evaluated_candidates(track)
    top = _top_new_candidate(candidates)
    best = _best_passing_candidate(candidates)
    if top is None or best is None:
        return None
    truth = track.get("truth") if isinstance(track.get("truth"), dict) else {}
    truth_bpm = _to_float(truth.get("bpm")) or 0.0
    duration_sec = _to_float((track.get("analysis") or {}).get("durationSec")) or 120.0
    beat_interval_ms = 60000.0 / truth_bpm if truth_bpm > 0.0 else 0.0
    comparison = _trajectory_comparison(
        top=top,
        best=best,
        signal_bundle=signal_bundle,
        duration_sec=duration_sec,
        beat_interval_ms=beat_interval_ms,
    )
    return {
        "dataset": dataset,
        "split": split,
        "fileName": str(track.get("fileName") or ""),
        "selectedCategory": str(((track.get("currentTimeline") or {}).get("category")) or ""),
        "topCategory": str(top["category"]),
        "topRank": int(top["rank"]),
        "bestPassingRank": int(best["rank"]),
        "topSource": str(top["source"]),
        "bestPassingSource": str(best["source"]),
        "comparison": comparison,
    }


def _guard_value(profile: dict[str, Any], key: str) -> float | None:
    return _to_float(profile.get(key))


def _passes_guard(config: dict[str, Any], top: dict[str, Any], profiles: dict[str, Any]) -> bool:
    top_score = _to_float(top.get("score"))
    if top_score is None:
        top_score = _to_float(top.get("topScore"))
    top_score = top_score or 0.0
    if top_score < float(config.get("topMinScore", -999.0)):
        return False
    checks = (
        ("full", "fullAttack"),
        ("low", "lowAttack"),
        ("beat", "beatLogit"),
    )
    for prefix, signal_name in checks:
        profile = profiles.get(signal_name) if isinstance(profiles.get(signal_name), dict) else {}
        min_margin = _to_float(config.get(f"{prefix}MinMargin"))
        if min_margin is not None and (_guard_value(profile, "meanMargin") or 0.0) < min_margin:
            return False
        min_offset = _to_float(config.get(f"{prefix}OffsetMinMs"))
        max_offset = _to_float(config.get(f"{prefix}OffsetMaxMs"))
        if min_offset is not None or max_offset is not None:
            offset = _guard_value(profile, "medianOffsetMs")
            if offset is None:
                return False
            if min_offset is not None and offset < min_offset:
                return False
            if max_offset is not None and offset > max_offset:
                return False
    return True


def _switch_row(
    *,
    dataset: str,
    split: str,
    track: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]],
) -> dict[str, Any] | None:
    candidates = _evaluated_candidates(track)
    top = _top_new_candidate(candidates)
    if top is None:
        return None
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    selected_source = str(analysis.get("gridSolverSelectedSource") or "")
    current_category = str(((track.get("currentTimeline") or {}).get("category")) or "unknown")
    duration_sec = _to_float(analysis.get("durationSec")) or 120.0
    profiles = _top_profiles(top=top, signal_bundle=signal_bundle, duration_sec=duration_sec)
    return {
        "dataset": dataset,
        "split": split,
        "fileName": str(track.get("fileName") or ""),
        "currentCategory": current_category,
        "topCategory": str(top["category"]),
        "topScore": float(top["score"]),
        "selectedSource": selected_source,
        "isLegacySelected": "legacy-fallback" in selected_source,
        "profiles": profiles,
    }


def _signal_summary(rows: list[dict[str, Any]], signal_name: str) -> dict[str, Any]:
    signal_rows = [
        ((row.get("comparison") or {}).get("signals") or {}).get(signal_name)
        for row in rows
    ]
    signal_rows = [row for row in signal_rows if isinstance(row, dict)]
    explain_errors = [
        float(item["trajectoryExplainsDeltaErrorMs"])
        for item in signal_rows
        if _to_float(item.get("trajectoryExplainsDeltaErrorMs")) is not None
    ]
    pull_errors = [
        float(item["topPullErrorMs"])
        for item in signal_rows
        if _to_float(item.get("topPullErrorMs")) is not None
    ]
    agreement_deltas = [
        float(item["bestMinusTopSegmentAgreement"])
        for item in signal_rows
        if _to_float(item.get("bestMinusTopSegmentAgreement")) is not None
    ]
    mad_deltas = [
        float(item["bestMinusTopOffsetMadMs"])
        for item in signal_rows
        if _to_float(item.get("bestMinusTopOffsetMadMs")) is not None
    ]
    margin_deltas = [
        float(item["bestMinusTopMeanMargin"])
        for item in signal_rows
        if _to_float(item.get("bestMinusTopMeanMargin")) is not None
    ]
    pull_true_count = sum(1 for item in signal_rows if item.get("topPullTowardBest") is True)
    return {
        "count": len(signal_rows),
        "trajectoryExplainsDeltaWithin2msRate": _rate(sum(1 for value in explain_errors if value <= 2.0), len(explain_errors)),
        "trajectoryExplainsDeltaWithin4msRate": _rate(sum(1 for value in explain_errors if value <= 4.0), len(explain_errors)),
        "trajectoryExplainsDeltaErrorMs": {
            "median": _median(explain_errors),
            "mean": _mean(explain_errors),
        },
        "topPullTowardBestRate": _rate(pull_true_count, len(signal_rows)),
        "topPullErrorMs": {
            "median": _median(pull_errors),
            "mean": _mean(pull_errors),
        },
        "bestSegmentAgreementHigherRate": _rate(sum(1 for value in agreement_deltas if value > 0.0), len(agreement_deltas)),
        "bestOffsetMadLowerRate": _rate(sum(1 for value in mad_deltas if value < 0.0), len(mad_deltas)),
        "bestMeanMarginHigherRate": _rate(sum(1 for value in margin_deltas if value > 0.0), len(margin_deltas)),
        "bestMinusTopSegmentAgreementMedian": _median(agreement_deltas),
        "bestMinusTopOffsetMadMsMedian": _median(mad_deltas),
        "bestMinusTopMeanMarginMedian": _median(margin_deltas),
    }


def _guard_simulation_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    baseline_pass = sum(1 for row in rows if row["currentCategory"] == "pass")
    for config in GUARD_CONFIGS:
        switch_count = 0
        selected_pass = 0
        fail_to_pass = 0
        pass_to_fail = 0
        category_counts: Counter[str] = Counter()
        for row in rows:
            next_category = row["currentCategory"]
            if row["isLegacySelected"] and _passes_guard(config, row, row["profiles"]):
                switch_count += 1
                next_category = row["topCategory"]
            if row["currentCategory"] != "pass" and next_category == "pass":
                fail_to_pass += 1
            if row["currentCategory"] == "pass" and next_category != "pass":
                pass_to_fail += 1
            if next_category == "pass":
                selected_pass += 1
            category_counts[next_category] += 1
        result[str(config["name"])] = {
            "switchCount": switch_count,
            "baselinePass": baseline_pass,
            "selectedPass": selected_pass,
            "netPassDelta": selected_pass - baseline_pass,
            "failToPass": fail_to_pass,
            "passToFail": pass_to_fail,
            "categoryCounts": dict(category_counts),
        }
    return result


def _top_profile_summary(rows: list[dict[str, Any]], signal_name: str) -> dict[str, Any]:
    profiles = [
        (((row.get("comparison") or {}).get("signals") or {}).get(signal_name) or {}).get("top")
        for row in rows
    ]
    profiles = [profile for profile in profiles if isinstance(profile, dict)]
    median_offsets = [
        float(profile["medianOffsetMs"])
        for profile in profiles
        if _to_float(profile.get("medianOffsetMs")) is not None
    ]
    offset_mads = [
        float(profile["offsetMadMs"])
        for profile in profiles
        if _to_float(profile.get("offsetMadMs")) is not None
    ]
    agreements = [
        float(profile["segmentAgreement"])
        for profile in profiles
        if _to_float(profile.get("segmentAgreement")) is not None
    ]
    margins = [
        float(profile["meanMargin"])
        for profile in profiles
        if _to_float(profile.get("meanMargin")) is not None
    ]
    return {
        "count": len(profiles),
        "medianOffsetMs": _median(median_offsets),
        "absMedianOffsetMs": _median([abs(value) for value in median_offsets]),
        "offsetMadMs": _median(offset_mads),
        "segmentAgreement": _median(agreements),
        "meanMargin": _median(margins),
    }


def _group_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    top_categories = Counter(str(row.get("topCategory") or "unknown") for row in rows)
    best_ranks = [float(row["bestPassingRank"]) for row in rows]
    phase_deltas = [
        abs(float((row.get("comparison") or {}).get("topToBestPhaseDeltaMs")))
        for row in rows
        if _to_float((row.get("comparison") or {}).get("topToBestPhaseDeltaMs")) is not None
    ]
    signed_phase_deltas = [
        float((row.get("comparison") or {}).get("topToBestPhaseDeltaMs"))
        for row in rows
        if _to_float((row.get("comparison") or {}).get("topToBestPhaseDeltaMs")) is not None
    ]
    return {
        "trackCount": len(rows),
        "topCandidateCategoryCounts": dict(top_categories),
        "bestPassingRankMedian": _median(best_ranks),
        "topToBestPhaseAbsDeltaMsMedian": _median(phase_deltas),
        "topToBestPhaseSignedDeltaMsMedian": _median(signed_phase_deltas),
        "signalSummary": {signal: _signal_summary(rows, signal) for signal in SIGNAL_ORDER},
        "topCandidateProfile": {
            "pass": {
                signal: _top_profile_summary(
                    [row for row in rows if str(row.get("topCategory") or "") == "pass"],
                    signal,
                )
                for signal in SIGNAL_ORDER
            },
            "fail": {
                signal: _top_profile_summary(
                    [row for row in rows if str(row.get("topCategory") or "") != "pass"],
                    signal,
                )
                for signal in SIGNAL_ORDER
            },
        },
    }


def _dataset_report(
    *,
    name: str,
    benchmark_path: Path,
    split_path: Path,
    feature_cache_dir: Path,
    focus_category: str,
    detail_limit: int,
) -> dict[str, Any]:
    split_map = _split_map(split_path)
    index_map = build_feature_index_map(feature_cache_dir)
    rows: list[dict[str, Any]] = []
    switch_rows: list[dict[str, Any]] = []
    category_counts: Counter[str] = Counter()
    skipped: Counter[str] = Counter()
    for track in _tracks(benchmark_path):
        category = str(((track.get("currentTimeline") or {}).get("category")) or "unknown")
        category_counts[category] += 1
        signal_bundle = _load_signal_bundle(track=track, feature_cache_dir=feature_cache_dir, index_map=index_map)
        if signal_bundle is None:
            skipped["missingFeatureCache"] += 1
            continue
        split = split_map.get(benchmark._normalize_lookup_key(track.get("fileName")), "unknown")
        switch_row = _switch_row(dataset=name, split=split, track=track, signal_bundle=signal_bundle)
        if switch_row is not None:
            switch_rows.append(switch_row)
        if category != focus_category:
            continue
        row = _row_report(dataset=name, split=split, track=track, signal_bundle=signal_bundle)
        if row is None:
            skipped["noPassingCandidate"] += 1
            continue
        rows.append(row)
    by_split: dict[str, Any] = {}
    for split in ("train", "tune", "holdout", "unknown"):
        split_rows = [row for row in rows if row["split"] == split]
        if split_rows:
            by_split[split] = _group_summary(split_rows)
    detail_rows = sorted(
        rows,
        key=lambda row: (
            int(row["bestPassingRank"]),
            float((row.get("comparison") or {}).get("topToBestPhaseAbsDeltaMs") or 999.0),
            str(row.get("fileName") or ""),
        ),
    )[: max(0, detail_limit)]
    return {
        "benchmark": str(benchmark_path),
        "splitPath": str(split_path),
        "featureCacheDir": str(feature_cache_dir),
        "trackTotal": sum(category_counts.values()),
        "categoryCounts": dict(category_counts),
        "focusCategory": focus_category,
        "fixableFocusCount": len(rows),
        "skipped": dict(skipped),
        "summary": _group_summary(rows),
        "bySplit": by_split,
        "guardSimulation": {
            "all": _guard_simulation_summary(switch_rows),
            "bySplit": {
                split: _guard_simulation_summary([row for row in switch_rows if row["split"] == split])
                for split in ("train", "tune", "holdout", "unknown")
                if any(row["split"] == split for row in switch_rows)
            },
        },
        "detailRows": detail_rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build phase trajectory diagnostics from RKB feature caches")
    parser.add_argument("--current-benchmark", default=str(DEFAULT_CURRENT_BENCHMARK))
    parser.add_argument("--current-splits", default=str(DEFAULT_CURRENT_SPLITS))
    parser.add_argument("--current-feature-cache", default=str(DEFAULT_CURRENT_FEATURE_CACHE))
    parser.add_argument("--blind-benchmark", default=str(DEFAULT_BLIND_BENCHMARK))
    parser.add_argument("--blind-splits", default=str(DEFAULT_BLIND_SPLITS))
    parser.add_argument("--blind-feature-cache", default=str(DEFAULT_BLIND_FEATURE_CACHE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--focus-category", default="first-beat-phase")
    parser.add_argument("--detail-limit", type=int, default=24)
    args = parser.parse_args()

    datasets = {
        "current": _dataset_report(
            name="current",
            benchmark_path=Path(args.current_benchmark),
            split_path=Path(args.current_splits),
            feature_cache_dir=Path(args.current_feature_cache),
            focus_category=str(args.focus_category),
            detail_limit=int(args.detail_limit),
        ),
        "blind": _dataset_report(
            name="blind",
            benchmark_path=Path(args.blind_benchmark),
            split_path=Path(args.blind_splits),
            feature_cache_dir=Path(args.blind_feature_cache),
            focus_category=str(args.focus_category),
            detail_limit=int(args.detail_limit),
        ),
    }
    output = {
        "version": VERSION,
        "scope": (
            "Offline trajectory diagnostics only. Uses truth solely to label best passing candidates; "
            "none of these metrics are production scorer rules."
        ),
        "focusCategory": str(args.focus_category),
        "trajectoryConfig": {
            "signals": list(SIGNAL_ORDER),
            "blockSize": BLOCK_SIZE,
            "beatLimit": BEAT_LIMIT,
            "offsetLimitMs": OFFSET_LIMIT_MS,
            "offsetStepMs": OFFSET_STEP_MS,
        },
        "datasets": datasets,
    }
    output_path = Path(args.output)
    atomic_write_json(output_path, output)
    print(json.dumps({"output": str(output_path), "focusCategory": args.focus_category}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
