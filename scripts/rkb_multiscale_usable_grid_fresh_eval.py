import argparse
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

from rkb_beatgrid_lab_common import build_feature_index_map
from rkb_benchmark_bridge_result import normalize_bridge_result
from rkb_dataset_contract import normalize_name, sha256_file, sha256_json
from rkb_grid_acceptance import USABLE_GRID_POLICY_VERSION, assess_usable_grid
from rkb_multiscale_ranker_study import (
    _build_track_row,
    _row_path,
    _score_candidates,
    _select_candidate,
    _sidecar_index_map,
)
from rkb_multiscale_study_inputs import iter_benchmark_tracks
from rkb_multiscale_usable_grid_replay import _raw_result
from rkb_nested_lobo_contract import read_json_object
from rkb_sealed_batch_common import SealedBatchError, truth_tracks


EVALUATION_VERSION = "rkb-multiscale-usable-grid-fresh-eval-v1"
EXPECTED_CANDIDATE_SHA256 = "28e92006d712a024f4488ddfab5b2a5e5dec12de7a1cb6075402ea21cc9c6207"
DEFAULT_CANDIDATE = (
    Path(__file__).resolve().parent
    / "models"
    / "rkb-multiscale-usable-grid-candidate-v1.json"
)


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _candidate_payload(path: Path) -> dict[str, Any]:
    payload = read_json_object(path)
    embedded_hash = str(payload.get("candidateSha256") or "")
    unhashed = {key: value for key, value in payload.items() if key != "candidateSha256"}
    if sha256_json(unhashed) != embedded_hash or embedded_hash != EXPECTED_CANDIDATE_SHA256:
        raise RuntimeError("frozen candidate hash is invalid or not the locked v1 candidate")
    if not bool(payload.get("locked")) or bool(payload.get("productionEligible")):
        raise RuntimeError("candidate must be locked and development-only")
    config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
    model = payload.get("model") if isinstance(payload.get("model"), dict) else {}
    if config.get("family") != "multiscale" or model.get("family") != "multiscale":
        raise RuntimeError("frozen candidate family is not multiscale")
    return payload


def _truth_catalog(path: Path, batch_id: str) -> dict[str, dict[str, Any]]:
    payload = read_json_object(path)
    result: dict[str, dict[str, Any]] = {}
    for item in truth_tracks(payload, path):
        file_name = str(item.get("fileName") or "")
        if not file_name:
            raise RuntimeError("sealed truth must contain fileName")
        key = normalize_name(file_name)
        if key in result:
            raise RuntimeError(f"sealed truth contains duplicate normalized fileName: {file_name}")
        result[key] = {**item, "batchId": str(item.get("batchId") or batch_id)}
    return result


def _assessment(raw: dict[str, Any], truth: dict[str, Any]) -> dict[str, Any]:
    result = assess_usable_grid(
        result_bpm=float(raw["bpm"]),
        result_first_beat_timeline_ms=float(raw["timelineFirstBeatMs"]),
        result_downbeat_beat_offset=int(raw["downbeatBeatOffset"]),
        truth=truth,
    )
    return {
        "bpm": float(raw["bpm"]),
        "timelineFirstBeatMs": float(raw["timelineFirstBeatMs"]),
        "downbeatBeatOffset": int(raw["downbeatBeatOffset"]) % 4,
        "source": str(raw.get("source") or ""),
        "tempoRatio": float(result["tempoRatio"]),
        "tempoRelation": str(result["tempoRelation"]),
        "strictCategory": str(result["strictCategory"]),
        "usableCategory": str(result["usableCategory"]),
        "usablePass": bool(result["usablePass"]),
        "octaveEquivalentLinesPass": bool(result["octaveEquivalentLinesPass"]),
        "normalizedBpmPass": bool(result["normalizedBpmPass"]),
        "downbeatFailure": bool(result["downbeatFailure"]),
        "normalizedBpmDrift128BeatsMs": result["normalizedMetrics"][
            "bpmOnlyDrift128BeatsMs"
        ],
        "normalizedFirstBeatPhaseAbsErrorMs": result["normalizedMetrics"][
            "firstBeatPhaseAbsErrorMs"
        ],
        "normalizedGridMaxAbsMs": result["normalizedMetrics"]["gridMaxAbsMs"],
    }


