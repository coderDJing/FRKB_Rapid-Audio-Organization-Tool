# Rekordbox 真值验证工作流

## 1. 核心原则

RKB beatgrid 长期只维护两份文档：

- `drafts/rkb-rekordbox-truth-validation-workflow.md`：数据、truth、benchmark、classification 和命令流程。
- `drafts/rkb-beatgrid-solver-pitfalls.md`：仍然有效的踩坑结论、禁止方向和后续调优验收标准。

旧的 Codex 交接稿、2ms 草稿和废弃 solver 草案都不再维护。需要历史过程时看 git 历史，
不再在 `drafts/` 里堆过期口径。

Rekordbox 只作为外部真值来源，用来校准 FRKB 的 beat grid analyzer。FRKB
运行态不能依赖 Rekordbox，也不能用 Rekordbox truth 覆盖分析结果。

当前流程只维护一个长期主 truth：

```text
grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-current-truth.json
```

另有一份独立 blind truth 归档：

```text
grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/
```

这批 608 首已经完成第一次 blind baseline，已不再是未触碰 blind 数据；仍作为独立 blind-truth
归档保留，不并入主 truth。后续如果用它参与算法优化，只能按固定 train / tune / holdout split
使用，holdout 只做阶段性汇报，不参与训练、调参、阈值扫描或逐曲修补。

`grid-analysis-lab/` 是本地分析工作区。truth、benchmark、classification
和失败清单都跟本机样本库绑定，不作为仓库可提交资产。历史上已跟踪的旧 JSON
即使继续出现在 `git status`，也不代表应该提交。

FRKB pass/fail 是当前算法状态，只存在于 classification 和派生 benchmark 视图中。
禁止再拆成 `sample truth` / `failure truth` 两份长期真值。

## 1.1 算法调优硬闸门

任何 beatgrid analyzer / solver / scorer 调优都必须先过这组闸门。过不了闸门的结果只能作为
诊断材料，不能写成生产提升，也不能合入运行时决策。

1. fresh sealed 只做一次性验收：跑之前必须锁死 production 规则、阈值、guard 和 scorer
   配置；跑完只记录结果，禁止现场改阈值、删歌、挑样本、重训选择规则或把本批最高分配置包装成
   泛化证明。
2. sealed-eval 跑完立即失去 sealed 身份：后续只能作为普通回归/诊断数据；下一次泛化证明必须来自
   另一批 fresh Rekordbox playlist 原样复验。
3. current / blind / 已消耗 sealed 只能用于开发回归和归因：可以分析候选覆盖、phase 分布、
   scorer 排名错误和失败簇，不能当 fresh proof，也不能反复扫阈值后只用同一批 pass 数证明变强。
4. 调参只能在 train / tune 上做，holdout 只在阶段性验收时打开；如果某类音频在 train / tune
   改善但 holdout 退化，按过拟合处理，回退该调参。
5. 默认不接受新的 `pass -> fail`；任何 `pass -> fail` 都必须逐项解释清楚，证明它不是 analyzer
   或 scorer 退化后，才允许继续讨论。
6. scorer 只能使用通用音频信号特征和候选自洽特征；禁止读取或间接编码歌名、artist、路径、
   playlist 来源、truth、benchmark 误差、pass/fail、失败类型标签、split 身份或逐曲规则。
7. 失败样本只用于聚类、候选覆盖分析和泛化验证；禁止维护逐曲 offset、逐曲 phase、逐曲规则，
   也禁止继续新增只服务当前失败清单的 `rescue` / `arbitration` 分支。
8. topN、source、小模型、front-edge / leading-edge / onset-foot / rising-edge 等信号只能作为
   诊断、特征发现或 locked hypothesis；没有新的 phase 语义证据和 fresh sealed 复验前，不能作为
   独立 production selector、bonus、hard guard 或全局 phase shift。
9. 主线优化目标是“多候选生成 + 统一 scorer”：先确认正确 grid 是否进入候选池，再解决 scorer
   为什么没选中。继续堆小型 if、阈值补丁或来源优先级，不算算法进步。

## 2. 本地固定文件

`grid-analysis-lab/rkb-rekordbox-benchmark/` 在本机只保留这些长期有用产物：

- `intake-current-truth.json`：新样本 Rekordbox truth 暂存队列。
- `rekordbox-current-truth.json`：唯一长期 Rekordbox truth 源。
- `frkb-current-latest.json`：当前算法对主 truth 的全量 benchmark，固定覆盖。
- `frkb-classification-current.json`：当前算法分类，决定每首歌属于 `sample` 还是 `grid-failures-current`。
- `sample-regression-latest.json`：从 classification 派生的当前通过集视图，固定覆盖。
- `grid-failures-current-latest.json`：从 classification 派生的当前失败集视图，固定覆盖。
- `grid-failures-current-manifest.json`：当前失败聚类清单，固定覆盖。
- `rkb-dataset-splits-current.json`：当前样本库的固定 cluster split。
- `rkb-dataset-splits-current-train-truth.json` / `rkb-dataset-splits-current-tune-truth.json` /
  `rkb-dataset-splits-current-holdout-truth.json`：由固定 split 派生的验证 truth。
- `phase-semantics-diagnostic-latest.json`：只读 benchmark 的 phase 语义诊断报告，固定覆盖。
- `phase-trajectory-diagnostic-latest.json`：只读 feature cache 的 phase trajectory 诊断报告，固定覆盖。
- `phase-ranker-diagnostic-latest.json`：受控 split 的 phase-ranker 离线诊断报告，固定覆盖。
- `phase-ranker-preregistered-replay-latest.json`：验后污染 phase-ranker locked hypothesis 回放报告，
  固定覆盖；只服务 future-data 复验，不是当前生产证据。
- `phase-ranker-selected-weakness-diagnostic-latest.json`：selected legacy/anchor weakness 数值特征的
  phase-ranker 离线诊断报告，固定覆盖。
- `phase-ranker-rising-edge-diagnostic-latest.json`：rising-edge derivative 相位特征的 phase-ranker
  离线诊断报告，固定覆盖。
- `phase-ranker-rising-edge-locked-replay-latest.json`：验后污染 rising-edge locked hypothesis
  回放报告，固定覆盖；只服务 future-data 复验，不是当前生产证据。
- `phase-ranker-rising-edge-ablation-diagnostic-latest.json`：rising-edge ranker 的 bar-prior
  ablation 诊断报告，固定覆盖。
- `onset-foot-phase-diagnostic-latest.json`：onset-foot / ramp-foot 相位证据诊断报告，固定覆盖。
- `beatthis-prediction-cache/`：可复用预测缓存。
- `blind-rekordbox-truth/`：独立 blind truth 归档，包含
  `rekordbox-blind-truth.json`、`rekordbox-blind-truth.m3u8`、`manifest.json`、固定 split truth、
  baseline 报告、`feature-cache/` 和 `audio/`。

这些文件只表达当前本机样本库状态；固定清单不写死数量，数量变更统一维护在下面的
当前状态快照中。快照只代表最新状态，更新时直接改写当前值，不追加历史流水账。

不保留 `*.progress.json`、临时 shard 目录、`targeted-*`、`try-*`、`diag-*`、
随手命名的 `after-*`、以及任何未在本节列出的 benchmark JSON。需要复查时重新跑。

## 2.1 当前状态快照

数据集：

- 唯一长期 truth：`grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-current-truth.json`
- 当前 truth 曲目数：1407
- intake 状态：空
- 当前 benchmark 曲目数：1407
- 当前 benchmark error：0
- 当前固定 split：train 829，tune 290，holdout 288
- 当前验收容差：5ms
- 历史 blind intake：609 首原始曲目，其中 608 首已归档为 blind truth，1 首因已在主 truth 中跳过
- blind truth：608 首，音频 608 个，MP3 512 个，FLAC 96 个
- blind truth 位置：`grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/`
- blind truth 状态：已归档，未合入主 truth；baseline 已跑，已生成固定 split，禁止无 split 调参
- blind 固定 split：train 334，tune 146，holdout 128
- latest consumed `test353` 批次：Rekordbox playlist 有效 353 首；音频已归档到
  `D:/FRKB_database-E/library/FilterLibrary/sealed-eval`，truth、feature-cache 和 production benchmark 已生成。
