# 大波形 RGB detail + strip 重构方案

## 结论

横向浏览和编辑模式的大波形不再沿用当前“播放帧按 viewport 重采样 raw waveform”的实现。新方案采用 DJ 软件式架构：

```text
分析阶段生成 RGB display-domain waveform detail
-> 运行时按当前窗口附近生成静态长条 strip
-> 播放 / seek / zoom 只移动 viewport 或切换 strip
```

长期缓存不存高频 Float32 raw peaks，也不存最终 bitmap。缓存的是最终显示用的 RGB 波形 detail：体积可控、可分块读取、可从音频重新分析生成。

第一版覆盖：

- 双轨模式大波形 detail lane。
- 编辑模式大波形 detail lane。

第一版不覆盖：

- mixtape timeline。
- 普通列表 waveform preview。
- 其它小波形 / overview waveform。

## 已确认决策

1. **detail 精度**：默认 `1200 segments/s`。
2. **声道信息**：保留 stereo，不合成 mono。
3. **波形类型**：做 RGB waveform，不做 3-band waveform。
4. **最大 zoom**：最细一屏 `2s`。
5. **视觉过渡**：不做“先粗后细”。已分析歌曲直接显示最终精度；未命中最终 detail 时只隐藏不可靠信息。
6. **seek 未命中**：不显示旧位置波形，不显示半成品；波形 shape 进入 empty-detail 状态。
7. **tempo 语义**：deck tempo / playbackRate 改变时，波形和 grid 在 visual-time 上伸缩，但屏幕滚动速度不变。
8. **metadata BPM 语义**：metadata BPM / beat grid 编辑不改变声音速度，不重建 waveform，只更新 grid。
9. **分析优先级**：音频播放正确性最高；当前播放 deck 的 detail/grid/key 高于已加载 deck，高于可见列表，高于后台库。
10. **旧 raw cache**：对新 RGB detail 方案无用，不迁移；新 detail 建好后自动清理对应旧 raw cache。

## 背景问题

当前大波形播放态的核心问题不是单个 seek 状态或某个 raw chunk 缺失，而是底层模型天然不稳：

- 播放中每帧按当前 viewport 重新采样并重画波形。
- 波形是 1px 级高频柱状纹理，对亚像素采样、颜色混合、帧提交时序非常敏感。
- 整数采样不热气，但会产生像素步进抖动。
- 线性插值能缓解步进，但柱高和颜色每帧变化，会产生热气感。
- CSS transform 或 worker drawImage 小数补偿仍建立在“当前 viewport 逐帧生成”上，不能从根上消除 artifact。

所以继续补当前路径，只会在“抖动、热气、频闪、追速”之间来回打架。底层要改成：波形本体稳定，播放时只移动观察窗口。

## rekordbox 启示

本方案参考 rekordbox 的公开逆向思路，但不照搬文件格式。

参考资料：

- Deep Symmetry rekordbox ANLZ 逆向文档：`https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html`
- pyrekordbox ANLZ 文档：`https://pyrekordbox.readthedocs.io/en/stable/formats/anlz.html`
- AlphaTheta 官方 waveform color 说明：`https://support.alphatheta.com/en-US/articles/8113178546201`

rekordbox 的关键点是：分析文件里存的是可显示 waveform detail，而不是播放时实时从 PCM/raw peaks 重新理解波形。

公开逆向资料里，RGB/color waveform 和 3-band waveform 是两套不同数据：

- RGB/color waveform 对应 `.EXT` 中的 `PWV4` / `PWV5` 一类 color detail。
- 3-band waveform 对应 `.2EX` 中的 `PWV6` / `PWV7` 一类 low/mid/high detail。

FRKB 第一版只参考 RGB/color detail 思路，不做 3-band。

我们获得：

- 播放平移稳定，不再每帧重采样高频纹理。
- 缓存体积从 raw peaks 的几十 MB / 首降到 MB 级 / 首。
- seek 命中时直接显示正确 detail；未命中时不显示错误波形。
- grid、cue、loop、waveform 分层，减少互相打架。

我们失去：

- 不追求采样级无限放大。
- waveform detail 是显示域摘要，不是 PCM 原始事实的完整表达。
- 未分析歌曲必须等待最终 RGB detail，不能用低精度波形先糊上。

