# 动态多 clip 网格接手文档

创建日期：2026-07-04
整理日期：2026-07-05

本文档是动态多 clip 网格需求的接手文档。下一个会话看到本文后，应直接按这里的产品语义继续设计或实现，不需要重新追溯前面的问答过程。

本文档定义 FRKB 对“同一首歌内部 BPM / 网格间距发生变化”的产品语义。目标不是把所有歌曲都迁移到复杂动态网格，而是让少数需要人工修正的歌曲可以拥有可靠的多 clip 网格，同时不增加绝大多数固定 BPM 歌曲的负担。

## 1. 总原则

- 固定 BPM 网格仍是默认模型。普通歌曲继续使用现有 `bpm` / `firstBeatMs` / `barBeatOffset`，这些字段仍是固定歌曲的事实源。
- 动态多 clip 网格只针对少数人工修正出来的特殊歌曲启用。
- 自动分析不识别、不生成动态多 clip 网格。
- 动态歌曲以 `SongBeatGridMap` 为网格事实源；旧字段只作为兼容摘要。
- 固定歌曲不强制生成单 clip `SongBeatGridMap`，也不强制走动态 helper 包装路径。
- 除非明确说明，本文的“动态网格规则”只作用于动态多 clip 歌曲；固定 BPM 歌曲保持现有路径。
- 动态网格必须能进入 Mixtape 核心链路，不能在 Mixtape 中退化为第一段兼容 BPM。

## 2. 术语

- 固定网格：整首歌使用一组 `bpm + firstBeatMs + barBeatOffset`。
- 动态多 clip 网格：同一首歌由多个连续固定 BPM 虚拟 clip 组成，每个 clip 有自己的左边界、BPM 和相位。
- 虚拟 clip：动态歌曲在逻辑层拆出的连续固定 BPM 片段；固定 BPM 歌曲可在逻辑上视作一个 clip，但不落库为 `SongBeatGridMap`。
- clip 边界：后一个 clip 的 `startSec`，固定在歌曲时间线上。
- 选中 clip：动态网格编辑时当前被编辑的 clip。左移 / 右移、BPM 输入、tap BPM 默认只作用于选中 clip。
- `SongBeatGridMap`：动态歌曲的完整网格事实源。
- 网格签名：从规范化后的 clips 计算出的稳定签名，用于段落识别、派生缓存、Mixtape 映射等失效判断。
- 全局动态拍线表：由整首 `SongBeatGridMap` 生成的拍线、bar boundary、累计 beat ordinal 和局部 BPM 查询表。

## 3. 数据模型

采用“保留旧字段，新增可选 `SongBeatGridMap`”。

```ts
type SongBeatGridClip = {
  startSec: number
  anchorSec: number
  bpm: number
  barBeatOffset: number
}

type SongBeatGridMap = {
  version: number
  source: 'manual'
  clips: SongBeatGridClip[]
  signature: string
}
```

`beatGridMap.clips` 只保存虚拟固定 BPM clip 的左边界和网格生成参数：

- 不保存每一根拍线。
- 不保存 UI 选中状态。
- 不保存临时编辑范围。
- 不保存 `endSec`，clip 右边界由下一个 clip 的 `startSec` 或歌曲结束推导。

### 3.1 固定歌曲

- 继续只保存 `bpm` / `firstBeatMs` / `barBeatOffset` 等旧字段。
- 不生成、不落库单 clip `SongBeatGridMap`。
- 自动分析结果仍写入旧字段。

### 3.2 动态歌曲

- 只有用户人工编辑并实际形成两个以上有效 clip 后，才保存 `beatGridMap`。
- 动态歌曲的旧字段只作为兼容摘要，不再是网格事实源。
- 兼容摘要取第一段固定投影：
  - `bpm` 取第一段 clip BPM。
  - `firstBeatMs` 取整首动态网格第一拍位置。
  - `barBeatOffset` 取第一段相位。
- 不取平均 BPM、不取最长段 BPM、不跟随当前播放段变化。

