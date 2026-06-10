# 波形 Surface Cache 重构接手文档

## 接手摘要

当前问题：打开歌曲列表会卡一下。日志证明卡点不在 renderer 绘制，而在主进程为了列表预览读取并解压完整 `unified_display_waveform_cache` payload。

已定方向：分析阶段额外持久化两套轻量显示 surface。运行时列表、播放器和概览只读对应 surface，禁止在读路径同步解压统一详情再现场转换。

第一版必须覆盖四个显示面：

- 歌曲列表波形预览。
- 浏览器模式主播放器波形。
- 双轨模式概览波形。
- 编辑模式概览波形。

已定数据分层：

```text
listPreview:
  用于歌曲列表预览
  低精度
  固定 512 columns

globalOverview:
  用于浏览器主播放器 + 双轨概览 + 编辑概览
  三者共用同一套精度
  32 frames/s
  minFrames = 4096
  maxFrames = 16384
  frameCount = clamp(ceil(durationSec * 32), 4096, 16384)
```

历史数据策略也已定：

```text
没有 surface cache = 当作未分析 / 需要补分析
```

不要为旧数据做读时兼容转换。

## 本轮问题从哪里来

用户反馈打开歌曲列表时会卡一下。临时加了 `[SONG-WAVEFORM-PERF]` 日志后，看到当前列表一共 18 首歌，首屏实际也请求了 18 首波形预览。

也就是说，这次日志里的 18 首既是首屏 18 首，也是完整列表 18 首。

关键日志：

```text
visibleCount: 18
actualVisibleCount: 18
pendingCount: 18
libraryCount: 18

main-compact-batch-done totalMs: 1448
statMs: 219
loadMs: 1213
convertMs: 7
cleanupMs: 8

renderer-batch-done ipcMs: 1528
renderer-draw-frame elapsedMs: 0-1
```

结论：

- 主进程 batch 总耗时约 1.45s。
- 主耗时是 `loadMs: 1213`，也就是读取 / 解压缓存。
- `convertMs: 7` 很小，现场转换本身不是最大耗时。
- renderer 绘制每帧 `0-1ms`，canvas / worker 绘制不是瓶颈。
- 18 首不多，但每首都解压 MB 级统一详情 payload，足够造成体感卡顿。

## 当前真实代码路径

歌曲列表预览 renderer 路径：

```text
src/renderer/src/pages/modules/songsArea/SongListRows/useWaveformPreview.ts
  -> ipcRenderer.invoke('compact-visual-waveform-cache:batch')
```

主进程 IPC 路径：

```text
src/main/ipc/cacheHandlers.ts
  -> compact-visual-waveform-cache:batch
```

当前实际读取的是统一详情缓存：

```text
src/main/libraryCacheDb/unifiedDisplayWaveformCache.ts
  -> unified_display_waveform_cache
  -> inflateSync(...)
```

当前相关共享类型 / 转换：

```text
src/shared/compactVisualWaveform.ts
src/shared/unifiedDisplayWaveform.ts
src/renderer/src/components/horizontalBrowseCompactVisualWaveform.ts
```

主播放器使用 compact visual 数据的路径：

```text
src/renderer/src/pages/modules/songPlayer/useSongLoader.ts
src/renderer/src/pages/modules/songPlayer/useWaveform.ts
src/renderer/src/pages/modules/songPlayer/playerCompactVisualWaveformRenderer.ts
```

双轨概览 / 编辑概览相关路径：

```text
src/renderer/src/components/HorizontalBrowseWaveformOverview.vue
src/renderer/src/components/MixtapeBeatAlignDialog.vue
src/renderer/src/components/mixtapeBeatAlignOverviewCache.ts
```

## 当前现状

当前统一详情缓存参数：

```text
UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE = 1200/s
UNIFIED_DISPLAY_WAVEFORM_OVERVIEW_RATE = 32/s
UNIFIED_DISPLAY_WAVEFORM_BODY_RATE_DIVISOR = 4
```

统一详情 payload 内容：

```text
height
attack
colorIndex
colorLow
colorMid
colorHigh
colorRed
colorGreen
colorBlue
body
overviewHeight
```

当前歌曲列表预览命中缓存时，实际做的是：