- latest consumed `test353` 状态：已被 rank1 negative legacy score v1/v2 与
  rank1 high structural score v1 开发回归消耗，不再是 sealed。
- previous sealed-intake `test327` 批次：327 首，已被 head near-zero、rank1 negative legacy score v2
  和 rank1 octave-down 开发回归消耗，只作为普通回归素材。
- previous sealed-intake `test316` 批次：316 首，已被 rank1 octave-down 开发回归消耗，
  只作为普通回归素材。
- previous sealed-intake `test-new-357` 批次：357 首，已被 v3 / structural phase v2 开发回归消耗，
  只作为普通回归素材。
- old consumed sealed-eval 归档：已消耗 sealed/test 回归音频长期放在
  `D:/FRKB_database-E/library/FilterLibrary/sealed-eval`，当前 1412 首，只作为普通回归素材。
- 临时 benchmark progress 文件：不作为长期状态，存在时只视为可复跑的中间产物

当前主 truth production latest（`constant-grid-dp` + locked ranker + integer BPM snap + rank1 material legacy weakness v3 + rank1 structural phase v2 + rank1 high structural score v1 + rank1 negative legacy score v2 + head near-zero + rank1 octave-down）：

- pass：976
- fail：431
- pass rate：69.37%
- error：0
- 输出：`grid-analysis-lab/rkb-rekordbox-benchmark/frkb-current-latest.json`；
  刷新来源为 `grid-analysis-lab/rkb-rekordbox-benchmark/frkb-current-rank1-high-structural-score-v2.json`
- 失败分类：`first-beat-phase` 307，`downbeat` 66，`bpm` 30，`half-or-double-bpm` 28
- guard 计数：`legacy-fallback-low-confidence` 1272，`constant-grid-dp-conservative-switch` 42，
  `constant-grid-dp-locked-rising-edge-ranker` 23，
  `constant-grid-dp-rank1-negative-legacy-score-switch` 16，`legacy-fallback-integer-bpm-snap` 15，
  `constant-grid-dp-head-near-zero-switch` 12，`constant-grid-dp-rank1-structural-phase-switch` 11，
  `constant-grid-dp-rank1-octave-down-switch` 5，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch` 4，
  `constant-grid-dp-phase-evidence-switch` 4，
  `constant-grid-dp-rank1-high-structural-score-switch` 3

冻结 blind baseline：

- solver：`constant-grid-dp`
- pass：423 / 608 = 69.57%
- error：0
- 失败分类：`first-beat-phase` 140，`downbeat` 27，`bpm` 16，`grid-drift` 1，
  `half-or-double-bpm` 1
- candidate oracle：599 / 608 = 98.52%
- 没有 passing candidate：9
- 有 passing candidate 但 scorer 未选中：176
- 最终选择来源：legacy fallback 595，candidate solver conservative switch 13

当前 blind selected（`constant-grid-dp` + locked ranker + integer BPM snap + rank1 material legacy weakness v3 + rank1 structural phase v2 + rank1 high structural score v1 + rank1 negative legacy score v2 + head near-zero + rank1 octave-down）：

- pass：436 / 608 = 71.71%
- error：0
- 失败分类：`first-beat-phase` 126，`downbeat` 30，`bpm` 15，
  `half-or-double-bpm` 1
- candidate oracle：599 / 608 = 98.52%
- 没有 passing candidate：9
- 有 passing candidate 但 scorer 未选中：163
- guard 计数：`legacy-fallback-low-confidence` 567，`constant-grid-dp-rank1-negative-legacy-score-switch` 1，
  `constant-grid-dp-head-near-zero-switch` 3，
  `constant-grid-dp-conservative-switch` 13，
  `constant-grid-dp-locked-rising-edge-ranker` 9，`legacy-fallback-integer-bpm-snap` 6，
  `constant-grid-dp-phase-evidence-switch` 3，
  `constant-grid-dp-rank1-structural-phase-switch` 4，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch` 2
- 相比 phase evidence v2 净增 11 首；相比 structural phase v2 净增 1 首；逐曲 diff 没有
  `pass -> fail`。rank1 negative legacy score 在 blind 只改变错误类型，不新增 pass；rank1 octave-down
  和 rank1 high structural score 在 blind 没有触发。这里仍是已看过
  blind 上的开发回归，不是新的泛化证明。

latest test353 selected（已消耗 sealed-intake 批次）：

- baseline：222 / 353 = 62.89%
- final selected（rank1 negative legacy score v2 + rank1 high structural score v1 + rank1 octave-down）：225 / 353 = 63.74%
- error：0
- 失败分类：`first-beat-phase` 83，`downbeat` 15，`bpm` 17，`half-or-double-bpm` 12，
  `grid-drift` 1
- candidate oracle：338 / 353 = 95.75%
- 没有 passing candidate：15
- 有 passing candidate 但 scorer 未选中：113
- guard 计数：`legacy-fallback-low-confidence` 314，
  `constant-grid-dp-rank1-negative-legacy-score-switch` 2，
  `constant-grid-dp-head-near-zero-switch` 5，`constant-grid-dp-conservative-switch` 13，
  `constant-grid-dp-phase-evidence-switch` 6，
  `constant-grid-dp-locked-rising-edge-ranker` 5，`legacy-fallback-integer-bpm-snap` 4，
  `constant-grid-dp-rank1-structural-phase-switch` 2，
  `constant-grid-dp-rank1-high-structural-score-switch` 1，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch` 1
- rank1 negative legacy score v2 相比 v1 保留 `224` pass，但用小相位差 soft guard 避免两次
  不必要切换；最终仅有 2 次非 pass 错误类型变化，逐曲 diff 没有 `pass -> fail`。
  rank1 high structural score v1 再救回 `Amonita - Walking In The Rain (Original Mix).mp3`，
  使 test353 到 `225 / 353`，仍无 `pass -> fail`。
  这批已经被优化消耗，不是新的泛化证明。

consumed test327 selected（已消耗 sealed-intake 批次）：

- pass：218 / 327 = 66.67%
- error：0
- 失败分类：`first-beat-phase` 64，`downbeat` 27，`bpm` 8，
  `half-or-double-bpm` 10
- candidate oracle：316 / 327 = 96.64%
- 没有 passing candidate：11
- 有 passing candidate 但 scorer 未选中：98
- guard 计数：`legacy-fallback-low-confidence` 273，
  `constant-grid-dp-head-near-zero-switch` 6，
  `constant-grid-dp-locked-rising-edge-ranker` 19，
  `legacy-fallback-integer-bpm-snap` 6，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch` 3，
  `constant-grid-dp-phase-evidence-switch` 5，
  `constant-grid-dp-conservative-switch` 4，
  `constant-grid-dp-rank1-structural-phase-switch` 3，
  `constant-grid-dp-rank1-negative-legacy-score-switch` 5，
  `constant-grid-dp-rank1-octave-down-switch` 3
- head near-zero 相比 structural phase v2：`212 -> 215`，命中
  `Chiodan - Persoana.mp3`、`Crankdat & NGHTMRE - TYPE SHIT  (Spritzur Ed.wav`、
  `JayJay - Cinema (master).wav`；current / blind / test327 逐曲 diff 没有 `pass -> fail`。
  final rank1 negative legacy score v2 + rank1 octave-down 再到 `218`：`Ariana Grande - thank u, next (PeteDown Mix).mp3`
  由 rank1 negative legacy score 救回；`Kid Ink feat. Lil Wayne & Saweetie - YUSO (I.mp3`
  和 `City Girls feat. Cardi B vs. Juicy J - Twerk.mp3` 由 rank1 octave-down 救回；
  `14？,Shing02 - Real With You Feat. Shing02.mp3` 只是 `half-or-double-bpm -> downbeat`
  的非 pass 类型变化。这批已经被优化消耗，不是新的泛化证明。

