# 筛选库 / 精选库真实歌曲标号草案

本文档用于细化“筛选库 / 精选库歌单的序号从纯列表序号改成真实歌曲标号，并支持持久化、拖拽重排、按当前排序自动重编号”的需求。

## 1. 背景

当前筛选库、精选库的 `序号` 列本质上只是界面行号：

- 普通歌单行渲染时，优先显示 `mixOrder`，否则直接显示 `item.idx + 1`。
- 筛选库、精选库普通歌单没有真实持久化的序号字段，所以看到的只是“当前列表第几行”。
- 一旦切换排序、重新扫描磁盘、刷新列表，序号含义就会变化。

这和当前项目里另外两套已有行为不一致：

- `Mixtape` 已经有真实的 `mixOrder`，支持拖拽重排并落库。
- `rekordbox 本机库` 已经有“序号升序时允许拖拽、非序号排序时显示表头按钮按当前可见顺序重排”的完整交互。

这次需求的核心不是“把序号列显示得更聪明一点”，而是给筛选库、精选库普通歌单引入一套真实、可持久化、可重排的歌单内编号。

## 2. 目标定义

### 2.1 真实歌曲标号的定义

这里的“真实歌曲标号”定义为：

- 作用域是“单个歌单内部”。
- 是歌单内的持久化顺序号。
- 不是当前 UI 行号。
- 不是音频文件标签里的 `trackNo` / `trackNumber` 元数据。
- 同一首物理文件如果出现在两个歌单里，可以有两个不同的歌单内标号。

建议在实现层避免复用 `trackNo` / `trackNumber` 这两个名字，因为项目里它们已经用于音频元数据和外部源轨道号，语义会打架。建议新概念单独命名，例如：

- `playlistTrackNumber`
- 或 `songListTrackNumber`

本文档后续统一用 `playlistTrackNumber` 指代这个字段。

### 2.2 本期范围

本期只覆盖：

- `FilterLibrary`
- `CuratedLibrary`
- 类型为 `songList` 的普通歌单

本期不改：

- `MixtapeLibrary`
- 外部临时歌单
- 回收站
- Pioneer / Rekordbox 外部来源歌单的数据模型
- 音频文件标签里的 `trackNo`

## 3. 期望交互

### 3.1 序号列显示

筛选库、精选库普通歌单的 `序号` 列改为显示 `playlistTrackNumber`：

- 有值时，显示持久化编号。
- 没值时，不再长期退回“当前行号”冒充真实编号。
- 对老歌单首次迁移时，应补齐编号，避免界面长期混合两种语义。

### 3.2 拖拽重排

交互直接对齐当前 `rekordbox 本机库`：

- 仅在当前排序为 `序号排序` 时允许拖拽重排。
- `序号升序` 和 `序号降序` 都允许拖拽。
- 有活动筛选时不允许拖拽重排。
- 拖拽后立即重写整首歌单的 `playlistTrackNumber`，结果必须连续，从 `1` 开始。
- 在 `序号降序` 视图下，拖拽按当前可见顺序理解，回写时按可见顺序反向映射到真实编号，保证拖完后界面所见即所得。

原因很简单：

- 有筛选时拖拽只看到子集，重排语义容易错。
- 直接复用 `rekordbox` 现有规则，用户认知成本最低。

### 3.3 自动重编号按钮

交互和样式直接对齐当前 `rekordbox 本机库` 的表头按钮：

- 当当前排序列不是 `序号` 时，显示表头按钮。
- 点击后，按照“当前完整可见列表顺序”重写全歌单 `playlistTrackNumber`。
- 重写后，保持当前排序方式不变，不自动跳回 `序号排序`。

建议沿用 `rekordbox` 当前的限制条件：

- 有活动筛选时不显示或不允许点击该按钮。
- 歌单条目数 `<= 1` 时不显示。
- 歌单正在写入/变更中时禁用。

### 3.4 新增 / 删除后的编号行为

建议默认规则：

- 新导入 / 复制 / 移动进歌单的歌曲，默认追加到末尾，编号取当前最大值 `+1`。
- 从歌单移出 / 删除到回收站后，歌单内编号自动收紧，保持连续。
- 不允许留下空洞编号。

也就是说，`自动重编号按钮` 的职责不是“修复空洞”，而是“按当前其他排序结果重写序号”。

## 4. 建议数据模型

### 4.1 字段

建议给普通歌单歌曲引入新字段：

