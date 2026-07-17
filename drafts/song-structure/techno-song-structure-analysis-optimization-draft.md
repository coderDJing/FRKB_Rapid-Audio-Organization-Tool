# 面向 Techno / EDM 的歌曲段落分析优化草案

> 当前状态（2026-07-17）：冻结基线为原生四拍网格 `v26`，当前待试听候选为 `v27`。v26 起不再依赖大节线、
> 小节线或固定 phrase 相位，只允许连续四拍 downbeat 作为结构落点；补齐持续下降入口、宏观
> Active / Inactive 状态、Breakdown / Build 后强重入、短状态稳定性、终局 Outro 与相邻同标签
> 归并，并统一正式 Worker、inspector 与 benchmark 的 MP3 native-libav 解码路径。v27 在此基础上
> 增加低频基础真实落地、长 Build 延伸、直接 `Drop → Build → Drop` 与保留低频的终段 Outro 识别。
> 本文保留架构
> 演进和历史实验背景；
> 样本位置、人工真值、prediction baseline、benchmark 命令与后续会话入口，以
> `drafts/song-structure/song-structure-truth-benchmark-workflow.md` 为唯一有效流程文档。本文后续出现的
> `v16 / v17 / v22`、`bar / phrase / 大节线 / 小节线` 表述都属于当时阶段记录，禁止据此判断
> 当前实现状态或恢复已经删除的层级语义。

创建日期：2026-07-10

状态：历史架构与实验记录；冻结基线为 v26，当前待试听候选为 v27，真实样本与验收口径见唯一流程文档

历史 v17 是用于先看实际效果的第一版：

- 已实现 bar 级稳健特征、MSAF 风格 recurrence/path affinity、Laplacian 光谱聚类和六类语义解码。
- 已统一固定网格与动态网格的 bar 投影。
- 已补入自适应 novelty 门槛、同质歌曲单段 Groove、纹理 Groove 边界保留、段内持续 Build ramp 证据、Breakdown 直接进入 Drop、动态 clip 弱候选和 Worker 缓存重算。
- 已建立 11 条结构合成回归、4 条 compact feature 提取测试、1 条 Worker 任务所有权回归，以及可输出边界 / emission 的只读诊断入口，但这些测试不能替代真实 Techno 真值集。
- 网格修改会先取消同曲旧任务；Worker 结果提交同时校验任务所有权与当前网格，旧 handler 不能删除新任务状态、复用已终止 Worker 或广播旧 signature 的结构。
- 已增加 `--absolute-bands --feature-rate 8|16|32` 离线 A/B；absolute 实验尚未切换生产 winner，也尚未建立 SQLite feature cache。
- 当前仍从 `UnifiedDisplayWaveform` 派生 low / mid / high presence，尚未落地独立 absolute band 特征缓存。
- 目标架构中的独立缓存、人工真值 benchmark 和数据驱动语义分类仍属于后续阶段。

## 当前 v26 冻结基线与 v27 待试听候选

- 输入时间基统一为零基、半开区间的四拍 downbeat ordinal；历史 prediction 的 `startBar / endBar`
  只在 benchmark 兼容读取层存在。
- 方向边界负责 Fall / Landing / Switch；语义后处理拆为 Activity、Macro Activity、Build、Outro、
  Structural Reentry 和稳定状态模块，禁止再用“段落超过半曲就硬切同标签”这类模板修复。
- 完整分析缓存只要格式、网格 signature 和必要字段可用，就继续尊重旧结果；算法升级不会未经用户
  选择自动覆盖已有完整结构。查看 v26 效果需主动重新分析曲目。
- 实际样本、人工 truth、prediction baseline 和 benchmark 指标均为本机私有数据，不再提交 Git。
  当前数量与批准状态必须通过本机 manifest 和报告读取，禁止在本文固化逐曲信息。
- v27 不覆盖 v26 baseline。候选规则要求 Drop 落地同时具备结构边界、低频基础回归和落地后的
  activity / foundation，避免只有高频与密度增强时误判 Drop。
- v27 允许把低频持续缺失的伪 Drop 延长回 Build，并识别低频抽离、高频张力增加的直接
  `Drop → Build → Drop`；保护完整 Drop 与完整 Breakdown，禁止跨段吞并已批准结构。
- 直接 Build 的多块宏观边界可能比真实起始沿晚 1–3 个四拍块。v27 会在宏观边界确认后向前
  回溯，只有当前块与下一块都持续出现低频基础下降、高频张力上升和 activity 下降时，才采用
  更早的起点；单块 fill 或瞬时抽空不得触发回溯。
- v27 的 Outro 可以在尾段仍保留低频时开始，但必须有歌曲后 13% 内的强结构退出和持续性证据；
  同时识别后续恢复，避免把临时削减当成 Outro。
- v27 已用本机真实音频完成逐曲回归，并补齐直接 Build 起始沿回溯和尾部低频回归型 Outro；具体
  曲名、边界、truth 覆盖率和指标只保留在本机数据集与报告中。该开发集仍不代表新的盲测泛化证据。

## 1. 目标

本草案针对当前歌曲段落分析在以下音乐上的明显弱点：

- 动态范围较小、母带压缩较强的 Techno。
- 四拍底鼓长期稳定，能量和低频没有明显大起伏。
- 主要通过增减打击乐、合成器层、滤波、音色和密度完成段落变化。
- 同一 groove 长时间重复，只在 8 / 16 / 32 小节处发生细微结构变化。
- 允许没有传统“大 Drop”的电子舞曲。

