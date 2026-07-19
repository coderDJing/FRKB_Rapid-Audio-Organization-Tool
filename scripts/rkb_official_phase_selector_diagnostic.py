import argparse
import hashlib
import json
import math
import statistics
import subprocess
import time
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from rkb_beatgrid_lab_common import (
    atomic_write_json,
    build_feature_index_map,
    read_feature_metadata,
    resolve_feature_arrays_path,
    resolve_feature_entry,
)
from rkb_grid_acceptance import USABLE_GRID_POLICY_VERSION, assess_usable_grid
from rkb_multiscale_study_inputs import DEFAULT_BENCHMARKS, iter_benchmark_tracks
from rkb_official_phase_selector import (
    HIGH_ATTACK_VERSION,
    SELECTOR_VERSION,
    build_high_attack_envelope,
    candidate_phase_evidence,
    stable_range_residual,
)


DIAGNOSTIC_VERSION = "rkb-official-style-fixed-phase-diagnostic-v1"
DEFAULT_OUTPUT = Path(
    "grid-analysis-lab/rkb-rekordbox-benchmark/official-phase-selector-diagnostic-latest.json"
)
DEFAULT_DATASETS = ("current1407", "blind608", "old377", "test316", "test327", "test353")
FEATURE_CACHE_ROOT = Path(
    "grid-analysis-lab/rkb-rekordbox-benchmark/feature-cache-policy-current"
)
BASE_VARIANT_NAMES = (
    "overall-argmax",
    "overall-shape",
    "overall-mod4-shape",
    "stable-residual",
    "stable-overall-mod4-shape",
)
GUARD_CONFIGS = (
    {"name": "shape-guard-1-6", "source": "overall-shape", "minAbs": 1.0, "maxAbs": 6.0},
    {"name": "shape-guard-1-8", "source": "overall-shape", "minAbs": 1.0, "maxAbs": 8.0},
    {"name": "shape-guard-2-8", "source": "overall-shape", "minAbs": 2.0, "maxAbs": 8.0},
    {
        "name": "shape-guard-2-8-edge",
        "source": "overall-shape",
        "minAbs": 2.0,
        "maxAbs": 8.0,
        "requireEdge": True,
    },
    {
        "name": "shape-guard-2-8-score-070",
        "source": "overall-shape",
        "minAbs": 2.0,
        "maxAbs": 8.0,
        "minEvidence": 0.70,
    },
    {
        "name": "shape-guard-2-8-score-080",
        "source": "overall-shape",
        "minAbs": 2.0,
        "maxAbs": 8.0,
        "minEvidence": 0.80,
    },
    {
        "name": "shape-guard-2-8-legacy",
        "source": "overall-shape",
        "minAbs": 2.0,
        "maxAbs": 8.0,
        "legacyOnly": True,
    },
    {
        "name": "mod4-guard-2-8-edge",
        "source": "overall-mod4-shape",
        "minAbs": 2.0,
        "maxAbs": 8.0,
        "requireEdge": True,
    },
    {
        "name": "stable-guard-1-8",
        "source": "stable-residual",
        "minAbs": 1.0,
        "maxAbs": 8.0,
        "maxStableMad": 4.0,
        "minStableCoverage": 0.40,
    },
)
RANKED_MARGINS = (0.0, 0.025, 0.05, 0.10)
RANKED_VARIANT_NAMES = tuple(
    f"ranked-top8-margin-{str(margin).replace('.', '')}{suffix}"
    for margin in RANKED_MARGINS
    for suffix in ("", "-legacy")
)
VARIANT_NAMES = BASE_VARIANT_NAMES + tuple(item["name"] for item in GUARD_CONFIGS) + RANKED_VARIANT_NAMES


def _finite_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def _timeline_offset_ms(truth: dict[str, Any]) -> float:
    time_basis = truth.get("timeBasis") if isinstance(truth.get("timeBasis"), dict) else {}
    return _finite_float(time_basis.get("offsetMs")) or 0.0


def _candidate_assessment(
    *,
    bpm: float,
    first_beat_ms: float,
    downbeat_offset: int,
    truth: dict[str, Any],
) -> dict[str, Any]:
    return assess_usable_grid(
        result_bpm=bpm,
        result_first_beat_timeline_ms=first_beat_ms + _timeline_offset_ms(truth),
        result_downbeat_beat_offset=downbeat_offset,
        truth=truth,
    )


