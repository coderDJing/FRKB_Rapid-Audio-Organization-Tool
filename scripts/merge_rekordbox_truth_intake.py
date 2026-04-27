import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_OUTPUT_DIR = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark"
DEFAULT_CURRENT_TRUTH = BENCHMARK_OUTPUT_DIR / "rekordbox-current-truth.json"
DEFAULT_INTAKE_TRUTH = BENCHMARK_OUTPUT_DIR / "intake-current-truth.json"


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"json is not an object: {path}")
    return payload


def _load_truth(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = _load_json(path)
    tracks = payload.get("tracks")
    if not isinstance(tracks, list):
        raise RuntimeError(f"truth has no tracks array: {path}")
    return payload, [item for item in tracks if isinstance(item, dict)]


def _dedupe_tracks(tracks: list[dict[str, Any]], source_label: str) -> tuple[list[dict[str, Any]], set[str]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    duplicates: set[str] = set()
    for track in tracks:
        key = _normalize_key(track.get("fileName"))
        if not key:
            continue
        if key in seen:
            duplicates.add(key)
            continue
        seen.add(key)
        result.append(track)
    if duplicates:
        preview = ", ".join(sorted(duplicates)[:8])
        raise RuntimeError(f"{source_label} contains duplicate fileName values: {preview}")
    return result, seen


def _merge_tracks(
    existing_tracks: list[dict[str, Any]],
    incoming_tracks: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int]:
    existing_tracks, _existing_keys = _dedupe_tracks(existing_tracks, "current truth")
    incoming_tracks, incoming_keys = _dedupe_tracks(incoming_tracks, "incoming truth")
    incoming_by_key = {str(track.get("fileName") or "").strip().casefold(): track for track in incoming_tracks}

    replaced = 0
    merged: list[dict[str, Any]] = []
    for track in existing_tracks:
        key = _normalize_key(track.get("fileName"))
        replacement = incoming_by_key.pop(key, None)
        if replacement is not None:
            merged.append(replacement)
            replaced += 1
        else:
            merged.append(track)

    added = len(incoming_by_key)
    merged.extend(incoming_by_key[key] for key in sorted(incoming_by_key.keys()))
    return merged, added, replaced


def _build_current_payload(
    *,
    existing_payload: dict[str, Any],
    tracks: list[dict[str, Any]],
    update_source: str,
    source_files: list[str],
) -> dict[str, Any]:
    source = existing_payload.get("source") if isinstance(existing_payload.get("source"), dict) else {}
    return {
        **existing_payload,
        "source": {
            **source,
            "type": "rekordbox-current-grid-truth",
            "trackCount": len(tracks),
            "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "updateSource": update_source,
            "sourceFiles": source_files,
            "note": "Single maintained Rekordbox truth source; FRKB pass/fail is derived classification.",
        },
        "tracks": tracks,
    }


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge Rekordbox intake truth into the single current truth")
    parser.add_argument("--current-truth", default=str(DEFAULT_CURRENT_TRUTH))
    parser.add_argument("--intake-truth", default=str(DEFAULT_INTAKE_TRUTH))
    parser.add_argument("--clear-intake", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    current_path = Path(args.current_truth)
    intake_path = Path(args.intake_truth)
    current_payload, current_tracks = _load_truth(current_path)
    _intake_payload, intake_tracks = _load_truth(intake_path)
    merged_tracks, added, replaced = _merge_tracks(current_tracks, intake_tracks)
    source_counts = {
        "currentBefore": len(current_tracks),
        "intake": len(intake_tracks),
    }

    next_payload = _build_current_payload(
        existing_payload=current_payload,
        tracks=merged_tracks,
        update_source="merge-intake-truth",
        source_files=[str(current_path), str(intake_path)],
    )

    if not args.dry_run:
        _write_json(current_path, next_payload)
        if args.clear_intake:
            intake_payload, _intake_tracks = _load_truth(intake_path)
            intake_source = intake_payload.get("source") if isinstance(intake_payload.get("source"), dict) else {}
            _write_json(
                intake_path,
                {
                    **intake_payload,
                    "source": {
                        **intake_source,
                        "trackCount": 0,
                        "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "updateSource": "clear-after-current-truth-merge",
                    },
                    "tracks": [],
                },
            )

    print(
        json.dumps(
            {
                "currentTruth": str(current_path),
                "trackCount": len(merged_tracks),
                "added": added,
                "replaced": replaced,
                "sourceCounts": source_counts,
                "clearIntake": bool(args.clear_intake),
                "dryRun": bool(args.dry_run),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
