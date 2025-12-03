<script setup lang="ts">
import { ref, shallowRef, computed, useTemplateRef, onUnmounted } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import { ISongInfo, ISongsAreaColumn } from '../../../../../types/globals'

// 组件导入
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import welcomePage from '@renderer/components/welcomePage.vue'
import SongListHeader from './SongListHeader.vue'
import SongListRows from './SongListRows.vue'
import ColumnHeaderContextMenu from './ColumnHeaderContextMenu.vue'

// Composable import
import {
  useSongItemContextMenu,
  type MetadataUpdatedAction,
  type PlaylistCacheClearedAction,
  type TrackCacheClearedAction
} from '@renderer/pages/modules/songsArea/composables/useSongItemContextMenu'
import { useSelectAndMoveSongs } from '@renderer/pages/modules/songsArea/composables/useSelectAndMoveSongs'
import { useDragSongs } from '@renderer/pages/modules/songsArea/composables/useDragSongs'
import { useSongsAreaColumns } from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import { useSongsLoader } from '@renderer/pages/modules/songsArea/composables/useSongsLoader'
import { useSweepCovers } from '@renderer/pages/modules/songsArea/composables/useSweepCovers'
import { useKeyboardSelection } from '@renderer/pages/modules/songsArea/composables/useKeyboardSelection'
import { useAutoScrollToCurrent } from '@renderer/pages/modules/songsArea/composables/useAutoScrollToCurrent'
import { useParentRafSampler } from '@renderer/pages/modules/songsArea/composables/useParentRafSampler'
import { useSongsAreaEvents } from '@renderer/pages/modules/songsArea/composables/useSongsAreaEvents'

// 资源导入
import ascendingOrder from '@renderer/assets/ascending-order.png?asset'
import descendingOrder from '@renderer/assets/descending-order.png?asset'

import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

// 类型定义，以便正确引用 OverlayScrollbarsComponent 实例
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

const runtime = useRuntimeStore()
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
// 使用浅响应+markRaw，避免为上千行数据创建深层 Proxy，降低 flushJobs 峰值
const originalSongInfoArr = shallowRef<ISongInfo[]>([])

// 父级滚动采样
const { externalScrollTop, externalViewportHeight } = useParentRafSampler({ songsAreaRef })

// Initialize composables
const { showAndHandleSongContextMenu } = useSongItemContextMenu(songsAreaRef)
const {
  isDialogVisible: isSelectSongListDialogVisible,
  targetLibraryName: selectSongListDialogTargetLibraryName,
  initiateMoveSongs,
  handleMoveSongsConfirm,
  handleDialogCancel
} = useSelectAndMoveSongs()
const { isDragging, startDragSongs, endDragSongs, handleDropToSongList } = useDragSongs()

// 集中列、筛选、排序与列头交互逻辑
const {
  columnData,
  columnDataArr,
  totalColumnsWidth,
  colRightClickMenuShow,
  triggeringColContextEvent,
  contextmenuEvent,
  handleToggleColumnVisibility,
  handleColumnsUpdate,
  colMenuClick,
  applyFiltersAndSorting
} = useSongsAreaColumns({ runtime, originalSongInfoArr })

// 封面清理
const { scheduleSweepCovers } = useSweepCovers({ runtime })

// 歌曲加载与渐进渲染
const { loadingShow, isRequesting, openSongList } = useSongsLoader({
  runtime,
  originalSongInfoArr,
  applyFiltersAndSorting
})

const handlePlaylistCacheCleared = async (payload: { uuid?: string }) => {
  if (!payload || payload.uuid !== runtime.songsArea.songListUUID) return
  const selectionBeforeReload = [...runtime.songsArea.selectedSongFilePath]
  await openSongList()
  runtime.songsArea.selectedSongFilePath = selectionBeforeReload.filter(Boolean)
}
emitter.on('playlistCacheCleared', handlePlaylistCacheCleared)

