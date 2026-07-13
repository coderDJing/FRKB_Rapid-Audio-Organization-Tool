# RKB Beatgrid 下一次会话交接

> 样本 intake 的现行流程以 [`分拣脚本.md`](./分拣脚本.md) 和
> [`准备好rkb新样本.md`](./准备好rkb新样本.md) 为准：`test` 分拣是 pre-review label QA；`review` 被用于
> 训练/调参后才成为 development。本文中任何“先对 test fresh prepare/evaluate，再分拣”的旧命令仅为
> 历史记录，禁止按其执行。

## 当前仓库状态

- 仓库：`D:\playground\FRKB_Rapid-Audio-Organization-Tool-5`
- 分支：`main`
- 已推送到：`origin/main`
- 核心诊断提交：`62b643f3 feat(rkb): 增加 beatgrid 诊断与 sealed 验收入口`

## 当前批次与验收状态

- 按现有归档批次记录，历史 `3745` 个样本实例全部 consumed；current、blind、test-new-357、
  test327、test353、test316 和旧 sealed/test 都不能再作为 fresh 泛化证明。
- 中央 registry 固定为
  `grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-registry.json`，必须先覆盖全部 3745 个
  consumed 实例，并为每条记录提供 `fileName`、`assetSha256`、稳定 exact `familyId`（或可验证
  PCM hash）、`batchId` 和 `batchStatus = consumed`。实例主键固定为
  `instanceId = normalized(batchId) + ":" + normalized(assetSha256)`；跨批同名允许，truth 只能在批内
  按 normalized `fileName` 连接。
  registry 未完成一次性导入和校验时，禁止开始新的 fresh sealed。
- split / LOBO 不能只按 exact `familyId`。必须先用 `scripts/rkb_audio_isolation_families.py` 的固定
  纯音频 policy 合并 exact family 和 Chromaprint 近重复录音，再按 `isolationFamilyId` / `batchId`
  分组；只按 exact family 生成的结果是 provisional development diagnostic，不是完整防泄漏证据。
- `new357` truth 是 current DB recovered reference，不是历史 frozen snapshot；它只允许
  diagnostic-only development replay，必须从 primary aggregate 排除，也不能充当 fresh proof。
- 用户人工操作保持 `Upan -> test -> needReview -> review`；`test` 和 `needReview` 每轮必须清空，
  `review` 可保留已 consumed 历史。新样本通过 report 的完整 roster 识别，不靠歌单名猜批次。
- 完整 `test` 批次分拣时先写 pre-review report，再把差异项移到 `needReview`。旧算法比对只服务于
  truth QA / 错误归因，不是产品低置信兜底，也不改变未来候选的证据资格。
- 人工确认后的 `review` 只能以 `prepare --reviewed-development --triage-report <report>` 封存为
  consumed development；它会做 approximate audio-isolation duplicate guard，缺强身份或近重复时 fail closed。
- registry baseline 已初始化，`import-consumed` 现已硬禁用；reviewed-development 是新增数据的唯一常规入口。
- 如果需要正式 fresh 证据，候选及其参数不得使用该批训练/调参。旧算法分拣本身不构成泄漏；一旦把 review
  批次纳入 development，就不能再用它验证使用过它的同一候选。
- 同一时刻只允许一个 fresh/evaluating/exposed 批次；存在活动批次或 `sealed-intake` 除
  `.frkb.uuid` 外仍有内容时，prepare 会拒绝，必须先 finalize 或清理。marker 是资料库节点身份，
  必须留在原目录；fresh/evaluating/exposed 记录也禁止进入
  development split。
- 历史 train/tune/holdout、LOBO holdout 和 new357 diagnostic 全部只属于 consumed development。
  根据任一旧 holdout 反复改模型、特征或阈值后，禁止再把它包装成“未触碰验证”；最终晋级只认
  下一批在 `prepare` 前锁死候选和门槛后的一次性 fresh evaluate。

当前 split v4 已实际生成并校验：

- 3745 instances、3735 exact families、3682 isolation families、7 batches。
- primary batches 6；diagnostic-only batch 1（`new357`）。
- `assignmentKey = sha256(canonical sorted component exactFamilyIds)`，不含 policy SHA；本次是稳定 assignment
  接入后的预期一次性 split 迁移，结果为 2249/773/723。
- `assignmentDigestSha256 = d3476f1551aa4c904e98e56d92ea30ed95b076c0e0272060e7ed79c8ece2909d`；
  `splitAssignmentsSha256 = 1b4289f908dfe031eb60ac53227ff5fe06de37cc4c072121a597a3ecd24f529f`。
- policy SHA-256：`e7e52a9df88ea17686bb7825c9ab017edbdf459dfe0a110cc65c2c5b1185be98`。
- 8135 个 coarse candidate pairs 接受 54 条近重复链接，形成 53 次 approximate union / 52 个
  approximate components；最大 component 3 个实例。
- v1 policy 固定为 SimHash strict majority（tie -> 0）、Hamming `<= 4`、density L1 `<= 3.0`、
  shift `[-120, 120]`、overlap `>= 600` 且覆盖短指纹 `>= 75%`、mean bit errors `<= 2/frame`。
- `audioIsolationRegistryScope = batchStatus=consumed`；fresh/evaluating/exposed 不参与历史 component/hash，
  fresh 批次在 sealed prepare 阶段另算隔离，不能让 consumed development split 漂移。
