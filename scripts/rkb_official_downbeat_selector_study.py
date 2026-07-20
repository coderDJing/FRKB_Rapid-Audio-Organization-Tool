from __future__ import annotations

import argparse
import json
import math
import mmap
import os
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from rkb_official_downbeat_selector import (
    PRESET_WEIGHTS,
    SELECTOR_VERSION,
    build_downbeat_rotation_evidence,
    score_downbeat_rotations,
)


DEFAULT_BENCHMARK_ROOT = Path("grid-analysis-lab/rkb-rekordbox-benchmark")
DEFAULT_FEATURE_CACHE = DEFAULT_BENCHMARK_ROOT / "feature-cache-by-batch/primary"
DEFAULT_COMPACT_FEATURES = DEFAULT_BENCHMARK_ROOT / "official-downbeat-selector-v1-features.json"
DEFAULT_OUTPUT = DEFAULT_BENCHMARK_ROOT / "official-downbeat-selector-v1-study.json"
BATCHES = ("current1407", "blind608", "old377", "test316", "test327", "test353")
REFERENCE_REPORTS = {
    "current1407": Path("frkb-current-latest.json"),
    "blind608": Path("blind-rekordbox-truth/frkb-blind-rank1-high-structural-score-v2.json"),
    "old377": Path("sealed-eval/frkb-sealed-constant-grid-dp-rank1-material-legacy-weakness.json"),
    "test316": Path("sealed-eval/frkb-sealed-test316-rank1-high-structural-score-v2.json"),
    "test327": Path("sealed-eval/frkb-sealed-test327-rank1-high-structural-score-v2.json"),
    "test353": Path("sealed-eval/frkb-sealed-test353-rank1-high-structural-score-v2-archive.json"),
}
ADVANTAGE_GRID = (0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.55, 0.75)
MARGIN_GRID = (0.0, 0.05, 0.10, 0.15, 0.25, 0.40)
AGREEMENT_GRID = (0.0, 0.20, 0.30, 0.40, 0.50, 0.60)
MODEL_COMPONENT_NAMES = (
    "classLikelihoodZ",
    "downbeatContrastZ",
    "robustBlockZ",
    "blockAgreementZ",
    "lowEnergyZ",
    "fullEnergyZ",
    "transitionZ",
    "introBoundaryZ",
)
MODEL_L2_GRID = (0.1, 1.0, 10.0, 100.0)
MODEL_ADVANTAGE_GRID = (0.0, 0.01, 0.02, 0.04, 0.06, 0.10, 0.16, 0.24, 0.36)
MODEL_MARGIN_GRID = (0.0, 0.01, 0.02, 0.04, 0.06, 0.10, 0.16, 0.24)


def _complete_track(track: dict[str, Any], batch_id: str) -> dict[str, Any]:
    required = (
        "sourcePath",
        "fileName",
        "truthDownbeatBeatOffset",
        "bpm",
        "firstBeatMs",
        "currentDownbeatBeatOffset",
        "durationSec",
        "firstBeatShiftBeats",
        "category",
        "bpmDriftStatus",
        "firstBeatPhaseStatus",
        "gridMaxStatus",
    )
    missing = [key for key in required if key not in track]
    if missing:
        raise RuntimeError(f"{batch_id}:{track.get('fileName') or '?'} missing fields: {missing}")
    first_beat_shift = int(track["firstBeatShiftBeats"])
    truth_rotation = int(track["truthDownbeatBeatOffset"]) % 4
    target_raw_rotation = (truth_rotation - first_beat_shift) % 4
    current_rotation = int(track["currentDownbeatBeatOffset"]) % 4
    timing_eligible = all(
        str(track[key]) == "pass"
        for key in ("bpmDriftStatus", "firstBeatPhaseStatus", "gridMaxStatus")
    )
    return {
        **track,
        "batchId": batch_id,
        "truthDownbeatBeatOffset": truth_rotation,
        "targetRawRotation": target_raw_rotation,
        "currentDownbeatBeatOffset": current_rotation,
        "currentDownbeatMatches": current_rotation == target_raw_rotation,
        "timingEligible": timing_eligible,
    }


