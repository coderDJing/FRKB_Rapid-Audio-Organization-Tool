# RKB Beatgrid 下一次会话交接

## 当前仓库状态

- 仓库：`D:\playground\FRKB_Rapid-Audio-Organization-Tool-5`
- 分支：`main`
- 已推送到：`origin/main`
- 核心诊断提交：`62b643f3 feat(rkb): 增加 beatgrid 诊断与 sealed 验收入口`

## 当前算法接入状态

`constant-grid-dp` 验收链路已接入 locked rising-edge ranker、保守的 legacy integer BPM snap、rank1 material legacy weakness switch、rank1 structural phase switch、head near-zero switch，以及 rank1 negative legacy score switch。六者都走同一套 solver 入口，已覆盖 Electron 实时分析路径。

当前 `scripts/rkb_constant_grid_dp_solver.py` 版本：

```text
constant-grid-dp-cache-v3-locked-rising-edge-ranker-integer-bpm-snap-rank1-material-legacy-weakness-v3-rank1-structural-phase-v2-rank1-negative-legacy-score-v1-head-near-zero-v1
```

接入边界：

- 已接入：`scripts/rkb_constant_grid_dp_solver.py`
- 新增冻结模型：`scripts/rkb_locked_phase_ranker.py`
- 新增 selection 辅助模块：`scripts/rkb_constant_grid_dp_selection.py`
- 已验证链路：`scripts/run_parallel_rkb_rekordbox_benchmark.py --solver constant-grid-dp`
- benchmark 输出原子写已加 Windows `PermissionError` 短重试，避免杀毒/索引器短暂占用目标 JSON 时丢掉已完成 shard 合并结果。
- 运行时接入：`scripts/beat_this_bridge.py` 通过 `scripts/beat_this_runtime_constant_grid.py` 现场构造同形 metadata/arrays，然后调用同一套 `constant-grid-dp + locked ranker`。
- 运行时保护：`_analyze_prepared_windows_to_track_result` 默认仍不启用 runtime constant-grid，Electron bridge 仅在 `gridSolverPolicy != "off"` 时启用，避免 feature-cache 生成 legacyGridSolver 时递归污染。
- 打包资源：`package.json` 与 `electron-builder.yml` 已补充 `beat_this_runtime_constant_grid.py`、`benchmark_rkb_rekordbox_truth.py`、`rkb_*.py` 到 `demucs/bootstrap`。
- `pnpm run build:unpack` 已验证 unpacked package，`dist/win-unpacked/resources/demucs/bootstrap` 内包含 runtime constant-grid 依赖。

当前生产回归口径：

- current：`706 / 931 = 75.83%`，error `0`
- blind：`436 / 608 = 71.71%`，error `0`
- latest `test353` sealed-intake batch：`224 / 353 = 63.46%`，error `0`
- rank1 negative legacy score 相比 baseline：current `702 -> 706`，blind `436 -> 436`，
  latest `test353` 批次 `222 -> 224`；current/blind/latest `test353` 逐曲 diff 没有 `pass -> fail`。
- head near-zero 相比 structural phase v2：current `702 -> 702`，blind `435 -> 436`，latest `test`
  批次 `212 -> 215`；current/blind/latest `test` 逐曲 diff 没有 `pass -> fail`。
- structural phase v2 相比 v3：current `696 -> 702`，blind `432 -> 435`，latest `test`
  批次 `230 -> 231`；current/blind 逐曲 diff 没有 `pass -> fail`。
- `frkb-current-latest.json` 已按 current `706 / 931` 重跑；`frkb-classification-current.json`、
  sample/failure 派生视图已刷新到 current `706 / 931`。
- FRKB-5 正式开发音乐库固定为 `D:/FRKB_database-E`；B 只作为历史来源，不再作为脚本默认目标。
- 音乐库长期保留 5 个音频歌单：`new`、`sample`、`grid-failures-current`、
  `blind-rekordbox-truth`、`sealed-eval`；`sealed-intake` 是唯一固定临时入口。
- current 音频目标分布：`new = 0`，`sample = 706`，`grid-failures-current = 225`；
  `sync_frkb_classification_audio_dirs.py --dry-run` 必须为 `moveCount = 0`。
