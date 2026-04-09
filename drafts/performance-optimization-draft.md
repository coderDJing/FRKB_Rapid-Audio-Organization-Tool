# 网格线 / Raw 波形性能优化草案

更新时间：2026-04-08

## 1. 目标

当前有两条性能敏感链路：

1. `Beat This!` 节拍网格分析
2. 横推双轨区 `raw waveform` 绘制

本草案用于记录：

- 已经做过的优化
- 已踩过的坑
- 当前已知瓶颈
- 下一轮继续优化时的建议切入点

后续新对话可以直接基于这份文档继续，不用再重复回忆上下文。

## 2. 当前结论概览

### 2.1 Beat This!

当前已经做到：

- 不再写整首临时 `wav`
- 使用独立 runtime：
  - `grid-analysis-lab/beat-this-runtime`
- Python bridge 常驻
- 模型常驻
- 软件启动后 worker 会后台预热 `Beat This!`
- 输入改成 Rust 解码后的 PCM 直接通过 `stdin` 喂给 Python bridge
- 分析策略改成：
  - `30s` 固定滑窗
  - 最多扫前 `120s`
  - 窗口序列：
    - `0-30`
    - `30-60`
  - `60-90`
  - `90-120`
  - 每个窗口返回质量分
  - 命中高质量窗口立即提前停止
- 前台优先级策略新增：
  - `key-analysis:queue-visible` 改成 `low + preemptible`
  - `key-analysis:queue-playing` 仍是 `high`
  - `high` 任务现在可抢占：
    - `background`
    - 可让位的列表可视区分析任务

### 2.2 横推 raw waveform

当前已经做到：

- 命中缓存时直接读 `mixtape_raw_waveform_cache`
- 缓存未命中时，改为流式返回 chunk
- 前端可以边收 chunk 边画
- 流式完成后会顺手写入 `mixtape_raw_waveform_cache`
- 如果歌已经有持久化网格，横推首帧就应该先画网格线，不再等 raw waveform 完整返回
- Horizontal Browse raw stream 改成按“当前交互态”动态提权
- 没有固定的 `top > bottom` / `deck1 > deck2`
- 当前策略是：
  - 同一时刻只保一个 active raw stream
  - 新的高优先级 Deck 请求到来时，可抢占低优先级 stream
  - 被抢占的 stream 会保留请求，稍后恢复

## 3. Beat This! 已做优化

### 3.1 已落地优化

1. Python 只负责模型推理
2. Rust 继续负责音频解码
3. 不再用文件路径回读音频
4. Python bridge 改成常驻
5. 启动时 worker 预热 Beat This!
6. BPM 推导由单纯 interval 中位数改成全局线性拟合
7. 分析由整首改为滑窗选优

### 3.2 当前核心文件

- `src/main/workers/beatThisAnalyzer.ts`
- `src/main/workers/keyAnalysisWorker.ts`
- `scripts/beat_this_bridge.py`

### 3.3 当前实测结论

以 Ziggy 样本为例：

- 整首 Beat This! 推理：
  - 约 `18~19s`
- `30s` 滑窗：
  - 约 `5s`
- 当前窗口质量分命中：
  - `0-30s`
  - `qualityScore = 0.85`
- 当前输出：
  - `bpm ≈ 137.99`
  - `firstBeatMs = 240`
  - `barBeatOffset = 0`

结论：

- `30s` 滑窗比整首有明显收益
- 但目前 `5s` 仍偏慢，只能算勉强可接受的实验态，不是最终产品态

## 4. Beat This! 已踩坑

### 4.1 误以为是 Python 本身慢

不是。

慢的主要来源是：

- PyTorch 模型推理本体

不是：

- Python 启动本身
- 单纯 bridge 协议本身

### 4.2 临时 wav 路线是错误方向

之前做过：

- Rust 解 PCM
- 再把整首 PCM 写成临时 `wav`
- 然后让 Beat This! 重新读文件

问题：

- 额外 IO 浪费
- 重复序列化/反序列化
- 本质是低级绕路

已改为：

- PCM 直接喂 bridge

### 4.3 `torchaudio.load` 在本地 runtime 不可靠

Beat This! 默认优先：

1. `torchaudio`
2. `soundfile`
3. `madmom`

在当前本地 runtime 中：

- `torchaudio` 没可用 backend
- 因此额外补装了 `soundfile`

结论：

- 继续走文件读取链路不稳
- 直接喂 PCM 更靠谱

### 4.4 常驻 bridge 初期看似“卡死”

