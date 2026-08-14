# RKB Sealed Batch 完整工作流

> 本文是 `review` 之后的现行内部工作流。用户入口见
> [`准备好rkb新样本.md`](./准备好rkb新样本.md)，前半段人工分拣见
> [`分拣脚本.md`](./分拣脚本.md)。具体命令和字段以 `scripts/rkb_sealed_batch.py --help` 与本批
> `prepare` 写出的 immutable manifest 为准。

## 1. 进入条件

只能接收最近一次 pre-review report 绑定的完整 `review` roster：

- 用户已经把本轮 `test` 与 `needReview` 的剩余曲目全部移入 `review`，并在 Rekordbox 完成必要的 BPM / grid
  修正；
- report、review roster、audio SHA-256 与音频身份完全一致；少曲、多曲、替换音频、分析错误或身份缺失均
  fail closed；
- 从 `.env` 解析权威库；registry / baseline 完整；没有 fresh、evaluating 或 exposed 活动批次；
- `sealed-intake` 除 `.frkb.uuid` 外为空。marker 是资料库节点身份，不能删除。

不满足任一项时停止并报告差异；不得猜测补齐、手工拼 truth 或以目录数量代替身份校验。

## 2. 选择本批用途

先读取 [`rkb-beatgrid-current-status.md`](./rkb-beatgrid-current-status.md)：

- 存在待验证的冻结候选：用 `prepare --playlist review --fresh-validation --triage-report <report>` 建立 fresh；
- 没有冻结候选且明确要把本批直接用于开发：才用
  `prepare --playlist review --reviewed-development --triage-report <report>`；
- 不得因为想尽快训练就把本应 fresh 的完整 roster 直接封成 reviewed development。

两种模式都以 report 绑定整批 roster，而不是按歌单名称、目录或临时筛选猜批次。

## 3. prepare：冻结不可变输入

prepare 必须写入 batchId、完整 truth、audio identity、registry / isolation family、candidate SHA、脚本与模型
依赖、solver 命令链和 acceptance policy。prepare 后：

- fresh 只能做一次锁定 evaluate，任何预跑、重训、扫阈值或改 policy 都不允许；
- reviewed development 直接是 consumed，永远不能证明使用过本批候选的泛化；
- fresh/evaluating/exposed 记录不得进入 development split，也不能改变历史 consumed split。

`dataset-lock.json` 和 manifest 是该批唯一权威；后续所有步骤必须重验其 roster、hash 与 provenance。

## 4. fresh evaluate：只曝光一次

fresh batch 只允许执行一次 `evaluate --batch <batchId>`。evaluate 必须：

1. 按 prepare 锁定的 production baseline、候选、特征与验收规则运行；
2. 保持完整 frozen 分母，低置信、`needReview`、人工待查和错误歌曲都不能删除；
3. 输出 selected、candidate oracle、phase / downbeat / non-octave tempo、分类迁移、运行错误和完整 provenance；
4. 首次完整曝光后立刻永久失去 fresh 身份，状态为 exposed，不能重跑来挑更好结果。

中断只允许在 lock、输入和已有 shard 正文 digest 完全一致时 resume；完整结果存在后禁止覆盖重跑。

## 5. finalize：记录决定并归档

fresh 的 acceptance policy 在 prepare 时冻结。evaluate 后：

- 自动满足 policy 才可 finalize 为 `eligible`；它只表示具备晋级资格，不直接接入 production；
- 未满足则 finalize 为 `reject` 或 `consume`，可附原因；
- 任一 finalize 结果都会把本批归档为 consumed development；根据本批结果改出的下一版必须等待另一批 fresh。

reviewed development 也必须完成其封存 / registry 更新，不能留下活动批次或半写入目录。

## 6. 后续使用边界

- consumed 数据只可用于开发回归、错误归因、split 和 LOBO；不能恢复 fresh 身份；
- 新候选必须在新的 fresh roster prepare 前锁死；
- 不得用低置信、`needReview`、错误类型、artist、文件名、path、truth 或旧 benchmark 结果缩小分母、选择规则
  或声明提升；
- 嵌套 LOBO 的防泄漏细则见
  [`rkb-nested-lobo-anti-overfit-contract.md`](./rkb-nested-lobo-anti-overfit-contract.md)。

## 7. 权威来源

- 用户如何准备批次：[`分拣脚本.md`](./分拣脚本.md) 与 [`准备好rkb新样本.md`](./准备好rkb新样本.md)；
- 当前冻结候选和门槛：[`rkb-beatgrid-current-status.md`](./rkb-beatgrid-current-status.md)；
- 已有规则与 benchmark 证据：[`rkb-beatgrid-evidence-ledger.md`](./rkb-beatgrid-evidence-ledger.md)；
- 命令参数和运行时拒绝条件：`scripts/rkb_sealed_batch.py --help` 与实际 immutable manifest。
