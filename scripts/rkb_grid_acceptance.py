import math
from typing import Any

import benchmark_rkb_rekordbox_truth as benchmark


USABLE_GRID_POLICY_VERSION = "rkb-usable-grid-octave-equivalence-v1"
OCTAVE_NORMALIZATION_FACTORS = (
    ("double-bpm", 0.5),
    ("same-bpm", 1.0),
    ("half-bpm", 2.0),
)


def _finite_positive(value: Any) -> float:
    try:
        numeric = float(value)
    except Exception:
        return 0.0
    return numeric if math.isfinite(numeric) and numeric > 0.0 else 0.0


def _normalized_options(result_bpm: float, truth_bpm: float) -> list[dict[str, Any]]:
    options: list[dict[str, Any]] = []
    for relation, factor in OCTAVE_NORMALIZATION_FACTORS:
        normalized_bpm = result_bpm * factor
        normalized_interval_ms = 60000.0 / normalized_bpm
        truth_interval_ms = 60000.0 / truth_bpm
        options.append(
            {
                "tempoRelation": relation,
                "normalizationFactor": factor,
                "normalizedBpm": normalized_bpm,
                "normalizedDrift128BeatsMs": (normalized_interval_ms - truth_interval_ms) * 128.0,
            }
        )
    return options


def assess_usable_grid(
    *,
    result_bpm: float,
    result_first_beat_timeline_ms: float,
    result_downbeat_beat_offset: int,
    truth: dict[str, Any],
    compare_count: int = 128,
    tolerance_ms: float = benchmark.STRICT_TOLERANCE_MS,
) -> dict[str, Any]:
    numeric_result_bpm = _finite_positive(result_bpm)
    truth_bpm = _finite_positive(truth.get("bpm"))
    if numeric_result_bpm <= 0.0 or truth_bpm <= 0.0:
        raise ValueError("result and truth BPM must be finite positive numbers")
    normalized_truth = dict(truth)
    if normalized_truth.get("downbeatBeatOffset") is None:
        if normalized_truth.get("barBeatOffset") is None:
            raise ValueError("truth must provide downbeatBeatOffset or barBeatOffset")
        normalized_truth["downbeatBeatOffset"] = int(normalized_truth["barBeatOffset"]) % 4

    strict_metrics = benchmark._derive_grid_metrics(
        result_bpm=numeric_result_bpm,
        result_first_beat_timeline_ms=float(result_first_beat_timeline_ms),
        result_downbeat_beat_offset=int(result_downbeat_beat_offset) % 4,
        truth=normalized_truth,
        compare_count=compare_count,
    )
    strict_classification = benchmark._classify(strict_metrics, numeric_result_bpm, truth_bpm)
    selected_option = min(
        _normalized_options(numeric_result_bpm, truth_bpm),
        key=lambda item: (
            abs(float(item["normalizedDrift128BeatsMs"])),
            abs(float(item["normalizationFactor"]) - 1.0),
        ),
    )
    normalized_metrics = benchmark._derive_grid_metrics(
        result_bpm=float(selected_option["normalizedBpm"]),
        result_first_beat_timeline_ms=float(result_first_beat_timeline_ms),
        result_downbeat_beat_offset=int(result_downbeat_beat_offset) % 4,
        truth=normalized_truth,
        compare_count=compare_count,
    )
    normalized_bpm_pass = (
        abs(float(normalized_metrics["bpmOnlyDrift128BeatsMs"])) <= tolerance_ms
    )
    normalized_phase_pass = (
        abs(float(normalized_metrics["firstBeatPhaseAbsErrorMs"])) <= tolerance_ms
    )
    normalized_grid_pass = abs(float(normalized_metrics["gridMaxAbsMs"])) <= tolerance_ms
    tempo_relation = str(selected_option["tempoRelation"])
    octave_equivalent_lines_pass = (
        tempo_relation in {"half-bpm", "double-bpm"}
        and normalized_bpm_pass
        and normalized_phase_pass
        and normalized_grid_pass
    )
    strict_pass = strict_classification["category"] == "pass"
    usable_pass = strict_pass or octave_equivalent_lines_pass
    usable_category = str(strict_classification["category"])
    if octave_equivalent_lines_pass:
        usable_category = "octave-equivalent-pass"

    return {
        "policyVersion": USABLE_GRID_POLICY_VERSION,
        "tempoRatio": round(numeric_result_bpm / truth_bpm, 9),
        "tempoRelation": tempo_relation,
        "normalizationFactor": float(selected_option["normalizationFactor"]),
        "normalizedBpm": round(float(selected_option["normalizedBpm"]), 6),
        "strictCategory": str(strict_classification["category"]),
        "strictPass": strict_pass,
        "strictBpmDriftFailure": abs(float(strict_metrics["bpmOnlyDrift128BeatsMs"]))
        > tolerance_ms,
        "downbeatFailure": not bool(strict_metrics["downbeatBeatOffsetMatches"]),
        "octaveEquivalentLinesPass": octave_equivalent_lines_pass,
        "usableCategory": usable_category,
        "usablePass": usable_pass,
        "normalizedBpmPass": normalized_bpm_pass,
        "normalizedPhasePass": normalized_phase_pass,
        "normalizedGridPass": normalized_grid_pass,
        "strictMetrics": strict_metrics,
        "normalizedMetrics": normalized_metrics,
    }
