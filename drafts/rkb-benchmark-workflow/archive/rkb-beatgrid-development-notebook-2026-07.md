# RKB Beatgrid 开发研究记录（2026-07）

> 这是归档的研究记录，不是当前操作入口，也不能据此改阈值或宣布 fresh 提升。当前状态见
> [`../rkb-beatgrid-current-status.md`](../rkb-beatgrid-current-status.md)，可核对的数字见
> [`../rkb-beatgrid-evidence-ledger.md`](../rkb-beatgrid-evidence-ledger.md)。

## 为什么保留

这轮研究留下了两类不能丢的结论：多尺度频谱确实携带 phase 信号；但早期的评价口径和 truth schema 都有
问题。保留它是为了以后继续做 scorer 时不重复犯错，不是为了把旧数据再次当作验证集。

## 多尺度频谱研究

独立 sidecar 使用 44.1 kHz、10 ms hop 和 `1024 / 2048 / 4096` 三尺度 spectral flux。相关实现为：

- `scripts/rkb_multiscale_spectral.py`
- `scripts/rkb_multiscale_feature_cache.py`
- `scripts/rkb_multiscale_ranker_study.py`
- `scripts/rkb_multiscale_usable_grid_replay.py`
- `scripts/rkb_multiscale_usable_grid_study.py`

第一轮 v1 的宽松阈值在 inner tune 看似有收益，但 outer 出现 pass、BPM 和 downbeat 回归；六折均选择
baseline。随后 v2 只在已消费数据上做 post-hoc 扩展：旧 strict 口径为净 `+5 / 3388`、
`pass -> fail = 3`，但这个 BPM gate 后来被产品口径纠正。

项目现在允许 `0.5x / 1x / 2x` tempo family：倍频归一化后 BPM 漂移、首拍相位和网格最大误差都在 `5 ms`
以内即可；精确 BPM 只作 diagnostic。三倍及其他非 octave tempo 不放行，downbeat 仍是独立 safety gate。

## 关键 schema 修复

回放发现 split catalog 写的是 `barBeatOffset`，旧 adapter 却读取 `downbeatBeatOffset`，导致 3745 首中
536 首非零 downbeat truth 被按 0 比较。此后任何研究都必须规范化这两个字段，且不能沿用旧 row-cache 的
downbeat 结论。

纠正口径后，冻结 v2 仍未通过：macro usable 净增 `+0.202264%`，但最差 fold `-0.611621%`、usable
`pass -> fail = 4`，并有真实 phase/downbeat 退化。结论不是“频谱无用”，而是 v2 不可接 production，
也不应继续在同一 3388 首上扫 threshold。

## v3 冻结候选

以 corrected usable-grid labels 重新训练的 v3 在 consumed development 上得到：

- 六折均正向，净 usable pass `+30 / 3388`，`pass -> fail = 0`；
- macro `+1.0395685%`，最差 fold `+0.3058104%`；
- 最差 downbeat failure 净增 `+0.3289474%`，但仍有 5 次单曲新增 downbeat 失败；
- 冻结候选：`family=multiscale`、`l2=1.0`、`mode=ranked-top16`、`threshold=1.1`；
- candidate SHA-256：`28e92006d712a024f4488ddfab5b2a5e5dec12de7a1cb6075402ea21cc9c6207`；
- tracked runtime candidate：`scripts/models/rkb-multiscale-usable-grid-candidate-v1.json`。

这个候选是看过 v2 后形成的 consumed post-hoc candidate，`productionEligible = false`。它只允许由
fresh sealed 流程原样验证；看到 fresh 结果后不得再改模型、mode 或 threshold。

## 其他已否定的捷径

- 将 locked ranker 阈值从 `0.93` 下调并不安全：历史检查会让
  `Badman Style - Guy Davidov, Nettta M2.wav` 从 pass 变为 downbeat。
- 简单的 half/double BPM switch 不安全，会伤害已通过歌曲；production 中只保留 octave-down 的窄 guard。
- same-BPM / low-legacy high-grid structural 分支曾显示离线收益，但实际 solver 用错 legacy 字段口径，
  没有稳定净增，已回滚。

后续可以研究新的结构性 phase 证据，但必须用当前 usable-grid / downbeat 口径、现有 split 与 nested
LOBO 合同；任何由 consumed 结果形成的候选仍需等待另一批 fresh。

## 早期 phase selector 研究摘要

旧 931 首阶段的 `phase evidence v2` 只带来很小的干净改善：current `684 -> 685`、blind `423 -> 425`。
候选池本身却已经很强，说明瓶颈是 selector 能否稳定识别 Rekordbox 风格 phase，而不是继续扩大候选数量。

- 无条件选择 constant-grid-dp top1 会从 `685 / 931` 降到 `355 / 931`；topN 里“看起来更像 truth”的候选
  不能直接变成 production selector。
- phase trajectory、直接按 rising-edge median 平移、source / legacy 阈值扫描，都没有跨 current、blind 和
  holdout 的稳定收益；这些方向只保留为诊断或已否定捷径。
- onset-foot 与 rising-edge 表明局部 phase 证据有价值，但 post-hoc replay 仍只是 future fresh 待验证假设。
  后续只能构建可解释的 phase evidence，不能靠放宽 confidence、统一 shift 或继续扫描旧 topN。
- 旧 931 首的逐 guard 涨分串、逐曲名单和分批数字已由 raw benchmark JSON 与
  [`../rkb-beatgrid-evidence-ledger.md`](../rkb-beatgrid-evidence-ledger.md) 索引；它们不再留在当前
  操作或踩坑文档中。
