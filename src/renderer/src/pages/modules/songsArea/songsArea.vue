<script setup lang="ts">
import { ref, shallowRef, computed, useTemplateRef, onUnmounted, watch } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import { ISongInfo, ISongsAreaColumn } from '../../../../../types/globals'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'

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
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'

// 资源导入
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'

import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

// 类型定义，以便正确引用 OverlayScrollbarsComponent 实例
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset

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
const { startDragSongs, scheduleDragCleanup, handleDropToSongList } = useDragSongs()
const dragHintVisible = ref(false)
const dragHintMode = ref<'internal' | 'external'>('internal')
let dragHintCleanup: (() => void) | null = null
const clipboardHintVisible = ref(false)
const clipboardHintText = ref('')
let clipboardHintTimer: ReturnType<typeof setTimeout> | null = null
const isAltPressed = ref(false)
const isCtrlPressed = ref(false)
let modifierKeyCleanup: (() => void) | null = null
const hideDragHint = () => {
  dragHintVisible.value = false
  if (dragHintCleanup) {
    dragHintCleanup()
    dragHintCleanup = null
  }
}
const attachDragHintListeners = () => {
  if (dragHintCleanup) return
  const onMouseUp = () => hideDragHint()
  const onDragEnd = () => hideDragHint()
  const onBlur = () => hideDragHint()
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('dragend', onDragEnd)
  window.addEventListener('blur', onBlur)
  dragHintCleanup = () => {
    window.removeEventListener('mouseup', onMouseUp)
    window.removeEventListener('dragend', onDragEnd)
    window.removeEventListener('blur', onBlur)
  }
}
const showDragHint = (mode: 'internal' | 'external') => {
  if (mode === 'external') {
    hideDragHint()
    return
  }
  dragHintMode.value = mode
  dragHintVisible.value = true
  attachDragHintListeners()
}
const showClipboardHint = (message: string) => {
  clipboardHintText.value = message
  clipboardHintVisible.value = true
  if (clipboardHintTimer) {
    clearTimeout(clipboardHintTimer)
  }
  clipboardHintTimer = setTimeout(() => {
    clipboardHintVisible.value = false
  }, 2000)
}
const handleClipboardHint = (payload?: { action?: 'copy' | 'cut' }) => {
  const action = payload?.action
  if (action === 'cut') {
    showClipboardHint(t('tracks.clipboardCutSuccess'))
    return
  }
  if (action === 'copy') {
    showClipboardHint(t('tracks.clipboardCopySuccess'))
  }
}
const attachModifierKeyListeners = () => {
  if (modifierKeyCleanup) return
  const updateModifierState = (event: KeyboardEvent) => {
    isAltPressed.value = event.altKey
    isCtrlPressed.value = event.ctrlKey
  }
  const onKeyDown = (event: KeyboardEvent) => {
    updateModifierState(event)
  }
  const onKeyUp = (event: KeyboardEvent) => {
    updateModifierState(event)
  }
  const onBlur = () => {
    isAltPressed.value = false
    isCtrlPressed.value = false
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  modifierKeyCleanup = () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
  }
}

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

// 手动滚动到当前播放
const { scrollToIndex } = useAutoScrollToCurrent({ runtime, songsAreaRef })
attachModifierKeyListeners()

// 事件订阅与同步
useSongsAreaEvents({
  runtime,
  originalSongInfoArr,
  applyFiltersAndSorting,
  openSongList,
  scheduleSweepCovers
})
useWaveformPreviewPlayer()
emitter.on('songsArea/clipboardHint', handleClipboardHint)