根因不是模型卡死，而是：

- 测试脚本没有正常关闭 bridge 子进程
- 导致外层等待超时，看起来像“模型不返回”

已补：

- bridge dispose
- 进程退出清理钩子

### 4.5 旧启发式网格算法会给出错误兜底结果

之前旧链路是：

- Rust/QM + JS 首拍/半拍/小节相位启发式

用户明确要求：

- 错误兜底不要保留

因此当前已改成：

- BPM / 网格只认 `Beat This!`
- 不再回退旧启发式网格算法
- 旧文件 `src/main/workers/keyAnalysisBeatGrid.ts` 已删除

## 5. 持久化策略现状

当前方向已经明确：

- 新歌第一次分析后，持久化 `bpm / firstBeatMs / barBeatOffset`
- 之后 songs / deck / mixtape 优先读 shared grid
- 不再重复分析已经有完整网格的歌曲

已改入口：

- `key-analysis:queue-visible`
- `key-analysis:queue-playing`
- 主窗口读歌
- `scanSongs`
- `mixtape` 批量 BPM 分析

共享网格核心文件：

- `src/main/services/sharedSongGrid.ts`
- `src/main/services/keyAnalysis/persistence.ts`

## 6. Raw waveform 已做优化

### 6.1 已落地优化

1. 缓存命中优先直接返回
2. 未命中时走流式 chunk
3. 完成后自动落缓存
4. 横推首帧可先显示网格线
5. 流式完成后再把 rawData 存进 tile worker
6. 拖动/流式阶段开启 `allowScrollReuse`
7. 拖动/流式阶段继续收口重绘频率与重绘范围，但保持最终 RGB 视觉结果
8. raw stream 增加 renderer -> main 的 `priorityHint`
9. 主进程 raw stream 改成可抢占调度，不再固定同时全开
10. 横推 detail 在 tile 未就绪时，优先收口 redraw 频率与脏区范围，而不是牺牲首屏 RGB
11. `resolveRawMonoSampleAtFrame` 对应的 mono 采样改成按 `RawWaveformData` 缓存复用
12. raw stream chunk 到达后，detail 重绘改成节流，不再每块都立刻全刷
13. tile worker 回图后，改成按脏 tile 合成，不再每块 tile 都触发整窗重绘

### 6.2 当前核心文件

- `src/main/workers/mixtapeRawWaveformWorker.ts`
- `src/main/ipc/cacheHandlers.ts`
- `src/renderer/src/components/HorizontalBrowseRawWaveformDetail.vue`
- `src/renderer/src/components/mixtapeBeatAlignWaveform.ts`
- `src/renderer/src/components/mixtapeBeatAlignPreviewRenderer.ts`

## 7. Raw waveform 已踩坑

### 7.1 流式阶段仍然走整首 decode

之前的假流式问题：

- worker 虽然按 chunk 回传
- 但底层还是 `decodeAudioFile` 整首解完再算

已改为：

- `ffmpeg stdout -> PCM chunk -> 聚合 -> chunk 回传`

### 7.2 流式结束时整份数据再回传一次导致卡死

症状：

- 一开始慢慢长出来
- 过一会儿整段卡死

根因：

- `stream-done` 时又把 full rawData 整包回给 renderer

已改为：

- 完成时只回 meta
- 数据写缓存，不再重复灌 full payload

### 7.3 `offset is out of bounds`

症状：

- 前端收 chunk 过程中直接报错

根因：

- 前端预分配数组长度不足
- 后续 chunk `.set(..., startFrame)` 越界

已改为：

- 前端根据 `requiredFrames` 自动扩容

### 7.4 `postMessage could not be cloned`

根因：

- 把带响应式壳子的对象直接丢给 worker

已改为：

- 发送前先做纯净拷贝

### 7.5 拖动时非常卡

已确认原因至少有两类：

1. 拖动时还会整窗重绘
2. 拖动时还在跑 raw FFT 颜色计算

当前已做：

- 拖动阶段强制走更便宜路径
- 禁用 FFT RGB 颜色
- 降低样本密度

但：

- 仍然没有达到理想顺滑程度

### 7.6 跳到别处后波形消失

当前已做兜底：

- tile 没命中时，保留前一帧，或走直接 `rawData` fallback

但这个问题仍需继续观察。

## 8. 当前还没完全解决的性能问题

### 8.1 Beat This! 仍然偏慢

当前已从 `18~19s` 压到大约 `5s`。

还需要继续做的可能方向：

