# Horizontal Browse pending-play 慢启动接手文档

## 适用范围

这个文档用于接手排查 Horizontal Browse 双轨页面里“载入歌曲后点击播放按钮，播放按钮闪烁/忙碌态持续 2-4 秒”的偶发现象。

重要：复现不一定发生在当前仓库实例里。用户可能会：

- 在当前 `D:\playground\FRKB_Rapid-Audio-Organization-Tool-4` 实例复现，并要求直接看当前 `log.txt`。
- 在其他 FRKB 实例或已发布 RC 里复现，只贴出日志片段。这种情况下不要去当前仓库的 `log.txt` 硬找，直接分析用户贴出的日志。
- 开新会话继续排查。新会话第一步先问清楚“这是当前项目实例的 `log.txt`，还是别的实例贴出来的日志”，除非用户已经明确说明。

## 当前结论

已确认/高置信的根因方向：

- 播放按钮长时间闪烁不是按钮 CSS/动画问题。
- 不是双轨同步互等；已复现日志里 `dualSyncActive:false`，bottom 轨为空。
- 核心门槛仍是 `playheadLoaded` / playhead coverage，不能为了消除按钮闪烁削弱 readiness 判断。
- 已有证据显示一种慢路径：点播放时已有后台 startup decode 在路上但还未覆盖播放头，随后播放点击路径触发 `prepare-playhead` 同步解当前播放头附近 10 秒 bootstrap PCM。
- 仍需复验：当前候选改动是否已经消除所有 2-4 秒 pending-play；如果再次复现，要继续按本文日志链路排查，不要直接认定同一根因。

已抓到的当前项目实例证据：

```text
[HB-TRANSPORT-SLOW] prepare-playhead elapsedMs: 4263.1
before.loaded: false
before.decoding: true
before.playheadLoaded: false
after.loaded: true
after.fullDecoding: true
after.playheadLoaded: true
after.loadedSegmentStartSec: 0.04
after.loadedSegmentEndSec: 10.04
hadPendingStartupAtStart: true
becamePlayheadLoaded: true
loadedSegmentExpanded: true
```

同一次 pending-play 日志显示：

```text
[HB-PENDING-PLAY] threshold elapsedMs: 501.4
[HB-PENDING-PLAY] cleared elapsedMs: 4271.8
```

这说明按钮忙碌时间基本等于 `prepare-playhead` 同步耗时。

补充：2026-06-10 在其他实例贴出的日志里，也复现了同类窗口：

```text
[HB-PENDING-PLAY] threshold elapsedMs: 512.5
start/current:
  loaded=false
  decoding=true
  fullDecoding=false
  playheadLoaded=false
  currentSec=17.951
  loadedSegmentStartSec=0
  loadedSegmentEndSec=0
  blockers=["playhead-not-ready","deck-not-loaded","decode-pending","coverage:not-loaded"]

[HB-PENDING-PLAY] cleared elapsedMs: 3509.5
current:
  loaded=true
  fullyDecoded=true
  fullDecoding=false
  playheadLoaded=true
  loadedSegmentStartSec=0
  loadedSegmentEndSec=240.041
```

这条日志没有 `[HB-TRANSPORT-SLOW]` / `[HB-TRANSPORT-DECODE-SLOW]`，所以只能确认 pending 卡在 playhead coverage，不能直接拆出 FFmpeg spawn/read/first-byte 阶段。关键点是：点击时同一首歌已有 startup decode 在路上，播放头 17.951s 还没被 PCM 覆盖，直到 3.5s 后整首或足够片段应用完才清除 pending。

当前候选改动：Rust transport 现在会记录 pending startup decode 的窗口（start/max duration）。`preparePlayhead` 如果发现同文件已有 pending startup decode 且该窗口覆盖当前播放头，就不再作废它并同步重解；只有播放头已经移出该 pending 窗口时，才替换为新的 playhead decode。这个改动保留 `playheadLoaded` 真实门槛，目标是避免点击播放把已经在路上的有效 startup decode 取消后再卡主进程同步解码。它已通过单元测试和类型检查，但还需要真实复现链路复验；再次出现长 pending 时继续按下面规则抓日志。

