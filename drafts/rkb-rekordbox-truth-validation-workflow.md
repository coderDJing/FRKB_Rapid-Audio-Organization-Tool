# Rekordbox 真值验证工作流

## 1. 核心原则

Rekordbox 只作为外部真值来源，用来校准 FRKB 的 beat grid analyzer。FRKB
运行态不能依赖 Rekordbox，也不能用 Rekordbox truth 覆盖分析结果。

当前流程只维护一个长期 truth：

```text
grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-current-truth.json
```

FRKB pass/fail 是当前算法状态，只存在于 classification 和派生 benchmark 视图中。
禁止再拆成 `sample truth` / `failure truth` 两份长期真值。

## 2. 固定保留文件

`grid-analysis-lab/rkb-rekordbox-benchmark/` 只保留这些长期有用产物：

- `intake-current-truth.json`：新样本 Rekordbox truth 暂存队列。
- `rekordbox-current-truth.json`：唯一长期 Rekordbox truth 源。
- `frkb-current-latest.json`：当前算法对主 truth 的全量 benchmark，固定覆盖。
- `frkb-classification-current.json`：当前算法分类，决定每首歌属于 `sample` 还是 `grid-failures-current`。
- `sample-regression-latest.json`：从 classification 派生的当前通过集视图，固定覆盖。
- `grid-failures-current-latest.json`：从 classification 派生的当前失败集视图，固定覆盖。
- `grid-failures-current-manifest.json`：当前失败聚类清单，固定覆盖。
- `beatthis-prediction-cache/`：可复用预测缓存。

当前快照：

```text
rekordbox-current-truth.json = 395 tracks
intake-current-truth.json = 0 tracks
frkb-classification-current.json = 395 tracks
sample-regression-latest.json = 276 tracks
grid-failures-current-latest.json = 119 tracks
grid-failures-current-manifest.json = 119 tracks
```

不保留 `*.progress.json`、临时 shard 目录、`targeted-*`、`try-*`、`diag-*`、
随手命名的 `after-*`、以及任何未在本节列出的 benchmark JSON。需要复查时重新跑。

## 3. 音频目录

音频文件只在三个目录中流转：

```text
D:/FRKB_database-B/library/FilterLibrary/new
D:/FRKB_database-B/library/FilterLibrary/sample
D:/FRKB_database-B/library/FilterLibrary/grid-failures-current
```

目录语义：

- `new`：由脚本从 Rekordbox `test` 曲目源路径复制出来的新样本暂存区。
- `sample`：当前 classification = `pass` 的音频。
- `grid-failures-current`：当前 classification != `pass` 或 benchmark error 的音频。

同一首歌不能同时存在于多个目录。目录是 classification 的派生状态，不是真值来源。

## 4. 新样本闭环

新增样本必须走完整闭环：

1. 把新歌加入 Rekordbox `test` playlist，让 Rekordbox 完成分析。
2. 人工删除 Rekordbox 自己也失败、不可信、或音频缺失的曲目。
3. 从 Rekordbox `test` 读取曲目源路径，把主 truth 里没有的新音频复制到 `new`。
4. 抓取 Rekordbox truth 到 `intake-current-truth.json`；已在主 truth 里的重复样本默认跳过，不进入 intake。
5. 确认 `intake-current-truth.json` 与 `new` 目录音频一一对应。
6. 把 intake 合入 `rekordbox-current-truth.json`，同时清空 intake。
7. 跑 `current` benchmark，生成 `frkb-current-latest.json`。
8. 生成 `frkb-classification-current.json` 和三个派生视图。
9. 按 classification 同步音频目录：`pass -> sample`，其他 -> `grid-failures-current`。
10. 清理 Rekordbox `test` 中已处理曲目。

truth 入库后，后续算法优化只更新 classification 和派生视图，不再搬 truth。

## 5. 算法优化闭环

优化算法时按这个顺序验收：

