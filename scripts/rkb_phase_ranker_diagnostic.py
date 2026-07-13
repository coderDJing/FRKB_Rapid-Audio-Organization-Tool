import argparse
import json
import math
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

import benchmark_rkb_rekordbox_truth as benchmark
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
from rkb_phase_trajectory_diagnostic import _trajectory_profile
from rkb_onset_foot_phase_diagnostic import _candidate_onset_features

VERSION = "rkb-phase-ranker-diagnostic-v1"
DEFAULT_CURRENT_BENCHMARK = BENCHMARK_OUTPUT_DIR / "frkb-current-latest.json"
DEFAULT_CURRENT_SPLITS = BENCHMARK_OUTPUT_DIR / "rkb-dataset-splits-current.json"
DEFAULT_CURRENT_FEATURE_CACHE = BENCHMARK_OUTPUT_DIR / "feature-cache"
DEFAULT_BLIND_ROOT = BENCHMARK_OUTPUT_DIR / "blind-rekordbox-truth"
DEFAULT_BLIND_BENCHMARK = DEFAULT_BLIND_ROOT / "frkb-blind-constant-grid-dp-phasepath-diagnostic.json"
DEFAULT_BLIND_SPLITS = DEFAULT_BLIND_ROOT / "rkb-blind-dataset-splits.json"
DEFAULT_BLIND_FEATURE_CACHE = DEFAULT_BLIND_ROOT / "feature-cache"
DEFAULT_OUTPUT = BENCHMARK_OUTPUT_DIR / "phase-ranker-diagnostic-latest.json"

DATASET_ORDER = ("current", "blind")
SPLIT_ORDER = ("train", "tune", "holdout", "unknown")
SIGNAL_ORDER = ("beatLogit", "downbeatLogit", "fullAttack", "lowAttack")
PROFILE_KEYS = (
    "support",
    "blockCount",
    "medianOffsetMs",
    "offsetMadMs",
    "segmentAgreement",
    "meanBestScore",
    "meanCenterScore",
    "meanMargin",
)
NUMERIC_FEATURE_KEYS = (
    "tempoScore",
    "tempoBaseScore",
    "tempoQuantizedScore",
    "phaseScore",
    "phaseSupportRatio",
    "phaseCompactness",
    "phaseSupport",
    "attackPhaseScore",
    "attackPhaseSupport",
    "leadingEdgeScore",
    "leadingEdgeTargetScore",
    "leadingEdgeConsistencyScore",
    "leadingEdgePeakScore",
    "leadingEdgeSupport",
    "leadingEdgePeakOffsetMadMs",
    "leadingEdgePeakOffsetMedianMs",
    "leadingEdgeTargetOffsetMs",
    "introLeadingEdgeScore",
    "introLeadingEdgeTargetScore",
    "introLeadingEdgeConsistencyScore",
    "introLeadingEdgePeakScore",
    "introLeadingEdgeSupport",
    "introLeadingEdgePeakOffsetMadMs",
    "introLeadingEdgePeakOffsetMedianMs",
    "introLeadingEdgeTargetOffsetMs",
    "dpBeatMean",
    "dpBeatSegmentAgreement",
    "dpBeatSegmentMin",
    "dpBeatSupport",
    "dpFullAttackMean",
    "dpFullAttackSegmentAgreement",
    "dpLowAttackMean",
    "dpLowAttackSegmentAgreement",
    "phasePathScore",
    "phasePathTargetScore",
    "phasePathSegmentAgreement",
    "phasePathPeakScore",
    "phasePathIntroReliability",
    "phasePathStableSegmentCount",
    "phasePathSupport",
    "phasePathPeakOffsetMadMs",
    "phasePathPeakOffsetMedianMs",
    "phasePathTargetOffsetMs",
    "constantGridDpScore",
    "constantGridDpPhaseEvidenceSwitchScore",
    "constantGridDpPhaseEvidenceRank",
    "downbeatScore",
    "downbeatMargin",
    "downbeatDeltaToBest",
    "downbeatRank",
    "downbeatSupport",
    "constantGridDpDownbeatAlternativePenalty",
    "constantGridDpNegativeEdgeBonus",
    "constantGridDpOctavePenalty",
    "phaseShiftMs",
    "timelineQuantizationShiftMs",
    "windowWeight",
    "onsetFootScore",
    "onsetFootAgreementScore",
    "onsetFootSupport",
    "fullFootScore",
    "fullFootTargetScore",
    "fullFootConsistencyScore",
    "fullFootPeakDelayScore",
    "fullFootContrastScore",
    "fullFootSegmentAgreement",
    "fullFootFootOffsetMedianMs",
    "fullFootFootOffsetMadMs",
    "fullFootPeakOffsetMedianMs",
    "fullFootRiseMsMedian",
    "fullFootSupport",
    "lowFootScore",
    "lowFootTargetScore",
    "lowFootConsistencyScore",
    "lowFootPeakDelayScore",
    "lowFootContrastScore",
    "lowFootSegmentAgreement",
    "lowFootFootOffsetMedianMs",
    "lowFootFootOffsetMadMs",
    "lowFootPeakOffsetMedianMs",
    "lowFootRiseMsMedian",
    "lowFootSupport",
)
L2_GRID = (0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3)
THRESHOLD_GRID = (
    0.55,
    0.6,
    0.65,
    0.7,
    0.75,
    0.8,
    0.85,
    0.9,
    0.93,
    0.94,
    0.95,
    0.955,
    0.96,
    0.965,
    0.97,
    0.975,
    0.98,
    0.985,
    0.99,
    0.995,
)
MODE_CONFIGS = (
    {"name": "top-new", "rankLimit": 1},
    {"name": "ranked-top16", "rankLimit": 16},
)


