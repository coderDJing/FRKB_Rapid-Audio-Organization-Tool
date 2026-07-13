# RKB Beatgrid Solver 踩坑文档

> 样本 intake 一律以 [`分拣脚本.md`](./分拣脚本.md) 和
> [`准备好rkb新样本.md`](./准备好rkb新样本.md) 为准。本文较早的 `test fresh prepare` 叙述是历史背景，
> 不可覆盖现行的 pre-review label-QA / review development 流程。

## 1. 当前口径

从 Codex4 起，RKB beatgrid 验收只按 5ms 主口径讨论：

- `firstBeatPhaseAbsErrorMs <= 5ms`
- `gridMaxAbsMs <= 5ms`
- `bpmOnlyDrift128BeatsMs <= 5ms`
- `barBeatOffset` mod4 必须匹配

旧 2ms 阶段的 pass rate、split 成绩、`70%` 目标、sample/failure 数量和边界样本结论全部作废。
它们不再用于判断当前算法好坏，也不再作为后续调优目标。

历史 5ms selected（`constant-grid-dp` phase evidence v2 + phasePath diagnostic，旧 931 首 current）：

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

当前已维护 production latest benchmark 文件（v3 + rank1 structural phase v2 + rank1 high structural score v1 + rank1 negative legacy score v2 + head near-zero + rank1 octave-down）：

| dataset | selected | candidate oracle | 主要剩余失败 |
| --- | ---: | ---: | --- |
| current all | `976 / 1407 = 69.37%` | `1353 / 1407 = 96.16%` | `first-beat-phase 307`，`downbeat 66`，`bpm 30`，`half/double 28` |
| blind all | `436 / 608 = 71.71%` | `599 / 608 = 98.52%` | `first-beat-phase 126`，`downbeat 30`，`bpm 15`，`half/double 1` |
| latest test353 | `225 / 353 = 63.74%` | `338 / 353 = 95.75%` | `first-beat-phase 83`，`downbeat 15`，`bpm 17`，`half/double 12`，`grid-drift 1` |
| consumed test327 | `218 / 327 = 66.67%` | `316 / 327 = 96.64%` | `first-beat-phase 64`，`downbeat 27`，`bpm 8`，`half/double 10` |
| consumed test316 | `176 / 316 = 55.70%` | `298 / 316 = 94.30%` | `first-beat-phase 83`，`downbeat 20`，`half/double 21`，`bpm 16` |
| new357 diagnostic-only | `231 / 357 = 64.71%` | `343 / 357 = 96.08%` | recovered reference；`first-beat-phase 102`，`downbeat 14`，`bpm 7`，`half/double 2`，`grid-drift 1` |

当前代码另有 `locked-phase-downbeat-ordinal-v1` 语义修复。六个完整 consumed 批次 targeted replay
覆盖 65 个 locked 触发点，合计 `fail -> pass = 12`、`pass -> fail = 0`；current 确定由
`976 -> 979 / 1407 = 69.58%`，downbeat `66 -> 63`。维护 benchmark/classification 尚未全量刷新，
所以表格仍保留文件真实值 976；这组 consumed replay 也绝不是 fresh evidence。

核心判断：

```text
候选覆盖已经很高。
当前主瓶颈不是“有没有生成正确候选”，而是 scorer / selector 没有稳定选中 Rekordbox 风格 phase。
```

当前主 truth 有 `377` 首、blind 有 `163` 首、latest test353 有 `113` 首是候选池里存在 5ms passing candidate，但最终 scorer
没选中。剩余优化应优先解决 phase 语义和 selector 泛化，而不是继续堆候选数量。

按现有归档批次记录，current、blind、旧 sealed/test 等合计 `3745` 个样本实例，现已全部 consumed。
上表来自不同历史 solver 阶段，只用于定位问题，不能直接求和当成当前统一准确率。后续必须先建立
`rkb-dataset-registry.json`，以 `batchId + assetSha256` 识别实例，只从 `batchStatus = consumed` 的记录
构建 development split。正式 split / LOBO 必须再用固定纯音频 policy 把 exact family 和
Chromaprint 近重复录音合并成 `isolationFamilyId`；组件同侧后用
`assignmentKey = sha256(canonical sorted exactFamilyIds)` 决定落点。assignment key 不含 policy SHA，
避免 policy 版本变化但组件不变时洗牌；完整 split 仍由 policy/registry/truth/assignment hashes 锁定。