def _summary(rows: list[dict[str, Any]], errors: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows) + len(errors)
    baseline_usable = sum(bool(item["baseline"]["usablePass"]) for item in rows)
    selected_usable = sum(bool(item["selected"]["usablePass"]) for item in rows)
    baseline_downbeat = sum(bool(item["baseline"]["downbeatFailure"]) for item in rows)
    selected_downbeat = sum(bool(item["selected"]["downbeatFailure"]) for item in rows)
    new_downbeat = sum(
        not bool(item["baseline"]["downbeatFailure"])
        and bool(item["selected"]["downbeatFailure"])
        for item in rows
    )
    fixed_downbeat = sum(
        bool(item["baseline"]["downbeatFailure"])
        and not bool(item["selected"]["downbeatFailure"])
        for item in rows
    )
    switched = [item for item in rows if bool(item["selection"]["switched"])]
    non_octave = sum(not bool(item["selected"]["normalizedBpmPass"]) for item in switched)
    oracle_pass = sum(bool(item["candidateOracleUsablePass"]) for item in rows)
    migrations = Counter(
        f"{item['baseline']['usableCategory']}->{item['selected']['usableCategory']}" for item in rows
    )
    denominator = max(1, total)
    return {
        "trackTotal": total,
        "analyzedTrackCount": len(rows),
        "errorTrackCount": len(errors),
        "baselineUsablePassCount": baseline_usable,
        "selectedUsablePassCount": selected_usable,
        "usableGridNetPassCount": selected_usable - baseline_usable,
        "baselineUsableGridAccuracy": round(baseline_usable / denominator, 9),
        "selectedUsableGridAccuracy": round(selected_usable / denominator, 9),
        "usableGridAccuracyDeltaRate": round(
            (selected_usable - baseline_usable) / denominator, 9
        ),
        "baselineDownbeatFailureCount": baseline_downbeat,
        "selectedDownbeatFailureCount": selected_downbeat,
        "downbeatFailureCountIncrease": selected_downbeat - baseline_downbeat,
        "downbeatFailureRateIncrease": round(
            (selected_downbeat - baseline_downbeat) / denominator, 9
        ),
        "newDownbeatFailureCount": new_downbeat,
        "newDownbeatFailureRate": round(new_downbeat / denominator, 9),
        "fixedDownbeatFailureCount": fixed_downbeat,
        "nonOctaveTempoFailureCount": non_octave,
        "nonOctaveTempoFailureRate": round(non_octave / denominator, 9),
        "switchCount": len(switched),
        "usableCategoryMigration": dict(sorted(migrations.items())),
        "candidateOracle": {
            "candidateUsablePassCount": oracle_pass,
            "candidateUsablePassRate": round(oracle_pass / denominator, 9),
        },
    }