### 3.3 合法性

- `beatGridMap` 必须覆盖整首歌。
- 第一段 clip 的 `startSec` 必须是 `0`。
- 后续 clip 的 `startSec` 必须严格递增。
- 除第一段外，后续 clip 的 `startSec` 必须大于 `0` 且小于 `durationSec`。
- 动态网格创建 / 保存必须以可靠 `durationSec` 为前置条件。
- 相邻 clip 如果 BPM 一致且边界处相位连续，应自动合并。
- 合并后只剩一个有效 clip 时，歌曲自动退回固定 BPM 模式，删除 `beatGridMap`，把唯一有效 clip 投影回旧字段。

### 3.4 签名和无效数据

- `beatGridMap.signature` 不是事实源；事实源是规范化后的 `clips`。
- 读取 / 写入 / 比较时应从规范化后的 clips 重新计算签名，存储值只作为缓存。
- 无效 `beatGridMap` 是异常防御状态，不是正常用户流程。
- 读取到无效 `beatGridMap` 时，临时回退到旧字段固定网格并记录诊断 / 错误；不静默自动修复，也不阻断播放。

## 4. 动态网格创建与主编辑模式

### 4.1 入口

- 网格编辑工具栏显示 `整首调整` 和 `从当前点之后调整` 两个互斥状态入口。
- 默认状态是 `整首调整`；点击 `整首调整` 会退出当前边界 / 后段局部编辑视图，恢复整首网格显示。
- 点击 `从当前点之后调整` 会在当前播放头位置创建后续 clip 边界，并自动选中新建右侧 clip；如果靠近已有边界，则选中该边界。
- 不提供独立“合并为固定 BPM”按钮；只能通过删除边界 / 自动合并自然退回固定 BPM。

`从当前点之后调整` 不是一个永久开关；它只负责创建 / 选中当前播放头之后的局部编辑对象。用户可随时点击 `整首调整` 退出局部编辑状态。

### 4.2 创建边界

- 新边界使用点击按钮瞬间的播放头位置。
- 新边界不自动吸附到拍线。
- 在一个 clip 内创建边界时，原 clip 拆成左 / 右两个 clip。
- 右 clip 初始继承原 clip 的 BPM / 相位，因此只创建边界本身不改变听感或网格外观。
- 如果播放头距离已有边界小于 `500ms`，不创建极短 clip，改为选中最近边界。左右两侧边界都参与判断。
- `500ms` 是交互防误触阈值，不是数据结构硬性最小 clip 长度。

### 4.3 选择和编辑对象

- 动态多 clip 歌曲进入网格编辑时，默认处于 `整首调整` 状态，不选中某个后段 clip。
- 进入 `从当前点之后调整` 后，用户点击 clip 波形区域选中该 clip。
- 点击边界线选中边界，并切入 `从当前点之后调整` 状态；边界命中优先级高于左右 clip 区域。
- 用户手动选中 clip 后，播放头移动不再改变选中对象。
- `从当前点之后调整` 状态下，BPM 输入、tap BPM、左移 / 右移只作用于当前选中 clip。
- `整首调整` 状态下，左移 / 右移是整首网格相位调整，不裁剪边界左侧网格。
- BPM 输入框聚焦或正在编辑时，不随播放头跨 clip 自动切换显示；局部状态下提交值作用于当前选中 clip。

### 4.4 边界和删除

- clip 边界固定，不允许拖动。
- 选中边界时，高亮边界并显示明确删除入口；clip 编辑控件禁用或转为空态。
- 删除边界不弹二次确认，但删除入口文案必须明确“删除边界，后段并入前段”。
- 删除边界时，右侧 clip 并入左侧 clip，左侧 BPM / 相位延伸到下一边界或歌曲结尾。
- 删除后选中合并后的左侧 clip；如果退回固定 BPM / 单 clip，则选中唯一 clip。
- 当前选中 clip 因 BPM / 相位调整触发自动合并后，选中合并后的 clip。

