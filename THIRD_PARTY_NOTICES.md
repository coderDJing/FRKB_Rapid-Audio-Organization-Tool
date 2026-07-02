# Third-Party Notices

This project includes third-party software, derived logic, and bundled binary
runtime assets. These notices are provided to describe the current repository
and packaged application license boundaries.

FRKB source code written by CoderDJing is licensed under the MIT License in
`LICENSE`. Third-party code remains under its original license. The current
packaged application includes GPL components, so redistribution of the combined
packaged application must comply with GPL-3.0-or-later as well as the
component licenses below.

## QM DSP Library

- Project: QM DSP Library (Queen Mary University of London)
- Repository path: `rust_package/native/qm`
- Source: QM DSP sources as vendored through the Mixxx source tree
- License: GPL-2.0-or-later
- Current use: key detection through `GetKeyMode` and supporting DSP classes.
  The files are compiled into `rust_package` by `rust_package/build.rs` and
  called from the `analyzeKeyFromPcm` native binding.

## KissFFT

- Project: KissFFT
- Repository paths:
  - `rust_package/native/qm/ext/kissfft`
  - `rust_package/native/chromaprint/kissfft`
- Source: https://github.com/mborgerding/kissfft
- License: BSD-3-Clause
- Current use: FFT backend for QM DSP and Chromaprint code paths.

## FFmpeg

- Project: FFmpeg
- Repository paths:
  - `vendor/ffmpeg`
  - `rust_package/native/ffmpeg`
- Source: https://ffmpeg.org/
- Windows build source: https://github.com/BtbN/FFmpeg-Builds
- Current bundled Windows build: GPL-3.0-or-later. The bundled
  `vendor/ffmpeg/win32-x64/ffmpeg.exe` reports `--enable-gpl --enable-version3`
  and `ffmpeg -L` reports GNU GPL version 3 or later.
- Current use: packaged FFmpeg/FFprobe binaries and FFmpeg libraries used by
  native decode/fingerprint paths.

## SoundTouch

- Projects:
  - SoundTouch
  - SoundTouchJS / `@soundtouchjs/audio-worklet`
  - `@soundtouchjs/core`
- Repository paths:
  - `rust_package/native/soundtouch`
  - packaged dependencies in `node_modules`
- Sources:
  - https://www.surina.net/soundtouch/
  - https://github.com/cutterbl/SoundTouchJS
- Licenses:
  - SoundTouch native sources: LGPL-2.1-or-later
  - `@soundtouchjs/audio-worklet`: LGPL-2.1
  - `@soundtouchjs/core`: LGPL-2.1
- Current use: tempo/pitch processing in native and renderer audio paths.

## Chromaprint

- Project: Chromaprint
- Repository path: `rust_package/native/chromaprint`
- Source: https://acoustid.org/chromaprint
- License: Chromaprint's own source is MIT. The vendored
  `rust_package/native/chromaprint/LICENSE.md` states that the bundled project
  should be considered LGPL-2.1 as a whole because it includes FFmpeg-derived
  code.
- Current use: acoustic fingerprint generation.

## Demucs and Beat-This Runtime Assets

- Repository paths:
  - `vendor/demucs`
  - `scripts/beat_this_*.py`
- Current use: stem separation and beat-grid analysis runtime support.
- Notes: The bundled Python runtimes and site-packages include multiple
  third-party packages with their own licenses. Notable license families in the
  current bundled runtime include MIT, BSD, Apache-2.0, MPL-2.0, LGPL, and Intel
  runtime licenses. The package license files are retained under the bundled
  `vendor/demucs/**/Lib/site-packages/**.dist-info` and runtime license paths.

## Rekordbox Desktop Runtime

- Repository path: `vendor/rekordbox-desktop-runtime`
- Current use: Python runtime and Python packages used by the Rekordbox desktop
  library bridge.
- Notes: The bundled runtime and site-packages include third-party packages
  with their own licenses. License files are retained under the bundled
  `vendor/rekordbox-desktop-runtime/**/Lib/site-packages/**.dist-info` and
  runtime license paths.

## JavaScript and Rust Package Dependencies

- Current production JavaScript dependency licenses include MIT, BSD, ISC,
  Apache-2.0, MPL-2.0-or-Apache-2.0, Python-2.0, and LGPL-2.1 families.
- Current Rust crate dependency licenses include MIT, Apache-2.0, BSD, ISC,
  MPL-2.0, Zlib, Unlicense, and compatible dual-license expressions.
- Dependency package metadata and license files are retained in the lockfiles,
  package metadata, Cargo metadata, and installed dependency folders.

## Compatibility Naming

Some FRKB internal types and cache names still use `Mixxx` as a compatibility
or historical waveform label. The current repository audit found no vendored
Mixxx source file outside the QM DSP source provenance described above. Those
internal names do not by themselves relicense FRKB-owned source code.