```text
读取 unified_display_waveform_cache
  -> inflateSync 解压完整统一详情
  -> 从统一详情派生 compact visual 数据
  -> 返回 renderer 绘制列表预览
```

这对列表预览是过量读取。列表只需要低精度扫视图，却读了完整 detail payload。

## 最开始的问题答案

最开始问的是“歌曲列表读取歌曲波形，是串行还是并行”。

当前结论：

- renderer 会把可见歌曲路径批量请求给主进程。
- 主进程 `compact-visual-waveform-cache:batch` 里是逐首处理，整体是串行 batch。
- 如果缺波形分析，`KeyAnalysisQueue` 当前 worker 数是 `1`，生成阶段也是串行。

但这次打开列表卡顿的主要根因不是“串行”本身，而是每首都在主进程读 / 解压完整统一详情。把这个错误读路径并行化，只会把更多解压压力同时压到主进程。

## 为什么以前不卡

历史上 `compact-visual-waveform-cache:batch` 读的是轻量 compact visual cache。

后续改动废弃旧波形缓存分析后，同一个 IPC 变成：

```text
remove compact visual cache
load unified_display_waveform_cache
convert unified detail to compact visual at read time
```

所以回归原因是：列表预览从“读轻量显示资产”退化成“读完整统一详情再现场派生”。

这不是 renderer 变慢，也不是列表 18 首数量异常，而是运行时读取的数据层级错了。

## 为什么不靠逐首读 / 并行读修

逐首读可以避免一次性等完 batch，但如果每首仍然解压完整统一详情，只是把卡顿拆成多个小卡顿。

并行读可以缩短 wall time，但会让主进程同时做更多 `inflateSync`，可能让 UI 更容易被抢占。

这两个都是调度层缓解，不是根因修复。

根因修复必须是：

```text
分析阶段生成显示 surface
运行时只读显示 surface
```

## 已定架构方向

新增持久化 waveform surface cache。

分析阶段写入：

```text
音频分析 / 统一详情生成
  -> 派生 listPreview
  -> 派生 globalOverview
  -> 写入 waveform_surface_cache
```

运行时读取：

```text
歌曲列表
  -> 只读 listPreview

浏览器主播放器 / 双轨概览 / 编辑概览
  -> 只读 globalOverview
```

缺失 surface：

```text
返回 missing / loading
触发或等待分析队列
禁止读时从 unified detail 同步转换
```

## 已定显示面分组

### 第一组：listPreview

只服务歌曲列表波形预览。

已定参数：

```text
columns = 512
```

设计理由：

- 列表行高和列宽都很小，只需要快速扫视轮廓。
- 固定列数可以避免长歌让列表预览 payload 线性膨胀。
- 列表不承担精确定位，512 columns 足够第一版使用。

### 第二组：globalOverview

服务三个显示面：

- 浏览器模式主播放器波形。
- 双轨模式概览波形。
- 编辑模式概览波形。

已定参数：

```text
targetRate = 32 frames/s
minFrames = 4096
maxFrames = 16384
frameCount = clamp(ceil(durationSec * 32), 4096, 16384)
```

设计理由：

- 当前统一详情里的 `overviewRate` 本来就是 `32/s`，沿用它不会造成肉眼倒退。
- 浏览器主播放器、双轨概览、编辑概览对全曲概览精度要求一致，应共用一套。
- 4 分钟歌曲约 7680 帧。
- 按现有 byte 通道模型，正常歌曲每首大约几十 KB 到一百多 KB，远低于当前 1.8-2MB 统一详情读取成本。

## 为什么不是四个显示面共用同一套

列表预览和另外三个显示面的诉求不一样。

列表预览：

- 低精度。
- 小尺寸。
- 需要大量歌曲同时出现。
- 不能随歌曲时长无限增长。

浏览器主播放器 / 双轨概览 / 编辑概览：

- 需要全曲时间定位。
- 需要一致精度。
- 可以按 duration 增长，但必须有上下限。

所以最终定为：

```text
listPreview 单独一套
globalOverview 供浏览器主播放器 + 双轨概览 + 编辑概览共用
```

## 建议数据库形态

建议新增表：

```text
waveform_surface_cache
```

建议字段：

```text
list_root
file_path
size
mtime_ms
cache_version
list_preview_parameter_version
global_overview_parameter_version
duration
list_preview_frame_count
global_overview_frame_count
list_preview_payload
global_overview_payload
updated_at
```