### 4.5 相位移动和裁剪

- `整首调整` 状态下，左移 / 右移整体平移整首网格相位，不移动边界。
- `从当前点之后调整` 状态下，左移 / 右移调整选中 clip 内网格相位，不移动边界。
- 如果相位左移后有拍线落到 clip 左边界之前，这些拍线被裁剪，不显示、不吸附、不参与段落 / loop / Mixtape 展开。
- clip 末尾按同一 BPM / 相位继续补线，保证该 clip 有连续网格覆盖。

### 4.6 保存语义

- 主编辑模式不新增显式保存 / 应用按钮。
- 创建边界、删除边界、左移 / 右移、BPM 输入、tap BPM 都实时生效，并通过去抖写库。
- 动态歌曲写 `beatGridMap`；固定歌曲写旧字段。
- 网格签名变化后触发相关派生数据失效和刷新。

## 5. 网格显示和 BPM 展示

### 5.1 波形显示

- 动态歌曲普通播放时，大波形按整首 `SongBeatGridMap` 连续显示网格线。
- 跨 clip 后网格间距自然变密 / 变疏。
- clip 边界线普通播放态可见，但比编辑态克制。
- 概览波形 / 小波形只显示轻量 clip 边界标记，不绘制完整密集动态网格。
- 固定 BPM 歌曲不显示动态边界标记。

### 5.2 当前 BPM 显示

- 动态歌曲普通播放时，当前 BPM 显示跟随播放头所在 clip。
- 如果 BPM 输入框聚焦或用户正在编辑，不自动跟随播放头切换。
- 列表 BPM 摘要是整首摘要，不跟随播放头变化。

### 5.3 列表、筛选、排序

- 固定歌曲继续显示单一 BPM。
- 动态歌曲按时间顺序显示 BPM 摘要，例如 `120 -> 125` 或 `120 -> 125 -> 120`。
- 相邻 clip 如果 BPM 数值相同，列表摘要压缩为一个 BPM。
- 如果所有 clip BPM 数值相同但相位 / 边界不同，列表只显示单值，不显示 `120 -> 120`，也不额外显示“动态网格”标记。
- 三段以内直接显示完整摘要。
- 超过三段显示前两段和末段，完整摘要用项目气泡提示展示，不能使用原生 DOM `title`。
- BPM 筛选按任意 clip 命中；范围筛选也按任意 clip 落入范围判定。
- BPM 排序按最低 clip BPM 排序，显示文本仍保留多段摘要。

## 6. 拍线吸附和播放相关功能

所有“吸附到拍线 / 网格线”的功能按歌曲类型分支：

- 固定 BPM 歌曲继续使用现有固定拍线计算。
- 动态歌曲使用整首 `SongBeatGridMap` 生成的全局动态拍线表。

这里的“整首 `SongBeatGridMap`”不是全曲平均 BPM，也不是只看当前 clip，而是把所有 clip 按各自 BPM / 相位生成一张全局动态拍线表，再从这张表里找最近拍线或累计 beat ordinal。

### 6.1 普通播放

- 动态网格不改变普通播放速度。
- 普通播放跨 clip 时，音频按原文件自然连续播放，不切 playbackRate。
- 动态网格修改后，当前加载该歌曲的 deck 立刻使用新网格解释；普通音频播放不重载、不 seek、不跳动。

### 6.2 Cue / Hot Cue / Memory Cue

- 已有 Cue / Hot Cue / Memory Cue 是歌曲内绝对时间点。
- 调整动态 clip BPM / 相位不会自动移动已有 cue。
- 新建 cue / quantize 使用最新全局动态拍线表。
- 如果 UI 显示 cue 的小节 / 拍点等派生标签，标签按最新动态网格刷新，真实 `sec` 不变。
- 不新增“拖动 cue 标记本身”的语义。

### 6.3 Loop

