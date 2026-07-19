import argparse
import json
import math
import time
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from rkb_beatgrid_lab_common import (
    atomic_write_json,
    build_feature_index_map,
    resolve_feature_entry,
)
from rkb_dataset_contract import sha256_file, sha256_json
from rkb_multiscale_study_inputs import DEFAULT_BENCHMARKS, iter_benchmark_tracks
from rkb_nested_lobo_contract import read_json_object
from rkb_official_phase_selector import HIGH_ATTACK_VERSION, SELECTOR_VERSION, candidate_phase_evidence
from rkb_official_phase_selector_diagnostic import (
    FEATURE_CACHE_ROOT,
    _candidate_assessment,
    _database_root_from_env,
    _load_track_features,
    _selected_grid,
)


STUDY_VERSION = "rkb-official-phase-switch-nested-lobo-v1"
DEFAULT_FOLD_PLAN = Path(
    "grid-analysis-lab/rkb-rekordbox-benchmark/nested-lobo/"
    "rkb-primary-nested-lobo-v2-groot/fold-plan.json"
)
DEFAULT_SPLIT = Path("grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-splits-current.json")
DEFAULT_HIGH_ATTACK_CACHE = Path(
    "grid-analysis-lab/rkb-rekordbox-benchmark/official-phase-high-attack-cache"
)
DEFAULT_OUTPUT = Path(
    "grid-analysis-lab/rkb-rekordbox-benchmark/official-phase-selector-nested-lobo-latest.json"
)
L2_GRID = (0.1, 1.0, 10.0)
THRESHOLD_GRID = (0.50, 0.60, 0.70, 0.80, 0.90)
SELECTION_GATES = {
    "maximumPassToFailRate": 0.005,
    "maximumDownbeatFailureRateIncrease": 0.005,
    "maximumStrictBpmDriftFailureRateIncrease": 0.0,
    "minimumWorstBatchNetStrictAccuracyDeltaRate": 0.0,
}
OUTER_GATES = {
    "minimumPositiveFoldCount": 4,
    "minimumMacroNetStrictAccuracyDeltaRate": 0.001,
    "minimumWorstFoldNetStrictAccuracyDeltaRate": -0.0025,
    "maximumWorstFoldPassToFailRate": 0.005,
    "maximumWorstFoldDownbeatFailureRateIncrease": 0.005,
    "maximumWorstFoldStrictBpmDriftFailureRateIncrease": 0.0,
}
FEATURE_NAMES = (
    "absShiftMs",
    "evidenceScore",
    "selectedEnergy",
    "selectedDynamicRange",
    "validMod4Fraction",
    "sustainedRisingEdge",
    "argmaxShapeDeltaAbsMs",
    "legacyFallback",
    "gridSolverScore",
    "qualityScore",
    "anchorConfidenceScore",
    "anchorCorrectionAbsMs",
    "overallSupportRatio",
)


def _finite_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric if math.isfinite(numeric) else default


def _feature_vector(analysis: dict[str, Any], evidence: dict[str, Any]) -> list[float]:
    overall = evidence.get("overall") if isinstance(evidence.get("overall"), dict) else {}
    shift_ms = _finite_float(evidence.get("overallShiftMs"))
    argmax_shift_ms = _finite_float(evidence.get("argmaxShiftMs"))
    source = str(analysis.get("gridSolverSelectedSource") or "")
    return [
        abs(shift_ms),
        _finite_float(evidence.get("evidenceScore")),
        _finite_float(evidence.get("selectedEnergy")),
        _finite_float(evidence.get("selectedDynamicRange")),
        min(1.0, _finite_float(evidence.get("validMod4Count")) / 4.0),
        1.0 if overall.get("reason") == "sustained-rising-edge" else 0.0,
        abs(argmax_shift_ms - shift_ms),
        1.0 if "legacy-fallback" in source else 0.0,
        _finite_float(analysis.get("gridSolverScore")),
        _finite_float(analysis.get("qualityScore")),
        _finite_float(analysis.get("anchorConfidenceScore")),
        abs(_finite_float(analysis.get("anchorCorrectionMs"))),
        min(1.0, _finite_float(evidence.get("overallSupport")) / 256.0),
    ]


