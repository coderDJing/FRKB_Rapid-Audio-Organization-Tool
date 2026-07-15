"""Generate a v2 beat-grid truth derivative without touching the legacy source file.

This is intentionally an offline one-way conversion utility.  It reads a legacy
truth JSON that contains a top-level ``tracks`` array and writes a new artifact
only when ``--apply`` is supplied.  The generated file preserves non-grid track
labels, removes legacy grid roots, and records immutable source provenance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CONVERTER_VERSION = 1
GRID_SCHEMA_VERSION = 2
SIGNATURE_HASH_OFFSET = 2166136261
SIGNATURE_HASH_PRIME = 16777619


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _finite_number(value: Any, field: str, track_index: int) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"track[{track_index}] has invalid {field}") from error
    if not math.isfinite(numeric):
        raise ValueError(f"track[{track_index}] has invalid {field}")
    return numeric


def _downbeat_offset(track: dict[str, Any], track_index: int) -> int:
    raw = track.get("downbeatBeatOffset", track.get("barBeatOffset"))
    if raw is None:
        raise ValueError(f"track[{track_index}] is missing downbeatBeatOffset/barBeatOffset")
    try:
        return int(round(float(raw))) % 4
    except (TypeError, ValueError) as error:
        raise ValueError(f"track[{track_index}] has invalid downbeat offset") from error


def _map_signature(clip: dict[str, Any]) -> str:
    payload = "v2:{startSec:.6f},{anchorSec:.6f},{bpm:.6f},{downbeatBeatOffset}".format(**clip)
    value = SIGNATURE_HASH_OFFSET
    for character in payload:
        value ^= ord(character)
        value = (value * SIGNATURE_HASH_PRIME) & 0xFFFFFFFF
    return f"sbgm_{value:08x}"


def _convert_track(track: dict[str, Any], track_index: int, source: str) -> dict[str, Any]:
    bpm = _finite_number(track.get("bpm"), "bpm", track_index)
    first_beat_ms = _finite_number(track.get("firstBeatMs"), "firstBeatMs", track_index)
    if bpm <= 0:
        raise ValueError(f"track[{track_index}] has non-positive bpm")
    if first_beat_ms < 0:
        raise ValueError(f"track[{track_index}] has negative firstBeatMs")

    output = dict(track)
    for field in (
        "bpm",
        "firstBeatMs",
        "firstBeatLabel",
        "barBeatOffset",
        "downbeatBeatOffset",
        "beatGridSource",
        "beatGridStatus",
        "beatGridAlgorithmVersion",
        "beatGridMap",
    ):
        output.pop(field, None)
    clip = {
        "startSec": 0,
        "anchorSec": round(first_beat_ms / 1000.0, 6),
        "bpm": round(bpm, 6),
        "downbeatBeatOffset": _downbeat_offset(track, track_index),
    }
    output["beatGridMap"] = {
        "version": GRID_SCHEMA_VERSION,
        "source": source,
        "clips": [clip],
        "signature": _map_signature(clip),
    }
    return output


def _read_payload(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON: {path}") from error
    if not isinstance(payload, dict):
        raise ValueError("truth source must be a JSON object")
    if not isinstance(payload.get("tracks"), list):
        raise ValueError("truth source must contain a tracks array")
    return payload


def _build_output(
    source_path: Path,
    payload: dict[str, Any],
    map_source: str,
) -> dict[str, Any]:
    raw_tracks = payload["tracks"]
    tracks: list[dict[str, Any]] = []
    for index, raw_track in enumerate(raw_tracks):
        if not isinstance(raw_track, dict):
            raise ValueError(f"track[{index}] is not an object")
        tracks.append(_convert_track(raw_track, index, map_source))
    return {
        "type": "frkb-grid-truth-v2-derived",
        "schemaVersion": GRID_SCHEMA_VERSION,
        "trackCount": len(tracks),
        "provenance": {
            "sourcePath": str(source_path.resolve()),
            "sourceSha256": _sha256_file(source_path),
            "sourceSchemaVersion": payload.get("schemaVersion"),
            "converter": "convert_legacy_grid_truth_to_v2.py",
            "converterVersion": CONVERTER_VERSION,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "source": payload.get("source"),
        "tracks": tracks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="legacy truth JSON; never modified")
    parser.add_argument("--output", required=True, help="new v2 derivative JSON")
    parser.add_argument(
        "--map-source",
        choices=("manual", "analysis"),
        default="manual",
        help="v2 map source recorded for every converted track",
    )
    parser.add_argument("--apply", action="store_true", help="write the derivative file")
    parser.add_argument("--force", action="store_true", help="allow replacing an existing output")
    args = parser.parse_args()

    source_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    if not source_path.is_file():
        raise SystemExit(f"input truth does not exist: {source_path}")
    if source_path == output_path:
        raise SystemExit("output must differ from the immutable input truth")
    if output_path.exists() and not args.force:
        raise SystemExit(f"output already exists (pass --force to replace): {output_path}")

    payload = _read_payload(source_path)
    converted = _build_output(source_path, payload, args.map_source)
    print(
        json.dumps(
            {
                "input": str(source_path),
                "inputSha256": converted["provenance"]["sourceSha256"],
                "output": str(output_path),
                "trackCount": converted["trackCount"],
                "mapSource": args.map_source,
                "willWrite": bool(args.apply),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if not args.apply:
        return 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(converted, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
