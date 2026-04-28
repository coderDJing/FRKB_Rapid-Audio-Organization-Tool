import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import benchmark_rkb_rekordbox_truth as benchmark
from frkb_provider_paths import ANALYZERS, provider_json_path


DEFAULT_CURRENT_BENCHMARK = provider_json_path("beatthis", "current_latest")
DEFAULT_CLASSIFICATION = provider_json_path("beatthis", "classification_current")
DEFAULT_SAMPLE_BENCHMARK = provider_json_path("beatthis", "sample_regression_latest")
DEFAULT_FAILURE_BENCHMARK = provider_json_path("beatthis", "grid_failures_current_latest")
DEFAULT_FAILURE_MANIFEST = provider_json_path("beatthis", "grid_failures_current_manifest")


def _arg_supplied(argv: list[str], *names: str) -> bool:
    for arg in argv:
        for name in names:
            if arg == name or arg.startswith(f"{name}="):
                return True
    return False


def _apply_analyzer_defaults(args: argparse.Namespace, argv: list[str]) -> None:
    analyzer = str(args.analyzer or "beatthis").strip().lower()
    if not _arg_supplied(argv, "--output-benchmark"):
        args.output_benchmark = str(provider_json_path(analyzer, "current_latest"))
    if not _arg_supplied(argv, "--classification"):
        args.classification = str(provider_json_path(analyzer, "classification_current"))
    if not _arg_supplied(argv, "--sample-output"):
        args.sample_output = str(provider_json_path(analyzer, "sample_regression_latest"))
    if not _arg_supplied(argv, "--failure-output"):
        args.failure_output = str(provider_json_path(analyzer, "grid_failures_current_latest"))
    if not _arg_supplied(argv, "--failure-manifest"):
        args.failure_manifest = str(provider_json_path(analyzer, "grid_failures_current_manifest"))


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"json is not an object: {path}")
    return payload


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    last_error: PermissionError | None = None
    for attempt in range(8):
        try:
            tmp_path.replace(path)
            return
        except PermissionError as error:
            last_error = error
            time.sleep(0.15 * float(attempt + 1))
    if last_error is not None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def _category(row: dict[str, Any]) -> str:
    return _normalize_key((row.get("currentTimeline") or {}).get("category")) or "unknown"


def _row_identity(row: dict[str, Any]) -> dict[str, Any]:
    truth = row.get("truth") if isinstance(row.get("truth"), dict) else {}
    analysis = row.get("analysis") if isinstance(row.get("analysis"), dict) else {}
    timeline = row.get("currentTimeline") if isinstance(row.get("currentTimeline"), dict) else {}
    category = _category(row)
    return {
        "fileName": row.get("fileName") or truth.get("fileName") or "",
        "title": truth.get("title") or row.get("title") or "",
        "artist": truth.get("artist") or row.get("artist") or "",
        "category": category,
        "targetSet": "sample" if category == "pass" else "grid-failures-current",
        "bpm": analysis.get("bpm"),
        "truthBpm": truth.get("bpm"),
        "gridMeanAbsMs": timeline.get("gridMeanAbsMs"),
        "gridMaxAbsMs": timeline.get("gridMaxAbsMs"),
        "firstBeatPhaseAbsErrorMs": timeline.get("firstBeatPhaseAbsErrorMs"),
        "bpmOnlyDrift128BeatsMs": timeline.get("bpmOnlyDrift128BeatsMs"),
        "barBeatOffset": analysis.get("barBeatOffset"),
        "truthBarBeatOffset": truth.get("barBeatOffset"),
        "anchorStrategy": analysis.get("anchorStrategy"),
    }


def _error_identity(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "fileName": row.get("fileName") or "",
        "title": row.get("title") or "",
        "artist": row.get("artist") or "",
        "category": "error",
        "targetSet": "grid-failures-current",
        "error": row.get("error") or "",
    }