def _selected_grid(track: dict[str, Any]) -> dict[str, Any] | None:
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    bpm = _finite_float(analysis.get("bpm"))
    first_beat_ms = _finite_float(analysis.get("firstBeatMs"))
    if bpm is None or bpm <= 0.0 or first_beat_ms is None:
        return None
    downbeat_offset = int(analysis.get("barBeatOffset") or analysis.get("downbeatBeatOffset") or 0) % 4
    return {
        "bpm": bpm,
        "firstBeatMs": first_beat_ms,
        "downbeatOffset": downbeat_offset,
        "durationSec": _finite_float(analysis.get("durationSec")) or 120.0,
        "source": str(analysis.get("gridSolverSelectedSource") or ""),
    }


def _best_strict_passing_candidate(track: dict[str, Any]) -> dict[str, Any] | None:
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    truth = track.get("truth") if isinstance(track.get("truth"), dict) else {}
    raw_candidates = analysis.get("gridSolverCandidates")
    if not isinstance(raw_candidates, list) or not truth:
        return None
    for rank, candidate in enumerate(raw_candidates, start=1):
        if not isinstance(candidate, dict):
            continue
        bpm = _finite_float(candidate.get("bpm"))
        first_beat_ms = _finite_float(candidate.get("firstBeatMs"))
        if bpm is None or bpm <= 0.0 or first_beat_ms is None:
            continue
        downbeat_offset = int(
            candidate.get("downbeatBeatOffset")
            if candidate.get("downbeatBeatOffset") is not None
            else candidate.get("barBeatOffset") or 0
        ) % 4
        assessment = _candidate_assessment(
            bpm=bpm,
            first_beat_ms=first_beat_ms,
            downbeat_offset=downbeat_offset,
            truth=truth,
        )
        if assessment["strictPass"]:
            return {
                "rank": rank,
                "source": str(candidate.get("source") or ""),
                "bpm": bpm,
                "firstBeatMs": first_beat_ms,
                "downbeatOffset": downbeat_offset,
            }
    return None


def _load_track_features(
    *,
    track: dict[str, Any],
    cache_dir: Path,
    index_map: dict[str, dict[str, Any]],
    signal_mode: str,
    high_attack_cache_dir: Path,
    database_root: Path | None,
) -> tuple[dict[str, Any], np.ndarray, float] | None:
    entry = resolve_feature_entry(track=track, index_map=index_map)
    if entry is None:
        return None
    metadata = read_feature_metadata(cache_dir, entry)
    if signal_mode == "high-attack":
        source_path = _resolve_audio_path(entry=entry, metadata=metadata, database_root=database_root)
        if source_path is None:
            return None
        high_attack = _load_or_build_high_attack(
            entry=entry,
            source_path=source_path,
            cache_dir=high_attack_cache_dir,
        )
        if high_attack is None:
            return None
        values, frame_rate = high_attack
        return metadata, values, frame_rate
    arrays_path = resolve_feature_arrays_path(cache_dir, entry, metadata)
    if not arrays_path.is_file():
        return None
    with np.load(arrays_path, allow_pickle=False) as arrays:
        values = np.asarray(arrays["fullAttackEnvelope"], dtype="float64")
        frame_rate = float(np.asarray(arrays["fullAttackSampleRate"]).item())
    return metadata, values, frame_rate


def _database_root_from_env(path: Path = Path(".env")) -> Path | None:
    if not path.is_file():
        return None
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    root = values.get("FRKB_BENCHMARK_DATABASE_ROOT") or values.get("FRKB_DEV_DATABASE_URL")
    return Path(root).resolve() if root else None


def _resolve_audio_path(
    *,
    entry: dict[str, Any],
    metadata: dict[str, Any],
    database_root: Path | None,
) -> Path | None:
    cache_payload = metadata.get("cachePayload") if isinstance(metadata.get("cachePayload"), dict) else {}
    audio_file = cache_payload.get("audioFile") if isinstance(cache_payload.get("audioFile"), dict) else {}
    raw_paths = (
        entry.get("sourcePath"),
        metadata.get("sourcePath"),
        audio_file.get("path"),
    )
    for raw_path in raw_paths:
        if not str(raw_path or "").strip():
            continue
        candidate = Path(str(raw_path))
        if candidate.is_file():
            return candidate.resolve()
        if database_root is None:
            continue
        parts = candidate.parts
        root_index = next(
            (index for index, part in enumerate(parts) if part.casefold() == "frkb_database-e"),
            None,
        )
        if root_index is None:
            continue
        migrated = database_root.joinpath(*parts[root_index + 1 :])
        if migrated.is_file():
            return migrated.resolve()
    return None


