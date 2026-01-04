# 数据迁移总览（SQLite + UI 设置）

状态：启用中

目标
- 将库级数据迁移到库根目录下的 SQLite，便于整体迁移。
- UI-only 设置只放 localStorage（仅渲染层）。
- 迁移后清理旧版落盘文件。
- 标记升级后的库与旧版 FRKB 不兼容。

存储布局
- SQLite 文件：`<库根>/FRKB.database.sqlite`
- 清单文件：`<库根>/FRKB.database.frkbdb`（含 `minAppVersion`）

SQLite Schema（v3）
- meta：迁移标记与库级设置。
- fingerprints：指纹列表（`pcm` / `file`）。
- song_cache：扫描缓存（按歌单根目录）。
- cover_index：封面索引（按歌单根目录）。
- library_nodes：库结构树。

迁移后数据源规则
- 库结构：`library_nodes`
- 指纹库：`fingerprints`
- 扫描缓存：`song_cache`
- 封面索引：`cover_index`（封面图片文件仍存 `.frkb_covers`）
- 库级设置：meta 键
  - `library_setting_fingerprint_mode`
  - `library_setting_audio_ext`
  - `library_setting_persist_song_filters`
- 全局设置：`settingConfig.json`（剔除 UI-only）
- UI-only 设置：localStorage（见 `src/shared/uiSettings.ts`）

旧库识别
- `looksLikeLegacyStructure`（manifest 辅助）：
  - 存在 `library/.description.json`，或
  - 存在 `songFingerprint/`，或
  - 存在 `library/`
- 迁移计划会检查：
  - `.description.json` -> 库结构迁移
  - `songFingerprint*` -> 指纹迁移
  - `.songs.cache.json` / `.frkb_covers/.index.json` -> 缓存迁移
  - SQLite meta 的 in-progress 标记

用户提示
- 发现旧库或 in-progress 会弹窗确认：
  - i18n key：`migration.legacyTitle`、`migration.legacyRequired`、
    `migration.legacyActions`、`migration.legacyConfirm`、`migration.legacyExit`
- 取消则退出，避免半迁移状态。

迁移流程（启动期）
1) 写入 manifest；设置 `minAppVersion`（旧版不可用）。
2) 需要迁移时弹窗确认。
3) 设置 meta 标记：
   - `legacy_migration_in_progress_v1`
   - `library_tree_migration_in_progress_v1`（如需库结构迁移）
4) 同步库级设置（`syncLibrarySettingsFromDb`）。
5) 指纹：读取旧文件 -> 写入 SQLite -> 删除旧目录。
6) 库结构：读取旧 `.description.json` -> 写入 `library_nodes`。
7) 归档 `.description.json` -> `.description.json.legacy`（一次性）。
8) 缓存迁移到 SQLite。
9) 清理旧文件。
10) 标记迁移完成：
    - `legacy_migration_done_v1`
    - `legacy_migration_in_progress_v1 = 0`
    - `library_tree_migration_done_v1`

旧文件清理
- 删除：
  - `.description.json` 与 `.description.json.legacy`
  - `.songs.cache.json`
  - `.frkb_covers/.index.json`
  - `songFingerprint/` 目录及旧文件
- 无 `.frkb_legacy` 备份；数据已入库。

运行期一致性（库结构）
- watcher：`fs.watch(libraryRoot, { recursive: true })`
- 同步：`syncLibraryTreeFromDisk`
  - 以磁盘为准增删改。
  - 写入 `.frkb.uuid` 保持重命名后 UUID 不变。
  - 核心库目录被删会自动重建。

缓存策略
- 迁移后仅使用 SQLite，不再回退旧文件。
- SQLite 不可用时：
  - 缓存读写直接跳过。
  - 扫描会走全量解析，不依赖缓存。

UI-only 设置迁移
- UI-only keys 见 `src/shared/uiSettings.ts`：
  - `hiddenPlayControlArea`, `waveformStyle`, `waveformMode`,
    `autoPlayNextSong`, `startPlayPercent`, `endPlayPercent`,
    `fastForwardTime`, `fastBackwardTime`, `enablePlaybackRange`,
    `autoScrollToCurrentSong`, `audioOutputDeviceId`,
    `showPlaylistTrackCount`, `recentDialogSelectedSongListMaxCount`,
    `songListBubbleAlways`
- 仅主窗口渲染层执行迁移/清理。
- 所有写入 `settingConfig.json` 的入口统一剔除 UI-only。

关键文件（索引）
- SQLite 核心：`src/main/libraryDb.ts`
- 迁移编排：`src/main/libraryMigration.ts`
- 库结构 + watcher：`src/main/libraryTreeDb.ts`、`src/main/libraryTreeWatcher.ts`
- 缓存 DB：`src/main/libraryCacheDb.ts`
- 指纹：`src/main/fingerprintStore.ts`
- 缓存使用：`src/main/services/scanSongs.ts`、`src/main/services/cacheMaintenance.ts`、
  `src/main/services/covers.ts`
- Manifest + 最低版本：`src/main/databaseManifest.ts`
- 库级设置：`src/main/librarySettingsDb.ts`
- UI-only 设置：`src/shared/uiSettings.ts`、`src/renderer/src/utils/uiSettingsStorage.ts`
- 设置持久化入口：`src/main/settingsPersistence.ts`