def run_evaluation(args: argparse.Namespace) -> dict[str, Any]:
    truth_path = Path(args.truth).resolve()
    baseline_path = Path(args.baseline_benchmark).resolve()
    source_cache_dir = Path(args.source_cache_dir).resolve()
    sidecar_dir = Path(args.multiscale_cache_dir).resolve()
    candidate_path = Path(args.candidate).resolve()
    output_path = Path(args.output).resolve()
    row_cache_dir = Path(args.row_cache_dir).resolve()
    batch_id = str(args.truth_batch_id or "").strip()
    if not batch_id:
        raise RuntimeError("--truth-batch-id is required")
    candidate = _candidate_payload(candidate_path)
    config = dict(candidate["config"])
    model = dict(candidate["model"])
    truths_by_name = _truth_catalog(truth_path, batch_id)
    source_index = read_json_object(source_cache_dir / "index.json")
    source_entries = source_index.get("entries")
    if not isinstance(source_entries, list):
        raise RuntimeError("fresh source feature index contains no entries")
    source_by_name = {
        normalize_name(str(item.get("fileName") or "")): item
        for item in source_entries
        if isinstance(item, dict) and str(item.get("fileName") or "")
    }
    if set(source_by_name) != set(truths_by_name):
        raise RuntimeError("fresh source feature index roster does not match sealed truth")
    truths_by_name = {
        name: {
            **truth,
            "instanceId": str(source_by_name[name].get("instanceId") or ""),
            "sourcePath": str(source_by_name[name].get("sourcePath") or ""),
            "assetSha256": str(source_by_name[name].get("assetSha256") or ""),
            "pcmSha256": str(source_by_name[name].get("pcmSha256") or ""),
            "familyId": str(source_by_name[name].get("familyId") or ""),
            "isolationFamilyId": str(source_by_name[name].get("isolationFamilyId") or ""),
        }
        for name, truth in truths_by_name.items()
    }
    if any(not str(item.get("instanceId") or "") for item in truths_by_name.values()):
        raise RuntimeError("fresh source feature index contains an empty instanceId")
    source_index_map = build_feature_index_map(source_cache_dir)
    sidecar_index_path = sidecar_dir / "index.json"
    sidecar_map = _sidecar_index_map(sidecar_index_path)
    if len(sidecar_map) != len(truths_by_name):
        raise RuntimeError("fresh multiscale feature cache does not match sealed truth count")

    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    baseline_sha256 = sha256_file(baseline_path)
    started_at = time.time()
    for benchmark_track in iter_benchmark_tracks(baseline_path):
        name_key = normalize_name(str(benchmark_track.get("fileName") or ""))
        truth = truths_by_name.get(name_key)
        if truth is None:
            continue
        instance_id = str(truth["instanceId"])
        try:
            analysis_payload = benchmark_track.get("analysis")
            if not isinstance(analysis_payload, dict):
                raise RuntimeError("baseline benchmark track has no analysis")
            row = _build_track_row(
                truth=truth,
                source_cache_dir=source_cache_dir,
                source_index_map=source_index_map,
                sidecar_dir=sidecar_dir,
                sidecar_map=sidecar_map,
                row_cache_dir=row_cache_dir,
                analysis_payload=analysis_payload,
                analysis_source_sha256=baseline_sha256,
            )
            expected_names = list((row.get("featureNames") or {}).get("multiscale") or [])
            if expected_names != list(model.get("featureNames") or []):
                raise RuntimeError("fresh feature names do not match frozen model")
            _score_candidates([row], model)
            selected_row = row["baseline"]
            candidate_rank: int | None = None
            switched = False
            if bool(row["baseline"]["isLegacySelected"]):
                proposed = _select_candidate(row, str(config["mode"]))
                if proposed is not None and float(proposed.get("rankerScore") or -999.0) >= float(
                    config["threshold"]
                ):
                    selected_row = proposed
                    candidate_rank = int(proposed["rank"])
                    switched = True
            analysis = normalize_bridge_result(analysis_payload)
            benchmark_truth = benchmark_track.get("truth")
            time_basis = truth.get("timeBasis")
            if not isinstance(time_basis, dict):
                time_basis = (
                    benchmark_truth.get("timeBasis")
                    if isinstance(benchmark_truth, dict)
                    and isinstance(benchmark_truth.get("timeBasis"), dict)
                    else {"offsetMs": 0.0}
                )
            enriched_truth = {**truth, "timeBasis": time_basis}
            timeline_offset_ms = float(time_basis.get("offsetMs") or 0.0)
            baseline = _assessment(
                _raw_result(
                    analysis=analysis,
                    candidate_rank=None,
                    timeline_offset_ms=timeline_offset_ms,
                ),
                enriched_truth,
            )
            selected = _assessment(
                _raw_result(
                    analysis=analysis,
                    candidate_rank=candidate_rank,
                    timeline_offset_ms=timeline_offset_ms,
                ),
                enriched_truth,
            )
            candidate_oracle = any(
                _assessment(
                    _raw_result(
                        analysis=analysis,
                        candidate_rank=int(item["rank"]),
                        timeline_offset_ms=timeline_offset_ms,
                    ),
                    enriched_truth,
                )["usablePass"]
                for item in row.get("candidates") or []
            )
            rows.append(
                {
                    "instanceId": instance_id,
                    "batchId": batch_id,
                    "fileName": str(truth.get("fileName") or ""),
                    "title": str(truth.get("title") or ""),
                    "artist": str(truth.get("artist") or ""),
                    "sourcePath": str(truth.get("sourcePath") or ""),
                    "truth": {
                        "bpm": float(enriched_truth["bpm"]),
                        "firstBeatMs": float(enriched_truth["firstBeatMs"]),
                        "downbeatBeatOffset": int(
                            enriched_truth.get(
                                "downbeatBeatOffset", enriched_truth.get("barBeatOffset")
                            )
                        )
                        % 4,
                    },
                    "selection": {
                        "switched": switched,
                        "candidateRank": candidate_rank,
                        "rankerScore": selected_row.get("rankerScore"),
                    },
                    "baseline": baseline,
                    "selected": selected,
                    "candidateOracleUsablePass": bool(candidate_oracle),
                }
            )
        except Exception as error:
            errors.append(
                {
                    "instanceId": instance_id,
                    "batchId": batch_id,
                    "fileName": str(truth.get("fileName") or ""),
                    "error": f"{type(error).__name__}: {error}",
                }
            )
        seen_names.add(name_key)
        if len(seen_names) % 25 == 0:
            print(f"[fresh usable-grid {len(seen_names)}/{len(truths_by_name)}]", flush=True)
    missing = set(truths_by_name) - seen_names
    if missing:
        raise RuntimeError(f"baseline benchmark misses sealed truth roster: {sorted(missing)[0]}")
    summary = _summary(rows, errors)
    payload = {
        "schemaVersion": 1,
        "type": "rkb-multiscale-usable-grid-fresh-evaluation",
        "evaluationVersion": EVALUATION_VERSION,
        "policyVersion": USABLE_GRID_POLICY_VERSION,
        "batchId": batch_id,
        "candidate": {
            "path": str(candidate_path).replace("\\", "/"),
            "fileSha256": sha256_file(candidate_path),
            "candidateSha256": candidate["candidateSha256"],
            "config": config,
        },
        "inputs": {
            "truthPath": str(truth_path).replace("\\", "/"),
            "truthSha256": sha256_file(truth_path),
            "baselineBenchmarkPath": str(baseline_path).replace("\\", "/"),
            "baselineBenchmarkSha256": baseline_sha256,
            "sourceFeatureIndexSha256": sha256_file(source_cache_dir / "index.json"),
            "multiscaleFeatureIndexSha256": sha256_file(sidecar_index_path),
        },
        "summary": summary,
        "tracks": rows,
        "errors": errors,
        "elapsedSec": round(time.time() - started_at, 3),
    }
    payload["payloadSha256"] = sha256_json(payload)
    _atomic_write_json(output_path, payload)
    return payload


