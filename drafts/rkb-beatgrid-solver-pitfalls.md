# RKB Beatgrid Solver 踩坑文档

## 1. 当前口径

从 Codex4 起，RKB beatgrid 验收只按 5ms 主口径讨论：

- `firstBeatPhaseAbsErrorMs <= 5ms`
- `gridMaxAbsMs <= 5ms`
- `bpmOnlyDrift128BeatsMs <= 5ms`
- `barBeatOffset` mod4 必须匹配

旧 2ms 阶段的 pass rate、split 成绩、`70%` 目标、sample/failure 数量和边界样本结论全部作废。
它们不再用于判断当前算法好坏，也不再作为后续调优目标。

当前 5ms selected（`constant-grid-dp` phase evidence v2 + phasePath diagnostic）：

| split | selected | candidate oracle | 主要剩余失败 |
| --- | ---: | ---: | --- |
| train | `396 / 527 = 75.14%` | `512 / 527 = 97.15%` | `first-beat-phase 105`，`downbeat 14`，`bpm 11`，`half/double 1` |
| tune | `159 / 201 = 79.10%` | `193 / 201 = 96.02%` | `first-beat-phase 32`，`bpm 6`，`downbeat 4` |
| holdout | `130 / 203 = 64.04%` | `194 / 203 = 95.57%` | `first-beat-phase 60`，`downbeat 10`，`bpm 3` |
| all | `685 / 931 = 73.58%` | `899 / 931 = 96.56%` | `first-beat-phase 197`，`downbeat 28`，`bpm 20`，`half/double 1` |

blind frozen baseline：

| dataset | selected | candidate oracle | 主要剩余失败 |
| --- | ---: | ---: | --- |
| blind all | `423 / 608 = 69.57%` | `599 / 608 = 98.52%` | `first-beat-phase 140`，`downbeat 27`，`bpm 16`，`grid-drift 1`，`half/double 1` |

blind selected（`constant-grid-dp` phase evidence v2 + phasePath diagnostic）：

| split | selected | 对 baseline | 备注 |
| --- | ---: | ---: | --- |
| train | `245 / 334 = 73.35%` | +1 |  |
| tune | `92 / 146 = 63.01%` | 0 |  |
| holdout | `88 / 128 = 68.75%` | +1 |  |
| all | `425 / 608 = 69.90%` | +2 | oracle `599 / 608 = 98.52%`；剩余 `first-beat-phase 139`，`downbeat 27`，`bpm 15`，`grid-drift 1`，`half/double 1` |

当前 production selected（v3 + rank1 structural phase v2）：

| dataset | selected | candidate oracle | 主要剩余失败 |
| --- | ---: | ---: | --- |
| current all | `702 / 931 = 75.40%` | `899 / 931 = 96.56%` | `first-beat-phase 179`，`downbeat 32`，`bpm 17`，`half/double 1` |
| blind all | `435 / 608 = 71.55%` | `599 / 608 = 98.52%` | `first-beat-phase 128`，`downbeat 29`，`bpm 15`，`half/double 1` |
| latest test-new-357 | `231 / 357 = 64.71%` | `343 / 357 = 96.08%` | `first-beat-phase 102`，`downbeat 14`，`bpm 7`，`half/double 2`，`grid-drift 1` |

核心判断：

```text
候选覆盖已经很高。
当前主瓶颈不是“有没有生成正确候选”，而是 scorer / selector 没有稳定选中 Rekordbox 风格 phase。
```

当前主 truth 有 `197` 首、blind 有 `164` 首、latest test-new-357 有 `112` 首是候选池里存在 5ms passing candidate，但最终 scorer
没选中。剩余优化应优先解决 phase 语义和 selector 泛化，而不是继续堆候选数量。

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

## 3. 坑位分级

2ms 阶段虽然口径作废，但踩坑结论仍然有用。不过不要把所有“不要”都理解成路线死亡。
本文件里的坑位按四档读：

- 硬坑：已经出现明确负向、泄漏或过拟合机制，production 禁止重复。
- 软坑：不能作为独立生产规则，但可以作为诊断、特征来源或受控消融继续研究。
- 有效信号但不能直接上线：已经看到稳定信号，必须锁定假设后用 fresh sealed 复验。
- fresh 待验证假设：当前 current/blind/latest test 上只算开发回归，不能包装成泛化证明。

### 软坑：不要把 topN selector 当独立生产规则