## 已加诊断

当前工作区已加两层诊断。

### 主进程慢 IPC 日志

前缀：

```text
[HB-TRANSPORT-SLOW]
```

位置：

- `src/main/ipc/horizontalBrowseTransportHandlers.ts`

触发条件：

- `set-deck-state` 超过 500ms
- `set-state` 超过 500ms
- `prepare-playhead` 超过 500ms

关键字段：

- `operation`
- `elapsedMs`
- `before`
- `after`
- `hadPendingStartupAtStart`
- `hadLoadedButUncoveredAtStart`
- `becamePlayheadLoaded`
- `loadedSegmentExpanded`

### Rust 内部 decode 阶段日志

前缀：

```text
[HB-TRANSPORT-DECODE-SLOW]
```

位置：

- Rust 计时：`rust_package/src/lib.rs`
- Rust 诊断队列：`rust_package/src/horizontal_browse_transport_runtime.rs`
- NAPI drain：`rust_package/src/horizontal_browse_transport_napi.rs`
- 主进程落盘：`src/main/ipc/horizontalBrowseTransportHandlers.ts`

触发条件：

- startup decode 超过 500ms
- full decode 超过 5000ms

关键字段：

- `operation`: `sync` 或 `async`
- `status`: `decoded`、`failed`、`cancelled`、`stale-before-decode`、`stale-before-prepare`、`apply-stale`
- `queueWaitMs`: async 请求在 worker 队列里等了多久
- `ffmpegTotalMs`: FFmpeg 相关总耗时
- `ffmpegSpawnMs`: FFmpeg 子进程启动耗时
- `ffmpegFirstByteMs`: 从开始到 stdout 第一批 PCM 的耗时
- `ffmpegReadMs`: 读取 stdout PCM 的累计耗时
- `ffmpegConvertMs`: s16le 转 f32 的累计耗时
- `ffmpegWaitMs`: 等 FFmpeg 进程退出耗时
- `prepareMs`: Rust 把 PCM 包装成 transport 数据的耗时
- `applyMs`: 应用到 transport deck state 的耗时
- `sampleCount` / `frameCount` / `sampleRate` / `channels`

## 下次复现后的第一步

如果用户说“当前项目实例复现了”：

```powershell
rg -n "\[HB-PENDING-PLAY\]|\[HB-TRANSPORT-SLOW\]|\[HB-TRANSPORT-DECODE-SLOW\]" "log.txt"
```

如果用户贴出其他实例日志：

- 不要读取当前 `log.txt`。
- 直接从贴出的日志里找上述三个前缀。
- 如果缺少 `[HB-TRANSPORT-DECODE-SLOW]`，说明那个实例可能还没有包含最新诊断，或者没有重启到新 native/runtime。

如果再次复现时已经包含当前候选改动：

- 先确认日志里是否还有 `[HB-TRANSPORT-SLOW] prepare-playhead`，以及它的 `elapsedMs` 是否仍接近 `[HB-PENDING-PLAY] cleared.elapsedMs`。
- 如果没有慢 `prepare-playhead`，不要继续沿着同步重解猜；改看 async decode 队列、full decode 应用、snapshot 广播、renderer pending 状态是否延迟清除。
- 如果有 `[HB-TRANSPORT-DECODE-SLOW] sync`，继续按 FFmpeg 阶段字段拆解。
- 如果只有 `[HB-PENDING-PLAY]`，只能说明卡在 `playheadLoaded=false`，需要先补齐或确认该实例是否带有主进程/Rust 慢日志。

## 判读规则

### 1. 判断是不是同一个事件

把三类日志按时间和 deck 对齐：

- `[HB-PENDING-PLAY] threshold`
- `[HB-TRANSPORT-SLOW] prepare-playhead`
- `[HB-PENDING-PLAY] cleared`
- `[HB-TRANSPORT-DECODE-SLOW] sync`