目标不是做完整的音乐学结构理解，而是服务 FRKB 的 DJ 使用场景：

- 找到可点击、可跳转、适合试听和筛歌的主要段落边界。
- 稳定区分 `intro / groove / breakdown / build / drop / outro`。
- 尤其控制 `drop` 误报，因为播放范围功能默认会使用 `drop`。
- 固定网格和动态多 clip 网格得到一致语义的结果。
- 用户修改网格后，只重新投影和解码结构，不重新解码整首音频。

## 2. 结论先行

当前问题不能靠“把阈值调低”解决。

根因分成四层：

1. **表示层信息不足**：结构算法主要看到总峰值、总峰值上升和相对三频颜色，已经丢掉大量绝对分频、纹理和节奏型信息。
2. **边界和标签耦合**：固定结构模板既决定边界又决定标签，细微但稳定的边界证据很难独立发挥作用。
3. **模型先验偏向大起伏 EDM**：低频、总能量和明显 bass rise 权重过高，持续高能 Techno 容易被强行解释成 Drop，或者直接退化成整首 Groove。
4. **没有结构真值 benchmark**：目前无法判断一次调参究竟是在修复 Techno，还是在扩大误报并破坏原本表现良好的歌曲。

推荐路线：

1. 先建立人工结构真值、冻结 v16 基线和回归门槛。
2. 利用当前 Rust Mixxx 波形链路已经生成的 absolute `low / mid / high / all` 包络，建立轻量、网格无关的结构特征缓存。
3. 固定和动态网格统一投影成 bar 时间线。
4. 使用曲内稳健归一化、多尺度 Foote novelty、phrase 级 recurrence 生成独立边界候选。
5. 再用候选约束的半马尔可夫 / DP 解码六类标签，不再枚举固定歌曲模板。
6. 证据不足时输出 `groove`，允许整首歌没有 `drop`。

## 3. 当前链路

当前主链路大致是：

```text
PCM
  -> Rust Mixxx waveform：absolute low / mid / high / all
  -> Raw FFT color：相对 low / mid / high
  -> UnifiedDisplayWaveform
       只用 all 生成 height
       attack 由 height 的正向变化生成
       保存相对 colorLow / colorMid / colorHigh
  -> 固定网格：8-bar 模板特征 + bar 级 algorithmic 候选
  -> 动态网格：bar 级特征直接进入原模板
  -> 六类 SongStructureSection
```

主要实现位置：

- `src/main/workers/keyAnalysisWorker.ts`
- `src/shared/unifiedDisplayWaveform.ts`
- `src/shared/songStructureAnalysis.ts`
- `src/shared/songStructureAlgorithmic.ts`
- `src/shared/songStructureDynamicBoundaries.ts`
- `src/shared/songStructureWholeSong.ts`
- `src/shared/songStructureCommon.ts`

## 4. 当前算法为什么依赖“大起伏”

### 4.1 总峰值波形不适合单独承担 Techno 结构识别

`UnifiedDisplayWaveform.height` 来自 Mixxx `all` band 的峰值摘要。

对强压缩 Techno 而言：

- kick 和 bass 可能从头到尾都接近同一峰值。
- 新增 hi-hat、ride、clap、噪声层或 synth，不一定明显抬高总峰值。
- filter sweep 和声部替换更像频谱纹理变化，不像响度阶跃。
- 母带 limiter 会进一步抹平段落间的峰值差。

因此，当前 `energy` 很容易全曲接近常量。

### 4.2 `attack` 不是鼓点密度或分频 onset

当前 `attack` 由显示波形 `height` 的逐帧正向差生成：

```text
directRise = max(0, height - previousHeight)
smoothRise = max(0, height - previousSmooth)
```

这只能描述总峰值包络的上升，不知道上升来自：

- 低频 kick；
- 中频 clap / synth；
- 高频 hat / ride；
- 噪声 riser；
- 或量化后的微小峰值抖动。

随后算法又按整 bar 或整 8-bar 求均值和峰值，四拍底鼓的稳定节奏型会被压成几乎相同的统计量。

### 4.3 已有 `colorMid` 没有进入结构距离

`UnifiedDisplayWaveform` 已保存 `colorLow / colorMid / colorHigh`，但当前结构特征基本只使用 low 和 high。

这会直接漏掉 Techno 中常见的变化：

- 中频 synth layer 进入或退出；
- clap、tom、percussion 的纹理替换；
- 中频滤波开合；
- vocal chop 或 stab 的加入；
- groove 不变但音色主体改变。

### 4.4 相对频带颜色不能代替 absolute band

当前 Raw FFT color 会把 low / mid / high 除以三者中的最大值。

它表达的是“这一帧哪一段频率更占优势”，不是该频带的绝对强度。至少一个频带通常接近满值，容易出现：

- 整体很弱和整体很强的两帧具有相似颜色；
- 频带共同增减时变化被抵消；
- 小动态歌曲的 band share 有变化，但缺乏 absolute envelope 佐证。

当前 `bass = sqrt(height * colorLow)` 试图补偿这一点，但之后又同时使用 `height / low / bass / density`，低频和总能量被重复计权。

### 4.5 边界阈值大量使用绝对差值

现有逻辑包含多组固定的 rise、novelty 和 contrast 区间，例如：

