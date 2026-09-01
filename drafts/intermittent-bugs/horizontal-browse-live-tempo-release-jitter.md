# Horizontal Browse 双轨 BPM 实时预览松手抖动

## 当前状态

- **阶段 1（暂停松手弹回）：已实现，待真机验收。** 代码见下方“已落地改动”。单测与 vue-tsc 已过，
  但**必须真机拖拽实测**才能确认消抖。
- **阶段 2a（暂停态松手横向跳）：已修复（回退 override 即好）。** 真机验收：暂停态松手不再横跳、
  播放头屏幕位置固定。当前代码 `applyIncomingPreviewTimeScale` 无 `previewStartOverride`（已回退），
  暂停态锚 `previewStartSec + previousVisible*RATIO`，播放头固定。
- **阶段 2b（播放态松手横向跳）：候选修复已实现，待真机复验。** 修法 #1（删
  `applyLiveVisualPlaybackRate` 的 `setLiveClockPlaybackRate`）**无效且已回退**；当前代码仍由即时视觉路径和
  32ms native 发送路径共同写 `liveClockPlaybackRate`。
  **最新认知修正**：不能用原始 `renderedViewportStartSec + 新 visibleDuration/2` 推算拖动期画面播放头。
  原始 viewport 尚未计入以播放头 50% 为原点的 CSS tempo scale，而且旧 canvas 仍按
  `displayedScale` 密度绘制。按完整坐标变换重算后，两组样本的 stable canvas 播放头仅分别滞后
  `currentSeconds` **15ms / 24.3ms**，不存在此前误算的约 1s 滞后；松手前 CSS 后有效视口起点与新帧
  起点仅差 **29.9ms / 36.5ms**。这仍不足以解释肉眼看到的剧烈横跳。
  `nativeRate`（`props.playbackRate`）在 live 期被 `preserveLiveClockDeckSnapshot` 冻结，不代表 native
  真实速度；现有日志也未直接采到 native 音频播放头。
  最新一轮 5 次真机复现中，`release-enter` 与 `release-post-paint` 的有效播放头始终贴合
  `currentSeconds`；按播放时间补偿后的有效视口误差仅 **5–11ms**。异常集中在 buffer 交接瞬间：新 active
  buffer 已生效，但两个 buffer 共用的父 scaler 仍是旧 `scaleX`，形成“新帧 + 旧缩放”的瞬态。
  tempo scaler 拆成每个 buffer 独立一层的候选修复已验证无效，播放态仍横跳。
  最新日志进一步锁定为 stable canvas revision handoff 使用旧 frame 的 playbackRate，绕过了 live
  tempo reanchor 写入的 playbackClock；该处已改为 handoff 仍沿用旧帧几何，但时间推进统一读取当前
  playbackClock，待真机复验。

本问题只能以真机拖拽实测验收（暂停态与播放态各拖一次 BPM 松手观察大波形），静态检查和单测
都不能单独宣布解决。

### 已落地改动（阶段 1）

- `horizontalBrowseLiveTempoPreview.ts`：新增纯函数
  `resolveHorizontalBrowseLiveTempoPreviewReleasePlan`（判定离场是立即还是延迟归位）与
  `shouldFinishHorizontalBrowseLiveTempoPreviewRelease`（判定延迟归位是否该收尾），及常量
  `HORIZONTAL_BROWSE_LIVE_TEMPO_RELEASE_EPSILON`。
- `HorizontalBrowseRawWaveformDetail.vue`：新增局部变量 `liveTempoPreviewReleasePendingScale`；
  重写 `applyLiveTempoPreviewRate` 离场分支为“延迟归位”；`onPresentedPreviewTimeScale` 回调里在
  displayed 追上 pending 目标时才归零；新增 `clearLiveTempoPreviewRelease`。
- `horizontalBrowseLiveTempoPreview.spec.ts`：新增“松手离场归位”一组单测。

### 阶段 2 诊断用法

已加临时诊断模块 `horizontalBrowseLiveTempoReleaseDiag.ts`，并在 `HorizontalBrowseRawWaveformDetail.vue`
记录四个阶段：`preview-reanchor`（拖动中重锚）、`release-enter`（松手离场入口）、`release-finish`
（worker 新帧 ready、CSS 清理前）和 `release-post-paint`（CSS 清理并至少完成一次合成后）。

