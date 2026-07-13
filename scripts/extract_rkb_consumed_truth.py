import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rkb_sealed_batch_common import normalize_name


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BENCHMARK = (
    REPO_ROOT
    / "grid-analysis-lab"
    / "rkb-rekordbox-benchmark"
    / "sealed-eval"
    / "frkb-sealed-constant-grid-dp-integer-bpm-snap.json"
)
AUDIO_EXTENSIONS = {
    ".aac",
    ".aif",
    ".aiff",
    ".alac",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".wav",
    ".wma",
}
TRUTH_FIELDS = ("bpm", "firstBeatMs", "firstBeatLabel", "barBeatOffset")


class ConsumedTruthExtractionError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_json_line_value(line: str, path: Path, field: str) -> Any:
    try:
        raw_value = line.split(": ", 1)[1].rstrip().removesuffix(",")
        return json.loads(raw_value)
    except (IndexError, json.JSONDecodeError) as error:
        raise ConsumedTruthExtractionError(
            f"invalid {field} value in streamed benchmark {path}: {line.rstrip()}"
        ) from error


def _finite_float(value: Any, field: str, file_name: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ConsumedTruthExtractionError(
            f"invalid truth.{field} for {file_name}: {value}"
        ) from error
    if not math.isfinite(result):
        raise ConsumedTruthExtractionError(f"invalid truth.{field} for {file_name}: {value}")
    return result


def canonical_truth_fields(
    raw_truth: dict[str, Any], file_name: str
) -> tuple[dict[str, Any], bool]:
    missing = [field for field in TRUTH_FIELDS if raw_truth.get(field) is None]
    if missing:
        raise ConsumedTruthExtractionError(
            f"incomplete embedded truth for {file_name}: {missing}"
        )
    bpm = _finite_float(raw_truth["bpm"], "bpm", file_name)
    first_beat_ms = _finite_float(raw_truth["firstBeatMs"], "firstBeatMs", file_name)
    try:
        first_beat_label = int(raw_truth["firstBeatLabel"])
        raw_bar_beat_offset = int(raw_truth["barBeatOffset"])
    except (TypeError, ValueError) as error:
        raise ConsumedTruthExtractionError(
            f"invalid embedded truth label/offset for {file_name}"
        ) from error
    if bpm <= 0 or first_beat_ms < 0:
        raise ConsumedTruthExtractionError(
            f"invalid embedded truth bpm/firstBeatMs for {file_name}"
        )
    if first_beat_label not in (1, 2, 3, 4):
        raise ConsumedTruthExtractionError(
            f"invalid embedded truth firstBeatLabel for {file_name}: {first_beat_label}"
        )
    bar_beat_offset = raw_bar_beat_offset % 4
    return (
        {
            "bpm": round(bpm, 6),
            "firstBeatMs": round(first_beat_ms, 3),
            "firstBeatLabel": first_beat_label,
            "barBeatOffset": bar_beat_offset,
        },
        bar_beat_offset != raw_bar_beat_offset,
    )


def stream_embedded_truth(
    benchmark_path: Path,
    *,
    expected_track_count: int = 377,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Read only top-level summary and tracks fields; never materialize the large JSON object."""
    try:
        handle = benchmark_path.open("r", encoding="utf-8")
    except OSError as error:
        raise ConsumedTruthExtractionError(
            f"failed to open benchmark {benchmark_path}: {error}"
        ) from error

    summary_track_total: int | None = None
    error_track_count: int | None = None
    in_tracks = False
    in_truth = False
    current: dict[str, Any] | None = None
    raw_truth: dict[str, Any] = {}
    tracks: list[dict[str, Any]] = []
    normalized_offset_count = 0

    with handle:
        for line in handle:
            if not in_tracks:
                if line.startswith('    "trackTotal": '):
                    summary_track_total = int(
                        _parse_json_line_value(line, benchmark_path, "summary.trackTotal")
                    )
                elif line.startswith('    "errorTrackCount": '):
                    error_track_count = int(
                        _parse_json_line_value(line, benchmark_path, "summary.errorTrackCount")
                    )
                elif line.startswith('  "tracks": ['):
                    in_tracks = True
                continue

            if line.startswith('      "fileName": '):
                if current is not None:
                    raise ConsumedTruthExtractionError(
                        f"track has no complete embedded truth before next track: {current.get('fileName')}"
                    )
                file_name = _parse_json_line_value(line, benchmark_path, "tracks[].fileName")
                if not isinstance(file_name, str) or not file_name.strip():
                    raise ConsumedTruthExtractionError(
                        f"empty tracks[].fileName in benchmark {benchmark_path}"
                    )
                current = {"fileName": file_name.strip()}
                raw_truth = {}
                in_truth = False
                continue
            if current is None:
                continue
            if line.startswith('      "title": '):
                title = _parse_json_line_value(line, benchmark_path, "tracks[].title")
                current["title"] = str(title or "").strip()
            elif line.startswith('      "artist": '):
                artist = _parse_json_line_value(line, benchmark_path, "tracks[].artist")
                current["artist"] = str(artist or "").strip()
            elif line.startswith('      "truth": {'):
                in_truth = True
            elif in_truth and any(
                line.startswith(f'        "{field}": ') for field in TRUTH_FIELDS
            ):
                field = line.split('"', 2)[1]
                raw_truth[field] = _parse_json_line_value(
                    line, benchmark_path, f"tracks[].truth.{field}"
                )
            elif in_truth and line.startswith("      },"):
                if "title" not in current or "artist" not in current:
                    raise ConsumedTruthExtractionError(
                        f"track metadata is incomplete for {current['fileName']}"
                    )
                truth, offset_was_normalized = canonical_truth_fields(
                    raw_truth, str(current["fileName"])
                )
                tracks.append({**current, **truth})
                normalized_offset_count += int(offset_was_normalized)
                current = None
                raw_truth = {}
                in_truth = False

    if not in_tracks:
        raise ConsumedTruthExtractionError(f"benchmark contains no top-level tracks: {benchmark_path}")
    if current is not None or in_truth:
        raise ConsumedTruthExtractionError("benchmark ended inside an incomplete track truth")
    if summary_track_total is None or error_track_count is None:
        raise ConsumedTruthExtractionError("benchmark summary is missing trackTotal/errorTrackCount")
    if error_track_count != 0:
        raise ConsumedTruthExtractionError(
            f"benchmark errorTrackCount must be 0, got {error_track_count}"
        )
    if summary_track_total != expected_track_count:
        raise ConsumedTruthExtractionError(
            f"benchmark summary trackTotal {summary_track_total} does not match expected "
            f"{expected_track_count}"
        )
    if len(tracks) != expected_track_count:
        raise ConsumedTruthExtractionError(
            f"streamed truth track count {len(tracks)} does not match expected {expected_track_count}"
        )

    normalized_names: set[str] = set()
    duplicates: list[str] = []
    for track in tracks:
        key = normalize_name(track["fileName"])
        if key in normalized_names:
            duplicates.append(str(track["fileName"]))
        normalized_names.add(key)
    if duplicates:
        raise ConsumedTruthExtractionError(
            f"streamed truth contains duplicate file names: {duplicates[:8]}"
        )

    return tracks, {
        "summaryTrackTotal": summary_track_total,
        "errorTrackCount": error_track_count,
        "normalizedBarBeatOffsetCount": normalized_offset_count,
    }


def resolve_audio_paths(
    tracks: list[dict[str, Any]], audio_root: Path
) -> list[dict[str, Any]]:
    if not audio_root.is_dir():
        raise ConsumedTruthExtractionError(f"audio root not found: {audio_root}")
    index: dict[str, list[Path]] = {}
    for path in audio_root.iterdir():
        if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS:
            index.setdefault(normalize_name(path.name), []).append(path.resolve())

    resolved_tracks: list[dict[str, Any]] = []
    for track in tracks:
        file_name = str(track["fileName"])
        matches = index.get(normalize_name(file_name), [])
        if len(matches) != 1:
            raise ConsumedTruthExtractionError(
                f"audio resolution is not unique for {file_name}: {matches}"
            )
        resolved_tracks.append(
            {
                "fileName": file_name,
                "filePath": str(matches[0]),
                "title": str(track["title"]),
                "artist": str(track["artist"]),
                "bpm": track["bpm"],
                "firstBeatMs": track["firstBeatMs"],
                "firstBeatLabel": track["firstBeatLabel"],
                "barBeatOffset": track["barBeatOffset"],
            }
        )
    return resolved_tracks


def build_consumed_truth(
    *,
    benchmark_path: Path,
    audio_root: Path,
    expected_track_count: int = 377,
) -> dict[str, Any]:
    embedded_tracks, validation = stream_embedded_truth(
        benchmark_path, expected_track_count=expected_track_count
    )
    tracks = resolve_audio_paths(embedded_tracks, audio_root)
    return {
        "source": {
            "type": "rekordbox-consumed-grid-truth-extracted-from-benchmark",
            "batchId": "old377",
            "sourceBenchmark": str(benchmark_path.resolve()),
            "audioRoot": str(audio_root.resolve()),
            "trackCount": len(tracks),
            "extractedAt": utc_now(),
            "extractionMethod": "streamed-top-level-tracks-truth-v1",
            "validation": validation,
        },
        "tracks": tracks,
    }


def resolve_repo_output(path: Path, repo_root: Path = REPO_ROOT) -> Path:
    output = path.resolve()
    try:
        output.relative_to(repo_root.resolve())
    except ValueError as error:
        raise ConsumedTruthExtractionError(
            f"--output must stay inside the repository: {output}"
        ) from error
    return output


def write_json_new(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    except FileExistsError as error:
        raise ConsumedTruthExtractionError(f"refusing to overwrite existing output: {path}") from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Stream canonical consumed truth from the historical old377 benchmark"
    )
    parser.add_argument("--benchmark", default=str(DEFAULT_BENCHMARK))
    parser.add_argument("--audio-root", required=True)
    parser.add_argument("--expected-track-count", type=int, default=377)
    parser.add_argument(
        "--output",
        default="",
        help="Optional repository-local JSON path. Without it the command is read-only dry-run.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    expected_track_count = int(args.expected_track_count)
    if expected_track_count <= 0:
        raise ConsumedTruthExtractionError("--expected-track-count must be positive")
    payload = build_consumed_truth(
        benchmark_path=Path(args.benchmark).resolve(),
        audio_root=Path(args.audio_root).resolve(),
        expected_track_count=expected_track_count,
    )
    output_path = None
    if str(args.output).strip():
        output_path = resolve_repo_output(Path(args.output))
        write_json_new(output_path, payload)

    print(
        json.dumps(
            {
                "mode": "write" if output_path else "dry-run",
                "trackCount": payload["source"]["trackCount"],
                "validation": payload["source"]["validation"],
                "output": str(output_path) if output_path else "",
                "preview": payload["tracks"][:8],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConsumedTruthExtractionError as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)
