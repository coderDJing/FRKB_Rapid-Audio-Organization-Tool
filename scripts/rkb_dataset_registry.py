from pathlib import Path
from typing import Any

from rkb_sealed_batch_common import (
    MANIFEST_NAME,
    STATE_NAME,
    SealedBatchError,
    load_json,
    sha256_file,
)


def verify_registry_baseline(
    *, batches_root: Path, registry_path: Path, baseline_path: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not registry_path.is_file() or not baseline_path.is_file():
        raise SealedBatchError(
            'dataset registry baseline is not initialized; import all consumed datasets and run initialize-registry'
        )
    registry = load_json(registry_path)
    baseline = load_json(baseline_path)
    if baseline.get('type') != 'rkb-dataset-registry-baseline':
        raise SealedBatchError(f'invalid dataset baseline: {baseline_path}')
    registry_batches = {
        str(item.get('batchId')): item
        for item in registry.get('batches') or []
        if isinstance(item, dict)
    }
    baseline_batch_ids: set[str] = set()
    for item in baseline.get('batches') or []:
        if not isinstance(item, dict):
            raise SealedBatchError('dataset baseline contains an invalid batch')
        batch_id = str(item.get('batchId') or '')
        baseline_batch_ids.add(batch_id)
        batch_dir = batches_root / batch_id
        manifest_path = batch_dir / MANIFEST_NAME
        state_path = batch_dir / STATE_NAME
        if not manifest_path.is_file() or sha256_file(manifest_path) != str(item.get('manifestSha256') or ''):
            raise SealedBatchError(f'baseline consumed manifest changed or is missing: {batch_id}')
        if not state_path.is_file() or sha256_file(state_path) != str(item.get('stateSha256') or ''):
            raise SealedBatchError(f'baseline consumed state changed or is missing: {batch_id}')
        registry_item = registry_batches.get(batch_id)
        if (
            not registry_item
            or registry_item.get('manifestSha256') != item.get('manifestSha256')
            or registry_item.get('stateSha256') != item.get('stateSha256')
            or registry_item.get('status') != 'consumed'
        ):
            raise SealedBatchError(f'registry is missing baseline batch: {batch_id}')
    imported_batch_ids = {
        batch_id
        for batch_id, item in registry_batches.items()
        if str(item.get('origin') or '') == 'import-consumed'
    }
    if imported_batch_ids != baseline_batch_ids:
        extra = sorted(imported_batch_ids - baseline_batch_ids)
        missing = sorted(baseline_batch_ids - imported_batch_ids)
        raise SealedBatchError(
            f'registry consumed imports do not match baseline; extra={extra}, missing={missing}'
        )
    expected = int(baseline.get('expectedTrackCount') or 0)
    if expected <= 0 or int(registry.get('trackCount') or 0) < expected:
        raise SealedBatchError('dataset registry no longer covers the initialized consumed baseline')
    return registry, baseline
