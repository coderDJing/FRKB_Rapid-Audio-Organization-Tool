# Mixtape 时间线与节拍对齐草案（实现对齐版）

更新时间：2026-02-15

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
2. 解码是双路径策略，不是单一路径：
   - `browser`：`fetch + decodeAudioData`（浏览器可解码格式优先）。
   - `ipc`：主进程 `mixtape:decode-for-transport`（Rust/FFmpeg）。
3. `browser` 解码失败会自动回退到 `ipc`。
4. 打开窗口与轨道列表变化时会触发全量预解码（按去重后的 `filePath`）。
5. 预解码期间显示全局进度遮罩（`done/total/percent`）。
6. 播放时优先复用窗口级 `AudioBuffer` 缓存；同文件并发解码通过 in-flight Promise 去重。
7. 点击时间尺可从目标时间启动播放；顶部按钮支持从头播放/停止。
8. 播放头是单一全局时间基准，同时渲染在时间尺、主时间线、overview。

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
4. 增加播放/暂停按钮，支持空格键播放暂停（输入控件聚焦时不劫持空格）。
5. 主波形左侧 `1/3` 固定播放锚线：锚线不动，波形窗口随播放滚动。
6. 播放起点按锚线时间计算，不再固定从可视窗口最左侧起播。
7. 主波形和概览都引入左侧前置留白，解决开头片段无法在锚线处播放的问题。
8. Dialog 加载波形时会后台 warmup 预解码，减少首次点播出现“解码中”。
9. Dialog 内部解码也做了 in-flight 去重，避免 warmup 与手动播放并发重复解码。

## 明确未实现项（避免误解）
1. 节拍对齐 Dialog 目前仅做“自动分析结果预览 + 试听”，未落地“手动调首拍并保存”流程。
2. `masterTempo` 仍是业务标记位，尚未接入实时变速不变调算法（当前仍是 `playbackRate` 变速）。
3. 时间线 transport 缓存与 Beat Align Dialog 缓存尚未共享，属于两套缓存体系。
4. 导出链路（OfflineAudioContext + 编码器联动）不在本草案覆盖范围内。

## 数据字段口径（Mixtape Track）
1. `originalBpm`：原始 BPM（用于计算 tempo ratio）。
2. `bpm`：当前目标 BPM（可被吸附逻辑改写）。
3. `masterTempo`：是否启用 Master Tempo（当前仅标记态）。
4. `startSec`：轨道在全局时间线的起点秒数。
5. `firstBeatMs`：首拍偏移毫秒数（用于网格锚点）。

## 关键触发时序
1. 加入混音库：`mixtape:append` -> 后台分析 `bpm + firstBeatMs` -> 回写 DB -> 广播增量结果。
2. 打开混音窗口：加载轨道 -> 对缺失项补跑分析 -> 时间线调度预解码与波形加载。
3. 打开 Beat Align：加载主/概览波形 -> 并行 warmup 预解码 -> 用户播放时优先复用缓存。

## 核心代码入口（按职责分组）
1. 时间线主编排：`src/renderer/src/composables/mixtape/useMixtapeTimeline.ts`
2. 时间线播放与拖拽：`src/renderer/src/composables/mixtape/timelineTransportAndDrag.ts`
3. 时间线挂载与监听：`src/renderer/src/composables/mixtape/timelineWatchAndMount.ts`
4. 时间线渲染与波形加载：`src/renderer/src/composables/mixtape/timelineRenderAndLoad.ts`
5. 轨道业务与分析补跑：`src/renderer/src/composables/useMixtape.ts`
6. 混音窗口 UI：`src/renderer/src/Mixtape.vue`
7. 节拍对齐 Dialog：`src/renderer/src/components/mixtapeBeatAlignDialog.vue`
8. 节拍对齐播放控制：`src/renderer/src/components/mixtapeBeatAlignPlayback.ts`
9. 节拍对齐主波形绘制：`src/renderer/src/components/mixtapeBeatAlignWaveform.ts`
10. 节拍对齐概览缓存：`src/renderer/src/components/mixtapeBeatAlignOverviewCache.ts`
11. 混音 IPC 与追加触发分析：`src/main/ipc/mixtapeHandlers.ts`
12. 分析结果持久化：`src/main/mixtapeDb.ts`
13. 主进程解码 IPC：`src/main/window/mainWindow/audioDecodeHandlers.ts`
14. 分析 Worker：`src/main/workers/keyAnalysisWorker.ts`
15. Rust 分析入口：`rust_package/src/lib.rs`
16. Rust BPM/首拍桥接：`rust_package/src/qm_bpm.rs`
17. QM 首拍实现：`rust_package/native/qm/qm_bpm_wrapper.cpp`

## 修订说明（本次清理）
1. 删除了“所有格式统一后端解码”的旧说法，改为“browser/ipc 双路径 + 失败回退”。
2. 删除了“波形轨内各轨局部播放头”的旧说法，改为“单一全局播放头”。
3. 把“已实现”和“未实现”拆开，避免将规划误读为现状。
4. 统一了首拍分析触发时机描述：入库即分析、开窗补跑、结果持久化复用。
