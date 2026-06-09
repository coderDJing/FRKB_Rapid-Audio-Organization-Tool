# Horizontal Browse pending-play 慢启动接手文档

## 适用范围

这个文档用于接手排查 Horizontal Browse 双轨页面里“载入歌曲后点击播放按钮，播放按钮闪烁/忙碌态持续 2-4 秒”的偶发现象。

重要：复现不一定发生在当前仓库实例里。用户可能会：

- 在当前 `D:\playground\FRKB_Rapid-Audio-Organization-Tool-4` 实例复现，并要求直接看当前 `log.txt`。
- 在其他 FRKB 实例或已发布 RC 里复现，只贴出日志片段。这种情况下不要去当前仓库的 `log.txt` 硬找，直接分析用户贴出的日志。
- 开新会话继续排查。新会话第一步先问清楚“这是当前项目实例的 `log.txt`，还是别的实例贴出来的日志”，除非用户已经明确说明。

## 当前结论

已确认的根因方向：

- 播放按钮长时间闪烁不是按钮 CSS/动画问题。
- 不是双轨同步互等；已复现日志里 `dualSyncActive:false`，bottom 轨为空。
- 不是在等整首歌 full decode 完成；pending 清除时仍可看到 `full-decode-pending`。
- 慢点在播放点击路径触发 `prepare-playhead` 时，同步解当前播放头附近 10 秒 bootstrap PCM。
- 当点播放时已经有后台 startup decode 在路上但还未覆盖播放头，会出现 `hadPendingStartupAtStart:true`，随后 `prepare-playhead` 同步接管并卡住主进程。

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
- Rust transport 相关测试 49 个通过。
- `cargo test` 过程中会输出 NAPI host runtime 探测警告，但退出码为 0。
- `electron-vite build` 通过。

## 下一步修复方向

不要先改按钮动画。

优先候选：

1. 避免播放点击路径同步硬等 startup decode，改成 async ready 后自动续播。
2. 让载入歌曲后的 startup segment 预热更可靠，并复用已有片段。
3. 如果 `[HB-TRANSPORT-DECODE-SLOW]` 证明 `ffmpegSpawnMs` 占比很高，再讨论 FFmpeg 常驻/worker pool。
4. 如果主要是 `ffmpegFirstByteMs` 或 `ffmpegReadMs`，常驻 FFmpeg 未必能解决根因，应考虑 seek/解码/文件 IO 策略。