def _configure_utf8_stdio() -> None:
    try:
        import sys

        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _safe_float(value: Any, default: float = 0.0) -> float:
    numeric = _to_float(value)
    return numeric if numeric is not None else default


def _rate(count: int, total: int) -> float:
    return round(count / total, 6) if total > 0 else 0.0


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 6) if values else None


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 6) if values else None


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
    result: dict[str, str] = {}
    splits = _load_json(path).get("splits")
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


def _is_legacy_source(source: str) -> bool:
    return "legacy" in source.lower()


def _is_legacy_candidate(candidate: dict[str, Any]) -> bool:
    source = _candidate_source(candidate)
    features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    legacy_source = str(features.get("legacyGridSolverSelectedSource") or "")
    return _is_legacy_source(source) or bool(legacy_source)


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
        "rank": int(rank),
        "score": _safe_float(candidate.get("score")),
        "source": _candidate_source(candidate),
        "isLegacy": _is_legacy_candidate(candidate),
        "bpm": float(bpm),
        "firstBeatMs": float(first_beat_ms),
        "timelineFirstBeatMs": float(timeline_first_beat_ms),
        "barBeatOffset": int(bar_beat_offset),
        "category": str(classification["category"]),
        "features": candidate.get("features") if isinstance(candidate.get("features"), dict) else {},
    }


def _evaluated_candidates(track: dict[str, Any]) -> list[dict[str, Any]]:
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    raw_candidates = analysis.get("gridSolverCandidates")
    candidates = [item for item in raw_candidates if isinstance(item, dict)] if isinstance(raw_candidates, list) else []
    truth = track.get("truth") if isinstance(track.get("truth"), dict) else {}
    offset_ms = _safe_float((truth.get("timeBasis") or {}).get("offsetMs"))
    result: list[dict[str, Any]] = []
    for rank, candidate in enumerate(candidates, start=1):
        evaluated = _candidate_metrics(candidate=candidate, truth=truth, offset_ms=offset_ms, rank=rank)
        if evaluated is not None:
            result.append(evaluated)
    return result


def _first_nonlegacy_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    for candidate in candidates:
        if not bool(candidate.get("isLegacy")):
            return candidate
    return None


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
        downbeat_logits = _sigmoid(np.asarray(arrays["downbeatLogits"], dtype="float64"))
        full_attack = np.asarray(arrays["fullAttackEnvelope"], dtype="float64")
        low_attack = np.asarray(arrays["lowrateAttackEnvelope"], dtype="float64")
        beat_rate = float(np.asarray(arrays["beatLogitFrameRate"]).item())
        downbeat_rate = float(np.asarray(arrays["downbeatLogitFrameRate"]).item())
        full_rate = float(np.asarray(arrays["fullAttackSampleRate"]).item())
        low_rate = float(np.asarray(arrays["lowrateAttackSampleRate"]).item())
    full_window = max(1, int(round(full_rate * 0.008)))
    low_window = max(1, int(round(low_rate * 0.012)))
    return {
        "beatLogit": (beat_logits, beat_rate),
        "downbeatLogit": (downbeat_logits, downbeat_rate),
        "fullAttack": (moving_average(full_attack, full_window), full_rate),
        "lowAttack": (moving_average(low_attack, low_window), low_rate),
    }


def _signal_profiles(
    *,
    candidate: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]] | None,
    duration_sec: float,
) -> dict[str, dict[str, Any]]:
    if signal_bundle is None:
        return {}
    result: dict[str, dict[str, Any]] = {}
    for signal_name in SIGNAL_ORDER:
        values, frame_rate = signal_bundle[signal_name]
        result[signal_name] = _trajectory_profile(
            values=values,
            frame_rate=frame_rate,
            bpm=float(candidate["bpm"]),
            phase_ms=float(candidate["firstBeatMs"]),
            duration_sec=duration_sec,
        )
    return result


