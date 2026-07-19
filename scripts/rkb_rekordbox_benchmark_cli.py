import argparse
import json
import time
from pathlib import Path
from types import ModuleType
from typing import Any

from rkb_dataset_contract import (
    attach_benchmark_result_digest,
    build_benchmark_provenance_from_args,
    validate_truth_contract,
)


def _build_parser(benchmark: ModuleType) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Benchmark FRKB BeatThis grid against Rekordbox truth")
    parser.add_argument("--truth", default=str(benchmark.DEFAULT_TRUTH))
    parser.add_argument("--truth-batch-id", default="")
    parser.add_argument("--registry", default=str(benchmark.DEFAULT_REGISTRY))
    parser.add_argument("--audio-root", default=str(benchmark.DEFAULT_AUDIO_ROOT))
    parser.add_argument("--ffmpeg", default=str(benchmark.DEFAULT_FFMPEG))
    parser.add_argument("--ffprobe", default=str(benchmark.DEFAULT_FFPROBE))
    parser.add_argument("--output", default=str(benchmark.DEFAULT_OUTPUT))
    parser.add_argument("--solver", choices=["legacy", "hybrid", "constant-grid-dp"], default="legacy")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--feature-cache-dir", default=str(benchmark.DEFAULT_FEATURE_CACHE_DIR))
    parser.add_argument(
        "--official-high-attack-cache-dir",
        default="",
        help="Explicit high-attack sidecar directory for production phase replay.",
    )
    parser.add_argument("--prediction-cache-dir", default=str(benchmark.DEFAULT_PREDICTION_CACHE_DIR))
    parser.add_argument(
        "--no-prediction-cache",
        action="store_true",
        help="Disable deterministic BeatThis raw prediction cache.",
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--compact-output",
        action="store_true",
        help="Drop bulky solver candidate lists after metrics are derived.",
    )
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        help="Filter tracks by case-insensitive file/title/artist substring. Can be repeated.",
    )
    return parser


def _validate_paths(
    *,
    benchmark: ModuleType,
    args: argparse.Namespace,
    solver: str,
    truth_path: Path,
    audio_roots: list[Path],
    ffmpeg_path: Path,
    ffprobe_path: Path,
    feature_cache_dir: Path,
    official_high_attack_cache_dir: Path | None,
) -> None:
    if not truth_path.exists():
        legacy_truth_path = truth_path.with_name("rekordbox-current-truth.json")
        raise SystemExit(
            "v2 Rekordbox truth not found: "
            f"{truth_path}. Generate a derived file without changing {legacy_truth_path} with: "
            f'py -3 scripts/convert_legacy_grid_truth_to_v2.py --input "{legacy_truth_path}" '
            f'--output "{truth_path}" --apply'
        )
    missing_audio_roots = [item for item in audio_roots if not item.exists()]
    if missing_audio_roots:
        missing = ", ".join(str(item) for item in missing_audio_roots)
        raise SystemExit(f"audio root not found: {missing}")
    if not ffmpeg_path.exists():
        raise SystemExit(f"ffmpeg not found: {ffmpeg_path}")
    if not ffprobe_path.exists():
        raise SystemExit(f"ffprobe not found: {ffprobe_path}")
    if solver in {"hybrid", "constant-grid-dp"} and not feature_cache_dir.exists():
        raise SystemExit(f"feature cache dir not found: {feature_cache_dir}")
    if official_high_attack_cache_dir is not None and not official_high_attack_cache_dir.exists():
        raise SystemExit(f"official high-attack cache dir not found: {official_high_attack_cache_dir}")


def _prepare_solver(
    *,
    benchmark: ModuleType,
    solver: str,
    device: str,
    feature_cache_dir: Path,
) -> dict[str, Any]:
    context: dict[str, Any] = {
        "bridge": None,
        "checkpointPath": "",
        "predictor": None,
        "cpuSpect": None,
        "hybridSolver": None,
        "constantGridDpSolver": None,
        "constantGridDpFeatureIndex": {},
    }
    if solver == "legacy":
        bridge = benchmark._load_bridge_module()
        benchmark._install_full_logit_prediction_cache(bridge)
        checkpoint_path = str(bridge._resolve_checkpoint_path())
        context.update(
            {
                "bridge": bridge,
                "checkpointPath": checkpoint_path,
                "predictor": bridge.Audio2Beats(
                    checkpoint_path=checkpoint_path,
                    device=device,
                    dbn=False,
                ),
                "cpuSpect": bridge.LogMelSpect(device="cpu")
                if bridge._uses_accelerated_device(device)
                else None,
            }
        )
    elif solver == "hybrid":
        context["hybridSolver"] = benchmark._load_hybrid_solver_module()
    else:
        from rkb_beatgrid_lab_common import build_feature_index_map

        context["constantGridDpSolver"] = benchmark._load_constant_grid_dp_solver_module()
        context["constantGridDpFeatureIndex"] = build_feature_index_map(feature_cache_dir)
    return context


def _analyze_truth_track(
    *,
    benchmark: ModuleType,
    solver: str,
    context: dict[str, Any],
    truth: dict[str, Any],
    ffmpeg_path: Path,
    device: str,
    prediction_cache_dir: Path | None,
    prediction_cache_stats: dict[str, int],
    feature_cache_dir: Path,
    official_high_attack_cache_dir: Path | None,
) -> dict[str, Any]:
    if solver == "legacy":
        return benchmark._analyze_track(
            bridge=context["bridge"],
            predictor=context["predictor"],
            cpu_spect=context["cpuSpect"],
            ffmpeg_path=ffmpeg_path,
            device=device,
            checkpoint_path=context["checkpointPath"],
            prediction_cache_dir=prediction_cache_dir,
            prediction_cache_stats=prediction_cache_stats,
            truth=truth,
        )
    if solver == "hybrid":
        return benchmark._analyze_track_hybrid(
            hybrid_solver=context["hybridSolver"],
            feature_cache_dir=feature_cache_dir,
            truth=truth,
        )
    return benchmark._analyze_track_constant_grid_dp(
        constant_grid_dp_solver=context["constantGridDpSolver"],
        feature_cache_dir=feature_cache_dir,
        feature_index_map=context["constantGridDpFeatureIndex"],
        official_high_attack_cache_dir=official_high_attack_cache_dir,
        truth=truth,
    )