已经试过 top3 / top5 / top10 / top20 / top80 / top240 的二次 rerank、source filter、
phase cluster consensus、closest-to-legacy、rank 扩展和 hard-negative mining。

结论：

```text
正确候选常在 topN 里，但现有生产特征不足以稳定区分正确候选和错候选。
继续换 topN 或扫阈值只会制造样本内巧合。
```

topN 本身不是废路。它对候选覆盖、oracle missed、hard negative 采样和新特征验证仍然有用；
不能重复的是“没有新 phase 语义证据，只靠 rank/topN/阈值挑一个更像 truth 的候选”。

### 有效信号但不能直接上线：小模型只能做特征发现

线性模型、logistic、shallow tree、小 MLP、listwise / pairwise ranker 都已经踩过坑。

问题不是模型写法本身，而是样本和特征不够支撑直接泛化：

- train 容易涨，tune / holdout 不稳。
- 很容易偷偷学到当前 931 首样本库偏差。
- 部分历史实验还出现过 `barOk`、`pass`、`category` 等评测字段泄漏风险。
- 最新受控 phase-ranker 加入 onset-foot 特征后，tune 与 holdout 都能做到 current / blind
  正增且 `pass -> fail = 0`，但 tune-selected 配置 current 全量仍有 `pass -> fail = 1`。
  验证报告里有一个全 split 零伤害配置，但那是验后识别出的污染假设，不能当场上线。

后续不要把小模型当主线 production selector；它可以继续用来验证新 phase 特征有没有信号、
做消融、产生 locked hypothesis。真正上线前必须先锁配置，再用 fresh sealed 原样复验。

### 硬坑：不要把 source 当生产优先级

`source` 只能用于日志、消融和错误归因。不要写“某来源优先”“某来源禁用”的生产规则。

已知问题：

- 主战场常发生在同 BPM、同 bar、同 source 内部的几毫秒 phase 排序。
- 来源优先级解决不了同源内 phase 语义。
- source rule 很容易变成当前样本库补丁。

### 有效信号但不能直接上线：front-edge / leading-edge / onset-foot / rising-edge

front-edge、leading-edge、signed phase shift、BeatThis residual、onset-foot、rising-edge 的统计现象存在；
rising-edge locked ranker 已经进 production 并带来正向回归。坑不是这些信号源本身，而是直接加权会退化。

保留判断：

```text
这些字段可以做离线验尸、诊断报告、ranker 特征和 fresh sealed 待验证假设。
它们不能未经锁定与 fresh 复验就直接作为 scorer bonus、hard guard 或全局 phase shift。
```

第一版 intro leading-edge phase evidence 已经落地，但只允许在极保守 guard 下切换候选：
current `684 -> 685`，blind `423 -> 425`，formal v2 没有 `pass -> fail`。放宽阈值曾出现
current 回归和 `pass -> fail`，不能为了 blind 数字好看继续放水。

phasePath 分段证据只能留在诊断层，不能进入生产切换评分。包含 phasePath 权重的 v3 switch
在 train / tune 上看起来不退，但 blind holdout 从 `88 / 128` 退到 `87 / 128`，原因是丢掉
`Photay - Always Cosmic (Original Mix).mp3` 这首 v2 救回样本；恢复 v2 switch 后 current full
和 blind full 对 v2 都是 `0` 行级转移。

`rkb_phase_semantics_diagnostic.py` 进一步确认：first-beat-phase 失败大多不是缺候选，而是
5ms 级相邻 phase 选错。current 这类失败里 `177 / 197` 有 passing candidate，blind 是
`132 / 139`；best passing rank 的中位数都是 `5`。top1 新候选到 best passing 的相位差
中位数 current `3.803ms`、blind `2.0ms`，但 signed delta 在 current / blind / split 间
不稳定，不能拿来做全局 phase offset。best-vs-top 的现有 leading-edge、phasePath、
segment agreement 特征中位差接近 `0`，继续给这些字段加权就是换皮过拟合。

`rkb_phase_trajectory_diagnostic.py` 把局部相位轨迹也验证了一遍：full / low attack
能解释 top1 与 best passing 的几毫秒偏移，但不能判断哪个 candidate 应该被选。fullAttack
`trajectoryExplainsDeltaWithin4msRate` current `0.853107`、blind `0.833333`，但
`topPullTowardBestRate` 只有 current `0.180791`、blind `0.151515`。固定 guard 模拟全是
净负：current 最好 `net -31`，blind 最好 `net -20`，holdout 最好也分别是 `-4` / `-2`。
这说明 trajectory margin 只能解释相位几何，不能作为 switch guard。

