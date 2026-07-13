import argparse
from pathlib import Path
from typing import Any, Callable

from rkb_dataset_relocation import ROOT_REMAP_FILE_NAME, create_root_remap_sidecar


def add_relocation_commands(
    subparsers: argparse._SubParsersAction,
    add_storage_args: Callable[[argparse.ArgumentParser], None],
) -> None:
    rebuild = subparsers.add_parser('rebuild-registry')
    add_storage_args(rebuild)
    rebuild.add_argument(
        '--root-remap',
        default='',
        help=(
            'Immutable relocation sidecar. Omit to auto-load rkb-dataset-root-remap.json beside '
            '--registry; pass none to explicitly build from immutable sealed source paths without a remap.'
        ),
    )

    remap = subparsers.add_parser('create-root-remap')
    add_storage_args(remap)
    remap.add_argument('--source-root', required=True)
    remap.add_argument('--target-root', required=True)
    remap.add_argument(
        '--sidecar',
        default='',
        help='Immutable sidecar output. Defaults beside --registry as rkb-dataset-root-remap.json.',
    )


def create_root_remap(args: argparse.Namespace) -> dict[str, Any]:
    batches_root = Path(args.batches_root).resolve()
    registry_path = Path(args.registry).resolve()
    baseline_path = Path(args.baseline).resolve()
    sidecar_value = str(args.sidecar or '').strip()
    sidecar_path = (
        Path(sidecar_value).resolve()
        if sidecar_value
        else registry_path.with_name(ROOT_REMAP_FILE_NAME)
    )
    remap = create_root_remap_sidecar(
        batches_root=batches_root,
        source_root=Path(args.source_root),
        target_root=Path(args.target_root),
        sidecar_path=sidecar_path,
        baseline_path=baseline_path,
    )
    return {
        'sidecar': str(sidecar_path),
        'lockSha256': remap['lockSha256'],
        'sourceRoot': remap['sourceRoot'],
        'targetRoot': remap['targetRoot'],
        'sourceRegistrySha256': remap['sourceRegistrySha256'],
        'sourceTrackCount': remap['sourceTrackCount'],
    }
