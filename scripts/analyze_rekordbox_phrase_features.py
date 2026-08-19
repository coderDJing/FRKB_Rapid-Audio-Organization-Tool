#!/usr/bin/env python3
"""Compare a Rekordbox PSSI phrase result against beat-aligned PCM features.

This research tool is read-only: it decodes an input audio file, reads the paired
ANLZ DAT/EXT files, and writes one JSON report. It does not reproduce or alter
Rekordbox's analysis.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np

from inspect_rekordbox_phrase_pssi import inspect_ext_file


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FFMPEG = REPO_ROOT / 'vendor' / 'ffmpeg' / 'win32-x64' / 'ffmpeg.exe'
SAMPLE_RATE = 22050
SUBBEATS_PER_BEAT = 4


def _decode_mono(audio_path: Path, ffmpeg_path: Path) -> np.ndarray:
    command = [
        str(ffmpeg_path),
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        str(audio_path),
        '-vn',
        '-ac',
        '1',
        '-ar',
        str(SAMPLE_RATE),
        '-f',
        'f32le',
        'pipe:1',
    ]
    completed = subprocess.run(command, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode('utf-8', errors='replace').strip())
    pcm = np.frombuffer(completed.stdout, dtype=np.float32).astype(np.float64)
    if pcm.size == 0:
        raise RuntimeError('ffmpeg returned no PCM')
    return pcm


def _load_beat_times(dat_path: Path) -> list[float]:
    try:
        from pyrekordbox.anlz import AnlzFile
    except Exception as exc:
        raise RuntimeError('run with vendor/rekordbox-desktop-runtime/win32-x64/python/python.exe') from exc

    anlz = AnlzFile.parse_file(dat_path)
    if 'PQTZ' not in anlz:
        raise RuntimeError(f'PQTZ is missing from {dat_path}')
    entries = list(anlz.get_tag('PQTZ').content.entries or [])
    if not entries:
        raise RuntimeError(f'PQTZ has no beat entries: {dat_path}')
    return [float(entry.time) / 1000.0 for entry in entries]


def _band_energy(samples: np.ndarray) -> tuple[float, float, float]:
    if samples.size < 16:
        return 0.0, 0.0, 0.0
    window = np.hanning(samples.size)
    spectrum = np.fft.rfft(samples * window)
    power = np.square(np.abs(spectrum))
    frequencies = np.fft.rfftfreq(samples.size, d=1.0 / SAMPLE_RATE)
    low = float(np.mean(power[(frequencies >= 30.0) & (frequencies < 500.0)]))
    high = float(np.mean(power[(frequencies >= 500.0) & (frequencies < 8000.0)]))
    total = float(np.mean(power[(frequencies >= 30.0) & (frequencies < 8000.0)]))
    return low, high, total


def _beat_feature_rows(pcm: np.ndarray, beat_times: list[float]) -> list[dict[str, float]]:
    rows: list[dict[str, float]] = []
    for beat_index, start_sec in enumerate(beat_times):
        if beat_index + 1 >= len(beat_times):
            end_sec = min(len(pcm) / SAMPLE_RATE, start_sec + (beat_times[-1] - beat_times[-2]))
        else:
            end_sec = beat_times[beat_index + 1]
        step = max(1, int(round((end_sec - start_sec) * SAMPLE_RATE / SUBBEATS_PER_BEAT)))
        bins: list[tuple[float, float, float]] = []
        for subbeat in range(SUBBEATS_PER_BEAT):
            start = int(round(start_sec * SAMPLE_RATE)) + subbeat * step
            end = min(len(pcm), start + step)
            bins.append(_band_energy(pcm[start:end]))
        total_db = np.log10(np.asarray([item[2] for item in bins]) + 1e-12)
        attacks = np.maximum(0.0, np.diff(total_db, prepend=total_db[0]))
        rows.append(
            {
                'startSec': start_sec,
                'endSec': end_sec,
                'low': float(np.mean([item[0] for item in bins])),
                'high': float(np.mean([item[1] for item in bins])),
                'total': float(np.mean([item[2] for item in bins])),
                'attackMean': float(np.mean(attacks)),
                'attackMax': float(np.max(attacks)),
            }
        )
    return rows


def _aggregate(rows: list[dict[str, float]]) -> dict[str, float | int]:
    if not rows:
        return {'beatCount': 0}
    result: dict[str, float | int] = {'beatCount': len(rows)}
    for key in ('low', 'high', 'total', 'attackMean', 'attackMax'):
        values = np.asarray([row[key] for row in rows], dtype=np.float64)
        result[f'{key}Mean'] = float(np.mean(values))
        result[f'{key}Median'] = float(np.median(values))
        result[f'{key}SlopePerBeat'] = float(np.polyfit(np.arange(values.size), values, 1)[0]) if values.size > 1 else 0.0
    return result


def _ratio(numerator: float | int | None, denominator: float | int | None) -> float | None:
    if not isinstance(numerator, (int, float)) or not isinstance(denominator, (int, float)) or denominator == 0:
        return None
    return float(numerator / denominator)


def _start_sec_at(rows: list[dict[str, float]], index: int) -> float | None:
    # 负下标在 Python 里会绕到列表末尾，不能只用 index < len 判断。
    if 0 <= index < len(rows):
        return rows[index]['startSec']
    return None


def _phrase_rows(
    phrases: list[dict[str, Any]], beat_features: list[dict[str, float]]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    beat_count = len(beat_features)
    for phrase in phrases:
        start = max(0, int(phrase['beat']) - 1)
        end = min(beat_count, max(0, int(phrase['endBeat']) - 1))
        metrics = _aggregate(beat_features[start:end])
        rows.append(
            {
                **phrase,
                'startSec': _start_sec_at(beat_features, start),
                'endSec': _start_sec_at(beat_features, end),
                'features': metrics,
            }
        )
    return rows


def _transition_rows(phrases: list[dict[str, Any]], beat_features: list[dict[str, float]]) -> list[dict[str, Any]]:
    transitions: list[dict[str, Any]] = []
    beat_count = len(beat_features)
    for index in range(1, len(phrases)):
        phrase = phrases[index]
        if int(phrase['beat']) <= 0:
            continue
        boundary = int(phrase['beat']) - 1
        left = _aggregate(beat_features[max(0, boundary - 16) : boundary])
        right = _aggregate(beat_features[boundary : min(beat_count, boundary + 16)])
        transitions.append(
            {
                'beat': phrase['beat'],
                'atSec': _start_sec_at(beat_features, boundary),
                'fromLabel': phrases[index - 1]['label'],
                'toLabel': phrase['label'],
                'before4Bars': left,
                'after4Bars': right,
                'afterToBefore': {
                    key: _ratio(right.get(f'{key}Mean'), left.get(f'{key}Mean'))
                    for key in ('low', 'high', 'total', 'attackMean')
                },
            }
        )
    return transitions


def _fill_rows(phrases: list[dict[str, Any]], beat_features: list[dict[str, float]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    beat_count = len(beat_features)
    for phrase in phrases:
        fill_beat = phrase.get('fillBeat')
        fill_length = int(phrase.get('fillLengthBeats') or 0)
        # 与解析器一致：拍号从 1 起。0 不是第 0 拍，减 1 后会变成 Python 的 -1。
        if not phrase.get('fill') or not isinstance(fill_beat, int) or fill_beat <= 0 or fill_length <= 0:
            continue
        fill_start = fill_beat - 1
        fill_end = min(beat_count, max(0, int(phrase['endBeat']) - 1))
        length = max(0, fill_end - fill_start)
        before = _aggregate(beat_features[max(0, fill_start - length) : fill_start])
        fill = _aggregate(beat_features[fill_start:fill_end])
        results.append(
            {
                'hostLabel': phrase['label'],
                'fillBeat': fill_beat,
                'fillLengthBeats': fill_length,
                'startSec': _start_sec_at(beat_features, fill_start),
                'beforeSameLength': before,
                'fill': fill,
                'fillToBefore': {
                    key: _ratio(fill.get(f'{key}Mean'), before.get(f'{key}Mean'))
                    for key in ('low', 'high', 'total', 'attackMean')
                },
            }
        )
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description='Compare Rekordbox PSSI phrases against PCM features')
    parser.add_argument('--ext', required=True, type=Path, help='PSSI-containing ANLZ0000.EXT')
    parser.add_argument('--dat', required=True, type=Path, help='paired ANLZ0000.DAT with PQTZ')
    parser.add_argument('--audio', required=True, type=Path, help='source audio used for analysis')
    parser.add_argument('--output', required=True, type=Path, help='output JSON report')
    parser.add_argument('--ffmpeg', type=Path, default=DEFAULT_FFMPEG)
    args = parser.parse_args()

    ext = inspect_ext_file(args.ext)
    if not ext.get('hasPssi'):
        raise SystemExit(f'PSSI is missing: {args.ext}')
    if not args.ffmpeg.exists() or not args.audio.exists() or not args.dat.exists():
        raise SystemExit('ext, dat, audio, and ffmpeg must all exist')

    beat_times = _load_beat_times(args.dat)
    pcm = _decode_mono(args.audio, args.ffmpeg)
    features = _beat_feature_rows(pcm, beat_times)
    phrases = list(ext['phrases'])
    report = {
        'source': {
            'ext': str(args.ext),
            'dat': str(args.dat),
            'audio': str(args.audio),
            'sampleRate': SAMPLE_RATE,
            'subbeatsPerBeat': SUBBEATS_PER_BEAT,
            'pqtzBeatCount': len(beat_times),
            'pcmDurationSec': len(pcm) / SAMPLE_RATE,
        },
        'pssi': {
            key: ext[key]
            for key in ('mood', 'moodName', 'bank', 'bankName', 'endBeat', 'lenEntryBytes', 'maskedExport')
        },
        'phrases': _phrase_rows(phrases, features),
        'transitions': _transition_rows(phrases, features),
        'fills': _fill_rows(phrases, features),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(args.output), 'phrases': len(phrases), 'fills': len(report['fills'])}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
