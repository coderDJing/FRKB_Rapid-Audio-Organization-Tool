import unittest

from rkb_multiscale_usable_grid_freeze import _modal_fold_config


def _config(config_id: str, family: str, mode: str, threshold: float) -> dict:
    return {
        "configId": config_id,
        "family": family,
        "l2": 1.0,
        "mode": mode,
        "threshold": threshold,
    }


class UsableGridFreezeTests(unittest.TestCase):
    def test_modal_exact_config_is_selected_without_outer_metrics(self) -> None:
        configs = [
            _config("multi", "multiscale", "ranked-top16", 1.1),
            _config("multi", "multiscale", "ranked-top16", 1.1),
            _config("multi", "multiscale", "ranked-top16", 1.1),
            _config("base", "base", "ranked-top16", 1.1),
            _config("base", "base", "ranked-top16", 1.1),
            _config("same-mod", "multiscale", "ranked-top16-same-mod4", 1.1),
        ]
        selected, counts = _modal_fold_config(configs)
        self.assertEqual(selected["configId"], "multi")
        self.assertEqual(selected["selectedFoldCount"], 3)
        self.assertEqual(counts["base"], 2)

    def test_baseline_only_study_cannot_be_frozen(self) -> None:
        with self.assertRaises(RuntimeError):
            _modal_fold_config([{"configId": "baseline", "family": "baseline"}])


if __name__ == "__main__":
    unittest.main()