- sealed prepare 另写不可变 `dataset-lock.json`；evaluate 前重验 registry/manifest identity
  projection，并重新计算每首 registry `sourcePath` 的 asset SHA-256。fresh truth 先物化为绑定原 truth
  labels + stable registry identity 的 authoritative enriched truth，shard/resume 还会校验结果正文 digest。
- canonical CLI 默认同步写主 split + train/tune/holdout truth；三个 truth 用 `parentSplit` 绑定
  主 split 文件 SHA、各 split roster、registry/truth/seed/policy/assignment hashes，每首同时写
  `assignmentKey`；benchmark/feature 与 derived shard 消费或 resume 时重验 parent/run provenance。
- canonical path 硬锁 seed=`frkb-rkb-grid-v2`、tune=0.2、holdout=0.2；改协议只能写非 canonical diagnostic output，防止挑 seed 刷 holdout。
- `leaveOneBatchOut` 当前仅是无泄漏 outer/inner membership/hash 定义，nested LOBO runner 尚未实现；
  不能声称已有多数批次同向、最差批次或任何 LOBO 模型成绩。
- `feature-cache-by-batch/new357/index.json` 当前只有 2 个强身份 entry；旧 355 首身份不可证明，
  强制重算前禁止把 new357 357 首 replay 当可靠全量结果。

## 当前算法接入状态

`constant-grid-dp` 验收链路已接入 locked rising-edge ranker、保守的 legacy integer BPM snap、rank1 material legacy weakness switch、rank1 structural phase switch、rank1 high structural score switch、head near-zero switch、rank1 negative legacy score v2 switch，以及 rank1 octave-down switch。locked phase switch 后另有 `locked-phase-downbeat-ordinal-v1` 只修正同 BPM 跨周期零点时的 downbeat ordinal 语义，不改 BPM、firstBeat、score、source、阈值或候选排序。全部走同一套 solver 入口，已覆盖 Electron 实时分析路径。

当前 `scripts/rkb_constant_grid_dp_solver.py` 版本：

```text
constant-grid-dp-cache-v3-locked-rising-edge-ranker-locked-phase-downbeat-ordinal-v1-integer-bpm-snap-rank1-material-legacy-weakness-v3-rank1-structural-phase-v2-rank1-high-structural-score-v1-rank1-negative-legacy-score-v2-head-near-zero-v1-rank1-octave-down-v1
```

接入边界：

- 已接入：`scripts/rkb_constant_grid_dp_solver.py`
- 新增冻结模型：`scripts/rkb_locked_phase_ranker.py`
- 新增 selection 辅助模块：`scripts/rkb_constant_grid_dp_selection.py`
- 新增 solver 拆分模块：`scripts/rkb_constant_grid_dp_cache.py`、`scripts/rkb_constant_grid_dp_cli.py`、
  `scripts/rkb_constant_grid_dp_high_structural.py`、`scripts/rkb_constant_grid_dp_octave.py`、
  `scripts/rkb_constant_grid_dp_phase_path.py`
- 已验证链路：`scripts/run_parallel_rkb_rekordbox_benchmark.py --solver constant-grid-dp`
- benchmark 输出原子写已加 Windows `PermissionError` 短重试，避免杀毒/索引器短暂占用目标 JSON 时丢掉已完成 shard 合并结果。
- 运行时接入：`scripts/beat_this_bridge.py` 通过 `scripts/beat_this_runtime_constant_grid.py` 现场构造同形 metadata/arrays，然后调用同一套 `constant-grid-dp + locked ranker`。
- 运行时保护：`_analyze_prepared_windows_to_track_result` 默认仍不启用 runtime constant-grid，Electron bridge 仅在 `gridSolverPolicy != "off"` 时启用，避免 feature-cache 生成 legacyGridSolver 时递归污染。
- 打包资源：`package.json` 与 `electron-builder.yml` 已补充 `beat_this_runtime_constant_grid.py`、`benchmark_rkb_rekordbox_truth.py`、`rkb_*.py` 到 `demucs/bootstrap`，并覆盖
  `rkb_constant_grid_dp_cache.py`、`rkb_constant_grid_dp_cli.py`、
  `rkb_constant_grid_dp_high_structural.py`、`rkb_constant_grid_dp_octave.py`、
  `rkb_constant_grid_dp_phase_path.py`
  这些 solver 拆分模块。
- 上一轮 `pnpm run build:unpack` 曾验证 runtime constant-grid 依赖进入 unpacked package；本轮新增
  cache / CLI / octave 拆分模块后尚未重跑打包验证。

当前生产回归口径：

下面的逐 guard、逐批次和逐曲命中只用于解释当前 production 是怎么形成的，全部属于 consumed
历史回归；禁止继续沿着这些歌曲拧阈值，也禁止用“旧集合零 `pass -> fail`”作为绝对晋级门槛。

- current production latest：`976 / 1407 = 69.37%`，error `0`；
  固定输出为 `grid-analysis-lab/rkb-rekordbox-benchmark/frkb-current-latest.json`，
  刷新来源为 `grid-analysis-lab/rkb-rekordbox-benchmark/frkb-current-rank1-high-structural-score-v2.json`
- 当前代码的 `locked-phase-downbeat-ordinal-v1` targeted development replay 覆盖 6 个完整历史批次：
  65 个 locked 触发点共 `fail -> pass = 12`、`pass -> fail = 0`。current 23 个触发点中救回 3 首，
  因其余曲目路径不变，可确定 current 代码口径为 `979 / 1407 = 69.58%`、downbeat `66 -> 63`；
  但 `frkb-current-latest.json`、classification 和旧维护 benchmark 尚未全量刷新，文件仍记录 976。
