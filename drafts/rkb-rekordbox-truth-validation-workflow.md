# Rekordbox 真值验证工作流

## 1. 当前结论

`rkb` 是历史命名。当前 Rekordbox 真值链路的目标不是让 FRKB 依赖
Rekordbox 运行，而是用 Rekordbox 作为外部分析参照，校准 FRKB 自己的
beat grid analyzer。

当前有效基线：

```text
sample pass regression = grid-analysis-lab/rkb-rekordbox-benchmark/sample-pass-after-layout-3.json
trackTotal = 219
pass = 219
errorTrackCount = 0
currentTimeline.bpmOnlyDrift128BeatsMs.max = 0.0ms
strictToleranceMs = 2.0ms

current failures = grid-analysis-lab/rkb-rekordbox-benchmark/grid-failures-after-layout-1.json
trackTotal = 56
first-beat-phase = 50
downbeat = 3
bpm = 3
errorTrackCount = 0
```

旧的 `184/184 pass` 输出不再作为当前算法质量结论。那轮结果混入了过窄的相位修补规则，样本内能全过，但存在明显多特征拟合风险。

当前策略：

- 历史旧 184 结果继续保留，但当前 `sample` 只放通过样本。
- 软件运行态不再把 `rkb` 歌单当特殊入口，也不再用 Rekordbox truth 覆盖 FRKB 分析结果。
- 本地通过样本根是 `D:/FRKB_database-B/library/FilterLibrary/sample`。
- FRKB 软件内 `rkb` 歌单已废弃，当前失败样本只归入 `grid-failures-current`。
- 暂停逐首追杀当前失败样本。
- 下一步先扩充新样本，再观察失败模式是否重复出现。
- 只有新旧样本中都出现的稳定模式，才允许沉淀为新的 Rekordbox-compatible phase prior。

2026-04-27 新增 `test` 歌单首轮观察：

```text
captured truth = grid-analysis-lab/rkb-rekordbox-benchmark/test-95-captured-truth.json
test playlist trackTotal = 95
duplicateWithOld = 4
uniqueNew = 91
audio source root = C:/Users/coder/Desktop/新建文件夹

old184 rerun = grid-analysis-lab/rkb-rekordbox-benchmark/current-old184-before-new95.json
old184 pass = 174
old184 first-beat-phase = 10
old184 errorTrackCount = 0

new95 baseline = grid-analysis-lab/rkb-rekordbox-benchmark/new95-baseline-1.json
new95 pass = 47
new95 first-beat-phase = 40
new95 downbeat = 5
new95 bpm = 3
new95 errorTrackCount = 0
```

首轮聚类结论：新增失败分布不是单一低维模式，`first-beat-phase`
需要的修正方向正负混杂；`full-logit` 在旧 184 里救回大量样本，但在新增 95
里触发样本质量不稳定，不能直接关停或粗暴收紧；`bpm` 失败也不能简单贴整数，
旧样本里存在真实 `131.99` 反例。

2026-04-27 合并规则：

```text
rule = refined-head-downbeat-logit-margin
failureType = downbeat
signals = refined head phase <= 30ms, beat/downbeat support, quality/confidence, full-track downbeat logits margin
guard = only adjacent one-beat bar change, margin >= 8.0
targetedNew95 = improved 2, regressed 0
fullNew95 = pass 49, first-beat-phase 40, downbeat 3, bpm 3, errorTrackCount 0
fullOld184 = pass 174, first-beat-phase 10, errorTrackCount 0
notes = no metadata, no truth, no file identity; old184 per-track diff is empty
```

本规则只修 `barBeatOffset`，不移动 BPM 或 first beat。完整新 95 中只有
`Vil & cravo - Sambatuga (1).mp3` 和
`Yigitoglu - Cloudy And Beautiful (Original Mix).mp3` 从 `downbeat` 变 `pass`；
旧 184 没有任何逐曲输出变化。

2026-04-27 本地样本整理：

