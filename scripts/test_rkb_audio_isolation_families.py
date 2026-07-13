import base64
import hashlib
import json
import unittest

import numpy as np

from rkb_audio_isolation_families import (
    ISOLATION_POLICY_SHA256,
    ISOLATION_POLICY_V1,
    build_audio_isolation_families,
    canonical_json_sha256,
    decode_chromaprint_fingerprint,
)


def _pack_lsb_codes(values: list[int], width: int) -> bytes:
    output = bytearray((len(values) * width + 7) // 8)
    bit_offset = 0
    for value in values:
        for bit in range(width):
            if value & (1 << bit):
                absolute_bit = bit_offset + bit
                output[absolute_bit // 8] |= 1 << (absolute_bit % 8)
        bit_offset += width
    return bytes(output)


def _encode_fingerprint(frames: np.ndarray, algorithm: int = 1) -> str:
    normalized = np.asarray(frames, dtype=np.uint32)
    normal_codes: list[int] = []
    exceptional_codes: list[int] = []
    previous = 0
    for raw_value in normalized:
        value = int(raw_value) ^ previous
        previous = int(raw_value)
        last_bit = 0
        bit = 1
        while value:
            if value & 1:
                delta = bit - last_bit
                if delta >= 7:
                    normal_codes.append(7)
                    exceptional_codes.append(delta - 7)
                else:
                    normal_codes.append(delta)
                last_bit = bit
            value >>= 1
            bit += 1
        normal_codes.append(0)
    header = bytes([algorithm]) + len(normalized).to_bytes(3, "big")
    compressed = header + _pack_lsb_codes(normal_codes, 3) + _pack_lsb_codes(
        exceptional_codes, 5
    )
    return base64.urlsafe_b64encode(compressed).decode("ascii").rstrip("=")


def _row(instance_id: str, frames: np.ndarray, batch_id: str = "batch-a") -> dict[str, str]:
    fingerprint = _encode_fingerprint(frames)
    fingerprint_sha256 = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
    return {
        "instanceId": instance_id,
        "familyId": f"chromaprint:{fingerprint_sha256}",
        "pcmSha256": hashlib.sha256(np.asarray(frames, dtype=np.uint32).tobytes()).hexdigest(),
        "fingerprint": fingerprint,
        "fingerprintSha256": fingerprint_sha256,
        "batchId": batch_id,
    }


class ChromaprintDecoderTests(unittest.TestCase):
    def test_round_trip_urlsafeb64_normal_and_exception_codes(self) -> None:
        frames = np.asarray(
            [0, 1, 1 << 31, (1 << 31) | 3, 0xFFFFFFFF, 0x12345678], dtype=np.uint32
        )
        encoded = _encode_fingerprint(frames, algorithm=3)

        algorithm, decoded = decode_chromaprint_fingerprint(encoded)

        self.assertEqual(algorithm, 3)
        np.testing.assert_array_equal(decoded, frames)

    def test_rejects_truncated_fingerprint(self) -> None:
        encoded = base64.urlsafe_b64encode(b"\x01\x00\x00\x02").decode("ascii").rstrip("=")
        with self.assertRaisesRegex(RuntimeError, "too few normal codes"):
            decode_chromaprint_fingerprint(encoded)


class AudioIsolationFamilyTests(unittest.TestCase):
    def test_policy_hash_is_canonical(self) -> None:
        canonical = json.loads(json.dumps(ISOLATION_POLICY_V1, ensure_ascii=False))
        self.assertEqual(ISOLATION_POLICY_SHA256, canonical_json_sha256(canonical))

    def test_exact_family_unions_before_candidates(self) -> None:
        frames = np.arange(620, dtype=np.uint32)
        first = _row("batch-a:asset-a", frames)
        second = dict(first, instanceId="batch-b:asset-b", batchId="batch-b")

        result = build_audio_isolation_families([second, first])

        self.assertEqual(result["stats"]["exactFamilyCount"], 1)
        self.assertEqual(result["stats"]["exactUnionCount"], 1)
        self.assertEqual(result["stats"]["candidatePairCount"], 0)
        self.assertEqual(result["stats"]["isolationFamilyCount"], 1)
        self.assertEqual(result["components"][0]["batchIds"], ["batch-a", "batch-b"])
        expected_assignment_key = canonical_json_sha256(result["components"][0]["exactFamilyIds"])
        self.assertEqual(result["components"][0]["assignmentKey"], expected_assignment_key)
        self.assertEqual(
            set(result["instanceAssignmentKeys"].values()), {expected_assignment_key}
        )
        self.assertNotIn(ISOLATION_POLICY_SHA256, expected_assignment_key)

    def test_finds_best_shift_and_merges_near_identical_audio(self) -> None:
        rng = np.random.default_rng(20260710)
        left_frames = rng.integers(0, 2**32, size=700, dtype=np.uint32)
        right_frames = np.concatenate(
            (left_frames[5:], rng.integers(0, 2**32, size=5, dtype=np.uint32))
        )

        result = build_audio_isolation_families(
            [_row("batch-a:asset-a", left_frames), _row("batch-b:asset-b", right_frames)]
        )

        self.assertEqual(result["stats"]["candidatePairCount"], 1)
        self.assertEqual(result["stats"]["acceptedApproximateLinkCount"], 1)
        self.assertEqual(result["stats"]["approximateUnionCount"], 1)
        self.assertEqual(result["stats"]["isolationFamilyCount"], 1)
        link = result["acceptedLinks"][0]
        self.assertEqual(link["shiftFrames"], 5)
        self.assertEqual(link["overlapFrames"], 695)
        self.assertEqual(link["meanBitErrorsPerFrame"], 0.0)

    def test_rejects_more_than_two_mean_bit_errors(self) -> None:
        rng = np.random.default_rng(42)
        left_frames = rng.integers(0, 2**32, size=620, dtype=np.uint32)
        right_frames = np.bitwise_xor(left_frames, np.uint32(0b111))

        result = build_audio_isolation_families(
            [_row("batch-a:asset-a", left_frames), _row("batch-b:asset-b", right_frames)]
        )

        self.assertEqual(result["stats"]["candidatePairCount"], 1)
        self.assertEqual(result["stats"]["acceptedApproximateLinkCount"], 0)
        self.assertEqual(result["stats"]["isolationFamilyCount"], 2)

    def test_simhash_requires_strict_majority(self) -> None:
        tied_frames = np.concatenate(
            (np.full(300, 0b11111, dtype=np.uint32), np.zeros(300, dtype=np.uint32))
        )
        zero_frames = np.zeros(600, dtype=np.uint32)

        result = build_audio_isolation_families(
            [_row("batch-a:asset-a", tied_frames), _row("batch-b:asset-b", zero_frames)]
        )

        self.assertEqual(result["stats"]["candidatePairCount"], 1)
        self.assertEqual(result["stats"]["acceptedApproximateLinkCount"], 0)

    def test_ignores_non_audio_oracle_fields_and_is_input_order_stable(self) -> None:
        frames = np.arange(620, dtype=np.uint32) * np.uint32(2654435761)
        clean = _row("batch-a:asset-a", frames)
        duplicate = dict(clean, instanceId="batch-b:asset-b", batchId="batch-b")
        dirty = dict(clean, fileName="oracle.mp3", path="X:/oracle.mp3", truth=1, outcome="pass")

        clean_result = build_audio_isolation_families([clean, duplicate])
        dirty_result = build_audio_isolation_families([duplicate, dirty])

        self.assertEqual(clean_result, dirty_result)

    def test_rejects_fingerprint_hash_mismatch(self) -> None:
        row = _row("batch-a:asset-a", np.arange(620, dtype=np.uint32))
        row["fingerprintSha256"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "fingerprintSha256 mismatch"):
            build_audio_isolation_families([row])


if __name__ == "__main__":
    unittest.main()
