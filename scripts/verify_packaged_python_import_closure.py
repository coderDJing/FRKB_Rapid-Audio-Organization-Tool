import argparse
import ast
import json
from collections import deque
from pathlib import Path


def _module_path(root: Path, module_name: str) -> Path | None:
    relative = Path(*module_name.split("."))
    module_path = root / relative.with_suffix(".py")
    if module_path.is_file():
        return module_path
    package_path = root / relative / "__init__.py"
    return package_path if package_path.is_file() else None


def _top_level_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    imports: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imports.add(node.module)
    return imports


def verify_import_closure(
    *,
    source_root: Path,
    packaged_root: Path,
    entries: list[str],
) -> dict[str, object]:
    source_root = source_root.resolve()
    packaged_root = packaged_root.resolve()
    queue = deque(Path(entry).stem for entry in entries)
    visited: set[str] = set()
    missing: list[dict[str, str]] = []

    while queue:
        module_name = queue.popleft()
        if module_name in visited:
            continue
        visited.add(module_name)
        source_path = _module_path(source_root, module_name)
        if source_path is None:
            continue
        packaged_path = _module_path(packaged_root, module_name)
        if packaged_path is None:
            missing.append({"module": module_name, "requiredBy": "bootstrap-import-closure"})
            continue
        for imported_name in _top_level_imports(source_path):
            if _module_path(source_root, imported_name) is not None:
                queue.append(imported_name)

    result = {
        "entryModules": [Path(entry).stem for entry in entries],
        "visitedLocalModules": sorted(visited),
        "missingLocalModules": missing,
    }
    if missing:
        names = ", ".join(item["module"] for item in missing)
        raise RuntimeError(f"packaged Python bootstrap is missing local modules: {names}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify packaged Python top-level import closure")
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--packaged-root", required=True)
    parser.add_argument("--entry", action="append", required=True)
    args = parser.parse_args()
    result = verify_import_closure(
        source_root=Path(args.source_root),
        packaged_root=Path(args.packaged_root),
        entries=list(args.entry),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
