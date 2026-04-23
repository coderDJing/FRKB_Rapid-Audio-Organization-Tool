<script setup lang="ts">
import {
  ref,
  shallowRef,
  computed,
  useTemplateRef,
  onMounted,
  onUnmounted,
  watch,
  markRaw,
  nextTick
} from 'vue'
import { type SongsAreaPaneKey, useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/components/horizontalBrowseInteractionTrace'
import { beginHorizontalBrowseDeckInteraction } from '@renderer/components/horizontalBrowseInteractionTimeline'
import { t } from '@renderer/utils/translate'
import { ISongInfo } from '../../../../../types/globals'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { activateSongsAreaPane } from '@renderer/utils/songsAreaSplit'
import type { MoveSongsLibraryName } from '@renderer/pages/modules/songsArea/composables/useSelectAndMoveSongs'

// 组件导入
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import welcomePage from '@renderer/components/welcomePage.vue'
import SongListHeader from './SongListHeader.vue'
import SongListRows from './SongListRows.vue'
import ColumnHeaderContextMenu from './ColumnHeaderContextMenu.vue'

// Composable import
import { useSongItemContextMenu } from '@renderer/pages/modules/songsArea/composables/useSongItemContextMenu'
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
import { useGlobalSearchFocus } from '@renderer/pages/modules/songsArea/composables/useGlobalSearchFocus'
import { useSongsAreaDragAndDrop } from '@renderer/pages/modules/songsArea/composables/useSongsAreaDragAndDrop'
import { detectSongsAreaScrollCarrier } from '@renderer/pages/modules/songsArea/composables/scrollCarrier'

// 资源导入
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'

import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

// 类型定义，便于正确引用 OverlayScrollbarsComponent 实例
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset

const props = withDefaults(
  defineProps<{
    pane: SongsAreaPaneKey
    enablePreviewPlayer?: boolean
  }>(),
  {
    enablePreviewPlayer: false
  }
)

const runtime = useRuntimeStore()
const songsAreaState = runtime.songsAreaPanels.panes[props.pane]
const isPaneActive = computed(() =>
  runtime.songsAreaPanels.splitEnabled ? runtime.songsAreaPanels.activePane === props.pane : true
)
const shouldPersistColumnsToLocalStorage = () => props.pane === 'single' || isPaneActive.value
const activatePaneIfNeeded = () => {
  if (runtime.songsAreaPanels.splitEnabled && runtime.songsAreaPanels.activePane !== props.pane) {
    activateSongsAreaPane(runtime, props.pane)
  }
}
const normalizeLibraryPath = (value: string) => (value || '').replace(/\\/g, '/')
const resolveCoreLibraryNameBySongListUUID = (uuid: string) => {
  const dirPath = normalizeLibraryPath(libraryUtils.findDirPathByUuid(uuid))
  if (dirPath === 'library/FilterLibrary' || dirPath.startsWith('library/FilterLibrary/')) {
    return 'FilterLibrary'
  }
  if (dirPath === 'library/CuratedLibrary' || dirPath.startsWith('library/CuratedLibrary/')) {
    return 'CuratedLibrary'
  }
  if (dirPath === 'library/MixtapeLibrary' || dirPath.startsWith('library/MixtapeLibrary/')) {
    return 'MixtapeLibrary'
  }
  return ''
}
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const isMixtapeListView = computed(
  () => libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'mixtapeList'
)
const getRowKey = (song: ISongInfo) =>
  isMixtapeListView.value && song.mixtapeItemId ? song.mixtapeItemId : song.filePath
const resolveSelectedFilePaths = (keys?: string[]) => {
  const selectedKeys = keys ?? songsAreaState.selectedSongFilePath
  if (!isMixtapeListView.value) return selectedKeys
  const map = new Map<string, string>()
  for (const item of songsAreaState.songInfoArr) {
    if (item.mixtapeItemId) {
      map.set(item.mixtapeItemId, item.filePath)
    }
  }
  return selectedKeys
    .map((key) => map.get(key) || key)
    .filter((p) => typeof p === 'string' && p.length > 0)
}
const songListRootDir = computed(() =>
  isMixtapeListView.value ? '' : libraryUtils.findDirPathByUuid(songsAreaState.songListUUID) || ''
)
// 使用 shallowRef 承载原始列表，避免不必要的深层响应式开销
const originalSongInfoArr = shallowRef<ISongInfo[]>([])

// 父级滚动采样
const { externalScrollTop, externalViewportHeight } = useParentRafSampler({ songsAreaRef })

let detachPaneScrollListener: (() => void) | null = null
const resolvePaneScrollCarrier = () => {
  const scrollElements = songsAreaRef.value?.osInstance()?.elements()
  const explicitViewport = scrollElements?.viewport as HTMLElement | undefined
  const explicitHost = scrollElements?.host as HTMLElement | undefined
  return detectSongsAreaScrollCarrier(
    explicitViewport || explicitHost || null,
    explicitHost || null
  ).carrier
}
const persistPaneScrollPosition = () => {
  const carrier = resolvePaneScrollCarrier()
  if (!carrier) return
  songsAreaState.scrollTop = Math.max(0, Number(carrier.scrollTop || 0))
  songsAreaState.scrollLeft = Math.max(0, Number(carrier.scrollLeft || 0))
}
const restorePaneScrollPosition = () => {
  const carrier = resolvePaneScrollCarrier()
  if (!carrier) return
  const nextTop = Math.max(0, Number(songsAreaState.scrollTop || 0))
  const nextLeft = Math.max(0, Number(songsAreaState.scrollLeft || 0))
  if (Math.abs(carrier.scrollTop - nextTop) > 1) {
    carrier.scrollTop = nextTop
  }
  if (Math.abs(carrier.scrollLeft - nextLeft) > 1) {
    carrier.scrollLeft = nextLeft
  }
}
const bindPaneScrollListener = () => {
  const carrier = resolvePaneScrollCarrier()
  if (!carrier) return
  detachPaneScrollListener?.()
  const handleScroll = () => {
    songsAreaState.scrollTop = Math.max(0, Number(carrier.scrollTop || 0))
    songsAreaState.scrollLeft = Math.max(0, Number(carrier.scrollLeft || 0))
  }
  carrier.addEventListener('scroll', handleScroll, { passive: true })
  detachPaneScrollListener = () => carrier.removeEventListener('scroll', handleScroll)
  handleScroll()
}
const schedulePaneScrollRestore = () => {
  void nextTick().then(() => {
    requestAnimationFrame(() => {
      if (viewState.value !== 'list') return
      bindPaneScrollListener()
      restorePaneScrollPosition()
    })
  })
}

// Initialize composables
const { showAndHandleSongContextMenu } = useSongItemContextMenu(songsAreaRef, songsAreaState)
const {
  isDialogVisible: isSelectSongListDialogVisible,
  targetLibraryName: selectSongListDialogTargetLibraryName,
  dialogActionMode: selectSongListDialogActionMode,
  initiateMoveSongs,
  handleMoveSongsConfirm,
  handleDialogCancel
} = useSelectAndMoveSongs({ songsAreaState })
const { startDragSongs, scheduleDragCleanup, handleDropToSongList } = useDragSongs({
  songsAreaState
})
type PreviewMoveRequestPayload = {
  song?: ISongInfo | null
  sourceLibraryName?: string
  sourceSongListUUID?: string
  sourcePane?: SongsAreaPaneKey
  targetLibraryName?: MoveSongsLibraryName
}
type WaveformPreviewStatePayload = {
  filePath?: string
  active?: boolean
  sourceLibraryName?: string
  sourceSongListUUID?: string
  sourcePane?: SongsAreaPaneKey | ''
}

// 列、筛选、排序与表头交互
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
  applyFiltersAndSorting,
  shouldApplyFiltersAndSortingForSongChange,
  persistColumnData
} = useSongsAreaColumns({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  shouldPersistToLocalStorage: shouldPersistColumnsToLocalStorage
})

