# 旧 Device Library 只读支持草案

更新时间：2026-03-26

## 0. 当前定稿决策

本草案当前已经拍板的决策如下，后续讨论默认以此为准：

1. 本期只支持旧 `Device Library`，不包含 `Device Library Plus` / `OneLibrary`
2. 本期只做只读，不做写入、不做回写、不做修复
3. 本期读取范围只到：
   - 文件夹 / 播放列表树
   - 播放列表内歌曲
   - 歌曲基础信息
   - `BPM / Key`
   - Pioneer 设备波形预览
4. 本期不读取 cue / hot cue / memory cue / loop
5. 技术栈定为：
   - Electron Main / Node `fs` 负责目录选择、文件访问、路径探测
   - Rust N-API 负责 `export.pdb` / `ANLZ` 二进制解析
   - TypeScript Main Service 负责归一化、容错、日志和 IPC
   - Renderer 单独做 Pioneer 设备库预览 UI
6. 底层读取 PoC 首选 `rekordcrate`
7. Pioneer U 盘波形单独维护一套协议和渲染器，不改现有 `MixxxWaveformData`
8. 短期双波形栈并存，后续再评估是否统一

以下探索性路线，当前视为不采用：

- 运行时依赖 Python
- 第一版全局替换 `MixxxWaveformData`
- 第一版把外部设备库直接写入 FRKB 持久化树
- 第一版兼容 `Device Library Plus`

## 1. 目标

本草案只讨论旧 `Device Library` 的读取支持，不包含：

- `Device Library Plus`
- `OneLibrary`
- 对 U 盘库的写入、修复、回写
- Cue 点、Hot Cue、Memory Cue、Loop、History 等非本期必需数据

第一阶段目标很明确：

- 识别旧 Pioneer / rekordbox 导出的 U 盘库
- 读取文件夹树 / 播放列表树
- 读取列表内歌曲
- 读取歌曲基础信息
- 读取歌曲的 `BPM / Key`
- 尽量读取歌曲波形

第一阶段不要求：

- 波形和 CDJ 设备显示完全一模一样
- 支持所有 ANLZ 标签
- 写回任何数据到 U 盘

## 2. 结论先说

按当前公开资料和社区逆向成果，旧 `Device Library` 的只读支持是可做的，而且把握比较高。

原因：

- 旧库的主数据库 `PIONEER/rekordbox/export.pdb` 已有较成熟的社区逆向资料
- 分析文件 `PIONEER/USBANLZ/*` 的结构也有现成资料和解析实现
- 我们当前需求只读取 `列表 / 歌曲 / 元数据 / BPM / Key / 波形`，不碰 cue 类数据，复杂度明显下降

一句人话总结：

- 旧 `Device Library`：现有资料足够支撑只读导入实现
- `Device Library Plus / OneLibrary`：公开资料还不够稳，不纳入本期

## 3. 本期范围定义

### 3.1 输入

用户选择一个 U 盘根目录或导出目录根目录。

第一版只识别旧 `Device Library`，判定条件至少包含：

- 存在 `PIONEER/rekordbox/export.pdb`

可选辅助判定：

- 存在 `PIONEER/USBANLZ`
- 存在 `PIONEER` 根目录

### 3.2 输出

FRKB 内部需要拿到一份统一的只读中间模型，至少包含：

- 设备库根信息
- 文件夹 / 播放列表树
- 歌曲清单
- 播放列表与歌曲的关联
- 歌曲基础信息
- 歌曲 `BPM / Key`
- 歌曲波形预览数据

### 3.3 明确排除

- 不读取 cue / hot cue / memory cue / saved loop
- 不做设备设置文件读取
- 不做历史播放记录读取
- 不修改 `export.pdb`
- 不修改 `USBANLZ`
- 不尝试“修复”损坏的导出盘

## 4. 外部资料整理

### 4.1 核心资料

0. 官方术语区分资料
   - https://support.pioneerdj.com/hc/en-us/articles/16290620247321-What-is-Device-Library-Plus
   - https://support.pioneerdj.com/hc/en-us/articles/26689155007641-Can-I-convert-USB-libraries-I-ve-been-using-into-Device-Library-Plus
   - 价值：明确 `Device Library Plus` 是新格式，和本草案讨论的传统 `Device Library` 不是一回事

