import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from rkb_benchmark_bridge_result import normalize_bridge_result
from rkb_dataset_contract import normalize_name, sha256_file, sha256_json
from rkb_grid_acceptance import USABLE_GRID_POLICY_VERSION, assess_usable_grid
from rkb_multiscale_ranker_study import _row_path, _score_candidates, _select_candidate
from rkb_multiscale_study_inputs import DEFAULT_BENCHMARKS, iter_benchmark_tracks
from rkb_nested_lobo_contract import read_json_object
from rkb_nested_lobo_evaluator import load_truth_catalog


REPLAY_VERSION = "rkb-multiscale-v2-usable-grid-frozen-replay-v1"
DEFAULT_STUDY_DIR = (
    "grid-analysis-lab/rkb-rekordbox-benchmark/multiscale-studies/"
    "rkb-multiscale-ridge-nested-development-v2-conservative-thresholds"
)
DEFAULT_ROW_CACHE_DIR = (
    "grid-analysis-lab/rkb-rekordbox-benchmark/multiscale-studies/"
    "rkb-multiscale-ridge-nested-development-v1/row-cache"
)
DEFAULT_OUTPUT_DIR = (
    "grid-analysis-lab/rkb-rekordbox-benchmark/multiscale-studies/"
    "rkb-multiscale-ridge-nested-development-v2-usable-grid-replay"
)


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _source_report_hash(report: dict[str, Any]) -> str:
    payload = {key: value for key, value in report.items() if key != "reportSha256"}
    return sha256_json(payload)


def _raw_result(
    *,
    analysis: dict[str, Any],
    candidate_rank: int | None,
    timeline_offset_ms: float,
) -> dict[str, Any]:
    if candidate_rank is None:
        return {
            "rank": None,
            "bpm": float(analysis["bpm"]),
            "analysisFirstBeatMs": float(analysis["firstBeatMs"]),
            "timelineFirstBeatMs": float(analysis["firstBeatMs"]) + timeline_offset_ms,
            "downbeatBeatOffset": int(analysis["downbeatBeatOffset"]) % 4,
            "source": str(analysis.get("gridSolverSelectedSource") or ""),
        }
    candidates = analysis.get("gridSolverCandidates") or []
    if candidate_rank <= 0 or candidate_rank > len(candidates):
        raise RuntimeError(f"candidate rank is unavailable in frozen analysis: {candidate_rank}")
    candidate = candidates[candidate_rank - 1]
    if not isinstance(candidate, dict):
        raise RuntimeError(f"candidate rank is not an object: {candidate_rank}")
    first_beat_ms = float(candidate.get("firstBeatMs") or 0.0)
    return {
        "rank": candidate_rank,
        "bpm": float(candidate.get("bpm") or 0.0),
        "analysisFirstBeatMs": first_beat_ms,
        "timelineFirstBeatMs": first_beat_ms + timeline_offset_ms,
        "downbeatBeatOffset": int(
            candidate.get("downbeatBeatOffset", candidate.get("barBeatOffset", 0)) or 0
        )
        % 4,
        "source": str(candidate.get("source") or ""),
    }


def _assessment_payload(
    raw: dict[str, Any],
    truth: dict[str, Any],
    *,
    source_flags: dict[str, Any],
) -> dict[str, Any]:
    assessment = assess_usable_grid(
        result_bpm=float(raw["bpm"]),
        result_first_beat_timeline_ms=float(raw["timelineFirstBeatMs"]),
        result_downbeat_beat_offset=int(raw["downbeatBeatOffset"]),
        truth=truth,
    )
    return {
        **raw,
        "sourceStrictCategory": str(source_flags["category"]),
        "sourceStrictPass": source_flags["category"] == "pass",
        "sourceStrictBpmDriftFailure": bool(source_flags["bpmBigError"]),
        "sourceDownbeatFailure": bool(source_flags["downbeatFailure"]),
        "tempoRatio": assessment["tempoRatio"],
        "tempoRelation": assessment["tempoRelation"],
        "normalizationFactor": assessment["normalizationFactor"],
        "normalizedBpm": assessment["normalizedBpm"],
        "strictCategory": assessment["strictCategory"],
        "strictPass": assessment["strictPass"],
        "strictBpmDriftFailure": assessment["strictBpmDriftFailure"],
        "downbeatFailure": assessment["downbeatFailure"],
        "octaveEquivalentLinesPass": assessment["octaveEquivalentLinesPass"],
        "usableCategory": assessment["usableCategory"],
        "usablePass": assessment["usablePass"],
        "normalizedBpmDrift128BeatsMs": assessment["normalizedMetrics"][
            "bpmOnlyDrift128BeatsMs"
        ],
        "normalizedFirstBeatPhaseAbsErrorMs": assessment["normalizedMetrics"][
            "firstBeatPhaseAbsErrorMs"
        ],
        "normalizedGridMaxAbsMs": assessment["normalizedMetrics"]["gridMaxAbsMs"],
    }