- 六批 targeted 明细：current `+3`、blind `+1`、old377 `+0`、test316 `+1`、test327 `+7`、
  test353 `+0`，全部是 consumed replay，只能证明没有观察到历史回归，不能当 fresh 泛化提升。
- blind：`436 / 608 = 71.71%`，error `0`
- latest `test353` consumed batch：`225 / 353 = 63.74%`，error `0`
- consumed `test327` batch：`218 / 327 = 66.67%`，error `0`
- consumed `test316` batch：`176 / 316 = 55.70%`，error `0`
- rank1 negative legacy score v2 相比 baseline：current `702 -> 706`，blind `436 -> 436`，
  latest `test353` 批次 `222 -> 224`；v2 在 test353 上保留 pass 数但收紧 2 次非 pass
  错误类型漂移，current/blind/latest `test353` 逐曲 diff 没有 `pass -> fail`。
- rank1 octave-down 相比上一轮：current `706 -> 707`，blind `436 -> 436`，
  `test327` final 到 `218 / 327`，`test316` `175 -> 176`；逐曲 diff 没有 `pass -> fail`。
- rank1 high structural score v1 相比本轮 1407 首 current baseline：current `973 -> 976`，
  blind `436 -> 436`，test353 `224 -> 225`，test327/test316 不变；逐曲 diff 全部
  `pass -> fail = 0`。
- head near-zero 相比 structural phase v2：current `702 -> 702`，blind `435 -> 436`，latest `test`
  批次 `212 -> 215`；current/blind/latest `test` 逐曲 diff 没有 `pass -> fail`。
- structural phase v2 相比 v3：current `696 -> 702`，blind `432 -> 435`，latest `test`
  批次 `230 -> 231`；current/blind 逐曲 diff 没有 `pass -> fail`。
- `frkb-current-latest.json`、`frkb-classification-current.json`、sample/failure 派生视图已刷新到
  `976 / 1407`。
- FRKB-5 正式开发音乐库根目录以 `.env` 的 `FRKB_BENCHMARK_DATABASE_ROOT` /
  `FRKB_DEV_DATABASE_URL` 为准。D 到 G 的文件迁移已完成并通过逐目录计数与 SQLite `quick_check`
  验收；`.env` 已切到 `G:/FRKB_database-E`，中央 registry/baseline 已完成 7 批 / 3745 首初始化。
  当前唯一身份计数为 asset 3745、PCM 3737、Chromaprint family 3735，D 盘旧目录禁止回退。
- 音乐库长期保留 5 个音频歌单：`new`、`sample`、`grid-failures-current`、
  `blind-rekordbox-truth`、`sealed-eval`；`sealed-intake` 是唯一固定临时入口。
- current 音频目标分布：`new = 0`，`sample = 976`，
  `grid-failures-current = 431`。
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
- rank1 octave-down 新增 pass 命中：
  - current：`Umoja - Rabia (Original Mix).mp3`，`half-or-double-bpm -> pass`
  - consumed `test327`：`Kid Ink feat. Lil Wayne & Saweetie - YUSO (I.mp3`，`half-or-double-bpm -> pass`
  - consumed `test327`：`City Girls feat. Cardi B vs. Juicy J - Twerk.mp3`，`half-or-double-bpm -> pass`
  - consumed `test316`：`Club des Belugas - It Don't Mean a Thing.mp3`，`half-or-double-bpm -> pass`
- rank1 high structural score 新增 pass 命中：
  - current：`Damir Prohic - Temple Dance (Original Mix).mp3`，`first-beat-phase -> pass`
  - current：`Dubfire - Deadbug.mp3`，`first-beat-phase -> pass`
  - current：`Girls of the Internet,shiv - Never Ever Ever.mp3`，`first-beat-phase -> pass`
  - consumed `test353`：`Amonita - Walking In The Rain (Original Mix).mp3`，`first-beat-phase -> pass`

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

rank1 high structural score 规则：

- 只在 baseline 仍是 `constant-grid-dp:legacy-fallback`，且普通 locked ranker、
  rank1 material legacy weakness 与 rank1 structural phase 都未切换时生效。
- 只看候选池 rank1，不从 topN 里挑候选。
- 要求 rank1 的 `lockedRisingEdgeRankerProbability >= 0.82`、`score >= 0.96`、
  `tempoScore >= 0.95`。
- 要求 rank1 `downbeatRank == 0`、`downbeatMargin >= 0.35`、
  `phasePathScore >= 0.7`、`leadingEdgePeakOffsetMadMs <= 8ms`。
- 要求 rank1 与 legacy 的相位差 `> 15ms`，BPM 差 `<= 0.08`，bar offset mod4 相同。
- 要求 legacy `firstBeatMs > 20ms`；`<= 20ms` 视为贴头 anchor，避免把已 pass 的头部网格换成 downbeat。
- 不使用 `fileName`、artist/title/path、truth、benchmark category、pass/fail 或 split identity。
- guard 标记为 `constant-grid-dp-rank1-high-structural-score-switch`。
- 这是在 1407 首 current 和 consumed test353 上形成的窄边界开发回归；current/blind/test353/test327/test316
  不退只是回归证据，不能包装成新的 sealed 泛化证明。

rank1 negative legacy score 规则：

