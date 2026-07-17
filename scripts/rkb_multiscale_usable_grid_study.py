import argparse
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from rkb_benchmark_bridge_result import normalize_bridge_result
from rkb_dataset_contract import normalize_name, sha256_file, sha256_json
from rkb_grid_acceptance import USABLE_GRID_POLICY_VERSION, assess_usable_grid
from rkb_multiscale_ranker_study import (
    L2_GRID,
    MODE_GRID,
    THRESHOLD_GRID,
    _fit_ridge,
    _model_json,
    _row_path,
    _score_candidates,
    _select_candidate,
)
from rkb_multiscale_study_inputs import DEFAULT_BENCHMARKS, iter_benchmark_tracks
from rkb_multiscale_usable_grid_replay import _raw_result
from rkb_nested_lobo_contract import read_json_object
from rkb_nested_lobo_evaluator import load_truth_catalog


STUDY_VERSION = "rkb-multiscale-ridge-usable-grid-development-v3"
CORRECTED_ROW_VERSION = "rkb-multiscale-usable-grid-training-row-v1"
DEFAULT_SOURCE_ROW_CACHE_DIR = (
    "grid-analysis-lab/rkb-rekordbox-benchmark/multiscale-studies/"
    "rkb-multiscale-ridge-nested-development-v1/row-cache"
)
DEFAULT_WORK_DIR = (
    "grid-analysis-lab/rkb-rekordbox-benchmark/multiscale-studies/"
    "rkb-multiscale-ridge-usable-grid-development-v3"
)
SELECTION_GATES = {
    "maximumUsablePassToFailRate": 0.005,
    "maximumDownbeatFailureRateIncrease": 0.005,
}
OUTER_GATES = {
    "minimumPositiveFoldCount": 4,
    "minimumMacroNetUsableGridAccuracyDeltaRate": 0.001,
    "minimumWorstFoldNetUsableGridAccuracyDeltaRate": -0.0025,
    "maximumWorstFoldUsablePassToFailRate": 0.005,
    "maximumWorstFoldDownbeatFailureRateIncrease": 0.005,
}


def _configure_utf8_stdio() -> None:
    try:
        import sys

        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _usable_flags(raw: dict[str, Any], truth: dict[str, Any]) -> dict[str, Any]:
    assessment = assess_usable_grid(
        result_bpm=float(raw["bpm"]),
        result_first_beat_timeline_ms=float(raw["timelineFirstBeatMs"]),
        result_downbeat_beat_offset=int(raw["downbeatBeatOffset"]),
        truth=truth,
    )
    category = "pass" if assessment["usablePass"] else str(assessment["strictCategory"])
    return {
        "category": category,
        "usableCategory": str(assessment["usableCategory"]),
        "usablePass": bool(assessment["usablePass"]),
        "octaveEquivalentLinesPass": bool(assessment["octaveEquivalentLinesPass"]),
        "strictCategory": str(assessment["strictCategory"]),
        "strictBpmDriftFailure": bool(assessment["strictBpmDriftFailure"]),
        "downbeatFailure": bool(assessment["downbeatFailure"]),
        "tempoRatio": float(assessment["tempoRatio"]),
        "tempoRelation": str(assessment["tempoRelation"]),
        "bpm": float(raw["bpm"]),
        "timelineFirstBeatMs": float(raw["timelineFirstBeatMs"]),
        "downbeatBeatOffset": int(raw["downbeatBeatOffset"]) % 4,
    }


def _corrected_cache_key(
    *,
    source_row_path: Path,
    source_row: dict[str, Any],
    benchmark_sha256: str,
    truth: dict[str, Any],
) -> str:
    return sha256_json(
        {
            "version": CORRECTED_ROW_VERSION,
            "policyVersion": USABLE_GRID_POLICY_VERSION,
            "sourceRowPath": str(source_row_path.resolve()).replace("\\", "/"),
            "sourceRowFileSha256": sha256_file(source_row_path),
            "sourceRowCacheKey": source_row.get("cacheKey"),
            "benchmarkSha256": benchmark_sha256,
            "instanceId": truth.get("instanceId"),
            "truthBpm": truth.get("bpm"),
            "truthFirstBeatMs": truth.get("firstBeatMs"),
            "truthBarBeatOffset": truth.get("barBeatOffset", truth.get("downbeatBeatOffset")),
        }
    )