1. Deep Symmetry 的旧 rekordbox 导出逆向文档
   - https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html
   - 价值：说明旧导出结构、`export.pdb`、`exportExt.pdb`、分析文件位置与核心概念

2. Deep Symmetry / pyrekordbox 的 ANLZ 资料
   - https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html
   - https://pyrekordbox.readthedocs.io/en/stable/formats/anlz.html
   - 价值：说明 `.DAT/.EXT/.2EX` 的标签结构、波形、beat grid、cue 等 section

3. `rekordcrate`
   - https://github.com/Holzhaus/rekordcrate
   - https://holzhaus.github.io/rekordcrate/rekordcrate/pdb/index.html
   - https://holzhaus.github.io/rekordcrate/rekordcrate/anlz/index.html
   - 价值：Rust 生态下对旧 `Device Library` 的现成解析参考，和我们现有 `rust_package` 架构最贴

4. `pyrekordbox`
   - https://github.com/dylanljones/pyrekordbox
   - https://pyrekordbox.readthedocs.io/en/latest/
   - 价值：适合做样本校验，尤其是 ANLZ 读取结果交叉验证

### 4.2 已确认的关键信息

- 旧 `Device Library` 的主库文件是 `PIONEER/rekordbox/export.pdb`
- 分析数据位于 `PIONEER/USBANLZ/...`
- `ANLZ` 文件扩展名通常是 `.DAT`、`.EXT`、`.2EX`
- `export.pdb` 中包含歌曲、调性、播放列表树、播放列表项等核心关系
- `ANLZ` 中包含波形、beat grid、cue 列表等更细节的分析数据

### 4.3 需要保持谨慎的点

- 不同 rekordbox 版本导出的细节可能有差异
- 不同设备代际对某些分析标签的使用可能不完全一致
- 高分彩色波形相关标签并非所有社区实现都完整覆盖
- `exportExt.pdb` 可能存在，但第一版不强依赖

## 5. 旧 Device Library 结构理解

本期只关注下面这些文件：

```text
<USB_ROOT>/
  PIONEER/
    rekordbox/
      export.pdb
      exportExt.pdb        # 可选，第一版不强依赖
    USBANLZ/
      .../
        ANLZ0000.DAT
        ANLZ0000.EXT
        ANLZ0000.2EX
```

### 5.1 `export.pdb`

职责：

- 歌曲主索引
- 播放列表树 / 文件夹树
- 播放列表项映射
- 艺人、专辑、调性等关联数据

本期最关心的读取结果：

- Track 列表
- Playlist / Folder 树
- Playlist Entry 映射
- Key 表
- 歌曲到分析文件的定位信息

### 5.2 `USBANLZ`

职责：

- 波形
- Beat Grid
- Cue / Hot Cue / Loop
- 若干设备显示相关的分析数据

本期最关心的读取结果：

- 波形预览
- 必要时补充 beat 相关的定位信息

本期明确忽略：

- Cue 列表
- Loop
- 其他与“导入歌曲本身信息”无直接关系的数据

## 6. FRKB 现状与可复用点

当前仓库已经有不少能直接复用的基础设施，不需要重新造轮子。

### 6.1 Rust 原生能力

现有 `rust_package` 已经负责音频解码、BPM/Key 分析、波形生成等能力：

- `rust_package/src/lib.rs`
- `rust_package/src/mixxx_waveform.rs`

这意味着旧 Device Library 的解析也很适合继续走 `Rust + N-API`。

理由：

- 二进制格式解析更适合 Rust
- 已经有原生模块基础，不用额外引入 Python 运行时
- 后续如果需要读取大量 U 盘样本，性能和错误控制更稳

### 6.2 FRKB 内部缓存与波形结构

现有缓存层已经有歌曲缓存和波形缓存：

- `src/main/libraryCacheDb.ts`
- `src/main/libraryCacheDb/songCache.ts`
- `src/main/waveformCache.ts`

其中 `MixxxWaveformData` 是项目现有原生波形协议，后续如果要统一波形协议，它会是重要参考对象。

但这里有个必须提前说清楚的坑：

