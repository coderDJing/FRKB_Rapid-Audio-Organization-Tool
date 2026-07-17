import argparse
import hashlib
import json
import math
import time
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Any

import numpy as np

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_beatgrid_lab_common import (
    build_feature_index_map,
    read_feature_metadata,
    resolve_feature_arrays_path,
    resolve_feature_entry,
)
from rkb_benchmark_bridge_result import normalize_bridge_result
from rkb_dataset_contract import normalize_name, sha256_file, sha256_json
from rkb_multiscale_spectral import MULTISCALE_SPECTRAL_VERSION
from rkb_multiscale_study_inputs import DEFAULT_BENCHMARKS, iter_benchmark_tracks
from rkb_nested_lobo_contract import read_json_object
from rkb_nested_lobo_evaluator import load_truth_catalog
from rkb_onset_foot_phase_diagnostic import _candidate_onset_features
from rkb_phase_ranker_diagnostic import (
    NUMERIC_FEATURE_KEYS,
    _load_signal_bundle,
)
from rkb_phase_ranker_rising_edge_diagnostic import (
    RISING_FEATURE_KEYS,
    _candidate_rising_edge_features,
)


STUDY_VERSION = "rkb-multiscale-ridge-nested-development-v2-conservative-thresholds"
ROW_CACHE_VERSION = "rkb-multiscale-candidate-row-v4"
L2_GRID = (0.1, 1.0)
THRESHOLD_GRID = (0.8, 0.85, 0.9, 0.95, 1.0, 1.1, 1.2, 1.4)
MODE_GRID = ("ranked-top16", "ranked-top16-same-mod4")
MULTISCALE_PROFILE_KEYS = (
    "support",
    "medianOffsetMs",
    "offsetMadMs",
    "segmentAgreement",
    "meanBestScore",
    "meanCenterScore",
    "meanMargin",
)
SELECTION_GATES = {
    "maximumPassToFailRate": 0.005,
    "maximumBpmBigErrorRateIncrease": 0.0025,
    "maximumDownbeatFailureRateIncrease": 0.005,
}
OUTER_GATES = {
    "minimumPositiveFoldCount": 4,
    "minimumMacroNetStrictAccuracyDeltaRate": 0.001,
    "minimumWorstFoldNetStrictAccuracyDeltaRate": -0.0025,
    "maximumWorstFoldPassToFailRate": 0.005,
    "maximumWorstFoldBpmBigErrorRateIncrease": 0.0025,
    "maximumWorstFoldDownbeatFailureRateIncrease": 0.005,
}


def _configure_utf8_stdio() -> None:
    try:
        import sys

        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _sidecar_index_map(path: Path) -> dict[str, dict[str, Any]]:
    payload = read_json_object(path)
    if payload.get("type") != "rkb-multiscale-spectral-sidecar-index":
        raise RuntimeError("multiscale sidecar index has an invalid type")
    if (payload.get("spectralPolicy") or {}).get("version") != MULTISCALE_SPECTRAL_VERSION:
        raise RuntimeError("multiscale sidecar policy version mismatch")
    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise RuntimeError("multiscale sidecar index has no entries")
    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        instance_id = str(entry.get("instanceId") or "").casefold()
        if not instance_id or instance_id in result:
            raise RuntimeError(f"invalid/duplicate multiscale instance: {instance_id}")
        result[instance_id] = entry
    return result


def _load_multiscale_bundle(
    *,
    instance_id: str,
    sidecar_dir: Path,
    sidecar_map: dict[str, dict[str, Any]],
) -> tuple[dict[str, tuple[np.ndarray, float]], dict[str, Any]]:
    entry = sidecar_map.get(instance_id.casefold())
    if entry is None:
        raise RuntimeError(f"multiscale sidecar misses instance: {instance_id}")
    metadata_path = sidecar_dir / str(entry.get("metadataPath") or "")
    arrays_path = sidecar_dir / str(entry.get("arraysPath") or "")
    metadata = read_json_object(metadata_path)
    if metadata.get("cacheKey") != entry.get("cacheKey"):
        raise RuntimeError(f"multiscale sidecar cache key mismatch: {instance_id}")
    if not arrays_path.is_file():
        raise RuntimeError(f"multiscale arrays are missing: {instance_id}")
    with np.load(arrays_path, allow_pickle=False) as arrays:
        frame_rate = float(np.asarray(arrays["frameRate"]).item())
        bundle = {
            key: (np.asarray(arrays[key], dtype="float64"), frame_rate)
            for key in arrays.files
            if key != "frameRate"
        }
    return bundle, entry


def _multiscale_profiles(
    *,
    candidate: dict[str, Any],
    bundle: dict[str, tuple[np.ndarray, float]],
    duration_sec: float,
) -> dict[str, dict[str, Any]]:
    return {
        name: _fast_grid_profile(
            values=values,
            frame_rate=frame_rate,
            candidate=candidate,
            duration_sec=duration_sec,
        )
        for name, (values, frame_rate) in sorted(bundle.items())
    }