def _selected_profile(track: dict[str, Any], signal_bundle: dict[str, tuple[np.ndarray, float]] | None) -> dict[str, Any]:
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    timeline = track.get("currentTimeline") if isinstance(track.get("currentTimeline"), dict) else {}
    features = analysis.get("gridSolverFeatures") if isinstance(analysis.get("gridSolverFeatures"), dict) else {}
    truth = track.get("truth") if isinstance(track.get("truth"), dict) else {}
    offset_ms = _safe_float((truth.get("timeBasis") or {}).get("offsetMs"))
    first_beat_ms = _safe_float(analysis.get("firstBeatMs"))
    timeline_first_beat_ms = _safe_float(timeline.get("firstBeatMs"), first_beat_ms + offset_ms)
    duration_sec = _safe_float(analysis.get("durationSec"), 120.0)
    candidate_like = {
        "bpm": _safe_float(analysis.get("bpm")),
        "firstBeatMs": first_beat_ms,
    }
    onset_features = _candidate_onset_features(
        candidate=candidate_like,
        signal_bundle=signal_bundle,
        duration_sec=duration_sec,
    )
    return {
        "score": _safe_float(analysis.get("gridSolverScore")),
        "source": str(analysis.get("gridSolverSelectedSource") or ""),
        "bpm": _safe_float(analysis.get("bpm")),
        "firstBeatMs": first_beat_ms,
        "timelineFirstBeatMs": timeline_first_beat_ms,
        "barBeatOffset": benchmark._normalize_bar_offset(analysis.get("barBeatOffset"), 32),
        "category": str(timeline.get("category") or "unknown"),
        "features": {**features, **onset_features},
        "profiles": _signal_profiles(
            candidate=candidate_like,
            signal_bundle=signal_bundle,
            duration_sec=duration_sec,
        ),
    }


def _feature_value(candidate: dict[str, Any], key: str) -> float:
    if key == "score":
        return _safe_float(candidate.get("score"))
    features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    return _safe_float(features.get(key))


def _add_feature(result: list[float], names: list[str], name: str, value: Any) -> None:
    result.append(_safe_float(value))
    names.append(name)


def _add_sincos(result: list[float], names: list[str], prefix: str, value: float, period: float) -> None:
    if period <= 0.0:
        result.extend([0.0, 0.0])
    else:
        angle = 2.0 * math.pi * (value % period) / period
        result.extend([math.sin(angle), math.cos(angle)])
    names.extend([f"{prefix}Sin", f"{prefix}Cos"])


def _append_profile_features(
    *,
    result: list[float],
    names: list[str],
    prefix: str,
    profiles: dict[str, dict[str, Any]],
) -> None:
    for signal_name in SIGNAL_ORDER:
        profile = profiles.get(signal_name) if isinstance(profiles.get(signal_name), dict) else {}
        for key in PROFILE_KEYS:
            _add_feature(result, names, f"{prefix}.{signal_name}.{key}", profile.get(key))
        median_offset = _safe_float(profile.get("medianOffsetMs"))
        _add_feature(result, names, f"{prefix}.{signal_name}.absMedianOffsetMs", abs(median_offset))
        support = max(1.0, _safe_float(profile.get("support"), 1.0))
        _add_feature(
            result,
            names,
            f"{prefix}.{signal_name}.positiveOffsetRatio",
            _safe_float(profile.get("positiveOffsetCount")) / support,
        )
        _add_feature(
            result,
            names,
            f"{prefix}.{signal_name}.negativeOffsetRatio",
            _safe_float(profile.get("negativeOffsetCount")) / support,
        )
        _add_feature(
            result,
            names,
            f"{prefix}.{signal_name}.zeroOffsetRatio",
            _safe_float(profile.get("zeroOffsetCount")) / support,
        )


