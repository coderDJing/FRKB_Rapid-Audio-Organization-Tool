# Mixtape 时间线重构说明（草案）

更新时间：2026-02-14

## 本轮目标
1. 自动混音轨道支持左右拖动。
2. 拖动时按大节线（32 beat）吸附。
3. 两首歌对齐吸附成功时，自动把靠后一首歌 BPM 对齐到前一首歌 BPM。
4. BPM 对齐后默认保持 Master Tempo（变速不变调）。
5. 新增顶部时间轨，点击任意位置即可从该时间点开始播放。
6. 新增播放头竖线：时间轨与波形轨同步实时移动。
7. 播放自动停止条件：
   - 用户主动停止
   - 用户修改曲目相关内容（拖动、吸附引发 BPM 变化、列表变化等）
   - 播放到混音末尾

## 交互规则
1. 轨道拖拽仅允许水平移动（X 轴）。
2. 吸附优先基于前一首歌的大节网格（32 beat）。
3. 吸附阈值使用像素阈值换算秒（与当前缩放联动）。
4. 吸附触发且前后曲目 BPM 有效时：
   - 后一首歌 `bpm -> 前一首歌 bpm`
   - 后一首歌 `masterTempo = true`
5. 轨道发生位置或 BPM 改动后，当前播放立即停止，避免播放状态与时间线状态不一致。
6. 轨道位置约束：允许空隙；同一条波形轨（lane）内禁止重叠，不同波形轨允许时间交叠。
7. 拖拽时基于“起拖快照”只约束当前被拖动轨道，不联动挤压同轨其他轨道，避免出现整条 lane 贴边连锁移动。

## 时间轨 / 播放头
1. 时间轨放在混音窗口时间线顶部，与主时间轴同宽、同滚动。
2. 点击时间轨位置后：
   - 设置全局播放时间
   - 从该位置启动 transport
3. 播放头竖线使用统一时间基准（秒）换算 X 坐标，在时间轨、波形主轨和底部全局 overview 轨同时显示；波形主轨为跨两条 lane 的单根全局竖线。
4. 播放时每帧更新播放头位置，停止后冻结在当前时间。

## 播放架构（Phase 1 — 统一 AudioBuffer 音频图）

### 架构概览
所有格式统一走后端解码 → Web Audio API 音频图。混音窗口打开后即启动全量预解码，播放阶段优先消费内存中的 `AudioBuffer`。

```
主进程 Rust/FFmpeg 解码 → PCM Float32 via IPC → AudioBuffer
    → AudioBufferSourceNode → GainNode → AudioContext.destination
```

### 单轨音频图（Phase 1）
```
AudioBufferSourceNode  (playbackRate 控制速度)
        ↓
    GainNode           (未来挂载增益/音量包络线)
        ↓
AudioContext.destination
```

### 速度与 Master Tempo
1. 单曲速度比率：`tempoRatio = targetBpm / originalBpm`。
2. 当前通过 `AudioBufferSourceNode.playbackRate` 实现变速，音高会随速度变化。
3. Master Tempo（变速不变调）计划在 Phase 3 通过 SoundTouch/Rubberband WASM AudioWorklet 实现。

### 解码流程
1. 混音窗口加载轨道后，自动按去重后的 `filePath` 全量预解码。
2. 主进程 Rust 优先用 Symphonia 解码（mp3/flac/wav/ogg 等），不支持的格式自动降级到 FFmpeg（ape/tak/wv/dts/wma 等）。
3. 预解码期间 UI 显示全局 Loading + 进度（done/total/percent）。
4. 用户点击播放或时间轨跳播时，优先复用预解码 `AudioBuffer`；仅未完成项按需补解码。
5. 窗口关闭时释放内存解码缓存。

### 长期演进路线（讨论中，非本轮）
| 阶段 | 内容 | 效果 |
|------|------|------|
| Phase 1 ✅ | 统一 AudioBuffer + 基础音频图 (Source → Gain → dest) | 全格式可播，为音频图打基础 |
| Phase 2 | 加入 3-band EQ + 音量/增益/EQ 包络线自动化 | 可实时预览 EQ 和音量变化 |
| Phase 3 | 引入 SoundTouch/Rubberband WASM AudioWorklet | Master Tempo + 动态 BPM 包络线 |
| Phase 4 | OfflineAudioContext 导出 + FFmpeg 编码 | 完整导出能力 |

