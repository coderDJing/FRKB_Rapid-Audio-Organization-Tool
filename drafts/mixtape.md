# Mixtape 时间线与节拍对齐草案（精简维护版）

更新时间：2026-02-24

## 文档定位
1. 本文仅记录自动混音（Mixtape）当前已实现能力、明确边界和核心入口。
2. 不记录临时调试信息和一次性联调细节。
3. 用于开发、测试、产品对齐口径，不替代完整需求文档。

## 当前实现（与代码一致）

### 时间线交互
1. 双轨（2 lanes）时间线，轨道仅支持 X 轴拖拽。
2. 同 lane 不允许重叠，不同 lane 允许时间交叠。
3. 轨道拖拽为强制吸附，不允许自由对齐：
4. 仅显示大节线时按大节吸附。
5. 显示小节线时按小节吸附（含大节）。
6. 显示节拍线时按节拍吸附（含小节和大节）。
7. 拖拽优先对齐上一首轨道（按 `mixOrder`）网格锚点，不可用时回退全局网格锚点。
8. 若命中上一首网格锚点，会自动把当前轨 `bpm` 对齐到上一轨 `bpm`，并把 `masterTempo` 置为启用。
9. 拖拽结束时会持久化 `startSec/bpm/masterTempo/originalBpm`，并在 `bpm` 变化时同步持久化段落静音。

### 网格与节拍
1. 网格口径为 `bpm + firstBeatMs + barBeatOffset`，不是固定从 `0ms` 起算。
2. BPM 改写会同步影响轨道时长换算与网格间距。
3. raw 波形优先使用 raw 时长参与时间映射。
4. 网格绘制按精确 `startSec` 补偿，降低高缩放下的像素级错位。

### 包络编辑（gain/high/mid/low/volume）
1. 包络点只能落在当前可见网格线上（无 BPM 或无法解算网格时不允许新增/拖拽）。
2. 同一网格线最多允许 2 个点，用于表达瞬间跳变。
3. 同网格双点拖拽时锁定 X 轴，避免点位跳到前后网格。
4. 交互口径为：单击加点、拖拽调节、双击删除点。
5. 右键删除已禁用（包络点右键菜单不再生效）。

### 音量段落静音
1. 音量参数页提供“段落静音”模式按钮。
2. 开启后按当前可见网格粒度选择段落：
3. 仅大节可见时按大节段落。
4. 小节可见时按小节段落。
5. 节拍可见时按节拍段落。
6. 支持拖选多段，拖动过程中实时预览静音遮罩。
7. 重复选择同一段会取消静音（toggle）。
8. 段落静音遮罩（淡红色）在所有参数页均常显，不仅限音量参数页。
9. 段落静音持久化字段为 `volumeMuteSegments`，存储为离散网格段，不合并相邻段。
10. 若拖拽对齐引起 `bpm` 变化，静音段会按“网格拍索引”重映射到新网格，避免视觉偏移。

### Beat Align（节拍校准）
1. 支持在对话框中调整 BPM、首拍偏移与大节相位，并保存到 mixtape 项。
2. 保存后只更新 mixtape 项数据，不改主曲库原始元数据。
3. 当保存会导致网格位置变化（首拍或 BPM 变化）时，会弹确认提示。
4. 确认后会把同源轨道实例的 `gain/high/mid/low/volume` 包络重置为平直，并清空段落静音。
5. 包络与段落静音重置会立即持久化。

### 播放与解码
1. 时间线播放基于 Web Audio。
2. 解码采用双路径：浏览器原生解码优先，失败回退 IPC（Rust/FFmpeg）。
3. 打开窗口和轨道集合变化会触发预解码，播放时复用缓存。
4. 播放时音量实际增益 = 音量包络值 × 段落静音遮罩（静音段为极低增益）。

### 缺失文件恢复与删除保护
1. `mixtape:list` 前执行缺失对账：原路径 -> 回收站 -> vault。
2. 未命中的轨道会从 mixtape 中移除，并在前端提示结果。
3. 删除混音歌单时，若对应混音窗口仍打开会被阻止。

## 明确未覆盖/未实现
1. `masterTempo` 目前仍是业务标记，未接入实时不变调算法（当前链路仍有 `playbackRate` 变速）。
2. 时间线 transport 缓存与 Beat Align 缓存尚未统一。
3. 导出链路（OfflineAudioContext + 编码器）不在本文范围。

## 关键数据字段（Mixtape Track）
1. `bpm`：当前目标 BPM（可被拖拽吸附或校准改写）。
2. `gridBaseBpm`：网格校准基准 BPM（用于比较与保存判定）。
3. `originalBpm`：原始 BPM（回退比较口径）。
4. `startSec`：轨道在全局时间线起点秒数。
5. `firstBeatMs`：首拍偏移毫秒数。
6. `barBeatOffset`：大节相位偏移（拍）。
7. `masterTempo`：主节拍同步标记位。
8. `gainEnvelope/highEnvelope/midEnvelope/lowEnvelope/volumeEnvelope`：参数包络数据。
9. `volumeMuteSegments`：音量段落静音区间集合（离散网格段）。

## 关键代码入口
1. `src/renderer/src/composables/mixtape/useMixtapeTimeline.ts`
2. `src/renderer/src/composables/mixtape/timelineTransportAndDrag.ts`
3. `src/renderer/src/composables/mixtape/useGainEnvelopeEditor.ts`
4. `src/renderer/src/composables/mixtape/volumeMuteSegments.ts`
5. `src/renderer/src/composables/useMixtape.ts`
6. `src/renderer/src/Mixtape.vue`
7. `src/renderer/src/components/mixtapeBeatAlignDialog.vue`
8. `src/main/ipc/mixtapeHandlers.ts`
9. `src/main/mixtapeDb.ts`