这些取舍已经确认可接受。

## 数据模型

### RGB detail cache

长期缓存存 RGB display-domain detail。建议第一版格式：

```text
rate:
  1200 segments/s

per segment:
  leftMin: Int16
  leftMax: Int16
  rightMin: Int16
  rightMax: Int16
  rgb: Uint24 或 3 * Uint8

chunk:
  2s~8s 一个 chunk
  每个 chunk 独立读取 / 重建
```

`leftMin/leftMax/rightMin/rightMax` 表达左右声道形状。`rgb` 表达最终显示颜色。RGB 可以由频谱/能量分析生成，但缓存语义叫 RGB waveform，不叫 3-band。

体积估算：

```text
shape:
  1200 * 4 * 2 = 9600 bytes/s

rgb:
  1200 * 3 = 3600 bytes/s

total:
  13200 bytes/s
  约 792KB/min
  约 3.8MB/5min
```

这个体积比现有 `4800Hz stereo min/max Float32` raw peaks 小很多。现有 raw peaks 约：

```text
4800 * 4 * 4 = 76800 bytes/s
约 4.4MB/min
约 22MB/5min
```

### 为什么不迁移旧 raw cache

旧 raw cache 只有振幅 min/max，没有可靠 RGB 颜色信息。即使拿它做形状，也仍然要重新分析音频生成 RGB。迁移复杂度高，收益低。

策略：

```text
新 RGB detail cache 重新分析生成。
旧 raw cache 不参与新渲染。
新 detail 对某首歌生成成功后，自动删除该歌旧 raw cache。
后台空闲时批量清理剩余旧 raw cache。
设置里可提供“清理旧波形缓存 / 重建 RGB 波形缓存”。
```

开发库数据没有保留价值，开发态允许直接清空旧 raw cache。

## 分析阶段

大波形最终 detail 纳入曲目分析完成定义：

```text
曲目分析完成:
  BPM / first beat / grid ready
  key ready
  overview waveform ready
  RGB detail waveform ready
```

优先级：

```text
最高:
  audio decode / transport / 播放正确性

高:
  当前正在播放 deck 的 RGB detail
  当前正在播放 deck 的 BPM/grid/key
  当前正在播放 deck 的 cue/loop hydration

中:
  已加载但未播放 deck 的 RGB detail/grid/key

低:
  可见列表预分析
  后台全库分析
  非当前 deck 的 hires/detail 补全
```

当前 deck 的分析可以抢后台任务，但不能抢音频播放线程和 transport 状态更新。

## 坐标系统

### audioSec 和 visualSec

声音以 `audioSec` 为准，画面以 `visualSec` 为准。

```text
audioSec:
  transport 的真实音频时间

visualSec:
  显示时间轴
  用于 strip、grid、cue、loop、viewport 坐标
```

简化公式：

```ts
visualSec = audioSec / visualPlaybackRate
x = (visualSec - viewportStartVisualSec) * pxPerVisualSec
```

这样 playbackRate 变快时，`audioSec` 前进更快，但 `visualSec` 被 rate 抵消，屏幕滚动速度保持稳定；波形和 grid 在视觉上压缩。

### 语义规则

```text
deck tempo / playbackRate:
  改变声音播放速度
  waveform 和 grid 在 visual-time 上压缩/拉伸
  屏幕滚动速度不变

metadata BPM / beat grid 编辑:
  不改变声音播放速度
  waveform 不变
  只更新 grid

master tempo:
  只影响音高保持算法
  不影响 audioSec -> visualSec 映射
  不影响滚动速度

sync / beat sync / nudge:
  最终都落到 playbackRate 或 currentSec 调整
  必须走同一套 visual-time 计算
```

### viewport

```text
pxPerVisualSec:
  当前 zoom 下，每秒 visualSec 对应多少 CSS px

viewportDurationVisualSec:
  viewportWidthCssPx / pxPerVisualSec

playheadRatio:
  播放头在 viewport 内的固定比例，通常 0.5

currentVisualSec:
  audioSecToVisualSec(currentAudioSec)

viewportStartVisualSec:
  currentVisualSec - viewportDurationVisualSec * playheadRatio
```

最大 zoom：

```text
最细一屏 2s
detail rate 1200/s
按 1200px 宽估算，约 2 detail points / pixel
```