## 数据字段（Mixtape Track 运行态）
1. `originalBpm`：曲目原始 BPM（分析结果或初始值）。
2. `bpm`：当前目标 BPM（可被对齐逻辑覆盖）。
3. `masterTempo`：是否保持调性（当前阶段仅作标记，Phase 3 生效）。
4. `startSec`：轨道在全局时间线起点（秒）。
5. `firstBeatMs`：首拍偏移（默认 0）。

## 当前状态
1. 自动混音已有：BPM 分析、双轨渲染、网格线绘制、overview。
2. 自动混音已接入：轨道拖拽、32-beat 吸附、自动 BPM 对齐、Master Tempo 标记。
3. 时间轨已支持点击跳转播放；顶部时间轨播放头为全局进度，波形轨内播放头为各轨局部进度。
4. 轨道标签已展示 `BPM + 调性（Key）`，调性格式遵循全局设置（Classic/Camelot）。
5. **全格式播放已完成**：所有项目声明支持的 20 种音频格式（mp3/wav/flac/aif/aiff/ogg/opus/aac/m4a/mp4/wma/ac3/dts/mka/webm/ape/tak/tta/wv）均可在时间轴播放。
6. **统一 AudioBuffer 音频图**（Phase 1 完成）：移除了 HTML Audio / PCM 双路逻辑，所有轨道统一走后端解码 → AudioContext 音频图。每轨播放路径为 `Source → GainNode → destination`，为后续 EQ/包络线/导出奠定基础。
7. **混音窗口预解码已接入**：打开窗口即全量预解码并显示进度，播放阶段默认走内存 `AudioBuffer`，显著减少点播瞬时卡顿。
8. **BPM 预处理结果已持久化**：后台 BPM 预分析结果写回 `mixtape_items.info_json`，重开窗口可直接复用，避免重复分析遮罩。
9. 当前策略默认面向高内存设备（建议 16GB 及以上），暂不做低内存阈值裁剪。
10. 为满足代码规范，时间线主文件已拆分模块：`useMixtapeTimeline.ts`（主编排）+ `timelineTransportAndDrag.ts` + `timelineWorkerBridge.ts` + `timelineWatchAndMount.ts` + `timelineRenderAndLoad.ts`。

## 验收标准（本轮）
1. 任意轨道可平滑左右拖动，松手可吸附大节线。
2. 吸附成功后，后一首歌 BPM 自动同步到前一首歌 BPM。
3. 播放中可见实时播放头：顶部时间轨展示全局进度，波形轨展示局部进度。
4. 点击时间轨任意位置可从该点开始播放。
5. 轨道编辑或 BPM 自动变化时，播放立即停止。
6. 所有项目声明支持的音频格式均可在时间轴正常播放。

## 影响文件
1. `src/renderer/src/Mixtape.vue`
2. `src/renderer/src/composables/useMixtape.ts`
3. `src/renderer/src/composables/mixtape/useMixtapeTimeline.ts`
4. `src/renderer/src/composables/mixtape/timelineTransportAndDrag.ts`
5. `src/renderer/src/composables/mixtape/timelineHelpers.ts`
6. `src/renderer/src/composables/mixtape/timelineRenderAndLoad.ts`
7. `src/renderer/src/composables/mixtape/timelineWorkerBridge.ts`
8. `src/renderer/src/composables/mixtape/timelineWatchAndMount.ts`
9. `src/renderer/src/composables/mixtape/types.ts`
10. `src/main/window/mainWindow/audioDecodeHandlers.ts`
11. `src/main/ipc/mixtapeHandlers.ts`
12. `src/main/mixtapeDb.ts`
13. `src/renderer/src/i18n/locales/zh-CN.json`
14. `src/renderer/src/i18n/locales/en-US.json`