consumed test316 selected（已消耗 sealed-intake 批次）：

- pass：176 / 316 = 55.70%
- error：0
- 失败分类：`first-beat-phase` 83，`downbeat` 20，`half-or-double-bpm` 21，`bpm` 16
- candidate oracle：298 / 316 = 94.30%
- 没有 passing candidate：18
- 有 passing candidate 但 scorer 未选中：122
- guard 计数：`legacy-fallback-low-confidence` 279，`constant-grid-dp-conservative-switch` 10，
  `constant-grid-dp-head-near-zero-switch` 6，`constant-grid-dp-locked-rising-edge-ranker` 6，
  `constant-grid-dp-rank1-structural-phase-switch` 5，
  `constant-grid-dp-rank1-negative-legacy-score-switch` 4，
  `legacy-fallback-integer-bpm-snap` 3，`constant-grid-dp-phase-evidence-switch` 2，
  `constant-grid-dp-rank1-octave-down-switch` 1
- rank1 octave-down 相比上一轮：`175 -> 176`，命中
  `Club des Belugas - It Don't Mean a Thing.mp3`。这批已经被优化消耗，不是新的泛化证明。

latest test-new-357 selected（已消耗 sealed-intake 批次）：

- pass：231 / 357 = 64.71%
- error：0
- 失败分类：`first-beat-phase` 102，`downbeat` 14，`bpm` 7，
  `half-or-double-bpm` 2，`grid-drift` 1
- candidate oracle：343 / 357 = 96.08%
- 没有 passing candidate：14
- 有 passing candidate 但 scorer 未选中：112
- guard 计数：`legacy-fallback-low-confidence` 336，
  `constant-grid-dp-locked-rising-edge-ranker` 8，`constant-grid-dp-conservative-switch` 6，
  `legacy-fallback-integer-bpm-snap` 3，
  `constant-grid-dp-rank1-structural-phase-switch` 1，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch` 2，
  `constant-grid-dp-phase-evidence-switch` 1
- v3 相比 v2：`229 -> 230`，命中
  `Ray Okpara - Brainows (Alvaro Medina Remix).mp3`，逐曲 diff 没有 `pass -> fail`。
  structural phase v2 相比 v3：`230 -> 231`，命中
  `Oliver Koletzki - It's All Gone (Original Mix).mp3`。这批已经被优化消耗，不是新的泛化证明。

`scripts/rkb_phase_ranker_rising_edge_locked_replay.py` 口径说明：

- replay baseline 取决于输入 benchmark 是否已经集成 production guard；它只做污染假设回放 sanity，
  不作为新的 production 提升证明。
- pre-v3 latest test-new-357 replay 曾输出 current `696 -> 697`、blind `425 -> 432`、
  test-new-357 `229 -> 230`，三套集合 `pass -> fail = 0`；v3 已把其中 test-new-357
  的 1 首纳入 production benchmark。
- 分阶段回归口径在旧 931 首 current 上曾是 current
  `685 -> 694 -> 695 -> 696 -> 701 -> 702 -> 702 -> 706 -> 707`、blind
  `425 -> 430 -> 430 -> 432 -> 434 -> 435 -> 436 -> 436`、old consumed test
  `274 -> 277 -> 278 -> 279`；latest test-new-357 只能记作 `229 -> 230 -> 231`，
  latest test327 只能记作 `212 -> 215 -> 218`，latest test353 只能记作 `222 -> 224 -> 225`，
  latest test316 只能记作 `175 -> 176`。
- 本轮 476 首新样本合入 current 后，production baseline 为 `973 / 1407`；
  rank1 high structural score v1 收紧 legacy head guard 后刷新为 `976 / 1407`，
  current 逐曲 diff 为 `first-beat-phase -> pass = 3`、`pass -> fail = 0`。

失败分类：

- `first-beat-phase`：307
- `downbeat`：66
- `bpm`：30
- `half-or-double-bpm`：28

候选覆盖：

- 全量 fail：431
- candidate oracle：1353 / 1407 = 96.16%
- 没有 passing candidate：54
- 有 passing candidate 但 scorer 未选中：377
- 最终选择来源：legacy fallback 1287，candidate solver non-legacy source 120

当前 5ms benchmark、classification、派生视图和音频目录已经刷新到 `976 / 1407 = 69.37%`、
error `0`。固定 latest 文件为 `frkb-current-latest.json`，classification 为
`frkb-classification-current.json`，派生视图为 `sample-regression-latest.json`
和 `grid-failures-current-latest.json`。音频库整理口径如下。

FRKB-5 正式开发音乐库固定为 `D:/FRKB_database-E`。音乐库中长期保留 5 个可见音频歌单，
另有 1 个固定临时入口：

- `D:/FRKB_database-E/library/FilterLibrary/new`：主 current 新样本入口，当前目标数量 0。
- `D:/FRKB_database-E/library/FilterLibrary/sample`：current pass 样本，当前目标数量 976。
- `D:/FRKB_database-E/library/FilterLibrary/grid-failures-current`：current 非 pass / error 样本，
  当前目标数量 431。
- `D:/FRKB_database-E/library/FilterLibrary/blind-rekordbox-truth`：blind truth 音频归档，608 首。
- `D:/FRKB_database-E/library/FilterLibrary/sealed-eval`：old consumed sealed/test 回归音频归档，1412 首。
- `D:/FRKB_database-E/library/FilterLibrary/sealed-intake`：latest test316 已消耗批次当前仍在此处，
  共 316 首；归档/清空后才可作为下一批 fresh sealed 的固定临时入口。

`D:/FRKB_database-B` 只作为历史样本库来源保留，不再作为 FRKB-5 脚本默认目标。禁止再新建
`Benchmark/current-*` 或按批次命名的长期 sealed 歌单。当前音频目录按 latest classification
同步完成后，`sync_frkb_classification_audio_dirs.py --dry-run` 必须显示 `moveCount = 0`。

后续每次刷新 classification 后，先复查 dry-run，再执行不带 `--dry-run` 的同步命令。

