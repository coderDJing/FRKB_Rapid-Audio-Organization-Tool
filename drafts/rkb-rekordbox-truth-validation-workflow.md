# Rekordbox 真值验证工作流

## 1. 核心原则

Rekordbox 只作为外部真值来源，用来校准 FRKB 的 beat grid analyzer。FRKB
运行态不能依赖 Rekordbox，也不能用 Rekordbox truth 覆盖分析结果。

当前流程只维护一个长期 truth：

```text
grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-current-truth.json
```

`grid-analysis-lab/` 是本地分析工作区。truth、benchmark、classification
和失败清单都跟本机样本库绑定，不作为仓库可提交资产。历史上已跟踪的旧 JSON
即使继续出现在 `git status`，也不代表应该提交。

FRKB pass/fail 是当前算法状态，只存在于 classification 和派生 benchmark 视图中。
禁止再拆成 `sample truth` / `failure truth` 两份长期真值。

## 2. 本地固定文件

`grid-analysis-lab/rkb-rekordbox-benchmark/` 在本机只保留这些长期有用产物：

- `intake-current-truth.json`：新样本 Rekordbox truth 暂存队列。
- `rekordbox-current-truth.json`：唯一长期 Rekordbox truth 源。
- `frkb-current-latest.json`：当前算法对主 truth 的全量 benchmark，固定覆盖。
- `frkb-classification-current.json`：当前算法分类，决定每首歌属于 `sample` 还是 `grid-failures-current`。
- `sample-regression-latest.json`：从 classification 派生的当前通过集视图，固定覆盖。
- `grid-failures-current-latest.json`：从 classification 派生的当前失败集视图，固定覆盖。
- `grid-failures-current-manifest.json`：当前失败聚类清单，固定覆盖。
- `rkb-dataset-splits-current.json`：当前样本库的固定 cluster split。
- `rkb-dataset-splits-current-train-truth.json` / `rkb-dataset-splits-current-tune-truth.json` /
  `rkb-dataset-splits-current-holdout-truth.json`：由固定 split 派生的验证 truth。
- `frkb-current-baseline-before-candidate-solver.json`：candidate solver 切换期的旧方案对照。
- `beatthis-prediction-cache/`：可复用预测缓存。

这些文件只表达当前本机样本库状态；数量以 JSON 实际内容为准，不写进仓库文档。

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
   重复判定至少包含 `fileName`，以及保守的 `title + artist + BPM` 元数据匹配。
5. 确认 `intake-current-truth.json` 与 `new` 目录音频一一对应。
6. 把 intake 合入 `rekordbox-current-truth.json`，同时清空 intake。
7. 跑 `current` benchmark，生成 `frkb-current-latest.json`。
8. 生成 `frkb-classification-current.json` 和三个派生视图。
9. 按 classification 同步音频目录：`pass -> sample`，其他 -> `grid-failures-current`。
10. 清理 Rekordbox `test` 中已处理曲目。

truth 入库后，后续算法优化只更新 classification 和派生视图，不再搬 truth。

## 5. 算法优化闭环

当前阶段不再以新增 `rescue`、`arbitration` 或小型 prior 为主。继续在当前失败集上手搓
`if` 最多只能多救极少数样本，这不是普适算法，而是在给样本库化妆。

后续目标是把 analyzer 改成“多候选生成 + 统一打分器”的 grid solver：

1. analyzer 必须先生成多个完整 grid 候选，再由统一 scorer 选择最终结果。
2. 每个候选至少表达 `bpm`、`firstBeatMs`、`barBeatOffset`、time basis 语义、
   来源、候选内部一致性特征和可调试的中间证据。
3. `window`、`full-logit`、`attack-envelope`、`global-solver`、
   `stream-start/time-basis` 都作为候选来源，而不是串成一路救援链。
4. 现有 `rescue` / `arbitration` 逻辑只允许临时作为 legacy 候选来源或对照组，
   禁止继续扩展成最终决策分支。
5. scorer 只吃通用音频信号特征和候选自洽特征，禁止吃歌名、artist、路径、
   truth、benchmark 误差、pass/fail、失败清单或逐曲标签。
6. scorer 不能靠候选来源名称写死优先级；来源名称只用于调试、消融分析和报表归因。

优化算法时按这个顺序验收：

1. 先固定数据集切分，再调算法。至少保留训练/调参集和锁死 holdout。
2. 优先按失败类型、artist、source 或音频来源做 cluster split，避免同质样本同时出现在
   调参集和 holdout 中。
3. 先实现候选 dump 和 scorer 特征 dump，确认正确候选是否进入候选池。
4. 再调 scorer。调参只能在训练/调参集做，holdout 只在阶段性验收时打开。
5. 跑全量 `current` benchmark，重建 classification 和派生视图。
6. 固定输出分类迁移、`pass -> fail`、`fail -> pass`、BPM 大错率、phase 误差分布、
   downbeat 回归、候选命中率和 scorer 排名错误。