def _load_or_build_high_attack(
    *,
    entry: dict[str, Any],
    source_path: Path,
    cache_dir: Path,
) -> tuple[np.ndarray, float] | None:
    cache_key = str(entry.get("cacheKey") or "").strip()
    if not cache_key:
        return None
    cache_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = cache_dir / f"high-attack-{cache_key}.json"
    arrays_path = cache_dir / f"high-attack-{cache_key}.npz"
    source_stat = source_path.stat()
    if metadata_path.is_file() and arrays_path.is_file():
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            matches = (
                payload.get("version") == HIGH_ATTACK_VERSION
                and payload.get("sourceCacheKey") == cache_key
                and int(payload.get("sourceSize") or -1) == source_stat.st_size
                and int(payload.get("sourceMtimeNs") or -1) == source_stat.st_mtime_ns
            )
            if matches:
                with np.load(arrays_path, allow_pickle=False) as arrays:
                    values = np.asarray(arrays["highAttackEnvelope"], dtype="float64")
                    frame_rate = float(np.asarray(arrays["sampleRate"]).item())
                return values, frame_rate
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    ffmpeg_path = Path("vendor/ffmpeg/win32-x64/ffmpeg.exe").resolve()
    command = [
        str(ffmpeg_path),
        "-v",
        "error",
        "-ss",
        "0",
        "-t",
        "120",
        "-i",
        str(source_path),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ac",
        "1",
        "-ar",
        "11025",
        "pipe:1",
    ]
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if completed.returncode != 0 or not completed.stdout:
        return None
    mono = np.frombuffer(completed.stdout, dtype="<f4").astype("float64", copy=False)
    values, frame_rate = build_high_attack_envelope(mono, sample_rate=11025, output_rate=4000)
    temporary_arrays = arrays_path.with_name(f"{arrays_path.stem}.tmp.npz")
    np.savez_compressed(
        temporary_arrays,
        highAttackEnvelope=np.asarray(values, dtype="float16"),
        sampleRate=np.asarray(frame_rate, dtype="int32"),
    )
    temporary_arrays.replace(arrays_path)
    atomic_write_json(
        metadata_path,
        {
            "version": HIGH_ATTACK_VERSION,
            "sourceCacheKey": cache_key,
            "sourcePath": str(source_path).replace("\\", "/"),
            "sourceSize": source_stat.st_size,
            "sourceMtimeNs": source_stat.st_mtime_ns,
            "sampleRate": frame_rate,
            "sampleCount": int(values.size),
        },
    )
    return np.asarray(values, dtype="float64"), float(frame_rate)


def _focus_track_keys(benchmark_path: Path, pass_control_limit: int) -> tuple[set[str], dict[str, int]]:
    phase_keys: set[str] = set()
    pass_rows: list[tuple[str, str]] = []
    for track in iter_benchmark_tracks(benchmark_path):
        file_name = str(track.get("fileName") or "")
        key = file_name.casefold()
        category = str(((track.get("currentTimeline") or {}).get("category")) or "")
        if category == "first-beat-phase":
            phase_keys.add(key)
        elif category == "pass" and pass_control_limit > 0:
            digest = hashlib.sha256(file_name.encode("utf-8")).hexdigest()
            pass_rows.append((digest, key))
    pass_keys = {key for _, key in sorted(pass_rows)[:pass_control_limit]}
    return phase_keys | pass_keys, {
        "phaseTrackCount": len(phase_keys),
        "passControlCount": len(pass_keys),
    }