`rkb_onset_foot_phase_diagnostic.py` 试了更像 Rekordbox 可见波形的 ramp foot / onset foot
语义：grid 应接近峰值前的起跳脚，而不只是 peak 在 grid 后几毫秒。单独 hard guard 不够强，
current all 会 `685 -> 683` 且 `pass -> fail = 2`；但作为 ranker 特征，它明显增强了
候选区分力。

`rkb_phase_ranker_diagnostic.py` 加入 onset-foot 后，tune-selected 保守配置为
`top-new / l2 = 0.1 / threshold = 0.95`。它在 tune 上 current `159 -> 161`、blind
`92 -> 94`，holdout 上 current `130 -> 133`、blind `88 -> 91`，这些 split 都没有
`pass -> fail`。但 current all 是 `685 -> 691` 且 `pass -> fail = 1`，所以仍不能进生产。
报告里存在一个验证安全候选 `ranked-top16 / l2 = 0.3 / threshold = 0.94`：current all
`685 -> 689`、blind all `425 -> 429`，tune / holdout / all 均无 `pass -> fail`。这条只能作为
future-data locked hypothesis 或 fresh blind 复验对象，不能因为验后安全就现场提拔。

`rkb_phase_ranker_preregistered_replay.py` 已把这条固定成 locked replay。当前安全筛查里共有
54 个配置满足 current/blind 的 tune / holdout / all 都无回退且 `pass -> fail = 0`，locked
config 是 total all net 最高的回放配置：current all `+4`、blind all `+4`，holdout 两边各
`+1`。它不是干净预注册证据，而是验后污染假设；只能原样等待新增 truth / fresh blind
复验，不能在当前数据上继续扫到更好看后上线。

`rkb_phase_ranker_selected_weakness_diagnostic.py` 试了 selected legacy / anchor 的数值弱置信度。
这条线没有提供额外突破：tune-selected 仍是 `top-new / l2 = 0.1 / threshold = 0.95`，current
holdout `130 -> 133`、blind holdout `88 -> 91`，但 current all 仍为 `685 -> 691` 且
`pass -> fail = 1`。它只保留为诊断，不进入 production scorer，也不要继续在这组字段上扫阈值。

`rkb_phase_ranker_rising_edge_diagnostic.py` 试了 full/low attack envelope 的 rising-edge derivative。
修正为“onset-foot 基线 + rising-edge 增量”后，tune-selected 配置为
`ranked-top16 / l2 = 0.3 / threshold = 0.93`；current all `685 -> 694`、blind all
`425 -> 430`，current holdout `130 -> 135`、blind holdout `88 -> 89`，全 split 都没有
`pass -> fail`。`same-mod4` guard 变体与未加 guard 结果相同，没有释放更多 rescue。但这个
feature family 是查看现有报告后提出的验后污染假设，只能作为 future-data hypothesis 留档，
不能直接上线。
`rkb_phase_ranker_rising_edge_locked_replay.py` 已锁定这组配置，后续只能拿新增 truth / fresh blind
原样复验，不能在当前数据上继续拧阈值。
`rkb_phase_ranker_rising_edge_ablation_diagnostic.py` 去掉 bar prior 后，current all 只 `+3`、
blind all 只 `+3`；说明 bar prior 确实带来一部分救回，但不能靠简单删除它获得更强泛化。
直接把 selected grid 按 rising-edge median 做连续相位平移也不行：固定 target / max-shift /
min-score 网格在 current 上普遍净负，blind 也不稳；这条线不要进 production，只保留候选级
ranker 特征。

locked rising-edge ranker 已集成到 `constant-grid-dp`，后续又加了四条窄 guard：

- `legacy-fallback-integer-bpm-snap`：只对仍落在 legacy fallback 的近整数 BPM 做 `<= 0.04 BPM`
  量化，current `694 -> 695`，blind `430 -> 430`，test `277 -> 278`，三套逐曲
  `pass -> fail = 0`。
- `constant-grid-dp-rank1-locked-legacy-weakness-switch`：只在普通 locked ranker 未切换、baseline
  仍是 legacy fallback、rank1 probability `>= 0.9`、legacy score `<= 2.6`、且 rank1 与 legacy
  相位差 `> 5ms` 时切换。结果为 current `695 -> 696`，blind `430 -> 432`，
  old consumed test `278 -> 279`；latest test-new-357 在 v3 下 `229 -> 230`。
  三套逐曲 `pass -> fail = 0`。