def _fast_grid_profile(
    *,
    values: np.ndarray,
    frame_rate: float,
    candidate: dict[str, Any],
    duration_sec: float,
) -> dict[str, Any]:
    bpm = float(candidate.get("bpm") or 0.0)
    first_beat_sec = float(candidate.get("firstBeatMs") or 0.0) / 1000.0
    if values.size < 16 or frame_rate <= 0.0 or bpm <= 0.0:
        return {key: 0.0 for key in MULTISCALE_PROFILE_KEYS}
    interval_sec = 60.0 / bpm
    beat_count = min(96, max(0, int((min(duration_sec, 120.0) - first_beat_sec) / interval_sec) + 1))
    if beat_count < 8:
        return {key: 0.0 for key in MULTISCALE_PROFILE_KEYS}
    beat_times = first_beat_sec + np.arange(beat_count, dtype="float64") * interval_sec
    offset_ms = np.asarray((-30.0, -20.0, -10.0, 0.0, 10.0, 20.0, 30.0), dtype="float64")
    positions = np.rint(beat_times[:, None] * frame_rate + offset_ms[None, :] * frame_rate / 1000.0).astype(
        "int64",
        copy=False,
    )
    valid = (positions >= 0) & (positions < values.size)
    sampled = np.where(valid, values[np.clip(positions, 0, max(0, values.size - 1))], np.nan)
    valid_rows = np.count_nonzero(np.isfinite(sampled), axis=1) >= 5
    sampled = sampled[valid_rows]
    if sampled.shape[0] < 8:
        return {key: 0.0 for key in MULTISCALE_PROFILE_KEYS}
    mean_scores = np.nanmean(sampled, axis=0)
    best_index = int(np.nanargmax(mean_scores))
    best_score = float(mean_scores[best_index])
    center_score = float(mean_scores[3])
    second_score = float(np.partition(mean_scores, -2)[-2]) if mean_scores.size > 1 else center_score
    local_best_indices = np.nanargmax(sampled, axis=1)
    local_offsets = offset_ms[local_best_indices]
    median_offset = float(np.median(local_offsets))
    offset_mad = float(np.median(np.abs(local_offsets - median_offset)))
    agreement = float(np.mean(np.abs(local_offsets - float(offset_ms[best_index])) <= 10.0))
    return {
        "support": int(sampled.shape[0]),
        "medianOffsetMs": round(median_offset, 3),
        "offsetMadMs": round(offset_mad, 3),
        "segmentAgreement": round(agreement, 6),
        "meanBestScore": round(best_score, 6),
        "meanCenterScore": round(center_score, 6),
        "meanMargin": round(best_score - second_score, 6),
    }


def _append_multiscale_features(
    values: list[float],
    names: list[str],
    *,
    candidate_profiles: dict[str, dict[str, Any]],
    selected_profiles: dict[str, dict[str, Any]],
) -> None:
    for signal_name in sorted(candidate_profiles):
        candidate = candidate_profiles[signal_name]
        selected = selected_profiles.get(signal_name, {})
        for key in MULTISCALE_PROFILE_KEYS:
            candidate_value = float(candidate.get(key) or 0.0)
            selected_value = float(selected.get(key) or 0.0)
            values.extend((candidate_value, candidate_value - selected_value))
            names.extend(
                (
                    f"multiscale.{signal_name}.{key}",
                    f"multiscaleDelta.{signal_name}.{key}",
                )
            )
        candidate_median = float(candidate.get("medianOffsetMs") or 0.0)
        selected_median = float(selected.get("medianOffsetMs") or 0.0)
        values.extend((abs(candidate_median), abs(candidate_median) - abs(selected_median)))
        names.extend(
            (
                f"multiscale.{signal_name}.absMedianOffsetMs",
                f"multiscaleDelta.{signal_name}.absMedianOffsetMs",
            )
        )


def _analysis_flags(
    *,
    bpm: float,
    timeline_first_beat_ms: float,
    downbeat_beat_offset: int,
    truth: dict[str, Any],
) -> dict[str, Any]:
    metrics = benchmark._derive_grid_metrics(
        result_bpm=float(bpm),
        result_first_beat_timeline_ms=float(timeline_first_beat_ms),
        result_downbeat_beat_offset=int(downbeat_beat_offset) % 4,
        truth=truth,
        compare_count=128,
    )
    classification = benchmark._classify(metrics, float(bpm), float(truth["bpm"]))
    return {
        "category": str(classification["category"]),
        "bpmBigError": abs(float(metrics["bpmOnlyDrift128BeatsMs"]))
        > benchmark.STRICT_TOLERANCE_MS,
        "downbeatFailure": not bool(metrics["downbeatBeatOffsetMatches"]),
        "metrics": metrics,
    }


def _row_cache_key(
    *,
    instance_id: str,
    source_entry: dict[str, Any],
    sidecar_entry: dict[str, Any],
    analysis_source_sha256: str,
) -> str:
    return sha256_json(
        {
            "version": ROW_CACHE_VERSION,
            "instanceId": instance_id,
            "sourceCacheKey": source_entry.get("cacheKey"),
            "sidecarCacheKey": sidecar_entry.get("cacheKey"),
            "analysisSourceSha256": analysis_source_sha256,
            "spectralVersion": MULTISCALE_SPECTRAL_VERSION,
        }
    )


def _row_path(row_cache_dir: Path, instance_id: str) -> Path:
    digest = hashlib.sha256(instance_id.casefold().encode("utf-8")).hexdigest()
    return row_cache_dir / f"row-{digest}.json"


def _metric_from_evaluated(candidate: dict[str, Any], truth: dict[str, Any]) -> dict[str, Any]:
    flags = _analysis_flags(
        bpm=float(candidate["bpm"]),
        timeline_first_beat_ms=float(candidate["timelineFirstBeatMs"]),
        downbeat_beat_offset=int(candidate["downbeatBeatOffset"]),
        truth=truth,
    )
    flags.pop("metrics", None)
    return flags


