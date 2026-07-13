from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import numpy as np


ISOLATION_POLICY_V1: dict[str, Any] = {
    "name": "rkb-audio-isolation-family-v1",
    "inputFeatures": [
        "instanceId",
        "familyId",
        "pcmSha256",
        "fingerprint",
        "fingerprintSha256",
    ],
    "reportOnlyFields": ["batchId"],
    "exactUnion": {"key": "familyId", "beforeApproximateLinks": True},
    "fingerprintDecoder": {
        "format": "chromaprint-compressed-urlsafe-base64",
        "normalCodeBits": 3,
        "exceptionCodeBits": 5,
    },
    "coarseCandidate": {
        "simHashBits": 32,
        "majorityTie": "zero",
        "maxHammingDistance": 4,
        "maxBitDensityL1": 3.0,
        "excludeSameExactFamily": True,
    },
    "alignment": {
        "minShiftFrames": -120,
        "maxShiftFrames": 120,
        "minOverlapFrames": 600,
        "minShorterFingerprintRatio": 0.75,
        "maxMeanBitErrorsPerFrame": 2.0,
        "tieBreak": ["meanBitErrors", "absoluteShift", "signedShift", "overlapFrames"],
    },
}


def canonical_json_sha256(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


ISOLATION_POLICY_SHA256 = canonical_json_sha256(ISOLATION_POLICY_V1)


_POPCOUNT_U8 = np.unpackbits(
    np.arange(256, dtype=np.uint8)[:, np.newaxis], axis=1
).sum(axis=1, dtype=np.uint8)
_BIT_WEIGHTS = np.left_shift(np.uint32(1), np.arange(32, dtype=np.uint32))


@dataclass(frozen=True)
class _AudioRow:
    instance_id: str
    family_id: str
    pcm_sha256: str
    fingerprint: str
    fingerprint_sha256: str
    batch_id: str


class _DisjointSet:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, item: int) -> int:
        parent = self.parent[item]
        if parent != item:
            self.parent[item] = self.find(parent)
        return self.parent[item]

    def union(self, left: int, right: int) -> bool:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return False
        if self.rank[left_root] < self.rank[right_root]:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root
        if self.rank[left_root] == self.rank[right_root]:
            self.rank[left_root] += 1
        return True


def _required_text(row: Mapping[str, Any], key: str, instance_hint: str = "") -> str:
    value = str(row.get(key) or "").strip()
    if not value:
        suffix = f" for {instance_hint!r}" if instance_hint else ""
        raise RuntimeError(f"audio isolation row is missing {key}{suffix}")
    return value


def _project_rows(rows: Iterable[Mapping[str, Any]]) -> list[_AudioRow]:
    projected: list[_AudioRow] = []
    seen_instances: set[str] = set()
    for raw_row in rows:
        instance_id = _required_text(raw_row, "instanceId")
        if instance_id in seen_instances:
            raise RuntimeError(f"duplicate audio isolation instanceId: {instance_id}")
        seen_instances.add(instance_id)
        fingerprint = _required_text(raw_row, "fingerprint", instance_id)
        fingerprint_sha256 = _required_text(raw_row, "fingerprintSha256", instance_id).casefold()
        actual_sha256 = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
        if fingerprint_sha256 != actual_sha256:
            raise RuntimeError(f"fingerprintSha256 mismatch for {instance_id!r}")
        family_id = _required_text(raw_row, "familyId", instance_id).casefold()
        if family_id.startswith("chromaprint:") and family_id != f"chromaprint:{actual_sha256}":
            raise RuntimeError(f"Chromaprint familyId mismatch for {instance_id!r}")
        projected.append(
            _AudioRow(
                instance_id=instance_id,
                family_id=family_id,
                pcm_sha256=str(raw_row.get("pcmSha256") or "").strip().casefold(),
                fingerprint=fingerprint,
                fingerprint_sha256=fingerprint_sha256,
                batch_id=str(raw_row.get("batchId") or "").strip(),
            )
        )
    if not projected:
        raise RuntimeError("audio isolation input contains no rows")
    return sorted(projected, key=lambda row: row.instance_id)