def _variant_phases(
    *,
    metadata: dict[str, Any],
    values: np.ndarray,
    frame_rate: float,
    selected: dict[str, Any],
) -> tuple[dict[str, float], dict[str, Any]]:
    bpm = float(selected["bpm"])
    base_phase = float(selected["firstBeatMs"])
    duration_sec = min(
        float(selected["durationSec"]),
        float(values.size) / frame_rate if frame_rate > 0.0 else float(selected["durationSec"]),
    )
    evidence = candidate_phase_evidence(
        values,
        frame_rate=frame_rate,
        bpm=bpm,
        first_beat_ms=base_phase,
        duration_sec=duration_sec,
    )
    stable = stable_range_residual(metadata, bpm=bpm, first_beat_ms=base_phase)
    phases = {name: base_phase for name in BASE_VARIANT_NAMES}
    if evidence.get("valid"):
        phases["overall-argmax"] = base_phase + float(evidence.get("argmaxShiftMs") or 0.0)
        phases["overall-shape"] = base_phase + float(evidence.get("overallShiftMs") or 0.0)
        phases["overall-mod4-shape"] = base_phase + float(evidence.get("selectedShiftMs") or 0.0)
    stable_phase = base_phase
    if stable.get("valid"):
        stable_phase += float(stable.get("meanResidualMs") or 0.0)
        phases["stable-residual"] = stable_phase
        stable_evidence = candidate_phase_evidence(
            values,
            frame_rate=frame_rate,
            bpm=bpm,
            first_beat_ms=stable_phase,
            duration_sec=duration_sec,
        )
        if stable_evidence.get("valid"):
            phases["stable-overall-mod4-shape"] = stable_phase + float(
                stable_evidence.get("selectedShiftMs") or 0.0
            )
        else:
            phases["stable-overall-mod4-shape"] = stable_phase
    for config in GUARD_CONFIGS:
        source_name = str(config["source"])
        proposed = float(phases[source_name])
        shift = proposed - base_phase
        allowed = float(config["minAbs"]) <= abs(shift) <= float(config["maxAbs"])
        if config.get("legacyOnly") and "legacy-fallback" not in str(selected.get("source") or ""):
            allowed = False
        overall = evidence.get("overall") if isinstance(evidence.get("overall"), dict) else {}
        if config.get("requireEdge") and overall.get("reason") != "sustained-rising-edge":
            allowed = False
        if float(evidence.get("evidenceScore") or 0.0) < float(config.get("minEvidence") or 0.0):
            allowed = False
        if stable.get("valid"):
            if float(stable.get("residualMadMs") or 999.0) > float(config.get("maxStableMad") or 999.0):
                allowed = False
            if float(stable.get("stableCoveredRatio") or 0.0) < float(
                config.get("minStableCoverage") or 0.0
            ):
                allowed = False
        elif config.get("maxStableMad") is not None or config.get("minStableCoverage") is not None:
            allowed = False
        phases[str(config["name"])] = proposed if allowed else base_phase
    return phases, {"evidence": evidence, "stable": stable}


def _ranked_candidate_phases(
    *,
    track: dict[str, Any],
    values: np.ndarray,
    frame_rate: float,
    selected: dict[str, Any],
    baseline_evidence: dict[str, Any],
    candidate_limit: int,
) -> dict[str, float]:
    base_phase = float(selected["firstBeatMs"])
    result = {name: base_phase for name in RANKED_VARIANT_NAMES}
    if candidate_limit <= 0 or not baseline_evidence.get("valid"):
        return result
    analysis = track.get("analysis") if isinstance(track.get("analysis"), dict) else {}
    raw_candidates = analysis.get("gridSolverCandidates")
    if not isinstance(raw_candidates, list):
        return result
    duration_sec = min(
        float(selected["durationSec"]),
        float(values.size) / frame_rate if frame_rate > 0.0 else float(selected["durationSec"]),
    )
    baseline_score = float(baseline_evidence.get("evidenceScore") or 0.0)
    best_phase = base_phase
    best_score = baseline_score
    considered = 0
    for candidate in raw_candidates:
        if not isinstance(candidate, dict):
            continue
        bpm = _finite_float(candidate.get("bpm"))
        phase = _finite_float(candidate.get("firstBeatMs"))
        if bpm is None or phase is None or abs(bpm - float(selected["bpm"])) > 0.08:
            continue
        downbeat_offset = int(
            candidate.get("downbeatBeatOffset")
            if candidate.get("downbeatBeatOffset") is not None
            else candidate.get("barBeatOffset") or 0
        ) % 4
        if downbeat_offset != int(selected["downbeatOffset"]):
            continue
        considered += 1
        evidence = candidate_phase_evidence(
            values,
            frame_rate=frame_rate,
            bpm=bpm,
            first_beat_ms=phase,
            duration_sec=duration_sec,
        )
        if evidence.get("valid") and float(evidence.get("evidenceScore") or 0.0) > best_score:
            best_phase = phase
            best_score = float(evidence.get("evidenceScore") or 0.0)
        if considered >= candidate_limit:
            break
    improvement = best_score - baseline_score
    is_legacy = "legacy-fallback" in str(selected.get("source") or "")
    for margin in RANKED_MARGINS:
        prefix = f"ranked-top8-margin-{str(margin).replace('.', '')}"
        if best_phase != base_phase and improvement >= margin:
            result[prefix] = best_phase
            if is_legacy:
                result[f"{prefix}-legacy"] = best_phase
    return result


