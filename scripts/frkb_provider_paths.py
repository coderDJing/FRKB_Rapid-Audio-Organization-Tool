from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
FILTER_LIBRARY_ROOT = Path("D:/FRKB_database-B/library/FilterLibrary")

ANALYZERS = ("beatthis", "classic")
AUDIO_BUCKETS = ("new", "sample", "grid-failures-current")

LEGACY_AUDIO_ROOTS = {
    "new": FILTER_LIBRARY_ROOT / "new",
    "sample": FILTER_LIBRARY_ROOT / "sample",
    "grid-failures-current": FILTER_LIBRARY_ROOT / "grid-failures-current",
}

PROVIDER_JSON_FILE_SUFFIXES = {
    "current_latest": "current-latest.json",
    "intake_latest": "intake-latest.json",
    "manual_latest": "manual-latest.json",
    "classification_current": "classification-current.json",
    "sample_regression_latest": "sample-regression-latest.json",
    "grid_failures_current_latest": "grid-failures-current-latest.json",
    "grid_failures_current_manifest": "grid-failures-current-manifest.json",
}

def normalize_analyzer(value: str | None) -> str:
    normalized = str(value or "beatthis").strip().lower()
    if normalized not in ANALYZERS:
        raise ValueError(f"unsupported analyzer: {value}")
    return normalized


def provider_audio_root(analyzer: str, bucket: str) -> Path:
    normalized_analyzer = normalize_analyzer(analyzer)
    normalized_bucket = str(bucket or "").strip()
    if normalized_bucket not in AUDIO_BUCKETS:
        raise ValueError(f"unsupported audio bucket: {bucket}")
    return FILTER_LIBRARY_ROOT / normalized_analyzer / normalized_bucket


def provider_audio_roots(analyzer: str, buckets: tuple[str, ...] = AUDIO_BUCKETS) -> list[Path]:
    return [provider_audio_root(analyzer, bucket) for bucket in buckets]


def provider_audio_root_arg(analyzer: str, buckets: tuple[str, ...] = AUDIO_BUCKETS) -> str:
    return ";".join(str(path) for path in provider_audio_roots(analyzer, buckets))


def provider_json_path(analyzer: str, key: str) -> Path:
    normalized_analyzer = normalize_analyzer(analyzer)
    suffix = PROVIDER_JSON_FILE_SUFFIXES.get(str(key or "").strip())
    if not suffix:
        raise ValueError(f"unsupported provider json key: {key}")
    return BENCHMARK_OUTPUT_DIR / f"frkb-{normalized_analyzer}-{suffix}"