def _unpack_lsb_codes(data: bytes, width: int) -> np.ndarray:
    if not data:
        return np.empty(0, dtype=np.uint8)
    bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8), bitorder="little")
    code_count = bits.size // width
    if code_count == 0:
        return np.empty(0, dtype=np.uint8)
    weights = np.left_shift(np.uint8(1), np.arange(width, dtype=np.uint8))
    return (bits[: code_count * width].reshape(code_count, width) * weights).sum(
        axis=1, dtype=np.uint8
    )


def decode_chromaprint_fingerprint(encoded: str) -> tuple[int, np.ndarray]:
    normalized = str(encoded or "").strip()
    if not normalized:
        raise RuntimeError("Chromaprint fingerprint is empty")
    try:
        compressed = base64.b64decode(
            normalized + "=" * (-len(normalized) % 4), altchars=b"-_", validate=True
        )
    except (ValueError, binascii.Error) as error:
        raise RuntimeError("Chromaprint fingerprint is not valid URL-safe base64") from error
    if len(compressed) < 4:
        raise RuntimeError("Chromaprint fingerprint is shorter than its header")

    algorithm = compressed[0]
    frame_count = int.from_bytes(compressed[1:4], byteorder="big", signed=False)
    normal_codes = _unpack_lsb_codes(compressed[4:], 3)
    zero_positions = np.flatnonzero(normal_codes == 0)
    if zero_positions.size < frame_count:
        raise RuntimeError("Chromaprint fingerprint has too few normal codes")
    code_count = int(zero_positions[frame_count - 1]) + 1 if frame_count else 0
    normal_codes = normal_codes[:code_count].copy()

    exceptional_count = int(np.count_nonzero(normal_codes == 7))
    exceptional_offset = 4 + (code_count * 3 + 7) // 8
    exceptional_codes = _unpack_lsb_codes(compressed[exceptional_offset:], 5)
    if exceptional_codes.size < exceptional_count:
        raise RuntimeError("Chromaprint fingerprint has too few exceptional codes")
    if exceptional_count:
        normal_codes[normal_codes == 7] += exceptional_codes[:exceptional_count]

    deltas = np.zeros(frame_count, dtype=np.uint32)
    if code_count:
        cumulative = np.cumsum(normal_codes, dtype=np.int64)
        reset = np.maximum.accumulate(np.where(normal_codes == 0, cumulative, 0))
        bit_positions = cumulative - reset - 1
        nonzero = normal_codes != 0
        if np.any(bit_positions[nonzero] < 0) or np.any(bit_positions[nonzero] >= 32):
            raise RuntimeError("Chromaprint fingerprint contains an invalid bit position")
        frame_indices = np.cumsum(normal_codes == 0, dtype=np.int64)[nonzero]
        bit_values = np.left_shift(
            np.uint32(1), bit_positions[nonzero].astype(np.uint32, copy=False)
        )
        np.bitwise_or.at(deltas, frame_indices, bit_values)
    return algorithm, np.bitwise_xor.accumulate(deltas)


def _fingerprint_summary(frames: np.ndarray) -> tuple[np.uint32, np.ndarray]:
    if frames.size == 0:
        return np.uint32(0), np.zeros(32, dtype=np.float64)
    bits = np.unpackbits(frames.astype("<u4", copy=False).view(np.uint8).reshape(-1, 4), axis=1)
    bits = bits.reshape(-1, 4, 8)[:, :, ::-1].reshape(-1, 32)
    density = bits.mean(axis=0, dtype=np.float64)
    sim_hash = np.bitwise_or.reduce(_BIT_WEIGHTS[density > 0.5], initial=np.uint32(0))
    return sim_hash, density


def _uint32_popcount(values: np.ndarray) -> np.ndarray:
    bytes_view = np.ascontiguousarray(values, dtype=np.uint32).view(np.uint8)
    return _POPCOUNT_U8[bytes_view].reshape(values.shape + (4,)).sum(axis=-1, dtype=np.uint8)


