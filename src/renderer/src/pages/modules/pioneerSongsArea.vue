<script setup lang="ts">
import { computed, ref, shallowRef, watch, useTemplateRef } from 'vue'
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
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import libraryUtils from '@renderer/utils/libraryUtils'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { buildSongsAreaDefaultColumns } from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'
import { getKeyDisplayText, getKeySortText } from '@shared/keyDisplay'
import { useParentRafSampler } from '@renderer/pages/modules/songsArea/composables/useParentRafSampler'
import type {
  IMenu,
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode,
  ISongInfo,
  ISongsAreaColumn
} from '../../../../types/globals'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
type PioneerTransferTarget = 'CuratedLibrary' | 'FilterLibrary' | 'MixtapeLibrary'

const runtime = useRuntimeStore()
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const originalTracks = shallowRef<IPioneerPlaylistTrack[]>([])
const visibleSongs = ref<ISongInfo[]>([])
const loading = ref(false)
const selectedRowKeys = ref<string[]>([])
const columnData = ref<ISongsAreaColumn[]>(
  buildSongsAreaDefaultColumns('default').map((column) =>
    column.key === 'index' ? { ...column, width: Math.max(column.width, 74) } : column
  )
)
const selectSongListDialogVisible = ref(false)
const selectSongListDialogTargetLibraryName = ref<PioneerTransferTarget | ''>('')

const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset
const { externalScrollTop, externalViewportHeight } = useParentRafSampler({ songsAreaRef })
useWaveformPreviewPlayer()

const selectedDriveKey = computed(() => runtime.pioneerDeviceLibrary.selectedDriveKey || '')
const selectedDriveName = computed(
  () => runtime.pioneerDeviceLibrary.selectedDriveName || 'Pioneer USB'
)
const selectedPlaylistId = computed(() => runtime.pioneerDeviceLibrary.selectedPlaylistId || 0)
const selectedDrivePath = computed(() => runtime.pioneerDeviceLibrary.selectedDrivePath || '')
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
  const driveKey = selectedDriveKey.value || selectedDrivePath.value || 'pioneer'
  return `pioneer:${driveKey}:${selectedPlaylistId.value}`
})

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
const originPathSnapshot = computed(() => {
  const driveLabel = selectedDriveName.value || 'Pioneer USB'
  const playlistLabel = selectedPlaylistNode.value?.name || ''
  return playlistLabel ? `${driveLabel} / ${playlistLabel}` : driveLabel
})

const pioneerSongMenuArr: IMenu[][] = [
  [{ menuName: 'tracks.exportTracksCopyOnly' }],
  [
    { menuName: 'library.copyToFilter' },
    { menuName: 'library.copyToCurated' },
    { menuName: 'library.addToMixtapeByCopy' }
  ],
  [{ menuName: 'tracks.showInFileExplorer' }],
  [{ menuName: 'fingerprints.analyzeAndAdd' }]
]

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
  mixOrder: track.entryIndex,
  pioneerCoverPath: track.coverPath || null,
  pioneerAnalyzePath: track.analyzePath || null,
  pioneerDeviceRootPath: selectedDrivePath.value || null,
  mixtapeItemId: track.rowKey
})

const normalizePath = (value: string) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const resolveSelectedTracks = (fallback?: ISongInfo) => {
  const selectedKeys = selectedRowKeys.value.length
    ? [...selectedRowKeys.value]
    : fallback
      ? [fallback.mixtapeItemId || fallback.filePath]
      : []
  if (!selectedKeys.length) return []
  const selectedKeySet = new Set(selectedKeys)
  const tracks = visibleSongs.value.filter((song) =>
    selectedKeySet.has(song.mixtapeItemId || song.filePath)
  )
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
    originalBpm: song.bpm
  }
}

const showErrorDialog = async (message: string) => {
  await confirm({
    title: t('common.error'),
    content: [message || t('common.unknownError')],
    confirmShow: false
  })
}

