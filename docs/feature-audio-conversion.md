# 音频格式转换功能设计说明

## 目标与范围
- 目标：在不要求用户另行安装任何依赖的前提下，为选中的曲目提供“转换格式”能力，支持批量操作，与现有并发与进度体系无缝对接。
- 平台：Windows、macOS（不做代码签名/公证的前提下，采取可执行权限与隔离属性兜底策略）。
- 不在本次范围：ffmpeg 下载/安装（随应用内置）、云转码、队列页面复杂管理（先使用现有全局进度反馈）。

## 入口与交互概览
- 入口：曲目列表中，选中单个或多个曲目，右键菜单新增“转换格式…”。
- 点击后弹出配置弹窗（风格与 `Settings` 页面一致）：
  - 可选择目标格式与编码预设；
  - 选择输出策略（生成新文件或替换原文件）；
  - 选择是否将新文件的指纹加入指纹库；
  - 点击“开始转换”后关闭弹窗并进入全局进度反馈（沿用现有 `progressSet` 机制）。

## 弹窗 UI 设计（仿照 Settings 风格）
表单字段：
1) 目标格式（必选，单选）
   - 选项：仅列出“软件已支持的格式”与“本机可用编码器”的交集。
     - 软件已支持的格式来源：`store.settingConfig.audioExt`（如 .mp3/.m4a/.aac/.flac/.wav/.ogg/.opus 等，需做扩展名→格式归一映射）。
     - 编码器可用性：基于随包 ffmpeg 的 `-codecs` 能力；不可用则在 UI 中隐藏或置灰。
   - 默认：首次为 MP3；用户一旦选择过，下次打开默认加载为“上次选择”。

2) 编码预设（可折叠的高级设置）
   - 比特率（针对有损编码：MP3/AAC/OPUS）：默认 320 kbps（MP3），192 kbps（AAC），128 kbps（OPUS）
   - 采样率：默认 44100 Hz（可选 48000 Hz）
   - 声道：默认 2（立体声）
   - 保留元数据：勾选（默认勾选）
   - 音量归一化（可选）：关闭（默认）

3) 输出策略（必选，单选）
   - 生成新文件（默认）
     - 输出位置：源文件所在文件夹（与源文件同级）。
     - 重名策略：强制自动重命名（追加后缀），不覆盖现有文件。
   - 替换原文件
     - 备份原文件到软件内回收站（默认勾选，可切换）

4) 指纹处理
   - 将新文件指纹加入指纹库：勾选（默认关闭，可根据设置页全局默认值初始化）
   - 指纹模式：沿用设置中的 `fingerprintMode`（文件/PCM），不在本弹窗独立配置。

5) 操作按钮
   - 取消
   - 开始转换（主按钮）

提示与禁用规则：
- 当选择“替换原文件”且源与目标格式相同，允许“重新编码”（提示会有质量变化风险），也允许用户取消。
- 当检测到磁盘空间可能不足时，开始前给出提醒（如可用）。

## 进度与结果反馈
- 进度：沿用主进程 `sendProgress('audio.convert', current, total)` 的全局进度条；对于批量任务，按文件维度更新。
- 结果摘要（完成后通知）：
  - 转换总数/成功/失败/跳过/覆盖/重命名数量；
  - 新增到指纹库的数量；
  - 回收站备份的文件数（当选择替换且开启备份时）。

## 后端（主进程）对接概述
不在本次文档实现代码，仅定义接口与行为：

- Renderer → Main（开始）
  - channel: `audio:convert:start`
  - payload：
    ```ts
    type ConvertJobOptions = {
      src: string
      targetFormat: 'mp3'|'aac'|'flac'|'wav'|'opus'
      bitrateKbps?: number
      sampleRate?: 44100|48000
      channels?: 1|2
      preserveMetadata?: boolean
      normalize?: boolean
      strategy: 'new_file'|'replace'
      overwrite?: boolean // 针对 new_file
      backupOnReplace?: boolean // 针对 replace
      addFingerprint?: boolean
    }
    ```

- Main → Renderer（进度）
  - channel: `audio:convert:progress`
  - data: `{ jobId, index, total, filePath, percent, speedKbps?, etaSec? }`