`new357` 的 truth 是 current DB recovered reference，不是历史 frozen snapshot。它只能作为
diagnostic-only development replay：允许帮助定位候选覆盖和 selector 问题，但禁止进入 primary
aggregate、历史 benchmark 重建或 fresh proof。当前 strong-identity cache index 只有 2 首；旧 355 首
无法证明实例身份，强制重算前禁止宣称可靠的 357 首全量 replay。

当前真实 split v4：3745 instances、3735 exact families、3682 isolation families，
train/tune/holdout 为 2249/773/723；6 个 primary batches + 1 个 diagnostic-only `new357`。
这是 stable assignment 的一次性迁移。`leaveOneBatchOut` 目前只有 membership/hash 产物，自动 nested
runner 尚未实现，所以不能把“零 overlap”写成已经取得 LOBO 模型成绩。

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

### 软坑：不要把旧小模型失败误读成“模型路线禁止”

线性模型、logistic、shallow tree、小 MLP、listwise / pairwise ranker 都已经踩过坑。

问题不是模型写法本身，而是样本和特征不够支撑直接泛化：

- train 容易涨，tune / holdout 不稳。
- 很容易偷偷学到当前主 truth 样本库偏差；旧阶段是 931 首，本轮已扩到 1407 首。
- 部分历史实验还出现过 `barOk`、`pass`、`category` 等评测字段泄漏风险。
- 最新受控 phase-ranker 加入 onset-foot 特征后，tune 与 holdout 都能做到 current / blind
  正增且 `pass -> fail = 0`，但 tune-selected 配置 current 全量仍有 `pass -> fail = 1`。
  验证报告里有一个全 split 零伤害配置，但那是验后识别出的污染假设，不能当场上线。

问题不在 logistic、tree、pairwise 或 listwise 这些模型名字，而在旧实验的特征、样本组织和验收边界。
Selector V2 可以继续使用小而可解释的 pairwise/listwise ranker，但必须满足：同一首歌内比较候选、
每首歌权重相同、同歌近相位候选作为 hard negative、实例使用 `batchId + assetSha256`、split 使用固定
纯音频 `isolationFamilyId` / `batchId`，并报告 LOBO 最差批次。不能把一首歌生成的几百个 candidate
row 当几百首独立样本。

真正上线前仍必须锁死模型、特征和阈值，再用 fresh sealed 原样复验；看到 fresh 后重训出的版本必须
等待下一批 fresh，不能用同一批证明提升。

### 硬坑：不要把 source 当生产优先级

`source` 只能用于日志、消融和错误归因。不要写“某来源优先”“某来源禁用”的生产规则。

已知问题：

- 主战场常发生在同 BPM、同 bar、同 source 内部的几毫秒 phase 排序。
- 来源优先级解决不了同源内 phase 语义。
- source rule 很容易变成当前样本库补丁。

### 硬坑：不要把文件名或 exact family 当最终隔离边界

历史批次允许出现相同 `fileName` 的不同音频实例，也会存在同一录音的转码、裁头或补静音版本。
全局按文件名连接会把不同实例误合并，只按 exact `familyId` split 又会把近重复录音分到两侧。

正确边界固定为：

- `instanceId = normalized(batchId) + ":" + normalized(assetSha256)`，truth 只在同一 batch 内按文件名连接。
- split / LOBO 先用不读取 truth 或 benchmark 的 audio isolation policy 合并 exact family 和
  Chromaprint 近重复录音，再按 `isolationFamilyId` 分组、稳定 `assignmentKey` 分配 split。
- LOBO holdout family 在其他批次的实例必须从 development 剔除，并公开 leakage count。
- canonical output 硬锁 seed=`frkb-rkb-grid-v2`、tune=0.2、holdout=0.2；改 seed/比例只能写非 canonical
  diagnostic 文件，禁止挑 seed 刷出更好 holdout。

只按 exact family 得到的 train/tune/holdout 可以用于检查脚本是否跑通，不能宣称已完全防泄漏。

### 硬坑：不要绕过 sealed 生命周期和 triage guard

- fresh `prepare` 会用同一 isolation policy 排除与 consumed registry 的近重复录音及 fresh 批内重复；
  只查 asset/PCM exact duplicate 不够。
- registry baseline 初始化后 `import-consumed` 永久禁用；新增数据必须走 prepare/evaluate/finalize，
  再 `rebuild-registry`。
