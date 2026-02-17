# Mixtape 时间线与节拍对齐草案（实现对齐版）

更新时间：2026-02-17

## 文档范围
1. 本文只描述“当前代码已实现行为”和“明确未实现项”。
2. 历史版本中与现状不符的描述已删除或改写。
3. 本文不替代产品需求文档，重点是给开发和联调对齐口径。

## 当前实现总览

### 自动混音时间线
1. 轨道支持水平拖拽（X 轴），不支持垂直换轨。
2. 吸附逻辑基于“上一首（按 `mixOrder`）”的大节网格（32 beat）。
3. 吸附锚点为：`上一首 startSec + 上一首 firstBeatMs/1000`。
4. 吸附阈值是像素阈值换算秒：`14 / pxPerSec`。
5. 吸附命中后，当前轨 `bpm` 自动对齐上一首 `bpm`，并将 `masterTempo` 设为 `true`。
6. 同一 lane 内禁止重叠，不同 lane 允许时间交叠。
7. 拖拽约束基于“起拖快照”，只约束当前轨，不做同 lane 其他轨道联动挤压。
8. 轨道变更（位置/BPM/首拍等）会立即停止 transport，避免播放态与时间线状态不一致。

### 播放与预解码（时间线）
1. 时间线播放统一使用 Web Audio 图：`AudioBufferSourceNode -> GainNode -> destination`。
2. 解码是双路径策略，不是单一路径。
3. `browser` 路径：`fetch + decodeAudioData`（浏览器可解码格式优先）。
4. `ipc` 路径：主进程 `mixtape:decode-for-transport`（Rust/FFmpeg）。
5. `browser` 解码失败会自动回退到 `ipc`。
6. 打开窗口与轨道列表变化时会触发全量预解码（按去重后的 `filePath`）。
7. 预解码期间显示全局进度遮罩（`done/total/percent`）。
8. 播放时优先复用窗口级 `AudioBuffer` 缓存；同文件并发解码通过 in-flight Promise 去重。
9. 点击时间尺可从目标时间启动播放；顶部按钮支持从头播放/停止。
10. 播放头是单一全局时间基准，同时渲染在时间尺、主时间线、overview。

### BPM/首拍分析（firstBeatMs）
1. Rust 分析返回 `bpm` 与 `firstBeatMs`，主进程统一接收并落库。
2. 在 `mixtape:append`（加入混音库）时即触发后台批量分析（非阻塞返回）。
3. 打开自动混音窗口后，会对缺失 `bpm/firstBeatMs` 的轨道补跑分析。
4. 分析结果写回 `mixtape_items.info_json`，字段为 `bpm` 与 `firstBeatMs`。
5. 前端加载轨道时优先读持久化结果；无有效值时 `firstBeatMs` 回退 `0`。
6. 网格线绘制统一使用轨道上的 `bpm + firstBeatMs`，不再固定从 `0ms` 起算。

### 节拍对齐 Dialog（Beat Align）
1. 主波形使用高细节波形渲染（`mixtape-waveform-hires:batch`，目标 `4kHz`）。
2. 概览波形使用缓存波形 + raw 波形金字塔（`cache:batch` + `raw:batch`）。
3. 缩放范围 `50x ~ 100x`，默认 `50x`。
4. 顶部控制区包含播放/暂停、网格线点选设大节线（开关态）、节拍器。
5. 主波形左侧 `1/3` 固定播放锚线：锚线不动，波形窗口随播放滚动。
6. 播放起点按锚线时间计算，不再固定从可视窗口最左侧起播。
7. 主波形和概览都引入左侧前置留白，解决开头片段无法在锚线处播放的问题。
8. Dialog 加载波形时会后台 warmup 预解码，减少首次点播出现“解码中”。
9. Dialog 内部解码做了 in-flight 去重，避免 warmup 与手动播放并发重复解码。
10. 支持方向键左右微调播放锚点：每次按键移动 `4` 拍（基于当前预览 BPM 换算秒）。
11. 主波形支持按住左键水平拖拽；拖拽时持续输出“拉扯感”试听，松手后瞬时回到正常播放。
12. 概览波形可视窗口支持左键拖拽；播放态下拖拽不自动停播，拖拽结束后继续按新锚点播放。
13. 主波形播放滚动采用增量渲染复用，避免每帧全量重绘导致的“低帧率感”。
14. 拖拽试听链路使用 `AudioWorkletNode`，主线程下发目标位置/速度，Worklet 内做连续速率平滑与 Hermite 插值。
15. Worklet 增加“无新拖拽输入超时归零”（约 `38ms`）机制，避免手停后声音继续滑动。
16. 主波形与概览之间新增网格调整工具栏，布局为左对齐、无背景/无外框、24px 高。
17. 工具栏包含 5 个网格按钮。
18. 按钮 1“将当前播放竖线设为大节线”是平移网格实现：通过改 `firstBeatMs` 让大节线精确对齐当前播放竖线，不改 `barBeatOffset`。
19. 按钮 2~5 分别是网格左大移、左小移、右小移、右大移；按毫秒位移。
20. 当前位移步长为：小步 `5ms`，大步 `20ms`。
21. 位移按钮支持长按连发：按住超过 `1s` 后开始连发，频率 `4Hz`（每 `250ms` 一次）。
22. 位移采用循环语义：越过首末不会停住，会按一个大节周期取模回绕。
23. 工具栏含 BPM 输入框（`step=0.01`、`min=1`、`max=300`），显示固定两位小数。
24. BPM 输入改动会实时影响网格间隔与预览计算，不必先保存。
25. BPM 输入框右侧含 `Tap` 按钮，点击节拍可估算 BPM 并实时更新网格。
26. Tap 口径与主播放器一致：取最近点击间隔均值，过滤异常间隔，点击窗口上限 8 次。
27. Tap 新增 5 秒超时清零：超过 `5s` 未继续点击，Tap 计数重置。
28. 底部按钮语义为“保存/取消”：只有点击保存才把修改生效；取消直接丢弃草稿。
29. 保存 payload 为 `barBeatOffset + firstBeatMs + bpm`。
30. 保存时会更新 mixtape 轨道持久化（`info_json`），不改主曲库。
31. 保存时 BPM 只在“输入 BPM 与该曲原始 BPM 不一致”时才写入 mixtape 的 `bpm` 字段。