// 封面清理
const { scheduleSweepCovers } = useSweepCovers({ runtime, songsAreaState })

// 歌单加载
const { loadingShow, isRequesting, openSongList } = useSongsLoader({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  applyFiltersAndSorting
})

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
  const selectionBeforeReload = [...songsAreaState.selectedSongFilePath]
  await openSongList()
  songsAreaState.selectedSongFilePath = selectionBeforeReload.map(
    (path) => renameMap.get(path) || path
  )
}
emitter.on('metadataBatchUpdated', handleMetadataBatchUpdatedFromEvent)

// 键盘与鼠标选择
const { songClick } = useKeyboardSelection({
  runtime,
  songsAreaState,
  externalViewportHeight,
  scheduleSweepCovers
})

// 自动滚动到当前播放项
const { scrollToIndex, scrollToIndexIfNeeded } = useAutoScrollToCurrent({
  runtime,
  songsAreaState,
  songsAreaRef
})

const {
  dragHintVisible,
  dragHintMode,
  dragHintTitle,
  dragHintDesc,
  paneDropHover,
  paneDropHoverMode,
  clipboardHintVisible,
  clipboardHintText,
  handleClipboardHint,
  handlePaneDragEnter,
  handlePaneDragOver,
  handlePaneDragLeave,
  handlePaneDrop,
  handleSongDragStart,
  handleSongDragEnd,
  handleMixtapeReorder
} = useSongsAreaDragAndDrop({
  songsAreaState,
  originalSongInfoArr,
  isMixtapeListView,
  getRowKey,
  resolveSelectedFilePaths,
  activatePaneIfNeeded,
  resolveCoreLibraryNameBySongListUUID,
  startDragSongs,
  scheduleDragCleanup,
  handleDropToSongList,
  openSongList,
  applyFiltersAndSorting
})

