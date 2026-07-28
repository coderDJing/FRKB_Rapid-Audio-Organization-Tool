# Rekordbox 外部库只读分析结果接入草案

## 文档状态

- 状态：代码实施完成；待真实 Pioneer U 盘与 Rekordbox Desktop 库人工验收（见第 17 节）
- 适用范围：FRKB 中的 Pioneer U 盘库与 Rekordbox Desktop 库
- 核心主题：Rekordbox 是外部库分析数据的唯一权威来源，FRKB 不持久缓存其分析结果
- 本文不包含提交或发布安排；数据库迁移仅限本需求规定的旧外部缓存静默清理

## 1. 背景

FRKB 当前可以浏览 Pioneer U 盘库与 Rekordbox Desktop 库，并已经能够读取部分
Rekordbox 数据，例如 BPM、Key、Cue、Loop 和概览波形。

现有实现同时还存在另一条 FRKB 外部歌曲分析链路：外部库歌曲可能被加入 FRKB
分析队列，生成 FRKB 自己的 Key、能量、网格和波形缓存；部分波形组件也可能优先
读取按文件路径命中的 FRKB 波形缓存，再尝试读取 Rekordbox 波形。

这会造成外部库页面展示的数据来源不纯：用户无法确定当前看到的是 Rekordbox
结果，还是 FRKB 对同一个音频文件重新分析后的结果。

本草案要求彻底消除这种混合。

## 2. 核心需求

在 Pioneer U 盘库和 Rekordbox Desktop 库中：

> FRKB 只读取、播放和渲染 Rekordbox 当前已有数据。Rekordbox 是 BPM、Key、
> 波形、节拍网格、Cue 和 Loop 等外部库分析数据的唯一权威来源。FRKB 不得在该
> 场景运行自己的分析，不得用 FRKB 缓存补全或覆盖 Rekordbox 数据，也不得提供
> 修改这些数据的能力；同时不得把 Rekordbox 分析结果持久缓存到 FRKB 数据库、
> 文件或跨会话内存缓存中。

这一要求必须作为底层数据边界实现，不能只靠隐藏几个 UI 按钮完成。

## 3. 术语

### 3.1 外部 Rekordbox 来源

本文所称外部 Rekordbox 来源包括：

- Pioneer U 盘 Device Library；
- Pioneer U 盘 OneLibrary；
- Rekordbox Desktop 本机资料库；
- 上述来源关联的 `export.pdb`、`exportLibrary.db`、ANLZ DAT/EXT/2EX 等数据。

### 3.2 Rekordbox 原始结果

由 Rekordbox 写入数据库或 ANLZ 文件的数据，包括但不限于：

- 曲目元数据、BPM、Key；
- 概览波形；
- 细节大波形；
- 完整节拍网格及动态 BPM 信息；
- Hot Cue、Memory Cue、Loop；
- Artwork 与分析文件定位信息。

### 3.3 临时运行时数据

FRKB 在当前读取请求或当前组件生命周期内，为完成渲染而临时保存的已解析对象。

临时运行时数据只允许存在于内存中，不能写入数据库或磁盘，不能跨资料库刷新、
来源切换、U 盘重新插拔或应用重启继续复用。来源失效后必须立即丢弃。

### 3.4 FRKB 分析结果

由 FRKB 自己对音频执行算法后产生的数据，包括但不限于：

- FRKB BPM、Key 和节拍网格；
- FRKB 概览波形、细节波形或 raw waveform；
- 能量、段落、相似度、指纹、Stem 等分析结果；
- 为上述结果建立的 `song_cache` 或 `external_analysis_cache` 数据。

## 4. 不可破坏的产品边界

### 4.1 Rekordbox 是唯一分析权威

外部库曲目的所有可展示分析数据必须来自当前 Rekordbox 来源。

禁止因为同一个文件路径在 FRKB 本地库中已有分析缓存，就在外部库页面复用该缓存。
数据权威由当前浏览来源决定，不能只按文件路径决定。

每次重新进入歌单、刷新资料库或重新打开曲目时，必须从当前 Rekordbox 数据库和
ANLZ 文件重新读取。禁止用之前保存的解析结果代替当前来源。

### 4.2 外部库严格只读

FRKB 不得通过外部库页面修改：

- BPM；
- Key；
- 节拍网格位置、BPM clip 或 downbeat；
- Hot Cue、Memory Cue、Loop；
- Rekordbox 波形数据；
- Rekordbox 数据库或 ANLZ 文件。

不仅要隐藏编辑入口，底层写入 IPC 和服务也必须拒绝该来源的修改请求。

### 4.3 禁止 FRKB 分析回退

Rekordbox 未提供某项数据、数据损坏或当前版本暂不支持解析时：

- 显示为空、不可用或“Rekordbox 未提供”；
- 可以显示明确的只读解析错误；
- 不得自动运行 FRKB 分析；
- 不得读取 FRKB 历史缓存进行补全；
- 不得用文件标签、FFmpeg 探测值或其他来源伪装成 Rekordbox 分析结果。

### 4.4 解析和渲染不等于分析

下列操作允许执行：

- 读取 Rekordbox 数据库和 ANLZ 文件；
- 解码 ANLZ 波形二进制；
- 将 Rekordbox 波形转换为 Canvas 可绘制数据；
- 将 Rekordbox 网格转换为只读运行时绘制数据；
- 在当前请求或当前组件生命周期内临时持有上述解析结果；
- 解码原音频用于播放；
- 在不改变原始数据的前提下进行播放时间轴坐标映射。

这些操作不能生成新的 BPM、Key、拍点或波形内容。

## 5. 数据来源矩阵

