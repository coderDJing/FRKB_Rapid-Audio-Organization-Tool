import copy
import os
from pathlib import Path
from typing import Any

from rkb_sealed_batch_common import (
    SCHEMA_VERSION,
    SealedBatchError,
    _build_registry_payload_unmapped,
    load_json,
    sha256_file,
    sha256_json,
    utc_now,
    write_json_new,
)


ROOT_REMAP_FILE_NAME = 'rkb-dataset-root-remap.json'
ROOT_REMAP_TYPE = 'rkb-dataset-root-remap'


def _registry_content_sha256(payload: dict[str, Any]) -> str:
    return sha256_json({key: value for key, value in payload.items() if key != 'generatedAt'})


def _absolute_path(value: str | Path, owner: str) -> Path:
    raw = str(value or '').strip()
    if not raw:
        raise SealedBatchError(f'{owner} is empty')
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise SealedBatchError(f'{owner} must be an absolute path: {raw}')
    try:
        return candidate.resolve()
    except OSError:
        return candidate.absolute()


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(str(left)) == os.path.normcase(str(right))


def _relative_path_under_root(path: Path, root: Path, owner: str) -> Path:
    normalized_path = _absolute_path(path, owner)
    normalized_root = _absolute_path(root, 'root remap sourceRoot')
    path_text = os.path.normcase(str(normalized_path))
    root_text = os.path.normcase(str(normalized_root))
    try:
        common = os.path.commonpath([path_text, root_text])
    except ValueError as error:
        raise SealedBatchError(f'{owner} is not inside root remap sourceRoot: {normalized_path}') from error
    if os.path.normcase(common) != root_text:
        raise SealedBatchError(f'{owner} is not inside root remap sourceRoot: {normalized_path}')
    try:
        relative = normalized_path.relative_to(normalized_root)
    except ValueError:
        relative = Path(os.path.relpath(str(normalized_path), str(normalized_root)))
    if str(relative) in {'', '.'} or '..' in relative.parts:
        raise SealedBatchError(f'{owner} has an invalid root remap relative path: {normalized_path}')
    return relative


def _root_remap_locked_payload(
    *, batches_root: Path, source_root: Path, target_root: Path, source_registry_sha256: str, track_count: int
) -> dict[str, Any]:
    if _same_path(source_root, target_root):
        raise SealedBatchError('root remap sourceRoot and targetRoot must differ')
    if track_count <= 0:
        raise SealedBatchError('root remap source registry has no tracks')
    return {
        'batchesRoot': str(batches_root),
        'sourceRoot': str(source_root),
        'targetRoot': str(target_root),
        'sourceRegistrySha256': source_registry_sha256,
        'sourceTrackCount': track_count,
    }


def _load_root_remap_payload(path: Path, batches_root: Path) -> dict[str, Any]:
    payload = load_json(path)
    if payload.get('schemaVersion') != SCHEMA_VERSION or payload.get('type') != ROOT_REMAP_TYPE:
        raise SealedBatchError(f'invalid dataset root remap sidecar: {path}')
    locked = payload.get('locked')
    if not isinstance(locked, dict) or payload.get('lockSha256') != sha256_json(locked):
        raise SealedBatchError(f'dataset root remap sidecar hash mismatch: {path}')
    required = ('batchesRoot', 'sourceRoot', 'targetRoot', 'sourceRegistrySha256', 'sourceTrackCount')
    if any(not str(locked.get(field) or '').strip() for field in required):
        raise SealedBatchError(f'dataset root remap sidecar is incomplete: {path}')
    locked_batches_root = _absolute_path(str(locked['batchesRoot']), 'root remap batchesRoot')
    expected_batches_root = _absolute_path(batches_root, 'sealed batches root')
    if not _same_path(locked_batches_root, expected_batches_root):
        raise SealedBatchError('dataset root remap sidecar belongs to another sealed batches root')
    source_root = _absolute_path(str(locked['sourceRoot']), 'root remap sourceRoot')
    target_root = _absolute_path(str(locked['targetRoot']), 'root remap targetRoot')
    if _same_path(source_root, target_root):
        raise SealedBatchError('root remap sourceRoot and targetRoot must differ')
    if not target_root.is_dir():
        raise SealedBatchError(f'root remap targetRoot does not exist: {target_root}')
    try:
        track_count = int(locked['sourceTrackCount'])
    except (TypeError, ValueError) as error:
        raise SealedBatchError('dataset root remap sourceTrackCount is invalid') from error
    if track_count <= 0:
        raise SealedBatchError('dataset root remap sourceTrackCount is invalid')
    source_registry_sha256 = str(locked['sourceRegistrySha256']).strip().casefold()
    if len(source_registry_sha256) != 64 or any(char not in '0123456789abcdef' for char in source_registry_sha256):
        raise SealedBatchError('dataset root remap sourceRegistrySha256 is invalid')
    return {
        'sidecarPath': str(path.resolve()),
        'lockSha256': str(payload['lockSha256']),
        'batchesRoot': str(locked_batches_root),
        'sourceRoot': str(source_root),
        'targetRoot': str(target_root),
        'sourceRegistrySha256': source_registry_sha256,
        'sourceTrackCount': track_count,
    }