采样经现有 `outputLog` IPC 落盘到 **`log.txt`**（dev = 项目根目录 `log.txt`；打包 =
`userData/log.txt`，路径逻辑见 `src/main/log.ts` 的 `resolveLogPath`），统一带
`[HB-TEMPO-RELEASE-DIAG]` 标签，**不需要 devtools**。

真机复现步骤：非 macOS、播放态拖 BPM 松手复现横向跳后，直接检索 `log.txt`：

```
grep "HB-TEMPO-RELEASE-DIAG" log.txt
```

每行形如 `[HB-TEMPO-RELEASE-DIAG] dir=up phase=release-enter displayedScale=.. incomingTimeScale=..
currentSeconds=.. activeCanvasIndex=.. renderedViewportStartSec=.. effectiveViewportStartSec=..
effectivePlayheadSec=..`。重点比较同一次松手里的 `release-enter` 和 `release-post-paint`：原始
`renderedViewportStartSec` 仅用于核查 canvas 内部几何，判断用户所见连续性必须使用计入 CSS scale 后的
`effectiveViewportStartSec` / `effectivePlayheadSec`。

> 注意：renderer 的 console bridge（`installConsoleLogBridge`）只把 `console.error` 转发到 log.txt，
> 所以诊断走的是 `window.electron.ipcRenderer.send('outputLog', …)`（level=info）直接落盘，不依赖 console。

> 验收通过后：整删 `horizontalBrowseLiveTempoReleaseDiag.ts`，并移除 `.vue` 里各处
> `recordHorizontalBrowseLiveTempoReleaseDiag` 调用与其 import（均带 `[HB-TEMPO-RELEASE-DIAG]` 注释）。

> 换会话/换账号接手须知：本文档自包含，照“修复方案”一节即可直接改代码，不需要重新侦查。
> 所有引用行号是写文档当时（基线见文末）的坐标，接手时若行号漂移，用符号名在文件内重新定位。

## 现象

双轨模式（`waveformLayout` 非 `full` 的上下半屏大波形）拖动 BPM 输入实时改速时，拖动过程本身
是丝滑的；**问题只在松手那一瞬间大波形剧烈抖一下**。两种状态形态不同：

- 暂停态松手：**宽度弹回再跳** —— 波形密度/宽度先弹回拖动前的样子，再跳到新 BPM 对应的密度。
- 播放态松手：**横向位置跳** —— 密度不变，但播放头/波形横向位置猫一下跳开再回来。

## 架构：三条并行通路

拖 BPM 时，实时反馈由三条**并行**通路同时驱动，互相独立：

| 通路 | 作用 | 关键位置 |
| --- | --- | --- |
| 1 音频 | 32ms 节流把新 playbackRate 经 IPC 送给 native，改真实播放速度 | `useHorizontalBrowseDeckTempoControls.ts` `queueLiveAudio`/`sendLivePlaybackRate`（约 150-164、132-137）→ `setPlaybackRateLive` |
| 2 CSS 预览 | 在外层 `.tempo-scaler` 上加 `scale3d(scaleX,1,1)` 拉伸波形/beat 密度，近似新 BPM，纯 GPU | `horizontalBrowseLiveTempoPreview.ts`（`resolve...ScaleX` / `apply...Transform`）；scaler 元素在 `HorizontalBrowseRawWaveformDetail.vue:1300`（波形层）、`:1315`（overlay 层） |
| 3 stable canvas | 播放中超宽稳定 canvas 用 RAF 逐帧 `translate3d` 滚动 | `horizontalBrowseStableCanvasPresentation.ts`（`tickPlayback`/`apply`/`reanchorPlayback`） |

scaleX 公式：`displayedRate / targetRate`（`horizontalBrowseLiveTempoPreview.ts` 的
`resolveHorizontalBrowseLiveTempoPreviewScaleX`）。
- `displayedRate` = 当前 canvas 里已经画出来的密度（`displayedPreviewTimeScale`）。
- `targetRate` = 想要的新密度（拖动中 = `liveTempoPreviewRateValue`）。
- 拖动中 canvas 还没重画，displayed 停在旧值、target 是新值 → scaleX≠1，CSS 把旧波形拉伸成新密度的视觉。
- 当 worker 按新密度画好新帧、`displayedPreviewTimeScale` 更新为新值后，displayed==target → scaleX==1，
  CSS 拉伸自然归零，视觉无缝换成真实新帧。

