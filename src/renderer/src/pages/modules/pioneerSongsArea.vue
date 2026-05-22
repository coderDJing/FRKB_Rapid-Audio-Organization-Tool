<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch, useTemplateRef } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import SongListHeader from '@renderer/pages/modules/songsArea/SongListHeader.vue'
import SongListRows from '@renderer/pages/modules/songsArea/SongListRows.vue'
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'
import rightClickMenu from '@renderer/components/rightClickMenu'
import exportDialog from '@renderer/components/exportDialog'
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import RekordboxDesktopWritingOverlay from '@renderer/components/RekordboxDesktopWritingOverlay.vue'
import emitter from '@renderer/utils/mitt'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/components/horizontalBrowseInteractionTrace'
import { beginHorizontalBrowseDeckInteraction } from '@renderer/components/horizontalBrowseInteractionTimeline'
import { t } from '@renderer/utils/translate'
import libraryUtils from '@renderer/utils/libraryUtils'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { normalizeBpmDisplayScaled } from '@renderer/utils/bpm'
import { copySongCueDefinitionsToTargets } from '@renderer/utils/songCueTransfer'
import { openRekordboxDesktopPlaylistForSelectedTracks } from '@renderer/utils/rekordboxDesktopPlaylist'
import {
  buildNeteaseSearchQuery,
  normalizeNeteaseSearchText,
  openNeteaseSearch
} from '@renderer/utils/neteaseSearch'
import {
  buildRekordboxSourceCacheKey,
  getCachedRekordboxPlaylistTracks,
  rememberRekordboxSourceSelectedPlaylist,
  setCachedRekordboxPlaylistTracks,
  shouldRefreshRekordboxPlaylistTracks
} from '@renderer/utils/rekordboxLibraryCache'
import { buildSongsAreaDefaultColumns } from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'
import { useKeyboardSelection } from '@renderer/pages/modules/songsArea/composables/useKeyboardSelection'
import type { ISongsAreaPaneRuntimeState } from '@renderer/stores/runtime'
import { getKeyDisplayText, getKeySortText } from '@shared/keyDisplay'
import { useParentRafSampler } from '@renderer/pages/modules/songsArea/composables/useParentRafSampler'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import { usePioneerDesktopPlaylistActions } from './pioneerSongsArea/usePioneerDesktopPlaylistActions'
import { usePioneerExternalPlaylistAnalysis } from './pioneerSongsArea/usePioneerExternalPlaylistAnalysis'
import { usePioneerSongDrag } from './pioneerSongsArea/usePioneerSongDrag'
import type { RekordboxSourceKind } from '@shared/rekordboxSources'
import type {
  IMenu,
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode,
  IRekordboxSourceKind,
  ISongInfo,
  ISongsAreaColumn
} from '../../../../types/globals'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
type PioneerTransferTarget = 'CuratedLibrary' | 'FilterLibrary' | 'MixtapeLibrary'

const runtime = useRuntimeStore()
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const handleOverlayClick = (e: MouseEvent) => {
  if (e.button === 0) selectedRowKeys.value = []
}
const originalTracks = shallowRef<IPioneerPlaylistTrack[]>([])
const visibleSongs = ref<ISongInfo[]>([])
const loading = ref(false)
const selectedRowKeys = ref<string[]>([])
const lastLoggedSnapshot = ref('')
const columnData = ref<ISongsAreaColumn[]>(
  buildSongsAreaDefaultColumns('default').map((column) =>
    column.key === 'index' ? { ...column, width: Math.max(column.width, 74) } : column
  )
)
const selectSongListDialogVisible = ref(false)
const selectSongListDialogTargetLibraryName = ref<PioneerTransferTarget | ''>('')
const selectSongListDialogTrackKeys = ref<string[]>([])
let playlistTracksRequestToken = 0

const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset
const { externalScrollTop, externalViewportHeight } = useParentRafSampler({ songsAreaRef })
useWaveformPreviewPlayer()

const pioneerSongsAreaState = {
  get songListUUID() {
    return currentPlaybackListKey?.value || ''
  },
  get songInfoArr() {
    return visibleSongs.value
  },
  get totalSongCount() {
    return visibleSongs.value.length
  },
  get selectedSongFilePath() {
    return selectedRowKeys.value
  },
  set selectedSongFilePath(v: string[]) {
    selectedRowKeys.value = v
  },
  get scrollTop() {
    return 0
  },
  set scrollTop(value: number) {
    void value
  },
  get scrollLeft() {
    return 0
  },
  set scrollLeft(value: number) {
    void value
  },
  columnCacheByMode: {}
} as unknown as ISongsAreaPaneRuntimeState
const { songClick, cancelPendingRepeatSingleClickDeselect } = useKeyboardSelection({
  runtime,
  songsAreaState: pioneerSongsAreaState,
  externalViewportHeight,
  readOnly: true
})
const selectedRowKeysForTemplate = computed(() => [...selectedRowKeys.value])

const selectedSourceKey = computed(() => runtime.pioneerDeviceLibrary.selectedSourceKey || '')
const selectedSourceKind = computed<IRekordboxSourceKind | ''>(
  () => runtime.pioneerDeviceLibrary.selectedSourceKind || ''
)
const isDesktopSource = computed(() => selectedSourceKind.value === 'desktop')
const selectedSourceName = computed(() => {
  if (runtime.pioneerDeviceLibrary.selectedSourceName) {
    return runtime.pioneerDeviceLibrary.selectedSourceName
  }
  return isDesktopSource.value ? 'Rekordbox 本机库' : 'Pioneer USB'
})
const selectedPlaylistId = computed(() => runtime.pioneerDeviceLibrary.selectedPlaylistId || 0)
const selectedSourceRootPath = computed(
  () => runtime.pioneerDeviceLibrary.selectedSourceRootPath || ''
)
const selectedLibraryType = computed(
  () => runtime.pioneerDeviceLibrary.selectedLibraryType || 'deviceLibrary'
)