- bass rise；
- immediate bass rise；
- low rise；
- energy rise；
- novelty；
- Foote novelty；
- boundary contrast。

明显起伏歌曲容易跨过这些区间；平缓 Techno 的真实变化常常落在字节量化和固定阈值之间。

单纯降低这些阈值会把以下内容一起放大：

- 母带抖动；
- 单次 fill；
- crash 尾音；
- 编码噪声；
- 网格轻微误差；
- 每 bar 固有的 kick 差异。

正确方向是曲内稳健标准化、局部显著度和多特征一致性，不是全局降阈值。

### 4.6 recurrence 比较的是单 bar，不是 phrase

当前 recurrence 为每个 bar 寻找远处最相似的单 bar。

Techno 的问题恰好是：

- 四拍底鼓使很多 bar 天生相似；
- 不同段落可能共享相同 kick 和 bass；
- 真正的结构差异存在于连续 4 / 8 / 16 bar 的层次、趋势和节奏型中。

单 bar recurrence 会把全曲都判断为高重复，无法说明“哪个完整 groove 又出现了”。

### 4.7 固定模板在决定边界前就假定了歌曲结构

当前模板和 algorithmic 路径包含有限的状态序列，例如双 Drop、单 Drop、带 Groove 的双 Drop。

这不适合以下结构：

- 全曲持续高能但每 16 bar 换一层纹理；
- 多个短 breakdown；
- 没有传统 Drop；
- 三个以上主段落；
- intro 和 outro 仍然保留完整 kick；
- build 主要依靠 filter / percussion，而不是 bass 明显下降。

需要先回答“边界在哪里”，再回答“这个区段是什么”，不能用固定标签序列反推所有边界。

### 4.8 模板置信度与 algorithmic 分数不在同一量纲

模板区段目前会得到大约 `0.76–0.86` 的固定置信度。

`buildAlgorithmicSongStructureSections()` 又把自己的平均目标分数与模板平均置信度直接比较，只有明显高于模板时才覆盖。

这会造成：

- 模板的固定常量被当成真实证据；
- bar 级候选即使边界更合理，也可能因分数量纲不同被丢弃；
- 平缓 Techno 的 algorithmic 分数天然更难超过固定模板。

### 4.9 动态网格路径缺少完整算法分段

进一步核对 `SongBeatGridLineLevel` 后确认：动态运行时的 `level: 'bar'` 表示 32 拍 / 8 小节 phrase，`level: 'beat4'` 才表示普通 4 拍小节。早期草案把 `'bar'` 误读成了每小节边界，该判断已纠正。

真正的问题是：

- 动态路径只运行模板分段，不调用固定路径的 algorithmic DP。
- 人工 clip 边界会与 8 小节 phrase 边界共同进入模板，其中可能包含非标准长度区间。
- clip 边界代表 BPM / 相位修正点，不一定是音乐结构边界。
- 固定和动态路径最终使用不同的候选与评分能力。

v17 已改为两种网格先统一投影到连续 bar 特征，再进入同一套光谱聚类和语义解码；动态 clip 边界只保留为弱证据。

### 4.10 一个明确的统计量错误

`songStructureAlgorithmic.ts` 的 build 评分使用 `values.attack` 时，阈值来自 `medianTension / p75Tension`，而不是 attack 自身的统计量。

这会让 attack 和 tension 两个不同量纲发生混用。应在建立基线后作为独立消融项修复，但它本身仍不能解决 Techno 的表示层问题。

## 5. 设计原则

### 5.1 边界发现和标签解码分开

边界层只输出：

- bar 位置；
- 边界显著度；
- 证据来源；
- 多尺度稳定性；
- 与 4 / 8 / 16 bar 的对齐关系。

标签层再基于完整区段输出：

- kind；
- confidence；
- 区段能量和频谱摘要。

### 5.2 结构特征与网格解耦

基础特征缓存只依赖：

- 音频文件；
- Mixxx / 特征提取参数版本；
- 固定时间采样率。

不得依赖：

- BPM；
- first beat；
- bar beat offset；
- `SongBeatGridMap.signature`；
- 段落算法版本；
- 标签权重。

这样修改固定或动态网格后，只需重新做：

```text
时间帧 -> beat / bar 投影 -> novelty / recurrence -> 边界 -> 标签
```

不需要重新解码 PCM。

### 5.3 曲内相对变化优先，绝对强度保留小权重

Techno 的“高能”通常是整首歌的常态。关键是某一段相对本曲其他位置发生了什么变化。

算法应同时保留：

- 小权重 absolute envelope；
- 全曲 robust z-score；
- 局部 4 / 8 / 16 bar 对比；
- 进入和退出方向；
- 多频带变化是否一致。

### 5.4 4 / 8 / 16 bar 是软先验，不是硬模板

EDM 边界高度偏向乐句网格，但仍存在：

- 提前一 bar 的 fill；
- 多一 bar 的过门；
- 短 break；
- 动态 clip 边界；
- 人工网格误差。

因此应把 phrase alignment 作为 bonus 和 peak snapping 依据，而不是禁止非标准长度。

### 5.5 `drop` 精度优先

由于 `src/shared/playbackRange.ts` 默认选择 `drop`：

- 不确定的高能段优先标 `groove`；
- 允许歌曲没有 `drop`；
- 只有“区段本体 + 入口对比 + 持续性”共同成立时才输出 `drop`；
- 不能用“全曲最响的一段”自动等同于 Drop。

## 6. 推荐目标架构

