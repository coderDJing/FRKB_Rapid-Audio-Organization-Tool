#!/usr/bin/env python3
"""解析 Rekordbox ANLZ 中的 PSSI（乐句/段落）产物，供逆向文档维护使用。

默认只读本机 `share/PIONEER/USBANLZ` 下的 `.EXT`，不改任何文件。
格式依据 DeepSymmetry crate-digger / pyrekordbox，不是 Pioneer 官方公开规范。
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
from collections import Counter
from pathlib import Path
from typing import Any

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

PSSI_XOR_BASE = bytes(
    [
        0xCB,
        0xE1,
        0xEE,
        0xFA,
        0xE5,
        0xEE,
        0xAD,
        0xEE,
        0xE9,
        0xD2,
        0xE9,
        0xEB,
        0xE1,
        0xE9,
        0xF3,
        0xE8,
        0xE9,
        0xF4,
        0xE1,
    ]
)

MOOD_NAMES = {1: "high", 2: "mid", 3: "low"}
BANK_NAMES = {
    0: "default",
    1: "cool",
    2: "natural",
    3: "hot",
    4: "subtle",
    5: "warm",
    6: "vivid",
    7: "club_1",
    8: "club_2",
}

HIGH_KIND = {1: "intro", 2: "up", 3: "down", 5: "chorus", 6: "outro"}
MID_KIND = {
    1: "intro",
    2: "verse_1",
    3: "verse_2",
    4: "verse_3",
    5: "verse_4",
    6: "verse_5",
    7: "verse_6",
    8: "bridge",
    9: "chorus",
    10: "outro",
}
LOW_KIND = {
    1: "intro",
    2: "verse_1",
    3: "verse_1",
    4: "verse_1",
    5: "verse_2",
    6: "verse_2",
    7: "verse_2",
    8: "bridge",
    9: "chorus",
    10: "outro",
}

DEFAULT_USBANLZ = (
    Path(os.environ.get("APPDATA", "")) / "Pioneer" / "rekordbox" / "share" / "PIONEER" / "USBANLZ"
)


def _read_u16(data: bytes, offset: int) -> int:
    return struct.unpack_from(">H", data, offset)[0]


def _read_u32(data: bytes, offset: int) -> int:
    return struct.unpack_from(">I", data, offset)[0]


def _unmask_pssi_body(body: bytes, len_entries: int) -> bytes:
    if len(body) < 2:
        return body
    raw_mood = _read_u16(body, 0)
    if 1 <= raw_mood <= 3:
        return body
    add = len_entries & 0xFF
    mask = bytes((value + add) & 0xFF for value in PSSI_XOR_BASE)
    return bytes(byte ^ mask[index % len(mask)] for index, byte in enumerate(body))


def _resolve_high_label(kind: int, k1: int, k2: int, k3: int) -> str:
    if kind == 1:
        return "intro_1" if k1 == 1 else "intro_2"
    if kind == 2:
        if k2 == 0 and k3 == 0:
            return "up_1"
        if k2 == 0 and k3 == 1:
            return "up_2"
        if k2 == 1 and k3 == 0:
            return "up_3"
        return "up"
    if kind == 3:
        return "down"
    if kind == 5:
        return "chorus_1" if k1 == 1 else "chorus_2"
    if kind == 6:
        return "outro_1" if k1 == 1 else "outro_2"
    return f"high_{kind}"


def _resolve_label(mood: int, kind: int, k1: int, k2: int, k3: int) -> str:
    if mood == 1:
        return _resolve_high_label(kind, k1, k2, k3)
    table = MID_KIND if mood == 2 else LOW_KIND
    return table.get(kind, f"kind_{kind}")


def parse_anlz_sections(path: Path) -> list[tuple[bytes, bytes]]:
    raw = path.read_bytes()
    if len(raw) < 12 or raw[0:4] != b"PMAI":
        raise ValueError(f"不是 ANLZ 文件: {path}")
    header_size = _read_u32(raw, 4)
    file_size = _read_u32(raw, 8)
    offset = header_size
    sections: list[tuple[bytes, bytes]] = []
    while offset + 12 <= min(file_size, len(raw)):
        kind = raw[offset : offset + 4]
        tag_size = _read_u32(raw, offset + 8)
        if tag_size < 12 or offset + tag_size > len(raw):
            break
        sections.append((kind, raw[offset : offset + tag_size]))
        offset += tag_size
    return sections


def parse_pssi_tag(tag: bytes) -> dict[str, Any]:
    if len(tag) < 20 or tag[0:4] != b"PSSI":
        raise ValueError("不是 PSSI 标签")
    len_header = _read_u32(tag, 4)
    len_tag = _read_u32(tag, 8)
    len_entry_bytes = _read_u32(tag, 12)
    len_entries = _read_u16(tag, 16)
    body = _unmask_pssi_body(tag[18:len_tag], len_entries)
    mood = _read_u16(body, 0) if len(body) >= 2 else 0
    end_beat = _read_u16(body, 8) if len(body) >= 10 else 0
    bank = body[12] if len(body) >= 13 else 0
    entries_blob = body[14:]
    phrases: list[dict[str, Any]] = []
    stride = len_entry_bytes if len_entry_bytes > 0 else 24
    for index in range(len_entries):
        start = index * stride
        chunk = entries_blob[start : start + stride]
        if len(chunk) < 24:
            break
        kind = _read_u16(chunk, 4)
        k1 = chunk[7]
        k2 = chunk[9]
        flag_b = chunk[11]
        k3 = chunk[19]
        fill = chunk[21]
        beat = _read_u16(chunk, 2)
        phrases.append(
            {
                "index": _read_u16(chunk, 0),
                "beat": beat,
                "kind": kind,
                "label": _resolve_label(mood, kind, k1, k2, k3),
                "k1": k1,
                "k2": k2,
                "k3": k3,
                "b": flag_b,
                "beat2": _read_u16(chunk, 12),
                "beat3": _read_u16(chunk, 14),
                "beat4": _read_u16(chunk, 16),
                "fill": bool(fill),
                "fillBeat": _read_u16(chunk, 22) if fill else None,
            }
        )
    for index, phrase in enumerate(phrases):
        next_beat = phrases[index + 1]["beat"] if index + 1 < len(phrases) else end_beat
        phrase["endBeat"] = next_beat
        phrase["lengthBeats"] = max(0, int(next_beat) - int(phrase["beat"]))
        phrase["lengthBars"] = phrase["lengthBeats"] / 4.0
        fill_beat = phrase.get("fillBeat")
        if phrase["fill"] and isinstance(fill_beat, int) and fill_beat > 0:
            phrase["fillLengthBeats"] = max(0, int(next_beat) - fill_beat)
        else:
            phrase["fillLengthBeats"] = 0
    return {
        "lenHeader": len_header,
        "lenEntryBytes": len_entry_bytes,
        "mood": mood,
        "moodName": MOOD_NAMES.get(mood, f"unknown_{mood}"),
        "bank": bank,
        "bankName": BANK_NAMES.get(bank, f"unknown_{bank}"),
        "endBeat": end_beat,
        "maskedExport": _read_u16(tag, 18) > 20 if len(tag) >= 20 else False,
        "phrases": phrases,
    }


def parse_ppth_tag(tag: bytes) -> str:
    if len(tag) < 16 or tag[0:4] != b"PPTH":
        return ""
    length = _read_u32(tag, 12)
    blob = tag[16 : 16 + length]
    return blob.decode("utf-16-be", errors="replace").rstrip("\x00")


def inspect_ext_file(path: Path) -> dict[str, Any]:
    sections = parse_anlz_sections(path)
    result: dict[str, Any] = {
        "extPath": str(path),
        "path": "",
        "hasPssi": False,
        "tags": [kind.decode("latin1", "replace") for kind, _tag in sections],
    }
    for kind, tag in sections:
        if kind == b"PPTH":
            result["path"] = parse_ppth_tag(tag)
        elif kind == b"PSSI":
            result["hasPssi"] = True
            result.update(parse_pssi_tag(tag))
    return result


def collect_ext_files(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    return sorted(root.rglob("*.EXT"))


def _alignment_bucket(beat: int, period: int) -> int:
    return ((max(0, beat) - 1) % period) if beat > 0 else -1


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    with_pssi = [item for item in records if item.get("hasPssi")]
    tag_counts: Counter[str] = Counter()
    for item in records:
        for tag in item.get("tags") or []:
            tag_counts[str(tag)] += 1
    mood_counts = Counter(str(item.get("moodName")) for item in with_pssi)
    label_counts: Counter[str] = Counter()
    length_beats: Counter[int] = Counter()
    start_mod8: Counter[int] = Counter()
    start_mod16: Counter[int] = Counter()
    start_mod32: Counter[int] = Counter()
    fill_lengths: Counter[int] = Counter()
    fill_hosts: Counter[str] = Counter()
    sequence_examples: list[str] = []
    for item in with_pssi:
        phrases = item.get("phrases") or []
        sequence_examples.append(" -> ".join(str(phrase.get("label")) for phrase in phrases))
        for phrase in phrases:
            label = str(phrase.get("label"))
            label_counts[label] += 1
            length_beats[int(phrase.get("lengthBeats") or 0)] += 1
            beat = int(phrase.get("beat") or 0)
            start_mod8[_alignment_bucket(beat, 8)] += 1
            start_mod16[_alignment_bucket(beat, 16)] += 1
            start_mod32[_alignment_bucket(beat, 32)] += 1
            if phrase.get("fill"):
                fill_hosts[label] += 1
                fill_lengths[int(phrase.get("fillLengthBeats") or 0)] += 1
    return {
        "fileCount": len(records),
        "pssiCount": len(with_pssi),
        "missingPssiCount": len(records) - len(with_pssi),
        "extTagCounts": dict(tag_counts),
        "moodCounts": dict(mood_counts),
        "labelCounts": dict(label_counts.most_common()),
        "lengthBeatsTop": dict(length_beats.most_common(16)),
        "startBeatMod8": dict(sorted(start_mod8.items())),
        "startBeatMod16": dict(sorted(start_mod16.items())),
        "startBeatMod32": dict(sorted(start_mod32.items())),
        "fillHostLabels": dict(fill_hosts.most_common()),
        "fillLengthBeats": dict(sorted(fill_lengths.items())),
        "sequenceExamples": sequence_examples[:12],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 Rekordbox PSSI 乐句产物")
    parser.add_argument(
        "root",
        nargs="?",
        default=str(DEFAULT_USBANLZ),
        help="ANLZ .EXT 文件或 USBANLZ 目录",
    )
    parser.add_argument("--json", action="store_true", help="输出完整 JSON")
    parser.add_argument("--limit", type=int, default=0, help="最多解析多少个 EXT，0 表示全部")
    args = parser.parse_args()
    root = Path(args.root)
    if not root.exists():
        raise SystemExit(f"路径不存在: {root}")
    files = collect_ext_files(root)
    if args.limit > 0:
        files = files[: args.limit]
    records = [inspect_ext_file(path) for path in files]
    summary = summarize(records)
    if args.json:
        print(json.dumps({"summary": summary, "tracks": records}, ensure_ascii=False, indent=2))
        return 0
    print(f"root: {root}")
    print(f"EXT: {summary['fileCount']}  PSSI: {summary['pssiCount']}  缺 PSSI: {summary['missingPssiCount']}")
    print(f"extTags: {summary['extTagCounts']}")
    print(f"mood: {summary['moodCounts']}")
    print(f"labels: {summary['labelCounts']}")
    print(f"lengthBeatsTop: {summary['lengthBeatsTop']}")
    print(f"startBeatMod8: {summary['startBeatMod8']}")
    print(f"startBeatMod16: {summary['startBeatMod16']}")
    print(f"startBeatMod32: {summary['startBeatMod32']}")
    print(f"fillHostLabels: {summary['fillHostLabels']}")
    print(f"fillLengthBeats: {summary['fillLengthBeats']}")
    if summary["sequenceExamples"]:
        print("sequenceExamples:")
        for item in summary["sequenceExamples"]:
            print(f"  {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
