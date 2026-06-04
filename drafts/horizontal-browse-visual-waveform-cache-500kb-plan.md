# 500KB 视觉波形缓存草案

## 结论

大波形要从“运行时 live raw stream + 滚动窗口”改成“分析阶段生成视觉波形缓存，运行时按时间轴读取缓存绘制”。

500KB 预算下不存 PCM 级 raw 数据，也不存 stereo/full float。缓存只服务绘图：

```text
分析阶段:
  音频 -> 视觉包络特征 -> 分块压缩落盘

运行时:
  当前时间 / viewport -> 读取可见时间段缓存 -> canvas worker 绘制
```

这样可以把 seek、短拖、向前拖、播放滚动从 raw stream 状态机里解耦。波形准备好就整窗显示，没准备好就只隐藏波形本体；grid、playhead、cue、loop 等覆盖层继续按时间轴正常滚动。

## 目标

- 单首普通歌曲的视觉波形缓存目标小于 `500KB`。
- 大波形视觉尽量贴近当前效果，而不是退化成干瘪的纯 peak 轮廓。
- seek / 拖拽 / 播放滚动不再触发 raw stream 重启。
- 不显示半成品波形：当前可见窗口未完整命中缓存时，不提交新波形画面。
- 不影响音频播放线程和 transport 稳定性。

第一版只覆盖横向浏览双轨大波形 detail lane。编辑模式和其它小波形可以复用格式，但不放进第一阶段硬目标。

## 缓存语义

缓存不是音频事实源，而是 display-domain waveform，也就是当前大波形渲染需要的视觉中间结果。

每首歌缓存包含：

```text
header:
  magic/version
  source file fingerprint
  duration
  analysis parameter version
  normalization reference
  detailRate
  chunk table

detailPeak:
  主轮廓，top/bottom uint8

detailBody:
  内部厚度 / 密度 / 能量感，uint8

colorIndex:
  RGB 质感索引，4-bit 或 uint8

overview:
  低精度全局概览，用于初始秒显和远景
```

`detailPeak` 保鼓点、瞬态和外轮廓。`detailBody` 保波形里面的肉感，避免只靠 peak 把持续响的段落和偶发尖峰画得太像。`colorIndex` 不存完整 RGB，而是存颜色类别，渲染时再按主题和强度映射到实际颜色。

## 500KB 体积模型

500KB 版本采用自适应 `detailRate`，按歌曲时长动态决定精度。短歌给高精度，长歌自动降一点，保证缓存体积稳定。

建议第一版公式：

```text
detailRate = clamp(300, 600, floor(availableBytes / (durationSec * bytesPerDetailFrame)))

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
  detailRate / 5, 4-bit
  平摊约 0.1 bytes/detail-frame
```

overview 单独按低 fps 存：

```text
overview:
  32fps, top/bottom uint8
  64 bytes/sec
```

典型预算：

```text
5:00 歌曲:
  detailRate 可到 600fps
  detail: 600 * 2.3 * 300s = 414KB
  overview: 64 * 300s = 19KB
  压缩前约 433KB + header

6:45 歌曲:
  detailRate 约 480fps
  detail: 480 * 2.3 * 405s = 447KB
  overview: 64 * 405s = 25KB
  压缩前约 472KB + header

8:00 歌曲:
  detailRate 约 360fps
  detail: 360 * 2.3 * 480s = 397KB
  overview: 64 * 480s = 30KB
  压缩前约 427KB + header
```

落盘再做分块压缩，正常会低于上述压缩前估算。压缩不是用来救超标设计，而是留给 header、chunk table、异常音频和版本字段的余量。

## 分块策略

缓存按时间分块，每块独立压缩和读取。

```text
chunkDuration:
  4s 或 8s

chunk content:
  detailPeak slice
  detailBody slice
  colorIndex slice

overview:
  可单独一块全量读取
```

运行时只需要读取当前可见窗口和少量前后预读块。seek 到任意位置时，磁盘读取是按 chunk table 定位，不需要重建 raw stream。

## 视觉生成规则

分析阶段要尽量复用当前大波形的视觉逻辑，而不是只做普通 min/max：

- 使用固定参考缩放，避免载入、播放、seek 后高度漂移。
- 保留 attack 音头，后半段做轻度 tail smoothing。
- 将当前 energy/body 算法烘焙进 `detailBody`。
- 将 RGB/频段感压成 `colorIndex`，运行时按调色板还原。
- 不缓存 stereo。左右声道先合成成视觉 mono，避免体积翻倍。

这会比纯 `mono min/max` 更接近当前视觉效果。损失主要是：

- 看不到左右声道差异。
- 极高倍率下没有采样级纹理。
- RGB 颜色是分类近似，不是完整频谱或完整 RGB。

这些损失不影响当前横向浏览大波形的核心体验。

## 运行时状态机

新状态机应保持很薄：

```text
missing:
  没有缓存或版本过期，只显示 grid/cue/playhead，不画波形

loading:
  正在读取可见 chunk，旧波形不用于新时间段

ready:
  当前可见窗口完整命中缓存，一次性提交波形并淡入
```

禁止出现：

- 一半新波形、一半空洞。
- seek 后 grid 等覆盖层等待波形淡入。
- 拖拽向前时因为前方 raw 数据没续上导致滚动停止。
- 播放中为了补 waveform 重启 raw stream。

## 与当前 raw stream 的边界

新缓存命中后，大波形 detail lane 不再走 live raw stream。旧 raw stream 可以保留给尚未迁移的功能，但不能参与新大波形的 seek、拖拽和播放滚动。

未分析歌曲不临时画低可信半成品波形，只显示非波形覆盖层，并把歌曲加入分析队列。分析完成后写入视觉缓存，再通知 renderer 刷新。

## 实施步骤

1. 定义 `VisualWaveformCacheV1` 类型和落盘格式。
2. 在分析阶段生成 `detailPeak/detailBody/colorIndex/overview`。
3. 新增主进程 cache read IPC：按 track id + visible range 读取 chunk。
4. renderer 建立只读 visual cache store，负责 chunk 命中判断。
5. canvas worker 改为从 visual cache 画大波形。
6. seek / drag / playback 只改变 viewport 时间，不触发 raw stream。
7. 通过开关只让双轨 detail lane 使用新路径，稳定后再移除旧路径依赖。

## 验收标准

- 已分析歌曲载入后，不播放、不 seek，也能显示大波形。
- seek 后 grid、playhead、cue、loop 立即按新时间轴显示并继续滚动。
- 波形未完整准备好时不显示半成品，准备好后整窗淡入。
- 短距离拖拽不触发黑屏等待；向前拖不会出现前方波形缺失导致滚动卡死。
- 播放中不因大波形可见窗口移动而重启 live raw stream。
- 选取 5 分钟、6 分 45 秒、8 分钟样本，缓存体积分别落在预算模型内。
- 与当前视觉对比，鼓点起点、整体高度、内部密度和颜色质感没有明显退化。

## 待确认问题

- `colorIndex` 第一版用 4-bit 还是 uint8。4-bit 更省体积，uint8 更方便调色。
- `chunkDuration` 取 4s 还是 8s。4s seek 更细，8s 文件索引更小。
- 500KB 是按压缩后文件大小硬限制，还是按普通歌曲目标限制。建议第一版按压缩后硬限制，超长曲自动降低 `detailRate`。
- 编辑模式是否第一阶段同步迁移。建议先把双轨 detail lane 做稳，再迁移编辑模式。