- 低置信度时才触发 Beat This!
- 进一步减少窗口数量
- 并发策略收口
- 长期方案：ONNX / Rust 化

### 8.2 raw waveform 拖动仍不够丝滑

下一轮优先排查：

1. 拖动时每帧 draw 耗时
2. stream chunk 到达频率
3. tile 命中率
4. direct RGB draw / tile 合成耗时

### 8.3 新发现的热点

在 Chrome Performance 里已观察到：

- `resolveRawMonoSampleAtFrame`

问题本质不是只有这个函数名字难看，而是：

1. Deck 刚载入、tile 还没命中时
   - main thread fallback 还会直接跑 raw FFT 颜色
2. raw FFT 在组 FFT 输入时
   - 会高频读取 raw 四路数组
   - 反复做左右声道求平均

本轮已先做两刀：

1. Horizontal Browse detail 优先收口主线程 redraw 频率与脏区刷新
   - 先保输入响应
   - 不靠牺牲首屏 RGB 来换性能
2. mono 样本改成按 `RawWaveformData` 对象缓存
   - 避免 FFT 每次重新拼左右声道平均值

这两刀的目标不是提升最终静态画质，而是先把“刚载入 Deck 时左右拖拽没反应”的问题压下去。

### 8.4 最新 trace 结论（歌单点击 trace）

从导出的歌单 trace 看，当前主卡点已经进一步收敛到：

- `src/renderer/src/components/HorizontalBrowseRawWaveformDetail.vue`
- detail 波形主线程绘制链路

已确认：

1. 不是拖拽事件本身慢
   - `handleDragMove` 总耗时很小
2. 不是 worker 消息处理函数本身慢
   - `handleWaveformWorkerMessage` 本体耗时也很小
3. 真正重的是：
   - `HorizontalBrowseRawWaveformDetail` 里反复触发的匿名绘制调用
   - trace 显示该热点累计约 `3.7s`
   - 平均单次约 `22.5ms`
   - 最差单次约 `80ms`

这意味着：

- 现在真正把主线程压住的，是 detail 波形重绘本身
- 不是输入事件派发
- 不是 chunk 写入数组

另外还观察到：

- `CrRendererMain` 上有大量 `Receive mojo message` 长任务

这里不要被名字骗了。

它更像是：

- IPC / Electron bridge 消息到了
- renderer 在这次消息处理里顺手做了重绘
- 于是整段任务被拉长

所以当前根因判断为：

- raw stream chunk 到达
- 触发 detail 波形重绘
- 主线程 detail draw 过重
- 拖拽输入响应被挤压

### 8.5 最新无损优化

基于上面的 trace，本轮又追加了两刀，而且都不改最终质量：

1. raw stream 重绘节流
   - chunk 到达后不再每块都立刻重画
   - 改成按时间窗合并脏区后再画
   - 最终波形数据不变，只减少中间无意义帧
2. tile 脏区刷新
   - tile worker 回一块 bitmap 后，不再整窗重画全部 visible tiles
   - 改成只把当前可见脏 tile 合成到 canvas
   - 最终 tile 质量不变，只减少整窗重复 compositing

当前预期收益：

- 刚载入 Deck 时，主线程 draw 峰值下降
- raw stream 期间拖拽更容易保持响应
- tile 热起来的过程中，不再因为每块 tile 回来都整窗 redraw 而卡顿

### 8.6 列表小波形异步化

最新 trace 说明：

- `SongListRows/useWaveformPreview.ts` 的小波形预览也在持续占主线程

因此当前已把 songs list waveform preview 改成：

- 单独的 worker
- `OffscreenCanvas`
- 与 Horizontal Browse detail 分离

当前策略：

1. songs list 小波形的重绘不再在主线程逐列循环绘制
2. main thread 只负责：
   - 维护可视 canvas 引用
   - 把波形数据同步给 worker
   - 发送 render 指令
3. worker 负责：
   - `Mixxx waveform`
   - `Pioneer preview waveform`
   - 按样式绘制到 `OffscreenCanvas`

当前核心文件：

- `src/renderer/src/workers/songListWaveformPreview.worker.ts`
- `src/renderer/src/workers/songListWaveformPreview.types.ts`
- `src/renderer/src/workers/songListWaveformPreview.workerClient.ts`
- `src/renderer/src/pages/modules/songsArea/SongListRows/useWaveformPreview.ts`

取舍：

- 最终视觉结果不变
- 如果运行环境不支持 `OffscreenCanvas`，仍保留原主线程 fallback

