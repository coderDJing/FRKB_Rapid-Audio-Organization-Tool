import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable

from rkb_dataset_contract import (
    DatasetContractError,
    build_benchmark_provenance,
    build_dataset_lock,
    build_derived_shard_metadata,
    normalize_path,
    registry_content_sha256,
    registry_stable_content_sha256,
    sha256_file,
    sha256_json,
    split_roster_sha256,
    validate_benchmark_provenance,
    validate_dataset_lock,
    validate_truth_contract,
)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


class _ContractFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def build_parent_split(
        self,
    ) -> tuple[Path, dict[str, Any], Path, dict[str, Any]]:
        audio_root = self.root / 'audio'
        audio_root.mkdir(parents=True, exist_ok=True)
        tracks: list[dict[str, Any]] = []
        registry_tracks: list[dict[str, Any]] = []
        families: list[dict[str, Any]] = []
        for index, label in enumerate(('alpha', 'beta'), start=1):
            source_path = audio_root / f'{label}.wav'
            source_path.write_bytes(f'audio-{label}'.encode('utf-8'))
            asset_sha256 = sha256_file(source_path)
            batch_id = f'batch-{index}'
            assignment_key = f'assignment-{index}'
            isolation_family_id = f'isolation-{index}'
            track = {
                'instanceId': f'{batch_id}:{asset_sha256}',
                'batchId': batch_id,
                'fileName': source_path.name,
                'title': label.title(),
                'artist': 'Contract Tester',
                'bpm': 120.0 + index,
                'firstBeatMs': float(index * 10),
                'familyId': f'family-{index}',
                'isolationFamilyId': isolation_family_id,
                'assignmentKey': assignment_key,
                'assetSha256': asset_sha256,
                'pcmSha256': _sha256_bytes(f'pcm-{label}'.encode('utf-8')),
                'sourcePath': str(source_path.resolve()),
            }
            tracks.append(track)
            registry_tracks.append(
                {
                    'batchId': batch_id,
                    'fileName': source_path.name,
                    'assetSha256': asset_sha256,
                    'pcmSha256': track['pcmSha256'],
                    'familyId': track['familyId'],
                    'sourcePath': track['sourcePath'],
                    'batchStatus': 'consumed',
                }
            )
            families.append(
                {
                    'isolationFamilyId': isolation_family_id,
                    'assignmentKey': assignment_key,
                    'split': 'train',
                }
            )

        registry_path = self.root / 'rkb-dataset-registry.json'
        registry = {
            'schemaVersion': 1,
            'generatedAt': '2026-07-10T00:00:00Z',
            'tracks': registry_tracks,
        }
        _write_json(registry_path, registry)

        source_truth_path = self.root / 'source-truth.json'
        source_truth = {'type': 'rkb-rekordbox-truth', 'tracks': copy.deepcopy(tracks)}
        _write_json(source_truth_path, source_truth)
        truth_sources = [
            {
                'batchId': 'source-batch',
                'path': str(source_truth_path.resolve()),
                'sha256': sha256_file(source_truth_path),
                'trackCount': len(tracks),
            }
        ]
        truth_sources_sha256 = sha256_json(truth_sources)

        parent_path = self.root / 'dataset-splits.json'
        parent = {
            'type': 'rkb-rekordbox-dataset-splits',
            'version': 4,
            'seed': 'contract-test-seed',
            'truthSources': truth_sources,
            'truthSourcesSha256': truth_sources_sha256,
            'registryPath': str(registry_path.resolve()),
            'registrySha256': registry_content_sha256(registry),
            'assignmentDigestSha256': _sha256_bytes(b'assignment-digest'),
            'splitAssignmentsSha256': _sha256_bytes(b'split-assignments'),
            'audioIsolationPolicySha256': _sha256_bytes(b'audio-isolation-policy'),
            'splitPolicy': {'tuneRatio': 0.2, 'holdoutRatio': 0.2},
            'summary': {'trackCount': len(tracks), 'train': len(tracks), 'tune': 0, 'holdout': 0},
            'instances': copy.deepcopy(tracks),
            'families': families,
        }
        _write_json(parent_path, parent)

        parent_split = {
            'parentSplitPath': str(parent_path.resolve()),
            'parentSplitFileSha256': sha256_file(parent_path),
            'splitRosterSha256': split_roster_sha256(tracks),
            'registrySha256': parent['registrySha256'],
            'truthSourcesSha256': truth_sources_sha256,
            'seed': parent['seed'],
            'tuneRatio': parent['splitPolicy']['tuneRatio'],
            'holdoutRatio': parent['splitPolicy']['holdoutRatio'],
            'assignmentDigestSha256': parent['assignmentDigestSha256'],
            'splitAssignmentsSha256': parent['splitAssignmentsSha256'],
            'audioIsolationPolicySha256': parent['audioIsolationPolicySha256'],
        }
        truth_path = self.root / 'dataset-splits-train-truth.json'
        truth = {
            'type': 'rkb-rekordbox-truth-split',
            'version': 4,
            'split': 'train',
            'trackCount': len(tracks),
            'truthSources': truth_sources,
            'parentSplit': parent_split,
            'tracks': copy.deepcopy(tracks),
        }
        _write_json(truth_path, truth)
        return truth_path, truth, parent_path, parent

    def build_derived_shard(
        self,
    ) -> tuple[Path, dict[str, Any], Path, dict[str, Any]]:
        source_truth_path, source_payload, _, _ = self.build_parent_split()
        source_contract = validate_truth_contract(source_truth_path)
        shard_tracks = copy.deepcopy(source_payload['tracks'][:1])
        shard_payload = {
            'type': 'rkb-rekordbox-truth-shard',
            'version': 1,
            'trackCount': len(shard_tracks),
            'parentSplit': copy.deepcopy(source_payload['parentSplit']),
            'derivedShard': build_derived_shard_metadata(
                source_truth_path=source_truth_path,
                source_contract=source_contract,
                tracks=shard_tracks,
                shard_index=0,
                shard_count=2,
            ),
            'tracks': shard_tracks,
        }
        shard_path = self.root / 'dataset-splits-train-truth-shard-1.json'
        _write_json(shard_path, shard_payload)
        return shard_path, shard_payload, source_truth_path, source_contract

    def build_sealed_dataset(
        self,
    ) -> tuple[Path, dict[str, Any], dict[str, Any], Path, dict[str, Any]]:
        audio_path = self.root / 'sealed-audio.wav'
        audio_path.write_bytes(b'sealed-audio-content')
        asset_sha256 = sha256_file(audio_path)
        pcm_sha256 = _sha256_bytes(b'sealed-pcm')
        fingerprint_sha256 = _sha256_bytes(b'sealed-fingerprint')
        batch_id = 'sealed-batch'
        registry_path = self.root / 'rkb-dataset-registry.json'
        registry = {
            'schemaVersion': 1,
            'generatedAt': '2026-07-10T00:00:00Z',
            'tracks': [
                {
                    'batchId': batch_id,
                    'batchStatus': 'fresh',
                    'fileName': audio_path.name,
                    'assetSha256': asset_sha256,
                    'pcmSha256': pcm_sha256,
                    'fingerprintSha256': fingerprint_sha256,
                    'familyId': f'chromaprint:{fingerprint_sha256}',
                    'sourcePath': str(audio_path.resolve()),
                }
            ],
        }
        _write_json(registry_path, registry)
        manifest = {
            'schemaVersion': 1,
            'type': 'rkb-sealed-batch-manifest',
            'batchId': batch_id,
            'truth': {'sha256': _sha256_bytes(b'sealed-truth')},
            'audio': {'rosterHash': _sha256_bytes(b'sealed-roster')},
            'audioRoster': [
                {
                    'fileName': audio_path.name,
                    'size': audio_path.stat().st_size,
                    'assetSha256': asset_sha256,
                    'pcmSha256': pcm_sha256,
                    'fingerprintSha256': fingerprint_sha256,
                    'familyId': f'chromaprint:{fingerprint_sha256}',
                }
            ],
        }
        lock = build_dataset_lock(
            registry_path=registry_path,
            registry=registry,
            manifest=manifest,
        )
        return registry_path, registry, manifest, audio_path, lock

    def build_benchmark_inputs(
        self,
    ) -> tuple[Path, dict[str, Any], dict[str, Path]]:
        truth_path = self.root / 'benchmark-truth.json'
        source_path = self.root / 'benchmark-audio.wav'
        source_path.write_bytes(b'benchmark-audio')
        asset_sha256 = sha256_file(source_path)
        truth = {
            'type': 'rkb-rekordbox-truth',
            'tracks': [
                {
                    'instanceId': f'benchmark-batch:{asset_sha256}',
                    'batchId': 'benchmark-batch',
                    'fileName': source_path.name,
                    'assetSha256': asset_sha256,
                    'pcmSha256': _sha256_bytes(b'benchmark-pcm'),
                    'familyId': 'benchmark-family',
                    'isolationFamilyId': 'benchmark-isolation-family',
                    'assignmentKey': 'benchmark-assignment',
                    'sourcePath': str(source_path.resolve()),
                    'bpm': 128.0,
                }
            ],
        }
        _write_json(truth_path, truth)
        ffmpeg_path = self.root / 'ffmpeg.exe'
        ffprobe_path = self.root / 'ffprobe.exe'
        ffmpeg_path.write_bytes(b'ffmpeg-test-binary')
        ffprobe_path.write_bytes(b'ffprobe-test-binary')
        feature_cache_dir = self.root / 'feature-cache'
        feature_cache_dir.mkdir()
        (feature_cache_dir / 'index.json').write_text('{}\n', encoding='utf-8')
        prediction_cache_dir = self.root / 'prediction-cache'
        prediction_cache_dir.mkdir()
        return truth_path, truth, {
            'ffmpeg': ffmpeg_path,
            'ffprobe': ffprobe_path,
            'feature_cache': feature_cache_dir,
            'prediction_cache': prediction_cache_dir,
        }