```text
D:/FRKB_database-B/library/FilterLibrary/sample = current pass sample root, 219 tracks
D:/FRKB_database-B/library/FilterLibrary/new = Rekordbox test intake staging, 0 tracks
D:/FRKB_database-B/library/FilterLibrary/grid-failures-current = current FRKB failures, 56 tracks
D:/FRKB_database-B/library/FilterLibrary/rkb = deleted

sample source:
old184 pass = 174 tracks
new95 pass unique = 45 tracks
new95 pass duplicate with old sample = 4 tracks, skipped

grid-failures-current source:
old184-after-downbeat-logit-1 = 10 failures
new95-after-downbeat-logit-3 = 46 failures
categoryCounts = first-beat-phase 50, downbeat 3, bpm 3
manifest = grid-analysis-lab/rkb-rekordbox-benchmark/grid-failures-current-manifest.json
failure truth = grid-analysis-lab/rkb-rekordbox-benchmark/grid-failures-current-truth.json
```

当前保留产物：

- `sample-pass-after-layout-3.json` / `.progress.json`：当前默认 `sample` 通过集基线。
- `grid-failures-after-layout-1.json` / `.progress.json`：当前失败集基线。
- `grid-failures-current-truth.json`：失败集 truth。
- `grid-failures-current-manifest.json`：失败集来源和分类清单。
- `after-late-edge-full-1.json` / `.progress.json`：旧 184 历史基线。
- `after-overfit-prune-1.json` / `.progress.json`：删除明显过拟合补丁后的基线。
- `after-local-onset-lead-full-1.json` / `.progress.json`：local onset lead 里程碑。
- `after-logit-edge-full-1.json` / `.progress.json`：full-track logit edge 里程碑。
- `after-frame-prior-full-2.json` / `.progress.json`：frame prior 里程碑。
- `test-101-captured-truth.json`、`test-truth.json`：truth 数据，不作为算法质量结论。

`targeted-*`、`try-*`、`diag-*`、`old40-*`、`abc*`、`test-new-*`、旧 `test-101-unified-184-*` 和 `latest.json` 都属于历史试跑噪音；需要复查时重新跑，不再作为交接资料保留。

## 2. 绝对禁止

以下做法一律禁止，即使能提升当前失败集通过率：

- 用歌名、artist、路径、basename、播放列表来源做算法特判。
- 用文件大小、mtime、hash、fingerprint 参与 analyzer 决策。
- 维护逐曲 offset 表或逐曲 phase 修正表。
- 在 analyzer 决策中读取 Rekordbox truth、benchmark 误差、pass/fail 结果。
- 为了贴合某一首歌移动 Rekordbox truth 的 `firstBeatMs`。
- 用 Rekordbox `PWV5` 波形替换 FRKB raw waveform。
- 把离线能量峰、首个可见起点、最大振幅点当成 Rekordbox 网格真值。
- 写一串过窄布尔条件，只命中 1-2 首失败样本。

没有歌名特判不代表没有过拟合。`rawFirstBeatMs + confidence + quality + strategy + barOffset + windowStartSec` 这种高维组合如果只服务极少数样本，也视为过拟合风险。

## 3. 可以引入什么

可以引入 **Rekordbox-compatible phase prior**，但它必须是低维、通用、可解释的目标系统偏置，而不是样本记忆。

允许的信号：

- BeatThis raw beats / downbeats。
- full-track beat logits / downbeat logits。
- attack envelope / local onset。
- 多窗口 BPM 和相位共识。
- downbeat margin。
- beat 序列中位相位和 MAD。
- 音频格式时间轴信号：`stream.start_time`、`Skip Samples`、encoder tag。

允许的 prior 类型：

- `model-frame-prior`：BeatThis / Rekordbox 风格的 20ms 帧边界残差先验。
- `integer-head-prezero`：首拍落在 decoded sample 0 之前时允许小幅负相位。
- `downbeat-one-beat-guard`：相位已接近但 bar offset 明显偏一拍时修正 downbeat。
- `sequence-median-phase`：beat 序列中位相位稳定且 MAD 很低时使用序列相位。
- `late-phase-edge`：晚相位、非 0 bar、anchor 未修正时贴近前侧边缘。
- `local-onset-lead`：低置信 head attack 可用稳定 onset lead 微调。
- `full-track-logit-*`：只有 logits 分数、support、downbeat margin 同时支持时才介入。

这些 prior 的名字必须描述机制，不能描述样本、歌单或临时现象。

