# RKB Beatgrid 下一次会话交接

## 当前仓库状态

- 仓库：`D:\playground\FRKB_Rapid-Audio-Organization-Tool-5`
- 分支：`main`
- 已推送到：`origin/main`
- 核心诊断提交：`62b643f3 feat(rkb): 增加 beatgrid 诊断与 sealed 验收入口`

## 当前算法接入状态

`constant-grid-dp` 验收链路已接入 locked rising-edge ranker，并已迁移到 Electron 实时分析入口。

当前 `scripts/rkb_constant_grid_dp_solver.py` 版本：

```text
constant-grid-dp-cache-v3-locked-rising-edge-ranker
```

接入边界：

- 已接入：`scripts/rkb_constant_grid_dp_solver.py`
- 新增冻结模型：`scripts/rkb_locked_phase_ranker.py`
- 已验证链路：`scripts/run_parallel_rkb_rekordbox_benchmark.py --solver constant-grid-dp`
- 运行时接入：`scripts/beat_this_bridge.py` 通过 `scripts/beat_this_runtime_constant_grid.py` 现场构造同形 metadata/arrays，然后调用同一套 `constant-grid-dp + locked ranker`。
- 运行时保护：`_analyze_prepared_windows_to_track_result` 默认仍不启用 runtime constant-grid，Electron bridge 仅在 `gridSolverPolicy != "off"` 时启用，避免 feature-cache 生成 legacyGridSolver 时递归污染。
- 打包资源：`package.json` 与 `electron-builder.yml` 已补充 `beat_this_runtime_constant_grid.py`、`benchmark_rkb_rekordbox_truth.py`、`rkb_*.py` 到 `demucs/bootstrap`。
- `pnpm run build:unpack` 已验证 unpacked package，`dist/win-unpacked/resources/demucs/bootstrap` 内包含 runtime constant-grid 依赖。

locked replay 的 current/blind sanity：

- current：`685 / 931 = 73.58%`
- blind：`425 / 608 = 69.90%`

## sealed-eval 结果（2026-05-08）

用户在 Rekordbox `test` 歌单新增样本后，已按锁死流程完成一次 sealed 验收。

样本摄取：

- `test` 歌单总数：`378`
- 已在 current truth 中存在并跳过：`1`
- 本轮 sealed truth 有效新增：`377`
- 被跳过旧样本：`Yanamaste - Evil (Original Mix).mp3`

产物路径：

- truth：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/rekordbox-sealed-truth.json`
- feature cache：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/feature-cache`
- production baseline：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp.json`
- locked replay：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/phase-ranker-rising-edge-locked-replay.json`
- integrated solver：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp-locked-ranker.json`

生产 baseline（constant-grid-dp）在 `test` sealed 上：

- baseline：`274 / 377 = 72.68%`

locked rising-edge hypothesis 在 `test` sealed 上：

- selected：`277 / 377 = 73.47%`
- net：`+3`
- fail -> pass：`3`
- pass -> fail：`0`
- 改善曲目：
  - `Alvaro Medina - This Sound (Original Mix).mp3`
  - `Meloko, Konvex (FR) & Garla - If U Ever (Original Mix).mp3`
  - `Kiko & Olivier Giacomotto - Making G's (Extended Mix).mp3`

接入 `constant-grid-dp` 后的 sealed benchmark：

- selected：`277 / 377 = 73.47%`
- errorTrackCount：`0`
- fail -> pass：`3`
- pass -> fail：`0`
- category delta：`first-beat-phase 80 -> 77`，其他失败类型不变
- 三首命中样本 ranker probability：
  - `Alvaro Medina - This Sound (Original Mix).mp3`：`0.954081355`
  - `Meloko, Konvex (FR) & Garla - If U Ever (Original Mix).mp3`：`0.958105093`
  - `Kiko & Olivier Giacomotto - Making G's (Extended Mix).mp3`：`0.960401998`

Electron runtime smoke：

