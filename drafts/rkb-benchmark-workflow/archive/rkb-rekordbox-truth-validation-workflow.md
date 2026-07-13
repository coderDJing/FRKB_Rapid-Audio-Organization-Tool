# Rekordbox 真值验证工作流

> 历史参考快照，不是当前执行入口。文中凡是 D 盘、G 到 D、旧 cache 数量或旧状态机的描述均已过时；
> 当前以 `.env` 的 `G:/FRKB_database-E`、[`../准备好rkb新样本.md`](../准备好rkb新样本.md)
> 和 [`../rkb-nested-lobo-runner.md`](../rkb-nested-lobo-runner.md) 为准。

## 1. 核心原则

RKB beatgrid 长期维护三份权威文档：

- `drafts/rkb-benchmark-workflow/准备好rkb新样本.md`：当前 fresh 样本入口。
- `drafts/rkb-benchmark-workflow/rkb-beatgrid-solver-pitfalls.md`：仍然有效的踩坑结论、禁止方向和后续调优验收标准。
- `drafts/rkb-benchmark-workflow/rkb-beatgrid-next-session-handoff.md`：当前代码/模型锁、批次状态和下一步入口，不再堆逐曲调参流水账。

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
归档保留，不并入主 truth。它和 current、旧 sealed/test 批次都属于 consumed 开发数据，内部
train / tune / holdout 只能用于开发诊断，不能重新包装成 fresh 泛化证明。

按现有归档批次记录，历史共有 `3745` 个样本实例，现已全部 consumed，只能做 development replay。
中央身份源固定为 `grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-registry.json`，实例主键是 `instanceId = normalized(batchId) + ":" + normalized(assetSha256)`。
跨批同名允许；truth 只能在不可变 batch 内按 normalized `fileName` 连接，批内同名或重复 instanceId 报错。registry 至少包含 fileName、assetSha256、exact family/PCM、batchId 和 batchStatus。
缺少稳定身份的数据禁止进入 split/晋级报告，`batchStatus != consumed` 禁止进入 development split。

exact `familyId` 不足以阻断转码、裁头、补静音泄漏；正式 split/LOBO 先用固定 audio-only policy 合并 Chromaprint 近重复实例为 `isolationFamilyId`。
组件内实例同侧，落点使用 `assignmentKey = sha256(canonical sorted component exactFamilyIds)`；它不含 policy SHA，组件不变时 policy 升级不会洗牌，versioned isolationFamilyId 继续用于审计。
文件名、artist、truth、pass/fail、误差和 batch 成绩不得参与 isolation。v1 固定 SimHash tie->0、Hamming<=4、density L1<=3、shift[-120,120]、overlap>=600 且>=75%、mean bit error<=2/frame。
参数变化必须产生新 policy hash 并重建 split/LOBO；只按 exact family 的 split 不能用于晋级证明。
禁止根据准确率或 holdout 现场调 isolation 参数。development scope 固定为 `batchStatus=consumed`；fresh/evaluating/exposed 不参与 component/hash，fresh 在 prepare 内另做近重复隔离。

中央 registry 必须先一次性导入并覆盖这 3745 个 consumed 样本；在注册未完成、数量/身份校验未通过时，
`scripts/rkb_sealed_batch.py` 必须拒绝建立或验收新的 fresh 批次，禁止拿空 registry 开跑。

`grid-analysis-lab/` 是本地分析工作区。truth、benchmark、classification
和失败清单都跟本机样本库绑定，不作为仓库可提交资产。历史上已跟踪的旧 JSON
即使继续出现在 `git status`，也不代表应该提交。

FRKB pass/fail 是当前算法状态，只存在于 classification 和派生 benchmark 视图中。
禁止再拆成 `sample truth` / `failure truth` 两份长期真值。

## 1.1 算法调优硬闸门

任何 beatgrid analyzer / solver / scorer 调优都必须先过这组闸门。过不了闸门的结果只能作为
诊断材料，不能写成生产提升，也不能合入运行时决策。

1. fresh sealed 只做一次性验收：跑之前必须锁死代码、模型权重、特征结构、规则、阈值和 scorer
   配置；第一次完整算法曝光结束后，无论结果好坏，该批立即转为 consumed。禁止现场改阈值、删歌、
   挑样本、重训选择规则或把本批最高分配置包装成泛化证明。
   状态文件可以在 finalize 前显示 `exposed`，但 `exposed` 已永久撤销 fresh 身份，语义上必须按
   consumed 对待；finalize 只记录 eligible/reject/consume 决策并完成归档。
   同一时刻只允许一个 fresh/evaluating/exposed 批次；存在活动批次或 `sealed-intake` 除
   `.frkb.uuid` 外仍有内容时，prepare 必须拒绝，先 finalize 或清理残留后再继续。marker 是资料库
   节点身份，必须保留。
2. 用户人工流程保持 `Upan -> test -> needReview -> review` 不变，但在差异分拣前必须冻结完整批次。
   `needReview` 只改变 Rekordbox 歌单视图，不能缩小 frozen manifest 的 benchmark 分母，也不是产品
   把低置信分析交给用户的兜底流程。
3. current / blind / 已消耗 sealed 只能用于开发回归和归因：可以分析候选覆盖、phase 分布、
   scorer 排名错误和失败簇，不能当 fresh proof，也不能反复扫阈值后只用同一批 pass 数证明变强。
