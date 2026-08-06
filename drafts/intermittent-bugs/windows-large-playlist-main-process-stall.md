# Windows 大歌单主进程偶发未响应接手文档

## 当前状态

- 状态：`诊断中`
- 首次记录：2026-08-06
- 已知影响版本：`1.2.2-rc.202608051614`
- 现场：另一台 Windows 电脑打开千首级筛选库歌单时几乎必现；当前开发电脑打开 1798 首的 `wait` 歌单无法复现明显未响应。
- 当前结论：只能确认 Electron 主进程事件循环发生长时间停顿，尚未确认具体阻塞代码。
- 阶段诊断和本文档已纳入源码交付，但尚未随新安装包发布，也未在问题电脑上验收。

## 用户可感知现象

在 Windows 中打开一个一千多首歌的筛选库歌单时，窗口短暂无响应。已捕获日志：

```text
2026-08-05T15:41:27.477Z [v1.2.2-rc.202608051614] [ERROR] [main-window] main-process event loop stalled {
  stallDurationMs: 6971,
  snapshot: {
    windowId: 2,
    webContentsId: 2,
    rendererPid: 31340,
    focused: true,
    visible: true
  }
}
```

诊断心跳周期为 1 秒，因此 `stallDurationMs: 6971` 表示相邻心跳实际间隔约 7.97 秒。

日志中的进程创建时间为：

- Browser：`2026-08-05T15:41:08.935Z`
- GPU：`2026-08-05T15:41:09.685Z`
- Renderer：`2026-08-05T15:41:10.452Z`

卡顿发生在应用启动约 18.5 秒后。倒推主进程阻塞大约从 `15:41:19.5Z` 开始，符合冷启动后打开歌单、1.5 秒后台磁盘刷新随后触发的时间窗口，但这仍只是时间关系，不是根因证明。

## 已确认事实

1. 卡顿由主进程 1 秒心跳检测到，不只是 renderer 列表渲染掉帧。
2. 出问题电脑和当前电脑使用的安装包版本相同，均为 `1.2.2-rc.202608051614`。
3. 当前电脑打包版数据库路径为 `E:\FRKB_database`。
4. 当前电脑筛选库 `wait` 歌单有 1798 首：1721 个 MP3、77 个 FLAC。
5. 当前数据库中这 1798 首都有有效 `beatGridMap.clips`，但均缺少 `timeBasisOffsetMs`。
6. 当前代码会在 worker 扫描返回后，于主进程检查整批歌曲的时间基，并通过 `Promise.all` 创建修复任务。
7. `resolveAudioTimeBasisOffsetMsForFile()` 的缓存仅存在于当前进程内，不能跨 FRKB 重启复用。
8. `better-sqlite3` 是同步驱动，即使外层函数声明为 `async`，JSON 序列化和数据库语句仍可能阻塞主事件循环。
9. 当前电脑打开同规模歌单没有明显未响应，因此“1798 首”或“缺少时间基”本身不能作为充分根因。

## 当前嫌疑链

以下方向需要用新日志确认，禁止提前定性：

### 1. 时间基修复任务创建或 FFprobe

路径：

```text
renderer useSongsLoader
  -> scanSongList IPC
  -> songListScanWorker
  -> repairScannedSongGridTimeBases
  -> resolveAudioTimeBasisOffsetMsForFile
  -> ffprobe.exe
```

可能的电脑差异包括：

- CPU 和 Windows 创建大量子进程的速度；
- 音频位于 SSD、机械硬盘、移动硬盘或网络盘；
- Windows Defender/第三方杀毒对每个 `ffprobe.exe` 和音频文件进行扫描；
- 当前进程中的时间基内存缓存是否已经预热；
- 打开歌单时是否正好处于冷启动后的第一次真实磁盘扫描。

### 2. SQLite 缓存加载或回写

可能表现：worker 扫描完成不慢，但主进程在逐首查找歌单根、读取 stat 或同步写入 `song_cache` 时停顿。

### 3. IPC 结果传输