### 8.7 Horizontal Browse 播放 race

已定位一个独立于绘制性能的问题：

- 用户刚把歌放进 Deck 后立刻点播放
- 前端已把 `playing=true` 送进 transport
- 但 deck 的 `pcm_data` 可能还没完成解码注入
- Rust transport 此时会保持静音输出
- 所以体感上像：
  - 点了播放没声音
  - 过一会再点又正常

当前修复方向：

1. transport snapshot 增加：
   - `loaded`
   - `decoding`
2. 前端点击播放时：
   - 如果 deck 还没 `loaded`
   - 先记录待播意图
   - 等 deck 真正 `loaded` 后自动补发播放

这不是降级策略，而是把“播放命令先于解码完成”的 race 收掉。

## 9. 采样与 Trace 导出

### 9.1 DevTools `Save trace` 当前问题

已观察到：

- 在 Electron 内嵌 DevTools 里，点击 `Save trace` 可能直接黑屏 / 崩掉

因此当前不建议继续依赖 DevTools 的导出按钮。

### 9.2 已加开发命令：手动 Trace 录制

当前已加一套开发态 trace 导出命令，用 Electron `contentTracing` 直接落文件，绕开 DevTools 导出：

1. 仅在 `dev` 模式里：
   - 顶部菜单 `帮助`
   - 新增：
     - `开始 Trace 录制`
     - `结束 Trace 并导出`
2. 手动流程：
   - 点击 `开始 Trace 录制`
     - 立即开始录制
   - 完成操作后点击 `结束 Trace 并导出`
     - 立即停止录制
     - 直接导出 trace 文件
3. 导出位置：
   - 桌面
   - `FRKB-dev-traces/`
4. 导出完成后：
   - 自动弹出文件所在位置
5. renderer console 日志：
   - 前缀统一：
     - `[dev-songlist-trace]`
   - 当前会打印的阶段：
     - 准备开始录制
     - 已开始录制
     - 收到结束录制请求
     - 正在导出
     - 校验导出文件
     - 导出完成
     - 失败
   - 看到“`trace 导出完成 ... 现在可以关窗口了`”再关窗口
6. 已修复：
   - 手动结束录制后重复弹两次导出结果弹窗的问题

### 9.3 当前 trace 命令的边界

- 只支持手动开始 / 手动结束
- 不再依赖库树歌单点击触发
- 不再依赖 `watch(songListUUID)` 这种脏触发

### 9.4 当前核心文件

- `src/main/ipc/devSongListTraceHandlers.ts`
- `src/renderer/src/App.vue`
- `src/renderer/src/components/titleComponent.vue`
- `src/main/menu/macMenu.ts`

### 9.5 当前建议使用方式

1. 打开浏览器开发者工具 Console
2. 点击：
   - `帮助 -> 开始 Trace 录制`
3. 观察 console：
   - 出现“准备开始录制”
   - 再出现“已开始录制”
4. 做你的操作
5. 点击：
   - `帮助 -> 结束 Trace 并导出`
   - 观察 console：
     - 出现“收到结束录制请求”
     - 出现“正在导出”
     - 出现“正在校验文件是否真实存在”
     - 最后出现：
       - `trace 导出完成 ... 现在可以关窗口了`

## 10. 已加日志

### 主进程日志

关键词：

- `[mixtape-raw-stream] first-chunk`
- `[mixtape-raw-stream] finished`

### renderer console

关键词：

- `[horizontal-raw-stream] first chunk`
- `[horizontal-raw-stream] done`

这些日志能帮助判断：

- 首块到达时间
- 总耗时
- chunk 数量
- 是否命中缓存

## 11. 典型场景复盘：大歌单显示 + 双 Deck 载入

### 11.1 大量歌曲显示在同一歌单时，实际先发生什么

1. `SongListRows` 是虚拟列表，不是整单全量同时开工。
   - 当前实际参与工作的，是当前视口行 + 上下 buffer 行。
   - `BUFFER_ROWS = 12`
2. renderer 此时会同时做两件事：
   - `useKeyAnalysisQueue` 在 `160ms` 防抖后，对当前可视歌曲发 `key-analysis:queue-visible`
   - `useWaveformPreview` 先读 `waveform-cache:batch`；缺失的歌会再补发一次 `key-analysis:queue-visible`
3. main 收到 `key-analysis:queue-visible` 后：
   - 先读 shared grid
   - 已有完整 `bpm / firstBeatMs / barBeatOffset` 的歌曲直接跳过
   - 剩余歌曲进入 `medium` 优先级队列