7. 默认不接受新的 `pass -> fail`，除非能明确证明只是评估暴露而非 analyzer 退化。
8. 只有跨 cluster 稳定成立、且 holdout 不退化的机制才允许合并。

失败样本只用于聚类、候选覆盖分析和验证泛化。禁止把失败样本当逐曲补丁来源。

允许结构性大改。现在的重点不是“再找一个 prior”，而是把 solver 分层拆清楚：

- candidate generator：尽可能召回合理 BPM / phase / downbeat / time-basis 候选。
- feature extractor：把候选和音频证据转成通用、可复现的特征。
- scorer：统一比较候选，输出最终 grid。
- benchmark reporter：报告候选覆盖、scorer 排名、最终输出和回归指标。

当前第一版 candidate solver 已落地，后续继续按这个结构演进：

- `scripts/beat_this_bridge.py` 负责收集 window、full-logit、attack-envelope、global-solver、
  stream-start/time-basis 和 legacy 输出等候选。
- `scripts/beat_this_candidate_solver.py` 负责提取候选自洽特征、音频信号特征和候选池共识特征，
  再统一打分选择最终 grid。
- `scripts/rkb_benchmark_*.py` 负责 benchmark 归一化、候选 oracle、summary 和回归指标。
- `scripts/build_rkb_rekordbox_dataset_splits.py` 负责生成固定 train / tune / holdout split。

旧方案输出只能作为候选或对照，不是兼容地板，也不能在最终选择阶段被特殊兜底。

如果失败聚类指向 solver 的结构性问题，应直接改对应层，而不是堆 prior：

- 候选池没有覆盖正确 BPM。
- 候选池有正确 BPM，但 phase 候选缺失。
- 候选池有正确 phase，但 downbeat 排名错误。
- time basis 候选生成错误或坐标语义混乱。
- 多窗口和 full-track 证据冲突，但 scorer 没有一致的比较标准。
- BeatThis 多窗口融合策略有系统偏差。
- phase solver 对 MP3 frame / decoded timeline 的抽象不干净。

判断规则：

- 正确候选没生成 -> 修 candidate generator。
- 正确候选生成了但分数低 -> 修特征或 scorer。
- 某类音频在训练集好、holdout 坏 -> 过拟合，回退该调参。
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
- 继续新增只服务当前失败清单的 `rescue` / `arbitration` 分支。
- 在同一批样本上反复调规则，再只用同一批样本的 pass 数证明有效。
- 让 scorer 读取 truth、误差、pass/fail、失败类型标签或候选来源名称来做决策。

没有歌名特判不代表没有过拟合。高维组合如果只服务极少数样本，也视为过拟合风险。

## 7. 候选来源与允许信号

允许引入 Rekordbox-compatible 候选和 scorer 特征，但必须描述机制，不描述样本。

允许的候选来源：

- BeatThis window raw beats / downbeats。
- full-track beat logits / downbeat logits。
- attack envelope / local onset 候选。
- 多窗口 BPM / phase 共识候选。
- global solver 从完整 beat 序列生成的候选。
- 音频格式时间轴候选：`stream.start_time`、`Skip Samples`、encoder tag。
- 现有 rescue / arbitration 的输出，只能作为 legacy 候选或消融对照。

允许 scorer 使用的通用特征：

- 候选 grid 对 beat logits 的对齐分数。
- 候选 downbeat 对 downbeat logits 的对齐分数。
- onset / attack envelope 在候选拍点附近的集中度和偏移分布。
- beat 序列残差、中位相位、MAD、局部漂移和离群点比例。
- 多窗口候选之间的 BPM、phase、downbeat 共识强度。
- 半速 / 倍速 BPM 关系证据，但不能靠曲名或来源特判。
- time basis 候选的坐标一致性和容器证据。
- downbeat margin、bar-level 周期稳定性和 4 拍相位一致性。

这些特征必须能从音频、模型输出或容器时间轴信号中复现。`source` 字段可以用于日志、
消融和错误归因，但不能成为 scorer 的身份特判。

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

生成固定数据集切分：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/build_rkb_rekordbox_dataset_splits.py" --write-truth-files
```

生成 classification 和派生视图：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/build_frkb_current_classification.py"
```

按 classification 同步音频目录：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_frkb_classification_audio_dirs.py" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_frkb_classification_audio_dirs.py"
```

临时排查单曲或子集：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --profile current --jobs 4 --only "artist or title substring" --output "grid-analysis-lab/rkb-rekordbox-benchmark/diagnostic-local.json"
```

`diagnostic-local.json` 只是临时排查文件，用完删除，不进入保留清单。

