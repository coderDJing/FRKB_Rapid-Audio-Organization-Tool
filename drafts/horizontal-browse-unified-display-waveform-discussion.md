# 横向浏览统一 display waveform 讨论草案

## 结论

大波形应该从“双轨模式一套、编辑模式一套”的实现，收敛到 rekordbox 式的曲目级 display-domain waveform：

```text
一首歌分析一次
-> 生成统一的显示域 waveform detail
-> 单轨 / 双轨 / 编辑模式都消费同一份 detail
-> 各模式只改变 viewport、zoom、layout、overlay 和裁剪方式
```

第一版不再把“双轨大波形必须是独立半波形柱状图”当硬约束。双轨模式可以继续显示成半波形，但半波形只是同一份全波形的显示裁剪结果，不是另一套数据，也不是另一套 raw stream。

## 逐项讨论记录

后续按下面顺序逐项确认。每确认一项，就把状态从 `待讨论` 改成 `已确认`，并把实现边界写清楚。

| 序号 | 议题 | 状态 | 当前倾向 |
| --- | --- | --- | --- |
| 1 | 统一 detail 精度 | 已确认 | `1200 segments/s`，目标最大可靠 zoom 为 `2 秒 / 屏` |
| 2 | 每个 detail frame 存什么 | 已确认 | mono display waveform；`height/attack/colorIndex` 全速，`body` 四分之一速 |
| 3 | 全波形渲染方式 | 已确认 | 继承现有 `raw-curve` 连续全波形方向，但数据源改为统一 display detail |
| 4 | 双轨半波形策略 | 已确认 | 从 mono height 镜像成完整连续全波形，再按中线硬裁为上 / 下 lane；禁止回到 columns/bar 半波形 |
| 5 | zoom 上限规则 | 已确认 | 编辑 `2 秒 / 屏`，双轨 `4 秒 / 屏`，按 detail density 解释 |
| 6 | 体积预算 | 已确认 | 普通歌曲目标 `500KB~1MB+`，不为 500KB 牺牲攻击头，不对超长歌降精度 |
| 7 | 旧缓存和迁移 | 已确认 | 旧缓存直接视为新 detail 缺失；打开歌单触发新分析并清旧缓存 |
| 8 | 未分析 / 分析中显示 | 已确认 | 缺 detail 时 shape 不显示；分析不阻塞播放；完成后原子显示 |
| 9 | 验证标准 | 已确认 | 用真实歌曲验证体积、seek、播放滚动、攻击头和双轨/编辑一致性 |

## 讨论背景

当前 FRKB 大波形问题不是某个 seek 分支没补好，而是模型本身不稳：

- 双轨模式和编辑模式存在不同的大波形路径。
- 编辑模式尝试按窗口加载高精度 raw waveform，播放和高倍拖动很难同时稳定。
- 播放中 seek / 拖拽 / zoom 容易触发 loading、暂停、黑屏、旧帧残留。
- 半波形柱状图在高放大倍率下会把离散采样暴露成楼梯感。

rekordbox 的启发不是照搬 ANLZ 文件格式，而是学习它的数据边界：分析阶段生成可显示的 waveform detail，运行时按时间轴显示，不在播放中不断重新解码或续 raw window。

## 已查证的 rekordbox 关键点

公开逆向资料和手册能支撑这些判断：

- rekordbox 的 ANLZ 分析文件是按曲目组织的 `.DAT/.EXT/.2EX` 文件族，不是按 1PLAYER / DUAL PLAYER / EDIT 模式分别存波形。
- `.EXT` 中的 `PWV4/PWV5` 这类 color waveform 是显示域数据；`.2EX` 中的 `PWV6/PWV7` 是另一个硬件世代 / 3-band 方向，不是双轨专用格式。
- `PWV5` detail 公开资料显示每秒约 150 entries，并且每个 entry 只存压缩后的高度和颜色信息。这说明 rekordbox 小体积来自显示域摘要，而不是高频 Float32 raw peaks。
- rekordbox 的单轨 / 双轨只是 UI layout 和 player panel 组合，曲目 waveform information 是分析结果本身。