- 已有 loop 起止点是歌曲内绝对时间点。
- 调整动态 clip BPM / 相位不会自动移动已有 loop。
- Memory Cue / Hot Cue 中保存的 loop cue 同样按绝对时间点处理，`sec` / `loopEndSec` 不变。
- 当前 active loop 正在播放时，动态网格调整不立刻重算 loop 边界；active loop 继续按已有起止时间播放，直到用户重新设置或调整 loop。
- 如果 UI 显示已有 loop 的拍数 / 小节数等派生标签，标签按最新动态网格刷新，起止真实时间不变。
- 新建 loop、调整 loop beat 长度或重新量化边界时，使用最新动态网格和累计 beat ordinal。
- Loop 允许跨 BPM clip 边界，按累计 beat / 小节边界计算，不退化成固定秒长。

### 6.4 Quantize / Beat Jump / Metronome

- Quantize 使用整首动态拍线表。
- Beat Jump 在动态歌曲中按累计 beat ordinal 加减 beat 数，再由 `SongBeatGridMap` 反查目标时间；跨 clip 不按当前 BPM 简单加固定秒长。
- Metronome 下一拍永远从整首动态拍线表取，跨 clip 时自然切换到新 clip 的拍线间隔。

## 7. BeatSync

- 固定 BPM 歌曲继续使用现有 BeatSync 路径。
- 动态歌曲启用动态 beat ordinal / 局部 BPM 分支。
- BeatSync 按钮仍只有开 / 关，不新增第三种可见状态。
- 动态歌曲播放中跨 BPM clip 时，playbackRate 使用短窗口平滑切换，初始建议 `50-150ms`，禁止用明显 seek / 位置跳动代替。
- 固定歌和动态歌混合 BeatSync 时，固定歌仍用现有固定 beat distance，动态歌用动态 beat ordinal，由同步层做相位对齐适配。
- 动态网格修改后，正在 BeatSync 的 deck 立刻按新网格重算同步关系，但要平滑更新，避免明显 seek 跳动或先错后追。

## 8. 段落识别和 Key

### 8.1 段落识别

- 只为动态歌曲新增动态段落识别路径。
- 固定歌曲继续现有固定网格段落识别和缓存有效性判断，不强制包装成单段 `SongBeatGridMap`。
- 动态歌曲从 `SongBeatGridMap` 生成 bar boundaries。
- 动态歌曲每个 bar feature 用相邻 bar boundary 汇总波形特征。
- 动态歌曲 phrase 按每 8 小节边界组合，不用固定 `beatSec * 32`。
- 动态歌曲的小节编号按全曲连续编号，不因 BPM clip 重置。
- `SongStructureAnalysis` 记录动态 `beatGridSignature`。
- 人工动态网格变更后，只要签名变化，旧段落结果立即标记为待更新。
- 连续调整停止后再自动排队重算，去抖时间为 `1000ms`。
- 等待重算和重算期间，旧段落视觉上继续正常显示，不隐藏、不淡化。
- 旧段落继续可用于依赖段落的播放范围；新结果回来后用于后续进入 / 选择。
- 动态网格修改后，当前正在生效的段落播放范围不立刻切换或取消；active 范围按创建时的绝对时间保持。
- 内部分析状态可标记为待更新，但普通 UI 不打扰用户。

### 8.2 Key / 调性

- Key 分析不受动态多 clip 网格影响。
- 继续按整首歌曲现有逻辑分析和显示。
- 动态网格变化不引入按 clip 分段 Key，也不额外触发 Key 重算。

## 9. 自动分析

- 自动分析完全不考虑动态多 clip 网格。
- BeatThis 仍只作为固定网格分析链路的一部分使用。
- 自动分析只产出固定 BPM 网格结果，不产出 `SongBeatGridMap`，也不做“疑似动态 BPM”提示。
- 动态网格只来自人工编辑。
- 用户主动对动态歌曲重新执行 BPM / 网格自动分析时，分析结果仍只产出固定 BPM。
- 重新分析成功后，用固定分析结果覆盖旧字段并清空 / 删除 `beatGridMap`，歌曲退回固定 BPM 路径。
- 不做二次确认；用户主动点击重新分析就表示接受用固定分析结果覆盖当前网格事实源。