同步校验命令：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_frkb_classification_audio_dirs.py" --dry-run
```

最新 classification 与音频目录同步后，期望结果：`moveCount = 0`。本轮 rank1 high structural
score 实际移动 `Damir Prohic - Temple Dance (Original Mix).mp3`、`Dubfire - Deadbug.mp3`、
`Girls of the Internet,shiv - Never Ever Ever.mp3` 从 `grid-failures-current` 到 `sample` 后，
dry-run 已归零。

当前主要问题已经从候选覆盖不足转成 selector / phase 语义不清。主 truth oracle 是 96.16%，
blind oracle 是 98.52%，说明候选池已经覆盖大多数正确 grid；真正缺的是稳定判断
Rekordbox 风格 first beat phase 的证据。locked ranker、integer BPM snap、rank1 material
legacy weakness v3、rank1 structural phase v2、rank1 high structural score v1、
rank1 negative legacy score v2、head near-zero 和 rank1 octave-down 都只是在窄
guard 下带来小幅干净提升。`test` 批次已被消耗，current / blind 也都是已看过数据；
下一步不能继续扫阈值或扩大 guard，只能拿 fresh sealed 样本原样复验，
或另找新的结构性 phase evidence。

fresh sealed 的第一目标不是现场涨分，而是验证当前 production solver 是否原样泛化。下一批新样本必须先
锁住 `rank1 structural phase v2`、`rank1 negative legacy score v2`、`head near-zero`
、`rank1 high structural score v1` 与 `rank1 octave-down` 现有阈值，
记录 pass rate、error、candidate oracle、guard 分布、
低概率高证据分支、rank1 high structural score v1、rank1 negative legacy score v2、
head near-zero 和 rank1 octave-down
触发曲目；rank<=8/topN、降阈值、half/double BPM switch 只能作为离线诊断，不允许在
同一批 fresh 上直接转成 production 修改。

phase 语义诊断报告：

- 产物：`phase-semantics-diagnostic-latest.json`
- 脚本：`scripts/rkb_phase_semantics_diagnostic.py`
- current first-beat-phase 失败中，`177 / 197` 有 passing candidate；blind 是 `132 / 139`。
- best passing candidate 的中位 rank 都是 `5`，说明候选已经很近，selector 仍没选中。
- top1 新候选到 best passing candidate 的相位差中位数：current `3.803ms`，blind `2.0ms`。
- top1 signed delta 不稳定：current 中位 `+2ms`，blind 中位 `0ms`，各 split 在 `0-2ms`
  间摆动；不能据此做全局 offset。
- best-vs-top 的现有 leadingEdge / phasePath / segmentAgreement 特征中位差基本为 `0`，
  说明 5ms 级相邻 phase 的区分证据不足，继续加权现有字段不是可靠突破口。

phase trajectory 诊断报告：

- 产物：`phase-trajectory-diagnostic-latest.json`
- 脚本：`scripts/rkb_phase_trajectory_diagnostic.py`
- full / low attack trajectory 可以解释 top1 与 best passing 为何只差几毫秒：fullAttack
  `trajectoryExplainsDeltaWithin4msRate` 在 current 为 `0.853107`，blind 为 `0.833333`。
- 但它不能安全决定“切不切 top1”：fullAttack `topPullTowardBestRate` 只有 current `0.180791`、
  blind `0.151515`；lowAttack 更低。
- 固定 guard 模拟全部为负：current 最好的 `full-0.30-low-0.25-score-0.90` 是
  `switch 142 / rescue 10 / hurt 41 / net -31`；blind 最好的 `full-0.35-low-0.30` 是
  `switch 97 / rescue 9 / hurt 29 / net -20`。
- holdout 也没有通过：current 最好 `net -4`，blind 最好 `net -2`。因此 trajectory 只保留诊断，
  不进入 production scorer 或 switch guard。

phase-ranker 诊断报告：

- 产物：`phase-ranker-diagnostic-latest.json`
- 脚本：`scripts/rkb_phase_ranker_diagnostic.py`
- 这是纯 NumPy logistic ranker，训练只用 current/train + blind/train，模型和阈值只按
  current/tune + blind/tune 选择；holdout 只做验收。
- 特征只使用候选数值特征、候选与当前 selected 的数值差、feature-cache 中
  beatLogit / downbeatLogit / fullAttack / lowAttack 的局部 trajectory profile，以及
  onset-foot / ramp-foot 诊断特征；不使用 fileName、artist、title、path、split identity、
  truth、benchmark category 或 source one-hot。
- tune 选择出的保守配置是 `top-new`、`l2 = 0.1`、`threshold = 0.95`。tune 结果：
  current `159 -> 161`、blind `92 -> 94`，均无 `pass -> fail`。
- holdout 结果：current `130 -> 133`、blind `88 -> 91`，均无 `pass -> fail`。
- 全量结果：current `685 -> 691`，但有 `pass -> fail = 1`；blind `425 -> 432`，没有
  `pass -> fail`。因此当前选中配置仍不能进 production。
- 验证报告里另有一个更保守的候选配置 `ranked-top16 / l2 = 0.3 / threshold = 0.94`：
  current all `685 -> 689`、blind all `425 -> 429`，tune / holdout / all 均无 `pass -> fail`。
  但这是在查看验证报告后识别出的候选，属于验后污染假设；只能锁定后拿 future-data 复验，
  不能当场提拔为生产选择，也不能把这段当前回放描述成干净预注册证据。
- 验后污染 locked replay 脚本：`scripts/rkb_phase_ranker_preregistered_replay.py`
- 验后污染 locked replay 产物：`phase-ranker-preregistered-replay-latest.json`
- locked config：`ranked-top16 / l2 = 0.3 / threshold = 0.94`
- locked replay 当前回放：current train `396 -> 397`、tune `159 -> 161`、holdout `130 -> 131`、
  all `685 -> 689`；blind train `245 -> 247`、tune `92 -> 93`、holdout `88 -> 89`、
  all `425 -> 429`；所有这些 split 都是 `pass -> fail = 0`。
- 全网格安全筛查中，有 54 个配置满足 current/blind 的 tune / holdout / all 都不回退且
  `pass -> fail = 0`；locked config 是其中 total all net 最高的回放配置。
- 这不是当前准确率提升证明：配置是在当前报告暴露后挑出来的，已经污染。生产合并前必须在
  新增 truth 或 fresh blind 上按原样 replay，且不能再改阈值、改特征或改筛选口径。

onset-foot phase 诊断报告：

- 产物：`onset-foot-phase-diagnostic-latest.json`
- 脚本：`scripts/rkb_onset_foot_phase_diagnostic.py`
- 目标是模拟 Rekordbox 可见波形里“grid 落在峰值前 ramp foot / onset foot”的语义，而不是只看
  peak 是否在 grid 后 `8-12ms`。
- 单独作为 hard guard 时不够强：tune 选择的保守 guard 在 current holdout 没有净增，blind
  holdout 只 `88 -> 89`；current all 还会 `685 -> 683`，有 `pass -> fail = 2`。
- 作为 ranker 特征时有明显信号：candidate pass / fail 的 onset-foot score 中位数在 holdout
  上约为 current `0.714627 / 0.483811`、blind `0.732657 / 0.491912`。这说明 onset-foot
  是有用特征，但仍需要更稳的 guard 或 fresh validation。

selected weakness phase-ranker 诊断报告：

- 产物：`phase-ranker-selected-weakness-diagnostic-latest.json`
- 脚本：`scripts/rkb_phase_ranker_selected_weakness_diagnostic.py`
- 目标是验证 selected legacy / anchor 的数值弱置信度能否给 ranker 一个非身份、非真值的切换 guard。
- 结果没有突破旧 ranker：tune-selected 仍是 `top-new / l2 = 0.1 / threshold = 0.95`，current
  holdout `130 -> 133`、blind holdout `88 -> 91`，均无 `pass -> fail`；但 current all 仍是
  `685 -> 691` 且 `pass -> fail = 1`，blind all `425 -> 432`。
- 该特征族没有进入生产，也不应作为继续放宽阈值的理由；后续除非有 fresh truth 证明，否则不要重复
  在 selected weakness 上调参。

rising-edge phase-ranker 诊断报告：

- 产物：`phase-ranker-rising-edge-diagnostic-latest.json`
- 脚本：`scripts/rkb_phase_ranker_rising_edge_diagnostic.py`
- 目标是验证 full/low attack envelope 的正向导数峰值是否能表达 Rekordbox grid 对 rising edge 的偏好。
- 修正为“onset-foot 基线 + rising-edge 增量”后，tune 选择配置为
  `ranked-top16 / l2 = 0.3 / threshold = 0.93`；`same-mod4` guard 变体结果相同，没有额外增益。
- 当前回放：current tune `159 -> 161`、holdout `130 -> 135`、all `685 -> 694`；
  blind tune `92 -> 94`、holdout `88 -> 89`、all `425 -> 430`；这些 split 均为
  `pass -> fail = 0`。
- rising-edge 特征是在查看现有报告后提出的验后污染假设，不能作为当前提升证据；除非 future-data
  复验给出明显正增，否则不进入 production scorer。它仍远不到 `80%`，不能作为停止优化的理由。
- locked replay 脚本：`scripts/rkb_phase_ranker_rising_edge_locked_replay.py`
- locked replay 产物：`phase-ranker-rising-edge-locked-replay-latest.json`
- locked config：`ranked-top16 / l2 = 0.3 / threshold = 0.93 / requireSameMod4 = false`
- bar-prior ablation：`scripts/rkb_phase_ranker_rising_edge_ablation_diagnostic.py` 验证了移除
  `barBeatOffset*` 和 `barBeatOffsetSame*` 这类 prior 后，current all 只 `685 -> 688`、blind all
  只 `425 -> 428`，仍无 `pass -> fail`；说明直接去掉 bar prior 更保守但少救，不是当前突破口。
- direct selected phase shift：按 rising-edge median 直接平移 selected grid 的固定 target /
  max-shift / min-score 网格在 current 上普遍净负，blind 也不稳；不进入 production。

## 3. 音频目录

FRKB-5 使用的音频统一放在 `D:/FRKB_database-E/library/FilterLibrary/`。稳定状态下只保留
5 个长期音频歌单，另有 1 个固定临时入口：

```text
D:/FRKB_database-E/library/FilterLibrary/new
D:/FRKB_database-E/library/FilterLibrary/sample
D:/FRKB_database-E/library/FilterLibrary/grid-failures-current
D:/FRKB_database-E/library/FilterLibrary/blind-rekordbox-truth
D:/FRKB_database-E/library/FilterLibrary/sealed-eval
D:/FRKB_database-E/library/FilterLibrary/sealed-intake
```

目录语义：

- `new`：由脚本从 Rekordbox `test` 曲目源路径复制出来的新样本暂存区。
- `sample`：当前 classification = `pass` 的音频。
- `grid-failures-current`：当前 classification != `pass` 或 benchmark error 的音频。
- `blind-rekordbox-truth`：独立 blind truth 音频归档，不进入主 truth，不参与无 split 调参。
- `sealed-eval`：已经跑完并失去 sealed 身份的回归音频归档，不再用于现场调阈值。
- `sealed-intake`：下一批 fresh sealed 的固定临时入口；验收结束后必须清空。

current 主样本只在 `new` / `sample` / `grid-failures-current` 三个目录中流转。同一首 current
样本不能同时存在于多个 current 目录。目录是 classification 的派生状态，不是真值来源。

blind 与 sealed 是数据集隔离边界，不是 current 分类目录。禁止把 blind/sealed 音频混入
`new`、`sample` 或 `grid-failures-current`，也禁止按批次无限增加 `sealed-eval-YYYYMMDD`
这类长期歌单；批次身份由 truth / manifest 记录。

## 4. 新样本闭环

新增样本必须走完整闭环：

1. 如果本轮源歌单是 `Upan`，先运行 `scripts/move_upan_non_integer_bpm_tracks.py` 做源头清理；
   该脚本默认 dry-run，确认后加 `--apply` 写回，不删除音频文件。清理顺序固定为：先从
   `Upan` 直接移除 current truth 重复曲目和源歌单内部重复多余项，再把剩余曲目里 UI BPM
   列显示为非整数的曲目移动到 `upanNonIntegerBpm` 人工筛查歌单。
2. 把待处理歌曲加入 Rekordbox `test` playlist。
   - 如果歌曲是新导入 Rekordbox 的音频，必须等 Rekordbox 完成分析后再继续。
   - 如果歌曲来自已有 Rekordbox 歌单（例如 `Upan`），并且 bridge 已能读到 `bpm` / grid，
     则视为 Rekordbox 已分析完成；从 `Upan` 移到 `test` 后不需要再等待分析，可以直接进入人工筛查或差异分拣。
3. 人工删除 Rekordbox 自己也失败、不可信、或音频缺失的曲目。
4. 从 Rekordbox `test` 读取曲目源路径，把主 truth 里没有的新音频复制到 `new`。
5. 抓取 Rekordbox truth 到 `intake-current-truth.json`；已在主 truth 里的重复样本默认跳过，不进入 intake。
   重复判定至少包含 `fileName`，以及保守的 `title + artist + BPM` 元数据匹配。
6. 确认 `intake-current-truth.json` 与 `new` 目录音频一一对应。
7. 把 intake 合入 `rekordbox-current-truth.json`，同时清空 intake。
8. 跑 `current` benchmark，生成 `frkb-current-latest.json`。
9. 生成 `frkb-classification-current.json` 和三个派生视图。
10. 按 classification 同步音频目录：`pass -> sample`，其他 -> `grid-failures-current`。
11. 清理 Rekordbox `test` 中已处理曲目。

truth 入库后，后续算法优化只更新 classification 和派生视图，不再搬 truth。

## 4.1 Blind truth 闭环

blind truth 与新增主样本闭环分开处理：

1. 从 Rekordbox `test` playlist 读取人工确认过的正确曲目。
2. 跳过已经存在于主 truth 的重复曲目。
3. 把剩余音频复制到 `D:/FRKB_database-E/library/FilterLibrary/blind-rekordbox-truth/`。
4. 抓取 Rekordbox grid 到 `blind-rekordbox-truth/rekordbox-blind-truth.json`。
5. 生成 `blind-rekordbox-truth/rekordbox-blind-truth.m3u8` 作为项目内 blind 歌单。
6. 生成 `blind-rekordbox-truth/manifest.json`，记录数量、哈希、路径和隔离规则。
7. 运行一致性校验，确保 truth 曲目与 audio 文件一一对应。
8. 冻结当前算法后先跑 blind baseline；第一次结果只汇报，不现场调参。
9. baseline 跑完后生成固定 split：train 334，tune 146，holdout 128。

blind truth 不进入 `intake-current-truth.json`，不合并到 `rekordbox-current-truth.json`。
第一次 baseline 已经完成，这批数据后续只能作为独立外部验证集按固定 split 使用：train / tune
可用于离线诊断和受控调参，holdout 只在阶段性验收时打开。禁止把 blind 全量结果反复用作阈值扫描目标。

## 5. 算法优化闭环

当前阶段不再以新增 `rescue`、`arbitration` 或小型 prior 为主。继续在当前失败集上手搓
`if` 最多只能多救极少数样本，这不是普适算法，而是在给样本库化妆。

后续目标是把 analyzer 改成“多候选生成 + 统一打分器”的 grid solver：

1. analyzer 必须先生成多个完整 grid 候选，再由统一 scorer 选择最终结果。
2. 每个候选至少表达 `bpm`、`firstBeatMs`、`barBeatOffset`、time basis 语义、
   来源、候选内部一致性特征和可调试的中间证据。
3. `window`、`full-logit`、`attack-envelope`、`global-solver`、
   `stream-start/time-basis` 都作为候选来源，而不是串成一路救援链。
4. 现有 `rescue` / `arbitration` 逻辑只允许临时作为 legacy 候选来源或对照组，
   禁止继续扩展成最终决策分支。
5. scorer 只吃通用音频信号特征和候选自洽特征，禁止吃歌名、artist、路径、
   truth、benchmark 误差、pass/fail、失败清单或逐曲标签。
6. scorer 不能靠候选来源名称写死优先级；来源名称只用于调试、消融分析和报表归因。

优化算法时按这个顺序验收：

1. 先固定数据集切分，再调算法。至少保留训练/调参集和锁死 holdout。
2. 优先按失败类型、artist、source 或音频来源做 cluster split，避免同质样本同时出现在
   调参集和 holdout 中。
3. 先实现候选 dump 和 scorer 特征 dump，确认正确候选是否进入候选池。
4. 再调 scorer。调参只能在训练/调参集做，holdout 只在阶段性验收时打开。
5. 跑全量 `current` benchmark，重建 classification 和派生视图。
6. 固定输出分类迁移、`pass -> fail`、`fail -> pass`、BPM 大错率、phase 误差分布、
   downbeat 回归、候选命中率和 scorer 排名错误。
7. 默认不接受新的 `pass -> fail`，除非能明确证明只是评估暴露而非 analyzer 退化。
8. 只有跨 cluster 稳定成立、且 holdout 不退化的机制才允许合并。

失败样本只用于聚类、候选覆盖分析和验证泛化。禁止把失败样本当逐曲补丁来源。

blind baseline 后已做过一轮 selector 诊断：topN / new-rank switch、小型
logistic / tree ranker、phase cluster consensus、legacy score threshold、统一 phase shift、
front-edge / leading-edge 直接加权都没有稳定突破 `80%`，且容易牺牲 current 或 blind
holdout。第一版 intro leading-edge phase evidence 已以极保守 guard 落地，只小幅救回样本。
phasePath 分段评分已经验证为诊断可用、生产切换不可用：包含 phasePath 权重的 v3 switch
会丢掉 blind holdout 上的 v2 救回样本。现阶段不继续放宽这些阈值补丁；下一步必须做
更强 phase evidence，而不是继续重排现有候选。

`rkb_phase_semantics_diagnostic.py` 已把主 truth 和 blind 的 first-beat-phase 失败拆到
candidate-level。当前数据说明：正确候选通常就在 topN 邻域内，很多只差几毫秒；但现有
features 对 top1 与 best passing 的中位差接近 `0`，没有能泛化到 blind 的区分信号。下一步
应补真正的新音频证据，例如 intro 内多个稳定节拍段的局部相位轨迹、kick 前缘/峰值/低频重心
的分段一致性，而不是再给已有分数加 bonus。

`rkb_phase_trajectory_diagnostic.py` 已验证“局部相位轨迹”这条线：它能解释 top1 与 best
passing 的几毫秒偏移，但不能安全地区分 top pass / top fail。任何把 trajectory margin 当
switch guard 的方案都会在 current 和 blind 全量上净负，主要问题是 pass->fail 多于 fail->pass。
这条线不应进生产；后续要么换更强输入特征，要么换能直接建模 Rekordbox 网格语义的学习目标。

`rkb_onset_foot_phase_diagnostic.py` 已验证“ramp foot / onset foot”这条线：单独 hard guard
不能安全上线，但它能提供比旧 leading-edge / phasePath 更强的候选区分信号。把 onset-foot
作为非泄漏特征加入 `rkb_phase_ranker_diagnostic.py` 后，保守 tune-selected 配置在 current /
blind 的 tune 与 holdout 都有正增且无 `pass -> fail`，但 current 全量仍伤 1 首；报告里存在
一个全 split 零伤害的候选配置，但它是验证后识别出来的验后污染假设，只能锁定后等待
future-data 复验，不能当场上线。
`rkb_phase_ranker_preregistered_replay.py` 已把这个候选固定成 locked replay：`ranked-top16 /
l2 = 0.3 / threshold = 0.94`。当前回放全 split 零伤害，current all `+4`、blind all `+4`，
但它仍然不是 fresh evidence；生产合并前必须跑新 truth 或 fresh blind。

`rkb_phase_ranker_selected_weakness_diagnostic.py` 已验证 selected legacy / anchor weakness 数值特征：
它没有比 onset-foot ranker 提供更大的安全提升，current all 仍有 `pass -> fail = 1`。这条线
只保留为诊断，不进入 production scorer。

`rkb_phase_ranker_rising_edge_diagnostic.py` 已验证 rising-edge derivative 特征：候选 pass/fail
分布存在可解释信号；与 onset-foot 一起进 ranker 后 current all `+9`、blind all `+5`，全 split
零 `pass -> fail`。但这条特征是在查看现有报告后提出的验后污染假设，只保留为 future-data
hypothesis，不进入 production scorer。
`rkb_phase_ranker_rising_edge_ablation_diagnostic.py` 已验证去掉 bar prior 的版本不如完整特征：
current all `+3`、blind all `+3`，只能作为抗过拟合检查留档。
direct rising-edge phase shift 已做固定网格探针，结论是 current 净负、blind 不稳；不要把
候选级 rising-edge 信号误改成 selected-grid 直接平移。

允许结构性大改。现在的重点不是“再找一个 prior”，而是把 solver 分层拆清楚：

- candidate generator：尽可能召回合理 BPM / phase / downbeat / time-basis 候选。
- feature extractor：把候选和音频证据转成通用、可复现的特征。
- scorer：统一比较候选，输出最终 grid。
- benchmark reporter：报告候选覆盖、scorer 排名、最终输出和回归指标。

当前第一版 candidate solver 已落地，后续继续按这个结构演进：

- `scripts/beat_this_bridge.py` 负责收集 window、full-logit、attack-envelope、global-solver、
  stream-start/time-basis 和 legacy 输出等候选。
- `scripts/beat_this_candidate_solver.py` 负责提取候选自洽特征、音频信号特征和候选池共识特征，
  再统一打分选择最终 grid。
- `scripts/rkb_benchmark_*.py` 负责 benchmark 归一化、候选 oracle、summary 和回归指标。
- `scripts/build_rkb_rekordbox_dataset_splits.py` 负责生成固定 train / tune / holdout split。

旧方案输出只能作为候选或对照，不是兼容地板，也不能在最终选择阶段被特殊兜底。

如果失败聚类指向 solver 的结构性问题，应直接改对应层，而不是堆 prior：

- 候选池没有覆盖正确 BPM。
- 候选池有正确 BPM，但 phase 候选缺失。
- 候选池有正确 phase，但 downbeat 排名错误。
- time basis 候选生成错误或坐标语义混乱。
- 多窗口和 full-track 证据冲突，但 scorer 没有一致的比较标准。
- BeatThis 多窗口融合策略有系统偏差。
- phase solver 对 MP3 frame / decoded timeline 的抽象不干净。

判断规则：

- 正确候选没生成 -> 修 candidate generator。
- 正确候选生成了但分数低 -> 修特征或 scorer。
- 某类音频在训练集好、holdout 坏 -> 过拟合，回退该调参。
- 失败类型杂乱 -> 不急着改算法，继续收样本或改评估工具。
- 暴露 truth/音频同步问题 -> 先修数据流程。

大改同样禁止读取歌名、路径、truth、benchmark 误差和 pass/fail 分类参与 analyzer 决策。

## 6. 禁止事项

算法决策中禁止：

- 使用歌名、artist、路径、basename、播放列表来源。
- 使用文件大小、mtime、hash、fingerprint 做身份特判。
- 维护逐曲 offset 表、逐曲 phase 表、逐曲规则。
- 读取 Rekordbox truth、benchmark 误差、pass/fail 分类。
- 为贴合某首歌移动 Rekordbox truth 的 `firstBeatMs`。
- 用 Rekordbox `PWV5` 波形替换 FRKB raw waveform。
- 把离线能量峰、首个可见起点、最大振幅点当成 Rekordbox 真值。
- 写只命中极少样本的高维布尔补丁。
- 继续新增只服务当前失败清单的 `rescue` / `arbitration` 分支。
- 在同一批样本上反复调规则，再只用同一批样本的 pass 数证明有效。
- 让 scorer 读取 truth、误差、pass/fail、失败类型标签或候选来源名称来做决策。

没有歌名特判不代表没有过拟合。高维组合如果只服务极少数样本，也视为过拟合风险。

## 7. 候选来源与允许信号

允许引入 Rekordbox-compatible 候选和 scorer 特征，但必须描述机制，不描述样本。

允许的候选来源：

- BeatThis window raw beats / downbeats。
- full-track beat logits / downbeat logits。
- attack envelope / local onset 候选。
- 多窗口 BPM / phase 共识候选。
- global solver 从完整 beat 序列生成的候选。
- 音频格式时间轴候选：`stream.start_time`、`Skip Samples`、encoder tag。
- 现有 rescue / arbitration 的输出，只能作为 legacy 候选或消融对照。

允许 scorer 使用的通用特征：

- 候选 grid 对 beat logits 的对齐分数。
- 候选 downbeat 对 downbeat logits 的对齐分数。
- onset / attack envelope 在候选拍点附近的集中度和偏移分布。
- beat 序列残差、中位相位、MAD、局部漂移和离群点比例。
- 多窗口候选之间的 BPM、phase、downbeat 共识强度。
- 半速 / 倍速 BPM 关系证据，但不能靠曲名或来源特判。
- time basis 候选的坐标一致性和容器证据。
- downbeat margin、bar-level 周期稳定性和 4 拍相位一致性。

这些特征必须能从音频、模型输出或容器时间轴信号中复现。`source` 字段可以用于日志、
消融和错误归因，但不能成为 scorer 的身份特判。

## 8. 数据语义

一首歌有三层数据：

- 音频文件：唯一共同输入。
- Rekordbox truth：`bpm`、`firstBeatMs`、`firstBeatLabel`、`barBeatOffset`、`PQTZ`。
- FRKB analyzer 输出：最终也必须表达 `bpm`、`firstBeatMs`、`barBeatOffset`。

`firstBeatMs` 是 Rekordbox 时间轴上的网格时间戳，不是音频第一个声音的位置。

FRKB 输出如果在 audio 轴上，benchmark 前必须转换：

```text
frkbFirstBeatTimelineMs = frkbFirstBeatAudioMs + timeBasisOffsetMs
```

如果 analyzer 已经输出 app timeline 语义，不能再加一次 offset。

analyzer 中间结果允许 `firstBeatMs < 0`。负值表示按当前 BPM 和相位外推，某条等价拍线落在 decoded sample 0 之前。候选、缓存、benchmark 归一化阶段不能提前丢弃。

## 9. time basis

Rekordbox 的 `firstBeatMs` 是 Rekordbox 时间轴；FRKB raw waveform 来自 FFmpeg decoded PCM。

当前坐标规则：

```text
timeBasisOffsetMs = ffprobe stream.start_time * 1000