参考资料：

- Deep Symmetry ANLZ 逆向文档：`https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html`
- pyrekordbox ANLZ 文档：`https://pyrekordbox.readthedocs.io/en/stable/formats/anlz.html`
- rekordbox manual：`https://cdn.rekordbox.com/files/20200522203309/rekordbox6.0.1_manual_EN.pdf`

## 为什么 rekordbox 小体积但不明显糊

核心不是它存了无限精度，而是它把问题限制在 DJ display waveform 上：

1. 存显示结果，不存 raw facts。
   - 它关心这一列画多高、什么颜色、在哪个时间点。
   - 它不把整首歌的高频 Float32 min/max/mean/rms 全塞进缓存。

2. 控制可视 zoom 范围。
   - DJ 波形要看鼓点、能量、段落和攻击头，不是 DAW 级采样编辑。
   - 超过显示域 detail 能表达的 zoom，继续放大只是在制造假精度。

3. 用连续轮廓和抗锯齿掩盖离散采样。
   - 全波形可以由 mono height 镜像出正/负包络，再形成连续 path。
   - 柱状半波形会更容易把每个采样 frame 暴露成台阶。

这说明 FRKB 也能做到小体积，但不能继续用 raw waveform 的思维做小体积。

## 全波形替代半波形

本次讨论形成的新判断：

```text
大波形统一按全波形建模。
双轨模式需要半波形观感时，第一版固定从完整连续全波形按中线硬裁得到。
这里的“半波形”只是 viewport / clip 的结果，不是柱状半波形，也不是另一种 renderer。
```

也就是说，缓存的主语义是曲目级 mono display detail，renderer 再从 `height` 派生完整连续 waveform geometry：

```text
height envelope (mono)
body / density
attack / onset
colorIndex / color

derived render geometry:
  positive envelope
  negative envelope
```

这里的 `positive/negative envelope` 只是同一条 waveform 的几何上下边，不是双轨 UI 的上 deck / 下 deck。

显示时分三种：

- 单轨大波形：显示完整全波形。
- 编辑模式：显示完整连续全波形，允许更高 zoom，但不超过 detail 的可靠表达范围。
- 双轨模式：把同一条完整连续全波形按中线硬劈一半显示成上 / 下半波形；第一版不使用压缩全波形替代，不使用 columns/bar 大波形。

关键边界：

- 半波形是 display mode，不是 cache format。
- 双轨半波形不再走独立柱状图 renderer。
- 双轨和编辑的大波形必须是同一类连续 curve/path 视觉，只是 layout / clip 不同。
- 不为半波形额外生成一份专用 waveform。
- 不因为双轨布局牺牲统一 waveform detail 的数据模型。

## 现有编辑模式 raw-curve 的关系

现有编辑 / beat-align 预览路径已经有 `raw-curve` 渲染形态，不是纯柱状图。双轨大波形也应该继承这个“连续曲线”的视觉方向，只是从完整波形中线硬裁为半波形。当前代码路径大致是：

```text
MixtapeBeatAlignDialog.vue
-> useHorizontalBrowseRawWaveformCanvas(...)
-> waveformLayout = full
-> waveformRenderStyle = raw-curve
-> beatGridWaveformRenderer.ts / drawRawCurveWaveform(...)
```

这说明“全波形连续显示”在 FRKB 里不是全新概念，可以作为后续 renderer 设计的参考。

但现有 `raw-curve` 不能直接当成最终统一方案，原因是：

- 它仍然依赖 `RawWaveformData`，本质上还是 raw window / raw cache 体系。
- 它按当前屏幕 `x` 逐列取 raw peaks，再用 stroke 连线，不是从曲目级 display detail 构建稳定全波形资产。
- 它画的是每个像素列内 `max -> min` 的短线段串联，不是由统一 `height` detail 派生出的连续闭合 path/fill。
- 它没有解决双轨和编辑共用同一份曲目级 waveform detail 的问题。

所以后续目标不是推翻 `raw-curve` 的视觉经验，而是把它的“连续全波形”方向迁移到新的统一 display waveform 上，并同时覆盖编辑模式和双轨模式：