def _selected_profile_current(
    track: dict[str, Any], signal_bundle: dict[str, tuple[np.ndarray, float]]
) -> dict[str, Any]:
    analysis = track["analysis"]
    timeline = track["currentTimeline"]
    duration_sec = float(analysis.get("durationSec") or 120.0)
    candidate_like = {
        "bpm": float(analysis["bpm"]),
        "firstBeatMs": float(analysis["firstBeatMs"]),
    }
    onset = _candidate_onset_features(
        candidate=candidate_like,
        signal_bundle=signal_bundle,
        duration_sec=duration_sec,
    )
    rising = _candidate_rising_edge_features(
        candidate=candidate_like,
        signal_bundle=signal_bundle,
        duration_sec=duration_sec,
    )
    features = analysis.get("gridSolverFeatures") if isinstance(analysis.get("gridSolverFeatures"), dict) else {}
    return {
        "score": float(analysis.get("gridSolverScore") or 0.0),
        "source": str(analysis.get("gridSolverSelectedSource") or ""),
        "bpm": float(analysis["bpm"]),
        "firstBeatMs": float(analysis["firstBeatMs"]),
        "timelineFirstBeatMs": float(timeline["firstBeatMs"]),
        "barBeatOffset": int(analysis["downbeatBeatOffset"]) % 4,
        "category": str(timeline["category"]),
        "features": {**features, **onset, **rising},
    }


def _safe_float(value: Any) -> float:
    try:
        numeric = float(value)
    except Exception:
        return 0.0
    return numeric if math.isfinite(numeric) else 0.0


def _phase_delta_ms(a_ms: float, b_ms: float, interval_ms: float) -> float:
    if interval_ms <= 0.0:
        return a_ms - b_ms
    return (a_ms - b_ms + interval_ms / 2.0) % interval_ms - interval_ms / 2.0


def _base_feature_vector(
    *,
    candidate: dict[str, Any],
    selected: dict[str, Any],
) -> tuple[list[float], list[str]]:
    candidate_features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
    selected_features = selected.get("features") if isinstance(selected.get("features"), dict) else {}
    bpm = max(1e-6, _safe_float(candidate.get("bpm")))
    selected_bpm = max(1e-6, _safe_float(selected.get("bpm")))
    interval_ms = 60000.0 / bpm
    values = [
        _safe_float(candidate.get("rank")),
        1.0 / max(1.0, _safe_float(candidate.get("rank"))),
        _safe_float(candidate.get("score")),
        _safe_float(candidate.get("score")) - _safe_float(selected.get("score")),
        bpm,
        bpm - selected_bpm,
        abs(bpm - selected_bpm),
        _phase_delta_ms(
            _safe_float(candidate.get("timelineFirstBeatMs")),
            _safe_float(selected.get("timelineFirstBeatMs")),
            interval_ms,
        ),
        1.0
        if int(candidate.get("barBeatOffset") or 0) % 4
        == int(selected.get("barBeatOffset") or 0) % 4
        else 0.0,
    ]
    names = [
        "rank",
        "invRank",
        "candidateScore",
        "scoreMinusSelected",
        "bpm",
        "bpmMinusSelected",
        "absBpmMinusSelected",
        "candidateToSelectedPhaseDeltaMs",
        "barBeatOffsetSameMod4",
    ]
    for key in (*NUMERIC_FEATURE_KEYS, *RISING_FEATURE_KEYS):
        candidate_value = _safe_float(candidate_features.get(key))
        selected_value = _safe_float(selected_features.get(key))
        values.extend((candidate_value, candidate_value - selected_value))
        names.extend((f"candidate.{key}", f"delta.{key}"))
    return values, names


def _evaluated_candidates_current(
    analysis: dict[str, Any], truth: dict[str, Any]
) -> list[dict[str, Any]]:
    raw_candidates = analysis.get("gridSolverCandidates")
    candidates = [item for item in raw_candidates if isinstance(item, dict)] if isinstance(raw_candidates, list) else []
    offset_ms = float((truth.get("timeBasis") or {}).get("offsetMs") or 0.0)
    result: list[dict[str, Any]] = []
    for rank, candidate in enumerate(candidates, start=1):
        bpm = float(candidate.get("bpm") or 0.0)
        first_beat_ms = float(candidate.get("firstBeatMs") or 0.0)
        if bpm <= 0.0:
            continue
        downbeat_beat_offset = int(
            candidate.get("downbeatBeatOffset", candidate.get("barBeatOffset", 0)) or 0
        ) % 4
        flags = _analysis_flags(
            bpm=bpm,
            timeline_first_beat_ms=first_beat_ms + offset_ms,
            downbeat_beat_offset=downbeat_beat_offset,
            truth=truth,
        )
        flags.pop("metrics", None)
        features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
        source = str(candidate.get("source") or "")
        legacy_source = str(features.get("legacyGridSolverSelectedSource") or "")
        result.append(
            {
                "rank": rank,
                "score": float(candidate.get("score") or 0.0),
                "source": source,
                "isLegacy": "legacy" in source.casefold() or "legacy" in legacy_source.casefold(),
                "bpm": bpm,
                "firstBeatMs": first_beat_ms,
                "timelineFirstBeatMs": first_beat_ms + offset_ms,
                "downbeatBeatOffset": downbeat_beat_offset,
                "barBeatOffset": downbeat_beat_offset,
                "features": features,
                **flags,
            }
        )
    return result