- 只在 baseline 仍是 `constant-grid-dp:legacy-fallback`，且普通 locked ranker、
  rank1 material legacy weakness、rank1 structural phase 和 head near-zero 都未切换时生效。
- 只看候选池 rank1，不从 topN 里挑候选。
- 要求 legacy `legacyGridSolverScore <= 0.0`。
- 要求 rank1 `score >= 0.85`，`phasePathScore >= 0.8`。
- 要求 rank1 与 legacy 的相位差 `> 5ms`，BPM 差 `<= 0.08`，bar offset mod4 相同。
- v2 soft guard：如果 rank1 与 legacy 的相位差 `< 10ms`，要求 rank1 `score >= 0.99`。
- 要求 rank1 `downbeatRank == 0`。
- 不使用 `fileName`、artist/title/path、truth、benchmark category、pass/fail 或 split identity。
- guard 标记为 `constant-grid-dp-rank1-negative-legacy-score-switch`。
- 这是在 test353 已跑完后形成的窄边界开发回归；current/blind 不退只是回归证据，
  不能包装成新的 sealed 泛化证明。

rank1 octave-down 规则：

- 只在最终选择仍是 `constant-grid-dp:legacy-fallback`，且 head near-zero 与
  rank1 negative legacy score 都没切换时生效。
- 只看候选池 rank1，不从 topN 里挑候选。
- 要求 `confidence <= 0.82`，避免高置信 legacy 被半速/倍速候选覆盖。
- 要求 `abs(rank1Bpm * 2 - legacyBpm) <= 0.08`，只处理 rank1 近似 legacy 半速的窄场景。
- 要求 rank1 来源包含 `window-beat-leading-edge`。
- 要求 rank1 `score >= 0.86`、`downbeatRank == 0`、`downbeatMargin >= 0.5`、
  `phasePathScore >= 0.7`、`leadingEdgePeakOffsetMadMs <= 8ms`、`tempoScore >= 0.74`。
- 不使用 `fileName`、artist/title/path、truth、benchmark category、pass/fail 或 split identity。
- guard 标记为 `constant-grid-dp-rank1-octave-down-switch`。
- 这是在 current / test327 / test316 已看过数据上形成的 half/double 窄边界开发回归；
  current/blind/各消耗批次不退只是回归证据，不能包装成新的 sealed 泛化证明。

## latest `test353` 批次结果

当前 Rekordbox `test` 歌单重新抓取后得到 353 首。音频最初复制到 `sealed-intake`，后续已归档到
`<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-eval`。本轮
`sync_rekordbox_playlist_audio.py --dry-run` 为 `copyCount = 353`、`skippedCount = 0`，
随后已执行复制。feature cache 已生成，summary indexed 353。这批已经用于
rank1 negative legacy score v1/v2 和 rank1 high structural score v1 开发回归，后续只能当普通回归集。

产物路径：

- truth：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/rekordbox-sealed-truth-test353.json`
- audio：`<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-eval`
- feature cache：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/feature-cache-test353`
- baseline benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp-test353.json`
- rank1 negative legacy score v1 benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp-test353-rank1-negative-legacy-score.json`
- final v2 + octave benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-test353-rank1-negative-v2-octave-down.json`
- rank1 high structural score benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-test353-rank1-high-structural-score-v2-archive.json`

production benchmark：

- baseline：`222 / 353 = 62.89%`
- final selected：`225 / 353 = 63.74%`
- errorTrackCount：`0`
- category：`pass 225`，`first-beat-phase 83`，`downbeat 15`，`bpm 17`，
  `half-or-double-bpm 12`，`grid-drift 1`
- candidate oracle：`338 / 353 = 95.75%`
- oracle selected fail：`113`
- guard 计数：`legacy-fallback-low-confidence 314`，
  `constant-grid-dp-rank1-negative-legacy-score-switch 2`，
  `constant-grid-dp-head-near-zero-switch 5`，`constant-grid-dp-conservative-switch 13`，
  `constant-grid-dp-phase-evidence-switch 6`，
  `constant-grid-dp-locked-rising-edge-ranker 5`，`legacy-fallback-integer-bpm-snap 4`，
  `constant-grid-dp-rank1-structural-phase-switch 2`，
  `constant-grid-dp-rank1-high-structural-score-switch 1`，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch 1`

rank1 negative legacy score 触发结果：

- latest test353：v1 5 次触发，2 首 `fail -> pass`，2 首 `first-beat-phase -> downbeat`，
  0 首 `pass -> fail`；v2 soft guard 后保留 `224` pass，仅剩 2 次非 pass 错误类型变化。
- rank1 high structural score v1 再触发 1 次，把
  `Amonita - Walking In The Rain (Original Mix).mp3` 从 `first-beat-phase` 救为 `pass`，
  `pass -> fail = 0`。
- current：6 次触发，4 首 `fail -> pass`，0 首 `pass -> fail`。
- blind：1 次触发，`first-beat-phase -> downbeat`，0 首 pass gain/loss。

结论：test353 是新鲜样本进入时的 sealed 验收结果，但它随后已经参与 rank1 negative legacy score v1/v2
和 rank1 high structural score v1 规则形成，所以现在只能算 consumed sealed regression，不再是 fresh 泛化证明。
下一次泛化证明必须来自另一批未曝光的新歌曲；Rekordbox playlist 仍可复用 `test`。

## latest `test327` 批次结果

当前 Rekordbox `test` 歌单重新抓取后得到 327 首。音频已在 consumed archive/current 目录中流转，
本轮
`sync_rekordbox_playlist_audio.py --dry-run` 为 `copyCount = 0`、`skippedCount = 327`。
这批已经用于 head near-zero、rank1 negative legacy score v2 和 rank1 octave-down 开发回归，
后续只能当普通回归集。

产物路径：

- truth：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/rekordbox-sealed-truth-test327.json`
- audio：复跑时使用 `<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-eval;<FRKB_DATABASE_ROOT>/library/FilterLibrary/sample;<FRKB_DATABASE_ROOT>/library/FilterLibrary/grid-failures-current`
- feature cache：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/feature-cache-test327`
- baseline benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp-test327.json`
- head near-zero benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-constant-grid-dp-test327-head-near-zero.json`
- final v2 + octave benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-test327-rank1-negative-v2-octave-down.json`

