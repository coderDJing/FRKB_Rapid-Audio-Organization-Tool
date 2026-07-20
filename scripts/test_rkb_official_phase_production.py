import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import beat_this_runtime_constant_grid as runtime
from rkb_beatgrid_feature_cache import _write_feature_arrays
from rkb_constant_grid_dp_solver import (
    _apply_official_downbeat_selector,
    _apply_official_phase_refiner,
    _candidate_is_within_bpm_range,
)


class OfficialPhaseProductionTests(unittest.TestCase):
    def test_legacy_candidate_outside_configured_range_is_not_eligible(self) -> None:
        candidate = {"bpm": 135.0, "firstBeatMs": 12.0, "barBeatOffset": 0}
        self.assertFalse(_candidate_is_within_bpm_range(candidate, 58.0, 115.0))
        self.assertTrue(_candidate_is_within_bpm_range(candidate, 70.0, 180.0))

    def _high_attack(self) -> tuple[np.ndarray, float]:
        frame_rate = 4000.0
        duration_sec = 20.0
        values = np.zeros(int(frame_rate * duration_sec), dtype="float64")
        for beat_index in range(1, 39):
            center = int(round((beat_index * 0.5 + 0.006) * frame_rate))
            values[center : center + 4] = 1.0
        return values, frame_rate

    def _downbeat_arrays(self, target_rotation: int) -> dict[str, np.ndarray]:
        duration_sec = 64.0
        logit_rate = 50
        attack_rate = 400
        beat_logits = np.full(int(duration_sec * logit_rate) + 1, -4.0, dtype="float32")
        downbeat_logits = np.full_like(beat_logits, -5.0)
        full_attack = np.zeros(int(duration_sec * attack_rate) + 1, dtype="float32")
        low_attack = np.zeros_like(full_attack)
        for beat_index in range(int(duration_sec * 2.0)):
            logit_index = int(round(beat_index * 0.5 * logit_rate))
            attack_index = int(round(beat_index * 0.5 * attack_rate))
            beat_logits[logit_index] = 4.0
            if beat_index % 4 == target_rotation:
                beat_logits[logit_index] = -2.0
                downbeat_logits[logit_index] = 6.0
                full_attack[attack_index] = 5.0
                low_attack[attack_index] = 7.0
        return {
            "beatLogits": beat_logits,
            "downbeatLogits": downbeat_logits,
            "beatLogitFrameRate": np.asarray(logit_rate, dtype="float32"),
            "downbeatLogitFrameRate": np.asarray(logit_rate, dtype="float32"),
            "fullAttackEnvelope": full_attack,
            "fullAttackSampleRate": np.asarray(attack_rate, dtype="int32"),
            "lowrateAttackEnvelope": low_attack,
            "lowrateAttackSampleRate": np.asarray(attack_rate, dtype="int32"),
        }

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

    def test_downbeat_selector_only_rotates_bar_ordinal(self) -> None:
        selected = {
            "bpm": 120.0,
            "firstBeatMs": 0.0,
            "barBeatOffset": 0,
            "score": 0.9,
            "features": {},
        }
        refined, meta = _apply_official_downbeat_selector(
            selected=selected,
            arrays=self._downbeat_arrays(target_rotation=2),
            duration_sec=64.0,
        )
        self.assertTrue(meta["applied"])
        self.assertEqual(refined["barBeatOffset"], 2)
        self.assertEqual(refined["bpm"], selected["bpm"])
        self.assertEqual(refined["firstBeatMs"], selected["firstBeatMs"])

    def test_downbeat_selector_preserves_candidate_without_logits(self) -> None:
        selected = {
            "bpm": 120.0,
            "firstBeatMs": 4.0,
            "barBeatOffset": 3,
            "features": {},
        }
        refined, meta = _apply_official_downbeat_selector(
            selected=selected,
            arrays={},
            duration_sec=20.0,
        )
        self.assertIs(refined, selected)
        self.assertFalse(meta["applied"])

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

    def test_runtime_passes_configured_bpm_range_to_solver(self) -> None:
        solver_result = {
            "gridSolverSelectedSource": "constant-grid-dp:test",
            "bpm": 88.0,
            "firstBeatMs": 0.0,
        }
        with patch.object(runtime, "_runtime_arrays", return_value={}), patch.object(
            runtime,
            "solve_constant_grid_dp",
            return_value=solver_result,
        ) as solve_mock:
            result = runtime.try_solve_runtime_constant_grid_dp(
                prepared_windows=[],
                signal=np.zeros((128, 2), dtype="float32"),
                sample_rate=44100,
                duration_sec=1.0,
                tuning={},
                legacy_result={},
                predictor=object(),
                cpu_spect=None,
                device="cpu",
                time_basis=None,
                min_bpm=88.0,
                max_bpm=175.0,
            )

        self.assertIsNotNone(result)
        solve_mock.assert_called_once()
        self.assertEqual(solve_mock.call_args.kwargs["arrays"], {})
        self.assertEqual(solve_mock.call_args.kwargs["min_bpm"], 88.0)
        self.assertEqual(solve_mock.call_args.kwargs["max_bpm"], 175.0)

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