const handleMetadataBatchUpdatedFromEvent = async (payload: {
  updates?: Array<{ song: ISongInfo; oldFilePath?: string }>
}) => {
  const updates = Array.isArray(payload?.updates) ? payload.updates : []
  if (!updates.length) return
  const renameMap = new Map<string, string>()
  let touchedCurrentList = false
  for (const update of updates) {
    if (!update?.song) continue
    const oldPath = update.oldFilePath ?? update.song.filePath
    renameMap.set(oldPath, update.song.filePath)
    const didTouch = await applyMetadataUpdate(update.song, update.oldFilePath, {
      rescan: false
    })
    if (didTouch) touchedCurrentList = true
  }
  if (!touchedCurrentList) return
  const selectionBeforeReload = [...runtime.songsArea.selectedSongFilePath]
  await openSongList()
  runtime.songsArea.selectedSongFilePath = selectionBeforeReload.map(
    (path) => renameMap.get(path) || path
  )
}
emitter.on('metadataBatchUpdated', handleMetadataBatchUpdatedFromEvent)

// 键盘与鼠标选择
const { songClick } = useKeyboardSelection({
  runtime,
  externalViewportHeight,
  scheduleSweepCovers
})

// 自动滚动到当前播放
useAutoScrollToCurrent({ runtime, songsAreaRef })

// 事件订阅与同步
useSongsAreaEvents({
  runtime,
  originalSongInfoArr,
  applyFiltersAndSorting,
  openSongList,
  scheduleSweepCovers
})

onUnmounted(() => {
  emitter.off('playlistCacheCleared', handlePlaylistCacheCleared)
  emitter.off('metadataBatchUpdated', handleMetadataBatchUpdatedFromEvent)
})
// 上述列、加载、事件与封面清理已由组合函数提供

// 移除残留的 perfLog

// songClick 已由 useKeyboardSelection 提供

const applyMetadataUpdate = async (
  updatedSong: ISongInfo | undefined,
  incomingOldFilePath?: string,
  options?: { rescan?: boolean }
) => {
  if (!updatedSong) return false
  const oldFilePath = incomingOldFilePath ?? updatedSong.filePath
  let touchedCurrentList = false
  const arr = [...originalSongInfoArr.value]
  let idx = arr.findIndex((item) => item.filePath === oldFilePath)
  if (idx === -1) idx = arr.findIndex((item) => item.filePath === updatedSong.filePath)
  if (idx !== -1) {
    arr.splice(idx, 1, updatedSong)
    originalSongInfoArr.value = arr
    applyFiltersAndSorting()
    touchedCurrentList = true
  }

  let runtimeListTouched = false
  runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.map((item) => {
    if (item.filePath === oldFilePath) {
      runtimeListTouched = true
      return { ...updatedSong }
    }
    if (item.filePath === updatedSong.filePath) {
      runtimeListTouched = true
      return { ...item, ...updatedSong }
    }
    return item
  })
  if (runtimeListTouched) touchedCurrentList = true

  let selectionTouched = false
  runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.map((path) => {
    if (path === oldFilePath) {
      selectionTouched = true
      return updatedSong.filePath
    }
    return path
  })
  if (selectionTouched) touchedCurrentList = true

  if (
    runtime.playingData.playingSong &&
    (runtime.playingData.playingSong.filePath === updatedSong.filePath ||
      runtime.playingData.playingSong.filePath === oldFilePath)
  ) {
    runtime.playingData.playingSong = {
      ...runtime.playingData.playingSong,
      ...updatedSong
    }
    runtime.playingData.playingSong.filePath = updatedSong.filePath
  }

  if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
    runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map((item) =>
      item.filePath === oldFilePath || item.filePath === updatedSong.filePath
        ? { ...item, ...updatedSong }
        : item
    )
  }

  if (touchedCurrentList && runtime.songsArea.songListUUID) {
    try {
      emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
    } catch {}
  }
  try {
    emitter.emit('songMetadataUpdated', {
      filePath: updatedSong.filePath,
      oldFilePath
    })
  } catch {}

  if (touchedCurrentList) {
    scheduleSweepCovers()
  }

  if (options?.rescan === false || !touchedCurrentList) return touchedCurrentList

  const selectionBeforeReload = [...runtime.songsArea.selectedSongFilePath]
  await openSongList()
  runtime.songsArea.selectedSongFilePath = selectionBeforeReload.map((path) =>
    path === oldFilePath ? updatedSong.filePath : path
  )
  return touchedCurrentList
}