production benchmark：

- structural phase v2 baseline：`212 / 327 = 64.83%`
- head near-zero selected：`215 / 327 = 65.75%`
- final selected：`218 / 327 = 66.67%`
- errorTrackCount：`0`
- category：`pass 218`，`first-beat-phase 64`，`downbeat 27`，`bpm 8`，
  `half-or-double-bpm 10`
- candidate oracle：`316 / 327 = 96.64%`
- oracle selected fail：`98`
- guard 计数：`legacy-fallback-low-confidence 273`，`constant-grid-dp-head-near-zero-switch 6`，
  `constant-grid-dp-locked-rising-edge-ranker 19`，`legacy-fallback-integer-bpm-snap 6`，
  `constant-grid-dp-rank1-locked-legacy-weakness-switch 3`，
  `constant-grid-dp-phase-evidence-switch 5`，`constant-grid-dp-conservative-switch 4`，
  `constant-grid-dp-rank1-structural-phase-switch 3`，
  `constant-grid-dp-rank1-negative-legacy-score-switch 5`，
  `constant-grid-dp-rank1-octave-down-switch 3`

head near-zero 新增 pass：

- `Chiodan - Persoana.mp3`
- `Crankdat & NGHTMRE - TYPE SHIT  (Spritzur Ed.wav`
- `JayJay - Cinema (master).wav`

final v2 + octave 额外变化：

- `Ariana Grande - thank u, next (PeteDown Mix).mp3`：`first-beat-phase -> pass`，guard `rank1-negative-legacy-score`
- `Kid Ink feat. Lil Wayne & Saweetie - YUSO (I.mp3`：`half-or-double-bpm -> pass`，guard `rank1-octave-down`
- `City Girls feat. Cardi B vs. Juicy J - Twerk.mp3`：`half-or-double-bpm -> pass`，guard `rank1-octave-down`
- `14？,Shing02 - Real With You Feat. Shing02.mp3`：`half-or-double-bpm -> downbeat`，非 pass 类型变化

## consumed `test316` 批次结果

这批已经用于 rank1 octave-down 开发回归，后续只能当普通回归集。

产物路径：

- final benchmark：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/frkb-sealed-test316-rank1-negative-v2-octave-down.json`

production benchmark：

- final selected：`176 / 316 = 55.70%`
- errorTrackCount：`0`
- category：`pass 176`，`first-beat-phase 83`，`downbeat 20`，`half-or-double-bpm 21`，`bpm 16`
- candidate oracle：`298 / 316 = 94.30%`
- oracle selected fail：`122`
- guard 计数：`legacy-fallback-low-confidence 279`，`constant-grid-dp-conservative-switch 10`，
  `constant-grid-dp-head-near-zero-switch 6`，`constant-grid-dp-locked-rising-edge-ranker 6`，
  `constant-grid-dp-rank1-structural-phase-switch 5`，
  `constant-grid-dp-rank1-negative-legacy-score-switch 4`，
  `legacy-fallback-integer-bpm-snap 3`，`constant-grid-dp-phase-evidence-switch 2`，
  `constant-grid-dp-rank1-octave-down-switch 1`

rank1 octave-down 新增 pass：

- `Club des Belugas - It Don't Mean a Thing.mp3`

## previous `new357` diagnostic-only 批次结果

下面保留的是当时的运行记录；原历史 frozen truth 已被后续批次覆盖，当前 registry 中的 truth 是
`scripts/recover_rkb_new357_truth.py` 生成的 current DB recovered reference。所以下列数字只能作
diagnostic development replay，不得进入 primary aggregate，也不得据此声称重建了历史 fresh 成绩。
当前 batch cache index 仅保留 2 个强身份 entry；旧 355 个迁移文件不能证明对应 registry instance，
必须强制重算后才允许新的 357 首全量 replay。下面旧数字不代表当前可靠可复现成绩。

用户再次提供 Rekordbox `test` 歌单样本后，本轮按固定 sealed-intake 流程完成摄取、truth、
feature cache 和 production benchmark。注意：本批在 v3 边界优化中已经被消耗，后续只能当普通回归集。

样本摄取：

- `test` 歌单总数：`357`
- 复制到 `sealed-intake`：`357`
- 跳过：`0`
- truth 曲目数：`357`
- historical feature cache 当时记录：`357 / 357`，`indexedFeatureCount = 732`；当前强身份 index 仅 2

产物路径：

- truth：`grid-analysis-lab/rkb-rekordbox-benchmark/sealed-eval/rekordbox-sealed-truth.json`
- audio：`<FRKB_DATABASE_ROOT>/library/FilterLibrary/sealed-intake`
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
泛化证明。下一批要证明泛化，必须使用未曝光的新歌曲，仍可放进 `test`，且在跑之前锁住候选规则。