def create_root_remap_sidecar(
    *,
    batches_root: Path,
    source_root: Path,
    target_root: Path,
    sidecar_path: Path,
    baseline_path: Path | None = None,
) -> dict[str, Any]:
    normalized_batches_root = _absolute_path(batches_root, 'sealed batches root')
    normalized_source_root = _absolute_path(source_root, 'root remap sourceRoot')
    normalized_target_root = _absolute_path(target_root, 'root remap targetRoot')
    if not normalized_source_root.is_dir():
        raise SealedBatchError(f'root remap sourceRoot does not exist: {normalized_source_root}')
    if not normalized_target_root.is_dir():
        raise SealedBatchError(f'root remap targetRoot does not exist: {normalized_target_root}')
    source_registry = _build_registry_payload_unmapped(normalized_batches_root, baseline_path)
    active_batches = [
        str(row.get('batchId') or '')
        for row in source_registry['batches']
        if str(row.get('status') or '') != 'consumed'
    ]
    if active_batches:
        raise SealedBatchError(
            f'root remap requires every sealed batch to be consumed: {sorted(active_batches)}'
        )
    locked = _root_remap_locked_payload(
        batches_root=normalized_batches_root,
        source_root=normalized_source_root,
        target_root=normalized_target_root,
        source_registry_sha256=_registry_content_sha256(source_registry),
        track_count=int(source_registry['trackCount']),
    )
    remap = {'sidecarPath': str(sidecar_path.resolve()), 'lockSha256': sha256_json(locked), **locked}
    for row in source_registry['tracks']:
        _relative_path_under_root(
            Path(str(row.get('sourcePath') or '')),
            normalized_source_root,
            f"registry sourcePath {row.get('batchId')}:{row.get('fileName')}",
        )
    payload = {
        'schemaVersion': SCHEMA_VERSION,
        'type': ROOT_REMAP_TYPE,
        'createdAt': utc_now(),
        'locked': locked,
        'lockSha256': remap['lockSha256'],
    }
    write_json_new(sidecar_path, payload)
    return remap


def resolve_root_remap_for_registry(
    *, registry_path: Path, batches_root: Path, root_remap_path: Path | None = None
) -> dict[str, Any] | None:
    sidecar_path = root_remap_path
    if sidecar_path is None:
        candidate = registry_path.resolve().with_name(ROOT_REMAP_FILE_NAME)
        if not candidate.is_file():
            return None
        sidecar_path = candidate
    return _load_root_remap_payload(sidecar_path.resolve(), batches_root)


def apply_root_remap(source_registry: dict[str, Any], remap: dict[str, Any]) -> dict[str, Any]:
    source_registry_sha256 = _registry_content_sha256(source_registry)
    if source_registry_sha256 != str(remap['sourceRegistrySha256']):
        raise SealedBatchError('dataset root remap source registry hash no longer matches sealed artifacts')
    if int(source_registry.get('trackCount') or -1) != int(remap['sourceTrackCount']):
        raise SealedBatchError('dataset root remap source track count no longer matches sealed artifacts')
    mapped = copy.deepcopy(source_registry)
    source_root = _absolute_path(str(remap['sourceRoot']), 'root remap sourceRoot')
    target_root = _absolute_path(str(remap['targetRoot']), 'root remap targetRoot')
    for row in mapped['tracks']:
        relative = _relative_path_under_root(
            Path(str(row.get('sourcePath') or '')),
            source_root,
            f"registry sourcePath {row.get('batchId')}:{row.get('fileName')}",
        )
        target_path = target_root / relative
        target_relative = _relative_path_under_root(
            target_path,
            target_root,
            f"root remap targetPath {row.get('batchId')}:{row.get('fileName')}",
        )
        row['sourcePath'] = str(target_root / target_relative)
    mapped['sourcePathRelocation'] = {
        'type': ROOT_REMAP_TYPE,
        'lockSha256': str(remap['lockSha256']),
        'sourceRoot': str(source_root),
        'targetRoot': str(target_root),
        'sourceRegistrySha256': source_registry_sha256,
        'sourceTrackCount': int(remap['sourceTrackCount']),
    }
    return mapped


def verify_registry_source_assets(payload: dict[str, Any]) -> None:
    failures: list[str] = []
    checked = 0
    for row in payload.get('tracks') or []:
        if not isinstance(row, dict):
            failures.append('registry contains an invalid track row')
            continue
        path = Path(str(row.get('sourcePath') or ''))
        expected = str(row.get('assetSha256') or '').casefold()
        if not path.is_file():
            failures.append(f"missing:{row.get('batchId')}:{row.get('fileName')}:{path}")
        elif sha256_file(path).casefold() != expected:
            failures.append(f"sha256:{row.get('batchId')}:{row.get('fileName')}:{path}")
        checked += 1
    if failures:
        preview = '; '.join(failures[:5])
        raise SealedBatchError(
            f'root remap target audio validation failed ({len(failures)}/{checked}): {preview}'
        )