class ParentSplitContractTests(unittest.TestCase):
    def test_valid_parent_split_contract_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            truth_path, truth, parent_path, _ = _ContractFixture(
                Path(temp_dir)
            ).build_parent_split()

            contract = validate_truth_contract(truth_path)

            self.assertEqual(contract['trackCount'], truth['trackCount'])
            self.assertEqual(contract['parentSplitPath'], normalize_path(parent_path))
            self.assertEqual(contract['parentSplitFileSha256'], sha256_file(parent_path))
            self.assertFalse(contract['derivedShard'])

    def test_parent_file_sha_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            truth_path, _, parent_path, parent = _ContractFixture(
                Path(temp_dir)
            ).build_parent_split()
            parent['unexpectedMutation'] = True
            _write_json(parent_path, parent)

            with self.assertRaisesRegex(DatasetContractError, 'parent split file SHA256 mismatch'):
                validate_truth_contract(truth_path)

    def test_parent_roster_ratio_assignment_and_source_path_drift_are_rejected(self) -> None:
        mutations: list[tuple[str, Callable[[dict[str, Any]], None], str]] = [
            (
                'split-roster',
                lambda payload: payload['parentSplit'].update(splitRosterSha256='0' * 64),
                'roster SHA256 mismatch',
            ),
            (
                'ratio',
                lambda payload: payload['parentSplit'].update(tuneRatio=0.25),
                'parentSplit tuneRatio mismatch',
            ),
            (
                'assignment',
                lambda payload: payload['tracks'][0].update(assignmentKey='mutated-assignment'),
                'assignmentKey mismatch',
            ),
            (
                'source-path',
                lambda payload: payload['tracks'][0].update(
                    sourcePath=str(
                        Path(payload['tracks'][0]['sourcePath']).with_name('replacement.wav')
                    )
                ),
                'sourcePath mismatch',
            ),
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for label, mutate, expected_error in mutations:
                with self.subTest(label=label):
                    truth_path, truth, _, _ = _ContractFixture(root / label).build_parent_split()
                    mutate(truth)
                    _write_json(truth_path, truth)
                    with self.assertRaisesRegex(DatasetContractError, expected_error):
                        validate_truth_contract(truth_path)


class DerivedShardContractTests(unittest.TestCase):
    def test_valid_derived_shard_subset_and_provenance_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            shard_path, shard, source_path, source_contract = _ContractFixture(
                Path(temp_dir)
            ).build_derived_shard()

            contract = validate_truth_contract(shard_path)

            self.assertTrue(contract['derivedShard'])
            self.assertEqual(contract['trackCount'], shard['trackCount'])
            self.assertEqual(contract['sourceTruthPath'], normalize_path(source_path))
            self.assertEqual(
                contract['sourceTruthContractSha256'], source_contract['contractSha256']
            )

    def test_derived_shard_non_identical_subset_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            shard_path, shard, source_path, source_contract = _ContractFixture(
                Path(temp_dir)
            ).build_derived_shard()
            shard['tracks'][0]['familyId'] = 'mutated-family'
            shard['derivedShard'] = build_derived_shard_metadata(
                source_truth_path=source_path,
                source_contract=source_contract,
                tracks=shard['tracks'],
                shard_index=0,
                shard_count=2,
            )
            _write_json(shard_path, shard)

            with self.assertRaisesRegex(DatasetContractError, 'not identical to source'):
                validate_truth_contract(shard_path)

    def test_derived_shard_provenance_tampering_is_rejected(self) -> None:
        mutations: list[tuple[str, str]] = [
            ('sourceTruthSha256', 'source SHA256 mismatch'),
            ('sourceTruthContractSha256', 'source contract mismatch'),
            ('sourceRosterSha256', 'source roster mismatch'),
            ('shardRosterSha256', 'shard roster SHA256 mismatch'),
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for field, expected_error in mutations:
                with self.subTest(field=field):
                    shard_path, shard, _, _ = _ContractFixture(root / field).build_derived_shard()
                    shard['derivedShard'][field] = '0' * 64
                    _write_json(shard_path, shard)
                    with self.assertRaisesRegex(DatasetContractError, expected_error):
                        validate_truth_contract(shard_path)


class DatasetLockContractTests(unittest.TestCase):
    def test_valid_dataset_lock_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_path, registry, manifest, _, lock = _ContractFixture(
                Path(temp_dir)
            ).build_sealed_dataset()

            locked = validate_dataset_lock(
                lock,
                registry_path=registry_path,
                registry=registry,
                manifest=manifest,
            )

            self.assertEqual(locked['batchId'], manifest['batchId'])
            self.assertEqual(locked['registryBatchTrackCount'], 1)
            self.assertEqual(
                locked['registryStableContentSha256'],
                registry_stable_content_sha256(registry),
            )

    def test_registry_generated_time_and_lifecycle_status_drift_do_not_break_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_path, registry, manifest, _, lock = _ContractFixture(
                Path(temp_dir)
            ).build_sealed_dataset()
            registry['generatedAt'] = '2026-07-10T00:01:00Z'
            registry['tracks'][0]['batchStatus'] = 'exposed'
            _write_json(registry_path, registry)

            validate_dataset_lock(
                lock,
                registry_path=registry_path,
                registry=registry,
                manifest=manifest,
            )

    def test_registry_source_path_identity_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            registry_path, registry, manifest, audio_path, lock = _ContractFixture(
                root
            ).build_sealed_dataset()
            replacement = root / 'same-audio-at-another-path.wav'
            replacement.write_bytes(audio_path.read_bytes())
            registry['tracks'][0]['sourcePath'] = str(replacement.resolve())
            _write_json(registry_path, registry)

            with self.assertRaisesRegex(DatasetContractError, 'no longer matches'):
                validate_dataset_lock(
                    lock,
                    registry_path=registry_path,
                    registry=registry,
                    manifest=manifest,
                )

    def test_registry_source_path_file_replacement_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_path, registry, manifest, audio_path, lock = _ContractFixture(
                Path(temp_dir)
            ).build_sealed_dataset()
            audio_path.write_bytes(b'replaced-audio-content')

            with self.assertRaisesRegex(DatasetContractError, 'asset SHA256 mismatch'):
                validate_dataset_lock(
                    lock,
                    registry_path=registry_path,
                    registry=registry,
                    manifest=manifest,
                )


class BenchmarkProvenanceContractTests(unittest.TestCase):
    @staticmethod
    def _build_provenance(
        truth_contract: dict[str, Any],
        paths: dict[str, Path],
        *,
        solver: str = 'constant-grid-dp',
        device: str = 'cpu',
    ) -> dict[str, Any]:
        return build_benchmark_provenance(
            truth_contract=truth_contract,
            solver=solver,
            device=device,
            audio_root=str(paths['feature_cache'].parent / 'audio-root'),
            ffmpeg_path=paths['ffmpeg'],
            ffprobe_path=paths['ffprobe'],
            feature_cache_dir=paths['feature_cache'],
            prediction_cache_dir=paths['prediction_cache'],
            prediction_cache_enabled=True,
        )

    def test_valid_benchmark_provenance_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            truth_path, _, paths = _ContractFixture(Path(temp_dir)).build_benchmark_inputs()
            truth_contract = validate_truth_contract(truth_path)
            provenance = self._build_provenance(truth_contract, paths)

            validate_benchmark_provenance(provenance, provenance)

    def test_truth_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            truth_path, truth, paths = _ContractFixture(Path(temp_dir)).build_benchmark_inputs()
            original = self._build_provenance(validate_truth_contract(truth_path), paths)
            truth['tracks'][0]['bpm'] = 129.0
            _write_json(truth_path, truth)
            expected_after_drift = self._build_provenance(
                validate_truth_contract(truth_path), paths
            )

            with self.assertRaisesRegex(DatasetContractError, 'does not match truth/solver/config'):
                validate_benchmark_provenance(original, expected_after_drift)

    def test_configuration_and_solver_drift_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            truth_path, _, paths = _ContractFixture(Path(temp_dir)).build_benchmark_inputs()
            truth_contract = validate_truth_contract(truth_path)
            original = self._build_provenance(truth_contract, paths)
            drifted = {
                'configuration': self._build_provenance(
                    truth_contract, paths, device='cuda'
                ),
                'solver': self._build_provenance(
                    truth_contract, paths, solver='legacy'
                ),
            }
            for label, expected in drifted.items():
                with self.subTest(label=label):
                    with self.assertRaisesRegex(
                        DatasetContractError, 'does not match truth/solver/config'
                    ):
                        validate_benchmark_provenance(original, expected)


if __name__ == '__main__':
    unittest.main()