如果满足：
  encoder tag 以大写 LAME 开头
  第一包存在 Skip Samples.skip_samples
  sample_rate 有效

则追加：
  timeBasisOffsetMs += skip_samples / sample_rate * 1000
```

坐标转换：

```text
timelineSec = audioSec + timeBasisOffsetMs / 1000
audioSec = timelineSec - timeBasisOffsetMs / 1000
```

这里修的是坐标，不是移动音频，也不是改 Rekordbox truth。

## 10. benchmark 等价定义

FRKB 输出归一化到 Rekordbox timeline 后比较：

```text
beatIntervalMs = 60000 / rekordboxBpm
phaseErrorMs = circularPhase(frkbFirstBeatTimelineMs - rekordboxFirstBeatMs, beatIntervalMs)
```

比较 downbeat 时，必须把首拍按整数拍折叠带来的 shift 同步应用到 `barBeatOffset`：

```text
firstBeatShiftBeats = nearestIntegerBeatShift(...)
normalizedFrkbBarBeatOffset = normalize(frkbBarBeatOffset + firstBeatShiftBeats)
barBeatOffsetMatch = normalizedFrkbBarBeatOffset == normalize(rekordboxBarBeatOffset)
```

固定 BPM 时，多拍比较：

```text
rbBeatMs[i] = rekordboxFirstBeatMs + i * 60000 / rekordboxBpm
frkbBeatMs[i] = frkbFirstBeatTimelineMs + i * 60000 / frkbBpm
gridErrorMs[i] = frkbBeatMs[i] - rbBeatMs[i]
```

硬阈值：

- `firstBeatPhaseAbsErrorMs <= 5ms`
- `gridMaxAbsMs <= 5ms`
- `bpmOnlyDrift128BeatsMs <= 5ms`
- `barBeatOffset` 必须匹配

没有灰区。任何一项超过阈值都算失败。

## 11. 命令

下一次新样本验收只走一次性 sealed-eval，不按批次新建长期歌单。用户在 Rekordbox 准备好
人工确认歌单后，先把当前污染假设锁死原样 replay；新音频先进入固定临时入口 `sealed-intake`。
跑完这批样本即失去 sealed 身份，后续再并入 `sealed-eval` 普通回归归档。禁止根据
sealed-eval 当场改阈值、删歌、挑样本或重训选择规则。

不要在文档或下次会话里假设 Rekordbox 新样本歌单名。用户给出实际歌单名后填入 `$playlist`：

```powershell
$playlist = "<用户提供的实际 Rekordbox 歌单名>"
$sealedRoot = "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval"
$sealedIntakeRoot = "D:/FRKB_database-E/library/FilterLibrary/sealed-intake"
$sealedArchiveRoot = "D:/FRKB_database-E/library/FilterLibrary/sealed-eval"
```

复制 sealed-eval 音频到 E 音乐库临时入口：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "$playlist" --target-root "$sealedIntakeRoot" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "$playlist" --target-root "$sealedIntakeRoot"
```

