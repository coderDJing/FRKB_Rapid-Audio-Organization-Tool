# Mixtape BPM Envelope Draft

## 背景

当前自动混音时间线里的 `gain`、`EQ`、`stem`、`volume` 都已经支持包络线，但 `BPM` 仍然是单轨固定值。

现有实现里，轨道播放速度、导出速度、叠加区节拍同步，都是围绕单轨固定 `bpm` 和固定 `tempoRatio` 展开的。这导致用户只能在轨道级别改速，不能在时间线上做持续变速、推进式提速、渐变减速等自动混音常见动作。

本草案用于定义新的 `BPM` 包络线能力，并明确它与 `masterTempo`、重叠区同步、UI 表达之间的关系。

## 已确认的产品结论

1. `BPM` 包络线显示真实 BPM 数值，不显示百分比，不显示相对倍率。
2. `BPM` 入口混入现有参数切换体系，用户操作感受保持为普通包络线。
3. 每首歌仍然保留自己的 `masterTempo` 开关。
4. 当某首歌 `masterTempo = true` 时，这首歌跟随 BPM 包络线变速，但不变调，也就是 key lock 生效。
5. 当某首歌 `masterTempo = false` 时，这首歌跟随 BPM 包络线变速，同时允许变调。
6. 两首歌叠在一起时，重叠区内的 BPM 必须同步，不能出现同一重叠区间里两首歌各跑各的 BPM。
7. `BPM` 包络线数据归属仍然是单轨，只是在重叠区按区间镜像同步，不是整个页面共用一条总 BPM 曲线。

## 目标

- 让用户可以像编辑普通包络线一样编辑 BPM。
- 让重叠区两首歌在对应区间内保持同一 BPM 曲线。
- 让 `masterTempo` 在 BPM 变化期间依然决定是否 key lock。
- 让播放预听、时间线显示、离线导出三条链路行为一致。

## 非目标

- 本阶段不做整页唯一一条全局 BPM 曲线。
- 本阶段不做多条 BPM 包络线叠加混算。
- 本阶段不做“某轨局部脱离重叠区同步但仍声称同步”的模糊规则。

## 核心设计

### 1. 包络线归属

`BPM` 包络线虽然在 UI 上作为一个普通参数出现，但数据归属挂在单轨上，不挂在 mixtape 时间线上。

建议定义：

- `track.bpmEnvelope: Array<{ sec: number; bpm: number }>`

其中：

- `sec` 是轨道内秒坐标。
- `bpm` 是该时间点的真实 BPM。

这样设计后：

- UI 可以像 `volume` 一样直接画在当前轨内部
- 数据语义简单，不会让用户误会自己在改整个页面唯一一条总 BPM 线
- 重叠区同步通过“镜像修改其它轨对应区间”来实现

### 2. 用户看到的行为

用户在参数切换里切到 `BPM` 后：

- 看到的仍然是一条包络线
- 可以打点、拖点、删除点、做线性斜坡、做跳变
- Y 轴显示真实 BPM 数值
- X 轴是当前轨的本地时间位置

看起来是单轨参数，实际也应该是单轨参数。

为避免误解，建议在 UI 上加一条轻提示：

- `当前编辑的是这首歌的 BPM；若与其它轨重叠，重叠区会同步到对应轨道`

这条提示可以放在参数切换区或 BPM 编辑面板上，不需要过度吓人，但必须讲清楚。

### 3. 重叠区同步规则

设 A 轨与 B 轨的时间范围存在重叠区 `[overlapStart, overlapEnd]`。

当用户编辑 A 轨 `bpmEnvelope` 时：

- A 轨在重叠区的 BPM 曲线先按自己的轨道内时间定义
- 系统将该区间映射到全局时间线
- 再把同一段全局时间映射回 B 轨的本地时间
- 只替换 B 轨对应重叠区的 `bpmEnvelope` 片段
- 非重叠区不修改

也就是说：