def _build_track_row(
    *,
    truth: dict[str, Any],
    source_cache_dir: Path,
    source_index_map: dict[str, dict[str, Any]],
    sidecar_dir: Path,
    sidecar_map: dict[str, dict[str, Any]],
    row_cache_dir: Path,
    analysis_payload: dict[str, Any],
    analysis_source_sha256: str,
) -> dict[str, Any]:
    instance_id = str(truth.get("instanceId") or "")
    source_entry = resolve_feature_entry(track=truth, index_map=source_index_map)
    if source_entry is None:
        raise RuntimeError(f"source feature cache misses instance: {instance_id}")
    sidecar_entry = sidecar_map.get(instance_id.casefold())
    if sidecar_entry is None:
        raise RuntimeError(f"multiscale sidecar misses instance: {instance_id}")
    cache_key = _row_cache_key(
        instance_id=instance_id,
        source_entry=source_entry,
        sidecar_entry=sidecar_entry,
        analysis_source_sha256=analysis_source_sha256,
    )
    cache_path = _row_path(row_cache_dir, instance_id)
    if cache_path.is_file():
        cached = read_json_object(cache_path)
        if cached.get("cacheKey") == cache_key:
            return cached

    multiscale_bundle, _ = _load_multiscale_bundle(
        instance_id=instance_id,
        sidecar_dir=sidecar_dir,
        sidecar_map=sidecar_map,
    )

    metadata = read_feature_metadata(source_cache_dir, source_entry, track=truth)
    analysis = normalize_bridge_result(analysis_payload)
    analysis["barBeatOffset"] = int(analysis["downbeatBeatOffset"])
    for candidate in analysis.get("gridSolverCandidates") or []:
        candidate["barBeatOffset"] = int(candidate["downbeatBeatOffset"])
    time_basis = truth.get("timeBasis")
    if not isinstance(time_basis, dict):
        audio = metadata.get("audio") if isinstance(metadata.get("audio"), dict) else {}
        time_basis = audio.get("timeBasis") if isinstance(audio.get("timeBasis"), dict) else {"offsetMs": 0.0}
    enriched_truth = {**truth, "timeBasis": time_basis}
    offset_ms = float((time_basis or {}).get("offsetMs") or 0.0)
    baseline_evaluation = _analysis_flags(
        bpm=float(analysis["bpm"]),
        timeline_first_beat_ms=float(analysis["firstBeatMs"]) + offset_ms,
        downbeat_beat_offset=int(analysis["downbeatBeatOffset"]),
        truth=enriched_truth,
    )
    current_timeline = {
        "firstBeatMs": round(float(analysis["firstBeatMs"]) + offset_ms, 3),
        **baseline_evaluation["metrics"],
        "category": baseline_evaluation["category"],
    }
    benchmark_track = {
        **enriched_truth,
        "analysis": analysis,
        "currentTimeline": current_timeline,
        "truth": enriched_truth,
    }
    source_bundle = _load_signal_bundle(
        track=benchmark_track,
        feature_cache_dir=source_cache_dir,
        index_map=source_index_map,
    )
    if source_bundle is None:
        raise RuntimeError(f"source signal bundle is unavailable: {instance_id}")
    selected = _selected_profile_current(benchmark_track, source_bundle)
    duration_sec = float(analysis.get("durationSec") or metadata.get("audio", {}).get("durationSec") or 120.0)
    selected_multiscale = _multiscale_profiles(
        candidate=selected,
        bundle=multiscale_bundle,
        duration_sec=duration_sec,
    )
    baseline_flags = _analysis_flags(
        bpm=float(selected["bpm"]),
        timeline_first_beat_ms=float(selected["timelineFirstBeatMs"]),
        downbeat_beat_offset=int(selected["barBeatOffset"]),
        truth=enriched_truth,
    )
    baseline_flags.pop("metrics", None)
    candidate_rows: list[dict[str, Any]] = []
    base_names: list[str] | None = None
    multiscale_names: list[str] | None = None
    for candidate in _evaluated_candidates_current(analysis, enriched_truth):
        if bool(candidate.get("isLegacy")) or int(candidate["rank"]) > 16:
            continue
        onset = _candidate_onset_features(
            candidate=candidate,
            signal_bundle=source_bundle,
            duration_sec=duration_sec,
        )
        rising = _candidate_rising_edge_features(
            candidate=candidate,
            signal_bundle=source_bundle,
            duration_sec=duration_sec,
        )
        candidate_with_features = {
            **candidate,
            "features": {**dict(candidate.get("features") or {}), **onset, **rising},
        }
        base_vector, names = _base_feature_vector(
            candidate=candidate_with_features,
            selected=selected,
        )
        candidate_multiscale = _multiscale_profiles(
            candidate=candidate_with_features,
            bundle=multiscale_bundle,
            duration_sec=duration_sec,
        )
        multiscale_vector = list(base_vector)
        next_names = list(names)
        _append_multiscale_features(
            multiscale_vector,
            next_names,
            candidate_profiles=candidate_multiscale,
            selected_profiles=selected_multiscale,
        )
        if base_names is None:
            base_names = names
            multiscale_names = next_names
        elif base_names != names or multiscale_names != next_names:
            raise RuntimeError("ranker feature names drifted within one track")
        flags = _metric_from_evaluated(candidate_with_features, enriched_truth)
        candidate_rows.append(
            {
                "rank": int(candidate["rank"]),
                "barBeatOffsetSameMod4": int(candidate["barBeatOffset"]) % 4
                == int(selected["barBeatOffset"]) % 4,
                **flags,
                "baseVector": [round(float(value), 9) for value in base_vector],
                "multiscaleVector": [round(float(value), 9) for value in multiscale_vector],
            }
        )
    row = {
        "schemaVersion": 1,
        "type": ROW_CACHE_VERSION,
        "cacheKey": cache_key,
        "instanceId": instance_id,
        "batchId": str(truth.get("batchId") or ""),
        "baseline": {
            **baseline_flags,
            "isLegacySelected": "legacy" in str(selected.get("source") or "").casefold(),
        },
        "featureNames": {
            "base": base_names or [],
            "multiscale": multiscale_names or [],
        },
        "candidates": candidate_rows,
    }
    _atomic_write_json(cache_path, row)
    return row


