# 偶发 Bug 待复现目录

这个目录用于维护以下问题：

- 无法在当前环境稳定复现；
- 已加入诊断或候选修复，但暂时无法完成真实运行时验收；
- 需要在另一台电脑、特定硬件、冷启动或长时间运行后继续取证；
- 新对话需要直接接手，不能重新从现象猜一遍。

## 状态约定

| 状态 | 含义 |
| --- | --- |
| `待复现` | 已记录现象，证据不足，等待下一次现场 |
| `诊断中` | 已加入诊断日志，等待日志确认具体阶段 |
| `候选修复待验收` | 已改代码，但尚未通过真实复现链路验收 |
| `已确认待清理` | 根因和修复已确认，等待删除临时诊断 |
| `已关闭` | 修复已验收，临时日志已清理，文档保留归档 |
| `持续维护` | 已关闭案例沉淀为交叉验证手册；新现场按台账追加，不代表当前仍有故障 |

## 文档最低要求

每个 Bug 文档至少应包含：

1. 当前状态、首次记录时间和影响版本；
2. 用户可感知现象和已有日志；
3. 已确认事实、未确认猜测和明确排除项；
4. 当前工作区改动及验证结果；
5. 下次复现时需要收集的日志、文件和环境信息；
6. 日志字段判读规则及下一步分支；
7. 临时诊断的保留原因和清理条件；
8. 给下一次对话直接使用的接手指令。

禁止把“高概率嫌疑”写成“已确认根因”。偶发问题没有现场证据时，宁可保留分支，也别瞎拍脑袋。

## 当前问题

| 状态 | 文档 | 简述 |
| --- | --- | --- |
| 候选修复待验收 | [Horizontal Browse pending-play 偶发慢启动](./horizontal-browse-pending-play.md) | 歌曲加载后立即播放偶发等待数秒，需以现场日志区分 decode 覆盖、FFmpeg 启动和 renderer 状态问题 |
| 已解决 | [Windows 大歌单主进程卡顿](./windows-large-playlist-main-process-stall.md) | 无界 FFprobe 创建会阻塞主线程；后台队列、worker thread、并发上限和零偏移版本标记已解决 |
| 持续维护 | [Pioneer Device Library U 盘歌单一致性](./pioneer-device-library-usb-playlist-consistency.md) | PDB 页尾条目截断、OneLibrary 缺歌单和恢复后错序的交叉验证手册 |
| 候选修复待验收 | [双轨联结起播与播放状态恢复维护手册](./dual-track-mix-alignment-long-term-maintenance.md) | 双轨时间基、联结起播、PCM 对齐与快照恢复的长期交叉验证手册 |
| 持续维护 | [双轨 Master Tempo 瞬态稳定与 Keylock 算法长期维护手册](./dual-track-master-tempo-transient-stability.md) | SoundTouch 瞬态漂移、Signalsmith 实验、Mixxx/Rubber Band 路线与免费泛化方案 |
