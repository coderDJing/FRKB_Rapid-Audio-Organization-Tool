# 横向浏览双轨大波形视觉缓存重构方向

## 结论

横向浏览双轨大波形 detail lane 要从“运行时 live raw stream + 滚动窗口 + 局部补帧”改成“分析阶段生成 display-domain 视觉波形缓存，运行时按时间轴读取缓存并构建稳定 strip”。

500KB 不是这个重构的核心收益，而是第一版低体积缓存的工程约束。真正收益是把 seek、短拖、向前回拉、播放滚动从 raw stream 状态机里解耦，让大波形本体变成稳定的显示资产。

```text
分析阶段:
  音频 -> 视觉包络特征 -> 分块压缩落盘

运行时:
  当前时间 / viewport -> 读取可见 chunk -> 构建稳定 strip -> viewport 平移 / 切换 strip
```

波形准备好就整窗显示；没准备好时只隐藏不可靠的 waveform shape。grid、playhead、cue、loop 等覆盖层继续按时间轴正常滚动，不能被波形加载状态绑架。

## 当前问题

当前大波形路径围绕 live raw stream 运行：

- seek 或拖拽到未覆盖区域时，需要重启或续接 raw stream。
- 播放中可见窗口移动，会持续触发 raw 数据覆盖判断、局部补帧和 canvas 提交。
- renderer / worker 需要维护 retained raw、dirty range、stream coverage、旧帧保留等状态。
- 前方 raw 数据没续上时，容易出现黑屏、半帧、旧位置波形残留或滚动卡住。
- waveform、grid、cue、loop 虽然都是时间轴信息，但现在容易被 waveform shape 的准备状态连带影响。

这不是单个 chunk 大小或某个 seek 分支能彻底解决的问题。根因是大波形本体还在运行时依赖 live raw stream，而不是依赖稳定的显示域缓存。

## 重构收益

### 用户体验收益

- seek、短拖、向前回拉时，不再等待 raw stream 重启或补齐，波形不会因为前方数据未续上而黑屏或卡住。
- 播放时大波形本体稳定，减少抖动、热气感、频闪和局部补帧造成的视觉跳变。
- 未命中波形缓存时，只隐藏不可靠的 waveform shape；grid、playhead、cue、loop 继续按时间轴工作。
- 已分析歌曲即使不播放、不 seek，也可以直接显示大波形。
- 用户看到的是诚实状态：可靠的时间轴信息继续显示，不可靠的波形形状不拿旧帧或半成品糊上去。

### 架构收益

- 双轨 detail lane 从 live raw stream 状态机里解耦，播放、seek、drag 只改变 viewport 时间。
- renderer 状态机从“补流 + 保帧 + 局部重画”收敛为 `missing / loading / ready`。
- waveform、grid、cue、loop 分层更清楚，metadata BPM / beat grid 调整只更新 grid，不重建 waveform。
- 缓存变成明确的 display-domain 产物，fingerprint、版本号、分析参数变化都可以清晰失效。
- 旧 raw stream 可以继续服务尚未迁移的功能，但不能再参与新双轨大波形的 seek、拖拽和播放滚动。

### 性能和稳定性收益

- 播放中不再因为可见窗口移动持续触发 raw stream 读取、复制和重采样。
- seek 到任意位置只读取有限 chunk 并重建 strip，不需要重新从音频或 raw window 建运行时数据。
- 单首普通歌曲缓存从当前 raw peaks 的 MB / 几十 MB 级，下降到约 500KB 目标级别。
- 降低主进程 worker、renderer worker、canvas 提交之间的时序耦合，减少黑屏、半帧、旧帧残留问题。
- 运行时可以围绕 chunk cache 和 strip cache 做明确的内存上限，而不是跟着播放窗口不断扩展 raw window。

## 第一版范围

第一版只覆盖：

- 横向浏览双轨大波形 detail lane。
- columns 视觉路径。
- 已分析歌曲的 display-domain 视觉缓存读取和 strip 呈现。

第一版不覆盖：

- 编辑模式大波形。
- mixtape timeline。
- 普通列表 waveform preview。
- song player 小波形。
- 采样级无限放大。

编辑模式不要顺手纳入第一阶段。编辑模式 zoom 更深，且 `full` layout 的视觉诉求不同，500KB compact 数据可能不够。等双轨 detail lane 稳定后，再决定编辑模式是复用 compact cache，还是使用更高保真的 detail cache。