抓取 sealed-eval truth。默认仍按 `rekordbox-current-truth.json` 跳过已经在主 truth 里的重复样本；
不要加 `--include-existing`，除非明确是在修数据流程：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/capture_rekordbox_playlist_truth.py" --playlist "$playlist" --audio-root "$sealedIntakeRoot" --output "$sealedRoot/rekordbox-sealed-truth.json"
```

生成 sealed-eval feature cache 和当前 production solver benchmark。当前 `constant-grid-dp` 已包含
locked ranker、integer BPM snap、rank1 material legacy weakness v3、rank1 structural phase v2、
rank1 high structural score v1、rank1 negative legacy score v2、head near-zero 和 rank1 octave-down；这一步就是主验收输出，
不要在 sealed-eval 上现场改阈值：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_beatgrid_feature_cache.py" --truth "$sealedRoot/rekordbox-sealed-truth.json" --audio-root "$sealedIntakeRoot" --cache-dir "$sealedRoot/feature-cache" --prediction-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/beatthis-prediction-cache" --jobs 4 --device cpu
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --truth "$sealedRoot/rekordbox-sealed-truth.json" --audio-root "$sealedIntakeRoot" --output "$sealedRoot/frkb-sealed-constant-grid-dp.json" --solver constant-grid-dp --feature-cache-dir "$sealedRoot/feature-cache" --prediction-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/beatthis-prediction-cache" --jobs 4 --device cpu
```