def _merge_benchmark_payloads(paths: list[Path]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in paths:
        payload = _load_json(path)
        summaries.append(
            {
                "path": str(path),
                "summary": payload.get("summary") if isinstance(payload.get("summary"), dict) else {},
            }
        )
        for row in payload.get("tracks") or []:
            if not isinstance(row, dict):
                continue
            key = _normalize_key(row.get("fileName"))
            if not key or key in seen:
                continue
            seen.add(key)
            rows.append(row)
        for row in payload.get("errors") or []:
            if not isinstance(row, dict):
                continue
            key = _normalize_key(row.get("fileName"))
            if not key or key in seen:
                continue
            seen.add(key)
            errors.append(row)

    rows.sort(key=lambda row: _normalize_key(row.get("fileName")))
    errors.sort(key=lambda row: _normalize_key(row.get("fileName")))
    summary = benchmark._build_summary(rows, errors)
    return {
        "summary": {
            **summary,
            "type": "frkb-current-benchmark",
            "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "sourceBenchmarks": summaries,
        },
        "errors": errors,
        "tracks": rows,
    }


def _filtered_benchmark_payload(
    *,
    rows: list[dict[str, Any]],
    errors: list[dict[str, Any]],
    label: str,
    source_benchmark: str,
) -> dict[str, Any]:
    summary = benchmark._build_summary(rows, errors)
    return {
        "summary": {
            **summary,
            "type": label,
            "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "sourceBenchmark": source_benchmark,
        },
        "errors": errors,
        "tracks": rows,
    }


def _build_classification(
    *,
    rows: list[dict[str, Any]],
    errors: list[dict[str, Any]],
    source_benchmark: str,
) -> dict[str, Any]:
    classification_rows = [_row_identity(row) for row in rows]
    classification_rows.extend(_error_identity(row) for row in errors)
    category_counts: dict[str, int] = {}
    for row in classification_rows:
        category = str(row.get("category") or "unknown")
        category_counts[category] = category_counts.get(category, 0) + 1
    classification_rows.sort(key=lambda row: _normalize_key(row.get("fileName")))
    return {
        "source": {
            "type": "frkb-grid-classification-current",
            "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "sourceBenchmark": source_benchmark,
            "trackCount": len(classification_rows),
            "categoryCounts": category_counts,
        },
        "tracks": classification_rows,
    }


def _build_failure_manifest(
    *,
    fail_rows: list[dict[str, Any]],
    error_rows: list[dict[str, Any]],
    source_benchmark: str,
) -> dict[str, Any]:
    rows = [_row_identity(row) for row in fail_rows]
    rows.extend(_error_identity(row) for row in error_rows)
    rows.sort(key=lambda row: _normalize_key(row.get("fileName")))
    return {
        "source": {
            "type": "frkb-grid-failures-current-manifest",
            "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "sourceBenchmark": source_benchmark,
            "trackCount": len(rows),
        },
        "tracks": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build current FRKB classification and derived benchmark views")
    parser.add_argument("--analyzer", choices=ANALYZERS, default="beatthis")
    parser.add_argument("--benchmark", action="append", default=[])
    parser.add_argument("--output-benchmark", default=str(DEFAULT_CURRENT_BENCHMARK))
    parser.add_argument("--classification", default=str(DEFAULT_CLASSIFICATION))
    parser.add_argument("--sample-output", default=str(DEFAULT_SAMPLE_BENCHMARK))
    parser.add_argument("--failure-output", default=str(DEFAULT_FAILURE_BENCHMARK))
    parser.add_argument("--failure-manifest", default=str(DEFAULT_FAILURE_MANIFEST))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    _apply_analyzer_defaults(args, sys.argv[1:])

    benchmark_paths = [Path(item) for item in args.benchmark] or [Path(args.output_benchmark)]
    current_payload = _merge_benchmark_payloads(benchmark_paths)
    if isinstance(current_payload.get("summary"), dict):
        current_payload["summary"]["analyzer"] = str(args.analyzer)
    all_rows = [item for item in current_payload.get("tracks") or [] if isinstance(item, dict)]
    all_errors = [item for item in current_payload.get("errors") or [] if isinstance(item, dict)]
    pass_rows = [row for row in all_rows if _category(row) == "pass"]
    fail_rows = [row for row in all_rows if _category(row) != "pass"]

    output_benchmark_path = Path(args.output_benchmark)
    source_benchmark = str(output_benchmark_path)
    sample_payload = _filtered_benchmark_payload(
        rows=pass_rows,
        errors=[],
        label="frkb-sample-regression-derived",
        source_benchmark=source_benchmark,
    )
    failure_payload = _filtered_benchmark_payload(
        rows=fail_rows,
        errors=all_errors,
        label="frkb-grid-failures-current-derived",
        source_benchmark=source_benchmark,
    )
    classification_payload = _build_classification(
        rows=all_rows,
        errors=all_errors,
        source_benchmark=source_benchmark,
    )
    failure_manifest = _build_failure_manifest(
        fail_rows=fail_rows,
        error_rows=all_errors,
        source_benchmark=source_benchmark,
    )

    if not args.dry_run:
        _write_json(output_benchmark_path, current_payload)
        _write_json(Path(args.classification), classification_payload)
        _write_json(Path(args.sample_output), sample_payload)
        _write_json(Path(args.failure_output), failure_payload)
        _write_json(Path(args.failure_manifest), failure_manifest)

    print(
        json.dumps(
            {
                "sourceBenchmarks": [str(item) for item in benchmark_paths],
                "currentBenchmark": str(output_benchmark_path),
                "classification": str(args.classification),
                "analyzer": str(args.analyzer),
                "trackTotal": len(all_rows) + len(all_errors),
                "pass": len(pass_rows),
                "fail": len(fail_rows),
                "errors": len(all_errors),
                "dryRun": bool(args.dry_run),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