第一版建议一张表存两套 payload，而不是拆两张表。

理由：

- 文件指纹校验只做一次。
- 分析阶段一次写入两套 surface。
- 迁移、删除、移动、重新分析时维护更简单。
- 缺哪套 payload 可以明确判断，不需要跨表拼状态。

## 建议共享类型

不要继续让 `CompactVisualWaveformData` 这个名字混指所有用途。

建议新增更明确的类型：

```text
WaveformListPreviewData
WaveformGlobalOverviewData
WaveformSurfaceCacheData
```

可以复用现有 compact visual renderer 的 byte-array 通道思想：

```text
duration
sampleRate
detailRate
overviewRate
bodyRateDivisor
colorRateDivisor
detailPeakTop
detailPeakBottom
detailBody
colorIndex
colorLow
colorMid
colorHigh
colorRed
colorGreen
colorBlue
overviewTop
overviewBottom
```

但类型名和参数版本要按用途拆清楚：

```text
LIST_PREVIEW_PARAMETER_VERSION
GLOBAL_OVERVIEW_PARAMETER_VERSION
SURFACE_CACHE_VERSION
```

这样以后只调整列表 512 columns 的算法，不会误让 global overview 全部失效。

## 编码和压缩方向

第一版可以继续使用 byte arrays 打包成 SQLite blob。

是否压缩待实现时权衡，但原则是：

- surface payload 已经比统一详情小很多。
- 读路径要优先减少 CPU 解压开销。
- 如果压缩收益不明显，宁可不压缩或轻压缩，也不要重新引入列表打开时的大量同步 inflate。

禁止把完整统一详情塞进 surface payload。

## 写入规则

歌曲分析完成时写入 surface cache。

建议写入点：

```text
src/main/services/keyAnalysis/persistence.ts
  -> persistWaveform(...)
```

写入时必须记录：

```text
list_root
file_path
size
mtime_ms
duration
surface cache version
list preview parameter version
global overview parameter version
payload frame counts
payload blobs
```

当重新分析、文件变更、移动、删除、维护清理时，surface cache 要和当前 waveform cache 一起失效。

需要同步纳入维护路径：

```text
src/main/libraryCacheDb/maintenance.ts
src/main/services/cacheMaintenance.ts
src/main/ipc/cacheHandlers.ts
src/main/window/mainWindow/audioDecodeHandlers.ts
src/main/services/keyAnalysis/background.ts
src/main/services/keyAnalysis/persistence.ts
```

## 读取规则

歌曲列表读取规则：

```text
只读 list_preview_payload
不读 unified_display_waveform_cache
不做读时转换
```

浏览器主播放器、双轨概览、编辑概览读取规则：

```text
只读 global_overview_payload
不读 unified_display_waveform_cache
不做读时转换
```

缺失规则：

```text
payload 缺失
版本不匹配
size / mtime 不匹配
decode 失败
```

以上都视为 missing。missing 时返回 loading / unavailable 状态，并排队分析或等待已有分析任务。

## IPC 命名方向

当前 IPC 名：

```text
compact-visual-waveform-cache:batch
compact-visual-waveform-cache:load
```

这个名字已经不准确。

建议第一版新增或替换为：

```text
waveform-list-preview-cache:batch
waveform-global-overview-cache:load
waveform-global-overview-cache:batch
```

如果为了减少改动保留旧 IPC 名，也必须让内部语义改为只读 surface cache，并在代码注释中标明旧名只是兼容壳，不能再读取 unified detail。

## 需要改的消费端

歌曲列表：

```text
src/renderer/src/pages/modules/songsArea/SongListRows/useWaveformPreview.ts
src/renderer/src/workers/songListWaveformPreview.shared.ts
```

浏览器模式主播放器：

```text
src/renderer/src/pages/modules/songPlayer/useSongLoader.ts
src/renderer/src/pages/modules/songPlayer/useWaveform.ts
src/renderer/src/pages/modules/songPlayer/playerCompactVisualWaveformRenderer.ts
src/renderer/src/pages/modules/songPlayer/webAudioPlayer.ts
```

双轨概览：

```text
src/renderer/src/components/HorizontalBrowseWaveformOverview.vue
```

