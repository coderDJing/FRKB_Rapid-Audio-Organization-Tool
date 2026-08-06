# Pioneer Device Library U 盘歌单缺曲或错序交叉验证手册

## 当前状态

- 状态：`候选修复待验收`
- 首次记录：2026-08-06
- 当前源码版本：`1.2.2-rc.202608061042`
- 影响范围：Rekordbox 导出的 Pioneer Device Library U 盘，尤其是同时存在 `export.pdb` 与 `exportLibrary.db` 的设备。
- 当前结论：Device Library 的 PDB 歌单树和曲目是主数据；OneLibrary 仅在严格一致时补全，不能因 OneLibrary 缺少歌单而认定 PDB 歌单已删除。
- 待完成验收：重启 FRKB 后，在真实页面确认 `Device Library / 未完Set / abyss` 的 24 首曲目与 Rekordbox 顺序一致。

本文是长期维护手册。每次遇到 U 盘歌单“消失、少曲、顺序错乱或标题错位”时，先按本文取证和交叉验证，不要直接改 UI、直接覆盖 PDB 条目，或把 OneLibrary 当成唯一真相。

## 用户可感知现象

本次已经出现过以下现象：

1. Device Library 中存在的歌单在 OneLibrary 中不存在，日志出现 `未找到 OneLibrary 歌单: <id>`。
2. FRKB 显示的曲目数少于 Rekordbox，例如 Rekordbox 为 24 首、FRKB 只显示 8 或 9 首。
3. 数量恢复后顺序仍然错误，例如 Rekordbox 第 5 首是 `Afar (Joyhauser remix)`，FRKB 却显示 `DHEA`；`DHEA` 实际应为第 6 首。

这些现象可以同时存在，必须把“歌单节点是否存在”“曲目数量”“曲目顺序/身份”拆开验证。

## 数据源职责和优先级

| 数据源 | 职责 | 可作为主数据的条件 | 不可据此推出的结论 |
| --- | --- | --- | --- |
| `PIONEER/rekordbox/export.pdb` | Device Library 树、歌单 ID、曲目条目和顺序 | 目标节点/条目可解析，且曲目 ID 可在 PDB 曲目表解析 | OneLibrary 缺失时，不能据此认定 PDB 歌单无效 |
| `PIONEER/rekordbox/exportLibrary.db` | OneLibrary 树和曲目补充 | 与 PDB 的歌单 ID、非空名称、已有条目 `entryIndex`、`trackId` 与可用路径严格一致，且 OneLibrary 曲目更多 | 不能覆盖不一致的 PDB 曲目，更不能过滤掉仅存在于 PDB 的歌单 |
| Rekordbox 设备库界面或播放器 | 用户可见的最终参照 | 与同一块 U 盘、同一次导出对应 | 不能只看数量；必须同时核对至少一个中间位置和尾部位置 |

当前调用链在 Device Library 模式下先读取 PDB；若同盘有 OneLibrary，则仅通过 `reconcileDeviceLibraryPlaylistTracks()` 做严格补全。`OneLibraryPlaylistNotFoundError` 是预期的跨库差异，不应继续落成“读取 Device Library 失败”的错误，也不能丢弃已经读出的 PDB 曲目。

## 已确认根因和教训

### 1. `present_rows()` 可能截断 PDB 页尾有效条目

`rekordcrate` 依据页头的 `num_rows` 读取页尾索引组。部分真实导出 PDB 的页头索引不完整，但页尾仍有带有效位图的后续条目。因此普通解析器可能只返回歌单前缀或后缀。

恢复时必须同时满足以下条件：

1. 只扫描真正的 `PlaylistEntries` PDB 页面。
2. 只接受页尾 `row_presence_flags` 标记为存在的行。
3. 偏移必须位于该页已使用的数据区内，且可完整读取 12 字节条目。
4. 条目 `playlistId` 必须是目标歌单，`entryIndex` 和 `trackId` 必须为正数。
5. 每个 `trackId` 都必须能在 PDB 曲目表解析元数据。
6. 最终的 `entryIndex` 必须完整连续为 `1..N`，且恢复后曲目数严格增加。

任一条件不满足时，保持解析器原始结果，不从原始字节“猜”曲目。

### 2. 不能用页尾最新物理记录整段覆盖已有条目

页尾会保留历史条目。曾经的错误恢复逻辑按每个 `entryIndex` 选择物理位置最后的记录，并用它全量替换已有条目，造成第 5 首 `Afar (Joyhauser remix)` 被覆盖成 `DHEA`。

当前规则：

1. 解析器已经返回的有效 `entryIndex -> trackId` 是锚点，绝不替换。
2. 锚点最大索引之前只补缺口；缺口使用该索引最新的有效原始条目。
3. 锚点最大索引之后，只从最后一个已知条目的同曲目物理位置向后连续补齐。
4. 一旦下一个索引无有效候选，立即停止；不跨越缺口拼接。

这使恢复逻辑既能补第 4 首缺口和第 10 至 24 首尾段，又不会重写已经确认的第 5 至 9 首。

## 当前案例台账

| 日期 | U 盘/歌单 | Rekordbox 参照 | 初始 PDB 解析 | OneLibrary | 已验证恢复结果 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-05 | `playlistId=121`，`无标题列表 (3)` | 18 首 | 仅 7 首（`12..18`） | 不存在该歌单 | 恢复连续 `1..18` | 已关闭，保留回归案例 |
| 2026-08-06 | `playlistId=116`，`未完Set/abyss` | 24 首 | 8 首：`1,2,3,5..9` | 20 首且不完整 | 实盘原生读取为连续 `1..24`；第 5 首 `Afar (Joyhauser remix)`，第 6 首 `DHEA`，第 16 首 `Cancel Your Ego (Original Mix)`，第 24 首 `The Quick (Original Mix)` | 候选修复待 FRKB 页面验收 |

