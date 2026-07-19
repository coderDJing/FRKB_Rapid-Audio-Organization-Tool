import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import beat_this_runtime_constant_grid as runtime
from rkb_beatgrid_feature_cache import _write_feature_arrays
from rkb_constant_grid_dp_solver import _apply_official_phase_refiner


class OfficialPhaseProductionTests(unittest.TestCase):
    def _high_attack(self) -> tuple[np.ndarray, float]:
        frame_rate = 4000.0
        duration_sec = 20.0
        values = np.zeros(int(frame_rate * duration_sec), dtype="float64")
        for beat_index in range(1, 39):
            center = int(round((beat_index * 0.5 + 0.006) * frame_rate))
            values[center : center + 4] = 1.0
        return values, frame_rate

    def test_solver_refiner_moves_selected_fixed_grid(self) -> None:
        values, frame_rate = self._high_attack()
        selected = {
            "bpm": 120.0,
            "firstBeatMs": 0.0,
            "barBeatOffset": 0,
            "score": 0.9,
            "features": {},
        }
        refined, meta = _apply_official_phase_refiner(
            selected=selected,
            arrays={
                "officialHighAttackEnvelope": values,
                "officialHighAttackSampleRate": np.asarray(frame_rate),
            },
            duration_sec=20.0,
        )
        self.assertTrue(meta["applied"])
        self.assertGreater(float(refined["firstBeatMs"]), 0.0)
        self.assertLessEqual(float(refined["firstBeatMs"]), 7.0)
        self.assertTrue(refined["features"]["officialHighAttackPhaseApplied"])

    def test_solver_refiner_preserves_grid_without_high_attack(self) -> None:
        selected = {"bpm": 120.0, "firstBeatMs": 4.0, "features": {}}
        refined, meta = _apply_official_phase_refiner(
            selected=selected,
            arrays={},
            duration_sec=20.0,
        )
        self.assertIs(refined, selected)
        self.assertFalse(meta["applied"])
        self.assertEqual(meta["reason"], "missing-high-attack-envelope")

    def test_runtime_returns_refined_legacy_result(self) -> None:
        solver_result = {
            "gridSolverSelectedSource": "constant-grid-dp:legacy-fallback",
            "gridSolverFeatures": {"officialHighAttackPhaseApplied": True},
            "firstBeatMs": 6.0,
        }
        with patch.object(runtime, "_runtime_arrays", return_value={}), patch.object(
            runtime,
            "solve_constant_grid_dp",
            return_value=solver_result,
        ):
            result = runtime.try_solve_runtime_constant_grid_dp(
                prepared_windows=[],
                signal=np.zeros((128, 2), dtype="float32"),
                sample_rate=44100,
                duration_sec=1.0,
                tuning={},
                legacy_result={"beatCoverageScore": 0.5},
                predictor=object(),
                cpu_spect=None,
                device="cpu",
                time_basis=None,
            )
        self.assertIsNotNone(result)
        self.assertEqual(result["firstBeatMs"], 6.0)
        self.assertEqual(result["beatCoverageScore"], 0.5)

    def test_feature_cache_writes_high_attack_arrays(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "arrays.npz"
            _write_feature_arrays(
                arrays_path=path,
                beat_logits=np.zeros(4),
                downbeat_logits=np.zeros(4),
                full_attack=np.zeros(4),
                full_attack_rate=4000,
                lowrate_attack=np.zeros(4),
                lowrate_attack_rate=800,
                high_attack=np.ones(4),
                high_attack_rate=4000,
            )
            with np.load(path, allow_pickle=False) as arrays:
                self.assertIn("officialHighAttackEnvelope", arrays.files)
                self.assertEqual(int(arrays["officialHighAttackSampleRate"].item()), 4000)


if __name__ == "__main__":
    unittest.main()