## 10. Mixtape

Mixtape 是动态多 clip 网格的核心目标。动态歌曲进入 Mixtape 时，必须使用完整 `SongBeatGridMap` 参与 track time map，不能降级为第一段兼容 BPM。

### 10.1 基本时间映射

- 固定歌曲继续使用现有 Mixtape 路径。
- 动态歌曲提供 source beat map：`sourceSec -> sourceBeatOrdinal`、`sourceBeatOrdinal -> sourceSec`。
- 项目时间轴提供 target beat map：`projectSec -> projectBeatOrdinal`、`projectBeatOrdinal -> projectSec`，来源是 Mixtape 全局 tempo map / resolved tempo map。
- 动态歌曲的 track time map 通过 beat ordinal 对齐源网格和项目网格，不再通过单一 `originalBpm` 线性换算。
- 动态歌曲的可见网格线、snap candidates、beat align、loop 展开、预览播放、导出都必须使用同一套动态 track time map。

### 10.2 全局 BPM 包络线

- Mixtape 的 BPM 包络线是全局 tempo map / resolved tempo map，不是 track 级 BPM 包络线。
- 动态歌曲在 Mixtape 逻辑层展开为“父歌曲 + 多个虚拟固定 BPM clip”。
- UI / 歌曲库仍是一首歌；无实际音频切割。
- 虚拟 clip 只存在于 tempo / grid / time map 计算层，播放和导出必须无缝。
- 动态歌曲虚拟 clip 对全局 BPM 包络线产生自动派生贡献。
- 父歌曲移动 / 删除时，所有虚拟 clip 及其自动 BPM 贡献一起移动 / 删除。
- 旧位置不能留下该歌曲的变速特征，也不能自动转成全局手动 BPM 点。
- 全局手动 BPM 点优先于自动虚拟 clip 贡献。
- 用户在全局 BPM 包络线上手动拉平某段 tempo 时，该时间段内所有歌曲和动态虚拟 clip 都按全局手动 tempo 播放 / 预览 / 导出。
- 全局手动 BPM 点视觉上必须区别于动态歌曲自动贡献。
- 手动点固定在 Mixtape 全局时间轴上，可编辑；自动贡献跟随歌曲 placement / crop / scale 派生。
- 全局手动 BPM 点不反写歌曲库 `SongBeatGridMap`，不提供同步回歌曲网格入口。
- 全局 BPM 控制点横向位置跟随当前 Mixtape 网格吸附精度，不保存任意像素 / 任意时间点。

### 10.3 缩放、裁剪和重叠

- 动态歌曲父级有整体缩放比例。
- `sourceAnchorBpm` 取父歌曲片段源起点 `sourceStartSec` 所在虚拟 clip 的 BPM。
- 导入 Mixtape 的初始对齐也使用 `sourceStartSec` 所在 clip 的 BPM，不取第一段或最低 BPM。
- `scale = targetAnchorBpm / sourceAnchorBpm`。
- 每个虚拟 clip 的有效 BPM 为 `sourceClipBpm * scale`。
- 如果裁剪起点后新的 `sourceStartSec` 落到另一个虚拟 clip，`sourceAnchorBpm` 和 `scale` 必须按新起点所在 clip 重新计算。
- 如果裁剪起点 / 终点落在虚拟 clip 中间，该 clip 的自动 BPM 贡献只覆盖实际播放范围；被裁掉的前后部分不影响全局 BPM、snap、beat align、预览或导出。
- 如果另一首歌跨过动态歌曲虚拟 clip 边界发生叠歌，按边界拆成多个连续 overlap 子区间。
- 每个子区间复用现有两首固定 BPM 歌叠歌逻辑；真实音频播放 / 导出必须无缝跨过虚拟边界。

### 10.4 源网格共享和刷新