验收完成并记录 manifest 后，把本批音频从 `sealed-intake` 并入 `sealed-eval`，再清空
`sealed-intake`。下一批 fresh sealed 仍复用同一个 `sealed-intake`，不要按批次新建长期歌单。

如需复核 locked rising-edge 子模型，可单独跑 replay。它只用于解释 locked ranker 本身；
当前 production solver 的最终结果仍以上面的 `constant-grid-dp` benchmark 为准：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_phase_ranker_rising_edge_locked_replay.py" --sealed-name "$playlist" --sealed-benchmark "$sealedRoot/frkb-sealed-constant-grid-dp.json" --sealed-feature-cache "$sealedRoot/feature-cache" --output "$sealedRoot/phase-ranker-rising-edge-locked-replay.json"
```

下一次会话快速开始：

```powershell
git status --short --branch
Get-Content "drafts/rkb-beatgrid-next-session-handoff.md"
rg -n "下一次新样本验收|当前状态|rising-edge|验后污染|交接摘要" "drafts/rkb-rekordbox-truth-validation-workflow.md"
rg -n "当前结论|phase-ranker rising-edge|direct phase shift|不要继续" "drafts/rkb-beatgrid-solver-pitfalls.md"
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_phase_ranker_rising_edge_locked_replay.py"
```

第一条看分支和本地状态；handoff 文件恢复交接上下文；后面两条恢复 truth/sealed-eval/踩坑上下文；
最后一条只做 current/blind 污染回放 sanity check，不是生产提升证明，也不是当前 production
solver 的最终 benchmark。

从 Rekordbox `test` playlist 复制新增音频到 `new`：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "test" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "test"
```

抓取 Rekordbox `test` playlist 到 intake：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/capture_rekordbox_playlist_truth.py" --playlist "test"
```

这一步默认跳过已经存在于 `rekordbox-current-truth.json` 的曲目，避免重复样本重新进入闭环。

合入主 truth 并清空 intake：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/merge_rekordbox_truth_intake.py" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/merge_rekordbox_truth_intake.py" --clear-intake
```