def _read_compact_tracks(report_path: Path, batch_id: str) -> list[dict[str, Any]]:
    tracks: list[dict[str, Any]] = []
    source_marker = b'\n      "sourcePath":'
    analysis_marker = b'\n      "analysis": {'
    current_marker = b'\n      "currentTimeline": {'

    def scalar(segment: bytes, key: str) -> Any:
        pattern = re.compile(
            rb'\n\s*"' + re.escape(key.encode("utf-8")) + rb'":\s*([^\r\n]+)'
        )
        match = pattern.search(segment)
        if match is None:
            raise RuntimeError(f"{batch_id} missing scalar field in compact scan: {key}")
        raw_value = match.group(1).decode("utf-8").rstrip().rstrip(",")
        return json.loads(raw_value)

    with report_path.open("rb") as handle:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
            tracks_start = mapped.find(b'\n  "tracks": [')
            if tracks_start < 0:
                raise RuntimeError(f"tracks array missing: {report_path}")
            source_position = mapped.find(source_marker, tracks_start)
            while source_position >= 0:
                next_source = mapped.find(source_marker, source_position + len(source_marker))
                track_end = len(mapped) if next_source < 0 else next_source
                analysis_position = mapped.find(analysis_marker, source_position, track_end)
                current_position = mapped.find(current_marker, analysis_position, track_end)
                if analysis_position < 0 or current_position < 0:
                    raise RuntimeError(f"compact scan failed near byte {source_position}: {report_path}")
                header = mapped[source_position:analysis_position]
                analysis = mapped[analysis_position : min(current_position, analysis_position + 16384)]
                current_timeline = mapped[current_position : min(track_end, current_position + 8192)]
                track = {
                    "sourcePath": scalar(header, "sourcePath"),
                    "fileName": scalar(header, "fileName"),
                    "truthDownbeatBeatOffset": scalar(header, "downbeatBeatOffset"),
                    "bpm": scalar(analysis, "bpm"),
                    "firstBeatMs": scalar(analysis, "firstBeatMs"),
                    "currentDownbeatBeatOffset": scalar(analysis, "downbeatBeatOffset"),
                    "durationSec": scalar(analysis, "durationSec"),
                    "firstBeatShiftBeats": scalar(current_timeline, "firstBeatShiftBeats"),
                    "category": scalar(current_timeline, "category"),
                    "bpmDriftStatus": scalar(current_timeline, "bpmDriftStatus"),
                    "firstBeatPhaseStatus": scalar(current_timeline, "firstBeatPhaseStatus"),
                    "gridMaxStatus": scalar(current_timeline, "gridMaxStatus"),
                }
                tracks.append(_complete_track(track, batch_id))
                if next_source < 0:
                    break
                source_position = next_source
    return tracks


def _normalized_path(value: str) -> str:
    return os.path.normcase(os.path.normpath(value)).casefold()


def _lookup_key(value: str) -> str:
    return Path(value).name.casefold()


def _read_reference_truth(report_path: Path, batch_id: str) -> list[dict[str, Any]]:
    track_marker = b'\n      "fileName":'
    analysis_marker = b'\n      "analysis": {'

    def scalar(segment: bytes, key: str, default: Any = None) -> Any:
        pattern = re.compile(
            rb'\n\s*"' + re.escape(key.encode("utf-8")) + rb'":\s*([^\r\n]+)'
        )
        match = pattern.search(segment)
        if match is None:
            if default is not None:
                return default
            raise RuntimeError(f"{batch_id} reference truth missing field: {key}")
        raw_value = match.group(1).decode("utf-8").rstrip().rstrip(",")
        return json.loads(raw_value)

    rows: list[dict[str, Any]] = []
    with report_path.open("rb") as handle:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
            tracks_start = mapped.find(b'\n  "tracks": [')
            track_position = mapped.find(track_marker, tracks_start)
            while track_position >= 0:
                next_track = mapped.find(track_marker, track_position + len(track_marker))
                track_end = len(mapped) if next_track < 0 else next_track
                analysis_position = mapped.find(analysis_marker, track_position, track_end)
                if analysis_position < 0:
                    raise RuntimeError(f"reference compact scan failed near byte {track_position}: {report_path}")
                header = mapped[track_position:analysis_position]
                anchor_sec = scalar(header, "anchorSec", math.nan)
                truth_first_beat_ms = (
                    float(anchor_sec) * 1000.0
                    if math.isfinite(float(anchor_sec))
                    else float(scalar(header, "firstBeatMs"))
                )
                downbeat_offset = scalar(header, "downbeatBeatOffset", -1)
                if int(downbeat_offset) < 0:
                    downbeat_offset = scalar(header, "barBeatOffset")
                rows.append(
                    {
                        "sourcePath": scalar(header, "filePath"),
                        "fileName": scalar(header, "fileName"),
                        "truthBpm": float(scalar(header, "bpm")),
                        "truthFirstBeatMs": truth_first_beat_ms,
                        "truthDownbeatBeatOffset": int(downbeat_offset) % 4,
                        "timeBasisOffsetMs": float(scalar(header, "offsetMs")),
                    }
                )
                if next_track < 0:
                    break
                track_position = next_track
    return rows