def _empty_variant_counter() -> dict[str, Any]:
    return {
        "trackCount": 0,
        "strictPass": 0,
        "usablePass": 0,
        "strictFailToPass": 0,
        "strictPassToFail": 0,
        "usableFailToPass": 0,
        "usablePassToFail": 0,
        "phaseFailToStrictPass": 0,
        "downbeatFailure": 0,
        "strictBpmDriftFailure": 0,
        "appliedCount": 0,
        "categoryCounts": Counter(),
        "usableCategoryCounts": Counter(),
        "shiftMs": [],
        "details": [],
    }


def _record_variant(
    *,
    counter: dict[str, Any],
    dataset: str,
    file_name: str,
    baseline: dict[str, Any],
    selected: dict[str, Any],
    shift_ms: float,
    detail_limit: int,
) -> None:
    counter["trackCount"] += 1
    counter["strictPass"] += int(bool(selected["strictPass"]))
    counter["usablePass"] += int(bool(selected["usablePass"]))
    counter["strictFailToPass"] += int(not baseline["strictPass"] and selected["strictPass"])
    counter["strictPassToFail"] += int(baseline["strictPass"] and not selected["strictPass"])
    counter["usableFailToPass"] += int(not baseline["usablePass"] and selected["usablePass"])
    counter["usablePassToFail"] += int(baseline["usablePass"] and not selected["usablePass"])
    counter["phaseFailToStrictPass"] += int(
        baseline["strictCategory"] == "first-beat-phase" and selected["strictPass"]
    )
    counter["downbeatFailure"] += int(bool(selected["downbeatFailure"]))
    counter["strictBpmDriftFailure"] += int(bool(selected["strictBpmDriftFailure"]))
    counter["categoryCounts"][str(selected["strictCategory"])] += 1
    counter["usableCategoryCounts"][str(selected["usableCategory"])] += 1
    if abs(shift_ms) > 1e-9:
        counter["appliedCount"] += 1
        counter["shiftMs"].append(float(shift_ms))
    changed = baseline["strictCategory"] != selected["strictCategory"]
    if changed and len(counter["details"]) < detail_limit:
        counter["details"].append(
            {
                "dataset": dataset,
                "fileName": file_name,
                "baselineCategory": str(baseline["strictCategory"]),
                "selectedCategory": str(selected["strictCategory"]),
                "shiftMs": round(float(shift_ms), 6),
            }
        )


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    return round(float(np.percentile(np.asarray(values, dtype="float64"), percentile)), 6)


def _finalize_variant(counter: dict[str, Any], baseline: dict[str, int]) -> dict[str, Any]:
    total = max(1, int(counter["trackCount"]))
    shifts = [float(value) for value in counter.pop("shiftMs")]
    category_counts = dict(counter.pop("categoryCounts"))
    usable_category_counts = dict(counter.pop("usableCategoryCounts"))
    return {
        **counter,
        "strictAccuracy": round(int(counter["strictPass"]) / total, 9),
        "usableGridAccuracy": round(int(counter["usablePass"]) / total, 9),
        "netStrictPassDelta": int(counter["strictPass"]) - int(baseline["strictPass"]),
        "netUsablePassDelta": int(counter["usablePass"]) - int(baseline["usablePass"]),
        "strictAccuracyDeltaRate": round(
            (int(counter["strictPass"]) - int(baseline["strictPass"])) / total,
            9,
        ),
        "usableGridAccuracyDeltaRate": round(
            (int(counter["usablePass"]) - int(baseline["usablePass"])) / total,
            9,
        ),
        "downbeatFailureDelta": int(counter["downbeatFailure"]) - int(baseline["downbeatFailure"]),
        "strictBpmDriftFailureDelta": int(counter["strictBpmDriftFailure"])
        - int(baseline["strictBpmDriftFailure"]),
        "categoryCounts": category_counts,
        "usableCategoryCounts": usable_category_counts,
        "shiftMs": {
            "mean": round(statistics.fmean(shifts), 6) if shifts else None,
            "median": round(statistics.median(shifts), 6) if shifts else None,
            "absMedian": round(statistics.median(abs(value) for value in shifts), 6) if shifts else None,
            "p95Abs": _percentile([abs(value) for value in shifts], 95.0),
            "maxAbs": max((round(abs(value), 6) for value in shifts), default=None),
        },
    }