def _frozen_selection(
    row: dict[str, Any],
    *,
    selected_config: dict[str, Any],
    selected_model: dict[str, Any] | None,
) -> tuple[dict[str, Any], int | None, bool]:
    baseline = row["baseline"]
    if selected_config["family"] == "baseline" or not baseline["isLegacySelected"]:
        return baseline, None, False
    if selected_model is None:
        raise RuntimeError("non-baseline frozen config has no model")
    _score_candidates([row], selected_model)
    candidate = _select_candidate(row, str(selected_config["mode"]))
    if candidate is None or float(candidate.get("rankerScore") or -999.0) < float(
        selected_config["threshold"]
    ):
        return baseline, None, False
    return candidate, int(candidate["rank"]), True


def _empty_metrics() -> Counter[str]:
    return Counter(
        {
            "trackCount": 0,
            "switchCount": 0,
            "baselineStrictPass": 0,
            "selectedStrictPass": 0,
            "strictFailToPass": 0,
            "strictPassToFail": 0,
            "baselineUsablePass": 0,
            "selectedUsablePass": 0,
            "usableFailToPass": 0,
            "usablePassToFail": 0,
            "baselineStrictBpmDriftFailure": 0,
            "selectedStrictBpmDriftFailure": 0,
            "baselineSourceDownbeatFailure": 0,
            "selectedSourceDownbeatFailure": 0,
            "baselineDownbeatFailure": 0,
            "selectedDownbeatFailure": 0,
        }
    )


def _record_metrics(
    counters: Counter[str],
    baseline: dict[str, Any],
    selected: dict[str, Any],
    *,
    switched: bool,
) -> None:
    counters["trackCount"] += 1
    counters["switchCount"] += int(switched)
    for prefix, payload in (("baseline", baseline), ("selected", selected)):
        counters[f"{prefix}StrictPass"] += int(payload["sourceStrictPass"])
        counters[f"{prefix}UsablePass"] += int(payload["usablePass"])
        counters[f"{prefix}StrictBpmDriftFailure"] += int(
            payload["sourceStrictBpmDriftFailure"]
        )
        counters[f"{prefix}SourceDownbeatFailure"] += int(payload["sourceDownbeatFailure"])
        counters[f"{prefix}DownbeatFailure"] += int(payload["downbeatFailure"])
    counters["strictFailToPass"] += int(
        not baseline["sourceStrictPass"] and selected["sourceStrictPass"]
    )
    counters["strictPassToFail"] += int(
        baseline["sourceStrictPass"] and not selected["sourceStrictPass"]
    )
    counters["usableFailToPass"] += int(not baseline["usablePass"] and selected["usablePass"])
    counters["usablePassToFail"] += int(baseline["usablePass"] and not selected["usablePass"])


def _finalize_metrics(
    counters: Counter[str],
    strict_migrations: Counter[str],
    usable_migrations: Counter[str],
) -> dict[str, Any]:
    total = max(1, counters["trackCount"])
    return {
        **dict(counters),
        "baselineStrictAccuracy": round(counters["baselineStrictPass"] / total, 9),
        "selectedStrictAccuracy": round(counters["selectedStrictPass"] / total, 9),
        "netStrictAccuracyDeltaRate": round(
            (counters["selectedStrictPass"] - counters["baselineStrictPass"]) / total, 9
        ),
        "baselineUsableGridAccuracy": round(counters["baselineUsablePass"] / total, 9),
        "selectedUsableGridAccuracy": round(counters["selectedUsablePass"] / total, 9),
        "netUsableGridAccuracyDeltaRate": round(
            (counters["selectedUsablePass"] - counters["baselineUsablePass"]) / total, 9
        ),
        "strictPassToFailRate": round(counters["strictPassToFail"] / total, 9),
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
        "strictCategoryMigration": dict(sorted(strict_migrations.items())),
        "usableCategoryMigration": dict(sorted(usable_migrations.items())),
    }