def _reference_maps(
    rows: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_path = {_normalized_path(str(row["sourcePath"])): row for row in rows}
    by_name_candidates: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_name_candidates.setdefault(str(row["fileName"]).casefold(), []).append(row)
    by_name = {key: values[0] for key, values in by_name_candidates.items() if len(values) == 1}
    return by_path, by_name


def _apply_reference_truth(
    track: dict[str, Any],
    *,
    by_path: dict[str, dict[str, Any]],
    by_name: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    reference = by_path.get(_normalized_path(str(track["sourcePath"])))
    if reference is None:
        reference = by_name.get(str(track["fileName"]).casefold())
    if reference is None:
        raise RuntimeError(f"reference truth not found: {track['batchId']}:{track['fileName']}")
    truth_bpm = float(reference["truthBpm"])
    result_bpm = float(track["bpm"])
    truth_interval_ms = 60000.0 / truth_bpm
    result_interval_ms = 60000.0 / result_bpm
    result_timeline_ms = float(track["firstBeatMs"]) + float(reference["timeBasisOffsetMs"])
    raw_delta_ms = result_timeline_ms - float(reference["truthFirstBeatMs"])
    phase_error_ms = (
        (raw_delta_ms + truth_interval_ms * 0.5) % truth_interval_ms
    ) - truth_interval_ms * 0.5
    first_beat_shift = int(round((raw_delta_ms - phase_error_ms) / truth_interval_ms))
    bpm_drift_128_ms = (result_interval_ms - truth_interval_ms) * 128.0
    grid_max_ms = max(
        abs(phase_error_ms + index * (result_interval_ms - truth_interval_ms))
        for index in range(128)
    )
    bpm_status = "pass" if abs(bpm_drift_128_ms) <= 5.0 else "fail"
    phase_status = "pass" if abs(phase_error_ms) <= 5.0 else "fail"
    grid_status = "pass" if grid_max_ms <= 5.0 else "fail"
    truth_rotation = int(reference["truthDownbeatBeatOffset"]) % 4
    target_raw_rotation = (truth_rotation - first_beat_shift) % 4
    current_rotation = int(track["currentDownbeatBeatOffset"]) % 4
    downbeat_matches = current_rotation == target_raw_rotation
    half_or_double = (
        abs(result_bpm * 2.0 - truth_bpm) <= 0.08
        or abs(result_bpm / 2.0 - truth_bpm) <= 0.08
    )
    if half_or_double:
        category = "half-or-double-bpm"
    elif bpm_status == "fail":
        category = "bpm"
    elif phase_status == "fail":
        category = "first-beat-phase"
    elif grid_status == "fail":
        category = "grid-drift"
    elif not downbeat_matches:
        category = "downbeat"
    else:
        category = "pass"
    return {
        **track,
        "truthDownbeatBeatOffset": truth_rotation,
        "targetRawRotation": target_raw_rotation,
        "currentDownbeatMatches": downbeat_matches,
        "firstBeatShiftBeats": first_beat_shift,
        "category": category,
        "bpmDriftStatus": bpm_status,
        "firstBeatPhaseStatus": phase_status,
        "gridMaxStatus": grid_status,
        "timingEligible": bpm_status == phase_status == grid_status == "pass",
    }


def _cache_maps(index: dict[str, Any]) -> tuple[dict[tuple[str, str], dict[str, Any]], dict[tuple[str, str], dict[str, Any]]]:
    by_path: dict[tuple[str, str], dict[str, Any]] = {}
    by_name_candidates: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for entry in index.get("entries", []):
        if not isinstance(entry, dict):
            continue
        batch_id = str(entry.get("batchId") or "")
        source_path = str(entry.get("sourcePath") or "")
        file_name = str(entry.get("fileName") or "")
        if batch_id and source_path:
            by_path[(batch_id, _normalized_path(source_path))] = entry
        if batch_id and file_name:
            by_name_candidates.setdefault((batch_id, file_name.casefold()), []).append(entry)
    by_name = {
        key: values[0]
        for key, values in by_name_candidates.items()
        if len(values) == 1
    }
    return by_path, by_name


def _resolve_cache_entry(
    track: dict[str, Any],
    *,
    by_path: dict[tuple[str, str], dict[str, Any]],
    by_name: dict[tuple[str, str], dict[str, Any]],
) -> dict[str, Any]:
    batch_id = str(track["batchId"])
    source_path = str(track["sourcePath"])
    entry = by_path.get((batch_id, _normalized_path(source_path)))
    if entry is None:
        entry = by_name.get((batch_id, _lookup_key(source_path)))
    if entry is None:
        raise RuntimeError(f"feature cache entry not found: {batch_id}:{source_path}")
    return entry


def _extract_track_features(
    track: dict[str, Any],
    *,
    cache_root: Path,
    entry: dict[str, Any],
) -> dict[str, Any]:
    arrays_path = cache_root / str(entry["arraysPath"])
    with np.load(arrays_path, allow_pickle=False) as loaded:
        arrays = {name: loaded[name] for name in loaded.files}
        duration_sec = min(float(track["durationSec"]), float(entry.get("durationSec") or 120.0))
        evidence = build_downbeat_rotation_evidence(
            arrays=arrays,
            bpm=float(track["bpm"]),
            first_beat_ms=float(track["firstBeatMs"]),
            duration_sec=duration_sec,
        )
    preset_stats: dict[str, Any] = {}
    rotations = evidence.get("rotations") if isinstance(evidence.get("rotations"), list) else []
    current_rotation = int(track["currentDownbeatBeatOffset"]) % 4
    for preset in PRESET_WEIGHTS:
        scores = score_downbeat_rotations(evidence, preset=preset)
        order = sorted(range(4), key=lambda rotation: scores[rotation], reverse=True)
        top = int(order[0])
        agreement = 0.0
        if top < len(rotations) and isinstance(rotations[top], dict):
            agreement = float(rotations[top].get("blockAgreement") or 0.0)
        preset_stats[preset] = {
            "topRotation": top,
            "scores": scores,
            "advantage": round(float(scores[top] - scores[current_rotation]), 9),
            "margin": round(float(scores[order[0]] - scores[order[1]]), 9),
            "blockAgreement": round(agreement, 9),
        }
    return {
        "batchId": track["batchId"],
        "fileName": track["fileName"],
        "sourcePath": track["sourcePath"],
        "instanceId": entry.get("instanceId"),
        "isolationFamilyId": entry.get("isolationFamilyId"),
        "category": track["category"],
        "timingEligible": bool(track["timingEligible"]),
        "currentRotation": current_rotation,
        "targetRawRotation": int(track["targetRawRotation"]),
        "currentDownbeatMatches": bool(track["currentDownbeatMatches"]),
        "evidenceValid": bool(evidence.get("valid")),
        "evidenceReason": str(evidence.get("reason") or ""),
        "beatSupport": int(evidence.get("beatSupport") or 0),
        "blockCount": int(evidence.get("blockCount") or 0),
        "components": evidence.get("components") if isinstance(evidence.get("components"), dict) else {},
        "rotations": rotations,
        "presetStats": preset_stats,
    }


def _build_feature_rows(
    *,
    benchmark_root: Path,
    cache_root: Path,
    jobs: int,
) -> list[dict[str, Any]]:
    compact_tracks: list[dict[str, Any]] = []
    for batch_id in BATCHES:
        report_path = benchmark_root / f"official-phase-production-{batch_id}.json"
        started = time.perf_counter()
        batch_tracks = _read_compact_tracks(report_path, batch_id)
        reference_rows = _read_reference_truth(benchmark_root / REFERENCE_REPORTS[batch_id], batch_id)
        reference_by_path, reference_by_name = _reference_maps(reference_rows)
        batch_tracks = [
            _apply_reference_truth(
                track,
                by_path=reference_by_path,
                by_name=reference_by_name,
            )
            for track in batch_tracks
        ]
        compact_tracks.extend(batch_tracks)
        print(f"parsed {batch_id}: {len(batch_tracks)} tracks in {time.perf_counter() - started:.1f}s", flush=True)
    index = json.loads((cache_root / "index.json").read_text(encoding="utf-8"))
    by_path, by_name = _cache_maps(index)
    tasks: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for track in compact_tracks:
        tasks.append(
            (
                track,
                _resolve_cache_entry(track, by_path=by_path, by_name=by_name),
            )
        )
    rows: list[dict[str, Any]] = []
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=max(1, jobs)) as executor:
        futures = [
            executor.submit(_extract_track_features, track, cache_root=cache_root, entry=entry)
            for track, entry in tasks
        ]
        for index_value, future in enumerate(as_completed(futures), start=1):
            rows.append(future.result())
            if index_value % 250 == 0 or index_value == len(futures):
                print(
                    f"features {index_value}/{len(futures)} elapsed={time.perf_counter() - started:.1f}s",
                    flush=True,
                )
    rows.sort(key=lambda row: (BATCHES.index(str(row["batchId"])), str(row["fileName"]).casefold()))
    return rows


def _prediction(row: dict[str, Any], config: dict[str, Any]) -> int:
    current = int(row["currentRotation"])
    if not row.get("evidenceValid"):
        return current
    stats = row["presetStats"][config["preset"]]
    top = int(stats["topRotation"])
    if top == current:
        return current
    if float(stats["advantage"]) < float(config["minimumAdvantage"]):
        return current
    if float(stats["margin"]) < float(config["minimumMargin"]):
        return current
    if float(stats["blockAgreement"]) < float(config["minimumBlockAgreement"]):
        return current
    return top


def _metrics(rows: Iterable[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    rows_list = list(rows)
    baseline_strict = 0
    selected_strict = 0
    fail_to_pass = 0
    pass_to_fail = 0
    baseline_downbeat_failure = 0
    selected_downbeat_failure = 0
    switch_count = 0
    timing_eligible = 0
    for row in rows_list:
        current_correct = bool(row["currentDownbeatMatches"])
        selected_rotation = _prediction(row, config)
        selected_correct = selected_rotation == int(row["targetRawRotation"])
        baseline_downbeat_failure += int(not current_correct)
        selected_downbeat_failure += int(not selected_correct)
        switch_count += int(selected_rotation != int(row["currentRotation"]))
        if not row["timingEligible"]:
            continue
        timing_eligible += 1
        baseline_strict += int(current_correct)
        selected_strict += int(selected_correct)
        fail_to_pass += int(not current_correct and selected_correct)
        pass_to_fail += int(current_correct and not selected_correct)
    return {
        "trackTotal": len(rows_list),
        "timingEligibleTrackCount": timing_eligible,
        "baselineStrictPass": baseline_strict,
        "selectedStrictPass": selected_strict,
        "netStrictPassDelta": selected_strict - baseline_strict,
        "strictAccuracy": round(selected_strict / max(1, len(rows_list)), 9),
        "timingEligibleDownbeatAccuracy": round(selected_strict / max(1, timing_eligible), 9),
        "failToPass": fail_to_pass,
        "passToFail": pass_to_fail,
        "baselineDownbeatFailure": baseline_downbeat_failure,
        "selectedDownbeatFailure": selected_downbeat_failure,
        "downbeatFailureDelta": selected_downbeat_failure - baseline_downbeat_failure,
        "switchCount": switch_count,
    }


def _candidate_configs() -> Iterable[dict[str, Any]]:
    for preset in PRESET_WEIGHTS:
        for minimum_advantage in ADVANTAGE_GRID:
            for minimum_margin in MARGIN_GRID:
                for minimum_block_agreement in AGREEMENT_GRID:
                    yield {
                        "preset": preset,
                        "minimumAdvantage": minimum_advantage,
                        "minimumMargin": minimum_margin,
                        "minimumBlockAgreement": minimum_block_agreement,
                    }


def _config_sort_key(result: dict[str, Any]) -> tuple[Any, ...]:
    metrics = result["metrics"]
    config = result["config"]
    return (
        int(metrics["netStrictPassDelta"]),
        -int(metrics["passToFail"]),
        -int(metrics["selectedDownbeatFailure"]),
        -int(metrics["switchCount"]),
        float(config["minimumAdvantage"]),
        float(config["minimumMargin"]),
        float(config["minimumBlockAgreement"]),
    )


def _select_best_config(rows: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    results = []
    for config in _candidate_configs():
        results.append({"config": config, "metrics": _metrics(rows, config)})
    results.sort(key=_config_sort_key, reverse=True)
    return results[0], results[:20]


def _by_batch(rows: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    return {
        batch_id: _metrics([row for row in rows if row["batchId"] == batch_id], config)
        for batch_id in BATCHES
    }


def _nested_lobo(rows: list[dict[str, Any]]) -> dict[str, Any]:
    folds = []
    holdout_predictions: list[tuple[dict[str, Any], int]] = []
    for holdout_batch in BATCHES:
        holdout = [row for row in rows if row["batchId"] == holdout_batch]
        holdout_families = {str(row["isolationFamilyId"]) for row in holdout}
        train = [
            row
            for row in rows
            if row["batchId"] != holdout_batch
            and str(row["isolationFamilyId"]) not in holdout_families
        ]
        best, _top = _select_best_config(train)
        holdout_metrics = _metrics(holdout, best["config"])
        folds.append(
            {
                "holdoutBatch": holdout_batch,
                "trainTrackCount": len(train),
                "holdoutTrackCount": len(holdout),
                "excludedIsolationFamilyOverlapCount": len(rows) - len(holdout) - len(train),
                "selectedConfig": best["config"],
                "trainMetrics": best["metrics"],
                "holdoutMetrics": holdout_metrics,
            }
        )
        for row in holdout:
            holdout_predictions.append((row, _prediction(row, best["config"])))

    baseline_strict = sum(
        int(row["timingEligible"] and row["currentDownbeatMatches"])
        for row, _prediction_value in holdout_predictions
    )
    selected_strict = sum(
        int(row["timingEligible"] and prediction == int(row["targetRawRotation"]))
        for row, prediction in holdout_predictions
    )
    fail_to_pass = sum(
        int(
            row["timingEligible"]
            and not row["currentDownbeatMatches"]
            and prediction == int(row["targetRawRotation"])
        )
        for row, prediction in holdout_predictions
    )
    pass_to_fail = sum(
        int(
            row["timingEligible"]
            and row["currentDownbeatMatches"]
            and prediction != int(row["targetRawRotation"])
        )
        for row, prediction in holdout_predictions
    )
    baseline_downbeat_failure = sum(int(not row["currentDownbeatMatches"]) for row, _ in holdout_predictions)
    selected_downbeat_failure = sum(
        int(prediction != int(row["targetRawRotation"])) for row, prediction in holdout_predictions
    )
    return {
        "folds": folds,
        "aggregate": {
            "trackTotal": len(holdout_predictions),
            "baselineStrictPass": baseline_strict,
            "selectedStrictPass": selected_strict,
            "netStrictPassDelta": selected_strict - baseline_strict,
            "strictAccuracy": round(selected_strict / max(1, len(holdout_predictions)), 9),
            "failToPass": fail_to_pass,
            "passToFail": pass_to_fail,
            "baselineDownbeatFailure": baseline_downbeat_failure,
            "selectedDownbeatFailure": selected_downbeat_failure,
            "downbeatFailureDelta": selected_downbeat_failure - baseline_downbeat_failure,
        },
    }


def _model_vector(row: dict[str, Any], rotation: int) -> list[float]:
    current = int(row["currentRotation"])
    components = row.get("components") if isinstance(row.get("components"), dict) else {}
    values = []
    deltas = []
    for name in MODEL_COMPONENT_NAMES:
        component = components.get(name) if isinstance(components.get(name), list) else [0.0] * 4
        candidate_value = float(component[rotation]) if len(component) == 4 else 0.0
        current_value = float(component[current]) if len(component) == 4 else 0.0
        values.append(candidate_value)
        deltas.append(candidate_value - current_value)
    return [*values, *deltas, 1.0 if rotation == current else 0.0]


def _fit_ridge_model(rows: list[dict[str, Any]], l2: float) -> dict[str, Any]:
    vectors = []
    targets = []
    weights = []
    for row in rows:
        if not row["timingEligible"] or not row["evidenceValid"]:
            continue
        target_rotation = int(row["targetRawRotation"])
        for rotation in range(4):
            is_target = rotation == target_rotation
            vectors.append(_model_vector(row, rotation))
            targets.append(1.0 if is_target else 0.0)
            weights.append(1.5 if is_target else 0.5)
    matrix = np.asarray(vectors, dtype="float64")
    target = np.asarray(targets, dtype="float64")
    sample_weight = np.asarray(weights, dtype="float64")
    if matrix.shape[0] < 16:
        raise RuntimeError("insufficient rows for downbeat ridge model")
    mean = np.mean(matrix, axis=0)
    scale = np.std(matrix, axis=0)
    scale = np.where(scale <= 1e-9, 1.0, scale)
    normalized = (matrix - mean) / scale
    design = np.column_stack([np.ones(normalized.shape[0]), normalized])
    root_weight = np.sqrt(sample_weight)
    weighted_design = design * root_weight[:, None]
    weighted_target = target * root_weight
    penalty = np.eye(design.shape[1], dtype="float64") * float(l2)
    penalty[0, 0] = 0.0
    coefficients = np.linalg.solve(
        weighted_design.T @ weighted_design + penalty,
        weighted_design.T @ weighted_target,
    )
    return {
        "l2": float(l2),
        "mean": mean,
        "scale": scale,
        "coefficients": coefficients,
        "trainingCandidateCount": int(matrix.shape[0]),
    }


def _model_stats(row: dict[str, Any], model: dict[str, Any]) -> dict[str, Any]:
    current = int(row["currentRotation"])
    if not row["evidenceValid"]:
        return {
            "topRotation": current,
            "scores": [0.0] * 4,
            "advantage": 0.0,
            "margin": 0.0,
            "blockAgreement": 0.0,
        }
    matrix = np.asarray([_model_vector(row, rotation) for rotation in range(4)], dtype="float64")
    normalized = (matrix - model["mean"]) / model["scale"]
    design = np.column_stack([np.ones(4), normalized])
    scores_array = design @ model["coefficients"]
    scores = [float(value) for value in scores_array]
    order = sorted(range(4), key=lambda rotation: scores[rotation], reverse=True)
    top = int(order[0])
    rotations = row.get("rotations") if isinstance(row.get("rotations"), list) else []
    agreement = 0.0
    if top < len(rotations) and isinstance(rotations[top], dict):
        agreement = float(rotations[top].get("blockAgreement") or 0.0)
    return {
        "topRotation": top,
        "scores": [round(value, 9) for value in scores],
        "advantage": round(float(scores[top] - scores[current]), 9),
        "margin": round(float(scores[order[0]] - scores[order[1]]), 9),
        "blockAgreement": round(agreement, 9),
    }


def _model_stats_for_rows(
    rows: list[dict[str, Any]], model: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    return {str(row["instanceId"]): _model_stats(row, model) for row in rows}


def _model_prediction(
    row: dict[str, Any],
    stats: dict[str, Any],
    config: dict[str, Any],
) -> int:
    current = int(row["currentRotation"])
    top = int(stats["topRotation"])
    if top == current:
        return current
    if float(stats["advantage"]) < float(config["minimumAdvantage"]):
        return current
    if float(stats["margin"]) < float(config["minimumMargin"]):
        return current
    if float(stats["blockAgreement"]) < float(config["minimumBlockAgreement"]):
        return current
    return top


def _model_metrics(
    rows: list[dict[str, Any]],
    stats_by_id: dict[str, dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    baseline_strict = 0
    selected_strict = 0
    fail_to_pass = 0
    pass_to_fail = 0
    baseline_downbeat_failure = 0
    selected_downbeat_failure = 0
    switch_count = 0
    for row in rows:
        current_correct = bool(row["currentDownbeatMatches"])
        stats = stats_by_id[str(row["instanceId"])]
        prediction = _model_prediction(row, stats, config)
        selected_correct = prediction == int(row["targetRawRotation"])
        baseline_downbeat_failure += int(not current_correct)
        selected_downbeat_failure += int(not selected_correct)
        switch_count += int(prediction != int(row["currentRotation"]))
        if not row["timingEligible"]:
            continue
        baseline_strict += int(current_correct)
        selected_strict += int(selected_correct)
        fail_to_pass += int(not current_correct and selected_correct)
        pass_to_fail += int(current_correct and not selected_correct)
    return {
        "trackTotal": len(rows),
        "baselineStrictPass": baseline_strict,
        "selectedStrictPass": selected_strict,
        "netStrictPassDelta": selected_strict - baseline_strict,
        "strictAccuracy": round(selected_strict / max(1, len(rows)), 9),
        "failToPass": fail_to_pass,
        "passToFail": pass_to_fail,
        "baselineDownbeatFailure": baseline_downbeat_failure,
        "selectedDownbeatFailure": selected_downbeat_failure,
        "downbeatFailureDelta": selected_downbeat_failure - baseline_downbeat_failure,
        "switchCount": switch_count,
    }


def _model_config_sort_key(result: dict[str, Any]) -> tuple[Any, ...]:
    metrics = result["metrics"]
    config = result["config"]
    return (
        int(metrics["netStrictPassDelta"]),
        -int(metrics["passToFail"]),
        -int(metrics["selectedDownbeatFailure"]),
        -int(metrics["switchCount"]),
        float(config["minimumAdvantage"]),
        float(config["minimumMargin"]),
        float(config["minimumBlockAgreement"]),
    )


def _select_model_thresholds(
    rows: list[dict[str, Any]],
    stats_by_id: dict[str, dict[str, Any]],
    *,
    l2: float,
) -> dict[str, Any]:
    results = []
    for minimum_advantage in MODEL_ADVANTAGE_GRID:
        for minimum_margin in MODEL_MARGIN_GRID:
            for minimum_block_agreement in AGREEMENT_GRID:
                config = {
                    "l2": float(l2),
                    "minimumAdvantage": minimum_advantage,
                    "minimumMargin": minimum_margin,
                    "minimumBlockAgreement": minimum_block_agreement,
                }
                results.append(
                    {
                        "config": config,
                        "metrics": _model_metrics(rows, stats_by_id, config),
                    }
                )
    results.sort(key=_model_config_sort_key, reverse=True)
    return results[0]


def _family_safe_training_rows(
    rows: list[dict[str, Any]], holdout: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    holdout_ids = {str(row["instanceId"]) for row in holdout}
    holdout_families = {str(row["isolationFamilyId"]) for row in holdout}
    train = [
        row
        for row in rows
        if str(row["instanceId"]) not in holdout_ids
        and str(row["isolationFamilyId"]) not in holdout_families
    ]
    excluded_overlap = len(rows) - len(holdout) - len(train)
    return train, excluded_overlap


def _global_model_selection(rows: list[dict[str, Any]]) -> dict[str, Any]:
    candidates = []
    for l2 in MODEL_L2_GRID:
        out_of_fold_stats: dict[str, dict[str, Any]] = {}
        for holdout_batch in BATCHES:
            holdout = [row for row in rows if row["batchId"] == holdout_batch]
            train, _excluded = _family_safe_training_rows(rows, holdout)
            model = _fit_ridge_model(train, l2)
            out_of_fold_stats.update(_model_stats_for_rows(holdout, model))
        candidates.append(_select_model_thresholds(rows, out_of_fold_stats, l2=l2))
    candidates.sort(key=_model_config_sort_key, reverse=True)
    selected = candidates[0]
    final_model = _fit_ridge_model(rows, float(selected["config"]["l2"]))
    final_stats = _model_stats_for_rows(rows, final_model)
    final_metrics = _model_metrics(rows, final_stats, selected["config"])
    return {
        "selectedConfig": selected["config"],
        "outOfFoldEstimate": selected["metrics"],
        "candidateConfigs": candidates,
        "allConsumedFinalFit": final_metrics,
        "model": {
            "featureNames": [
                *MODEL_COMPONENT_NAMES,
                *(f"delta.{name}" for name in MODEL_COMPONENT_NAMES),
                "isCurrentRotation",
            ],
            "mean": [round(float(value), 12) for value in final_model["mean"]],
            "scale": [round(float(value), 12) for value in final_model["scale"]],
            "coefficients": [
                round(float(value), 12) for value in final_model["coefficients"]
            ],
            "trainingCandidateCount": final_model["trainingCandidateCount"],
        },
        "finalStats": final_stats,
    }


def _nested_model_lobo(rows: list[dict[str, Any]]) -> dict[str, Any]:
    folds = []
    aggregate_stats: dict[str, dict[str, Any]] = {}
    aggregate_configs: dict[str, dict[str, Any]] = {}
    for outer_batch in BATCHES:
        outer_holdout = [row for row in rows if row["batchId"] == outer_batch]
        outer_train, outer_overlap = _family_safe_training_rows(rows, outer_holdout)
        inner_batches = [batch for batch in BATCHES if batch != outer_batch]
        l2_candidates = []
        for l2 in MODEL_L2_GRID:
            inner_stats: dict[str, dict[str, Any]] = {}
            inner_rows: list[dict[str, Any]] = []
            for inner_batch in inner_batches:
                inner_holdout = [row for row in outer_train if row["batchId"] == inner_batch]
                inner_train, _inner_overlap = _family_safe_training_rows(outer_train, inner_holdout)
                model = _fit_ridge_model(inner_train, l2)
                inner_stats.update(_model_stats_for_rows(inner_holdout, model))
                inner_rows.extend(inner_holdout)
            l2_candidates.append(_select_model_thresholds(inner_rows, inner_stats, l2=l2))
        l2_candidates.sort(key=_model_config_sort_key, reverse=True)
        selected = l2_candidates[0]
        outer_model = _fit_ridge_model(outer_train, float(selected["config"]["l2"]))
        outer_stats = _model_stats_for_rows(outer_holdout, outer_model)
        aggregate_stats.update(outer_stats)
        for row in outer_holdout:
            aggregate_configs[str(row["instanceId"])] = selected["config"]
        folds.append(
            {
                "holdoutBatch": outer_batch,
                "trainTrackCount": len(outer_train),
                "holdoutTrackCount": len(outer_holdout),
                "excludedIsolationFamilyOverlapCount": outer_overlap,
                "selectedConfig": selected["config"],
                "innerEstimate": selected["metrics"],
                "holdoutMetrics": _model_metrics(
                    outer_holdout,
                    outer_stats,
                    selected["config"],
                ),
            }
        )

    baseline_strict = 0
    selected_strict = 0
    fail_to_pass = 0
    pass_to_fail = 0
    baseline_downbeat_failure = 0
    selected_downbeat_failure = 0
    for row in rows:
        stats = aggregate_stats[str(row["instanceId"])]
        config = aggregate_configs[str(row["instanceId"])]
        prediction = _model_prediction(row, stats, config)
        current_correct = bool(row["currentDownbeatMatches"])
        selected_correct = prediction == int(row["targetRawRotation"])
        baseline_downbeat_failure += int(not current_correct)
        selected_downbeat_failure += int(not selected_correct)
        if not row["timingEligible"]:
            continue
        baseline_strict += int(current_correct)
        selected_strict += int(selected_correct)
        fail_to_pass += int(not current_correct and selected_correct)
        pass_to_fail += int(current_correct and not selected_correct)
    return {
        "folds": folds,
        "aggregate": {
            "trackTotal": len(rows),
            "baselineStrictPass": baseline_strict,
            "selectedStrictPass": selected_strict,
            "netStrictPassDelta": selected_strict - baseline_strict,
            "strictAccuracy": round(selected_strict / max(1, len(rows)), 9),
            "failToPass": fail_to_pass,
            "passToFail": pass_to_fail,
            "baselineDownbeatFailure": baseline_downbeat_failure,
            "selectedDownbeatFailure": selected_downbeat_failure,
            "downbeatFailureDelta": selected_downbeat_failure - baseline_downbeat_failure,
        },
    }


def _migration_samples(rows: list[dict[str, Any]], config: dict[str, Any], limit: int = 80) -> dict[str, Any]:
    recovered = []
    regressed = []
    for row in rows:
        if not row["timingEligible"]:
            continue
        prediction = _prediction(row, config)
        selected_correct = prediction == int(row["targetRawRotation"])
        payload = {
            "batchId": row["batchId"],
            "fileName": row["fileName"],
            "currentRotation": row["currentRotation"],
            "selectedRotation": prediction,
            "truthRotation": row["targetRawRotation"],
            "stats": row["presetStats"][config["preset"]],
        }
        if not row["currentDownbeatMatches"] and selected_correct:
            recovered.append(payload)
        elif row["currentDownbeatMatches"] and not selected_correct:
            regressed.append(payload)
    return {
        "recovered": recovered[:limit],
        "regressed": regressed[:limit],
        "recoveredCount": len(recovered),
        "regressedCount": len(regressed),
    }


def _load_or_build_features(args: argparse.Namespace) -> list[dict[str, Any]]:
    compact_path = Path(args.compact_features)
    if compact_path.exists() and not args.rebuild_features:
        cached = json.loads(compact_path.read_text(encoding="utf-8"))
        if cached.get("selectorVersion") == SELECTOR_VERSION and isinstance(cached.get("rows"), list):
            print(f"reusing compact features: {compact_path} rows={len(cached['rows'])}", flush=True)
            return cached["rows"]
    rows = _build_feature_rows(
        benchmark_root=Path(args.benchmark_root),
        cache_root=Path(args.feature_cache),
        jobs=args.jobs,
    )
    compact_path.parent.mkdir(parents=True, exist_ok=True)
    compact_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "selectorVersion": SELECTOR_VERSION,
                "rowCount": len(rows),
                "rows": rows,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Study a Rekordbox-inspired fixed-grid downbeat selector")
    parser.add_argument("--benchmark-root", default=str(DEFAULT_BENCHMARK_ROOT))
    parser.add_argument("--feature-cache", default=str(DEFAULT_FEATURE_CACHE))
    parser.add_argument("--compact-features", default=str(DEFAULT_COMPACT_FEATURES))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--jobs", type=int, default=8)
    parser.add_argument("--rebuild-features", action="store_true")
    args = parser.parse_args()

    started = time.perf_counter()
    rows = _load_or_build_features(args)
    if len(rows) != 3388:
        raise RuntimeError(f"expected 3388 consumed tracks, got {len(rows)}")
    invalid = Counter(str(row["evidenceReason"]) for row in rows if not row["evidenceValid"])
    ablations = {}
    for preset in PRESET_WEIGHTS:
        config = {
            "preset": preset,
            "minimumAdvantage": 0.0,
            "minimumMargin": 0.0,
            "minimumBlockAgreement": 0.0,
        }
        ablations[preset] = _metrics(rows, config)

    print("selecting all-consumed final-fit config...", flush=True)
    final_fit, top_configs = _select_best_config(rows)
    print("running isolation-family-safe nested LOBO...", flush=True)
    nested_lobo = _nested_lobo(rows)
    print("selecting low-dimensional ridge selector...", flush=True)
    model_selection = _global_model_selection(rows)
    final_model_stats = model_selection.pop("finalStats")
    model_selection["byBatch"] = {
        batch_id: _model_metrics(
            [row for row in rows if row["batchId"] == batch_id],
            final_model_stats,
            model_selection["selectedConfig"],
        )
        for batch_id in BATCHES
    }
    print("running nested LOBO for ridge selector...", flush=True)
    nested_model_lobo = _nested_model_lobo(rows)
    output = {
        "schemaVersion": 1,
        "type": "rkb-official-downbeat-selector-study",
        "selectorVersion": SELECTOR_VERSION,
        "evidenceRole": "consumed-development-estimate-not-fresh-proof",
        "trackTotal": len(rows),
        "batchCounts": dict(Counter(str(row["batchId"]) for row in rows)),
        "isolationFamilyCount": len({str(row["isolationFamilyId"]) for row in rows}),
        "invalidEvidence": dict(invalid),
        "presetWeights": PRESET_WEIGHTS,
        "ablationsAlwaysUseEvidenceTop": ablations,
        "finalFit": {
            "config": final_fit["config"],
            "aggregate": final_fit["metrics"],
            "byBatch": _by_batch(rows, final_fit["config"]),
            "topConfigs": top_configs,
            "migrations": _migration_samples(rows, final_fit["config"]),
        },
        "nestedLobo": nested_lobo,
        "ridgeSelector": model_selection,
        "ridgeNestedLobo": nested_model_lobo,
        "elapsedSec": round(time.perf_counter() - started, 3),
        "notes": [
            "BPM and firstBeatMs are frozen; every candidate differs only by modulo-4 downbeat rotation.",
            "Feature arrays were produced by the existing Intel XPU Beat This cache pipeline.",
            "Nested LOBO excludes isolation families shared with each holdout batch from training.",
            "This consumed-data result can guide development but cannot replace a sealed fresh validation batch.",
        ],
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(output_path),
                "heuristicFinalFit": output["finalFit"]["aggregate"],
                "heuristicNestedLobo": nested_lobo["aggregate"],
                "ridgeOutOfFold": model_selection["outOfFoldEstimate"],
                "ridgeNestedLobo": nested_model_lobo["aggregate"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