def _feature_matrix(rows: list[dict[str, Any]], family: str) -> tuple[np.ndarray, np.ndarray, list[str]]:
    vector_key = "baseVector" if family == "base" else "multiscaleVector"
    values: list[list[float]] = []
    labels: list[float] = []
    feature_names: list[str] | None = None
    for row in rows:
        candidates = list(row.get("candidates") or [])
        if not candidates:
            continue
        names = list((row.get("featureNames") or {}).get(family) or [])
        if feature_names is None:
            feature_names = names
        elif names != feature_names:
            raise RuntimeError(f"{family} feature names drifted across tracks")
        for candidate in candidates:
            values.append([float(value) for value in candidate[vector_key]])
            labels.append(1.0 if candidate["category"] == "pass" else 0.0)
    if not values:
        raise RuntimeError(f"no {family} candidate examples")
    return np.asarray(values, dtype="float64"), np.asarray(labels, dtype="float64"), feature_names or []


def _fit_ridge(rows: list[dict[str, Any]], family: str, l2: float) -> dict[str, Any]:
    X, y, feature_names = _feature_matrix(rows, family)
    mean = np.mean(X, axis=0)
    std = np.std(X, axis=0)
    std = np.where(std < 1e-6, 1.0, std)
    Xs = np.clip((X - mean) / std, -8.0, 8.0)
    positive = max(1.0, float(np.sum(y)))
    negative = max(1.0, float(y.size - np.sum(y)))
    sample_weight = np.where(y > 0.5, y.size / (2.0 * positive), y.size / (2.0 * negative))
    weight_total = max(1.0, float(np.sum(sample_weight)))
    bias = float(np.sum(sample_weight * y) / weight_total)
    centered = y - bias
    weighted_X = Xs * np.sqrt(sample_weight)[:, None]
    weighted_y = centered * np.sqrt(sample_weight)
    gram = (weighted_X.T @ weighted_X) / weight_total
    gram.flat[:: gram.shape[0] + 1] += float(l2)
    target = (weighted_X.T @ weighted_y) / weight_total
    weights = np.linalg.solve(gram, target)
    return {
        "family": family,
        "l2": float(l2),
        "bias": bias,
        "mean": mean,
        "std": std,
        "weights": weights,
        "featureNames": feature_names,
        "trainTrackCount": len(rows),
        "trainCandidateCount": int(y.size),
        "trainPositiveRate": round(float(np.mean(y)), 9),
    }


def _score_candidates(rows: list[dict[str, Any]], model: dict[str, Any]) -> None:
    vector_key = "baseVector" if model["family"] == "base" else "multiscaleVector"
    vectors: list[list[float]] = []
    references: list[dict[str, Any]] = []
    for row in rows:
        for candidate in row.get("candidates") or []:
            vectors.append(candidate[vector_key])
            references.append(candidate)
    if not vectors:
        return
    X = np.asarray(vectors, dtype="float64")
    Xs = np.clip((X - model["mean"]) / model["std"], -8.0, 8.0)
    scores = Xs @ model["weights"] + float(model["bias"])
    for candidate, score in zip(references, scores, strict=False):
        candidate["rankerScore"] = round(float(score), 9)


def _select_candidate(row: dict[str, Any], mode: str) -> dict[str, Any] | None:
    candidates = list(row.get("candidates") or [])
    if mode.endswith("same-mod4"):
        candidates = [candidate for candidate in candidates if candidate["barBeatOffsetSameMod4"]]
    if not candidates:
        return None
    return max(candidates, key=lambda item: (float(item.get("rankerScore") or -999.0), -int(item["rank"])))


def _metrics(rows: list[dict[str, Any]], *, mode: str, threshold: float) -> dict[str, Any]:
    counters: Counter[str] = Counter()
    migrations: Counter[str] = Counter()
    for row in rows:
        baseline = row["baseline"]
        selected = baseline
        switched = False
        if baseline["isLegacySelected"]:
            candidate = _select_candidate(row, mode)
            if candidate is not None and float(candidate.get("rankerScore") or -999.0) >= threshold:
                selected = candidate
                switched = True
        counters["trackCount"] += 1
        counters["baselinePass"] += int(baseline["category"] == "pass")
        counters["selectedPass"] += int(selected["category"] == "pass")
        counters["failToPass"] += int(baseline["category"] != "pass" and selected["category"] == "pass")
        counters["passToFail"] += int(baseline["category"] == "pass" and selected["category"] != "pass")
        counters["baselineBpmBigError"] += int(baseline["bpmBigError"])
        counters["selectedBpmBigError"] += int(selected["bpmBigError"])
        counters["baselineDownbeatFailure"] += int(baseline["downbeatFailure"])
        counters["selectedDownbeatFailure"] += int(selected["downbeatFailure"])
        counters["switchCount"] += int(switched)
        migrations[f"{baseline['category']}->{selected['category']}"] += 1
    total = max(1, counters["trackCount"])
    return {
        **dict(counters),
        "baselineStrictAccuracy": round(counters["baselinePass"] / total, 9),
        "selectedStrictAccuracy": round(counters["selectedPass"] / total, 9),
        "netStrictAccuracyDeltaRate": round(
            (counters["selectedPass"] - counters["baselinePass"]) / total, 9
        ),
        "passToFailRate": round(counters["passToFail"] / total, 9),
        "bpmBigErrorRateIncrease": round(
            (counters["selectedBpmBigError"] - counters["baselineBpmBigError"]) / total, 9
        ),
        "downbeatFailureRateIncrease": round(
            (counters["selectedDownbeatFailure"] - counters["baselineDownbeatFailure"]) / total,
            9,
        ),
        "categoryMigration": dict(sorted(migrations.items())),
    }


