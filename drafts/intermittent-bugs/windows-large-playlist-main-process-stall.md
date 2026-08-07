# Windows 大歌单主进程偶发未响应接手文档

## 当前状态

- 状态：`已修复，待问题电脑现场验收`
- 首次记录：2026-08-06
- 已知影响版本：`1.2.2-rc.202608051614`、`1.2.2-rc.202608070938`
- 现场：另一台 Windows 电脑打开千首级筛选库歌单时几乎必现；当前开发电脑打开 1798 首的 `wait` 歌单无法复现明显未响应。
- 当前结论：`1.2.2-rc.202608070938` 的现场日志已确认主进程在无界创建 1224 个时间基修复任务时连续阻塞约 20 秒；代码修复已完成，但尚未发布新安装包，也未在问题电脑上验收。
- 另一台性能更低、歌单更多的电脑未复现，说明硬件性能和歌单总数不是充分根因；现场环境会放大 Windows 子进程创建成本，但不影响“主进程禁止无界启动 FFprobe”的修复结论。

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
10. 问题电脑在 `traceId = renderer-msj67yl5-2` 中扫描 1224 首歌曲，worker 仅耗时 2862 ms，主进程响应却耗时 23972 ms。
11. 该批次有 1224 个时间基候选且全部为进程内缓存 miss；从 `time-basis repair planned` 到 `time-basis tasks launched` 耗时 20376 ms。
12. 同一时段心跳记录 `stallDurationMs: 20097`，与任务创建区间吻合；IPC 送达仅耗时 84 ms，因此已排除 renderer 接收和 IPC 传输作为本次主因。
13. 原实现的 `songs.map(async ...)` 会在 `Promise.all` 前同步执行每个回调直到首次 `await`，因此会连续调用 1224 次 `execFile(ffprobe.exe)`，没有并发上限，也没有让出主事件循环。
14. 本次 1224 首中只有 168 首解析出非零偏移；其余合法零偏移若没有独立的解析版本标记，会在跨进程重启后继续被误判为旧版未修复数据。

## 2026-08-08 修复

修复原则：歌单打开链路只负责 worker 扫描和时间基候选规划，不再等待整批 FFprobe 与缓存回写。

- 时间基修复进入全局后台队列；批次串行执行，单批最多同时运行 4 个 FFprobe。
- 队列接收的是尚未启动的任务函数，禁止在构造任务数组时提前创建子进程。
- `scanSongList` 在后台修复完成前即可返回，当前歌单通过已有 `song-grid-updated` 事件逐首接收修复结果。
- 同目录歌曲复用一次歌单根查询，避免逐首同步查询 `library_nodes`。
- 缓存持久化只使用 SQLite `json_set` 原子更新 `timeBasisOffsetMs` 和 `timeBasisOffsetAlgorithmVersion`，不再拿扫描时的整首旧对象覆盖 `info_json`，避免后台任务覆盖用户随后做出的网格编辑。
- 新增 `timeBasisOffsetAlgorithmVersion`。已确认的合法零偏移也会记录版本，后续冷启动不会重复探测；没有该标记的旧版 MP3 零偏移仍会执行一次兼容修复。
- FFprobe 的 `execFile` 调用在专用 Node worker thread 中执行；不能只把 Promise 放到后台，因为 Windows 子进程创建本身可能同步阻塞调用它的线程。
- 原有诊断日志继续保留，用于现场确认主响应先返回、后台最大并发不超过 4，以及不再出现同 trace 的主进程长停顿。

### 2026-08-08 开发模式首次验收后的补充修复

第一次实现只把修复移出歌单响应链并限制并发，FFprobe 仍由 Electron 主线程调用。开发模式现场日志证明这还不充分：

- `traceId = renderer-msj8mk00-1` 只有 2 个 MP3 候选；
- `main response ready` 后 11 ms renderer 已收到结果；
- 后台修复期间仍出现 `stallDurationMs: 3224`；
- `resolveDurationMaxMs: 3746`，而 SQLite 两次原子更新总计仅 1 ms；
- 第二次打开候选已降为 0，说明版本标记持久化正确。

因此第二次修复把 FFprobe 探测和 Windows 子进程启动整体移入 `audioTimeBasisOffsetWorker`。后台队列仍在主线程负责最多并发 4、缓存原子更新和界面事件，但主线程不再直接调用 `execFile(ffprobe.exe)`。

## 复现前的嫌疑链（历史记录）

以下分支是取得 `1.2.2-rc.202608070938` 现场日志之前的排查假设。新日志已经把本次卡顿收敛到时间基任务无界启动；磁盘和杀毒软件仍可能放大进程创建耗时，但不再作为等待修复的前置条件。

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
- `time-basis background repair started`
- `time-basis background repair completed`
- `main response ready`
- `main scan failed`

关键字段：

