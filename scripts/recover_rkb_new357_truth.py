import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rkb_sealed_batch_common import normalize_name


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BRIDGE = REPO_ROOT / "resources" / "rekordboxDesktopLibrary" / "bridge.py"
DEFAULT_BENCHMARK_ROOT = REPO_ROOT / "grid-analysis-lab" / "rkb-rekordbox-benchmark" / "sealed-eval"
DEFAULT_OLD377_BENCHMARK = (
    DEFAULT_BENCHMARK_ROOT / "frkb-sealed-constant-grid-dp-integer-bpm-snap.json"
)
DEFAULT_TEST327_TRUTH = DEFAULT_BENCHMARK_ROOT / "rekordbox-sealed-truth-test327.json"
DEFAULT_TEST353_TRUTH = DEFAULT_BENCHMARK_ROOT / "rekordbox-sealed-truth-test353.json"
DEFAULT_REKORDBOX_DB = Path("D:/PIONEER/Master/master.db")
DEFAULT_CONFLICT_RELATIVE_ROOT = Path("_conflicts") / "sealed-intake-20260610"
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
GRID_FIELDS = ("bpm", "firstBeatMs", "firstBeatLabel", "barBeatOffset")


class New357RecoveryError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_truth_names(path: Path) -> list[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise New357RecoveryError(f"failed to read truth {path}: {error}") from error
    tracks = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(tracks, list) or not tracks:
        raise New357RecoveryError(f"truth contains no tracks: {path}")
    names: list[str] = []
    for track in tracks:
        file_name = str(track.get("fileName") or "").strip() if isinstance(track, dict) else ""
        if not file_name:
            raise New357RecoveryError(f"truth contains a track without fileName: {path}")
        names.append(file_name)
    assert_unique_names(names, f"truth {path}")
    return names


def extract_benchmark_track_names(path: Path) -> list[str]:
    """Extract top-level tracks[].fileName without loading the large benchmark into memory."""
    try:
        handle = path.open("r", encoding="utf-8")
    except OSError as error:
        raise New357RecoveryError(f"failed to open benchmark {path}: {error}") from error

    names: list[str] = []
    in_tracks = False
    with handle:
        for line in handle:
            if not in_tracks:
                if line.strip() == '"tracks": [':
                    in_tracks = True
                continue
            if line.startswith('      "fileName": '):
                raw_value = line.split(": ", 1)[1].rstrip().removesuffix(",")
                try:
                    file_name = json.loads(raw_value)
                except json.JSONDecodeError as error:
                    raise New357RecoveryError(
                        f"invalid tracks[].fileName in benchmark {path}: {raw_value}"
                    ) from error
                if not isinstance(file_name, str) or not file_name.strip():
                    raise New357RecoveryError(f"empty tracks[].fileName in benchmark {path}")
                names.append(file_name.strip())

    if not in_tracks or not names:
        raise New357RecoveryError(f"benchmark contains no top-level tracks: {path}")
    assert_unique_names(names, f"benchmark {path}")
    return names


def assert_unique_names(names: list[str], label: str) -> None:
    seen: dict[str, str] = {}
    duplicates: list[str] = []
    for name in names:
        key = normalize_name(name)
        if key in seen:
            duplicates.append(f"{seen[key]} <> {name}")
        else:
            seen[key] = name
    if duplicates:
        raise New357RecoveryError(f"{label} contains duplicate file names: {duplicates[:8]}")


def list_audio_files(root: Path) -> list[Path]:
    if not root.is_dir():
        raise New357RecoveryError(f"audio root not found: {root}")
    return sorted(
        (
            path.resolve()
            for path in root.iterdir()
            if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS
        ),
        key=lambda path: normalize_name(path.name),
    )


def construct_new357_audio_paths(
    *,
    sealed_root: Path,
    conflict_root: Path,
    old_benchmark: Path,
    test327_truth: Path,
    test353_truth: Path,
    expected_old_count: int = 377,
    expected_test327_count: int = 327,
    expected_test353_count: int = 353,
    expected_top_count: int = 355,
    expected_conflict_count: int = 2,
    expected_total_count: int = 357,
) -> tuple[list[Path], dict[str, int]]:
    old_names = extract_benchmark_track_names(old_benchmark)
    test327_names = load_truth_names(test327_truth)
    test353_names = load_truth_names(test353_truth)
    expected_inputs = (
        ("old benchmark", len(old_names), expected_old_count),
        ("test327 truth", len(test327_names), expected_test327_count),
        ("test353 truth", len(test353_names), expected_test353_count),
    )
    for label, actual, expected in expected_inputs:
        if actual != expected:
            raise New357RecoveryError(f"{label} count {actual} does not match expected {expected}")

    excluded_names = {
        normalize_name(name) for name in [*old_names, *test327_names, *test353_names]
    }
    sealed_audio = list_audio_files(sealed_root)
    top_paths = [path for path in sealed_audio if normalize_name(path.name) not in excluded_names]
    conflict_paths = list_audio_files(conflict_root)
    targets = sorted([*top_paths, *conflict_paths], key=lambda path: normalize_name(path.name))
    assert_unique_names([path.name for path in targets], "new357 target roster")

    expected_counts = (
        ("new357 sealed-eval top-level difference", len(top_paths), expected_top_count),
        ("new357 conflict archive", len(conflict_paths), expected_conflict_count),
        ("new357 target roster", len(targets), expected_total_count),
    )
    for label, actual, expected in expected_counts:
        if actual != expected:
            raise New357RecoveryError(f"{label} count {actual} does not match expected {expected}")

    return targets, {
        "sealedTopAudioCount": len(sealed_audio),
        "old377Count": len(old_names),
        "test327Count": len(test327_names),
        "test353Count": len(test353_names),
        "newTopCount": len(top_paths),
        "conflictCount": len(conflict_paths),
        "targetCount": len(targets),
    }


def _finite_float(value: Any, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise New357RecoveryError(f"invalid {label}: {value}") from error
    if not math.isfinite(result):
        raise New357RecoveryError(f"invalid {label}: {value}")
    return result


def normalize_grid(raw_grid: dict[str, Any], file_name: str, track_id: str) -> dict[str, Any]:
    missing = [field for field in GRID_FIELDS if raw_grid.get(field) is None]
    if missing:
        raise New357RecoveryError(
            f"Rekordbox content {track_id} for {file_name} has incomplete grid: {missing}"
        )
    bpm = _finite_float(raw_grid["bpm"], "bpm")
    first_beat_ms = _finite_float(raw_grid["firstBeatMs"], "firstBeatMs")
    try:
        first_beat_label = int(raw_grid["firstBeatLabel"])
        bar_beat_offset = int(raw_grid["barBeatOffset"])
    except (TypeError, ValueError) as error:
        raise New357RecoveryError(
            f"Rekordbox content {track_id} for {file_name} has invalid grid labels"
        ) from error
    if bpm <= 0 or first_beat_ms < 0:
        raise New357RecoveryError(
            f"Rekordbox content {track_id} for {file_name} has invalid bpm/firstBeatMs"
        )
    if first_beat_label not in (1, 2, 3, 4) or bar_beat_offset not in (0, 1, 2, 3):
        raise New357RecoveryError(
            f"Rekordbox content {track_id} for {file_name} has invalid label/offset"
        )
    return {
        "bpm": round(bpm, 6),
        "firstBeatMs": round(first_beat_ms, 3),
        "firstBeatLabel": first_beat_label,
        "barBeatOffset": bar_beat_offset,
    }


def truth_grid_from_bridge(raw_grid: dict[str, Any]) -> dict[str, Any]:
    return {
        "bpm": raw_grid.get("gridBpm"),
        "firstBeatMs": raw_grid.get("gridFirstBeatMs"),
        "firstBeatLabel": raw_grid.get("gridFirstBeatLabel"),
        "barBeatOffset": raw_grid.get("gridBarBeatOffset"),
    }


def _candidate_sort_key(candidate: dict[str, Any]) -> tuple[int, str]:
    track_id = str(candidate.get("trackId") or "")
    try:
        return int(track_id), track_id
    except ValueError:
        return sys.maxsize, track_id


def build_recovered_truth(
    *,
    audio_paths: list[Path],
    candidates_by_name: dict[str, list[dict[str, Any]]],
    db_path: Path,
    construction_counts: dict[str, int],
) -> dict[str, Any]:
    tracks: list[dict[str, Any]] = []
    ambiguous_name_count = 0
    for audio_path in sorted(audio_paths, key=lambda path: normalize_name(path.name)):
        key = normalize_name(audio_path.name)
        candidates = sorted(candidates_by_name.get(key, []), key=_candidate_sort_key)
        if not candidates:
            raise New357RecoveryError(f"no Rekordbox content matched {audio_path.name}")
        normalized_candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for candidate in candidates:
            track_id = str(candidate.get("trackId") or "").strip()
            source_path = str(candidate.get("sourcePath") or "").strip()
            raw_grid = candidate.get("grid")
            if not track_id or not source_path or not isinstance(raw_grid, dict):
                raise New357RecoveryError(
                    f"invalid Rekordbox candidate for {audio_path.name}: {candidate}"
                )
            normalized_candidates.append(
                (candidate, normalize_grid(raw_grid, audio_path.name, track_id))
            )
        consensus_grid = normalized_candidates[0][1]
        disagreements = [
            candidate.get("trackId")
            for candidate, grid in normalized_candidates[1:]
            if grid != consensus_grid
        ]
        if disagreements:
            track_ids = [candidate.get("trackId") for candidate, _ in normalized_candidates]
            raise New357RecoveryError(
                f"Rekordbox candidates disagree for {audio_path.name}: {track_ids}"
            )
        if len(normalized_candidates) > 1:
            ambiguous_name_count += 1

        representative = normalized_candidates[0][0]
        tracks.append(
            {
                "fileName": audio_path.name,
                "filePath": str(audio_path.resolve()),
                "title": str(representative.get("title") or "").strip(),
                "artist": str(representative.get("artist") or "").strip(),
                **consensus_grid,
                "rekordboxTrackIds": [
                    str(candidate["trackId"]) for candidate, _ in normalized_candidates
                ],
                "rekordboxSourcePaths": [
                    str(candidate["sourcePath"]) for candidate, _ in normalized_candidates
                ],
            }
        )

    return {
        "source": {
            "type": "rekordbox-recovered-consumed-grid-truth",
            "dbPath": str(db_path.resolve()),
            "batchId": "new357",
            "trackCount": len(tracks),
            "capturedAt": utc_now(),
            "recoveryMethod": "sealed-eval-difference-plus-conflicts-and-grid-consensus",
            "referenceScope": "current-db-recovered-reference",
            "isHistoricalFrozenSnapshot": False,
            "allowedUses": ["consumed-registry-bootstrap", "development-labeling"],
            "forbiddenUses": ["historical-fresh-proof", "historical-benchmark-reconstruction"],
            "warning": (
                "Current DB recovered reference; it is not guaranteed to equal the historical "
                "frozen snapshot and must not be presented as one."
            ),
            "constructionCounts": construction_counts,
            "multiContentFileNameCount": ambiguous_name_count,
        },
        "tracks": tracks,
    }


def load_rekordbox_candidates(
    *,
    db_path: Path,
    bridge_path: Path,
    audio_paths: list[Path],
) -> dict[str, list[dict[str, Any]]]:
    if not db_path.is_file():
        raise New357RecoveryError(f"Rekordbox master.db not found: {db_path}")
    if not bridge_path.is_file():
        raise New357RecoveryError(f"Rekordbox bridge not found: {bridge_path}")
    bridge_root = str(bridge_path.parent.resolve())
    if bridge_root not in sys.path:
        sys.path.insert(0, bridge_root)
    try:
        import bridge as rekordbox_bridge
    except Exception as error:
        raise New357RecoveryError(
            "failed to load Rekordbox runtime; run with the bundled rekordbox-desktop Python"
        ) from error
    if rekordbox_bridge.PYREKORDBOX_IMPORT_ERROR:
        raise New357RecoveryError(
            f"pyrekordbox is unavailable: {rekordbox_bridge.PYREKORDBOX_IMPORT_ERROR}"
        )

    target_names = {normalize_name(path.name) for path in audio_paths}
    candidates: dict[str, list[dict[str, Any]]] = {name: [] for name in target_names}
    database = rekordbox_bridge.Rekordbox6Database(
        path=str(db_path.resolve()), db_dir=str(db_path.resolve().parent)
    )
    try:
        share_dir = str(db_path.resolve().parent / "share")
        for content in database.get_content().all():
            source_path = str(getattr(content, "FolderPath", "") or "").strip()
            normalized_source = source_path.replace("\\", "/")
            file_name = normalized_source.rsplit("/", 1)[-1].strip()
            if not file_name:
                file_name = str(getattr(content, "FileNameL", "") or "").strip()
            key = normalize_name(file_name)
            if key not in target_names:
                continue
            bridge_grid = rekordbox_bridge._resolve_track_grid_payload(
                database, content, share_dir
            )
            candidates[key].append(
                {
                    "trackId": str(getattr(content, "ID", "") or "").strip(),
                    "sourcePath": source_path,
                    "title": str(getattr(content, "Title", "") or "").strip(),
                    "artist": rekordbox_bridge._resolve_artist_name(content),
                    "grid": truth_grid_from_bridge(bridge_grid),
                }
            )
    finally:
        rekordbox_bridge._close_database(database)
    return candidates


def resolve_repo_output(path: Path, repo_root: Path = REPO_ROOT) -> Path:
    output = path.resolve()
    try:
        output.relative_to(repo_root.resolve())
    except ValueError as error:
        raise New357RecoveryError(f"--output must stay inside the repository: {output}") from error
    return output


def write_json_new(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    except FileExistsError as error:
        raise New357RecoveryError(f"refusing to overwrite existing output: {path}") from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Recover an auditable current-DB reference for the consumed new357 batch"
    )
    parser.add_argument("--sealed-root", required=True)
    parser.add_argument("--conflict-root", default="")
    parser.add_argument("--db", default=str(DEFAULT_REKORDBOX_DB))
    parser.add_argument("--bridge", default=str(DEFAULT_BRIDGE))
    parser.add_argument("--old-benchmark", default=str(DEFAULT_OLD377_BENCHMARK))
    parser.add_argument("--test327-truth", default=str(DEFAULT_TEST327_TRUTH))
    parser.add_argument("--test353-truth", default=str(DEFAULT_TEST353_TRUTH))
    parser.add_argument(
        "--output",
        default="",
        help="Optional repository-local JSON path. Without it the command is read-only dry-run.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    sealed_root = Path(args.sealed_root).resolve()
    conflict_root = (
        Path(args.conflict_root).resolve()
        if str(args.conflict_root).strip()
        else (sealed_root / DEFAULT_CONFLICT_RELATIVE_ROOT).resolve()
    )
    audio_paths, counts = construct_new357_audio_paths(
        sealed_root=sealed_root,
        conflict_root=conflict_root,
        old_benchmark=Path(args.old_benchmark).resolve(),
        test327_truth=Path(args.test327_truth).resolve(),
        test353_truth=Path(args.test353_truth).resolve(),
    )
    db_path = Path(args.db).resolve()
    candidates = load_rekordbox_candidates(
        db_path=db_path,
        bridge_path=Path(args.bridge).resolve(),
        audio_paths=audio_paths,
    )
    payload = build_recovered_truth(
        audio_paths=audio_paths,
        candidates_by_name=candidates,
        db_path=db_path,
        construction_counts=counts,
    )
    output_path = None
    if str(args.output).strip():
        output_path = resolve_repo_output(Path(args.output))
        write_json_new(output_path, payload)

    source = payload["source"]
    print(
        json.dumps(
            {
                "mode": "write" if output_path else "dry-run",
                "trackCount": source["trackCount"],
                "multiContentFileNameCount": source["multiContentFileNameCount"],
                "referenceScope": source["referenceScope"],
                "isHistoricalFrozenSnapshot": source["isHistoricalFrozenSnapshot"],
                "allowedUses": source["allowedUses"],
                "forbiddenUses": source["forbiddenUses"],
                "warning": source["warning"],
                "constructionCounts": counts,
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
    except New357RecoveryError as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)
