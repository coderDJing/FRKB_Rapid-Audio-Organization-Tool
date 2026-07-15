import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("convert_legacy_grid_truth_to_v2.py")
SPEC = importlib.util.spec_from_file_location("legacy_truth_v2_converter", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load legacy truth v2 converter")
CONVERTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONVERTER)


class LegacyTruthV2ConverterTests(unittest.TestCase):
    def test_builds_a_signed_v2_derivative_without_mutating_source(self) -> None:
        source_payload = {
            "schemaVersion": 1,
            "source": {"type": "manual-truth"},
            "tracks": [
                {
                    "fileName": "fixture.mp3",
                    "bpm": 128,
                    "firstBeatMs": 125,
                    "barBeatOffset": 7,
                    "label": "keep-me",
                }
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "legacy.json"
            source_path.write_text(json.dumps(source_payload), encoding="utf-8")
            source_before = source_path.read_bytes()

            converted = CONVERTER._build_output(source_path, source_payload, "manual")

            self.assertEqual(source_before, source_path.read_bytes())
            self.assertEqual(converted["schemaVersion"], 2)
            self.assertEqual(converted["trackCount"], 1)
            self.assertEqual(converted["provenance"]["sourceSchemaVersion"], 1)
            track = converted["tracks"][0]
            self.assertEqual(track["label"], "keep-me")
            self.assertNotIn("bpm", track)
            self.assertNotIn("firstBeatMs", track)
            self.assertNotIn("barBeatOffset", track)
            grid = track["beatGridMap"]
            clip = grid["clips"][0]
            self.assertEqual(clip["downbeatBeatOffset"], 3)
            self.assertEqual(grid["signature"], CONVERTER._map_signature(clip))

    def test_rejects_tracks_without_a_downbeat_phase(self) -> None:
        with self.assertRaisesRegex(ValueError, "downbeatBeatOffset/barBeatOffset"):
            CONVERTER._convert_track({"bpm": 128, "firstBeatMs": 0}, 0, "manual")


if __name__ == "__main__":
    unittest.main()