1. 用失败清单定位稳定失败类型。
2. 设计低维、通用、可解释的 Rekordbox-compatible prior。
3. 跑针对性排查，但临时输出用完即删。
4. 跑全量 `current` benchmark。
5. 重建 classification 和派生视图。
6. 检查通过集是否回归、失败集是否改善、是否引入新失败类型。
7. 只有稳定跨样本重复的机制才允许合并。

当前失败样本不作为逐曲补丁来源。它们只用于聚类和验证新规则是否泛化。

允许结构性大改。低维、通用、可解释是验收标准，不是改动规模限制。

如果失败聚类指向 solver 的结构性问题，应直接改对应层，而不是堆 prior：

- anchor 选择逻辑整体不稳。
- time basis 建模不对。
- BeatThis 多窗口融合策略有系统偏差。
- downbeat 决策缺少全局约束。
- BPM 候选选择过早收敛。
- phase solver 对 MP3 frame / decoded timeline 的抽象不干净。

判断规则：

- 局部、可解释偏差 -> 低维 prior。
- 多个失败指向同一决策层薄弱 -> 新机制或重构该层。
- 失败类型杂乱 -> 不急着改算法，继续收样本或改评估工具。
- 暴露 truth/音频同步问题 -> 先修数据流程。

大改同样禁止读取歌名、路径、truth、benchmark 误差和 pass/fail 分类参与 analyzer 决策。

## 6. 禁止事项

算法决策中禁止：

- 使用歌名、artist、路径、basename、播放列表来源。
- 使用文件大小、mtime、hash、fingerprint 做身份特判。
- 维护逐曲 offset 表、逐曲 phase 表、逐曲规则。
- 读取 Rekordbox truth、benchmark 误差、pass/fail 分类。
- 为贴合某首歌移动 Rekordbox truth 的 `firstBeatMs`。
- 用 Rekordbox `PWV5` 波形替换 FRKB raw waveform。
- 把离线能量峰、首个可见起点、最大振幅点当成 Rekordbox 真值。
- 写只命中极少样本的高维布尔补丁。

没有歌名特判不代表没有过拟合。高维组合如果只服务极少数样本，也视为过拟合风险。

## 7. 允许信号

允许引入 Rekordbox-compatible phase prior，但必须描述机制，不描述样本。

允许的信号：

- BeatThis raw beats / downbeats。
- full-track beat logits / downbeat logits。
- attack envelope / local onset。
- 多窗口 BPM 和相位共识。
- downbeat margin。
- beat 序列中位相位和 MAD。
- 音频格式时间轴信号：`stream.start_time`、`Skip Samples`、encoder tag。

允许的 prior 类型：

- `model-frame-prior`
- `integer-head-prezero`
- `downbeat-one-beat-guard`
- `sequence-median-phase`
- `late-phase-edge`
- `local-onset-lead`
- `full-track-logit-*`

## 8. 数据语义

一首歌有三层数据：

- 音频文件：唯一共同输入。
- Rekordbox truth：`bpm`、`firstBeatMs`、`firstBeatLabel`、`barBeatOffset`、`PQTZ`。
- FRKB analyzer 输出：最终也必须表达 `bpm`、`firstBeatMs`、`barBeatOffset`。

`firstBeatMs` 是 Rekordbox 时间轴上的网格时间戳，不是音频第一个声音的位置。

FRKB 输出如果在 audio 轴上，benchmark 前必须转换：

```text
frkbFirstBeatTimelineMs = frkbFirstBeatAudioMs + timeBasisOffsetMs
```

如果 analyzer 已经输出 app timeline 语义，不能再加一次 offset。

analyzer 中间结果允许 `firstBeatMs < 0`。负值表示按当前 BPM 和相位外推，某条等价拍线落在 decoded sample 0 之前。候选、缓存、benchmark 归一化阶段不能提前丢弃。

## 9. time basis

