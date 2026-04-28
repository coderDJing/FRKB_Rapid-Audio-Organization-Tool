# Rekordbox 真值验证双管线工作流

## 1. 核心原则

Rekordbox 只作为外部真值来源，用来校准 FRKB 的 beat grid analyzer。FRKB
运行态不能依赖 Rekordbox，也不能用 Rekordbox truth 覆盖分析结果。

当前只维护一个长期 Rekordbox truth：

```text
grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-current-truth.json
```

`grid-analysis-lab/` 是本地分析工作区。truth、benchmark、classification
和失败清单都跟本机样本库绑定，不作为仓库可提交资产。历史上已跟踪的旧 JSON
即使继续出现在 `git status`，也不代表应该提交。

FRKB pass/fail 是某个 analyzer provider 的当前算法状态，只能存在于该 provider
自己的 classification、派生 benchmark 视图和音频目录中。禁止再拆成
`sample truth` / `failure truth` 两份长期真值，也禁止一套 provider 改写另一套
provider 的分类状态。

当前长期并行维护两套 provider：

- `beatthis`：默认运行态 provider。
- `classic`：非 AI provider，用于长期独立对照。

两套 provider 共享同一个 Rekordbox truth 和同一个 intake truth；除此之外，
benchmark、classification、派生视图、音频样本目录全部分开。它们不是短期胜负模式，
也不要求通过一两次 benchmark 判定胜负。

## 2. 本地固定文件

`grid-analysis-lab/rkb-rekordbox-benchmark/` 只保留这些长期有用产物：

- `intake-current-truth.json`：新样本 Rekordbox truth 暂存队列，双 provider 共享。
- `rekordbox-current-truth.json`：唯一长期 Rekordbox truth 源，双 provider 共享。
- `frkb-beatthis-current-latest.json`：`beatthis` 对主 truth 的全量 benchmark。
- `frkb-beatthis-classification-current.json`：`beatthis` 当前分类。
- `frkb-beatthis-sample-regression-latest.json`：从 `beatthis` classification 派生的通过集视图。
- `frkb-beatthis-grid-failures-current-latest.json`：从 `beatthis` classification 派生的失败集视图。
- `frkb-beatthis-grid-failures-current-manifest.json`：`beatthis` 当前失败聚类清单。
- `frkb-classic-current-latest.json`：`classic` 对主 truth 的全量 benchmark。
- `frkb-classic-classification-current.json`：`classic` 当前分类。
- `frkb-classic-sample-regression-latest.json`：从 `classic` classification 派生的通过集视图。
- `frkb-classic-grid-failures-current-latest.json`：从 `classic` classification 派生的失败集视图。
- `frkb-classic-grid-failures-current-manifest.json`：`classic` 当前失败聚类清单。
- `beatthis-prediction-cache/`：BeatThis 可复用预测缓存。

这些文件只表达当前本机样本库状态；数量以 JSON 实际内容为准，不写进仓库文档。
新增 provider 时沿用 `frkb-<provider>-...` 命名，禁止新增无 provider 作用域的
benchmark/classification 文件。

不保留 `*.progress.json`、临时 shard 目录、`targeted-*`、`try-*`、`diag-*`、
随手命名的 `after-*`、以及任何未在本节列出的 benchmark JSON。需要复查时重新跑。

## 3. 音频目录

两套 provider 的音频目录必须按 provider 命名空间隔离：

```text
D:/FRKB_database-B/library/FilterLibrary/beatthis/new
D:/FRKB_database-B/library/FilterLibrary/beatthis/sample
D:/FRKB_database-B/library/FilterLibrary/beatthis/grid-failures-current

D:/FRKB_database-B/library/FilterLibrary/classic/new
D:/FRKB_database-B/library/FilterLibrary/classic/sample
D:/FRKB_database-B/library/FilterLibrary/classic/grid-failures-current
```

每个 provider 内部目录语义一致：

- `new`：从 Rekordbox `test` 曲目源路径复制出来、尚未按该 provider 分类的新样本。
- `sample`：该 provider 当前 classification = `pass` 的音频。
- `grid-failures-current`：该 provider 当前 classification != `pass` 或 benchmark error 的音频。

旧的无作用域目录不再属于正式工作流：

```text
D:/FRKB_database-B/library/FilterLibrary/new
D:/FRKB_database-B/library/FilterLibrary/sample
D:/FRKB_database-B/library/FilterLibrary/grid-failures-current
```

迁移旧目录时必须执行 `copy -> verify -> delete old dirs`：

