# 歌曲分析全局并发策略草案

## 状态

已实现（含运行时动态并发调整）。代码实现超出了本文档"第一阶段"范围，增加了 `setGlobalConcurrency` 运行时缩容/扩容能力。

本草案记录当前讨论结论：歌曲分析可以从“全局写死 1 首”改成“全局可控 1-2 首”，但绝不能改成“每个任务各自 1 首”。任务只负责归属、进度和取消，真正执行必须共享同一个全局分析队列和同一个全局并发额度。

## 当前事实

当前 Tool-2 的 key-analysis 主链路是全局单例队列：

- `src/main/services/keyAnalysisQueue.ts` 里 `const workerCount = 1`。
- `getQueue()` 只创建一个 `KeyAnalysisQueue(workerCount, keyAnalysisEvents)`。
- `KeyAnalysisQueue` 构造函数按 `workerCount` 创建 worker。
- `drain()` 从全局 pending 队列取 job，再分配给 idle worker。
- `manual-batch`、`visible`、`waveform-preview` 都是 job category，不是独立执行器。
- 后台分析还有 `BACKGROUND_MAX_INFLIGHT = 1` 的保护。

所以当前模型是：

```text
多个入口 / 多个任务
  -> 同一个 KeyAnalysisQueue
  -> 全局 workerCount = 1
  -> 同时最多分析 1 首
```

这个模型能保护播放、波形和 UI 交互，但批量分析吞吐偏低。

## 要解决的问题

用户手动发起“分析未分析歌曲”或“重新分析歌单”时，通常希望任务能持续跑完。几百首歌曲全局单路分析会很慢。

但如果错误地按任务开 worker，就会出现更糟糕的问题：

```text
任务 A -> 1 首并发
任务 B -> 1 首并发
任务 C -> 1 首并发
...
10 个任务 -> 同时 10 首分析
```

这不合理。分析是 CPU / IO 重活，还会触发 Rust 解码、FFmpeg、BeatThis、波形缓存写入。并发失控会抢播放解码、抢主进程调度、放大磁盘写入和进度事件压力。

## 设计结论

正确方向是：

```text
多个任务 / 多个入口
  -> 同一个全局 KeyAnalysisQueue
  -> 同一个全局 worker 池
  -> 一个全局并发上限
```

并发额度属于全局队列，不属于任务。

10 个任务同时存在，也只能共享同一份额度。例如全局上限是 2，则所有任务加起来最多同时分析 2 首。

## 核心原则

### 1. 保留全局单例队列

继续由 `src/main/services/keyAnalysisQueue.ts` 持有唯一队列实例。

禁止任何入口直接 `new KeyAnalysisQueue(...)`：

- 当前可见列表分析
- 播放中歌曲分析
- deck idle 分析
- 手动批量分析
- 重新分析歌单
- 后台闲时分析
- waveform-preview 补分析

这些入口都只能 enqueue job 到同一个全局队列。

### 2. 任务只做逻辑归属

`manual-batch` 只负责：

- batch id
- 标题
- 总数 / 完成数
- 哪些文件属于这个 batch
- 取消这个 batch
- 进度展示

`manual-batch` 不负责：

- 创建 worker
- 持有并发额度
- 自己 drain 队列
- 自己跑分析循环

### 3. 并发上限全局可控

把当前硬编码的 `workerCount = 1` 改成一个全局策略值。

第一阶段建议只支持保守上限：

```text
min = 1
max = 2
```

不要一开始做 3、4 或按 CPU 核数自动放大。FRKB 的分析链路不是纯 CPU batch，里面有播放、解码、FFmpeg、Python runtime、缓存写入和 UI 事件。

### 4. 播放体验优先

全局并发策略必须优先保护播放体验：

- 正在播放时默认 1 路。
- 切歌、seek、deck prepare、横向浏览交互活跃时保持 1 路。
- 手动批量分析只在不明显影响播放时提升到 2 路。
- 后台闲时分析默认 1 路，深度空闲才允许考虑 2 路。

不要为了吞吐把播放和分析抢成一锅粥。

### 5. 优先级决定谁拿额度，不决定额度数量

当前优先级仍然保留：

```text
high: 播放中 / 当前 deck 相关
medium: 手动批量
low: 当前可见列表 / waveform-preview
background: 后台闲时分析
```

