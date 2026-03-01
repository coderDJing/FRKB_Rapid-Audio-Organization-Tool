# Mixtape Stem 模式重构草案（按 djay 定义，3/4 Stems，导入即分离）

更新时间：2026-02-28（维护版，含策略确认、续跑修复与 D2-2 落地）

## 当前实现状态（2026-02-28）
1. 已完成：工程 `stemMode` 持久化、Stem 参数栏与段落选择交互、撤销栈适配、主链路从 `EQ` 迁移到 `StemMix` 过渡控制。
2. 已完成：实时播放与导出链路去除 `high/mid/low` 自动化，改为按 `3/4 stems` 动态读取 stem 包络。
3. 已完成：阶段 B1 基础闭环（`mixtape_stem_assets` 表、入队/重试/状态 IPC、`append` 自动入队、`mixtape:list` 返回 `stemSummary`、状态广播刷新）。
4. 已完成：门禁能力（导出前阻止非 `ready` 轨道；播放链路跳过非 `ready` 轨道并提示统计）。
5. 已完成：真实 Demucs CLI 执行器接入（内置 Python runtime + 本地模型，不依赖用户安装 Python/Demucs）。
6. 已完成：B2 首批落地，实时播放与离线导出切换为“每 Stem 独立音源”节点图。
7. 已完成：轨道 `info_json` 持久化 `stemVocalPath/stemHarmonicPath/stemBassPath/stemDrumsPath`，前端按路径解码多 stem 音频。
8. 已完成：阶段 D1 最小闭环，时间线波形改为按 `3/4 stems` 分栏绘制；每个 stem 按独立文件路径加载/缓存/预渲染（含 worker 路径）。
9. 已完成：旧数据兼容修复，若轨道 `stemStatus=ready` 但缺失 `stem*Path`，前端加载时自动触发一次 `enqueue(force=false)` 回填/重建路径。
10. 已完成（D2-1）：`mixtape_stem_waveform_cache` 切换到专用 `StemWaveformDataLite`（每 stem 仅 `all` 通道）结构，并提升缓存版本执行破坏式重建（不兼容旧缓存格式）。
11. 最近校验：`npx vue-tsc --noEmit` 通过。
12. 已完成：工程级策略确认持久化（`mixtape_projects.stem_strategy_confirmed`，`SCHEMA_VERSION=15`）。
13. 已完成：首次进入混音工程时弹出 Stem 策略选择（速度优先 / 质量优先 / 稍后再选）；未确认前不自动触发 stem 分离入队。
14. 已完成：打开工程自动续跑增强，首次接管 `pending/running`，并对“超时失败”的轨道自动补一次重试。
15. 已完成：策略弹窗并发锁，修复重复弹窗问题（同 playlist 仅弹一次）。
16. 已完成：Demucs 分离超时改为按设备动态设置；CPU 路径 hard cap `8 分钟/首`，避免 `3600s` 长挂。
17. 已完成：Mixtape 时间线与 worker 侧波形类型改为 stem 专用数据结构（仅 `all`），不再依赖 `low/mid/high` 语义。
18. 已完成（D2-2）：在 stem 分离成功与 `readyFromCache` 两条路径都触发 stem bundle 预热，减少重开工程时的冷启动波形等待。

## 文档定位
1. 本文是自动混音（Mixtape）从 `EQ 三频` 重构为 `Stem 混音` 的实现草案。
2. 目标是统一产品、前端、主进程、数据层的口径，用于进入开发排期。
3. 本文不是最终需求文档，参数细节可在评审后收敛。

## 目标与边界
1. 混音核心从 `gain/high/mid/low/volume` 改为 `gain + stems + volume`。
2. 支持两种工程模式（按 djay 定义）：
3. `3 stems`：`vocal/harmonic/drums`。
4. `4 stems`：`vocal/harmonic/bass/drums`。
5. 模式只在“创建混音工程”时选择，创建后锁定，不支持实时切换。
6. 导入曲目后立即执行分离，分离完成后才视为可混音素材。
7. 不保留旧 `high/mid/low EQ` 模式，不做运行时回退。
8. `Stem` 通道不提供自由曲线包络点编辑；交互改为“段落选择（网格段开关）”。
9. `Stem` 最终听感仍叠加 `gainEnvelope` 与 `volumeEnvelope`（Stem 段落开关仅决定该 Stem 在该段是否生效）。
10. 由于项目尚未发布历史版本，D2 阶段允许破坏式升级缓存结构与 schema，不保留旧波形缓存兼容分支。