def _candidate_pairs(
    rows: Sequence[_AudioRow], sim_hashes: np.ndarray, densities: np.ndarray
) -> list[tuple[int, int, int, float]]:
    candidates: list[tuple[int, int, int, float]] = []
    family_ids = np.asarray([row.family_id for row in rows], dtype=object)
    for left in range(len(rows) - 1):
        right_indices = np.arange(left + 1, len(rows), dtype=np.int64)
        xor = np.bitwise_xor(sim_hashes[left], sim_hashes[left + 1 :])
        hamming = _uint32_popcount(xor)
        coarse_mask = (hamming <= 4) & (family_ids[left + 1 :] != family_ids[left])
        if not np.any(coarse_mask):
            continue
        coarse_indices = right_indices[coarse_mask]
        density_l1 = np.abs(densities[coarse_indices] - densities[left]).sum(axis=1)
        accepted = density_l1 <= 3.0
        for right, distance, density_distance in zip(
            coarse_indices[accepted], hamming[coarse_mask][accepted], density_l1[accepted]
        ):
            candidates.append((left, int(right), int(distance), float(density_distance)))
    return candidates


def _shift_errors(
    source: np.ndarray, mate: np.ndarray, offsets: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    source_size = source.size
    min_length = min(source.size, mate.size)
    if min_length == 0 or offsets.size == 0:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.int64)
    max_offset = int(offsets.max(initial=0))
    required_size = min_length + max_offset
    if source.size < required_size:
        source = np.pad(source, (0, required_size - source.size))
    windows = np.lib.stride_tricks.sliding_window_view(source, min_length)[offsets]
    xor = np.bitwise_xor(windows, mate[:min_length])
    frame_errors = _uint32_popcount(xor)
    cumulative_errors = np.cumsum(frame_errors, axis=1, dtype=np.int32)
    overlaps = np.minimum(source_size - offsets, mate.size).astype(np.int64, copy=False)
    errors = cumulative_errors[np.arange(offsets.size), overlaps - 1].astype(np.int64, copy=False)
    return errors, overlaps


def _best_alignment(left: np.ndarray, right: np.ndarray) -> dict[str, Any] | None:
    min_length = min(left.size, right.size)
    if min_length < 600:
        return None

    positive_offsets = np.arange(0, 121, dtype=np.int64)
    positive_errors, positive_overlaps = _shift_errors(left, right, positive_offsets)
    negative_offsets = np.arange(1, 121, dtype=np.int64)
    negative_errors, negative_overlaps = _shift_errors(right, left, negative_offsets)
    shifts = np.concatenate((-negative_offsets, positive_offsets))
    errors = np.concatenate((negative_errors, positive_errors))
    overlaps = np.concatenate((negative_overlaps, positive_overlaps))
    valid = (overlaps >= 600) & (overlaps / min_length >= 0.75)
    if not np.any(valid):
        return None

    best: tuple[tuple[float, int, int, int], int, int] | None = None
    for shift, bit_errors, overlap in zip(shifts[valid], errors[valid], overlaps[valid]):
        mean_bit_errors = int(bit_errors) / int(overlap)
        key = (mean_bit_errors, abs(int(shift)), int(shift), int(overlap))
        if best is None or key < best[0]:
            best = (key, int(bit_errors), int(overlap))
    if best is None:
        return None
    key, bit_errors, overlap = best
    return {
        "shiftFrames": key[2],
        "overlapFrames": overlap,
        "shorterFingerprintRatio": overlap / min_length,
        "bitErrors": bit_errors,
        "meanBitErrorsPerFrame": key[0],
    }


def _component_assignment_key(exact_family_ids: Sequence[str]) -> str:
    return canonical_json_sha256(sorted(exact_family_ids))


def _component_id(assignment_key: str) -> str:
    return f"audio-isolation-v1:{ISOLATION_POLICY_SHA256[:16]}:{assignment_key}"