## 4. 新规则合并门槛

新增规则必须同时满足：

- 不使用任何元数据身份信号。
- 不使用 truth 或 benchmark 结果参与 analyzer。
- 能解释一个稳定失败类型，例如 `first-beat-phase`、`downbeat`、`bpm`、`time-basis`、`frame-residual`。
- 使用粗粒度、可解释阈值，不能为了某首歌写精确误差值。
- 先跑 targeted，再跑 `sample` 通过集回归。
- `sample` 通过集必须 `0` 回归。
- 如果规则针对失败聚类，还必须显式跑 `grid-failures-current`，并单独记录改善和新增失败。
- 不能引入新的 `bpm`、`half-or-double-bpm` 或 `downbeat` 失败。
- 输出必须记录触发数、救回数、回归数。

推荐记录格式：

```text
rule = model-frame-prior
failureType = first-beat-phase
signals = raw/current phase, bar offset, quality, confidence, drift
targeted = improved 4, regressed 0
sample = pass 219, regressed 0
failures = improved 9, regressed 0
notes = no metadata, no truth, no file identity
```

如果某条规则只救 1 首：

- 默认不合并。
- 除非它是已有机制的自然扩展，并且有明确反例保护。
- 如果连续出现多个单首规则，停止堆补丁，重构 solver。

## 5. 样本扩充后的新流程

当前剩余失败样本先保留，不继续单独追杀。下一步流程改为：

1. Rekordbox 端只维护一个 `test` playlist。
2. 新样本先进入 Rekordbox `test`，由 Rekordbox 完成分析。
3. 人工删除 Rekordbox 自己也失败或不可信的曲目。
4. 从 Rekordbox 读取剩余曲目的 `.DAT beat_grid` / `PQTZ`。
5. 合并进 `resources/rkbRekordboxGridSnapshot.json`。
6. 跑 `sample` 通过集回归。
7. 把 FRKB 当前仍失败的曲目归入软件内 `grid-failures-current` 歌单。
8. 对 `grid-failures-current` 做聚类，而不是逐首补规则。
9. 只有聚类结果形成稳定、可解释、跨样本重复的模式，才设计通用 prior。

`rkb` 不再作为 FRKB 软件里的当前验证歌单名称；`sample` 只保存当前通过样本，
`grid-failures-current` 只保存当前失败样本。同一首失败样本不应同时留在
`sample` 和 `grid-failures-current`。

聚类维度：

- BPM 错。
- half/double BPM。
- firstBeat phase 错。
- downbeat/barBeatOffset 错。
- timeBasisOffset 错。
- full-logit 拉偏。
- head attack / local onset 偏差。
- model frame / quantization 残差。
- 多窗口相位不一致。

只有当新样本中出现和旧失败样本相同的稳定模式，才继续设计 prior。

## 6. dev / regression / blind 约束

历史旧 184 是 **regression + dev 历史混合集**，不能当 locked blind。
当前 `sample` 是通过集回归样本，不代表 blind 泛化；`grid-failures-current`
是失败聚类输入，不参与默认通过集回归。

建议后续分层：

- `dev`：允许看失败、调规则。
- `regression`：旧样本，保证不退化。
- `locked blind`：冻结算法后才跑，只评估不调参。

规则：

- 如果根据某批新样本失败结果改了算法，那批新样本自动降级为 dev。
- 需要重新准备另一批 locked blind。
- “全通过”必须说明是 dev 全通过、regression 全通过，还是 locked blind 全通过。
- 没有 locked blind 时，只能说样本内通过，不能说泛化已解决。

## 7. 数据层语义

一首歌在这个验证体系里有三层数据。

### 7.1 音频文件

音频文件是唯一共同输入。

MP3 不是从 `0ms` 开始的一串裸 PCM。它可能包含：

- MPEG frame。
- encoder delay / padding。
- `ffprobe stream.start_time`。
- 第一包 `Skip Samples`。
- encoder tag，例如 `LAME3.100`、`Lavc59.37`。

这些字段只用于坐标映射，不允许扩展成逐曲补偿表。

### 7.2 Rekordbox 真值

Rekordbox truth 来自 Rekordbox beat grid：