- current 命中：`Aftertime - Franky Wah.mp3`，`124.035116 -> 124.0 BPM`，`bpm -> pass`
- old sealed/test integer BPM snap 命中：`Kosheen & Kasia - Catch (Extended Mix).mp3`，
  `131.98 -> 132.0 BPM`，`bpm -> pass`
- rank1 material legacy weakness v3 命中：
  - current：`A.D.O.R. - Young World (Smokey Bubblin' B Re.mp3`，`firstBeatMs 259.886 -> 248.886`
  - current：`Will Clarke feat. House Gospel Choir - Weekend Love (Extended Mix) (1).mp3`
  - current：`KC Lights,Leo Stannard - Daydreamer (Extende.mp3`
  - blind：`VITO (UK), Marian (BR) - Simple Things (Original Mix).flac`，`firstBeatMs 190.0 -> 170.0`
  - blind：`Patrick Scuro - Supersonic (Extended Mix).mp3`，`firstBeatMs 80.0 -> 46.943`
  - latest `test`：`Ray Okpara - Brainows (Alvaro Medina Remix).mp3`，`firstBeatMs 301.943 -> 283.943`
  - latest `test`：`Tonco - Burned Down (Original Mix).mp3`
- rank1 structural phase v2 新增 pass 命中：
  - current：`Cristoph - Vanquish （Original Mix）.mp3`
  - current：`Nightcrawler - ZHU.mp3`
  - current：`Yukede - Me Encanta Bailar (Original Mix) (1).mp3`
  - current：`Mother City (Extended Mix) - Gil Glaze.mp3`
  - current：`Revered (Original Mix) - EDX.mp3`
  - current：`Theo Kottis - Onda (Extended Mix).mp3`
  - blind：`Rene Wise - Granite Skin (Original Mix).mp3`
  - blind：`Fiona Zanetti - Trust The Process (Original Mix).mp3`
  - blind：`Pr0xima - Devolver (Original Mix).mp3`
  - latest `test`：`Oliver Koletzki - It's All Gone (Original Mix).mp3`

head near-zero 规则：

- 只在 baseline 仍是 `constant-grid-dp:legacy-fallback`，且普通 locked ranker、rank1 material legacy weakness、rank1 structural phase 都未切换时生效。
- 要求 legacy weakness score `>= 0.2`。
- 要求候选池 rank1 的 `firstBeatMs > 90ms`，表示高分候选明显没有贴近音频头部。
- 只在 top8 内寻找候选，要求候选 `firstBeatMs <= 8ms`、与 rank1 分差 `<= 0.08`、与 legacy BPM 差 `<= 0.5`、bar offset mod4 与 rank1 相同，且来源必须包含 `window-beat-leading-edge`。
- 不使用 `fileName`、artist/title/path、truth、benchmark category、pass/fail 或 split identity。
- guard 标记为 `constant-grid-dp-head-near-zero-switch`。
- 这轮是在已消耗 `test327` 上形成的开发回归优化；current/blind 不退只是回归证据，不是新的 sealed 泛化证明。

legacy integer BPM snap 规则：

- 只在最终选择仍是 `constant-grid-dp:legacy-fallback` 时生效。
- 只把距离整数 `<= 0.04 BPM` 的 legacy BPM 量化到最近整数。
- 不使用 `fileName`、artist/title/path、truth、benchmark category、pass/fail 或 split identity。
- guard 标记为 `legacy-fallback-integer-bpm-snap`。
- 这轮结果只能算已见过集合上的保守回归，不是新的 sealed 泛化证明。

rank1 material legacy weakness 规则：

- 只在 baseline 仍是 `constant-grid-dp:legacy-fallback`，且普通 locked ranker 未切换时生效。
- 只看候选池 rank1，不从 top16 里挑最高概率候选。
- 要求 rank1 的 `lockedRisingEdgeRankerProbability >= 0.9`。
- 要求 legacy `legacyGridSolverScore <= 2.6`。
- 要求 rank1 与 legacy 的相位差 `> 5ms`，避免把已 pass 的小误差样本换成另一个等价 pass 网格。
- 不使用 `fileName`、artist/title/path、truth、benchmark category、pass/fail 或 split identity。
- guard 标记为 `constant-grid-dp-rank1-locked-legacy-weakness-switch`。
- 这轮是在 `test` 已消耗后的开发回归优化，不是新的 sealed 泛化证明；`2.6` 是 v3
  的窄边界，不能继续贴着样本往上拧。