- 直接整理 `test` 必须带 finalize 后的 `--sealed-batch-id`，或明确使用非 fresh 的
  `--consumed-maintenance`；wrapper 必须把 prepare 返回的真实 batchId 传到底，禁止靠 `latest` 猜批次。

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
future-data locked hypothesis 或下一批 fresh sealed 复验对象，不能因为验后安全就现场提拔。

`rkb_phase_ranker_preregistered_replay.py` 已把这条固定成 locked replay。当前安全筛查里共有
54 个配置满足 current/blind 的 tune / holdout / all 都无回退且 `pass -> fail = 0`，locked
config 是 total all net 最高的回放配置：current all `+4`、blind all `+4`，holdout 两边各
`+1`。它不是干净预注册证据，而是验后污染假设；只能原样等待下一批 fresh sealed
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
`rkb_phase_ranker_rising_edge_locked_replay.py` 已锁定这组配置，后续只能拿下一批 fresh sealed
原样复验，不能在当前数据上继续拧阈值。
`rkb_phase_ranker_rising_edge_ablation_diagnostic.py` 去掉 bar prior 后，current all 只 `+3`、
blind all 只 `+3`；说明 bar prior 确实带来一部分救回，但不能靠简单删除它获得更强泛化。
直接把 selected grid 按 rising-edge median 做连续相位平移也不行：固定 target / max-shift /
min-score 网格在 current 上普遍净负，blind 也不稳；这条线不要进 production，只保留候选级
ranker 特征。

locked rising-edge ranker 已集成到 `constant-grid-dp`，后续又加了七条窄 guard：

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
- `constant-grid-dp-rank1-high-structural-score-switch`：只在普通 locked ranker、rank1 material
  legacy weakness 和 rank1 structural phase 都未切换、baseline 仍是 legacy fallback 时生效。
  只看候选池 rank1，不扫 topN；要求 rank1 probability `>= 0.82`、`score >= 0.96`、
  `tempoScore >= 0.95`、`downbeatRank == 0`、`downbeatMargin >= 0.35`、
  `phasePathScore >= 0.7`、`leadingEdgePeakOffsetMadMs <= 8ms`、与 legacy 相位差 `> 15ms`、
  BPM 差 `<= 0.08`、bar offset mod4 相同，且 legacy `firstBeatMs > 20ms`。
  `legacyFirstBeatMs <= 20ms` 是明确坑：本轮未收紧时会把
  `Fur Coat,Avidus - In Our Town (Avidus Versio.mp3` 从 pass 打成 downbeat；收紧后
  current `973 -> 976`、blind 不变、test353 `224 -> 225`、test327/test316 不变，
  全部逐曲 `pass -> fail = 0`。它不读歌名、artist/title/path、truth、category、pass/fail
  或 split identity。
- `constant-grid-dp-head-near-zero-switch`：只在普通 locked ranker、rank1 material legacy weakness、
  rank1 structural phase 都未切换、baseline 仍是 legacy fallback、legacy weakness `>= 0.2`、
  rank1 `firstBeatMs > 90ms` 时生效。它只在 top8 内寻找 `firstBeatMs <= 8ms`、与 rank1
  分差 `<= 0.08`、与 legacy BPM 差 `<= 0.5`、bar offset mod4 与 rank1 相同、且来源包含
  `window-beat-leading-edge` 的近头部候选。结果为 current `702 -> 702`，blind `435 -> 436`，
  latest test327 `212 -> 215`；current/blind/test327 逐曲 `pass -> fail = 0`。
- `constant-grid-dp-rank1-negative-legacy-score-switch`：只在前序 switch 都未切换、baseline
  仍是 legacy fallback、legacy `legacyGridSolverScore <= 0.0`、rank1 `score >= 0.85`、
  rank1 `phasePathScore >= 0.8`、rank1 与 legacy 相位差 `> 5ms`、BPM 差 `<= 0.08`、
  bar offset mod4 相同、`downbeatRank == 0` 时生效。v2 额外加了小相位差 soft guard：
  如果 `phaseDeltaAbsMs < 10ms`，必须 `score >= 0.99`。它只看 rank1，不扫 topN，
  不读歌名、artist/title/path、truth、category、pass/fail 或 split identity。
  结果为 current `702 -> 706`，blind `436 -> 436`，latest test353 `222 -> 224`；
  v2 在 test353 上保留 pass 数但把两次非 pass 错误类型漂移收窄。current/blind/test353
  逐曲 `pass -> fail = 0`。这条是在 test353 已跑完后形成的消耗集开发回归，不能包装成
  fresh sealed 泛化证明。
