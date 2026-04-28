import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from frkb_provider_paths import ANALYZERS, provider_audio_root, provider_json_path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DEFAULT_CLASSIFICATION = provider_json_path("beatthis", "classification_current")
DEFAULT_NEW_ROOT = provider_audio_root("beatthis", "new")
DEFAULT_SAMPLE_ROOT = provider_audio_root("beatthis", "sample")
DEFAULT_FAILURE_ROOT = provider_audio_root("beatthis", "grid-failures-current")


def _arg_supplied(argv: list[str], *names: str) -> bool:
    for arg in argv:
        for name in names:
            if arg == name or arg.startswith(f"{name}="):
                return True
    return False


def _apply_analyzer_defaults(args: argparse.Namespace, argv: list[str]) -> None:
    analyzer = str(args.analyzer or "beatthis").strip().lower()
    if not _arg_supplied(argv, "--classification"):
        args.classification = str(provider_json_path(analyzer, "classification_current"))
    if not _arg_supplied(argv, "--new-root"):
        args.new_root = str(provider_audio_root(analyzer, "new"))
    if not _arg_supplied(argv, "--sample-root"):
        args.sample_root = str(provider_audio_root(analyzer, "sample"))
    if not _arg_supplied(argv, "--failure-root"):
        args.failure_root = str(provider_audio_root(analyzer, "grid-failures-current"))


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"json is not an object: {path}")
    return payload


def _resolve_root(path_value: str) -> Path:
    path = Path(path_value)
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def _scan_audio_files(roots: dict[str, Path]) -> tuple[dict[str, list[tuple[str, Path]]], list[str]]:
    by_name: dict[str, list[tuple[str, Path]]] = {}
    errors: list[str] = []
    for label, root in roots.items():
        if not root.exists() or not root.is_dir():
            errors.append(f"audio root is not a directory: {root}")
            continue
        for item in root.iterdir():
            if not item.is_file():
                continue
            key = _normalize_key(item.name)
            if not key:
                continue
            by_name.setdefault(key, []).append((label, item.resolve()))
    return by_name, errors


def _load_targets(classification_path: Path) -> dict[str, tuple[str, str]]:
    payload = _load_json(classification_path)
    tracks = payload.get("tracks")
    if not isinstance(tracks, list):
        raise RuntimeError(f"classification has no tracks array: {classification_path}")
    targets: dict[str, tuple[str, str]] = {}
    duplicates: set[str] = set()
    for track in tracks:
        if not isinstance(track, dict):
            continue
        file_name = str(track.get("fileName") or "").strip()
        key = _normalize_key(file_name)
        if not key:
            continue
        if key in targets:
            duplicates.add(file_name)
            continue
        target_set = str(track.get("targetSet") or "").strip()
        if target_set not in {"sample", "grid-failures-current"}:
            category = _normalize_key(track.get("category"))
            target_set = "sample" if category == "pass" else "grid-failures-current"
        targets[key] = (file_name, target_set)
    if duplicates:
        preview = ", ".join(sorted(duplicates)[:8])
        raise RuntimeError(f"classification contains duplicate fileName values: {preview}")
    return targets


def _is_within_root(path: Path, roots: dict[str, Path]) -> bool:
    resolved = path.resolve()
    for root in roots.values():
        try:
            resolved.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _build_move_plan(
    *,
    targets: dict[str, tuple[str, str]],
    located_files: dict[str, list[tuple[str, Path]]],
    roots: dict[str, Path],
    allowed_roots: dict[str, Path],
    mode: str,
) -> tuple[list[dict[str, str]], list[str]]:
    moves: list[dict[str, str]] = []
    errors: list[str] = []
    for key, (file_name, target_set) in targets.items():
        locations = located_files.get(key) or []
        if not locations:
            errors.append(f"classified audio missing from roots: {file_name}")
            continue

        source_label, source_path = locations[0]
        target_root = roots[target_set]
        destination_path = (target_root / file_name).resolve()
        target_locations = [
            path
            for label, path in locations
            if label == target_set and path.resolve() == destination_path
        ]
        if target_locations:
            continue

        source_locations = [(label, path) for label, path in locations if label != target_set]
        if len(source_locations) != 1:
            joined = ", ".join(str(path) for _label, path in locations)
            errors.append(f"audio exists in ambiguous roots: {file_name} -> {joined}")
            continue
        source_label, source_path = source_locations[0]
        if not _is_within_root(source_path, allowed_roots) or not _is_within_root(destination_path, roots):
            errors.append(f"unsafe move path: {source_path} -> {destination_path}")
            continue
        if source_label == target_set:
            continue
        if destination_path.exists():
            if mode == "copy":
                continue
            errors.append(f"destination already exists: {destination_path}")
            continue
        moves.append(
            {
                "fileName": file_name,
                "fromSet": source_label,
                "toSet": target_set,
                "mode": mode,
                "source": str(source_path),
                "destination": str(destination_path),
            }
        )
    return moves, errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync FRKB audio directories from current classification")
    parser.add_argument("--analyzer", choices=ANALYZERS, default="beatthis")
    parser.add_argument("--classification", default=str(DEFAULT_CLASSIFICATION))
    parser.add_argument("--new-root", default=str(DEFAULT_NEW_ROOT))
    parser.add_argument("--sample-root", default=str(DEFAULT_SAMPLE_ROOT))
    parser.add_argument("--failure-root", default=str(DEFAULT_FAILURE_ROOT))
    parser.add_argument(
        "--source-root",
        action="append",
        default=[],
        help="Additional source roots used for non-destructive comparison playlist copies.",
    )
    parser.add_argument("--mode", choices=["move", "copy"], default="move")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    _apply_analyzer_defaults(args, sys.argv[1:])

    roots = {
        "new": _resolve_root(args.new_root),
        "sample": _resolve_root(args.sample_root),
        "grid-failures-current": _resolve_root(args.failure_root),
    }
    source_roots = {
        f"source-{index + 1}": _resolve_root(path_value)
        for index, path_value in enumerate(args.source_root)
        if str(path_value or "").strip()
    }
    targets = _load_targets(Path(args.classification))
    located_files, scan_errors = _scan_audio_files({**source_roots, **roots})
    moves, plan_errors = _build_move_plan(
        targets=targets,
        located_files=located_files,
        roots=roots,
        allowed_roots={**source_roots, **roots},
        mode=str(args.mode),
    )
    errors = scan_errors + plan_errors
    if errors:
        preview = "\n".join(errors[:12])
        raise SystemExit(f"audio sync plan has errors:\n{preview}")

    if not args.dry_run:
        for item in moves:
            destination = Path(item["destination"])
            destination.parent.mkdir(parents=True, exist_ok=True)
            if item["mode"] == "copy":
                shutil.copy2(item["source"], destination)
            else:
                shutil.move(item["source"], destination)

    move_counts: dict[str, int] = {}
    for item in moves:
        label = f"{item['fromSet']}->{item['toSet']}"
        move_counts[label] = move_counts.get(label, 0) + 1

    print(
        json.dumps(
            {
                "classification": str(Path(args.classification)),
                "analyzer": str(args.analyzer),
                "mode": str(args.mode),
                "trackCount": len(targets),
                "moveCount": len(moves),
                "moveCounts": move_counts,
                "dryRun": bool(args.dry_run),
                "moves": moves[:40],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
