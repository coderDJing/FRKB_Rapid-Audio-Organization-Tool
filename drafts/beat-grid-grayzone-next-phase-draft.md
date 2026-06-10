# Beat Grid 灰区问题续接草案

## 当前结论

- 运行时已经彻底移除人工真值注入。
- 软件界面里看到的是**真实分析结果**，不再是假真值。
- 人工真值只保留在：
  - `grid-analysis-lab/manual-truth/truth-sample.json`
  - benchmark / 文档 / 离线评估脚本

## 当前验收标准

- `firstBeatMs` 误差 `<= 8ms`：可接受
- `8-12ms`：灰区，可人工复核
- `> 12ms`：不可接受

- `128 拍漂移 <= 10ms`：可接受
- `10-30ms`：灰区
- `> 30ms`：不可接受

## 当前 benchmark 基线

基于 `grid-analysis-lab/manual-truth/benchmark-latest.json`：

- `refinedMeanGridAbsMs = 2.321`
- `legacyMeanGridAbsMs = 6.953`
- `refinedMeanAbsBpmError = 0.003455`
- `refinedWorstAbsBpmError = 0.038417`
- `refinedMeanAbsDrift128BeatsMs = 1.507`
- `refinedWorstAbsDrift128BeatsMs = 18.579`
- `worsenedTrackCount = 0`
- `gridMeanAbsMs > 12ms = 0 首`
- `gridMeanAbsMs > 8ms = 2 首`

## 已经解决的硬伤

以下三首原来不可接受，现在已经打掉：

- `leonardo chevy - sprawling metropolis (original mix).mp3`
  - `20.0ms -> 0.0ms`
- `popof - sync out (original mix) (1).mp3`
  - `16.0ms -> 1.858ms`
- `sharam - party all the time (adam beyer, layton giordani & green velvet remix) (1).mp3`
  - `12.5ms -> 0.0ms`

当前有效规则：

- `snap-zero-lowband`
- `early-cluster`

实现位置：

- `scripts/beat_this_bridge.py`

## 当前剩余灰区

只剩两首：

### 1. `leigh boy - rito (platypuss remix).mp3`

- `gridMeanAbsMs = 11.205`
- `firstBeatErrorMs = -4.43`
- `absDrift128BeatsMs = 13.656`
- 当前主问题偏向 **BPM 灰区**

当前状态说明：

- 首拍已经不算大错
- 主要是 BPM 略偏，导致长程漂移仍在灰区

### 2. `leonardo chevy - slightly higher (original mix).mp3`

- `gridMeanAbsMs = 9.217`
- `firstBeatErrorMs = 0.0`
- `absDrift128BeatsMs = 18.579`
- 当前主问题也是 **BPM 灰区**

当前状态说明：

- 首拍已经对齐
- 问题主要是 BPM 数值还差一点

## 已验证失败的方向

这些方向都已经跑过全量 benchmark，不能再重复踩坑：

### 1. 运行时注入人工真值

错误原因：

- 软件里看到的不是算法真实结果
- 会污染调试判断
- `beatThisWindowCount / 预估128拍漂移` 也会失真

结论：

- 绝对不能再进运行时链路

### 2. 固定毫秒全局平移

错误原因：

- 看起来像能修 8ms / 12ms
- 实际会把本来已经准的歌整体拉坏

结论：

- 不存在统一全局 phase 偏移

### 3. 多窗口 phase 中值

错误原因：

- 很多窗口本身就量化在 `20/40/60/80ms`
- 做中值只是把错误量化共识化

结论：

- 不能默认启用

### 4. 非整数 BPM 的 envelope 局部搜索

错误原因：

- 会误伤 `Legowelt / Phoenix / Scrufizzer`
- 全量 benchmark 均值恶化

结论：

- 当前 envelope score 不适合做默认非整数 BPM 微调

### 5. BPM 簇共识 / 簇中值 / 簇均值

错误原因：

- 会误伤已经准的歌
- 对 `Rito / Slightly Higher` 也不稳定

结论：

- 不能默认启用

### 6. 跨窗口 `absoluteFirstBeatMs` 反推全局 interval

错误原因：

- 对部分歌有希望
- 但对 `Rito` 不稳，对全量泛化不够

结论：

- 暂时只能作为研究方向，不能直接进默认链路

## 当前真正稳定的架构

- `Beat This`：候选生成器
- 多窗口准备：`_prepare_analysis_windows`
- anchor window 选择：`_select_anchor_window_result`
- anchor / grid solver / guard：已有主链路
- BPM integer rescue：保守启用
- phase rescue：`snap-zero-lowband` + `early-cluster`

这套架构当前已经把硬伤清掉，并且没有 benchmark 回归。

## 下一阶段建议

下一阶段不要再优先改首拍。

应该只研究 **BPM 灰区两首**，方向如下：

### 1. 单独做 BPM objective 研究

目标：

- 不动默认 phase 逻辑
- 只研究如何在高漂移灰区歌上改进 BPM

要求：

- 必须全量 benchmark 不回归
- 不能只修 `Rito / Slightly Higher`

### 2. 只允许高风险歌触发二次 BPM 分析

触发信号可继续沿用：

- `beatThisEstimatedDrift128Ms`
- 多窗口 BPM 分歧
- anchor confidence

但是：

- 目前还没有找到可默认上线的第二意见算法
- `madmom` 当前 runtime 没有现成依赖，不能直接拿来即用

### 3. 如果继续做第二引擎

先做这件事：

- 评估把 `madmom` 打进 runtime 的真实成本

如果成本过高：

- 就继续在当前 runtime 内研究更稳的 classical tempo objective

## 新线程接手时最重要的事实

- 当前版本已经没有 `>12ms` 的硬 fail
- 只剩 2 首 `8-12ms` 灰区
- 剩余问题不是首拍主导，而是 BPM 灰区
- 不要再把人工真值接回运行时
- 不要再尝试固定全局毫秒平移
- 不要再把未通过全量 benchmark 的 BPM 修正塞进默认链路