| 能力 | 唯一允许来源 | Rekordbox 缺失时 | 是否允许修改 |
| --- | --- | --- | --- |
| BPM | Rekordbox 数据库或完整网格 | 显示为空 | 否 |
| Key | Rekordbox Key 数据 | 显示为空 | 否 |
| 概览波形 | Rekordbox ANLZ 概览波形 | 显示空波形状态 | 否 |
| 细节大波形 | Rekordbox ANLZ 细节波形 | 显示不可用 | 否 |
| 节拍网格 | Rekordbox ANLZ 完整网格 | 不显示网格 | 否 |
| 动态 BPM | Rekordbox 每拍或分段数据 | 不推测固定 BPM 网格 | 否 |
| Hot Cue | Rekordbox ANLZ | 显示为空 | 否 |
| Memory Cue | Rekordbox ANLZ | 显示为空 | 否 |
| Loop | Rekordbox ANLZ | 显示为空 | 否 |
| Artwork | Rekordbox 数据库关联资源 | 使用无封面状态 | 否 |
| 音频播放 | 外部库指向的原音频文件 | 显示文件缺失 | 不修改源文件 |
| 能量、段落、指纹、Stem | 外部库场景不提供 | 不显示、不分析 | 否 |

## 6. 波形要求

### 6.1 概览波形

- U 盘库和 Rekordbox Desktop 库必须只显示 Rekordbox 概览波形；
- 禁止先查询 FRKB `globalOverview`、`compactVisualWaveformData` 或其他本地波形缓存；
- 即使按文件路径命中了 FRKB 本地库波形，也必须忽略；
- Rekordbox 概览波形缺失时保持空状态，不生成 FRKB 波形。

### 6.2 细节大波形

- 大波形必须直接来自 Rekordbox ANLZ 细节波形；
- 应覆盖当前资料中已确认存在的 PWV3、PWV5、PWV6、PWV7 等结构；
- 具体选用哪一层波形，应由来源实际包含的数据和设备版本决定；
- 同一曲目同时存在 `PWV5` RGB 与 `PWV7` 三频细节数据时，优先使用 Rekordbox RGB
  细节波形 `PWV5`；仅在 RGB 缺失时使用 `PWV7`；
- 不得为提高放大细节而读取 PCM 重新生成 FRKB raw waveform；
- PWV3/PWV5 的原始高度是 Rekordbox 量化高度，不得按 PCM 振幅再套 gamma、noise gate、
  attack/release、能量包络、FRKB 高度模型或动态频段塑形；仅允许按原始量程直接绘制，
  因而无鼓点的 break 也必须保留其 Rekordbox 原有的低高度；
- 超过 Rekordbox 原始波形分辨率的放大仅允许插值或保持现有分辨率，不得伪造新细节；
- Rekordbox ANLZ 缺少细节大波形时，大波形区域必须明确显示“Rekordbox 未提供细节
  波形”；
- 不得放大概览波形冒充细节大波形；
- 当前运行时对象必须携带 Rekordbox 来源、ANLZ 路径和来源签名，供过期请求校验；
- 离开曲目、切换来源或刷新资料库后，已解析波形必须丢弃并重新读取。

### 6.3 播放解码边界

FRKB 仍需解码音频才能播放。音频解码只服务于播放，不得在后台顺带生成 FRKB
波形、网格、Key、BPM、能量或段落结果。

如果某种音频格式必须走 PCM 解码路径，返回给 Renderer 的播放数据不得夹带 FRKB
生成的波形作为外部库显示来源。

## 7. 节拍网格要求

### 7.1 完整读取

- 不能只读取歌级 BPM；
- 不能只读取 `PQTZ` 第一条并转换成 `firstBeatMs`；
- 必须保留每拍时间、每拍 BPM、1 至 4 拍标签及可用的扩展网格信息；
- 动态 BPM 曲目必须按 Rekordbox 原始网格显示，禁止降级为 FRKB 推测的固定网格；
- 数据不完整时不生成替代网格。
- 为绘制而临时合并出的 tempo clip 不是 Rekordbox 可见标记；外部只读库不得把它们画成
  FRKB 的橙色 clip-boundary，只显示 Rekordbox 的拍线与其本身提供的 Cue / Loop。

### 7.1.1 PQTZ 逐拍消费规则

PQTZ 的每条记录都是外部库节拍网格的权威拍点。外部来源加载后，FRKB 必须将当前请求
读取到的原始 `timeMs`、`bpm`、`beatNumber` 直接传递给波形渲染和 native Beat Sync：

- 大波形按每条 `timeMs` 直接画拍线；`beatNumber === 1` 画小节主线，其余画普通拍线；
- Beat Sync 以原始拍点在相邻两拍之间插值计算当前拍位，并按同一拍点序列反查目标拍的
  时间；不得再用 `bpm` 外推的 tempo clip 作为外部曲目的同步真值；
- tempo clip 可以作为 FRKB 自有曲目或旧组件的内部兼容结构存在，但外部 Rekordbox 来源
  不得向渲染器或 native Beat Sync 传递它；
- 原始拍点只保存在当前外部资料库读取结果和当前播放器生命周期内，来源刷新、切歌、拔盘
  或重启后必须重新读取，不得持久化。

这样动态 BPM 曲目的波形白线和 Beat Sync 读取的是同一份 Rekordbox 真值；PQTZ 中因
毫秒量化、节拍微调或变速导致的相邻拍间距变化不会再被 FRKB 的连续等速假设重写。

### 7.2 独立只读模型

Rekordbox 网格不应直接写入 FRKB canonical `song_cache`，不得写入任何持久缓存，
也不得作为可编辑 `SongBeatGridMap v2` 持久化。

建议建立独立只读结构，例如：

```ts
type RekordboxReadOnlyBeatGrid = {
  authority: 'rekordbox'
  entries: Array<{
    timeMs: number
    bpm: number
    beatNumber: 1 | 2 | 3 | 4
  }>
  sourceAnalyzePath: string
  sourceSignature: string
}
```

