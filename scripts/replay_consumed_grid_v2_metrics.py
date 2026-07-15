"""Replay frozen benchmark downbeat metrics against a derived v2 truth artifact.

The input benchmark report and legacy truth remain immutable. This tool compares
each frozen analysis result with the derived ``beatGridMap v2`` truth and proves
that removing the 32-beat hierarchy did not alter the strict downbeat outcome.
It is dry-run by default and writes a separate replay report only with ``--apply``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPLAY_VERSION = 1


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _normalize_name(value: Any) -> str:
    return str(value or "").strip().casefold()


def _downbeat_offset(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} is invalid")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} is invalid") from error
    if not numeric.is_integer():
        raise ValueError(f"{label} is invalid")
    return int(numeric) % 4


def _v2_truth_index(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise ValueError("v2 truth contains no tracks")
    indexed: dict[str, dict[str, Any]] = {}
    for index, track in enumerate(tracks):
        if not isinstance(track, dict):
            raise ValueError(f"truth track[{index}] is not an object")
        key = _normalize_name(track.get("fileName"))
        if not key or key in indexed:
            raise ValueError(f"truth has an invalid or duplicate fileName: {track.get('fileName')}")
        beat_grid_map = track.get("beatGridMap")
        if not isinstance(beat_grid_map, dict) or beat_grid_map.get("version") != 2:
            raise ValueError(f"truth track is not v2: {track.get('fileName')}")
        clips = beat_grid_map.get("clips")
        if not isinstance(clips, list) or len(clips) != 1 or not isinstance(clips[0], dict):
            raise ValueError(f"truth track must have one fixed v2 clip: {track.get('fileName')}")
        clip = clips[0]
        indexed[key] = {
            "fileName": str(track.get("fileName") or "").strip(),
            "beatGridMap": beat_grid_map,
            "downbeatBeatOffset": _downbeat_offset(
                clip.get("downbeatBeatOffset"), f"truth {track.get('fileName')} downbeatBeatOffset"
            ),
        }
    return indexed


def _replay_category(timeline: dict[str, Any], downbeat_matches: bool) -> str:
    if str(timeline.get("category") or "") == "half-or-double-bpm":
        return "half-or-double-bpm"
    if str(timeline.get("bpmDriftStatus") or "") == "fail":
        return "bpm"
    if str(timeline.get("firstBeatPhaseStatus") or "") == "fail":
        return "first-beat-phase"
    if str(timeline.get("gridMaxStatus") or "") == "fail":
        return "grid-drift"
    if not downbeat_matches:
        return "downbeat"
    return "pass"


def replay(payload: dict[str, Any], truth_payload: dict[str, Any]) -> dict[str, Any]:
    truth_by_file_name = _v2_truth_index(truth_payload)
    rows = payload.get("tracks")
    if not isinstance(rows, list) or not rows:
        raise ValueError("benchmark report contains no tracks")

    replay_rows: list[dict[str, Any]] = []
    mismatches: list[str] = []
    legacy_categories_changed: list[str] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"benchmark track[{index}] is not an object")
        file_name = str(row.get("fileName") or "").strip()
        truth = truth_by_file_name.get(_normalize_name(file_name))
        if not file_name or truth is None:
            raise ValueError(f"benchmark track has no v2 truth counterpart: {file_name or index}")
        analysis = row.get("analysis")
        timeline = row.get("currentTimeline")
        if not isinstance(analysis, dict) or not isinstance(timeline, dict):
            raise ValueError(f"benchmark track has no analysis/timeline: {file_name}")
        if "barBeatOffset" not in analysis or "firstBeatShiftBeats" not in timeline:
            raise ValueError(f"benchmark track has no frozen legacy phase fields: {file_name}")
        legacy_match = timeline.get("barBeatOffsetMatchedMod4")
        if not isinstance(legacy_match, bool):
            raise ValueError(f"benchmark track has no legacy mod4 outcome: {file_name}")
        raw_offset = _downbeat_offset(analysis["barBeatOffset"], f"analysis {file_name} barBeatOffset")
        shift = _downbeat_offset(timeline["firstBeatShiftBeats"], f"timeline {file_name} firstBeatShiftBeats")
        adjusted_offset = (raw_offset + shift) % 4
        v2_match = adjusted_offset == int(truth["downbeatBeatOffset"])
        category = _replay_category(timeline, v2_match)
        legacy_category = str(timeline.get("category") or "")
        if legacy_match != v2_match:
            mismatches.append(file_name)
        if legacy_category != category:
            legacy_categories_changed.append(file_name)
        replay_rows.append(
            {
                "fileName": file_name,
                "legacyDownbeatMatchedMod4": legacy_match,
                "v2DownbeatBeatOffsetMatches": v2_match,
                "adjustedDownbeatBeatOffset": adjusted_offset,
                "truthBeatGridMap": truth["beatGridMap"],
                "legacyCategory": legacy_category,
                "v2Category": category,
            }
        )

    return {
        "replayVersion": REPLAY_VERSION,
        "trackCount": len(replay_rows),
        "downbeatMismatchCount": len(mismatches),
        "categoryMismatchCount": len(legacy_categories_changed),
        "downbeatMismatches": mismatches[:20],
        "categoryMismatches": legacy_categories_changed[:20],
        "tracks": replay_rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", required=True, help="immutable legacy benchmark report")
    parser.add_argument("--truth", required=True, help="derived v2 truth JSON")
    parser.add_argument("--output", required=True, help="new v2 replay report")
    parser.add_argument("--apply", action="store_true", help="write the replay report")
    parser.add_argument("--force", action="store_true", help="replace an existing replay report")
    args = parser.parse_args()

    benchmark_path = Path(args.benchmark).resolve()
    truth_path = Path(args.truth).resolve()
    output_path = Path(args.output).resolve()
    if not benchmark_path.is_file() or not truth_path.is_file():
        raise SystemExit("benchmark and v2 truth must both exist")
    if output_path in {benchmark_path, truth_path}:
        raise SystemExit("replay output must differ from both immutable inputs")
    if output_path.exists() and not args.force:
        raise SystemExit(f"output already exists (pass --force to replace): {output_path}")

    result = replay(
        json.loads(benchmark_path.read_text(encoding="utf-8")),
        json.loads(truth_path.read_text(encoding="utf-8")),
    )
    if result["downbeatMismatchCount"] or result["categoryMismatchCount"]:
        raise SystemExit(json.dumps(result, ensure_ascii=False, indent=2))

    output = {
        "type": "frkb-consumed-grid-v2-replay",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "provenance": {
            "benchmarkPath": str(benchmark_path),
            "benchmarkSha256": _sha256_file(benchmark_path),
            "truthPath": str(truth_path),
            "truthSha256": _sha256_file(truth_path),
            "replayVersion": REPLAY_VERSION,
        },
        **result,
    }
    print(
        json.dumps(
            {
                "benchmark": str(benchmark_path),
                "truth": str(truth_path),
                "output": str(output_path),
                "trackCount": result["trackCount"],
                "willWrite": bool(args.apply),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if args.apply:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
