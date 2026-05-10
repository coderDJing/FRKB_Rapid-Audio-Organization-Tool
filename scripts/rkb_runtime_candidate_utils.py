import math
from typing import Any


def to_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except Exception:
        return None
    return numeric if math.isfinite(numeric) else None


def sigmoid_clip_range() -> tuple[float, float]:
    return -40.0, 40.0
