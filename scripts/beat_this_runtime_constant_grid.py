from typing import Any

import numpy as np

from beat_this_full_logit_rescue import _predict_frame_logits
from beat_this_grid_solver import build_attack_envelope
from rkb_constant_grid_dp_solver import solve_constant_grid_dp


def _normalize_array(values: np.ndarray | None) -> np.ndarray:
    if values is None:
        return np.asarray([], dtype="float32")
    return np.asarray(values, dtype="float32")


def _serialize_windows(prepared_windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for window in prepared_windows:
        signal = window.get("signal")
        serialized.append(
            {
                "windowIndex": int(window.get("windowIndex") or 0),
                "windowStartSec": round(float(window.get("windowStartSec") or 0.0), 3),
                "windowDurationSec": round(float(window.get("windowDurationSec") or 0.0), 3),
                "signalFrameCount": int(getattr(signal, "shape", [0])[0] or 0),
                "rawBpm": round(float(window.get("rawBpm") or 0.0), 6),
                "rawBeatInterval": round(float(window.get("rawBeatInterval") or 0.0), 6),
                "beatCount": int(window.get("beatCount") or 0),
                "downbeatCount": int(window.get("downbeatCount") or 0),
                "beatCoverageScore": round(float(window.get("beatCoverageScore") or 0.0), 6),
                "beatStabilityScore": round(float(window.get("beatStabilityScore") or 0.0), 6),
                "downbeatCoverageScore": round(float(window.get("downbeatCoverageScore") or 0.0), 6),
                "downbeatStabilityScore": round(float(window.get("downbeatStabilityScore") or 0.0), 6),
                "qualityScore": round(float(window.get("qualityScore") or 0.0), 6),
                "beats": [round(float(value), 6) for value in window.get("beats", [])],
                "downbeats": [round(float(value), 6) for value in window.get("downbeats", [])],
            }
        )
    return serialized


def _build_attack_feature(
    *,
    signal: np.ndarray,
    sample_rate: int,
    tuning: dict[str, Any],
    focus_mode: str,
) -> tuple[np.ndarray, int]:
    next_tuning = dict(tuning)
    next_tuning["focusMode"] = focus_mode
    result = build_attack_envelope(signal, sample_rate, next_tuning)
    if result is None:
        return np.asarray([], dtype="float32"), 0
    envelope, envelope_sample_rate = result
    return _normalize_array(envelope), int(envelope_sample_rate)


def _runtime_arrays(
    *,
    predictor: Any,
    cpu_spect: Any,
    signal: np.ndarray,
    sample_rate: int,
    device: str,
    tuning: dict[str, Any],
) -> dict[str, Any]:
    beat_logits, downbeat_logits = _predict_frame_logits(
        predictor,
        signal,
        sample_rate,
        device,
        cpu_spect,
    )
    full_attack, full_attack_rate = _build_attack_feature(
        signal=signal,
        sample_rate=sample_rate,
        tuning=tuning,
        focus_mode="full",
    )
    lowrate_attack, lowrate_attack_rate = _build_attack_feature(
        signal=signal,
        sample_rate=sample_rate,
        tuning=tuning,
        focus_mode="low",
    )
    return {
        "beatLogits": _normalize_array(beat_logits),
        "downbeatLogits": _normalize_array(downbeat_logits),
        "beatLogitFrameRate": np.asarray(50.0, dtype="float32"),
        "downbeatLogitFrameRate": np.asarray(50.0, dtype="float32"),
        "fullAttackEnvelope": full_attack,
        "fullAttackSampleRate": np.asarray(full_attack_rate, dtype="int32"),
        "lowrateAttackEnvelope": lowrate_attack,
        "lowrateAttackSampleRate": np.asarray(lowrate_attack_rate, dtype="int32"),
    }


def _legacy_grid_solver_payload(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "solver": "beat-this-runtime-candidate-solver",
        "result": dict(result),
        "selectedSource": result.get("gridSolverSelectedSource"),
        "candidateCount": result.get("gridSolverCandidateCount"),
        "score": result.get("gridSolverScore"),
    }


def _runtime_metadata(
    *,
    prepared_windows: list[dict[str, Any]],
    sample_rate: int,
    duration_sec: float,
    legacy_result: dict[str, Any],
    time_basis: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "audio": {
            "sampleRate": int(sample_rate),
            "durationSec": round(float(duration_sec), 3),
            "timeBasis": time_basis,
        },
        "beatThis": {
            "windows": _serialize_windows(prepared_windows),
            "windowCount": len(prepared_windows),
        },
        "legacyGridSolver": _legacy_grid_solver_payload(legacy_result),
    }


def _constant_grid_used_new_result(result: dict[str, Any]) -> bool:
    source = str(result.get("gridSolverSelectedSource") or "")
    features = result.get("gridSolverFeatures") if isinstance(result.get("gridSolverFeatures"), dict) else {}
    return source != "constant-grid-dp:legacy-fallback" or bool(
        features.get("constantGridDpUsedNewCandidate")
    )


def _merge_runtime_quality_fields(
    *,
    result: dict[str, Any],
    legacy_result: dict[str, Any],
) -> dict[str, Any]:
    merged = dict(result)
    for key in (
        "beatCoverageScore",
        "beatStabilityScore",
        "downbeatCoverageScore",
        "downbeatStabilityScore",
    ):
        if key not in merged and key in legacy_result:
            merged[key] = legacy_result[key]
    return merged


def try_solve_runtime_constant_grid_dp(
    *,
    prepared_windows: list[dict[str, Any]],
    signal: np.ndarray,
    sample_rate: int,
    duration_sec: float,
    tuning: dict[str, Any],
    legacy_result: dict[str, Any],
    predictor: Any,
    cpu_spect: Any,
    device: str,
    time_basis: dict[str, Any] | None,
) -> dict[str, Any] | None:
    arrays = _runtime_arrays(
        predictor=predictor,
        cpu_spect=cpu_spect,
        signal=signal,
        sample_rate=sample_rate,
        device=device,
        tuning=tuning,
    )
    metadata = _runtime_metadata(
        prepared_windows=prepared_windows,
        sample_rate=sample_rate,
        duration_sec=duration_sec,
        legacy_result=legacy_result,
        time_basis=time_basis,
    )
    result = solve_constant_grid_dp(metadata=metadata, arrays=arrays)
    if not _constant_grid_used_new_result(result):
        return None
    return _merge_runtime_quality_fields(result=result, legacy_result=legacy_result)