## 缓存定位

缓存不是音频事实源，而是 `display-domain waveform`，也就是当前双轨大波形渲染需要的视觉中间结果。第一版建议命名为 `CompactVisualWaveformCacheV1`，避免和高保真 RGB stereo detail 方案混淆。

每首歌缓存包含：

```text
header:
  magic/version
  source file fingerprint
  duration
  analysis parameter version
  normalization reference
  detailRate
  chunkDuration
  chunk table

detailPeak:
  主轮廓，top/bottom uint8

detailBody:
  内部厚度 / 密度 / 能量感，低频率 uint8

colorIndex:
  RGB 质感索引，第一版建议 uint8

overview:
  低精度全局概览，用于远景和快速定位
```

`detailPeak` 保鼓点、瞬态和外轮廓。`detailBody` 保波形里面的肉感，避免只靠 peak 把持续响的段落和偶发尖峰画得太像。`colorIndex` 不存完整 RGB，而是存颜色类别，渲染时再按主题和强度映射到实际颜色。

## 取舍边界

为了把普通歌曲压到约 500KB，第一版 compact cache 明确做这些取舍：

- 不存 PCM 级 raw 数据。
- 不存 Float32 raw peaks。
- 不存 stereo；左右声道先合成成视觉 mono。
- 不存完整 RGB；颜色压成 `colorIndex`。
- 不保证超长曲也维持同样 detailRate。

因此会失去：

- 左右声道差异。
- 极高倍率下的采样级纹理。
- 完整频谱或完整 RGB 的精细变化。

这些损失对第一阶段双轨 detail lane 可以接受，但不能把这份 compact cache 直接当成编辑模式高倍率波形的最终答案。

## 500KB 体积模型

500KB 应定义为“普通 5 到 8 分钟歌曲的压缩后目标值”，不是所有音频的绝对硬承诺。超长曲、异常动态、压缩失败、header 扩展都会影响体积。

第一版按自适应 `detailRate` 控制体积。先扣掉 overview、header、chunk table 和预留空间，再计算 detail rate。

```text
targetBytes = 500 * 1024
overviewBytes = durationSec * 64
headerAndIndexBytes ~= 8KB
reserveBytes ~= targetBytes * 0.08

detailBudget = targetBytes - overviewBytes - headerAndIndexBytes - reserveBytes
detailRate = clamp(240, 600, floor(detailBudget / (durationSec * bytesPerDetailFrame)))

bytesPerDetailFrame ~= 2.3
```

`2.3 bytes/frame` 来自：

```text
detailPeak:
  top + bottom = 2 bytes/frame

detailBody:
  detailRate / 5
  平摊约 0.2 bytes/detail-frame

colorIndex:
  detailRate / 5, uint8
  平摊约 0.2 bytes/detail-frame

分块压缩后:
  peak/body/color 的重复和低熵数据应抵消部分 header/index 开销
```

overview 单独按低 fps 存：

```text
overview:
  32fps, top/bottom uint8
  64 bytes/sec
```

典型目标：

```text
5:00 歌曲:
  detailRate 目标 600fps
  压缩前 detail 约 414KB
  overview 约 19KB
  加 header/index/reserve 后依赖压缩落入 500KB 目标

6:45 歌曲:
  detailRate 目标约 450fps
  压缩前 detail 约 419KB
  overview 约 25KB
  加 header/index/reserve 后依赖压缩落入 500KB 目标

8:00 歌曲:
  detailRate 目标约 360fps
  压缩前 detail 约 397KB
  overview 约 30KB
  加 header/index/reserve 后依赖压缩落入 500KB 目标
```

如果实现后实测压缩率不足，优先降低长曲 detailRate，而不是删除 `detailBody` 或把状态机退回半成品显示。体积是约束，可靠显示是底线。

## 分块和 strip 策略

缓存按时间分块，每块独立压缩和读取。

```text
chunkDuration:
  第一版建议 4s

chunk content:
  detailPeak slice
  detailBody slice
  colorIndex slice

overview:
  可单独全量读取
```

运行时不应每帧按当前 viewport 重新理解波形。正确路径是：