Renderer 和播放组件可以通过只读适配器消费该结构，但不能调用 FRKB 网格保存、
移动、拆分 clip 或修改 downbeat 的逻辑。

外部库允许使用 Beat Jump、Quantize 和 Beat Sync，但它们只能消费当前读取到的
Rekordbox 原始网格：

- 不得为了启用这些能力生成 FRKB 网格或固定 BPM 替代网格；
- 不得因操作结果反向修改 Rekordbox 网格、BPM、Cue 或 Loop；
- Rekordbox 网格缺失或解析失败时，相关能力必须禁用；
- 禁用状态不得触发 FRKB 自动分析或闲时补算。

最终类型名称和字段可以在实施时调整，但“独立、只读、仅当前运行时存在、不进入
FRKB canonical 分析存储或其他持久缓存”是硬性要求。

### 7.3 时间轴映射

FRKB 已经建立 Rekordbox/产品时间轴与 FFmpeg decoded PCM 音频坐标之间的统一合同，
外部只读网格必须直接复用，不得重新设计第二套时间基准：

```text
timelineSec = audioSec + timeBasisOffsetMs / 1000
audioSec = timelineSec - timeBasisOffsetMs / 1000
```

现有 `timeBasisOffsetMs` 由音频文件的 FFprobe `stream.start_time` 以及适用时的 LAME
gapless `Skip Samples` 计算。FRKB 自有网格算法、Rekordbox 真值评测、原始波形绘制、
Cue/Loop 和 native transport 已经使用该合同。

直接读取的 Rekordbox 拍点、波形、Cue 和 Loop 保持 Rekordbox timeline 坐标；播放和
PCM 取样时通过现有合同换算到 audio 坐标。PWV6/PWV7 与 PQTZ 均来自同一 Rekordbox
时间轴，因此二者相互绘制时不得额外叠加 FFprobe 偏移；该偏移只在与 PCM 播放坐标交互
时使用：

- 原始 Rekordbox 拍点时间不得修改；
- 原始 Rekordbox 波形位置不得修改；
- `timeBasisOffsetMs` 只能用于播放游标、Seek、PCM 取样、波形和 Overlay 的坐标转换；
- 同一数据进入 timeline 坐标后不得重复叠加 offset；
- 映射不得被描述或保存为“修正后的 Rekordbox 网格”；
- 外部来源的 `timeBasisOffsetMs` 属于播放坐标元数据，不是 Rekordbox 分析结果，也不
  得写入 `external_analysis_cache` 或其他外部分析持久缓存；
- 当前曲目加载时按音频文件及来源签名解析，音频文件变化后必须重新计算；
- 对受支持文件发生时间基准解析失败属于加载或实现错误，不是正常的“时间轴未验证”
  产品状态；该曲目的网格相关播放能力应失败关闭，并且不能用 FRKB 重新分析代替。

### 7.4 PWV6/PWV7 三频绘制适配

- `PWV6` / `PWV7` 每列三个字节的顺序是 `mid, high, low`，不是 RGB；
- 原始三频幅度必须原样保留到 Renderer，禁止映射成 FRKB FFT 结果或普通 RGB；
- Canvas 以低频蓝色、中频琥珀色、高频白色按同轴层级绘制，中频与低频重叠允许形成
  Rekordbox 风格的棕色；
- 禁止对该来源套用 FRKB 的波形平滑、尾音释放、包络重塑或 RGB 调色模型；
- 这是一层只读格式解码与显示适配，不生成或修改任何 Rekordbox 分析值。

## 8. UI 与交互要求

不得为外部 Rekordbox 来源新增、重做或平行实现任何播放、波形或网格 UI。必须复用
FRKB 现有的列表、播放器、大波形、概览波形、网格、Cue 和 Loop 展示组件；差异仅能在
数据适配层：外部来源向这些组件提供当前读取的 Rekordbox 只读运行时数据。本节的禁用
规则同样必须在既有组件和底层写入入口生效。

外部 Rekordbox 来源中必须移除或禁止：

- BPM 修改；
- Key 修改；
- 网格左移、右移、重置、保存；
- 网格 BPM 增减；
- 动态网格 clip 新增、删除、拆分和选择；
- downbeat 修改；
- 自动分析、重新分析和分析进度提示；
- FRKB 段落、能量、分析版本等外部库不存在的展示；
- 任何会把结果写入 Rekordbox 文件或 FRKB canonical 分析缓存的操作。

允许保留：

- 播放、暂停、Seek；
- 浏览概览波形和大波形；
- 显示 Rekordbox 网格、Cue 和 Loop；
- 列表筛选、排序、多选；
- 将歌曲复制到 FRKB 本地资料库的显式操作；
- 不修改 Rekordbox 数据的其他只读浏览能力。

建议在界面层显示清晰但不打扰操作的“Rekordbox 只读”来源状态。

## 9. 禁止持久缓存与读取时效

### 9.1 禁止持久缓存

`rekordbox-usb` 和 `rekordbox-desktop` 来源的下列内容不得写入 FRKB 数据库、磁盘
缓存或跨会话缓存：

- Rekordbox 数据库读取结果；
- ANLZ 段落解析结果；
- 概览波形和细节波形绘制数据；
- 完整网格和动态 BPM 数据；
- BPM、Key、Cue、Loop 和 Artwork 关联结果；
- 从上述数据派生的 Renderer 专用结构；
- 用于下次启动、下次插盘或下次打开曲目的分析结果快照。

这包括但不限于 `external_analysis_cache`、`pioneer_preview_waveform_cache`、
`song_cache`、波形缓存表和另行新建的 Rekordbox 分析缓存表。

### 9.2 允许的临时内存范围

为避免一次绘制过程中重复解析同一个 Buffer，允许在以下范围内临时持有数据：

- 单次 IPC 请求；
- 当前打开曲目的组件生命周期；
- 当前歌单加载请求的去重窗口；
- Worker 完成一次解析所需的局部变量。

