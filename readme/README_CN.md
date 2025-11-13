<p align="center">
 <img width="100px" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/build/icon.png?raw=true" align="center" alt="GitHub Readme Stats" />
 <h2 align="center">FRKB</h2>
 <p align="center">快速音频整理工具</p>
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
  <img alt="FRKB in action" src="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/screenshot/softwareScreenshot_cn.webp?raw=true">
</p>

### 如何使用
1. 前往官网或 Releases 下载最新版本：
   - 官网：https://coderDJing.github.io/FRKB_Rapid-Audio-Organization-Tool/
   - 或到 Releases 按系统选择安装包（Windows/macOS）
2. 运行安装文件安装到电脑上
3. 在桌面快捷方式启动 FRKB

### 项目背景
作为一名DJ，我日常需要整理大量的歌曲文件。然而，市面上现有的音频文件整理软件往往不尽如人意，要么需要过多的鼠标操作，导致肩颈不适；要么快捷键设计不合理，不符合人体工学；要么仅对音频文件进行引用整理，在文件管理器中仍然显得杂乱无章。此外，我还经常遇到下载重复歌曲的问题，这使得筛选过程变得冗长且低效。因此，我决定自己开发一款顺手的软件来解决这些问题。项目的最终目标是引入AI模型，在学习用户的分类行为习惯后，帮助用户自动进行分类入库，天知道这会节省我多少时间。

### 简介

**FRKB** 是一款为音频工作者（如DJ）设计的跨平台桌面音频筛选软件，支持Windows/macOS平台，已发布正式版1.0.0，仍在积极更新中。

### 系统要求

- Windows 10 或更高版本（x64）
- macOS 12 或更高版本

### 核心功能

- **便携**：轻松将数据库转移到移动设备上随身携带。
- **歌曲查重**：通过SHA256算法对识别排除音乐库中的重复曲目（忽略封面，标题，作者等元数据信息），在导入阶段给与提示，保持音乐收藏的整洁和高效。
- **人体工学快捷键**：符合人体工学的快捷键，整理过程中的绝大部分时间仅使用左手，让整理操作更加流畅和高效。
- **可以选择播放范围**：筛选音频经常只需要听音频中的一段就可以了，提供范围播放功能，从指定的位置开始播放，到指定的位置结束播放。
- **直接文件管理**：在添加曲目时，FRKB直接管理音频文件本身，确保整理结果立即反映在电脑文件夹中，实现所见即所得的效果。
- **多种波形可视化**：内置 SoundCloud 经典波形、细节波形与 RGB 三频能量柱，快速定位高潮段落与鼓点能量。
- **BPM 分析与点按（Tap Tempo）**：提供 BPM 显示。左键点击 BPM 进行节拍点按（结果保留 1 位小数）。当为手动点按结果时，BPM 数字会以 `#0078d4` 高亮显示；右键点击可恢复系统自动分析的 BPM。悬浮提示为：“左键节拍点按 / 右键恢复”。
- **回收站机制**：提供回收站机制，不会像有些软件一样误删除后就永远消失了。
- **云同步（指纹）**：支持将本地曲目指纹（SHA256）与云端双向同步，包含差异分析、分页拉取、分批上传、配额上限与频控（5 分钟内最多 10 次发起）。入口：系统托盘 → 云同步。
- **国际化（i18n）**：内置中文（`zh-CN`）与英文（`en-US`）语言包。
- **封面右键另存**：悬浮封面支持右键菜单，将封面图片另存为本地文件。
- **歌曲筛选**：支持根据标题，艺术家，专辑，时长，格式等多种维度对歌曲列表进行筛选。
- **多格式播放与转换**：内建 FFmpeg 管线，导入即播，批量转码 20+ 常见与专业音频格式。
  | 格式     | 扫描/播放 | 转换 |
  | -------- | --------- | ---- |
  | `MP3`    | ✅         | ✅    |
  | `WAV`    | ✅         | ✅    |
  | `FLAC`   | ✅         | ✅    |
  | `AIF`    | ✅         | ✅    |
  | `AIFF`   | ✅         | ✅    |
  | `OGG`    | ✅         | ✅    |
  | `OPUS`   | ✅         | ✅    |
  | `AAC`    | ✅         | ✅    |
  | `M4A`    | ✅         | ✅    |
  | `MP4`    | ✅         | ✅    |
  | `WMA`    | ✅         | ✅    |
  | `AC3`    | ✅         | ✅    |
  | `DTS`    | ✅         | ✅    |
  | `MKA`    | ✅         | ✅    |
  | `WEBM`   | ✅         | ✅    |
  | `APE`    | ✅         | ✅    |
  | `TAK`    | ✅         | ✅    |
  | `TTA`    | ✅         | ✅    |
  | `WV`     | ✅         | ✅    |

### 贡献

欢迎各种形式的贡献！无论是报告问题、提出功能建议还是贡献代码，都请随时打开问题或提交拉取请求

### 许可证

FRKB遵循MIT许可证，允许广泛使用和修改软件。

# 如何开发

### 编译rust

```bash
pnpm add -g @napi-rs/cli
cd ./rust_package
napi build --platform --release
```

### 安装依赖

```bash
cd ..
pnpm install
```

### 开发模式

```bash
pnpm run dev
```

### 构建

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

```

# 计划开发的功能清单
<a href="../backlog.md">backlog.md</a>

### 云同步后端项目
- `FRKB-API`（云同步服务器端）：[https://github.com/coderDJing/FRKB-API](https://github.com/coderDJing/FRKB-API)