台账必须记录实际曲目数、至少一个中间位置和最后一首。只记录“数量一样”不足以证明顺序正确。

## 下次现场排查流程

### 1. 先保护现场

1. 记录 U 盘根目录、导出时间、Rekordbox 看到的歌单路径、`playlistId`、曲目数和至少 3 个位置的标题。
2. 只读检查 `PIONEER/rekordbox/export.pdb`、可选的 `exportLibrary.db` 与 `exportExt.pdb`。不要让 FRKB、脚本或系统修复工具写回 U 盘。
3. 不要因为 OneLibrary 报“未找到歌单”就从 Device Library 树中删除该节点。

### 2. 直接读取 PDB，核对数量、连续索引和身份

先确保当前源码的原生模块已构建，再在仓库根目录运行。将路径和歌单 ID 替换为现场值：

```powershell
@'
const native = require('./rust_package')
const result = native.readPioneerPlaylistTracks('F:/PIONEER/rekordbox/export.pdb', 116)
const rows = result.tracks.map(({ entryIndex, trackId, title }) => ({ entryIndex, trackId, title }))
console.log(JSON.stringify({
  playlistName: result.playlistName,
  trackTotal: result.trackTotal,
  continuous: rows.every((row, index) => row.entryIndex === index + 1),
  rows
}, null, 2))
'@ | node -
```

判读：

- `trackTotal` 与 Rekordbox 不同：继续查 PDB 页尾恢复条件和 OneLibrary 交叉比对。
- `continuous=false`：不能把结果视为已恢复，先保留现场并检查原始 PDB 页。
- 数量相同但中间标题不同：优先查是否覆盖了已有 PDB 条目，以及是否漏用了页尾有效位图。
- 第一个、中间位置和最后一个均相同：才可进入 FRKB 页面验收。

### 3. 检查 FRKB 调用链和日志

Device Library 调用链：

```text
Renderer
  -> pioneerDeviceLibraryHandlers
  -> loadPioneerPlaylistTracksByDrivePath
  -> pioneerDeviceLibraryWorker
  -> rust_package.readPioneerPlaylistTracks(export.pdb, playlistId)
  -> optional readOneLibraryPlaylistTracks(exportLibrary.db)
  -> strict reconciliation only
```

开发模式日志固定读仓库根目录 `log.txt`；打包运行才读 Electron `userData` 目录的 `log.txt`。优先搜索：

```powershell
rg -n -C 12 "pioneer-device-library|OneLibrary|export.pdb|exportLibrary.db" "log.txt"
```

`OneLibraryPlaylistNotFoundError` 只说明 OneLibrary 没有同 ID 歌单。若 Device Library 的 PDB 已成功读取，它不是 PDB 歌单删除的证据。

### 4. 必要时采集诊断快照

仅当上面的原生读取和页面结果仍不一致时，运行现有脚本：

```powershell
node "scripts/dump-pioneer-device-library-debug.cjs"
```

该脚本会把快照写入仓库根目录 `log.txt`。采集后立即阅读并保留同一次 U 盘导出的证据；不要把它改成常驻日志。

## 修改和验证门槛

涉及 PDB 恢复或 OneLibrary 对账的改动，至少执行：

```powershell
cd rust_package
cargo test playlist_entry_recovery_tests
corepack yarn build
cd ..
npx vue-tsc --noEmit
pnpm run build
```

然后必须用真实 U 盘直接调用 `readPioneerPlaylistTracks()`，检查：

1. 总数与 Rekordbox 一致；
2. `entryIndex` 连续；
3. 至少核对首首、中间、尾首的 `trackId` 和标题；
4. 重启现有 FRKB 后在 Device Library 页面重复核对。

本次源码验证结果：PDB 恢复单测 4 项通过，`npx vue-tsc --noEmit` 与 `pnpm run build` 通过；针对 `playlistId=116` 的真实 PDB 原生读取返回 24 首连续条目并通过上述关键位置核验。

## 临时诊断和关闭条件

当前没有为本问题保留常驻非错误日志。只有在新的现场仍不能判定时，才临时增加经过阈值控制且可检索的 `log.txt` 诊断；页面验收后必须删除。

将本文状态改为 `已关闭` 前，需要同时满足：

1. FRKB 页面与 Rekordbox 的数量、顺序和关键曲目身份一致；
2. OneLibrary 缺失不再导致 Device Library 歌单消失或报误导性错误；
3. 至少已对案例台账中的两个 PDB 结构完成原生读取回归；
4. 无临时诊断日志遗留。

## 给下一次对话的接手指令

```text
继续排查 Pioneer Device Library U 盘歌单缺曲或错序。
先阅读 drafts/intermittent-bugs/pioneer-device-library-usb-playlist-consistency.md，
再读取本次 U 盘的 export.pdb，使用 rust_package.readPioneerPlaylistTracks() 核对
曲目数、连续 entryIndex、首/中/尾曲目身份。OneLibrary 缺歌单不能当成 PDB 删除。
若数量相同但顺序不对，检查 PDB 页尾 row_presence_flags 和是否覆盖了原解析条目；
不要直接从原始字节全量重建或让 OneLibrary 覆盖 PDB。
```