临时数据必须满足：

- 不写入数据库或磁盘；
- 不跨应用重启；
- 不跨资料库刷新；
- 不跨来源切换或 U 盘重新插拔；
- 新请求到达后，旧请求结果不得覆盖当前来源；
- 来源文件不存在或身份变化后立即失效。

### 9.3 重新读取时机

以下操作必须重新读取当前 Rekordbox 数据源：

- 首次打开 U 盘库或 Rekordbox Desktop 库；
- 切换歌单；
- 重新打开曲目波形；
- 用户执行资料库刷新；
- U 盘拔出后重新插入；
- Rekordbox Desktop 资料库发生重新连接；
- 来源数据库或 ANLZ 文件的身份、mtime、大小发生变化。

界面连续重绘不要求每一帧重新读盘，可以复用当前组件生命周期内的临时内存对象；
但一旦离开上述生命周期，必须丢弃。

### 9.4 现有缓存隔离

`rekordbox-usb` 和 `rekordbox-desktop` 来源不得读取或写入用于保存 FRKB 分析结果的
`external_analysis_cache`，也不得读取或写入持久化的 Pioneer 波形解析缓存。

普通外部文件播放是否继续使用该表不属于本草案范围，实施时不得误删或破坏
`external-playback` 的既有行为。

### 9.5 旧版持久缓存清理

旧版已经可能为 Rekordbox 外部来源写入 FRKB 分析结果和 Pioneer 概览波形解析缓存。
新版本必须在首次启动迁移阶段自动、静默执行一次性清理，但仅在已经阻断相关读取、
入队和写入后执行。静默清理不弹确认框、不要求用户手动操作，也不展示与外部库分析
相关的迁移进度。

清理前必须：

- 关闭所有可能写数据库的 FRKB 实例；
- 对 `FRKB.database.sqlite` 创建可恢复备份；
- 只读统计各目标表和 `source_kind` 的行数；
- 明确区分 `rekordbox-usb`、`rekordbox-desktop` 与 `external-playback`；
- 记录清理前数量，供迁移结果验收。

如果备份、只读统计或事务准备失败，本次启动不得执行删除；应用可以继续启动，但必须
记录可定位的错误和失败结果，等待后续启动重试。禁止为了维持“静默”而跳过备份或
吞掉失败。

目标清理范围：

```sql
DELETE FROM external_analysis_cache
WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop');

DELETE FROM external_analysis_devices
WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop');

DELETE FROM pioneer_preview_waveform_cache;
```

执行要求：

- 删除必须在事务中完成；
- 任一步失败必须整体回滚；
- 不删除 `external-playback`；
- 不整体清空 `song_cache`、`waveform_cache`、`unified_display_waveform_cache`、
  `waveform_surface_cache` 等 FRKB 本地资料库表；
- 不按绝对文件路径扩大删除范围，避免同一音频同时属于 FRKB 本地库时被误删；
- 清理后再次统计目标表，确认对应来源为零；
- 是否执行 `VACUUM` 另行决定，不作为功能迁移的必要条件；
- 用户运行旧版 FRKB 后可能重新生成这些缓存，版本降级场景必须明确提示。

## 10. 分析调度与闲时策略

### 10.1 总原则

`rekordbox-readonly` 来源永远不是 FRKB 分析候选。优先级、是否空闲、用户是否打开
分析状态显示、歌曲是否正在播放、波形是否缺失，都不能改变这一结论。

禁止把“没有 Rekordbox 分析结果”解释为“需要 FRKB 闲时补分析”。在外部库里，
缺失只代表 Rekordbox 当前没有提供或 FRKB 当前无法读取。

### 10.2 FRKB 本地库闲时分析继续保留

现有全局后台分析主要扫描 FRKB 本地 `song_cache` 和本地歌单目录。该能力继续服务
FRKB 本地资料库，不需要因为用户打开 U 盘库或 Rekordbox Desktop 库而全局关闭。

必须保持以下边界：

- 后台候选只来自明确属于 FRKB 本地资料库的歌曲；
- 不扫描 `external_analysis_cache` 构建闲时候选；
- 不扫描 Pioneer U 盘音频目录或 Rekordbox Desktop 外部音频目录；
- 外部库歌曲不增加后台 `pending`、`inFlight` 或 `processing` 数量；
- 外部歌曲播放可以按现有性能策略影响“机器是否空闲”的判断，但不能把该歌曲加入
  分析候选；
- `showIdleAnalysisStatus` 只控制状态展示，不能改变数据权威或允许外部曲目分析。

### 10.3 外部库必须阻断的分析入口

以下入口对 `rekordbox-readonly` 来源一律拒绝：

- 打开外部歌单后触发的可见歌曲低优先级分析；
- `key-analysis:queue-visible`；
- `key-analysis:queue-playing`；
- `key-analysis:queue-deck-idle`；
- 播放器切歌触发的高优先级分析；
- 双轨 deck 分配后的播放优先级或 deck idle 分析；
- PCM 解码路径触发的播放网格分析；
- 概览波形、大波形或列表波形缺失触发的 `waveform-preview` 分析；
- 播放区间或段落缺失触发的分析；
- 用户手动批量分析；
- “分析待处理歌曲”按钮或歌单分析提示；
- 启动恢复、自动重试、失败重试和延迟队列；
- 任何未来新增的 BPM、Key、网格、波形、能量或段落分析入口。

外部库 UI 不应显示上述入口；即使通过旧 Renderer、插件、测试脚本或伪造 IPC 请求
绕过 UI，主进程仍必须拒绝。

### 10.4 双层硬门

仅在 Renderer 隐藏入口不够，必须同时设置两层拒绝：

1. 入队门：任何分析请求进入全局队列前，检查分析权威；
2. 持久化门：Worker 已运行或旧任务尚未清理时，在写入 Key、网格、能量、段落、
   波形和完成状态前再次检查分析权威。