def _assert_strict_reproduction(actual: dict[str, Any], expected: dict[str, Any], batch_id: str) -> None:
    comparisons = {
        "trackCount": "trackCount",
        "baselineStrictPass": "baselinePass",
        "selectedStrictPass": "selectedPass",
        "strictFailToPass": "failToPass",
        "strictPassToFail": "passToFail",
        "baselineStrictBpmDriftFailure": "baselineBpmBigError",
        "selectedStrictBpmDriftFailure": "selectedBpmBigError",
        "baselineSourceDownbeatFailure": "baselineDownbeatFailure",
        "selectedSourceDownbeatFailure": "selectedDownbeatFailure",
        "switchCount": "switchCount",
    }
    for actual_key, expected_key in comparisons.items():
        if int(actual[actual_key]) != int(expected[expected_key]):
            raise RuntimeError(
                f"frozen strict replay drifted for {batch_id}:{actual_key}:"
                f"{actual[actual_key]}!={expected[expected_key]}"
            )


def _aggregate(folds: list[dict[str, Any]]) -> dict[str, Any]:
    values = [item["metrics"] for item in folds]
    usable_deltas = [float(item["netUsableGridAccuracyDeltaRate"]) for item in values]
    positive = sum(value > 0.0 for value in usable_deltas)
    neutral = sum(value == 0.0 for value in usable_deltas)
    gates = {
        "minimumPositiveFoldCount": positive >= 4,
        "minimumMacroNetUsableGridAccuracyDeltaRate": float(np.mean(usable_deltas)) >= 0.001,
        "minimumWorstFoldNetUsableGridAccuracyDeltaRate": min(usable_deltas) >= -0.0025,
        "maximumWorstFoldUsablePassToFailRate": max(
            float(item["usablePassToFailRate"]) for item in values
        )
        <= 0.005,
        "maximumWorstFoldDownbeatFailureRateIncrease": max(
            float(item["downbeatFailureRateIncrease"]) for item in values
        )
        <= 0.005,
    }
    return {
        "primaryFoldCount": len(folds),
        "positiveFoldCount": positive,
        "neutralFoldCount": neutral,
        "negativeFoldCount": len(folds) - positive - neutral,
        "macroNetUsableGridAccuracyDeltaRate": round(float(np.mean(usable_deltas)), 9),
        "worstFoldNetUsableGridAccuracyDeltaRate": min(usable_deltas),
        "worstFoldUsablePassToFailRate": max(
            float(item["usablePassToFailRate"]) for item in values
        ),
        "worstFoldDownbeatFailureRateIncrease": max(
            float(item["downbeatFailureRateIncrease"]) for item in values
        ),
        "netUsablePassDelta": sum(
            int(item["selectedUsablePass"]) - int(item["baselineUsablePass"]) for item in values
        ),
        "usablePassToFailCount": sum(int(item["usablePassToFail"]) for item in values),
        "strictNetPassDelta": sum(
            int(item["selectedStrictPass"]) - int(item["baselineStrictPass"]) for item in values
        ),
        "strictPassToFailCount": sum(int(item["strictPassToFail"]) for item in values),
        "gates": gates,
        "passed": all(gates.values()),
    }