const handleSongContextMenuEvent = async (event: MouseEvent, song: ISongInfo) => {
  const result = await showAndHandleSongContextMenu(event, song)
  if (!result) return

  if (result.action === 'openSelectSongListDialog') {
    initiateMoveSongs(result.libraryName)
    return
  }

  if (result.action === 'songsRemoved') {
    const pathsToRemove = result.paths

    if (Array.isArray(pathsToRemove) && pathsToRemove.length > 0) {
      originalSongInfoArr.value = originalSongInfoArr.value.filter(
        (item) => !pathsToRemove.includes(item.filePath)
      )

      applyFiltersAndSorting()

      if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
        runtime.playingData.playingSongListData = [...runtime.songsArea.songInfoArr]
      }
      if (
        runtime.playingData.playingSong &&
        pathsToRemove.includes(runtime.playingData.playingSong.filePath)
      ) {
        runtime.playingData.playingSong = null
      }

      runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
        (path) => !pathsToRemove.includes(path)
      )
    }
    return
  }

  if (result.action === 'metadataUpdated') {
    await applyMetadataUpdate(result.song, result.oldFilePath)
    return
  }

  if (result.action === 'metadataBatchUpdated') {
    const updates = Array.isArray(result.updates) ? result.updates : []
    if (!updates.length) return
    const renameMap = new Map<string, string>()
    let touchedCurrentList = false
    for (const update of updates) {
      if (!update?.song) continue
      const oldPath = update.oldFilePath ?? update.song.filePath
      renameMap.set(oldPath, update.song.filePath)
      const didTouch = await applyMetadataUpdate(update.song, update.oldFilePath, {
        rescan: false
      })
      if (didTouch) touchedCurrentList = true
    }
    if (!touchedCurrentList) return
    const selectionBeforeReload = [...runtime.songsArea.selectedSongFilePath]
    await openSongList()
    runtime.songsArea.selectedSongFilePath = selectionBeforeReload.map(
      (path) => renameMap.get(path) || path
    )
    return
  }

  if (result.action === 'trackCacheCleared') {
    const selectionBeforeReload = [...runtime.songsArea.selectedSongFilePath]
    await openSongList()
    runtime.songsArea.selectedSongFilePath = selectionBeforeReload.filter(Boolean)
    return
  }

  if (result.action === 'playlistCacheCleared') {
    const selectionBeforeReload = [...runtime.songsArea.selectedSongFilePath]
    await openSongList()
    runtime.songsArea.selectedSongFilePath = selectionBeforeReload.filter(Boolean)
    return
  }
}

const songDblClick = async (song: ISongInfo) => {
  runtime.activeMenuUUID = ''
  runtime.songsArea.selectedSongFilePath = []

  const normalizedSong = { ...song }
  const isSameList = runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID
  const isSameSong =
    isSameList && runtime.playingData.playingSong?.filePath === normalizedSong.filePath

  runtime.playingData.playingSongListUUID = runtime.songsArea.songListUUID
  runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr

  if (isSameSong && runtime.playingData.playingSong) {
    runtime.playingData.playingSong = normalizedSong
    emitter.emit('player/replay-current-song')
    return
  }

  runtime.playingData.playingSong = normalizedSong
}

// 删除键处理由 useKeyboardSelection 绑定

// 键盘 Shift 范围选择与快捷键绑定由 useKeyboardSelection 管理

// 排序、筛选与列点击等逻辑由 useSongsAreaColumns 提供

// --- 新增计算属性给 SongListRows ---
const playingSongFilePathForRows = computed(() => runtime.playingData.playingSong?.filePath)

// 父级采样由 useParentRafSampler 提供

// 自动滚动逻辑由 useAutoScrollToCurrent 提供