## 明确未实现项（避免误解）
1. `masterTempo` 仍是业务标记位，尚未接入实时变速不变调算法（当前仍是 `playbackRate` 变速）。
2. 时间线 transport 缓存与 Beat Align Dialog 缓存尚未共享，属于两套缓存体系。
3. 导出链路（OfflineAudioContext + 编码器联动）不在本草案覆盖范围内。

## 数据字段口径（Mixtape Track）
1. `originalBpm`：原始 BPM（用于比较是否需要覆盖 mixtape BPM）。
2. `bpm`：自动混音窗口中的当前目标 BPM（可被吸附逻辑或 Beat Align 保存改写）。
3. `masterTempo`：是否启用 Master Tempo（当前仅标记态）。
4. `startSec`：轨道在全局时间线的起点秒数。
5. `firstBeatMs`：首拍偏移毫秒数（用于网格锚点，也用于节拍对齐位移保存）。
6. `barBeatOffset`：大节线相位偏移（以拍为单位，主要由“网格线点选设大节线”修改）。

## 关键触发时序
1. 加入混音库：`mixtape:append` -> 后台分析 `bpm + firstBeatMs` -> 回写 DB -> 广播增量结果。
2. 打开混音窗口：加载轨道 -> 对缺失项补跑分析 -> 时间线调度预解码与波形加载。
3. 打开 Beat Align：加载主/概览波形 -> 并行 warmup 预解码 -> 用户播放时优先复用缓存。
4. Beat Align 调整：所有操作只改 Dialog 草稿态（`barBeatOffset/firstBeatMs/bpm`），不立即写回主视图。
5. 点击保存：前端更新同文件轨道的网格定义并调用 `mixtape:update-grid-definition`；主进程仅更新 `mixtape_items.info_json`。

## 核心代码入口（按职责分组）
1. 时间线主编排：`src/renderer/src/composables/mixtape/useMixtapeTimeline.ts`
2. 时间线播放与拖拽：`src/renderer/src/composables/mixtape/timelineTransportAndDrag.ts`
3. 时间线挂载与监听：`src/renderer/src/composables/mixtape/timelineWatchAndMount.ts`
4. 时间线渲染与波形加载：`src/renderer/src/composables/mixtape/timelineRenderAndLoad.ts`
5. 轨道业务与分析补跑/保存：`src/renderer/src/composables/useMixtape.ts`
6. 混音窗口 UI：`src/renderer/src/Mixtape.vue`
7. 节拍对齐 Dialog：`src/renderer/src/components/mixtapeBeatAlignDialog.vue`
8. 节拍对齐顶部控制区：`src/renderer/src/components/mixtapeBeatAlignTopControls.vue`
9. 节拍对齐网格调整工具栏：`src/renderer/src/components/mixtapeBeatAlignGridAdjustToolbar.vue`
10. 节拍对齐网格逻辑：`src/renderer/src/components/mixtapeBeatAlignGridAdjust.ts`
11. 节拍对齐播放控制：`src/renderer/src/components/mixtapeBeatAlignPlayback.ts`
12. 节拍对齐主波形绘制：`src/renderer/src/components/mixtapeBeatAlignWaveform.ts`
13. 节拍对齐概览缓存：`src/renderer/src/components/mixtapeBeatAlignOverviewCache.ts`
14. 节拍对齐主波形增量渲染：`src/renderer/src/components/mixtapeBeatAlignPreviewRenderer.ts`
15. 节拍对齐拖拽试听 Worklet：`src/renderer/src/workers/mixtapeBeatAlignScrub.worklet.js`
16. 混音 IPC 与追加触发分析：`src/main/ipc/mixtapeHandlers.ts`
17. 分析结果/网格定义持久化：`src/main/mixtapeDb.ts`
18. 主进程解码 IPC：`src/main/window/mainWindow/audioDecodeHandlers.ts`
19. 分析 Worker：`src/main/workers/keyAnalysisWorker.ts`
20. Rust 分析入口：`rust_package/src/lib.rs`
21. Rust BPM/首拍桥接：`rust_package/src/qm_bpm.rs`
22. QM 首拍实现：`rust_package/native/qm/qm_bpm_wrapper.cpp`

## 修订说明（本次清理）
1. 删除“Beat Align 仅预览、未支持保存”的旧说法，改为“保存/取消草稿语义”。
2. 新增中间网格工具栏口径：5 个网格按钮、长按连发、循环位移、BPM 输入与 Tap。
3. 明确“将当前播放竖线设为大节线”是通过 `firstBeatMs` 平移网格，不是改 `barBeatOffset`。
4. 明确 BPM 输入上限 `300`、两位小数显示、`0.01` 步进。
5. 明确 BPM 持久化口径：仅在保存且与原始 BPM 不一致时改 mixtape BPM，不改主曲库。