持久化门用于防止以下竞态：

- 曲目先以普通外部文件身份入队，随后被识别为 Rekordbox 外部来源；
- 用户切换资料库时旧请求仍在运行；
- 低优先级任务被播放任务升级或合并；
- 延迟任务、失败重试或旧 Renderer IPC 在边界切换后到达；
- Worker 已完成计算，但来源已经变成只读或已经失效。

命中只读权威后，任务应被标记为 `blocked-readonly-source` 并安静结束，不记录普通
分析失败，不进入自动重试，也不污染外部库的错误计数。

### 10.5 任务身份不能只靠文件路径

当前分析队列主要按文件路径去重和升级。同一个物理文件可能同时：

- 被 FRKB 本地资料库收录；
- 出现在 Rekordbox Desktop 资料库；
- 通过 Pioneer U 盘路径被浏览。

因此分析请求至少需要携带：

- `analysisAuthority`；
- 来源类型；
- 来源身份或本地资料库身份；
- 请求入口；
- 文件路径。

不能仅凭文件路径判断是否允许分析，也不能因为同路径已有 FRKB 本地分析任务，就把
结果投影到外部 Rekordbox 页面。合法的 FRKB 本地任务可以继续运行，但外部页面必须
完全忽略其状态和结果。

### 10.6 待分析数量与状态展示

外部库曲目不得参与：

- 待分析数量；
- 第一首待分析歌曲定位；
- 行内分析进度；
- 闲时分析状态；
- 手动批次进度；
- 分析失败数量；
- 歌单分析提示。

外部库可以单独显示“正在读取 Rekordbox 数据”或“ANLZ 解析失败”，但该状态必须与
FRKB 分析队列彻底分开，不能复用“待分析”语义。

## 11. 外部库与 FRKB 本地库的所有权切换

浏览外部库本身不能把 Rekordbox 数据写入 FRKB canonical 分析存储或任何持久缓存。

当用户明确执行“复制到 FRKB 本地资料库”后，该本地文件进入另一个数据域。本草案
不允许把整套外部 Rekordbox 分析结果自动保存成 FRKB 本地分析快照。

在复制音频和普通文件元数据之外，明确允许一次性带入：

- Key；
- Hot Cue；
- Memory Cue；
- Hot Loop 和 Memory Loop。

明确不带入：

- Rekordbox BPM；
- Rekordbox 概览波形；
- Rekordbox 细节大波形；
- Rekordbox 节拍网格和动态 BPM 网格；
- 其他未明确允许的 Rekordbox 分析结果。

Key、Cue 和 Loop 的复制属于用户明确触发的所有权切换，不属于外部库缓存。复制完成
后，它们成为 FRKB 本地资料库数据，可以按 FRKB 本地能力保存和编辑，不再与原
Rekordbox 数据保持自动同步。

自动 FRKB 分析不得因为补算 BPM、网格、波形、能量或段落而静默覆盖已导入的 Key。
只有用户明确执行重新分析 Key 的操作时，才允许替换该值。

Cue 和 Loop 的位置必须按现有 `timeBasisOffsetMs` 坐标合同转换后写入本地数据；不能
重复叠加 offset，也不能因复制操作改变它们相对原音频的实际位置。

无论采用哪种方案，都必须满足：

- 原外部库数据保持只读；
- 所有权切换只能由明确的复制/导入操作触发；
- 不能因为播放、预览或打开大波形就自动触发切换；
- Rekordbox 后续发生变化时，不自动更新已经复制进 FRKB 本地库的 Key、Cue 和 Loop；
- 外部运行时对象和 FRKB canonical 分析对象不得共享可变对象。

## 12. 当前实现与目标的已知差距

以下路径已确认与目标边界冲突，后续实施前需逐项审计：

1. `src/renderer/src/pages/modules/pioneerSongsArea/usePioneerExternalPlaylistAnalysis.ts`
   - 当前维护 FRKB 已分析路径和分析进度；
   - 会请求准备外部歌单分析。

2. `src/main/services/pioneerDeviceLibrary/playlistAnalysis.ts`
   - 当前把 FRKB Key、能量、canonical 网格和 FRKB 波形作为外部歌曲完整分析；
   - 缺失时会进入 FRKB 分析队列；
   - 会为 Rekordbox 来源维护 `external_analysis_cache`。

3. `src/renderer/src/components/HorizontalBrowseWaveformOverview.vue`
   - 当前优先读取 FRKB global overview；
   - 命中后不会再读取 Rekordbox 概览波形。

4. `src/renderer/src/pages/modules/songPlayer/songPlayer.vue`
   - 当前通用切歌逻辑可能为外部库歌曲触发 FRKB 分析。

5. `src/renderer/src/pages/modules/songPlayer/useSongLoader.ts`
   - PCM 解码路径可能携带 FRKB compact visual waveform；
   - 是否跳过播放网格分析目前由通用浏览器分析开关决定，不是由数据权威决定。

6. `rust_package/src/pioneer_export.rs`
   - 当前 USB 正式链路已读取 BPM、Key、Analyze Path 和概览波形；
   - 概览波形当前主要覆盖 PWV4、PWAV、PWV2；
   - 尚未向产品链路提供完整细节大波形和完整网格。

7. `resources/rekordboxDesktopLibrary/bridge.py`
   - 当前能够读取部分 Rekordbox 网格摘要；
   - 当前已经返回 `gridBpm`、`gridFirstBeatMs`、`gridFirstBeatLabel` 和
     `gridBarBeatOffset`，但 `src/main/services/rekordboxDesktopLibrary/tracks.ts` 未继续
     传递这些字段，`IPioneerPlaylistTrack` 也没有完整只读网格结构；
   - 仍需改为完整只读网格结构，并确保下游不会丢弃、重复叠加时间偏移或改造成 FRKB
     分析结果；
   - 外部曲目加载时应复用 `src/main/services/audioTimeBasisOffset.ts` 与现有 native
     transport 坐标合同，只在当前运行时携带 `timeBasisOffsetMs`。

