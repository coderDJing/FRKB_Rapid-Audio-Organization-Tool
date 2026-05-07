# RKB Beatgrid 下一次会话交接

## 当前仓库状态

- 仓库：`D:\playground\FRKB_Rapid-Audio-Organization-Tool-5`
- 分支：`main`
- 已推送到：`origin/main`
- 核心诊断提交：`62b643f3 feat(rkb): 增加 beatgrid 诊断与 sealed 验收入口`

## 当前生产状态

生产 solver 没有切换到 rising-edge ranker。

当前生产仍是：

```text
constant-grid-dp phase evidence v2 + phasePath diagnostic
```

当前 5ms 成绩：

- current：`685 / 931 = 73.58%`
- blind：`425 / 608 = 69.90%`

## 当前候选假设

当前最值得复验的是：

```text
rising-edge + onset-foot locked hypothesis
```

当前 current/blind 回放结果：

- current：`685 -> 694`
- blind：`425 -> 430`
- 全 split：`pass -> fail = 0`

但这不是生产提升证明。它是在看过 current/blind 报告后形成的验后污染假设，只能等下一批新 truth
按锁死配置原样复验。

## 等用户提供的信息

下一次继续时，不要假设 Rekordbox 新样本歌单名。

只等用户明确说出实际歌单名，例如：

```text
新样本歌单叫 <实际 Rekordbox 歌单名>
```

拿到实际歌单名后，把它填入下面命令里的 `$playlist`，不要改阈值、不要现场挑歌、不要重训选择规则。

## sealed-eval 一次性验收流程

```powershell
$playlist = "<用户提供的实际 Rekordbox 歌单名>"
$sealedRoot = "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval"
```

复制音频：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "$playlist" --target-root "$sealedRoot/audio" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "$playlist" --target-root "$sealedRoot/audio"
```

抓取 Rekordbox truth：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/capture_rekordbox_playlist_truth.py" --playlist "$playlist" --audio-root "$sealedRoot/audio" --output "$sealedRoot/rekordbox-sealed-truth.json"
```

生成 feature cache 和 production baseline benchmark：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_beatgrid_feature_cache.py" --truth "$sealedRoot/rekordbox-sealed-truth.json" --audio-root "$sealedRoot/audio" --cache-dir "$sealedRoot/feature-cache" --prediction-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/beatthis-prediction-cache" --jobs 4 --device cpu
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --truth "$sealedRoot/rekordbox-sealed-truth.json" --audio-root "$sealedRoot/audio" --output "$sealedRoot/frkb-sealed-constant-grid-dp.json" --solver constant-grid-dp --feature-cache-dir "$sealedRoot/feature-cache" --prediction-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/beatthis-prediction-cache" --jobs 4 --device cpu
```

按 locked rising-edge hypothesis 原样复验：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_phase_ranker_rising_edge_locked_replay.py" --sealed-name "$playlist" --sealed-benchmark "$sealedRoot/frkb-sealed-constant-grid-dp.json" --sealed-feature-cache "$sealedRoot/feature-cache" --output "$sealedRoot/phase-ranker-rising-edge-locked-replay.json"
```

## 禁止事项

- 不要在 current/blind 上继续扫阈值当证据。
- 不要根据 sealed-eval 现场改阈值、删歌、挑样本或重训选择规则。
- sealed-eval 跑完后就不再是 sealed，后续只能当普通回归数据。
- 禁止使用 `fileName`、`artist`、`title`、path、truth、benchmark error、pass/fail、split identity 做 solver/ranker 决策。
- 没有新样本时，可以继续找新的结构性 phase evidence，但不能报成真实准确率提升。

## 关键文档

- `drafts/rkb-rekordbox-truth-validation-workflow.md`
- `drafts/rkb-beatgrid-solver-pitfalls.md`

## 关键脚本

- `scripts/rkb_phase_ranker_rising_edge_locked_replay.py`
- `scripts/rkb_phase_ranker_rising_edge_diagnostic.py`
- `scripts/rkb_phase_ranker_diagnostic.py`
- `scripts/rkb_onset_foot_phase_diagnostic.py`
- `scripts/rkb_phase_semantics_diagnostic.py`
- `scripts/rkb_phase_trajectory_diagnostic.py`

## 已验证

- `py_compile` 通过。
- `npx vue-tsc --noEmit` 通过。
- `git diff --check` 通过。
- `scripts/rkb_phase_ranker_rising_edge_locked_replay.py` current/blind sanity check 跑通。