def _group_rows(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        result.setdefault(str(row["batchId"]), []).append(row)
    return result


def _tune_config_metrics(rows: list[dict[str, Any]], *, mode: str, threshold: float) -> dict[str, Any]:
    by_batch = {
        batch_id: _metrics(batch_rows, mode=mode, threshold=threshold)
        for batch_id, batch_rows in sorted(_group_rows(rows).items())
    }
    fold_values = list(by_batch.values())
    safe = all(
        item["passToFailRate"] <= SELECTION_GATES["maximumPassToFailRate"]
        and item["bpmBigErrorRateIncrease"] <= SELECTION_GATES["maximumBpmBigErrorRateIncrease"]
        and item["downbeatFailureRateIncrease"] <= SELECTION_GATES["maximumDownbeatFailureRateIncrease"]
        for item in fold_values
    )
    return {
        "safe": safe,
        "macroNetStrictAccuracyDeltaRate": round(
            float(np.mean([item["netStrictAccuracyDeltaRate"] for item in fold_values])), 9
        ),
        "worstBatchNetStrictAccuracyDeltaRate": min(
            item["netStrictAccuracyDeltaRate"] for item in fold_values
        ),
        "netPassDelta": sum(item["selectedPass"] - item["baselinePass"] for item in fold_values),
        "passToFailCount": sum(item["passToFail"] for item in fold_values),
        "byBatch": by_batch,
    }


def _model_json(model: dict[str, Any]) -> dict[str, Any]:
    return {
        key: (
            [round(float(value), 12) for value in item]
            if isinstance(item, np.ndarray)
            else item
        )
        for key, item in model.items()
    }


def _choose_fold_config(
    train_rows: list[dict[str, Any]], tune_rows: list[dict[str, Any]]
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, dict[str, Any]]]:
    configs: list[dict[str, Any]] = [
        {
            "configId": "baseline-no-op",
            "family": "baseline",
            "l2": None,
            "mode": "no-op",
            "threshold": None,
            "complexityRank": 0,
            "tune": {
                "safe": True,
                "macroNetStrictAccuracyDeltaRate": 0.0,
                "worstBatchNetStrictAccuracyDeltaRate": 0.0,
                "netPassDelta": 0,
                "passToFailCount": 0,
                "byBatch": {},
            },
        }
    ]
    models: dict[str, dict[str, Any]] = {}
    for family in ("base", "multiscale"):
        for l2 in L2_GRID:
            model_id = f"{family}-ridge-l2-{l2:g}"
            model = _fit_ridge(train_rows, family, l2)
            models[model_id] = model
            _score_candidates(tune_rows, model)
            for mode in MODE_GRID:
                for threshold in THRESHOLD_GRID:
                    configs.append(
                        {
                            "configId": f"{model_id}-{mode}-threshold-{threshold:g}",
                            "modelId": model_id,
                            "family": family,
                            "l2": l2,
                            "mode": mode,
                            "threshold": threshold,
                            "complexityRank": 1 if family == "base" else 2,
                            "tune": _tune_config_metrics(
                                tune_rows,
                                mode=mode,
                                threshold=threshold,
                            ),
                        }
                    )
    eligible = [item for item in configs if item["tune"]["safe"]]
    selected = max(
        eligible,
        key=lambda item: (
            float(item["tune"]["macroNetStrictAccuracyDeltaRate"]),
            float(item["tune"]["worstBatchNetStrictAccuracyDeltaRate"]),
            int(item["tune"]["netPassDelta"]),
            -int(item["tune"]["passToFailCount"]),
            -int(item["complexityRank"]),
            str(item["configId"]),
        ),
    )
    ranking = sorted(
        configs,
        key=lambda item: (
            not bool(item["tune"]["safe"]),
            -float(item["tune"]["macroNetStrictAccuracyDeltaRate"]),
            -float(item["tune"]["worstBatchNetStrictAccuracyDeltaRate"]),
            -int(item["tune"]["netPassDelta"]),
            int(item["tune"]["passToFailCount"]),
            int(item["complexityRank"]),
            str(item["configId"]),
        ),
    )
    return selected, ranking, models