- 当前 `MixxxWaveformData` 不是单一振幅数组，而是 `low / mid / high / all` 四组 band 数据
- Pioneer 设备波形与 FRKB 当前波形结构不保证天然一一对应

所以第一版不要先假设“读出来就能无损塞进去”，而应该保留一层波形适配逻辑。

### 6.3 树结构与歌曲扫描能力

现有树结构与扫描能力：

- `src/main/libraryTreeDb.ts`
- `src/main/services/scanSongs.ts`
- `src/main/window/mainWindow/importHandlers.ts`

但要注意：

- 现有导入流程偏“复制音频文件到 FRKB 管理目录，再扫描元数据”
- 旧 Device Library 读取更像“读取外部设备库，再映射成 FRKB 内部视图或导入对象”

所以第一版不建议硬塞进现有 `startImportSongs` 流程，而应该单独做一条“读取 Pioneer 设备库”的链路。

## 7. 推荐技术路线

### 7.1 总体思路

推荐分三层：

1. Rust 解析层
2. Main Process 归一化层
3. Renderer 展示 / 导入层

### 7.1.1 Rust 解析层

职责：

- 判定目录是否为旧 `Device Library`
- 读取 `export.pdb`
- 读取必要的 `ANLZ`
- 输出最小只读模型

推荐新增模块：

```text
rust_package/src/pioneer_device_library/
  mod.rs
  model.rs
  pdb.rs
  anlz.rs
  detect.rs
```

推荐新增导出函数：

- `inspect_pioneer_device_library(root_path)`
- `read_pioneer_device_library(root_path, options)`

建议 `options` 至少包含：

- `includeWaveform: boolean`
- `includeBeatgrid: boolean`，第一版可默认 `false`

### 7.1.2 Main Process 归一化层

职责：

- 调用 Rust N-API
- 将 Pioneer 只读模型转成 FRKB 内部统一模型
- 处理缺省值、容错、日志、路径归一化

推荐新增目录：

```text
src/main/services/pioneerDeviceLibrary/
  detect.ts
  normalize.ts
  importPreview.ts
  waveform.ts
  types.ts
```

建议职责：

- `detect.ts`: 判断目录是否是旧 Device Library
- `normalize.ts`: 归一化播放列表树、歌曲信息、路径
- `importPreview.ts`: 生成给前端预览的导入结果
- `waveform.ts`: 处理波形映射和回退策略
- `types.ts`: 定义 TS 中间类型

### 7.1.3 IPC 与前端层

推荐新增：

```text
src/main/ipc/pioneerDeviceLibraryHandlers.ts
```

建议暴露的 IPC：

- `pioneer-device-library:detect`
- `pioneer-device-library:preview`

第一版先只做“预览读取”，不要一开始就做“导入并落库”。

### 7.2 最终技术栈决策

本项目对旧 `Device Library` 的读取技术栈正式定为：

1. 文件访问层：Electron Main + Node `fs`
2. 格式解析层：Rust N-API
3. 归一化与业务层：TypeScript Main Services
4. 展示层：Renderer 独立预览界面

#### 7.2.1 文件访问层

职责：

- 让用户选择 U 盘根目录或导出目录
- 检查 `PIONEER/rekordbox/export.pdb` 是否存在
- 枚举 `USBANLZ` 目录
- 提供绝对路径给 Rust 解析层

不负责：

- 二进制解析
- 波形解码
- 数据库结构推断

#### 7.2.2 格式解析层

职责：

- 解析 `export.pdb`
- 解析 `ANLZ`
- 输出结构化只读结果

正式结论：

- 二进制解析不放在 TS 里硬啃
- 运行时不依赖 Python
- 以 `rust_package` 为唯一正式解析入口

#### 7.2.3 归一化层

职责：

- 把 Rust 输出转换成 FRKB 内部预览模型
- 统一歌曲字段、列表树字段、波形字段
- 处理缺失值、兼容差异、错误提示

#### 7.2.4 展示层

职责：

- 单独展示 Pioneer 设备库树
- 单独展示 Pioneer 列表歌曲
- 单独展示 Pioneer 波形

正式结论：

- 第一版不混进 FRKB 原生曲库 UI 语义
- 第一版不混进 FRKB 持久化树结构

### 7.3 `rekordcrate` 的最终定位