4. 开发 split 的实例身份必须使用 `batchId + assetSha256`，组件分组使用固定纯音频 policy 派生的
   `isolationFamilyId`，落点使用不含 policy SHA 的稳定 `assignmentKey`，批次边界使用不可变 `batchId`。同一或近重复录音必须留在同一侧；晋级前必须
   报告 Leave-One-Batch-Out（LOBO）全部批次和最差批次，禁止使用 `category + artist/source` 这类会
   随结果变化的 split 身份。canonical seed=`frkb-rkb-grid-v2`、tune=0.2、holdout=0.2 硬锁，禁止挑 seed 刷 holdout。若 holdout 批次的 isolation family 也出现在其他批次，development 必须
   自动剔除对应实例，并公开剔除数量。
5. 不再把“零 `pass -> fail`”当绝对门槛。每次仍必须完整报告逐曲迁移，但晋级看全量净收益、
   `fail -> pass` 与 `pass -> fail` 比例、LOBO 最差批次、BPM 大错率和灾难性回归；不能为了守住
   每一首旧 pass 而继续堆只服务旧样本的窄 guard。
6. scorer 只能使用通用音频信号特征和候选自洽特征；禁止读取或间接编码歌名、artist、路径、
   playlist 来源、truth、benchmark 误差、pass/fail、失败类型标签、split 身份或逐曲规则。
7. 失败样本只用于聚类、候选覆盖分析和泛化验证；禁止维护逐曲 offset、逐曲 phase、逐曲规则，
   也禁止继续新增只服务当前失败清单的 `rescue` / `arbitration` 分支。
8. topN、source、小模型、front-edge / leading-edge / onset-foot / rising-edge 等信号只能作为
   诊断、特征发现或 locked hypothesis；没有新的 phase 语义证据和 fresh sealed 复验前，不能作为
   独立 production selector、bonus、hard guard 或全局 phase shift。
9. 主线优化目标是“多候选生成 + 统一 scorer”：先确认正确 grid 是否进入候选池，再解决 scorer
   为什么没选中。继续堆小型 if、阈值补丁或来源优先级，不算算法进步。
10. confidence 只允许决定机器是否自动追加完整歌曲、多窗口或高分辨率二次分析；低置信样本仍在
    全量准确率分母里，禁止通过送人工或剔除低置信样本抬高指标。
11. 历史 train / tune / holdout 和 LOBO 全部是 consumed 内部开发视图。禁止根据任一 holdout、LOBO
    holdout 或 fresh 曝光结果反复调参后，再把同一份数据称为未触碰证据；最终晋级必须由下一批
    `prepare` 前锁死候选的一次性 fresh evaluate 单独证明。

## 2. 本地固定文件

`grid-analysis-lab/rkb-rekordbox-benchmark/` 在本机只保留这些长期有用产物：

- `intake-current-truth.json`：新样本 Rekordbox truth 暂存队列。
- `rekordbox-current-truth.json`：唯一长期 Rekordbox truth 源。
- `frkb-current-latest.json`：当前算法对主 truth 的全量 benchmark，固定覆盖。
- `frkb-classification-current.json`：当前算法分类，决定每首歌属于 `sample` 还是 `grid-failures-current`。
- `sample-regression-latest.json`：从 classification 派生的当前通过集视图，固定覆盖。
- `grid-failures-current-latest.json`：从 classification 派生的当前失败集视图，固定覆盖。
- `grid-failures-current-manifest.json`：当前失败聚类清单，固定覆盖。
- `rkb-dataset-registry.json`：全部 consumed 样本的实例/批次身份源；记录 fileName、assetSha256、exact family/PCM、batchId 和 batchStatus。
- `rkb-dataset-splits-current.json`：固定 instance/isolation-family/batch split 与 LOBO 定义；记录 assignment keys/hashes、isolation policy/scope、近重复和 leakage 统计。
- `rkb-dataset-splits-current-{train,tune,holdout}-truth.json`：与主 split 同一次 canonical CLI 生成；每首含
  `assignmentKey`，顶层 `parentSplit` 锁定主文件 SHA、split roster、registry/truth/seed/policy/assignment hashes；benchmark/feature 消费时必须重验。
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
- `sealed-batches/<batchId>/`：由 `scripts/rkb_sealed_batch.py` 管理的一次性批次目录，保存完整分母、truth、manifest、`dataset-lock.json`、benchmark 和状态迁移；evaluate 前重验 registry/音频 SHA，禁止手工复制或覆盖另一个批次的产物。

这些文件只表达当前本机样本库状态；固定清单不写死数量，数量变更统一维护在下面的
当前状态快照中。快照只代表最新状态，更新时直接改写当前值，不追加历史流水账。

不保留 `*.progress.json`、临时 shard 目录、`targeted-*`、`try-*`、`diag-*`、
随手命名的 `after-*`、以及任何未在本节列出的 benchmark JSON。需要复查时重新跑。

## 2.1 当前状态快照

数据集：

