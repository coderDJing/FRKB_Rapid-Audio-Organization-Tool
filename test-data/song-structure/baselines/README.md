# 段落算法 prediction 快照

这里保存生产算法对固定样本的历史输出，用于版本差异审查。prediction 不是人工真值，禁止因为
某个版本输出“看起来不错”就直接复制到 `tracks/*.truth.json`。

目录按算法版本分组，例如 `v20/<sha256>.prediction.json`。快照必须记录算法版本、Git HEAD、
dirty 状态和生成时间；dirty 快照只说明当时工作树状态，不能声称对应 commit 本身包含该算法。