def build_audio_isolation_families(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    audio_rows = _project_rows(rows)
    decoded: list[np.ndarray] = []
    algorithms: dict[str, int] = {}
    sim_hashes = np.empty(len(audio_rows), dtype=np.uint32)
    densities = np.empty((len(audio_rows), 32), dtype=np.float64)
    for index, row in enumerate(audio_rows):
        algorithm, frames = decode_chromaprint_fingerprint(row.fingerprint)
        decoded.append(frames)
        algorithms[str(algorithm)] = algorithms.get(str(algorithm), 0) + 1
        sim_hashes[index], densities[index] = _fingerprint_summary(frames)

    disjoint_set = _DisjointSet(len(audio_rows))
    exact_family_roots: dict[str, int] = {}
    exact_union_count = 0
    for index, row in enumerate(audio_rows):
        previous = exact_family_roots.setdefault(row.family_id, index)
        if previous != index and disjoint_set.union(previous, index):
            exact_union_count += 1

    candidates = _candidate_pairs(audio_rows, sim_hashes, densities)
    accepted_links: list[dict[str, Any]] = []
    approximate_union_count = 0
    for left, right, sim_hash_distance, density_l1 in candidates:
        alignment = _best_alignment(decoded[left], decoded[right])
        if alignment is None or alignment["meanBitErrorsPerFrame"] > 2.0:
            continue
        left_row = audio_rows[left]
        right_row = audio_rows[right]
        if disjoint_set.union(left, right):
            approximate_union_count += 1
        accepted_links.append(
            {
                "leftInstanceId": left_row.instance_id,
                "rightInstanceId": right_row.instance_id,
                "leftExactFamilyId": left_row.family_id,
                "rightExactFamilyId": right_row.family_id,
                "leftBatchId": left_row.batch_id,
                "rightBatchId": right_row.batch_id,
                "simHashDistance": sim_hash_distance,
                "bitDensityL1": density_l1,
                **alignment,
            }
        )

    component_indices: dict[int, list[int]] = {}
    for index in range(len(audio_rows)):
        component_indices.setdefault(disjoint_set.find(index), []).append(index)

    instance_to_family: dict[str, str] = {}
    instance_assignment_keys: dict[str, str] = {}
    components: list[dict[str, Any]] = []
    approximate_component_count = 0
    for indices in component_indices.values():
        instance_ids = sorted(audio_rows[index].instance_id for index in indices)
        exact_family_ids = sorted({audio_rows[index].family_id for index in indices})
        batch_ids = sorted(
            {audio_rows[index].batch_id for index in indices if audio_rows[index].batch_id}
        )
        assignment_key = _component_assignment_key(exact_family_ids)
        isolation_family_id = _component_id(assignment_key)
        if len(exact_family_ids) > 1:
            approximate_component_count += 1
        for instance_id in instance_ids:
            instance_to_family[instance_id] = isolation_family_id
            instance_assignment_keys[instance_id] = assignment_key
        components.append(
            {
                "isolationFamilyId": isolation_family_id,
                "assignmentKey": assignment_key,
                "instanceIds": instance_ids,
                "exactFamilyIds": exact_family_ids,
                "batchIds": batch_ids,
            }
        )
    components.sort(key=lambda component: component["isolationFamilyId"])
    accepted_links.sort(
        key=lambda link: (link["leftInstanceId"], link["rightInstanceId"], link["shiftFrames"])
    )

    return {
        "schemaVersion": 1,
        "type": "rkb-audio-isolation-families",
        "policy": copy.deepcopy(ISOLATION_POLICY_V1),
        "policySha256": ISOLATION_POLICY_SHA256,
        "instanceIsolationFamilyIds": dict(sorted(instance_to_family.items())),
        "instanceAssignmentKeys": dict(sorted(instance_assignment_keys.items())),
        "components": components,
        "acceptedLinks": accepted_links,
        "stats": {
            "instanceCount": len(audio_rows),
            "algorithmCounts": dict(sorted(algorithms.items())),
            "exactFamilyCount": len(exact_family_roots),
            "exactUnionCount": exact_union_count,
            "candidatePairCount": len(candidates),
            "acceptedApproximateLinkCount": len(accepted_links),
            "approximateUnionCount": approximate_union_count,
            "approximateComponentCount": approximate_component_count,
            "isolationFamilyCount": len(components),
            "largestComponentInstanceCount": max(
                len(component["instanceIds"]) for component in components
            ),
        },
    }
