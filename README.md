<p align="center">
  <img width="100px" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/build/icon.png?raw=true" alt="GitHub Readme Stats" />
  <h2 align="center">FRKB</h2>
  <p align="center">Rapid Audio Organization Tool</p>
</p>

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest)
[![GitHub Releases](https://img.shields.io/github/downloads/coderDJing/FRKB_Rapid-Audio-Organization-Tool/total?logo=github)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases)
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
  <img alt="FRKB in action" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/screenshot/softwareScreenshot.webp?raw=true">
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
**FRKB** is a cross-platform desktop audio screening tool designed for audio professionals such as DJs. It supports both Windows and macOS platforms, with the official version 1.0.0 already released and ongoing active updates.

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
- **Multiple Waveform Visualizations**: Offers SoundCloud-style waveform, fine-grained waveform, and RGB three-band energy view to spot drops and phrasing instantly.
- **Waveform Preview Column**: Shows cached waveform previews directly in the song list for fast scanning.
- **BPM Analysis & Tap Tempo**: Displays BPM information. Left-click the BPM to tap tempo (calculated to 1 decimal place). When the BPM is manually tapped, it is highlighted in `#0078d4`. Right-click to restore the system-analyzed BPM. Tooltip: "Tap beat (LMB) / Reset (RMB)".
- **Key Analysis & Display**: Supports Classic (C#m) and Camelot (1A/1B) display styles.
- **Recycle Bin**: Safely recover deleted tracks and restore them to their original playlists.
- **Cloud Sync (fingerprints)**: Bidirectional sync of local track fingerprints (SHA256) with the cloud, including diff analysis, paginated pulls, and batched uploads, with quota and rate limiting (up to 10 sync starts within 5 minutes). Entry: system tray → Cloud Sync.
- **Internationalization (i18n)**: Built-in Chinese (`zh-CN`) and English (`en-US`) language packs.
- **Save Cover Image**: Right-click the enlarged cover to save the image locally.
- **Metadata Editing & Online Fill**: Edit tags and cover art with MusicBrainz criteria search and AcoustID fingerprint matching, plus batch auto-fill for track info.
- **Song Filtering**: Filter by title, artist, album, duration, format, BPM, and more, with optional persistence after restart.
- **Wide Format Playback & Conversion**: Built-in FFmpeg pipeline plays instantly and batch-converts 20+ mainstream and pro audio formats.

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