- `constant-grid-dp-rank1-structural-phase-switch`：只在普通 locked ranker 和 rank1 material
  legacy weakness 都未切换、baseline 仍是 legacy fallback、主分支 rank1 probability `>= 0.86`，
  低概率高证据分支 `0.85 <= probability < 0.86` 且 `score >= 0.88`、`downbeatMargin >= 0.5`，
  legacy score `<= 6.0`、rank1 与 legacy 相位差 `> 15ms`、BPM 差 `<= 0.08`、bar offset
  mod4 相同、rank1 `score >= 0.8`、`downbeatRank == 0`、`downbeatMargin >= 0.1` 时切换。
  结果为 current `696 -> 702`，blind `432 -> 435`，latest test-new-357 `230 -> 231`。
  current/blind 逐曲 `pass -> fail = 0`。它会把少量 first-beat-phase 改成 downbeat
  非 pass，这类只是错误类型变化，不得误报成 pass rescue。
- `constant-grid-dp-head-near-zero-switch`：只在普通 locked ranker、rank1 material legacy weakness、
  rank1 structural phase 都未切换、baseline 仍是 legacy fallback、legacy weakness `>= 0.2`、
  rank1 `firstBeatMs > 90ms` 时生效。它只在 top8 内寻找 `firstBeatMs <= 8ms`、与 rank1
  分差 `<= 0.08`、与 legacy BPM 差 `<= 0.5`、bar offset mod4 与 rank1 相同、且来源包含
  `window-beat-leading-edge` 的近头部候选。结果为 current `702 -> 702`，blind `435 -> 436`，
  latest test327 `212 -> 215`；current/blind/test327 逐曲 `pass -> fail = 0`。

后续还离线试过 rank<=8 / topN structural selector。它能继续制造 current/blind 样本内净增，
但本质是在已看过数据上挑 topN 候选，缺少新的结构证据来区分错候选；没有 fresh sealed 前不要进生产。

这不是说 topN 方向永远无效，而是说 topN 必须服务于新的 phase 语义证据，不能独立承担生产决策。
head near-zero 也不能被误读成“开放 top8 selector”；它只处理 rank1 明显远离音频头部、同 BPM /
同 downbeat mod4 下有近头部 leading-edge 候选的窄场景。

post-v2 又复查了残余 rank1-only 低概率分支：`0.84` / `0.845` 只会把 blind 的
`Sambo - Get Down (Original Mix).flac` 从 `bpm` 错改成 `first-beat-phase` 错，不新增 pass；
`0.848` 以上没有变化。继续往 `0.85` 以下压阈值没有收益，只是在制造错误类型漂移。

这四条都不能包装成新的 sealed 泛化证据：`test` 已被继续优化消耗，current / blind 也是已看过的
开发回归集。它们只能作为窄边界、零回退的生产候选，等待下一批 fresh truth 原样复验。

不要把这个结果误读成“可以降 locked 阈值”。离线检查过把 `0.93` 降到 `0.90`，会出现：

- current：`fail -> pass = 10`，`pass -> fail = 6`
- blind：`fail -> pass = 13`，`pass -> fail = 7`
- test：`fail -> pass = 7`，`pass -> fail = 1`

这条是明确证伪方向。也不要把 rank1-only guard 改回 top16 best-prob switch；top16 扫法容易把
ranker 变成验后挑样本器，不符合当前防过拟合边界。

也不要直接做 half/double BPM switch。latest test-new-357 的两个 half/double 失败确实有 passing
candidate，但按 BPM 二倍/半速、rank、leading-edge 和 downbeat margin 做简单 guard，会在 current、
blind 和 latest test-new-357 上把多首已通过样本打成 `half-or-double-bpm`；这个方向目前是净负，
只能回到更强的 tempo 证据后再谈。

原因：

- 正确 phase 有时更靠近前缘，有时更像峰值中心或视觉网格习惯。
- 全局固定 offset 不成立。
- 强瞬态、强 downbeat 反而经常把 scorer 拉向错误 phase。

### 软坑：不要继续调 cached envelope phase-DP 第一版

Codex3 的 cached envelope phase-DP 证明了一个问题：DP 形式对，不代表 emission 语义对。

第一版 DP 稳定追逐 full/low attack envelope 和 beat-logit 的强 front phase，但这不等价于
Rekordbox firstBeatMs。

