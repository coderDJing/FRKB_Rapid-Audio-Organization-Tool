# 段落算法 prediction 快照

这里保存生产算法对固定样本的历史输出，用于版本差异审查。prediction 不是人工真值，禁止因为
某个版本输出“看起来不错”就直接复制到 `tracks/*.truth.json`。

目录按算法版本分组，例如 `v26/<sha256>.prediction.json`。快照必须记录算法版本、Git HEAD、
dirty 状态和生成时间；dirty 快照只说明当时工作树状态，不能声称对应 commit 本身包含该算法。

当前 v26 目录固定保存 manifest 中全部 7 首样本的生产 `native-libav-waveform` 输出，使用原生
四拍网格的 `startDownbeatOrdinal / endDownbeatOrdinal`。旧版本 prediction 仍可能包含历史
`startBar / endBar` 字段，只用于向后对照；新 baseline 禁止继续写旧层级术语。

v26 baseline 是本轮用户审查节点，不等于 7 首人工真值。只有 truth 文件中 `coverage=full` 或
`coverage=partial` 且 `review.status=approved` 的区间才进入准确率分母。