rank1 structural phase v2 规则：

- 只在 baseline 仍是 `constant-grid-dp:legacy-fallback`，且普通 locked ranker 与
  rank1 material legacy weakness 都未切换时生效。
- 只看候选池 rank1，不从 topN 里挑候选。
- 主分支要求 rank1 的 `lockedRisingEdgeRankerProbability >= 0.86`。
- 低概率高证据分支只允许 `0.85 <= probability < 0.86`，并额外要求
  `score >= 0.88`、`downbeatMargin >= 0.5`。
- 要求 legacy `legacyGridSolverScore <= 6.0`。
- 要求 rank1 与 legacy 的相位差 `> 15ms`，避免 Cherry 这类已 pass 小相位差样本被换成 downbeat。
- 要求 rank1 与 legacy BPM 差 `<= 0.08`，bar offset mod4 相同。
- 要求 rank1 `score >= 0.8`、`downbeatRank == 0`、`downbeatMargin >= 0.1`。
- 不使用 `fileName`、artist/title/path、truth、benchmark category、pass/fail 或 split identity。
- guard 标记为 `constant-grid-dp-rank1-structural-phase-switch`。
- 这是在 current/blind/latest `test` 已看过数据上形成的结构性开发假设；只能算回归收益，
  不能包装成新的 sealed 泛化证明。

rank1 negative legacy score 规则：

- 只在 baseline 仍是 `constant-grid-dp:legacy-fallback`，且普通 locked ranker、
  rank1 material legacy weakness、rank1 structural phase 和 head near-zero 都未切换时生效。
- 只看候选池 rank1，不从 topN 里挑候选。
- 要求 legacy `legacyGridSolverScore <= 0.0`。
- 要求 rank1 `score >= 0.85`，`phasePathScore >= 0.8`。
- 要求 rank1 与 legacy 的相位差 `> 5ms`，BPM 差 `<= 0.08`，bar offset mod4 相同。
- 要求 rank1 `downbeatRank == 0`。
- 不使用 `fileName`、artist/title/path、truth、benchmark category、pass/fail 或 split identity。
- guard 标记为 `constant-grid-dp-rank1-negative-legacy-score-switch`。
- 这是在 test353 已跑完后形成的窄边界开发回归；current/blind 不退只是回归证据，
  不能包装成新的 sealed 泛化证明。

## latest `test353` 批次结果

当前 Rekordbox `test` 歌单重新抓取后得到 353 首。音频已经复制到 `sealed-intake`，本轮
`sync_rekordbox_playlist_audio.py --dry-run` 为 `copyCount = 353`、`skippedCount = 0`，
随后已执行复制。feature cache 已生成，summary indexed 353。这批已经用于
rank1 negative legacy score 开发回归，后续只能当普通回归集。

产物路径：

- truth：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/rekordbox-sealed-truth-test353.json`
- audio：`D:/FRKB_database-E/library/FilterLibrary/sealed-intake`
- feature cache：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/feature-cache-test353`
- baseline benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp-test353.json`
- rank1 negative legacy score benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp-test353-rank1-negative-legacy-score.json`

production benchmark：

- baseline：`222 / 353 = 62.89%`
- rank1 negative legacy score selected：`224 / 353 = 63.46%`
- errorTrackCount：`0`
- category：`pass 224`，`first-beat-phase 82`，`downbeat 17`，`bpm 17`，
  `half-or-double-bpm 12`，`grid-drift 1`