def _phase_evidence_summary(counter: Counter[str]) -> dict[str, Any]:
    total = int(counter["fixablePhaseCount"])
    return {
        **dict(counter),
        "bestPassingEvidencePreferredRate": round(counter["bestPassingEvidencePreferred"] / total, 6)
        if total
        else 0.0,
        "bestPassingDynamicRangePreferredRate": round(
            counter["bestPassingDynamicRangePreferred"] / total,
            6,
        )
        if total
        else 0.0,
        "bestPassingSurvivesOfficialRefineRate": round(
            counter["bestPassingSurvivesOfficialRefine"] / total,
            6,
        )
        if total
        else 0.0,
    }


def _dataset_report(
    *,
    name: str,
    benchmark_path: Path,
    cache_dir: Path,
    detail_limit: int,
    candidate_limit: int,
    signal_mode: str,
    high_attack_cache_dir: Path,
    database_root: Path | None,
    pass_control_limit: int,
) -> dict[str, Any]:
    index_map = build_feature_index_map(cache_dir)
    focus_keys: set[str] | None = None
    sampling: dict[str, int] = {}
    if pass_control_limit > 0:
        focus_keys, sampling = _focus_track_keys(benchmark_path, pass_control_limit)
    baseline_counter: Counter[str] = Counter()
    variants = {variant: _empty_variant_counter() for variant in VARIANT_NAMES}
    skipped: Counter[str] = Counter()
    phase_evidence: Counter[str] = Counter()
    started_at = time.time()
    processed_count = 0
    for track_index, track in enumerate(iter_benchmark_tracks(benchmark_path), start=1):
        if focus_keys is not None and str(track.get("fileName") or "").casefold() not in focus_keys:
            continue
        selected_grid = _selected_grid(track)
        truth = track.get("truth") if isinstance(track.get("truth"), dict) else {}
        if selected_grid is None or not truth:
            skipped["invalidTrack"] += 1
            continue
        features = _load_track_features(
            track=track,
            cache_dir=cache_dir,
            index_map=index_map,
            signal_mode=signal_mode,
            high_attack_cache_dir=high_attack_cache_dir,
            database_root=database_root,
        )
        if features is None:
            skipped["missingFeatureOrSignal"] += 1
            continue
        processed_count += 1
        metadata, values, frame_rate = features
        baseline = _candidate_assessment(
            bpm=float(selected_grid["bpm"]),
            first_beat_ms=float(selected_grid["firstBeatMs"]),
            downbeat_offset=int(selected_grid["downbeatOffset"]),
            truth=truth,
        )
        baseline_counter["trackCount"] += 1
        baseline_counter["strictPass"] += int(bool(baseline["strictPass"]))
        baseline_counter["usablePass"] += int(bool(baseline["usablePass"]))
        baseline_counter["downbeatFailure"] += int(bool(baseline["downbeatFailure"]))
        baseline_counter["strictBpmDriftFailure"] += int(bool(baseline["strictBpmDriftFailure"]))
        baseline_counter[f"category:{baseline['strictCategory']}"] += 1

        phases, diagnostics = _variant_phases(
            metadata=metadata,
            values=values,
            frame_rate=frame_rate,
            selected=selected_grid,
        )
        baseline_evidence = (
            diagnostics.get("evidence") if isinstance(diagnostics.get("evidence"), dict) else {}
        )
        phases.update(
            _ranked_candidate_phases(
                track=track,
                values=values,
                frame_rate=frame_rate,
                selected=selected_grid,
                baseline_evidence=baseline_evidence,
                candidate_limit=candidate_limit,
            )
        )
        for variant, first_beat_ms in phases.items():
            assessment = _candidate_assessment(
                bpm=float(selected_grid["bpm"]),
                first_beat_ms=float(first_beat_ms),
                downbeat_offset=int(selected_grid["downbeatOffset"]),
                truth=truth,
            )
            _record_variant(
                counter=variants[variant],
                dataset=name,
                file_name=str(track.get("fileName") or ""),
                baseline=baseline,
                selected=assessment,
                shift_ms=float(first_beat_ms) - float(selected_grid["firstBeatMs"]),
                detail_limit=detail_limit,
            )

        if baseline["strictCategory"] == "first-beat-phase":
            best = _best_strict_passing_candidate(track)
            if best is None:
                phase_evidence["missingPassingCandidate"] += 1
            else:
                phase_evidence["fixablePhaseCount"] += 1
                base_evidence = baseline_evidence
                best_evidence = candidate_phase_evidence(
                    values,
                    frame_rate=frame_rate,
                    bpm=float(best["bpm"]),
                    first_beat_ms=float(best["firstBeatMs"]),
                    duration_sec=min(
                        float(selected_grid["durationSec"]),
                        float(values.size) / frame_rate,
                    ),
                )
                if base_evidence.get("valid") and best_evidence.get("valid"):
                    phase_evidence["comparableEvidenceCount"] += 1
                    phase_evidence["bestPassingEvidencePreferred"] += int(
                        float(best_evidence.get("evidenceScore") or 0.0)
                        > float(base_evidence.get("evidenceScore") or 0.0)
                    )
                    phase_evidence["bestPassingDynamicRangePreferred"] += int(
                        float(best_evidence.get("selectedDynamicRange") or 0.0)
                        > float(base_evidence.get("selectedDynamicRange") or 0.0)
                    )
                    refined_best = _candidate_assessment(
                        bpm=float(best["bpm"]),
                        first_beat_ms=float(best["firstBeatMs"])
                        + float(best_evidence.get("selectedShiftMs") or 0.0),
                        downbeat_offset=int(best["downbeatOffset"]),
                        truth=truth,
                    )
                    phase_evidence["bestPassingSurvivesOfficialRefine"] += int(
                        bool(refined_best["strictPass"])
                    )
        progress_step = 25 if signal_mode == "high-attack" else 100
        if processed_count % progress_step == 0:
            print(f"[{name}] processed={processed_count} sourceIndex={track_index}", flush=True)

    baseline_payload = {
        "trackCount": int(baseline_counter["trackCount"]),
        "strictPass": int(baseline_counter["strictPass"]),
        "usablePass": int(baseline_counter["usablePass"]),
        "strictAccuracy": round(
            baseline_counter["strictPass"] / max(1, baseline_counter["trackCount"]),
            9,
        ),
        "usableGridAccuracy": round(
            baseline_counter["usablePass"] / max(1, baseline_counter["trackCount"]),
            9,
        ),
        "downbeatFailure": int(baseline_counter["downbeatFailure"]),
        "strictBpmDriftFailure": int(baseline_counter["strictBpmDriftFailure"]),
        "categoryCounts": {
            key.removeprefix("category:"): int(value)
            for key, value in baseline_counter.items()
            if key.startswith("category:")
        },
    }
    return {
        "benchmark": str(benchmark_path.resolve()).replace("\\", "/"),
        "featureCacheDir": str(cache_dir.resolve()).replace("\\", "/"),
        "baseline": baseline_payload,
        "variants": {
            name: _finalize_variant(counter, baseline_payload)
            for name, counter in variants.items()
        },
        "phaseEvidence": _phase_evidence_summary(phase_evidence),
        "sampling": sampling,
        "skipped": dict(skipped),
        "elapsedSec": round(time.time() - started_at, 3),
    }


