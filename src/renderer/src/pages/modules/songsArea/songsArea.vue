<script setup lang="ts">
import {
  ref,
  shallowRef,
  computed,
  useTemplateRef,
  onMounted,
  onUnmounted,
  watch,
  nextTick
} from 'vue'
import { type SongsAreaPaneKey, useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/components/horizontalBrowseInteractionTrace'
import { beginHorizontalBrowseDeckInteraction } from '@renderer/components/horizontalBrowseInteractionTimeline'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import { ISongInfo } from '../../../../../types/globals'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { activateSongsAreaPane } from '@renderer/utils/songsAreaSplit'
import type { MoveSongsLibraryName } from '@renderer/pages/modules/songsArea/composables/useSelectAndMoveSongs'
import { usePlaylistAnalysisPrompt } from '@renderer/pages/modules/songsArea/composables/usePlaylistAnalysisPrompt'
import { useSongsAreaEmptyState } from '@renderer/pages/modules/songsArea/composables/useSongsAreaEmptyState'

import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import welcomePage from '@renderer/components/welcomePage.vue'
import SongListHeader from './SongListHeader.vue'
import SongListRows from './SongListRows.vue'
import ColumnHeaderContextMenu from './ColumnHeaderContextMenu.vue'
import PlaylistAnalysisFloatingButton from './PlaylistAnalysisFloatingButton.vue'

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
import { usePlaylistTrackNumbers } from '@renderer/pages/modules/songsArea/composables/usePlaylistTrackNumbers'
import { detectSongsAreaScrollCarrier } from '@renderer/pages/modules/songsArea/composables/scrollCarrier'

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
  if (dirPath === 'library/SetLibrary' || dirPath.startsWith('library/SetLibrary/')) {
    return 'SetLibrary'
  }
  if (dirPath === 'library/MixtapeLibrary' || dirPath.startsWith('library/MixtapeLibrary/')) {
    return 'MixtapeLibrary'
  }
  return ''
}
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const handleOverlayClick = (e: MouseEvent) => {
  if (e.button === 0) {
    runtime.focusArea = 'songsArea'
    songsAreaState.selectedSongFilePath.length = 0
    // 清空歌单列表选中状态
    runtime.selectedPlaylistIds = []
  }
}
const isMixtapeListView = computed(
  () => libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'mixtapeList'
)
const isSetListView = computed(
  () => libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'setList'
)
const getRowKey = (song: ISongInfo) =>
  isMixtapeListView.value && song.mixtapeItemId
    ? song.mixtapeItemId
    : isSetListView.value && song.setItemId
      ? song.setItemId
      : song.filePath
const resolveSelectedFilePaths = (keys?: string[]) => {
  const selectedKeys = keys ?? songsAreaState.selectedSongFilePath
  if (!isMixtapeListView.value && !isSetListView.value) return selectedKeys
  const map = new Map<string, string>()
  for (const item of songsAreaState.songInfoArr) {
    if (item.mixtapeItemId) {
      map.set(item.mixtapeItemId, item.filePath)
    }
    if (item.setItemId) {
      map.set(item.setItemId, item.filePath)
    }
  }
  return selectedKeys
    .map((key) => map.get(key) || key)
    .filter((p) => typeof p === 'string' && p.length > 0)
}
const songListRootDir = computed(() =>
  songsAreaState.songListUUID === RECORDING_LIBRARY_UUID
    ? 'library/RecordingLibrary'
    : isMixtapeListView.value
      ? ''
      : libraryUtils.findDirPathByUuid(songsAreaState.songListUUID) || ''
)
// 使用 shallowRef 承载原始列表，避免不必要的深层响应式开销
const originalSongInfoArr = shallowRef<ISongInfo[]>([])

// 切换歌单离开动画期间保留旧数据，避免动画播放空内容
const leaveData = shallowRef<ISongInfo[] | null>(null)
const displaySongs = computed(() => leaveData.value ?? songsAreaState.songInfoArr)
const handleListLeave = (el: Element, done: () => void) => {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    leaveData.value = null
    done()
  }
  el.addEventListener(
    'transitionend',
    (e) => {
      if (e.target === el) finish()
    },
    { once: true }
  )
  setTimeout(finish, 200)
}

// 父级滚动采样
const {
  externalScrollTop,
  externalViewportHeight,
  syncMetrics: syncParentScrollMetrics
} = useParentRafSampler({ songsAreaRef })

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
const { showAndHandleSongContextMenu } = useSongItemContextMenu(
  songsAreaRef,
  songsAreaState,
  syncParentScrollMetrics
)
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