## 当前候选假设

下面是当前 production baseline 的组成，只用于锁定一次性 fresh 对照。新 selector/scorer 使用 stable
assignment split 开发；LOBO 目前只有定义，nested runner 是尚未完成的晋级前置项：

```text
rising-edge locked ranker + legacy integer BPM snap + rank1 material legacy weakness + rank1 structural phase v2 + rank1 high structural score v1 + rank1 negative legacy score v2 + head near-zero + rank1 octave-down
```

当前 current/blind/latest test 回归结果：

- current：`685 -> 694 -> 695 -> 696 -> 701 -> 702 -> 702 -> 706 -> 707`
- current after 476-track intake：`973 -> 976`
- blind：`425 -> 430 -> 430 -> 432 -> 434 -> 435 -> 436 -> 436`
- old consumed test：`274 -> 277 -> 278 -> 279`
- new357 历史诊断：`229 -> 230 -> 231`（当前只有 2 首强身份 cache，不能据此复跑可靠 357 首）
- latest test327：`212 -> 215 -> 218`
- latest test353：`222 -> 224 -> 225`
- latest test316：`175 -> 176`
- 全 split：`pass -> fail = 0`

current/blind 本身仍不是生产提升证明，因为它是在看过 current/blind 报告后形成的验后污染假设。
old consumed test、latest test-new-357、latest test327、latest test353 与 latest test316
都已经被优化消耗，后续只能作为普通回归集使用。要证明
integer BPM snap、rank1 material legacy weakness v3、rank1 structural phase v2、head near-zero 和
rank1 high structural score v1、rank1 negative legacy score v2、rank1 octave-down 的泛化，需要另一批
未曝光的新歌曲原样 sealed 复验；Rekordbox playlist 仍可复用 `test`。

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
- 本轮二次扫描还试过 same-BPM / low-legacy high-grid structural 分支。离线假设一开始看着有收益，
  但真实 solver 验证暴露出它依赖了错误的 legacy 字段口径，落到实际 production 输出没有稳定净增；
  已完全回滚，不作为后续方向。

## 下一批新样本要验证什么

结论先写死：现在需要的是一批从未参与当前候选版本开发的新歌曲，不需要新建 Rekordbox playlist；
仍可复用 `test`。current、blind 和所有旧 test/sealed 批次都已 consumed，继续用它们涨分只算开发回归。

下一批新样本只验证这些事：

1. `prepare` 前锁死候选版本的代码、模型、特征、阈值、数据 registry 和晋级标准；完整 `test`
   批次必须在差异分拣前冻结，不能先把失败歌曲移动到 `needReview` 再抓 truth。
2. `evaluate` 只运行一次，输出 frozen 全量分母上的严格正确率、candidate oracle、scorer missed、
   first-beat-phase/downbeat/bpm 分布、confidence 分层和运行错误。低置信、`needReview` 和人工待查歌曲
   全部留在分母中。
3. 晋级先看全部 consumed 数据统一 solver 回放；还必须先实现 nested LOBO runner，再验证多数 primary
   批次同向、最差批次无预注册灾难性回归，并报告 `fail -> pass`、`pass -> fail`、
   BPM 大错率和 downbeat 回归。`new357` 单列 diagnostic，不进 primary aggregate；零
   `pass -> fail` 不是绝对条件。
4. fresh 只验证锁死候选是否达到预注册门槛，不在本批扫描 topN、阈值、guard 或重新训练。
   如果结果不达标，本批 finalize 为 reject/consume，允许进入下一版本训练；下一版本必须等下一批 fresh。
5. confidence 只决定机器是否自动追加完整歌曲、多窗口或高分辨率二次分析，不能决定是否把任务交给
   用户，也不能用于缩小准确率分母。

任何晋级标准都必须在 `prepare` 的 lock manifest 中写死。看到 fresh 结果后新增或修改指标，等同于
使用该批调参，只能把本批降级为 consumed，不能继续拿它证明提升。

## 下一步建议

不要继续在 current/blind 或已消耗的 `test` sealed 上扫阈值。

可选下一步：

- 若要发布安装包，先补跑 `pnpm run build:unpack` 验证新拆分模块进入 bootstrap，
  再跑 `pnpm run build:win`。
- stable-assignment split v4 与 LOBO membership 已完成；下一步是全部 consumed 同版本回放、new357 剩余
  355 首强身份 cache 重算，以及实现 nested LOBO runner。runner 完成前禁止汇报 LOBO 多数/最差批成绩。
  候选锁死后，再让用户按原流程把新歌放进 `test`，无需新建歌单。

不要改阈值、不要现场挑歌、不要重训选择规则；完整 `test` 必须在分拣到 `needReview` 前冻结。

## sealed-eval 一次性验收流程

所有 sealed 子步骤统一由 `scripts/rkb_sealed_batch.py` 编排，参数以 `--help` 为准。禁止手工复制
旧 truth/cache/benchmark 裸命令，避免覆盖批次、漏锁模型或在分拣后缩小分母。

下列 import 命令只记录首次历史迁移；当前 baseline 已初始化，再运行 `import-consumed` 会硬失败：