- `constant-grid-dp-rank1-octave-down-switch`：只在最终选择仍是 legacy fallback、且前序
  head near-zero 与 rank1 negative legacy score 都没切换时生效。只看候选池 rank1，不扫 topN；要求
  `confidence <= 0.82`、`abs(rank1Bpm * 2 - legacyBpm) <= 0.08`、rank1 来源包含
  `window-beat-leading-edge`、rank1 `score >= 0.86`、`downbeatRank == 0`、
  `downbeatMargin >= 0.5`、`phasePathScore >= 0.7`、`leadingEdgePeakOffsetMadMs <= 8ms`、
  `tempoScore >= 0.74`。它不读歌名、artist/title/path、truth、category、pass/fail
  或 split identity。结果为 current `706 -> 707`，blind `436 -> 436`，
  test327 final `215 -> 218` 中有 2 首由 octave-down 救回，test316 `175 -> 176`；
  逐曲 `pass -> fail = 0`。这条是在已消耗回归集上形成的窄 half/double 修正，
  不能包装成 fresh sealed 泛化证明。

后续还离线试过 rank<=8 / topN structural selector。它能继续制造 current/blind 样本内净增，
但本质是在已看过数据上挑 topN 候选，缺少新的结构证据来区分错候选；没有 fresh sealed 前不要进生产。

这不是说 topN 方向永远无效，而是说 topN 必须服务于新的 phase 语义证据，不能独立承担生产决策。
head near-zero 也不能被误读成“开放 top8 selector”；它只处理 rank1 明显远离音频头部、同 BPM /
同 downbeat mod4 下有近头部 leading-edge 候选的窄场景。

post-v2 又复查了残余 rank1-only 低概率分支：`0.84` / `0.845` 只会把 blind 的
`Sambo - Get Down (Original Mix).flac` 从 `bpm` 错改成 `first-beat-phase` 错，不新增 pass；
`0.848` 以上没有变化。继续往 `0.85` 以下压阈值没有收益，只是在制造错误类型漂移。

这些 guard 都不能包装成新的 sealed 泛化证据：`test` 已被继续优化消耗，current / blind 也是已看过的
开发回归集。历史上它们曾按“窄边界、零回退”筛选；新流程不再把零回退当绝对门槛，后续候选必须
按全量净收益、LOBO 最差批和灾难性回归门槛筛选，再等待下一批 fresh truth 原样复验。

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
`instanceId`、`familyId`、`isolationFamilyId`、`batchId`、asset/PCM hash 和 fingerprint 只允许用于
registry 身份、近重复音频隔离、split 和 LOBO，
禁止进入 production solver/scorer 特征。

## 5. 后续有效方向

### Blind baseline 已跑，不能再当未触碰数据

当前 1407 首主 truth 已经被多轮实验反复看过。哪怕生产代码不读取文件名或 truth，只要继续根据这批样本扫规则，
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
后续只能作为 consumed 开发数据参与 instance-safe / audio-isolation-family-safe split、交叉验证和 LOBO。
旧 holdout 已被多次查看，
只能当内部回归视图，不能再叫 fresh proof。current、blind 和全部旧 sealed/test 合计 3745 个样本实例
都遵守同一规则；禁止把任何一个历史批次重新命名为 blind 后继续扫阈值。

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

- 所有歌曲都自动给出最终结果，并始终留在全量准确率分母中。
- high confidence 可以走常规计算路径，且 pass rate 应明显高于全量。
- low confidence 必须自动触发更强的完整歌曲、多窗口、高分辨率 onset/kick 或独立仲裁分析，
  不能送普通用户人工擦屁股。
- `needReview` 只允许作为开发期 truth QA / 错误归因歌单，不是产品低置信兜底。
- confidence 只控制机器追加多少计算量，不能决定是否统计该歌曲，也不能悄悄回退覆盖正确新候选。

## 6. 验收规则

用户人工流程仍是 `Upan -> test -> needReview -> review`，不要把防过拟合改造变成额外的人工负担。
现行变化是：完整 `test` 会先生成带 audio identity 和 solver hash 的 pre-review report，再移动差异曲目到
`needReview`；用户确认后由 `review` report-bound prepare 直接封存为 consumed development。它不是 fresh
验收，不得拿来证明任何已经看过这批数据的候选提升。

任何新实验必须报告：