def _build_corrected_row(
    *,
    truth: dict[str, Any],
    benchmark_track: dict[str, Any],
    source_row_cache_dir: Path,
    corrected_row_cache_dir: Path,
    benchmark_sha256: str,
) -> dict[str, Any]:
    instance_id = str(truth["instanceId"])
    source_row_path = _row_path(source_row_cache_dir, instance_id)
    source_row = read_json_object(source_row_path)
    cache_key = _corrected_cache_key(
        source_row_path=source_row_path,
        source_row=source_row,
        benchmark_sha256=benchmark_sha256,
        truth=truth,
    )
    corrected_path = _row_path(corrected_row_cache_dir, instance_id)
    if corrected_path.is_file():
        cached = read_json_object(corrected_path)
        if cached.get("cacheKey") == cache_key:
            return cached

    analysis_payload = benchmark_track.get("analysis")
    if not isinstance(analysis_payload, dict):
        raise RuntimeError(f"benchmark analysis is missing: {instance_id}")
    analysis = normalize_bridge_result(analysis_payload)
    time_basis = truth.get("timeBasis")
    if not isinstance(time_basis, dict):
        benchmark_truth = benchmark_track.get("truth")
        time_basis = (
            benchmark_truth.get("timeBasis")
            if isinstance(benchmark_truth, dict)
            and isinstance(benchmark_truth.get("timeBasis"), dict)
            else {"offsetMs": 0.0}
        )
    enriched_truth = {**truth, "timeBasis": time_basis}
    timeline_offset_ms = float(time_basis.get("offsetMs") or 0.0)
    baseline_raw = _raw_result(
        analysis=analysis,
        candidate_rank=None,
        timeline_offset_ms=timeline_offset_ms,
    )
    baseline = {
        **_usable_flags(baseline_raw, enriched_truth),
        "isLegacySelected": bool(source_row["baseline"]["isLegacySelected"]),
    }
    feature_names = source_row.get("featureNames") or {}
    base_names = list(feature_names.get("base") or [])
    try:
        bpm_index = base_names.index("bpm")
    except ValueError as error:
        raise RuntimeError(f"source row has no BPM feature: {instance_id}") from error
    corrected_candidates: list[dict[str, Any]] = []
    for source_candidate in source_row.get("candidates") or []:
        candidate_rank = int(source_candidate["rank"])
        raw = _raw_result(
            analysis=analysis,
            candidate_rank=candidate_rank,
            timeline_offset_ms=timeline_offset_ms,
        )
        vector_bpm = float(source_candidate["baseVector"][bpm_index])
        if abs(vector_bpm - float(raw["bpm"])) > 1e-6:
            raise RuntimeError(
                f"source candidate rank/BPM drifted: {instance_id}:{candidate_rank}:"
                f"{vector_bpm}!={raw['bpm']}"
            )
        corrected_candidates.append(
            {
                **source_candidate,
                **_usable_flags(raw, enriched_truth),
            }
        )
    row = {
        "schemaVersion": 1,
        "type": CORRECTED_ROW_VERSION,
        "cacheKey": cache_key,
        "instanceId": instance_id,
        "batchId": str(truth.get("batchId") or ""),
        "fileName": str(truth.get("fileName") or benchmark_track.get("fileName") or ""),
        "title": str(truth.get("title") or benchmark_track.get("title") or ""),
        "artist": str(truth.get("artist") or benchmark_track.get("artist") or ""),
        "sourcePath": str(truth.get("sourcePath") or ""),
        "truth": {
            "bpm": float(enriched_truth["bpm"]),
            "firstBeatMs": float(enriched_truth["firstBeatMs"]),
            "downbeatBeatOffset": int(
                enriched_truth.get("downbeatBeatOffset", enriched_truth.get("barBeatOffset"))
            )
            % 4,
        },
        "baseline": baseline,
        "featureNames": feature_names,
        "candidates": corrected_candidates,
    }
    _atomic_write_json(corrected_path, row)
    return row


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
        counters["baselineUsablePass"] += int(baseline["category"] == "pass")
        counters["selectedUsablePass"] += int(selected["category"] == "pass")
        counters["usableFailToPass"] += int(
            baseline["category"] != "pass" and selected["category"] == "pass"
        )
        counters["usablePassToFail"] += int(
            baseline["category"] == "pass" and selected["category"] != "pass"
        )
        counters["baselineStrictBpmDriftFailure"] += int(baseline["strictBpmDriftFailure"])
        counters["selectedStrictBpmDriftFailure"] += int(selected["strictBpmDriftFailure"])
        counters["baselineDownbeatFailure"] += int(baseline["downbeatFailure"])
        counters["selectedDownbeatFailure"] += int(selected["downbeatFailure"])
        counters["switchCount"] += int(switched)
        migrations[f"{baseline['usableCategory']}->{selected['usableCategory']}"] += 1
    total = max(1, counters["trackCount"])
    return {
        **dict(counters),
        "baselineUsableGridAccuracy": round(counters["baselineUsablePass"] / total, 9),
        "selectedUsableGridAccuracy": round(counters["selectedUsablePass"] / total, 9),
        "netUsableGridAccuracyDeltaRate": round(
            (counters["selectedUsablePass"] - counters["baselineUsablePass"]) / total, 9
        ),
        "usablePassToFailRate": round(counters["usablePassToFail"] / total, 9),
        "strictBpmDriftFailureRateIncrease": round(
            (
                counters["selectedStrictBpmDriftFailure"]
                - counters["baselineStrictBpmDriftFailure"]
            )
            / total,
            9,
        ),
        "downbeatFailureRateIncrease": round(
            (counters["selectedDownbeatFailure"] - counters["baselineDownbeatFailure"])
            / total,
            9,
        ),
        "usableCategoryMigration": dict(sorted(migrations.items())),
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
    values = list(by_batch.values())
    safe = all(
        item["usablePassToFailRate"] <= SELECTION_GATES["maximumUsablePassToFailRate"]
        and item["downbeatFailureRateIncrease"]
        <= SELECTION_GATES["maximumDownbeatFailureRateIncrease"]
        for item in values
    )
    return {
        "safe": safe,
        "macroNetUsableGridAccuracyDeltaRate": round(
            float(np.mean([item["netUsableGridAccuracyDeltaRate"] for item in values])), 9
        ),
        "worstBatchNetUsableGridAccuracyDeltaRate": min(
            item["netUsableGridAccuracyDeltaRate"] for item in values
        ),
        "netUsablePassDelta": sum(
            item["selectedUsablePass"] - item["baselineUsablePass"] for item in values
        ),
        "usablePassToFailCount": sum(item["usablePassToFail"] for item in values),
        "byBatch": by_batch,
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
                "macroNetUsableGridAccuracyDeltaRate": 0.0,
                "worstBatchNetUsableGridAccuracyDeltaRate": 0.0,
                "netUsablePassDelta": 0,
                "usablePassToFailCount": 0,
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
            float(item["tune"]["macroNetUsableGridAccuracyDeltaRate"]),
            float(item["tune"]["worstBatchNetUsableGridAccuracyDeltaRate"]),
            int(item["tune"]["netUsablePassDelta"]),
            -int(item["tune"]["usablePassToFailCount"]),
            -int(item["complexityRank"]),
            str(item["configId"]),
        ),
    )
    ranking = sorted(
        configs,
        key=lambda item: (
            not bool(item["tune"]["safe"]),
            -float(item["tune"]["macroNetUsableGridAccuracyDeltaRate"]),
            -float(item["tune"]["worstBatchNetUsableGridAccuracyDeltaRate"]),
            -int(item["tune"]["netUsablePassDelta"]),
            int(item["tune"]["usablePassToFailCount"]),
            int(item["complexityRank"]),
            str(item["configId"]),
        ),
    )
    return selected, ranking, models