```text
旧:
  rawData window -> per-screen-x peaks -> stroke raw curve

新:
  unified display detail -> derived positive/negative envelope -> continuous path/fill
```

可以复用的经验：

- full waveform 比 columns 更不容易暴露楼梯感。
- `lineJoin/lineCap/imageSmoothing` 对放大观感有价值。
- 颜色可以沿时间轴变化，但不应每根柱子单独决定主形状。

不能继续沿用的部分：

- 播放或 seek 中按 viewport 续 raw window。
- 把编辑模式和双轨模式拆成两套波形数据源。
- 用缺失 raw window 决定 waveform shape 是否可显示。

## “硬劈一半”的显示策略

双轨模式如果继续要半波形外观，推荐做法是：

```text
统一 mono height detail -> 镜像成完整连续全波形 -> 按 lane 需求裁剪上半或下半
```

这里的“硬劈一半”定义必须明确：

```text
先得到完整连续 waveform curve/path
-> 以中心线为裁剪边界
-> top deck lane 只显示上半
-> bottom deck lane 只显示下半
```

因此双轨模式的最终视觉不是 bar / columns。columns 只能作为旧实现或临时调试参考，不能作为统一 display waveform 的验收形态。

这样用户看到的仍然像半波形，但底层不是半波形柱状图：

- 攻击头位置来自同一份全波形 detail。
- 颜色和 body 表达来自同一份 detail。
- 单轨 / 双轨 / 编辑模式不会出现两套波形视觉割裂。
- 裁剪出来的半波形边缘必须走连续 path 和抗锯齿。
- 不存左右声道，也不存半波形专用缓存。

如果后续实测发现裁剪半波形仍然不如压缩全波形清楚，双轨模式可以另开视觉实验直接显示压缩高度的全波形。这个不属于第一版实现，不能被当成默认方案，也不能借此回到 columns/bar renderer。

## 已确认：detail 精度和字段

### detail 精度

统一 waveform detail 的第一版精度定为：

```text
detailRate = 1200 segments/s
目标最大可靠 zoom = 2 秒 / 屏
```

按 1200px 宽屏估算，2 秒 / 屏时约有 2 个 detail points / pixel。低于这个密度继续放大，视觉上容易暴露假精度和楼梯感，因此第一版不继续支持更细 zoom。

### detail frame 字段

第一版采用小体积 packed 折中方案：

```text
analysis input:
  stereo audio -> mono display envelope

full-rate: 1200/s
  height: Uint8
  attack: Uint8
  colorIndex: Uint8

quarter-rate: 300/s
  body: Uint8
```

这样保留 DJ 可读性最敏感的外轮廓和攻击头：

- 第一版是 mono display waveform，不存左右声道两套 detail。
- `height` 是同一个 mono waveform 的显示高度，渲染时上下镜像生成全波形。
- `height` 全速，保证波形轮廓和鼓点位置不被低频采样糊掉。
- `attack` 全速，保证 kick/snare 等瞬态强调有足够时间精度。
- `colorIndex` 全速，保证颜色变化跟随主轮廓，实际 RGB 由渲染 palette 映射。
- `body` 四分之一速，表达内部厚度 / 能量密度，降低体积。

相比 stereo detail，这已经直接省掉左右声道维度。不要再设计：

```text
leftTop / leftBottom / rightTop / rightBottom
```

除非后续明确要显示左右声道差异，否则统一大波形不存 stereo。

`height` 方案比分别存上下包络更接近 rekordbox 公开资料里的 display height 思路，体积更小，显示也更稳定。它会丢掉 mono min/max 的上下不对称，但这部分信息对 DJ 读鼓点、能量、段落的价值较低，第一版不保留。

体积估算：

```text
full-rate:
  1200 * 3 bytes/s = 3600 bytes/s

quarter-rate body:
  300 * 1 byte/s = 300 bytes/s

total:
  3900 bytes/s
  约 234KB/min 压缩前
  约 1.17MB/5min 压缩前
```