- `playlistTrackNumber?: number`

建议落在 `ISongInfo`，并让以下链路都能携带它：

- 普通歌单扫描结果
- `song_cache.info_json`
- 全局搜索快照 / 快速加载结果
- songsArea 的等价比较 / 差异比较

### 4.2 持久化位置

建议优先复用现有 `song_cache`，按 `list_root + file_path` 维度持久化 `playlistTrackNumber`。

理由：

- 现有 `song_cache` 本来就是“每个歌单根目录下，每首歌的附加状态”存储。
- `key` / `bpm` / 热点 / memory cue 已经走这条链。
- 不需要马上再开一张全新表。

但这里有一个现成的大坑必须补：

- `scanSongs.ts` 在重扫后会调用 `replaceSongCache` 整体回写缓存。
- 当前回写逻辑只显式保留 `key` / `bpm` / `analysisOnly`。
- 如果只是把 `playlistTrackNumber` 塞进 `info_json`，下次重扫时它会被洗掉。

所以如果采用 `song_cache` 方案，必须同时补这几处：

- 扫描命中缓存时，能把 `playlistTrackNumber` 带回内存。
- `replaceSongCache` 前的 merge 逻辑保留 `playlistTrackNumber`。
- `loadSongCacheEntry` / `upsertSongCacheEntry` 的调用方不要误清空它。
- `globalSongSearch` 的 `toSongInfo` 也要把它带上，否则快速加载和全量扫描会不一致。

## 5. 编号写入规则

### 5.1 老歌单首次迁移

第一次打开一个还没有 `playlistTrackNumber` 的老歌单时：

- 以当前磁盘扫描顺序为基准做一次初始化编号。
- 初始化结果写回持久化层。
- 初始化后全歌单编号连续，从 `1` 开始。

这样做虽然不能还原“历史上用户脑补的顺序”，但至少能把现状冻结下来，避免之后每次刷新都变。

### 5.2 新导入 / 复制 / 移动进歌单

写入规则建议统一：

- 目标歌单已有最大号为 `N` 时，新项依次写成 `N + 1`、`N + 2`……
- 多首批量进入时，按实际落盘成功顺序追加。

注意区分两种已有链路：

- `startImportSongs` 导入到歌单
- `moveSongsToDir` / `copySongsToDir` 跨歌单移动或复制

这两条链路都要补编号写入，不能只修一条。

### 5.3 从歌单移出 / 删除 / 回收站恢复

建议规则：

- 从歌单移出或删除后，剩余歌曲自动重新压紧编号。
- 回收站恢复到原歌单时，先追加到末尾，再自动压紧。

这里“恢复到原位置”不是本期默认方案，原因是实现成本明显更高：

- 需要在回收站记录里额外保存删除前编号甚至前后邻居信息。
- 还要处理删除后歌单已发生重排的冲突。

本期已确认不做“恢复回原编号/原位置”，统一恢复到末尾。

### 5.4 同歌单内重命名 / 元数据编辑

如果歌曲还在原歌单里，只是：

- 文件改名
- 元数据改名
- 缓存重建

则 `playlistTrackNumber` 必须保持不变。

### 5.5 跨歌单移动

跨歌单移动时，必须遵守：

- 源歌单删掉该曲目后自动压紧编号。
- 目标歌单给该曲目分配新的末尾编号。
- 不能把源歌单的 `playlistTrackNumber` 原样带到目标歌单。

这里又有一个现成坑：

- 现在 `moveSongsToDir` 在 `isMove` 时会调用 `transferTrackCaches`。
- `transferTrackCaches` 会把源缓存整条搬去目标歌单。

所以如果 `playlistTrackNumber` 落在 `song_cache.info_json`，那跨歌单 move 时必须特殊处理：

- 同歌单内仅路径变化，可以保留原编号。
- 跨歌单根目录移动，必须清掉旧编号并按目标歌单重新分配。

## 6. 排序与状态限制

已确认按下面规则实现：

- 普通歌单 `序号` 列排序时，按 `playlistTrackNumber` 排。
- `playlistTrackNumber` 相同或缺失时，迁移阶段再用文件路径做兜底稳定排序。
- 有筛选时禁止拖拽、禁止“按当前排序自动重编号”。
- 有进行中的导入、移动、批量删除时，禁止拖拽和重编号。
- 分屏模式下只允许操作当前激活 pane 的歌单视图。

## 7. 受影响模块草案

下面这些位置基本都得碰，不碰就是假实现。