- `Alvaro Medina - This Sound (Original Mix).mp3`：legacy `firstBeatMs=220.0`，runtime constant-grid `firstBeatMs=202.0`，guard=`constant-grid-dp-locked-rising-edge-ranker`，probability=`0.949674285`。
- `Meloko, Konvex (FR) & Garla - If U Ever (Original Mix).mp3`：runtime constant-grid `firstBeatMs=175.0`，guard=`constant-grid-dp-locked-rising-edge-ranker`，probability=`0.957195868`。
- `Kiko & Olivier Giacomotto - Making G's (Extended Mix).mp3`：runtime constant-grid `firstBeatMs=237.0`，guard=`constant-grid-dp-locked-rising-edge-ranker`，probability=`0.952505352`。
- `A.Paul - Reverie (Original).mp3`：legacy 与 runtime 都是 `142 BPM / firstBeatMs=0.0`，未切换，作为 pass 样本冒烟。
- runtime smoke 不读 sealed feature-cache，直接从 PCM 重算 logits/attack；概率和缓存 benchmark 有小数差异是预期内的路径差异。

同次 replay 的 current/blind sanity 仍为：

- current：`685 -> 694`
- blind：`425 -> 430`
- 全 split：`pass -> fail = 0`

结论：这次 `test` 是新 truth 上的正向 sealed 证据，不再只是 current/blind 验后污染回放。locked ranker 已按冻结规则接入 `constant-grid-dp`，并且 integrated solver 与 locked replay 结果一致。

## 当前候选假设

当前最值得复验的是：

```text
rising-edge + onset-foot locked hypothesis
```

当前 current/blind 回放结果：

- current：`685 -> 694`
- blind：`425 -> 430`
- 全 split：`pass -> fail = 0`

current/blind 本身仍不是生产提升证明，因为它是在看过 current/blind 报告后形成的验后污染假设。2026-05-08 的 `test` sealed 结果是该锁死假设的第一批新 truth 正向证据，且已通过集成后的 `constant-grid-dp` benchmark 复现。

## 下一步建议

不要继续在 current/blind 或已消耗的 `test` sealed 上扫阈值。

可选下一步：

- 若要发布安装包，继续跑 `pnpm run build:win`；当前已通过 unpacked package 验证，尚未生成安装器。
- 如果还想更保守，再让用户提供另一批全新 Rekordbox 歌单，按下面流程原样复验。不要复用 `test` 当 sealed。

拿到新的实际歌单名后，把它填入下面命令里的 `$playlist`，不要改阈值、不要现场挑歌、不要重训选择规则。

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

- `scripts/beat_this_bridge.py`
- `scripts/beat_this_runtime_constant_grid.py`
- `scripts/rkb_constant_grid_dp_solver.py`
- `scripts/rkb_locked_phase_ranker.py`
- `scripts/rkb_phase_ranker_rising_edge_locked_replay.py`
- `scripts/rkb_phase_ranker_rising_edge_diagnostic.py`
- `scripts/rkb_phase_ranker_diagnostic.py`
- `scripts/rkb_onset_foot_phase_diagnostic.py`
- `scripts/rkb_phase_semantics_diagnostic.py`
- `scripts/rkb_phase_trajectory_diagnostic.py`

## 已验证

- `py_compile` 通过。
- `beat_this_bridge` / `beat_this_runtime_constant_grid` import smoke 通过。
- `dist/win-unpacked/resources/demucs/bootstrap` packaged import smoke 通过。
- `package.json` 解析通过。
- `electron-builder.yml` 解析通过。
- `pnpm run build:unpack` 通过。
- `dist/win-unpacked/resources/demucs/bootstrap` 资源检查通过：`beat_this_runtime_constant_grid.py`、`rkb_constant_grid_dp_solver.py`、`rkb_locked_phase_ranker.py`、`benchmark_rkb_rekordbox_truth.py` 均存在。
- `npx vue-tsc --noEmit` 通过。
- `git diff --check` 通过（仅 Git CRLF 提示）。
- `scripts/rkb_phase_ranker_rising_edge_locked_replay.py` current/blind sanity check 跑通。
- `constant-grid-dp` integrated sealed benchmark：`277 / 377`，`pass -> fail = 0`。
- Electron runtime smoke：三首 sealed 命中样本均切到 locked ranker，一首 pass 样本不切换。
