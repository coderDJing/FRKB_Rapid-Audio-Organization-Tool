import tempfile
import unittest
from pathlib import Path

from build_rkb_rekordbox_dataset_splits import build_splits
from rkb_dataset_relocation import ROOT_REMAP_FILE_NAME, create_root_remap_sidecar
from rkb_sealed_batch_common import build_registry_payload


class DatasetRelocationSplitTests(unittest.TestCase):
    def test_root_remap_rebuilds_paths_without_changing_split_membership(self) -> None:
        from test_build_rkb_rekordbox_dataset_splits import BuildRekordboxDatasetSplitsTest

        fixture = BuildRekordboxDatasetSplitsTest('runTest')
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            batches_root = root / 'sealed-batches'
            registry_path = root / 'rkb-dataset-registry.json'
            snapshot_a = fixture._write_sealed_batch(
                batches_root,
                'batch-a',
                [{'fileName': 'a.flac', 'bpm': 128.0}],
            )
            snapshot_b = fixture._write_sealed_batch(
                batches_root,
                'batch-b',
                [{'fileName': 'b.flac', 'bpm': 130.0}],
            )
            baseline = {'batches': [snapshot_a, snapshot_b]}
            source_registry = build_registry_payload(batches_root)
            fixture._write_json(registry_path, source_registry)
            before = build_splits(
                None,
                registry_path,
                batches_root=batches_root,
                authoritative_registry_payload=source_registry,
                baseline_payload=baseline,
                seed='test-seed',
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )
            target_root = root / 'relocated-database'
            target_root.mkdir()
            remap = create_root_remap_sidecar(
                batches_root=batches_root,
                source_root=batches_root,
                target_root=target_root,
                sidecar_path=registry_path.with_name(ROOT_REMAP_FILE_NAME),
            )
            mapped_registry = build_registry_payload(batches_root, root_remap=remap)
            fixture._write_json(registry_path, mapped_registry)

            after = build_splits(
                None,
                registry_path,
                batches_root=batches_root,
                baseline_payload=baseline,
                seed='test-seed',
                tune_ratio=0.2,
                holdout_ratio=0.2,
            )

            self.assertNotEqual(before['registrySha256'], after['registrySha256'])
            self.assertEqual(before['splitAssignmentsSha256'], after['splitAssignmentsSha256'])
            self.assertEqual(
                {row['instanceId'] for row in before['instances']},
                {row['instanceId'] for row in after['instances']},
            )
            self.assertEqual(
                {row['batchId']: set(row['holdout']) for row in before['leaveOneBatchOut']},
                {row['batchId']: set(row['holdout']) for row in after['leaveOneBatchOut']},
            )
            self.assertTrue(
                all(
                    Path(str(row['sourcePath'])).is_relative_to(target_root)
                    for row in after['instances']
                )
            )


if __name__ == '__main__':
    unittest.main()