4. `KeyAnalysisQueue` 当前关键事实：
   - worker 数最多 `2`
   - `queue-visible` 属于 `foreground + medium`
   - 当前只会抢占 `background`，不会抢占已经在跑的 `medium`
5. 单首歌进入 `keyAnalysisWorker` 后，顺序是：
   - `prepareJob` 判断还缺不缺 `key / bpm / waveform`
   - Rust `decodeAudioFile`
   - 如果缺 BPM，跑 `Beat This!`
   - `analyze-done` 时立刻持久化 `key / bpm / firstBeatMs / barBeatOffset`
   - 最后如果缺，再计算 `Mixxx waveform` 并写 cache

### 11.2 用户把一首“已经分析完”的歌放进 deck1 时，发生了什么

1. 双击或拖入后，renderer 会走 `assignSongToDeck`
2. `assignSongToDeck` 里会先查 `song:get-shared-grid-definition`
   - 只要 shared grid 命中，`bpm / firstBeatMs / barBeatOffset` 会先合并进 deck song
   - 所以 BPM 数字会先出来
3. 同时 `HorizontalBrowseRawWaveformDetail` 会开始处理 raw waveform：
   - 先走 `mixtape-waveform-raw:batch`
   - 这里是 `cacheOnly: true`
   - 命中 cache 就直接画
   - miss 就立刻启动 `mixtape-waveform-raw:stream`
4. 这首歌如果 shared grid 已完整，`key-analysis:queue-playing` 会直接 return，不再重复分析
5. 所以“BPM 已经出来，但还没有 raw waveform”，在当前实现里是正常现象：
   - BPM / 网格来自 shared grid
   - raw waveform 来自另一条独立 cache / stream 链路
   - 两者没有绑定成同一个任务

### 11.3 用户又把另一首“排名很靠后、还没分析过”的歌放进另一个 Deck 时，发生了什么

1. 另一个 Deck 也会先查 shared grid
   - 因为这首歌此前没轮到分析，大概率拿不到完整 grid
2. raw waveform 仍然会马上起：
   - 先查 raw cache
   - miss 后启动新的 `mixtape-waveform-raw:stream`
3. 同时 `key-analysis:queue-playing` 会发到主进程：
   - 进入 `high` 优先级
   - 带对应 Deck 的 `focusSlot`
4. 但这份 `high` 任务能不能立刻开跑，要看当时 worker 是否空闲：
   - 如果两个 worker 都被可视列表的 `medium` 任务占着，这个 Deck 的高优先级也只能排队
   - 因为当前只支持抢占 `background`，不抢占已在跑的 `medium`
5. 结果可能出现三种体感：
   - 新放入的 Deck raw waveform 先开始流，但 BPM / 网格还没回来
   - 新放入的 Deck BPM / 网格被列表可视区任务拖住
   - 两个 Deck 的 raw stream 同时跑，CPU / 磁盘 / ffmpeg 吞吐一起被吃满

### 11.4 当前明确存在的“打架点”

1. `queue-visible` 现在不是纯后台杂活，而是 `foreground + medium`
   - 这意味着“列表当前可视歌曲”和“刚放进 deck 的焦点歌曲”在同一个前台资源池里抢 worker
2. deck raw waveform 和 key analysis 会对同一首歌重复解码
   - `keyAnalysisWorker` 走 Rust `decodeAudioFile`
   - `mixtapeRawWaveformWorker` 走 `ffmpeg -> f32le stream`
   - 当前没有共享 PCM，也没有共享 inflight
3. raw waveform 目前没有基于“当前交互 Deck”的动态优先级
   - 两个 Deck cache miss 时都会各起一个 stream worker
   - 没有“当前用户刚操作的是哪个 Deck，就先保哪个”的调度
4. 列表可视区分析目标偏大
   - 当前可视区任务会顺手做 `key + bpm + waveform`
   - 但用户此刻可能只是找歌，或者只需要列表小 waveform
5. Horizontal Browse 当前不会因为“歌已有 BPM”而自动拥有 raw waveform
   - 这本身不算错
   - 但它解释了为什么“歌已经分析完了，deck 里 raw waveform 还是第一次临时现算”

### 11.5 让用户体感最好的优先级，应该怎么排

按体感，建议明确分成下面这条顺序。

注意：

- 这里没有固定的 `deck1 > deck2` 或 `top > bottom`
- 两个 Deck 是对等的
- 优先级只应该由“当前用户交互态”动态决定，而不是由物理槽位决定

