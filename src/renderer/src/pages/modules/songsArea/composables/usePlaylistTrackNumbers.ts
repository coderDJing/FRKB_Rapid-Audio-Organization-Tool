import { computed, markRaw, ref, type Ref, type ShallowRef } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'
import { t } from '@renderer/utils/translate'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'

type UsePlaylistTrackNumbersParams = {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  columnData: Ref<ISongsAreaColumn[]>
  isRequesting: Ref<boolean>
  applyFiltersAndSorting: () => void
  resolveCoreLibraryNameBySongListUUID: (uuid: string) => string
}

const normalizePath = (value: string | undefined | null) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const normalizePlaylistTrackNumber = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.floor(numeric)
  return rounded > 0 ? rounded : undefined
}

const buildNumberMap = (orderedFilePaths: string[]) =>
  new Map(orderedFilePaths.map((filePath, index) => [normalizePath(filePath), index + 1]))

export const usePlaylistTrackNumbers = (params: UsePlaylistTrackNumbersParams) => {
  const {
    runtime,
    songsAreaState,
    originalSongInfoArr,
    columnData,
    isRequesting,
    applyFiltersAndSorting,
    resolveCoreLibraryNameBySongListUUID
  } = params

  const trackNumberMutationPending = ref(false)

  const isSupportedPlaylistTrackNumberList = computed(() => {
    const libraryName = resolveCoreLibraryNameBySongListUUID(songsAreaState.songListUUID)
    const nodeType = libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type
    return (
      nodeType === 'songList' &&
      (libraryName === 'FilterLibrary' || libraryName === 'CuratedLibrary')
    )
  })

  const hasActiveTrackFilters = computed(() =>
    columnData.value.some((column) => Boolean(column.filterActive))
  )

  const sortedTrackColumn = computed(
    () => columnData.value.find((column) => Boolean(column.order)) || null
  )

  const canReorderPlaylistTracks = computed(
    () =>
      isSupportedPlaylistTrackNumberList.value &&
      !isRequesting.value &&
      !trackNumberMutationPending.value &&
      songsAreaState.songInfoArr.length > 1 &&
      !hasActiveTrackFilters.value &&
      Boolean(sortedTrackColumn.value?.key === 'index' && sortedTrackColumn.value.order)
  )

  const canRenumberPlaylistTracks = computed(
    () =>
      isSupportedPlaylistTrackNumberList.value &&
      !isRequesting.value &&
      !trackNumberMutationPending.value &&
      songsAreaState.songInfoArr.length > 1 &&
      !hasActiveTrackFilters.value &&
      Boolean(sortedTrackColumn.value) &&
      sortedTrackColumn.value?.key !== 'index'
  )

  const syncPlayingSongListSnapshot = () => {
    if (runtime.playingData.playingSongListUUID !== songsAreaState.songListUUID) return
    runtime.playingData.playingSongListData = [...songsAreaState.songInfoArr]
    const currentPlayingSong = runtime.playingData.playingSong
    if (!currentPlayingSong?.filePath) return
    const matchedSong = songsAreaState.songInfoArr.find(
      (song) => normalizePath(song.filePath) === normalizePath(currentPlayingSong.filePath)
    )
    if (!matchedSong) return
    runtime.playingData.playingSong = {
      ...currentPlayingSong,
      playlistTrackNumber: matchedSong.playlistTrackNumber
    }
  }

  const isSameOrderAsCurrentTrackNumbers = (orderedFilePaths: string[]) => {
    const currentOrderedFilePaths = originalSongInfoArr.value
      .map((song) => song.filePath)
      .filter(Boolean)
    if (currentOrderedFilePaths.length !== orderedFilePaths.length) return false
    return currentOrderedFilePaths.every(
      (filePath, index) => normalizePath(filePath) === normalizePath(orderedFilePaths[index])
    )
  }

  const applyOptimisticTrackNumbers = (orderedFilePaths: string[]) => {
    const numberMap = buildNumberMap(orderedFilePaths)
    const songMap = new Map(
      originalSongInfoArr.value.map((song) => [normalizePath(song.filePath), song] as const)
    )
    const nextSongs: ISongInfo[] = []
    const used = new Set<string>()
    for (const filePath of orderedFilePaths) {
      const normalizedPath = normalizePath(filePath)
      const song = songMap.get(normalizedPath)
      if (!song || used.has(normalizedPath)) continue
      used.add(normalizedPath)
      const nextNumber = numberMap.get(normalizedPath)
      nextSongs.push({
        ...song,
        playlistTrackNumber: nextNumber
      })
    }
    for (const song of originalSongInfoArr.value) {
      const normalizedPath = normalizePath(song.filePath)
      if (used.has(normalizedPath)) continue
      nextSongs.push({ ...song })
    }
    originalSongInfoArr.value = markRaw(nextSongs)
    applyFiltersAndSorting()
    syncPlayingSongListSnapshot()
  }

  const restoreSnapshot = (snapshot: ISongInfo[]) => {
    originalSongInfoArr.value = markRaw(snapshot.map((song) => ({ ...song })))
    applyFiltersAndSorting()
    syncPlayingSongListSnapshot()
  }

  const showTrackNumberError = async (error: unknown) => {
    const message =
      error instanceof Error && error.message.trim() ? error.message : t('common.unknownError')
    await confirm({
      title: t('common.error'),
      content: [message],
      confirmShow: false
    })
  }

  const persistTrackNumbers = async (orderedFilePaths: string[]) => {
    const songListPath = libraryUtils.findDirPathByUuid(songsAreaState.songListUUID)
    if (!songListPath) {
      throw new Error('目标歌单路径不存在')
    }
    const isNoop = isSameOrderAsCurrentTrackNumbers(orderedFilePaths)
    if (isNoop) {
      try {
        emitter.emit('songsArea/clipboardHint', {
          message: t('tracks.playlistTrackNumbersAlreadyMatchHint')
        })
      } catch {}
      return
    }
    trackNumberMutationPending.value = true
    const snapshotBeforeUpdate = originalSongInfoArr.value.map((song) => ({ ...song }))
    try {
      applyOptimisticTrackNumbers(orderedFilePaths)
      const result = await window.electron.ipcRenderer.invoke('songList:reorder-track-numbers', {
        songListPath,
        orderedFilePaths
      })
      if (!result?.updated || Number(result?.total || 0) <= 0) {
        throw new Error('真实序号写入失败')
      }
      try {
        emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
        emitter.emit('songsArea/clipboardHint', {
          message: t('tracks.playlistTrackNumbersRenumberedHint', {
            count: orderedFilePaths.length
          })
        })
      } catch {}
    } catch (error) {
      restoreSnapshot(snapshotBeforeUpdate)
      await showTrackNumberError(error)
    } finally {
      trackNumberMutationPending.value = false
    }
  }

  const buildReorderedVisibleSongs = (sourceItemIds: string[], targetIndex: number) => {
    const normalizedSourceSet = new Set(
      sourceItemIds.map((itemId) => normalizePath(itemId)).filter(Boolean)
    )
    const currentVisibleSongs = [...songsAreaState.songInfoArr]
    const moving = currentVisibleSongs.filter((song) =>
      normalizedSourceSet.has(normalizePath(song.filePath))
    )
    if (moving.length === 0) return null
    const remaining = currentVisibleSongs.filter(
      (song) => !normalizedSourceSet.has(normalizePath(song.filePath))
    )
    let insertIndex = remaining.length
    if (targetIndex <= 0) {
      insertIndex = 0
    } else if (targetIndex < currentVisibleSongs.length) {
      const movingBefore = currentVisibleSongs
        .slice(0, Math.min(targetIndex, currentVisibleSongs.length))
        .filter((song) => normalizedSourceSet.has(normalizePath(song.filePath))).length
      insertIndex = Math.max(0, Math.min(remaining.length, targetIndex - movingBefore))
    }
    return [...remaining.slice(0, insertIndex), ...moving, ...remaining.slice(insertIndex)]
  }

  const handlePlaylistReorder = async (payload: {
    sourceItemIds: string[]
    targetIndex: number
  }) => {
    if (!canReorderPlaylistTracks.value) return
    const reorderedVisibleSongs = buildReorderedVisibleSongs(
      payload.sourceItemIds,
      payload.targetIndex
    )
    if (!reorderedVisibleSongs) return
    const isDescending = sortedTrackColumn.value?.order === 'desc'
    const orderedFilePaths = (
      isDescending ? [...reorderedVisibleSongs].reverse() : reorderedVisibleSongs
    )
      .map((song) => song.filePath)
      .filter(Boolean)
    await persistTrackNumbers(orderedFilePaths)
  }

  const handleRenumberTracksByVisibleOrder = async () => {
    if (!canRenumberPlaylistTracks.value) return
    const orderedFilePaths = songsAreaState.songInfoArr.map((song) => song.filePath).filter(Boolean)
    await persistTrackNumbers(orderedFilePaths)
  }

  return {
    trackNumberMutationPending,
    canReorderPlaylistTracks,
    canRenumberPlaylistTracks,
    handlePlaylistReorder,
    handleRenumberTracksByVisibleOrder
  }
}
