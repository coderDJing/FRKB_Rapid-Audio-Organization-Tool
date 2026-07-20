from __future__ import annotations

import json
import unittest
from pathlib import Path

import numpy as np

from rkb_official_downbeat_selector import (
    PRESET_WEIGHTS,
    build_downbeat_rotation_evidence,
    score_downbeat_rotations,
    select_downbeat_rotation,
    select_downbeat_rotation_with_linear_model,
)


def _synthetic_arrays(*, target_rotation: int) -> dict[str, np.ndarray]:
    duration_sec = 64.0
    logit_rate = 50
    attack_rate = 400
    beat_logits = np.full(int(duration_sec * logit_rate) + 1, -4.0, dtype="float32")
    downbeat_logits = np.full_like(beat_logits, -5.0)
    full_attack = np.zeros(int(duration_sec * attack_rate) + 1, dtype="float32")
    low_attack = np.zeros_like(full_attack)
    for beat_index in range(int(duration_sec * 2.0)):
        time_sec = beat_index * 0.5
        logit_index = int(round(time_sec * logit_rate))
        attack_index = int(round(time_sec * attack_rate))
        beat_logits[logit_index] = 4.0
        full_attack[attack_index] = 1.0
        low_attack[attack_index] = 1.0
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


class OfficialDownbeatSelectorTest(unittest.TestCase):
    def test_all_presets_recover_known_rotation(self) -> None:
        evidence = build_downbeat_rotation_evidence(
            arrays=_synthetic_arrays(target_rotation=2),
            bpm=120.0,
            first_beat_ms=0.0,
            duration_sec=64.0,
        )
        self.assertTrue(evidence["valid"])
        for preset in PRESET_WEIGHTS:
            scores = score_downbeat_rotations(evidence, preset=preset)
            self.assertEqual(int(np.argmax(scores)), 2, preset)

    def test_selector_only_rotates_when_evidence_clears_guards(self) -> None:
        evidence = build_downbeat_rotation_evidence(
            arrays=_synthetic_arrays(target_rotation=3),
            bpm=120.0,
            first_beat_ms=0.0,
            duration_sec=64.0,
        )
        selected = select_downbeat_rotation(
            evidence=evidence,
            current_rotation=1,
            preset="rekordbox-envelope",
        )
        self.assertTrue(selected["applied"])
        self.assertEqual(selected["selectedRotation"], 3)

        guarded = select_downbeat_rotation(
            evidence=evidence,
            current_rotation=1,
            preset="rekordbox-envelope",
            minimum_advantage=100.0,
        )
        self.assertFalse(guarded["applied"])
        self.assertEqual(guarded["selectedRotation"], 1)

    def test_invalid_grid_preserves_current_rotation(self) -> None:
        evidence = build_downbeat_rotation_evidence(
            arrays={},
            bpm=0.0,
            first_beat_ms=0.0,
            duration_sec=0.0,
        )
        selected = select_downbeat_rotation(
            evidence=evidence,
            current_rotation=6,
            preset="fixed-grid-likelihood",
        )
        self.assertFalse(selected["applied"])
        self.assertEqual(selected["selectedRotation"], 2)

    def test_frozen_linear_candidate_uses_the_same_feature_contract(self) -> None:
        artifact = json.loads(
            Path("scripts/models/rkb-official-downbeat-rotation-candidate-v1.json").read_text(
                encoding="utf-8"
            )
        )
        evidence = build_downbeat_rotation_evidence(
            arrays=_synthetic_arrays(target_rotation=2),
            bpm=120.0,
            first_beat_ms=0.0,
            duration_sec=64.0,
        )
        selected = select_downbeat_rotation_with_linear_model(
            evidence=evidence,
            current_rotation=0,
            artifact=artifact,
        )
        self.assertEqual(selected["evidenceTopRotation"], 2)
        self.assertEqual(selected["selectedRotation"], 2)


if __name__ == "__main__":
    unittest.main()