- registry 版本，以及代码、模型、特征和阈值 hash。
- `batchId + assetSha256` 的 `instanceId`、audio-only `isolationFamilyId`、不含 policy SHA 的稳定
  `assignmentKey`；canonical 主 split 与三份 truth 必须用 `parentSplit`、assignment hashes 同步绑定。
- `batchStatus != consumed` 必须在 development isolation 前剔除，fresh/evaluating/exposed 不能改变旧 split。
- development isolation scope 必须是 `batchStatus=consumed`；非 consumed 实例不得参与 component/hash，
  不能因未来 fresh 数据加入而改变历史 split。
- 同 isolation family 横跨历史批次时，LOBO development 必须剔除 holdout family 在其他批次的副本，
  并报告 `excludedDevelopmentIsolationFamilyLeakageTrackCount`，禁止把重复录音留在训练侧。
- `new357` 必须单列 `diagnostic-development-reference`，不得进入 primary aggregate；它的 recovered
  reference 不得冒充历史 frozen truth。
- 全部 3745 个 consumed 样本在同一 solver 版本下的统一 all。`leaveOneBatchOut` 当前只是 membership/hash；
  自动 nested runner 实现后才允许报告 LOBO 多数/最差批模型成绩。
- frozen 全量分母上的 selected pass rate，低置信和 `needReview` 不得剔除。
- candidate oracle。
- scorer missed while oracle exists。
- `pass -> fail` 和 `fail -> pass`。
- BPM 大错率。
- phase 误差分布。
- downbeat 回归。
- 是否使用了任何禁止字段。

继续推进的最低标准：

- 中央 registry 已完整覆盖历史 3745 个 consumed 样本；未完成一次性注册前禁止 fresh 验收。
- consumed 全量严格正确率相对同版本 baseline 有预注册净增；晋级前必须补齐 runner 并验证多数 LOBO 同向。
- runner 产出的 LOBO 最差批次、BPM 大错率和 downbeat 不触发预注册灾难性回归门槛。
- `fail -> pass`、`pass -> fail` 和分类迁移全部公开；不再要求绝对零 `pass -> fail`，也禁止
  为守住单首旧 pass 追加逐曲 guard。
- 候选配置在 fresh `prepare` 前已经锁死；fresh 只 `evaluate` 一次，曝光后立即 consumed。
- 任何 consumed holdout / LOBO holdout 只允许否决候选，不能因为没有参与本轮拟合就重新获得 fresh
  身份；根据它调参后必须继续在 consumed development 内迭代。

production 晋级还必须满足：

- fresh frozen manifest 的全部歌曲都在分母中，`needReview`、低置信和人工待查歌曲不得删除。
- fresh 结果达到 prepare 前写死的绝对指标/相对净收益门槛，且没有数据、解码或 benchmark error。
- 如果看到 fresh 后修改模型、特征、阈值或指标，该批只能 finalize 为 reject/consume；新版本等下一批 fresh。

统一入口当前默认 acceptance policy 是严格正确率 `>= 0.80`、error rate `<= 0`、BPM 大错率
`<= 0.05`、candidate oracle `>= 0.94`。这些门槛可以在 prepare 前显式调整，但写入 immutable
manifest 后不能修改；只有自动通过锁死 policy 的结果才能 finalize 为 `eligible`，且 `eligible`
只表示具备晋级资格，不直接执行 production promotion。

阶段性突破标准：

- all `>= 80%`。
- audio-isolation-family-safe 交叉验证及 nested LOBO runner 不靠单一批次硬撑，最差批次达到预注册目标。
- 至少一批独立 fresh 达到预注册门槛；confidence 只用于自动追加计算，不改变全量指标。

接近产品化标准：

- all `>= 85%`。
- 连续两批独立 fresh 稳定通过。
- low confidence 能可靠触发自动二次分析，且二次分析后的全量结果仍统一计入指标。

## 7. 当前结论

```text
2ms 成绩数字作废。
候选池覆盖仍然很强。
selector / phase 语义仍是主瓶颈。
不要把 topN、source、front-edge bonus 或 timeBasis shift 当独立生产捷径；小模型本身不禁止，
但必须按歌曲内 pairwise/listwise、instance-safe + audio-isolation-family-safe split、LOBO 和 fresh
一次性验收来证明。
blind baseline 已跑；第一版 intro leading-edge phase evidence 只带来小幅干净提升。
3745 个历史实例全部 consumed，new357 只作 diagnostic-only；任何旧 holdout 都不能恢复 fresh 身份。
下一步做更强的 Rekordbox phase evidence，而不是放宽阈值。
```