- 历史 3745 个实例全部 consumed；registry 固定为 `rkb-dataset-registry.json`，实例键是 `batchId + assetSha256`
- 当前 v4：3735 exact families、3682 isolation families、7 batches；6 primary + diagnostic-only `new357`
- stable assignment 一次性迁移后 split 为 train 2249、tune 773、holdout 723；`assignmentKey` 不含 policy SHA
- `assignmentDigestSha256 = d3476f1551aa4c904e98e56d92ea30ed95b076c0e0272060e7ed79c8ece2909d`；`splitAssignmentsSha256 = 1b4289f908dfe031eb60ac53227ff5fe06de37cc4c072121a597a3ecd24f529f`
- isolation policy SHA-256 为 `e7e52a9df88ea17686bb7825c9ab017edbdf459dfe0a110cc65c2c5b1185be98`；8135 个 candidate 接受 54 条近重复链接
- `leaveOneBatchOut` 的无泄漏 membership 由 nested LOBO runner 消费；runner 仅支持 fixed/no-fit 候选，六个 primary
  selection lock 必须先冻结，`new357` 只可 diagnostic replay。未完成统一 feature cache 前仍不得声称已有 LOBO 成绩。
- `new357` 是 current DB recovered reference，只允许 diagnostic；强身份 cache 当前仅 2 首，剩余 355 首强制重算前禁止全量可靠 replay
- fresh 批次状态：无；下一批只允许由 `scripts/rkb_sealed_batch.py prepare` 建立并锁定
- 唯一长期 truth：`grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-current-truth.json`
- 当前 truth 曲目数：1407
- intake 状态：空
- 当前 benchmark 曲目数：1407
- 当前 benchmark error：0
- 历史 current-only split（consumed diagnostic）：train 829，tune 290，holdout 288
- 当前验收容差：5ms
- 历史 blind intake：609 首原始曲目，其中 608 首已归档为 blind truth，1 首因已在主 truth 中跳过
- blind truth：608 首，音频 608 个，MP3 512 个，FLAC 96 个
- blind truth 位置：`grid-analysis-lab/rkb-rekordbox-benchmark/blind-rekordbox-truth/`
- blind truth 状态：已归档，未合入主 truth；baseline 已跑，已生成固定 split，禁止无 split 调参
- 历史 blind-only split（consumed diagnostic）：train 334，tune 146，holdout 128
- latest consumed `test353` 批次：Rekordbox playlist 有效 353 首；音频已归档到
  `<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-eval`，truth、feature-cache 和 production benchmark 已生成。
- latest consumed `test353` 状态：已被 rank1 negative legacy score v1/v2 与
  rank1 high structural score v1 开发回归消耗，不再是 sealed。
- previous sealed-intake `test327` 批次：327 首，已被 head near-zero、rank1 negative legacy score v2
  和 rank1 octave-down 开发回归消耗，只作为普通回归素材。
- previous sealed-intake `test316` 批次：316 首，已被 rank1 octave-down 开发回归消耗，
  只作为普通回归素材。
- previous sealed-intake `test-new-357` 批次：357 首，已被 v3 / structural phase v2 开发回归消耗；
  当前 truth 是 recovered reference，只作为 diagnostic-only 回归素材，不进入 primary aggregate。
- old consumed sealed-eval 归档：已消耗 sealed/test 回归音频长期放在
  `<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-eval`；按历史批次实例数应为 1414 首，只作为普通回归素材。
- 临时 benchmark progress 文件：不作为长期状态，存在时只视为可复跑的中间产物

当前主 truth 已维护 benchmark 文件（`constant-grid-dp` + locked ranker + integer BPM snap + rank1 material legacy weakness v3 + rank1 structural phase v2 + rank1 high structural score v1 + rank1 negative legacy score v2 + head near-zero + rank1 octave-down）：

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

当前代码另已接入 `locked-phase-downbeat-ordinal-v1`。六个完整 consumed 批次的 targeted replay 共
65 个 locked 触发点，得到 12 个 `fail -> pass`、0 个 `pass -> fail`；其中 current 23 个触发点救回
3 首，因其余路径不变，可确定代码口径为 `979 / 1407 = 69.58%`、downbeat `66 -> 63`。但
`frkb-current-latest.json`、classification 和旧维护 benchmark 尚未全量刷新，以上 976 数字仍是当前
已维护文件口径。这些 replay 全部来自 consumed 数据，只能作为 development regression，不能宣称 fresh 提升。

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

new357 diagnostic selected（已消耗批次；current DB recovered reference）：

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

FRKB-5 正式开发音乐库根目录由 `.env` 的 `FRKB_BENCHMARK_DATABASE_ROOT` /
`FRKB_DEV_DATABASE_URL` 决定。D 到 G 的文件迁移已完成：G 盘音频实例按 current 1407、blind 608、
历史 sealed 1414、test316 316 闭合为 3745，SQLite `quick_check` 通过。`.env` 已切到
`D:/FRKB_database-E`；中央 registry/baseline 已完成 7 批 / 3745 首初始化，唯一身份计数为
asset 3745、PCM 3737、Chromaprint family 3735。

权威库已通过 relocation sidecar 从 G 迁到 D，禁止直接改 sealed manifest。完整的 G 到 D 复制、全量 SHA
验证、registry/split/truth/cache 重建顺序见
[`rkb-database-root-relocation.md`](rkb-database-root-relocation.md)。G 原库目前仅作为已验证回滚副本保留。
音乐库中长期保留 5 个可见音频歌单，
另有 1 个固定临时入口：

- `<FRKB_DATABASE_ROOT>/library/FilterLibrary/new`：主 current 新样本入口，当前目标数量 0。
- `<FRKB_DATABASE_ROOT>/library/FilterLibrary/sample`：current pass 样本，当前目标数量 976。
- `<FRKB_DATABASE_ROOT>/library/FilterLibrary/grid-failures-current`：current 非 pass / error 样本，
  当前目标数量 431。