## strip 渲染模型

### strip 范围

运行时不画整首歌，只画当前 viewport 附近的长条 strip：

```text
stripWidth = viewportWidth * 4
当前 viewport 起点放在 stripX = viewportWidth * 1.5
stripStartVisualSec = viewportStartVisualSec - stripX / pxPerVisualSec
stripDurationVisualSec = stripWidth / pxPerVisualSec
```

播放时：

```text
stripOffsetCssPx = (viewportStartVisualSec - stripStartVisualSec) * pxPerVisualSec
viewport 从 strip 的 stripOffsetCssPx 读取
```

接近 strip 边缘时，后台预构建下一条 strip：

```text
if stripOffsetCssPx < viewportWidth * 0.75:
  build left strip

if stripOffsetCssPx > stripWidth - viewportWidth * 1.75:
  build right strip
```

新 strip 完整 ready 后再原子切换。

### 正常播放

每帧只做：

```text
currentAudioSec
-> currentVisualSec
-> viewportStartVisualSec
-> stripOffsetCssPx
-> present viewport
```

禁止：

- 每帧重新采样 raw peaks。
- 每帧重新读取整首 detail。
- 用缺失 detail 的帧覆盖显示层。
- 为追上播放位置补动画。

### seek

声音优先：

```text
audio.seek(targetAudioSec)
```

画面：

```text
targetVisualSec = audioSecToVisualSec(targetAudioSec)

if currentStrip.contains(targetVisualSec):
  update stripOffsetCssPx
else:
  enter empty-detail for waveform shape
  build seek strip around targetVisualSec
  switch when ready
```

seek outside strip 时：

- 不显示旧位置波形。
- 不显示低精度替代。
- 不显示未覆盖 viewport 的半成品。
- 可靠 overlay 可以继续显示。

### zoom

滚轮缩放使用锚点：

```ts
anchorVisualSec = viewportStartVisualSec + mouseX / oldPxPerVisualSec
newViewportStartVisualSec = anchorVisualSec - mouseX / newPxPerVisualSec
```

缩放时可以短暂 transform 旧 strip 作为跟手反馈，但必须满足：

- 只用于同一语义位置。
- 不跨 seek 使用。
- 不把低精度 detail 当最终 detail。
- 新 strip ready 后原子替换。
- 如果 transform 会造成明显误导，优先进入 empty-detail。

### resize / visibility change / 拖动窗口恢复

恢复时不追速。按当前 transport snapshot 直接 present 最终位置：

```text
currentAudioSec
-> currentVisualSec
-> viewportStartVisualSec
-> present or rebuild
```

如果当前位置已经不在 strip 覆盖范围内，进入 empty-detail 或保留可靠 overlay，后台重建 strip，ready 后切换。

## 分层

### waveform layer

依赖：

- song/file identity
- RGB detail cache revision
- `stripStartVisualSec / stripDurationVisualSec`
- `pxPerVisualSec`
- visualPlaybackRate / tempo map
- canvas size / DPR
- layout: top-half / bottom-half / full
- theme palette

不依赖：

- metadata BPM
- first beat
- barBeatOffset

### grid layer

依赖：

- metadata BPM
- first beat / phase
- barBeatOffset
- timeBasisOffsetMs
- visualPlaybackRate / tempo map
- `viewportStartVisualSec / pxPerVisualSec`

metadata BPM 改动只更新 grid。deck tempo / playbackRate 改动时，grid 和 waveform 一起走 visual-time。

### cue / loop / marker layer

cue、hot cue、memory cue、loop 都是 audioSec 数据，绘制前转 visualSec：

```ts
x = (audioSecToVisualSec(markerAudioSec) - viewportStartVisualSec) * pxPerVisualSec
```

数量少，第一版不需要缓存成 strip，直接 overlay 绘制。

### playhead

playhead 固定在 viewport：

```text
playheadX = viewportWidthCssPx * playheadRatio
```

播放时移动 strip，不移动 playhead。

## 数据缺失时的功能规则

总原则：

```text
功能是否可用，只看它依赖的数据是否可靠。
不能因为波形 shape 未显示，就禁用有明确数学语义的时间轴操作。
能确定正确的就显示 / 允许；不能确定正确的就隐藏 / 禁用。
```