压缩后普通歌曲目标落在约 `500KB~1MB+`。后续可以再评估 body/attack 事件编码或更强压缩，但第一版不牺牲 `height/attack` 的全速精度。

体积预算不是硬上限：

```text
普通歌曲:
  目标约 500KB~1MB+

超长歌曲:
  按时长自然变大
  不做降 detailRate 的特殊逻辑
```

第一版所有歌曲统一 `1200/s`。不再为了把所有时长都塞进固定 500KB 而降低长曲精度，也不为体积牺牲攻击头可读性。

## 统一缓存建议

新缓存应命名和语义上明确区别于旧 raw cache：

```text
UnifiedDisplayWaveformDetailV1
```

建议字段：

```text
header:
  version
  parameterVersion
  duration
  detailRate
  overviewRate
  file fingerprint
  normalization reference

detail:
  height: Uint8，全速 1200/s
  attack: Uint8，全速 1200/s
  colorIndex: Uint8，全速 1200/s
  body: Uint8，四分之一速 300/s

overview:
  低精度全局显示数据
```

`detail` 不包含双轨的 top / bottom deck 字段。双轨上下只属于 layout consumer：

```text
top deck lane:
  same UnifiedDisplayWaveformDetailV1 -> viewport/layout/crop

bottom deck lane:
  same UnifiedDisplayWaveformDetailV1 -> viewport/layout/crop
```

第一版 detail rate 建议继续围绕 `1200 segments/s` 评估。它比 rekordbox 公开资料中的 150/s 高很多，但仍然是显示域缓存，不会回到几十 MB raw Float32 的路线。

体积方向：

```text
600/s * 4 bytes * 300s  ~= 720KB 压缩前
1200/s * 4 bytes * 300s ~= 1.44MB 压缩前
```

压缩后普通歌曲有机会落到约 500KB 到 1MB 级。最终预算要用真实曲库实测，不再用 raw cache 的体积模型推断。

## 运行时模型

运行时不再做这些事：

- 播放中按 viewport 解码音频。
- 播放中续接 raw window。
- seek 后暂停播放等待 waveform window。
- 双轨和编辑各维护一套大波形状态机。

运行时应该只做：

```text
读取统一 waveform detail
-> 按当前 viewport / zoom 生成 strip 或直接绘制
-> 播放时移动 viewport
-> seek 时切换 viewport
-> zoom 时按锚点重建显示
```

strip 可以作为 worker 内的临时绘制缓存，但不落盘。落盘只存统一 display waveform detail。

## zoom 边界

双轨模式不应该承担编辑级无限 zoom：

- 双轨模式目标是播放、对齐、混音观察。
- 编辑模式目标是更细的 grid / cue / attack 判断。
- 两者可以共用一份 waveform detail，但 zoom 上限可以不同。

推荐规则：

```text
双轨模式:
  最大 zoom = 4 秒 / 屏。
  第一版固定显示从完整连续全波形中线硬裁出来的半波形。
  不使用 columns/bar renderer。
  不把压缩全波形作为默认方案。

编辑模式:
  最大 zoom = 2 秒 / 屏。
  不用 raw window 临时补“假高精度”。
```

这个边界来自 detail density，而不是拍脑袋的“倍数”：

```text
detailRate = 1200/s
编辑 2 秒 / 屏，1200px 宽时约 2 detail points / pixel
双轨 4 秒 / 屏，1200px 宽时约 4 detail points / pixel
```

如果窗口宽度变化，实现应按同一语义动态计算：

```text
minViewportSec = viewportWidthPx / maxPxPerSec
maxPxPerSec = detailRate / minReliablePointsPerPixel
minReliablePointsPerPixel = 2
```

双轨模式更保守，是因为它主要用于播放、对齐和混音观察，lane 高度更小，高倍率裁半显示收益有限。编辑模式才承担最细攻击头判断。

## 对现有实现的影响

这份草案意味着后续改造方向应该是：

