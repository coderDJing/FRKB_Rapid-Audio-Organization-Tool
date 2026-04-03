# Rekordbox 本机库第一阶段草案

更新时间：2026-04-03

## 0. 当前拍板

本草案当前先按下面这些决策执行，别后面又改得像坨浆糊：

1. 第一阶段只做 `Rekordbox 本机库` 的读取和复制，不做任何写回。
2. 用户侧体验尽量和当前 `Rekordbox U 盘读取` 保持一致。
3. 唯一明确的 UI 差异是：左侧库选择区新增一个独立 icon，用来代表“Rekordbox 本机库”。
4. 第一阶段不新开一整套页面，优先复用当前 `PioneerDeviceLibrary` 的树区和歌曲区。
5. 运行时必须开箱即用，不能要求用户自己安装 Python。
6. 第一阶段只支持 `Windows / macOS`；`Linux` 不纳入支持范围。
7. 第一阶段允许在检测到数据库被占用或读取失败时，提示用户关闭 Rekordbox 后重试；先不承诺热读取百分百稳定。

## 1. 目标

本期目标非常收敛：

- 识别当前电脑上的本机 Rekordbox 库
- 读取播放列表树
- 读取播放列表内曲目
- 读取封面、基础元数据、BPM、Key、分析路径
- 复用现有只读歌曲区能力：
  - 双击播放
  - 波形预览
  - 导出复制
  - 复制到 FRKB 库
  - 复制到 Mixtape

本期明确不做：

- 不写回 `master.db`
- 不创建 / 删除 / 重命名 Rekordbox 播放列表
- 不同步 cue / hot cue / memory cue / loop
- 不做 Rekordbox 云库、流媒体、历史记录支持
- 不做 Linux

## 2. 用户可见行为

### 2.1 左侧库选择区

新增一个独立 icon，例如：

- `RekordboxDesktopLibrary`

交互规则：

- 当检测到本机存在可读 Rekordbox 库时显示该 icon
- 点击后进入与当前 U 盘库相同的“只读浏览模式”
- 该 icon 没有“弹出 U 盘”右键菜单

### 2.2 中间歌单树区域

保持和当前 U 盘库一致：

- 顶部显示源名称，例如 `Rekordbox 本机库`
- 支持搜索播放列表
- 支持文件夹展开 / 折叠
- 支持切换选中播放列表

### 2.3 右侧歌曲区域

保持和当前 U 盘库一致：

- 只读显示曲目列表
- 支持双击播放
- 支持封面缩略图
- 支持波形预览
- 支持右键菜单

第一阶段右键菜单保持现状：

- `导出曲目（仅复制）`
- `复制到筛选库`
- `复制到精选库`
- `复制到 Mixtape`
- `在资源管理器中显示`
- `分析并加入指纹`

## 3. 与现有 U 盘功能的关系

第一阶段不重新发明轮子，直接站在现有实现上干。

当前可复用的链路已经有：

- 左侧设备入口与选中态
- 歌单树读取后展示
- 歌曲区只读表格
- 复制到 FRKB 库
- 复制到 Mixtape
- 导出复制
- Pioneer 预览波形读取与渲染

这意味着第一阶段不是再做一套“本机库专属页面”，而是：

1. 新增一个“本机库 source”
2. 让它进入和当前 U 盘相同的浏览容器
3. 仅在数据来源和 icon 上区分

## 4. 技术路线

## 4.1 总体方案

采用下面这条链路：

1. Electron Main 检测本机 Rekordbox 安装与数据目录
2. Main 拉起内置 Python helper
3. Python helper 使用 `pyrekordbox` 读取本机库
4. helper 通过 `stdout JSON` 把树、曲目、封面路径、分析路径回传给 Main
5. Main 归一化成现有只读歌曲区可消费的数据
6. Renderer 继续走现有只读浏览 UI

一句话：

- UI 复用当前 U 盘库
- 数据源换成本机 `master.db`
- 运行时靠内置 Python + `pyrekordbox`

## 4.2 为什么第一阶段用 Python helper

第一阶段要的是“快落地、可发布、用户无感安装”。

`pyrekordbox` 当前最适合干这件事，因为它已经覆盖：

- `master.db`
- Rekordbox XML
- `ANLZ`
- `My-Setting`

而且它已经处理了本机库解锁问题，省得我们现在就去 Rust 里硬啃 SQLCipher 和本机 key 提取这坨脏活。

本期正式结论：

- 第一阶段运行时允许依赖 Python helper
- 但这个 Python runtime 必须跟产品一起打包
- 不能让用户自己装 Python

## 4.3 运行时打包策略

目标只有一个：

- 安装 FRKB 后直接能用

建议沿用当前 `demucs` 的思路，但不要和 `demucs` 运行时硬耦合，避免把一堆 torch 垃圾绑到这条链路上。

