import json
import tempfile
import unittest
from pathlib import Path

from recover_rkb_new357_truth import (
    New357RecoveryError,
    build_recovered_truth,
    construct_new357_audio_paths,
    resolve_repo_output,
    truth_grid_from_bridge,
)


class RecoverNew357TruthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.sealed = self.root / "sealed-eval"
        self.conflicts = self.sealed / "_conflicts" / "sealed-intake-20260610"
        self.sealed.mkdir()
        self.conflicts.mkdir(parents=True)
        self.old = self.root / "old.json"
        self.test327 = self.root / "test327.json"
        self.test353 = self.root / "test353.json"

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def _write_truth(path: Path, names: list[str]) -> None:
        path.write_text(
            json.dumps({"source": {}, "tracks": [{"fileName": name} for name in names]}, indent=2),
            encoding="utf-8",
        )

    def _build_roster(self) -> list[Path]:
        self._write_truth(self.old, ["old.mp3"])
        self._write_truth(self.test327, ["test327.mp3"])
        self._write_truth(self.test353, ["test353.mp3"])
        for name in ["old.mp3", "test327.mp3", "test353.mp3", "new-a.mp3", "new-b.wav"]:
            (self.sealed / name).write_bytes(name.encode("utf-8"))
        for name in ["conflict-a.mp3", "conflict-b.mp3"]:
            (self.conflicts / name).write_bytes(name.encode("utf-8"))
        paths, _ = construct_new357_audio_paths(
            sealed_root=self.sealed,
            conflict_root=self.conflicts,
            old_benchmark=self.old,
            test327_truth=self.test327,
            test353_truth=self.test353,
            expected_old_count=1,
            expected_test327_count=1,
            expected_test353_count=1,
            expected_top_count=2,
            expected_conflict_count=2,
            expected_total_count=4,
        )
        return paths

    @staticmethod
    def _candidate(track_id: str, *, first_beat_ms: float = 25.0) -> dict[str, object]:
        return {
            "trackId": track_id,
            "sourcePath": f"D:/source/{track_id}.mp3",
            "title": f"Title {track_id}",
            "artist": "Artist",
            "grid": {
                "bpm": 128.0,
                "firstBeatMs": first_beat_ms,
                "firstBeatLabel": 1,
                "barBeatOffset": 0,
            },
        }

    def test_constructs_exact_top_difference_plus_conflicts(self) -> None:
        paths = self._build_roster()
        self.assertEqual(
            [path.name for path in paths],
            ["conflict-a.mp3", "conflict-b.mp3", "new-a.mp3", "new-b.wav"],
        )
        self.assertTrue(paths[0].is_relative_to(self.conflicts))
        self.assertTrue(paths[-1].is_relative_to(self.sealed))

    def test_builds_truth_with_exact_paths_and_multi_content_audit(self) -> None:
        paths = self._build_roster()
        candidates = {
            path.name.casefold(): [self._candidate(str(index))]
            for index, path in enumerate(paths, start=1)
        }
        candidates["new-a.mp3"] = [self._candidate("20"), self._candidate("10")]
        payload = build_recovered_truth(
            audio_paths=paths,
            candidates_by_name=candidates,
            db_path=self.root / "master.db",
            construction_counts={"targetCount": 4},
        )
        self.assertEqual(payload["source"]["trackCount"], 4)
        self.assertEqual(payload["source"]["multiContentFileNameCount"], 1)
        self.assertEqual(payload["source"]["referenceScope"], "current-db-recovered-reference")
        self.assertFalse(payload["source"]["isHistoricalFrozenSnapshot"])
        self.assertEqual(
            payload["source"]["allowedUses"],
            ["consumed-registry-bootstrap", "development-labeling"],
        )
        self.assertIn("historical-fresh-proof", payload["source"]["forbiddenUses"])
        self.assertIn("not guaranteed", payload["source"]["warning"])
        row = next(track for track in payload["tracks"] if track["fileName"] == "new-a.mp3")
        self.assertEqual(row["filePath"], str((self.sealed / "new-a.mp3").resolve()))
        self.assertEqual(row["rekordboxTrackIds"], ["10", "20"])
        self.assertEqual(
            row["rekordboxSourcePaths"], ["D:/source/10.mp3", "D:/source/20.mp3"]
        )

    def test_rejects_missing_content(self) -> None:
        paths = self._build_roster()
        with self.assertRaisesRegex(New357RecoveryError, "no Rekordbox content matched"):
            build_recovered_truth(
                audio_paths=paths,
                candidates_by_name={},
                db_path=self.root / "master.db",
                construction_counts={},
            )

    def test_rejects_incomplete_grid(self) -> None:
        paths = self._build_roster()
        candidate = self._candidate("1")
        del candidate["grid"]["firstBeatLabel"]  # type: ignore[index]
        candidates = {path.name.casefold(): [self._candidate("2")] for path in paths}
        candidates[paths[0].name.casefold()] = [candidate]
        with self.assertRaisesRegex(New357RecoveryError, "incomplete grid"):
            build_recovered_truth(
                audio_paths=paths,
                candidates_by_name=candidates,
                db_path=self.root / "master.db",
                construction_counts={},
            )

    def test_rejects_multi_content_grid_disagreement(self) -> None:
        paths = self._build_roster()
        candidates = {path.name.casefold(): [self._candidate("2")] for path in paths}
        candidates[paths[0].name.casefold()] = [
            self._candidate("10", first_beat_ms=25.0),
            self._candidate("20", first_beat_ms=30.0),
        ]
        with self.assertRaisesRegex(New357RecoveryError, "candidates disagree"):
            build_recovered_truth(
                audio_paths=paths,
                candidates_by_name=candidates,
                db_path=self.root / "master.db",
                construction_counts={},
            )

    def test_output_must_stay_inside_repository(self) -> None:
        inside = resolve_repo_output(self.root / "repo" / "truth.json", self.root / "repo")
        self.assertEqual(inside, (self.root / "repo" / "truth.json").resolve())
        with self.assertRaisesRegex(New357RecoveryError, "inside the repository"):
            resolve_repo_output(self.root / "outside.json", self.root / "repo")

    def test_converts_bridge_grid_field_names(self) -> None:
        self.assertEqual(
            truth_grid_from_bridge(
                {
                    "gridBpm": 130.0,
                    "gridFirstBeatMs": 72.0,
                    "gridFirstBeatLabel": 1,
                    "gridBarBeatOffset": 0,
                }
            ),
            {
                "bpm": 130.0,
                "firstBeatMs": 72.0,
                "firstBeatLabel": 1,
                "barBeatOffset": 0,
            },
        )


if __name__ == "__main__":
    unittest.main()