8. `src/main/libraryCacheDb/pioneerPreviewWaveformCache.ts`
   - 当前会持久缓存 Pioneer 概览波形解析结果；
   - 与“每次从当前 Rekordbox 来源重新读取”的要求冲突，外部 Rekordbox 来源不得再使用。

9. `src/main/ipc/keyAnalysisHandlers.ts`
   - 当前可见、播放、deck idle、手动批次等 IPC 主要只按文件路径入队；
   - 没有统一的 Rekordbox 只读权威检查。

10. `src/renderer/src/composables/horizontalBrowse/horizontalBrowseDeckAssignment.ts`
    - 当前 deck 分配可能触发 `queue-playing` 或 `queue-deck-idle`；
    - 外部 Rekordbox 曲目必须跳过。

11. `src/renderer/src/pages/modules/songPlayer/usePlaybackRangeController.ts`
    - 当前播放区间需要段落时可能触发 `queue-playing`；
    - 外部 Rekordbox 曲目不得因此运行 FRKB 段落分析。

12. `src/main/ipc/cacheHandlers.ts`
    - 当前波形缺失可能触发 `waveform-preview` 分析；
    - 外部库必须直接报告 Rekordbox 波形缺失，不能进入 FRKB 波形队列。

13. `src/main/services/keyAnalysis/background.ts`
    - 当前全局闲时分析主要读取本地 `song_cache` 和本地歌单目录；
    - 该本地边界应保留，并增加回归测试防止未来把外部来源纳入候选。

## 13. 建议实施阶段

### 阶段 A：建立数据权威硬门

- 为歌曲上下文增加明确的分析权威，例如 `frkb` 与 `rekordbox-readonly`；
- 所有分析队列入口、持久化入口、波形选择器和网格编辑入口统一经过该权威判断；
- 分析任务携带来源身份和请求入口，禁止仅按文件路径判断；
- 增加入队门和持久化门；
- 禁止依靠散落的 `sourceKind === 'usb'` 判断维持边界。

### 阶段 B：停止外部库 FRKB 分析

- 移除 U 盘库与 Rekordbox Desktop 库的自动分析准备；
- 阻止主播放器、PCM 解码和通用分析提示触发 FRKB 分析；
- 停止为这两类来源写入 FRKB `external_analysis_cache`；
- 停止读取或写入持久化 Pioneer 波形解析缓存；
- 阻断可见、播放、deck idle、手动、波形缺失、段落缺失和自动重试入口；
- 外部曲目从待分析数量、行内进度和闲时状态中移除；
- 移除外部库分析进度状态。

### 阶段 C：纯 Rekordbox 波形链路

- 修正概览波形优先级，外部库只请求 Rekordbox 波形；
- 接入细节大波形即时读取、解析和绘制；
- 保证列表预览、主播放器、双轨大波形等消费者来源一致；
- Rekordbox 波形缺失时保持缺失，不生成替代波形；
- 切换曲目、刷新资料库或重新插盘后重新读取，不复用上一次解析结果。

### 阶段 D：完整只读网格链路

- 读取完整 PQTZ/PQT2 数据；
- 建立独立只读网格模型；
- 当前曲目加载时解析运行时 `timeBasisOffsetMs`，并将 Rekordbox timeline 网格直接接入
  现有波形、Cue/Loop 和 native transport 坐标合同；
- 接入网格绘制、播放游标、Beat Jump、Quantize 和 Beat Sync 消费能力；
- 网格缺失或解析失败时禁用 Beat Jump、Quantize 和 Beat Sync；
- 不接入任何网格编辑和保存逻辑。

### 阶段 E：时间轴回归验收

- 验证外部只读链路复用了现有 `timelineSec` / `audioSec` 双向换算，没有建立第二套规则；
- 使用真实 U 盘和 Rekordbox Desktop 曲目验证波形、网格、Cue、播放声音和游标；
- 覆盖 MP3、AIFF、WAV、FLAC 等实际支持格式；
- 覆盖固定 BPM、动态 BPM、前导静音和编码延迟代表样本；
- 验证 Beat Jump、Quantize 和 Beat Sync 使用与波形、Cue、Loop 相同的 timeline 坐标；
- 时间基准解析失败必须作为加载或实现错误失败关闭，不用 FRKB 分析回退。

### 阶段 F：旧缓存清理

- 新版本首次启动迁移时静默执行，不弹确认框或迁移进度；
- 确认新版本已经停止读取和写入旧缓存；
- 自动备份真实数据库；
- 只读统计待清理行数；
- 事务清理 `rekordbox-usb`、`rekordbox-desktop` 和 Pioneer 概览波形缓存；
- 验证目标来源为零且 FRKB 本地资料库记录未减少；
- 保留清理报告和可恢复备份；
- 备份或迁移准备失败时不删除，记录错误并在后续启动重试。

## 14. 验收标准

### 14.1 分析隔离

- 打开任意 U 盘或 Rekordbox Desktop 歌单，不产生 FRKB 分析队列任务；
- 播放外部库歌曲，不触发 `key-analysis:queue-playing` 或播放网格分析；
- 浏览外部库期间，不新增或更新该来源的 FRKB `external_analysis_cache`；
- 不新增或更新该来源的持久化 Pioneer 波形解析缓存；
- 不显示 FRKB 分析进度、能量和段落结果；
- 可见、播放、deck idle、波形缺失、段落缺失、手动分析和自动重试均无法入队；
- 伪造旧 IPC 请求也被主进程拒绝；
- 已经运行的旧任务在持久化前被拒绝，不产生缓存记录；
- 外部歌曲不进入待分析数量和闲时分析状态。

### 14.2 闲时分析隔离