1. 新增统一 display waveform detail cache。
2. 分析阶段生成这份 detail。
3. 双轨大波形改为消费统一 detail。
4. 编辑大波形改为消费同一份 detail。
5. 停止继续扩大 `mixtape_raw_waveform_cache` 和 raw stream 的职责。
6. 旧 raw / compact visual cache 不迁移、不兜底，直接按新 detail 缺失处理。
7. 打开歌单或加载歌曲发现新 detail 缺失时，触发新 waveform detail 分析。
8. 触发新分析时清理对应旧 waveform 缓存，避免历史脏数据继续影响视觉。

不要继续把问题拆成“双轨续流怎么补”和“编辑高精度怎么补”。正确边界是：播放和 waveform detail 解耦，所有大波形都消费同一份曲目级显示资产。

## 旧缓存处理

旧缓存策略：

```text
旧 mixtape_raw_waveform_cache:
  不迁移
  不作为新大波形兜底数据源
  发现新 detail 缺失时清理对应旧项

旧 compact_visual_waveform_cache:
  不作为统一大波形数据源
  如果参数版本不匹配，按缺失处理

新 UnifiedDisplayWaveformDetail:
  重新分析生成
```

触发时机：

```text
打开歌单 / 进入横向浏览 / 加载歌曲
-> 检查新 detail 是否存在且 fingerprint 匹配
-> 不存在则标记为待分析
-> enqueue waveform detail analysis
-> 清理对应旧 raw / compact visual waveform 缓存
```

这样历史数据不会在 UI 上混用，也不会出现低倍率旧波形、高倍率新波形的视觉割裂。

## 未分析 / 分析中显示

显示规则：

```text
新 detail 缺失:
  waveform shape 不显示
  显示待分析 / 分析中提示
  不显示旧缓存波形
  不显示半成品 chunk

新 detail 分析中:
  播放不暂停
  seek / cue / loop / grid 等可靠时间轴信息继续工作
  分析完成后原子切换到完整 waveform detail
```

优先级规则：

```text
最高:
  audio playback / seek / transport

其次:
  当前可见 / 当前加载歌曲的 waveform detail 分析

更低:
  后台歌单预分析
```

如果分析会抢音频播放资源，就排队等待，不为了 waveform 抢占播放线程。UI 要诚实显示缺失状态，而不是用旧帧、旧缓存或低精度半成品掩饰。

## 验证标准

### 缓存体积

用真实歌曲验证压缩后体积：

```text
样本:
  短歌
  约 5 分钟普通歌曲
  约 8 分钟歌曲
  动态强的歌曲
  电子鼓攻击头明显的歌曲

目标:
  普通歌曲约 500KB~1MB+
  超长歌曲按时长自然增长
```

### 显示一致性

```text
同一首歌同一时间点:
  编辑模式
  双轨上 deck
  双轨下 deck

必须满足:
  waveform 攻击头位置一致
  color/body 观感一致
  不出现低倍率旧波形、高倍率新波形的割裂
```

### 播放连续性

```text
缺 detail:
  播放不暂停
  seek 不等待 waveform

分析中:
  播放不暂停
  waveform 完成后原子显示

播放中 seek:
  音频先正确跳转
  waveform 不因为加载状态回抽或清屏闪烁
```

### 双轨模式

```text
最大 zoom:
  4 秒 / 屏

必须满足:
  双轨大波形视觉是连续 curve/path，不是 columns/bar
  top deck 显示同一完整波形的上半裁剪
  bottom deck 显示同一完整波形的下半裁剪
  裁半半波形不出现明显柱状楼梯感
  上下 deck 同时播放时滚动稳定
  不触发 raw stream loading / 续流
```

### 编辑模式

```text
最大 zoom:
  2 秒 / 屏

必须满足:
  攻击头位置可读
  高倍播放不触发频繁 loading / 清屏
  seek 后 waveform 和音频时间一致
```

### 旧缓存行为

```text
老歌单打开:
  旧 raw / compact cache 不显示为新大波形
  自动触发新 detail 分析
  对应旧缓存被清理或失效
```

### 日志

```text
排查期:
  可以保留临时 log.txt 链路日志

稳定交付前:
  清理非错误常驻日志
```
