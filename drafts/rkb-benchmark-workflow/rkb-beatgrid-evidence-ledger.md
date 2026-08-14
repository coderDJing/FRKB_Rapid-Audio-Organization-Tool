# RKB Beatgrid 证据台账

> 本文保存“某个结论凭什么成立”。它不替代 raw benchmark JSON，也不把 consumed 回归说成 fresh proof。
> 当前操作入口见 [`rkb-beatgrid-current-status.md`](./rkb-beatgrid-current-status.md)。

## 证据读取规则

- `current1407`、`blind608`、`old377`、`test316`、`test327`、`test353` 都已 consumed；它们可以用于
  回归、LOBO 和错误归因，不能再证明泛化。
- `new357` 只作 diagnostic：truth 是 recovered reference，且旧 cache 仅 2 首可证明身份。旧的 357 首
  数字保留为历史观察，不可当作当前可复现全量成绩。
- 文中的“快照”是已写出的 benchmark 文件；“定向 replay”只覆盖特定触发点，不能代替全量刷新。
- JSON 是逐曲真值和完整分类的权威记录；本文只保留比较所需的总数、方向和定位入口。

## 当前 benchmark 快照

| 批次 | 快照结果 | candidate oracle | 证据角色 | 主要产物 |
| --- | --- | --- | --- | --- |
| current1407 | `976 / 1407 = 69.37%` | `1353 / 1407 = 96.16%` | consumed 回归 | `grid-analysis-lab/rkb-rekordbox-benchmark/frkb-current-latest.json` |
| blind608 | `436 / 608 = 71.71%` | `599 / 608 = 98.52%` | consumed 回归 | 对应 canonical benchmark / split 产物 |
| test353 | `225 / 353 = 63.74%` | `338 / 353 = 95.75%` | consumed sealed regression | `sealed-eval/frkb-sealed-test353-rank1-negative-v2-octave-down.json` |
| test327 | `218 / 327 = 66.67%` | `316 / 327 = 96.64%` | consumed sealed regression | `sealed-eval/frkb-sealed-test327-rank1-negative-v2-octave-down.json` |
| test316 | `176 / 316 = 55.70%` | `298 / 316 = 94.30%` | consumed sealed regression | `sealed-eval/frkb-sealed-test316-rank1-negative-v2-octave-down.json` |
| new357 | 历史观察为 `231 / 357 = 64.71%` | 历史观察为 `343 / 357 = 96.08%` | diagnostic，当前不可可靠全量复现 | recovered truth / 强身份 cache 需重建 |

`locked-phase-downbeat-ordinal-v1` 的六批定向 replay 覆盖 65 个触发点，合计 `fail -> pass = 12`、
`pass -> fail = 0`；其中 current 为 `976 -> 979 / 1407`，downbeat `66 -> 63`。这是待全量刷新确认的
代码尖端结果，不覆盖上表的文件快照。

## 已接入 production guard 的历史证据

| 规则 | 解决的窄问题 | 历史验证结论 | 不能推出什么 |
| --- | --- | --- | --- |
| locked rising-edge ranker | 有结构性 rising-edge 证据的 rank1 phase | 已接入；旧 consumed replay 显示正向且无已知 `pass -> fail` | 不是 fresh 泛化，不能降低阈值或改 topN selector |
| legacy integer BPM snap | legacy fallback 极接近整数 BPM | 仅在 `<= 0.04 BPM` 的窄区间量化；历史回归无已知伤害 | 不可扩展为普通 BPM 修正 |
| material legacy weakness | legacy 分数低且 rank1 证据强 | 只切换 rank1；代表性修复保留在 pitfalls | 不可从 top16 重新挑选 |
| structural phase / high structural score | rank1 的 phase 证据强、legacy 明显弱 | 历史 consumed 批次有正向改善，未观察到 `pass -> fail` | 阈值均由已见数据形成，仍须 fresh |
| head near-zero | rank1 明显远离音频头部，存在同 BPM / 同 bar 语义的 near-zero candidate | test327 `212 -> 215`；只是一条窄 guard | 不是开放的 top8 selector |
| negative legacy score v2 | legacy score 为负、rank1 同 BPM 且 phase 证据足够 | test353 从 baseline `222` 到最终链路 `225` 的组成部分；v2 收紧了 v1 的非 pass 类型漂移 | 不可只根据负 legacy score 切换 |
| octave-down | rank1 为 legacy 半速且结构证据充分 | test327 / test316 有 half-or-double BPM 到 pass 的修复 | 不可放开为一般 half/double switch |
| locked-phase downbeat ordinal | 同 BPM、跨周期时的 downbeat ordinal 语义 | 六批定向 replay `+12 / -0` | 不改变 BPM、firstBeat、候选排序或 fresh 证据角色 |

详细阈值、代表性反例和禁止扩展方式在 [`rkb-beatgrid-solver-pitfalls.md`](./rkb-beatgrid-solver-pitfalls.md)。
若要核对逐曲变化，直接读取表中 JSON，不在本台账重复曲目名单。

## 研究候选与 runner 证据

| 对象 | 结论 | 可追溯物 | 当前权限 |
| --- | --- | --- | --- |
| fixed/no-fit nested LOBO | 首个六折 study 全部选择 baseline，净增 `0`，aggregate 未通过 | `rkb-primary-nested-lobo-v2-groot` study | runner 已完成；仅否定 `phaseStepMs = 1.0` 候选 |
| multiscale usable-grid v2 replay | corrected usable-grid 口径下仍有真实 phase/downbeat 退化，aggregate 未通过 | 历史 report、`rkb_multiscale_usable_grid_replay.py` | 不得接 production，不得继续扫 v2 threshold |
| multiscale usable-grid v3 | 6/6 fold 正向，净 usable pass `+30 / 3388`，`pass -> fail = 0`；仍有 5 次新增 downbeat 失败 | `scripts/models/rkb-multiscale-usable-grid-candidate-v1.json`，candidate SHA `28e92006d712a024f4488ddfab5b2a5e5dec12de7a1cb6075402ea21cc9c6207` | 已冻结、未接 production；下一批 fresh 只能原样验证 |

多尺度研究为何保留、旧 BPM gate 为什么作废，以及 schema 修复后的含义，见 archive notebook；产品口径、
禁止泄漏字段和 fresh 验收红线以 solver pitfalls 为准。