### 6.1 网格无关的轻量结构特征缓存

当前 Rust Mixxx waveform 已经产生：

- `bands.low`
- `bands.mid`
- `bands.high`
- `bands.all`

每个 band 都有：

- left / right body；
- peakLeft / peakRight。

这些数据在 `keyAnalysisWorker.ts` 中已经存在，只是构建 UnifiedDisplayWaveform 时主要使用了 `all`。

建议新增内部数据类型：

```ts
type SongStructureFeatureData = {
  cacheVersion: number
  extractorVersion: number
  durationSec: number
  frameRate: number
  frameCount: number
  allBody: Uint8Array
  allPeak: Uint8Array
  lowBody: Uint8Array
  lowPeak: Uint8Array
  midBody: Uint8Array
  midPeak: Uint8Array
  highBody: Uint8Array
  highPeak: Uint8Array
}
```

建议：

- 第一候选采样率为 `16 Hz`。
- 同时对 `8 / 16 / 32 Hz` 做离线消融后再冻结。
- 左右 body 可先取均值，peak 取左右最大值。
- 每个目标窗口保存稳健均值和 p90 / peak，不直接抽一个源帧。
- 基础缓存保持字节数组，解码阶段再转 Float32。

10 分钟歌曲、16 Hz、8 通道的未压缩主体约为：

```text
600 × 16 × 8 = 76,800 bytes
```

相对现有高分辨率显示波形很小，且 deflate 后通常还能继续下降。

注意：

- Mixxx absolute band 仍是经过 band-specific scale 的字节包络，不是跨歌曲可直接比较的声压真值。
- 它适合做同一首歌内部的相对结构分析。
- 上线前必须统计各 band 的零值率、255 饱和率和有效动态范围。
- 如果数据已严重饱和，再考虑修改 Rust 输出；不要提前重写 DSP。

### 6.2 统一的网格投影

新增统一的 `BarSpan[]`：

```ts
type SongStructureBarSpan = {
  startSec: number
  endSec: number
  barOrdinal: number
  clipIndex?: number
  phrasePhase: number
}
```

规则：

- 固定网格和 `SongBeatGridMap` 都先转换为同一结构。
- `barOrdinal` 全曲连续，不在动态 clip 边界重置。
- phrase phase 由累计 bar 决定。
- 动态 clip 边界只提供软先验，不强制成为歌曲结构边界。
- 等价的固定网格和单 clip 投影必须得到一致结果。

### 6.3 bar 级多视图特征

从固定时间缓存投影到每个 bar 后，生成以下特征。

#### 绝对包络视图

- all / low / mid / high 的 body 均值、p50、p90。
- peak。
- crest：peak 与 body 的关系。
- active occupancy：超过本曲局部基线的帧比例。

#### 频谱纹理视图

- low / mid / high share。
- 频谱重心代理。
- 频带熵 / 平坦度代理。
- low-mid、mid-high 对比。
- 每个 band 的正向 / 负向 flux。

#### 节奏和瞬态视图

- all / low / mid / high 的 onset density。
- 每拍和半拍位置的 attack occupancy。
- 16 分格 pulse profile，至少保留 kick、offbeat、hat 密度差异。
- bar 内 transient 分布，而不只是整 bar 最大值。

#### 趋势视图

- 1 / 2 / 4 bar 差分。
- 4 / 8 / 16 bar slope。
- 相对前一 phrase 的进入变化。
- 相对后一 phrase 的退出变化。

### 6.4 稳健归一化

每个连续特征先做适当的 log compression，再计算：

```text
robustZ = clip(
  (x - median) / (1.4826 × MAD + scaleFloor),
  -4,
  4
)
```

同时：

- 对 p2–p98 winsorize。
- MAD 很小时使用特征级尺度下限，禁止把 1 个字节的量化噪声放大成强边界。
- absolute、global robust-z、local contrast 分开保留。
- energy / timbre / rhythm 分视图归一化后再融合，避免 bass 再次支配全部距离。
- 边界权重和标签权重分开配置。

“平缓模式”不应成为一个靠手工阈值触发的独立算法分支。稳健标准化应该让同一套算法自然适配高动态和低动态歌曲。

### 6.5 多尺度 SSM 与 Foote novelty

在 bar 级特征上构建 self-similarity matrix，不在 1200 Hz 显示帧上构建。

分别构建：

- energy view；
- timbre / band view；
- rhythm / pulse view。

对每个视图：

- 使用 cosine 或稳健尺度后的距离；
- 使用 4 / 8 / 16 bar Gaussian checkerboard kernel；
- 正确处理边缘核归一化；
- 对每条 novelty curve 再做局部 median / MAD 显著度标准化；
- 保留 local prominence，而不是只看绝对峰值。

融合时应奖励多特征一致性：

```text
一个中等 energy 变化
+ 一个中等 timbre 变化
+ phrase 对齐
```

可以比单次很强的 crash / fill 更可信。

### 6.6 phrase 级 recurrence

recurrence 应比较连续序列：

- 4-bar phrase；
- 8-bar phrase；
- 16-bar phrase。

第一版可以使用：

- 对齐后逐 bar cosine similarity 的平均；
- phrase 均值、方差、slope；
- pulse profile 相似度；
- 允许 `±1 bar` 的小范围对齐。

目标是找到：

- 同一 groove 家族再次出现；
- breakdown 后回到前一 groove；
- texture 相似但能量不同的变奏；
- phrase 家族在某个边界发生切换。