// 新增：处理移动歌曲对话框确认后的逻辑
async function onMoveSongsDialogConfirmed(targetSongListUuid: string) {
  const pathsEffectivelyMoved = [...runtime.songsArea.selectedSongFilePath]

  if (pathsEffectivelyMoved.length === 0) {
    // 如果没有选中的歌曲，让 composable 的 handleMoveSongsConfirm 处理（它可能会直接关闭对话框或不做任何事）
    await handleMoveSongsConfirm(targetSongListUuid)
    return
  }

  // 调用 composable 中的函数来执行移动操作 (IPC, 关闭对话框, 清空选择等)
  // handleMoveSongsConfirm 应该会处理 isDialogVisible 和 selectedSongFilePath
  await handleMoveSongsConfirm(targetSongListUuid)
  // 本地同步移除：基于移动前的路径快照，立即从 original 中剔除并统一重建，避免偶发事件竞态导致“复活”
  if (pathsEffectivelyMoved.length > 0) {
    const normalizePath = (p: string | undefined | null) =>
      (p || '').replace(/\//g, '\\').toLowerCase()
    const movedSet = new Set(pathsEffectivelyMoved.map((p) => normalizePath(p)))
    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (item) => !movedSet.has(normalizePath(item.filePath))
    )
    applyFiltersAndSorting()

    // 若当前播放列表即为当前视图，同步快照（与其他删除路径保持一致）
    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = [...runtime.songsArea.songInfoArr]
      if (
        runtime.playingData.playingSong &&
        pathsEffectivelyMoved.includes(runtime.playingData.playingSong.filePath)
      ) {
        runtime.playingData.playingSong = null
      }
    }
  }
}

const shouldShowEmptyState = computed(() => {
  return (
    !isRequesting.value &&
    runtime.songsArea.songListUUID &&
    runtime.songsArea.songInfoArr.length === 0
  )
})
// 是否存在任意激活的筛选条件
const hasActiveFilter = computed(() => columnData.value.some((c) => !!c.filterActive))
// --- END 新增计算属性 ---

// 拖拽相关函数
const handleSongDragStart = (event: DragEvent, song: ISongInfo) => {
  if (!runtime.songsArea.songListUUID) return

  // 确保拖拽的歌曲在选中列表中
  const isSelected = runtime.songsArea.selectedSongFilePath.includes(song.filePath)

  if (!isSelected || runtime.songsArea.selectedSongFilePath.length === 0) {
    // 如果这首歌没有被选中，或者没有选中任何歌曲，就选中这首歌
    runtime.songsArea.selectedSongFilePath = [song.filePath]
  }

  startDragSongs(song, runtime.libraryAreaSelected, runtime.songsArea.songListUUID)

  // 设置拖拽数据
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(
      'application/x-song-drag',
      JSON.stringify({
        type: 'song',
        sourceLibraryName: runtime.libraryAreaSelected,
        sourceSongListUUID: runtime.songsArea.songListUUID
      })
    )
  }
}

const handleSongDragEnd = (event: DragEvent) => {
  endDragSongs()
}