- Mixtape 不保存歌曲源网格快照。
- Mixtape 使用歌曲库当前有效源网格。
- 已使用的动态歌如果歌曲库源 `beatGridMap` 被修改，Mixtape 刷新后使用最新源网格重新派生 time map、自动 BPM 贡献、snap candidates、预览和导出映射。
- 源 `beatGridMap` 更新后，Mixtape 中动态歌的 `sourceAnchorBpm` 和 `scale` 必须按当前 `sourceStartSec` 所在的新 clip 重新计算。
- 源网格更新不弹窗、不要求确认。
- 源网格更新只导致 Mixtape 派生结果刷新，不把项目标记为已修改。
- 只有 placement、裁剪、`scale`、全局手动 BPM 点、曲目增删 / 排序、envelope 等项目级数据变化才产生 dirty 状态。

### 10.5 Mixtape 中的歌曲网格调整

- Mixtape 里调整“某首歌自己的网格线”时，修改的是歌曲库源网格事实源，不是当前 Mixtape placement 的私有网格副本。
- 动态歌曲写回源 `beatGridMap`；固定歌曲写回旧固定网格字段。
- Mixtape 的“歌曲网格线调整”和“全局 BPM 包络线调整”必须在 UI 文案和交互上区分清楚：
  - 歌曲网格线调整：改共享歌曲源网格。
  - 全局 BPM 包络线调整：改当前 Mixtape 项目 tempo map，不反写歌曲库。

Mixtape 网格调整弹窗保留“应用 / 取消”两阶段语义：

- 弹窗打开时创建临时网格副本。
- 弹窗内拖动、改 BPM、设置大节线、创建 / 调整 / 删除动态 clip 时，只影响弹窗预览和临时网格状态。
- 弹窗支持完整动态 clip 编辑能力，包括创建边界、选择 clip、调整 BPM / 相位、删除边界、自动合并和退回固定 BPM。
- 点“应用”后才把最终网格写回共享歌曲源网格。
- 点“取消”或关闭弹窗时，丢弃本次未应用的临时网格改动，不影响歌曲库源网格，也不刷新其他引用。
- 弹窗打开期间如果源网格在别处被修改，本弹窗不自动合并、不弹窗打断；点“应用”时以弹窗临时结果覆盖当前共享源网格。采用 last apply wins，不做冲突合并。
- 应用结果如果归并成单一有效固定网格，允许源歌曲退回固定 BPM；删除 `beatGridMap`，写回旧固定字段，Mixtape 重新按固定歌曲路径派生。

如果“应用”会改变网格位置、BPM 或动态 clip 结构，从而影响该 track 的 beat / time 关系：

- 沿用 envelope 重置确认。
- 用户确认后，受影响 track 的 envelope 重置为初始平直状态。
- 如果同一音频在当前 Mixtape 中有多个引用，并且本次应用会同步更新这些引用的源网格解释，则这些受影响引用按现有同 filePath 更新范围处理。
- 用户取消确认时，本次应用不提交，临时网格不写入共享歌曲源网格。

### 10.6 Mixtape 播放和导出

- 动态歌曲普通进入 Mixtape 后不能按第一段兼容 BPM 降级。
- 预览播放、可见网格、snap、beat align、BPM 包络线和导出都必须通过动态 track time map 统一解释。
- 如果全局手动 BPM 点覆盖动态歌自动贡献，该时间段内动态歌会被真正拉平；这是 Mixtape 全局 tempo 编辑，不反写歌曲库。

## 11. 共享、复制和备份

