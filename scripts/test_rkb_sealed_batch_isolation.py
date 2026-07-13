import base64
import copy
import hashlib
import unittest

import numpy as np

from rkb_audio_isolation_families import ISOLATION_POLICY_SHA256
from rkb_sealed_batch_common import SealedBatchError
from rkb_sealed_batch_isolation import plan_fresh_audio_isolation_guard


EXPECTED_ISOLATION_POLICY_SHA256 = (
    "e7e52a9df88ea17686bb7825c9ab017edbdf459dfe0a110cc65c2c5b1185be98"
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


def _encode_fingerprint(frames: np.ndarray) -> str:
    normal_codes: list[int] = []
    exceptional_codes: list[int] = []
    previous = 0
    for raw_value in np.asarray(frames, dtype=np.uint32):
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
    header = bytes([1]) + len(frames).to_bytes(3, "big")
    compressed = header + _pack_lsb_codes(normal_codes, 3) + _pack_lsb_codes(
        exceptional_codes, 5
    )
    return base64.urlsafe_b64encode(compressed).decode("ascii").rstrip("=")


def _audio_row(label: str, frames: np.ndarray, *, asset_sha256: str = "") -> dict[str, str]:
    fingerprint = _encode_fingerprint(frames)
    fingerprint_sha256 = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
    return {
        "fileName": f"{label}.wav",
        "assetSha256": asset_sha256 or hashlib.sha256(f"asset:{label}".encode()).hexdigest(),
        "pcmSha256": hashlib.sha256(np.asarray(frames, dtype=np.uint32).tobytes()).hexdigest(),
        "fingerprint": fingerprint,
        "fingerprintSha256": fingerprint_sha256,
        "familyId": f"chromaprint:{fingerprint_sha256}",
    }


def _registry(*rows: dict[str, str]) -> dict[str, object]:
    tracks = [
        {**row, "batchId": f"consumed-{index}", "batchStatus": "consumed"}
        for index, row in enumerate(rows, start=1)
    ]
    return {"trackCount": len(tracks), "tracks": tracks}


class FreshAudioIsolationGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        rng = np.random.default_rng(20260710)
        self.consumed_frames = rng.integers(0, 2**32, size=700, dtype=np.uint32)
        self.near_frames = np.concatenate(
            (
                self.consumed_frames[5:],
                rng.integers(0, 2**32, size=5, dtype=np.uint32),
            )
        )
        self.unrelated_frames = np.random.default_rng(71).integers(
            0, 2**32, size=700, dtype=np.uint32
        )

    def test_near_duplicate_with_different_exact_identities_is_excluded(self) -> None:
        consumed = _audio_row("consumed", self.consumed_frames)
        near = _audio_row("near", self.near_frames)
        unrelated = _audio_row("unrelated", self.unrelated_frames)
        for field in ("assetSha256", "pcmSha256", "fingerprintSha256"):
            self.assertNotEqual(consumed[field], near[field])

        kept, excluded, audit = plan_fresh_audio_isolation_guard(
            registry=_registry(consumed),
            roster=[near, unrelated],
            registry_sha256="a" * 64,
        )

        self.assertEqual({item["assetSha256"] for item in kept}, {unrelated["assetSha256"]})
        self.assertEqual(len(excluded), 1)
        self.assertEqual(excluded[0]["assetSha256"], near["assetSha256"])
        self.assertEqual(excluded[0]["reason"], "duplicate-isolation-family")
        self.assertEqual(audit["stats"]["freshExcludedCount"], 1)
        self.assertEqual(audit["stats"]["freshKeptCount"], 1)

    def test_fresh_only_component_keeps_stable_audio_identity(self) -> None:
        consumed = _audio_row("unrelated-consumed", self.unrelated_frames)
        stable = _audio_row("z-name", self.consumed_frames, asset_sha256="1" * 64)
        duplicate = _audio_row("a-name", self.near_frames, asset_sha256="f" * 64)

        kept, excluded, audit = plan_fresh_audio_isolation_guard(
            registry=_registry(consumed),
            roster=[duplicate, stable],
            registry_sha256="b" * 64,
        )

        self.assertEqual([item["assetSha256"] for item in kept], [stable["assetSha256"]])
        self.assertEqual(excluded[0]["assetSha256"], duplicate["assetSha256"])
        self.assertEqual(
            excluded[0]["reason"], "duplicate-current-batch-isolation-family"
        )
        self.assertEqual(
            audit["stats"]["excludedByReason"],
            {"duplicate-current-batch-isolation-family": 1},
        )

    def test_oracle_name_and_path_fields_do_not_change_decisions(self) -> None:
        consumed = _audio_row("unrelated-consumed", self.unrelated_frames)
        stable = _audio_row("stable", self.consumed_frames, asset_sha256="2" * 64)
        duplicate = _audio_row("duplicate", self.near_frames, asset_sha256="e" * 64)
        clean_registry = _registry(consumed)
        dirty_registry = copy.deepcopy(clean_registry)
        dirty_registry["tracks"][0].update(
            {"fileName": "oracle-name.mp3", "path": "X:/oracle.mp3", "outcome": "pass"}
        )
        dirty_stable = {**stable, "fileName": "zzz.mp3", "truthCategory": "pass"}
        dirty_duplicate = {
            **duplicate,
            "fileName": "aaa.mp3",
            "filePath": "Y:/oracle.mp3",
            "outcome": "fail",
        }

        clean = plan_fresh_audio_isolation_guard(
            registry=clean_registry,
            roster=[stable, duplicate],
            registry_sha256="c" * 64,
        )
        dirty = plan_fresh_audio_isolation_guard(
            registry=dirty_registry,
            roster=[dirty_duplicate, dirty_stable],
            registry_sha256="c" * 64,
        )

        clean_decisions = {
            item["assetSha256"]: item["reason"] for item in clean[1]
        }
        dirty_decisions = {
            item["assetSha256"]: item["reason"] for item in dirty[1]
        }
        self.assertEqual(clean_decisions, dirty_decisions)
        self.assertEqual(clean[2]["freshInstances"], dirty[2]["freshInstances"])
        self.assertEqual(clean[2]["acceptedLinksTouchingFresh"], dirty[2]["acceptedLinksTouchingFresh"])

    def test_missing_consumed_or_fresh_fingerprint_fails_closed(self) -> None:
        consumed = _audio_row("consumed", self.consumed_frames)
        fresh = _audio_row("fresh", self.unrelated_frames)
        bad_consumed = dict(consumed)
        bad_consumed.pop("fingerprint")
        with self.assertRaisesRegex(SealedBatchError, "missing fingerprint.*consumed"):
            plan_fresh_audio_isolation_guard(
                registry=_registry(bad_consumed),
                roster=[fresh],
                registry_sha256="d" * 64,
            )

        bad_fresh = dict(fresh)
        bad_fresh.pop("fingerprint")
        with self.assertRaisesRegex(SealedBatchError, "missing fingerprint.*fresh"):
            plan_fresh_audio_isolation_guard(
                registry=_registry(consumed),
                roster=[bad_fresh],
                registry_sha256="d" * 64,
            )

    def test_guard_policy_is_fixed_and_audited(self) -> None:
        self.assertEqual(ISOLATION_POLICY_SHA256, EXPECTED_ISOLATION_POLICY_SHA256)
        consumed = _audio_row("consumed", self.consumed_frames)
        fresh = _audio_row("fresh", self.unrelated_frames)
        _, _, audit = plan_fresh_audio_isolation_guard(
            registry=_registry(consumed),
            roster=[fresh],
            registry_sha256="e" * 64,
        )
        self.assertEqual(audit["policySha256"], EXPECTED_ISOLATION_POLICY_SHA256)
        self.assertEqual(audit["registrySha256"], "e" * 64)
        self.assertEqual(audit["policy"]["coarseCandidate"]["maxHammingDistance"], 4)
        self.assertEqual(audit["policy"]["alignment"]["maxMeanBitErrorsPerFrame"], 2.0)


if __name__ == "__main__":
    unittest.main()