### detail waveform 未就绪

仍然允许：

- 点击波形区域 seek，只要 duration 和 transport ready。
- 拖拽 scrub，只要它按时间轴工作。
- 滚轮 zoom，只要 duration / viewport 映射可靠。
- 键盘 seek / 固定跳转。
- cue / loop / grid 操作，只要它们自己的数据可靠。

隐藏或禁用：

- 依赖波形形状的 hover 峰值/能量提示。
- 依赖波形 RGB 颜色的提示。
- 未来如果有“吸附到波形峰值”的操作，detail 未就绪时禁用。

### grid 未就绪

禁用：

- beat jump。
- bar jump。
- beat sync。
- quantize seek。
- beat-based loop 扩缩。
- grid snap。
- metronome。

保留：

- 普通播放。
- 普通 seek。
- 非量化 cue。
- waveform 显示，如果 RGB detail ready。

### duration 未就绪

禁用：

- 点击时间轴 seek。
- scrub。
- zoom 锚点。

### audio / transport 未 ready

禁用：

- 播放。
- seek。
- scrub。
- sync。
- loop。
- cue 触发。

### cue / loop 数据未就绪

禁用：

- cue recall。
- loop recall。
- cue/loop 编辑保存。

## empty-detail 显示规则

“黑一下”不是纯黑整块闪屏，而是清掉不可靠的 waveform shape，保留稳定背景和可靠 overlay。

```text
波形 detail 未就绪:
  不画 waveform shape
  保留 waveform background
  保留播放头，如果 transport 时间可靠
  保留时间文字，如果 duration/position 可靠
  保留 grid，如果 grid 已可靠
  保留 cue/loop，如果数据和坐标可靠
```

禁止：

- 显示旧位置波形。
- 显示低精度替代波形。
- 显示猜测 grid。
- 用频闪式纯黑盖住整个 deck。

## worker 协议草案

```ts
type BuildWaveformStripRequest = {
  stripId: number
  songKey: string
  detailRevision: number
  stripStartVisualSec: number
  stripDurationVisualSec: number
  pxPerVisualSec: number
  visualPlaybackRate: number
  viewportWidthCssPx: number
  stripWidthCssPx: number
  heightCssPx: number
  pixelRatio: number
  layout: 'top-half' | 'bottom-half' | 'full'
  themeVariant: 'light' | 'dark'
}

type BuildWaveformStripResult = {
  stripId: number
  ready: boolean
  coveredStartVisualSec: number
  coveredEndVisualSec: number
}

type PresentViewportRequest = {
  stripId: number
  viewportStartVisualSec: number
  viewportDurationVisualSec: number
  pxPerVisualSec: number
  visualPlaybackRate: number
}
```

worker 持有：

- RGB detail chunk cache。
- waveform strip canvas。
- viewport compositing canvas。

renderer 只负责：

- transport snapshot。
- visual-time math。
- 状态机。
- 接收 ready viewport / attach canvas。

## 状态机

```text
idle
  -> loadingDetail
  -> buildingInitialStrip
  -> ready

ready
  -> presenting
  -> prebuildingAhead
  -> switchingStrip
  -> ready

seekInsideStrip:
  ready -> ready

seekOutsideStrip:
  ready -> emptyDetail -> buildingSeekStrip -> switchingStrip -> ready

zoomChanged:
  ready -> transforming | emptyDetail -> buildingZoomStrip -> switchingStrip -> ready

resizeOrVisibilityResume:
  ready -> presentCurrent | emptyDetail -> rebuilding -> ready
```

关键规则：

- 新 strip 未完整覆盖 viewport 前，不切换。
- 所有 worker 消息以 `stripId` 校验，过期消息丢弃。
- seek outside strip 不保留旧 waveform shape。
- zoom 可以短暂 transform，但不能跨语义位置。

## 模块拆分建议

```text
src/renderer/src/components/horizontalBrowseWaveformDetailTypes.ts
src/renderer/src/components/horizontalBrowseWaveformDetailMath.ts
src/renderer/src/components/useHorizontalBrowseWaveformDetailStrip.ts
src/renderer/src/workers/horizontalBrowseWaveformDetailStrip.worker.ts
src/renderer/src/workers/horizontalBrowseWaveformDetailStrip.types.ts
```

