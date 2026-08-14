# 准备好 RKB 新样本

## 你现在只需要确认一件事

你已按 [`分拣脚本.md`](./分拣脚本.md) 完成这一批人工 review：本轮 `test` 和 `needReview` 的剩余曲目都已
进入 Rekordbox `review`，且需要修正的 BPM / grid 已完成修正。满足后直接艾特本文；无需复制命令、说明盘符
或解释 benchmark。

## 这句话的固定含义

1. `review` 中包含刚完成的一整批样本，并能对应最近一次分拣生成的 pre-review report；
2. 人工修正后的 Rekordbox BPM / grid 是本批 truth；
3. `review` 可以保留历史曲目，但本次只取 report 绑定的新 roster；
4. 不允许少曲、多曲、换音频或拿错 report；任一不一致都停止，不猜测补齐。

## Codex 的固定动作

1. 只读 preflight：从 `.env` 解析权威库，确认 registry / baseline 完整、没有活动 sealed 批次，并校验
   report、roster、音频身份和分析结果；
2. 判断《当前状态》中是否有待验证的冻结候选：有则以完整 roster 创建 fresh validation；没有且明确要直接
   纳入开发时，才创建 reviewed development；
3. 通过 `scripts/rkb_sealed_batch.py` 的现行入口执行 prepare、一次 evaluate 和 finalize，不手工拼 truth、
   benchmark 或 registry；
4. prepare 写入 immutable manifest 后，以其中锁定的 candidate、依赖、roster 与 acceptance policy 为准；
5. fresh 一次完整 evaluate 后立即失去 fresh 身份。finalize 后才成为 consumed development；`eligible` 不等于
   自动接入 production。

## 防过拟合红线

旧算法分拣只服务于人工 truth QA，不决定哪些歌进入样本。完整 roster 必须全部进入冻结分母，`needReview`、
低置信和错误歌曲都不能被删除。

若存在待验证冻结候选，本批必须先 fresh validation，禁止先以 reviewed development 消耗 fresh 资格。若没有
冻结候选且明确要直接用于开发，才允许 reviewed development；该批从此永远不能证明使用过它的候选泛化。

当前候选、门槛和下一步见 [`rkb-beatgrid-current-status.md`](./rkb-beatgrid-current-status.md)。
完整的 prepare、evaluate、finalize 生命周期见
[`rkb-sealed-batch-workflow.md`](./rkb-sealed-batch-workflow.md)。