def _build_rows(
    *,
    high_attack_cache_root: Path,
    database_root: Path | None,
    isolation_by_instance: dict[str, str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    batch_counts: Counter[str] = Counter()
    started_at = time.time()
    for batch_id, benchmark_relative in DEFAULT_BENCHMARKS.items():
        if batch_id not in {"current1407", "blind608", "old377", "test316", "test327", "test353"}:
            continue
        benchmark_path = Path(benchmark_relative)
        cache_dir = FEATURE_CACHE_ROOT / batch_id
        index_map = build_feature_index_map(cache_dir)
        for track_index, track in enumerate(iter_benchmark_tracks(benchmark_path), start=1):
            entry = resolve_feature_entry(track=track, index_map=index_map)
            selected = _selected_grid(track)
            truth = track.get("truth") if isinstance(track.get("truth"), dict) else {}
            if entry is None or selected is None or not truth:
                skipped[f"{batch_id}:invalid-track-or-identity"] += 1
                continue
            instance_id = str(entry.get("instanceId") or "").strip()
            isolation_family_id = isolation_by_instance.get(instance_id.casefold(), "")
            if not instance_id or not isolation_family_id:
                skipped[f"{batch_id}:weak-identity"] += 1
                continue
            loaded = _load_track_features(
                track=track,
                cache_dir=cache_dir,
                index_map=index_map,
                signal_mode="high-attack",
                high_attack_cache_dir=high_attack_cache_root / batch_id,
                database_root=database_root,
            )
            if loaded is None:
                skipped[f"{batch_id}:missing-high-attack"] += 1
                continue
            _, values, frame_rate = loaded
            analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
            duration_sec = min(float(selected["durationSec"]), float(values.size) / frame_rate)
            evidence = candidate_phase_evidence(
                values,
                frame_rate=frame_rate,
                bpm=float(selected["bpm"]),
                first_beat_ms=float(selected["firstBeatMs"]),
                duration_sec=duration_sec,
            )
            if not evidence.get("valid"):
                skipped[f"{batch_id}:invalid-evidence"] += 1
                continue
            baseline = _candidate_assessment(
                bpm=float(selected["bpm"]),
                first_beat_ms=float(selected["firstBeatMs"]),
                downbeat_offset=int(selected["downbeatOffset"]),
                truth=truth,
            )
            refined_phase_ms = float(selected["firstBeatMs"]) + float(evidence.get("overallShiftMs") or 0.0)
            refined = _candidate_assessment(
                bpm=float(selected["bpm"]),
                first_beat_ms=refined_phase_ms,
                downbeat_offset=int(selected["downbeatOffset"]),
                truth=truth,
            )
            rows.append(
                {
                    "instanceId": instance_id,
                    "batchId": batch_id,
                    "isolationFamilyId": isolation_family_id,
                    "fileName": str(track.get("fileName") or ""),
                    "featureNames": list(FEATURE_NAMES),
                    "featureVector": _feature_vector(analysis, evidence),
                    "baseline": {
                        "strictPass": bool(baseline["strictPass"]),
                        "usablePass": bool(baseline["usablePass"]),
                        "category": str(baseline["strictCategory"]),
                        "downbeatFailure": bool(baseline["downbeatFailure"]),
                        "strictBpmDriftFailure": bool(baseline["strictBpmDriftFailure"]),
                    },
                    "refined": {
                        "strictPass": bool(refined["strictPass"]),
                        "usablePass": bool(refined["usablePass"]),
                        "category": str(refined["strictCategory"]),
                        "downbeatFailure": bool(refined["downbeatFailure"]),
                        "strictBpmDriftFailure": bool(refined["strictBpmDriftFailure"]),
                    },
                    "diagnostic": {
                        "shiftMs": round(float(evidence.get("overallShiftMs") or 0.0), 6),
                        "evidenceScore": round(float(evidence.get("evidenceScore") or 0.0), 6),
                    },
                }
            )
            batch_counts[batch_id] += 1
            if track_index % 250 == 0:
                print(f"[rows {batch_id}] processed={track_index}", flush=True)
    rows.sort(key=lambda item: str(item["instanceId"]).casefold())
    instance_ids = [str(row["instanceId"]).casefold() for row in rows]
    if len(instance_ids) != len(set(instance_ids)):
        raise RuntimeError("selector rows contain duplicate instanceId")
    return rows, {
        "trackCount": len(rows),
        "batchCounts": dict(sorted(batch_counts.items())),
        "skipped": dict(sorted(skipped.items())),
        "elapsedSec": round(time.time() - started_at, 3),
    }


def _fit_ridge(rows: list[dict[str, Any]], l2: float) -> dict[str, Any]:
    decisive = [
        row
        for row in rows
        if bool(row["baseline"]["strictPass"]) != bool(row["refined"]["strictPass"])
    ]
    if not decisive:
        raise RuntimeError("selector training fold has no decisive rows")
    X = np.asarray([row["featureVector"] for row in decisive], dtype="float64")
    y = np.asarray([1.0 if row["refined"]["strictPass"] else 0.0 for row in decisive], dtype="float64")
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
        "l2": float(l2),
        "bias": bias,
        "mean": mean,
        "std": std,
        "weights": weights,
        "featureNames": list(FEATURE_NAMES),
        "trainTrackCount": len(rows),
        "trainDecisiveCount": len(decisive),
        "trainPositiveCount": int(np.sum(y)),
        "trainNegativeCount": int(y.size - np.sum(y)),
    }


def _score_rows(rows: list[dict[str, Any]], model: dict[str, Any]) -> np.ndarray:
    if not rows:
        return np.asarray([], dtype="float64")
    X = np.asarray([row["featureVector"] for row in rows], dtype="float64")
    Xs = np.clip((X - model["mean"]) / model["std"], -8.0, 8.0)
    return Xs @ model["weights"] + float(model["bias"])


def _metrics(rows: list[dict[str, Any]], scores: np.ndarray, threshold: float) -> dict[str, Any]:
    counters: Counter[str] = Counter()
    migrations: Counter[str] = Counter()
    for row, score in zip(rows, scores, strict=False):
        baseline = row["baseline"]
        selected = row["refined"] if float(score) >= threshold else baseline
        switched = selected is row["refined"]
        counters["trackCount"] += 1
        counters["baselinePass"] += int(bool(baseline["strictPass"]))
        counters["selectedPass"] += int(bool(selected["strictPass"]))
        counters["baselineUsablePass"] += int(bool(baseline["usablePass"]))
        counters["selectedUsablePass"] += int(bool(selected["usablePass"]))
        counters["failToPass"] += int(not baseline["strictPass"] and selected["strictPass"])
        counters["passToFail"] += int(baseline["strictPass"] and not selected["strictPass"])
        counters["usableFailToPass"] += int(not baseline["usablePass"] and selected["usablePass"])
        counters["usablePassToFail"] += int(baseline["usablePass"] and not selected["usablePass"])
        counters["baselineDownbeatFailure"] += int(bool(baseline["downbeatFailure"]))
        counters["selectedDownbeatFailure"] += int(bool(selected["downbeatFailure"]))
        counters["baselineStrictBpmDriftFailure"] += int(bool(baseline["strictBpmDriftFailure"]))
        counters["selectedStrictBpmDriftFailure"] += int(bool(selected["strictBpmDriftFailure"]))
        counters["switchCount"] += int(switched)
        migrations[f"{baseline['category']}->{selected['category']}"] += 1
    total = max(1, counters["trackCount"])
    return {
        **dict(counters),
        "baselineStrictAccuracy": round(counters["baselinePass"] / total, 9),
        "selectedStrictAccuracy": round(counters["selectedPass"] / total, 9),
        "netStrictAccuracyDeltaRate": round(
            (counters["selectedPass"] - counters["baselinePass"]) / total,
            9,
        ),
        "baselineUsableGridAccuracy": round(counters["baselineUsablePass"] / total, 9),
        "selectedUsableGridAccuracy": round(counters["selectedUsablePass"] / total, 9),
        "netUsableGridAccuracyDeltaRate": round(
            (counters["selectedUsablePass"] - counters["baselineUsablePass"]) / total,
            9,
        ),
        "passToFailRate": round(counters["passToFail"] / total, 9),
        "downbeatFailureRateIncrease": round(
            (counters["selectedDownbeatFailure"] - counters["baselineDownbeatFailure"]) / total,
            9,
        ),
        "strictBpmDriftFailureRateIncrease": round(
            (
                counters["selectedStrictBpmDriftFailure"]
                - counters["baselineStrictBpmDriftFailure"]
            )
            / total,
            9,
        ),
        "categoryMigration": dict(sorted(migrations.items())),
    }


def _group_by_batch(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row["batchId"]), []).append(row)
    return grouped