onUnmounted(() => {
  emitter.off('playlistCacheCleared', handlePlaylistCacheCleared)
  emitter.off('metadataBatchUpdated', handleMetadataBatchUpdatedFromEvent)
  emitter.off('songsArea/clipboardHint', handleClipboardHint)
  hideDragHint()
  if (clipboardHintTimer) {
    clearTimeout(clipboardHintTimer)
    clipboardHintTimer = null
  }
  if (modifierKeyCleanup) {
    modifierKeyCleanup()
    modifierKeyCleanup = null
  }
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
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
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

const viewState = computed<'welcome' | 'loading' | 'list'>(() => {
  if (loadingShow.value) return 'loading'
  if (!runtime.songsArea.songListUUID) return 'welcome'
  return 'list'
})

const currentPlayingIndex = computed(() => {
  const currentPath = runtime.playingData.playingSong?.filePath
  if (!currentPath) return -1
  return runtime.songsArea.songInfoArr.findIndex((song) => song.filePath === currentPath)
})

const showScrollToPlaying = computed(() => {
  return viewState.value === 'list' && currentPlayingIndex.value >= 0
})

const scrollToCurrentIfNeeded = () => {
  if (!runtime.setting.autoScrollToCurrentSong) return
  if (!runtime.playingData.playingSong?.filePath) return
  if (runtime.playingData.playingSongListUUID !== runtime.songsArea.songListUUID) return
  if (currentPlayingIndex.value < 0) return
  scrollToIndex(currentPlayingIndex.value)
}

watch(
  () => [
    runtime.setting.autoScrollToCurrentSong,
    runtime.playingData.playingSong?.filePath,
    runtime.playingData.playingSongListUUID,
    runtime.songsArea.songListUUID,
    runtime.songsArea.songInfoArr.length
  ],
  () => {
    scrollToCurrentIfNeeded()
  },
  { flush: 'post' }
)

const handleScrollToPlaying = () => {
  if (currentPlayingIndex.value < 0) return
  scrollToIndex(currentPlayingIndex.value)
}

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
const isRecycleBinView = computed(() => runtime.songsArea.songListUUID === RECYCLE_BIN_UUID)
const emptyTitleText = computed(() => {
  if (hasActiveFilter.value) return t('filters.noResults')
  if (isRecycleBinView.value) return t('recycleBin.noDeletionRecords')
  return t('tracks.noTracks')
})
const emptyHintText = computed(() => {
  if (hasActiveFilter.value) return t('filters.noResultsHint')
  if (isRecycleBinView.value) return ''
  return t('tracks.noTracksHint')
})
const isMacPlatform = computed(() => runtime.setting.platform === 'darwin')
const dragHintModifier = computed(() => {
  return isMacPlatform.value ? t('tracks.dragHintModifierOption') : t('tracks.dragHintModifierCtrl')
})
const dragHintTarget = computed(() => {
  return isMacPlatform.value ? t('tracks.dragHintTargetFinder') : t('tracks.dragHintTargetExplorer')
})
const dragHintTitle = computed(() => {
  return dragHintMode.value === 'external'
    ? t('tracks.dragHintExternalTitle')
    : t('tracks.dragHintInternalTitle')
})
const dragHintDesc = computed(() => {
  return dragHintMode.value === 'external'
    ? t('tracks.dragHintExternalSub', { target: dragHintTarget.value })
    : t('tracks.dragHintInternalSub', {
        modifier: dragHintModifier.value,
        target: dragHintTarget.value
      })
})
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

  const songFilePaths = runtime.songsArea.selectedSongFilePath.length
    ? [...runtime.songsArea.selectedSongFilePath]
    : [song.filePath]

  const hasExternalModifier = isMacPlatform.value
    ? event.altKey ||
      isAltPressed.value ||
      (typeof event.getModifierState === 'function' && event.getModifierState('Alt'))
    : event.ctrlKey ||
      isCtrlPressed.value ||
      (typeof event.getModifierState === 'function' && event.getModifierState('Control'))

  if (hasExternalModifier) {
    showDragHint('external')
    console.info('[external-drag] request', {
      fileCount: songFilePaths.length,
      sample: songFilePaths[0] || '',
      platform: runtime.setting.platform
    })
    event.preventDefault()
    window.electron.ipcRenderer.sendSync('startExternalSongDrag', {
      filePaths: songFilePaths
    })
    return
  }

  showDragHint('internal')
  startDragSongs(song, runtime.libraryAreaSelected, runtime.songsArea.songListUUID)

  // 设置拖拽数据以支持内部拖放
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copyMove'
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

const handleSongDragEnd = () => {
  hideDragHint()
  scheduleDragCleanup()
}

// 播放列表同步由 useSongsAreaEvents 管理
</script>
<template>
  <div class="songs-area-root">
    <Transition name="songs-area-switch" mode="out-in">
      <div v-if="viewState === 'welcome'" key="welcome" class="unselectable welcomeContainer">
        <welcomePage />
      </div>

      <div v-else-if="viewState === 'loading'" key="loading" class="loading-wrapper">
        <div class="loading"></div>
      </div>

      <div v-else key="list" class="songs-area-shell">
        <OverlayScrollbarsComponent
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
            :key="runtime.songsArea.songListUUID"
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
            :song-list-root-dir="
              libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID) || ''
            "
            @song-click="songClick"
            @song-contextmenu="handleSongContextMenuEvent"
            @song-dblclick="songDblClick"
            @song-dragstart="handleSongDragStart"
            @song-dragend="handleSongDragEnd"
          />
        </OverlayScrollbarsComponent>

        <button
          v-if="showScrollToPlaying"
          class="songs-area-float-jump"
          type="button"
          title="Scroll to playing"
          @click.stop="handleScrollToPlaying"
        >
          <span class="songs-area-float-jump__icon" aria-hidden="true"></span>
        </button>

        <Transition name="songs-area-drag-hint">
          <div
            v-if="dragHintVisible"
            class="songs-area-drag-hint"
            :class="{ 'is-external': dragHintMode === 'external' }"
          >
            <div class="title">{{ dragHintTitle }}</div>
            <div class="desc">{{ dragHintDesc }}</div>
          </div>
        </Transition>
        <Transition name="songs-area-drag-hint">
          <div v-if="clipboardHintVisible" class="songs-area-drag-hint songs-area-clipboard-hint">
            <div class="title">{{ clipboardHintText }}</div>
          </div>
        </Transition>

        <!-- Empty State Overlay: 独立于滚动内容，始终居中在可视区域 -->
        <div v-if="shouldShowEmptyState" class="songs-area-empty-overlay unselectable">
          <div class="empty-box">
            <div class="title">
              {{ emptyTitleText }}
            </div>
            <div class="hint">
              {{ emptyHintText }}
            </div>
          </div>
        </div>
      </div>
    </Transition>

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
.songs-area-root {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
}

.songs-area-shell {
  position: relative;
  width: 100%;
  height: 100%;
}

.songs-area-float-jump {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  opacity: 0.65;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 6;
  cursor: pointer;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18);
}