- candidate oracle：`338 / 353 = 95.75%`
- oracle selected fail：`114`
- guard 计数：`legacy-fallback-low-confidence 312`，
  `constant-grid-dp-rank1-negative-legacy-score-switch 5`，
  `constant-grid-dp-head-near-zero-switch 5`，`constant-grid-dp-conservative-switch 13`，
  `constant-grid-dp-phase-evidence-switch 6`，
  `constant-grid-dp-locked-rising-edge-ranker 5`，`legacy-fallback-integer-bpm-snap 4`，
  `constant-grid-dp-rank1-structural-phase-switch 2`，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch 1`

rank1 negative legacy score 触发结果：

- latest test353：5 次触发，2 首 `fail -> pass`，2 首 `first-beat-phase -> downbeat`，0 首 `pass -> fail`。
- current：6 次触发，4 首 `fail -> pass`，0 首 `pass -> fail`。
- blind：1 次触发，`first-beat-phase -> downbeat`，0 首 pass gain/loss。

结论：test353 是新鲜样本进入时的 sealed 验收结果，但它随后已经参与 rank1 negative legacy score
规则形成，所以现在只能算 consumed sealed regression，不再是 fresh 泛化证明。下一次泛化证明必须来自
另一批全新 Rekordbox playlist。

## latest `test327` 批次结果

当前 Rekordbox `test` 歌单重新抓取后得到 327 首。音频已经在 `sealed-intake`，本轮
`sync_rekordbox_playlist_audio.py --dry-run` 为 `copyCount = 0`、`skippedCount = 327`。
这批已经用于 head near-zero 开发回归，后续只能当普通回归集。

产物路径：

- truth：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/rekordbox-sealed-truth-test327.json`
- audio：`D:/FRKB_database-E/library/FilterLibrary/sealed-intake`
- feature cache：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/feature-cache-test327`
- baseline benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp-test327.json`
- head near-zero benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp-test327-head-near-zero.json`

production benchmark：

- structural phase v2 baseline：`212 / 327 = 64.83%`
- head near-zero selected：`215 / 327 = 65.75%`
- errorTrackCount：`0`
- category：`pass 215`，`first-beat-phase 65`，`downbeat 26`，`bpm 8`，
  `half-or-double-bpm 13`
- candidate oracle：`316 / 327 = 96.64%`
- oracle selected fail：`101`
- guard 计数：`legacy-fallback-low-confidence 281`，`constant-grid-dp-head-near-zero-switch 6`，
  `constant-grid-dp-locked-rising-edge-ranker 19`，`legacy-fallback-integer-bpm-snap 6`，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch 3`，
  `constant-grid-dp-phase-evidence-switch 5`，`constant-grid-dp-conservative-switch 4`，
  `constant-grid-dp-rank1-structural-phase-switch 3`

head near-zero 新增 pass：

- `Chiodan - Persoana.mp3`
- `Crankdat & NGHTMRE - TYPE SHIT  (Spritzur Ed.wav`
- `JayJay - Cinema (master).wav`

## previous `test-new-357` 批次结果

用户再次提供 Rekordbox `test` 歌单样本后，本轮按固定 sealed-intake 流程完成摄取、truth、
feature cache 和 production benchmark。注意：本批在 v3 边界优化中已经被消耗，后续只能当普通回归集。

样本摄取：

- `test` 歌单总数：`357`
- 复制到 `sealed-intake`：`357`
- 跳过：`0`
- truth 曲目数：`357`
- feature cache：`357 / 357`，`indexedFeatureCount = 732`

产物路径：

- truth：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/rekordbox-sealed-truth.json`
- audio：`D:/FRKB_database-E/library/FilterLibrary/sealed-intake`
- feature cache：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/feature-cache`
- production benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp.json`
- pre-v3 locked replay：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/phase-ranker-rising-edge-locked-replay-new357.json`

production benchmark：

- v2 baseline：`229 / 357 = 64.15%`
- v3 selected：`230 / 357 = 64.43%`
- structural phase v2 selected：`231 / 357 = 64.71%`
- errorTrackCount：`0`
- category：`pass 231`，`first-beat-phase 102`，`downbeat 14`，`bpm 7`，
  `half-or-double-bpm 2`，`grid-drift 1`