第一版不需要 DTW。只有 benchmark 证明固定对齐不足时再加入，避免计算和调参复杂度提前膨胀。

### 6.7 独立边界候选层

候选来源：

- 多尺度 Foote peak；
- phrase recurrence family change；
- band flux / texture change；
- rhythm density change；
- 4 / 8 / 16 bar 软先验；
- 动态 clip 边界软先验；
- 歌曲首尾强制边界。

候选筛选：

- 局部峰值；
- prominence；
- 非极大值抑制；
- 最小 bar 间距；
- 多尺度稳定性；
- 多证据一致性。

输出示意：

```ts
type SongStructureBoundaryCandidate = {
  barIndex: number
  score: number
  scaleSupport: number[]
  evidence: {
    energy: number
    timbre: number
    rhythm: number
    recurrence: number
    phrasePrior: number
    dynamicClipPrior: number
  }
}
```

这层必须能够独立跑 boundary precision / recall / F1，不能等标签完成后才知道边界好不好。

### 6.8 候选约束的半马尔可夫 / DP 标签解码

状态仍保持：

- intro
- groove
- breakdown
- build
- drop
- outro

但不再枚举固定歌曲模板。

允许：

- 任意歌曲没有 drop；
- groove 重复出现；
- 多个 breakdown / build；
- build 直接回 groove；
- drop 后直接 outro；
- 某些状态被跳过。

区段 emission 应使用完整区段的：

- absolute 和 relative 能量；
- low / mid / high 纹理；
- kick / hat / onset density；
- 区段内部稳定性；
- 进入和退出对比；
- 4 / 8 / 16 bar 趋势；
- recurrence family；
- 歌曲位置先验。

时长使用宽松软先验，不再硬编码“Drop 必须接近 32 bar”。

DP 只在稀疏边界候选之间搜索，并使用 prefix sum 计算区段统计，避免全 bar 全状态的无约束组合爆炸。

### 6.9 Techno 标签语义

#### Groove

默认的稳定活动段。

- 允许能量很高。
- 允许是全曲主体。
- 没有强 Drop 入口证据时，高能不自动升级为 Drop。

#### Drop

必须同时满足多类证据中的大部分：

- 相对前段存在明确入口变化；
- 入口变化可以是低频 / 脉冲恢复或音色重击，不要求总响度明显抬升；
- 低频 / 总能量或节奏密度持续活跃；
- 不是单 bar crash；
- 区段内部形成稳定 groove；
- 相对 `groove` 状态有足够 score margin。

#### Breakdown

不能只看低频变小，还应看：

- kick / low onset density；
- 纹理稀疏度；
- 与前后 active section 的对比；
- 是否保持 atmospheric / melodic 内容。

#### Build

Build 是可选状态，不是 Drop 前的必经状态。大量 Techno 合法结构是 `Breakdown -> Drop`，没有持续上升证据时禁止为了套模板补出 Build。

存在 Build 时应主要依靠趋势：

- high / mid flux 上升；
- onset density 或 tension proxy 上升；
- filter opening；
- low 可能下降，也可能不下降；
- 结尾连接到更活跃或纹理明显变化的段落。

Build ramp 的观察窗必须完全位于当前候选区段内部，并至少在多个子窗口中持续上升。禁止把后一个 Drop 的高能帧跨边界算进 Breakdown，也禁止把“前半平、后半突然阶跃”当成持续 Build。

#### Intro / Outro

位置是强先验，但不能要求一定低能。

Techno 的 DJ intro / outro 可以保留完整 kick，只是：

- 纹理较薄；
- percussion / synth layer 较少；
- recurrence family 与核心段不同；
- 层次逐渐加入或释放。

### 6.10 置信度

当前固定常量不能继续作为真实 confidence。

建议 confidence 来自：

- 边界候选在多尺度下的稳定性；
- 最优路径和次优路径的 margin；
- 当前标签相对第二候选标签的 margin；
- 真值集上的分桶校准。

首版仍可只输出现有单个 `confidence`，但它应表示边界和标签的联合可靠度。内部诊断要保留 boundary confidence 和 label confidence，便于后续决定是否扩展持久化 schema。

## 7. 评估体系

### 7.1 必须先建立真值

在没有结构真值集前，不应继续围绕个别歌曲调权重。

当前仓库已有 `songStructureSpectral.spec.ts` 的 11 条合成回归，以及 `inspect:song-structure -- --diagnostics` 的边界 / cluster / emission 诊断；它们已覆盖同质歌曲、平缓纹理、渐进 Build、4 小节短 Breakdown 直接进 Drop、非 ramp 阶跃、动态 grid signature 失效、动态 clip 和确定性。

仍然缺少离线真值 benchmark、质量指标报告和真实样本锁定集。现阶段不能把“合成测试全绿”当成算法质量合格，仍应仿照现有 beat grid 工作流新建本地 `structure-analysis-lab/`：

- `manual-truth/`：人工边界和标签。
- `features/`：可复用的 compact structure feature。
- `reports/`：v16 / candidate benchmark JSON。
- `diagnostics/`：bar feature、novelty、候选峰和最终路径证据。

生产结果生成必须调用同一套 TypeScript 算法核心，不能在 Python 中复制一份近似实现；Python 可以只负责指标汇总和报告。

建议先做 60 首 MVP：

