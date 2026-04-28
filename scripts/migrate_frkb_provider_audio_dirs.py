import argparse
import json
import os
import shutil
import stat
import sys
from pathlib import Path
from typing import Any

from frkb_provider_paths import (
    ANALYZERS,
    AUDIO_BUCKETS,
    FILTER_LIBRARY_ROOT,
    LEGACY_AUDIO_ROOTS,
    provider_audio_root,
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _scan_legacy_files() -> tuple[dict[str, list[Path]], list[str]]:
    files_by_bucket: dict[str, list[Path]] = {}
    errors: list[str] = []
    seen: dict[str, Path] = {}
    for bucket in AUDIO_BUCKETS:
        root = LEGACY_AUDIO_ROOTS[bucket]
        files: list[Path] = []
        if not root.exists():
            files_by_bucket[bucket] = files
            continue
        if not root.is_dir():
            errors.append(f"legacy root is not a directory: {root}")
            files_by_bucket[bucket] = files
            continue
        for item in root.iterdir():
            if not item.is_file():
                continue
            if item.name.startswith("."):
                continue
            key = _normalize_key(item.name)
            if not key:
                continue
            previous = seen.get(key)
            if previous is not None:
                errors.append(f"duplicate legacy fileName across buckets: {item.name} -> {previous} / {item}")
                continue
            seen[key] = item
            files.append(item)
        files_by_bucket[bucket] = files
    return files_by_bucket, errors


def _same_file_size(left: Path, right: Path) -> bool:
    try:
        return left.stat().st_size == right.stat().st_size
    except OSError:
        return False


def _existing_provider_file_names(analyzer: str) -> set[str]:
    names: set[str] = set()
    for bucket in AUDIO_BUCKETS:
        root = provider_audio_root(analyzer, bucket)
        if not root.exists() or not root.is_dir():
            continue
        for item in root.iterdir():
            if item.is_file() and not item.name.startswith("."):
                names.add(_normalize_key(item.name))
    return names


def _add_copy_item(
    plan: list[dict[str, str]],
    errors: list[str],
    *,
    source: Path,
    destination: Path,
    role: str,
) -> None:
    if destination.exists():
        if _same_file_size(source, destination):
            return
        errors.append(f"destination collision: {destination}")
        return
    plan.append(
        {
            "role": role,
            "source": str(source),
            "destination": str(destination),
        }
    )


def _build_copy_plan(files_by_bucket: dict[str, list[Path]]) -> tuple[list[dict[str, str]], list[str]]:
    plan: list[dict[str, str]] = []
    errors: list[str] = []
    for bucket, files in files_by_bucket.items():
        beatthis_root = provider_audio_root("beatthis", bucket)
        for source in files:
            _add_copy_item(
                plan,
                errors,
                source=source,
                destination=beatthis_root / source.name,
                role=f"beatthis/{bucket}",
            )

    classic_new = provider_audio_root("classic", "new")
    classic_existing = _existing_provider_file_names("classic")
    for bucket in AUDIO_BUCKETS:
        for source in files_by_bucket.get(bucket, []):
            if _normalize_key(source.name) in classic_existing:
                continue
            _add_copy_item(
                plan,
                errors,
                source=source,
                destination=classic_new / source.name,
                role=f"classic/new-from-{bucket}",
            )

    return plan, errors


def _execute_copy_plan(plan: list[dict[str, str]]) -> None:
    for analyzer in ANALYZERS:
        for bucket in AUDIO_BUCKETS:
            provider_audio_root(analyzer, bucket).mkdir(parents=True, exist_ok=True)

    for item in plan:
        destination = Path(item["destination"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item["source"], destination)


def _verify_copy_plan(plan: list[dict[str, str]]) -> list[str]:
    errors: list[str] = []
    for item in plan:
        source = Path(item["source"])
        destination = Path(item["destination"])
        if not destination.exists():
            errors.append(f"missing copied file: {destination}")
            continue
        if not _same_file_size(source, destination):
            errors.append(f"copied file size mismatch: {source} -> {destination}")
    return errors


def _assert_safe_legacy_root(root: Path) -> Path:
    resolved_root = root.resolve()
    resolved_filter_root = FILTER_LIBRARY_ROOT.resolve()
    resolved_root.relative_to(resolved_filter_root)
    if root.name not in AUDIO_BUCKETS:
        raise RuntimeError(f"refuse to delete unexpected legacy root: {root}")
    return resolved_root


def _handle_readonly_remove_error(function: Any, path: str, _exc_info: Any) -> None:
    os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
    function(path)


def _delete_legacy_roots() -> list[str]:
    deleted: list[str] = []
    for bucket in AUDIO_BUCKETS:
        root = LEGACY_AUDIO_ROOTS[bucket]
        if not root.exists():
            continue
        resolved = _assert_safe_legacy_root(root)
        shutil.rmtree(resolved, onerror=_handle_readonly_remove_error)
        deleted.append(str(resolved))
    return deleted


def _count_files(files_by_bucket: dict[str, list[Path]]) -> dict[str, int]:
    return {bucket: len(files_by_bucket.get(bucket, [])) for bucket in AUDIO_BUCKETS}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Migrate legacy unscoped FRKB validation audio dirs to provider-scoped dirs"
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--delete-old", action="store_true")
    parser.add_argument("--confirm-delete-old", action="store_true")
    args = parser.parse_args()

    if args.delete_old and not args.confirm_delete_old:
        raise SystemExit("--delete-old requires --confirm-delete-old")

    files_by_bucket, scan_errors = _scan_legacy_files()
    plan, plan_errors = _build_copy_plan(files_by_bucket)
    errors = scan_errors + plan_errors
    if errors:
        preview = "\n".join(errors[:12])
        raise SystemExit(f"migration plan has errors:\n{preview}")

    verify_errors: list[str] = []
    deleted_roots: list[str] = []
    if not args.dry_run:
        _execute_copy_plan(plan)
        verify_errors = _verify_copy_plan(plan)
        if verify_errors:
            preview = "\n".join(verify_errors[:12])
            raise SystemExit(f"migration verification failed:\n{preview}")
        if args.delete_old:
            deleted_roots = _delete_legacy_roots()

    role_counts: dict[str, int] = {}
    for item in plan:
        role = str(item.get("role") or "")
        role_counts[role] = role_counts.get(role, 0) + 1

    print(
        json.dumps(
            {
                "legacyRoots": {bucket: str(LEGACY_AUDIO_ROOTS[bucket]) for bucket in AUDIO_BUCKETS},
                "providerRoots": {
                    "beatthis": {
                        bucket: str(provider_audio_root("beatthis", bucket))
                        for bucket in AUDIO_BUCKETS
                    },
                    "classic": {
                        bucket: str(provider_audio_root("classic", bucket))
                        for bucket in AUDIO_BUCKETS
                    },
                },
                "legacyFileCounts": _count_files(files_by_bucket),
                "copyCount": len(plan),
                "copyCountByRole": role_counts,
                "deleteOld": bool(args.delete_old),
                "deletedRoots": deleted_roots,
                "dryRun": bool(args.dry_run),
                "copies": plan[:60],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