- candidate oracle：`343 / 357 = 96.08%`
- oracle selected fail：`112`
- guard 计数：`legacy-fallback-low-confidence 336`，
  `constant-grid-dp-locked-rising-edge-ranker 8`，`constant-grid-dp-conservative-switch 6`，
  `legacy-fallback-integer-bpm-snap 3`，
  `constant-grid-dp-rank1-structural-phase-switch 1`，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch 2`，
  `constant-grid-dp-phase-evidence-switch 1`

v3 只新增一首命中：

- `Ray Okpara - Brainows (Alvaro Medina Remix).mp3`
- baseline：`first-beat-phase`
- v3：`pass`
- rank1 probability：`0.928914`
- legacyGridSolverScore：`2.567555`
- firstBeatMs：`301.943 -> 283.943`

structural phase v2 在 latest `test` 上仍只新增这一首命中：

- `Oliver Koletzki - It's All Gone (Original Mix).mp3`
- baseline：`first-beat-phase`
- v1：`pass`
- rank1 probability：`0.873181`
- legacyGridSolverScore：`-1.831621`
- phaseDeltaAbsMs：`66.0`
- downbeatMargin：`0.67153`

这次还复查了两条危险方向：

- 直接降低 locked ranker `0.93` 阈值不安全；`0.9289` 已经会在 current 触发
  `Badman Style - Guy Davidov, Nettta M2.wav` 的 `pass -> downbeat`。
- 简单 half/double BPM switch 不安全；扫描会把 current/blind/new357 多首已通过样本打成
  `half-or-double-bpm`，不进 production。

结论：v3 / structural phase v2 都是已消耗 `test` 上的窄边界开发优化，不是新的 sealed
泛化证明。下一批要证明泛化，必须使用全新 playlist，且在跑之前锁住当前 production 规则。

## 当前候选假设

当前最值得复验的是：

```text
rising-edge locked ranker + legacy integer BPM snap + rank1 material legacy weakness + rank1 structural phase v2 + head near-zero + rank1 negative legacy score
```

当前 current/blind/latest test 回归结果：

- current：`685 -> 694 -> 695 -> 696 -> 701 -> 702 -> 702 -> 706`
- blind：`425 -> 430 -> 430 -> 432 -> 434 -> 435 -> 436 -> 436`
- old consumed test：`274 -> 277 -> 278 -> 279`
- latest test-new-357：`229 -> 230 -> 231`
- latest test327：`212 -> 215`
- latest test353：`222 -> 224`
- 全 split：`pass -> fail = 0`

current/blind 本身仍不是生产提升证明，因为它是在看过 current/blind 报告后形成的验后污染假设。
old consumed test、latest test-new-357、latest test327 与 latest test353 都已经被优化消耗，后续只能作为普通回归集使用。要证明
integer BPM snap、rank1 material legacy weakness v3、rank1 structural phase v2、head near-zero 和
rank1 negative legacy score 的泛化，需要另一批全新 Rekordbox playlist 原样 sealed 复验。

不要把 locked ranker 阈值继续往下扫。本轮离线检查过，把 `0.93` 往 `0.90` 降会带来正向净增，但三套集合都会出现 `pass -> fail`；这条路目前不够干净。也不要改成 top16 best-prob switch；本次留下的是 rank1-only + material phase delta 的窄 guard。

本轮还离线检查了 v2 后残余空间：

- 继续把低概率高证据分支降到 `0.84` / `0.845`，不会新增 pass，只会把 blind 的
  `Sambo - Get Down (Original Mix).flac` 从 `bpm` 错改成 `first-beat-phase` 错；`0.848`
  以上没有残余变化。
- rank<=8 / topN structural selector 仍能在 current/blind/new357 的失败集中找到不少 passing
  candidate，但属于“从 topN 里验后挑像 truth 的候选”，无法用现有生产特征稳定区分错候选；
  没有 fresh sealed 前不进入 production。
- head near-zero 不是开放 topN selector；它只处理 rank1 明显远离头部、同 BPM/同 downbeat mod4
  里存在近头部 leading-edge 候选的窄场景。不要把它扩展成“top8 里挑最像 truth 的候选”。

## 下一批新样本要验证什么

结论先写死：现在必须要 fresh Rekordbox playlist。current、blind、latest test-new-357、latest test327
和 latest test353 都已经被
看过并参与过开发判断，继续用它们涨分只算回归，不算泛化。