- 动态 `beatGridMap` 是歌曲网格事实源的一部分。
- 复制 / 转移歌曲到内部歌单、Set、Mixtape 或其他内部库时，应随歌曲元数据保留完整 `beatGridMap`，不能退化成旧字段兼容摘要。
- 同一音频文件 / 歌曲实体共享同一份 grid definition；普通歌单、Set、Mixtape 等内部引用看到同一份源 `beatGridMap`。
- 不做 per-playlist-item 网格 override。
- 同一首动态歌在多个 Deck / Mixtape / 内部引用中同时加载时，一个地方修改 `beatGridMap` 后，所有已加载引用立刻使用新网格。
- 普通播放不跳、不重载；BeatSync 按新网格平滑重算。
- FRKB 自己的库备份 / 恢复必须完整保留动态 `beatGridMap`。
- 备份动态歌曲时不能只导出旧字段兼容摘要。
- 恢复时按同一套动态网格校验规则读取 `beatGridMap`；有效则恢复为动态歌曲，无效则按无效数据防御规则回退旧字段并记录诊断。

## 12. Rekordbox 和外部边界

- 当前项目没有把 FRKB 手调网格写回 Rekordbox beat grid 的能力。
- 现有 Rekordbox 写能力主要用于歌单树 / 歌单曲目操作，不应理解为 beat grid 写回。
- 不做 Rekordbox 动态网格导入 / 导出。
- 不做 Rekordbox beat grid 写回。
- 动态多 clip 网格只作为 FRKB 内部事实源。
- Rekordbox beat grid 写回不属于本需求；如需开展，必须作为独立需求重新评估文件格式、数据库写入安全、Rekordbox 打开状态、备份恢复和跨版本兼容。

## 13. 接手范围

接手时应按以下范围理解需求：

1. 数据结构支持少数歌曲按需保存 `SongBeatGridMap`。
2. 固定歌曲继续使用旧字段路径，不强制动态化。
3. 动态网格读取 helper 和全局动态拍线表。
4. 大波形动态网格渲染和 clip 边界显示。
5. 主编辑模式动态 clip 创建、选择、调整、删除、自动合并和退回固定 BPM。
6. BPM 显示、筛选、排序的动态摘要语义。
7. Cue / Loop / Quantize / Beat Jump / Metronome 的动态网格分支。
8. 段落识别动态 bar boundaries、签名失效和去抖重算。
9. BeatSync 动态 beat ordinal / 局部 BPM 分支。
10. Mixtape 动态 source beat map、track time map、全局 BPM 自动贡献、裁剪、重叠、导出。
11. Mixtape 网格调整弹窗支持动态 clip 编辑，但保留应用 / 取消两阶段提交。
12. 内部复制、共享引用、备份 / 恢复保留 `beatGridMap`。

## 14. 实现状态

更新日期：2026-07-05

本节只记录当前代码已经接入并通过本轮静态验证的范围；没有打勾的项继续按本文前文语义实现，不视为已完成。