def validate_fresh_candidate_output(
    path: Path,
    *,
    expected_track_count: int,
    exit_code: int,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    payload = read_json_object(path)
    if exit_code != 0:
        raise SealedBatchError(f"fresh usable-grid evaluator exited with code {exit_code}")
    if payload.get("type") != "rkb-multiscale-usable-grid-fresh-evaluation":
        raise SealedBatchError("fresh usable-grid output type is invalid")
    embedded = str(payload.get("payloadSha256") or "")
    unhashed = {key: value for key, value in payload.items() if key != "payloadSha256"}
    if sha256_json(unhashed) != embedded:
        raise SealedBatchError("fresh usable-grid output hash is invalid")
    if str(payload.get("batchId") or "") != str(manifest.get("batchId") or ""):
        raise SealedBatchError("fresh usable-grid output batchId mismatch")
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    if int(summary.get("trackTotal") or 0) != expected_track_count:
        raise SealedBatchError("fresh usable-grid output denominator mismatch")
    if int(summary.get("analyzedTrackCount") or 0) + int(summary.get("errorTrackCount") or 0) != expected_track_count:
        raise SealedBatchError("fresh usable-grid analyzed/error counts do not cover denominator")
    tracks = payload.get("tracks") if isinstance(payload.get("tracks"), list) else []
    errors = payload.get("errors") if isinstance(payload.get("errors"), list) else []
    if len(tracks) + len(errors) != expected_track_count:
        raise SealedBatchError("fresh usable-grid row count does not cover denominator")
    if str((payload.get("candidate") or {}).get("candidateSha256") or "") != EXPECTED_CANDIDATE_SHA256:
        raise SealedBatchError("fresh usable-grid candidate identity mismatch")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the frozen usable-grid v3 candidate on fresh truth")
    parser.add_argument("--truth", required=True)
    parser.add_argument("--truth-batch-id", required=True)
    parser.add_argument("--baseline-benchmark", required=True)
    parser.add_argument("--source-cache-dir", required=True)
    parser.add_argument("--multiscale-cache-dir", required=True)
    parser.add_argument("--row-cache-dir", required=True)
    parser.add_argument("--candidate", default=str(DEFAULT_CANDIDATE))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        payload = run_evaluation(args)
    except Exception as error:
        print(f"error: {error}")
        return 1
    print(json.dumps(payload["summary"], ensure_ascii=False, indent=2))
    return 1 if payload["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
