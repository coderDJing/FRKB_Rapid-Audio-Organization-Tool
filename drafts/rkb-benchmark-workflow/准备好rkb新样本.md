# 准备好 RKB 新样本

## 你现在只需要确认一件事

你已经按 [`分拣脚本.md`](./分拣脚本.md) 的手工流程，把本轮 `test` 剩余曲目和 `needReview` 剩余曲目全部放入
`review`，并完成了需要修正的 Rekordbox BPM / grid。满足这一点后，直接艾特本文即可。

当你已经完成一批人工 review，并把这一批的 `test` 全部曲目和 `needReview` 全部曲目都放入
Rekordbox `review` 歌单后，只需艾特本文。无需复制命令或解释盘符、nested LOBO。

## 这句话的固定含义

1. `review` 中含有刚刚完成的一整批样本；它对应最近一次由
   [`分拣脚本.md`](./分拣脚本.md) 生成的预审报告。
2. 人工 review 已完成，Rekordbox 中的 BPM / grid 已按你的结论修正。
3. 当前已有冻结候选
   `28e92006d712a024f4488ddfab5b2a5e5dec12de7a1cb6075402ea21cc9c6207`，所以下一批完整 500 首
   必须优先作为一次性 **fresh validation**，不能先封成 consumed development。
4. `review` 可保留历史曲目；脚本只会取 report 绑定的这一个新批次。

## Codex 的固定动作

1. 只读 preflight：确认 `.env` 指向 `G:/FRKB_database-E`、registry / baseline 完整、没有
   fresh/evaluating/exposed 活动批次，且最近的 pre-review report 完整、无分析错误。
2. 从 report 的完整 500 首 roster 读取 `review`。少一首、多一首、替换音频、或拿错 report 都 fail closed。
   用户后来修正的 Rekordbox BPM / grid 会作为冻结 truth；曲目身份仍必须和分拣时一致。
3. 对当前冻结 v3 运行 fresh prepare：

   ```powershell
   & "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" `
     prepare --playlist "review" --fresh-validation `
     --triage-report "grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-test-need-review-latest.json"
   ```

4. prepare 会锁住完整 roster、truth、音频身份、isolation family、candidate SHA、脚本依赖、四阶段命令链和
   acceptance policy。状态保持 `fresh`，不得读取或预跑 v3 结果。
5. 只运行一次 evaluate：

   ```powershell
   & "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" `
     evaluate --batch "<prepare 返回的 batchId>"
   ```

   evaluate 固定执行：production baseline benchmark → fresh multiscale sidecar → 冻结 v3 selector →
   usable/downbeat 相对验收。曝光后状态立即是 `exposed`，无论通过与否都不能恢复 fresh。
6. 按自动 acceptance 结果 finalize 为 `eligible` 或 `reject`；finalize 后批次归档并成为 consumed。

## 当前 fresh 验收锁定值

- `usableGridNetPassCount >= 1`：500 首至少净救回 1 首；
- `maximumErrorRate = 0`；
- `downbeatFailureRateIncrease <= 0.5%`：500 首净新增最多 2 首；
- `newDownbeatFailureRate <= 0.5%`：500 首原本正确、被新候选改错的 downbeat 最多 2 首；
- `nonOctaveTempoFailureRate = 0`：不允许新增任何非 `0.5x / 1x / 2x` tempo family 错误；
- `candidateUsablePassRate >= 94%`；
- 所有新增/修复 downbeat 与 category migration 必须完整保存在 immutable benchmark，禁止只报互相抵消后的净值。

这些值在 prepare 时写入 immutable manifest。看到 fresh 结果后禁止改口径、模型、feature、mode 或 threshold。

## 防过拟合红线

旧算法分拣只用于减少人工检查量：它不决定哪些歌进入样本，也不影响未来候选是否能用这批做验证。
完整 500 首必须都进入 `review`；一致与不一致只是 QA 路径不同。

当前下一批 500 首先用于冻结 v3 的 fresh validation；evaluate 之前禁止让它参与训练、调参、阈值选择或
验收规则选择。evaluate 曝光并 finalize 后，它才成为 consumed development，可供未来新候选训练。

只有没有待验证的冻结候选、且明确要把本批直接用于开发时，才允许使用
`prepare --playlist review --reviewed-development --triage-report ...`。该模式会直接 consumed，永远不能再
证明使用过本批的候选。不要手工拼 truth / benchmark / registry，也不要把 fresh-validation 和
reviewed-development 混用。

新一批的来源与人工分拣规则见 [`分拣脚本.md`](./分拣脚本.md)。