## djay 对齐口径
1. 采用 djay 的 Neural Mix 语义：
2. `3 stems`：`Vocals / Harmonic / Drums`
3. `4 stems`：`Vocals / Harmonic / Bass / Drums`
4. 方案内的字段命名使用小写：`vocal/harmonic/bass/drums`。

## djay 波形呈现核验（2026-02-28）
1. djay 的 Stem 波形不是只有一种展示：支持 `Single / 2 Split / 3 Split / 4 Split` 可选视图。
2. 在 `4 Split` 下，四个 stem 会分开展示为独立波形；在 `Single` 下仍是单轨叠加视图。
3. 结论：FRKB 当前“分栏独立 stem 波形”方向并不违背 djay；差异在于我们目前没有提供视图模式切换。
4. 当前产品口径仍按“废弃旧 RGB 波形”执行，不回退到旧 `high/mid/low` 语义。
5. 参考：
6. https://help.algoriddim.com/user-manual/djay-pro-mac/neural-mix/tracks
7. https://help.algoriddim.com/user-manual/djay-pro-mac/neural-mix/overview
8. https://help.algoriddim.com/user-manual/djay-ios/mixing-basics/waveform-options

## Demucs 映射策略
1. 统一使用 Demucs 4 stems 输出：`vocals/drums/bass/other`。
2. FRKB 映射：
3. `vocals -> vocal`
4. `drums -> drums`
5. `bass -> bass`（仅 4 stems 工程启用）
6. `other -> harmonic`
7. 在 3 stems 工程中：`harmonic = other + bass`（离线合成后落盘），不暴露单独 bass 控制。

## 内置引擎落地（2026-02-27 更新）
1. 引擎形态：`Demucs CLI`，调用 `python -m demucs.separate`，不使用 GUI 壳。
2. 运行时路径（Windows）：`vendor/demucs/win32-x64/runtime/python.exe`。
3. 模型仓路径：`vendor/demucs/models`（当前默认 `htdemucs`）。
4. 调用参数基线：`-n htdemucs --repo <models> -d cpu -j 1 --filename {stem}.{ext}`。
5. 分离输出先落临时目录，再映射/合成为最终缓存文件，避免半成品污染状态。
6. 写盘容错：为 vendored Demucs 增加 wav 写入 fallback，规避 `torchaudio` backend 缺失导致的 `ta.save` 失败。

## 命名规范（防止口径漂移）
1. 代码与数据层统一使用 `harmonic`，不再使用 `inst`。
2. UI 展示可用“和声”或“Harmonic”，但字段名保持 `harmonic`。
3. 任何新增类型、IPC、DB 字段、缓存键均以 `harmonic` 为准。

## 用户流程（目标态）
1. 用户创建混音工程时，必须选择 `3 stems` 或 `4 stems`。
2. 首次进入工程需确认 stem 策略（速度优先/质量优先）；未确认时允许浏览但不自动分离。
3. 添加曲目后显示分离状态：`pending/running/ready/failed`。
4. 若上次处理中断，打开工程会自动续跑 `pending/running`，并对“超时失败”轨道补一次自动重试。
5. 仅 `ready` 曲目参与播放、波形、导出。
6. `failed` 曲目允许手动重试，不自动降级为旧 EQ。

## 数据模型变更（草案）
1. 工程级字段新增：
2. `mixtape_project.stemMode: '3stems' | '4stems'`
3. 轨道级字段新增（info_json）：
4. `stemStatus`, `stemModel`, `stemVersion`, `stemReadyAt`, `stemError`
5. 包络与段落参数集合改造：
6. 包络线参数保留为 `gain/volume`（用于连续自动化）。
7. Stem 参数改为段落集合：`vocal/harmonic/drums`（3 stems）与 `vocal/harmonic/bass/drums`（4 stems）。
8. 段落集合语义与“音量段落静音”一致（按网格切段，支持拖拽批量开关）。
9. 新增素材索引表（建议）：
10. `mixtape_stem_assets(list_root, file_path, stem_mode, model, vocal_path, harmonic_path, bass_path, drums_path, status, updated_at_ms, ...)`
11. `libraryDb` 需要升级 `SCHEMA_VERSION` 并补迁移脚本。