```text
visible range / prefetch range
-> 读取覆盖范围内的 chunk
-> worker 构建一条稳定 strip
-> 播放时只移动 viewport offset
-> 接近 strip 边缘时后台构建下一条 strip
-> 新 strip 完整覆盖后原子切换
```

seek 到 strip 内部时只更新 viewport offset。seek 到 strip 外部时进入 `loading`，清掉旧位置 waveform shape，保留可靠 overlay，等新 strip 完整覆盖后再提交。

## 视觉生成规则

分析阶段要复用当前大波形的 DJ 可读性，而不是只做普通 min/max：

- 使用固定参考缩放，避免载入、播放、seek 后高度漂移。
- 保留 attack 音头，后半段做轻度 tail smoothing。
- 将当前 energy/body 算法烘焙进 `detailBody`。
- 将当前 RGB/频段感压成 `colorIndex`，运行时按主题调色板还原。
- 视觉 mono 合成时要保留左右声道最大能量，不要简单平均到鼓点变矮。

验收时不要只看“有轮廓”，要看鼓点起点、整体高度、内部密度和颜色质感是否仍然有 DJ 可读性。

## 运行时状态机

新状态机应保持很薄：

```text
missing:
  没有缓存或版本过期，只显示 grid/cue/playhead，不画 waveform shape

loading:
  正在读取 chunk 或构建 strip，旧波形不用于新时间段

ready:
  当前 strip 完整覆盖 viewport，一次性提交 waveform shape 并淡入
```

禁止出现：

- 一半新波形、一半空洞。
- seek 后 grid 等覆盖层等待波形淡入。
- 拖拽向前时因为前方 raw 数据没续上导致滚动停止。
- 播放中为了补 waveform 重启 live raw stream。
- 用旧位置波形假装新位置已 ready。

## 与当前 raw stream 的边界

新缓存命中后，双轨大波形 detail lane 不再走 live raw stream。旧 raw stream 可以保留给尚未迁移的功能，但不能参与新双轨大波形的 seek、拖拽和播放滚动。

未分析歌曲不临时画低可信半成品波形，只显示非波形覆盖层，并把歌曲加入分析队列。分析完成后写入视觉缓存，再通知 renderer 刷新。

## 实施步骤

1. 定义 `CompactVisualWaveformCacheV1` 类型、版本和落盘格式。
2. 写离线原型，生成 5:00、6:45、8:00 样本缓存，验证体积和 contact sheet 视觉效果。
3. 在分析阶段生成 `detailPeak/detailBody/colorIndex/overview`。
4. 新增主进程 cache read IPC：按 track id + visible/preload range 读取 chunk。
5. renderer 建立只读 visual cache store，负责 chunk 命中和版本判断。
6. 新增 canvas worker strip 路径：从 visual cache chunk 构建 strip，再 present viewport。
7. 通过开关只让双轨 detail lane 使用新路径，seek / drag / playback 只改变 viewport 时间。
8. 稳定后删除双轨 detail lane 对 live raw stream 的依赖，保留其它未迁移功能的旧路径。

## 验收标准

- 已分析歌曲载入后，不播放、不 seek，也能显示大波形。
- seek 后 grid、playhead、cue、loop 立即按新时间轴显示并继续滚动。
- 波形未完整准备好时不显示半成品，准备好后整窗淡入。
- 短距离拖拽不触发黑屏等待；向前拖不会出现前方波形缺失导致滚动卡死。
- 播放中不因大波形可见窗口移动而重启 live raw stream。
- 播放 30 秒无持续抖动、热气感、频闪。
- 选取 5 分钟、6 分 45 秒、8 分钟样本，缓存体积落入 500KB 目标模型。
- 与当前视觉对比，鼓点起点、整体高度、内部密度和颜色质感没有明显退化。
- light / dark theme 下 waveform 背景、颜色、grid、cue、loop 都正常。

## 待确认问题

- `colorIndex` 是否接受第一版用 uint8。建议先用 uint8 保调色空间，体积实测不达标再压到 4-bit。
- `chunkDuration` 是否接受第一版用 4s。4s seek 更细，索引开销可控。
- 500KB 是否定义为普通歌曲目标值。建议不要做所有音频的绝对硬限制。
- 长曲低于 240fps 时是否直接接受更粗视觉，还是允许缓存超过 500KB。
- 编辑模式后续是复用 compact cache，还是单独做高保真 RGB stereo detail cache。