主进程可能已经准备好扫描结果，但 Electron 在序列化或向 renderer 传输歌曲数组时阻塞。需要比较 `main response ready` 和 renderer `response received` 的时间差。

### 4. 其他启动期任务

现有通用卡顿日志只能说明主进程停顿。若新日志显示卡顿时没有活跃的歌单扫描，应停止沿上述链路猜测，改查同一时间的数据库迁移、全局搜索索引、文件监听器或其他启动任务。

## 已加入诊断

统一日志关键词：

```text
playlist-scan-diagnostic
main-process event loop stalled
```

统一关联字段：

```text
traceId
```

### Renderer 阶段

文件：`src/renderer/src/pages/modules/songsArea/composables/useSongsLoader.ts`

日志：

- `request started`
- `response received`
- `request failed`

关键字段：

- `diagnosticSource`：`foreground-open`、`background-refresh` 或 `fresh-analysis`
- `rendererStartedAtMs`
- `receivedAtMs`
- `rendererDurationMs`
- `deliveryAfterMainReadyMs`

### 主进程扫描阶段

文件：`src/main/ipc/playlistHandlers.ts`

日志：

- `main scan started`
- `worker scan completed`
- `time-basis repair planned`
- `time-basis tasks launched`
- `time-basis repair completed`
- `main response ready`
- `main scan failed`

关键字段：

- `workerDurationMs` 和 `workerPerf`
- `candidateCount`
- `cacheHitCount` / `cacheMissCount`
- `extensionCounts`
- `taskLaunchDurationMs`
- `resolveDurationTotalMs` / `resolveDurationMaxMs`
- `cachePersistenceDurationTotalMs` / `cachePersistenceDurationMaxMs`
- `cacheUpsertAttemptedCount` / `cacheUpsertSucceededCount`
- `cacheRootMissingCount`
- `fileStatMissingCount`
- `mainDurationMs`

### 主进程卡顿快照

文件：

- `src/main/window/mainWindow/responsivenessDiagnostics.ts`
- `src/main/services/playlistScanDiagnostics.ts`

`main-process event loop stalled` 的 `snapshot.playlistScans` 会包含当前活跃扫描和最近 30 秒内完成的扫描，最多保留 8 条。关键字段：

- `traceId`
- `phase`
- `elapsedMs`
- `phaseElapsedMs`
- `source`
- `songListUUID`
- `scanPaths`
- `trackCount`
- `candidateCount`
- `cacheHitCount` / `cacheMissCount`

可能的 `phase`：

```text
worker-scan
worker-result-received
time-basis-plan
time-basis-task-launch
time-basis-await
post-scan-schedule
response-ready
failed
```

## 下次复现流程

1. 确认问题电脑安装的版本已经包含本文诊断代码。当前源码交付尚未随新安装包发布，后续发布后应在本节补充版本号和提交 SHA。
2. 完全退出 FRKB，确认任务管理器中没有残留 `FRKB.exe` 和 `ffprobe.exe`。
3. 重新启动 FRKB，第一次打开问题歌单；不要先打开其他大歌单预热缓存。
4. 出现未响应后等待窗口自行恢复，不要立即强制结束进程。
5. 保存问题电脑的 `%APPDATA%\FRKB\log.txt`。
6. 同时记录：音频所在盘符、磁盘类型、是否为 USB/网络盘、杀毒软件，以及同一进程内第二次打开是否还会卡。

如果日志已经复制到当前仓库根目录，优先执行：

```powershell
rg -n -C 30 "playlist-scan-diagnostic|main-process event loop stalled|renderer unresponsive|renderer recovered" "log.txt"
```

不要默认让用户复制浏览器控制台；应直接读取 `log.txt`。

## 日志判读分支

### A. worker 扫描慢

特征：

- `workerDurationMs` 接近卡顿总时长；
- `worker scan completed` 很晚才出现；
- stall 快照中 `phase = worker-scan`。

下一步：按 `workerPerf.listFilesMs`、`cacheCheckMs`、`parseMetadataMs` 拆分，检查磁盘扫描、SQLite 缓存加载和元数据解析。