全局并发上限只有一份。优先级只决定 job 选择顺序，不改变总并发上限。

## 建议策略

第一版不要做复杂自适应，先做明确、可解释的保守策略。

### 基础并发

```text
默认全局 workerCount = 1
允许配置 / 策略提升到 2
```

### 提升到 2 的条件

建议同时满足：

- 当前没有播放中的 deck，或播放链路明确处于低压力状态。
- 当前没有短时间内高频切歌 / seek / preparePlayhead。
- 队列里有手动批量任务，且待分析数量大于 1。
- 不是纯后台扫描刚扫出来的零散任务。

如果第一阶段拿不到可靠的播放低压力信号，可以先只做手动设置或开发开关，不做自动提升。

### 降回 1 的条件

出现以下任意情况，应回到 1 路：

- 播放开始。
- 用户频繁切歌、seek、拖动横向浏览。
- `preparePlayhead` 或 transport 相关路径出现慢日志。
- 队列里只有后台闲时分析。
- 机器资源压力不明。

第一版可以只在新队列创建时决定 worker 数，不做运行时动态缩容。动态缩容涉及终止 worker 和 in-flight job 处理，容易浪费一首歌已经跑了一半的分析，不适合第一阶段。

## 第一阶段实现范围

第一阶段建议只做“全局 1-2 并发能力”，不做激进动态调度。

### 可做

- 把 `workerCount = 1` 提取为 `resolveKeyAnalysisWorkerCount()`。
- 明确 workerCount 是全局值，不按 batch 变化。
- 加上最大值钳制，例如 `1 <= count <= 2`。
- 保持 `KeyAnalysisQueue` 单例。
- 保持 manual batch 只 enqueue job。
- 保持 `BACKGROUND_MAX_INFLIGHT = 1`，避免后台任务抢满额度。
- 在代码注释里写清楚：任务不拥有 worker，并发额度全局共享。

### 暂不做

- 每个 batch 独立 worker。
- 每个入口独立队列。
- 运行时频繁 kill / restart worker 来缩容。
- 根据 CPU 核数直接开 4 路或更多。
- 为了公平调度重写整个队列。

## 后续可选增强

### 公平调度

如果未来多个手动批量任务互相挤压，可以考虑在 `medium` 队列里按 batch 做 round-robin。

但这只是“谁先跑”的公平性问题，不影响全局并发上限。

### 运行时动态并发

后续可以考虑队列支持 `setGlobalConcurrency(count)`。

动态扩容相对简单：增加 worker。

动态缩容要谨慎：

- 不应杀掉正在分析的 job，除非用户明确取消。
- 可以标记多余 worker 为 `retiring`，等当前 job 完成后退出。
- 不能为了交互优化浪费已经分析 30 秒的 in-flight 歌曲。

### 压力信号

如果要自动从 1 提升到 2，需要可靠信号：

- 播放状态
- 最近 seek / 切歌 / preparePlayhead 时间
- foreground busy 状态
- background idle gate 状态
- 慢日志或 transport slow 统计

没有这些信号前，不要假装“自动智能调度”已经可靠。

## 验收标准

- 同时创建多个手动分析任务时，全局同时分析数量不超过配置上限。
- 全局上限为 1 时，行为与当前基本一致。
- 全局上限为 2 时，10 个任务也最多同时分析 2 首。
- 播放中歌曲仍然能以最高优先级插队。
- 手动 batch 取消只取消对应 batch 归属，不误杀其他 batch 共享的同一路径 job。
- 后台分析不会因为全局上限提升而抢满全部 worker。
- `npx vue-tsc --noEmit` 通过。

## 风险点

- 增加 worker 会增加同时解码、FFmpeg、BeatThis 和缓存写入压力。
- 进度事件数量可能上升，renderer 侧列表进度刷新压力也会上升。
- 如果动态缩容用 terminate 实现，会浪费已经跑了一半的分析。
- 如果后续误把 batch 当执行器，会出现多个任务叠加导致并发失控。

## 最终一句话

不是把“全局 1 首”改成“每个任务 1 首”，而是改成：

```text
所有任务共享一个全局分析池，全局最多 1-2 首。
```

默认保守，空闲或手动批量时再提升吞吐；任何时候都不能让任务数量线性放大分析并发。
