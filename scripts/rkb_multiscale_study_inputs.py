import json
from pathlib import Path
from typing import Any, Iterator


DEFAULT_BENCHMARKS = {
    "current1407": "grid-analysis-lab/rkb-rekordbox-benchmark/frkb-current-latest.json",
    "blind608": (
        "grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/"
        "frkb-blind-rank1-high-structural-score-v2.json"
    ),
    "old377": (
        "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/"
        "frkb-sealed-constant-grid-dp-rank1-material-legacy-weakness.json"
    ),
    "test316": (
        "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/"
        "frkb-sealed-test316-rank1-high-structural-score-v2.json"
    ),
    "test327": (
        "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/"
        "frkb-sealed-test327-rank1-high-structural-score-v2.json"
    ),
    "test353": (
        "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/"
        "frkb-sealed-test353-rank1-high-structural-score-v2-archive.json"
    ),
}


def iter_benchmark_tracks(path: Path) -> Iterator[dict[str, Any]]:
    decoder = json.JSONDecoder()
    tracks_marker = '\n  "tracks": ['
    buffer = ""
    position = 0
    found_array = False
    with path.open("r", encoding="utf-8") as source:
        while True:
            if position >= len(buffer) - 65536:
                buffer = buffer[position:] + source.read(1024 * 1024)
                position = 0
            if not found_array:
                marker = buffer.find(tracks_marker, position)
                if marker < 0:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        raise RuntimeError(f"benchmark contains no tracks array: {path}")
                    buffer = buffer[-len(tracks_marker) :] + chunk
                    position = 0
                    continue
                position = marker + len(tracks_marker)
                found_array = True
            while True:
                while position < len(buffer) and buffer[position] in " \t\r\n,":
                    position += 1
                if position < len(buffer) and buffer[position] == "]":
                    return
                try:
                    item, next_position = decoder.raw_decode(buffer, position)
                    position = next_position
                    if isinstance(item, dict):
                        yield item
                    break
                except json.JSONDecodeError:
                    remainder = buffer[position:]
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        raise RuntimeError(f"benchmark tracks array is truncated: {path}")
                    buffer = remainder + chunk
                    position = 0