1. 旧 `new/sample/grid-failures-current` 原样复制到 `beatthis/new/sample/grid-failures-current`，
   因为旧状态本来就是 BeatThis 的分类结果。
2. 旧 `new`、旧 `sample`、旧 `grid-failures-current` 的完整样本全集复制到 `classic/new`。
3. `classic/sample` 和 `classic/grid-failures-current` 初始化为空。
4. 复制校验通过后，才允许删除旧无作用域目录。

同一 provider 内，同一首歌不能同时存在于 `new`、`sample`、`grid-failures-current`
多个目录。跨 provider 允许存在同名音频，因为它们表达的是不同 analyzer 的独立分类状态。
目录是 classification 的派生状态，不是真值来源。

## 4. 新样本闭环

新增样本必须走完整闭环：

1. 把新歌加入 Rekordbox `test` playlist，让 Rekordbox 完成分析。
2. 人工删除 Rekordbox 自己也失败、不可信、或音频缺失的曲目。
3. 从 Rekordbox `test` 读取曲目源路径，把主 truth 里没有的新音频同时复制到：
   `beatthis/new` 和 `classic/new`。
4. 抓取 Rekordbox truth 到 `intake-current-truth.json`；已在主 truth 里的重复样本默认跳过，
   不进入 intake。重复判定至少包含 `fileName`，以及保守的 `title + artist + BPM`
   元数据匹配。
5. 确认 `intake-current-truth.json` 与两个 provider 的 `new` 目录音频一一对应。
6. 把 intake 合入 `rekordbox-current-truth.json`，同时清空 intake。
7. 分别跑 `beatthis` 和 `classic` 的 current benchmark。
8. 分别生成 `beatthis` 和 `classic` 的 classification 与派生视图。
9. 每个 provider 按自己的 classification 同步自己的音频目录：
   `pass -> sample`，其他 -> `grid-failures-current`。
10. 清理 Rekordbox `test` 中已处理曲目。

truth 入库后，后续算法优化只更新对应 provider 的 benchmark、classification
和音频派生状态，不再搬 truth，也不得覆盖另一套 provider 的状态。

## 5. 算法优化闭环

优化算法时按这个顺序验收：

1. 用当前 provider 的失败清单定位稳定失败类型。
2. 设计低维、通用、可解释的 Rekordbox-compatible prior。
3. 跑针对性排查，但临时输出用完即删。
4. 跑当前 provider 的全量 `current` benchmark。
5. 重建当前 provider 的 classification 和派生视图。
6. 同步当前 provider 的 `sample` / `grid-failures-current`。
7. 检查通过集是否回归、失败集是否改善、是否引入新失败类型。
   必须固定输出 `pass -> fail`、`fail -> pass` 和分类迁移；默认不接受新的
   `pass -> fail`，除非能明确证明只是分类暴露而非 analyzer 退化。
8. 只有稳定跨样本重复的机制才允许合并。

跨 provider 比较时，必须用同一份 `rekordbox-current-truth.json` 和同一批音频全集：

- `beatthis` 和 `classic` 都只读取自己的 provider 目录。
- 对比只看各自 provider-scoped JSON 之间的迁移。
- 任何 provider 的 pass/fail 都不能写回 Rekordbox truth。
- 长期胜出选择不属于日常闭环；真正切换时再做一次性运行态默认 provider 变更。

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

当前可接受的低维 prior 示例：

- 最终 timeline 整数毫秒仲裁：只对 `firstBeatMs + offsetMs` 做整数毫秒量化，
  最大只允许移动 `0.5ms`，并同步更新 `absoluteFirstBeatMs`、
  `anchorCorrectionMs`，跨整拍时再同步 `barBeatOffset`。

这类 prior 只修 2ms 阈值附近的时间轴量化误差，不得改 BPM 候选选择、
不得读取 truth/benchmark 标签，也不得演变成逐曲补丁表。

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

analyzer 中间结果允许 `firstBeatMs < 0`。负值表示按当前 BPM 和相位外推，
某条等价拍线落在 decoded sample 0 之前。候选、缓存、benchmark 归一化阶段不能提前丢弃。

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

从 Rekordbox `test` playlist 复制新增音频到两个 provider 的 `new`：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "test" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "test"
```

抓取 Rekordbox `test` playlist 到共享 intake：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/capture_rekordbox_playlist_truth.py" --playlist "test"
```

这一步默认校验两个 provider 的 `new` 目录，并跳过已经存在于
`rekordbox-current-truth.json` 的曲目，避免重复样本重新进入闭环。