## 阶段 B1（历史冻结）范围说明
1. 目标：实现“导入即分离”的最小可用闭环，不引入额外 UI 花活。
2. 范围内：
3. 新增 `mixtape_stem_assets` 表及读写 API（按 `list_root + file_path + stem_mode + model` 幂等）。
4. 新增分离任务队列服务：`enqueue -> running -> ready/failed`，支持并发上限与进程内去重。
5. 新增轨道状态字段落库：`stemStatus/stemError/stemReadyAt/stemVersion/stemModel`。
6. 新增重试链路：仅手动触发，不做后台无限重试。
7. 新增导出门禁：存在非 `ready` 轨道时阻止导出并返回可读错误。
8. 新增播放门禁：非 `ready` 轨道在 transport 中跳过并提示统计信息。
9. 范围外：
10. 不在本轮实现 stem 波形重构。
11. 不在本轮实现多进程分布式任务调度。
12. 不在本轮实现模型热切换或在线模型下载。
13. 说明：以上为 B1 当时的冻结范围；当前整体进度已推进到 D1（stem 分栏波形）。

## IPC/服务接口草案（阶段 B1）
1. `mixtape:stem:enqueue`：入队指定轨道分离任务，返回任务受理结果。
2. `mixtape:stem:retry`：对 `failed` 轨道重试，内部复用 enqueue。
3. `mixtape:stem:get-status`：按 `playlistId` 批量返回轨道 stem 状态。
4. `mixtape:stem:cancel`（可选）：取消未开始任务；`running` 任务是否可取消由引擎能力决定。
5. `mixtape:list` 返回结构补充 `stemSummary`（`pending/running/ready/failed` 计数），减少前端多次拉取。

## 数据一致性规则（阶段 B1）
1. 资产记录与轨道状态必须同事务或同一提交序列更新，禁止出现 `ready` 但文件不存在。
2. 启动时执行资产自检：文件缺失则回写 `failed` 并附错误码 `STEM_ASSET_MISSING`。
3. 轨道源文件变更（路径变化或 hash 变化）时，旧 stem 资产失效并重新入队。
4. 3 stems 工程读取规则固定：`vocal/harmonic/drums`；若资产仅有 4 stems，则按映射策略生成/选择有效路径。

## 错误码建议
1. `STEM_QUEUE_REJECTED`：任务未受理（参数非法或资源不足）。
2. `STEM_SPLIT_FAILED`：分离过程失败。
3. `STEM_ASSET_MISSING`：记录存在但文件缺失。
4. `STEM_NOT_READY_FOR_EXPORT`：导出门禁命中。
5. `STEM_NOT_READY_FOR_PLAYBACK`：播放门禁命中（可降级为警告）。

## 缓存与文件布局（建议）
1. 建议落盘目录：`<userData>/stems/<audio_hash>/<model>/<stem_mode>/`
2. 文件命名：
3. `vocal.wav`, `harmonic.wav`, `bass.wav`, `drums.wav`, `meta.json`
4. 3 stems 工程不写 `bass.wav`，或写入但不暴露（二选一，建议不写，节省空间）。
5. 删除曲目、移动曲目、库维护时，复用现有缓存维护机制扩展清理 stem 缓存。
6. 当前实现采用该目录结构；`audio_hash` 基于 `filePath + size + mtimeMs` 计算，确保源文件变化触发新缓存。

