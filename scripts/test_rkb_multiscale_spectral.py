import unittest

import numpy as np

from rkb_multiscale_spectral import (
    DEFAULT_BANDS_HZ,
    DEFAULT_FRAME_LENGTHS,
    DEFAULT_SAMPLE_RATE,
    build_multiscale_spectral_flux,
    mix_to_mono,
)


class MultiscaleSpectralTests(unittest.TestCase):
    def test_mix_to_mono_averages_channels(self) -> None:
        signal = np.asarray([[1.0, -1.0], [0.5, 0.25]], dtype="float32")
        mono = mix_to_mono(signal)
        np.testing.assert_allclose(mono, np.asarray([0.0, 0.375], dtype="float32"))

    def test_all_scales_and_bands_are_time_aligned(self) -> None:
        signal = np.zeros((DEFAULT_SAMPLE_RATE * 2, 2), dtype="float32")
        signal[DEFAULT_SAMPLE_RATE // 2 : DEFAULT_SAMPLE_RATE // 2 + 8, :] = 1.0
        envelopes, frame_rate = build_multiscale_spectral_flux(signal, DEFAULT_SAMPLE_RATE)
        self.assertAlmostEqual(frame_rate, 100.0)
        self.assertEqual(len(envelopes), len(DEFAULT_FRAME_LENGTHS) * len(DEFAULT_BANDS_HZ))
        lengths = {values.size for values in envelopes.values()}
        self.assertEqual(len(lengths), 1)
        self.assertGreater(next(iter(lengths)), 190)
        self.assertGreater(max(float(np.max(values)) for values in envelopes.values()), 0.5)

    def test_constant_silence_produces_zero_flux(self) -> None:
        signal = np.zeros((DEFAULT_SAMPLE_RATE, 1), dtype="float32")
        envelopes, _ = build_multiscale_spectral_flux(signal, DEFAULT_SAMPLE_RATE)
        self.assertTrue(envelopes)
        for values in envelopes.values():
            self.assertEqual(float(np.max(values)), 0.0)

    def test_rejects_unlocked_sample_rate(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires 44100 Hz"):
            build_multiscale_spectral_flux(np.zeros(22050, dtype="float32"), 22050)


if __name__ == "__main__":
    unittest.main()
