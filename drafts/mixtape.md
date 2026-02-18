# Mixtape 时间线与节拍对齐草案（精简维护版）

更新时间：2026-02-18

## 文档定位
1. 本文仅记录自动混音（Mixtape）当前已实现能力、明确边界和核心入口。
2. 不记录实现噪音（临时调试、微小样式参数、一次性联调细节）。
3. 用于开发、测试、产品对齐口径，不替代完整需求文档。

## 当前实现（与代码一致）

### 时间线交互
1. 双轨（2 lanes）时间线，轨道仅支持 X 轴拖拽。
2. 同 lane 不允许重叠，不同 lane 允许时间交叠。
3. 拖拽吸附以上一首轨道（按 `mixOrder`）网格为参考。
4. 吸附命中后，可自动把当前轨 `bpm` 对齐到上一轨 `bpm`，并保持 `masterTempo` 为启用态。
5. 轨道关键属性变化（位置/BPM/网格定义）会触发时间线重绘与缓存刷新。

### 网格与节拍
1. 网格计算口径为 `bpm + firstBeatMs + barBeatOffset`，不是固定从 `0ms` 起算。
2. BPM 改写会同步影响轨道时长换算与网格间距。
3. 已修正高倍缩放下网格与波形可视偏移：
4. raw 波形优先使用 raw 时长参与时间映射。
5. 网格绘制按精确 `startSec` 做补偿，降低 1~2px 级的上下错位。

### 缩放与渲染
1. 缩放范围为 `0.1 ~ 20`。
2. 缩放参数已平滑化，减少“跳倍率/跳档”感。
3. 时间线渲染同时支持主线程与 worker 路径，缓存按缩放级别与轨道状态隔离。
4. 两条轨道高度已下调至历史版本的一半，提高信息密度并降低绘制像素负载。

### 播放与解码
1. 时间线播放基于 Web Audio。
2. 解码采用双路径：浏览器原生解码优先，失败回退 IPC（Rust/FFmpeg）。
3. 打开窗口和轨道集合变化会触发预解码，播放时复用缓存。

### Beat Align（节拍校准）
1. 支持在对话框中调整 BPM、首拍偏移与大节相位，并保存到 mixtape 项。
2. 保存后更新时间线与 mixtape 持久化数据，不改主曲库原始元数据。

### 缺失文件恢复与删除保护
1. `mixtape:list` 前执行缺失对账：原路径 -> 回收站 -> vault。
2. 未命中的轨道会从 mixtape 中移除，并在前端提示结果。
3. 删除混音歌单时，若对应混音窗口仍打开会被阻止。

### 时间尺可读性
1. 时间尺首尾标签已做边缘防遮挡：
2. 左边界（含 `0`）向右展开显示。
3. 右边界标签向左展开显示。
4. 中间标签保持居中。

## 明确未覆盖/未实现
1. `masterTempo` 目前仍是业务标记，未接入实时不变调算法（当前链路仍有 `playbackRate` 变速）。
2. 时间线 transport 缓存与 Beat Align 缓存尚未统一。
3. 导出链路（OfflineAudioContext + 编码器）不在本文范围。

## 关键数据字段（Mixtape Track）
1. `bpm`：当前目标 BPM（可被吸附或校准改写）。
2. `gridBaseBpm`：网格校准基准 BPM（用于比较与保存判定）。
3. `originalBpm`：原始 BPM（回退比较口径）。
4. `startSec`：轨道在全局时间线起点秒数。
5. `firstBeatMs`：首拍偏移毫秒数。
6. `barBeatOffset`：大节相位偏移（拍）。
7. `masterTempo`：主节拍同步标记位。

## 关键代码入口
1. `src/renderer/src/composables/mixtape/useMixtapeTimeline.ts`
2. `src/renderer/src/composables/mixtape/timelineTransportAndDrag.ts`
3. `src/renderer/src/composables/mixtape/timelineRenderAndLoad.ts`
4. `src/renderer/src/composables/mixtape/timelineWorkerBridge.ts`
5. `src/renderer/src/composables/useMixtape.ts`
6. `src/renderer/src/Mixtape.vue`
7. `src/renderer/src/components/mixtapeBeatAlignDialog.vue`
8. `src/main/ipc/mixtapeHandlers.ts`
9. `src/main/mixtapeDb.ts`