Rekordbox 的 `firstBeatMs` 是 Rekordbox 时间轴；FRKB raw waveform 来自 FFmpeg decoded PCM。

当前坐标规则：

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

这里修的是坐标，不是移动音频，也不是改 Rekordbox truth。

## 10. benchmark 等价定义

FRKB 输出归一化到 Rekordbox timeline 后比较：

```text
beatIntervalMs = 60000 / rekordboxBpm
phaseErrorMs = circularPhase(frkbFirstBeatTimelineMs - rekordboxFirstBeatMs, beatIntervalMs)
```

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

硬阈值：

- `firstBeatPhaseAbsErrorMs <= 2ms`
- `gridMaxAbsMs <= 2ms`
- `bpmOnlyDrift128BeatsMs <= 2ms`
- `barBeatOffset` 必须匹配

没有灰区。任何一项超过阈值都算失败。

## 11. 命令

从 Rekordbox `test` playlist 复制新增音频到 `new`：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "test" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "test"
```

抓取 Rekordbox `test` playlist 到 intake：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/capture_rekordbox_playlist_truth.py" --playlist "test"
```

这一步默认跳过已经存在于 `rekordbox-current-truth.json` 的曲目，避免重复样本重新进入闭环。

合入主 truth 并清空 intake：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/merge_rekordbox_truth_intake.py" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/merge_rekordbox_truth_intake.py" --clear-intake
```

跑全量当前 benchmark：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --profile current --jobs 4
```

生成 classification 和派生视图：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/build_frkb_current_classification.py"
```

临时排查单曲或子集：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --profile current --jobs 4 --only "artist or title substring" --output "grid-analysis-lab/rkb-rekordbox-benchmark/diagnostic-local.json"
```

`diagnostic-local.json` 只是临时排查文件，用完删除，不进入保留清单。

Python 编译检查：

```powershell
py -3 -m py_compile "scripts/beat_this_bridge.py" "scripts/beat_this_phase_rescue.py" "scripts/beat_this_grid_rescue.py" "scripts/beat_this_full_logit_rescue.py" "scripts/benchmark_rkb_rekordbox_truth.py" "scripts/capture_rekordbox_playlist_truth.py" "scripts/sync_rekordbox_playlist_audio.py" "scripts/run_parallel_rkb_rekordbox_benchmark.py" "scripts/merge_rekordbox_truth_intake.py" "scripts/build_frkb_current_classification.py"
```

代码修改后必须运行：

```powershell
npx vue-tsc --noEmit
```

## 12. 缓存边界

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

## 13. 人工复核

benchmark 失败时：

1. 在 FRKB raw waveform 上显示 Rekordbox truth grid。
2. 同轴显示 FRKB analyzer grid。
3. 判断差异属于 BPM、首拍相位、downbeat、time basis，还是多锚点。
4. 如果 Rekordbox truth 错，回 Rekordbox 修 grid，再重新生成 truth。
5. 如果 FRKB analyzer 错，先聚类失败类型，再决定是否设计通用 prior。

不要在 FRKB 里手工写补偿把失败样本抹平。

## 14. 交接摘要

```text
唯一长期 truth = rekordbox-current-truth.json。
新增音频由 sync_rekordbox_playlist_audio.py 从 Rekordbox test 源路径复制到 new。
已有主 truth 的重复样本会被跳过；新 truth 进入 intake-current-truth.json，确认后合入主 truth 并清空 intake。
FRKB pass/fail 只存在于 frkb-classification-current.json 和派生 latest/manifest。
音频目录由 classification 派生：pass -> sample，其他 -> grid-failures-current。
算法优化只更新 classification，不搬 truth。
新增 prior 必须低维、通用、可解释，禁止身份特判和逐曲补丁。
允许结构性大改；大改也必须由失败聚类驱动，并通过全量 current benchmark 验收。
临时 benchmark 输出用完即删。
修改代码后必须跑 py_compile、相关 benchmark、npx vue-tsc --noEmit。
```