onMounted(() => {
  schedulePaneScrollRestore()
})

// songsArea 相关事件
useSongsAreaEvents({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  applyFiltersAndSorting,
  shouldApplyFiltersAndSortingForSongChange,
  openSongList,
  scheduleSweepCovers
})
if (props.enablePreviewPlayer) {
  useWaveformPreviewPlayer()
}
emitter.on('songsArea/clipboardHint', handleClipboardHint)
const activePreviewFilePath = ref('')
const handleWaveformPreviewState = (payload?: WaveformPreviewStatePayload) => {
  if (
    payload?.active &&
    payload?.sourcePane === props.pane &&
    String(payload?.sourceSongListUUID || '').trim() === songsAreaState.songListUUID &&
    String(payload?.sourceLibraryName || '').trim() === runtime.libraryAreaSelected
  ) {
    activePreviewFilePath.value = String(payload?.filePath || '').trim()
    return
  }
  if (payload?.active) {
    activePreviewFilePath.value = ''
    return
  }
  const payloadFilePath = String(payload?.filePath || '').trim()
  if (!payload?.active && (!payloadFilePath || activePreviewFilePath.value === payloadFilePath)) {
    activePreviewFilePath.value = ''
  }
}
emitter.on('waveform-preview:state', handleWaveformPreviewState)
const handlePreviewMoveRequest = (payload?: PreviewMoveRequestPayload) => {
  const song = payload?.song
  const sourceLibraryName = String(payload?.sourceLibraryName || '').trim()
  const sourceSongListUUID = String(payload?.sourceSongListUUID || '').trim()
  const targetLibraryName = payload?.targetLibraryName
  if (!song?.filePath || !sourceSongListUUID || payload?.sourcePane !== props.pane) return
  if (sourceLibraryName && sourceLibraryName !== runtime.libraryAreaSelected) return
  if (sourceSongListUUID !== songsAreaState.songListUUID) return
  if (
    targetLibraryName !== 'FilterLibrary' &&
    targetLibraryName !== 'CuratedLibrary' &&
    targetLibraryName !== 'MixtapeLibrary'
  ) {
    return
  }
  const rowKey = getRowKey(song)
  const exists = songsAreaState.songInfoArr.some((item) => getRowKey(item) === rowKey)
  if (!exists) return
  activatePaneIfNeeded()
  runtime.activeMenuUUID = ''
  songsAreaState.selectedSongFilePath = [rowKey]
  initiateMoveSongs(targetLibraryName)
}
emitter.on('preview-transfer:open-dialog', handlePreviewMoveRequest)