Python 编译检查：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" -m py_compile "scripts/beat_this_bridge.py" "scripts/beat_this_candidate_solver.py" "scripts/beat_this_phase_arbitration.py" "scripts/beat_this_phase_rescue.py" "scripts/beat_this_grid_rescue.py" "scripts/beat_this_full_logit_rescue.py" "scripts/beat_this_full_logit_utils.py" "scripts/beat_this_bpm_metrics.py" "scripts/beat_this_window_selection.py" "scripts/benchmark_rkb_rekordbox_truth.py" "scripts/rkb_benchmark_bridge_result.py" "scripts/rkb_benchmark_candidate_oracle.py" "scripts/rkb_benchmark_summary.py" "scripts/capture_rekordbox_playlist_truth.py" "scripts/sync_rekordbox_playlist_audio.py" "scripts/run_parallel_rkb_rekordbox_benchmark.py" "scripts/merge_rekordbox_truth_intake.py" "scripts/build_frkb_current_classification.py" "scripts/build_rkb_rekordbox_dataset_splits.py" "scripts/sync_frkb_classification_audio_dirs.py"
```

代码修改后必须运行：

```powershell
npx vue-tsc --noEmit
```

## 12. 缓存边界

允许长期缓存：

- BeatThis raw window predictions。
- full-track logits。
- attack envelope / local onset 序列。
- ffprobe 和容器时间轴证据。
- 与算法决策无关、同音频同模型必然相同的中间输出。

允许临时缓存：

- 候选 dump。
- scorer feature dump。
- 候选覆盖和 scorer 排名诊断。

临时缓存必须绑定 solver 版本或 run id，只能用于本轮排查和复现实验，不能作为跨算法版本的
验收结论。

禁止缓存：

- 最终 `bpm` / `firstBeatMs` / `barBeatOffset`。
- 最终被选中的候选。
- scorer 分数、排名或仲裁结果。
- benchmark pass/fail 结论。
- anchor 选择、phase rescue、downbeat 归一化后的最终结果。
- 任何混入 truth、benchmark 误差、pass/fail 或失败类型标签的特征。

判断标准：

```text
改 FRKB 网格求解算法或 scorer 后，缓存内容本身是否仍应完全相同？
```

如果答案不是明确的“是”，就不能作为跨算法版本复用的验收结论。

## 13. 人工复核

benchmark 失败时：

1. 在 FRKB raw waveform 上显示 Rekordbox truth grid。
2. 同轴显示 FRKB analyzer grid。
3. 同轴显示候选池中每个候选的 grid、score、排名和主要特征。
4. 判断失败属于候选缺失、scorer 排名错误、BPM 大错、phase 偏移、downbeat 错位、
   time basis 错位，还是 Rekordbox truth 本身错误。
5. 如果 Rekordbox truth 错，回 Rekordbox 修 grid，再重新生成 truth。
6. 如果正确候选缺失，修 candidate generator。
7. 如果正确候选存在但排名靠后，修 scorer 特征或权重。
8. 如果同类错误只在训练/调参集改善、holdout 退化，判定为过拟合。

不要在 FRKB 里手工写补偿把失败样本抹平。

## 14. 交接摘要

```text
唯一长期 truth = rekordbox-current-truth.json。
grid-analysis-lab/ 是本地样本分析工作区，不提交 truth、benchmark 或 classification 派生数据；旧的已跟踪 JSON 即使出现在 git status，也不纳入代码提交。
新增音频由 sync_rekordbox_playlist_audio.py 从 Rekordbox test 源路径复制到 new。
已有主 truth 的重复样本会被跳过；新 truth 进入 intake-current-truth.json，确认后合入主 truth 并清空 intake。
FRKB pass/fail 只存在于 frkb-classification-current.json 和派生 latest/manifest。
音频目录由 classification 派生：pass -> sample，其他 -> grid-failures-current。
算法优化只更新 classification，不搬 truth。
当前阶段停止继续堆小型 rescue/prior；analyzer 应重构为多候选生成 + 统一 scorer。
window、full-logit、attack-envelope、global-solver、stream-start/time-basis 都是候选来源。
scorer 只吃通用音频信号特征和候选自洽特征，禁止读取歌名、路径、truth、误差、pass/fail 或失败标签。
每次优化都要固定检查 pass -> fail、fail -> pass、分类迁移、BPM 大错率、phase 分布、downbeat 回归、候选覆盖和 scorer 排名错误。
调参必须有训练/调参集与锁死 holdout，最好按失败类型、artist 或 source 做 cluster split。
允许结构性大改；大改必须由候选覆盖、scorer 排名和失败聚类共同驱动，并通过全量 current benchmark 验收。
临时 benchmark 输出用完即删。
修改代码后必须跑 py_compile、相关 benchmark、npx vue-tsc --noEmit。
旧方案输出只能作为候选或对照，不能作为最终选择的兼容地板。
```