跑全量当前 benchmark：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --profile current --jobs 4
```

跑 blind feature cache 和冻结 baseline：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_beatgrid_feature_cache.py" --truth "grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/rekordbox-blind-truth.json" --audio-root "D:/FRKB_database-E/library/FilterLibrary/blind-rekordbox-truth" --feature-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/feature-cache" --prediction-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/beatthis-prediction-cache" --jobs 4 --device cpu
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --truth "grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/rekordbox-blind-truth.json" --audio-root "D:/FRKB_database-E/library/FilterLibrary/blind-rekordbox-truth" --output "grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/frkb-blind-constant-grid-dp-baseline.json" --solver constant-grid-dp --feature-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/feature-cache" --prediction-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/beatthis-prediction-cache" --jobs 4 --device cpu
```

生成固定数据集切分：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/build_rkb_rekordbox_dataset_splits.py" --write-truth-files
```

生成 classification 和派生视图：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/build_frkb_current_classification.py"
```

按 classification 同步音频目录：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_frkb_classification_audio_dirs.py" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_frkb_classification_audio_dirs.py"
```

临时排查单曲或子集：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --profile current --jobs 4 --only "artist or title substring" --output "grid-analysis-lab/rkb-rekordbox-benchmark/diagnostic-local.json"
```

`diagnostic-local.json` 只是临时排查文件，用完删除，不进入保留清单。

Python 编译检查：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" -m py_compile "scripts/beat_this_bridge.py" "scripts/beat_this_candidate_solver.py" "scripts/beat_this_phase_arbitration.py" "scripts/beat_this_phase_rescue.py" "scripts/beat_this_grid_rescue.py" "scripts/beat_this_full_logit_rescue.py" "scripts/beat_this_full_logit_utils.py" "scripts/beat_this_bpm_metrics.py" "scripts/beat_this_window_selection.py" "scripts/benchmark_rkb_rekordbox_truth.py" "scripts/rkb_benchmark_bridge_result.py" "scripts/rkb_benchmark_candidate_oracle.py" "scripts/rkb_benchmark_summary.py" "scripts/capture_rekordbox_playlist_truth.py" "scripts/sync_rekordbox_playlist_audio.py" "scripts/run_parallel_rkb_rekordbox_benchmark.py" "scripts/merge_rekordbox_truth_intake.py" "scripts/build_frkb_current_classification.py" "scripts/build_rkb_rekordbox_dataset_splits.py" "scripts/sync_frkb_classification_audio_dirs.py" "scripts/rkb_beatgrid_candidate_lab.py" "scripts/rkb_beatgrid_candidate_report.py" "scripts/rkb_beatgrid_feature_cache.py" "scripts/rkb_beatgrid_lab_common.py" "scripts/rkb_constant_grid_dp_cache.py" "scripts/rkb_constant_grid_dp_cli.py" "scripts/rkb_constant_grid_dp_high_structural.py" "scripts/rkb_constant_grid_dp_lab.py" "scripts/rkb_constant_grid_dp_octave.py" "scripts/rkb_constant_grid_dp_phase_path.py" "scripts/rkb_constant_grid_dp_solver.py" "scripts/rkb_hybrid_beatgrid_solver.py" "scripts/run_parallel_rkb_beatgrid_feature_cache.py" "scripts/rkb_phase_semantics_diagnostic.py" "scripts/rkb_phase_trajectory_diagnostic.py" "scripts/rkb_phase_ranker_diagnostic.py" "scripts/rkb_phase_ranker_preregistered_replay.py" "scripts/rkb_phase_ranker_selected_weakness_diagnostic.py" "scripts/rkb_phase_ranker_rising_edge_diagnostic.py" "scripts/rkb_phase_ranker_rising_edge_locked_replay.py" "scripts/rkb_phase_ranker_rising_edge_ablation_diagnostic.py" "scripts/rkb_onset_foot_phase_diagnostic.py"
```

代码修改后必须运行：

```powershell
npx vue-tsc --noEmit
```

## 12. 缓存边界

允许长期缓存：

- BeatThis raw window predictions。
- full-track logits。
- attack envelope / local onset 序列。
- ffprobe 和容器时间轴证据。
- 与算法决策无关、同音频同模型必然相同的中间输出。

允许临时缓存：

- 候选 dump。
- scorer feature dump。
- 候选覆盖和 scorer 排名诊断。

临时缓存必须绑定 solver 版本或 run id，只能用于本轮排查和复现实验，不能作为跨算法版本的
验收结论。

禁止缓存：

- 最终 `bpm` / `firstBeatMs` / `barBeatOffset`。
- 最终被选中的候选。
- scorer 分数、排名或仲裁结果。
- benchmark pass/fail 结论。
- anchor 选择、phase rescue、downbeat 归一化后的最终结果。
- 任何混入 truth、benchmark 误差、pass/fail 或失败类型标签的特征。

判断标准：

```text
改 FRKB 网格求解算法或 scorer 后，缓存内容本身是否仍应完全相同？
```

如果答案不是明确的“是”，就不能作为跨算法版本复用的验收结论。

## 13. 人工复核

benchmark 失败时：

1. 在 FRKB raw waveform 上显示 Rekordbox truth grid。
2. 同轴显示 FRKB analyzer grid。
3. 同轴显示候选池中每个候选的 grid、score、排名和主要特征。
4. 判断失败属于候选缺失、scorer 排名错误、BPM 大错、phase 偏移、downbeat 错位、
   time basis 错位，还是 Rekordbox truth 本身错误。
5. 如果 Rekordbox truth 错，回 Rekordbox 修 grid，再重新生成 truth。
6. 如果正确候选缺失，修 candidate generator。
7. 如果正确候选存在但排名靠后，修 scorer 特征或权重。
8. 如果同类错误只在训练/调参集改善、holdout 退化，判定为过拟合。

不要在 FRKB 里手工写补偿把失败样本抹平。

## 14. 交接摘要

```text
唯一长期 truth = rekordbox-current-truth.json。
grid-analysis-lab/ 是本地样本分析工作区，不提交 truth、benchmark 或 classification 派生数据；旧的已跟踪 JSON 即使出现在 git status，也不纳入代码提交。
FRKB-5 正式开发音乐库是 D:/FRKB_database-E；B 只作为历史来源，不再作为默认目标。
音乐库长期保留 5 个音频歌单：new、sample、grid-failures-current、blind-rekordbox-truth、sealed-eval；
sealed-intake 是唯一固定临时入口，用于下一批 fresh sealed，验收后清空。
新增主样本默认由 sync_rekordbox_playlist_audio.py 从 Rekordbox test 源路径复制到 new；sealed-eval
必须使用用户提供的实际 Rekordbox 歌单名，先进入 sealed-intake，验收后归档到 sealed-eval。
已有主 truth 的重复样本会被跳过；新 truth 进入 intake-current-truth.json，确认后合入主 truth 并清空 intake。
FRKB pass/fail 只存在于 frkb-classification-current.json 和派生 latest/manifest。
音频目录由 classification 派生：pass -> sample，其他 -> grid-failures-current。
算法优化只更新 classification，不搬 truth。
当前阶段停止继续堆小型 rescue/prior；analyzer 应重构为多候选生成 + 统一 scorer。
window、full-logit、attack-envelope、global-solver、stream-start/time-basis 都是候选来源。
scorer 只吃通用音频信号特征和候选自洽特征，禁止读取歌名、路径、truth、误差、pass/fail 或失败标签。
每次优化都要固定检查 pass -> fail、fail -> pass、分类迁移、BPM 大错率、phase 分布、downbeat 回归、候选覆盖和 scorer 排名错误。
调参必须有训练/调参集与锁死 holdout，最好按失败类型、artist 或 source 做 cluster split。
允许结构性大改；大改必须由候选覆盖、scorer 排名和失败聚类共同驱动，并通过全量 current benchmark 验收。
踩坑、禁止方向和下一步调优标准统一看 rkb-beatgrid-solver-pitfalls.md。
临时 benchmark 输出用完即删。
修改代码后必须跑 py_compile、相关 benchmark、npx vue-tsc --noEmit。
旧方案输出只能作为候选或对照，不能作为最终选择的兼容地板。
```
