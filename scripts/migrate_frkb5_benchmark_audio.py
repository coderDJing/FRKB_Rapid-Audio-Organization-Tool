import argparse
import hashlib
import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from frkb_database_paths import (
    FRKB_DATABASE_ROOT,
    FRKB_FILTER_BLIND_ROOT,
    FRKB_FILTER_FAILURE_ROOT,
    FRKB_LIBRARY_ROOT,
    FRKB_FILTER_LIBRARY_ROOT,
    FRKB_FILTER_NEW_ROOT,
    FRKB_FILTER_SAMPLE_ROOT,
    FRKB_FILTER_SEALED_INTAKE_ROOT,
    FRKB_FILTER_SEALED_ROOT,
    REPO_ROOT,
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

AUDIO_EXTENSIONS = {
    ".mp3",
    ".flac",
    ".wav",
    ".aif",
    ".aiff",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
}

BENCHMARK_ROOT = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_CLASSIFICATION = BENCHMARK_ROOT / "frkb-classification-current.json"
DEFAULT_BLIND_AUDIO_ROOT = BENCHMARK_ROOT / "blind-rekordbox-truth" / "audio"
DEFAULT_SEALED_AUDIO_ROOT = BENCHMARK_ROOT / "sealed-eval" / "audio"
DEFAULT_MANIFEST = FRKB_FILTER_LIBRARY_ROOT / ".frkb_audio_library_manifest.json"
LEGACY_BENCHMARK_LIBRARY_ROOT = FRKB_FILTER_LIBRARY_ROOT / "Benchmark"
ARCHIVE_AUDIO_ROOTS = (
    FRKB_FILTER_BLIND_ROOT,
    FRKB_FILTER_SEALED_ROOT,
    FRKB_FILTER_SEALED_INTAKE_ROOT,
    LEGACY_BENCHMARK_LIBRARY_ROOT,
)
DESTINATION_AUDIO_ROOTS = (
    FRKB_FILTER_NEW_ROOT,
    FRKB_FILTER_SAMPLE_ROOT,
    FRKB_FILTER_FAILURE_ROOT,
    FRKB_FILTER_BLIND_ROOT,
    FRKB_FILTER_SEALED_ROOT,
    FRKB_FILTER_SEALED_INTAKE_ROOT,
)


@dataclass(frozen=True)
class CopyItem:
    dataset: str
    source: Path
    destination: Path
    size: int
    sha256: str


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _is_audio_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS


def _is_within_any_root(path: Path, roots: tuple[Path, ...]) -> bool:
    resolved_path = path.resolve(strict=False)
    for root in roots:
        try:
            resolved_path.relative_to(root.resolve(strict=False))
            return True
        except ValueError:
            continue
    return False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"json is not an object: {path}")
    return payload


def _scan_audio_by_name(root: Path) -> dict[str, list[Path]]:
    if not root.exists():
        raise RuntimeError(f"library root not found: {root}")
    by_name: dict[str, list[Path]] = {}
    for path in root.rglob("*"):
        if not _is_audio_file(path):
            continue
        resolved_path = path.resolve(strict=False)
        if _is_within_any_root(resolved_path, ARCHIVE_AUDIO_ROOTS):
            continue
        by_name.setdefault(_normalize_key(path.name), []).append(path)
    return by_name


def _target_root_for_current_track(track: dict[str, Any]) -> Path:
    target_set = str(track.get("targetSet") or "").strip()
    if not target_set:
        category = _normalize_key(track.get("category"))
        target_set = "sample" if category == "pass" else "grid-failures-current"
    if target_set == "sample":
        return FRKB_FILTER_SAMPLE_ROOT
    if target_set == "grid-failures-current":
        return FRKB_FILTER_FAILURE_ROOT
    raise RuntimeError(f"unsupported targetSet: {target_set}")


def _current_source_priority(source: Path, target_root: Path) -> tuple[int, str]:
    resolved_source = source.resolve(strict=False)
    preference_roots = [
        target_root,
        FRKB_FILTER_SAMPLE_ROOT,
        FRKB_FILTER_FAILURE_ROOT,
        FRKB_FILTER_LIBRARY_ROOT,
    ]
    for index, root in enumerate(preference_roots):
        try:
            resolved_source.relative_to(root.resolve(strict=False))
            return index, str(resolved_source)
        except ValueError:
            continue
    return len(preference_roots), str(resolved_source)


def _select_current_source(file_name: str, candidates: list[Path], target_root: Path) -> Path:
    if not candidates:
        raise RuntimeError(f"current audio missing from FRKB library: {file_name}")
    sorted_candidates = sorted(candidates, key=lambda item: _current_source_priority(item, target_root))
    best = sorted_candidates[0]
    if len(sorted_candidates) == 1:
        return best
    best_priority = _current_source_priority(best, target_root)[0]
    tied = [
        item
        for item in sorted_candidates
        if _current_source_priority(item, target_root)[0] == best_priority
    ]
    if len(tied) > 1:
        joined = ", ".join(str(item) for item in tied[:5])
        raise RuntimeError(f"ambiguous current audio source for {file_name}: {joined}")
    return best