- 同步的是重叠区对应片段
- 数据归属仍然是单轨
- `masterTempo` 只决定保调与否，不决定是否参与同步

### 4. `masterTempo` 的新语义

当前语义需要收敛成更清晰的定义：

- `masterTempo = true`
  - 跟随该轨当前的 BPM 包络线
  - 若重叠区被同步改写，也跟随改写后的该轨 BPM 包络线
  - 保持音高不变
  - 导出时也必须保持音高不变
- `masterTempo = false`
  - 跟随该轨当前的 BPM 包络线
  - 若重叠区被同步改写，也跟随改写后的该轨 BPM 包络线
  - 允许音高随变速发生变化
  - 导出时也允许音高变化

这意味着 `masterTempo` 不再只是“是否参与同步”的模糊开关，而是明确成为 key lock 开关。

### 5. UI 交互原则

#### 5.1 参数切换

现有参数切换里新增 `BPM`：

- `gain`
- `high`
- `mid`
- `low`
- `vocal`
- `inst`
- `bass`
- `drums`
- `volume`
- `bpm`

实际展示时仍按当前混音模式裁剪，但 `bpm` 应在 `eq` 和 `stem` 两种模式下都可见。

#### 5.2 编辑体验

`BPM` 包络线沿用现有包络线操作习惯：

- 单击创建点
- 拖动改值
- 拖动同秒双点实现跳变
- 删除控制点
- 撤销重做沿用现有栈

#### 5.3 Y 轴

Y 轴不再表示 gain/db，而表示 BPM。

建议范围：

- 以当前轨基准 BPM 作为 `100%`
- 顶部固定为 `200%`
- 底部固定为 `25%`
- 默认平线位于中线

也就是说，UI 表达上是固定百分比范围，但存储值仍然是实际 BPM 数值。

#### 5.4 显示层级

因为 `BPM` 是单轨曲线，所以建议：

- 直接在轨道波形内部渲染 BPM 曲线
- 激活 `BPM` 参数时，只操作当前轨内部的控制点
- 系统自动处理重叠区镜像同步

换句话说，切到 `BPM` 时，就应该明确看起来像“每条轨各有自己的 BPM 线”。

### 6. 数据模型建议

建议新增类型：

```ts
type MixtapeBpmPoint = {
  sec: number
  bpm: number
}
```

建议新增轨道级字段：

```ts
type MixtapeTrack = {
  bpmEnvelope?: MixtapeBpmPoint[]
}
```

建议默认包络线：

```ts
[
  { sec: 0, bpm: trackBaseBpm },
  { sec: trackDurationSec, bpm: trackBaseBpm }
]
```

其中 `trackBaseBpm` 可以来自：

- 当前轨 `bpm`
- 或 `gridBaseBpm`
- 或 `originalBpm`

草案建议优先取当前轨有效 BPM，规则最简单。

### 7. 播放链路设计

当前链路基本是：

- 先算出每轨固定 `tempoRatio`
- 播放中再做一点同步修正

要支持 BPM 包络线，需要升级为：

- 每个采样时刻或每个自动化步进时刻，先读取当前轨 `bpmEnvelope(trackLocalSec)`
- 若轨道与其他轨重叠，则这些轨道在重叠区会读到已经同步后的对应片段
- 再根据 `masterTempo` 决定使用 key lock time-stretch 还是普通变速

建议拆成两个层次：

#### 层 1：Tempo Map

负责提供：

- `sampleTrackBpmEnvelopeAtSec(track, trackLocalSec)`
- `resolveTrackTempoRatioAtSec(track, trackLocalSec)`

#### 层 2：Playback Engine

负责提供：

- `masterTempo = true` 时的保调变速
- `masterTempo = false` 时的普通变速

### 8. 导出链路设计

播放和导出必须一致。

因此导出不能继续只依赖“整轨一个 `asetrate=sample_rate*固定倍率`”这种固定变速思路，而要支持按每轨 BPM 包络线随时间变化的 tempo automation。

按能力拆分，导出至少需要：

