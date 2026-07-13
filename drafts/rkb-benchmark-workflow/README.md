# RKB Rekordbox Benchmark 文档索引

这个目录收纳 Rekordbox 样本、fresh sealed 验收、nested LOBO 与 beatgrid 策略文档。用户不需要逐个阅读
或艾特；日常只使用下面的唯一入口。

## 用户唯一入口

- [`准备好rkb新样本.md`](./准备好rkb新样本.md)：人工 review 后，用户只艾特本文档；Codex 从
  `review` 的报告绑定完整样本创建 consumed development batch。

## Codex 内部参考

- [`分拣脚本.md`](./分拣脚本.md)：
  从 `Upan` 取 500 首，再执行 `test -> needReview -> review` 的人工分拣规则。
- [`rkb-nested-lobo-runner.md`](./rkb-nested-lobo-runner.md)：准备改算法时的已消费样本筛选与 post-outer
  diagnostic。
- [`rkb-nested-lobo-anti-overfit-contract.md`](./rkb-nested-lobo-anti-overfit-contract.md)：防泄漏与不许借
  historical 样本过拟合的硬约束。
- [`rkb-beatgrid-next-session-handoff.md`](./rkb-beatgrid-next-session-handoff.md)：当前策略、运行状态与
  下一次算法工作入口。
- [`rkb-beatgrid-solver-pitfalls.md`](./rkb-beatgrid-solver-pitfalls.md)：已证伪方向、错误模式与验收红线。
- [`archive/rkb-database-root-relocation.md`](./archive/rkb-database-root-relocation.md)：历史迁移草案，禁止
  按其中命令执行；当前权威根目录以 `.env` 的 `G:/FRKB_database-E` 为准。
- [`archive/rkb-rekordbox-truth-validation-workflow.md`](./archive/rkb-rekordbox-truth-validation-workflow.md)：
  较完整的历史实现参考，不是用户入口；与 fresh handoff 和 `.env` 冲突时，以现行入口为准。
