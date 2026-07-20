from __future__ import annotations

import json
import math
import statistics
from pathlib import Path
from typing import Any

import numpy as np


SELECTOR_VERSION = "rkb-official-downbeat-rotation-v1"
DEFAULT_LINEAR_ARTIFACT_PATH = (
    Path(__file__).resolve().parent
    / "models"
    / "rkb-official-downbeat-rotation-candidate-v1.json"
)
LINEAR_COMPONENT_NAMES = (
    "classLikelihoodZ",
    "downbeatContrastZ",
    "robustBlockZ",
    "blockAgreementZ",
    "lowEnergyZ",
    "fullEnergyZ",
    "transitionZ",
    "introBoundaryZ",
)
PRESET_WEIGHTS: dict[str, dict[str, float]] = {
    "downbeat-mean": {
        "downbeatContrastZ": 1.0,
    },
    "fixed-grid-likelihood": {
        "classLikelihoodZ": 0.65,
        "downbeatContrastZ": 0.35,
    },
    "robust-fixed-grid": {
        "classLikelihoodZ": 0.35,
        "downbeatContrastZ": 0.20,
        "robustBlockZ": 0.30,
        "blockAgreementZ": 0.15,
    },
    "rekordbox-envelope": {
        "classLikelihoodZ": 0.26,
        "downbeatContrastZ": 0.14,
        "robustBlockZ": 0.22,
        "blockAgreementZ": 0.12,
        "lowEnergyZ": 0.08,
        "fullEnergyZ": 0.04,
        "transitionZ": 0.09,
        "introBoundaryZ": 0.05,
    },
    "rekordbox-logit-heavy": {
        "classLikelihoodZ": 0.34,
        "downbeatContrastZ": 0.18,
        "robustBlockZ": 0.24,
        "blockAgreementZ": 0.12,
        "lowEnergyZ": 0.04,
        "fullEnergyZ": 0.02,
        "transitionZ": 0.04,
        "introBoundaryZ": 0.02,
    },
}


def load_linear_downbeat_artifact(path: Path | None = None) -> dict[str, Any]:
    artifact_path = (path or DEFAULT_LINEAR_ARTIFACT_PATH).resolve()
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    if artifact.get("version") != SELECTOR_VERSION:
        raise ValueError(f"downbeat artifact version mismatch: {artifact_path}")
    if artifact.get("evidenceRole") != "consumed-development-candidate-not-fresh-proof":
        raise ValueError(f"downbeat artifact evidence role mismatch: {artifact_path}")
    return artifact


def _finite_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _sigmoid(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values.astype("float64", copy=False), -40.0, 40.0)
    return 1.0 / (1.0 + np.exp(-clipped))


def _fixed_grid_indices_and_times(
    *,
    bpm: float,
    first_beat_ms: float,
    duration_sec: float,
) -> tuple[np.ndarray, np.ndarray]:
    if bpm <= 0.0 or duration_sec <= 0.0:
        return np.asarray([], dtype="int64"), np.asarray([], dtype="float64")
    interval_sec = 60.0 / bpm
    phase_sec = first_beat_ms / 1000.0
    start_index = int(math.ceil(-phase_sec / interval_sec))
    end_index = int(math.floor((duration_sec - phase_sec - 1e-9) / interval_sec))
    if end_index < start_index:
        return np.asarray([], dtype="int64"), np.asarray([], dtype="float64")
    indices = np.arange(start_index, end_index + 1, dtype="int64")
    times = phase_sec + indices.astype("float64") * interval_sec
    valid = (times >= 0.0) & (times < duration_sec)
    return indices[valid], times[valid]


def _sample_values(values: np.ndarray, times_sec: np.ndarray, frame_rate: float) -> np.ndarray:
    if values.size == 0 or times_sec.size == 0 or frame_rate <= 0.0:
        return np.asarray([], dtype="float64")
    positions = times_sec * float(frame_rate)
    valid = (positions >= 0.0) & (positions <= float(values.size - 1))
    if not bool(np.all(valid)):
        positions = positions[valid]
    if positions.size == 0:
        return np.asarray([], dtype="float64")
    left = np.floor(positions).astype("int64", copy=False)
    fraction = positions - left
    right = np.minimum(left + 1, values.size - 1)
    return values[left] * (1.0 - fraction) + values[right] * fraction