下一批新样本只验证这些事：

1. 当前 production solver 是否能原样泛化：
   `locked rising-edge ranker + integer BPM snap + rank1 material legacy weakness v3 + rank1 structural phase v2 + head near-zero + rank1 negative legacy score`
   必须不改阈值、不改 guard、不重训，直接跑 sealed-eval。
2. `rank1 structural phase v2` 的低概率高证据分支和 `rank1 negative legacy score` 是否在 fresh 样本上仍是净正向：
   如果 `0.85 <= probability < 0.86` 的 switch 触发，要单独记录触发曲目、最终 category、
   `score`、`downbeatMargin`、`legacyGridSolverScore` 和相位差；不能看到结果后再调 `0.85`。
   如果 rank1 negative legacy score 触发，要单独记录 `score`、`phasePathScore`、
   `legacyGridSolverScore`、相位差、BPM 差和 `downbeatRank`；不能根据触发曲目现场改
   `0.85` / `0.8` / `0.0`。
3. current 已证伪方向在 fresh 上是否仍危险：
   locked ranker 阈值下调、rank<=8/topN selector、half/double BPM switch 都只能做离线诊断，
   不能进入 production。诊断目标是看是否出现新的结构性证据，不是挑一个当前批次最高分配置。
4. 剩余失败是否仍是 selector / phase 语义问题：
   同步记录 candidate oracle、`has passing candidate but scorer missed`、first-beat-phase/downbeat/bpm
   分布。如果 oracle 仍高而 selected 不涨，下一步应继续研究 phase evidence；如果 oracle 明显下降，
   才回到候选生成或 tempo 覆盖。
5. 音频与 classification 只在 production benchmark 完成后同步：
   fresh sealed 跑完先记录结果，确认无脚本错误，再决定是否归档；不要边跑边挪音频、删样本或挑歌。

新样本验收后的判断标准：

- 如果 production 原样在 fresh 上没有异常 error、guard 没有集中打坏明显通过样本，记录为泛化支持证据。
- 如果 `rank1 structural phase v2` 在 fresh 上出现明显负向，先把它标为待回滚候选，不要现场修阈值；
  需要再拿另一批 fresh 或做可解释结构证据后再改 production。
- 如果只有 rank<=8/topN 诊断涨分，仍然不许上线；那说明需要新结构特征，不是需要更会挑样本的 selector。

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
$sealedIntakeRoot = "D:/FRKB_database-E/library/FilterLibrary/sealed-intake"
$sealedArchiveRoot = "D:/FRKB_database-E/library/FilterLibrary/sealed-eval"
```

复制音频：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "$playlist" --target-root "$sealedIntakeRoot" --dry-run
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/sync_rekordbox_playlist_audio.py" --playlist "$playlist" --target-root "$sealedIntakeRoot"
```

抓取 Rekordbox truth：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/capture_rekordbox_playlist_truth.py" --playlist "$playlist" --audio-root "$sealedIntakeRoot" --output "$sealedRoot/rekordbox-sealed-truth.json"
```

生成 feature cache 和当前 production solver benchmark。当前 `constant-grid-dp` 已包含 locked ranker、
integer BPM snap、rank1 material legacy weakness v3、rank1 structural phase v2、head near-zero
和 rank1 negative legacy score；这一步就是主验收输出，不要在 sealed-eval 上现场改阈值：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_beatgrid_feature_cache.py" --truth "$sealedRoot/rekordbox-sealed-truth.json" --audio-root "$sealedIntakeRoot" --cache-dir "$sealedRoot/feature-cache" --prediction-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/beatthis-prediction-cache" --jobs 4 --device cpu
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/run_parallel_rkb_rekordbox_benchmark.py" --truth "$sealedRoot/rekordbox-sealed-truth.json" --audio-root "$sealedIntakeRoot" --output "$sealedRoot/frkb-sealed-constant-grid-dp.json" --solver constant-grid-dp --feature-cache-dir "$sealedRoot/feature-cache" --prediction-cache-dir "grid-analysis-lab/rkb-rekordbox-benchmark/beatthis-prediction-cache" --jobs 4 --device cpu
```