- FRKB 本地资料库闲时分析继续正常工作；
- 闲时扫描候选仅来自本地 `song_cache` 和本地歌单目录；
- 不读取 `external_analysis_cache` 生成候选；
- 打开 Rekordbox 外部库不会把可见曲目加入后台队列；
- 播放外部曲目不会把该曲目加入后台或 deck idle 分析；
- 同路径存在合法 FRKB 本地任务时，外部页面仍不读取其状态或结果。

### 14.3 数据来源

- BPM 和 Key 与 Rekordbox 显示一致；
- 概览波形来自对应曲目的 Rekordbox ANLZ；
- 大波形来自对应曲目的 Rekordbox 细节波形；
- 网格线来自完整 Rekordbox 网格；
- Cue 和 Loop 来自 Rekordbox 数据；
- 同一音频同时存在于 FRKB 本地库和 Rekordbox 外部库时，外部库页面不得显示
  FRKB 本地分析结果；
- 在 Rekordbox 中重新分析或修改曲目后，刷新或重新打开曲目必须读取到当前结果，
  不得继续显示 FRKB 保存的旧副本。

### 14.4 缺失行为

- 删除或移走某首歌的 Rekordbox Analyze 文件后，该曲目波形和网格显示缺失；
- 缺失时不产生 FRKB 波形或网格；
- 只有概览波形而没有细节大波形时，大波形区域显示“Rekordbox 未提供细节波形”，
  不放大概览波形冒充；
- 解析失败时给出可定位的错误状态，不静默切换数据来源；
- U 盘拔出或 Desktop 来源失效后，不得继续用持久缓存伪装成在线数据。

### 14.5 只读行为

- 外部库大波形不出现网格编辑工具；
- 不允许保存 BPM、Key、网格、Cue 或 Loop 修改；
- 任何绕过 UI 发起的修改请求都被底层拒绝；
- 验收前后 U 盘数据库、ANLZ 文件和 Rekordbox Desktop 数据库保持未修改。

### 14.6 播放和时间轴

- 概览波形、大波形、网格、Cue、Loop 和播放游标使用一致的 Rekordbox 时间语义；
- 播放声音与网格对齐结果通过代表曲目人工验收；
- 动态 BPM 曲目不得被错误绘制成固定 BPM 网格；
- 时间轴映射不得改变或覆盖原始 Rekordbox 网格数据；
- Rekordbox timeline 与 decoded audio 坐标必须通过现有 `timeBasisOffsetMs` 双向合同
  转换，不能重复叠加 offset；
- Rekordbox 网格可用时，Beat Jump、Quantize 和 Beat Sync 可以正常消费该网格；
- 外部来源运行时 `timeBasisOffsetMs` 不写入 `external_analysis_cache` 或其他外部分析
  持久缓存；
- 时间基准解析失败按加载或实现错误处理，相关能力失败关闭且不得触发 FRKB 分析补算。

### 14.7 旧缓存清理

- 新版本首次启动自动执行静默迁移，不要求用户确认或手动清理；
- 清理前存在可恢复数据库备份；
- 清理前后行数记录完整；
- `external_analysis_cache` 中 `rekordbox-usb` 和 `rekordbox-desktop` 为零；
- `external_analysis_devices` 中上述来源为零；
- `pioneer_preview_waveform_cache` 为零；
- `external-playback` 行数不因本次迁移减少；
- FRKB 本地 `song_cache` 和本地波形表未被整体清空；
- 清理后重新打开外部库不会再次产生持久缓存；
- 备份或事务准备失败时目标数据保持不变，并留下可定位的失败记录供后续启动重试。

### 14.8 复制到 FRKB 本地库

- 用户未执行复制前，不产生任何本地分析快照；
- 复制后保留 Rekordbox Key、Hot Cue、Memory Cue 和对应 Loop；
- 不复制 Rekordbox BPM、概览波形、大波形或节拍网格；
- 导入 Key 不被后续自动 BPM、网格、波形、能量或段落分析静默覆盖；
- Cue 和 Loop 位置与原音频保持一致；
- 复制后的本地数据可以编辑，但不反写 Rekordbox；
- Rekordbox 后续修改不会自动同步到 FRKB 本地副本。

## 15. 非目标

本草案不包含：

- 向 Pioneer U 盘写入 FRKB 分析结果；
- 修改 Rekordbox Desktop 数据库；
- 在外部库中编辑网格、Cue 或 Loop；
- 用 Rekordbox 数据替换 FRKB 本地资料库的全部分析体系；
- 重新设计普通外部文件播放的分析规则；
- 发布版本以及与本需求无关的数据库清理或历史缓存迁移；
- 为 Rekordbox 分析结果新增任何形式的持久缓存；
- 因外部库只读要求而关闭 FRKB 本地资料库的正常闲时分析。

## 16. 非阻塞待确认问题

1. 是否需要提供“查看 Rekordbox 原始分析信息”的诊断入口，用于展示 Analyze Path、
   ANLZ 标签、来源签名和解析错误，但不提供任何编辑能力？

## 17. 实现跟踪（2026-07-27）

### 已落地

- 删除 Pioneer U 盘与 Rekordbox Desktop 的 `prepare-playlist-analysis` IPC 和 renderer 自动
  准备链路；Pioneer 页面不再维护 FRKB 的外部待分析/已分析状态，也不再向
  `key-analysis:queue-playing` 主动入队。
- 分析 IPC 改为只接收显式 `analysisAuthority: 'frkb'` 的请求；普通本地页面调用已补齐该
  标识，缺失或伪造旧格式的请求不会入队。外部歌曲在主播放器、播放区间、双轨分配、双轨
  播放优先级等入口均显式跳过 FRKB 分析。
- 外部歌单每次进入或切换都会直接回读当前来源，不再展示跨视图缓存的旧曲目结果。
- Pioneer 概览波形服务已移除 `pioneer_preview_waveform_cache` 的读取和写入；当前请求中仍可
  聚合结果，但不会跨会话保存。