const sortArrayByProperty = <T extends Record<string, any>>(
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

const parseExcludeKeywords = (input: unknown): string[] => {
  if (input === null || input === undefined) return []
  const raw = String(input)
  if (!raw.trim()) return []
  return raw
    .split(/[,\n;\r，；、|]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

const applyFiltersAndSorting = () => {
  let filtered = originalTracks.value.map((track) => toSongInfo(track))
  for (const col of columnData.value) {
    if (!col.filterActive) continue
    if (col.filterType === 'text' && col.key) {
      const keyword = String(col.filterValue || '').toLowerCase()
      const excludeKeywords = parseExcludeKeywords(col.filterExcludeValue)
      const hasInclude = keyword.trim().length > 0
      const hasExclude = excludeKeywords.length > 0
      if (!hasInclude && !hasExclude) continue
      const isKeyColumn = col.key === 'key'
      const keyStyle =
        (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
      filtered = filtered.filter((song) => {
        const rawValue = String((song as any)[col.key] ?? '')
        const displayValue = isKeyColumn ? getKeyDisplayText(rawValue, keyStyle) : rawValue
        const value = displayValue.toLowerCase()
        if (hasInclude && !value.includes(keyword)) return false
        if (hasExclude && excludeKeywords.some((item) => value.includes(item))) return false
        return true
      })
    } else if (col.filterType === 'duration' && col.filterOp && col.filterDuration) {
      const target = parseDurationToSeconds(col.filterDuration)
      filtered = filtered.filter((song) => {
        const duration = parseDurationToSeconds(String((song as any).duration ?? ''))
        if (Number.isNaN(duration) || Number.isNaN(target)) return false
        if (col.filterOp === 'eq') return duration === target
        if (col.filterOp === 'gte') return duration >= target
        if (col.filterOp === 'lte') return duration <= target
        return true
      })
    } else if (col.filterType === 'bpm' && col.filterOp && col.filterNumber) {
      const target = parseNumberInput(col.filterNumber)
      filtered = filtered.filter((song) => {
        const bpm = parseNumberInput((song as any)?.bpm)
        if (Number.isNaN(bpm) || Number.isNaN(target)) return false
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
      const style = (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
      const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
      filtered = [...filtered].sort((a, b) => {
        const valueA = getKeySortText(String((a as any).key || ''), style)
        const valueB = getKeySortText(String((b as any).key || ''), style)
        return sortedCol.order === 'asc'
          ? collator.compare(valueA, valueB)
          : collator.compare(valueB, valueA)
      })
    } else {
      filtered = sortArrayByProperty(
        filtered as any[],
        sortedCol.key as keyof ISongInfo,
        sortedCol.order!
      )
    }
  }

  visibleSongs.value = filtered
}

const handleColumnsUpdate = (nextColumns: ISongsAreaColumn[]) => {
  columnData.value = nextColumns
  applyFiltersAndSorting()
  selectedRowKeys.value = []
}

const handleColumnClick = (column: ISongsAreaColumn) => {
  if (column.key === 'cover' || column.key === 'waveformPreview') return
  columnData.value = columnData.value.map((item) => {
    if (item.key !== column.key) return { ...item, order: undefined }
    const nextOrder = item.order === 'asc' ? 'desc' : item.order === 'desc' ? 'asc' : 'asc'
    return { ...item, order: nextOrder as 'asc' | 'desc' }
  })
  applyFiltersAndSorting()
}

const loadPlaylistTracks = async () => {
  if (!selectedDrivePath.value || !selectedPlaylistId.value) {
    originalTracks.value = []
    visibleSongs.value = []
    selectedRowKeys.value = []
    return
  }
  loading.value = true
  selectedRowKeys.value = []
  try {
    const result = await window.electron.ipcRenderer.invoke(
      'pioneer-device-library:load-playlist-tracks',
      selectedDrivePath.value,
      selectedPlaylistId.value
    )
    originalTracks.value = Array.isArray(result?.tracks) ? result.tracks : []
    applyFiltersAndSorting()
  } catch (error) {
    console.error('[pioneerSongsArea] load playlist tracks failed', error)
    originalTracks.value = []
    visibleSongs.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => [selectedDrivePath.value, selectedPlaylistId.value] as const,
  () => {
    try {
      emitter.emit('waveform-preview:stop', { reason: 'switch' })
    } catch {}
    void loadPlaylistTracks()
  },
  { immediate: true }
)

watch(
  () => runtime.setting.keyDisplayStyle,
  () => {
    applyFiltersAndSorting()
  }
)

const handleSongClick = (_event: MouseEvent, song: ISongInfo) => {
  const key = song.mixtapeItemId || song.filePath
  if (!key) return
  selectedRowKeys.value = [key]
}

const openCopyTargetDialog = (libraryName: PioneerTransferTarget) => {
  selectSongListDialogTargetLibraryName.value = libraryName
  selectSongListDialogVisible.value = true
}

const handleSongContextMenu = async (event: MouseEvent, song: ISongInfo) => {
  const key = song.mixtapeItemId || song.filePath
  if (!key) return
  if (!selectedRowKeys.value.includes(key)) {
    selectedRowKeys.value = [key]
  }

  const result = await rightClickMenu({
    menuArr: pioneerSongMenuArr,
    clickEvent: event
  })
  if (result === 'cancel') return

  const selectedTracks = resolveSelectedTracks(song)
  if (!selectedTracks.length) return

  switch (result.menuName) {
    case 'library.copyToCurated':
      openCopyTargetDialog('CuratedLibrary')
      return
    case 'library.copyToFilter':
      openCopyTargetDialog('FilterLibrary')
      return
    case 'library.addToMixtapeByCopy':
      openCopyTargetDialog('MixtapeLibrary')
      return
    case 'fingerprints.analyzeAndAdd':
      await analyzeFingerprintsForPaths(
        selectedTracks.map((item) => item.filePath),
        {
          origin: 'selection'
        }
      )
      return
    case 'tracks.exportTracksCopyOnly': {
      const exportResult = await exportDialog({
        title: 'tracks.title',
        forceCopyOnly: true
      })
      if (exportResult === 'cancel') return
      await window.electron.ipcRenderer.invoke(
        'exportSongsToDir',
        exportResult.folderPathVal,
        false,
        JSON.parse(JSON.stringify(selectedTracks))
      )
      return
    }
    case 'tracks.showInFileExplorer':
      window.electron.ipcRenderer.send('show-item-in-folder', selectedTracks[0]?.filePath)
      return
  }
}

const requestImmediateAnalysis = (song: ISongInfo) => {
  const filePath = song?.filePath
  if (!filePath) return
  try {
    window.electron.ipcRenderer.send('key-analysis:queue-playing', { filePath })
  } catch {}
}

const handleSongDblClick = (song: ISongInfo) => {
  const playbackListKey = currentPlaybackListKey.value
  if (!playbackListKey) return
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  runtime.activeMenuUUID = ''
  selectedRowKeys.value = []

  const normalizedSong = { ...song }
  requestImmediateAnalysis(normalizedSong)
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
  selectSongListDialogVisible.value = false
  selectSongListDialogTargetLibraryName.value = ''
  const selectedTracks = resolveSelectedTracks()
  if (!selectedTracks.length || !targetLibraryName) return

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
    await window.electron.ipcRenderer.invoke(
      'moveSongsToDir',
      selectedTracks.map((item) => item.filePath),
      targetDirPath,
      { mode: 'copy' }
    )
    emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
  } catch (error: any) {
    const messageCode = String(error?.message || '')
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
}

const placeholderText = computed(() => {
  if (loading.value) return t('pioneer.loadingPlaylistTracks')
  if (!selectedPlaylistId.value) return t('pioneer.selectPlaylistPrompt')
  if (!visibleSongs.value.length) return t('pioneer.emptyPlaylist')
  return ''
})
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
      defer
      @click="selectedRowKeys = []"
    >
      <SongListHeader
        :columns="columnData"
        :t="t"
        :ascending-order="ascendingOrder"
        :descending-order="descendingOrder"
        :total-width="totalWidth"
        @update:columns="handleColumnsUpdate"
        @column-click="handleColumnClick"
        @header-contextmenu.stop.prevent
      />

      <SongListRows
        :songs="visibleSongs"
        :visible-columns="visibleColumns"
        :selected-song-file-paths="selectedRowKeys"
        :playing-song-file-path="playingSongFilePathForRows"
        :flash-row-key="''"
        :flash-row-token="0"
        :total-width="totalWidth"
        source-library-name="PioneerDeviceLibrary"
        :source-song-list-u-u-i-d="currentPlaybackListKey || `pioneer:${selectedPlaylistId}`"
        :scroll-host-element="songsAreaRef?.osInstance()?.elements().viewport"
        :external-scroll-top="externalScrollTop"
        :external-viewport-height="externalViewportHeight"
        :pioneer-device-root-path="selectedDrivePath"
        :read-only="true"
        :allow-context-menu-when-read-only="true"
        :allow-dblclick-when-read-only="true"
        :allow-waveform-preview-when-read-only="true"
        :enable-cover-thumbnails="true"
        :enable-key-analysis-queue="false"
        @song-click="handleSongClick"
        @song-contextmenu="handleSongContextMenu"
        @song-dblclick="handleSongDblClick"
      />
    </OverlayScrollbarsComponent>
    <Teleport to="body">
      <selectSongListDialog
        v-if="selectSongListDialogVisible"
        :library-name="selectSongListDialogTargetLibraryName"
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