推荐结论：

- `rekordcrate` 作为旧 `Device Library` 读取的 PoC 首选底层库
- 在样本验证通过前，不把它视为“已经锁死的最终依赖”
- 若正式接入，必须做版本锁定和封装隔离

理由：

- `rekordcrate` 就是为旧 Pioneer 设备导出解析准备的 Rust 库
- 文档明确覆盖 `export.pdb` 和 `ANLZ`
- 和 FRKB 当前 `rust_package` 技术栈天然匹配

需要注意：

- `rekordcrate` 文档写了“仍在积极开发，未来可能有 breaking changes”
- 许可证是 `MPL-2.0`，理论上与当前项目的 `GPL-2.0-or-later` 方向并非明显冲突，但正式 vendoring / 复制源码前仍应复核

正式接入要求：

1. 用我们自己的 U 盘样本验证：
   - 列表树
   - 歌曲基础信息
   - `BPM / Key`
   - `analysisPath`
   - `PWAV / PWV2` 波形
2. 在 `rust_package` 内部包一层 FRKB 自己的接口
3. 不把 `rekordcrate` 的原始类型直接扩散到 TypeScript 侧
4. 锁定依赖版本

替代策略：

- 如果 `rekordcrate` 依赖过重、API 不稳、读取覆盖不足，就保留“按已验证结构自己实现最小 parser”的退路

### 7.4 是否在运行时依赖 Python

不推荐。

原因：

- 项目当前主链是 Electron + Rust，不是 Python 桌面栈
- 增加 Python 运行时只会让打包、依赖、跨平台更脏
- `pyrekordbox` 更适合作为开发期样本校验工具，而不是应用运行时依赖

## 8. 数据范围设计

推荐先定义一套 FRKB 内部中间模型，避免后面逻辑被 Pioneer 格式绑死。

```ts
type PioneerDeviceLibraryPreview = {
  sourceRoot: string
  detected: boolean
  playlists: PioneerPlaylistNode[]
  tracks: PioneerTrack[]
}

type PioneerPlaylistNode = {
  id: string
  parentId: string | null
  name: string
  type: 'folder' | 'playlist'
  order: number
  trackIds?: string[]
}

type PioneerTrack = {
  id: string
  filePath: string
  fileName: string
  title?: string
  artist?: string
  album?: string
  genre?: string
  label?: string
  durationSec?: number
  bpm?: number
  key?: string
  analysisPath?: string | null
  waveform?: MixxxWaveformData | null
}
```

字段说明：

- `bpm` / `key` 优先从旧库直接读取
- `waveform` 优先从 `ANLZ` 读取
- `analysisPath` 用于调试、补充解析、错误定位

### 8.1 `export.pdb` 第一版字段清单

第一版建议严格控制字段范围，只读取“当前需求直接需要”的字段。

#### 8.1.1 Track 必读字段

建议第一版至少读取下列信息：

- `trackId`
- `title`
- `artist`
- `album`
- `genre`
- `label`
- `durationSec`
- `bpm`
- `key`
- `filePath`
- `fileName`
- `fileFormat`
- `analysisPath`

这些字段足够覆盖：

- 列表展示
- 基础搜索
- 歌曲详情预览
- 波形定位
- 后续导入 FRKB 的最小元数据映射

#### 8.1.2 Track 选读字段

这些字段不是第一版必须，但建议在 parser 设计时预留位置：

- `artworkId` 或封面引用
- `comment`
- `bitrate`
- `sampleRate`
- `playCount`
- `rating`

处理建议：

- 第一版不需要在 UI 暴露
- 但如果上游解析库能低成本拿到，可以先放进内部调试结构

#### 8.1.3 Track 明确不读字段

- cue 相关字段
- memory cue / hot cue / loop
- history / history playlist
- MyTag / rating color 等设备侧非本期必需信息

#### 8.1.4 `export.pdb -> FRKB ISongInfo` 映射建议

建议第一版映射关系如下：