- 按时间步进应用每轨 BPM 包络线
- 对每条轨按 `masterTempo` 分别选择处理路径

建议：

- `masterTempo = false` 轨道：允许继续走变速变调路径
- `masterTempo = true` 轨道：必须走保调 time-stretch 路径

如果离线导出阶段暂时做不到真正的高质量保调 time-stretch，那么就不能把这个能力对外宣称为已经完整支持。

### 9. 对现有包络线系统的复用边界

可以复用：

- 参数切换入口
- 控制点编辑交互
- 撤销重做骨架
- 点归一化和排序逻辑
- 包络线持久化节流思路

不能直接复用：

- `gainEnvelope` 那套 `sec -> gain` 数据结构
- 以 dB/gain 为中心的 Y 轴映射
- “轨道内时间”作为唯一坐标的前提
- 现有“改 BPM 要不要重置包络线”的规则

因为 `BPM` 是单轨参数，但又需要做重叠区镜像同步，语义不同。

### 10. 与现有网格/首拍定义的关系

现有 `firstBeatMs`、`barBeatOffset`、`gridBaseBpm` 仍然保留，它们的职责不应被 BPM 包络线替代。

建议职责拆分如下：

- `firstBeatMs`：定义该音频内容的首拍位置
- `barBeatOffset`：定义大节线相位
- `originalBpm`：定义原始素材速度
- `gridBaseBpm`：定义该轨的节拍网格基准
- `bpmEnvelope`：定义该轨在各自时间上的 BPM 变化

也就是说：

- 轨道网格定义是素材属性
- BPM 包络线是混音编排属性

这两个层级不能再混成一个字段。

### 11. 迁移策略

旧项目没有 BPM 包络线时：

- 不报错
- 自动生成一条平直 BPM 包络线
- 默认值取首个有效轨道 BPM

若项目所有轨都没有有效 BPM：

- BPM 参数入口可显示禁用态
- 或先要求用户完成 BPM 分析

草案建议：

- 无有效 BPM 时，BPM 包络线入口可见但不可编辑
- UI 文案提示“需要至少一首带 BPM 的轨道”

### 12. 风险

#### 12.1 最大风险

真正的 `masterTempo/key lock` 需要可靠的保调 time-stretch。

如果底层仍然只是简单改 `playbackRate`，那用户一开 BPM 包络线就会听见音高跟着跑，`masterTempo` 名字就成摆设。

#### 12.2 第二风险

时间线宽度现在主要依赖固定时长计算。BPM 曲线一旦变成单轨变速曲线，轨道显示长度和局部时间映射仍然会变复杂。

#### 12.3 第三风险

UI 看起来像普通包络线，但它还带着重叠区自动镜像同步逻辑。如果提示不够清楚，用户容易误会其它轨为什么会跟着变。

### 13. 建议的分阶段落地

#### Phase 1

- 只完成文档、数据模型、UI 交互草案
- 明确 `BPM` 为单轨内部包络线
- 明确重叠区同步为镜像片段同步
- 明确 `masterTempo` 为 key lock 开关

#### Phase 2

- 落地 BPM 包络线数据存储
- 落地编辑器 UI
- 轨道内部显示真实 BPM 曲线
- 暂不开放正式导出

#### Phase 3

- 升级播放引擎，支持 tempo map 驱动
- `masterTempo = false` 先可用
- `masterTempo = true` 接入真正保调引擎

#### Phase 4

- 升级导出链路
- 确保播放与导出一致
- 补回自动混音、包络线预览、离线渲染细节

### 14. 当前草案结论

本方案确认如下：

- `BPM` 对用户来说是普通轨道包络线
- 数据归属在单轨内部
- 重叠区通过对应区间镜像同步来保证两轨 BPM 一致
- 是否变调不由 BPM 包络线决定，而由每轨 `masterTempo` 决定
- `masterTempo = true` 必须 key lock
- `masterTempo = false` 允许变调

这是当前最稳、规则最清楚、后续实现最不容易打架的方案。
