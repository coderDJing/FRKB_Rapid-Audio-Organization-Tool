# RKB Rekordbox Benchmark 文档索引

这个目录收纳 Rekordbox 样本、fresh sealed 验收、nested LOBO 与 beatgrid 策略文档。用户不需要逐个阅读
或艾特；日常只使用下面的唯一入口。

## 用户唯一入口

- [`准备好rkb新样本.md`](./准备好rkb新样本.md)：人工 review 后，用户只艾特本文档；Codex 从
  `review` 的报告绑定完整样本，并按冻结候选状态进入 fresh validation 或 reviewed development。

## Codex 内部参考

- [`分拣脚本.md`](./分拣脚本.md)：
  从 `Upan` 取 500 首，再执行 `test -> needReview -> review` 的人工分拣规则。
- [`rkb-sealed-batch-workflow.md`](./rkb-sealed-batch-workflow.md)：report-bound review 后的
  fresh / reviewed-development 分支、prepare、一次 evaluate 和 finalize 生命周期。
- [`rkb-nested-lobo-runner.md`](./rkb-nested-lobo-runner.md)：准备改算法时的已消费样本筛选与 post-outer
  diagnostic。
- [`rkb-nested-lobo-anti-overfit-contract.md`](./rkb-nested-lobo-anti-overfit-contract.md)：防泄漏与不许借
  historical 样本过拟合的硬约束。
- [`rkb-beatgrid-current-status.md`](./rkb-beatgrid-current-status.md)：当前策略、运行状态与下一次算法工作入口。
- [`rkb-beatgrid-evidence-ledger.md`](./rkb-beatgrid-evidence-ledger.md)：已接入规则、历史 benchmark 和
  frozen research candidate 的证据索引。
- [`rkb-beatgrid-evidence-data-contract.md`](./rkb-beatgrid-evidence-data-contract.md)：truth、音频目录、
  时间轴、5ms 判定、缓存和人工归因的统一语义。
- [`rkb-beatgrid-solver-pitfalls.md`](./rkb-beatgrid-solver-pitfalls.md)：已证伪方向、错误模式与验收红线。