验收完成并记录 manifest 后，把本批音频从 `sealed-intake` 并入 `sealed-eval`，再清空
`sealed-intake`。下一批 fresh sealed 仍复用同一个 `sealed-intake`。

如需单独复核 locked rising-edge replay，可继续跑：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_phase_ranker_rising_edge_locked_replay.py" --sealed-name "$playlist" --sealed-benchmark "$sealedRoot/frkb-sealed-constant-grid-dp.json" --sealed-feature-cache "$sealedRoot/feature-cache" --output "$sealedRoot/phase-ranker-rising-edge-locked-replay.json"
```

## 禁止事项

- 不要在 current/blind 上继续扫阈值当证据。
- 不要根据 sealed-eval 现场改阈值、删歌、挑样本或重训选择规则。
- sealed-eval 跑完后就不再是 sealed，后续只能当普通回归数据。
- 不要按批次新建长期 sealed 歌单；fresh sealed 只进固定 `sealed-intake`，验收后归档到 `sealed-eval`。
- 禁止使用 `fileName`、`artist`、`title`、path、truth、benchmark error、pass/fail、split identity 做 solver/ranker 决策。
- 没有新样本时，可以继续找新的结构性 phase evidence，但不能报成真实准确率提升。

## 关键文档

- `drafts/rkb-rekordbox-truth-validation-workflow.md`
- `drafts/rkb-beatgrid-solver-pitfalls.md`

## 关键脚本

- `scripts/beat_this_bridge.py`
- `scripts/beat_this_runtime_constant_grid.py`
- `scripts/rkb_constant_grid_dp_solver.py`
- `scripts/rkb_constant_grid_dp_selection.py`
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
- old consumed test integrated sealed benchmark：locked ranker `277 / 377`，integer BPM snap
  `278 / 377`，`pass -> fail = 0`。
- integer BPM snap 回归：current `695 / 931`，blind `430 / 608`，old consumed test
  `278 / 377`，三套逐曲 diff 均 `pass -> fail = 0`。
- rank1 material legacy weakness v3 回归：current `696 / 931`，blind `432 / 608`，
  latest test-new-357 `230 / 357`，三套逐曲 diff 均 `pass -> fail = 0`。
- rank1 structural phase v2 回归：current `702 / 931`，blind `435 / 608`，
  latest test-new-357 `231 / 357`；current/blind 逐曲 diff 均 `pass -> fail = 0`。
- head near-zero 回归：current `702 / 931`，blind `436 / 608`，
  latest test327 `215 / 327`；current/blind/test327 逐曲 diff 均 `pass -> fail = 0`。
- rank1 negative legacy score 回归：current `706 / 931`，blind `436 / 608`，
  latest test353 `224 / 353`；current/blind/test353 逐曲 diff 均 `pass -> fail = 0`。
- current classification / sample-regression / grid-failures-current 派生视图已刷新到 `706 / 931`。
- E 音乐库 current 目标分布为 `new = 0`、`sample = 706`、`grid-failures-current = 225`，
  同步后 `sync_frkb_classification_audio_dirs.py --dry-run` 必须为 `moveCount = 0`。
- latest test-new-357 音频当前位于 `D:/FRKB_database-E/library/FilterLibrary/sealed-intake`，
  已消耗，不可再当 fresh sealed。
- latest test327 音频同样位于 `D:/FRKB_database-E/library/FilterLibrary/sealed-intake`，
  已消耗，不可再当 fresh sealed；下一批 fresh 前必须先归档/清空该临时入口。
- latest test353 音频同样位于 `D:/FRKB_database-E/library/FilterLibrary/sealed-intake`，
  已消耗，不可再当 fresh sealed；`sealed-intake` 当前共 1037 首。
- `scripts/rkb_phase_ranker_rising_edge_locked_replay.py` 的 pre-v3 latest test-new-357 回放为：
  current `696 -> 697`、blind `425 -> 432`、test-new-357 `229 -> 230`。
  v3 已把 test-new-357 的这 1 首纳入 production benchmark；这段只作为决策来源记录，不再是新泛化证据。
- Electron runtime smoke：三首 sealed 命中样本均切到 locked ranker，一首 pass 样本不切换。
