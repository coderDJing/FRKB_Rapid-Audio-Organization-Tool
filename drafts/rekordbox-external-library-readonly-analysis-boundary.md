# Rekordbox 外部库只读维护边界

维护状态：代码已实现；待真实 Pioneer U 盘与 Rekordbox Desktop 库人工验收

适用范围：Pioneer U 盘 Device Library、OneLibrary 与 Rekordbox Desktop 资料库。

本文定义外部 Rekordbox 来源的长期数据边界。它不记录一次性迁移、提交安排或字节级波形格式；RGB 和三频波形的解析与绘制研究见[Rekordbox RGB 波形研究](./rekordbox-rgb-waveform-research.md)。

## 1. 唯一权威与只读

在外部 Rekordbox 来源中，BPM、Key、波形、节拍网格、Cue、Loop、Artwork 和关联分析文件只能来自当前 Rekordbox 数据库和 ANLZ 文件。FRKB 只读取、播放和渲染，不能把它们当作 FRKB 本地分析结果。

- 同一路径即使在本地库已有 FRKB 缓存，外部页面也必须忽略该缓存。
- Rekordbox 缺少或无法解析某项数据时，显示为空、不可用或明确错误；不得自动运行 FRKB 分析、用 FFmpeg/标签伪造结果，或读取历史缓存补全。
- 禁止修改 Rekordbox 的 BPM、Key、grid、downbeat、Cue、Loop、数据库或 ANLZ 文件。禁用必须同时落在 UI、IPC 和服务层，不能只隐藏按钮。
- 允许解码原音频用于播放，以及将 Rekordbox 数据转换成当前画面可绘制的运行时对象；这些操作不能生成新的分析结论。

## 2. 网格与时间轴

- 外部网格的真值是 Rekordbox PQTZ 等原始逐拍数据：每拍时间、BPM 和 `1..4` 拍号必须直接用于波形和 Beat Sync。
- 动态 BPM 曲目不得压缩成 FRKB 推测的固定 BPM 或 tempo clip。为内部显示临时派生的结构不能冒充 FRKB 可编辑 clip，也不能成为同步真值。
- Beat Jump、Quantize、Loop 与 Beat Sync 可以使用外部网格；缺少或解析失败时应禁用相关能力，不能触发 FRKB 补分析。
- Rekordbox timeline 与 decoded PCM 的转换只复用统一合同：`timelineSec = audioSec + timeBasisOffsetMs / 1000`。原始拍点、波形、Cue 和 Loop 仍保持 Rekordbox timeline，禁止重复叠加偏移或保存为“修正后的 Rekordbox 网格”。
- `timeBasisOffsetMs` 只服务播放、seek、PCM 取样和坐标映射，不属于 Rekordbox 分析数据，也不能进入外部分析缓存。

## 3. 波形和显示

- 概览与细节大波形均直接使用 Rekordbox ANLZ 数据；细节缺失时明确显示 Rekordbox 未提供，不能放大概览或从 PCM 重建。
- 只允许保留原始分辨率或做插值，不能套用 FRKB 波形的振幅、平滑、噪声门、包络或颜色模型来伪造细节。
- 外部来源复用现有播放器和波形 surface，但数据适配层必须标明其 Rekordbox 来源、ANLZ 身份和过期条件。
- 动态网格的边界是 FRKB 本地编辑语义，外部库只显示 Rekordbox 自身拍线、Cue 和 Loop，不展示 FRKB clip 边界。

## 4. 缓存与时效

Rekordbox 外部来源的解析结果只能存在于单次请求、当前曲目组件生命周期或当前歌单读取去重窗口中。

- 不得写入 `song_cache`、`external_analysis_cache`、Pioneer 波形缓存或任意新的跨会话持久缓存。
- 切歌、切换来源、刷新资料库、U 盘拔插、Desktop 重连、应用重启，或来源数据库/ANLZ 身份变化后，旧运行时对象必须失效并重新读取。
- 已实现的 schema 清理只清除 `rekordbox-usb` 与 `rekordbox-desktop` 的旧外部分析缓存，不得误删 `external-playback` 或 FRKB 本地库数据。

## 5. 允许与禁止

允许：播放、暂停、seek、只读浏览波形/grid/Cue/Loop、筛选排序，以及把歌曲显式复制到 FRKB 本地库。

禁止：外部来源的 BPM/Key/grid 编辑、动态 clip 编辑、自动或重新分析、FRKB 段落/能量/Stem 展示、以及任何写回 Rekordbox 或写入 FRKB canonical 分析缓存的行为。

## 6. 人工验收

真实 Pioneer U 盘和 Rekordbox Desktop 库都要验证：

1. BPM、Key、概览/细节波形、PQTZ 网格、Cue 和 Loop 都来自当前 Rekordbox 来源；缺失时不回退；
2. 动态 BPM 的可见拍线、Beat Sync 与播放时间基一致，且不出现 FRKB clip 或本地网格；
3. 编辑和分析入口在 UI 与底层调用中均被拒绝；
4. 刷新、切歌、拔插或重连后不会复用旧来源数据，也不会写入持久缓存；
5. FRKB 本地库与 `external-playback` 的既有分析和播放行为不受外部只读隔离影响。

验收不以“能播放”代替数据来源验证。只要外部页面混入 FRKB 分析、缓存或写入能力，本项即不通过。