- 30 首平缓 / 强压缩 / repetitive Techno。
- 10 首有明显 Drop 的 peak-time / melodic Techno。
- 10 首其他 House / EDM 回归样本。
- 5 首没有传统 Drop 的歌曲。
- 5 首动态多 clip 网格歌曲。

架构验证后扩展到约 120 首，并按 artist 隔离：

- calibration；
- development；
- locked holdout。

调参期间禁止反复查看 locked holdout。

音频不提交仓库。仓库可保存：

- 匿名或哈希化 manifest；
- bar / sec 边界和标签；
- 必要时保存无版权风险的 compact structure feature；
- benchmark 输出。

### 7.2 标注格式

每首歌至少记录：

- file hash / 本地路径映射；
- BPM、first beat、bar offset 或动态网格签名；
- boundary bar ordinal；
- startSec / endSec；
- kind；
- `acceptableKinds`；
- boundary uncertainty；
- 标注人和复核状态。

Techno 中 `groove / drop`、`breakdown / build` 可能有主观差异，允许保存严格标签和可接受标签集合，并同时报告严格 / 宽松指标。

### 7.3 核心指标

边界：

- `±1 bar` precision / recall / F1，作为主指标。
- `±2 bar` precision / recall / F1，作为宽松指标。
- 一对一边界匹配，防止多个预测同时命中一个真值。
- 预测段落数 / 真值段落数。
- 过分段率和漏分段率。

标签：

- 时间加权 macro F1。
- 每类 temporal IoU。
- 每类 precision / recall。
- 无 Drop 歌曲的 track-level Drop 误报率。

Drop 专项：

- temporal precision。
- track-level presence precision / recall。
- onset 中位误差和 p90。
- 预测 Drop 时长落在真值外的比例。

稳定性：

- 等价固定网格与单 clip 投影的一致性。
- 动态网格只改局部 clip 后，未受影响区段的稳定性。
- 相同输入重复运行的确定性。

性能：

- 特征提取耗时。
- 缓存写入 / 读取耗时。
- 网格修改后的结构重算耗时。
- SSM / recurrence / DP 耗时。
- 峰值内存。
- 单曲缓存体积。

### 7.4 建议的发布门槛

以下数值是首轮建议，必须在看到 vNext holdout 结果前冻结，不能事后按结果改门槛：

- Techno `±1 bar` boundary F1 相对 v16 提升至少 5 个百分点。
- 当前表现良好样本的 boundary F1 和 macro F1 退化不超过 2 个百分点。
- Techno Drop temporal precision 相对 v16 提升至少 8 个百分点，且目标不低于 0.85。
- 含 Drop 曲目的 track-level recall 不得靠“全部不报 Drop”明显下降。
- 无 Drop 曲目的误报率相对 v16 至少下降 30%。
- Drop onset 中位误差不超过 1 bar，p90 不超过 2 bar。
- 10 分钟歌曲的结构特征缓存原始主体控制在约 100 KiB 内。
- Windows 参考机器从缓存重算 10 分钟歌曲，p95 初始目标不超过 250 ms。
- 修改网格后的结构重算不得触发音频 decode。

这些门槛要同时报告绝对值和相对 v16 的变化，避免低基线下只看百分比产生误导。

### 7.5 2026-07-10 absolute band 首轮 A/B

当前只读实验路径会从 Worker 已有的 1200 Hz Mixxx 四频带结果聚合 compact feature，不会再次运行 Rust DSP。实验数据包含：

- `low / mid / high / all`；
- 每个频带的窗口 body mean；
- robust peak P90；
- 由 1200 Hz 包络先计算 fast / slow EMA 后再降采样的 onset；
- Rust high band 的 `value^0.632` 显示缩放会在聚合前反变换，避免把高频与其他频带放在错误量纲上比较。

三首现有 Techno / Deep Tech 样本的首轮结果：

| 样本 | 8 Hz 段数 | 16 Hz 段数 | 32 Hz 段数 | 16 Hz Build 数 |
| --- | ---: | ---: | ---: | ---: |
| ALISHA - Can't Touch Us | 15 | 16 | 16 | 1 |
| allfive - fieldwork | 16 | 17 | 17 | 1 |
| 7circle - sevastra | 15 | 16 | 14 | 0 |

表中结果已在“Build 必须是段内持续 ramp”守门修正后重跑。`allfive` 的 16 Hz Build 从 3 个降为 1 个，但这仍只能说明误报候选减少，不能说明剩余标签正确；所有真实样本仍需人工听感确认，不能因为 absolute 输入存在就默认它是真 Build。

16 Hz 当前实测：

- 约 344–354 秒歌曲的 12 通道原始 payload 为 `66–68 KiB`；线性外推 10 分钟约 `112.5 KiB`，略高于原草案约 100 KiB 目标。
- TypeScript 聚合约 `89–97 ms / 首`；谱分析约 `107–111 ms / 首`。
- 三首样本的 body 通道没有 255 饱和；all-band P90 peak 饱和约 `0–9.34%`，因此 peak 只能保留小权重。
- 8 Hz 在约 130 BPM 时不足以稳定支撑每 bar 16 个 pulse bin；32 Hz 是否带来可听收益仍需真值验证。16 Hz 暂时是首选，不是已经冻结的生产参数。

历史生产节点 `v17` 使用 pseudo-color 特征。absolute 实验只有在真值 / 人工试听证明收益后，才进入独立缓存和生产切换；正式切换时应升新算法版本，不能把旧 pseudo-color `v17` 当成同一结果继续复用。