def _tune_metrics(rows: list[dict[str, Any]], scores: np.ndarray, threshold: float) -> dict[str, Any]:
    score_map = {str(row["instanceId"]).casefold(): float(score) for row, score in zip(rows, scores, strict=False)}
    by_batch: dict[str, Any] = {}
    for batch_id, batch_rows in sorted(_group_by_batch(rows).items()):
        batch_scores = np.asarray(
            [score_map[str(row["instanceId"]).casefold()] for row in batch_rows],
            dtype="float64",
        )
        by_batch[batch_id] = _metrics(batch_rows, batch_scores, threshold)
    values = list(by_batch.values())
    safe = all(
        item["passToFailRate"] <= SELECTION_GATES["maximumPassToFailRate"]
        and item["downbeatFailureRateIncrease"]
        <= SELECTION_GATES["maximumDownbeatFailureRateIncrease"]
        and item["strictBpmDriftFailureRateIncrease"]
        <= SELECTION_GATES["maximumStrictBpmDriftFailureRateIncrease"]
        for item in values
    )
    worst_net = min(item["netStrictAccuracyDeltaRate"] for item in values)
    safe = safe and worst_net >= SELECTION_GATES["minimumWorstBatchNetStrictAccuracyDeltaRate"]
    return {
        "safe": safe,
        "macroNetStrictAccuracyDeltaRate": round(
            float(np.mean([item["netStrictAccuracyDeltaRate"] for item in values])),
            9,
        ),
        "worstBatchNetStrictAccuracyDeltaRate": worst_net,
        "netPassDelta": sum(item["selectedPass"] - item["baselinePass"] for item in values),
        "passToFailCount": sum(item["passToFail"] for item in values),
        "byBatch": by_batch,
    }


