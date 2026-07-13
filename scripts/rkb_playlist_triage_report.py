import hashlib
import json
import math
from pathlib import Path
from typing import Any

import benchmark_rkb_rekordbox_truth as benchmark
from rkb_sealed_batch_common import (
    MANIFEST_NAME,
    SOLVER_LOCK_NAME,
    STATE_NAME,
    audio_roster_hash,
    batch_directories,
    load_json,
    sha256_file,
    truth_tracks,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
REPORT_SCHEMA_VERSION = 6
REPORT_TYPE = "rekordbox-grid-diff-triage"
PRODUCTION_SOLVER_MODE = "bridge-production-runtime-constant-grid"
FINALIZATION_NAME = "finalization.json"
BENCHMARK_NAME = "benchmark.json"
TRUTH_NAME = "truth.json"
PRODUCTION_SOLVER_SOURCE_FILES = (
    "benchmark_rkb_rekordbox_truth.py",
    "beat_this_bridge.py",
    "beat_this_bpm_metrics.py",
    "beat_this_candidate_solver.py",
    "beat_this_full_logit_rescue.py",
    "beat_this_full_logit_utils.py",
    "beat_this_grid_rescue.py",
    "beat_this_grid_solver.py",
    "beat_this_phase_arbitration.py",
    "beat_this_phase_rescue.py",
    "beat_this_runtime_constant_grid.py",
    "beat_this_window_selection.py",
    "rkb_beatgrid_candidate_lab.py",
    "rkb_constant_grid_dp_high_structural.py",
    "rkb_constant_grid_dp_octave.py",
    "rkb_constant_grid_dp_phase_path.py",
    "rkb_constant_grid_dp_selection.py",
    "rkb_constant_grid_dp_solver.py",
    "rkb_locked_phase_ranker.py",
    "rkb_playlist_triage_report.py",
    "rkb_runtime_grid_common.py",
    "move_rekordbox_playlist_grid_diffs.py",
)


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _to_int(value: Any) -> int | None:
    numeric = _to_float(value)
    return int(round(numeric)) if numeric is not None else None


def stable_json_sha256(payload: Any) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _solver_source_sha256() -> str:
    scripts_root = REPO_ROOT / "scripts"
    paths = [scripts_root / file_name for file_name in PRODUCTION_SOLVER_SOURCE_FILES]
    digest = hashlib.sha256()
    for path in paths:
        if not path.exists() or not path.is_file():
            raise RuntimeError(f"production solver source file is missing: {path}")
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def runtime_constant_grid_enabled(tuning: dict[str, Any]) -> bool:
    return str(tuning.get("gridSolverPolicy") or "").strip().lower() != "off"


def enable_production_runtime_constant_grid(bridge: Any) -> None:
    original = bridge._analyze_prepared_windows_to_track_result

    def analyze_with_production_grid(*args: Any, **kwargs: Any) -> dict[str, Any]:
        tuning = args[4] if len(args) > 4 and isinstance(args[4], dict) else {}
        kwargs["use_runtime_constant_grid"] = runtime_constant_grid_enabled(tuning)
        return original(*args, **kwargs)

    bridge._analyze_prepared_windows_to_track_result = analyze_with_production_grid


def build_solver_identity(
    bridge: Any,
    *,
    checkpoint_path: str,
    device: str,
    tuning: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved_tuning = dict(tuning or bridge._resolve_anchor_tuning())
    solver_module = benchmark._load_constant_grid_dp_solver_module()
    checkpoint = Path(checkpoint_path)
    if not checkpoint.exists() or not checkpoint.is_file():
        raise RuntimeError(f"BeatThis checkpoint not found: {checkpoint}")
    config = {
        "device": str(device or "cpu").strip().lower() or "cpu",
        "sampleRate": benchmark.SAMPLE_RATE,
        "channels": benchmark.CHANNELS,
        "windowSec": benchmark.WINDOW_SEC,
        "maxScanSec": benchmark.MAX_SCAN_SEC,
        "tuning": resolved_tuning,
        "runtimeConstantGridEnabled": runtime_constant_grid_enabled(resolved_tuning),
    }
    source_sha256 = _solver_source_sha256()
    config_sha256 = stable_json_sha256(config)
    solver_version = str(getattr(solver_module, "SOLVER_VERSION", "") or "").strip()
    if not solver_version:
        raise RuntimeError("production constant-grid solver has no SOLVER_VERSION")
    combined = {
        "mode": PRODUCTION_SOLVER_MODE,
        "solverVersion": solver_version,
        "sourceSha256": source_sha256,
        "checkpointSha256": _file_sha256(checkpoint),
        "configSha256": config_sha256,
    }
    return {
        **combined,
        "checkpointSize": int(checkpoint.stat().st_size),
        "config": config,
        "solverConfigSha256": stable_json_sha256(combined),
    }


def _snapshot_float(value: Any, digits: int) -> float | None:
    numeric = _to_float(value)
    return round(numeric, digits) if numeric is not None else None


def snapshot_track(raw_track: dict[str, Any]) -> dict[str, Any]:
    return {
        "rowKey": str(raw_track.get("rowKey") or "").strip(),
        "trackId": _to_int(raw_track.get("trackId")),
        "entryIndex": _to_int(raw_track.get("entryIndex")),
        "fileName": str(raw_track.get("fileName") or "").strip(),
        "filePath": str(raw_track.get("filePath") or "").strip(),
        "title": str(raw_track.get("title") or "").strip(),
        "artist": str(raw_track.get("artist") or "").strip(),
        "gridBpm": _snapshot_float(raw_track.get("gridBpm"), 9),
        "gridFirstBeatMs": _snapshot_float(raw_track.get("gridFirstBeatMs"), 6),
        "gridFirstBeatLabel": _to_int(raw_track.get("gridFirstBeatLabel")),
        "gridBarBeatOffset": _to_int(raw_track.get("gridBarBeatOffset")),
    }


def select_raw_tracks(
    raw_tracks: list[dict[str, Any]],
    *,
    only_filters: list[str],
    limit: int,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for raw_track in raw_tracks:
        haystack = " ".join(
            str(raw_track.get(key) or "") for key in ("fileName", "title", "artist")
        ).casefold()
        if only_filters and not any(item in haystack for item in only_filters):
            continue
        selected.append(raw_track)
        if limit > 0 and len(selected) >= limit:
            break
    return selected


def build_batch_snapshot(
    *,
    playlist_id: int,
    playlist_name: str,
    raw_tracks: list[dict[str, Any]],
    selected_tracks: list[dict[str, Any]],
    only_filters: list[str],
    limit: int,
) -> dict[str, Any]:
    selection = {"onlyFilters": list(only_filters), "limit": max(0, int(limit))}
    playlist_entries = [snapshot_track(track) for track in raw_tracks]
    denominator_entries = [snapshot_track(track) for track in selected_tracks]
    playlist_core = {
        "playlistId": playlist_id,
        "playlistName": playlist_name,
        "trackCount": len(playlist_entries),
        "entries": playlist_entries,
    }
    denominator_core = {
        "playlistId": playlist_id,
        "selection": selection,
        "trackCount": len(denominator_entries),
        "entries": denominator_entries,
    }
    playlist_sha256 = stable_json_sha256(playlist_core)
    denominator_sha256 = stable_json_sha256(denominator_core)
    return {
        "batchId": f"rekordbox-{playlist_id}-{denominator_sha256[:16]}",
        "sourcePlaylistId": playlist_id,
        "sourcePlaylistName": playlist_name,
        "sourcePlaylistTrackCount": len(playlist_entries),
        "originalDenominatorTrackCount": len(denominator_entries),
        "selection": selection,
        "playlistSnapshotSha256": playlist_sha256,
        "denominatorSnapshotSha256": denominator_sha256,
        "playlistEntries": playlist_entries,
        "denominatorEntries": denominator_entries,
    }


def _safe_sealed_batch_dir(batches_root: Path, batch_id: str) -> Path:
    normalized = str(batch_id or "").strip()
    component = Path(normalized)
    if (
        not normalized
        or component.is_absolute()
        or len(component.parts) != 1
        or component.name != normalized
    ):
        raise RuntimeError(f"sealed batchId is invalid: {batch_id!r}")
    batch_dir = batches_root.resolve() / normalized
    if not batch_dir.is_dir():
        raise RuntimeError(f"sealed batch not found: {batch_dir}")
    return batch_dir


def _normalized_file_names(entries: list[dict[str, Any]], label: str) -> list[str]:
    names = [_normalize_key(entry.get("fileName")) for entry in entries]
    if any(not name for name in names):
        raise RuntimeError(f"{label} contains an empty fileName")
    if len(set(names)) != len(names):
        raise RuntimeError(f"{label} contains duplicate fileName values")
    return sorted(names)


def build_denominator_audio_identities(
    tracks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    identities: list[dict[str, Any]] = []
    for track in tracks:
        file_name = str(track.get("fileName") or "").strip()
        file_path = Path(str(track.get("filePath") or "")).resolve()
        if not file_name or not file_path.is_file():
            raise RuntimeError(f"triage audio identity source is missing: {file_name or file_path}")
        stat = file_path.stat()
        identities.append(
            {
                "fileName": file_name,
                "filePath": str(file_path),
                "size": int(stat.st_size),
                "assetSha256": sha256_file(file_path),
            }
        )
    _normalized_file_names(identities, "triage audio identity roster")
    return sorted(identities, key=lambda item: _normalize_key(item.get("fileName")))


def _audio_identity_map(
    entries: list[dict[str, Any]], label: str
) -> dict[str, dict[str, Any]]:
    names = _normalized_file_names(entries, label)
    result: dict[str, dict[str, Any]] = {}
    for name, entry in zip(names, sorted(entries, key=lambda item: _normalize_key(item.get("fileName")))):
        asset_sha256 = str(entry.get("assetSha256") or "").strip().casefold()
        file_path = str(entry.get("filePath") or "").strip()
        size = _to_int(entry.get("size"))
        if len(asset_sha256) != 64 or not file_path or size is None or size < 0:
            raise RuntimeError(f"{label} contains an incomplete strong audio identity: {name}")
        result[name] = {
            "fileName": str(entry.get("fileName") or "").strip(),
            "filePath": file_path,
            "size": size,
            "assetSha256": asset_sha256,
        }
    return result


def verify_denominator_audio_identity_files(
    entries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    identity_map = _audio_identity_map(entries, "report audio identity roster")
    verified: list[dict[str, Any]] = []
    for name in sorted(identity_map):
        expected = identity_map[name]
        file_path = Path(expected["filePath"])
        if not file_path.is_file():
            raise RuntimeError(f"triage audio changed after dry-run; file is missing: {file_path}")
        stat = file_path.stat()
        if int(stat.st_size) != int(expected["size"]):
            raise RuntimeError(f"triage audio changed after dry-run; size mismatch: {file_path}")
        if sha256_file(file_path).casefold() != expected["assetSha256"]:
            raise RuntimeError(f"triage audio changed after dry-run; SHA-256 mismatch: {file_path}")
        verified.append(dict(expected))
    return verified


def _required_transition_history(state: dict[str, Any]) -> None:
    history = state.get("history")
    if not isinstance(history, list):
        raise RuntimeError("sealed batch state has no lifecycle history")
    transitions = [
        str(item.get("to") or "")
        for item in history
        if isinstance(item, dict) and str(item.get("to") or "")
    ]
    cursor = 0
    expected = ("fresh", "evaluating", "exposed", "consumed")
    for transition in transitions:
        if cursor < len(expected) and transition == expected[cursor]:
            cursor += 1
    if cursor != len(expected):
        raise RuntimeError("sealed batch lifecycle history is incomplete")


def _full_batch_entries(batch: dict[str, Any]) -> list[dict[str, Any]]:
    playlist_entries = _require_dict_list(batch.get("playlistEntries"), "batch.playlistEntries")
    denominator_entries = _require_dict_list(
        batch.get("denominatorEntries"), "batch.denominatorEntries"
    )
    selection = _require_dict(batch.get("selection"), "batch.selection")
    filters = [_normalize_key(value) for value in selection.get("onlyFilters") or [] if _normalize_key(value)]
    limit = max(0, int(selection.get("limit") or 0))
    if filters or limit:
        raise RuntimeError(
            "sealed/consumed triage requires the complete playlist; --only and --limit are forbidden"
        )
    playlist_names = _normalized_file_names(playlist_entries, "triage playlist")
    denominator_names = _normalized_file_names(denominator_entries, "triage denominator")
    if playlist_names != denominator_names:
        raise RuntimeError("triage denominator must equal the complete source playlist")
    return denominator_entries


def _manifest_roster(
    manifest: dict[str, Any], truth_rows: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[str], str]:
    roster = [item for item in manifest.get("audioRoster") or [] if isinstance(item, dict)]
    audio = manifest.get("audio") if isinstance(manifest.get("audio"), dict) else {}
    if not roster or int(audio.get("trackCount") or -1) != len(roster):
        raise RuntimeError("consumed batch manifest audio roster is missing or incomplete")
    try:
        roster_hash = audio_roster_hash(roster)
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("consumed batch manifest audio roster is invalid") from error
    if roster_hash != str(audio.get("rosterHash") or ""):
        raise RuntimeError("consumed batch manifest audio roster hash mismatch")
    truth_names = _normalized_file_names(truth_rows, "consumed truth")
    roster_names = _normalized_file_names(roster, "consumed audio roster")
    if truth_names != roster_names:
        raise RuntimeError("consumed truth and audio roster do not match exactly")
    return roster, roster_names, roster_hash


def _registry_batch_rows(
    *,
    registry_path: Path,
    batch_id: str,
    manifest_sha256: str,
    state_sha256: str,
    roster_by_name: dict[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], str]:
    if not registry_path.is_file():
        raise RuntimeError(f"dataset registry not found: {registry_path}")
    registry = load_json(registry_path)
    normalized_batch_id = _normalize_key(batch_id)
    batch_rows = [
        item
        for item in registry.get("batches") or []
        if isinstance(item, dict) and _normalize_key(item.get("batchId")) == normalized_batch_id
    ]
    if len(batch_rows) != 1:
        raise RuntimeError(f"consumed batch is missing or duplicated in dataset registry: {batch_id}")
    registry_batch = batch_rows[0]
    if (
        str(registry_batch.get("status") or "") != "consumed"
        or str(registry_batch.get("manifestSha256") or "") != manifest_sha256
        or str(registry_batch.get("stateSha256") or "") != state_sha256
    ):
        raise RuntimeError("dataset registry consumed batch proof does not match manifest/state")
    rows = [
        item
        for item in registry.get("tracks") or []
        if isinstance(item, dict) and _normalize_key(item.get("batchId")) == normalized_batch_id
    ]
    if len(rows) != int(registry_batch.get("trackCount") or -1):
        raise RuntimeError("dataset registry consumed batch track count is inconsistent")
    registry_by_name: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = _normalize_key(row.get("fileName"))
        asset_sha256 = str(row.get("assetSha256") or "").strip().casefold()
        if (
            not name
            or name in registry_by_name
            or str(row.get("batchStatus") or "") != "consumed"
            or len(asset_sha256) != 64
        ):
            raise RuntimeError("dataset registry consumed track identity is incomplete or duplicated")
        registry_by_name[name] = row
    if set(registry_by_name) != set(roster_by_name):
        raise RuntimeError("dataset registry tracks do not match the consumed audio roster exactly")
    for name, roster_row in roster_by_name.items():
        if str(registry_by_name[name].get("assetSha256") or "").strip().casefold() != str(
            roster_row.get("assetSha256") or ""
        ).strip().casefold():
            raise RuntimeError(f"dataset registry asset identity mismatch: {name}")
    return registry_by_name, sha256_file(registry_path)


def _build_consumed_roster_proof(
    *,
    batches_root: Path,
    registry_path: Path,
    batch_id: str,
    playlist_id: int,
    playlist_name: str,
    batch: dict[str, Any],
    denominator_audio_identities: list[dict[str, Any]],
) -> dict[str, Any]:
    denominator_entries = _full_batch_entries(batch)
    batch_dir = _safe_sealed_batch_dir(batches_root, batch_id)
    manifest_path = batch_dir / MANIFEST_NAME
    state_path = batch_dir / STATE_NAME
    truth_path = batch_dir / TRUTH_NAME
    missing = [str(path) for path in (manifest_path, state_path, truth_path) if not path.is_file()]
    if missing:
        raise RuntimeError("consumed batch proof is incomplete: " + ", ".join(missing))
    manifest = load_json(manifest_path)
    state = load_json(state_path)
    truth = load_json(truth_path)
    normalized_batch_id = str(batch_id).strip()
    if str(manifest.get("batchId") or "") != normalized_batch_id:
        raise RuntimeError("consumed manifest batchId mismatch")
    if str(state.get("batchId") or "") != normalized_batch_id:
        raise RuntimeError("consumed state batchId mismatch")
    if str(state.get("status") or "") != "consumed":
        raise RuntimeError("maintenance batch must already be consumed")
    manifest_sha256 = sha256_file(manifest_path)
    state_sha256 = sha256_file(state_path)
    truth_sha256 = sha256_file(truth_path)
    if str(state.get("manifestSha256") or "") != manifest_sha256:
        raise RuntimeError("consumed state manifest hash mismatch")
    manifest_truth = manifest.get("truth") if isinstance(manifest.get("truth"), dict) else {}
    truth_rows = truth_tracks(truth, truth_path)
    if (
        str(manifest_truth.get("sha256") or "") != truth_sha256
        or int(manifest_truth.get("trackCount") or -1) != len(truth_rows)
    ):
        raise RuntimeError("consumed manifest truth hash/count mismatch")
    roster, roster_names, roster_hash = _manifest_roster(manifest, truth_rows)
    roster_by_name = {_normalize_key(item.get("fileName")): item for item in roster}
    registry_by_name, registry_sha256 = _registry_batch_rows(
        registry_path=registry_path,
        batch_id=normalized_batch_id,
        manifest_sha256=manifest_sha256,
        state_sha256=state_sha256,
        roster_by_name=roster_by_name,
    )
    denominator_names = _normalized_file_names(denominator_entries, "triage denominator")
    if denominator_names != roster_names:
        raise RuntimeError(
            "triage playlist denominator must match the frozen truth/audio roster exactly; "
            "missing or extra tracks are forbidden"
        )
    identity_by_name = _audio_identity_map(
        denominator_audio_identities, "triage strong audio identity roster"
    )
    if set(identity_by_name) != set(roster_by_name):
        raise RuntimeError("triage strong audio identities do not cover the frozen roster exactly")
    for name, identity in identity_by_name.items():
        expected_asset = str(roster_by_name[name].get("assetSha256") or "").strip().casefold()
        registry_asset = str(registry_by_name[name].get("assetSha256") or "").strip().casefold()
        if identity["assetSha256"] != expected_asset or identity["assetSha256"] != registry_asset:
            raise RuntimeError(f"triage audio is not the consumed registry asset: {name}")
    ordered_identities = [identity_by_name[name] for name in sorted(identity_by_name)]
    origin = manifest.get("origin") if isinstance(manifest.get("origin"), dict) else {}
    return {
        "batchDir": str(batch_dir),
        "manifest": manifest,
        "state": state,
        "guard": {
            "freshProofEligible": False,
            "lifecycleVerified": True,
            "registryVerified": True,
            "strongIdentityVerified": True,
            "batchId": normalized_batch_id,
            "batchOrigin": str(origin.get("kind") or ""),
            "batchDir": str(batch_dir),
            "sourcePlaylistId": int(playlist_id),
            "sourcePlaylistName": str(playlist_name),
            "batchRosterTrackCount": len(roster_names),
            "batchRosterFileNames": roster_names,
            "batchRosterFileNamesSha256": stable_json_sha256(roster_names),
            "denominatorAudioIdentities": ordered_identities,
            "denominatorAudioIdentitiesSha256": stable_json_sha256(ordered_identities),
            "manifestSha256": manifest_sha256,
            "stateSha256": state_sha256,
            "truthSha256": truth_sha256,
            "audioRosterHash": roster_hash,
            "registryPath": str(registry_path.resolve()),
            "registrySha256": registry_sha256,
        },
    }


def _active_sealed_batches(batches_root: Path) -> list[str]:
    active: list[str] = []
    if not batches_root.is_dir():
        return active
    for batch_dir in batch_directories(batches_root.resolve()):
        state_path = batch_dir / STATE_NAME
        if not state_path.is_file():
            continue
        state = load_json(state_path)
        status = str(state.get("status") or "")
        if status in {"fresh", "evaluating", "exposed"}:
            active.append(f"{batch_dir.name}:{status}")
    return active


def _require_no_active_sealed_batch(batches_root: Path, owner: str) -> None:
    active = _active_sealed_batches(batches_root)
    if active:
        raise RuntimeError(f"{owner} is blocked while a sealed batch is active: " + ", ".join(active))


def build_sealed_triage_guard(
    *,
    batches_root: Path,
    registry_path: Path,
    batch_id: str,
    playlist_id: int,
    playlist_name: str,
    batch: dict[str, Any],
    denominator_audio_identities: list[dict[str, Any]],
) -> dict[str, Any]:
    _require_no_active_sealed_batch(batches_root, "sealed triage")
    proof = _build_consumed_roster_proof(
        batches_root=batches_root,
        registry_path=registry_path,
        batch_id=batch_id,
        playlist_id=playlist_id,
        playlist_name=playlist_name,
        batch=batch,
        denominator_audio_identities=denominator_audio_identities,
    )
    batch_dir = Path(proof["batchDir"])
    manifest = proof["manifest"]
    state = proof["state"]
    solver_lock_path = batch_dir / SOLVER_LOCK_NAME
    benchmark_path = batch_dir / BENCHMARK_NAME
    finalization_path = batch_dir / FINALIZATION_NAME
    required_paths = (
        solver_lock_path,
        benchmark_path,
        finalization_path,
    )
    missing = [str(path) for path in required_paths if not path.is_file()]
    if missing:
        raise RuntimeError("sealed batch proof is incomplete: " + ", ".join(missing))

    solver_lock = load_json(solver_lock_path)
    finalization = load_json(finalization_path)
    normalized_batch_id = str(batch_id).strip()
    if str(manifest.get("batchId") or "") != normalized_batch_id:
        raise RuntimeError("sealed manifest batchId mismatch")
    if str(state.get("batchId") or "") != normalized_batch_id:
        raise RuntimeError("sealed state batchId mismatch")
    if str(finalization.get("batchId") or "") != normalized_batch_id:
        raise RuntimeError("sealed finalization batchId mismatch")
    origin = manifest.get("origin") if isinstance(manifest.get("origin"), dict) else {}
    if str(origin.get("kind") or "") != "sealed-fresh":
        raise RuntimeError("triage sealed proof must come from a sealed-fresh batch")
    if str(state.get("status") or "") != "consumed":
        raise RuntimeError("sealed batch must be consumed before triage")
    _required_transition_history(state)

    solver_lock_file_sha256 = sha256_file(solver_lock_path)
    benchmark_sha256 = sha256_file(benchmark_path)
    finalization_sha256 = sha256_file(finalization_path)
    if str(state.get("solverLockFileSha256") or "") != solver_lock_file_sha256:
        raise RuntimeError("sealed state solver-lock file hash mismatch")
    if str(state.get("solverLockHash") or "") != str(solver_lock.get("lockHash") or ""):
        raise RuntimeError("sealed state solver lockHash mismatch")
    evaluation = state.get("evaluation") if isinstance(state.get("evaluation"), dict) else {}
    if str(evaluation.get("status") or "") != "complete":
        raise RuntimeError("sealed evaluation is not complete")
    if str(evaluation.get("benchmarkSha256") or "") != benchmark_sha256:
        raise RuntimeError("sealed benchmark hash mismatch")
    state_finalization = (
        state.get("finalization") if isinstance(state.get("finalization"), dict) else {}
    )
    if str(state_finalization.get("sha256") or "") != finalization_sha256:
        raise RuntimeError("sealed finalization hash mismatch")
    if str(finalization.get("solverLockHash") or "") != str(solver_lock.get("lockHash") or ""):
        raise RuntimeError("sealed finalization solver lockHash mismatch")
    if str(finalization.get("benchmarkSha256") or "") != benchmark_sha256:
        raise RuntimeError("sealed finalization benchmark hash mismatch")

    playlist = manifest.get("playlist") if isinstance(manifest.get("playlist"), dict) else {}
    if (_to_int(playlist.get("id")) or 0) != int(playlist_id):
        raise RuntimeError("sealed batch playlistId does not match triage source")
    if _normalize_key(playlist.get("name")) != _normalize_key(playlist_name):
        raise RuntimeError("sealed batch playlistName does not match triage source")
    return {
        **proof["guard"],
        "mode": "sealed-consumed",
        "solverLockFileSha256": solver_lock_file_sha256,
        "solverLockHash": str(solver_lock.get("lockHash") or ""),
        "benchmarkSha256": benchmark_sha256,
        "finalizationSha256": finalization_sha256,
        "decision": str(finalization.get("decision") or ""),
    }


def build_consumed_maintenance_guard(
    *,
    batches_root: Path,
    registry_path: Path,
    batch_id: str,
    playlist_id: int,
    playlist_name: str,
    batch: dict[str, Any],
    denominator_audio_identities: list[dict[str, Any]],
) -> dict[str, Any]:
    _require_no_active_sealed_batch(batches_root, "consumed maintenance")
    proof = _build_consumed_roster_proof(
        batches_root=batches_root,
        registry_path=registry_path,
        batch_id=batch_id,
        playlist_id=playlist_id,
        playlist_name=playlist_name,
        batch=batch,
        denominator_audio_identities=denominator_audio_identities,
    )
    return {
        **proof["guard"],
        "mode": "consumed-maintenance",
        "maintenanceOnly": True,
        "activeSealedBatchCount": 0,
        "batchesRoot": str(batches_root.resolve()),
    }


def build_pre_review_guard(
    *,
    batches_root: Path,
    playlist_id: int,
    playlist_name: str,
    batch: dict[str, Any],
    denominator_audio_identities: list[dict[str, Any]],
) -> dict[str, Any]:
    """Bind the full roster and audio identities for manual label QA.

    Comparing with the current baseline only determines which tracks need a
    person to inspect. It does not itself decide a later candidate's evidence.
    """
    _require_no_active_sealed_batch(batches_root, "pre-review label QA")
    denominator_entries = _full_batch_entries(batch)
    denominator_names = _normalized_file_names(denominator_entries, "pre-review denominator")
    identity_map = _audio_identity_map(
        denominator_audio_identities, "pre-review strong audio identity roster"
    )
    if sorted(identity_map) != denominator_names:
        raise RuntimeError("pre-review strong audio identities do not cover the complete playlist")
    ordered_identities = [identity_map[name] for name in sorted(identity_map)]
    return {
        "mode": "pre-review-label-qa",
        "labelQaOnly": True,
        "reportIsFreshProof": False,
        "activeSealedBatchCount": 0,
        "strongIdentityVerified": True,
        "sourcePlaylistId": int(playlist_id),
        "sourcePlaylistName": str(playlist_name),
        "batchRosterTrackCount": len(denominator_names),
        "batchRosterFileNames": denominator_names,
        "batchRosterFileNamesSha256": stable_json_sha256(denominator_names),
        "denominatorAudioIdentities": ordered_identities,
        "denominatorAudioIdentitiesSha256": stable_json_sha256(ordered_identities),
    }


def attach_report_integrity(payload: dict[str, Any]) -> dict[str, Any]:
    unsigned = {key: value for key, value in payload.items() if key != "integrity"}
    return {
        **unsigned,
        "integrity": {"algorithm": "sha256", "payloadSha256": stable_json_sha256(unsigned)},
    }


def _require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"report {label} is missing or invalid")
    return value


def _validated_apply_request(summary: dict[str, Any]) -> dict[str, Any]:
    target_playlist = str(summary.get("targetPlaylistName") or "").strip()
    target_parent_id = _to_int(summary.get("targetParentId"))
    operation = str(summary.get("requestedOperation") or "").strip()
    if not target_playlist:
        raise RuntimeError("report apply target playlist is missing")
    if target_parent_id is None or target_parent_id < 0:
        raise RuntimeError("report apply target parent id is invalid")
    if operation not in {"move", "copy"}:
        raise RuntimeError("report requested move/copy operation is invalid")
    return {
        "targetPlaylistName": target_playlist,
        "targetParentId": target_parent_id,
        "requestedOperation": operation,
    }


def validate_apply_request(
    summary: dict[str, Any],
    *,
    target_playlist: str,
    target_parent_id: int,
    copy_only: bool,
) -> None:
    expected = _validated_apply_request(summary)
    requested = {
        "targetPlaylistName": str(target_playlist or "").strip(),
        "targetParentId": int(target_parent_id),
        "requestedOperation": "copy" if copy_only else "move",
    }
    if (
        _normalize_key(expected["targetPlaylistName"])
        != _normalize_key(requested["targetPlaylistName"])
        or expected["targetParentId"] != requested["targetParentId"]
        or expected["requestedOperation"] != requested["requestedOperation"]
    ):
        raise RuntimeError(
            "apply target/parent/move-copy request does not match the dry-run report; "
            "rerun dry-run before applying"
        )


def _require_dict_list(value: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise RuntimeError(f"report {label} is missing or invalid")
    return list(value)


def _row_key_map(entries: list[dict[str, Any]], label: str) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        row_key = str(entry.get("rowKey") or entry.get("sourceRowKey") or "").strip()
        if not row_key:
            raise RuntimeError(f"report {label} contains an entry without rowKey")
        if row_key in result:
            raise RuntimeError(f"report {label} contains duplicate rowKey: {row_key}")
        result[row_key] = entry
    return result


def _validate_solver_identity(solver: dict[str, Any]) -> None:
    config = _require_dict(solver.get("config"), "solver.config")
    source_sha256 = str(solver.get("sourceSha256") or "")
    checkpoint_sha256 = str(solver.get("checkpointSha256") or "")
    if len(source_sha256) != 64 or len(checkpoint_sha256) != 64:
        raise RuntimeError("report solver source/checkpoint hash is invalid")
    if str(solver.get("mode") or "") != PRODUCTION_SOLVER_MODE:
        raise RuntimeError("report solver mode is not production runtime constant-grid")
    config_sha256 = stable_json_sha256(config)
    if config_sha256 != str(solver.get("configSha256") or ""):
        raise RuntimeError("report solver config hash is inconsistent")
    combined = {
        "mode": str(solver.get("mode") or ""),
        "solverVersion": str(solver.get("solverVersion") or ""),
        "sourceSha256": source_sha256,
        "checkpointSha256": checkpoint_sha256,
        "configSha256": config_sha256,
    }
    if not combined["solverVersion"]:
        raise RuntimeError("report solver version is missing")
    if stable_json_sha256(combined) != str(solver.get("solverConfigSha256") or ""):
        raise RuntimeError("report solver/config hash is inconsistent")


def _validate_workflow_guard(
    guard: dict[str, Any], batch: dict[str, Any]
) -> None:
    mode = str(guard.get("mode") or "")
    if mode != "pre-review-label-qa" and bool(guard.get("freshProofEligible")):
        raise RuntimeError("triage workflow guard cannot be fresh-proof eligible")
    if mode not in {"sealed-consumed", "consumed-maintenance", "pre-review-label-qa"}:
        raise RuntimeError("report workflow guard is missing or invalid")
    if mode == "pre-review-label-qa":
        if not bool(guard.get("labelQaOnly")) or bool(guard.get("reportIsFreshProof")):
            raise RuntimeError("pre-review label-QA workflow guard is invalid")
        if _to_int(guard.get("activeSealedBatchCount")) != 0:
            raise RuntimeError("pre-review label-QA requires no active sealed batch")
    elif not all(
        bool(guard.get(key))
        for key in ("lifecycleVerified", "registryVerified", "strongIdentityVerified")
    ):
        raise RuntimeError("report workflow guard did not verify lifecycle/registry/audio identity")
    if (_to_int(guard.get("sourcePlaylistId")) or 0) != (
        _to_int(batch.get("sourcePlaylistId")) or 0
    ):
        raise RuntimeError("workflow guard playlistId mismatch")
    if _normalize_key(guard.get("sourcePlaylistName")) != _normalize_key(
        batch.get("sourcePlaylistName")
    ):
        raise RuntimeError("workflow guard playlistName mismatch")
    roster_names_raw = guard.get("batchRosterFileNames")
    if not isinstance(roster_names_raw, list):
        raise RuntimeError("workflow guard has no frozen filename roster")
    roster_names = [str(value) for value in roster_names_raw]
    if (
        len(roster_names) != int(guard.get("batchRosterTrackCount") or -1)
        or stable_json_sha256(roster_names)
        != str(guard.get("batchRosterFileNamesSha256") or "")
    ):
        raise RuntimeError("workflow guard frozen roster is inconsistent")
    denominator_entries = _full_batch_entries(batch)
    denominator_names = _normalized_file_names(
        denominator_entries, "report denominator"
    )
    if roster_names != denominator_names:
        raise RuntimeError("report denominator does not exactly match the frozen roster")
    identities = _require_dict_list(
        guard.get("denominatorAudioIdentities"), "workflowGuard.denominatorAudioIdentities"
    )
    identity_map = _audio_identity_map(identities, "workflow guard audio identity roster")
    if sorted(identity_map) != roster_names:
        raise RuntimeError("workflow guard strong identities do not match the frozen roster")
    ordered_identities = [identity_map[name] for name in sorted(identity_map)]
    if stable_json_sha256(ordered_identities) != str(
        guard.get("denominatorAudioIdentitiesSha256") or ""
    ):
        raise RuntimeError("workflow guard audio identity hash is inconsistent")
    if mode == "pre-review-label-qa":
        return
    common_hash_fields = (
        "manifestSha256",
        "stateSha256",
        "truthSha256",
        "audioRosterHash",
        "registrySha256",
    )
    if any(len(str(guard.get(key) or "")) != 64 for key in common_hash_fields):
        raise RuntimeError("workflow guard contains an invalid consumed proof hash")
    if not str(guard.get("registryPath") or "").strip():
        raise RuntimeError("workflow guard dataset registry path is missing")
    if mode == "consumed-maintenance":
        active_count = _to_int(guard.get("activeSealedBatchCount"))
        if not bool(guard.get("maintenanceOnly")) or active_count != 0:
            raise RuntimeError("consumed maintenance guard is invalid")
        return
    sealed_hash_fields = (
        "solverLockFileSha256",
        "solverLockHash",
        "benchmarkSha256",
        "finalizationSha256",
    )
    if any(len(str(guard.get(key) or "")) != 64 for key in sealed_hash_fields):
        raise RuntimeError("sealed workflow guard contains an invalid hash")


def _validate_batch_snapshot(batch: dict[str, Any]) -> dict[str, dict[str, Any]]:
    playlist_id = _to_int(batch.get("sourcePlaylistId")) or 0
    playlist_name = str(batch.get("sourcePlaylistName") or "").strip()
    playlist_entries = _require_dict_list(batch.get("playlistEntries"), "batch.playlistEntries")
    denominator_entries = _require_dict_list(
        batch.get("denominatorEntries"), "batch.denominatorEntries"
    )
    selection = _require_dict(batch.get("selection"), "batch.selection")
    if playlist_id <= 0 or not playlist_name:
        raise RuntimeError("report batch source playlist identity is invalid")
    if int(batch.get("sourcePlaylistTrackCount") or -1) != len(playlist_entries):
        raise RuntimeError("report source playlist track count is inconsistent")
    if int(batch.get("originalDenominatorTrackCount") or -1) != len(denominator_entries):
        raise RuntimeError("report original denominator count is inconsistent")
    playlist_core = {
        "playlistId": playlist_id,
        "playlistName": playlist_name,
        "trackCount": len(playlist_entries),
        "entries": playlist_entries,
    }
    denominator_core = {
        "playlistId": playlist_id,
        "selection": selection,
        "trackCount": len(denominator_entries),
        "entries": denominator_entries,
    }
    playlist_sha256 = stable_json_sha256(playlist_core)
    denominator_sha256 = stable_json_sha256(denominator_core)
    if playlist_sha256 != str(batch.get("playlistSnapshotSha256") or ""):
        raise RuntimeError("report source playlist snapshot hash is inconsistent")
    if denominator_sha256 != str(batch.get("denominatorSnapshotSha256") or ""):
        raise RuntimeError("report denominator snapshot hash is inconsistent")
    if str(batch.get("batchId") or "") != f"rekordbox-{playlist_id}-{denominator_sha256[:16]}":
        raise RuntimeError("report batchId is inconsistent")
    playlist_by_row = _row_key_map(playlist_entries, "batch.playlistEntries")
    denominator_by_row = _row_key_map(denominator_entries, "batch.denominatorEntries")
    for row_key, expected in denominator_by_row.items():
        if playlist_by_row.get(row_key) != expected:
            raise RuntimeError(
                f"report denominator row is not identical to playlist snapshot: {row_key}"
            )
    return denominator_by_row


def validate_report_payload(payload: dict[str, Any]) -> None:
    if int(payload.get("schemaVersion") or 0) != REPORT_SCHEMA_VERSION:
        raise RuntimeError("report schema is obsolete; rerun dry-run before applying")
    if str(payload.get("reportType") or "") != REPORT_TYPE:
        raise RuntimeError("report type is invalid")
    integrity = _require_dict(payload.get("integrity"), "integrity")
    unsigned = {key: value for key, value in payload.items() if key != "integrity"}
    if (
        str(integrity.get("algorithm") or "") != "sha256"
        or stable_json_sha256(unsigned) != str(integrity.get("payloadSha256") or "")
    ):
        raise RuntimeError("report integrity check failed; the report is incomplete or modified")

    summary = _require_dict(payload.get("summary"), "summary")
    source = _require_dict(summary.get("sourcePlaylist"), "summary.sourcePlaylist")
    batch = _require_dict(payload.get("batch"), "batch")
    solver = _require_dict(payload.get("solver"), "solver")
    workflow_guard = _require_dict(payload.get("workflowGuard"), "workflowGuard")
    rows = _require_dict_list(payload.get("rows"), "rows")
    errors = _require_dict_list(payload.get("errors"), "errors")
    differences = _require_dict_list(payload.get("differences"), "differences")
    _validated_apply_request(summary)
    denominator_by_row = _validate_batch_snapshot(batch)
    _validate_solver_identity(solver)
    _validate_workflow_guard(workflow_guard, batch)

    source_checks = (
        ((_to_int(source.get("playlistId")) or 0), (_to_int(batch.get("sourcePlaylistId")) or 0)),
        (str(source.get("playlistName") or ""), str(batch.get("sourcePlaylistName") or "")),
        (int(source.get("trackTotal") or -1), int(batch.get("sourcePlaylistTrackCount") or -2)),
        (int(source.get("selectedTrackCount") or -1), len(denominator_by_row)),
    )
    if any(actual != expected for actual, expected in source_checks):
        raise RuntimeError("report source playlist summary does not match batch snapshot")
    identity_checks = (
        (summary.get("batchId"), batch.get("batchId")),
        (summary.get("denominatorSnapshotSha256"), batch.get("denominatorSnapshotSha256")),
        (summary.get("solverConfigSha256"), solver.get("solverConfigSha256")),
        (
            source.get("playlistSnapshotSha256"),
            batch.get("playlistSnapshotSha256"),
        ),
    )
    if any(actual != expected for actual, expected in identity_checks):
        raise RuntimeError("report summary identity hashes are inconsistent")
    pass_count = sum(
        1
        for row in rows
        if isinstance(row.get("currentTimeline"), dict)
        and str(row["currentTimeline"].get("category") or "") == "pass"
    )
    count_checks = (
        (summary.get("originalDenominatorTrackCount"), len(denominator_by_row)),
        (summary.get("analyzedTrackCount"), len(rows)),
        (summary.get("errorTrackCount"), len(errors)),
        (summary.get("differenceTrackCount"), len(differences)),
        (summary.get("passTrackCount"), pass_count),
    )
    if any(
        int(actual if actual is not None else -1) != expected
        for actual, expected in count_checks
    ):
        raise RuntimeError("report summary counts are inconsistent")
    if len(rows) + len(errors) != len(denominator_by_row):
        raise RuntimeError("report rows/errors do not cover the complete original denominator")
    result_by_row = _row_key_map(rows + errors, "rows/errors")
    if set(result_by_row) != set(denominator_by_row):
        raise RuntimeError("report rows/errors rowKey set does not match the original denominator")
    difference_by_row = _row_key_map(differences, "differences")
    expected_difference_rows = set()
    for row in rows:
        current = row.get("currentTimeline")
        category = str(current.get("category") or "") if isinstance(current, dict) else ""
        if category != "pass":
            expected_difference_rows.add(str(row.get("sourceRowKey") or "").strip())
    expected_difference_rows.update(str(row.get("sourceRowKey") or "").strip() for row in errors)
    if set(difference_by_row) != expected_difference_rows:
        raise RuntimeError("report differences do not match analyzed non-pass/error rows")
    for row_key, difference in difference_by_row.items():
        if _to_int(difference.get("sourceTrackId")) != _to_int(
            denominator_by_row[row_key].get("trackId")
        ):
            raise RuntimeError(f"report difference trackId does not match denominator: {row_key}")


def load_report_for_apply(report_path: Path) -> dict[str, Any]:
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"report is invalid: {report_path}")
    validate_report_payload(payload)
    return payload


def validate_current_solver(report_solver: dict[str, Any], current_solver: dict[str, Any]) -> None:
    if current_solver.get("solverConfigSha256") != report_solver.get("solverConfigSha256"):
        raise RuntimeError(
            "production solver/config changed after dry-run; rerun dry-run before applying"
        )


def validate_current_workflow_guard(
    *,
    report_guard: dict[str, Any],
    batch: dict[str, Any],
    batches_root: Path,
    registry_path: Path,
) -> None:
    mode = str(report_guard.get("mode") or "")
    identities = verify_denominator_audio_identity_files(
        _require_dict_list(
            report_guard.get("denominatorAudioIdentities"),
            "workflowGuard.denominatorAudioIdentities",
        )
    )
    if mode == "consumed-maintenance":
        current = build_consumed_maintenance_guard(
            batches_root=batches_root,
            registry_path=registry_path,
            batch_id=str(report_guard.get("batchId") or ""),
            playlist_id=_to_int(batch.get("sourcePlaylistId")) or 0,
            playlist_name=str(batch.get("sourcePlaylistName") or ""),
            batch=batch,
            denominator_audio_identities=identities,
        )
    elif mode == "sealed-consumed":
        current = build_sealed_triage_guard(
            batches_root=batches_root,
            registry_path=registry_path,
            batch_id=str(report_guard.get("batchId") or ""),
            playlist_id=_to_int(batch.get("sourcePlaylistId")) or 0,
            playlist_name=str(batch.get("sourcePlaylistName") or ""),
            batch=batch,
            denominator_audio_identities=identities,
        )
    elif mode == "pre-review-label-qa":
        current = build_pre_review_guard(
            batches_root=batches_root,
            playlist_id=_to_int(batch.get("sourcePlaylistId")) or 0,
            playlist_name=str(batch.get("sourcePlaylistName") or ""),
            batch=batch,
            denominator_audio_identities=identities,
        )
    else:
        raise RuntimeError("report workflow guard mode is invalid")
    if current != report_guard:
        raise RuntimeError(
            "workflow/audio proof changed after dry-run; rerun dry-run before applying"
        )