建议新增一套独立运行时资源，例如：

```text
vendor/rekordbox-desktop-runtime/
  win32-x64/
    python/
  darwin-arm64/
    python/
  darwin-x64/
    python/

resources/rekordboxDesktopLibrary/
  bridge.py
```

构建时做的事：

- 把独立 Python runtime 打进安装包
- 把 `pyrekordbox` 及其依赖预装进该 runtime
- 把 helper 脚本一起打包

运行时做的事：

- Main 直接执行内置 Python
- 调 `bridge.py`
- 不访问用户系统 Python

## 4.4 支持平台

第一阶段只做：

- Windows
- macOS

不做：

- Linux

原因很简单：

- Rekordbox 桌面本机库本来就主要对应 Win/mac
- 第一阶段没必要给自己加一层伪需求

## 5. 推荐的数据与状态改造

这里有个必须先骂清楚的点：

当前很多字段已经写死成了 `drive` / `pioneer` 语义，比如：

- `selectedDriveKey`
- `selectedDriveName`
- `selectedDrivePath`
- `pioneerAnalyzePath`
- `pioneerDeviceRootPath`

U 盘模式这么叫还能忍，本机库再沿用这套名字，后面读起来就跟屎上雕花一样恶心。

所以第一阶段建议做“最小泛化”，不是全面改名，但关键状态和歌曲附加字段要先抽象出来。

### 5.1 浏览状态建议

建议把当前设备浏览状态收敛成“外部 Rekordbox 源浏览状态”，至少包含：

```ts
type RekordboxSourceKind = 'usb' | 'desktop'

type RekordboxSourceLibraryType = 'deviceLibrary' | 'oneLibrary' | 'masterDb'

interface IRekordboxLibraryBrowserState {
  selectedSourceKey: string
  selectedSourceName: string
  selectedSourceRootPath: string
  selectedSourceKind: RekordboxSourceKind | ''
  selectedLibraryType: RekordboxSourceLibraryType | ''
  selectedPlaylistId: number
  loading: boolean
  treeNodes: IPioneerPlaylistTreeNode[]
}
```

说明：

- `usb` 对应现有 U 盘库
- `desktop` 对应本机 Rekordbox 库
- `masterDb` 是本机库的 library type

### 5.2 歌曲附加字段建议

当前 `ISongInfo` 里这些字段也该一起泛化：

```ts
externalAnalyzePath?: string | null
externalWaveformRootPath?: string | null
externalSourceKind?: 'usb' | 'desktop' | null
```

原因：

- 现在波形预览链路已经在 `useSongLoader.ts`、`useWaveformPreview.ts`、`HorizontalBrowseWaveformOverview.vue` 里吃 `pioneerAnalyzePath / pioneerDeviceRootPath`
- 不先泛化，本机库波形只能继续假装自己是 U 盘，代码会越来越蠢

### 5.3 视图选择建议

第一阶段为了少动 UI 框架，可以保留：

- `runtime.libraryAreaSelected === 'PioneerDeviceLibrary'`

也就是说：

- 现有 U 盘 icon
- 新增本机库 icon

都进入同一个只读浏览视图壳子。

差异靠：

- `selectedSourceKind`
- `selectedLibraryType`
- `selectedSourceKey`

来区分。

这招很务实，第一阶段够用。

## 6. 目录与模块建议

## 6.1 Main 侧新增模块

建议新增：

```text
src/main/services/rekordboxDesktopLibrary/
  detect.ts
  helper.ts
  tree.ts
  tracks.ts
  waveform.ts
  types.ts
```

职责建议：

- `detect.ts`
  - 检测本机是否安装 Rekordbox
  - 检测本机库路径是否可用
- `helper.ts`
  - 解析内置 Python 路径
  - 拉起 helper
  - 处理 stdin/stdout JSON
- `tree.ts`
  - 读取并归一化播放列表树
- `tracks.ts`
  - 按播放列表读取曲目
- `waveform.ts`
  - 按分析路径读取预览波形
- `types.ts`
  - 定义本机库 IPC 返回结构

## 6.2 Python helper 建议

建议 helper 只做四类命令：

- `probe`
- `load-tree`
- `load-playlist-tracks`
- `get-preview-waveforms`

输入输出统一走 JSON，别整花活。

建议输出结构尽量贴近现有 U 盘 IPC：

- 这样 Renderer 可以最大限度复用
- Main 只做轻量归一化

## 6.3 IPC 建议

建议新增独立 IPC，而不是把桌面库强塞进现有 `pioneer-device-library:*`。

建议新增：

- `rekordbox-desktop-library:probe`
- `rekordbox-desktop-library:load-tree`
- `rekordbox-desktop-library:load-playlist-tracks`
- `rekordbox-desktop-library:get-preview-waveforms`