不要继续调这些参数：

- full / low attack front score 权重。
- beat-logit front score 权重。
- global DP 转移半径 / 转移惩罚。
- anchored DP 搜索半径。
- 最近 same-BPM candidate 投影阈值。

phase-DP 不是废路。只有第一版 envelope/front-emission 参数扫描是坑；如果重做 phase-DP，
必须先换成能解释 Rekordbox firstBeatMs 的 emission 语义，再谈转移和锚定参数。

### 硬坑：不要把 timeBasis / encoder 分组 shift 当修复

按 `timeBasis.offsetMs`、encoder、文件扩展名或稀有组合做 phase shift，本质是过拟合。

允许用 time basis 修坐标；禁止用它当“某类文件统一挪几毫秒”的经验补丁。

### 架构坑：不要混淆 beat phase 和 downbeat

5ms 下主要失败仍然是 first-beat phase。downbeat 是另一个问题。

后续必须拆成三层：

- tempo solver
- beat phase solver
- bar phase / downbeat solver

不要用一个混合总分同时修 phase 和 downbeat。downbeat evidence 强，不代表 firstBeatMs 正确。
但 downbeat evidence 不是禁用项；它可以作为辅助 guard 或 bar-phase 层特征，不能单独证明 beat-phase 正确。

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

### Blind baseline 已跑，不能再当未触碰数据

当前 931 首已经被多轮实验反复看过。哪怕生产代码不读取文件名或 truth，只要继续根据这批样本扫规则，
也会形成样本记忆。

blind truth 已经归档：

- 位置：`grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/`
- 曲目：608
- 字段包含 `fileName`、`bpm`、`firstBeatMs`、`barBeatOffset`。
- 已生成独立 truth、manifest、项目内 `.m3u8` blind 歌单和对应音频归档。
- 已生成固定 split：train 334，tune 146，holdout 128。

冻结 baseline 已完成：`423 / 608 = 69.57%`，candidate oracle `599 / 608 = 98.52%`。
phase evidence v2 当前为 `425 / 608 = 69.90%`，train `245 / 334`，tune `92 / 146`，
holdout `88 / 128`，没有 `pass -> fail`。这批数据已经不再是未触碰 blind；
后续只能按固定 split 做受控实验，holdout 只在阶段性验收时打开。
禁止把 blind 全量当阈值扫描目标。

### 新证据源要解释 phase，不是重排候选

第一版 intro leading-edge evidence 已验证有小信号，但远远不够冲 `80%`。下一步算法不应再从
“topN 里猜哪个像 truth”开始，而应从“为什么这个 phase 是正确 grid”开始。

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

