<p align="center">
  <img width="100px" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/build/icon.png?raw=true" alt="GitHub Readme Stats" />
  <h2 align="center">FRKB</h2>
  <p align="center">Rapid Audio Organization Tool</p>
</p>

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest)
[![GitHub license](https://img.shields.io/github/license/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/LICENSE)
[![GitHub commit activity](https://img.shields.io/github/commit-activity/m/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/commits/master)
[![GitHub last commit](https://img.shields.io/github/last-commit/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/commits/master)
[![Windows](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)](https://www.apple.com/macos)


<p align="center">
  <a href="/README.md">English</a>
  ·
  <a href="/readme/README_CN.md">简体中文</a>
</p>

## FRKB
<p align="center">
  <img alt="FRKB in action" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/screenshot/softwareScreenshot.png?raw=true">
</p>

### How to Use
1. Download from the website or the [Releases](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases):
   - Website: https://coderDJing.github.io/FRKB_Rapid-Audio-Organization-Tool/
   - Or go to Releases and pick your platform (Windows/macOS)
2. Run the installer to install on your computer.
3. Launch FRKB from the desktop shortcut.

### Project Background
As a DJ, I frequently need to organize large numbers of music files. However, existing audio file management software often falls short. Many require excessive mouse operations, leading to shoulder and neck pain. Others have poorly designed shortcuts that do not conform to ergonomic principles. Additionally, some only manage file references, leaving the actual file manager cluttered and disorganized. Furthermore, I often end up downloading duplicate songs, which wastes time during the selection process. Therefore, I decided to develop a more user-friendly software solution to address these issues.The ultimate goal of this project is to incorporate AI models that will learn users' classification behavior patterns and automatically categorize songs into libraries, which will save me God knows how much time.

### Introduction
**FRKB** is a cross-platform desktop audio workflow tool designed for audio professionals such as DJs. It combines rapid library organization, fingerprint deduplication, waveform-driven preview, auto-recording, stem separation, Pioneer USB library support, Rekordbox library integration, dual-deck browsing, global search, and standalone conversion in one desktop app for Windows and macOS.

### System Requirements

- Windows 10 or later (x64)
- macOS 12 or later

### Core Features
- **Portable**: Easily transfer the database to mobile devices for on-the-go use.
- **Song Deduplication**: Identify and exclude duplicate tracks using content fingerprints (content hash / file hash modes; content hash ignores cover art, title, artist, etc.), with prompts during import to keep your library clean and efficient.
- **Playlist Fingerprint Deduplication**: One-click analysis on a playlist and move duplicates to the recycle bin.
- **Ergonomic Shortcuts**: Ergonomically designed shortcuts that allow most operations to be performed with the left hand, making the organization process smoother and more efficient.
- **Global Shortcuts**: Playback controls even when minimized, plus a customizable focus/minimize toggle shortcut.
- **Selectable Playback Range**: Often, you only need to listen to a specific part of an audio track for screening. This feature allows you to set a start and end point for playback.
- **Output Device Selection**: Choose a specific output device or follow the system default.
- **Direct File Management**: When adding tracks, FRKB directly manages the audio files themselves, ensuring that the organization results are immediately reflected in the computer's folders, achieving a "what you see is what you get" effect.
- **Filter/Curated Dual-Library Flow**: Fast triage and layered organization that matches DJ workflows.
- **Drag-and-Drop Import & Move**: Drag files/folders to import, drag tracks between playlists, and hold Ctrl/Option to drag out copies to Explorer/Finder.
- **External Track Playback**: Open external audio files for temporary playback without importing them.
- **Track Export**: Export to a folder and optionally delete tracks after export.
- **Multiple Waveform Visualizations**: Offers SoundCloud-style waveform, fine-grained waveform, RGB three-band energy view, and single-track editing waveform to spot drops and phrasing instantly. The single-track editing mode supports detailed waveform inspection and marker placement.
- **Waveform Preview Column**: Shows cached waveform previews directly in the song list for fast scanning.
- **Title Bar Audio Visualization**: Real-time audio spectrum display in the main window title bar, allowing you to monitor playback status and audio energy changes without switching windows.
- **BPM Analysis & Tap Tempo**: Displays BPM information. Left-click the BPM to tap tempo (calculated to 1 decimal place). When the BPM is manually tapped, it is highlighted in `#0078d4`. Right-click to restore the system-analyzed BPM. Tooltip: "Tap beat (LMB) / Reset (RMB)".
- **Key Analysis & Display**: Supports Classic (C#m) and Camelot (1A/1B) display styles.
- **Recycle Bin**: Safely recover deleted tracks and restore them to their original playlists.
- **Cloud Sync (fingerprints)**: Bidirectional sync of local track fingerprints (SHA256) with the cloud, including diff analysis, paginated pulls, and batched uploads, with quota and rate limiting (up to 10 sync starts within 5 minutes). Entry: system tray → Cloud Sync.
- **Curated Artist Cloud Sync**: Curated artist data supports automatic split-linking when tracks contain multiple artists, with intelligent detection and separation. All curated artist information syncs across devices via cloud, maintaining a consistent curated artist list everywhere.
- **Internationalization (i18n)**: Built-in Chinese (`zh-CN`) and English (`en-US`) language packs.
- **Save Cover Image**: Right-click the enlarged cover to save the image locally.
- **Metadata Editing & Online Fill**: Edit tags and cover art with MusicBrainz criteria search and AcoustID fingerprint matching, plus batch auto-fill for track info.
- **Song Filtering**: Filter by title, artist, album, duration, format, BPM, and more, with optional persistence after restart.
- **Wide Format Playback & Conversion**: Built-in FFmpeg pipeline plays instantly, supports standalone conversion workflows, and batch-converts 20+ mainstream and pro audio formats. For non-MP3 audio files, right-click menu provides one-click conversion to MP3 format, automatically skipping existing copies to avoid redundant processing.
- **Mixtape Timeline Editing**: Dedicated auto-recording workspace with a dual-track timeline, beat-grid editing, first-downbeat analysis, metronome tools, preview sync, gain/BPM envelopes, mute segments, undo support, and timeline-accurate export. Supports dragging tracks from the main window directly into the timeline and cross-track drag positioning for quick DJ Set arrangement.
- **Stem Runtime & Separation**: Stem mode, managed runtimes, separation cache management, ONNX fast separation, DirectML/XPU acceleration, and on-demand runtime downloads for auto-recording workflows.
- **Pioneer USB Library Support**: Read more Pioneer USB library variants, including legacy Device Library and OneLibrary entries, with preview waveform caching, multi-drive recognition, playback, and guarded operations.
- **Rekordbox Library Integration**: Directly read local Rekordbox database and playlists without manual XML export. Browse Rekordbox playlists within FRKB, drag-to-reorder tracks, read Cue points and Loop information, with one-click XML export for syncing with other Pioneer devices. Filter and curated libraries support real sequence numbering, maintaining consistent sorting logic with Rekordbox.
- **Dual-Deck Browse Mode**: Provides a DJ mixer-style side-by-side dual-track browsing interface, with each side displaying a track's waveform and control panel. Supports independent volume faders and a crossfader for quick volume balance adjustment between two tracks. Each deck supports Hot Cue (hot markers), Memory Cue (memory markers), Loop (loop segments) control, along with Quantize toggle and beat-grid metronome. Dual-deck mode automatically highlights key information for easy harmonic matching assessment between tracks.
- **Global Track Search**: Search songs across the app and jump back to the matching location with clearer and more stable locate feedback.
- **NetEase Cloud Search**: Right-click menu to directly search the current track on NetEase Cloud Music web, convenient for finding comments, lyrics, and similar recommendations without manually copying song names.
- **Similar Tracks Query**: Dual-source similar track discovery that simultaneously queries two data sources for songs with matching vibes, helping quickly find same-genre music and expand your selection range.
- **Batch Playlist Rename**: Batch rename tracks within a playlist using preset rules or custom formats, useful for organizing tracks collected from different sources while maintaining naming consistency.
- **Selection Count Display**: Real-time display of selected track count at the bottom of the song list, convenient for confirming selection range before batch operations and avoiding mistakes.
- **Playlist Name Hover**: When playlist names are truncated due to length, hovering the mouse displays the full name without adjusting window width or entering edit mode.
- **Idle Background Scheduling**: Unified idle-task scheduling and throttling keep background analysis predictable while reducing contention with foreground work.

  | Format | Scan/Playback | Conversion |
  | ------ | ------------- | ---------- |
  | `MP3`  | ✅             | ✅          |
  | `WAV`  | ✅             | ✅          |
  | `FLAC` | ✅             | ✅          |
  | `AIF`  | ✅             | ✅          |
  | `AIFF` | ✅             | ✅          |
  | `OGG`  | ✅             | ✅          |
  | `OPUS` | ✅             | ✅          |
  | `AAC`  | ✅             | ✅          |
  | `M4A`  | ✅             | ✅          |
  | `MP4`  | ✅             | ✅          |
  | `WMA`  | ✅             | ✅          |
  | `AC3`  | ✅             | ✅          |
  | `DTS`  | ✅             | ✅          |
  | `MKA`  | ✅             | ✅          |
  | `WEBM` | ✅             | ✅          |
  | `APE`  | ✅             | ✅          |
  | `TAK`  | ✅             | ✅          |
  | `TTA`  | ✅             | ✅          |
  | `WV`   | ✅             | ✅          |

### Contributions
Contributions of all kinds are welcome! Whether reporting issues, suggesting features, or contributing code, feel free to open an issue or submit a pull request.

### License
FRKB follows the GNU General Public License v2.0 or later (GPL-2.0-or-later).

# Development

### Compile Rust

```bash
pnpm add -g @napi-rs/cli
cd ./rust_package
napi build --platform --release
```

### Installing Dependencies

```bash
cd ..
pnpm install
```

### Development Mode

```bash
pnpm run dev
```

### Building

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

```

# Backlog
<a href="./backlog.md">backlog.md</a>

### Cloud Sync Backend Project
- `FRKB-API` (cloud sync server): [https://github.com/coderDJing/FRKB-API](https://github.com/coderDJing/FRKB-API)
