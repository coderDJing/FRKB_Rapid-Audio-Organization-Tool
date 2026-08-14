# RKB Beatgrid 当前状态

> 这是当前工作的短入口，不是实验流水账。规则为什么存在、历史成绩和研究结论分别见
> [`rkb-beatgrid-evidence-ledger.md`](./rkb-beatgrid-evidence-ledger.md)、
> [`rkb-beatgrid-solver-pitfalls.md`](./rkb-beatgrid-solver-pitfalls.md) 和
> [`archive/rkb-beatgrid-development-notebook-2026-07.md`](./archive/rkb-beatgrid-development-notebook-2026-07.md)。

## 现在处于什么状态

- 历史 `3745` 个样本实例都已是 consumed development。`new357` 是 current DB recovered reference，
  只能作 diagnostic；其现有 cache 只有 2 首强身份条目，不能将旧的 357 首重放数字当作可靠全量结果。
- registry、audio-isolation split v4 和 fixed/no-fit nested LOBO runner 都已完成。首个六折 study 中所有
  fold 都选择 baseline，故该 `phaseStepMs = 1.0` 候选未通过；这不否定其他新 scorer。
- 现生产 baseline 由 `constant-grid-dp` 的 locked rising-edge ranker、legacy integer BPM snap、
  material legacy weakness、structural phase、high structural score、negative legacy score、head near-zero
  和 octave-down 窄 guard 组成。每项适用条件和历史证据见 evidence ledger；不得自行放宽阈值或改成 topN
  挑选。
- 多尺度 usable-grid v3 候选已在 consumed 数据上冻结，尚未接入 production；它只能原样进入下一批 fresh
  validation，不能继续在旧数据上调模型、模式或阈值。

## 当前冻结候选与 fresh 门槛

- 当前冻结候选 SHA-256：`28e92006d712a024f4488ddfab5b2a5e5dec12de7a1cb6075402ea21cc9c6207`；
  它是 consumed post-hoc candidate，未接 production。
- 下一批完整 review roster 必须优先用于它的 fresh validation；`prepare` 时锁定完整 roster、音频身份、
  candidate、依赖和 acceptance policy，之后不得改动。
- 当前 policy 要求 usable-grid 净 pass `>= 1`、error rate `= 0`、downbeat failure 净增及新增错误率各
  `<= 0.5%`、non-octave tempo failure `= 0`、candidate usable pass rate `>= 94%`。

真正执行时以 `prepare` 写入的 immutable manifest 为准：它是该批唯一有效的候选和门槛快照。

## 当前数字怎样读

落盘 benchmark 快照与代码尖端的定向 replay 必须分开说：

- 已维护的 `frkb-current-latest.json` 快照是 `976 / 1407`；
- `locked-phase-downbeat-ordinal-v1` 的六批定向 replay 推得 current 为 `979 / 1407`，但完整 benchmark 和
  classification 尚未刷新。

所以 `979` 是待全量刷新验证的代码尖端结果，不能替代 `976` 被写成“当前已维护 benchmark”。其他批次的
快照、产物路径和证据角色统一见 evidence ledger。

## 接下来只该做什么

1. 若有一批从未参与候选开发的新歌，按 [`分拣脚本.md`](./分拣脚本.md) 和
   [`准备好rkb新样本.md`](./准备好rkb新样本.md) 的现行入口创建 fresh validation；prepare 前锁死候选和门槛，
   evaluate 只允许一次。
2. fresh 通过只代表候选有晋级资格，不直接改 production；fresh 失败或曝光后形成的下一版本必须等下一批
   fresh。
3. 没有 fresh 时，只能在 consumed 数据上研究新的、能解释 phase 的结构性证据，并明确标为 development
   diagnostic。

## 不要在这里复制的规则

- 样本移动、prepare / evaluate / finalize 的命令与参数：以两个入口文档和 `scripts/rkb_sealed_batch.py --help`
  为准。
- nested LOBO 的运行方式与防泄漏合同：见
  [`rkb-nested-lobo-runner.md`](./rkb-nested-lobo-runner.md) 和
  [`rkb-nested-lobo-anti-overfit-contract.md`](./rkb-nested-lobo-anti-overfit-contract.md)。
- 已证伪路线、禁止字段、phase / downbeat 语义和验收红线：见 solver pitfalls。