- `workerDurationMs` 和 `workerPerf`
- `candidateCount`
- `cacheHitCount` / `cacheMissCount`
- `extensionCounts`
- `backgroundScheduled` / `concurrency`
- `executionContext`：修复后固定为 `worker-thread`
- `queueWaitDurationMs` / `repairDurationMs`
- `resolveDurationTotalMs` / `resolveDurationMaxMs`
- `cachePersistenceDurationTotalMs` / `cachePersistenceDurationMaxMs`
- `cachePatchAttemptedCount` / `cachePatchSucceededCount`
- `cacheRootMissingCount`
- `maxActiveCount` / `failedCount`
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
time-basis-background-queued
time-basis-background-running
response-ready-background-repair
post-scan-schedule
response-ready
failed
```

## 修复后现场验收流程

1. 确认问题电脑安装的版本已经包含本次修复。当前源码尚未随新安装包发布，后续发布后应在本节补充版本号和提交 SHA。
2. 完全退出 FRKB，确认任务管理器中没有残留 `FRKB.exe` 和 `ffprobe.exe`。
3. 重新启动 FRKB，第一次打开问题歌单；不要先打开其他大歌单预热缓存。
4. 确认歌单在 worker 扫描结束后即可打开，窗口保持可交互；后台时间基事件可继续逐首回填。
5. 保存问题电脑的 `%APPDATA%\FRKB\log.txt`。
6. 核对同一 trace：`main response ready` 应早于 `time-basis background repair completed`，`maxActiveCount <= 4`，且不应再出现覆盖该后台阶段的长时间 `main-process event loop stalled`。
7. 完全退出并重启后再次打开同一歌单；已记录 `timeBasisOffsetAlgorithmVersion` 的合法零偏移歌曲不应重新成为候选。

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
src/main/services/audioTimeBasisOffsetProbe.ts
src/main/services/audioTimeBasisOffsetWorker.ts
src/main/services/playlistTimeBasisRepair.ts
src/main/services/playlistTimeBasisRepair.spec.ts
src/main/workers/audioTimeBasisOffsetWorker.ts
src/main/services/playlistScanDiagnostics.ts
src/main/window/mainWindow/responsivenessDiagnostics.ts
src/main/libraryCacheDb.ts
src/main/libraryCacheDb/songCache.ts
src/main/librarySchemaV37Migration.ts
src/main/services/scanSongs.ts
src/types/globals.d.ts
electron.vite.config.ts
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
npx vitest run src/main/services/playlistTimeBasisRepair.spec.ts src/main/services/scanSongs.spec.ts
npx vue-tsc --noEmit
pnpm run build
npx eslint "electron.vite.config.ts" "src/main/ipc/playlistHandlers.ts" "src/main/libraryCacheDb.ts" "src/main/libraryCacheDb/songCache.ts" "src/main/librarySchemaV37Migration.spec.ts" "src/main/librarySchemaV37Migration.ts" "src/main/services/audioTimeBasisOffset.ts" "src/main/services/audioTimeBasisOffsetProbe.ts" "src/main/services/audioTimeBasisOffsetWorker.ts" "src/main/services/keyAnalysis/persistence.ts" "src/main/services/playlistTimeBasisRepair.spec.ts" "src/main/services/playlistTimeBasisRepair.ts" "src/main/services/scanSongs.spec.ts" "src/main/services/scanSongs.ts" "src/main/workers/audioTimeBasisOffsetWorker.ts" "src/types/globals.d.ts"
node "node_modules/prettier/bin/prettier.cjs" --check "electron.vite.config.ts" "src/main/ipc/playlistHandlers.ts" "src/main/libraryCacheDb.ts" "src/main/libraryCacheDb/songCache.ts" "src/main/librarySchemaV37Migration.spec.ts" "src/main/librarySchemaV37Migration.ts" "src/main/services/audioTimeBasisOffset.ts" "src/main/services/audioTimeBasisOffsetProbe.ts" "src/main/services/audioTimeBasisOffsetWorker.ts" "src/main/services/keyAnalysis/persistence.ts" "src/main/services/playlistTimeBasisRepair.spec.ts" "src/main/services/playlistTimeBasisRepair.ts" "src/main/services/scanSongs.spec.ts" "src/main/services/scanSongs.ts" "src/main/workers/audioTimeBasisOffsetWorker.ts" "src/types/globals.d.ts"
git diff --check
```

结果：

- 定向 Vitest 共 2 个文件、6 个测试通过，覆盖候选筛选、合法零偏移版本标记、偏移与版本标记一致性、最大并发 4、同目录根查询复用，以及入队立即返回。
- `npx vue-tsc --noEmit`、`pnpm run build`、定向 ESLint、Prettier 检查和 `git diff --check` 通过；构建产物包含 `out/main/workers/audioTimeBasisOffsetWorker.js`，仅出现 npm 对旧项目配置项的弃用警告和既有 Vite chunk 提示。
- `npx vitest run src/main/librarySchemaV37Migration.spec.ts` 未进入断言：本机 `better_sqlite3.node` 使用 `NODE_MODULE_VERSION 145` 编译，而当前 Node 需要 `137`。这是本机原生模块 ABI 不匹配，不是迁移逻辑测试失败；未为此次验证擅自重编依赖。

没有启动新的 dev/Electron 实例，也没有在当前电脑强行制造 1798 个 FFprobe 压力测试。

## 给下一次对话的接手指令

```text
继续排查 Windows 大歌单主进程偶发未响应。
先完整阅读 drafts/intermittent-bugs/windows-large-playlist-main-process-stall.md，
再读取本次复现产生的 log.txt，按 traceId 对齐 playlist-scan-diagnostic 和
main-process event loop stalled。先确定卡在哪个阶段，不要直接认定 FFprobe 是根因。
```
