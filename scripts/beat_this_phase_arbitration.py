import math
from typing import Any

from beat_this_grid_solver import normalize_phase_ms, phase_delta_ms


def _present_float(payload: dict[str, Any] | None, key: str, fallback: float) -> float:
    if not isinstance(payload, dict):
        return fallback
    value = payload.get(key)
    if value is None:
        return fallback
    try:
        numeric = float(value)
    except Exception:
        return fallback
    return numeric if math.isfinite(numeric) else fallback


def _time_basis_offset_ms(time_basis: dict[str, Any] | None) -> float:
    return _present_float(time_basis, "offsetMs", 0.0)


def _update_first_beat(
    result: dict[str, Any],
    first_beat_ms: float,
    interval_ms: float,
    strategy_suffix: str,
) -> dict[str, Any]:
    previous_first_beat_ms = _present_float(result, "firstBeatMs", first_beat_ms)
    updated_first_beat_ms = normalize_phase_ms(first_beat_ms, interval_ms)
    shift_ms = phase_delta_ms(updated_first_beat_ms, previous_first_beat_ms, interval_ms)
    whole_beat_shift = 0
    if interval_ms > 0.0:
        whole_beat_shift = int(
            round((updated_first_beat_ms - previous_first_beat_ms - shift_ms) / interval_ms)
        )

    next_result = dict(result)
    next_result["firstBeatMs"] = round(updated_first_beat_ms, 3)
    if whole_beat_shift != 0:
        next_result["barBeatOffset"] = (int(next_result.get("barBeatOffset") or 0) - whole_beat_shift) % 32

    absolute_first_beat_ms = next_result.get("absoluteFirstBeatMs")
    if absolute_first_beat_ms is not None:
        try:
            next_result["absoluteFirstBeatMs"] = round(float(absolute_first_beat_ms) + shift_ms, 3)
        except Exception:
            pass

    raw_first_beat_ms = _present_float(next_result, "rawFirstBeatMs", previous_first_beat_ms)
    next_result["anchorCorrectionMs"] = round(
        phase_delta_ms(updated_first_beat_ms, raw_first_beat_ms, interval_ms),
        3,
    )
    current_strategy = str(next_result.get("anchorStrategy") or "").strip()
    next_result["anchorStrategy"] = (
        f"{current_strategy}-{strategy_suffix}" if current_strategy else strategy_suffix
    )
    return next_result


def _apply_timeline_integer_quantization(
    result: dict[str, Any],
    time_basis: dict[str, Any] | None,
) -> dict[str, Any]:
    bpm = _present_float(result, "bpm", 0.0)
    if bpm <= 0.0:
        return result
    interval_ms = 60000.0 / bpm
    if not math.isfinite(interval_ms) or interval_ms <= 0.0:
        return result

    first_beat_ms = _present_float(result, "firstBeatMs", 0.0)
    offset_ms = _time_basis_offset_ms(time_basis)
    timeline_ms = first_beat_ms + offset_ms
    quantized_timeline_ms = round(timeline_ms)
    shift_ms = quantized_timeline_ms - timeline_ms
    if abs(shift_ms) < 0.0005 or abs(shift_ms) > 0.5:
        return result

    next_result = _update_first_beat(
        result,
        first_beat_ms + shift_ms,
        interval_ms,
        "timeline-ms-quantized",
    )
    next_result["timelineQuantizationShiftMs"] = round(shift_ms, 3)
    return next_result


def apply_final_phase_arbitration(
    finalized_results: list[dict[str, Any]],
    result: dict[str, Any],
    *,
    time_basis: dict[str, Any] | None = None,
) -> dict[str, Any]:
    del finalized_results
    return _apply_timeline_integer_quantization(result, time_basis)