- old377 使用 `scripts/extract_rkb_consumed_truth.py` 从大 benchmark 流式提取内嵌历史 truth，禁止整份复制。
- new357 使用 `scripts/recover_rkb_new357_truth.py` 生成当前 Rekordbox DB 恢复参考；它只允许用于
  consumed registry bootstrap / 带警告的开发标签，不能冒充历史 frozen snapshot 或 fresh proof。

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" import-consumed --batch-id "<历史批次ID>" --truth "<truth.json>" --audio-root "<音频目录>"
# 3745 个历史 consumed 实例全部导入后只初始化一次：
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" initialize-registry `
  --expected-track-count 3745 `
  --expected-batch "current1407=1407" --expected-batch "blind608=608" `
  --expected-batch "old377=377" --expected-batch "new357=357" `
  --expected-batch "test327=327" --expected-batch "test353=353" `
  --expected-batch "test316=316"
```

baseline 创建后禁止 `import-consumed`；新增数据只走 sealed fresh lifecycle，finalize 后使用 `rebuild-registry`。

重建 instance-safe / audio-isolation-family-safe development split：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/build_rkb_rekordbox_dataset_splits.py" `
  --registry "grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-registry.json" `
  --output "grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-splits-current.json"
```

canonical CLI 默认一次同步主 split 与三份 truth；主文件写 `assignmentDigestSha256` /
`splitAssignmentsSha256`，truth 用 parent 文件 SHA/split roster 等契约绑定主文件并逐曲写
`assignmentKey`；消费端会重验。`--no-write-truth-files` 只能配非 canonical diagnostic output。
LOBO 字段只是 membership，不是 runner 成绩。

在差异分拣前冻结完整 `test`：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" prepare --playlist "test"
```

prepare 默认锁定 `--minimum-strict-accuracy = 0.80`、`--maximum-error-rate = 0`、
`--maximum-bpm-big-error-rate = 0.05`、`--minimum-candidate-oracle-rate = 0.94`。需要调整只能在
prepare 前显式传入；写进 immutable manifest 后禁止修改。prepare 还会用 approximate isolation guard
排除 consumed/fresh 近重复录音，并记录 `excludedIsolationDuplicates` / `audioIsolationGuard`。

只运行一次锁定评估：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" evaluate --batch latest
```

中断时只有 lock hash 完全一致才允许 `evaluate --batch latest --resume`；完整成功后禁止重跑。
第一次完整曝光已永久撤销 fresh 身份，接着记录决定并归档：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" "scripts/rkb_sealed_batch.py" finalize --batch latest --decision eligible
# 或：--decision reject / --decision consume，可追加 --note "原因"
```

`eligible` 必须自动通过 prepare 时锁死的 acceptance policy，只表示候选具备晋级资格，不直接执行
production promotion。三种 decision 都会把本批归档为 consumed；根据本批结果修改出的下一版本，
必须再等下一批 fresh。finalize 完成后再按原流程移动到 `needReview` / review，不改变 frozen 分母。

日常用户命令仍可保持不变：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/prep_move_tracks_between_playlists.py" `
  --source "Upan" --target "test" --limit 500 --apply --then-triage --triage-apply