def _feature_vector(
    *,
    candidate: dict[str, Any],
    selected: dict[str, Any],
    candidate_profiles: dict[str, dict[str, Any]],
) -> tuple[list[float], list[str]]:
    result: list[float] = []
    names: list[str] = []
    bpm = max(1e-6, float(candidate["bpm"]))
    selected_bpm = max(1e-6, float(selected["bpm"]))
    beat_interval_ms = 60000.0 / bpm
    selected_beat_interval_ms = 60000.0 / selected_bpm
    phase_delta = _phase_delta_ms(
        float(candidate["timelineFirstBeatMs"]),
        float(selected["timelineFirstBeatMs"]),
        beat_interval_ms,
    )

    _add_feature(result, names, "rank", candidate["rank"])
    _add_feature(result, names, "invRank", 1.0 / max(1.0, float(candidate["rank"])))
    _add_feature(result, names, "candidateScore", candidate["score"])
    _add_feature(result, names, "selectedScore", selected["score"])
    _add_feature(result, names, "scoreMinusSelected", float(candidate["score"]) - float(selected["score"]))
    _add_feature(result, names, "bpm", bpm)
    _add_feature(result, names, "beatIntervalMs", beat_interval_ms)
    _add_feature(result, names, "bpmMinusSelected", bpm - selected_bpm)
    _add_feature(result, names, "absBpmMinusSelected", abs(bpm - selected_bpm))
    _add_feature(result, names, "beatIntervalMinusSelected", beat_interval_ms - selected_beat_interval_ms)
    _add_feature(result, names, "candidateToSelectedPhaseDeltaMs", phase_delta)
    _add_feature(result, names, "candidateToSelectedPhaseAbsDeltaMs", abs(phase_delta))
    _add_feature(
        result,
        names,
        "barBeatOffsetSameMod4",
        1.0 if int(candidate["barBeatOffset"]) % 4 == int(selected["barBeatOffset"]) % 4 else 0.0,
    )
    _add_feature(
        result,
        names,
        "barBeatOffsetSameExact32",
        1.0 if int(candidate["barBeatOffset"]) % 32 == int(selected["barBeatOffset"]) % 32 else 0.0,
    )
    _add_sincos(result, names, "phaseWithinBeat", float(candidate["firstBeatMs"]), beat_interval_ms)
    _add_sincos(result, names, "barBeatOffset32", float(candidate["barBeatOffset"]), 32.0)
    _add_sincos(result, names, "barBeatOffset4", float(candidate["barBeatOffset"]), 4.0)

    for key in NUMERIC_FEATURE_KEYS:
        candidate_value = _feature_value(candidate, key)
        selected_value = _feature_value(selected, key)
        _add_feature(result, names, f"candidate.{key}", candidate_value)
        _add_feature(result, names, f"delta.{key}", candidate_value - selected_value)

    _append_profile_features(result=result, names=names, prefix="candidateProfile", profiles=candidate_profiles)
    selected_profiles = selected.get("profiles") if isinstance(selected.get("profiles"), dict) else {}
    for signal_name in SIGNAL_ORDER:
        candidate_profile = candidate_profiles.get(signal_name) if isinstance(candidate_profiles.get(signal_name), dict) else {}
        selected_profile = selected_profiles.get(signal_name) if isinstance(selected_profiles.get(signal_name), dict) else {}
        for key in PROFILE_KEYS:
            _add_feature(
                result,
                names,
                f"profileDelta.{signal_name}.{key}",
                _safe_float(candidate_profile.get(key)) - _safe_float(selected_profile.get(key)),
            )
    return result, names


def _track_row(
    *,
    dataset: str,
    split: str,
    track: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]] | None,
    max_rank: int,
) -> dict[str, Any]:
    selected = _selected_profile(track, signal_bundle)
    candidates = _evaluated_candidates(track)
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    duration_sec = _safe_float(analysis.get("durationSec"), 120.0)
    candidate_rows: list[dict[str, Any]] = []
    feature_names: list[str] | None = None
    for candidate in candidates:
        if bool(candidate.get("isLegacy")) or int(candidate["rank"]) > max_rank:
            continue
        onset_features = _candidate_onset_features(
            candidate=candidate,
            signal_bundle=signal_bundle,
            duration_sec=duration_sec,
        )
        candidate = {
            **candidate,
            "features": {**dict(candidate.get("features") or {}), **onset_features},
        }
        profiles = _signal_profiles(candidate=candidate, signal_bundle=signal_bundle, duration_sec=duration_sec)
        vector, names = _feature_vector(candidate=candidate, selected=selected, candidate_profiles=profiles)
        if feature_names is None:
            feature_names = names
        candidate_rows.append(
            {
                "rank": int(candidate["rank"]),
                "category": str(candidate["category"]),
                "isPass": str(candidate["category"]) == "pass",
                "score": float(candidate["score"]),
                "source": str(candidate["source"]),
                "featureVector": vector,
            }
        )
    return {
        "dataset": dataset,
        "split": split,
        "fileName": str(track.get("fileName") or ""),
        "baselineCategory": str(selected["category"]),
        "selectedSource": str(selected["source"]),
        "isLegacySelected": _is_legacy_source(str(selected["source"])),
        "candidates": candidate_rows,
        "featureNames": feature_names or [],
    }


