import unittest

import numpy as np

from rkb_official_phase_selector import (
    build_high_attack_envelope,
    build_phase_trajectories,
    candidate_phase_evidence,
    stable_range_residual,
)


class OfficialPhaseSelectorTests(unittest.TestCase):
    def test_high_attack_envelope_suppresses_low_frequency_tone(self) -> None:
        sample_rate = 11025
        times = np.arange(sample_rate, dtype="float64") / sample_rate
        signal = np.sin(2.0 * np.pi * 200.0 * times)
        burst = (times >= 0.45) & (times <= 0.55)
        signal[burst] += np.sin(2.0 * np.pi * 3000.0 * times[burst])
        envelope, output_rate = build_high_attack_envelope(signal, sample_rate=sample_rate)
        self.assertEqual(output_rate, 4000)
        burst_mean = float(np.mean(envelope[int(0.46 * output_rate) : int(0.54 * output_rate)]))
        quiet_mean = float(np.mean(envelope[int(0.10 * output_rate) : int(0.30 * output_rate)]))
        self.assertGreater(burst_mean, quiet_mean * 5.0)

    def test_attack_trajectory_finds_positive_grid_shift(self) -> None:
        frame_rate = 4000.0
        duration_sec = 20.0
        values = np.zeros(int(frame_rate * duration_sec), dtype="float64")
        interval_sec = 0.5
        for beat_index in range(1, 39):
            center = int(round((beat_index * interval_sec + 0.006) * frame_rate))
            values[center : center + 4] = 1.0
        evidence = candidate_phase_evidence(
            values,
            frame_rate=frame_rate,
            bpm=120.0,
            first_beat_ms=0.0,
            duration_sec=duration_sec,
        )
        self.assertTrue(evidence["valid"])
        self.assertGreaterEqual(float(evidence["argmaxShiftMs"]), 5.0)
        self.assertLessEqual(float(evidence["argmaxShiftMs"]), 7.0)
        self.assertGreaterEqual(float(evidence["selectedShiftMs"]), 0.0)
        self.assertLessEqual(float(evidence["selectedShiftMs"]), 7.0)

    def test_mod4_trajectories_keep_four_independent_groups(self) -> None:
        frame_rate = 4000.0
        duration_sec = 20.0
        values = np.zeros(int(frame_rate * duration_sec), dtype="float64")
        for beat_index in range(1, 39):
            offset_sec = 0.010 if beat_index % 4 == 0 else 0.004
            center = int(round((beat_index * 0.5 + offset_sec) * frame_rate))
            values[center : center + 3] = 1.0
        trajectories = build_phase_trajectories(
            values,
            frame_rate=frame_rate,
            bpm=120.0,
            first_beat_ms=0.0,
            duration_sec=duration_sec,
        )
        self.assertGreaterEqual(int(trajectories["overallSupport"]), 32)
        self.assertEqual(len(trajectories["mod4"]), 4)
        self.assertTrue(all(int(value) >= 8 for value in trajectories["mod4Support"]))
        peaks = [int(np.argmax(values)) for values in trajectories["mod4"]]
        self.assertGreater(max(peaks) - min(peaks), 12)

    def test_stable_range_recovers_mean_residual(self) -> None:
        beats = [round(0.006 + index * 0.5, 6) for index in range(40)]
        metadata = {
            "beatThis": {
                "windows": [
                    {
                        "windowIndex": 0,
                        "windowStartSec": 0.0,
                        "rawBpm": 120.0,
                        "beats": beats,
                    }
                ]
            }
        }
        result = stable_range_residual(metadata, bpm=120.0, first_beat_ms=0.0)
        self.assertTrue(result["valid"])
        self.assertEqual(int(result["stableLength"]), 40)
        self.assertAlmostEqual(float(result["meanResidualMs"]), 6.0, places=3)
        self.assertAlmostEqual(float(result["residualMadMs"]), 0.0, places=3)


if __name__ == "__main__":
    unittest.main()