def run_benchmark_cli(benchmark: ModuleType) -> int:
    args = _build_parser(benchmark).parse_args()
    truth_path = Path(args.truth)
    audio_roots = benchmark._parse_audio_roots(args.audio_root)
    ffmpeg_path = Path(args.ffmpeg)
    ffprobe_path = Path(args.ffprobe)
    output_path = Path(args.output)
    solver = str(args.solver or "legacy").strip().lower()
    feature_cache_dir = Path(args.feature_cache_dir)
    official_high_attack_cache_dir = (
        Path(args.official_high_attack_cache_dir)
        if str(args.official_high_attack_cache_dir or "").strip()
        else None
    )
    device = str(args.device or "cpu").strip() or "cpu"
    prediction_cache_dir = None if args.no_prediction_cache else Path(args.prediction_cache_dir)
    _validate_paths(
        benchmark=benchmark,
        args=args,
        solver=solver,
        truth_path=truth_path,
        audio_roots=audio_roots,
        ffmpeg_path=ffmpeg_path,
        ffprobe_path=ffprobe_path,
        feature_cache_dir=feature_cache_dir,
        official_high_attack_cache_dir=official_high_attack_cache_dir,
    )

    started_at = time.time()
    truth_contract = validate_truth_contract(truth_path)
    truth_tracks = benchmark._load_truth_tracks(
        truth_path,
        audio_roots,
        ffprobe_path,
        str(args.truth_batch_id or "").strip(),
        Path(args.registry),
        require_audio_files=solver != "constant-grid-dp",
    )
    missing_tracks = (
        [item for item in truth_tracks if not item["fileExists"]]
        if solver != "constant-grid-dp"
        else []
    )
    if missing_tracks:
        missing_names = ", ".join(item["fileName"] for item in missing_tracks[:5])
        raise SystemExit(f"truth tracks missing from audio roots: {missing_names}")
    only_filters = [
        benchmark._normalize_lookup_key(item)
        for item in args.only
        if benchmark._normalize_lookup_key(item)
    ]
    truth_tracks = [
        item for item in truth_tracks if benchmark.matches_track_filters(item, only_filters)
    ]
    if args.limit and args.limit > 0:
        truth_tracks = truth_tracks[: args.limit]

    context = _prepare_solver(
        benchmark=benchmark,
        solver=solver,
        device=device,
        feature_cache_dir=feature_cache_dir,
    )
    prediction_cache_stats = benchmark._cache_stats()
    run_provenance = build_benchmark_provenance_from_args(args, truth_contract)
    rows: list[dict[str, Any]] = []
    error_rows: list[dict[str, Any]] = []
    for index, truth in enumerate(truth_tracks, start=1):
        print(f"[{index}/{len(truth_tracks)}] {truth['fileName']}", flush=True)
        try:
            analysis = _analyze_truth_track(
                benchmark=benchmark,
                solver=solver,
                context=context,
                truth=truth,
                ffmpeg_path=ffmpeg_path,
                device=device,
                prediction_cache_dir=prediction_cache_dir,
                prediction_cache_stats=prediction_cache_stats,
                feature_cache_dir=feature_cache_dir,
                official_high_attack_cache_dir=official_high_attack_cache_dir,
            )
            track_report = benchmark._build_track_report(analysis, truth)
            rows.append(
                benchmark._compact_track_report(track_report)
                if args.compact_output
                else track_report
            )
        except Exception as error:
            error_rows.append({**truth, "error": str(error)})
            print(f"  error: {error}", flush=True)

    summary = benchmark._build_summary(rows, error_rows)
    payload = attach_benchmark_result_digest(
        {
            "summary": {
                **summary,
                "truthPath": str(truth_path),
                "runProvenance": run_provenance,
                "truthBatchId": str(args.truth_batch_id or "").strip() or None,
                "registry": str(args.registry)
                if str(args.truth_batch_id or "").strip()
                else None,
                "audioRoot": str(args.audio_root),
                "audioRoots": [str(item) for item in audio_roots],
                "device": device,
                "solver": solver,
                "windowSec": benchmark.WINDOW_SEC,
                "maxScanSec": benchmark.MAX_SCAN_SEC,
                "featureCache": {
                    "enabled": solver in {"hybrid", "constant-grid-dp"},
                    "dir": str(feature_cache_dir)
                    if solver in {"hybrid", "constant-grid-dp"}
                    else None,
                },
                "officialHighAttackCache": {
                    "enabled": official_high_attack_cache_dir is not None,
                    "dir": str(official_high_attack_cache_dir)
                    if official_high_attack_cache_dir is not None
                    else None,
                },
                "strictToleranceMs": benchmark.STRICT_TOLERANCE_MS,
                "predictionCache": {
                    "enabled": prediction_cache_dir is not None,
                    "dir": str(prediction_cache_dir)
                    if prediction_cache_dir is not None
                    else None,
                    **prediction_cache_stats,
                },
                "durationSec": round(time.time() - started_at, 3),
            },
            "errors": error_rows,
            "tracks": rows,
        }
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {"summary": payload["summary"], "output": str(output_path)},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if not error_rows else 1
