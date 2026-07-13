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
3. Codex 必须把报告中的整批曲目从 `review` 精确冻结为新的 **consumed development** 批次。
   `review` 可保留历史曲目；脚本只会取报告绑定的这一个新批次。

## Codex 的固定动作

1. 只读 preflight：确认 `.env` 指向 `G:/FRKB_database-E`、registry / baseline 完整、没有
   fresh/evaluating/exposed 活动批次，且最近的 pre-review report 完整、无分析错误。
2. 从 report 的完整 500 首 roster 读取 `review`。少一首、多一首、替换音频、或拿错 report 都 fail closed。
   用户后来修正的 Rekordbox BPM / grid 会作为冻结 truth；曲目身份仍必须和分拣时一致。
3. 运行统一入口：

   ```powershell
   & "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" `
     prepare --playlist "review" --reviewed-development `
     --triage-report "grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-test-need-review-latest.json"
   ```

4. 入口会直接生成 immutable truth / audio roster / Chromaprint / isolationFamilyId、归档音频并更新
   `rkb-dataset-registry.json`。状态直接是 `consumed`，可供以后 nested LOBO 的 development split 使用。

## 防过拟合红线

旧算法分拣只用于减少人工检查量：它不决定哪些歌进入样本，也不影响未来候选是否能用这批做验证。
完整 500 首必须都进入 `review`；一致与不一致只是 QA 路径不同。

本文的入口会把这批显式纳入 development，用于训练/调参。因此在它参与某个候选的训练或选择之后，
不能再用同一批证明**那个候选**提升；这条限制来自训练/调参，不来自分拣。

不要手工拼 truth / benchmark / registry。若未来要验证一个尚未用过本批训练/调参的锁定候选，应另走
fresh prepare/evaluate，而不是先调用本文的 `--reviewed-development` 入口。

新一批的来源与人工分拣规则见 [`分拣脚本.md`](./分拣脚本.md)。
