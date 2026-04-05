# Rekordbox 外部库长时间运行 OOM 排查草案

更新时间：2026-04-05

## 1. 现象

开发环境长时间运行 `pnpm run dev` 后，Electron 进程崩溃退出。

已记录到的典型日志：

```text
OOM error in V8: ExternalEntityTable::AllocateEntry Allocation failed - process out of memory
```

同一段日志里还能看到：

- 崩溃前 JS heap 只有大约 `52 MB`
- 进程已运行约 `19,720,642 ms`，约等于 `5.48 小时`

这说明更像是：

- Electron / Node 侧的外部实体、原生句柄或桥接资源长期累积

而不像：

- 单纯 JS 数组或对象把普通堆内存打满

## 2. 当时环境

- 启动方式：`pnpm run dev`
- 模式：开发模式，带 Vite HMR
- 平台：Windows
- 触发时机：应用长时间挂着不管，数小时后才发现已退出

## 3. 当前已确认的高风险链路

### 3.1 Renderer 侧常驻轮询

`src/renderer/src/pages/modules/librarySelectArea/useRekordboxSourceIcons.ts`

旧实现存在：

- 每 `15` 秒固定跑一次外部源刷新
- `window focus` 时也会刷新
- 刷新时会继续调：
  - U 盘枚举
  - Rekordbox Desktop probe

如果应用长期挂着，这条链路会重复跑很多轮。

### 3.2 Main 侧 probe 强制刷新

`src/main/ipc/rekordboxDesktopLibraryHandlers.ts`

旧实现中：

- `rekordbox-desktop-library:probe`
- 每次都调用 `probeRekordboxDesktopLibrary(true)`

也就是说，哪怕底层已经有 TTL 缓存，IPC 入口还是会把它强行绕开。

### 3.3 为什么怀疑这条链路

原因很直接：

1. 崩溃发生在长时间空跑后，不像一次性操作打爆内存。
2. 当前这条外部源刷新逻辑是稳定的周期性后台任务。
3. 该任务会跨 renderer / IPC / main / Python helper 多层调用。
4. 崩溃日志里的 `ExternalEntityTable` 更像长期积累的外部资源，而不是普通 JS 数据。

## 4. 2026-04-05 已做修复

本次已落地的修复包括：

### 4.1 降低自动轮询频率

文件：

- `src/renderer/src/pages/modules/librarySelectArea/useRekordboxSourceIcons.ts`

改动：

- 自动轮询从 `15s` 提高到 `60s`

### 4.2 只在需要时才自动刷新外部源

文件：

- `src/renderer/src/pages/modules/librarySelectArea/useRekordboxSourceIcons.ts`

改动：

- 仅当当前视图是 `PioneerDeviceLibrary`
- 且页面 `visible`
- 且窗口当前有焦点

才允许定时自动刷新。

也就是说，用户如果切到别的库、窗口失焦、窗口隐藏，这条后台链路就不会继续傻跑。

### 4.3 刷新流程串行化

文件：

- `src/renderer/src/pages/modules/librarySelectArea/useRekordboxSourceIcons.ts`

改动：

- 同一时刻只允许一个 `refreshRekordboxSourceIcons` 在跑
- 避免定时器、focus、切视图几路事件同时打进来

### 4.4 Rekordbox probe 默认吃缓存

文件：

- `src/main/ipc/rekordboxDesktopLibraryHandlers.ts`
- `src/main/services/rekordboxDesktopLibrary/detect.ts`

改动：

- `probe` IPC 改为 `probeRekordboxDesktopLibrary(false)`
- 内部 `requireRekordboxDesktopLibraryProbe()` 也已改为不强制 refresh

这意味着：

- 常规读取路径会优先命中 TTL 缓存
- 不再每次都重新探测桌面库路径

## 5. 当前判断

截至 2026-04-05，当前最像根因的是：

> “开发模式下，Rekordbox / U 盘外部源刷新链路长期后台运行，反复触发 IPC 与外部探测，最终导致 Electron 进程的外部实体或原生资源累积，触发 V8 OOM。”

但要注意：

- 这是当前最强怀疑，不是已经拿到 native dump 后的终局定论。
- 如果修复后仍复现，需要继续排除：
  - Electron dev/HMR 自身长跑问题
  - 其他长期后台任务
  - 某个 IPC / helper / native 模块没有正确释放资源

## 6. 如果再次复现，先收集这些信息

### 6.1 先别急着重开

优先保留：

- 控制台完整输出
- 当时是否停留在 `PioneerDeviceLibrary` 视图
- 当时是否选中了 `desktop` 或 `usb` 外部源
- 是否开着 Rekordbox 本机库树

### 6.2 记录当前代码版本

在仓库根目录执行：

```powershell
git rev-parse HEAD
git status --short
```

### 6.3 保存开发日志

本项目 dev 模式日志默认写在仓库根目录：

- `log.txt`

建议执行：

```powershell
Get-Content "log.txt" -Tail 400
Copy-Item "log.txt" "tmp/log-oom-$(Get-Date -Format yyyyMMddHHmmss).txt"
```

### 6.4 检查是否生成系统 crash dump

Windows 常见位置：

```powershell
Get-ChildItem "$env:LOCALAPPDATA/CrashDumps" | Sort-Object LastWriteTime -Descending | Select-Object -First 20 FullName,LastWriteTime,Length
```

如果能看到和 `electron.exe`、`frkb`、`node.exe` 相关的 dump，先留档，不要急着删。

### 6.5 记录当时进程内存

如果复现前有机会观察到异常增长，建议记录：

```powershell
Get-Process electron,node | Select-Object Name,Id,CPU,PM,WS,StartTime | Sort-Object PM -Descending
```

其中：

- `PM` 是私有内存
- `WS` 是工作集

### 6.6 额外建议

如果后续需要专门复现这类长跑问题，建议单独开一轮：

1. 启动 `pnpm run dev`
2. 切到普通库，挂一夜
3. 再切到 `PioneerDeviceLibrary`，挂一夜
4. 对比两组结果

这样可以先判断问题是否仍明显依赖外部库视图。

## 7. 如果修复后还复现，下一轮排查顺序

建议按这个顺序继续查：

1. 确认崩溃时应用是否真的停留在 `PioneerDeviceLibrary`
2. 检查 `log.txt` 中是否仍有高频外部源刷新痕迹
3. 给 `refreshRekordboxSourceIcons`、`probe` IPC、Python helper 增加更细的开始/结束日志
4. 对比：
   - 外部库视图空跑
   - 普通库视图空跑
5. 如果普通库也会复现，优先怀疑 Electron dev/HMR 或其他后台任务
6. 如果只有外部库视图复现，继续盯：
   - IPC handler
   - Python helper 进程
   - 相关 native bridge

## 8. 本次修复涉及文件

- `src/renderer/src/pages/modules/librarySelectArea/useRekordboxSourceIcons.ts`
- `src/main/ipc/rekordboxDesktopLibraryHandlers.ts`
- `src/main/services/rekordboxDesktopLibrary/detect.ts`

## 9. 当前结论一句话版

这次最像是“外部库后台刷新链路长跑导致的开发态 OOM”，不是普通的前端列表缓存把内存吃爆。