- `<FRKB_DATABASE_ROOT>/library/FilterLibrary/blind-rekordbox-truth`：blind truth 音频归档，608 首。
- `<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-eval`：old consumed sealed/test 回归音频归档，
  按 `377 + 357 + 327 + 353` 的历史批次实例数为 1414 首；G 盘顶层实测 1412 首，另有两个
  同名不同音频版本保存在 `_conflicts/sealed-intake-20260610`，必须按精确 `filePath` 归属批次。
- `<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-intake`：latest test316 已消耗批次历史上曾在此处；
  316 首现已归档到 `sealed-eval/test316`。当前 intake 音频为 0，可作为下一批 fresh sealed 的固定
  临时入口；目录内 `.frkb.uuid` 是资料库节点身份标记，必须保留，统一入口会忽略该元数据文件。

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

fresh sealed 的目标不是现场涨分，而是验证 `prepare` 前锁死的候选版本是否原样泛化。候选可以是
当前 production，也可以是完成 consumed 全量回放和 nested LOBO runner 验证的 selector/scorer V2；两者都必须锁住
代码、模型、特征、阈值和晋级标准，并记录 frozen 全量 pass rate、error、candidate oracle、
scorer missed、迁移、BPM 大错率、downbeat 和 confidence 分布。任何 topN、阈值或 guard 扫描都只能
发生在 consumed 开发数据上，不允许在同一批 fresh 曝光后转成 production 修改并再次验收。

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
  下一批 fresh sealed 上按原样 replay，且不能再改阈值、改特征或改筛选口径。

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

FRKB-5 使用的音频统一放在 `<FRKB_DATABASE_ROOT>/library/FilterLibrary/`。稳定状态下只保留
5 个长期音频歌单，另有 1 个固定临时入口：

```text
<FRKB_DATABASE_ROOT>/library/FilterLibrary/new
<FRKB_DATABASE_ROOT>/library/FilterLibrary/sample
<FRKB_DATABASE_ROOT>/library/FilterLibrary/grid-failures-current
<FRKB_DATABASE_ROOT>/library/FilterLibrary/blind-rekordbox-truth
<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-eval/<batchId>
<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-intake/<batchId>
```

目录语义：

- `new`：由脚本从 Rekordbox `test` 曲目源路径复制出来的新样本暂存区。
- `sample`：当前 classification = `pass` 的音频。
- `grid-failures-current`：当前 classification != `pass` 或 benchmark error 的音频。
- `blind-rekordbox-truth`：独立 blind truth 音频归档，不进入主 truth，不参与无 split 调参。
- `sealed-eval/<batchId>`：已经曝光并失去 sealed 身份的 consumed 回归音频归档，不再用于现场调阈值。
- `sealed-intake/<batchId>`：由 `scripts/rkb_sealed_batch.py prepare` 创建的 fresh 临时目录；禁止手工
  混入另一个批次。`finalize` 后按 batch 归档，入口恢复为空闲状态。

current 主样本只在 `new` / `sample` / `grid-failures-current` 三个目录中流转。同一首 current
样本不能同时存在于多个 current 目录。目录是 classification 的派生状态，不是真值来源。

blind 与 sealed 是数据集隔离边界，不是 current 分类目录。禁止把 blind/sealed 音频混入
`new`、`sample` 或 `grid-failures-current`，也禁止按批次无限增加 `sealed-eval-YYYYMMDD`
这类长期歌单；批次身份由 truth / manifest 记录。

## 4. 新样本闭环

用户人工流程保持不变：

```text
Upan -> test -> needReview -> review
```

变化只发生在内部顺序：完整 `test` 批次必须在差异分拣前冻结，后续移动到 `needReview` 的歌曲仍然
属于同一 benchmark 分母。

1. 如果本轮源歌单是 `Upan`，先运行 `scripts/move_upan_non_integer_bpm_tracks.py` 做源头清理；
   该脚本默认 dry-run，确认后加 `--apply` 写回，不删除音频文件。清理顺序固定为：先从
   `Upan` 直接移除已注册 consumed 重复曲目和源歌单内部重复多余项，再把剩余曲目里 UI BPM
   列显示为非整数的曲目移动到 `upanNonIntegerBpm` 人工筛查歌单。
2. 把待处理歌曲加入或移动到 Rekordbox `test` playlist。歌单名可以长期复用；fresh 身份由
   `batchId`、音频/PCM 身份和 registry 判定，不由 playlist 名称判定。
3. 如果歌曲是新导入 Rekordbox 的音频，必须等 Rekordbox 完成分析；来自 `Upan` 且 bridge 已能
   读到 `bpm` / grid 的曲目不需要重复等待。算法曝光前只允许按音频缺失、Rekordbox 无 grid 等
   与 FRKB 输出无关的客观原因剔除，并把原因写进 manifest。
4. 运行 `scripts/rkb_sealed_batch.py prepare --playlist test`。它必须在任何 FRKB 差异 dry-run 前，
   一次性冻结完整音频、truth、曲目分母、`batchId`、稳定 `familyId` 以及代码/模型/特征/阈值
   lock hash；并用同一 audio isolation policy 排除与 consumed registry 的近重复录音及 fresh 批内重复，
   将命中和匹配实例写入 manifest audit。缺身份或 guard 失败必须 fail closed。
