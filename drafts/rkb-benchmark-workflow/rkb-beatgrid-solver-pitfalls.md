# RKB Beatgrid Solver 踩坑文档

> 本文只记录长期红线、有效信号和验收原则。当前工作边界见
> [`rkb-beatgrid-current-status.md`](./rkb-beatgrid-current-status.md)，数据与规则证据见
> [`rkb-beatgrid-evidence-ledger.md`](./rkb-beatgrid-evidence-ledger.md)，历史研究过程见
> [`archive/rkb-beatgrid-development-notebook-2026-07.md`](./archive/rkb-beatgrid-development-notebook-2026-07.md)。

## 1. 当前判定口径

- 允许 `0.5x / 1x / 2x` tempo family；先归一化到 truth tempo；
- 归一化后 `firstBeatPhaseAbsErrorMs`、`gridMaxAbsMs`、`bpmOnlyDrift128BeatsMs` 均须 `<= 5ms`；
- exact BPM 只作 diagnostic；非 octave tempo 不允许；
- downbeat 单列验收，不能用 phase / tempo 净增掩盖新增 downbeat 错误。

旧 2ms 口径、旧 split 成绩、70% 目标、目录数量和边界样本阈值都已失效。它们不能用于调参或判断当前
production；如需理解历史，只读 archive notebook 和 raw benchmark，不要把数字复制回本文。

长期判断不变：候选覆盖已经很高，主瓶颈是 selector 能否稳定选中 Rekordbox 风格 phase，不是继续扩大
候选数量。历史批次都已 consumed；`new357` 仅作 diagnostic，不能重新包装成 fresh proof。

## 2. 坑位分级

- **硬坑**：已有明确负向、泄漏或过拟合机制，production 禁止重复。
- **软坑**：不能独立上线，但可作为诊断、特征来源或受控消融继续研究。
- **有效信号**：已有结构性信号，必须锁定假设并通过 fresh sealed 验证才能上线。

### 不要把 topN selector 当生产规则

不能因为 topN 中存在更像 truth 的候选，就按 source、分数、曲名、错误类型或人工观察挑它。历史上无条件
选 top1、扩大 topN、按 source family 切换都不安全。production 只能在预注册、歌曲内可解释的特征下切换
rank1；不允许从 topN 重新挑“最像正确答案”的候选。

### 不要把小模型失败理解成模型路线死亡

旧小模型或阈值扫描失败，通常只说明当时特征、标签或选择流程不可靠。后续可以研究小而可解释的
pairwise / listwise scorer，但必须使用 instance-safe、audio-isolation-family-safe split、nested LOBO 和
fresh 一次性验收；不得从旧 holdout 的结果反推特征或阈值。

### source、文件名和数据身份都不是 solver 特征

- 不得按 candidate source 建立生产优先级或 hard switch；
- `fileName`、artist、title、path、truth、benchmark category、pass/fail、batch / split identity 都不得进入
  solver、ranker 或 selector；
- `instanceId`、familyId、isolationFamilyId、asset / PCM / Chromaprint hash 仅用于身份、近重复隔离、
  split 与 provenance；
- exact `familyId` 不是最终隔离边界，必须用固定纯音频 policy 合并近重复录音为 `isolationFamilyId`。

### 不要绕过 sealed 生命周期

用户流程固定为 `Upan -> test -> needReview -> review`。完整 roster 必须在分拣前锁定；低置信、
`needReview` 和错误歌曲仍留在 frozen 分母。fresh 首次完整曝光后立即失去 fresh 身份；根据结果改出的下一版
必须等待另一批 fresh。禁止绕过 duplicate guard、无 batchId triage 或在 baseline 后 `import-consumed`。

### 不要用固定 shift 掩盖相位错误

`timeBasis`、encoder grouping、文件起点或显示层的统一 shift 都不是 beatgrid 修复。任何新相位证据必须解释
多拍一致性，不能只对齐首个瞬态或单一点；不得用 source、PQTZ、容器 `start_time` 或波形首非零点当普适首拍。

### 不要混淆 beat phase 与 downbeat

beat phase 正确不代表 downbeat 正确。downbeat ordinal / bar offset 的字段语义必须明确，不能把不同 schema
静默按 0，也不能以 phase pass 掩盖 downbeat 回归。

## 3. 可继续研究的信号

front-edge、leading-edge、onset-foot、rising-edge、首段结构和局部 phase path 都是有价值的证据源；它们
不能单独充当 hard guard。研究应回答“为什么这个 phase 正确”，并输出 phase margin、segment agreement、
low-confidence reason，而不是只给一个貌似确定的 grid。

confidence 也必须真实可用：所有歌曲都给最终结果并进入全量分母；低 confidence 只能触发更强的自动分析
（完整歌曲、多窗口、高分辨率 onset/kick 或独立仲裁），不能把任务交给用户，也不能悄悄回退正确候选。

## 4. 验收红线

新实验至少报告：

- registry、代码、模型、特征、阈值与 candidate 的 hash；
- 完整 frozen 分母上的 selected pass、candidate oracle、scorer missed、`fail -> pass`、`pass -> fail`；
- non-octave tempo、phase、downbeat 和运行错误的独立变化；
- `instanceId`、`isolationFamilyId`、`assignmentKey`、parent split 与 provenance；
- 是否使用任何禁止字段。

development 只能使用 `batchStatus=consumed` 的数据。LOBO 必须隔离 outer holdout 的同一
`isolationFamilyId`，并通过既有 runner 生成 macro、最差批次和 exposure provenance。任何 consumed 结果
都只能否决或支持开发假设，不能重新获得 fresh 身份。

fresh `prepare` 前必须锁定候选和 acceptance policy；evaluate 只能一次。fresh 通过只表示 `eligible`，
不直接 promotion；看到结果后改模型、特征、阈值或指标，该批只能 finalize 为 reject / consume。

当前统一 acceptance policy 为：usable-grid 净 pass `>= 1`、error rate `= 0`、downbeat failure 净增和新增
错误率各 `<= 0.5%`、non-octave tempo failure `= 0`、usable candidate oracle `>= 94%`。门槛写入 immutable
manifest 后不得修改。

## 5. 继续工作时先读

- [`rkb-beatgrid-current-status.md`](./rkb-beatgrid-current-status.md)：当前边界与下一步；
- [`rkb-beatgrid-evidence-ledger.md`](./rkb-beatgrid-evidence-ledger.md)：规则、快照与 raw benchmark 入口；
- [`archive/rkb-beatgrid-development-notebook-2026-07.md`](./archive/rkb-beatgrid-development-notebook-2026-07.md)：
  旧 phase selector 与多尺度研究；
- [`rkb-nested-lobo-anti-overfit-contract.md`](./rkb-nested-lobo-anti-overfit-contract.md)：LOBO 防泄漏合同。