```text
Pioneer Track.id              -> 外部 trackId，不直接复用为 FRKB uuid
Pioneer Track.path/name       -> ISongInfo.filePath / fileName
Pioneer Track file extension  -> ISongInfo.fileFormat
Pioneer title                 -> ISongInfo.title
Pioneer artist                -> ISongInfo.artist
Pioneer album                 -> ISongInfo.album
Pioneer genre                 -> ISongInfo.genre
Pioneer label                 -> ISongInfo.label
Pioneer duration             -> ISongInfo.duration / durationSec 辅助字段
Pioneer tempo(BPM*100)        -> ISongInfo.bpm
Pioneer key / key_id          -> ISongInfo.key
```

注意：

- 社区资料里常见 `tempo` 为 `BPM * 100`
- 调性通常通过 `key_id` 关联 `Key` 表解析
- 精确字段名以最终选定的 parser 实现为准，草案阶段先锁“语义字段”，不要先绑死某个库的命名

### 8.2 播放列表树到 FRKB 的映射建议

先说结论：

- 预览阶段，不要直接映射进 FRKB 持久化树
- 预览阶段保持“外部设备树”自己的节点语义最稳
- 真正导入时，再映射到 FRKB 的 `library / dir / songList`

#### 8.2.1 预览阶段推荐模型

预览阶段建议只保留两类节点：

- `folder`
- `playlist`

原因：

- Pioneer 设备树本质上就是这两层语义
- 不必为了兼容 FRKB 持久化树，过早塞进 `library / dir / songList`
- 这样前端做只读浏览最直观

#### 8.2.2 真正导入时的映射

如果后续决定把外部设备库导入 FRKB 持久化树，建议映射为：

```text
Pioneer device root   -> FRKB 一个独立 library 节点
Pioneer folder        -> FRKB dir
Pioneer playlist      -> FRKB songList
```

推荐导入后的顶层名字：

- `Pioneer Device Library`
- 或带设备卷标的名字，例如 `Pioneer Device Library (USB_NAME)`

#### 8.2.3 为什么不直接映射为 FRKB 根树

原因很实际：

- FRKB 当前根树结构有自己的产品语义
- 外部设备库是“只读来源”，不是 FRKB 自己维护的原生库
- 如果第一版就直接落持久化树，后面撤回、刷新、重扫都会变脏

所以第一版建议：

- 只做“外部设备库预览”
- 不写入 `library_nodes`
- 不生成 `.frkb.uuid`
- 不把 U 盘内容伪装成 FRKB 原生歌单

### 8.3 波形第一版目标

波形这块必须收住，别一上来给自己挖坑。

#### 8.3.1 第一期真正目标

第一期波形只要求做到：

- 大部分可读歌曲能显示稳定的概览波形
- 波形长度和歌曲时长基本对应
- 在列表预览或播放器预览里可用

第一期不要求：

- 完全复刻 CDJ 的彩色显示效果
- 完全复刻设备侧所有波形层级
- 支持所有高阶 ANLZ 标签

#### 8.3.2 波形来源优先级

建议优先级如下：

1. 旧 `ANLZ` 中最稳定、最普遍的概览波形数据
2. 若同曲存在多个波形层级，优先选最容易稳定解析的版本
3. 高阶彩色 / 高分辨率波形放到后续阶段

#### 8.3.3 与现有 `MixxxWaveformData` 的适配建议

当前项目前后端大量逻辑默认波形结构是：

- `low`
- `mid`
- `high`
- `all`

而 Pioneer 波形不一定天然提供同样的四频段表达。

但经过进一步讨论，第一版不采用“强行适配到 `MixxxWaveformData`”的路线。

当前正式决策改为：

- 单独为 Pioneer U 盘库维护一套独立波形协议
- 这套波形协议只服务于旧 `Device Library` 读取链路
- 不修改现有 `MixxxWaveformData`
- 不让 U 盘库波形直接侵入 FRKB 原有播放器 / mixtape 波形协议

原因：

- 当前项目里 `MixxxWaveformData` 已有大量引用，且很多逻辑直接写死了 `low / mid / high / all`
- 如果第一版就全局替换，会把播放器、列表、mixtape、缓存编码一起拖下水
- U 盘库波形当前需求只服务“外部设备库预览”，没必要一开始就改项目底层公共协议

所以第一版推荐策略改为：