1. 当前刚被放进 Deck、或刚被用户操作的那首歌
   - 先读 shared grid
   - 先给 raw waveform 首块
   - 如果没有 grid，再补 BPM / firstBeat / bar offset
2. 当前正在播放 / 正在拖拽 / 正在对齐的 Deck
   - 保证 raw waveform chunk 持续稳定
   - 非必要任务不要抢它的 CPU
3. 另一个已载入、但当前没被直接操作的 Deck
   - 可以降一档
   - 如果它没在播放、也没在拖动，可先用较低 raw target rate，再空闲时补高清
4. 歌单当前可视区
   - 优先补列表小 waveform
   - `key / bpm` 不要和 deck 焦点任务抢同一批前台 worker
5. 不可视区 / 闲时扫描 / 预热
   - 一律放到真正后台

### 11.6 如果只改一刀，最值的是哪一刀

第一刀不是继续抠 `Beat This!`，而是先把优先级层次拉开：

- `deck-active`
- `deck-loaded-idle`
- `list-visible`
- `background`

最该先改的两个点：

1. `key-analysis:queue-visible` 不要再和 deck 焦点歌共享同等级前台执行权
   - 最少要让“当前被操作的 Deck 歌曲”的 `high` 能抢占正在跑的 `medium`
   - 更理想是把 visible 改成真正低优先级、可中断任务
2. raw waveform 要有“按当前交互 Deck 调度”的概念
   - 当前被操作的 Deck raw stream 至少要压过列表分析
   - 另一个 Deck 不该因为物理位置固定吃亏，也不该在非活跃状态下抢走焦点 Deck 的首块时间

### 11.7 现阶段更务实的产品策略

如果只追求最快见效，我建议先把策略定成这样：

- deck 歌曲：
  - `shared grid` 命中就立刻显示 BPM / 网格
  - raw waveform 以“首块最快到达”为第一目标
- deck 歌曲未分析：
  - raw waveform 与 BPM 分析并行
  - 但 raw 首块优先于列表可视区分析完成
- 两个 Deck 同时存在时：
  - 不按槽位分主次
  - 只按“最近交互 / 正在播放 / 正在拖动 / 正在对齐”动态提权
- 列表可视区：
  - 先保证小 waveform
  - `Beat This!` 可以延后，甚至只对用户停留 / 预听 / 上 deck 的歌触发
- 非活跃 Deck：
  - 如果当前没有播放、拖动、对齐等强交互，可自动降采样 / 延后补全

### 11.8 本轮已落地

当前已经实际改成：

1. `key-analysis:queue-visible`
   - 从会挡路的 `medium` 改成 `low + preemptible`
   - 但不能在 handler 层只按 shared grid 提前过滤
   - 否则会把仍然缺 `key / waveform` 的歌直接挡掉
2. `key-analysis:queue-playing`
   - 焦点歌高优先级现在可以抢占：
     - `background`
     - 可让位的列表可视区任务
3. Horizontal Browse raw waveform
   - renderer 会根据最近交互 / 播放 / 拖动 / cue 预听，给两个 Deck 动态打分
   - 主进程只保一个 active raw stream
   - 当前交互 Deck 可以抢占非活跃 Deck 的 stream
4. 当前取舍
   - 好处是：用户刚操作的 Deck 更容易更快拿到首块波形
   - 代价是：非活跃 Deck 的 raw stream 可能被中断后稍晚恢复
   - 这个取舍当前更偏向体感，不偏向总吞吐
5. raw waveform 首屏 fallback
   - 当前优先保交互响应，不保首屏 FFT 颜色精细度
   - 等 tile worker 热起来后，再恢复更完整的最终视觉结果

## 12. 下一轮建议

下个对话建议优先顺序：

1. 观察单 active raw stream 是否过于激进
   - 如果两个 Deck 同时都在强交互，可能要改成 `2` 路并发 + 更细的动态权重
2. 继续优化横推 raw waveform 拖动手感
   - 如果 still 卡，直接打更细的 draw timing 日志
3. 继续收口 `Beat This!` 触发范围
   - 再考虑是否只对上 deck / 停留 / 预听歌曲触发

## 13. 当前原则

- 能用 Rust 的尽量用 Rust
- Python 只保留模型推理
- 已有持久化结果优先复用
- 错误兜底不要返回错误网格
- 新策略先在本地实验区验证，再决定是否收敛进最终产品链路