## 8. 分阶段实施

### 阶段 0：冻结 v16 基线

先做：

- 标注规范。
- 60 首 MVP 真值。
- v16 全量输出快照。
- boundary、label、Drop、安全性和性能报告。

这一阶段不改算法行为。

### 阶段 1：验证表示层

实现离线实验，不立即切换生产结果：

- 从现有 Mixxx absolute bands 提取 8 / 16 / 32 Hz 特征。
- 统计零值率、饱和率和动态范围。
- 对比只用 UnifiedDisplay 与 absolute band 的边界候选上限。
- 验证 `colorMid`、absolute mid、band onset density 的增益。
- 验证 16-bin pulse profile 是否能区分平缓 Techno 的 layer 变化。

只有表示层对边界候选 recall 有稳定增益，才进入缓存和正式算法。

### 阶段 2：特征缓存和统一网格投影

实现：

- `SongStructureFeatureData`。
- 独立 SQLite cache。
- worker 生成和持久化。
- 固定 / 动态统一 `BarSpan[]`。
- 文件移动、重命名、删除、清理、stat 更新的完整缓存生命周期。

可先发布“只生成缓存、仍输出 v16”的过渡版本，提高缓存覆盖率，再切换 vNext，避免算法升级时全库同时重解码。

### 阶段 3：只优化边界

实现：

- robust normalization；
- multi-view bar feature；
- 多尺度 SSM / Foote；
- phrase recurrence；
- 稀疏边界候选。

此阶段先用真值标签或简单区段输出评估 boundary，不急着调六类标签。

边界候选 recall 未达到门槛前，不进入复杂标签解码。

### 阶段 4：半马尔可夫标签

实现：

- section emission；
- 软状态转移；
- 软时长先验；
- 最优 / 次优路径；
- Drop precision 优先校准；
- confidence 分桶校准。

### 阶段 5：受控切换 v17

历史工作区为了尽快人工试听，曾让实验性 `v17` 优先进入生产分析入口。这只是当时的工程验证状态，不代表当前 v26 的发布结论；当前验收以 benchmark 工作流文档为准。

满足全部条件后：

- 升级 `CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION`。
- 旧结构结果自然失效。
- 优先从 structure feature cache 重算。
- 缺失新缓存的旧歌曲首次允许重新解码并生成真实 absolute feature，不能拿旧 UnifiedDisplay 数据伪造迁移。
- 固定和动态网格都走统一新链路。
- v16 代码短期保留为 benchmark 对照，稳定后再删除。

## 9. 建议文件拆分

当前 `src/shared/songStructureAnalysis.ts` 已有 1077 行，新实现不能继续堆入该文件。

建议职责拆分：

- `src/shared/songStructureAnalysis.ts`
  - 输入验证；
  - 流程编排；
  - 最终结果组装；
  - 安全结果。
- `src/shared/songStructureFeatureData.ts`
  - 网格无关基础特征类型和编解码。
- `src/shared/songStructureGridProjection.ts`
  - 固定 / 动态网格统一 bar timeline。
- `src/shared/songStructureBarFeatures.ts`
  - bar 统计、pulse profile、趋势。
- `src/shared/songStructureNormalization.ts`
  - robust scale、winsorize、local contrast。
- `src/shared/songStructureSimilarity.ts`
  - 多视图距离和 SSM。
- `src/shared/songStructureFoote.ts`
  - 多尺度 checkerboard novelty。
- `src/shared/songStructureRecurrence.ts`
  - phrase 序列 recurrence。
- `src/shared/songStructureBoundaryCandidates.ts`
  - peak picking、prominence、NMS、先验融合。
- `src/shared/songStructureSectionScoring.ts`
  - 六类 section emission。
- `src/shared/songStructureDecoder.ts`
  - 半马尔可夫 / DP 和 confidence margin。
- `src/shared/songStructureEvaluation.ts`
  - 一对一 boundary matching 和质量指标。

现有文件处理：

- `songStructureAlgorithmic.ts`
  - 不继续追加 vNext；
  - 短期保留 v16 对照；
  - 新链路稳定后删除。
- `songStructureDynamicBoundaries.ts`
  - 结构分析职责迁入统一 grid projection；
  - 动态 clip 只保留网格事实语义。
- `songStructureWholeSong.ts`
  - 保留证据不足时的全曲 Groove 安全结果。
- `unifiedDisplayWaveform.ts`
  - 继续只负责显示波形；
  - 不把完整 absolute bands 强塞进显示缓存。

主进程建议新增：

- `src/main/libraryCacheDb/songStructureFeatureCache.ts`
- `src/main/services/keyAnalysis/structureFeaturePersistence.ts`

并修改：

- `src/main/workers/keyAnalysisWorker.ts`
- `src/main/services/keyAnalysis/types.ts`
- `src/main/services/keyAnalysis/workerPool.ts`
- `src/main/services/keyAnalysis/persistence.ts`
- `src/main/services/keyAnalysis/waveformPersistence.ts`
- `src/main/libraryDb.ts`
- `src/main/libraryCacheDb.ts`
- 现有 cache maintenance / move / remove / prune 链路。

当前数据库 schema 为 `35`。若新增独立表，预计升级为 `36`，实际实施时必须和同期迁移统一编号。

## 10. 需要先做的消融实验

每项只改变一个因素：