.songs-area-float-jump:hover {
  opacity: 0.95;
  transform: translateY(-1px);
}

.songs-area-float-jump:active {
  transform: translateY(0);
}

.songs-area-float-jump:focus-visible {
  outline: 2px solid rgba(0, 120, 212, 0.6);
  outline-offset: 2px;
}

.songs-area-float-jump__icon {
  position: relative;
  width: 14px;
  height: 14px;
}

.songs-area-float-jump__icon::before,
.songs-area-float-jump__icon::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
}

.songs-area-float-jump__icon::before {
  width: 2px;
  height: 12px;
  left: 6px;
  top: 1px;
  background: var(--text);
  border-radius: 1px;
  opacity: 0.85;
}

.songs-area-float-jump__icon::after {
  width: 6px;
  height: 6px;
  left: 4px;
  top: 4px;
  background: var(--text);
  border-radius: 50%;
  opacity: 0.9;
}

.songs-area-drag-hint {
  position: absolute;
  right: 20px;
  bottom: 20px;
  min-width: 168px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  z-index: 7;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
}

.songs-area-drag-hint.is-external {
  border-color: var(--accent);
  box-shadow:
    0 0 0 1px rgba(0, 120, 212, 0.35),
    0 6px 16px rgba(0, 0, 0, 0.2);
}

.songs-area-drag-hint .title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.songs-area-drag-hint .desc {
  font-size: 11px;
  color: var(--text-weak);
}

.songs-area-clipboard-hint .title {
  font-size: 12px;
  font-weight: 600;
}

.songs-area-drag-hint-enter-active,
.songs-area-drag-hint-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.songs-area-drag-hint-enter-from,
.songs-area-drag-hint-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}

.loading-wrapper {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: 100%;
}

.songs-area-switch-enter-active,
.songs-area-switch-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;
}

.songs-area-switch-enter-from,
.songs-area-switch-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.995);
}

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