合入主 truth 并清空 intake：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/merge_rekordbox_truth_intake.py" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/merge_rekordbox_truth_intake.py" --clear-intake
```

跑全量当前 benchmark：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --profile current --analyzer beatthis --jobs 4
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --profile current --analyzer classic --jobs 4
```

默认输出：

```text
frkb-beatthis-current-latest.json
frkb-classic-current-latest.json
```

生成 classification 和派生视图：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/build_frkb_current_classification.py" --analyzer beatthis
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/build_frkb_current_classification.py" --analyzer classic
```

按各自 classification 同步各自音频目录：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_frkb_classification_audio_dirs.py" --analyzer beatthis --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_frkb_classification_audio_dirs.py" --analyzer beatthis

& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_frkb_classification_audio_dirs.py" --analyzer classic --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_frkb_classification_audio_dirs.py" --analyzer classic
```

迁移旧无作用域目录：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/migrate_frkb_provider_audio_dirs.py" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/migrate_frkb_provider_audio_dirs.py"
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/migrate_frkb_provider_audio_dirs.py" --delete-old --confirm-delete-old
```

第三条只有在复制和校验都通过后才允许执行。

临时排查单曲或子集：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --profile current --analyzer beatthis --jobs 4 --only "artist or title substring" --output "grid-analysis-lab/rkb-rekordbox-benchmark/diagnostic-local-beatthis.json"
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --profile current --analyzer classic --jobs 4 --only "artist or title substring" --output "grid-analysis-lab/rkb-rekordbox-benchmark/diagnostic-local-classic.json"
```

`diagnostic-local*.json` 只是临时排查文件，用完删除，不进入保留清单。

Python 编译检查：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" -m py_compile "scripts/frkb_provider_paths.py" "scripts/beat_this_bridge.py" "scripts/classic_beat_grid_bridge.py" "scripts/beat_this_phase_arbitration.py" "scripts/beat_this_phase_rescue.py" "scripts/beat_this_grid_rescue.py" "scripts/beat_this_full_logit_rescue.py" "scripts/benchmark_rkb_rekordbox_truth.py" "scripts/capture_rekordbox_playlist_truth.py" "scripts/sync_rekordbox_playlist_audio.py" "scripts/run_parallel_rkb_rekordbox_benchmark.py" "scripts/merge_rekordbox_truth_intake.py" "scripts/build_frkb_current_classification.py" "scripts/sync_frkb_classification_audio_dirs.py" "scripts/migrate_frkb_provider_audio_dirs.py"
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

## 14. 运行态切换

运行态默认 analyzer provider 是 `beatthis`。

开发版和 RC 版可以在设置 dialog 中切换：

- `beatthis`
- `classic`

切换后新分析结果必须带上对应 `beatGridAnalyzerProvider` 和 provider 自己的
`beatGridAlgorithmVersion`。缓存验收必须检查 provider；`beatthis` 的缓存不能被
`classic` 复用，反过来也一样。

正式版不展示切换入口，继续使用默认 `beatthis`。

## 15. 交接摘要

```text
唯一长期 truth = rekordbox-current-truth.json。
共享 intake = intake-current-truth.json。
grid-analysis-lab/ 是本地样本分析工作区，不提交 truth、benchmark 或 classification 派生数据。
beatthis 和 classic 是两套长期独立 provider 管线，只共享 Rekordbox truth。
新增音频由 sync_rekordbox_playlist_audio.py 从 Rekordbox test 源路径同时复制到 beatthis/new 和 classic/new。
已有主 truth 的重复样本会被跳过；新 truth 进入 intake-current-truth.json，确认后合入主 truth 并清空 intake。
所有 FRKB benchmark / classification / latest / manifest 必须使用 frkb-<provider>-... 命名。
beatthis 音频只在 beatthis/new、beatthis/sample、beatthis/grid-failures-current 内流转。
classic 音频只在 classic/new、classic/sample、classic/grid-failures-current 内流转。
旧无作用域 new/sample/grid-failures-current 只用于一次性迁移，迁移顺序是 copy -> verify -> delete old dirs。
算法优化只更新当前 provider 的 classification 和音频派生状态，不搬 truth，不覆盖另一套 provider 状态。
新增 prior 必须低维、通用、可解释，禁止身份特判和逐曲补丁。
每次优化都要固定检查 pass -> fail、fail -> pass 和分类迁移，防止失败集优化反向伤到成功集。
允许结构性大改；大改也必须由失败聚类驱动，并通过对应 provider 的全量 current benchmark 验收。
临时 benchmark 输出用完即删。
修改代码后必须跑 py_compile、相关 benchmark、npx vue-tsc --noEmit。
```
