"""Bundled Python -m unittest discover -s scripts -p test_inspect_rekordbox_phrase_pssi.py."""

import struct
import unittest

from pyrekordbox.anlz import AnlzFile

from inspect_rekordbox_phrase_pssi import parse_pssi_tag


def phrase_tag(version: int, masked: bool) -> bytes:
    tag = bytearray(80)
    struct.pack_into('>4sIIHHHH', tag, 0, b'PSSI', 32, 80, version, 24, 2, 2)
    struct.pack_into('>H', tag, 26, 65)
    tag[30] = 3
    for index, beat in enumerate((1, 33)):
        struct.pack_into('>HHH', tag, 32 + index * 24, index + 1, beat, 1)
    if masked:
        seed = b'Kanzen-niRikaishita'
        for index in range(18, len(tag)):
            tag[index] ^= (seed[(index - 18 + version) % len(seed)] + 0x80 + 2) & 255
    return bytes(tag)


class PhraseParsingTests(unittest.TestCase):
    def test_both_versions_and_encodings_match_pyrekordbox(self):
        for version in (0, 1):
            for masked in (False, True):
                with self.subTest(version=version, masked=masked):
                    tag = phrase_tag(version, masked)
                    result = parse_pssi_tag(tag)
                    header = struct.pack('>4sIIIIII', b'PMAI', 28, 28 + len(tag), 0, 0, 0, 0)
                    native = AnlzFile.parse(header + tag).get_tag('PSSI').content
                    self.assertEqual(result['version'], version)
                    self.assertEqual(result['lenEntryBytes'], 24)
                    self.assertEqual(result['maskedExport'], masked)
                    self.assertEqual(result['mood'], native.mood)
                    self.assertEqual(result['bank'], native.bank)
                    self.assertEqual([p['beat'] for p in result['phrases']], [1, 33])
                    self.assertEqual([p['beat'] for p in result['phrases']],
                                     [entry.beat for entry in native.entries])
                    self.assertEqual([p['lengthBeats'] for p in result['phrases']], [32, 32])

    def test_rejects_unknown_and_incomplete_structures(self):
        malformed = bytearray(phrase_tag(1, False))
        malformed[14:16] = b'\x00\x19'
        for tag in (phrase_tag(2, False), bytes(malformed), phrase_tag(1, True)[:-1]):
            with self.subTest(tag=tag[:18]):
                with self.assertRaises(ValueError):
                    parse_pssi_tag(tag)


if __name__ == '__main__':
    unittest.main()