- `bpm`
- `firstBeatMs`
- `firstBeatLabel`
- `barBeatOffset`
- `PQTZ`

重点：`firstBeatMs` 是 Rekordbox 时间轴上的网格时间戳，不是“音频文件第一个声音的位置”。

### 7.3 FRKB analyzer 输出

FRKB analyzer 最终也必须输出同一语义：

- `bpm`
- `firstBeatMs`
- `barBeatOffset`

如果 analyzer 输出在 audio 轴上，benchmark 前必须转换：

```text
frkbFirstBeatTimelineMs = frkbFirstBeatAudioMs + timeBasisOffsetMs
```

如果 analyzer 已经输出 app timeline 语义，则不能再加一次 offset。

### 7.4 负 firstBeatMs

analyzer 中间结果允许 `firstBeatMs < 0`。

它表示按当前 BPM 和相位外推，某条等价拍线落在 decoded sample 0 之前。算法候选、缓存、benchmark 归一化阶段不能因为负数提前丢信息。

禁止恢复这类逻辑：

```text
firstBeatMs = max(0, firstBeatMs)
if firstBeatMs < 0: discard result
```

## 8. timeBasisOffsetMs

Rekordbox 的 `firstBeatMs` 是 Rekordbox 时间轴；FRKB raw waveform 来自 FFmpeg decoded PCM。

必须明确：

```text
FFmpeg decoded sample 0 -> Rekordbox timeline ?
```

当前规则：

```text
timeBasisOffsetMs = ffprobe stream.start_time * 1000

如果满足：
  encoder tag 以大写 LAME 开头
  第一包存在 Skip Samples.skip_samples
  sample_rate 有效

则追加：
  timeBasisOffsetMs += skip_samples / sample_rate * 1000
```

坐标转换：

```text
timelineSec = audioSec + timeBasisOffsetMs / 1000
audioSec = timelineSec - timeBasisOffsetMs / 1000
```

代表样本：

| file | encoder | start_time | skip_samples | timeBasisOffsetMs |
| --- | --- | ---: | ---: | ---: |
| `Developer - Have It All (Original Mix).mp3` | `LAME3.100` | `25.057ms` | `1105` | `50.114ms` |
| `len faki - zig zag (original mix) (1).mp3` | `LAME3.100` | `25.057ms` | `1105` | `50.114ms` |
| `enrico sangiuliano - the techno code (...) (1).mp3` | `Lavc59.37` | `25.057ms` | `1105` | `25.057ms` |
| `len faki - gamma (glaskin remix) (1).mp3` | `Lame3.100` | `0ms` | 无 | `0ms` |
| `leviws - foul play (1).mp3` | `Lame3.100` | `0ms` | 无 | `0ms` |

这里修的是坐标，不是移动音频，也不是改 Rekordbox truth。

## 9. benchmark 等价定义

FRKB 输出归一化到 Rekordbox timeline 后比较：

```text
beatIntervalMs = 60000 / rekordboxBpm
phaseErrorMs = circularPhase(frkbFirstBeatTimelineMs - rekordboxFirstBeatMs, beatIntervalMs)
```

首拍相位必须用 circular phase，不能普通相减。

比较 downbeat 时，必须把首拍按整数拍折叠带来的 shift 同步应用到 `barBeatOffset`：

```text
firstBeatShiftBeats = nearestIntegerBeatShift(...)
normalizedFrkbBarBeatOffset = normalize(frkbBarBeatOffset + firstBeatShiftBeats)
barBeatOffsetMatch = normalizedFrkbBarBeatOffset == normalize(rekordboxBarBeatOffset)
```

固定 BPM 时，多拍比较：

```text
rbBeatMs[i] = rekordboxFirstBeatMs + i * 60000 / rekordboxBpm
frkbBeatMs[i] = frkbFirstBeatTimelineMs + i * 60000 / frkbBpm
gridErrorMs[i] = frkbBeatMs[i] - rbBeatMs[i]
```

如果未来遇到变 BPM 或多锚点歌曲，优先使用完整 `PQTZ`。

硬阈值：

- `firstBeatPhaseAbsErrorMs <= 2ms`
- `gridMaxAbsMs <= 2ms`
- `bpmOnlyDrift128BeatsMs <= 2ms`
- `barBeatOffset` 必须匹配