- [x] 数据结构：新增 `SongBeatGridMap`，固定 BPM 继续以旧字段为事实源，动态歌曲以 `beatGridMap` 为事实源。
- [x] 动态网格 helper：规范化、签名、固定投影、全局拍线、累计 beat ordinal 和时间反查已接入共享层。
- [x] 共享网格存取：主进程歌曲缓存、共享 grid definition、内部歌单 / Set / Mixtape 引用链路已保留 `beatGridMap`。
- [x] 主编辑模式：支持创建边界、选择 clip / 边界、调整 BPM / 相位 / 大节线、删除边界、自动合并和退回固定 BPM。
- [x] 大波形和概览显示：动态歌曲按整首 `SongBeatGridMap` 绘制网格，clip 边界在相关波形 surface 可见。
- [x] BPM 展示：歌曲列表摘要、筛选、排序按动态 clip BPM 语义接入，长摘要使用项目气泡提示而不是原生 DOM `title`。
- [x] 播放网格功能：Cue / Quantize / Beat Jump / Loop / Metronome 已接动态拍线或累计 beat 分支。
- [x] Native 播放：Rust transport 已接动态 clip 状态、局部 BPM、动态 Metronome 和 BeatSync 的短窗口 playbackRate 平滑基础分支。
- [x] 段落识别：动态歌曲使用动态 bar boundaries，`SongStructureAnalysis` 记录 `beatGridSignature`，网格签名变化后去抖重算。
- [x] Mixtape 基础映射：动态歌曲的 source beat map、track time map、可见网格、snap / 拖拽映射和 runtime tempo snapshot 已接动态源网格。
- [x] Mixtape 网格调整弹窗：支持动态 clip 临时编辑、应用 / 取消两阶段提交、同 filePath 引用同步和归并后清空 `beatGridMap`。
- [x] 静态验证：已通过 `npx vue-tsc --noEmit`、`cargo check`、`pnpm run build`、`git diff --check`。
- [x] Mixtape 全局 BPM 包络线：动态虚拟 clip 自动贡献已按阶梯 BPM 点派生，手动点 / 自动贡献点已通过点来源做视觉区分。
- [x] Mixtape source section 锚点：动态自动贡献按当前可见 / loop 展开 section 派生，`sourceAnchorBpm` 和 `scale` 使用 section 起点所在虚拟 clip。
- [x] Mixtape 叠歌跨动态虚拟 clip 边界：transport 已生成动态 tempo segment，BeatSync 按当前 segment 的 source BPM / 相位锚点切换，导出跳过整段固定 ratio 预烘以保留跨边界动态播放率。
- [x] BeatSync：Rust transport 已用动态全局拍线插值实现 `beat ordinal -> sec` / `sec -> beat ordinal` 双向 phase solver，`beatsync`、`align_to_leader`、刷新对齐和网格变更补偿都按同一套动态 phase 解算。
- [x] 真实音频回归：已用隔离临时库跑通 Electron dev 应用，覆盖动态建边界、跨 clip 预览播放、Mixtape 导出 WAV、暗色 / 亮色主题；证据见 `tmp/dynamic-grid-regression/run-1783263957244/evidence.json`。

## 15. 本轮验收证据

更新时间：2026-07-05

本轮已按本文语义对照当前代码入口复核，重点证据如下：

- 共享数据结构和 helper：`src/shared/songBeatGridMap.ts` 定义 `SongBeatGridMap`，并提供规范化、签名、固定投影、全局动态拍线、累计 beat ordinal、BPM 摘要、筛选和排序 helper。
- 主编辑模式：`src/renderer/src/composables/horizontalBrowse/useHorizontalBrowseDynamicBeatGridEdit.ts` 覆盖动态 clip 选择、创建边界、删除边界、BPM / 相位调整、自动合并和去抖持久化触发。
- 共享持久化和内部引用：`src/main/services/sharedSongGrid.ts`、`src/main/ipc/setListHandlers.ts`、`src/main/ipc/mixtapeHandlers.ts`、`src/main/services/scanSongs.ts`、`src/main/libraryCacheDb/songCache.ts` 已保留、同步或按重新分析语义清空 `beatGridMap`。
- Mixtape 动态时间映射：`src/renderer/src/composables/mixtape/trackTimeMapCore.ts`、`trackTimeMapFactory.ts`、`mixtapeGlobalTempoModel.ts`、`timelineTransportDynamicTempoSegments.ts`、`timelineTransportRenderWav.ts` 已覆盖动态 source beat map、动态可见网格、全局 BPM 自动贡献、source section 锚点、跨动态 clip transport segment 和导出路径。
- Native transport：`rust_package/src/horizontal_browse_transport_engine_state.rs`、`horizontal_browse_transport_grid_sync.rs` 和对应 tests 已覆盖动态 beat ordinal / sec 双向解算、局部 BPM、Metronome、BeatSync、align 和网格变更补偿。
- 真实 Electron 回归：`node tmp/dynamic-grid-regression/run-regression.mjs` 已通过，证据文件为 `tmp/dynamic-grid-regression/run-1783263957244/evidence.json`，导出文件为 `tmp/dynamic-grid-regression/run-1783263957244/export/dynamic-grid-regression.wav`。
- 静态 / 构建验证：已通过 `npx vue-tsc --noEmit`、`cargo check`、`cargo test`、`pnpm run build`、`git diff --check`。
