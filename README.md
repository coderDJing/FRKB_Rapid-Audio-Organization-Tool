<p align="center">
  <img width="100px" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/build/icon.png?raw=true" alt="GitHub Readme Stats" />
  <h2 align="center">FRKB</h2>
  <p align="center">Rapid Audio Organization Tool</p>
</p>

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest)
[![GitHub Releases](https://img.shields.io/github/downloads/coderDJing/FRKB_Rapid-Audio-Organization-Tool/total?logo=github)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases)
[![Windows](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)](https://www.apple.com/macos)
[![GitHub license](https://img.shields.io/github/license/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/LICENSE)
[![GitHub commit activity](https://img.shields.io/github/commit-activity/m/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/commits/master)
[![GitHub last commit](https://img.shields.io/github/last-commit/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/commits/master)


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
1. Download the latest version from the [releases](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases) page.
2. Run the installer to install on your computer.
3. Launch FRKB from the desktop shortcut.

### Project Background
As a DJ, I frequently need to organize large numbers of music files. However, existing audio file management software often falls short. Many require excessive mouse operations, leading to shoulder and neck pain. Others have poorly designed shortcuts that do not conform to ergonomic principles. Additionally, some only manage file references, leaving the actual file manager cluttered and disorganized. Furthermore, I often end up downloading duplicate songs, which wastes time during the selection process. Therefore, I decided to develop a more user-friendly software solution to address these issues.The ultimate goal of this project is to incorporate AI models that will learn users' classification behavior patterns and automatically categorize songs into libraries, which will save me God knows how much time.

### Introduction
**FRKB** is a cross-platform desktop application designed for audio professionals (such as DJs). The current beta version is compatible with Windows and will be adapted for macOS once stable. It is still under active development.

### Core Features
- **Portable**: Easily transfer the database to mobile devices for on-the-go use.
- **Song Deduplication**: Identify and exclude duplicate tracks in the music library using the SHA256 algorithm (ignoring metadata such as cover art, title, artist, etc.), providing prompts during the import phase to keep your music collection clean and efficient.
- **Ergonomic Shortcuts**: Ergonomically designed shortcuts that allow most operations to be performed with the left hand, making the organization process smoother and more efficient.
- **Selectable Playback Range**: Often, you only need to listen to a specific part of an audio track for screening. This feature allows you to set a start and end point for playback.
- **Direct File Management**: When adding tracks, FRKB directly manages the audio files themselves, ensuring that the organization results are immediately reflected in the computer's folders, achieving a "what you see is what you get" effect.
- **Waveform Visualization**: Provides audio waveform display.
- **BPM Analysis**: Displays BPM information.
- **Recycle Bin**: Features a recycle bin, ensuring that accidentally deleted files aren't permanently lost, a common issue with other software.

### Contributions
Contributions of all kinds are welcome! Whether reporting issues, suggesting features, or contributing code, feel free to open an issue or submit a pull request.

### License
FRKB follows the MIT license, allowing extensive use and modification of the software.

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