def _aggregate(datasets: dict[str, Any]) -> dict[str, Any]:
    baseline = Counter()
    variants = {name: Counter() for name in VARIANT_NAMES}
    for dataset in datasets.values():
        base = dataset["baseline"]
        for key in ("trackCount", "strictPass", "usablePass", "downbeatFailure", "strictBpmDriftFailure"):
            baseline[key] += int(base[key])
        for name in VARIANT_NAMES:
            metrics = dataset["variants"][name]
            for key in (
                "trackCount",
                "strictPass",
                "usablePass",
                "strictFailToPass",
                "strictPassToFail",
                "usableFailToPass",
                "usablePassToFail",
                "phaseFailToStrictPass",
                "downbeatFailure",
                "strictBpmDriftFailure",
                "appliedCount",
            ):
                variants[name][key] += int(metrics[key])
    total = max(1, baseline["trackCount"])
    return {
        "baseline": {
            **dict(baseline),
            "strictAccuracy": round(baseline["strictPass"] / total, 9),
            "usableGridAccuracy": round(baseline["usablePass"] / total, 9),
        },
        "variants": {
            name: {
                **dict(counter),
                "strictAccuracy": round(counter["strictPass"] / total, 9),
                "usableGridAccuracy": round(counter["usablePass"] / total, 9),
                "netStrictPassDelta": counter["strictPass"] - baseline["strictPass"],
                "netUsablePassDelta": counter["usablePass"] - baseline["usablePass"],
                "strictAccuracyDeltaRate": round(
                    (counter["strictPass"] - baseline["strictPass"]) / total,
                    9,
                ),
                "usableGridAccuracyDeltaRate": round(
                    (counter["usablePass"] - baseline["usablePass"]) / total,
                    9,
                ),
                "downbeatFailureDelta": counter["downbeatFailure"] - baseline["downbeatFailure"],
                "strictBpmDriftFailureDelta": counter["strictBpmDriftFailure"]
                - baseline["strictBpmDriftFailure"],
            }
            for name, counter in variants.items()
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate Rekordbox-inspired fixed-BPM phase refiners without changing production solver"
    )
    parser.add_argument("--datasets", nargs="+", choices=DEFAULT_DATASETS, default=list(DEFAULT_DATASETS))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--detail-limit", type=int, default=40)
    parser.add_argument("--candidate-limit", type=int, default=0)
    parser.add_argument("--signal-mode", choices=("full-attack", "high-attack"), default="full-attack")
    parser.add_argument(
        "--high-attack-cache-dir",
        default="grid-analysis-lab/rkb-rekordbox-benchmark/official-phase-high-attack-cache",
    )
    parser.add_argument("--database-root", default="")
    parser.add_argument("--pass-control-limit", type=int, default=0)
    args = parser.parse_args()
    database_root = Path(args.database_root).resolve() if str(args.database_root).strip() else _database_root_from_env()
    if args.signal_mode == "high-attack" and database_root is None:
        raise RuntimeError("high-attack mode requires FRKB database root from .env or --database-root")
    datasets: dict[str, Any] = {}
    started_at = time.time()
    for name in args.datasets:
        benchmark_path = Path(DEFAULT_BENCHMARKS[name])
        cache_dir = FEATURE_CACHE_ROOT / name
        if not benchmark_path.is_file():
            raise RuntimeError(f"missing benchmark: {benchmark_path}")
        if not cache_dir.is_dir():
            raise RuntimeError(f"missing feature cache: {cache_dir}")
        datasets[name] = _dataset_report(
            name=name,
            benchmark_path=benchmark_path,
            cache_dir=cache_dir,
            detail_limit=max(0, int(args.detail_limit)),
            candidate_limit=max(0, int(args.candidate_limit)),
            signal_mode=str(args.signal_mode),
            high_attack_cache_dir=Path(args.high_attack_cache_dir) / name,
            database_root=database_root,
            pass_control_limit=max(0, int(args.pass_control_limit)),
        )
    report = {
        "schemaVersion": 1,
        "type": "rkb-official-style-fixed-phase-diagnostic",
        "version": DIAGNOSTIC_VERSION,
        "selectorVersion": SELECTOR_VERSION,
        "usableGridPolicyVersion": USABLE_GRID_POLICY_VERSION,
        "developmentDiagnosticOnly": True,
        "freshProofEligible": False,
        "productionSolverChanged": False,
        "candidateLimit": max(0, int(args.candidate_limit)),
        "signalMode": str(args.signal_mode),
        "signalPolicy": (
            {
                "name": HIGH_ATTACK_VERSION,
                "decodeSampleRate": 11025,
                "storedSampleRate": 4000,
                "description": "FFT HPF 1.8-2.2kHz, rectification, FFT LPF 0.8-1.2kHz",
            }
            if args.signal_mode == "high-attack"
            else {
                "name": "existing-full-attack-envelope",
                "sampleRate": "per-cache, normally 4000Hz",
            }
        ),
        "datasets": datasets,
        "aggregate": _aggregate(datasets),
        "elapsedSec": round(time.time() - started_at, 3),
    }
    output = Path(args.output)
    atomic_write_json(output, report)
    print(json.dumps({"output": str(output.resolve()), "aggregate": report["aggregate"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
