# 双轨混音对拍与听感错位长期维护手册

状态：本次样本已完成真实试听验收；其他双轨操作序列持续回归

首次记录：2026-08-07

影响范围：FRKB 双轨模式、联结起播、BeatSync、Master Tempo、Rekordbox 网格与 FFmpeg 解码 PCM 的对齐链路。

## 这份文档的用途

双轨问题不能只看界面网格线，也不能看到两个 ffprobe 字段相同就直接相加或删除偏移。
以后处理任何双轨混音问题，先读本文件，再建立新的现场证据。目标是保护已经验证过的时间基、网格、同步和混音状态机语义，避免修一个阶段时破坏另一个阶段。

## 当前现场

样本来自 `CODER Device Library/未完Set/abyss` 的第二、第三首，用户在 Rekordbox 与 FRKB 对比叠歌：

| 项目 | 上轨 | 下轨 |
| --- | --- | --- |
| 文件 | `Push (Original Mix)` | `Rollende Technodingen (Original Mix)` |
| BPM | 134 | 131，跟随后 effective BPM 134 |
| Rekordbox 网格点 | 849 | 838 |
| timeBasisOffsetMs | 25.057 | 50.114 |
| 同步状态 | `syncEnabled=true`, `syncLock=full` | `syncEnabled=true`, `syncLock=full` |
| Master Tempo | 开启 | 开启 |

三轮现场日志 traceId：

- 首次问题现场：`linked-start-1786074286326-1`；
- 修复问题一后的复测：`linked-start-1786080905110-1`；
- 修复问题二后的最终验收：`linked-start-1786084237389-1`。

本次实际操作模式是 `join-playing-deck`：上轨已经播放到约 240 秒，下轨从开头加入；不是两轨原子同时起播。因此不能把“两个 setPlaying 调用间隔”当成这次的唯一根因。

## 已确认事实

### 1. 不是持续 BPM 漂移

两轨的 effective BPM 都是 134。按 80、500、1500、3000ms 采样，网格相位差约为：

```text
-0.813ms、-10.649ms、-10.276ms、-10.179ms、-10.522ms
```

相位在启动后变成一个约 10ms 的固定差值，没有继续累积。因此先查启动/处理器状态，不要先改 BPM 比例、动态网格或浮点计算。

### 2. LAME 的 50.114ms 不能凭字段相等直接判定为重复补偿

两首文件的 ffprobe 都显示：

```text
stream.start_time = 25.057ms
sample_rate = 44100
first packet Skip Samples = 1105 samples = 25.057ms
```

但下轨 encoder 是 `LAME3.100`，现有时间基规则会追加一次 gapless Skip Samples，得到 `50.114ms`；上轨 encoder 是 `Lavc58.91`，保持 `25.057ms`。

这看起来像重复计算，但不能只按容器字段下结论。对实际解码 PCM 与 Rekordbox 固定网格做宽带 onset 扫描后，最佳时间轴偏移约为：

```text
Push：约 30.5ms
Rollende：约 54.7ms
两者差值：约 24.2ms
```

这与 `25.057ms` 的跨编码差异相符，说明 LAME 额外补偿目前仍是 Rekordbox 坐标契约的一部分。未经同曲 PCM benchmark、网格首拍和现场试听三者共同确认，禁止删除 `shouldApplyLameGaplessSkipOffset` 或把所有 MP3 强行归一为 `stream.start_time`。

### 3. 已确认问题一：Master Tempo 状态在相位调整后仍使用旧游标

当前链路存在以下顺序：

1. `setPlaying` 或状态刷新先对跟随轨执行 `reset_and_prime_master_tempo_state`；
2. `refresh_sync_state(true)` 再按 leader 网格调整跟随轨 `current_sec`；
3. SoundTouch 的 `playhead_source_frame` 仍对应调整前的位置；
4. 下一批输出由 `sample_deck_master_tempo` 根据旧的 audio playhead 回写 `current_sec`。