## 播放链路改造
1. 现状：`Source -> LowShelf -> MidPeaking -> HighShelf -> Volume -> Gain -> Destination`
2. 目标：
3. 每轨变为多源汇总：`(Vocal Source -> VocalGain) + (Harmonic Source -> HarmonicGain) + (Bass Source -> BassGain) + (Drums Source -> DrumsGain) -> Volume -> Gain -> Destination`
4. 3 stems 工程移除 `Bass Source/Gain`。
5. 移除所有 `resolveEntryEqDbValue('high'|'mid'|'low')` 相关逻辑。
6. 现实现（2026-02-28）：已接入独立 stem 音源，节点图为  
7. `(Vocal Source -> VocalGain) + (Harmonic Source -> HarmonicGain) + (Bass Source -> BassGain) + (Drums Source -> DrumsGain) -> StemBus -> Volume -> Gain -> Destination`。
8. 3 stems 工程仅创建 `vocal/harmonic/drums` 三路，`bass` 不创建。

## 导出链路改造
1. OfflineAudioContext 与实时播放保持同构节点结构（避免听感偏差）。
2. 导出阶段直接读取 stem 音频文件（`stem*Path`），不再使用三段 EQ 自动化。
3. 进度阶段保留：准备、解码、调度、渲染、编码、收尾。

## 波形改造
1. 当前 `MixxxWaveformData.bands.low/mid/high/all` 不再满足 stem 语义。
2. D2-1 落地后，Mixtape 专用结构为 `StemWaveformDataLite`：
3. `duration/sampleRate/step + all(left/right/peakLeft/peakRight)`（每个 stem 各一份）。
4. 展示风格按 djay 口径：优先采用分栏（split）stem 波形。
5. `3 stems` 分 3 栏，`4 stems` 分 4 栏；每栏颜色固定，整体时间轴共享。
6. 现实现（D1）：时间线与预渲染链路已改为“每 stem 文件路径独立拉取波形/原始波形”，并在单轨道内按分栏子行绘制。
7. 当前口径：不再回退旧 RGB 单栏语义；stem 路径缺失时保持空白占位并走状态提示/重试链路。
8. 现实现（D2-2）：在分离完成与缓存命中时均主动预热 stem bundle，减少首次进入时间线的冷启动。

## D2 评估结论（2026-02-28）
1. 结论：上。D2-1 已落地：引入 Mixtape 专用 `StemWaveformDataLite` 缓存结构（每 stem 仅 `all` 通道）。
2. 兼容策略：不兼容旧格式、旧实现、旧数据；通过 `STEM_WAVEFORM_CACHE_VERSION` 升级触发旧缓存失效重建。
3. 已消除瓶颈：Mixtape 主链路不再依赖 `MixxxWaveformData.low/mid/high/all` 语义，类型已收敛为 stem 专用结构。
4. 当前缓存主键：按“源曲目 + stemMode + model + stemVersion（+targetRate）”索引，缓存粒度为“每源曲目一组 stems”。
5. 当前返回链路：`mixtape-stem-waveform-cache:batch` 已直接返回 stem-lite 数据，worker/renderer 按 `all` 渲染。
6. D2-2 已做：在 stem 分离任务 `ready` 与 `readyFromCache` 两条路径都主动预热 bundle，减少首次进入工程的冷启动等待。
7. 风险控制：仍需做一轮回归（3 stems/4 stems、stem 路径缺失、播放门禁、导出门禁、超时重试）。

## UI 与交互改造
1. `Mixtape` 顶部参数项按工程模式动态渲染。
2. i18n 文案替换：
3. `mixParamHigh/mixParamMid/mixParamLow` -> `mixParamVocal/mixParamHarmonic/mixParamBass/mixParamDrums`
4. 4 stems 工程显示 `bass` 参数；3 stems 不显示。
5. Stem 参数不绘制包络线与控制点；编辑方式改为“段落选择按钮”（交互形态与音量段落按钮一致）。
6. `gain/volume` 仍保留包络编辑器；Stem 的段落结果与 `gain/volume` 共同作用于最终增益。
7. 包络编辑器、段落选择器、预览图例、撤销栈参数类型同步改造。

## 旧数据迁移策略（建议）
1. 旧工程首次打开时执行一次性迁移到新结构。
2. `gainEnvelope` 与 `volumeEnvelope` 原样保留。
3. `high/mid/low` 不做语义映射，统一丢弃并重置为平直（1.0）。
4. 迁移后打标 `stemMigrated=true`，避免重复迁移。
5. 不再提供“回退到旧 EQ”入口。