def _decision_changes(
    rows: list[dict[str, Any]], *, mode: str, threshold: float, config_id: str
) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for row in rows:
        baseline = row["baseline"]
        selected = baseline
        if baseline["isLegacySelected"]:
            candidate = _select_candidate(row, mode)
            if candidate is not None and float(candidate.get("rankerScore") or -999.0) >= threshold:
                selected = candidate
        if baseline["usableCategory"] == selected["usableCategory"]:
            continue
        changes.append(
            {
                "instanceId": row["instanceId"],
                "batchId": row["batchId"],
                "fileName": row["fileName"],
                "title": row["title"],
                "artist": row["artist"],
                "sourcePath": row["sourcePath"],
                "truth": row["truth"],
                "configId": config_id,
                "threshold": threshold,
                "baseline": {
                    key: baseline[key]
                    for key in (
                        "usableCategory",
                        "bpm",
                        "timelineFirstBeatMs",
                        "downbeatBeatOffset",
                        "downbeatFailure",
                    )
                },
                "selected": {
                    **{
                        key: selected[key]
                        for key in (
                            "usableCategory",
                            "bpm",
                            "timelineFirstBeatMs",
                            "downbeatBeatOffset",
                            "downbeatFailure",
                            "tempoRatio",
                            "tempoRelation",
                        )
                    },
                    "rank": selected.get("rank"),
                    "rankerScore": selected.get("rankerScore"),
                },
            }
        )
    return changes