### 7.1 Renderer

- `src/types/globals.d.ts`
- `src/renderer/src/pages/modules/songsArea/SongListRows.vue`
- `src/renderer/src/pages/modules/songsArea/SongListHeader.vue`
- `src/renderer/src/pages/modules/songsArea/composables/useSongsAreaColumns.ts`
- `src/renderer/src/pages/modules/songsArea/composables/useSongsLoader.ts`
- `src/renderer/src/pages/modules/songsArea/composables/useSongsAreaDragAndDrop.ts`
- `src/renderer/src/pages/modules/songsArea/songsArea.vue`

### 7.2 Main

- `src/main/services/scanSongs.ts`
- `src/main/libraryCacheDb/songCache.ts`
- `src/main/services/globalSongSearch.ts`
- `src/main/ipc/exportHandlers.ts`
- `src/main/window/mainWindow/importHandlers.ts`
- `src/main/ipc/libraryMaintenanceHandlers.ts`
- `src/main/services/cacheMaintenance.ts`

### 7.3 可复用参考实现

可以直接参考现有 `rekordbox 本机库` 这套逻辑：

- `src/renderer/src/pages/modules/pioneerSongsArea.vue`
- `src/renderer/src/pages/modules/pioneerSongsArea/usePioneerDesktopPlaylistActions.ts`

它已经验证过两件事：

- “序号升序可拖拽” 这套交互成立。
- “非序号排序时显示表头按钮按当前顺序重排” 这套交互成立。

## 8. 推荐实施顺序

建议别一口吃成胖子，按下面顺序做：

1. 先把 `playlistTrackNumber` 跑通读取、显示、持久化、重扫不丢。
2. 再补“新增/删除/移动”后的自动连续编号规则。
3. 再把 songsArea 普通歌单的 `index` 排序改成真实编号排序。
4. 最后再接拖拽重排和表头“按当前排序重编号”按钮。

原因：

- 如果第 1 步不稳，后面拖拽和重排全是白忙。
- 如果第 2 步不做，序号很快就会脏。
- 如果 UI 先上、写入规则没补齐，用户一操作就乱套。

## 9. 已确认决策

- 字段语义与音频文件元数据 `trackNo` / `trackNumber` 完全脱钩。
- 字段命名采用 `playlistTrackNumber`。
- 删除 / 移出 / 跨歌单移动后，源歌单编号自动压紧，始终保持连续。
- 回收站恢复到原歌单时，统一追加到末尾，不恢复原位置。
- 仅在 `序号排序` 且无筛选条件时允许拖拽重排。
- `序号升序` / `序号降序` 都允许拖拽；降序拖拽按当前可见顺序理解并回写。
- 非 `序号排序` 时，允许点击表头按钮按当前完整可见顺序重写真实编号。
- 自动重编号按钮在有筛选条件时禁用。
- 自动重编号后保持当前排序方式不变。
- 新导入 / 复制进歌单 / 跨歌单移动进歌单的歌曲统一追加到末尾。
- 批量移动 / 复制进入目标歌单时，保持源列表当前可见顺序。
- 老歌单首次进入时自动初始化真实编号，并持久化。
- 老歌单初始化基准采用稳定顺序：按歌单内相对路径 / 文件名排序。
- 若编号出现缺号、重号、不连续、部分缺失，打开歌单时自动修复为连续 `1..N`。
- 不提供手动输入单首编号能力，首版不做，后续也不做。
- 导出到 `Rekordbox XML` 或写入 `rekordbox 本机库播放列表` 时，只映射为播放列表顺序，不回写音频文件元数据 `TrackNumber`。
- 写入已有 `rekordbox 本机库` 播放列表时，统一追加到末尾。
- 老歌单首次自动建立真实编号时，给一次性轻提示，不弹确认框。

## 10. 结论

这个需求真正要做的是“给普通歌单补一套类似 playlist entry order 的持久化顺序系统”，而不是单纯改个序号列。

如果按本文档收口，第一版的定义已经够落开发了：

- 有独立字段
- 有持久化位置
- 有初始化迁移规则
- 有新增/删除/移动后的自动连续规则
- 有和 `rekordbox` 对齐的拖拽/重编号交互
- 也把当前实现里最容易踩爆的缓存覆盖点、跨歌单移动点提前标出来了

后续如果你拍板上面第 9 节的推荐项，我下一步就可以把它进一步拆成开发任务清单和改动顺序。