5. 对候选 production 运行一次 `scripts/rkb_sealed_batch.py evaluate --batch latest`。第一次完整算法
   曝光结束后，该批立即从 fresh 转为 exposed/consumed；成功结果禁止重跑，只有中断且 lock hash
   完全相同时才允许 `--resume`。
6. 使用 `scripts/rkb_sealed_batch.py finalize --batch latest --decision eligible|reject|consume` 记录决策并
   归档。`eligible` 必须自动通过 prepare 时锁死的 acceptance policy，只表示候选具备晋级资格，
   不直接执行 production promotion。无论哪种 decision，该批都已经 consumed；下一版本必须由下一批
   从未曝光的歌曲证明。
7. finalize 完成后，继续按原流程把差异曲目移动到 `needReview` 并 review。内部必须先生成完整
   triage dry-run 报告，再使用同一报告 `--from-report ... --apply`；禁止直接 `--apply` 重新分析后写回。
   这个动作只整理 Rekordbox 歌单，不删除 frozen manifest 中的歌曲。若 review 后修改了 Rekordbox
   truth，修正后的数据进入开发集，不能用同一批重跑证明提升。
8. 需要并入长期开发集时，再由统一入口重建 registry，并按现有 current truth / classification 流程
   生成开发视图。baseline 已初始化后永久禁用 `import-consumed`；新数据只能走 fresh lifecycle，
   finalize 后 `rebuild-registry`。truth 入库后只更新 benchmark、classification 和派生视图。

日常仍可沿用原来的一键命令；`--then-triage` 内部会强制执行
`move -> prepare -> evaluate -> finalize consume -> triage`，任一 sealed 步骤失败都会阻止 triage：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/prep_move_tracks_between_playlists.py" `
  --source "Upan" --target "test" --limit 500 --apply --then-triage --triage-apply