历史 phase-evidence v2 诊断结论如下；这些数字用于解释路线，不再代表当前 production baseline。
当前已维护 benchmark 文件以 v3 + rank1 structural phase v2 + rank1 high structural score v1、
rank1 negative legacy score v2、head near-zero + rank1 octave-down 为准：current
`976 / 1407 = 69.37%`，current holdout `176 / 288 = 61.11%`；当前代码再加
`locked-phase-downbeat-ordinal-v1` 后可确定 current 为 `979 / 1407 = 69.58%`，但统一 benchmark
和 classification 尚未刷新；
blind `436 / 608 = 71.71%`。旧 `707 / 931` 只代表 476 首新样本合入前的历史阶段。

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
- integrated solver 已接入 locked ranker、legacy integer BPM snap、rank1 material legacy weakness、
  rank1 structural phase、rank1 high structural score v1、rank1 negative legacy score v2、
  head near-zero 和 rank1 octave-down。旧 931 首阶段：
  current `685 -> 694 -> 695 -> 696 -> 701 -> 702 -> 702 -> 706 -> 707`，blind
  `425 -> 430 -> 430 -> 432 -> 434 -> 435 -> 436 -> 436`，old consumed test
  `274 -> 277 -> 278 -> 279`，latest test-new-357 `229 -> 230 -> 231`，
  latest test327 `212 -> 215 -> 218`，latest test353 `222 -> 224 -> 225`，
  latest test316 `175 -> 176`。本轮 1407 首 current 阶段为 `973 -> 976`。
  三套逐曲均无 `pass -> fail`。其中 old consumed test
  的 locked ranker 阶段在当时曾提供一次性 fresh 证据，但该批现在同样已 consumed；后续 guard、latest test-new-357 的 v3
  边界、structural phase v2、test327 的 head near-zero / rank1 octave-down、test353 的
  rank1 negative legacy score v2 和 test316 的 rank1 octave-down 都只是开发回归证据。
- rising-edge no-bar-prior ablation：current all `+3`、blind all `+3`，少于完整 rising-edge，
  只作为抗过拟合检查留档。
- rising-edge direct phase shift：按 rising-edge median 直接平移 selected grid 在 current 净负，
  blind 不稳，不进入 production。
- blind / current 上继续试过 topN、新候选固定 rank switch、pairwise / candidate-level 小模型、
  phase cluster consensus、legacy threshold、统一 phase shift、front-edge / leading-edge scorer。
  这些方向要么只多救极少数样本，要么牺牲 tune / holdout，要么明显依赖 source 或 truth 归因。

结论：当前候选池里确实有大量正确候选，但现有 scorer 特征没有足够泛化信号支撑自动选中；
靠继续松 confidence、扫阈值或只重排旧 topN，看不到冲到 all `80%` 的可靠路径。onset-foot
证明新 phase 证据方向有价值；后续可以用小而可解释的 pairwise/listwise selector，但必须先完成
统一 solver baseline 和尚未实现的 nested LOBO runner，再锁死候选交给下一批 fresh 原样复验。
registry 与 stable-assignment split 四件套已完成；new357 剩余 355 首强身份重算前不算可靠全量回放。

下一次会话不要从头扫：

0. 先读 `drafts/rkb-benchmark-workflow/rkb-beatgrid-next-session-handoff.md`。
1. 先看 `drafts/rkb-benchmark-workflow/准备好rkb新样本.md` 的统一 sealed 入口，并以
   `scripts/rkb_sealed_batch.py --help` 为准，不复制底层裸命令。
2. registry baseline 已覆盖 3745 首，禁止再 `import-consumed`；canonical split CLI 必须同步刷新主文件和
   train/tune/holdout truth，并校验 `parentSplit` / assignment hashes。
3. `leaveOneBatchOut` 当前只是定义；先实现 nested runner，再报告 LOBO 多数/最差批成绩。
4. 新歌曲进入 `test` 后先 prepare；近重复 guard 与 evaluate/finalize 都成功后，triage 必须绑定实际 batchId。
5. evaluate 曝光后立即失去 fresh 身份，并用 finalize 记录 eligible/reject/consume；`eligible` 只表示
   自动通过锁死的 acceptance policy，不直接 promotion。看到结果后改出的下一版本必须等下一批 fresh。
6. 如果没有新 fresh，继续在 consumed 数据上研究新的结构性 phase evidence 和 selector；不能报成
   fresh 准确率提升，也不要再把 post-hoc 配置叫“预注册证据”。
