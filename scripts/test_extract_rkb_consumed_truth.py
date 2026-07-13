import json
import tempfile
import unittest
from pathlib import Path

from extract_rkb_consumed_truth import (
    ConsumedTruthExtractionError,
    build_consumed_truth,
    resolve_repo_output,
    stream_embedded_truth,
)


class ExtractConsumedTruthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.benchmark = self.root / "benchmark.json"
        self.audio = self.root / "audio"
        self.audio.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_benchmark(
        self,
        *,
        tracks: list[dict[str, object]],
        error_track_count: int = 0,
        summary_track_total: int | None = None,
    ) -> None:
        self.benchmark.write_text(
            json.dumps(
                {
                    "summary": {
                        "trackTotal": len(tracks)
                        if summary_track_total is None
                        else summary_track_total,
                        "analyzedTrackCount": len(tracks),
                        "errorTrackCount": error_track_count,
                    },
                    "tracks": tracks,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _track(name: str, *, offset: int = 0) -> dict[str, object]:
        return {
            "fileName": name,
            "title": f"Title {name}",
            "artist": "Artist",
            "filePath": f"legacy/{name}",
            "truth": {
                "bpm": 128.0,
                "firstBeatMs": 25.0,
                "firstBeatLabel": 1,
                "barBeatOffset": offset,
                "timeBasis": {"offsetMs": 25.0},
            },
            "analysis": {
                "bpm": 64.0,
                "firstBeatMs": 999.0,
                "firstBeatLabel": 4,
                "barBeatOffset": 31,
            },
        }

    def test_streams_only_embedded_truth_and_normalizes_offset(self) -> None:
        self._write_benchmark(tracks=[self._track("a.mp3", offset=5)])
        tracks, validation = stream_embedded_truth(
            self.benchmark, expected_track_count=1
        )
        self.assertEqual(tracks[0]["bpm"], 128.0)
        self.assertEqual(tracks[0]["firstBeatMs"], 25.0)
        self.assertEqual(tracks[0]["firstBeatLabel"], 1)
        self.assertEqual(tracks[0]["barBeatOffset"], 1)
        self.assertEqual(validation["normalizedBarBeatOffsetCount"], 1)

    def test_rejects_nonzero_benchmark_errors(self) -> None:
        self._write_benchmark(tracks=[self._track("a.mp3")], error_track_count=1)
        with self.assertRaisesRegex(ConsumedTruthExtractionError, "errorTrackCount must be 0"):
            stream_embedded_truth(self.benchmark, expected_track_count=1)

    def test_rejects_incomplete_truth(self) -> None:
        track = self._track("a.mp3")
        del track["truth"]["firstBeatLabel"]  # type: ignore[index]
        self._write_benchmark(tracks=[track])
        with self.assertRaisesRegex(ConsumedTruthExtractionError, "incomplete embedded truth"):
            stream_embedded_truth(self.benchmark, expected_track_count=1)

    def test_resolves_top_level_audio_to_absolute_file_path(self) -> None:
        self._write_benchmark(tracks=[self._track("A.mp3"), self._track("b.wav")])
        (self.audio / "a.MP3").write_bytes(b"a")
        (self.audio / "b.wav").write_bytes(b"b")
        payload = build_consumed_truth(
            benchmark_path=self.benchmark,
            audio_root=self.audio,
            expected_track_count=2,
        )
        self.assertEqual(payload["source"]["trackCount"], 2)
        self.assertEqual(payload["tracks"][0]["filePath"], str((self.audio / "a.MP3").resolve()))
        self.assertEqual(payload["tracks"][1]["filePath"], str((self.audio / "b.wav").resolve()))

    def test_rejects_missing_audio(self) -> None:
        self._write_benchmark(tracks=[self._track("missing.mp3")])
        with self.assertRaisesRegex(ConsumedTruthExtractionError, "audio resolution is not unique"):
            build_consumed_truth(
                benchmark_path=self.benchmark,
                audio_root=self.audio,
                expected_track_count=1,
            )

    def test_output_must_stay_inside_repository(self) -> None:
        inside = resolve_repo_output(self.root / "repo" / "truth.json", self.root / "repo")
        self.assertEqual(inside, (self.root / "repo" / "truth.json").resolve())
        with self.assertRaisesRegex(ConsumedTruthExtractionError, "inside the repository"):
            resolve_repo_output(self.root / "outside.json", self.root / "repo")


if __name__ == "__main__":
    unittest.main()
