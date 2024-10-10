<p align="center">
 <img width="100px" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/build/icon.png?raw=true" align="center" alt="GitHub Readme Stats" />
 <h2 align="center">FRKB</h2>
 <p align="center">快速音频整理工具</p>
</p>

[![GitHub commit activity](https://img.shields.io/github/commit-activity/m/coderDJing/FRKB_Rapid-Audio-Organization-Tool)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/commits/master)
[![GitHub Releases](https://img.shields.io/github/downloads/coderDJing/FRKB_Rapid-Audio-Organization-Tool/latest/total?logo=github)](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases)

<p align="center">
  <a href="/README.md">English</a>
    ·
  <a href="/readme/README_CN.md">简体中文</a>
 </p>

## FRKB
<p align="center">
  <img alt="FRKB in action" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/screenshot/softwareScreenshot.png?raw=true">
</p>

### 如何使用
1. 在 [releases](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases) 页面下载最新版本
2. 运行安装文件安装到电脑上
3. 在桌面快捷方式启动FRKB

### 项目背景
作为一名DJ，我日常需要整理大量的歌曲文件。然而，市面上现有的音频文件整理软件往往不尽如人意，要么需要过多的鼠标操作，导致肩颈不适；要么快捷键设计不合理，不符合人体工学；要么仅对音频文件进行引用整理，在文件管理器中仍然显得杂乱无章。此外，我还经常遇到下载重复歌曲的问题，这使得筛选过程变得冗长且低效。因此，我决定自己开发一款顺手的软件来解决这些问题。

### 简介

**FRKB** 是一款专为音频工作者（如DJ）设计的跨平台桌面软件，目前仍在积极开发中。它结合了Vue.js的前端技术、Electron的跨平台能力和Python的后端处理，实现了完全离线的操作体验，无需网络连接或外部服务。

### 核心功能

- **独立且便携**：无需安装即可运行FRKB，并轻松将数据库转移到移动设备上随身携带。
- **声音指纹查重**：通过声音指纹技术识别和排除音乐库中的重复曲目，保持音乐收藏的整洁和高效。
- **波形可视化与人体工学快捷键**：提供音频波形预览和符合人体工学的快捷键，让整理操作更加流畅和高效。
- **直接文件管理**：在添加曲目时，FRKB直接管理音频文件本身，确保整理结果立即反映在电脑文件夹中，实现所见即所得的效果。

### 开发状态

FRKB目前仍在开发中，我们不断致力于改进其功能、性能和稳定性。请关注更新和未来发布版本。

### 快速上手

- **下载**：从[发布页面]下载最新版本。
- **运行**：执行适合您操作系统的可执行文件。
- **整理**：利用FRKB的强大功能开始整理您的音频文件。

### 贡献

我们欢迎各种形式的贡献！无论是报告问题、提出功能建议还是贡献代码，都请随时打开问题或提交拉取请求

### 许可证

FRKB遵循MIT许可证，允许广泛使用和修改软件。

# electron-app

An Electron application with Vue

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)

## Project Setup

### Compile Python

```bash
cd pySrc
poetry install
poetry shell
pyinstaller .\src\analyseSongFingerprint.py --distpath=..\resources\pyScript\
```

### Install

```bash
cd..
pnpm install
```

### Development

```bash
pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