编辑概览：

```text
src/renderer/src/components/MixtapeBeatAlignDialog.vue
src/renderer/src/components/mixtapeBeatAlignOverviewCache.ts
```

主进程缓存：

```text
src/main/libraryDb.ts
src/main/libraryCacheDb.ts
src/main/libraryCacheDb/*
src/main/ipc/cacheHandlers.ts
src/main/services/keyAnalysis/persistence.ts
src/main/services/cacheMaintenance.ts
```

## 不要走的方案

不要把读取完整 unified detail 改成并行后当成修复。

不要在列表预览里保留读时 fallback：

```text
missing surface
  -> load unified detail
  -> convert
```

这条路正是当前卡顿根因。

不要把四个显示面强行共用一套 payload。已定分组是：

```text
listPreview 单独一套
globalOverview 三个概览 / 主播放器共用
```

不要为了历史数据兼容保留旧转换。用户已明确不用管历史数据，没有 surface 就当需要分析。

不要把本轮 surface cache 误当成编辑模式深度 zoom detail 的最终替代。编辑概览要做，编辑深度细节波形不是本轮目标。

## 本轮边界

第一版要解决：

- 歌曲列表预览卡顿。
- 浏览器模式主播放器波形读取轻量化。
- 双轨概览读取轻量化。
- 编辑概览读取轻量化。
- surface 缺失时自动补分析。

第一版不替代：

- 编辑模式深度 zoom detail 波形。
- 双轨大波形 detail lane 的高倍率细节。
- 采样级或 1200/s detail 数据。
- 原始音频事实源或 PCM 缓存。

## 第一阶段实施顺序

1. 新增共享类型和 surface 编解码模块。
2. 新增 `waveform_surface_cache` 表。
3. 新增 surface cache 的 load / batch / upsert / remove 函数。
4. 在分析持久化阶段生成并写入 `listPreview` 和 `globalOverview`。
5. 把列表读取切到 `listPreview`。
6. 把浏览器主播放器读取切到 `globalOverview`。
7. 把双轨概览读取切到 `globalOverview`。
8. 把编辑概览读取切到 `globalOverview`。
9. 缺失 surface 时排队分析，禁止读时转换 unified detail。
10. 把移动、删除、重新分析、维护清理纳入 surface cache 失效。
11. 删除本轮临时 `[SONG-WAVEFORM-PERF]` 诊断日志。
12. 跑验证。

## 验证要求

代码修改完成后必须跑：

```text
npx vue-tsc --noEmit
git diff --check
```

功能验证重点：

- 打开 18 首列表时不再出现 1s 级 main cache batch。
- 列表预览能显示已分析歌曲。
- 缺失 surface 的歌曲会进入分析 / 补分析，不会同步解压 unified detail。
- 浏览器主播放器能显示 `globalOverview`。
- 双轨概览能显示 `globalOverview`。
- 编辑概览能显示 `globalOverview`。
- 重新分析后四个显示面刷新。

## 当前临时状态

当前仓库里还保留了为定位卡顿加入的 `[SONG-WAVEFORM-PERF]` 临时日志，涉及：

```text
src/renderer/src/pages/modules/songsArea/SongListRows/useWaveformPreview.ts
src/main/ipc/cacheHandlers.ts
src/main/libraryCacheDb/unifiedDisplayWaveformCache.ts
```

这些日志是临时诊断，不属于常驻日志。实现重构时可以先保留用于对比改造前后耗时；交付或提交前默认删除，除非用户明确要求保留。

注意：`useWaveformPreview.ts` 因临时日志超过 1100 行。调试期间可以暂时接受，但交付或提交前要删除临时日志；删除后如果仍超过 1100 行，再按仓库规则拆分。

## 未定事项

这些点还没最终拍板，实现前可以按代码约束选择保守方案：

- surface payload 是否压缩，以及用哪种压缩。
- `globalOverview` 是否保留 `overviewTop / overviewBottom` 双侧字段，还是只存 mono height。
- IPC 是直接改名，还是先保留旧名作为兼容壳。
- 缺失 surface 时由哪个模块做 enqueue 去重，避免列表滚动重复排队。

不要因为这些未定项推翻已定主方向：运行时读轻量 surface，禁止读时解压统一详情。