- 在 `src/main/services/pioneerDeviceLibrary/waveform.ts` 维护独立的 Pioneer 波形处理逻辑
- 在前端新增只给 U 盘库使用的单独渲染逻辑
- 现有 FRKB 波形链继续使用 `MixxxWaveformData`
- 等 Pioneer 波形链路稳定后，再评估是否与现有协议靠拢

#### 8.3.4 Pioneer 专用波形协议建议

建议新增一套只服务旧 `Device Library` 的专用波形结构，例如：

```ts
type PioneerPreviewWaveformData = {
  source: 'PWAV' | 'PWV2'
  duration: number
  step: number
  left: Uint8Array
  right: Uint8Array
}
```

第一版先故意收敛到最小必要字段：

- `source`: 标记来自哪类 ANLZ 波形段
- `duration`: 波形对应歌曲时长
- `step`: 每个采样点代表的时间跨度
- `left / right`: 左右声道概览振幅

第一版不额外塞：

- 颜色信息
- 四频段数据
- cue 叠加信息
- beat grid 叠加信息

这样做的好处：

- Rust 解析层更容易稳定
- 前端渲染器更容易单独实现
- 后续要扩展字段时不会和现有波形协议互相污染

#### 8.3.5 前端展示策略

第一版 Pioneer 波形展示策略定为：

- 单独写一套渲染器
- 单独写一套类型
- 单独走一条 IPC
- 只给 U 盘库使用

不做的事：

- 不复用现有 `MixxxWaveformData` 的渲染算法
- 不把 Pioneer 波形塞进现有歌曲列表波形缓存协议
- 不让 mixtape 等高级模块直接消费 Pioneer 波形

建议的新增落点：

```text
src/main/services/pioneerDeviceLibrary/waveform.ts
src/main/ipc/pioneerDeviceLibraryHandlers.ts
src/renderer/src/components/pioneerDeviceLibrary/
  PioneerWaveformCanvas.vue
src/renderer/src/composables/pioneerDeviceLibrary/
  usePioneerWaveform.ts
  types.ts
```

#### 8.3.6 中长期策略

短期正式策略：

- 双波形栈并存
- `FRKB 原生波形` 与 `Pioneer U 盘波形` 分开维护

中长期再评估：

- 是否抽象出统一的预览波形协议
- 是否让播放器同时接受多种波形源
- 是否逐步淘汰 `MixxxWaveformData` 的前端强耦合

#### 8.3.7 UI 标记建议

既然第一版采用独立 Pioneer 波形协议，UI 和内部状态都应明确标记波形来源，例如：

- `pioneer-usb-waveform`
- `frkb-generated-waveform`

这样后续排查显示差异时不会一头雾水。

## 9. 推荐分阶段实现计划

### 9.1 第一阶段：样本与探测

目标：

- 在本地准备至少 3 套旧 Device Library 样本
- 写一个最小探测器，能判断路径是否为旧库

任务：

- 收集不同 rekordbox / 设备导出的样本
- 覆盖中文路径、英文路径、深层列表、空列表
- 做 `detect` 原型

验收：

- 给定任意目录，能明确返回“是旧 Device Library / 不是”

### 9.2 第二阶段：主库读取

目标：

- 先只读 `export.pdb`

任务：

- 读取 Track 基础信息
- 读取 Key 表并映射到歌曲
- 读取播放列表树
- 读取播放列表项
- 组装成只读中间模型

验收：

- 能列出文件夹 / 列表 / 歌曲
- 能看到歌曲 `title / artist / album / bpm / key`

### 9.3 第三阶段：波形读取

目标：

- 接入 `ANLZ` 波形

任务：

- 从 Track 中拿到分析文件路径
- 读取 `.DAT/.EXT/.2EX` 中与波形相关的 section
- 映射到 `MixxxWaveformData`
- 若高阶波形读取失败，保留回退路径

验收：

- 至少能显示一版稳定的波形预览
- 波形缺失时不影响列表和歌曲信息读取

### 9.4 第四阶段：UI 预览与导入对接

目标：

- 在 FRKB 内提供只读预览

任务：

- 选择导出盘目录
- 展示设备库树
- 展示列表内歌曲
- 展示歌曲 `BPM / Key / 波形`

第一版建议：

- 先做“只读预览窗口 / 对话框”
- 暂不把外部设备库直接混入 FRKB 主库结构

## 10. 波形策略