```

wrapper 必须读取 prepare 返回的真实 `batchId`，并原样传给 evaluate/finalize/triage。直接对 `test` 运行
`move_rekordbox_playlist_grid_diffs.py` dry-run 时，必须传 finalize 后的 `--sealed-batch-id`；实际写回只允许
`--from-report <同一次dry-run报告> --apply`。sealed triage 会要求
现场完整 playlist 与 frozen truth/audio roster 精确相等，并逐首核对 asset SHA-256 和 consumed registry；
禁止用 `--only` / `--limit` 隐藏额外 fresh 曲目。只有明确维护已 consumed 数据时才允许同时传
`--consumed-maintenance --consumed-batch-id <明确批次ID>`；该模式同样逐首绑定 consumed truth、manifest
audio roster 和中央 registry，不能再只凭“没有 active batch”放行。两种模式互斥；任何
fresh/evaluating/exposed 批次存在时，sealed triage 和 maintenance 都必须拒绝。报告同时锁定目标歌单、
target parent id 与 move/copy，apply 参数变化必须重新 dry-run。

## 4.1 Blind truth 闭环

blind truth 与新增主样本闭环分开处理：

1. 从 Rekordbox `test` playlist 读取人工确认过的正确曲目。
2. 跳过已经存在于主 truth 的重复曲目。
3. 把剩余音频复制到 `<FRKB_DATABASE_ROOT>/library/FilterLibrary/blind-rekordbox-truth/`。
4. 抓取 Rekordbox grid 到 `blind-rekordbox-truth/rekordbox-blind-truth.json`。
5. 生成 `blind-rekordbox-truth/rekordbox-blind-truth.m3u8` 作为项目内 blind 歌单。
6. 生成 `blind-rekordbox-truth/manifest.json`，记录数量、哈希、路径和隔离规则。
7. 运行一致性校验，确保 truth 曲目与 audio 文件一一对应。
8. 历史上冻结当前算法后跑过 blind baseline；第一次结果只汇报、不现场调参的职责已经完成。
9. baseline 跑完后生成过固定 split：train 334，tune 146，holdout 128；这些 split 现在都属于
   consumed 开发证据；当前统一使用 registry 的 `assignmentKey` / `isolationFamilyId` / `batchId` split。

blind truth 不进入 `intake-current-truth.json`，不合并到 `rekordbox-current-truth.json`。
第一次 baseline 已经完成，这批数据后续只能作为 consumed 开发数据使用。可以参与 audio-isolation-family-safe
交叉验证和 LOBO，但不能把旧 holdout、blind 全量或任何重新切分的子集包装成 fresh proof。

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

1. 先让 `scripts/build_rkb_rekordbox_dataset_splits.py` 从
   `grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-registry.json` 生成固定 split，再调算法；
   实例主键固定为 `batchId + assetSha256`，默认严格拒绝缺失 exact `familyId`（或可验证 PCM hash）、
   Chromaprint identity、`batchId` / `assetSha256` 的样本，也拒绝任何 `batchStatus != consumed` 的
   fresh/evaluating/exposed 记录进入 development split。
2. split 先运行固定纯音频 isolation policy，将 exact family 和经 Chromaprint 时移对齐确认的近重复
   录音合成 `isolationFamilyId`，再按 isolation family 和 batch 边界生成。禁止再用会随 benchmark
   结果变化的失败类型、category、artist/source 拼 split。除 train/tune 外，必须输出
   Leave-One-Batch-Out 的全部批次和最差批次结果；只有 exact-family split 时不得宣称防泄漏完成。
3. 先实现候选 dump 和 scorer 特征 dump，确认正确候选是否进入候选池。
4. 再调 scorer。历史 3745 个样本全部是 consumed，只能用于开发训练、交叉验证和 LOBO；内部
   holdout 可以否决候选，不能给候选恢复 fresh 身份。fresh proof 只能来自锁死模型后的下一批
   一次性 evaluate。
5. 对全部 consumed 数据用同一 solver 版本跑统一 benchmark，重建 classification 和派生视图；
   禁止把不同历史 solver 版本的批次结果直接相加冒充当前全量基线。
6. 固定输出分类迁移、`pass -> fail`、`fail -> pass`、BPM 大错率、phase 误差分布、
   downbeat 回归、候选命中率和 scorer 排名错误。
7. 不设零 `pass -> fail` 绝对门槛；晋级必须提前写死全量净收益、迁移比例、LOBO 最差批、
   BPM 大错率和灾难性回归阈值。任何单曲回归仍要进入报告，但不能据此反向补逐曲 guard。
8. 只有多数 LOBO 批次同向、最差批次不崩、全量净收益达标且 fresh 一次性验收通过的机制才允许晋级。

当前 `build_rkb_rekordbox_dataset_splits.py` 只产出 LOBO outer/inner membership、隔离剔除和 hash，尚未实现
自动 nested train/tune/evaluate runner。因此“多数批次同向/最差批次”是晋级门槛，不是当前已取得的模型成绩。

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
但它仍然不是 fresh evidence；生产合并前必须跑下一批 fresh sealed。

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
- `scripts/build_rkb_rekordbox_dataset_splits.py` 默认读取 `rkb-dataset-registry.json`，以
  `batchId + assetSha256` 识别实例，并通过 `scripts/rkb_audio_isolation_families.py` 的固定纯音频 policy
  按 `isolationFamilyId` 成组、`assignmentKey` 落点，生成 train/tune 和 LOBO membership；缺失身份或
  `batchStatus != consumed` 时严格失败。
- 历史同 isolation family 跨批时不能把另一批副本留在 LOBO development；脚本必须写出
  `excludedDevelopmentIsolationFamilyLeakage`，让这类剔除可审计。

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
- 把移动到 `needReview`、低置信或人工修改过 truth 的歌曲从 frozen benchmark 分母中删除。
- fresh 首次完整曝光后继续保留 fresh 标记，或用新阈值/新模型在同一批上重跑并宣称泛化提升。
- 让 scorer 读取 truth、误差、pass/fail、失败类型标签或候选来源名称来做决策。

没有歌名特判不代表没有过拟合。高维组合如果只服务极少数样本，也视为过拟合风险。
文件/PCM hash、fingerprint 和 `familyId` 只允许用于 registry 去重、family 分组和 split 隔离，
禁止作为 analyzer/scorer 输入或生产决策信号。

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

晋级报告必须使用 frozen manifest 的全量曲目作为分母，并同时给出 consumed 全量净收益、
LOBO 各批次/最差批次、`fail -> pass` 与 `pass -> fail`、BPM 大错率和灾难性回归。confidence
分层只能作为诊断，低置信曲目不能移出分母；零 `pass -> fail` 不是绝对晋级条件。

## 11. 命令

fresh sealed 的音频复制、truth 捕获、lock manifest、feature cache、benchmark 和归档统一由
`scripts/rkb_sealed_batch.py` 编排。禁止从本节复制底层脚本重新拼一条旁路；参数变化以
`scripts/rkb_sealed_batch.py --help` 为准。

Rekordbox 歌单可以继续使用 `test`。下列 `import-consumed -> initialize-registry` 仅记录首次历史迁移；
当前 baseline 已建立，`import-consumed` 会被硬拒绝，后续新数据只能走 sealed fresh lifecycle。

old377 不得把约 480MB benchmark 整份复制进 manifest；先流式提取其中内嵌的历史 truth。new357
固定 truth 已被后续批次覆盖，只能生成“当前 Rekordbox DB 恢复参考”，用于 consumed registry bootstrap
和带警告的开发标签，禁止把它包装成历史 frozen snapshot 或 fresh proof：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/extract_rkb_consumed_truth.py" `
  --audio-root "<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-eval" `
  --output "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/rekordbox-consumed-truth-old377.json"

& "vendor/rekordbox-desktop-runtime/win32-x64/python/python.exe" "scripts/recover_rkb_new357_truth.py" `
  --sealed-root "<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-eval" `
  --output "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/rekordbox-consumed-reference-new357.json"
```

两条工具默认都是只读 dry-run；只有显式 `--output` 才在仓库内新建文件，并拒绝覆盖已有输出。

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" import-consumed --batch-id "<历史批次ID>" --truth "<truth.json>" --audio-root "<音频目录>"
# 所有历史批次导入完成后只初始化一次：
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" initialize-registry `
  --expected-track-count 3745 `
  --expected-batch "current1407=1407" `
  --expected-batch "blind608=608" `
  --expected-batch "old377=377" `
  --expected-batch "new357=357" `
  --expected-batch "test327=327" `
  --expected-batch "test353=353" `
  --expected-batch "test316=316"
```