## 数据流与关键回调

- 拖动实时：`useHorizontalBrowseDeckToolbarInteractions.ts:120` `handleDeckBpmInputLive` →
  `scheduleDeckLiveTargetBpm` → `applyLiveVisualPlaybackRate` → `setLiveClockPlaybackRate` +
  `onLiveVisualPlaybackRate` 回调。
- `onLiveVisualPlaybackRate` 在 `HorizontalBrowseModeShell.vue:356` 里 →
  `resolveDetailRef(deck).setLiveTempoPreviewRate(rate)`（expose 出口
  `horizontalBrowseRawWaveformDetailExpose.ts:24/76`）→ 组件 prop `liveTempoPreviewRate`。
- 组件内 `HorizontalBrowseRawWaveformDetail.vue`：
  - `props.liveTempoPreviewRate` 的 `flush:'sync'` watcher（`:1061-1067`）→ `applyLiveTempoPreviewRate`。
  - `applyLiveTempoPreviewRate`（`:1044-1059`）：设 `liveTempoPreviewRateValue`，调
    `syncLiveTempoPreviewTransform()`（`:427-433` 把 scaleX 写到两个 scaler）。**离场分支**（liveRate=null）
    走 `applyIncomingPreviewTimeScale(true,{keepCurrentFrame:true})`。
  - **“新帧画好了”的信号** = `onPresentedPreviewTimeScale` 回调（`:416-419`）：worker 帧 ready 后由
    `useHorizontalBrowseRawWaveformCanvas.ts` 的 `handleLiveCanvasRendered`（`:347`）触发，
    把 `displayedPreviewTimeScale` 更新为 `queuedPreviewTimeScale`（提交渲染时记录，`:669`），再
    `syncLiveTempoPreviewTransform()`。
- 松手提交：`useHorizontalBrowseDeckToolbarInteractions.ts:179` `commitDeckTargetBpm` →
  `useHorizontalBrowseDeckTempoControls.ts:192` 的 `finally` 里 `clearLiveVisualPlaybackRate`
  （`:86-89`）→ `onLiveVisualPlaybackRate(deck, null)` → `setLiveTempoPreviewRate(null)` → 组件走离场分支。
- `applyIncomingPreviewTimeScale` 定义在 `horizontalBrowseDetailPresentationActions.ts:104-147`：
  更新 `lastAppliedPreviewTimeScale`、重算 `previewStartSec`，排 worker viewportOnly 重画。

## 根因

松手瞬间的通路切换**不是原子的**：通路 2（CSS scale）的撤销是同步、立即完成的，而通路 1/3 的
新密度帧是异步、滞后的，两者之间夹了至少一帧“旧密度”，于是抖一下。

- 暂停「宽度弹回再跳」：离场时 `applyLiveTempoPreviewRate(null)` 先把 `liveTempoPreviewRateValue=null`
  并立刻 `syncLiveTempoPreviewTransform()` → scaleX 被算回 1（`targetRate` 回退到 displayed）→ **CSS 拉伸
  瞬间撤销，波形弹回旧密度**；之后 `applyIncomingPreviewTimeScale` 才排 worker 新帧，一个往返后
  displayed 跳到新密度 → 弹回再跳。（`HorizontalBrowseRawWaveformDetail.vue:1044-1058`）
- 播放「横向位置跳」：在上面基础上多了通路 3。`applyLiveTempoPreviewRate` 的非离场分支里播放态会
  `reanchorStableCanvasPlayback(resolveWaveformCurrentSeconds(), liveTempoPreviewRateValue)`（`:1052-1054`），
  松手切回 native 真实 rate 时，stable canvas 的 `resolveHorizontalBrowseStableCanvasOffsetCssPx`
  依赖的 `rangeStart`/`anchorSec` 与 `applyIncomingPreviewTimeScale` 重算的 `previewStartSec` 起点在同一帧内
  各自变化但未对齐 → 横向 offset 突变。