UI 聚合层再把：

- U 盘 source
- 本机库 source

拼成统一的“外部 Rekordbox 来源列表”。

## 7. UI 改动建议

## 7.1 左侧 icon

建议新增资源：

```text
src/renderer/src/assets/rekordboxDesktop.svg
```

建议 tooltip / i18n：

- `library.rekordboxDesktopLibrary`
- 中文：`Rekordbox 本机库`
- 英文：`Rekordbox Desktop Library`

显示逻辑：

- 仅在 `probe` 成功时显示

## 7.2 当前组件复用策略

第一阶段建议继续复用：

- `librarySelectArea.vue`
- `pioneerDeviceLibraryArea.vue`
- `pioneerSongsArea.vue`

但是要做两类分支：

1. source 为 `usb`
2. source 为 `desktop`

具体差异：

- `usb` 才有弹出菜单
- `desktop` 没有弹出菜单
- 标题文案不同
- 加载数据来源不同

## 7.3 文案

当前很多文案写的是 `Pioneer U 盘`，第一阶段应该拆成 source-aware 文案，不然点本机库还写着“正在读取 U 盘库”，这就太抽象了。

建议把这些文案改成按 source 分支：

- 加载歌单树
- 空歌单树
- 加载曲目
- 选择歌单提示
- 读取失败提示

## 8. 功能验收标准

第一阶段验收按下面来：

1. 用户安装 FRKB 后，不额外安装 Python，也能看到并打开本机 Rekordbox 库。
2. 左侧会多出一个单独的“Rekordbox 本机库” icon。
3. 点击该 icon 后，能看到播放列表树。
4. 选中播放列表后，右侧能看到曲目列表。
5. 双击曲目可播放。
6. 有分析路径的曲目可显示预览波形。
7. 右键菜单里的复制、导出、复制到 Mixtape 行为与当前 U 盘库一致。
8. 不对 Rekordbox 本机库做任何写入。

## 9. 风险与阶段性妥协

## 9.1 数据库占用

如果 Rekordbox 正在运行，`master.db` 可能出现：

- 读取失败
- busy / locked
- WAL 相关一致性问题

第一阶段建议接受下面这个妥协：

- 先尝试只读打开
- 失败时给出明确提示：请关闭 Rekordbox 后重试

后续再评估是否补：

- 临时快照复制
- WAL/SHM 联动复制
- 更稳的只读快照方案

## 9.2 字段命名历史包袱

现有 `pioneer*` 字段已经渗进播放器和波形预览链路。

如果第一阶段完全不泛化：

- 本机库逻辑会一边叫 desktop，一边字段名还叫 pioneer/drive

这会让后面维护的人想掀桌子。

所以本草案建议：

- 第一阶段至少把关键状态和歌曲附加字段泛化
- 组件文件名可暂时保留，避免 diff 过大

## 9.3 打包体积

内置 Python runtime 会增加包体。

第一阶段建议接受，因为换来的是：

- 用户零安装
- 研发落地速度快
- 少踩 SQLCipher / Rekordbox key 解锁的底层坑

## 10. 推荐实施顺序

1. 先把运行时打包链路打通，确保 `pyrekordbox` helper 能随安装包启动。
2. 实现本机库 `probe`。
3. 在左侧加新 icon，但先只做点击后弹“未完成”或空结果确认 source 流转没问题。
4. 实现树读取。
5. 实现播放列表曲目读取。
6. 接入波形预览。
7. 接上现有复制 / 导出动作。
8. 最后再补文案分支和错误提示抛光。

## 11. 第一阶段建议触达文件

预计最核心会动到这些位置：

```text
src/main/ipc/
src/main/services/rekordboxDesktopLibrary/
src/types/globals.d.ts
src/renderer/src/stores/runtime.ts
src/renderer/src/pages/modules/librarySelectArea.vue
src/renderer/src/pages/modules/pioneerDeviceLibraryArea.vue
src/renderer/src/pages/modules/pioneerSongsArea.vue
src/renderer/src/pages/modules/songPlayer/useSongLoader.ts
src/renderer/src/pages/modules/songsArea/SongListRows/useWaveformPreview.ts
src/renderer/src/components/HorizontalBrowseWaveformOverview.vue
src/renderer/src/assets/
package.json
electron-builder.yml
```

## 12. 当前建议

当前最合理的做法不是先改 UI，而是先把下面三件事钉死：

1. 内置 Python runtime 的目录和打包策略
2. 本机库浏览状态字段如何泛化
3. helper 返回的数据格式要多贴近现有 U 盘 IPC

只要这三件事钉住，第一阶段后面的活基本就是机械施工，不至于写到一半发现架子塌了。