watch(
  () => isPaneActive.value,
  (active) => {
    if (active && runtime.songsAreaPanels.splitEnabled) {
      persistColumnData()
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  persistPaneScrollPosition()
  detachPaneScrollListener?.()
  detachPaneScrollListener = null
  emitter.off('metadataBatchUpdated', handleMetadataBatchUpdatedFromEvent)
  emitter.off('songsArea/clipboardHint', handleClipboardHint)
  emitter.off('waveform-preview:state', handleWaveformPreviewState)
  emitter.off('preview-transfer:open-dialog', handlePreviewMoveRequest)
  clearGlobalSearchFlashSchedule()
})
// 上述列处理、加载、事件与封面清理均由 composable 提供

// 已移除残留 perfLog

// songClick 宸茬敱 useKeyboardSelection 鎻愪緵

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
  songsAreaState.songInfoArr = songsAreaState.songInfoArr.map((item) => {
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
  songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.map((path) => {
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

  if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
    runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map((item) =>
      item.filePath === oldFilePath || item.filePath === updatedSong.filePath
        ? { ...item, ...updatedSong }
        : item
    )
  }

  if (touchedCurrentList && songsAreaState.songListUUID) {
    try {
      emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
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

  const selectionBeforeReload = [...songsAreaState.selectedSongFilePath]
  await openSongList()
  songsAreaState.selectedSongFilePath = selectionBeforeReload.map((path) =>
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
    // songsRemoved 已由 useSongItemContextMenu 内部通过 emitter 统一处理，避免这里再次删一遍
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
    const selectionBeforeReload = [...songsAreaState.selectedSongFilePath]
    await openSongList()
    songsAreaState.selectedSongFilePath = selectionBeforeReload.map(
      (path) => renameMap.get(path) || path
    )
    return
  }

  if (result.action === 'trackCacheCleared') {
    const selectionBeforeReload = [...songsAreaState.selectedSongFilePath]
    await openSongList()
    songsAreaState.selectedSongFilePath = selectionBeforeReload.filter(Boolean)
    return
  }
}

const requestImmediateAnalysis = (song: ISongInfo) => {
  const filePath = song?.filePath
  if (!filePath) return
  if (runtime.mainWindowBrowseMode === 'horizontal') return
  try {
    window.electron.ipcRenderer.send('key-analysis:queue-playing', {
      filePath,
      focusSlot: 'main-player'
    })
  } catch {}
}

const songDblClick = async (song: ISongInfo, event?: MouseEvent) => {
  if (runtime.songDragSuppressClickUntilMs > Date.now()) return
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  runtime.activeMenuUUID = ''
  songsAreaState.selectedSongFilePath = []

  const normalizedSong = { ...song }
  requestImmediateAnalysis(normalizedSong)
  if (runtime.mainWindowBrowseMode === 'horizontal') {
    const deck = event?.shiftKey ? 'bottom' : 'top'
    beginHorizontalBrowseDeckInteraction(deck, String(normalizedSong.filePath || '').trim())
    sendHorizontalBrowseInteractionTrace('song-dblclick', {
      source: 'songsArea',
      deck,
      filePath: String(normalizedSong.filePath || '').trim()
    })
    emitter.emit('horizontalBrowse/load-song', {
      deck,
      song: normalizedSong
    })
    return
  }
  const isSameList = runtime.playingData.playingSongListUUID === songsAreaState.songListUUID
  const isSameSong =
    isSameList && runtime.playingData.playingSong?.filePath === normalizedSong.filePath

  runtime.playingData.playingSongListUUID = songsAreaState.songListUUID
  runtime.playingData.playingSongListData = songsAreaState.songInfoArr

  if (isSameSong && runtime.playingData.playingSong) {
    runtime.playingData.playingSong = normalizedSong
    emitter.emit('player/replay-current-song')
    return
  }

  runtime.playingData.playingSong = normalizedSong
}

const globalSearchFlashRowKey = ref('')
const globalSearchFlashToken = ref(0)
let globalSearchFlashTimer: ReturnType<typeof setTimeout> | null = null
let globalSearchFlashRafA: number | null = null
let globalSearchFlashRafB: number | null = null
const clearGlobalSearchFlashSchedule = () => {
  if (globalSearchFlashTimer) {
    clearTimeout(globalSearchFlashTimer)
    globalSearchFlashTimer = null
  }
  if (globalSearchFlashRafA !== null) {
    cancelAnimationFrame(globalSearchFlashRafA)
    globalSearchFlashRafA = null
  }
  if (globalSearchFlashRafB !== null) {
    cancelAnimationFrame(globalSearchFlashRafB)
    globalSearchFlashRafB = null
  }
}
const triggerGlobalSearchFlash = (rowKey: string) => {
  if (!rowKey) return
  clearGlobalSearchFlashSchedule()
  globalSearchFlashRowKey.value = ''
  globalSearchFlashToken.value += 1
  const flashToken = globalSearchFlashToken.value
  void nextTick().then(() => {
    globalSearchFlashRafA = requestAnimationFrame(() => {
      globalSearchFlashRafA = null
      globalSearchFlashRafB = requestAnimationFrame(() => {
        globalSearchFlashRafB = null
        if (globalSearchFlashToken.value !== flashToken) return
        globalSearchFlashRowKey.value = rowKey
      })
    })
  })
  globalSearchFlashTimer = setTimeout(() => {
    if (globalSearchFlashToken.value === flashToken && globalSearchFlashRowKey.value === rowKey) {
      globalSearchFlashRowKey.value = ''
    }
    globalSearchFlashTimer = null
  }, 1400)
}

useGlobalSearchFocus({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  columnData,
  applyFiltersAndSorting,
  getRowKey,
  scrollToIndex,
  songDblClick,
  onFocusHit: triggerGlobalSearchFlash
})

// 删除按键处理由 useKeyboardSelection 绑定

// 键盘 Shift 范围选择与快捷键绑定由 useKeyboardSelection 管理

// 排序、筛选与列表头点击等逻辑由 useSongsAreaColumns 提供

// 提供给 SongListRows 的派生状态
const playingSongFilePathForRows = computed(() => {
  const playingSong = runtime.playingData.playingSong
  if (!playingSong) return undefined
  return getRowKey(playingSong)
})
const playingSongFilePathsForRows = computed(() => {
  const keys = new Set<string>()
  const mainRowKey = playingSongFilePathForRows.value
  if (mainRowKey) keys.add(mainRowKey)
  const topDeckSong = runtime.horizontalBrowseDecks.topSong
  if (topDeckSong) keys.add(getRowKey(topDeckSong))
  const bottomDeckSong = runtime.horizontalBrowseDecks.bottomSong
  if (bottomDeckSong) keys.add(getRowKey(bottomDeckSong))
  return [...keys]
})
const harmonicReferenceKeyForRows = computed(() => {
  if (runtime.mainWindowBrowseMode !== 'horizontal') return ''
  const leaderDeck = runtime.horizontalBrowseDecks.leaderDeck
  if (leaderDeck === 'top') {
    return String(runtime.horizontalBrowseDecks.topSong?.key || '').trim()
  }
  if (leaderDeck === 'bottom') {
    return String(runtime.horizontalBrowseDecks.bottomSong?.key || '').trim()
  }
  return ''
})
const currentPlayingRowKey = computed(() => {
  const playingSong = runtime.playingData.playingSong
  if (!playingSong) return ''
  return getRowKey(playingSong)
})

const viewState = computed<'welcome' | 'blank' | 'loading' | 'list'>(() => {
  if (loadingShow.value) return 'loading'
  if (!songsAreaState.songListUUID) {
    return runtime.songsAreaPanels.splitEnabled && props.pane !== 'single' ? 'blank' : 'welcome'
  }
  return 'list'
})

watch(
  () => [viewState.value, songsAreaState.songListUUID] as const,
  ([state]) => {
    if (state !== 'list') {
      persistPaneScrollPosition()
      detachPaneScrollListener?.()
      detachPaneScrollListener = null
      return
    }
    schedulePaneScrollRestore()
  },
  { flush: 'post' }
)

const currentPlayingIndex = computed(() => {
  const rowKey = currentPlayingRowKey.value
  if (!rowKey) return -1
  return songsAreaState.songInfoArr.findIndex((song) => getRowKey(song) === rowKey)
})

const showScrollToPlaying = computed(() => {
  return viewState.value === 'list' && currentPlayingIndex.value >= 0
})

const lastAutoScrollKey = ref('')
const autoScrollPresence = computed(() => (currentPlayingIndex.value >= 0 ? '1' : '0'))
const autoScrollIndexToken = computed(() =>
  currentPlayingIndex.value >= 0 ? String(currentPlayingIndex.value) : 'missing'
)
const autoScrollKey = computed(() => {
  const listUUID = songsAreaState.songListUUID || ''
  return `${listUUID}|${currentPlayingRowKey.value}|${autoScrollPresence.value}|${autoScrollIndexToken.value}`
})
const autoScrollTriggerKey = computed(() => {
  if (!runtime.setting.autoScrollToCurrentSong) return ''
  return autoScrollKey.value
})

watch(
  () => autoScrollTriggerKey.value,
  (key) => {
    if (!key) {
      lastAutoScrollKey.value = ''
      return
    }
    if (currentPlayingIndex.value < 0) return
    if (key === lastAutoScrollKey.value) return
    if (runtime.playingData.playingSongListUUID !== songsAreaState.songListUUID) return
    lastAutoScrollKey.value = key
    scrollToIndexIfNeeded(currentPlayingIndex.value)
  },
  { flush: 'post' }
)

const handleScrollToPlaying = () => {
  if (currentPlayingIndex.value < 0) return
  scrollToIndex(currentPlayingIndex.value)
}

// 父级滚动采样由 useParentRafSampler 提供

// 自动滚动逻辑由 useAutoScrollToCurrent 提供

// 处理移动歌曲对话框确认后的逻辑
async function onMoveSongsDialogConfirmed(targetSongListUuid: string) {
  const pathsEffectivelyMoved = [...songsAreaState.selectedSongFilePath]
  const currentListUuid = songsAreaState.songListUUID
  const sourceActionMode = selectSongListDialogActionMode.value
  const sourceNode = libraryUtils.getLibraryTreeByUUID(currentListUuid)
  const targetNode = libraryUtils.getLibraryTreeByUUID(targetSongListUuid)
  const isMixtapeSource = sourceNode?.type === 'mixtapeList'
  const isMixtapeTarget =
    targetNode?.type === 'mixtapeList' ||
    selectSongListDialogTargetLibraryName.value === 'MixtapeLibrary'

  if (pathsEffectivelyMoved.length === 0) {
    // 无有效移动项时，直接走 composable 默认逻辑
    await handleMoveSongsConfirm(targetSongListUuid)
    return
  }

  const playingListSnapshot = [...runtime.playingData.playingSongListData]
  const currentPlayingSong = runtime.playingData.playingSong
    ? { ...runtime.playingData.playingSong }
    : null
  const resolveNextPlayingSong = (list: ISongInfo[], removedPaths: string[]): ISongInfo | null => {
    if (!currentPlayingSong?.filePath) return null
    const currentIndex = list.findIndex((item) => item.filePath === currentPlayingSong.filePath)
    if (currentIndex === -1) return null
    const normalizedRemovedSet = new Set(
      removedPaths.map((item) => (item || '').replace(/\//g, '\\').toLowerCase())
    )
    if (
      !normalizedRemovedSet.has(
        (currentPlayingSong.filePath || '').replace(/\//g, '\\').toLowerCase()
      )
    ) {
      return null
    }
    const remaining = list.filter(
      (item) => !normalizedRemovedSet.has((item.filePath || '').replace(/\//g, '\\').toLowerCase())
    )
    if (!remaining.length) return null
    return remaining[Math.min(currentIndex, remaining.length - 1)] || null
  }
  const nextPlayingSong =
    sourceActionMode === 'move' && runtime.playingData.playingSongListUUID === currentListUuid
      ? resolveNextPlayingSong(playingListSnapshot, pathsEffectivelyMoved)
      : null

  // 调用 composable 执行移动操作，并处理对话框关闭与选中清理
  await handleMoveSongsConfirm(targetSongListUuid)
  if (
    sourceActionMode === 'move' &&
    activePreviewFilePath.value &&
    pathsEffectivelyMoved.includes(activePreviewFilePath.value)
  ) {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  }
  if (sourceActionMode === 'move' && runtime.playingData.playingSongListUUID === currentListUuid) {
    runtime.playingData.playingSongListData = [...songsAreaState.songInfoArr]
    runtime.playingData.playingSong = nextPlayingSong
  }
  if (
    sourceActionMode === 'copy' ||
    isMixtapeSource ||
    isMixtapeTarget ||
    targetSongListUuid === currentListUuid
  ) {
    return
  }
  // 非 Mixtape 目标时，从当前列表中同步移除已移动项
  if (pathsEffectivelyMoved.length > 0) {
    const normalizePath = (p: string | undefined | null) =>
      (p || '').replace(/\//g, '\\').toLowerCase()
    const movedSet = new Set(pathsEffectivelyMoved.map((p) => normalizePath(p)))
    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (item) => !movedSet.has(normalizePath(item.filePath))
    )
    applyFiltersAndSorting()

    // 若当前播放列表即为当前视图，同步快照（与其他删除路径保持一致）
    if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
      runtime.playingData.playingSongListData = [...songsAreaState.songInfoArr]
    }
  }
}

const shouldShowEmptyState = computed(() => {
  return (
    !isRequesting.value && songsAreaState.songListUUID && songsAreaState.songInfoArr.length === 0
  )
})
// 空状态相关计算
const hasActiveFilter = computed(() => columnData.value.some((c) => !!c.filterActive))
const isRecycleBinView = computed(() => songsAreaState.songListUUID === RECYCLE_BIN_UUID)
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
// 派生状态结束

// 播放列表同步由 useSongsAreaEvents 管理
</script>
<template>
  <div
    class="songs-area-root"
    :class="{
      'is-drop-target': paneDropHover,
      'is-drop-target-external': paneDropHoverMode === 'external'
    }"
    @mousedown.capture="activatePaneIfNeeded"
    @dragenter="handlePaneDragEnter"
    @dragover="handlePaneDragOver"
    @dragleave="handlePaneDragLeave"
    @drop="handlePaneDrop"
  >
    <Transition name="songs-area-switch" mode="out-in">
      <div v-if="viewState === 'welcome'" key="welcome" class="unselectable welcomeContainer">
        <welcomePage />
      </div>

      <div v-else-if="viewState === 'blank'" key="blank" class="songs-area-blank"></div>

      <div v-else-if="viewState === 'loading'" key="loading" class="loading-wrapper">
        <div class="loading"></div>
      </div>

      <div v-else key="list" class="songs-area-shell">
        <OverlayScrollbarsComponent
          ref="songsAreaRef"
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
          @click="songsAreaState.selectedSongFilePath.length = 0"
        >
          <SongListHeader
            :columns="columnData"
            :t="t"
            :ascending-order="ascendingOrder"
            :descending-order="descendingOrder"
            :total-width="totalColumnsWidth"
            @update:columns="handleColumnsUpdate"
            @column-click="colMenuClick"
            @header-contextmenu="contextmenuEvent"
            @drag-start="runtime.dragTableHeader = true"
            @drag-end="runtime.dragTableHeader = false"
          />

          <!-- 使用 SongListRows 组件渲染歌曲列表 -->
          <SongListRows
            v-if="songsAreaState.songInfoArr.length > 0"
            :key="songsAreaState.songListUUID"
            :songs="songsAreaState.songInfoArr"
            :visible-columns="columnDataArr"
            :selected-song-file-paths="songsAreaState.selectedSongFilePath"
            :playing-song-file-path="playingSongFilePathForRows"
            :playing-song-file-paths="playingSongFilePathsForRows"
            :flash-row-key="globalSearchFlashRowKey"
            :flash-row-token="globalSearchFlashToken"
            :harmonic-reference-key="harmonicReferenceKeyForRows"
            :total-width="totalColumnsWidth"
            :source-library-name="runtime.libraryAreaSelected"
            :source-song-list-u-u-i-d="songsAreaState.songListUUID"
            :source-pane-key="props.pane"
            :scroll-host-element="songsAreaRef?.osInstance()?.elements().viewport"
            :external-scroll-top="externalScrollTop"
            :external-viewport-height="externalViewportHeight"
            :song-list-root-dir="songListRootDir"
            :reorder-mode="isMixtapeListView ? 'mixtape' : 'none'"
            @song-click="songClick"
            @song-contextmenu="handleSongContextMenuEvent"
            @song-dblclick="songDblClick"
            @song-dragstart="handleSongDragStart"
            @song-dragend="handleSongDragEnd"
            @mixtape-reorder="handleMixtapeReorder"
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

        <!-- Empty State Overlay: 鐙珛浜庢粴鍔ㄥ唴瀹癸紝濮嬬粓灞呬腑鍦ㄥ彲瑙嗗尯鍩?-->
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
      :target-event="triggeringColContextEvent"
      :columns="columnData"
      :scroll-host-element="songsAreaRef?.osInstance()?.elements().host"
      @toggle-column-visibility="handleToggleColumnVisibility"
    />
    <Teleport to="body">
      <selectSongListDialog
        v-if="isSelectSongListDialogVisible"
        :library-name="selectSongListDialogTargetLibraryName"
        :action-mode="selectSongListDialogActionMode"
        @confirm="onMoveSongsDialogConfirmed"
        @cancel="handleDialogCancel"
      />
    </Teleport>
  </div>
</template>
<style lang="scss" scoped src="./songsArea.scss"></style>