修复钥匙：`onPresentedPreviewTimeScale` 本就是“新帧 ready”的精确信号。让 CSS scale 的**归位延迟到
这一刻**，归位与换帧同帧发生，displayed==target 时 scaleX 恒为 1，无跳变。这与代码里既有的
`surfaceVisibility.preserveUntilNextReady()` / stable presentation 的 revision handoff 是同一套
“保持旧呈现直到替代帧 ready”的哲学，只是 tempo 预览的离场之前没接上这套。

## 已确认的边界

- 拖动过程本身丝滑，不要动拖动路径；只需修“松手离场”这一瞬间。
- `onPresentedPreviewTimeScale`（`:416-419`）是唯一可靠的“新密度帧已上屏”信号，归位必须挂在它上面，
  不能用 setTimeout/固定延迟去等。
- macOS 播放期不走通路 3（超宽 stable canvas）：`resolveCanvasStableWaveformSource`
  （`HorizontalBrowseRawWaveformDetail.vue:115-119`）在 `platform==='darwin' && 播放中` 时返回 false，
  交给 worker 增量滚动。阶段 2 的横向跳在非 macOS 播放态最容易复现。
- `liveTempoPreviewRateValue` 是组件内的裸变量（非 ref），`syncLiveTempoPreviewTransform` 读它和
  `displayedPreviewTimeScale` 计算 scaleX。任何离场逻辑都要保证这两个值在归位时一致。
- 组件卸载（`onUnmounted` `:1241-1247`）已把 scaler 强制归 1，属正常清理，不要与离场逻辑混淆。

## 修复方案

### 阶段 1 —— 修暂停松手「宽度弹回再跳」（核心，低风险）

在 `HorizontalBrowseRawWaveformDetail.vue` 内实现“延迟归位”：

1. 新增组件局部变量 `let liveTempoPreviewReleasePendingScale: number | null = null`（不加新 prop/IPC）。
2. 改 `applyLiveTempoPreviewRate`（`:1044`）离场分支（`liveRate==null` 且此前 `leavingLive`）：
   - **不**立即把 scale 归零。把 `liveTempoPreviewRateValue` 保持为“最终提交的 timeScale”
     （= `resolveIncomingPreviewTimeScale()`，即松手后新的目标密度），记
     `liveTempoPreviewReleasePendingScale = 该目标值`。
   - 照常调 `applyIncomingPreviewTimeScale(true,{keepCurrentFrame:true})` 排 worker 新帧、更新
     `lastAppliedPreviewTimeScale`。
   - 此时 scaleX = displayed(旧) / target(新) 仍≠1，CSS 维持拉伸态，视觉不弹回。
3. 改 `onPresentedPreviewTimeScale` 回调（`:416-419`）：更新 `displayedPreviewTimeScale` 后，若
   `liveTempoPreviewReleasePendingScale != null` 且 `displayedPreviewTimeScale` 已追上它（差值
   ≤ 1e-4），则清 `liveTempoPreviewReleasePendingScale = null`、`liveTempoPreviewRateValue = null`，
   再 `syncLiveTempoPreviewTransform()`。此刻 displayed==target，scaleX 恒 1，归位无跳变。
4. 兜底：若 worker 因某种原因不回 `onPresentedPreviewTimeScale`（例如无高清波形帧），需保证 pending
   不会永久卡住 scale。可在离场时若判定不会有新帧（`!compactVisualWaveformActive` 之类）走旧的立即归零
   路径；具体条件实现时按 `drawWaveform` 的分支判断，勿盲目加定时器。

### 阶段 2 —— 松手横向跳（播放态未解决，先修正测量模型）

**已确认结果**：

- `previewStartOverride` 方案已整体回退。暂停态恢复用
  `previewStartSec + previousVisible*RATIO` 保持播放头屏幕位置固定，用户真机确认暂停态已不横跳。
- 播放态仍可见松手横跳。
- 删除 `applyLiveVisualPlaybackRate` 中 `setLiveClockPlaybackRate` 的修法 #1 无效，已经回退；不得把它写成
  已落地修复。
- 当前没有足够证据把播放态横跳归因于 render sync、stable presentation 或 native 中任意一层。

#### 三时钟与 CSS 坐标变换的准确关系

1. **native 音频时钟**：真实播放位置和真实生效 rate 在 native 内。renderer 的 live rate 通过 32ms
   节流发送；现有诊断没有直接采集 native 播放头。