def run_study(args: argparse.Namespace) -> dict[str, Any]:
    split_path = Path(args.splits).resolve()
    fold_plan_path = Path(args.fold_plan).resolve()
    source_cache_dir = Path(args.source_cache_dir).resolve()
    sidecar_dir = Path(args.multiscale_cache_dir).resolve()
    work_dir = Path(args.work_dir).resolve()
    split = read_json_object(split_path)
    fold_plan = read_json_object(fold_plan_path)
    source_index_map = build_feature_index_map(source_cache_dir)
    sidecar_index_path = sidecar_dir / "index.json"
    sidecar_map = _sidecar_index_map(sidecar_index_path)
    primary_ids = [str(item) for item in fold_plan.get("primaryBatchIds") or []]
    folds = fold_plan.get("primaryFolds")
    if len(primary_ids) != 6 or not isinstance(folds, list) or len(folds) != 6:
        raise RuntimeError("study requires the canonical six primary folds")
    all_instance_ids = sorted(
        {
            str(instance_id)
            for fold in folds
            for key in ("effectiveDevelopmentTrain", "effectiveDevelopmentTune", "outerHoldout")
            for instance_id in fold.get(key) or []
        },
        key=str.casefold,
    )
    catalog = load_truth_catalog(split_path, split, instance_ids=all_instance_ids)
    row_cache_dir = (
        Path(args.row_cache_dir).resolve() if str(args.row_cache_dir or "").strip() else work_dir / "row-cache"
    )
    row_paths: dict[str, Path] = {}
    started_at = time.time()
    processed_count = 0
    row_workers = max(1, int(args.row_workers))
    with ThreadPoolExecutor(max_workers=row_workers) as executor:
        for batch_id in primary_ids:
            benchmark_path = Path(DEFAULT_BENCHMARKS[batch_id]).resolve()
            if not benchmark_path.is_file():
                raise RuntimeError(f"benchmark source is missing: {batch_id}:{benchmark_path}")
            benchmark_sha256 = sha256_file(benchmark_path)
            truths_by_name = {
                normalize_name(str(track.get("fileName") or "")): track
                for track in catalog.values()
                if str(track.get("batchId") or "") == batch_id
            }
            seen_names: set[str] = set()
            pending: dict[Any, str] = {}
            for benchmark_track in iter_benchmark_tracks(benchmark_path):
                name_key = normalize_name(str(benchmark_track.get("fileName") or ""))
                truth = truths_by_name.get(name_key)
                if truth is None:
                    continue
                analysis_payload = (
                    benchmark_track.get("analysis")
                    if isinstance(benchmark_track.get("analysis"), dict)
                    else None
                )
                if analysis_payload is None:
                    raise RuntimeError(f"benchmark track has no analysis: {batch_id}:{name_key}")
                instance_id = str(truth["instanceId"])
                future = executor.submit(
                    _build_track_row,
                    truth=truth,
                    source_cache_dir=source_cache_dir,
                    source_index_map=source_index_map,
                    sidecar_dir=sidecar_dir,
                    sidecar_map=sidecar_map,
                    row_cache_dir=row_cache_dir,
                    analysis_payload=analysis_payload,
                    analysis_source_sha256=benchmark_sha256,
                )
                pending[future] = instance_id
                seen_names.add(name_key)
                if len(pending) >= row_workers * 2:
                    done, _ = wait(set(pending), return_when=FIRST_COMPLETED)
                    for completed in done:
                        completed.result()
                        completed_id = pending.pop(completed)
                        row_paths[completed_id.casefold()] = _row_path(row_cache_dir, completed_id)
                        processed_count += 1
                        if processed_count % 25 == 0:
                            print(f"[rows {processed_count}/{len(all_instance_ids)}]", flush=True)
            while pending:
                done, _ = wait(set(pending), return_when=FIRST_COMPLETED)
                for completed in done:
                    completed.result()
                    completed_id = pending.pop(completed)
                    row_paths[completed_id.casefold()] = _row_path(row_cache_dir, completed_id)
                    processed_count += 1
                    if processed_count % 25 == 0 or processed_count == len(all_instance_ids):
                        print(f"[rows {processed_count}/{len(all_instance_ids)}]", flush=True)
            missing_names = set(truths_by_name) - seen_names
            if missing_names:
                raise RuntimeError(
                    f"benchmark source misses truth roster: {batch_id}:{sorted(missing_names)[0]}"
                )
    if set(row_paths) != {item.casefold() for item in all_instance_ids}:
        raise RuntimeError("row cache does not cover the canonical primary roster")

    def load_rows(instance_ids: list[str]) -> list[dict[str, Any]]:
        return [read_json_object(row_paths[str(item).casefold()]) for item in instance_ids]

    fold_reports: list[dict[str, Any]] = []
    for fold_index, fold in enumerate(folds, start=1):
        batch_id = str(fold["batchId"])
        train_rows = load_rows(fold["effectiveDevelopmentTrain"])
        tune_rows = load_rows(fold["effectiveDevelopmentTune"])
        outer_rows = load_rows(fold["outerHoldout"])
        selected, ranking, models = _choose_fold_config(train_rows, tune_rows)
        if selected["family"] == "baseline":
            outer_metrics = _metrics(outer_rows, mode="ranked-top16", threshold=999.0)
            selected_model = None
        else:
            selected_model = models[str(selected["modelId"])]
            _score_candidates(outer_rows, selected_model)
            outer_metrics = _metrics(
                outer_rows,
                mode=str(selected["mode"]),
                threshold=float(selected["threshold"]),
            )
        fold_dir = work_dir / "folds" / batch_id
        fold_payload = {
            "schemaVersion": 1,
            "type": "rkb-multiscale-ranker-development-fold",
            "studyVersion": STUDY_VERSION,
            "batchId": batch_id,
            "selectedConfig": selected,
            "selectedModel": _model_json(selected_model) if selected_model is not None else None,
            "tuneRanking": ranking,
            "outerMetrics": outer_metrics,
        }
        _atomic_write_json(fold_dir / "result.json", fold_payload)
        fold_reports.append(
            {
                "batchId": batch_id,
                "selectedConfigId": selected["configId"],
                "selectedFamily": selected["family"],
                "outerMetrics": outer_metrics,
                "resultPath": str((fold_dir / "result.json").resolve()).replace("\\", "/"),
            }
        )
        print(
            f"[fold {fold_index}/6] {batch_id} selected={selected['configId']} "
            f"net={outer_metrics['netStrictAccuracyDeltaRate']}",
            flush=True,
        )

    positive = sum(item["outerMetrics"]["netStrictAccuracyDeltaRate"] > 0.0 for item in fold_reports)
    neutral = sum(item["outerMetrics"]["netStrictAccuracyDeltaRate"] == 0.0 for item in fold_reports)
    negative = 6 - positive - neutral
    macro_delta = round(
        float(np.mean([item["outerMetrics"]["netStrictAccuracyDeltaRate"] for item in fold_reports])),
        9,
    )
    worst_delta = min(item["outerMetrics"]["netStrictAccuracyDeltaRate"] for item in fold_reports)
    worst_pass_to_fail = max(item["outerMetrics"]["passToFailRate"] for item in fold_reports)
    worst_bpm_increase = max(item["outerMetrics"]["bpmBigErrorRateIncrease"] for item in fold_reports)
    worst_downbeat_increase = max(
        item["outerMetrics"]["downbeatFailureRateIncrease"] for item in fold_reports
    )
    gates = {
        "minimumPositiveFoldCount": positive >= OUTER_GATES["minimumPositiveFoldCount"],
        "minimumMacroNetStrictAccuracyDeltaRate": macro_delta
        >= OUTER_GATES["minimumMacroNetStrictAccuracyDeltaRate"],
        "minimumWorstFoldNetStrictAccuracyDeltaRate": worst_delta
        >= OUTER_GATES["minimumWorstFoldNetStrictAccuracyDeltaRate"],
        "maximumWorstFoldPassToFailRate": worst_pass_to_fail
        <= OUTER_GATES["maximumWorstFoldPassToFailRate"],
        "maximumWorstFoldBpmBigErrorRateIncrease": worst_bpm_increase
        <= OUTER_GATES["maximumWorstFoldBpmBigErrorRateIncrease"],
        "maximumWorstFoldDownbeatFailureRateIncrease": worst_downbeat_increase
        <= OUTER_GATES["maximumWorstFoldDownbeatFailureRateIncrease"],
    }
    report = {
        "schemaVersion": 1,
        "type": "rkb-multiscale-ranker-nested-development-report",
        "studyVersion": STUDY_VERSION,
        "developmentDiagnosticOnly": True,
        "postHocDevelopmentIteration": True,
        "parentDevelopmentStudy": "rkb-multiscale-ridge-nested-development-v1",
        "primaryNestedEstimateEligible": False,
        "freshProofEligible": False,
        "parameterSelectionAllowedAfterOuter": False,
        "inputs": {
            "splitPath": str(split_path).replace("\\", "/"),
            "splitSha256": sha256_file(split_path),
            "foldPlanPath": str(fold_plan_path).replace("\\", "/"),
            "foldPlanSha256": sha256_file(fold_plan_path),
            "sourceFeatureIndexSha256": sha256_file(source_cache_dir / "index.json"),
            "multiscaleFeatureIndexSha256": sha256_file(sidecar_index_path),
        },
        "policy": {
            "analysisSources": DEFAULT_BENCHMARKS,
            "l2Grid": list(L2_GRID),
            "thresholdGrid": list(THRESHOLD_GRID),
            "modeGrid": list(MODE_GRID),
            "selectionGates": SELECTION_GATES,
            "outerGates": OUTER_GATES,
        },
        "aggregate": {
            "primaryFoldCount": 6,
            "positiveFoldCount": positive,
            "neutralFoldCount": neutral,
            "negativeFoldCount": negative,
            "macroNetStrictAccuracyDeltaRate": macro_delta,
            "worstFoldNetStrictAccuracyDeltaRate": worst_delta,
            "worstFoldPassToFailRate": worst_pass_to_fail,
            "worstFoldBpmBigErrorRateIncrease": worst_bpm_increase,
            "worstFoldDownbeatFailureRateIncrease": worst_downbeat_increase,
            "netPassDelta": sum(
                item["outerMetrics"]["selectedPass"] - item["outerMetrics"]["baselinePass"]
                for item in fold_reports
            ),
            "passToFailCount": sum(item["outerMetrics"]["passToFail"] for item in fold_reports),
            "selectedFamilyCounts": dict(Counter(item["selectedFamily"] for item in fold_reports)),
            "gates": gates,
            "passed": all(gates.values()),
        },
        "folds": fold_reports,
        "summary": {
            "trackCount": len(all_instance_ids),
            "elapsedSec": round(time.time() - started_at, 3),
        },
    }
    report["reportSha256"] = sha256_json(report)
    _atomic_write_json(work_dir / "report.json", report)
    return report