结果就是 UI/网格刚对齐，第一批实际 Master Tempo 输出又退回旧相位，第一次现场表现为启动后约一个音频缓冲区（约 10ms）的固定错位。

当前修复：当 phase alignment 改动超过 1ms 且该轨正在使用 Master Tempo 时，在写入新 `current_sec` 后立即重新 reset + prime SoundTouch。对应回归测试：

`refresh_sync_state_reprime_master_tempo_after_phase_alignment`

该问题是实锤 bug，但 2026-08-07 第二次真实试听仍然跑马，证明它不是全部主因，禁止把代码单测通过写成现场已关闭。

### 4. 已确认问题二：时间基之前的静音引导被 Master Tempo 直接跳过

第二次现场 traceId：`linked-start-1786080905110-1`。

修复问题一后，启动后相位不再是约 `-10ms`，而是稳定在约 `+17.4ms`：

```text
-0.463ms、+17.299ms、+17.448ms、+17.545ms、+17.425ms
```

这次下轨 phase alignment 后的 timeline 位置为 `32ms`，但其 `timeBasisOffsetMs` 为 `50.114ms`。此时正确语义应是在 timeline `32ms -> 50.114ms` 之间输出静音，然后从 decoded PCM sample 0 开始。

旧代码只把 `currentSec < 0` 当作静音引导。因为 `32ms > 0`，Master Tempo 直接进入音频采样；`reset_master_tempo_state` 又会把负的 audio position 钳为 0，第一帧随即把 timeline 从 `32ms` 重建到约 `50.114ms`，凭空前跳约 `18.1ms`。这与现场稳定的 `+17.4ms` 相符。

当前修复把静音引导终点从固定的 timeline `0` 改为实际 decoded PCM 起点：

```text
pcmStartTimelineSec = audio_sec_to_timeline_sec(pcm_start_sec)
```

只要 `currentSec < pcmStartTimelineSec`，无论是否开启 Master Tempo，都保持静音并按 playback rate 连续推进 timeline；跨过真实 PCM 起点后再 reset + prime。对应回归测试：

`time_basis_lead_in_does_not_jump_master_tempo_playhead_to_pcm_start`

### 5. 最终现场验收：启动相位稳定且人耳不再跑马

2026-08-07 第三次真实试听使用相同的 `Push` / `Rollende Technodingen`、相同的 `join-playing-deck` 操作。两轨均为 `syncEnabled=true`、`syncLock=full`、Master Tempo 开启，effective BPM 均为 134。

最终 traceId 为 `linked-start-1786084237389-1`。按下轨原始 131 BPM 网格相位换算到 134 BPM 的墙钟时间，启动后采样结果为：

```text
0ms       +0.351ms
80ms      +0.291ms
500ms     -0.314ms
1500ms    -0.216ms
3000ms    +0.194ms
```

诊断快照中的 `currentSec` 只记录到 1ms，因此这些小数不能当作亚毫秒精密测量；可靠结论是相位保持在约 1ms 观测精度内，没有复现先前约 `-10ms` 或 `+17.4ms` 的固定错位，也没有单向累计漂移。用户人耳确认本次“不跑马”。

该结论关闭的是这对样本的已播放 leader 上加入 follower 场景。暂停恢复、切换 master、seek、loop、`paired-start` 等操作仍按后文清单持续回归，禁止据此宣称所有双轨路径永久关闭。

### 6. 修复代价与行为边界

- phase alignment 改动超过 1ms 且 Master Tempo 活跃时，会一次性 reset + prime SoundTouch；本次 `setPlaying` 总耗时为 `3.7ms`，没有观察到断音。该数值包含整个 handler，不能当作 reset + prime 的独立 benchmark。
- `sample_silent_lead_in` 每个播放帧会多做一次 PCM 起点换算和比较，只有简单浮点运算，无新增分配，相比 SoundTouch 和混音 DSP 可忽略。
- 时间基之前现在输出正确静音。若输入的 `timeBasisOffsetMs` 本身错误，会按错误时间基表现，因此不能放松时间基生成、持久化和载入验证。
- 本次没有修改 BPM、Rekordbox 网格、QuickSeek、Master Tempo 音质参数、EQ、Auto Gain、Limiter 或混音增益语义。