def _centered_z(values: list[float]) -> list[float]:
    array = np.asarray(values, dtype="float64")
    if array.size != 4 or not bool(np.all(np.isfinite(array))):
        return [0.0, 0.0, 0.0, 0.0]
    centered = array - float(np.mean(array))
    scale = float(np.std(centered))
    if scale <= 1e-9:
        return [0.0, 0.0, 0.0, 0.0]
    return [round(float(value / scale), 9) for value in centered]


def _robust_signal(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return np.asarray([], dtype="float64")
    transformed = np.log1p(np.maximum(values.astype("float64", copy=False), 0.0))
    median = float(np.median(transformed))
    mad = float(np.median(np.abs(transformed - median)))
    scale = max(1e-6, mad * 1.4826)
    return np.clip((transformed - median) / scale, -6.0, 6.0)


def _rotation_contrast(values: np.ndarray, beat_indices: np.ndarray) -> list[float]:
    scores: list[float] = []
    for rotation in range(4):
        selected = values[(beat_indices % 4) == rotation]
        others = values[(beat_indices % 4) != rotation]
        if selected.size == 0 or others.size == 0:
            scores.append(0.0)
            continue
        scores.append(float(np.mean(selected) - np.mean(others)))
    return scores


def _block_profiles(
    *,
    evidence: np.ndarray,
    activity: np.ndarray,
    beat_indices: np.ndarray,
    block_beats: int = 32,
) -> tuple[list[float], list[float], int]:
    block_scores: list[list[float]] = []
    block_activity: list[float] = []
    for start in range(0, evidence.size, block_beats):
        stop = min(evidence.size, start + block_beats)
        if stop - start < 16:
            continue
        next_evidence = evidence[start:stop]
        next_indices = beat_indices[start:stop]
        next_scores: list[float] = []
        valid = True
        for rotation in range(4):
            selected = next_evidence[(next_indices % 4) == rotation]
            if selected.size < 3:
                valid = False
                break
            next_scores.append(float(np.mean(selected)))
        if not valid:
            continue
        block_scores.append(next_scores)
        block_activity.append(float(np.mean(activity[start:stop])))

    if not block_scores:
        return [0.0] * 4, [0.0] * 4, 0
    scores_array = np.asarray(block_scores, dtype="float64")
    activity_array = np.asarray(block_activity, dtype="float64")
    active_threshold = float(np.percentile(activity_array, 30.0)) if activity_array.size >= 4 else -math.inf
    active_mask = activity_array >= active_threshold
    active_scores = scores_array[active_mask]
    if active_scores.size == 0:
        active_scores = scores_array
    robust_scores = [float(np.median(active_scores[:, rotation])) for rotation in range(4)]
    winners = np.argmax(active_scores, axis=1)
    agreement = [float(np.mean(winners == rotation)) for rotation in range(4)]
    return robust_scores, agreement, int(active_scores.shape[0])


def _transition_scores(
    *,
    full_energy: np.ndarray,
    low_energy: np.ndarray,
    beat_indices: np.ndarray,
) -> tuple[list[float], list[float]]:
    if full_energy.size < 8 or low_energy.size != full_energy.size:
        return [0.0] * 4, [0.0] * 4
    full_delta = np.maximum(0.0, np.diff(full_energy, prepend=full_energy[0]))
    low_delta = np.maximum(0.0, np.diff(low_energy, prepend=low_energy[0]))
    combined = full_delta * 0.45 + low_delta * 0.55
    positive = combined[combined > 0.0]
    if positive.size == 0:
        return [0.0] * 4, [0.0] * 4
    threshold = float(np.percentile(positive, 72.0))
    strong = np.where(combined >= threshold, combined, 0.0)
    transition_scores = [
        float(np.sum(strong[(beat_indices % 4) == rotation])) for rotation in range(4)
    ]

    intro_count = min(48, combined.size)
    intro = combined[:intro_count]
    intro_indices = beat_indices[:intro_count]
    intro_mean = float(np.mean(intro))
    intro_std = float(np.std(intro))
    intro_threshold = intro_mean + intro_std * 1.5
    anomalies = np.where(intro >= intro_threshold, intro, 0.0)
    if bool(np.any(anomalies > 0.0)):
        suffix_maximum = np.maximum.accumulate(anomalies[::-1])[::-1]
        anomalies = anomalies + suffix_maximum * 0.35
    intro_scores = [
        float(np.sum(anomalies[(intro_indices % 4) == rotation])) for rotation in range(4)
    ]
    return transition_scores, intro_scores


def build_downbeat_rotation_evidence(
    *,
    arrays: dict[str, Any],
    bpm: float,
    first_beat_ms: float,
    duration_sec: float,
) -> dict[str, Any]:
    beat_indices, times_sec = _fixed_grid_indices_and_times(
        bpm=bpm,
        first_beat_ms=first_beat_ms,
        duration_sec=duration_sec,
    )
    if times_sec.size < 16:
        return {
            "valid": False,
            "reason": "insufficient-fixed-grid-support",
            "version": SELECTOR_VERSION,
            "beatSupport": int(times_sec.size),
        }

    beat_logits = np.asarray(arrays.get("beatLogits", []), dtype="float64")
    downbeat_logits = np.asarray(arrays.get("downbeatLogits", []), dtype="float64")
    full_attack = np.asarray(arrays.get("fullAttackEnvelope", []), dtype="float64")
    low_attack = np.asarray(arrays.get("lowrateAttackEnvelope", []), dtype="float64")
    beat_rate = _finite_float(np.asarray(arrays.get("beatLogitFrameRate", 0.0)).item())
    downbeat_rate = _finite_float(np.asarray(arrays.get("downbeatLogitFrameRate", 0.0)).item())
    full_rate = _finite_float(np.asarray(arrays.get("fullAttackSampleRate", 0.0)).item())
    low_rate = _finite_float(np.asarray(arrays.get("lowrateAttackSampleRate", 0.0)).item())
    if beat_logits.size == 0 or downbeat_logits.size == 0 or beat_rate <= 0.0 or downbeat_rate <= 0.0:
        return {
            "valid": False,
            "reason": "missing-beat-this-logits",
            "version": SELECTOR_VERSION,
            "beatSupport": int(times_sec.size),
        }

    beat_probability = _sigmoid(_sample_values(beat_logits, times_sec, beat_rate))
    downbeat_probability = _sigmoid(_sample_values(downbeat_logits, times_sec, downbeat_rate))
    support = min(beat_indices.size, beat_probability.size, downbeat_probability.size)
    if support < 16:
        return {
            "valid": False,
            "reason": "insufficient-logit-support",
            "version": SELECTOR_VERSION,
            "beatSupport": int(support),
        }
    beat_indices = beat_indices[:support]
    beat_probability = beat_probability[:support]
    downbeat_probability = downbeat_probability[:support]
    times_sec = times_sec[:support]

    epsilon = 1e-6
    log_ratio = np.log(np.maximum(downbeat_probability, epsilon)) - np.log(
        np.maximum(beat_probability, epsilon)
    )
    class_likelihood: list[float] = []
    for rotation in range(4):
        is_downbeat = (beat_indices % 4) == rotation
        score = np.mean(
            np.where(
                is_downbeat,
                np.log(np.maximum(downbeat_probability, epsilon)),
                np.log(np.maximum(beat_probability, epsilon)),
            )
        )
        class_likelihood.append(float(score))
    downbeat_contrast = _rotation_contrast(downbeat_probability, beat_indices)

    full_samples = _sample_values(full_attack, times_sec, full_rate)
    low_samples = _sample_values(low_attack, times_sec, low_rate)
    if full_samples.size != support:
        full_samples = np.zeros(support, dtype="float64")
    if low_samples.size != support:
        low_samples = np.zeros(support, dtype="float64")
    full_energy = _robust_signal(full_samples)
    low_energy = _robust_signal(low_samples)
    activity = np.maximum(beat_probability, downbeat_probability)
    activity = activity + np.maximum(full_energy, 0.0) * 0.08 + np.maximum(low_energy, 0.0) * 0.12
    robust_block, block_agreement, block_count = _block_profiles(
        evidence=log_ratio,
        activity=activity,
        beat_indices=beat_indices,
    )
    low_energy_score = _rotation_contrast(low_energy, beat_indices)
    full_energy_score = _rotation_contrast(full_energy, beat_indices)
    transition_score, intro_boundary_score = _transition_scores(
        full_energy=full_energy,
        low_energy=low_energy,
        beat_indices=beat_indices,
    )

    components = {
        "classLikelihoodZ": _centered_z(class_likelihood),
        "downbeatContrastZ": _centered_z(downbeat_contrast),
        "robustBlockZ": _centered_z(robust_block),
        "blockAgreementZ": _centered_z(block_agreement),
        "lowEnergyZ": _centered_z(low_energy_score),
        "fullEnergyZ": _centered_z(full_energy_score),
        "transitionZ": _centered_z(transition_score),
        "introBoundaryZ": _centered_z(intro_boundary_score),
    }
    rotation_metrics = []
    for rotation in range(4):
        rotation_metrics.append(
            {
                "rotation": rotation,
                "classLikelihood": round(class_likelihood[rotation], 9),
                "downbeatContrast": round(downbeat_contrast[rotation], 9),
                "robustBlock": round(robust_block[rotation], 9),
                "blockAgreement": round(block_agreement[rotation], 9),
                "lowEnergy": round(low_energy_score[rotation], 9),
                "fullEnergy": round(full_energy_score[rotation], 9),
                "transition": round(transition_score[rotation], 9),
                "introBoundary": round(intro_boundary_score[rotation], 9),
            }
        )
    return {
        "valid": True,
        "reason": "fixed-grid-four-rotation-evidence",
        "version": SELECTOR_VERSION,
        "beatSupport": int(support),
        "blockCount": block_count,
        "components": components,
        "rotations": rotation_metrics,
    }


def score_downbeat_rotations(
    evidence: dict[str, Any],
    *,
    preset: str,
) -> list[float]:
    weights = PRESET_WEIGHTS.get(preset)
    if weights is None:
        raise ValueError(f"unknown downbeat selector preset: {preset}")
    if not evidence.get("valid"):
        return [0.0] * 4
    components = evidence.get("components") if isinstance(evidence.get("components"), dict) else {}
    scores = np.zeros(4, dtype="float64")
    for name, weight in weights.items():
        values = np.asarray(components.get(name, [0.0] * 4), dtype="float64")
        if values.size == 4:
            scores += values * float(weight)
    return [round(float(value), 9) for value in scores]


def select_downbeat_rotation(
    *,
    evidence: dict[str, Any],
    current_rotation: int,
    preset: str,
    minimum_advantage: float = 0.0,
    minimum_margin: float = 0.0,
    minimum_block_agreement: float = 0.0,
) -> dict[str, Any]:
    current = int(current_rotation) % 4
    if not evidence.get("valid"):
        return {
            "applied": False,
            "reason": str(evidence.get("reason") or "invalid-evidence"),
            "version": SELECTOR_VERSION,
            "preset": preset,
            "currentRotation": current,
            "selectedRotation": current,
        }
    scores = score_downbeat_rotations(evidence, preset=preset)
    order = sorted(range(4), key=lambda rotation: scores[rotation], reverse=True)
    selected = int(order[0])
    margin = float(scores[order[0]] - scores[order[1]])
    advantage = float(scores[selected] - scores[current])
    rotations = evidence.get("rotations") if isinstance(evidence.get("rotations"), list) else []
    agreement = 0.0
    if selected < len(rotations) and isinstance(rotations[selected], dict):
        agreement = _finite_float(rotations[selected].get("blockAgreement"))
    reason = "selected-current-rotation"
    applied = False
    if selected != current:
        if advantage < minimum_advantage:
            reason = "advantage-below-threshold"
        elif margin < minimum_margin:
            reason = "margin-below-threshold"
        elif agreement < minimum_block_agreement:
            reason = "block-agreement-below-threshold"
        else:
            reason = "stronger-four-rotation-evidence"
            applied = True
    return {
        "applied": applied,
        "reason": reason,
        "version": SELECTOR_VERSION,
        "preset": preset,
        "currentRotation": current,
        "selectedRotation": selected if applied else current,
        "evidenceTopRotation": selected,
        "scores": scores,
        "advantage": round(advantage, 9),
        "margin": round(margin, 9),
        "blockAgreement": round(agreement, 9),
        "minimumAdvantage": float(minimum_advantage),
        "minimumMargin": float(minimum_margin),
        "minimumBlockAgreement": float(minimum_block_agreement),
    }


def _linear_feature_vector(
    *,
    evidence: dict[str, Any],
    current_rotation: int,
    candidate_rotation: int,
) -> list[float]:
    components = evidence.get("components") if isinstance(evidence.get("components"), dict) else {}
    current = int(current_rotation) % 4
    candidate = int(candidate_rotation) % 4
    values = []
    deltas = []
    for name in LINEAR_COMPONENT_NAMES:
        component = components.get(name) if isinstance(components.get(name), list) else [0.0] * 4
        candidate_value = float(component[candidate]) if len(component) == 4 else 0.0
        current_value = float(component[current]) if len(component) == 4 else 0.0
        values.append(candidate_value)
        deltas.append(candidate_value - current_value)
    return [*values, *deltas, 1.0 if candidate == current else 0.0]


def select_downbeat_rotation_with_linear_model(
    *,
    evidence: dict[str, Any],
    current_rotation: int,
    artifact: dict[str, Any],
) -> dict[str, Any]:
    current = int(current_rotation) % 4
    if not evidence.get("valid"):
        return {
            "applied": False,
            "reason": str(evidence.get("reason") or "invalid-evidence"),
            "version": SELECTOR_VERSION,
            "currentRotation": current,
            "selectedRotation": current,
        }
    model = artifact.get("model") if isinstance(artifact.get("model"), dict) else {}
    selection = artifact.get("selection") if isinstance(artifact.get("selection"), dict) else {}
    expected_names = [
        *LINEAR_COMPONENT_NAMES,
        *(f"delta.{name}" for name in LINEAR_COMPONENT_NAMES),
        "isCurrentRotation",
    ]
    if model.get("featureNames") != expected_names:
        raise ValueError("downbeat linear model feature contract mismatch")
    mean = np.asarray(model.get("mean"), dtype="float64")
    scale = np.asarray(model.get("scale"), dtype="float64")
    coefficients = np.asarray(model.get("coefficients"), dtype="float64")
    if mean.size != len(expected_names) or scale.size != len(expected_names):
        raise ValueError("downbeat linear model normalization shape mismatch")
    if coefficients.size != len(expected_names) + 1:
        raise ValueError("downbeat linear model coefficient shape mismatch")
    matrix = np.asarray(
        [
            _linear_feature_vector(
                evidence=evidence,
                current_rotation=current,
                candidate_rotation=rotation,
            )
            for rotation in range(4)
        ],
        dtype="float64",
    )
    normalized = (matrix - mean) / np.where(np.abs(scale) <= 1e-9, 1.0, scale)
    design = np.column_stack([np.ones(4), normalized])
    scores_array = design @ coefficients
    scores = [float(value) for value in scores_array]
    order = sorted(range(4), key=lambda rotation: scores[rotation], reverse=True)
    top = int(order[0])
    advantage = float(scores[top] - scores[current])
    margin = float(scores[order[0]] - scores[order[1]])
    rotations = evidence.get("rotations") if isinstance(evidence.get("rotations"), list) else []
    agreement = 0.0
    if top < len(rotations) and isinstance(rotations[top], dict):
        agreement = _finite_float(rotations[top].get("blockAgreement"))
    minimum_advantage = _finite_float(selection.get("minimumAdvantage"))
    minimum_margin = _finite_float(selection.get("minimumMargin"))
    minimum_agreement = _finite_float(selection.get("minimumBlockAgreement"))
    applied = bool(
        top != current
        and advantage >= minimum_advantage
        and margin >= minimum_margin
        and agreement >= minimum_agreement
    )
    reason = "selected-current-rotation"
    if top != current and not applied:
        reason = "linear-model-guard-rejected"
    elif applied:
        reason = "linear-model-stronger-four-rotation-evidence"
    return {
        "applied": applied,
        "reason": reason,
        "version": SELECTOR_VERSION,
        "artifactVersion": str(artifact.get("version") or ""),
        "currentRotation": current,
        "selectedRotation": top if applied else current,
        "evidenceTopRotation": top,
        "scores": [round(value, 9) for value in scores],
        "advantage": round(advantage, 9),
        "margin": round(margin, 9),
        "blockAgreement": round(agreement, 9),
        "minimumAdvantage": minimum_advantage,
        "minimumMargin": minimum_margin,
        "minimumBlockAgreement": minimum_agreement,
    }