```

内部固定执行 `move -> prepare -> evaluate -> finalize consume -> triage`；wrapper 读取 prepare 的真实
batchId，校验后传给后三步。直接运行 triage 脚本整理 `test` 时必须传 `--sealed-batch-id <batchId>`；
只有已 consumed 维护才可显式 `--consumed-maintenance`，活动 sealed 批次存在时 maintenance 会拒绝。

## 禁止事项

- 不要在 current/blind 上继续扫阈值当证据。
- 不要根据 sealed-eval 现场改阈值、删歌、挑样本或重训选择规则。
- fresh 第一次完整曝光后就不再 fresh，后续只能当普通训练、回归或诊断数据。
- 不要按批次新建 Rekordbox sealed 歌单；统一入口会在 `sealed-intake/<batchId>` 与
  `sealed-eval/<batchId>` 管理隔离目录，用户继续复用 `test`。
- 不要把移动到 `needReview` 或低置信歌曲从 frozen 分母中删除；`needReview` 不是产品兜底。
- 不要把零 `pass -> fail` 当绝对门槛；必须看全量净收益、LOBO 最差批次、迁移比例和灾难性回归。
- 不要按 category、失败类型或 artist/source 生成可变化 split；统一用 `batchId + assetSha256`
  识别实例、固定纯音频 `isolationFamilyId` / `batchId` 分组，缺失身份、isolation 映射或
  `batchStatus != consumed` 必须报错。
- 不要根据 exact split、旧 holdout、LOBO holdout 或 `new357` diagnostic 的结果反复调参后，再把
  同一数据称为新验证；这些数据已经全部 consumed。
- 不要在 baseline 后调用 `import-consumed`，不要绕过 approximate duplicate guard，也不要无 batchId
  直接 triage `test`。
- 不要把 LOBO membership/hash 产物说成 nested runner 或模型成绩；runner 目前尚未实现。
- 禁止使用 `fileName`、`artist`、`title`、path、truth、benchmark error、pass/fail、split identity 做 solver/ranker 决策。
- 没有新样本时，可以继续找新的结构性 phase evidence，但不能报成真实准确率提升。

## 关键文档

- `drafts/rkb-benchmark-workflow/archive/rkb-rekordbox-truth-validation-workflow.md`
- `drafts/rkb-benchmark-workflow/rkb-beatgrid-solver-pitfalls.md`

## 关键脚本

- `scripts/rkb_sealed_batch.py`
- `scripts/rkb_sealed_batch_isolation.py`
- `scripts/build_rkb_rekordbox_dataset_splits.py`
- `scripts/rkb_audio_isolation_families.py`
- `scripts/materialize_rkb_feature_cache_by_batch.py`
- `scripts/rkb_playlist_triage_report.py`
- `scripts/beat_this_bridge.py`
- `scripts/beat_this_runtime_constant_grid.py`
- `scripts/rkb_constant_grid_dp_solver.py`
- `scripts/rkb_constant_grid_dp_cache.py`
- `scripts/rkb_constant_grid_dp_cli.py`
- `scripts/rkb_constant_grid_dp_high_structural.py`
- `scripts/rkb_constant_grid_dp_octave.py`
- `scripts/rkb_constant_grid_dp_phase_path.py`
- `scripts/rkb_constant_grid_dp_selection.py`
- `scripts/rkb_locked_phase_ranker.py`
- `scripts/rkb_phase_ranker_rising_edge_locked_replay.py`
- `scripts/rkb_phase_ranker_rising_edge_diagnostic.py`
- `scripts/rkb_phase_ranker_diagnostic.py`
- `scripts/rkb_onset_foot_phase_diagnostic.py`
- `scripts/rkb_phase_semantics_diagnostic.py`
- `scripts/rkb_phase_trajectory_diagnostic.py`

## 已验证

- split schema v4 已从真实 7 批 / 3745 consumed registry 生成：3735 exact families 合并为
  3682 isolation families，train/tune/holdout 为 2249/773/723。
- canonical 主 split 与三份 truth 已同次刷新，`parentSplit` / assignment hashes 一致；本次 split 变化是
  stable assignment 接入的一次性迁移，不是调参后挑分区。
- audio isolation policy 仅使用音频身份：8135 个 coarse candidate pairs 接受 54 条近重复链接，
  形成 53 次 approximate union / 52 个 approximate components；policy SHA 固定为
  `e7e52a9df88ea17686bb7825c9ab017edbdf459dfe0a110cc65c2c5b1185be98`。
- `new357` 在 split 中为唯一 diagnostic-only batch，
  `batchEvidencePolicies.new357.primaryEvaluationEligible = false`、`freshProofEligible = false`；
  其 batch cache index 当前仅 2 个强身份 entry。
- fresh prepare 已接入 consumed + fresh approximate isolation duplicate guard；baseline 后
  `import-consumed` 被拒绝，test triage 也已强制绑定 sealed batch 或 explicit maintenance。
- LOBO outer/inner membership 已验证无 isolation overlap，但 nested runner 尚未实现，当前没有 LOBO 模型成绩。
- dataset contract、sealed/isolation/triage、split/migration、solver semantic 共 153 项单测通过；三个
  canonical truth 的 parent 文件 SHA、roster、sourcePath、assignment/ratio 契约已由消费端实际重验。
- `py_compile` 通过：`rkb_constant_grid_dp_high_structural.py`、
  `rkb_constant_grid_dp_phase_path.py`、`rkb_constant_grid_dp_selection.py`、
  `rkb_constant_grid_dp_solver.py`、`frkb_database_paths.py`。
- current rank1 high structural score v2：`976 / 1407`，error `0`；相对本轮 baseline
  `973 / 1407`，逐曲 diff 为 `first-beat-phase -> pass = 3`、`pass -> fail = 0`。
- blind：`436 / 608`，error `0`；相对上一版 blind benchmark 无逐曲变化，
  high structural guard 触发 `0`。
- consumed test353：`225 / 353`，error `0`；相对上一版 `224 / 353` 新增
  `Amonita - Walking In The Rain (Original Mix).mp3`，`pass -> fail = 0`。
- consumed test327：`218 / 327`，error `0`；相对上一版无逐曲变化，high structural guard 触发 `0`。
- consumed test316：`176 / 316`，error `0`；相对上一版无逐曲变化，high structural guard 触发 `0`。
- current classification / sample-regression / grid-failures-current 派生视图已刷新到 `976 / 1407`。
- E 音乐库 current 目标分布为 `new = 0`、`sample = 976`、`grid-failures-current = 431`，
  同步后 `sync_frkb_classification_audio_dirs.py --dry-run` 为 `moveCount = 0`。
- 本轮实际同步移动 `Damir Prohic - Temple Dance (Original Mix).mp3`、
  `Dubfire - Deadbug.mp3`、`Girls of the Internet,shiv - Never Ever Ever.mp3`：
  `grid-failures-current -> sample`。
- consumed regression 音频已完成归档：`sealed-eval` 顶层 1412 首，加
  `_conflicts/sealed-intake-20260610` 两个同名不同音频版本，闭合 old377/new357/test327/test353
  的 1414 个实例；test316 的 316 首位于 `sealed-eval/test316`。
  `sealed-intake` 当前音频为 0，仅保留资料库节点身份标记 `.frkb.uuid`，新 sealed 入口会忽略该元数据文件。
- 全量身份计算默认按 16 首写入 `audio-identity-cache` 断点；缓存命中仍重算 asset SHA-256，U 盘中断后
  只续未完成块，不会把缓存当身份真值。
- G 盘 `.frkb_audio_library_manifest.json` 是 registry 建立前的 1916 首历史迁移快照，内部 D 盘路径不再
  代表当前状态；保留它只为审计，当前数量/身份权威源固定为中央 registry + baseline。
- 本轮没有重新跑 `pnpm run build:unpack` / `pnpm run build:win`；发版或安装包验收前需要补跑。