def run_study(args: argparse.Namespace) -> dict[str, Any]:
    split_path = Path(args.splits).resolve()
    fold_plan_path = Path(args.fold_plan).resolve()
    source_row_cache_dir = Path(args.source_row_cache_dir).resolve()
    work_dir = Path(args.work_dir).resolve()
    corrected_row_cache_dir = work_dir / "corrected-row-cache"
    split = read_json_object(split_path)
    fold_plan = read_json_object(fold_plan_path)
    folds = fold_plan.get("primaryFolds")
    primary_ids = [str(item) for item in fold_plan.get("primaryBatchIds") or []]
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
    row_paths: dict[str, Path] = {}
    processed_count = 0
    started_at = time.time()
    for batch_id in primary_ids:
        benchmark_path = Path(DEFAULT_BENCHMARKS[batch_id]).resolve()
        benchmark_sha256 = sha256_file(benchmark_path)
        truths_by_name = {
            normalize_name(str(track.get("fileName") or "")): track
            for track in catalog.values()
            if str(track.get("batchId") or "") == batch_id
        }
        seen_names: set[str] = set()
        for benchmark_track in iter_benchmark_tracks(benchmark_path):
            name_key = normalize_name(str(benchmark_track.get("fileName") or ""))
            truth = truths_by_name.get(name_key)
            if truth is None:
                continue
            row = _build_corrected_row(
                truth=truth,
                benchmark_track=benchmark_track,
                source_row_cache_dir=source_row_cache_dir,
                corrected_row_cache_dir=corrected_row_cache_dir,
                benchmark_sha256=benchmark_sha256,
            )
            instance_id = str(row["instanceId"])
            row_paths[instance_id.casefold()] = _row_path(corrected_row_cache_dir, instance_id)
            seen_names.add(name_key)
            processed_count += 1
            if processed_count % 50 == 0 or processed_count == len(all_instance_ids):
                print(f"[corrected rows {processed_count}/{len(all_instance_ids)}]", flush=True)
        missing_names = set(truths_by_name) - seen_names
        if missing_names:
            raise RuntimeError(f"benchmark misses truth roster: {batch_id}:{sorted(missing_names)[0]}")
    if set(row_paths) != {item.casefold() for item in all_instance_ids}:
        raise RuntimeError("corrected row cache does not cover the canonical primary roster")

    def load_rows(instance_ids: list[str]) -> list[dict[str, Any]]:
        return [read_json_object(row_paths[str(item).casefold()]) for item in instance_ids]

    fold_reports: list[dict[str, Any]] = []
    all_changes: list[dict[str, Any]] = []
    for fold_index, fold in enumerate(folds, start=1):
        batch_id = str(fold["batchId"])
        train_rows = load_rows(fold["effectiveDevelopmentTrain"])
        tune_rows = load_rows(fold["effectiveDevelopmentTune"])
        outer_rows = load_rows(fold["outerHoldout"])
        selected, ranking, models = _choose_fold_config(train_rows, tune_rows)
        if selected["family"] == "baseline":
            outer_metrics = _metrics(outer_rows, mode="ranked-top16", threshold=999.0)
            selected_model = None
            changes: list[dict[str, Any]] = []
        else:
            selected_model = models[str(selected["modelId"])]
            _score_candidates(outer_rows, selected_model)
            mode = str(selected["mode"])
            threshold = float(selected["threshold"])
            outer_metrics = _metrics(outer_rows, mode=mode, threshold=threshold)
            changes = _decision_changes(
                outer_rows,
                mode=mode,
                threshold=threshold,
                config_id=str(selected["configId"]),
            )
        fold_dir = work_dir / "folds" / batch_id
        fold_payload = {
            "schemaVersion": 1,
            "type": "rkb-multiscale-usable-grid-development-fold",
            "studyVersion": STUDY_VERSION,
            "batchId": batch_id,
            "selectedConfig": selected,
            "selectedModel": _model_json(selected_model) if selected_model is not None else None,
            "tuneRanking": ranking,
            "outerMetrics": outer_metrics,
            "decisionChanges": changes,
        }
        _atomic_write_json(fold_dir / "result.json", fold_payload)
        all_changes.extend(changes)
        fold_reports.append(
            {
                "batchId": batch_id,
                "selectedConfigId": str(selected["configId"]),
                "selectedFamily": str(selected["family"]),
                "outerMetrics": outer_metrics,
                "decisionChangeCount": len(changes),
                "resultPath": str((fold_dir / "result.json").resolve()).replace("\\", "/"),
            }
        )
        print(
            f"[fold {fold_index}/6] {batch_id} selected={selected['configId']} "
            f"net={outer_metrics['netUsableGridAccuracyDeltaRate']}",
            flush=True,
        )

    deltas = [float(item["outerMetrics"]["netUsableGridAccuracyDeltaRate"]) for item in fold_reports]
    positive = sum(value > 0.0 for value in deltas)
    neutral = sum(value == 0.0 for value in deltas)
    macro_delta = round(float(np.mean(deltas)), 9)
    worst_delta = min(deltas)
    worst_pass_to_fail = max(
        float(item["outerMetrics"]["usablePassToFailRate"]) for item in fold_reports
    )
    worst_downbeat = max(
        float(item["outerMetrics"]["downbeatFailureRateIncrease"]) for item in fold_reports
    )
    gates = {
        "minimumPositiveFoldCount": positive >= OUTER_GATES["minimumPositiveFoldCount"],
        "minimumMacroNetUsableGridAccuracyDeltaRate": macro_delta
        >= OUTER_GATES["minimumMacroNetUsableGridAccuracyDeltaRate"],
        "minimumWorstFoldNetUsableGridAccuracyDeltaRate": worst_delta
        >= OUTER_GATES["minimumWorstFoldNetUsableGridAccuracyDeltaRate"],
        "maximumWorstFoldUsablePassToFailRate": worst_pass_to_fail
        <= OUTER_GATES["maximumWorstFoldUsablePassToFailRate"],
        "maximumWorstFoldDownbeatFailureRateIncrease": worst_downbeat
        <= OUTER_GATES["maximumWorstFoldDownbeatFailureRateIncrease"],
    }
    report = {
        "schemaVersion": 1,
        "type": "rkb-multiscale-usable-grid-development-report",
        "studyVersion": STUDY_VERSION,
        "developmentDiagnosticOnly": True,
        "postHocAfterV2": True,
        "freshProofEligible": False,
        "parameterSelectionAllowedAfterOuter": False,
        "inputs": {
            "splitPath": str(split_path).replace("\\", "/"),
            "splitSha256": sha256_file(split_path),
            "foldPlanPath": str(fold_plan_path).replace("\\", "/"),
            "foldPlanSha256": sha256_file(fold_plan_path),
            "sourceRowCacheDir": str(source_row_cache_dir).replace("\\", "/"),
        },
        "policy": {
            "acceptanceVersion": USABLE_GRID_POLICY_VERSION,
            "correctedRowVersion": CORRECTED_ROW_VERSION,
            "acceptedTempoRelations": ["same-bpm", "half-bpm", "double-bpm"],
            "exactBpmMetricRole": "diagnostic-only",
            "downbeatMetricRole": "separate-safety-gate",
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
            "negativeFoldCount": 6 - positive - neutral,
            "macroNetUsableGridAccuracyDeltaRate": macro_delta,
            "worstFoldNetUsableGridAccuracyDeltaRate": worst_delta,
            "worstFoldUsablePassToFailRate": worst_pass_to_fail,
            "worstFoldDownbeatFailureRateIncrease": worst_downbeat,
            "netUsablePassDelta": sum(
                item["outerMetrics"]["selectedUsablePass"]
                - item["outerMetrics"]["baselineUsablePass"]
                for item in fold_reports
            ),
            "usablePassToFailCount": sum(
                item["outerMetrics"]["usablePassToFail"] for item in fold_reports
            ),
            "selectedFamilyCounts": dict(
                Counter(item["selectedFamily"] for item in fold_reports)
            ),
            "gates": gates,
            "passed": all(gates.values()),
        },
        "folds": fold_reports,
        "artifacts": {
            "correctedRowCacheDir": str(corrected_row_cache_dir.resolve()).replace("\\", "/"),
            "decisionChangesPath": str((work_dir / "decision-changes.json").resolve()).replace(
                "\\", "/"
            ),
        },
        "summary": {
            "trackCount": len(all_instance_ids),
            "decisionChangeCount": len(all_changes),
            "elapsedSec": round(time.time() - started_at, 3),
        },
    }
    report["reportSha256"] = sha256_json(report)
    _atomic_write_json(work_dir / "decision-changes.json", all_changes)
    _atomic_write_json(work_dir / "report.json", report)
    return report


def main() -> int:
    _configure_utf8_stdio()
    parser = argparse.ArgumentParser(
        description="Train and evaluate multiscale ridge with corrected usable-grid labels"
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
    parser.add_argument("--source-row-cache-dir", default=DEFAULT_SOURCE_ROW_CACHE_DIR)
    parser.add_argument("--work-dir", default=DEFAULT_WORK_DIR)
    args = parser.parse_args()
    report = run_study(args)
    print(json.dumps({"aggregate": report["aggregate"], "summary": report["summary"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