2. **render sync 时钟 `currentSeconds`**：以 native snapshot 为基准，用
   `resolveLiveClockPlaybackRate ?? snapshot.playbackRate` 在 RAF 中外推。拖 BPM 时即时视觉路径和
   `setPlaybackRateLive` 都会写 `liveClockPlaybackRate`，rate 改变时通过 rebase 保持时间连续。
3. **stable canvas playbackClock**：拖动事件中反复以 `currentSeconds` 和目标 live rate 重锚，RAF 之间
   自己外推，然后把旧帧以 `translate3d` 滚动呈现。它通常只比 render sync 晚一帧左右。
4. **CSS tempo scale（不是第四个时钟，但不能从几何中省略）**：旧 canvas 仍按
   `displayedScale` 密度绘制，外层 scaler 以播放头 `RATIO=0.5` 为原点应用
   `scaleX = displayedScale / targetScale`。因此日志里的原始 `renderedViewportStartSec` 不是用户实际看到的
   屏幕左缘时间。

令：

- `rvs` = CSS 变换前的 `renderedViewportStartSec`；
- `Vt` = 目标 rate 下的 `visibleDuration`；
- `s` = `displayedScale / targetScale`；
- `Vd = Vt * s` = 旧帧自身密度对应的可见时长；
- `R = 0.5`。

则拖动期旧帧经过 CSS 后：

```text
effectiveVisibleDuration = Vd / s = Vt
effectiveViewportStart   = rvs + (Vd - Vt) * R
effectivePlayhead        = effectiveViewportStart + Vt * R
                         = rvs + Vd * R
```

此前两次相反方向的结论都漏了这一层：

- “画面超前 native”把被冻结的 `props.playbackRate` 当成 native 真实速度，证据无效；
- “画面滞后 currentSeconds 约 1s”用 `rvs + Vt/2` 计算旧密度帧，同样无效。

按完整公式重算现有两组日志：

| 样本 | `rvs` | `Vd` | 正确旧帧播放头 | `currentSeconds` | 差值 | CSS 后旧起点 | 新帧起点 | 起点差 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3.4035 | 9.4262 | 8.1166 | 8.1316 | -15.0ms | 2.6685 | 2.6984 | 29.9ms |
| 2 | 3.9951 | 10.8965 | 9.4433 | 9.4676 | -24.3ms | 4.9857 | 5.0222 | 36.5ms |

这说明 stable canvas 与 `currentSeconds` 基本同相；现有样本只能解释一帧量级的差距，不能解释肉眼可见的
剧烈横跳。`previewStartSec` 在拖动期冻结也不是单独证据：播放态旧帧本来就是由 stable translate 呈现，
不能把渲染基准值当成最终屏幕坐标。

#### 当前诊断缺口

- `collectTempoReleaseVisualDiag` 原先固定读取 `waveformCanvasRef`，但双 buffer 切换后 active canvas 可能是
  `waveformCanvasBackRef`，所以旧 `canvasTranslateXpx` 可能来自非活动 buffer。
- `release-finish` 在清除 CSS transform 之前记录，且同一 JS task 内随后才调用
  `syncLiveTempoPreviewTransform()`；这个采样不是用户最终看到的归位后画面。
- `resolveRenderedCanvasViewportStartSec()` 正确读取 active canvas，但只返回 CSS 之前的原始坐标。
- 现有日志没有 native 播放头，因此不能再用 renderer prop 推断“音频超前/滞后”。

**已补的下一轮诊断（仍是临时代码）**：

- 自动识别 opacity=1 的 active buffer，并记录 `activeCanvasIndex` 与该 canvas 的 translate；
- 同时记录 `renderedVisibleDurationSec`、`effectiveVisibleDurationSec`、
  `effectiveViewportStartSec`、`effectivePlayheadSec`；
- worker 新帧 ready 并同步清除 CSS 后，用双 RAF 追加 `release-post-paint`，读取至少完成一次合成后的状态；
- 不改任何播放、重锚、buffer 激活或 CSS 归位算法。

**2026-08-31 最新真机结果（连续 5 次播放态松手）**：

- enter 的 `effectivePlayheadSec - currentSeconds` 为约 -6ms、-17ms、-17ms、-12ms、-27ms；
- post-paint 为约 -1ms、-8ms、-9ms、-6ms、-16ms；
- 将 enter 到 post-paint 期间的正常播放推进扣除后，有效 viewport start 只差约 5–11ms；
- active buffer 每次确实在 `release-finish` 从 0→1 或 1→0 切换；
- 所以 render sync、stable playbackClock 及松手后最终新帧 range 均连续，不是横跳来源。