def main() -> int:
    _configure_utf8_stdio()
    parser = argparse.ArgumentParser(
        description="Run a train/tune/outer multiscale ranker study on consumed nested LOBO folds"
    )
    parser.add_argument(
        "--splits",
        default="grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-splits-current.json",
    )
    parser.add_argument(
        "--fold-plan",
        default=(
            "grid-analysis-lab/rkb-rekordbox-benchmark/nested-lobo/"
            "rkb-primary-nested-lobo-v2-groot/fold-plan.json"
        ),
    )
    parser.add_argument(
        "--source-cache-dir",
        default="grid-analysis-lab/rkb-rekordbox-benchmark/feature-cache-by-batch/primary",
    )
    parser.add_argument(
        "--multiscale-cache-dir",
        default="grid-analysis-lab/rkb-rekordbox-benchmark/multiscale-feature-cache/primary",
    )
    parser.add_argument(
        "--work-dir",
        default=(
            "grid-analysis-lab/rkb-rekordbox-benchmark/multiscale-studies/"
            "rkb-multiscale-ridge-nested-development-v2-conservative-thresholds"
        ),
    )
    parser.add_argument("--row-workers", type=int, default=6)
    parser.add_argument("--row-cache-dir", default="")
    args = parser.parse_args()
    report = run_study(args)
    print(json.dumps({"aggregate": report["aggregate"], "summary": report["summary"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