没有灰区。任何一项超过阈值都算失败。

## 10. 运行 benchmark

默认回归跑 `sample` 通过集。默认 truth 是
`resources/rkbRekordboxGridSnapshot.json`，默认 `audio-root` 是
`D:/FRKB_database-B/library/FilterLibrary/sample`，当前应为 219 首：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --jobs 4 --output "grid-analysis-lab/rkb-rekordbox-benchmark/<name>.json" --progress-output "grid-analysis-lab/rkb-rekordbox-benchmark/<name>.progress.json"
```

针对样本：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --jobs 4 --only "artist or title substring" --output "grid-analysis-lab/rkb-rekordbox-benchmark/<name>.json" --progress-output "grid-analysis-lab/rkb-rekordbox-benchmark/<name>.progress.json"
```

失败集单独跑，不和默认 `sample` 回归混在一起：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --jobs 4 --truth "grid-analysis-lab/rkb-rekordbox-benchmark/grid-failures-current-truth.json" --audio-root "D:/FRKB_database-B/library/FilterLibrary/grid-failures-current" --output "grid-analysis-lab/rkb-rekordbox-benchmark/<failure-name>.json" --progress-output "grid-analysis-lab/rkb-rekordbox-benchmark/<failure-name>.progress.json"
```

Python 编译检查：

```powershell
py -3 -m py_compile "scripts/beat_this_bridge.py" "scripts/beat_this_phase_rescue.py" "scripts/beat_this_grid_rescue.py" "scripts/beat_this_full_logit_rescue.py" "scripts/benchmark_rkb_rekordbox_truth.py" "scripts/capture_rekordbox_playlist_truth.py" "scripts/run_parallel_rkb_rekordbox_benchmark.py"
```

如果修改了代码，最终还必须运行：

```powershell
npx vue-tsc --noEmit
```

## 11. 缓存边界

允许缓存：

- BeatThis raw window predictions。
- full-track logits。
- 与算法决策无关、同音频同模型必然相同的中间输出。

禁止缓存：

- 最终 `bpm` / `firstBeatMs` / `barBeatOffset`。
- benchmark pass/fail 结论。
- anchor 选择、phase rescue、downbeat 归一化后的最终结果。

判断标准：

```text
改 FRKB 网格求解算法后，缓存内容本身是否仍应完全相同？
```

如果答案不是明确的“是”，就不能作为跨算法版本复用的验收结论。

## 12. 人工复核闭环

benchmark 失败时：

1. 在 FRKB raw waveform 上显示 Rekordbox truth grid。
2. 同轴显示 FRKB analyzer grid。
3. 判断差异属于 BPM、首拍相位、downbeat、time basis，还是多锚点。
4. 如果 Rekordbox truth 错，回 Rekordbox 修 grid，再重新生成 truth。
5. 如果 FRKB analyzer 错，先聚类失败类型，再决定是否设计通用 prior。

不要在 FRKB 里手工写补偿把失败样本抹平。

## 13. 当前剩余失败处理原则

当前失败样本不再单独作为逐曲新增规则来源。

它们的作用是：

- 保留在 `grid-failures-current` 和对应 failure truth 里。
- 等新样本扩充后做失败模式对照。
- 如果同类错误在新样本中重复出现，再设计通用 prior。

如果某个剩余失败样本长期孤立存在：

- 可以继续失败。
- 不为它写单曲规则。
- 不为它牺牲新样本泛化。

当前最重要的目标不是把失败集压到全过，而是让新样本加入后还能稳定解释失败并避免回归。

## 14. 一句话交接

```text
按 drafts/rkb-rekordbox-truth-validation-workflow.md 工作。
当前默认 `sample` 是通过集；失败样本在 `grid-failures-current` 单独聚类。
旧 184/184 是样本内过窄补丁结果，不再作为质量结论。
下一步先扩充样本，用新旧样本共同暴露稳定失败模式。
新增 Rekordbox-compatible phase prior 必须低维、通用、可解释、0 回归。
禁止歌名/文件名/truth/pass-fail/高维特征指纹规则。
修改代码后必须跑 py_compile、相关 benchmark、npx vue-tsc --noEmit。
```
