# RKB Beatgrid Solver 踩坑文档

## 1. 当前口径

从 Codex4 起，RKB beatgrid 验收只按 5ms 主口径讨论：

- `firstBeatPhaseAbsErrorMs <= 5ms`
- `gridMaxAbsMs <= 5ms`
- `bpmOnlyDrift128BeatsMs <= 5ms`
- `barBeatOffset` mod4 必须匹配

旧 2ms 阶段的 pass rate、split 成绩、`70%` 目标、sample/failure 数量和边界样本结论全部作废。
它们不再用于判断当前算法好坏，也不再作为后续调优目标。

当前 5ms baseline：

| split | selected | candidate oracle | 主要剩余失败 |
| --- | ---: | ---: | --- |
| train | `395 / 527 = 74.95%` | `512 / 527 = 97.15%` | `first-beat-phase 106`，`downbeat 14`，`bpm 11`，`half/double 1` |
| tune | `159 / 201 = 79.10%` | `193 / 201 = 96.02%` | `first-beat-phase 32`，`bpm 6`，`downbeat 4` |
| holdout | `130 / 203 = 64.04%` | `194 / 203 = 95.57%` | `first-beat-phase 60`，`downbeat 10`，`bpm 3` |
| all | `684 / 931 = 73.47%` | `899 / 931 = 96.56%` | `first-beat-phase 198`，`downbeat 28`，`bpm 20`，`half/double 1` |

核心判断：

```text
候选覆盖已经很高。
当前主瓶颈不是“有没有生成正确候选”，而是 scorer / selector 没有稳定选中 Rekordbox 风格 phase。
```

当前有 `215` 首是候选池里存在 5ms passing candidate，但最终 scorer 没选中。剩余优化应优先解决
phase 语义和 selector 泛化，而不是继续堆候选数量。

## 2. 已失效内容

以下 2ms 阶段内容不再保留为文档正文，也不要在后续讨论中引用为当前依据：

- 2ms pass/fail 数字。
- 2ms split 成绩。
- 2ms 口径下“是否达到 70%”的目标判断。
- 2ms sample / failure 目录数量。
- 基于 2ms 边界样本得出的微小阈值调参。
- `same-BPM guard`、`top240 compact oracle` 等 2ms 历史成绩。
- Codex1 / Codex2 / Codex3 的交接 prompt。

这些东西最多解释历史过程，不再影响当前路线。

## 3. 仍然有效的教训

2ms 阶段虽然口径作废，但踩坑结论仍然有用。不要重复以下方向。

### 不要继续扫 topN selector

已经试过 top3 / top5 / top10 / top20 / top80 / top240 的二次 rerank、source filter、
phase cluster consensus、closest-to-legacy、rank 扩展和 hard-negative mining。

结论：

```text
正确候选常在 topN 里，但现有生产特征不足以稳定区分正确候选和错候选。
继续换 topN 或扫阈值只会制造样本内巧合。
```

### 不要直接上小模型

线性模型、logistic、shallow tree、小 MLP、listwise / pairwise ranker 都已经踩过坑。

问题不是模型写法，而是样本和特征不够支撑泛化：

- train 容易涨，tune / holdout 不稳。
- 很容易偷偷学到当前 931 首样本库偏差。
- 部分历史实验还出现过 `barOk`、`pass`、`category` 等评测字段泄漏风险。

后续没有 blind 数据和新证据源前，不要再把小模型当主线。

### 不要把 source 当生产优先级

`source` 只能用于日志、消融和错误归因。不要写“某来源优先”“某来源禁用”的生产规则。

已知问题：

- 主战场常发生在同 BPM、同 bar、同 source 内部的几毫秒 phase 排序。
- 来源优先级解决不了同源内 phase 语义。
- source rule 很容易变成当前样本库补丁。

### 不要直接加权 front-edge / leading-edge / 12ms residual

front-edge、leading-edge、signed phase shift、BeatThis residual 的统计现象存在，但直接加权会退化。

保留判断：

```text
这些字段可以做离线验尸和诊断报告里的解释层。
它们不能直接作为 scorer bonus、hard guard 或全局 phase shift。
```

原因：

- 正确 phase 有时更靠近前缘，有时更像峰值中心或视觉网格习惯。
- 全局固定 offset 不成立。
- 强瞬态、强 downbeat 反而经常把 scorer 拉向错误 phase。

### 不要继续调 cached envelope phase-DP 第一版

