import argparse
import sys
from pathlib import Path

from frkb_database_paths import FRKB_FILTER_SEALED_INTAKE_ROOT, FRKB_FILTER_SEALED_ROOT
from rkb_sealed_batch_relocation_cli import add_relocation_commands


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_ROOT = REPO_ROOT / "scripts"
BENCHMARK_ROOT = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"


def _add_storage_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--batches-root", default=str(BENCHMARK_ROOT / "sealed-batches"))
    parser.add_argument("--registry", default=str(BENCHMARK_ROOT / "rkb-dataset-registry.json"))
    parser.add_argument(
        "--baseline", default=str(BENCHMARK_ROOT / "rkb-dataset-registry-baseline.json")
    )


def _add_identity_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--node", default="node")
    parser.add_argument(
        "--identity-helper", default=str(SCRIPTS_ROOT / "rkb_sealed_audio_identity.mjs")
    )
    parser.add_argument("--identity-max-seconds", type=int, default=120)
    parser.add_argument(
        "--identity-cache-dir", default=str(BENCHMARK_ROOT / "audio-identity-cache")
    )
    parser.add_argument("--identity-chunk-size", type=int, default=16)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Enforce one-shot Rekordbox sealed beatgrid batches")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare")
    _add_storage_args(prepare)
    _add_identity_args(prepare)
    prepare.add_argument("--playlist", default="test")
    prepare.add_argument(
        "--reviewed-development",
        action="store_true",
        help=(
            "Consume a human-reviewed batch as development-only data. "
            "Requires --triage-report and never creates fresh proof."
        ),
    )
    prepare.add_argument(
        "--fresh-validation",
        action="store_true",
        help=(
            "Bind a human-reviewed triage roster as one-shot fresh validation for the already "
            "frozen candidate. Requires --triage-report."
        ),
    )
    prepare.add_argument(
        "--triage-report",
        default="",
        help="Immutable pre-review triage report required by --reviewed-development.",
    )
    prepare.add_argument("--python", default=sys.executable)
    prepare.add_argument("--checkpoint", default="")
    prepare.add_argument("--audio-intake-root", default=str(FRKB_FILTER_SEALED_INTAKE_ROOT))
    prepare.add_argument("--audio-archive-root", default=str(FRKB_FILTER_SEALED_ROOT))
    prepare.add_argument(
        "--bridge",
        default=str(REPO_ROOT / "resources" / "rekordboxDesktopLibrary" / "bridge.py"),
    )
    prepare.add_argument(
        "--current-truth", default=str(BENCHMARK_ROOT / "rekordbox-current-truth.v2.json")
    )
    prepare.add_argument("--db-path", default="")
    prepare.add_argument(
        "--sync-script", default=str(SCRIPTS_ROOT / "sync_rekordbox_playlist_audio.py")
    )
    prepare.add_argument(
        "--capture-script", default=str(SCRIPTS_ROOT / "capture_rekordbox_playlist_truth.py")
    )
    prepare.add_argument(
        "--feature-cache-script",
        default=str(SCRIPTS_ROOT / "run_parallel_rkb_beatgrid_feature_cache.py"),
    )
    prepare.add_argument(
        "--benchmark-script",
        default=str(SCRIPTS_ROOT / "run_parallel_rkb_rekordbox_benchmark.py"),
    )
    prepare.add_argument(
        "--multiscale-feature-script",
        default=str(SCRIPTS_ROOT / "rkb_multiscale_feature_cache.py"),
    )
    prepare.add_argument(
        "--usable-grid-eval-script",
        default=str(SCRIPTS_ROOT / "rkb_multiscale_usable_grid_fresh_eval.py"),
    )
    prepare.add_argument(
        "--usable-grid-candidate",
        default=str(SCRIPTS_ROOT / "models" / "rkb-multiscale-usable-grid-candidate-v1.json"),
    )
    prepare.add_argument(
        "--prediction-cache-dir", default=str(BENCHMARK_ROOT / "beatthis-prediction-cache")
    )
    prepare.add_argument(
        "--ffmpeg", default=str(REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffmpeg.exe")
    )
    prepare.add_argument(
        "--ffprobe", default=str(REPO_ROOT / "vendor" / "ffmpeg" / "win32-x64" / "ffprobe.exe")
    )
    prepare.add_argument("--device", default="cpu")
    prepare.add_argument("--jobs", type=int, default=4)
    prepare.add_argument("--minimum-usable-grid-net-pass-count", type=int, default=1)
    prepare.add_argument("--maximum-error-rate", type=float, default=0.0)
    prepare.add_argument("--maximum-downbeat-failure-rate-increase", type=float, default=0.005)
    prepare.add_argument("--maximum-new-downbeat-failure-rate", type=float, default=0.005)
    prepare.add_argument("--maximum-non-octave-tempo-failure-rate", type=float, default=0.0)
    prepare.add_argument("--minimum-candidate-oracle-rate", type=float, default=0.94)

    evaluate = subparsers.add_parser("evaluate")
    _add_storage_args(evaluate)
    evaluate.add_argument("--batch", default="latest")
    evaluate.add_argument("--resume", action="store_true")

    finalize = subparsers.add_parser("finalize")
    _add_storage_args(finalize)
    finalize.add_argument("--batch", default="latest")
    finalize.add_argument("--decision", choices=["eligible", "reject", "consume"], required=True)
    finalize.add_argument("--note", default="")

    imported = subparsers.add_parser("import-consumed")
    _add_storage_args(imported)
    _add_identity_args(imported)
    imported.add_argument("--batch-id", required=True)
    imported.add_argument("--truth", required=True)
    imported.add_argument("--audio-root", action="append", required=True)

    initialize = subparsers.add_parser("initialize-registry")
    _add_storage_args(initialize)
    initialize.add_argument("--expected-track-count", type=int, required=True)
    initialize.add_argument(
        "--expected-batch",
        action="append",
        default=[],
        help="Require an exact imported batch as BATCH_ID=TRACK_COUNT. Can be repeated.",
    )

    add_relocation_commands(subparsers, _add_storage_args)
    return parser