def _collect_current_items(classification_path: Path) -> list[CopyItem]:
    payload = _load_json(classification_path)
    tracks = payload.get("tracks")
    if not isinstance(tracks, list):
        raise RuntimeError(f"classification has no tracks array: {classification_path}")

    audio_by_name = _scan_audio_by_name(FRKB_LIBRARY_ROOT)
    items: list[CopyItem] = []
    for track in tracks:
        if not isinstance(track, dict):
            continue
        file_name = str(track.get("fileName") or "").strip()
        if not file_name:
            continue
        target_root = _target_root_for_current_track(track)
        source = _select_current_source(
            file_name,
            audio_by_name.get(_normalize_key(file_name)) or [],
            target_root,
        )
        items.append(
            CopyItem(
                dataset="current",
                source=source,
                destination=target_root / file_name,
                size=source.stat().st_size,
                sha256=_sha256(source),
            )
        )
    return items


def _collect_flat_audio_items(
    dataset: str,
    source_root: Path,
    destination_root: Path,
) -> list[CopyItem]:
    if not source_root.exists():
        raise RuntimeError(f"{dataset} audio root not found: {source_root}")
    items: list[CopyItem] = []
    seen_destinations: set[str] = set()
    for source in sorted(source_root.iterdir(), key=lambda item: item.name.casefold()):
        if not _is_audio_file(source):
            continue
        destination = destination_root / source.name
        key = _normalize_key(destination.name)
        if key in seen_destinations:
            raise RuntimeError(f"duplicate destination in {dataset}: {destination.name}")
        seen_destinations.add(key)
        items.append(
            CopyItem(
                dataset=dataset,
                source=source,
                destination=destination,
                size=source.stat().st_size,
                sha256=_sha256(source),
            )
        )
    return items


def _validate_destination_root(item: CopyItem) -> None:
    resolved_destination = item.destination.resolve(strict=False)
    if not _is_within_any_root(resolved_destination, DESTINATION_AUDIO_ROOTS):
        raise RuntimeError(f"destination escapes FRKB audio roots: {item.destination}")


def _destination_state(item: CopyItem) -> str:
    if not item.destination.exists():
        return "missing"
    if not item.destination.is_file():
        return "blocked"
    if item.destination.stat().st_size != item.size:
        return "different"
    return "ready" if _sha256(item.destination) == item.sha256 else "different"


def _copy_items(items: list[CopyItem], *, apply: bool) -> dict[str, int]:
    stats = {"ready": 0, "copied": 0, "missing": 0, "different": 0, "blocked": 0}
    for item in items:
        _validate_destination_root(item)
        state = _destination_state(item)
        if state == "ready":
            stats["ready"] += 1
            continue
        if state in {"different", "blocked"}:
            stats[state] += 1
            raise RuntimeError(f"unsafe destination state={state}: {item.destination}")
        stats["missing"] += 1
        if apply:
            item.destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item.source, item.destination)
            if _destination_state(item) != "ready":
                raise RuntimeError(f"copied file failed verification: {item.destination}")
            stats["copied"] += 1
    return stats


def _write_manifest(items: list[CopyItem], manifest_path: Path) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "type": "frkb5-benchmark-audio-library-manifest",
        "databaseRoot": str(FRKB_DATABASE_ROOT),
        "filterLibraryRoot": str(FRKB_FILTER_LIBRARY_ROOT),
        "datasets": _summarize_by_dataset(items),
        "files": [
            {
                "dataset": item.dataset,
                "source": str(item.source),
                "destination": str(item.destination),
                "size": item.size,
                "sha256": item.sha256,
            }
            for item in items
        ],
    }
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _summarize_by_dataset(items: list[CopyItem]) -> dict[str, dict[str, int]]:
    summary: dict[str, dict[str, int]] = {}
    for item in items:
        bucket = summary.setdefault(item.dataset, {"files": 0, "bytes": 0})
        bucket["files"] += 1
        bucket["bytes"] += item.size
    return summary


def _print_summary(items: list[CopyItem], stats: dict[str, int], *, apply: bool) -> None:
    total_bytes = sum(item.size for item in items)
    payload = {
        "apply": apply,
        "databaseRoot": str(FRKB_DATABASE_ROOT),
        "filterLibraryRoot": str(FRKB_FILTER_LIBRARY_ROOT),
        "datasets": _summarize_by_dataset(items),
        "totalFiles": len(items),
        "totalBytes": total_bytes,
        "totalGiB": round(total_bytes / (1024**3), 3),
        "stats": stats,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate benchmark audio into the FRKB-5 library")
    parser.add_argument("--classification", default=str(DEFAULT_CLASSIFICATION))
    parser.add_argument("--blind-audio-root", default=str(DEFAULT_BLIND_AUDIO_ROOT))
    parser.add_argument("--sealed-audio-root", default=str(DEFAULT_SEALED_AUDIO_ROOT))
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    if args.apply:
        for root in DESTINATION_AUDIO_ROOTS:
            root.mkdir(parents=True, exist_ok=True)
    items = [
        *_collect_current_items(Path(args.classification)),
        *_collect_flat_audio_items(
            "blind",
            Path(args.blind_audio_root),
            FRKB_FILTER_BLIND_ROOT,
        ),
        *_collect_flat_audio_items(
            "sealed",
            Path(args.sealed_audio_root),
            FRKB_FILTER_SEALED_ROOT,
        ),
    ]
    stats = _copy_items(items, apply=bool(args.apply))
    if args.apply:
        _write_manifest(items, Path(args.manifest))
    _print_summary(items, stats, apply=bool(args.apply))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