def run_replay(args: argparse.Namespace) -> dict[str, Any]:
    study_dir = Path(args.study_dir).resolve()
    row_cache_dir = Path(args.row_cache_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    source_report_path = study_dir / "report.json"
    source_report = read_json_object(source_report_path)
    if _source_report_hash(source_report) != source_report.get("reportSha256"):
        raise RuntimeError("source study report hash is invalid")
    split_path = Path(str(source_report["inputs"]["splitPath"])).resolve()
    fold_plan_path = Path(str(source_report["inputs"]["foldPlanPath"])).resolve()
    if sha256_file(split_path) != source_report["inputs"]["splitSha256"]:
        raise RuntimeError("source split hash drifted")
    if sha256_file(fold_plan_path) != source_report["inputs"]["foldPlanSha256"]:
        raise RuntimeError("source fold plan hash drifted")
    split = read_json_object(split_path)
    fold_plan = read_json_object(fold_plan_path)
    folds_by_batch = {str(item["batchId"]): item for item in fold_plan["primaryFolds"]}
    all_outer_ids = [
        str(instance_id)
        for fold in fold_plan["primaryFolds"]
        for instance_id in fold["outerHoldout"]
    ]
    catalog = load_truth_catalog(split_path, split, instance_ids=all_outer_ids)
    fold_reports: list[dict[str, Any]] = []
    strict_regressions: list[dict[str, Any]] = []
    usable_regressions: list[dict[str, Any]] = []
    changed_decisions: list[dict[str, Any]] = []

    for source_fold in source_report["folds"]:
        batch_id = str(source_fold["batchId"])
        fold = folds_by_batch[batch_id]
        outer_ids = {str(item).casefold() for item in fold["outerHoldout"]}
        truths_by_name = {
            normalize_name(str(track.get("fileName") or "")): track
            for instance_id, track in catalog.items()
            if instance_id.casefold() in outer_ids
        }
        fold_result_path = study_dir / "folds" / batch_id / "result.json"
        fold_result = read_json_object(fold_result_path)
        selected_config = fold_result["selectedConfig"]
        selected_model = fold_result.get("selectedModel")
        counters = _empty_metrics()
        strict_migrations: Counter[str] = Counter()
        usable_migrations: Counter[str] = Counter()
        seen_ids: set[str] = set()
        benchmark_path = Path(DEFAULT_BENCHMARKS[batch_id]).resolve()
        for benchmark_track in iter_benchmark_tracks(benchmark_path):
            name_key = normalize_name(str(benchmark_track.get("fileName") or ""))
            truth = truths_by_name.get(name_key)
            if truth is None:
                continue
            instance_id = str(truth["instanceId"])
            row = read_json_object(_row_path(row_cache_dir, instance_id))
            selected_row, candidate_rank, switched = _frozen_selection(
                row,
                selected_config=selected_config,
                selected_model=selected_model,
            )
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
            baseline = _assessment_payload(
                _raw_result(
                    analysis=analysis,
                    candidate_rank=None,
                    timeline_offset_ms=timeline_offset_ms,
                ),
                enriched_truth,
                source_flags=row["baseline"],
            )
            selected = _assessment_payload(
                _raw_result(
                    analysis=analysis,
                    candidate_rank=candidate_rank,
                    timeline_offset_ms=timeline_offset_ms,
                ),
                enriched_truth,
                source_flags=selected_row,
            )
            if baseline["sourceStrictCategory"] != row["baseline"]["category"]:
                raise RuntimeError(f"baseline strict category drifted: {instance_id}")
            if selected["sourceStrictCategory"] != selected_row["category"]:
                raise RuntimeError(f"selected strict category drifted: {instance_id}")
            _record_metrics(counters, baseline, selected, switched=switched)
            strict_migrations[
                f"{baseline['sourceStrictCategory']}->{selected['sourceStrictCategory']}"
            ] += 1
            usable_migrations[f"{baseline['usableCategory']}->{selected['usableCategory']}"] += 1
            detail = {
                "instanceId": instance_id,
                "batchId": batch_id,
                "fileName": str(truth.get("fileName") or benchmark_track.get("fileName") or ""),
                "title": str(truth.get("title") or benchmark_track.get("title") or ""),
                "artist": str(truth.get("artist") or benchmark_track.get("artist") or ""),
                "sourcePath": str(truth.get("sourcePath") or truth.get("filePath") or ""),
                "truth": {
                    "bpm": float(enriched_truth["bpm"]),
                    "firstBeatMs": float(enriched_truth["firstBeatMs"]),
                    "downbeatBeatOffset": int(
                        enriched_truth.get("downbeatBeatOffset", enriched_truth.get("barBeatOffset"))
                    )
                    % 4,
                },
                "selection": {
                    "switched": switched,
                    "configId": str(selected_config["configId"]),
                    "threshold": float(selected_config.get("threshold") or 999.0),
                    "candidateRank": candidate_rank,
                    "candidateRankerScore": (
                        float(selected_row.get("rankerScore")) if candidate_rank is not None else None
                    ),
                },
                "baseline": baseline,
                "selected": selected,
            }
            if baseline["sourceStrictPass"] and not selected["sourceStrictPass"]:
                strict_regressions.append(detail)
            if baseline["usablePass"] and not selected["usablePass"]:
                usable_regressions.append(detail)
            if baseline["sourceStrictCategory"] != selected["sourceStrictCategory"]:
                changed_decisions.append(detail)
            seen_ids.add(instance_id.casefold())
        if seen_ids != outer_ids:
            missing = sorted(outer_ids - seen_ids)
            raise RuntimeError(f"benchmark misses frozen outer roster: {batch_id}:{missing[:1]}")
        metrics = _finalize_metrics(counters, strict_migrations, usable_migrations)
        _assert_strict_reproduction(metrics, fold_result["outerMetrics"], batch_id)
        fold_reports.append(
            {
                "batchId": batch_id,
                "selectedConfigId": str(selected_config["configId"]),
                "sourceFoldResultPath": str(fold_result_path).replace("\\", "/"),
                "sourceFoldResultSha256": sha256_file(fold_result_path),
                "metrics": metrics,
            }
        )

    aggregate = _aggregate(fold_reports)
    report = {
        "schemaVersion": 1,
        "type": "rkb-multiscale-frozen-usable-grid-replay",
        "replayVersion": REPLAY_VERSION,
        "developmentDiagnosticOnly": True,
        "postHocAcceptancePolicyCorrection": True,
        "freshProofEligible": False,
        "parameterSelectionAllowed": False,
        "sourceStudy": {
            "path": str(source_report_path).replace("\\", "/"),
            "fileSha256": sha256_file(source_report_path),
            "embeddedReportSha256": source_report["reportSha256"],
            "studyVersion": source_report["studyVersion"],
        },
        "policy": {
            "version": USABLE_GRID_POLICY_VERSION,
            "acceptedTempoRelations": ["same-bpm", "half-bpm", "double-bpm"],
            "octaveEquivalentRequiresNormalizedBpmPhaseAndGridWithinMs": 5.0,
            "exactBpmMetricRole": "diagnostic-only",
            "downbeatMetricRole": "separate-safety-gate",
            "frozenSelectionReplayedWithoutRetuning": True,
        },
        "aggregate": aggregate,
        "folds": fold_reports,
        "artifacts": {
            "strictRegressionsPath": str((output_dir / "strict-regressions.json").resolve()).replace(
                "\\", "/"
            ),
            "usableRegressionsPath": str((output_dir / "usable-regressions.json").resolve()).replace(
                "\\", "/"
            ),
            "changedDecisionsPath": str((output_dir / "changed-decisions.json").resolve()).replace(
                "\\", "/"
            ),
        },
        "summary": {
            "trackCount": sum(int(item["metrics"]["trackCount"]) for item in fold_reports),
            "strictRegressionCount": len(strict_regressions),
            "usableRegressionCount": len(usable_regressions),
            "changedDecisionCount": len(changed_decisions),
        },
    }
    report["reportSha256"] = sha256_json(report)
    _atomic_write_json(output_dir / "strict-regressions.json", strict_regressions)
    _atomic_write_json(output_dir / "usable-regressions.json", usable_regressions)
    _atomic_write_json(output_dir / "changed-decisions.json", changed_decisions)
    _atomic_write_json(output_dir / "report.json", report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Replay the frozen multiscale v2 selections under octave-equivalent grid acceptance"
    )
    parser.add_argument("--study-dir", default=DEFAULT_STUDY_DIR)
    parser.add_argument("--row-cache-dir", default=DEFAULT_ROW_CACHE_DIR)
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()
    report = run_replay(args)
    print(json.dumps({"aggregate": report["aggregate"], "summary": report["summary"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
