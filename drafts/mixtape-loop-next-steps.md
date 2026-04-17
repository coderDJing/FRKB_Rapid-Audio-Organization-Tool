# Mixtape Loop 下一步修改方向

## 当前结论

### 1. 日志链已经打通
- `mixtape loop` 调试日志前缀：`[mixtape-loop-debug]`
- 当前会写入：
  - renderer console bridge
  - 主进程 `mixtape-loop-debug`
  - `log.txt`
- 日志文件位置：
  - 开发态：[`log.txt`](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/log.txt)

### 2. 当前真实问题
- `Loop` 创建链路已经能落库，`loopSegment` 会写进 `mixtape_items.info_json`
- 但用户反馈的核心问题仍然存在：
  - 重复波形在某些情况下仍然不稳定
  - 交互模型仍然不顺手
  - “重复次数增加”这条路径经常没有按预期命中

### 3. 已从日志确认的现象
- 某次复现里只有 `drag:create`
- 没有 `mousedown:repeat` / `drag:repeat`
- 说明当时并没有真正进入“拖重复块改重复次数”的链路
- 创建 loop 时，历史上出现过：
  - `baseLocalSec` 很早卡住
  - `repeatCount` 始终只为 `1`

### 4. 当前代码状态
- 代码已经多次热修，loop 相关逻辑比较脏，继续补丁式修容易反复打架
- 建议下一轮按“交互重构”而不是“局部补丁”来做

---

## 推荐的重构方向

## 最新交互决定
- `A/B` 改成点击可见网格线来定义
- 第一击设 `A`，第二击设 `B`
- 要修改 `A/B` 时，先点对应边界，再点新的可见网格线
- 直接在波形 overlay 内提供 `- / +` 按钮来调整 `repeatCount`
- `grid:create` 只负责定义 `A/B`
- `grid:boundary` 只负责修改 `startSec/endSec`
- `button:repeat` 只负责修改 `repeatCount`

## 目标
- 把 `Loop` 做成稳定、单义、可预测的交互
- 避免“一次拖拽同时猜 A/B 和 repeatCount”的混合逻辑
- 避免 DOM overlay、主线程 canvas、worker tile 三套逻辑各算各的

## 建议交互模型

### 方案 A：点网格线选 A/B + 波形按钮调重复次数
这是最推荐的方向。

1. 点第一根可见网格线
   设 `A`
2. 点第二根可见网格线
   设 `B`
3. 点击波形上的 `- / +`
   改 `repeatCount`

特点：
- `A/B` 和 `重复次数` 分离
- 不再依赖拖动命中
- 反馈更直接，命中率更稳

必须保证：
- `grid:create` 绝不再推导 `repeatCount > 1`
- `button:repeat` 只负责改 `repeatCount`
- `grid:boundary` 只负责改 `startSec/endSec`

### 方案 B：保留边界点击重设
这是比 A 更保守但更清晰的版本。

1. 点第一根可见网格线设 `A`
2. 点第二根可见网格线设 `B`
3. 若要改 `A/B`
   先点对应边界，再点新的可见网格线
4. 点按钮增加重复

特点：
- 精准
- 更 DJ / grid 驱动
- 但比拖拽选区慢一点

如果用户更在意稳定性和拍点精确度，可以选这版。

---

## 渲染层必须统一的点

## 问题本质
- 现在 loop 的视觉同时受这些层影响：
  - DOM overlay
  - 主线程 tile 渲染
  - worker tile/frame 渲染
- 一旦三层的时长 / section / cache key 不一致，就会出现：
  - source / repeat 波形不一致
  - 某些缩放能看到，某些缩放看不到

## 建议处理原则

### 1. DOM 只负责辅助交互
- 只保留：
  - 半透明底色
  - 边界线
  - 命中区
- 不让 DOM 负责“真正的波形差异”

### 2. 波形重复必须复用同一份源段图像
- `loop-source`
  先离屏渲染一次
- `loop-repeat`
  直接复用 source 的离屏结果

不要让 repeat 段再次独立重采样，否则相同音频段会看起来不一样。

### 3. summary 模式不能吞掉 loop
- 有 `loopSegment` 的轨道，不允许走单条 summary bar 简化路径
- 必须进入 loop-aware 分段渲染

### 4. 缓存 key 必须包含 loop 结构
- `tempoSnapshot.signature`
- `visibleGridSignature`
- `trackWidth`
- `loopSegment`

如果缓存 key 没包含这些，旧 tile 会污染新结果。

---

## 建议优先处理顺序

### 第一优先级：重做交互状态机
文件：
- [useMixtapeTrackLoopEditor.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/src/renderer/src/composables/mixtape/useMixtapeTrackLoopEditor.ts)

目标：
- 明确拆成三条链：
  - `create`
  - `boundary`
  - `button:repeat`
- 每条链只做一件事
- 删掉所有多义逻辑

### 第二优先级：统一 loop 渲染
文件：
- [timelineRenderAndLoad.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/src/renderer/src/composables/mixtape/timelineRenderAndLoad.ts)
- [mixtapeWaveformRender.tile.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/src/renderer/src/workers/mixtapeWaveformRender.tile.ts)
- [timelineWorkerBridge.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/src/renderer/src/composables/mixtape/timelineWorkerBridge.ts)
- [mixtapeTrackLoop.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/src/renderer/src/composables/mixtape/mixtapeTrackLoop.ts)

目标：
- source/repeat 复用同一份离屏波形结果
- 所有缩放级别统一使用 loop-aware section

### 第三优先级：清理 UI 噪音
文件：
- [Mixtape.vue](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/src/renderer/src/Mixtape.vue)
- [MixtapeTrackLoopOverlay.vue](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/src/renderer/src/components/mixtape/MixtapeTrackLoopOverlay.vue)
- [_track-loop.scss](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/src/renderer/src/styles/mixtape/_track-loop.scss)

目标：
- 不再在波形左上角塞字
- 不再在参数栏右侧塞大段提示
- 只保留必要的视觉元素

---

## 下一轮建议直接做的事

1. 先选定最终交互方案
   推荐：点网格线选 `A/B` + 波形按钮调重复次数
2. 重写 `useMixtapeTrackLoopEditor.ts`
   把旧补丁逻辑清空
3. 做一个最小 loop demo
   只验证：
   - 创建
   - 改边界
   - 按按钮改重复次数
4. 再接主线程 / worker 波形复用
5. 每次改完都看：
   - [`log.txt`](D:/playground/FRKB_Rapid-Audio-Organization-Tool-2/log.txt)
   - `npx vue-tsc --noEmit`

---

## 当前最重要的经验
- 不要再同时修交互、DOM、worker、主线程缓存四层并试图一次成
- 先把交互状态机收敛成单义的
- 再把重复波形复用做成 deterministic
- 再谈视觉润色