def _model_json(model: dict[str, Any]) -> dict[str, Any]:
    return {
        "l2": model["l2"],
        "bias": round(float(model["bias"]), 12),
        "mean": [round(float(value), 12) for value in model["mean"]],
        "std": [round(float(value), 12) for value in model["std"]],
        "weights": [round(float(value), 12) for value in model["weights"]],
        "featureNames": model["featureNames"],
        "trainTrackCount": model["trainTrackCount"],
        "trainDecisiveCount": model["trainDecisiveCount"],
        "trainPositiveCount": model["trainPositiveCount"],
        "trainNegativeCount": model["trainNegativeCount"],
    }


def run_study(args: argparse.Namespace) -> dict[str, Any]:
    fold_plan_path = Path(args.fold_plan).resolve()
    fold_plan = read_json_object(fold_plan_path)
    split_path = Path(args.splits).resolve()
    split = read_json_object(split_path)
    isolation_by_instance = {
        str(item.get("instanceId") or "").casefold(): str(item.get("isolationFamilyId") or "")
        for item in split.get("instances") or []
        if isinstance(item, dict)
    }
    database_root = _database_root_from_env()
    rows, row_summary = _build_rows(
        high_attack_cache_root=Path(args.high_attack_cache_dir).resolve(),
        database_root=database_root,
        isolation_by_instance=isolation_by_instance,
    )
    row_map = {str(row["instanceId"]).casefold(): row for row in rows}

    def load_rows(instance_ids: list[str]) -> list[dict[str, Any]]:
        missing = [instance_id for instance_id in instance_ids if instance_id.casefold() not in row_map]
        if missing:
            raise RuntimeError(f"selector row cache misses instance: {missing[0]}")
        return [row_map[instance_id.casefold()] for instance_id in instance_ids]

    fold_reports: list[dict[str, Any]] = []
    for fold_index, fold in enumerate(fold_plan.get("primaryFolds") or [], start=1):
        batch_id = str(fold.get("batchId") or "")
        train_rows = load_rows(list(fold.get("effectiveDevelopmentTrain") or []))
        tune_rows = load_rows(list(fold.get("effectiveDevelopmentTune") or []))
        outer_rows = load_rows(list(fold.get("outerHoldout") or []))
        configs: list[dict[str, Any]] = [
            {
                "configId": "baseline-no-op",
                "l2": None,
                "threshold": None,
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
        models: dict[float, dict[str, Any]] = {}
        for l2 in L2_GRID:
            model = _fit_ridge(train_rows, l2)
            models[l2] = model
            tune_scores = _score_rows(tune_rows, model)
            for threshold in THRESHOLD_GRID:
                configs.append(
                    {
                        "configId": f"ridge-l2-{l2:g}-threshold-{threshold:g}",
                        "l2": l2,
                        "threshold": threshold,
                        "tune": _tune_metrics(tune_rows, tune_scores, threshold),
                    }
                )
        eligible = [config for config in configs if config["tune"]["safe"]]
        selected = max(
            eligible,
            key=lambda config: (
                float(config["tune"]["macroNetStrictAccuracyDeltaRate"]),
                float(config["tune"]["worstBatchNetStrictAccuracyDeltaRate"]),
                int(config["tune"]["netPassDelta"]),
                -int(config["tune"]["passToFailCount"]),
                float(config["l2"] or 999.0),
                float(config["threshold"] or 999.0),
            ),
        )
        if selected["configId"] == "baseline-no-op":
            outer_scores = np.full(len(outer_rows), -999.0, dtype="float64")
            outer_metrics = _metrics(outer_rows, outer_scores, 999.0)
            selected_model = None
        else:
            selected_model = models[float(selected["l2"])]
            outer_scores = _score_rows(outer_rows, selected_model)
            outer_metrics = _metrics(outer_rows, outer_scores, float(selected["threshold"]))
        fold_reports.append(
            {
                "batchId": batch_id,
                "selectedConfig": selected,
                "selectedModel": _model_json(selected_model) if selected_model is not None else None,
                "outerMetrics": outer_metrics,
                "trainTrackCount": len(train_rows),
                "tuneTrackCount": len(tune_rows),
                "outerTrackCount": len(outer_rows),
            }
        )
        print(
            f"[fold {fold_index}/6] {batch_id} selected={selected['configId']} "
            f"net={outer_metrics['selectedPass'] - outer_metrics['baselinePass']} "
            f"p2f={outer_metrics['passToFail']}",
            flush=True,
        )

    positive = sum(item["outerMetrics"]["netStrictAccuracyDeltaRate"] > 0.0 for item in fold_reports)
    neutral = sum(item["outerMetrics"]["netStrictAccuracyDeltaRate"] == 0.0 for item in fold_reports)
    negative = len(fold_reports) - positive - neutral
    macro_net = round(
        float(np.mean([item["outerMetrics"]["netStrictAccuracyDeltaRate"] for item in fold_reports])),
        9,
    )
    worst_net = min(item["outerMetrics"]["netStrictAccuracyDeltaRate"] for item in fold_reports)
    worst_p2f = max(item["outerMetrics"]["passToFailRate"] for item in fold_reports)
    worst_downbeat = max(item["outerMetrics"]["downbeatFailureRateIncrease"] for item in fold_reports)
    worst_bpm = max(
        item["outerMetrics"]["strictBpmDriftFailureRateIncrease"] for item in fold_reports
    )
    gates = {
        "minimumPositiveFoldCount": positive >= OUTER_GATES["minimumPositiveFoldCount"],
        "minimumMacroNetStrictAccuracyDeltaRate": macro_net
        >= OUTER_GATES["minimumMacroNetStrictAccuracyDeltaRate"],
        "minimumWorstFoldNetStrictAccuracyDeltaRate": worst_net
        >= OUTER_GATES["minimumWorstFoldNetStrictAccuracyDeltaRate"],
        "maximumWorstFoldPassToFailRate": worst_p2f
        <= OUTER_GATES["maximumWorstFoldPassToFailRate"],
        "maximumWorstFoldDownbeatFailureRateIncrease": worst_downbeat
        <= OUTER_GATES["maximumWorstFoldDownbeatFailureRateIncrease"],
        "maximumWorstFoldStrictBpmDriftFailureRateIncrease": worst_bpm
        <= OUTER_GATES["maximumWorstFoldStrictBpmDriftFailureRateIncrease"],
    }
    return {
        "schemaVersion": 1,
        "type": "rkb-official-phase-switch-nested-lobo-report",
        "studyVersion": STUDY_VERSION,
        "selectorVersion": SELECTOR_VERSION,
        "highAttackVersion": HIGH_ATTACK_VERSION,
        "developmentDiagnosticOnly": True,
        "postHocFeatureFamily": True,
        "freshProofEligible": False,
        "parameterSelectionAllowedAfterOuter": False,
        "inputs": {
            "foldPlanPath": str(fold_plan_path).replace("\\", "/"),
            "foldPlanSha256": sha256_file(fold_plan_path),
            "splitPath": str(split_path).replace("\\", "/"),
            "splitSha256": sha256_file(split_path),
            "benchmarks": DEFAULT_BENCHMARKS,
            "rowSha256": sha256_json(rows),
        },
        "policy": {
            "featureNames": list(FEATURE_NAMES),
            "l2Grid": list(L2_GRID),
            "thresholdGrid": list(THRESHOLD_GRID),
            "selectionGates": SELECTION_GATES,
            "outerGates": OUTER_GATES,
            "trainingRows": "only decisive baseline/refined pass-status changes",
            "abstention": "score below selected threshold preserves baseline grid",
        },
        "rowSummary": row_summary,
        "aggregate": {
            "primaryFoldCount": len(fold_reports),
            "positiveFoldCount": positive,
            "neutralFoldCount": neutral,
            "negativeFoldCount": negative,
            "macroNetStrictAccuracyDeltaRate": macro_net,
            "worstFoldNetStrictAccuracyDeltaRate": worst_net,
            "worstFoldPassToFailRate": worst_p2f,
            "worstFoldDownbeatFailureRateIncrease": worst_downbeat,
            "worstFoldStrictBpmDriftFailureRateIncrease": worst_bpm,
            "netPassDelta": sum(
                item["outerMetrics"]["selectedPass"] - item["outerMetrics"]["baselinePass"]
                for item in fold_reports
            ),
            "passToFailCount": sum(item["outerMetrics"]["passToFail"] for item in fold_reports),
            "failToPassCount": sum(item["outerMetrics"]["failToPass"] for item in fold_reports),
            "gates": gates,
            "passed": all(gates.values()),
        },
        "folds": fold_reports,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a narrow abstaining selector with canonical isolation-safe nested LOBO"
    )
    parser.add_argument("--fold-plan", default=str(DEFAULT_FOLD_PLAN))
    parser.add_argument("--splits", default=str(DEFAULT_SPLIT))
    parser.add_argument("--high-attack-cache-dir", default=str(DEFAULT_HIGH_ATTACK_CACHE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()
    report = run_study(args)
    output_path = Path(args.output)
    atomic_write_json(output_path, report)
    print(json.dumps({"output": str(output_path.resolve()), "aggregate": report["aggregate"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