## 错误与容错
1. Demucs 分离失败：轨道标记 `failed`，给出错误摘要和重试按钮。
2. 分离未完成：禁止进入导出，播放时跳过该轨并提示。
3. stem 文件缺失：触发一致性修复（重试分离或标记失败）。
4. 任何情况下不回退旧 EQ 路径。
5. 分离超时：按设备动态阈值失败并尽快返回；CPU 不再允许 `3600s` 长挂。

## 待讨论（本轮新增）
1. 波形“看起来不对”主要是视觉规范问题，不是 stem 语义问题：需定义分栏高度、间距、颜色、峰值归一化口径。
2. 是否提供 `Single / Split` 视图切换：djay 有该切换；FRKB 当前为 split-only（符合“废弃旧 RGB”口径，但可讨论是否要提供不带 EQ 语义的 `Single` 聚合视图）。
3. 空白波形场景需继续压缩：对 `failed(超时)` 的自动补重试已加，仍需观察极端长音频与低性能 CPU 的稳定性。

## 分阶段实施（建议）
1. 阶段 A：数据结构与创建工程选择
2. 增加 `stemMode`、IPC 参数、前端创建工程 UI、Schema 升级。
3. 阶段 B：Demucs 任务队列与导入即分离（拆分 B1/B2）
4. B1：资产表、任务队列、状态持久化、失败重试、播放/导出门禁。
5. B2：真实独立 stem 音源接入与缓存治理联动。
6. 阶段 C：播放/导出链路切换到 stem
7. 完整替换 EQ 播放图和 Offline 渲染图。
8. 阶段 D：波形与缓存重构
9. D1 已完成：按 stem 分栏渲染 + 按 stem 文件路径加载/缓存（含 worker 预渲染链路）。
10. D2 已定案：引入 stem 专用波形结构并执行 cache schema 破坏式迁移（不做旧格式兼容）。
11. 阶段 E：清理旧代码
12. 删除 high/mid/low 相关类型、i18n、DB 字段读写分支。

## 当前剩余待办（建议顺序）
1. E：清理 `high/mid/low` 遗留类型与分支，收敛到 `gain + stems + volume` 单口径。
2. E：补回归清单（3 stems/4 stems、stem 路径缺失、导出门禁、播放门禁）。

## 验收标准（草案）
1. 新建工程可选择 3/4 stems，且创建后不可修改。
2. 导入歌曲后自动分离，状态可见，失败可重试。
3. 播放、参数编辑、导出在两种模式下都能完成，且不依赖旧 EQ。
4. 波形显示与参数通道一致（3 stems 不出现 bass，4 stems 出现 bass）。
5. Stem 参数仅支持段落选择，不出现包络曲线；且最终结果仍遵从 `gain/volume` 包络。
6. 代码库中不再存在混音主链路对 `high/mid/low EQ` 的依赖。

## 涉及核心文件（持续更新）
1. `src/renderer/src/Mixtape.vue`
2. `src/renderer/src/composables/mixtape/types.ts`
3. `src/renderer/src/composables/mixtape/gainEnvelope.ts`
4. `src/renderer/src/composables/mixtape/timelineTransportAndDrag.ts`
5. `src/renderer/src/composables/mixtape/timelineTransportRenderWav.ts`
6. `src/renderer/src/composables/mixtape/timelineHelpers.ts`
7. `src/renderer/src/composables/mixtape/timelineRenderAndLoad.ts`
8. `src/renderer/src/composables/mixtape/timelineWorkerBridge.ts`
9. `src/renderer/src/composables/mixtape/timelineWatchAndMount.ts`
10. `src/renderer/src/workers/mixtapeWaveformRender.types.ts`
11. `src/renderer/src/workers/mixtapeWaveformRender.frame.ts`
12. `src/renderer/src/composables/mixtape/waveformDraw.ts`
13. `src/renderer/src/composables/mixtape/stemMode.ts`
14. `src/main/ipc/mixtapeHandlers.ts`
15. `src/main/mixtapeDb.ts`
16. `src/main/mixtapeStemDb.ts`
17. `src/main/services/mixtapeStemQueue.ts`
18. `src/main/demucs.ts`
19. `src/main/libraryDb.ts`
20. `src/main/services/scanSongs.ts`