- 新增 V38→V39 静默迁移：先创建 SQLite 一致性备份，再在事务中删除
  `external_analysis_cache` / `external_analysis_devices` 的 `rekordbox-usb`、
  `rekordbox-desktop` 行，并清空 `pioneer_preview_waveform_cache`；成功后删除临时备份。
  备份或事务失败时不会删除数据、不会升级到 V39，并会在下次启动重试。
- Rekordbox Desktop bridge 现输出完整 `rekordboxGridEntries` 拍点表。产品侧只在本次运行中
  将其适配成 transport 可消费的网格，结合现有 `timeBasisOffsetMs` 使用；不写入
  `song_cache`、`external_analysis_cache` 或其他外部分析缓存。
- Pioneer USB Rust 链路现即时读取 DAT 的完整 `PQTZ` 拍点表（`beat=1..4`、`tempo / 100`、
  timeline 毫秒），经 worker 仅在本次运行中适配成 transport 网格；同样不持久化。已加入
  PQTZ 二进制布局单测。
- 为复用既有网格 Renderer，连续且 BPM/拍号/相位一致的每拍 PQTZ 真值只在当前运行时
  合并为一个 tempo clip；不连续、变速或相位变化处才形成 clip 边界。原始每拍表仍随曲目
  运行时对象保留，因此不会把每一拍错误画成动态分段边界，也不会由 FRKB 推测拍点。
- Pioneer USB 与 Rekordbox Desktop 的细节大波形均即时读取当前 ANLZ。读取器覆盖
  `PWV3` / `PWV5`、2EX 的 `PWV7`，并以 `PWV6` 作为仅有三频预览时的原始分辨率回退；
  PWV6/PWV7 的三条原始频带仅被映射到既有 RGB canvas 输入；对于这些格式的 7-bit
  振幅和颜色通道，只允许在 Canvas 输入处做 0–127 到既有 0–255 显示量程的归一化，
  不生成、补全或推测任何波形内容。
  `PWV3`、`PWV5`、`PWV7` 的列频率必须读取 ANLZ 头第三个 `u32` 的高 16 位（官方
  文件为 `0x0096`，即 150Hz），以 `列数 / 150` 作为波形时间轴，绝不按可能为整数的
  曲目时长反推并拉伸列坐标；否则 PQTZ 的逐拍真值相对波形会产生随播放时间累积的漂移。
  `PWV6` 是固定 1200 列概览且未携带该时间频率，才允许按全曲时长均分。
  为避免 `PWV5` 低档位的非零高度（例如 1/31）在现有 canvas 中被中心线覆盖而视觉消失，
  原生 Rekordbox 波形允许采用 2px 的非零像素下限；这只是画笔最小线宽，零值仍不画，
  不改变 ANLZ 数值、不放大原始幅度，且不使用 FRKB 包络或重分析。
  两个来源复用同一个 `HorizontalBrowseRawWaveformDetail` canvas 数据合同，没有新增或重做
  波形 UI。读取失败、缺少标签或不受支持的格式仍显示既有的“Rekordbox 未提供细节波形”
  状态，不会改用 FRKB raw waveform。
- 细节波形异步读到后会立即请求既有 canvas 重绘；此前漏掉该请求，导致只有后续播放、
  缩放或尺寸变化才偶然显示。PWV6/PWV7 的 7-bit 原始振幅和三频颜色均按既有 canvas 的
  8-bit 输入做显示归一化，并补齐颜色索引，避免出现纯白或过淡渲染；这只改变显示适配，
  不生成或替换
  任何 Rekordbox 波形数据。
- 保留窄范围 `RKB-WAVEFORM` 落盘诊断：只覆盖 USB/Desktop 的网格读取、细节波形
  请求、ANLZ 解析结果、列数、颜色样式、renderer 重绘入队，以及 canvas 实际完成的网格
  渲染范围、clip 数和 ready/失败原因；普通外部文件库不会产生这些日志。用于人工复现后从
  `log.txt` 直接定位，字段不包含音频分析结果写回。
- 外部歌曲进入双轨时跳过本地 shared grid / Cue 水合与网格持久化入口；网格编辑工具被禁用。
  在尚未读取到 Rekordbox 原始细节波形时，细节区域明确显示“Rekordbox 未提供细节波形”，
  且不会读取 FRKB unified/raw waveform 缓存。
- 外部 Rekordbox 曲目走 PCM 播放时显式禁用 FRKB shared grid、全局概览波形缓存与波形生成
  写回；PCM 解码只用于声音播放。普通本地库仍维持原来的分析与波形路径。
- 概览波形消费者先按曲目显式 `externalSourceKind: 'usb' | 'desktop'` 分流：这两类来源
  只读 Rekordbox ANLZ，绝不先探测 FRKB `globalOverview`，以免缓存未命中触发
  `waveform-preview` 分析；普通外部文件库（`external-playback`）不带该标记，继续走
  原有 FRKB 分析、缓存和波形路径。
- V38→V39 清理事务现在在写入 schema 版本前再次验证三个目标缓存范围均已归零；清理失败
  会保留 V38 和备份，并记录错误后在下次启动重试。

### 尚未完成，不能假装已支持

- Pioneer USB 的 PQT2 扩展网格尚未移植；PQTZ 已提供完整基础拍点表。如果 DAT 缺少 PQTZ，
  则网格相关能力必须保持“未提供”，绝不使用 FRKB 分析替代。
- 待人工验收：以真实 U 盘和 Desktop 曲目确认声音、游标、Cue/Loop、动态 BPM 与刷新时效；
  验收步骤与判定标准见第 14 节，重点检查重新分析或修改 Rekordbox 后重新打开曲目是否立即
  回读当前数据，以及整个过程未产生 FRKB 外部分析/波形缓存。
