# 双轨联结起播与播放状态恢复维护手册

状态：启动相位问题已完成真实试听验收；快照空窗误恢复候选待现场复测

首次记录：2026-08-07

影响范围：双轨联结起播、BeatSync、Rekordbox 网格、FFmpeg 解码 PCM、播放状态快照与自动恢复。

Master Tempo / Keylock 处理后的实际瞬态质量由
[双轨 Master Tempo 瞬态稳定与 Keylock 算法长期维护手册](./dual-track-master-tempo-transient-stability.md)
负责；本文不把处理器内部的 WSOLA / Rubber Band 质量问题混入联结时间基问题。

## 1. 这篇文档要保护什么

双轨问题不能只看 UI 网格线，也不能看到两个 ffprobe 字段相同就直接相加或删除偏移。必须同时保护：

1. Rekordbox timeline 上的网格时间；
2. decoded PCM 的真实起点与 `timeBasisOffsetMs`；
3. Master Tempo 处理器的 audio playhead；
4. renderer / native snapshot 的投递活性；
5. 自动恢复是否真的有证据表明音频引擎停止。

前两项、游标帧数或 UI 自洽都不能单独证明人耳听感通过。

## 2. 已确认的时间基边界

同一现场中，两首歌的 `stream.start_time` 都为 `25.057ms`，但 LAME 文件还有 `1105` samples 的 Skip Samples，
因此按现行契约得到 `50.114ms`。对实际 decoded PCM 和 Rekordbox 网格做 onset 核对后，LAME 与非 LAME 文件
的时间轴差异约 `24.2ms`，目前不能据此删除 LAME gapless 补偿。

固定规则：

- `firstBeatMs` 是 Rekordbox timeline 时间戳，不是第一个声音的位置；
- `timelineSec = audioSec + timeBasisOffsetSec`；
- 不得把 decoder skip、容器 timestamp、Rekordbox timeline 和处理器延迟混成一个常数；
- 未经同曲 PCM benchmark、网格首拍和现场试听共同确认，不得改
  `shouldApplyLameGaplessSkipOffset` 或把所有 MP3 归一到 `stream.start_time`。

### 已关闭案例：DHEA / VERMILLION 的固定 25ms 错位

DHEA（134 BPM MP3）的 Rekordbox 网格首拍为 `0.426807s`，其正确
`timeBasisOffsetMs` 为 `25.057ms`。该字段曾在目录扫描从缓存继承分析结果时被遗漏，随后扫描把
`null` 回写到 SQLite；renderer 和 native transport 又将缺失值按 `0` 参与同步。结果是网格数学仍然自洽，
但 DHEA 的真实 PCM 首拍提前约 `25.057ms`，与 VERMILLION（135 BPM）叠放时出现明显跑马。

已修复：扫描必须一并继承 `timeBasisOffsetMs`、算法版本和 v2 grid map；缺失或可疑 MP3 零值的时间基在主进程
回填，不能由缺少 bundled ffprobe 的扫描 worker 写成 `0`。回归中 DHEA 会以 `25.057ms` 传给两条 deck，实际鼓点
约在 `204.5ms` 对齐，用户试听确认固定错位消失。

这个案例的长期规则是：网格线重合只能证明 grid timeline 一致，不能证明 decoded PCM 对齐。任何时间基字段的
生成、持久化、加载或 native 传递改动，都要以同曲 PCM、网格首拍和实际试听共同回归。

## 3. 已关闭的启动问题

### 相位对齐后使用旧 Master Tempo 游标

旧链路先 reset/prime，再刷新 follower 的 `current_sec`，处理器仍持有旧 audio playhead，下一批输出会把相位拉回
旧位置。修复是在 Master Tempo 活跃且相位调整超过 1ms 后，写入新 `current_sec` 立即重新 reset + prime。
回归测试：`refresh_sync_state_reprime_master_tempo_after_phase_alignment`。

### PCM 起点前的静音引导被跳过

旧代码只在 `currentSec < 0` 时静音；若时间基使真实 PCM 起点晚于 timeline 0，就会把 timeline 直接钳到 decoded
sample 0，产生约 18ms 的前跳。修复使用 `pcmStartTimelineSec` 作为静音引导终点，并在跨过真实 PCM 起点后再
reset + prime。回归测试：`time_basis_lead_in_does_not_jump_master_tempo_playhead_to_pcm_start`。

相同 `join-playing-deck` 样本的最终试听中，启动后相位约在 1ms 观测精度内，没有重现旧的 `-10ms` / `+17.4ms`
固定错位，也没有单向累计漂移。这个结论只关闭该操作序列的启动问题，不代表所有双轨操作永久通过。

## 4. 当前待复测候选：快照空窗误恢复

一次约 107 秒现场中，诊断采样出现 `3.541s` 空窗；空窗后 renderer 的
`horizontalBrowsePlaybackStallRecovery` 把“快照没有按期投递”误判成“原生音频卡死”，对两轨都执行
`preparePlayhead + setPlaying(true)`，从而 reset Master Tempo，造成短暂听感抖动。

证据包括：

- 两轨在 reset 前都已经 `playing=true`；
- reset 前 Bottom 已消费约 `2227491` 帧；
- 同一时间没有 seek、解码应用、联结重建、underrun、错误或警告；
- 空窗与共享 broadcaster 回调一致。

候选修复：疑似卡死时先请求一次新鲜 native snapshot；若播放状态仍为 true 且
`currentSec`、`audioCurrentSec` 或 `renderCurrentSec` 任一继续前进至少 30ms，立即取消恢复。只有新鲜快照也完全
不前进时，才执行原来的恢复动作。

长期约束：状态投递活性不等于音频引擎活性；共享 broadcaster 下两轨同时停住应先查公共投递链路；任何自动
恢复都必须先读取新鲜 native 状态。该候选仍需相同样本连续播放现场验收。

## 5. 固定排查顺序

### A. 确认样本身份

记录真实来源歌单、文件路径、标题、BPM 和音频 hash，不要把 FRKB 与 Rekordbox 的同名歌单混为一谈。

### B. 同时记录三套时间

- Rekordbox timeline：`firstBeatMs`、完整网格点；
- decoded PCM：`timeBasisOffsetMs`、`pcm_start_sec`、`audioCurrentSec`；
- Master Tempo：`playhead_source_frame`、输出采样率和实际 playback rate。

### C. 区分固定相位与累计漂移

至少采样启动后 80、500、1500、3000ms，并将 follower 相位按 effective rate 换算到 leader beat 时间。固定
差值走启动 / 处理器状态分支；随时间增长才走 BPM、rate 或动态网格分支。

### D. 覆盖操作序列

至少复测：已播放 leader 加入 follower、`paired-start`、单轨 BeatSync、暂停恢复、切换 master、seek、loop、
开关联结和 Master Tempo，以及 `134 -> 135`、`135 -> 134` 两个变速方向。

## 6. 诊断与日志边界

需要临时诊断时，使用同一 `traceId` 关联 native snapshot、setPlaying 前后状态、时间基、BPM、effective BPM、
playback rate 和多次 post-start 采样点。临时 trace 在真实试听验收后删除；长期只保留必要错误日志。

如果证据不足，禁止直接改 BeatSync BPM 数学、删除时间基字段，或用 UI 网格重合代替 PCM 对齐验收。