- current all 高于当前 production `702 / 931 = 75.40%`。
- current holdout 高于当前 production `137 / 203 = 67.49%`。
- blind all 不低于当前 production `435 / 608 = 71.55%`。
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
不要把 topN、source、小模型、front-edge bonus 或 timeBasis shift 当独立生产捷径。
blind baseline 已跑；第一版 intro leading-edge phase evidence 只带来小幅干净提升。
下一步做更强的 Rekordbox phase evidence，而不是放宽阈值。
```

历史 phase-evidence v2 诊断结论如下；这些数字用于解释路线，不再代表当前 production baseline。
当前 production baseline 以 v3 + rank1 structural phase v2 为准：current `702 / 931 = 75.40%`，
current holdout `137 / 203 = 67.49%`，blind `435 / 608 = 71.55%`。

- phase-evidence v2 selected：`685 / 931 = 73.58%`，holdout `130 / 203 = 64.04%`。
- phase evidence v2 相比冻结 baseline：current `684 -> 685`，blind `423 -> 425`；
  current / blind formal v2 均无 `pass -> fail`，blind holdout `87 -> 88`。
- 如果无条件选择 `constant-grid-dp` top1 新候选，会退到 `355 / 931 = 38.13%`，
  holdout `68 / 203 = 33.50%`；top1 分数不是可信切换信号。
- 按 source family、score、legacy score、downbeat margin、segment agreement、leading-edge
  MAD、phase shift 等现有字段做保守阈值扫描，train / tune 稳定净增很小，holdout 没有突破。
- 仅诊断用途的 train 线性 ranker，tune 选切换阈值后，最佳也只到
  `686 / 931 = 73.68%`，holdout 仍是 `130 / 203 = 64.04%`。
- blind baseline：`423 / 608 = 69.57%`，oracle `599 / 608 = 98.52%`；
  split 诊断为 train `244 / 334`，tune `92 / 146`，holdout `87 / 128`。
- blind phase evidence v2：`425 / 608 = 69.90%`，split 为 train `245 / 334`，
  tune `92 / 146`，holdout `88 / 128`。
- phasePath diagnostic：候选字段已进入输出，生产评分仍使用 v2 switch；current full
  `685 / 931`、blind full `425 / 608`，对 formal v2 均为 `0` 行级转移。
- phase semantics diagnostic：current first-beat-phase fixable `177 / 197`，blind
  `132 / 139`；top1 与 best passing 通常只差 `2-4ms`，但现有诊断字段没有稳定区分力。
- phase trajectory diagnostic：full / low attack 轨迹不能安全切换 top1；固定 guard 模拟在
  current / blind 全量和 holdout 都是净负，只保留诊断。
- onset-foot diagnostic：单独 hard guard 不安全，但 onset-foot score 的 pass/fail 分离明显。
- phase-ranker diagnostic：加入 onset-foot 后，tune-selected 配置在 tune/holdout 正增且零伤害，
  但 current all 仍有 1 首 `pass -> fail`；另有验后识别出的全 split 零伤害候选，只能 fresh 复验。
- phase-ranker post-hoc locked replay：locked config 当前回放 current all `685 -> 689`、
  blind all `425 -> 429`，全 split 零伤害；它是验后污染假设，只能给下一批 fresh truth
  原样复验，不是当前生产结论。
- phase-ranker selected weakness diagnostic：selected legacy / anchor 数值弱置信度没有带来额外
  安全增益，current all 仍 `pass -> fail = 1`，只保留诊断。
- phase-ranker rising-edge diagnostic：onset-foot + rising-edge derivative 当前回放 current all
  `+9`、blind all `+5`，全 split 零伤害；但它是验后污染假设，只能 future-data 复验。
- integrated solver 已接入 locked ranker、legacy integer BPM snap、rank1 material legacy weakness
  和 rank1 structural phase：
  current `685 -> 694 -> 695 -> 696 -> 701 -> 702`，blind `425 -> 430 -> 430 -> 432 -> 434 -> 435`，
  old consumed test `274 -> 277 -> 278 -> 279`，latest test-new-357 `229 -> 230 -> 231`。
  三套逐曲均无 `pass -> fail`。其中 old consumed test 只有 locked ranker 阶段仍可算 fresh
  sealed 证据；后续 guard、latest test-new-357 的 v3 边界和 structural phase v2 都只是开发回归证据。
- rising-edge no-bar-prior ablation：current all `+3`、blind all `+3`，少于完整 rising-edge，
  只作为抗过拟合检查留档。
- rising-edge direct phase shift：按 rising-edge median 直接平移 selected grid 在 current 净负，
  blind 不稳，不进入 production。
- blind / current 上继续试过 topN、新候选固定 rank switch、pairwise / candidate-level 小模型、
  phase cluster consensus、legacy threshold、统一 phase shift、front-edge / leading-edge scorer。
  这些方向要么只多救极少数样本，要么牺牲 tune / holdout，要么明显依赖 source 或 truth 归因。

结论：当前候选池里确实有大量正确候选，但现有 scorer 特征没有足够泛化信号支撑自动选中；
靠继续松 confidence、扫阈值、重排 topN 或上小模型，看不到冲到 all `80%` / holdout `75%`
的可靠路径。onset-foot 证明新 phase 证据方向有价值，但还没到生产级；后续必须锁定污染假设后
用 fresh blind 或新增 truth 原样复验，不能把当前主 truth 或 blind 全量当调参靶子反复拧。

下一次会话不要从头扫：

0. 先读 `drafts/rkb-beatgrid-next-session-handoff.md`。
1. 先看 `drafts/rkb-rekordbox-truth-validation-workflow.md` 的 sealed-eval 命令。
2. 先跑 `scripts/rkb_phase_ranker_rising_edge_locked_replay.py` 做 current/blind sanity check。
3. 如果用户已经准备好新 Rekordbox 样本歌单，必须使用用户提供的实际歌单名；不要假设歌单名。
   然后只按 locked replay 原样验收。
4. 如果没有新 sealed truth，继续研究新的结构性 phase evidence；当前主 truth 和 blind 只能做开发/回归，
   不能当 fresh proof。
5. 不要再把 post-hoc 配置叫“预注册证据”；正确叫法是验后污染假设 / future-data hypothesis。