本期推荐策略非常务实：

- 能从 `ANLZ` 读到波形就直接用
- 读不到就显示“无设备波形”
- 不要在第一版偷偷回退成重新解码音频生成波形，避免用户误以为这是设备原始分析结果

如果后续产品上希望“始终有波形”：

- 可以额外提供“使用 FRKB 重新生成波形”的降级逻辑
- 但 UI 上必须标记来源，区分“设备原波形”和“FRKB 重建波形”

## 11. 风险清单

### 11.1 样本不足

这是最大风险。

如果只拿一两个 U 盘样本就开写，后面很容易被不同 rekordbox 版本、不同设备代际打脸。

### 11.2 `ANLZ` 标签覆盖不完整

社区资料已经很成熟，但不是所有标签都完全吃透。

已知 `pyrekordbox` 公开写过部分 ANLZ 标签仍未完全支持，例如：

- `PWV6`
- `PWV7`
- `PWVC`

这意味着：

- 第一版波形可以做
- 但不要承诺“所有设备、所有波形样式完全一致”

### 11.3 路径编码与跨平台

U 盘导出路径可能涉及：

- Windows 盘符差异
- 大小写差异
- 中文 / 日文 / 特殊字符

这部分必须在样本验证阶段就重点覆盖。

### 11.4 许可证与依赖稳定性

如果直接依赖 `rekordcrate`：

- 需要复核许可证和项目 API 稳定性
- 需要锁版本，避免上游 breaking change 直接把构建干碎

## 12. 建议的首批实现任务

建议按下面顺序拆工单：

1. 用 `rekordcrate` 做旧 Device Library 读取 PoC
2. 起草 TS / Rust 中间模型
3. 做旧 Device Library 探测器
4. 打通 `export.pdb` 的 Track / Playlist 只读解析
5. 把读取结果通过 IPC 暴露给前端
6. 做只读预览界面
7. 再补 `ANLZ` 波形读取

不建议的顺序：

- 一上来就接 UI
- 一上来就想做导入落库
- 一上来就想兼容 `Device Library Plus`

## 13. 建议的本仓库落点

推荐后续代码大致落在这里：

```text
rust_package/src/pioneer_device_library/
src/main/services/pioneerDeviceLibrary/
src/main/ipc/pioneerDeviceLibraryHandlers.ts
src/renderer/src/components/ 或 src/renderer/src/pages/
```

和现有模块的关系：

- 原生解析：沿用 `rust_package`
- 波形落点：复用 `src/main/waveformCache.ts`
- 树结构映射：参考 `src/main/libraryTreeDb.ts`
- UI 导入前预览：新开链路，不硬塞进 `src/main/window/mainWindow/importHandlers.ts`

## 14. 当前建议

下一步最值得做的不是写代码，而是先把下面三件事锤实：

1. 样本清单
2. 中间模型字段清单
3. `export.pdb` 最小读取范围

建议下一轮细化时优先讨论：

- Track 需要哪些字段
- Playlist / Folder 树如何映射到 FRKB
- 波形第一版到底要不要进 UI

## 15. 附：本草案引用的关键来源

- AlphaTheta / Pioneer 旧导出格式无公开官方 schema，本草案主要依据社区逆向成果
- 官方术语区分：
  - https://support.pioneerdj.com/hc/en-us/articles/16290620247321-What-is-Device-Library-Plus
  - https://support.pioneerdj.com/hc/en-us/articles/26689155007641-Can-I-convert-USB-libraries-I-ve-been-using-into-Device-Library-Plus
- Deep Symmetry 旧导出结构说明：
  - https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html
- Deep Symmetry / pyrekordbox ANLZ 结构说明：
  - https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html
  - https://pyrekordbox.readthedocs.io/en/stable/formats/anlz.html
- Rust 解析参考 `rekordcrate`：
  - https://github.com/Holzhaus/rekordcrate
  - https://holzhaus.github.io/rekordcrate/rekordcrate/pdb/index.html
  - https://holzhaus.github.io/rekordcrate/rekordcrate/anlz/index.html
- Python 校验参考 `pyrekordbox`：
  - https://github.com/dylanljones/pyrekordbox
  - https://pyrekordbox.readthedocs.io/en/latest/