`initialize-registry` 必须校验数量、`familyId` / PCM identity 和 `batchId`；baseline 创建后禁止继续
`import-consumed`。finalize 后只用 `rebuild-registry` 重建派生视图；如 registry 同目录存在
`rkb-dataset-root-remap.json`，rebuild 会强制使用它并全量验证目标音频 SHA，禁止手工改 `sourcePath`。
身份计算默认由 `--identity-chunk-size 16` 分块，并写入 `audio-identity-cache` 断点。缓存命中仍会重新
计算 asset SHA-256，并校验 size、mtime、helper SHA 与 120 秒参数；U 盘中断时只续未完成块，缓存不是真值来源。
G 盘旧 `.frkb_audio_library_manifest.json` 仍是 registry 建立前的 1916 首历史迁移快照，不再作为当前
根目录、数量或身份依据；当前唯一权威源是 `rkb-dataset-registry.json` 与 baseline。

在任何差异分拣前冻结完整 `test` 批次：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" prepare --playlist "test"
```

`prepare` 默认创建 `sealed-batches/<batchId>/` 和 `sealed-intake/<batchId>`，并锁死代码、模型、
特征、阈值、truth、完整曲目分母和 acceptance policy；同时用 v1 audio isolation guard 排除与
consumed registry 或 fresh 批内的近重复录音，并把排除原因、匹配实例和 policy hash 写进 manifest。
默认 policy 为：

- `--minimum-strict-accuracy = 0.80`
- `--maximum-error-rate = 0`
- `--maximum-bpm-big-error-rate = 0.05`
- `--minimum-candidate-oracle-rate = 0.94`

这些门槛只能在 prepare 前显式调整；写入 immutable manifest 后，evaluate/finalize 阶段禁止修改。
然后只运行一次：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" evaluate --batch latest
```

正常完成后禁止重跑；只有中断且 lock hash 完全相同时才允许追加 `--resume`。第一次完整曝光结束后，
fresh 身份已永久撤销，状态进入 exposed；接着记录模型决策并归档为 consumed：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" finalize --batch latest --decision eligible
# 或：--decision reject / --decision consume，可追加 --note "原因"
```

`eligible` 只有在 prepare 时锁死的 acceptance policy 自动通过后才允许使用；它只表示候选具备
晋级资格，不直接执行 production promotion。三种 decision 都会把批次归档为 consumed；后续根据
本批改出的版本必须由下一批新歌证明。finalize 完成后才能按既定脚本移动到 `needReview` 和 review，
且 frozen 分母不变。

生成 consumed 开发集固定切分和 LOBO 定义：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/build_rkb_rekordbox_dataset_splits.py" --registry "grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-registry.json"
```

canonical CLI 默认同步写主 split + train/tune/holdout truth 四件套；`--no-write-truth-files` 只允许非 canonical
diagnostic 输出。主文件写 assignment hashes，三个 truth 用 `parentSplitFileSha256` / `splitRosterSha256` 等契约绑定主文件且每首带 `assignmentKey`；benchmark/feature 会重验 parent 与 run provenance。canonical 输出还硬锁 seed=`frkb-rkb-grid-v2`、tune/holdout=0.2；协议实验必须改用非 canonical output。`new357` 必须是 diagnostic-only。`leaveOneBatchOut` 目前只定义
membership/hash，没有自动 nested runner，不能把它写成已完成 LOBO 训练或成绩。

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
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" -m py_compile "scripts/beat_this_bridge.py" "scripts/beat_this_candidate_solver.py" "scripts/beat_this_phase_arbitration.py" "scripts/beat_this_phase_rescue.py" "scripts/beat_this_grid_rescue.py" "scripts/beat_this_full_logit_rescue.py" "scripts/beat_this_full_logit_utils.py" "scripts/beat_this_bpm_metrics.py" "scripts/beat_this_window_selection.py" "scripts/benchmark_rkb_rekordbox_truth.py" "scripts/rkb_benchmark_bridge_result.py" "scripts/rkb_benchmark_candidate_oracle.py" "scripts/rkb_benchmark_summary.py" "scripts/capture_rekordbox_playlist_truth.py" "scripts/sync_rekordbox_playlist_audio.py" "scripts/run_parallel_rkb_rekordbox_benchmark.py" "scripts/merge_rekordbox_truth_intake.py" "scripts/build_frkb_current_classification.py" "scripts/build_rkb_rekordbox_dataset_splits.py" "scripts/rkb_audio_isolation_families.py" "scripts/materialize_rkb_feature_cache_by_batch.py" "scripts/sync_frkb_classification_audio_dirs.py" "scripts/rkb_beatgrid_candidate_lab.py" "scripts/rkb_beatgrid_candidate_report.py" "scripts/rkb_beatgrid_feature_cache.py" "scripts/rkb_beatgrid_lab_common.py" "scripts/rkb_constant_grid_dp_cache.py" "scripts/rkb_constant_grid_dp_cli.py" "scripts/rkb_constant_grid_dp_high_structural.py" "scripts/rkb_constant_grid_dp_lab.py" "scripts/rkb_constant_grid_dp_octave.py" "scripts/rkb_constant_grid_dp_phase_path.py" "scripts/rkb_constant_grid_dp_solver.py" "scripts/rkb_hybrid_beatgrid_solver.py" "scripts/run_parallel_rkb_beatgrid_feature_cache.py" "scripts/rkb_phase_semantics_diagnostic.py" "scripts/rkb_phase_trajectory_diagnostic.py" "scripts/rkb_phase_ranker_diagnostic.py" "scripts/rkb_phase_ranker_preregistered_replay.py" "scripts/rkb_phase_ranker_selected_weakness_diagnostic.py" "scripts/rkb_phase_ranker_rising_edge_diagnostic.py" "scripts/rkb_phase_ranker_rising_edge_locked_replay.py" "scripts/rkb_phase_ranker_rising_edge_ablation_diagnostic.py" "scripts/rkb_onset_foot_phase_diagnostic.py"
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