def _dataset_rows(
    *,
    name: str,
    benchmark_path: Path,
    split_path: Path,
    feature_cache_dir: Path,
    max_rank: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    split_map = _split_map(split_path)
    index_map = build_feature_index_map(feature_cache_dir)
    rows: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    for track in _tracks(benchmark_path):
        signal_bundle = _load_signal_bundle(track=track, feature_cache_dir=feature_cache_dir, index_map=index_map)
        if signal_bundle is None:
            skipped["missingFeatureCache"] += 1
        split = split_map.get(benchmark._normalize_lookup_key(track.get("fileName")), "unknown")
        rows.append(
            _track_row(
                dataset=name,
                split=split,
                track=track,
                signal_bundle=signal_bundle,
                max_rank=max_rank,
            )
        )
    return rows, {
        "benchmark": str(benchmark_path),
        "splitPath": str(split_path),
        "featureCacheDir": str(feature_cache_dir),
        "trackTotal": len(rows),
        "skipped": dict(skipped),
    }


def _candidate_examples(rows: list[dict[str, Any]], splits: set[str]) -> tuple[np.ndarray, np.ndarray]:
    xs: list[list[float]] = []
    ys: list[float] = []
    for row in rows:
        if row["split"] not in splits:
            continue
        for candidate in row["candidates"]:
            xs.append([float(value) for value in candidate["featureVector"]])
            ys.append(1.0 if candidate["isPass"] else 0.0)
    if not xs:
        return np.zeros((0, 0), dtype="float64"), np.zeros((0,), dtype="float64")
    return np.asarray(xs, dtype="float64"), np.asarray(ys, dtype="float64")


def _standardize_train(X: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = np.mean(X, axis=0)
    std = np.std(X, axis=0)
    std = np.where(std < 1e-6, 1.0, std)
    return np.clip((X - mean) / std, -8.0, 8.0), mean, std


def _standardize_apply(X: np.ndarray, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    return np.clip((X - mean) / std, -8.0, 8.0)


def _logistic(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -40.0, 40.0)))


def _train_logistic_regression(X: np.ndarray, y: np.ndarray, *, l2: float) -> dict[str, Any]:
    Xs, mean, std = _standardize_train(X)
    n, feature_count = Xs.shape
    pos_count = float(np.sum(y))
    neg_count = float(n - pos_count)
    pos_weight = n / max(1.0, 2.0 * pos_count)
    neg_weight = n / max(1.0, 2.0 * neg_count)
    sample_weight = np.where(y > 0.5, pos_weight, neg_weight)
    sample_weight = sample_weight / max(1e-6, float(np.mean(sample_weight)))
    weights = np.zeros((feature_count,), dtype="float64")
    bias = 0.0
    m_w = np.zeros_like(weights)
    v_w = np.zeros_like(weights)
    m_b = 0.0
    v_b = 0.0
    beta1 = 0.9
    beta2 = 0.999
    lr = 0.03
    weight_total = float(np.sum(sample_weight))
    for step in range(1, 1201):
        logits = Xs @ weights + bias
        probs = _logistic(logits)
        error = (probs - y) * sample_weight
        grad_w = (Xs.T @ error) / weight_total + float(l2) * weights
        grad_b = float(np.sum(error) / weight_total)
        m_w = beta1 * m_w + (1.0 - beta1) * grad_w
        v_w = beta2 * v_w + (1.0 - beta2) * (grad_w * grad_w)
        m_b = beta1 * m_b + (1.0 - beta1) * grad_b
        v_b = beta2 * v_b + (1.0 - beta2) * (grad_b * grad_b)
        m_w_hat = m_w / (1.0 - beta1**step)
        v_w_hat = v_w / (1.0 - beta2**step)
        m_b_hat = m_b / (1.0 - beta1**step)
        v_b_hat = v_b / (1.0 - beta2**step)
        weights -= lr * m_w_hat / (np.sqrt(v_w_hat) + 1e-8)
        bias -= lr * m_b_hat / (math.sqrt(v_b_hat) + 1e-8)
    return {
        "weights": weights,
        "bias": float(bias),
        "mean": mean,
        "std": std,
        "l2": float(l2),
        "trainPositiveRate": _rate(int(pos_count), int(n)),
    }


def _predict(model: dict[str, Any], X: np.ndarray) -> np.ndarray:
    if X.size == 0:
        return np.zeros((0,), dtype="float64")
    Xs = _standardize_apply(X, model["mean"], model["std"])
    return _logistic(Xs @ model["weights"] + float(model["bias"]))


def _score_rows(rows: list[dict[str, Any]], model: dict[str, Any]) -> None:
    vectors: list[list[float]] = []
    refs: list[dict[str, Any]] = []
    for row in rows:
        for candidate in row["candidates"]:
            vectors.append(candidate["featureVector"])
            refs.append(candidate)
    if not vectors:
        return
    probs = _predict(model, np.asarray(vectors, dtype="float64"))
    for candidate, prob in zip(refs, probs, strict=False):
        candidate["rankerProbability"] = round(float(prob), 9)


def _choose_candidate(row: dict[str, Any], *, mode: str, rank_limit: int) -> dict[str, Any] | None:
    candidates = [candidate for candidate in row["candidates"] if int(candidate["rank"]) <= rank_limit]
    if not candidates:
        return None
    if mode == "top-new":
        return min(candidates, key=lambda item: int(item["rank"]))
    return max(candidates, key=lambda item: (float(item.get("rankerProbability") or 0.0), -int(item["rank"])))


def _simulate(
    rows: list[dict[str, Any]],
    *,
    mode: str,
    rank_limit: int,
    threshold: float,
    splits: set[str] | None = None,
    detail_limit: int = 0,
) -> dict[str, Any]:
    selected_pass = 0
    baseline_pass = 0
    switch_count = 0
    fail_to_pass = 0
    pass_to_fail = 0
    category_counts: Counter[str] = Counter()
    baseline_counts: Counter[str] = Counter()
    details: list[dict[str, Any]] = []
    scoped_rows = [row for row in rows if splits is None or row["split"] in splits]
    for row in scoped_rows:
        baseline_category = str(row["baselineCategory"])
        next_category = baseline_category
        chosen = None
        if bool(row["isLegacySelected"]):
            candidate = _choose_candidate(row, mode=mode, rank_limit=rank_limit)
            if candidate is not None and float(candidate.get("rankerProbability") or 0.0) >= threshold:
                chosen = candidate
                next_category = str(candidate["category"])
                switch_count += 1
        if baseline_category == "pass":
            baseline_pass += 1
        if next_category == "pass":
            selected_pass += 1
        if baseline_category != "pass" and next_category == "pass":
            fail_to_pass += 1
        if baseline_category == "pass" and next_category != "pass":
            pass_to_fail += 1
        baseline_counts[baseline_category] += 1
        category_counts[next_category] += 1
        if chosen is not None and len(details) < detail_limit:
            details.append(
                {
                    "dataset": row["dataset"],
                    "split": row["split"],
                    "fileName": row["fileName"],
                    "baselineCategory": baseline_category,
                    "nextCategory": next_category,
                    "candidateRank": chosen["rank"],
                    "rankerProbability": chosen.get("rankerProbability"),
                    "source": chosen.get("source"),
                }
            )
    return {
        "trackTotal": len(scoped_rows),
        "baselinePass": baseline_pass,
        "selectedPass": selected_pass,
        "baselineRate": _rate(baseline_pass, len(scoped_rows)),
        "selectedRate": _rate(selected_pass, len(scoped_rows)),
        "netPassDelta": selected_pass - baseline_pass,
        "failToPass": fail_to_pass,
        "passToFail": pass_to_fail,
        "switchCount": switch_count,
        "baselineCategoryCounts": dict(baseline_counts),
        "selectedCategoryCounts": dict(category_counts),
        "details": details,
    }


def _score_config_for_tune(metrics: dict[str, dict[str, Any]]) -> tuple[int, int, int, int, float]:
    current = metrics["current"]
    blind = metrics["blind"]
    current_net = int(current["netPassDelta"])
    blind_net = int(blind["netPassDelta"])
    total_net = current_net + blind_net
    total_hurt = int(current["passToFail"]) + int(blind["passToFail"])
    total_switch = int(current["switchCount"]) + int(blind["switchCount"])
    min_net = min(current_net, blind_net)
    zero_hurt = 1 if total_hurt == 0 else 0
    return (zero_hurt, min_net, -total_switch, total_net, -total_hurt, min(float(current["selectedRate"]), float(blind["selectedRate"])))


def _split_metrics_for_config(
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    *,
    mode: str,
    rank_limit: int,
    threshold: float,
    include_details: bool,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for dataset, rows in rows_by_dataset.items():
        dataset_result: dict[str, Any] = {}
        for split in ("train", "tune", "holdout"):
            dataset_result[split] = _simulate(
                rows,
                mode=mode,
                rank_limit=rank_limit,
                threshold=threshold,
                splits={split},
                detail_limit=12 if include_details and split == "holdout" else 0,
            )
        dataset_result["all"] = _simulate(
            rows,
            mode=mode,
            rank_limit=rank_limit,
            threshold=threshold,
            splits=None,
            detail_limit=20 if include_details else 0,
        )
        result[dataset] = dataset_result
    return result


def _candidate_probability_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    pass_probs: list[float] = []
    fail_probs: list[float] = []
    for row in rows:
        for candidate in row["candidates"]:
            prob = _to_float(candidate.get("rankerProbability"))
            if prob is None:
                continue
            if candidate["isPass"]:
                pass_probs.append(prob)
            else:
                fail_probs.append(prob)
    return {
        "passCount": len(pass_probs),
        "failCount": len(fail_probs),
        "passMedianProbability": _median(pass_probs),
        "failMedianProbability": _median(fail_probs),
        "passMeanProbability": _mean(pass_probs),
        "failMeanProbability": _mean(fail_probs),
    }


def _build_report(
    *,
    rows_by_dataset: dict[str, list[dict[str, Any]]],
    metadata_by_dataset: dict[str, dict[str, Any]],
    feature_names: list[str],
    detail_limit: int,
) -> dict[str, Any]:
    train_rows = rows_by_dataset["current"] + rows_by_dataset["blind"]
    X_train, y_train = _candidate_examples(train_rows, {"train"})
    if X_train.size == 0:
        raise RuntimeError("no train candidate examples")

    configs: list[dict[str, Any]] = []
    for l2 in L2_GRID:
        model = _train_logistic_regression(X_train, y_train, l2=float(l2))
        for rows in rows_by_dataset.values():
            _score_rows(rows, model)
        for mode_config in MODE_CONFIGS:
            mode = str(mode_config["name"])
            rank_limit = int(mode_config["rankLimit"])
            for threshold in THRESHOLD_GRID:
                tune_metrics = {
                    dataset: _simulate(
                        rows,
                        mode=mode,
                        rank_limit=rank_limit,
                        threshold=float(threshold),
                        splits={"tune"},
                    )
                    for dataset, rows in rows_by_dataset.items()
                }
                configs.append(
                    {
                        "l2": float(l2),
                        "mode": mode,
                        "rankLimit": rank_limit,
                        "threshold": float(threshold),
                        "tuneMetrics": tune_metrics,
                        "selectionScore": list(_score_config_for_tune(tune_metrics)),
                        "model": model,
                    }
                )

    configs.sort(key=lambda item: tuple(item["selectionScore"]), reverse=True)
    selected = configs[0]
    for rows in rows_by_dataset.values():
        _score_rows(rows, selected["model"])
    selected_metrics = _split_metrics_for_config(
        rows_by_dataset,
        mode=str(selected["mode"]),
        rank_limit=int(selected["rankLimit"]),
        threshold=float(selected["threshold"]),
        include_details=detail_limit > 0,
    )
    top_configs = []
    for item in configs[:12]:
        for rows in rows_by_dataset.values():
            _score_rows(rows, item["model"])
        metrics = _split_metrics_for_config(
            rows_by_dataset,
            mode=str(item["mode"]),
            rank_limit=int(item["rankLimit"]),
            threshold=float(item["threshold"]),
            include_details=False,
        )
        top_configs.append(
            {
                "l2": item["l2"],
                "mode": item["mode"],
                "rankLimit": item["rankLimit"],
                "threshold": item["threshold"],
                "selectionScore": item["selectionScore"],
                "metrics": {
                    dataset: {
                        "tune": metrics[dataset]["tune"],
                        "holdout": metrics[dataset]["holdout"],
                        "all": metrics[dataset]["all"],
                    }
                    for dataset in DATASET_ORDER
                },
            }
        )

    for rows in rows_by_dataset.values():
        _score_rows(rows, selected["model"])
    holdout_current = selected_metrics["current"]["holdout"]
    holdout_blind = selected_metrics["blind"]["holdout"]
    holdout_signal_positive = (
        int(holdout_current["netPassDelta"]) > 0
        and int(holdout_blind["netPassDelta"]) > 0
        and int(holdout_current["passToFail"]) == 0
        and int(holdout_blind["passToFail"]) == 0
    )
    promotion_blockers: list[str] = []
    for dataset in DATASET_ORDER:
        for split in ("tune", "holdout", "all"):
            metrics = selected_metrics[dataset][split]
            if int(metrics["passToFail"]) > 0:
                promotion_blockers.append(f"{dataset}/{split} pass->fail={metrics['passToFail']}")
            if int(metrics["netPassDelta"]) < 0:
                promotion_blockers.append(f"{dataset}/{split} net={metrics['netPassDelta']}")
    promotion_safe = holdout_signal_positive and not promotion_blockers
    selected_model = selected["model"]
    weight_abs = np.abs(np.asarray(selected_model["weights"], dtype="float64"))
    top_weight_indices = np.argsort(-weight_abs)[:24]
    return {
        "version": VERSION,
        "scope": (
            "Diagnostic only. Logistic phase-ranker is trained from candidate/audio-cache numeric features; "
            "holdout metrics are validation only and must not be used for threshold scanning."
        ),
        "leakageControls": {
            "excludedFromFeatures": [
                "fileName",
                "artist",
                "title",
                "path",
                "split identity",
                "truth values",
                "benchmark category",
                "firstBeatPhaseErrorMs",
                "source string one-hot",
            ],
            "trainSplits": ["current/train", "blind/train"],
            "modelSelectionSplits": ["current/tune", "blind/tune"],
            "finalValidationSplits": ["current/holdout", "blind/holdout"],
            "productionSolverModified": False,
        },
        "training": {
            "featureCount": len(feature_names),
            "featureNames": feature_names,
            "candidateRankLimit": max(int(item["rankLimit"]) for item in MODE_CONFIGS),
            "trainExamples": int(X_train.shape[0]),
            "trainPositiveCount": int(np.sum(y_train)),
            "trainPositiveRate": _rate(int(np.sum(y_train)), int(X_train.shape[0])),
            "l2Grid": list(L2_GRID),
            "thresholdGrid": list(THRESHOLD_GRID),
        },
        "datasets": metadata_by_dataset,
        "selectedConfig": {
            "l2": selected["l2"],
            "mode": selected["mode"],
            "rankLimit": selected["rankLimit"],
            "threshold": selected["threshold"],
            "selectionRule": (
                "Prefer zero tune pass->fail, then maximize min(current tune net, blind tune net), "
                "then lower switch count, then total tune net."
            ),
            "selectionScore": selected["selectionScore"],
            "topWeights": [
                {
                    "feature": feature_names[int(index)],
                    "weight": round(float(selected_model["weights"][int(index)]), 6),
                }
                for index in top_weight_indices
                if int(index) < len(feature_names)
            ],
        },
        "probabilitySummary": {
            dataset: {
                split: _candidate_probability_summary([row for row in rows_by_dataset[dataset] if row["split"] == split])
                for split in ("train", "tune", "holdout")
            }
            for dataset in DATASET_ORDER
        },
        "metrics": selected_metrics,
        "topConfigsByTune": top_configs,
        "promotionRecommendation": {
            "safeToPromote": promotion_safe,
            "holdoutSignalPositive": holdout_signal_positive,
            "blockers": promotion_blockers,
            "reason": (
                "requires positive current and blind holdout net, no tune/holdout/all pass->fail, "
                "and no tune/holdout/all net regression"
                if not promotion_safe
                else "current and blind holdout both improved without tune/holdout/all regression"
            ),
        },
    }


def main() -> int:
    _configure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Train a diagnostic-only phase ranker with fixed split discipline")
    parser.add_argument("--current-benchmark", default=str(DEFAULT_CURRENT_BENCHMARK))
    parser.add_argument("--current-splits", default=str(DEFAULT_CURRENT_SPLITS))
    parser.add_argument("--current-feature-cache", default=str(DEFAULT_CURRENT_FEATURE_CACHE))
    parser.add_argument("--blind-benchmark", default=str(DEFAULT_BLIND_BENCHMARK))
    parser.add_argument("--blind-splits", default=str(DEFAULT_BLIND_SPLITS))
    parser.add_argument("--blind-feature-cache", default=str(DEFAULT_BLIND_FEATURE_CACHE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--detail-limit", type=int, default=20)
    args = parser.parse_args()

    max_rank = max(int(item["rankLimit"]) for item in MODE_CONFIGS)
    rows_by_dataset: dict[str, list[dict[str, Any]]] = {}
    metadata_by_dataset: dict[str, dict[str, Any]] = {}
    current_rows, current_metadata = _dataset_rows(
        name="current",
        benchmark_path=Path(args.current_benchmark),
        split_path=Path(args.current_splits),
        feature_cache_dir=Path(args.current_feature_cache),
        max_rank=max_rank,
    )
    blind_rows, blind_metadata = _dataset_rows(
        name="blind",
        benchmark_path=Path(args.blind_benchmark),
        split_path=Path(args.blind_splits),
        feature_cache_dir=Path(args.blind_feature_cache),
        max_rank=max_rank,
    )
    rows_by_dataset["current"] = current_rows
    rows_by_dataset["blind"] = blind_rows
    metadata_by_dataset["current"] = current_metadata
    metadata_by_dataset["blind"] = blind_metadata

    feature_names = next(
        (
            row["featureNames"]
            for rows in rows_by_dataset.values()
            for row in rows
            if row.get("featureNames")
        ),
        [],
    )
    report = _build_report(
        rows_by_dataset=rows_by_dataset,
        metadata_by_dataset=metadata_by_dataset,
        feature_names=feature_names,
        detail_limit=int(args.detail_limit),
    )
    output_path = Path(args.output)
    atomic_write_json(output_path, report)
    compact = {
        "output": str(output_path),
        "selectedConfig": report["selectedConfig"],
        "holdout": {
            dataset: report["metrics"][dataset]["holdout"]
            for dataset in DATASET_ORDER
        },
        "safeToPromote": report["promotionRecommendation"]["safeToPromote"],
    }
    print(json.dumps(compact, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
