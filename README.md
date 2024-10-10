<p align="center">
  <img width="100px" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/build/icon.png?raw=true" alt="GitHub Readme Stats" />
  <h2 align="center">FRKB</h2>
  <p align="center">Rapid Audio Organization Tool</p>
</p>

[![GitHub commit activity](https://img.shields.io/github/commit-activity/m/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/commits/master)
[![GitHub Releases](https://img.shields.io/github/downloads/coderDJing/FRKB_Rapid-Audio-Organization-Tool/latest/total?logo=github)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases)

<p align="center">
  <a href="/README.md">English</a>
  ·
  <a href="/readme/README_CN.md">Simplified Chinese</a>
</p>

## FRKB
<p align="center">
  <img alt="FRKB in action" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/screenshot/softwareScreenshot_en.png?raw=true">
</p>

### How to Use
1. Download the latest version from the [releases](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases) page.
2. Run the installer to install on your computer.
3. Launch FRKB from the desktop shortcut.

### Project Background
As a DJ, I frequently need to organize large numbers of music files. However, existing audio file management software often falls short. Many require excessive mouse operations, leading to shoulder and neck pain. Others have poorly designed shortcuts that do not conform to ergonomic principles. Additionally, some only manage file references, leaving the actual file manager cluttered and disorganized. Furthermore, I often end up downloading duplicate songs, which wastes time during the selection process. Therefore, I decided to develop a more user-friendly software solution to address these issues.

### Introduction
**FRKB** is a cross-platform desktop application designed for audio professionals (such as DJs). The current beta version is compatible with Windows and will be adapted for macOS once stable. It is still under active development.

### Core Features
- **Portable**: Easily transfer the database to mobile devices for on-the-go use.
- **Audio Fingerprint Deduplication**: Identify and exclude duplicate tracks using audio fingerprint technology, providing prompts during import to keep your music collection clean and efficient.
- **Ergonomic Shortcuts**: Ergonomically designed shortcuts that allow most operations to be performed with the left hand, making the organization process smoother and more efficient.
- **Direct File Management**: When adding tracks, FRKB directly manages the audio files themselves, ensuring that the organization results are immediately reflected in the computer's folders, achieving a "what you see is what you get" effect.
- **Waveform Visualization**: Provides audio waveform display.
- **BPM Analysis**: Displays BPM information.

### Contributions
Contributions of all kinds are welcome! Whether reporting issues, suggesting features, or contributing code, feel free to open an issue or submit a pull request.

### License
FRKB follows the MIT license, allowing extensive use and modification of the software.

# Development

### Compiling Python

```bash
cd pySrc
poetry install
poetry shell
pyinstaller .\src\analyseSongFingerprint.py --distpath=..\resources\pyScript\
```

### Installing Dependencies

```bash
cd..
pnpm install
```

### Development Mode

```bash
pnpm dev
```

### Building

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