如果 `prepare-playhead.elapsedMs` 接近 `cleared.elapsedMs`，就是点击播放后同步准备播放头导致按钮忙碌。

### 2. 判断慢在队列还是 FFmpeg

- `queueWaitMs` 很大：后台 async decode worker 被占或排队，优先看 worker 数、full decode/分析任务是否抢占。
- `ffmpegSpawnMs` 很大：FFmpeg 进程启动成本高，才考虑常驻/worker pool 是否有意义。
- `ffmpegFirstByteMs` 很大但 `ffmpegSpawnMs` 不大：文件打开、探测、seek、MP3/VBR 定位可能慢。
- `ffmpegReadMs` 很大：解码/读取 10 秒 PCM 慢，可能是文件/磁盘/CPU。
- `ffmpegConvertMs` 很大：s16le 转 f32 成本异常，按 Rust 转换路径查。
- `prepareMs` 或 `applyMs` 很大：transport 内部 PCM 包装或状态应用慢，这才去查 Rust apply/Arc/master tempo 初始化。

### 3. 判断为什么偶发

偶发不是逻辑随机，而是点播放时机撞没撞上这个窗口：

```text
loaded=false
decoding=true
playheadLoaded=false
hadPendingStartupAtStart=true
```

如果载入后等一会儿再点，后台 startup decode 可能已经完成，`playheadLoaded=true`，就不会闪。

## 复现建议

不要为了复现乱清系统缓存。需要提高概率时可以：

- 选没刚播放过的新歌。
- 优先选不同库/不同盘符里的歌。
- 双轨页面只加载 top，bottom 保持空。
- 歌一载入立刻点播放，不等波形和信息稳定。
- 连续换几首新歌重复。
- 如果需要压力环境，可以同时跑导入/分析任务，但要在日志里说明。

## 当前代码状态注意事项

- 修改 Rust transport 后必须运行 `pnpm run rust-package:ensure`，否则源码和本地 native runtime 可能脱节。
- 本轮已跑过 `pnpm run rust-package:ensure` 并确认 `horizontalBrowseTransportDrainDecodeDiagnostics` 可从 JS require 到。
- 当前诊断是临时/排查性质的常驻阈值日志。后续真正修复并稳定后，应按 Debug Logging 规则清理或收窄。

## 已验证命令

```powershell
npx vue-tsc --noEmit
pnpm exec eslint "src/main/ipc/horizontalBrowseTransportBridge.ts" "src/main/ipc/horizontalBrowseTransportHandlers.ts"
cargo test --manifest-path "rust_package/Cargo.toml" horizontal_browse_transport --lib
pnpm exec electron-vite build
node -e "const rp=require('./rust_package'); console.log(typeof rp.horizontalBrowseTransportDrainDecodeDiagnostics, Array.isArray(rp.horizontalBrowseTransportDrainDecodeDiagnostics?.()))"
```

验证备注：

- `npx vue-tsc --noEmit` 只出现 npm 配置警告。
- Rust transport 相关测试 50 个通过。
- `cargo test` 过程中会输出 NAPI host runtime 探测警告，但退出码为 0。
- `electron-vite build` 通过。

## 下一步修复方向

不要先改按钮动画。

优先候选：

1. 复验当前“复用已有 pending startup decode 窗口”的候选改动；如果仍复现，再看新的慢日志分布。
2. 避免播放点击路径同步硬等 startup decode，改成 async ready 后自动续播。
3. 让载入歌曲后的 startup segment 预热更可靠，并复用已有片段。
4. 如果 `[HB-TRANSPORT-DECODE-SLOW]` 证明 `ffmpegSpawnMs` 占比很高，再讨论 FFmpeg 常驻/worker pool。
5. 如果主要是 `ffmpegFirstByteMs` 或 `ffmpegReadMs`，常驻 FFmpeg 未必能解决根因，应考虑 seek/解码/文件 IO 策略。