- Main → Renderer（完成/失败/汇总）
  - channel: `audio:convert:done`
  - data: `{
      summary: {
        total, success, failed, skipped,
        overwritten, renamed, backupCount,
        fingerprintAddedCount
      },
      errors: Array<{filePath: string, message: string}>
    }`

- Renderer → Main（取消）
- channel: `audio:convert:cancel`
- data: `{ jobId }`（主进程维护 jobId → 子进程映射并终止）

实现要点（主进程，后续实现时遵循）：
- ffmpeg 二进制：随应用打包在 `extraResources`（Windows x64、macOS x64/arm64 各一份），运行时按平台/架构选择；macOS 首次尝试 `chmod +x` 并清理隔离属性（失败则 UI 指引）。
- 并发：默认 1（可在设置页配置），走现有 `runWithConcurrency`。
- 进度：用 `ffprobe` 获取总时长（可选），`ffmpeg -progress pipe:1 -nostats` 解析 `out_time_ms` 推算百分比；无 `ffprobe` 时可退化为按输出时长或文件大小估算。
- 输出：先在源文件同目录写临时文件（如 `.<name>.tmp`）→ 校验成功后原子重命名；
  - `new_file` 策略：自动重命名（例如在文件名末尾追加格式标识或序号），绝不覆盖已有文件；
  - `replace` 策略：若开启备份则先将原文件移动到软件回收站，再以目标文件覆盖原路径。
- 指纹：当勾选 `addFingerprint` 时，在转换成功后对新文件计算指纹并合入指纹库（沿用现有 `FingerprintStore` 与配置）。
- 容错：
  - 磁盘满：中断当前批次，触发与导入/回收站类似的 `file-batch-summary` 通知；
  - 权限/路径错误：记录错误并继续其他任务；
  - 架构不匹配（mac 上）：在开始前路径解析即校验，发现问题直接 fail-fast 并提示。

## 用户偏好记忆（首次默认 MP3，其后沿用上次选择）
- 持久化位置：`store.settingConfig.convertDefaults`（与其他设置一并读写）。
- 建议字段：
  ```ts
  type ConvertDefaults = {
    targetFormat: 'mp3'|'aac'|'flac'|'wav'|'opus' // 受支持格式子集
    bitrateKbps?: number
    sampleRate?: 44100|48000
    channels?: 1|2
    preserveMetadata?: boolean
    normalize?: boolean
    strategy: 'new_file'|'replace'
    overwrite?: boolean
    backupOnReplace?: boolean
    addFingerprint?: boolean
  }
  ```
- 行为约定：
  - 弹窗打开时：若存在 `convertDefaults` 则作为初始值；否则以“MP3 + 保留元数据 + 生成新文件 + 并发默认值”的内置预设。
  - 点击“开始转换”时：将本次用户选择写回 `convertDefaults`，用于下次默认。
  - 仅展示/允许保存“当前应用支持且 ffmpeg 编码器可用”的格式与参数；不合法的历史值在展示层回退到最近的合法选项。

## 右键菜单改动
- 曲目项（单选/多选）右键菜单新增项：`转换格式…`
- 仅当选中项均为支持的音频扩展名时可用（扩展名列表沿用 `store.settingConfig.audioExt`）。

## 文案（示例）
- 菜单项：`转换格式…`
- 弹窗标题：`转换格式`
- 字段：`目标格式`、`编码预设`、`比特率`、`采样率`、`声道`、`保留元数据`、`音量归一化`、`输出策略`、`生成新文件`、`替换原文件`、`重名时覆盖`、`备份原文件到回收站`、`将新文件指纹加入指纹库`
- 按钮：`开始转换`、`取消`
- 提示：
  - `源与目标格式相同，继续将会重新编码，可能影响音质。`
  - `磁盘空间不足，可能导致转换失败。`
  - `部分文件转换失败，可在摘要中查看原因。`

## 平台与合规注意
- Windows：未签名将触发 SmartScreen，一旦应用放行，ffmpeg 可正常调用。
- macOS：应用可启动的前提下，ffmpeg 通常可调用；需保证可执行权限、清理隔离属性，并提供失败时指引。未签名/未公证在少数受管设备上可能被策略阻拦。
- 许可证：随包附带 FFmpeg 许可证文本，在“关于/设置”展示致谢。