### 7. 最终自动验证

清理临时诊断后执行：

- `cargo test --manifest-path "rust_package/Cargo.toml" horizontal_browse_transport --lib`：63/63 通过；
- `npx vue-tsc --noEmit`：通过；
- `pnpm run rust-package:ensure`：通过，开发 native artifact 已刷新；
- `git diff --check`：通过；
- `src/main` 与 `rust_package/src` 中无 `[HB-LINKED-START-DIAG]` 残留。

## 明确排除和暂不修改项

- 不把本次问题归因于 BPM 比例累计误差；日志没有累计漂移证据。
- 不把 `join-playing-deck` 直接等同于原子双轨起播竞态；本次 trace 不是 paired-start。
- 不删除 LAME 的额外时间基补偿；当前离线 PCM/网格证据不支持这个改法。
- 不用削波、Limiter、Auto Gain 解释相位差。它们可能放大难听感，但不会制造稳定拍点错位。
- 不用静态 UI 波形/网格重合代替 PCM 对齐验收。

## 以后排查的固定顺序

### A. 先确认样本身份

记录来源歌单、真实文件路径、标题、BPM、音频 hash；不要把 FRKB 本地歌单和 Rekordbox 同名歌单混为一谈。

### B. 再确认三套时间

对每轨同时记录：

- Rekordbox timeline：`firstBeatMs`、完整网格点；
- FFmpeg decoded PCM：`timeBasisOffsetMs`、`pcm_start_sec`、`audioCurrentSec`；
- Master Tempo 处理器：`playhead_source_frame`、输出采样率、实际播放 rate。

统一关系是：

```text
timelineSec = audioSec + timeBasisOffsetSec
audioSec = timelineSec - timeBasisOffsetSec
```

不要把已经消费过的 decoder skip、容器 timestamp、Rekordbox timeline 和 SoundTouch 延迟混成一个“看起来合理”的数字。

### C. 再看同步是否累计漂移

至少采样启动后 80、500、1500、3000ms，并将 follower 相位按 effective rate 换算到 leader 的 beat 时间。固定差值走启动/处理器状态分支；随时间增长才走 BPM、rate 或动态网格分支。

### D. 最后覆盖操作序列

每次修复至少复测：

- 已播放 leader 上加入 follower；
- 两轨同时起播；
- 单轨 BeatSync；
- 暂停后恢复；
- 切换 master；
- seek、拖拽、loop 边界；
- 开关联结和 Master Tempo；
- 变速方向 `134 -> 135` 与 `135 -> 134`。

## 日志字段判读

需要重新启用临时 `[HB-LINKED-START-DIAG]` trace 时，必须保留：

- `mode`、两次调用的 `before/after`、调用耗时；
- 每轨 `bpm`、`effectiveBpm`、`playbackRate`、`masterTempoEnabled`；
- `timeBasisOffsetMs`、`firstBeatMs`、首尾网格点数量；
- post-start 的多个采样点。

临时诊断默认只保留到真实试听验收完成；验收后删除普通 info 级诊断，长期代码只保留必要错误日志。本次诊断已在最终试听验收后删除，数据结论保留在本文，不把大 JSON 和延迟采样定时器留在常驻代码中。

## 接手指令

接手新的双轨问题时，第一步必须打开本文件和 `log.txt`，先回答：

1. 两首歌的真实来源和文件身份是否确定？
2. 这是固定相位还是累计漂移？
3. Rekordbox timeline、decoded PCM、Master Tempo playhead 三者各自的原点是什么？
4. 本次操作属于 `paired-start`、`join-playing-deck` 还是 seek/resume？
5. 现有修复是否已经覆盖该操作序列？

如果这五个问题没有证据，禁止直接改 BeatSync BPM 数学或删除时间基字段。