const selectedPlaylistNode = computed(() => {
  const targetId = selectedPlaylistId.value
  if (!targetId) return null
  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode | null => {
    for (const item of items) {
      if (item.id === targetId) return item
      if (Array.isArray(item.children) && item.children.length > 0) {
        const found = walk(item.children)
        if (found) return found
      }
    }
    return null
  }
  return walk(runtime.pioneerDeviceLibrary.treeNodes || [])
})
const currentPlaybackListKey = computed(() => {
  if (!selectedPlaylistId.value) return ''
  const sourceKey = selectedSourceKey.value || selectedSourceRootPath.value || 'rekordbox'
  const sourceKind = selectedSourceKind.value || 'usb'
  return `${sourceKind}:${sourceKey}:${selectedPlaylistId.value}`
})
const selectedSourceCacheKey = computed(() =>
  buildRekordboxSourceCacheKey({
    sourceKind: selectedSourceKind.value,
    sourceKey: selectedSourceKey.value,
    rootPath: selectedSourceRootPath.value,
    libraryType: selectedLibraryType.value
  })
)

const visibleColumns = computed(() => columnData.value.filter((item) => item.show))
const totalWidth = computed(() =>
  visibleColumns.value.reduce((sum, col) => sum + Number(col.width || 0), 0)
)
const playingSongFilePathForRows = computed(() => {
  if (!currentPlaybackListKey.value) return undefined
  if (runtime.playingData.playingSongListUUID !== currentPlaybackListKey.value) return undefined
  const playingSong = runtime.playingData.playingSong
  return playingSong?.mixtapeItemId || playingSong?.filePath || undefined
})
const playingSongFilePathsForRows = computed(() => {
  const keys = new Set<string>()
  const mainRowKey = playingSongFilePathForRows.value
  if (mainRowKey) keys.add(mainRowKey)
  const topDeckSong = runtime.horizontalBrowseDecks.topSong
  if (topDeckSong) {
    const key = String(topDeckSong.mixtapeItemId || topDeckSong.filePath || '').trim()
    if (key) keys.add(key)
  }
  const bottomDeckSong = runtime.horizontalBrowseDecks.bottomSong
  if (bottomDeckSong) {
    const key = String(bottomDeckSong.mixtapeItemId || bottomDeckSong.filePath || '').trim()
    if (key) keys.add(key)
  }
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
const originPathSnapshot = computed(() => {
  const driveLabel = selectedSourceName.value || 'Pioneer USB'
  const playlistLabel = selectedPlaylistNode.value?.name || ''
  return playlistLabel ? `${driveLabel} / ${playlistLabel}` : driveLabel
})

const emitPioneerSongsAreaLog = (_event: string, _payload?: Record<string, unknown>) => {}

const getSongField = (song: ISongInfo, key: string): unknown => song[key as keyof ISongInfo]

const canRemoveTracksFromDesktopPlaylist = computed(
  () =>
    isDesktopSource.value &&
    Boolean(selectedPlaylistNode.value) &&
    !selectedPlaylistNode.value?.isFolder &&
    !selectedPlaylistNode.value?.isSmartPlaylist
)
const hasActiveTrackFilters = computed(() =>
  columnData.value.some((col) => Boolean(col.filterActive))
)
const sortedTrackColumn = computed(() => columnData.value.find((col) => Boolean(col.order)) || null)
const canReorderDesktopTracks = computed(
  () =>
    canRemoveTracksFromDesktopPlaylist.value &&
    !loading.value &&
    !playlistMutationPending.value &&
    !hasActiveTrackFilters.value &&
    (!sortedTrackColumn.value ||
      (sortedTrackColumn.value.key === 'index' && sortedTrackColumn.value.order === 'asc'))
)
const canRenumberDesktopTracks = computed(
  () =>
    canRemoveTracksFromDesktopPlaylist.value &&
    !loading.value &&
    !playlistMutationPending.value &&
    visibleSongs.value.length > 1 &&
    Boolean(sortedTrackColumn.value) &&
    sortedTrackColumn.value?.key !== 'index'
)

const pioneerSongMenuArr = computed<IMenu[][]>(() => {
  const groups: IMenu[][] = []
  if (canRemoveTracksFromDesktopPlaylist.value) {
    groups.push([{ menuName: 'rekordboxDesktop.removeTracksFromPlaylistAction' }])
  }
  groups.push([{ menuName: 'tracks.exportTracksCopyOnly' }])
  groups.push([{ menuName: 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks' }])
  groups.push([
    { menuName: 'library.copyToFilter' },
    { menuName: 'library.copyToCurated' },
    { menuName: 'library.addToMixtapeByCopy' }
  ])
  groups.push([{ menuName: 'tracks.showInFileExplorer' }])
  groups.push([
    {
      menuName: 'tracks.neteaseSearch',
      children: [
        { menuName: 'tracks.neteaseSearchTitleArtist' },
        { menuName: 'tracks.neteaseSearchTitle' },
        { menuName: 'tracks.neteaseSearchArtist' },
        { menuName: 'tracks.neteaseSearchAlbum' }
      ]
    }
  ])
  groups.push([{ menuName: 'similarTracks.menu' }])
  groups.push([{ menuName: 'fingerprints.analyzeAndAdd' }])
  groups.push([{ menuName: 'tracks.clearTrackCache' }])
  return groups
})

const toSongInfo = (track: IPioneerPlaylistTrack): ISongInfo => ({
  filePath: track.filePath,
  fileName: track.fileName,
  fileFormat: track.fileFormat,
  cover: null,
  title: track.title,
  artist: track.artist || undefined,
  album: track.album || undefined,
  duration: track.duration,
  genre: track.genre || undefined,
  label: track.label || undefined,
  bitrate: track.bitrate,
  container: track.container || undefined,
  key: track.key,
  bpm: track.bpm,
  hotCues: Array.isArray(track.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : [],
  memoryCues: Array.isArray(track.memoryCues) ? track.memoryCues.map((cue) => ({ ...cue })) : [],
  mixOrder: track.entryIndex,
  externalAnalyzePath: track.analyzePath || null,
  externalWaveformRootPath: selectedSourceRootPath.value || null,
  externalSourceKind: (selectedSourceKind.value || 'usb') as RekordboxSourceKind,
  pioneerCoverPath: track.coverPath || null,
  pioneerAnalyzePath: selectedSourceKind.value === 'usb' ? track.analyzePath || null : null,
  pioneerDeviceRootPath:
    selectedSourceKind.value === 'usb' ? selectedSourceRootPath.value || null : null,
  mixtapeItemId: track.rowKey,
  fileMissing: track.fileMissing ?? false
})

const normalizePath = (value: string) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const resolveTrackKey = (song: ISongInfo) => song.mixtapeItemId || song.filePath

const resolveSelectedTracksByKeys = (keys: string[]) => {
  if (!keys.length) return []
  const selectedKeySet = new Set(keys)
  return visibleSongs.value.filter((song) => selectedKeySet.has(resolveTrackKey(song)))
}

const resolveSelectedTracks = (fallback?: ISongInfo) => {
  const selectedKeys = selectedRowKeys.value.length
    ? [...selectedRowKeys.value]
    : fallback
      ? [resolveTrackKey(fallback)]
      : []
  if (!selectedKeys.length) return []
  const tracks = resolveSelectedTracksByKeys(selectedKeys)
  if (tracks.length > 0) return tracks
  return fallback ? [fallback] : []
}

const resolveFileNameAndFormat = (filePath: string) => {
  const baseName =
    String(filePath || '')
      .split(/[/\\]/)
      .pop() || ''
  const parts = baseName.split('.')
  const ext = parts.length > 1 ? parts.pop() || '' : ''
  return {
    fileName: baseName,
    fileFormat: ext ? ext.toUpperCase() : ''
  }
}

const buildSongSnapshot = (filePath: string, song: ISongInfo) => {
  const meta = resolveFileNameAndFormat(filePath)
  return {
    filePath,
    fileName: meta.fileName,
    fileFormat: song.fileFormat || meta.fileFormat,
    cover: null,
    title: song.title ?? meta.fileName,
    artist: song.artist,
    album: song.album,
    duration: song.duration ?? '',
    genre: song.genre,
    label: song.label,
    bitrate: song.bitrate,
    container: song.container,
    key: song.key,
    originalKey: song.key,
    bpm: song.bpm,
    originalBpm: song.bpm,
    firstBeatMs: song.firstBeatMs,
    barBeatOffset: song.barBeatOffset,
    hotCues: Array.isArray(song.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(song.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
  }
}

const showErrorDialog = async (message: string) => {
  await confirm({
    title: t('common.error'),
    content: [message || t('common.unknownError')],
    confirmShow: false
  })
}

const confirmTaskBusy = async () => {
  await confirm({
    title: t('dialog.hint'),
    content: [t('import.waitForTask')],
    confirmShow: false
  })
}

const showFileMissingHint = async (missingTracks: ISongInfo[]) => {
  const paths = missingTracks.map((item) => item.filePath).filter(Boolean)
  const content = [
    t('pioneer.fileMissingHintDetail', { count: missingTracks.length }),
    t('pioneer.fileMissingHintAction'),
    paths.length ? t('pioneer.fileMissingPathListTitle') : t('pioneer.fileMissingPathUnavailable'),
    ...paths.slice(0, 10),
    ...(paths.length > 10 ? [t('pioneer.fileMissingPathMore', { count: paths.length - 10 })] : [])
  ]
  await confirm({
    title: t('pioneer.fileMissingHint'),
    content,
    confirmShow: false,
    innerWidth: 620,
    innerHeight: 0,
    textAlign: 'left',
    canCopyText: paths.length > 0
  })
}

const resolveExistingOperationTracks = async (tracks: ISongInfo[]) => {
  const missingPathSet = new Set(
    tracks.filter((item) => item.fileMissing || !item.filePath).map((item) => item.filePath)
  )
  const pathsToCheck = Array.from(
    new Set(
      tracks.filter((item) => !item.fileMissing && item.filePath).map((item) => item.filePath)
    )
  )

  if (pathsToCheck.length) {
    const existenceMap = (await window.electron.ipcRenderer.invoke(
      'check-paths-exist',
      pathsToCheck
    )) as Record<string, boolean>
    for (const filePath of pathsToCheck) {
      if (existenceMap[filePath] === false) {
        missingPathSet.add(filePath)
      }
    }
  }

  if (missingPathSet.size > 0) {
    originalTracks.value = originalTracks.value.map((track) =>
      missingPathSet.has(track.filePath) ? { ...track, fileMissing: true } : track
    )
    applyFiltersAndSorting('fileMissing-changed')
  }

  const updatedTracks = tracks.map((track) =>
    missingPathSet.has(track.filePath) ? { ...track, fileMissing: true } : track
  )
  const missingTracks = updatedTracks.filter((track) => track.fileMissing || !track.filePath)
  const existingTracks = updatedTracks.filter((track) => !track.fileMissing && track.filePath)

  return {
    updatedTracks,
    missingTracks,
    existingTracks
  }
}

const sortArrayByProperty = <T extends object>(
  array: T[],
  property: keyof T,
  order: 'asc' | 'desc'
) => {
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
  return [...array].sort((a, b) => {
    const valueA = String(a[property] || '')
    const valueB = String(b[property] || '')
    return order === 'asc' ? collator.compare(valueA, valueB) : collator.compare(valueB, valueA)
  })
}

const parseDurationToSeconds = (mmss: string): number => {
  if (!mmss || typeof mmss !== 'string') return NaN
  const parts = mmss.split(':')
  if (parts.length !== 2) return NaN
  const minutes = Number(parts[0])
  const seconds = Number(parts[1])
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return NaN
  return minutes * 60 + seconds
}

const parseNumberInput = (input: unknown): number => {
  if (input === null || input === undefined) return NaN
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN
  const raw = String(input || '').trim()
  if (!raw) return NaN
  const cleaned = raw.replace(/[^0-9.]/g, '')
  if (!cleaned) return NaN
  const parts = cleaned.split('.')
  const normalized = parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : parts[0]
  const value = Number(normalized)
  return Number.isFinite(value) ? value : NaN
}

const parseComparableBpm = (input: unknown): number | null => {
  const numeric = parseNumberInput(input)
  if (Number.isNaN(numeric)) return null
  return normalizeBpmDisplayScaled(numeric)
}

const parseExcludeKeywords = (input: unknown): string[] => {
  if (input === null || input === undefined) return []
  const raw = String(input)
  if (!raw.trim()) return []
  return raw
    .split(/[,\n;\r，；、|]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

const applyFiltersAndSorting = (reason = 'unspecified') => {
  let filtered = originalTracks.value.map((track) => toSongInfo(track))
  const beforeCount = filtered.length
  for (const col of columnData.value) {
    if (!col.filterActive) continue
    if (col.filterType === 'text' && col.key) {
      const keyword = String(col.filterValue || '').toLowerCase()
      const excludeKeywords = parseExcludeKeywords(col.filterExcludeValue)
      const hasInclude = keyword.trim().length > 0
      const hasExclude = excludeKeywords.length > 0
      if (!hasInclude && !hasExclude) continue
      const isKeyColumn = col.key === 'key'
      const keyStyle = runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
      filtered = filtered.filter((song) => {
        const rawValue = String(getSongField(song, col.key) ?? '')
        const displayValue = isKeyColumn ? getKeyDisplayText(rawValue, keyStyle) : rawValue
        const value = displayValue.toLowerCase()
        if (hasInclude && !value.includes(keyword)) return false
        if (hasExclude && excludeKeywords.some((item) => value.includes(item))) return false
        return true
      })
    } else if (col.filterType === 'duration' && col.filterOp && col.filterDuration) {
      const target = parseDurationToSeconds(col.filterDuration)
      filtered = filtered.filter((song) => {
        const duration = parseDurationToSeconds(String(song.duration ?? ''))
        if (Number.isNaN(duration) || Number.isNaN(target)) return false
        if (col.filterOp === 'eq') return duration === target
        if (col.filterOp === 'gte') return duration >= target
        if (col.filterOp === 'lte') return duration <= target
        return true
      })
    } else if (col.filterType === 'bpm' && col.filterOp && col.filterNumber) {
      const target = parseComparableBpm(col.filterNumber)
      filtered = filtered.filter((song) => {
        const bpm = parseComparableBpm(song.bpm)
        if (bpm === null || target === null) return false
        if (col.filterOp === 'eq') return bpm === target
        if (col.filterOp === 'gte') return bpm >= target
        if (col.filterOp === 'lte') return bpm <= target
        return true
      })
    }
  }

  const sortedCol = columnData.value.find((col) => col.order)
  if (sortedCol) {
    if (sortedCol.key === 'index') {
      filtered = [...filtered].sort((a, b) => {
        const valueA = Number(a.mixOrder) || 0
        const valueB = Number(b.mixOrder) || 0
        return sortedCol.order === 'asc' ? valueA - valueB : valueB - valueA
      })
    } else if (sortedCol.key === 'key') {
      const style = runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
      const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
      filtered = [...filtered].sort((a, b) => {
        const valueA = getKeySortText(String(a.key || ''), style)
        const valueB = getKeySortText(String(b.key || ''), style)
        return sortedCol.order === 'asc'
          ? collator.compare(valueA, valueB)
          : collator.compare(valueB, valueA)
      })
    } else {
      filtered = sortArrayByProperty(filtered, sortedCol.key as keyof ISongInfo, sortedCol.order!)
    }
  }

  visibleSongs.value = filtered

  // 当前播放列表即为当前视图时，同步播放列表快照（保持排序一致）
  if (
    currentPlaybackListKey.value &&
    runtime.playingData.playingSongListUUID === currentPlaybackListKey.value
  ) {
    runtime.playingData.playingSongListData = [...visibleSongs.value]
  }

  emitPioneerSongsAreaLog('apply-filters-and-sorting', {
    reason,
    beforeCount,
    afterCount: filtered.length,
    selectedRowCount: selectedRowKeys.value.length,
    filters: columnData.value
      .filter((col) => !!col.filterActive)
      .map((col) => ({
        key: col.key,
        filterType: col.filterType || '',
        filterOp: col.filterOp || '',
        filterValue: col.filterValue || '',
        filterExcludeValue: col.filterExcludeValue || '',
        filterDuration: col.filterDuration || '',
        filterNumber: col.filterNumber || ''
      })),
    firstOriginalTracks: originalTracks.value.slice(0, 5).map((track) => ({
      rowKey: track.rowKey,
      title: track.title,
      filePath: track.filePath
    })),
    firstVisibleSongs: filtered.slice(0, 5).map((song) => ({
      rowKey: song.mixtapeItemId || song.filePath,
      title: song.title,
      filePath: song.filePath
    }))
  })
}

const handleColumnsUpdate = (nextColumns: ISongsAreaColumn[]) => {
  columnData.value = nextColumns
  applyFiltersAndSorting('columns-updated')
  selectedRowKeys.value = []
}

const handleColumnClick = (column: ISongsAreaColumn) => {
  if (column.key === 'cover' || column.key === 'waveformPreview') return
  columnData.value = columnData.value.map((item) => {
    if (item.key !== column.key) return { ...item, order: undefined }
    const nextOrder = item.order === 'asc' ? 'desc' : item.order === 'desc' ? 'asc' : 'asc'
    return { ...item, order: nextOrder as 'asc' | 'desc' }
  })
  applyFiltersAndSorting('column-sort-click')
}

const isCurrentPlaylistLoadTarget = (sourceCacheKey: string, playlistId: number) =>
  selectedSourceCacheKey.value === sourceCacheKey && selectedPlaylistId.value === playlistId

const { frkbAnalyzedFilePaths, resetFrkbAnalyzedFilePaths, prepareExternalPlaylistAnalysis } =
  usePioneerExternalPlaylistAnalysis({
    sourceKind: selectedSourceKind,
    sourceKey: selectedSourceKey,
    visibleSongs,
    isCurrentPlaylistLoadTarget
  })

const fetchPlaylistTracks = async (params: {
  sourceCacheKey: string
  playlistId: number
  sourceKind: IRekordboxSourceKind
  rootPath: string
  libraryType: string
  hasCachedTracks: boolean
}) => {
  const requestToken = ++playlistTracksRequestToken
  const { sourceCacheKey, playlistId, sourceKind, rootPath, libraryType, hasCachedTracks } = params

  try {
    emitPioneerSongsAreaLog('fetch-playlist-tracks-start', {
      requestToken,
      hasCachedTracks,
      sourceCacheKey
    })
    const result =
      sourceKind === 'desktop'
        ? await window.electron.ipcRenderer.invoke(
            buildRekordboxSourceChannel('desktop', 'load-playlist-tracks'),
            playlistId
          )
        : await window.electron.ipcRenderer.invoke(
            buildRekordboxSourceChannel('usb', 'load-playlist-tracks'),
            rootPath,
            playlistId,
            libraryType
          )
    const tracks = Array.isArray(result?.tracks) ? result.tracks : []
    setCachedRekordboxPlaylistTracks(sourceCacheKey, playlistId, tracks)
    emitPioneerSongsAreaLog('fetch-playlist-tracks-success', {
      requestToken,
      returnedTrackCount: tracks.length,
      firstTracks: tracks.slice(0, 5).map((track: IPioneerPlaylistTrack) => ({
        rowKey: track.rowKey,
        title: track.title,
        filePath: track.filePath
      }))
    })

    if (!isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
    if (requestToken !== playlistTracksRequestToken) return

    originalTracks.value = tracks
    applyFiltersAndSorting('fetch-playlist-tracks-success')
    void prepareExternalPlaylistAnalysis({ sourceCacheKey, playlistId, rootPath, tracks })
  } catch (error) {
    if (!isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
    if (requestToken !== playlistTracksRequestToken) return

    console.error('[pioneerSongsArea] load playlist tracks failed', error)
    emitPioneerSongsAreaLog('fetch-playlist-tracks-failed', {
      requestToken,
      hasCachedTracks,
      error
    })
    if (!hasCachedTracks) {
      originalTracks.value = []
      visibleSongs.value = []
    }
  } finally {
    if (
      isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId) &&
      requestToken === playlistTracksRequestToken
    ) {
      loading.value = false
    }
  }
}

const loadPlaylistTracks = async () => {
  const sourceCacheKey = selectedSourceCacheKey.value
  const playlistId = selectedPlaylistId.value
  const sourceKind = selectedSourceKind.value || 'usb'
  const rootPath = selectedSourceRootPath.value
  const libraryType = selectedLibraryType.value

  if (!rootPath || !playlistId || !sourceCacheKey) {
    playlistTracksRequestToken += 1
    loading.value = false
    originalTracks.value = []
    visibleSongs.value = []
    selectedRowKeys.value = []
    resetFrkbAnalyzedFilePaths()
    emitPioneerSongsAreaLog('load-playlist-tracks-reset-empty-selection', {
      sourceCacheKey,
      rootPath,
      playlistId
    })
    return
  }

  selectedRowKeys.value = []
  resetFrkbAnalyzedFilePaths()

  const cachedTracks = getCachedRekordboxPlaylistTracks(sourceCacheKey, playlistId)
  emitPioneerSongsAreaLog('load-playlist-tracks-enter', {
    sourceCacheKey,
    hasCachedTracks: Boolean(cachedTracks),
    cachedTrackCount: cachedTracks?.tracks?.length || 0
  })
  if (cachedTracks) {
    originalTracks.value = cachedTracks.tracks
    applyFiltersAndSorting('load-playlist-tracks-cache-hit')
    loading.value = false
    void prepareExternalPlaylistAnalysis({
      sourceCacheKey,
      playlistId,
      rootPath,
      tracks: cachedTracks.tracks
    })
  } else {
    loading.value = true
    originalTracks.value = []
    visibleSongs.value = []
  }

  if (cachedTracks && !shouldRefreshRekordboxPlaylistTracks(sourceCacheKey, playlistId)) {
    return
  }

  const task = fetchPlaylistTracks({
    sourceCacheKey,
    playlistId,
    sourceKind,
    rootPath,
    libraryType,
    hasCachedTracks: Boolean(cachedTracks)
  })
  if (!cachedTracks) {
    await task
  } else {
    void task
  }
}

const {
  playlistMutationPending,
  removeTracksFromDesktopPlaylist,
  reorderTracksInDesktopPlaylist,
  renumberTracksInDesktopPlaylist
} = usePioneerDesktopPlaylistActions({
  runtime,
  selectedPlaylistId,
  selectedSourceCacheKey,
  currentPlaybackListKey,
  visibleSongs,
  selectedRowKeys,
  loadPlaylistTracks
})

watch(
  () => [selectedSourceRootPath.value, selectedPlaylistId.value, selectedSourceKind.value] as const,
  () => {
    emitPioneerSongsAreaLog('source-or-playlist-changed')
    try {
      emitter.emit('waveform-preview:stop', { reason: 'switch' })
    } catch {}
    void loadPlaylistTracks()
  },
  { immediate: true }
)

watch(
  () =>
    [
      selectedSourceCacheKey.value,
      selectedPlaylistId.value,
      Array.isArray(runtime.pioneerDeviceLibrary.treeNodes)
        ? runtime.pioneerDeviceLibrary.treeNodes.length
        : 0
    ] as const,
  ([sourceCacheKey, playlistId, treeNodeCount]) => {
    if (!sourceCacheKey) return
    if (playlistId <= 0 && treeNodeCount <= 0) return
    rememberRekordboxSourceSelectedPlaylist(sourceCacheKey, playlistId)
  },
  { immediate: true }
)

watch(
  () => runtime.setting.keyDisplayStyle,
  () => {
    applyFiltersAndSorting('key-display-style-changed')
  }
)

watch(
  selectedRowKeys,
  (keys) => {
    runtime.pioneerSelectedRowKeys = [...keys]
  },
  { deep: true }
)

const handleSongClick = (event: MouseEvent, song: ISongInfo) => {
  if (playlistMutationPending.value) return
  songClick(event, song)
}

const openCopyTargetDialog = (libraryName: PioneerTransferTarget, tracks: ISongInfo[] = []) => {
  selectSongListDialogTrackKeys.value = tracks.map(resolveTrackKey).filter(Boolean)
  selectSongListDialogTargetLibraryName.value = libraryName
  selectSongListDialogVisible.value = true
}
const handlePreviewMoveRequest = (
  payload?: Record<string, unknown> & { song?: ISongInfo | null }
) => {
  if (String(payload?.sourceLibraryName || '').trim() !== 'PioneerDeviceLibrary') return
  if (String(payload?.sourceSongListUUID || '').trim() !== currentPlaybackListKey.value) return
  const targetLibraryName = payload?.targetLibraryName as PioneerTransferTarget | undefined
  const song = payload?.song
  if (!song?.filePath || !targetLibraryName) return
  const rowKey = song.mixtapeItemId || song.filePath
  if (!rowKey) return
  const exists = visibleSongs.value.some((item) => (item.mixtapeItemId || item.filePath) === rowKey)
  if (!exists) return
  selectedRowKeys.value = [rowKey]
  openCopyTargetDialog(targetLibraryName)
}
emitter.on('preview-transfer:open-dialog', handlePreviewMoveRequest)

// 播放器标记文件缺失时，同步更新原始数据使 UI 立即变色
const handleSongFileMissing = (payload: { listUUID?: string; filePath?: string }) => {
  if (!payload?.filePath) return
  if (currentPlaybackListKey.value && payload.listUUID === currentPlaybackListKey.value) {
    const missingPath = payload.filePath
    originalTracks.value = originalTracks.value.map((track) =>
      track.filePath === missingPath ? { ...track, fileMissing: true } : track
    )
    applyFiltersAndSorting('fileMissing-changed')
  }
}
emitter.on('songFileMissing', handleSongFileMissing)

const handleSongFileRestored = (payload: { listUUID?: string; filePath?: string }) => {
  if (!payload?.filePath) return
  if (currentPlaybackListKey.value && payload.listUUID === currentPlaybackListKey.value) {
    const restoredPath = payload.filePath
    originalTracks.value = originalTracks.value.map((track) =>
      track.filePath === restoredPath ? { ...track, fileMissing: false } : track
    )
    applyFiltersAndSorting('fileRestored-changed')
  }
}
emitter.on('songFileRestored', handleSongFileRestored)

const handleSongContextMenu = async (event: MouseEvent, song: ISongInfo) => {
  cancelPendingRepeatSingleClickDeselect()
  if (playlistMutationPending.value) return
  const key = song.mixtapeItemId || song.filePath
  if (!key) return
  if (!selectedRowKeys.value.includes(key)) {
    selectedRowKeys.value = [key]
  }

  const result = await rightClickMenu({
    menuArr: pioneerSongMenuArr.value,
    clickEvent: event
  })
  if (result === 'cancel') return

  const selectedTracks = resolveSelectedTracks(song)
  if (!selectedTracks.length) return

  const { updatedTracks, missingTracks, existingTracks } =
    await resolveExistingOperationTracks(selectedTracks)
  const showSelectedMissingHint = async () => showFileMissingHint(missingTracks)
  const showNeteaseSearchEmptyHint = async (messageKey: string) => {
    await confirm({
      title: t('dialog.hint'),
      content: [t(messageKey)],
      confirmShow: false
    })
  }
  const openSongNeteaseSearch = async (query: string) => {
    if (!openNeteaseSearch(query)) {
      await showNeteaseSearchEmptyHint('tracks.neteaseSearchEmpty')
    }
  }

  switch (result.menuName) {
    case 'rekordboxDesktop.removeTracksFromPlaylistAction':
      await removeTracksFromDesktopPlaylist(updatedTracks, canRemoveTracksFromDesktopPlaylist.value)
      return
    case 'library.copyToCurated':
      if (!existingTracks.length) {
        await showSelectedMissingHint()
        return
      }
      openCopyTargetDialog('CuratedLibrary', existingTracks)
      return
    case 'library.copyToFilter':
      if (!existingTracks.length) {
        await showSelectedMissingHint()
        return
      }
      openCopyTargetDialog('FilterLibrary', existingTracks)
      return
    case 'library.addToMixtapeByCopy':
      if (!existingTracks.length) {
        await showSelectedMissingHint()
        return
      }
      openCopyTargetDialog('MixtapeLibrary', existingTracks)
      return
    case 'fingerprints.analyzeAndAdd':
      if (!existingTracks.length) {
        await showSelectedMissingHint()
        return
      }
      await analyzeFingerprintsForPaths(
        existingTracks.map((item) => item.filePath),
        {
          origin: 'selection'
        }
      )
      return
    case 'tracks.clearTrackCache':
      if (!existingTracks.length) {
        await showSelectedMissingHint()
        return
      }
      await window.electron.ipcRenderer.invoke(
        'track:cache:clear:batch',
        existingTracks.map((item) => item.filePath)
      )
      return
    case 'similarTracks.menu': {
      const { default: openSimilarTracksDialog } =
        await import('@renderer/components/similarTracksDialog')
      await openSimilarTracksDialog(song)
      return
    }
    case 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks':
      if (runtime.isProgressing) {
        await confirmTaskBusy()
        return
      }
      if (!existingTracks.length) {
        await showSelectedMissingHint()
        return
      }
      runtime.isProgressing = true
      try {
        await openRekordboxDesktopPlaylistForSelectedTracks({
          tracks: existingTracks,
          songListUUID: currentPlaybackListKey.value,
          forceKeepSourceTracks: true
        })
      } finally {
        runtime.isProgressing = false
      }
      return
    case 'tracks.exportTracksCopyOnly': {
      if (!existingTracks.length) {
        await showSelectedMissingHint()
        return
      }
      const exportResult = await exportDialog({
        title: 'tracks.title',
        forceCopyOnly: true
      })
      if (exportResult === 'cancel') return
      await window.electron.ipcRenderer.invoke(
        'exportSongsToDir',
        exportResult.folderPathVal,
        false,
        JSON.parse(JSON.stringify(existingTracks))
      )
      return
    }
    case 'tracks.showInFileExplorer':
      if (updatedTracks[0]?.fileMissing) {
        await showSelectedMissingHint()
      } else {
        window.electron.ipcRenderer.send('show-item-in-folder', updatedTracks[0]?.filePath)
      }
      return
    case 'tracks.neteaseSearchTitle': {
      const title = normalizeNeteaseSearchText(song.title)
      if (!title) {
        await showNeteaseSearchEmptyHint('tracks.neteaseSearchTitleEmpty')
        return
      }
      await openSongNeteaseSearch(title)
      return
    }
    case 'tracks.neteaseSearchArtist': {
      const artist = normalizeNeteaseSearchText(song.artist)
      if (!artist) {
        await showNeteaseSearchEmptyHint('tracks.neteaseSearchArtistEmpty')
        return
      }
      await openSongNeteaseSearch(artist)
      return
    }
    case 'tracks.neteaseSearchAlbum': {
      const album = normalizeNeteaseSearchText(song.album)
      if (!album) {
        await showNeteaseSearchEmptyHint('tracks.neteaseSearchAlbumEmpty')
        return
      }
      await openSongNeteaseSearch(album)
      return
    }
    case 'tracks.neteaseSearchTitleArtist': {
      const title = normalizeNeteaseSearchText(song.title)
      const artist = normalizeNeteaseSearchText(song.artist)
      if (!title && !artist) {
        await showNeteaseSearchEmptyHint('tracks.neteaseSearchTitleArtistEmpty')
        return
      }
      await openSongNeteaseSearch(buildNeteaseSearchQuery(title, artist))
      return
    }
  }
}

const handlePlaylistReorder = async (payload: { sourceItemIds: string[]; targetIndex: number }) => {
  await reorderTracksInDesktopPlaylist(
    payload.sourceItemIds,
    payload.targetIndex,
    canReorderDesktopTracks.value
  )
}

const handleRenumberTracksByVisibleOrder = async () => {
  await renumberTracksInDesktopPlaylist(visibleSongs.value, canRenumberDesktopTracks.value)
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

const { handleSongDragStart, handleSongDragEnd } = usePioneerSongDrag({
  selectedRowKeys,
  visibleSongs,
  currentPlaybackListKey,
  resolveSelectedTracks
})

const handleSongDblClick = async (song: ISongInfo, event?: MouseEvent) => {
  cancelPendingRepeatSingleClickDeselect()
  if (!song.fileMissing && song.filePath) {
    const exists = await window.electron.ipcRenderer.invoke('check-path-exists', song.filePath)
    if (!exists) {
      const missingPath = song.filePath
      originalTracks.value = originalTracks.value.map((track) =>
        track.filePath === missingPath ? { ...track, fileMissing: true } : track
      )
      applyFiltersAndSorting('fileMissing-changed')
      song.fileMissing = true
    }
  }
  if (song.fileMissing) {
    const songName = String(song.title || song.fileName || '').trim()
    const content = [
      t('pioneer.fileMissingSingleDetail'),
      ...(songName ? [t('pioneer.fileMissingTrackName', { name: songName })] : []),
      song.filePath
        ? t('pioneer.fileMissingPathListTitle')
        : t('pioneer.fileMissingPathUnavailable'),
      ...(song.filePath ? [song.filePath] : []),
      t('pioneer.fileMissingSingleAction')
    ]
    await confirm({
      title: t('pioneer.fileMissingHint'),
      content,
      confirmShow: false,
      innerWidth: 620,
      innerHeight: 0,
      textAlign: 'left',
      canCopyText: Boolean(song.filePath)
    })
    return
  }
  if (playlistMutationPending.value) return
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  runtime.activeMenuUUID = ''
  selectedRowKeys.value = []

  const normalizedSong = { ...song }
  requestImmediateAnalysis(normalizedSong)
  if (runtime.mainWindowBrowseMode !== 'browser') {
    const deck =
      runtime.mainWindowBrowseMode === 'edit' ? 'top' : event?.shiftKey ? 'bottom' : 'top'
    const playbackListKey = currentPlaybackListKey.value
    if (playbackListKey) {
      runtime.playingData.playingSongListUUID = playbackListKey
      runtime.playingData.playingSongListData = [...visibleSongs.value]
    }
    beginHorizontalBrowseDeckInteraction(deck, String(normalizedSong.filePath || '').trim())
    sendHorizontalBrowseInteractionTrace('song-dblclick', {
      source: 'pioneerSongsArea',
      deck,
      filePath: String(normalizedSong.filePath || '').trim()
    })
    emitter.emit('horizontalBrowse/load-song', {
      deck,
      song: normalizedSong
    })
    return
  }
  const playbackListKey = currentPlaybackListKey.value
  if (!playbackListKey) return
  const isSameList = runtime.playingData.playingSongListUUID === playbackListKey
  const isSameSong =
    isSameList && runtime.playingData.playingSong?.filePath === normalizedSong.filePath

  runtime.playingData.playingSongListUUID = playbackListKey
  runtime.playingData.playingSongListData = [...visibleSongs.value]

  if (isSameSong && runtime.playingData.playingSong) {
    runtime.playingData.playingSong = normalizedSong
    emitter.emit('player/replay-current-song')
    return
  }

  runtime.playingData.playingSong = normalizedSong
}

const handleSelectSongListDialogConfirm = async (targetSongListUUID: string) => {
  const targetLibraryName = selectSongListDialogTargetLibraryName.value
  const selectedTrackKeys = [...selectSongListDialogTrackKeys.value]
  selectSongListDialogVisible.value = false
  selectSongListDialogTargetLibraryName.value = ''
  selectSongListDialogTrackKeys.value = []
  const rawSelectedTracks = selectedTrackKeys.length
    ? resolveSelectedTracksByKeys(selectedTrackKeys)
    : resolveSelectedTracks()
  if (!rawSelectedTracks.length || !targetLibraryName) return

  const { missingTracks, existingTracks: selectedTracks } =
    await resolveExistingOperationTracks(rawSelectedTracks)
  if (!selectedTracks.length) {
    await showFileMissingHint(missingTracks)
    return
  }

  try {
    if (targetLibraryName === 'MixtapeLibrary') {
      const copiedTracks = (await window.electron.ipcRenderer.invoke(
        'mixtape:copy-files-to-vault',
        {
          filePaths: selectedTracks.map((item) => item.filePath)
        }
      )) as Array<{ sourcePath: string; targetPath: string }>

      const copiedPathMap = new Map(
        copiedTracks.map((item) => [normalizePath(item.sourcePath), item.targetPath])
      )
      const items = selectedTracks
        .map((track) => {
          const copiedPath = copiedPathMap.get(normalizePath(track.filePath))
          if (!copiedPath) return null
          return {
            filePath: copiedPath,
            originPathSnapshot: originPathSnapshot.value,
            info: buildSongSnapshot(copiedPath, track)
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)

      if (!items.length) {
        throw new Error('MIXTAPE_COPY_TO_VAULT_FAILED')
      }

      await window.electron.ipcRenderer.invoke('mixtape:append', {
        playlistId: targetSongListUUID,
        items
      })
      emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
      emitter.emit('songsArea/clipboardHint', {
        message: t('mixtape.addedToMixtape', { count: items.length })
      })
      return
    }

    const targetDirPath = libraryUtils.findDirPathByUuid(targetSongListUUID)
    if (!targetDirPath) {
      await showErrorDialog(t('library.notExistOnDisk'))
      return
    }
    const copiedPaths = (await window.electron.ipcRenderer.invoke(
      'moveSongsToDir',
      selectedTracks.map((item) => item.filePath),
      targetDirPath,
      {
        mode: 'copy',
        curatedArtistNames: selectedTracks.map((item) => item.artist || '')
      }
    )) as string[]
    await copySongCueDefinitionsToTargets(
      copiedPaths.map((targetFilePath, index) => ({
        targetFilePath,
        sourceSong: selectedTracks[index]
      }))
    )
    emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
  } catch (error: unknown) {
    const messageCode = error instanceof Error ? error.message : String(error || '')
    if (messageCode === 'MIXTAPE_VAULT_UNAVAILABLE') {
      await showErrorDialog(t('pioneer.mixtapeVaultUnavailable'))
      return
    }
    if (messageCode === 'MIXTAPE_COPY_TO_VAULT_FAILED') {
      await showErrorDialog(t('pioneer.copyToMixtapeFailed'))
      return
    }
    if (messageCode === 'copySongsToDir failed') {
      await showErrorDialog(t('pioneer.copyTracksFailed'))
      return
    }
    await showErrorDialog(messageCode || t('common.unknownError'))
  }
}

const handleSelectSongListDialogCancel = () => {
  selectSongListDialogVisible.value = false
  selectSongListDialogTargetLibraryName.value = ''
  selectSongListDialogTrackKeys.value = []
}

onUnmounted(() => {
  cancelPendingRepeatSingleClickDeselect()
  emitter.off('preview-transfer:open-dialog', handlePreviewMoveRequest)
  emitter.off('songFileMissing', handleSongFileMissing)
  emitter.off('songFileRestored', handleSongFileRestored)
})

const placeholderText = computed(() => {
  if (loading.value) {
    return isDesktopSource.value
      ? t('rekordboxDesktop.loadingPlaylistTracks')
      : t('pioneer.loadingPlaylistTracks')
  }
  if (!selectedPlaylistId.value) {
    return isDesktopSource.value
      ? t('rekordboxDesktop.selectPlaylistPrompt')
      : t('pioneer.selectPlaylistPrompt')
  }
  if (!visibleSongs.value.length) {
    return isDesktopSource.value ? t('rekordboxDesktop.emptyPlaylist') : t('pioneer.emptyPlaylist')
  }
  return ''
})

watch(
  () => placeholderText.value,
  (value) => {
    const snapshot = JSON.stringify({
      placeholderText: value,
      loading: loading.value,
      selectedPlaylistId: selectedPlaylistId.value,
      originalTrackCount: originalTracks.value.length,
      visibleSongCount: visibleSongs.value.length,
      activeFilters: columnData.value.filter((col) => !!col.filterActive).map((col) => col.key)
    })
    if (snapshot === lastLoggedSnapshot.value) return
    lastLoggedSnapshot.value = snapshot
    emitPioneerSongsAreaLog('placeholder-text-changed', {
      placeholderText: value,
      firstOriginalTracks: originalTracks.value.slice(0, 5).map((track) => ({
        rowKey: track.rowKey,
        title: track.title,
        filePath: track.filePath
      })),
      firstVisibleSongs: visibleSongs.value.slice(0, 5).map((song) => ({
        rowKey: song.mixtapeItemId || song.filePath,
        title: song.title,
        filePath: song.filePath
      }))
    })
  },
  { immediate: true }
)
</script>

<template>
  <div class="songsAreaShell">
    <div v-if="placeholderText" class="songsAreaPlaceholder">
      {{ placeholderText }}
    </div>
    <OverlayScrollbarsComponent
      v-else
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
        :total-width="totalWidth"
        :show-index-action="canRenumberDesktopTracks"
        :index-action-title="t('rekordboxDesktop.renumberPlaylistTracksAction')"
        :index-action-disabled="playlistMutationPending || loading"
        @update:columns="handleColumnsUpdate"
        @column-click="handleColumnClick"
        @header-contextmenu.stop.prevent
        @index-action-click="handleRenumberTracksByVisibleOrder"
      />

      <SongListRows
        :songs="visibleSongs"
        :visible-columns="visibleColumns"
        :selected-song-file-paths="selectedRowKeysForTemplate"
        :playing-song-file-path="playingSongFilePathForRows"
        :playing-song-file-paths="playingSongFilePathsForRows"
        :flash-row-key="''"
        :flash-row-token="0"
        :harmonic-reference-key="harmonicReferenceKeyForRows"
        :total-width="totalWidth"
        source-library-name="PioneerDeviceLibrary"
        :source-song-list-u-u-i-d="
          currentPlaybackListKey || `${selectedSourceKind || 'usb'}:${selectedPlaylistId}`
        "
        :scroll-host-element="songsAreaRef?.osInstance()?.elements().viewport"
        :external-scroll-top="externalScrollTop"
        :external-viewport-height="externalViewportHeight"
        :external-waveform-root-path="selectedSourceRootPath"
        :read-only="true"
        :allow-context-menu-when-read-only="true"
        :allow-dblclick-when-read-only="true"
        :allow-waveform-preview-when-read-only="true"
        :allow-song-drag-when-read-only="true"
        :analysis-complete-file-paths="frkbAnalyzedFilePaths"
        :reorder-mode="canReorderDesktopTracks ? 'playlist' : 'none'"
        song-list-root-dir="library/PioneerDeviceLibrary"
        :enable-cover-thumbnails="true"
        :enable-key-analysis-queue="false"
        @song-click="handleSongClick"
        @song-contextmenu="handleSongContextMenu"
        @song-dblclick="handleSongDblClick"
        @song-dragstart="handleSongDragStart"
        @song-dragend="handleSongDragEnd"
        @playlist-reorder="handlePlaylistReorder"
      />
    </OverlayScrollbarsComponent>
    <RekordboxDesktopWritingOverlay v-if="playlistMutationPending" />
    <Teleport to="body">
      <selectSongListDialog
        v-if="selectSongListDialogVisible"
        :library-name="selectSongListDialogTargetLibraryName"
        action-mode="copy"
        @confirm="handleSelectSongListDialogConfirm"
        @cancel="handleSelectSongListDialogCancel"
      />
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
.songsAreaShell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}

.songsAreaPlaceholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 12px;
}
</style>