1. v16 原样。
2. 只修复 attack 使用 tension 统计量的错误。
3. 只让 `colorMid` 进入现有距离。
4. 只加入 Mixxx absolute low / mid / high。
5. absolute bands + robust normalization。
6. 再加入 bar 内 onset density / pulse profile。
7. 再加入多尺度标准 Foote。
8. 再加入 phrase recurrence。
9. 最后替换固定模板为候选约束解码。

目的：

- 确认增益来自哪里；
- 避免一次改十个权重后无法解释；
- 识别对明显起伏歌曲的回归来源；
- 防止“复杂度增加但真值指标没有提升”。

## 11. 不建议直接做的方案

### 11.1 只降低阈值

会把平缓歌曲的量化噪声、fill 和 crash 一起放大，Drop 误报风险最高。

### 11.2 继续增加固定模板

模板只能记住更多已知排列，不能解决未知结构、无 Drop 和动态网格粒度问题。

### 11.3 只把 `colorMid` 加进当前距离

这是合理消融项，但仍然没有 absolute mid、节奏型、稳健归一化和边界 / 标签解耦，不能作为最终修复。

### 11.4 把 absolute bands 塞进 UnifiedDisplayWaveform

显示缓存和结构缓存的生命周期、采样率、参数版本不同。继续耦合会让以后改 UI 波形时误伤结构分析，反之亦然。

### 11.5 在 1200 Hz 帧上构建全曲 SSM

没有必要，内存和时间都会爆炸。SSM 只应在 bar 或 phrase 表示上构建。

### 11.6 把动态 clip 边界强制当作结构边界

用户拆 clip 是为了修 BPM / 相位，不代表音乐在该点发生段落变化。只能作为软先验。

### 11.7 直接引入大型神经网络

当前还没有：

- FRKB 自己的结构真值；
- 可复现 benchmark；
- 推理预算；
- 模型缓存和打包方案；
- 置信度校准。

先把现成 absolute band、SSM、recurrence 和解码做对。只有 benchmark 证明手工表示达到上限后，再评估 EDM 专用 learned embedding。

### 11.8 用歌曲名、歌单或风格标签触发特判

运行时只能依据音频和网格证据。风格分层只用于 benchmark 报告，不能成为隐藏算法分支。

## 12. 风险与防护

### absolute band 饱和

- 先统计，不假设。
- 若大量 255，考虑调整 Rust 的结构特征输出尺度，而不是在 TS 端继续放大。

### robust normalization 放大量化噪声

- 使用 MAD floor。
- 要求时间持续性。
- 使用 prominence 和 phrase recurrence。
- 多特征一致时才提高边界分数。

### SSM 二次复杂度

- 只在 bar 数量上计算。
- 使用 Float32。
- 保留当前合理 bar 上限。
- 必要时只保存上三角或按视图分批计算。

### 全库重算

- 特征缓存和 v17 分两步发布。
- 缓存先覆盖，算法后切换。
- 后台队列限速。

### Drop 召回被过度压低

- 同时锁定 precision 和 recall 门槛。
- 真值集必须包含“有 Drop”和“无 Drop”歌曲。
- 不允许用全部标 Groove 获得虚假高 precision。

### 动态网格回归

- 建立“等价固定 / 单 clip”一致性测试。
- 建立局部 clip 修改只影响邻近结构的稳定性测试。

## 13. 外部方法依据

本草案采用的方向与以下成熟方法一致，但不要求直接引入其运行时：

- Jonathan Foote, 2000，基于 self-similarity 和 checkerboard kernel 的 audio novelty：
  - https://ccrma.stanford.edu/workshops/mir2009/references/Foote_00.pdf
- Bruno Rocha 等，2013，面向 EDM 的 beat-aligned timbre segmentation：
  - https://doi.org/10.6084/m9.figshare.1181795.v1
- Brian McFee 与 Daniel Ellis，2014，结合局部连续性与长程 recurrence 的 Laplacian segmentation：
  - https://archives.ismir.net/ismir2014/paper/000319.pdf
- 2024 年 EDM switch point 可解释性研究：
  - https://www.mdpi.com/2624-6120/5/4/36

这些工作共同支持：

- EDM 的边界不能只看响度；
- timbre / instrumentation 的进入和退出很重要；
- beat / downbeat 对齐能显著改善边界定位；
- novelty、homogeneity、repetition 和时长规律需要共同使用；
- 频谱、能量和鼓点密度之间存在交互，单一 bass 特征不足以决定结构。

## 14. 下一步建议

下一轮不要直接改 `songStructureAlgorithmic.ts` 的权重。

最优先做三件事：

1. 建立 60 首结构真值 MVP，并保留 v16 / 历史实验性 v17 报告作为演进对照。
2. 用熟悉的 Techno 样本人工复核 pseudo-color 与 absolute 8 / 16 / 32 Hz 输出，先锁定边界和 Build / Drop 语义，再冻结帧率与通道。
3. 在边界 benchmark 成立后，确定 `SongStructureFeatureData` 和独立缓存 schema；首版先随正常分析生成，不立即开启全库解码预热。

待确认的产品 / 工程决策：

- 首轮真值做 60 首 MVP，还是直接做约 120 首完整集。
- 匿名 compact feature 是否允许提交仓库；音频本身不提交。
- 是否将当前根级 Vitest 入口扩展为正式 benchmark runner，还是只保留纯 TS 回归测试。
- 首版是否只由解码器控制 Drop 置信度，暂不在 `playbackRange.ts` 再加第二层门槛。