// 播放列表同步由 useSongsAreaEvents 管理
</script>
<template>
  <div style="width: 100%; height: 100%; min-width: 0; overflow: hidden; position: relative">
    <div
      v-show="!loadingShow && !runtime.songsArea.songListUUID"
      class="unselectable welcomeContainer"
    >
      <welcomePage />
    </div>
    <div
      v-show="loadingShow"
      style="width: 100%; height: 100%; display: flex; justify-content: center; align-items: center"
    >
      <div class="loading"></div>
    </div>

    <OverlayScrollbarsComponent
      v-if="runtime.songsArea.songListUUID && !loadingShow"
      :options="{
        scrollbars: {
          autoHide: 'leave' as const,
          autoHideDelay: 50,
          clickScroll: true
        } as const,
        overflow: {
          x: 'scroll',
          y: 'scroll'
        } as const
      }"
      element="div"
      style="height: 100%; width: 100%; position: relative"
      defer
      ref="songsAreaRef"
      @click="runtime.songsArea.selectedSongFilePath.length = 0"
    >
      <SongListHeader
        :columns="columnData"
        :t="t"
        :ascendingOrder="ascendingOrder"
        :descendingOrder="descendingOrder"
        :total-width="totalColumnsWidth"
        @update:columns="handleColumnsUpdate"
        @column-click="colMenuClick"
        @header-contextmenu="contextmenuEvent"
        @drag-start="runtime.dragTableHeader = true"
        @drag-end="runtime.dragTableHeader = false"
      />

      <!-- 使用 SongListRows 组件渲染歌曲列表 -->
      <SongListRows
        v-if="runtime.songsArea.songInfoArr.length > 0"
        :songs="runtime.songsArea.songInfoArr"
        :visibleColumns="columnDataArr"
        :selectedSongFilePaths="runtime.songsArea.selectedSongFilePath"
        :playingSongFilePath="playingSongFilePathForRows"
        :total-width="totalColumnsWidth"
        :sourceLibraryName="runtime.libraryAreaSelected"
        :sourceSongListUUID="runtime.songsArea.songListUUID"
        :scroll-host-element="songsAreaRef?.osInstance()?.elements().viewport"
        :external-scroll-top="externalScrollTop"
        :external-viewport-height="externalViewportHeight"
        :song-list-root-dir="libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID) || ''"
        @song-click="songClick"
        @song-contextmenu="handleSongContextMenuEvent"
        @song-dblclick="songDblClick"
        @song-dragstart="handleSongDragStart"
        @song-dragend="handleSongDragEnd"
      />
    </OverlayScrollbarsComponent>

    <!-- Empty State Overlay: 独立于滚动内容，始终居中在可视区域 -->
    <div v-if="shouldShowEmptyState && !loadingShow" class="songs-area-empty-overlay unselectable">
      <div class="empty-box">
        <div class="title">
          {{ hasActiveFilter ? t('filters.noResults') : t('tracks.noTracks') }}
        </div>
        <div class="hint">
          {{ hasActiveFilter ? t('filters.noResultsHint') : t('tracks.noTracksHint') }}
        </div>
      </div>
    </div>

    <ColumnHeaderContextMenu
      v-model="colRightClickMenuShow"
      :targetEvent="triggeringColContextEvent"
      :columns="columnData"
      :scrollHostElement="songsAreaRef?.osInstance()?.elements().host"
      @toggle-column-visibility="handleToggleColumnVisibility"
    />
    <Teleport to="body">
      <selectSongListDialog
        v-if="isSelectSongListDialogVisible"
        :libraryName="selectSongListDialogTargetLibraryName"
        @confirm="onMoveSongsDialogConfirmed"
        @cancel="handleDialogCancel"
      />
    </Teleport>
  </div>
</template>
<style lang="scss" scoped>
.loading {
  display: block;
  position: relative;
  width: 6px;
  height: 10px;

  animation: rectangle infinite 1s ease-in-out -0.2s;

  background-color: #cccccc;
}

.loading:before,
.loading:after {
  position: absolute;
  width: 6px;
  height: 10px;
  content: '';
  background-color: #cccccc;
}

.loading:before {
  left: -14px;

  animation: rectangle infinite 1s ease-in-out -0.4s;
}

.loading:after {
  right: -14px;

  animation: rectangle infinite 1s ease-in-out;
}

@keyframes rectangle {
  0%,
  80%,
  100% {
    height: 20px;
    box-shadow: 0 0 #cccccc;
  }

  40% {
    height: 30px;
    box-shadow: 0 -20px #cccccc;
  }
}

.welcomeContainer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  min-width: 430px;
}

/* 为新的空状态容器添加一个类名，以便将来可能需要的特定样式 */
.songs-area-empty-state {
  /* Styles for empty state are mostly inline, but class is good for targeting */
  &.unselectable {
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
  }
}

/* 新的空态覆盖层，固定在可视区域中央，不受横向滚动影响 */
.songs-area-empty-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.songs-area-empty-overlay .empty-box {
  min-height: 120px;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.songs-area-empty-overlay .title {
  font-size: 16px;
  color: #999999;
}
.songs-area-empty-overlay .hint {
  font-size: 12px;
  color: #999999;
  margin-top: 10px;
}
</style>
