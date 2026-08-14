# Pioneer Device Library U 盘歌单一致性维护手册

状态：持续维护

适用范围：Rekordbox 导出的 Pioneer Device Library U 盘，尤其是同时存在 `export.pdb` 与 `exportLibrary.db` 的设备。

遇到 U 盘歌单消失、缺曲、错序或标题错位时，先按本文取证。不要直接改 UI、覆盖 PDB 条目，或把 OneLibrary 当成唯一真相。

## 1. 数据源优先级

| 数据源 | 用途 | 约束 |
| --- | --- | --- |
| `PIONEER/rekordbox/export.pdb` | Device Library 树、歌单、曲目和顺序 | 当前主数据；PDB 可解析时，OneLibrary 缺歌单不代表该歌单已删除 |
| `exportLibrary.db` | OneLibrary 补充 | 只有歌单 ID、非空名称、已有条目 `entryIndex`、`trackId` 和可用路径严格一致且条目更多时才补全 |
| Rekordbox 设备库页面 | 用户可见真值 | 必须核对数量、至少一个中间位置和尾部位置，不能只看数量 |

Device Library 当前链路先读 PDB，再由 `reconcileDeviceLibraryPlaylistTracks()` 严格补全。`OneLibraryPlaylistNotFoundError` 只表示两套库不同步，不能丢弃已读出的 PDB 歌单。

## 2. PDB 页尾恢复硬条件

部分真实导出 PDB 的页头索引不完整，但 `PlaylistEntries` 页尾仍有有效条目。恢复只能在以下条件全部满足时进行：

1. 只扫描真正的 `PlaylistEntries` 页；
2. 只接受 `row_presence_flags` 标记存在、位于已使用数据区并可完整读取的条目；
3. `playlistId` 必须为目标歌单，`entryIndex` 和 `trackId` 必须为正数；
4. 每个 `trackId` 都能在 PDB 曲目表解析出元数据；
5. 最终索引连续为 `1..N`，且恢复后曲目数严格增加；
6. 已由解析器返回的 `entryIndex -> trackId` 永远是锚点，不能被页尾的历史记录覆盖。

补缺规则：锚点最大索引前只补缺口；最大索引后只能从最后一个已知条目的同曲目物理位置向后连续补齐。出现无效候选或缺口立即停止，不能跨越拼接。任一条件不满足时保留原始解析结果，禁止从原始字节猜曲目。

## 3. 已关闭回归案例

| 日期 | 歌单 | Rekordbox 参照 | 已验证结果 |
| --- | --- | --- | --- |
| 2026-08-05 | `playlistId=121`，`无标题列表 (3)` | 18 首 | 页尾恢复连续 `1..18`；OneLibrary 没有该歌单 |
| 2026-08-06 | `playlistId=116`，`未完Set/abyss` | 当时 24 首 | 恢复 `1..24`；第 5 首 `Afar`、第 6 首 `DHEA`、第 24 首 `The Quick` |
| 2026-08-06 | `playlistId=115`，根目录 `8.2` | 32 首 | 恢复 `1..32`；首首 `Liquid Feat. Fran`、第 4 首 `Shooting Stars`、尾首 `Euphoria` |

这些只作回归案例。再次导出后必须重新记录当前 `export.pdb` 的时间戳、SHA-256 和 Rekordbox 页面，不能用旧数量或旧顺序判断新现场。

## 4. 现场流程

1. 记录 U 盘根目录、导出时间、歌单路径/`playlistId`、Rekordbox 数量和首/中/尾标题；只读记录 `export.pdb` 的 `LastWriteTime` 与 SHA-256。
2. 不写入 U 盘；同时保留 `export.pdb`、可选 `exportLibrary.db` 与 `exportExt.pdb` 的现场状态。
3. 用当前原生模块直接读取 PDB：

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

4. 数量不符或索引不连续时，回到页尾恢复条件；数量相同但标题不对时，检查是否覆盖了 PDB 锚点。首、中、尾都与 Rekordbox 相同后，再进入 FRKB 页面复核。

开发模式读仓库根目录 `log.txt`。只有原生结果与页面仍不一致时，才运行 `node "scripts/dump-pioneer-device-library-debug.cjs"` 采集一次快照；不保留常驻诊断日志。

## 5. 修改与关闭门槛

改动 PDB 恢复或 OneLibrary 对账后，至少运行：

```powershell
cd rust_package
cargo test playlist_entry_recovery_tests
corepack yarn build
cd ..
npx vue-tsc --noEmit
pnpm run build
```

真实 U 盘验收必须同时满足：总数一致、`entryIndex` 连续、首/中/尾的 `trackId` 与标题一致、重启 FRKB 后仍一致。单个案例关闭后保留台账；新现场新增一行，并以当前导出证据为准。