### B. 创建时间基任务时卡住

特征：

- `candidateCount` 和 `cacheMissCount` 很大；
- `taskLaunchDurationMs` 接近卡顿时长；
- stall 快照落在 `time-basis-task-launch` 或紧邻该阶段。

下一步：确认是否在主进程同步创建大量 `ffprobe` 子进程；候选修复是移出打开歌单关键路径，并限制并发。没有日志证明前不要直接改。

### C. 等 FFprobe、磁盘或杀毒软件慢

特征：

- `taskLaunchDurationMs` 不大；
- `resolveDurationMaxMs` 或整个 `time-basis repair totalDurationMs` 很大；
- 不同电脑差异明显。

下一步：对比音频盘类型、Defender/第三方杀软、FFprobe 版本和冷启动；必要时再增加阈值化的 FFprobe spawn/first-byte 阶段日志。

### D. SQLite 回写慢

特征：

- `cachePersistenceDuration*` 明显异常；
- `cacheUpsertAttemptedCount` 很大；
- `cacheUpsertSucceededCount` 明显不足时，同时检查错误日志。

下一步：考虑批量事务、后台 worker 或避免在歌单打开关键路径逐首写入。

### E. IPC 送达慢

特征：

- `mainDurationMs` 正常；
- `main response ready` 已经出现；
- `deliveryAfterMainReadyMs` 很大；
- stall 快照中可能只剩最近完成的 `response-ready` 记录。

下一步：检查返回对象体积、Electron structured clone、主进程到 renderer 的传输，以及 renderer 接收后的同步工作。

### F. stall 时没有歌单扫描记录

特征：`snapshot.playlistScans` 为空或时间对不上。

下一步：排除本链路，转查启动迁移、全局搜索、文件监听器或其他 IPC；不要继续围着 FFprobe 猜。

## 本次源码交付范围

```text
src/main/ipc/playlistHandlers.ts
src/main/services/audioTimeBasisOffset.ts
src/main/services/playlistScanDiagnostics.ts
src/main/window/mainWindow/responsivenessDiagnostics.ts
src/renderer/src/pages/modules/songsArea/composables/useSongsLoader.ts
drafts/intermittent-bugs/README.md
drafts/intermittent-bugs/windows-large-playlist-main-process-stall.md
```

这些日志是用户明确要求保留、用于下一次偶发现场的诊断日志。当前阶段不要按普通 Debug Logging 清理；清理条件是：

1. 问题电脑成功复现并通过 `traceId` 确认具体阶段；
2. 根因修复完成；
3. 同一真实链路复验通过；
4. 再删除或收窄非错误诊断日志。

## 已完成验证

```powershell
npx vue-tsc --noEmit
npx eslint "src/main/services/playlistScanDiagnostics.ts" "src/main/services/audioTimeBasisOffset.ts" "src/main/window/mainWindow/responsivenessDiagnostics.ts" "src/main/ipc/playlistHandlers.ts" "src/renderer/src/pages/modules/songsArea/composables/useSongsLoader.ts"
node "node_modules/prettier/bin/prettier.cjs" --check "src/main/services/playlistScanDiagnostics.ts" "src/main/services/audioTimeBasisOffset.ts" "src/main/window/mainWindow/responsivenessDiagnostics.ts" "src/main/ipc/playlistHandlers.ts" "src/renderer/src/pages/modules/songsArea/composables/useSongsLoader.ts"
git diff --check
```

结果：全部通过，仅出现 npm 对旧项目配置项的弃用警告。

没有启动新的 dev/Electron 实例，也没有在当前电脑强行制造 1798 个 FFprobe 压力测试。

## 给下一次对话的接手指令

```text
继续排查 Windows 大歌单主进程偶发未响应。
先完整阅读 drafts/intermittent-bugs/windows-large-playlist-main-process-stall.md，
再读取本次复现产生的 log.txt，按 traceId 对齐 playlist-scan-diagnostic 和
main-process event loop stalled。先确定卡在哪个阶段，不要直接认定 FFprobe 是根因。
```