职责：

- `horizontalBrowseWaveformDetailTypes.ts`: RGB detail、strip descriptor、cache key、ready state 类型。
- `horizontalBrowseWaveformDetailMath.ts`: audioSec/visualSec、viewport、zoom anchor、strip range、offset 计算。
- `useHorizontalBrowseWaveformDetailStrip.ts`: renderer 状态机，接双轨和编辑模式。
- `horizontalBrowseWaveformDetailStrip.worker.ts`: detail chunk 读取、strip 渲染、viewport compositing。
- `horizontalBrowseWaveformDetailStrip.types.ts`: worker message 协议。

## 迁移计划

### Phase 1: 纯数学和类型

- 新增 visual-time math。
- 新增 zoom anchor math。
- 新增 strip range / offset math。
- 单元化验证：tempo 改变时滚动速度不变；metadata BPM 不影响 waveform。

### Phase 2: RGB detail cache

- 新增 RGB detail cache schema。
- 新增分析产出。
- 新增 chunk 读取 API。
- 开发态清空旧 raw cache。
- 新 detail ready 后清理对应旧 raw cache。

### Phase 3: strip worker

- worker 从 RGB detail chunk 生成 strip。
- worker 做 viewport compositing。
- 不接播放，只用固定时间点渲染验证。

### Phase 4: 编辑模式接入

- 编辑模式大波形先接新 strip。
- 验证 zoom / scrub / grid edit。
- metadata BPM 改动只更新 grid。

### Phase 5: 双轨模式接入

- 双轨大波形接新 strip。
- 验证播放平移、seek、tempo、sync、nudge。
- 验证拖动窗口 / visibility 恢复不追速。

### Phase 6: 删除旧播放态路径

- 删除旧 live viewport raw 重采样路径。
- 删除临时日志。
- 保留必要错误日志，不保留 trace 型落盘日志。

## 验收标准

### 视觉

- 直接播放 30 秒，无持续抖动。
- 无热气感。
- 无频闪。
- seek 后无旧位置波形暂留。
- 未命中 detail 时只隐藏 waveform shape，可靠 overlay 保留。
- tempo 连续调整时，滚动速度稳定，waveform/grid 同步伸缩。
- metadata BPM 连续调整时，只更新 grid，不影响 waveform。
- dark / light theme 下背景、grid、RGB waveform 都正常。

### 交互

- detail 未就绪时，点击时间轴 seek 仍可用，只要 duration/transport ready。
- grid 未就绪时，beat/grid 类操作禁用。
- audio 未 ready 时，播放/seek/scrub 禁用。
- 编辑模式 zoom anchor 不漂。
- 双轨 sync / nudge 走统一 visual-time。

### 性能

- 已分析歌曲首屏 waveform 目标 `<=100ms`，可接受 `<=250ms`。
- 未分析歌曲声音优先；detail 首次生成目标 `<=1500ms`，慢盘允许更久但不得阻塞声音。
- 正常播放时 worker 不做 raw peak 全屏重采样。
- 正常播放时不读取整首 detail，只读取 / 持有当前 strip 附近 chunk。
- strip 重建不随每帧播放触发。
- 双 deck + 编辑模式切换不造成长期内存上涨。

### 日志

开发期允许临时日志写入 `log.txt`：

- detail cache hit/miss。
- strip build start/done。
- strip switch。
- empty-detail enter/exit。
- visual-time offset。

交付前清理所有非错误 trace 日志。

### 文件和质量

- 新增 / 修改 TS/Vue 后运行 `npx vue-tsc --noEmit`。
- 执行 `git diff --check`。
- 涉及构建路径时执行 `npx electron-vite build`。
- 单文件保持 `<=1100` 行。

## 待实现时再确认

1. RGB 生成算法的具体复刻程度：先用现有频谱能力做接近 rekordbox 的色彩，还是单独实现更贴近 PWV5 的颜色映射。
2. RGB detail chunk 大小：`2s`、`4s` 还是 `8s`。
3. RGB detail 是否压缩存储：第一版可先不压缩，稳定后再加。
4. strip 是否需要 2x 横向超采样：如果平移仍有 aliasing，再启用。
5. 是否给用户设置“重建 RGB 波形缓存”入口。
