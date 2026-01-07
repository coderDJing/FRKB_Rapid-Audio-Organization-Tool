# Third-Party Notices

This project includes third-party software and/or derived logic. The following
notices are provided to comply with their respective licenses.

## Mixxx
- Project: Mixxx DJ software
- Source: https://github.com/mixxxdj/mixxx
- License: GPL-2.0-or-later
- Usage: Mixxx RGB waveform analysis logic and Bessel filter design aligned with Mixxx 2.5.4

## QM DSP Library
- Project: QM DSP Library (Queen Mary University of London)
- Source: https://github.com/mixxxdj/mixxx (vendored under lib/qm-dsp)
- License: GPL-2.0-or-later
- Usage: Key detection (GetKeyMode) and supporting DSP

## KissFFT
- Project: KissFFT
- Source: https://github.com/mborgerding/kissfft (vendored under Mixxx)
- License: BSD-3-Clause
- Usage: FFT backend for QM DSP key detection

## FFmpeg
- Project: FFmpeg
- Source: https://ffmpeg.org/
- License: GPL-2.0-or-later (GPL build is used in CI)
- Windows build source: https://github.com/BtbN/FFmpeg-Builds (ffmpeg-master-latest-win64-gpl.zip)
- macOS build sources: Homebrew ffmpeg, ffbinaries-prebuilt, and ffmpeg-static fallback
- Distributed binaries are bundled under resources/ffmpeg/* in packaged builds