const {
  songListAutoAnalyzeEnabled,
  playlistAnalysisActionVisible,
  playlistAnalysisActionPending,
  handleUserOpenedSongList,
  analyzeDismissedPlaylist
} = usePlaylistAnalysisPrompt({
  runtime,
  songsAreaState,
  isMixtapeListView
})
const {
  trackNumberMutationPending,
  canReorderPlaylistTracks,
  canRenumberPlaylistTracks,
  handlePlaylistReorder,
  handleRenumberTracksByVisibleOrder
} = usePlaylistTrackNumbers({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  columnData,
  isRequesting,
  applyFiltersAndSorting,
  resolveCoreLibraryNameBySongListUUID
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
const { songClick, cancelPendingRepeatSingleClickDeselect, cancelPendingShiftSelect } =
  useKeyboardSelection({
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

// 切换歌单时快照旧数据，用于离开动画期间保持渲染；同时重置滚动位置
watch(
  () => songsAreaState.songListUUID,
  (_newUUID, _oldUUID) => {
    if (_oldUUID && songsAreaState.songInfoArr.length > 0) {
      leaveData.value = [...songsAreaState.songInfoArr]
    }
    songsAreaState.scrollTop = 0
    songsAreaState.scrollLeft = 0
  }
)

const activePreviewFilePath = ref('')

// songsArea 相关事件
useSongsAreaEvents({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  applyFiltersAndSorting,
  shouldApplyFiltersAndSortingForSongChange,
  openSongList,
  scheduleSweepCovers,
  activeWaveformPreviewFilePath: activePreviewFilePath,
  onUserOpenedSongList: handleUserOpenedSongList
})
if (props.enablePreviewPlayer) {
  useWaveformPreviewPlayer()
}
emitter.on('songsArea/clipboardHint', handleClipboardHint)
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
    arr.splice(idx, 1, { ...arr[idx], ...updatedSong })
    originalSongInfoArr.value = arr
    applyFiltersAndSorting()
    touchedCurrentList = true
  }

  let runtimeListTouched = false
  songsAreaState.songInfoArr = songsAreaState.songInfoArr.map((item) => {
    if (item.filePath === oldFilePath) {
      runtimeListTouched = true
      return { ...item, ...updatedSong }
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
  cancelPendingRepeatSingleClickDeselect()
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
}

const requestImmediateAnalysis = (song: ISongInfo) => {
  const filePath = song?.filePath
  if (!filePath) return
  if (runtime.mainWindowBrowseMode !== 'browser') return
  try {
    window.electron.ipcRenderer.send('key-analysis:queue-playing', {
      filePath,
      focusSlot: 'main-player'
    })
  } catch {}
}

const songDblClick = async (song: ISongInfo, event?: MouseEvent) => {
  cancelPendingRepeatSingleClickDeselect()
  cancelPendingShiftSelect()
  if (runtime.songDragSuppressClickUntilMs > Date.now()) return
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  runtime.activeMenuUUID = ''
  songsAreaState.selectedSongFilePath = []

  const normalizedSong = { ...song }
  requestImmediateAnalysis(normalizedSong)
  if (runtime.mainWindowBrowseMode !== 'browser') {
    const deck =
      runtime.mainWindowBrowseMode === 'edit' ? 'top' : event?.shiftKey ? 'bottom' : 'top'
    const sourceSongListData = songsAreaState.songInfoArr.map((item) => ({ ...item }))
    runtime.playingData.playingSongListUUID = songsAreaState.songListUUID
    runtime.playingData.playingSongListData = sourceSongListData
    beginHorizontalBrowseDeckInteraction(deck, String(normalizedSong.filePath || '').trim())
    sendHorizontalBrowseInteractionTrace('song-dblclick', {
      source: 'songsArea',
      deck,
      filePath: String(normalizedSong.filePath || '').trim()
    })
    emitter.emit('horizontalBrowse/load-song', {
      deck,
      song: normalizedSong,
      sourceSongListUUID: songsAreaState.songListUUID,
      sourceSongListData
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
  if (runtime.mainWindowBrowseMode === 'browser') return ''
  if (runtime.mainWindowBrowseMode === 'edit') {
    return String(runtime.horizontalBrowseDecks.topSong?.key || '').trim()
  }
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
  if (runtime.mainWindowBrowseMode === 'edit') {
    const topDeckSong = runtime.horizontalBrowseDecks.topSong
    if (topDeckSong) return getRowKey(topDeckSong)
  }
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
  const isSetTarget =
    targetNode?.type === 'setList' || selectSongListDialogTargetLibraryName.value === 'SetLibrary'
  const removesFromSource =
    sourceActionMode === 'move' &&
    !isMixtapeSource &&
    !isMixtapeTarget &&
    !isSetTarget &&
    targetSongListUuid !== currentListUuid

  if (pathsEffectivelyMoved.length === 0) {
    // 无有效移动项时，直接走 composable 默认逻辑
    await handleMoveSongsConfirm(targetSongListUuid)
    return
  }

  const playingListSnapshot = [...runtime.playingData.playingSongListData]
  const currentPlayingSong = runtime.playingData.playingSong
    ? { ...runtime.playingData.playingSong }
    : null
  const normalizeMovedPath = (p: string | undefined | null) =>
    (p || '').replace(/\//g, '\\').toLowerCase()
  const movedPathSet = new Set(pathsEffectivelyMoved.map((p) => normalizeMovedPath(p)))
  const currentPlayingWillBeRemoved =
    removesFromSource &&
    runtime.playingData.playingSongListUUID === currentListUuid &&
    !!currentPlayingSong?.filePath &&
    movedPathSet.has(normalizeMovedPath(currentPlayingSong.filePath))
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
  const nextPlayingSong = currentPlayingWillBeRemoved
    ? resolveNextPlayingSong(playingListSnapshot, pathsEffectivelyMoved)
    : null

  await handleMoveSongsConfirm(targetSongListUuid, {
    preservePlaybackForRemovedPaths:
      currentPlayingWillBeRemoved && Boolean(nextPlayingSong?.filePath),
    resumeMainPlayerAfterPreviewStop: !currentPlayingWillBeRemoved
  })
  if (removesFromSource && runtime.playingData.playingSongListUUID === currentListUuid) {
    runtime.playingData.playingSongListData = [...songsAreaState.songInfoArr]
    if (currentPlayingWillBeRemoved) {
      runtime.playingData.playingSong = nextPlayingSong
    }
  }
  if (!removesFromSource) {
    return
  }
  if (pathsEffectivelyMoved.length > 0) {
    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (item) => !movedPathSet.has(normalizeMovedPath(item.filePath))
    )
    applyFiltersAndSorting()

    if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
      runtime.playingData.playingSongListData = [...songsAreaState.songInfoArr]
    }
  }
}

const { shouldShowEmptyState, emptyTitleText, emptyHintText } = useSongsAreaEmptyState({
  isRequesting,
  songsAreaState,
  columnData
})

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
          @click="handleOverlayClick"
        >
          <SongListHeader
            :columns="columnData"
            :t="t"
            :ascending-order="ascendingOrder"
            :descending-order="descendingOrder"
            :total-width="totalColumnsWidth"
            :show-index-action="canRenumberPlaylistTracks"
            :index-action-title="t('tracks.renumberPlaylistTrackNumbersAction')"
            :index-action-disabled="trackNumberMutationPending || isRequesting"
            @update:columns="handleColumnsUpdate"
            @column-click="colMenuClick"
            @header-contextmenu="contextmenuEvent"
            @drag-start="runtime.dragTableHeader = true"
            @drag-end="runtime.dragTableHeader = false"
            @index-action-click="handleRenumberTracksByVisibleOrder"
          />

          <!-- 使用 SongListRows 组件渲染歌曲列表 -->
          <Transition name="songs-area-list-switch" mode="out-in" @leave="handleListLeave">
            <div :key="songsAreaState.songListUUID" class="songs-area-list-viewport">
              <Transition name="songs-area-list-switch">
                <SongListRows
                  v-if="displaySongs.length > 0"
                  :songs="displaySongs"
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
                  :enable-key-analysis-queue="songListAutoAnalyzeEnabled"
                  :scroll-host-element="songsAreaRef?.osInstance()?.elements().viewport"
                  :external-scroll-top="externalScrollTop"
                  :external-viewport-height="externalViewportHeight"
                  :song-list-root-dir="songListRootDir"
                  :reorder-mode="
                    isMixtapeListView ? 'mixtape' : canReorderPlaylistTracks ? 'playlist' : 'none'
                  "
                  @song-click="songClick"
                  @song-contextmenu="handleSongContextMenuEvent"
                  @song-dblclick="songDblClick"
                  @song-dragstart="handleSongDragStart"
                  @song-dragend="handleSongDragEnd"
                  @mixtape-reorder="handleMixtapeReorder"
                  @playlist-reorder="handlePlaylistReorder"
                />
              </Transition>
            </div>
          </Transition>
        </OverlayScrollbarsComponent>

        <PlaylistAnalysisFloatingButton
          v-if="playlistAnalysisActionVisible"
          :pending="playlistAnalysisActionPending"
          :with-jump="showScrollToPlaying"
          @analyze="analyzeDismissedPlaylist"
        />

        <bubbleBoxTrigger
          v-if="showScrollToPlaying"
          tag="button"
          class="songs-area-float-jump"
          type="button"
          title="Scroll to playing"
          @click.stop="handleScrollToPlaying"
        >
          <span class="songs-area-float-jump__icon" aria-hidden="true"></span>
        </bubbleBoxTrigger>

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
