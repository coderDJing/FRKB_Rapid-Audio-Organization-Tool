import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FRKB_DATABASE_ROOT = Path("D:/FRKB_database-E")


def _read_dotenv_value(key: str) -> str:
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return ""
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            if name.strip() == key:
                return value.strip().strip('"').strip("'")
    except OSError:
        return ""
    return ""


def resolve_frkb_database_root() -> Path:
    configured = (
        os.environ.get("FRKB_BENCHMARK_DATABASE_ROOT", "").strip()
        or os.environ.get("FRKB_DEV_DATABASE_URL", "").strip()
        or _read_dotenv_value("FRKB_BENCHMARK_DATABASE_ROOT")
        or _read_dotenv_value("FRKB_DEV_DATABASE_URL")
    )
    return Path(configured) if configured else DEFAULT_FRKB_DATABASE_ROOT


FRKB_DATABASE_ROOT = resolve_frkb_database_root()
FRKB_LIBRARY_ROOT = FRKB_DATABASE_ROOT / "library"
FRKB_FILTER_LIBRARY_ROOT = FRKB_LIBRARY_ROOT / "FilterLibrary"
FRKB_FILTER_NEW_ROOT = FRKB_FILTER_LIBRARY_ROOT / "new"
FRKB_FILTER_SAMPLE_ROOT = FRKB_FILTER_LIBRARY_ROOT / "sample"
FRKB_FILTER_FAILURE_ROOT = FRKB_FILTER_LIBRARY_ROOT / "grid-failures-current"
FRKB_FILTER_BLIND_ROOT = FRKB_FILTER_LIBRARY_ROOT / "blind-rekordbox-truth"
FRKB_FILTER_SEALED_ROOT = FRKB_FILTER_LIBRARY_ROOT / "sealed-eval"
FRKB_FILTER_SEALED_INTAKE_ROOT = FRKB_FILTER_LIBRARY_ROOT / "sealed-intake"

FRKB_BENCHMARK_CURRENT_AUDIO_ROOT = ";".join(
    str(item)
    for item in (
        FRKB_FILTER_NEW_ROOT,
        FRKB_FILTER_SAMPLE_ROOT,
        FRKB_FILTER_FAILURE_ROOT,
    )
)