`feature-cache-by-batch/new357/index.json` 当前只有 2 个强身份 entry；旧 355 份名称/大小迁移文件无法证明当前 instanceId，不得计入 cache。
剩余 355 首强制重算并写入身份后，才允许称为 new357 全量 development replay；此前 357 首成绩只能是历史/不可靠诊断。

## 13. 人工复核

这里的人工复核只服务开发阶段的 Rekordbox truth QA、错误归因和模型研究，不是 FRKB 产品流程。
产品运行时的低置信结果必须由机器自动追加二次分析，不能自动送用户处理，也不能移出准确率分母。

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
如果 fresh evaluate 曝光后人工修正了 Rekordbox truth，该批立即按 reject/consume 处理；修正数据可以
进入 consumed 开发集，但禁止重跑同一批并把新分数当 fresh 证明。

## 14. 交接摘要

```text
唯一长期 truth = rekordbox-current-truth.json。
grid-analysis-lab/ 是本地样本分析工作区，不提交 truth、benchmark 或 classification 派生数据；旧的已跟踪 JSON 即使出现在 git status，也不纳入代码提交。
FRKB-5 正式开发音乐库以 `.env` 解析出的 `D:/FRKB_database-E` 为准。G 到 D 的复制、七批
truth/音频唯一映射、中央 registry/baseline 初始化和 relocation sidecar 验证均已完成；baseline 为 7 批 /
3745 首，禁止脚本自行猜盘符或绕过 sidecar 回退到 G。
音乐库长期保留 5 个音频歌单：new、sample、grid-failures-current、blind-rekordbox-truth、sealed-eval；
sealed-intake 是统一入口管理的临时根目录，每批使用独立 batchId 子目录，finalize 后归档。
用户人工流程保持 Upan -> test -> needReview -> review，test 名称可复用；完整批次必须在差异分拣前冻结。
sealed 的 prepare/evaluate/finalize 只走 scripts/rkb_sealed_batch.py；prepare 会排除 consumed/fresh 近重复录音并冻结 dataset-lock，evaluate 重验 registry/sourcePath 音频 SHA，baseline 建立后禁止 import-consumed。
test 直接 triage dry-run 必须带 finalize 后的 sealed-batch-id；仅已 consumed 维护可显式使用 consumed-maintenance + consumed-batch-id。两种模式都要求不存在活动 sealed 批次、playlist 与绑定批次 truth/audio roster 精确相等，并逐首校验 consumed registry asset SHA-256；写回只允许同一报告的 from-report apply，且目标歌单、parent id、move/copy 必须一致。一键 wrapper 会自动透传 prepare 的真实 batchId 和同一 registry。
历史 3745 个样本实例全部 consumed；中央 rkb-dataset-registry.json 必须先完整注册它们，才能开始新 fresh。
实例身份固定为 batchId + assetSha256；组件按 isolationFamilyId，同侧落点按不含 policy SHA 的稳定 assignmentKey；canonical split 四件套用 parent 文件 SHA、roster 与 assignment hashes 绑定，shard resume 还必须匹配 truth/solver/config provenance。
new357 只允许 diagnostic；当前强身份 cache 仅 2 首，剩余 355 首重算前不能报可靠全量 replay。
fresh 第一次完整曝光后立即 consumed；needReview 和低置信歌曲始终留在 frozen 分母中，needReview 不是产品兜底。
已有主 truth 的重复样本会被跳过；新 truth 进入 intake-current-truth.json，确认后合入主 truth 并清空 intake。
FRKB pass/fail 只存在于 frkb-classification-current.json 和派生 latest/manifest。
音频目录由 classification 派生：pass -> sample，其他 -> grid-failures-current。
算法优化只更新 classification，不搬 truth。
当前阶段停止继续堆小型 rescue/prior；analyzer 应重构为多候选生成 + 统一 scorer。
window、full-logit、attack-envelope、global-solver、stream-start/time-basis 都是候选来源。
scorer 只吃通用音频信号特征和候选自洽特征，禁止读取歌名、路径、truth、误差、pass/fail 或失败标签。
每次优化都要固定检查 pass -> fail、fail -> pass、分类迁移、BPM 大错率、phase 分布、downbeat 回归、候选覆盖和 scorer 排名错误。
split 使用 batchId + assetSha256、isolationFamilyId、assignmentKey 和 batchId；nested LOBO runner 已实现，但在
六批 feature-generation policy 统一、六折 selection lock 冻结和 outer evaluation 实际完成前，不得虚报多数/最差批成绩。
晋级最终仍需 LOBO runner 的多数/最差批结果、全量净收益、迁移比例、BPM 大错率和灾难性回归；零 pass -> fail 不是绝对门槛。
允许结构性大改；大改必须由候选覆盖、scorer 排名和失败聚类共同驱动，并通过 consumed 统一回放和下一批 fresh 一次性验收。
踩坑、禁止方向和下一步调优标准统一看 rkb-beatgrid-solver-pitfalls.md。
临时 benchmark 输出用完即删。
修改代码后必须跑 py_compile、相关 benchmark、npx vue-tsc --noEmit。
旧方案输出只能作为候选或对照，不能作为最终选择的兼容地板。
```