## CI 集成：release.yml 在构建阶段下载并摆放 FFmpeg
目标：在 CI 构建时把各平台/架构的 ffmpeg 放入 `vendor/ffmpeg/<platform-arch>/`，由 electron-builder 的 `extraResources` 打包至产物中，用户零安装。

约定路径（仓库相对）：
- Windows x64：`vendor/ffmpeg/win32-x64/ffmpeg.exe`
- macOS arm64：`vendor/ffmpeg/darwin-arm64/ffmpeg`
- macOS x64：`vendor/ffmpeg/darwin-x64/ffmpeg`

electron-builder 配置（示例，放到 package.json 的 build 字段或 electron-builder.yml）：
```json
{
  "build": {
    "extraResources": [
      { "from": "vendor/ffmpeg", "to": "ffmpeg" }
    ]
  }
}
```

运行时解析路径（示意）：
```ts
function resolveBundledFfmpegPath() {
  const isPackaged = app.isPackaged
  const platform = process.platform // 'win32' | 'darwin'
  const arch = process.arch        // 'x64' | 'arm64'
  const base = isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, '../../../vendor')
  const dir = platform === 'win32'
    ? 'win32-x64'
    : (arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  return path.join(base, 'ffmpeg', dir, exe)
}
```

### Windows Job 片段（放在 Package 步骤之前）
```yaml
      - name: Prepare FFmpeg (Windows)
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Force -Path vendor/ffmpeg/win32-x64 | Out-Null
          $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip'
          Invoke-WebRequest -Uri $url -OutFile ffmpeg.zip
          Expand-Archive -Path ffmpeg.zip -DestinationPath ffmpeg_unzip -Force
          $ff = (Get-ChildItem -Recurse -Filter ffmpeg.exe ffmpeg_unzip | Select-Object -First 1).FullName
          Copy-Item -Path $ff -Destination vendor/ffmpeg/win32-x64/ffmpeg.exe -Force
          Remove-Item ffmpeg.zip -Force
          Remove-Item ffmpeg_unzip -Recurse -Force

      - name: Verify FFmpeg (Windows)
        shell: pwsh
        run: |
          vendor/ffmpeg/win32-x64/ffmpeg.exe -version
```

### macOS Job 片段（放在 Package 步骤之前）
说明：使用 evermeet 提供的通用（universal）或新版本 ffmpeg 二进制；若为通用可同时用于 x64 与 arm64。若下载到的是单架构版本，也请分别下载两次放到对应目录。

```yaml
      - name: Prepare FFmpeg (macOS)
        run: |
          mkdir -p vendor/ffmpeg/darwin-arm64 vendor/ffmpeg/darwin-x64
          curl -L "https://evermeet.cx/ffmpeg/ffmpeg.zip" -o ffmpeg-mac.zip
          unzip -o ffmpeg-mac.zip -d ffmpeg_mac
          # 将同一二进制拷贝到两处（若为 universal 可两处通用）
          install -m 755 ffmpeg_mac/ffmpeg vendor/ffmpeg/darwin-arm64/ffmpeg
          install -m 755 ffmpeg_mac/ffmpeg vendor/ffmpeg/darwin-x64/ffmpeg
          rm -rf ffmpeg-mac.zip ffmpeg_mac

      - name: Verify FFmpeg (macOS)
        run: |
          file vendor/ffmpeg/darwin-arm64/ffmpeg || true
          file vendor/ffmpeg/darwin-x64/ffmpeg || true
          vendor/ffmpeg/darwin-arm64/ffmpeg -version || true
          vendor/ffmpeg/darwin-x64/ffmpeg -version || true
```

注意：若你更偏好指定版本，可把 `ffmpeg.zip` 换成固定版本链接，例如 `https://evermeet.cx/ffmpeg/ffmpeg-6.1.1.zip`。

## 验收清单（QA）
- 右键菜单出现且仅在支持格式时可用；
- 弹窗表单校验与默认值正确；
- 批量转换能看到进度并可取消；
- 新文件输出到源文件同目录，自动重命名且不覆盖；
- 替换时原文件进入软件回收站（若开启）；
- 勾选加入指纹库时，转换成功文件的指纹被正确合入；
- Windows/macOS 均可正常完成一次批量转换；
- 错误摘要信息清晰、可定位问题文件。
- 目标格式选项仅为软件支持∩编码器可用；首次默认 MP3，其后默认沿用上次选择。