Codex3 的 cached envelope phase-DP 证明了一个问题：DP 形式对，不代表 emission 语义对。

第一版 DP 稳定追逐 full/low attack envelope 和 beat-logit 的强 front phase，但这不等价于
Rekordbox firstBeatMs。

不要继续调这些参数：

- full / low attack front score 权重。
- beat-logit front score 权重。
- global DP 转移半径 / 转移惩罚。
- anchored DP 搜索半径。
- 最近 same-BPM candidate 投影阈值。

如果重做 phase-DP，必须先换 emission 语义。

### 不要把 timeBasis / encoder 分组 shift 当修复

按 `timeBasis.offsetMs`、encoder、文件扩展名或稀有组合做 phase shift，本质是过拟合。

允许用 time basis 修坐标；禁止用它当“某类文件统一挪几毫秒”的经验补丁。

### 不要混淆 beat phase 和 downbeat

5ms 下主要失败仍然是 first-beat phase。downbeat 是另一个问题。

后续必须拆成三层：

- tempo solver
- beat phase solver
- bar phase / downbeat solver

不要用一个混合总分同时修 phase 和 downbeat。downbeat evidence 强，不代表 firstBeatMs 正确。

## 4. 禁止泄漏字段

生产 solver / scorer / selector 禁止读取：

- `truth`
- `pass`
- `category`
- `phaseAbs`
- `gridMax`
- `barOk`
- `bestPass`
- benchmark 误差
- pass/fail 分类
- 失败类型
- fileName / basename / path
- title / artist
- train / tune / holdout split
- 当前样本身份或逐曲标签

这些字段只能用于离线验收、报告、诊断脚本和错误归因。

## 5. 后续有效方向

### 先补 blind truth

当前 931 首已经被多轮实验反复看过。哪怕生产代码不读取文件名或 truth，只要继续根据这批样本扫规则，
也会形成样本记忆。

blind truth 要求：

- 新增 `200 - 500` 首此前没参与调参的 Rekordbox truth。
- 字段至少包含 `fileName`、`bpm`、`firstBeatMs`、`barBeatOffset`。
- 冻结当前 5ms baseline 后再跑 blind。
- blind 结果只汇报，不现场调参；一旦按 blind 调参，这批数据就不再是 blind。

### 新证据源要解释 phase，不是重排候选

下一步算法不应再从“topN 里猜哪个像 truth”开始，而应从“为什么这个 phase 是正确 grid”开始。

优先方向：

- Rekordbox 可见 waveform / raw waveform 的显示口径。
- first-beat anchor 的局部语义，而不是全曲强峰。
- intro 可信度、首段结构和首个稳定网格区间。
- 真正的 phase path / DP：对每个 tempo hypothesis 在时间轴上求 phase path，允许局部缺失、
  弱瞬态、intro 不可信和分段差异。
- 输出 phase margin、segment agreement、low-confidence reason，而不是只输出一个貌似确定的 grid。

### confidence 必须真实可用

当前 high confidence 体系还没有发挥产品价值。后续 confidence 必须满足：

- high confidence 覆盖一部分样本。
- high confidence pass rate 明显高于全量。
- low confidence 不硬装正确。
- low confidence 可以走人工检查或 legacy 对照，但不能悄悄覆盖正确新候选。

## 6. 验收规则

任何新实验必须报告：

- train / tune / holdout / all。
- selected pass rate。
- candidate oracle。
- scorer missed while oracle exists。
- `pass -> fail` 和 `fail -> pass`。
- BPM 大错率。
- phase 误差分布。
- downbeat 回归。
- 是否使用了任何禁止字段。

继续推进的最低标准：

- all 高于当前 `73.47%`。
- holdout 高于当前 `64.04%`。
- train / tune / holdout 不出现靠某一 split 硬撑的假提升。
- 没有新增无法解释的 `pass -> fail`。

阶段性突破标准：

- all `>= 80%`。
- holdout `>= 75%`。
- high confidence pass `>= 85%`。
- high confidence coverage `>= 50%`。

接近产品化标准：

- all `>= 85%`。
- holdout 接近或超过 `80%`。
- high confidence pass 稳定高于 `90%`。
- low confidence 能可靠识别。

## 7. 当前结论

```text
2ms 成绩数字作废。
候选池覆盖仍然很强。
selector / phase 语义仍是主瓶颈。
不要继续扫 topN、source、小模型、front-edge bonus 或 timeBasis shift。
下一步优先准备 blind truth，并做能解释 Rekordbox phase 语义的新证据源。
```