**已排除的候选**：原模板让前后两个 canvas 共用一个 `.tempo-scaler`，理论上可能造成“新帧 + 旧 CSS scale”
瞬态；已将 scaler 拆成每个 buffer 独立一层并在激活前预置 transform，但真机仍复现，因此不是根因。

**当前锁定根因**：stable canvas 的 `tickPlayback` 在 revision handoff 时原先使用
`estimateFramePlaybackSeconds(currentFrame)`。该 current frame 的 `playbackRate` 是旧渲染帧快照；BPM
拖动期间 `applyLiveTempoPreviewRate` 虽反复调用 `reanchorStableCanvasPlayback(currentSeconds, liveRate)`
更新当前 playbackClock，tick 却走 handoff 分支绕过它。结果是 render sync 的 `currentSeconds` 按 live rate
推进，而 stable canvas 按旧 frame rate 推进，translate 逐渐累计到百余像素；松手替代帧 ready 后 translate
归零，画面横跳。修复已改为 handoff 只复用旧帧几何，秒数始终来自当前 playbackClock。

**本轮候选修复（已实现、待真机验收）**：

- revision handoff 继续使用旧 frame 的 viewport/range 几何，避免替代帧 ready 前露出空洞；
- handoff 的时间推进改读当前 stable playbackClock，不再读旧 frame 的 `playbackRate`；
- 没有修改 native、render sync、CSS scaler、rangeStart 或 seek 逻辑。

**约束**：暂停态播放头屏幕位置固定；纯视觉不触音频；不得用 setTimeout、隐藏一帧或扩大 stable canvas
判据掩盖问题。所有诊断在定位并验收后按 Debug Logging 规则删除。

## 验证

- 单测：扩 `horizontalBrowse/horizontalBrowseLiveTempoPreview.spec.ts`，覆盖
  “离场时保持 scaleX≠1 直到 displayed 追上 target 才归 1”的时序（用纯函数
  `resolveHorizontalBrowseLiveTempoPreviewScaleX` 断言各阶段 scaleX；组件级时序可在
  可测的纯逻辑里断言 pending 状态机）。
- 构建：`npm run build`，并跑相关 spec。
- 真机手动验收（**必须**）：
  - 暂停态拖 BPM 松手 → 波形不弹回、不跳，直接无缝换成新密度。
  - 播放态拖 BPM 松手 → 播放头/波形横向不跳。
  - 上下两轨各测；快速连续拖动多次松手也不抖。

## 后续约束

- 不得用 setTimeout/固定延迟/隐藏一帧等手段掩盖抖动；归位必须由“新帧 ready”事件驱动。
- 阶段 2 的诊断 `performance.mark`/`measure` 仅在未完成真机验收期间保留，修复确认后按项目
  Debug Logging 规则删除或收窄。
- 不要为了消抖去放宽 stable canvas 的 `canPresent`/`reanchor` 判据，那会引入播放漂移。
- 若再次复现，先记录版本/实例、是否 macOS、暂停还是播放态，再决定改哪条通路。

## 基线

- 分支 `main`，最近提交 `7938dcb5 chore(release): 发布 1.2.4-rc.202608301451`。
- 相关文件（写文档当时）：
  - `src/renderer/src/components/HorizontalBrowseRawWaveformDetail.vue`
  - `src/renderer/src/composables/horizontalBrowse/horizontalBrowseLiveTempoPreview.ts`
  - `src/renderer/src/composables/horizontalBrowse/horizontalBrowseDetailPresentationActions.ts`
  - `src/renderer/src/composables/horizontalBrowse/horizontalBrowseStableCanvasPresentation.ts`
  - `src/renderer/src/composables/horizontalBrowse/useHorizontalBrowseRawWaveformCanvas.ts`
  - `src/renderer/src/composables/horizontalBrowse/useHorizontalBrowseDeckTempoControls.ts`
  - `src/renderer/src/composables/horizontalBrowse/useHorizontalBrowseDeckToolbarInteractions.ts`
  - `src/renderer/src/components/HorizontalBrowseModeShell.vue`
