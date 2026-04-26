import { onMounted, onUnmounted, watch, markRaw, triggerRef } from 'vue'
import emitter from '@renderer/utils/mitt'
import type { ShallowRef } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from '../../../../../../types/globals'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { areSongHotCuesEqual, normalizeSongHotCues } from '@shared/hotCues'
import { areSongMemoryCuesEqual, normalizeSongMemoryCues } from '@shared/memoryCues'
import libraryUtils from '@renderer/utils/libraryUtils'

const normalizePath = (p: string | undefined | null) => (p || '').replace(/\//g, '\\').toLowerCase()

interface UseSongsAreaEventsParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  applyFiltersAndSorting: () => void
  shouldApplyFiltersAndSortingForSongChange: (fields: string[]) => boolean
  openSongList: () => Promise<void>
  scheduleSweepCovers: () => void
}

export function useSongsAreaEvents(params: UseSongsAreaEventsParams) {
  const {
    runtime,
    songsAreaState,
    originalSongInfoArr,
    applyFiltersAndSorting,
    shouldApplyFiltersAndSortingForSongChange,
    openSongList,
    scheduleSweepCovers
  } = params

  const onSongsOptimisticallyRemoved = (payload: { listUUID?: string; paths?: string[] }) => {
    const listUUID = payload?.listUUID
    const currentListUUID = songsAreaState.songListUUID
    if (listUUID && listUUID !== currentListUUID) return
    const pathsToRemove: string[] = Array.isArray(payload?.paths) ? payload.paths : []
    if (!pathsToRemove.length) return
    const normalizedSet = new Set<string>(
      pathsToRemove.map((p: string) => normalizePath(p)).filter(Boolean)
    )
    const hasIntersection = originalSongInfoArr.value.some((s) =>
      normalizedSet.has(normalizePath(s.filePath))
    )
    if (!hasIntersection) return

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (song) => !normalizedSet.has(normalizePath(song.filePath))
    )
    applyFiltersAndSorting()

    if (runtime.playingData.playingSongListUUID === currentListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
    }

    songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
      (path) => !normalizedSet.has(normalizePath(path))
    )
    scheduleSweepCovers()
  }

  const onSongsOptimisticallyRestored = (payload: {
    listUUID?: string
    items?: Array<{ song: ISongInfo; index: number }>
  }) => {
    const listUUID = payload?.listUUID
    const currentListUUID = songsAreaState.songListUUID
    if (listUUID && listUUID !== currentListUUID) return
    const items = Array.isArray(payload?.items) ? payload.items : []
    if (!items.length) return

    const current = [...originalSongInfoArr.value]
    const existingSet = new Set(current.map((song) => normalizePath(song.filePath)))
    const filteredItems = items
      .filter(
        (item): item is { song: ISongInfo; index: number } =>
          !!item?.song && typeof item.index === 'number' && Number.isFinite(item.index)
      )
      .filter((item) => !existingSet.has(normalizePath(item.song.filePath)))
      .sort((left, right) => left.index - right.index)
    if (!filteredItems.length) return

    const totalLength = current.length + filteredItems.length
    const restoreBuckets = new Map<number, ISongInfo[]>()
    for (const item of filteredItems) {
      const targetIndex = Math.max(0, Math.min(totalLength, Math.floor(item.index)))
      const bucket = restoreBuckets.get(targetIndex) || []
      bucket.push({ ...item.song })
      restoreBuckets.set(targetIndex, bucket)
    }

    const rebuilt: ISongInfo[] = []
    let currentIndex = 0
    for (let index = 0; index < totalLength; index++) {
      const bucket = restoreBuckets.get(index)
      if (bucket?.length) {
        rebuilt.push(...bucket)
        continue
      }
      const currentSong = current[currentIndex]
      if (currentSong) {
        rebuilt.push(currentSong)
        currentIndex += 1
      }
    }
    const trailingBucket = restoreBuckets.get(totalLength)
    if (trailingBucket?.length) {
      rebuilt.push(...trailingBucket)
    }
    while (currentIndex < current.length) {
      rebuilt.push(current[currentIndex])
      currentIndex += 1
    }

    originalSongInfoArr.value = markRaw(rebuilt)
    applyFiltersAndSorting()

    if (runtime.playingData.playingSongListUUID === currentListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
    }

    scheduleSweepCovers()
  }

  const onSongsRemoved = (payload: { listUUID?: string; paths?: string[]; itemIds?: string[] }) => {
    const listUUID = payload?.listUUID
    const itemIds: string[] = Array.isArray(payload?.itemIds) ? payload.itemIds : []
    const currentListUUID = songsAreaState.songListUUID
    const isMixtapeView = libraryUtils.getLibraryTreeByUUID(currentListUUID)?.type === 'mixtapeList'

    if (itemIds.length > 0) {
      if (!isMixtapeView) return
      if (listUUID && listUUID !== currentListUUID) return
      const idSet = new Set(itemIds)
      const hasIntersection = originalSongInfoArr.value.some((s) =>
        idSet.has(s.mixtapeItemId || '')
      )
      if (!hasIntersection) return

      originalSongInfoArr.value = originalSongInfoArr.value.filter(
        (song) => !idSet.has(song.mixtapeItemId || '')
      )
      applyFiltersAndSorting()

      if (runtime.playingData.playingSongListUUID === currentListUUID) {
        runtime.playingData.playingSongListData = songsAreaState.songInfoArr
        if (
          runtime.playingData.playingSong &&
          idSet.has(runtime.playingData.playingSong.mixtapeItemId || '')
        ) {
          runtime.playingData.playingSong = null
        }
      }

      songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
        (key) => !idSet.has(key)
      )

      scheduleSweepCovers()
      return
    }

    const pathsToRemove: string[] = Array.isArray(payload?.paths) ? payload.paths : []
    const normalizedSet = new Set<string>(
      pathsToRemove.map((p: string) => normalizePath(p)).filter(Boolean)
    )
    const hasIntersection = originalSongInfoArr.value.some((s) =>
      normalizedSet.has(normalizePath(s.filePath))
    )

    if (!pathsToRemove.length) return
    // 任意视图：仅在当前列表与要移除的路径存在交集时才更新，避免误删与不必要重建
    if (!hasIntersection) return

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (song) => !normalizedSet.has(normalizePath(song.filePath))
    )

    applyFiltersAndSorting()

    if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
      if (
        runtime.playingData.playingSong &&
        normalizedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
      ) {
        runtime.playingData.playingSong = null
      }
    }

    songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
      (path) => !normalizedSet.has(normalizePath(path))
    )

    scheduleSweepCovers()
  }

  const onSongsMovedByDrag = (movedSongPaths: string[]) => {
    if (libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'mixtapeList') {
      return
    }
    if (!Array.isArray(movedSongPaths) || movedSongPaths.length === 0) return
    const normalizedMovedSet = new Set(
      movedSongPaths.map((path) => normalizePath(path)).filter(Boolean)
    )

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (song) => !normalizedMovedSet.has(normalizePath(song.filePath))
    )
    applyFiltersAndSorting()
    scheduleSweepCovers()

    if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
      if (
        runtime.playingData.playingSong &&
        normalizedMovedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
      ) {
        runtime.playingData.playingSong = null
      }
    }

    songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
      (path) => !normalizedMovedSet.has(normalizePath(path))
    )
  }

  const onExternalPlaylistRefresh = () => {
    if (songsAreaState.songListUUID !== EXTERNAL_PLAYLIST_UUID) return
    const songs = runtime.externalPlaylist.songs || []
    originalSongInfoArr.value = markRaw([...songs])
    applyFiltersAndSorting()
    scheduleSweepCovers()
  }

  let keyUpdateScheduled = false
  type SongPatchFn = (song: ISongInfo) => ISongInfo
  const scheduleApply = () => {
    if (keyUpdateScheduled) return
    keyUpdateScheduled = true
    requestAnimationFrame(() => {
      keyUpdateScheduled = false
      applyFiltersAndSorting()
    })
  }

  const scheduleApplyIfNeeded = (fields: string[]) => {
    if (!shouldApplyFiltersAndSortingForSongChange(fields)) return
    scheduleApply()
  }

  const findSongIndexByPath = (songs: readonly ISongInfo[], normalizedTargetPath: string) => {
    for (let index = 0; index < songs.length; index += 1) {
      if (normalizePath(songs[index]?.filePath) === normalizedTargetPath) {
        return index
      }
    }
    return -1
  }

  const patchSongListAtIndex = (songs: ISongInfo[], index: number, patch: SongPatchFn) => {
    if (index < 0 || index >= songs.length) return false
    const currentSong = songs[index]
    if (!currentSong) return false
    const nextSong = patch(currentSong)
    if (nextSong === currentSong) return false
    songs[index] = nextSong
    return true
  }

  const patchSongListByPath = (
    songs: ISongInfo[] | null | undefined,
    normalizedTargetPath: string,
    patch: SongPatchFn
  ) => {
    if (!songs?.length) return false
    const targetIndex = findSongIndexByPath(songs, normalizedTargetPath)
    return patchSongListAtIndex(songs, targetIndex, patch)
  }

  const patchOriginalSongByPath = (normalizedTargetPath: string, patch: SongPatchFn) => {
    const touched = patchSongListByPath(originalSongInfoArr.value, normalizedTargetPath, patch)
    if (touched) {
      triggerRef(originalSongInfoArr)
    }
    return touched
  }

  const patchSongsAreaSongByPath = (normalizedTargetPath: string, patch: SongPatchFn) =>
    patchSongListByPath(songsAreaState.songInfoArr, normalizedTargetPath, patch)

  const patchPlayingSongListByPath = (normalizedTargetPath: string, patch: SongPatchFn) => {
    if (runtime.playingData.playingSongListData === songsAreaState.songInfoArr) return false
    return patchSongListByPath(runtime.playingData.playingSongListData, normalizedTargetPath, patch)
  }

  const patchExternalPlaylistSongByPath = (normalizedTargetPath: string, patch: SongPatchFn) =>
    patchSongListByPath(runtime.externalPlaylist.songs, normalizedTargetPath, patch)

  const patchPlayingSongByPath = (normalizedTargetPath: string, patch: SongPatchFn) => {
    const currentPlayingSong = runtime.playingData.playingSong
    if (!currentPlayingSong) return false
    if (normalizePath(currentPlayingSong.filePath) !== normalizedTargetPath) return false
    const nextPlayingSong = patch(currentPlayingSong)
    if (nextPlayingSong === currentPlayingSong) return false
    runtime.playingData.playingSong = nextPlayingSong
    return true
  }

  const onSongKeyUpdated = (_e: unknown, payload: { filePath?: string; keyText?: string }) => {
    const filePath = payload?.filePath
    const keyText = payload?.keyText
    if (!filePath || typeof keyText !== 'string') return
    const normalizedTargetPath = normalizePath(filePath)

    const applyKeyPatch = (song: ISongInfo): ISongInfo =>
      song.key === keyText
        ? song
        : {
            ...song,
            key: keyText
          }

    if (patchOriginalSongByPath(normalizedTargetPath, applyKeyPatch)) {
      scheduleApplyIfNeeded(['key'])
    }

    patchSongsAreaSongByPath(normalizedTargetPath, applyKeyPatch)
    patchPlayingSongByPath(normalizedTargetPath, applyKeyPatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyKeyPatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyKeyPatch)
  }

  const onSongBpmUpdated = (
    _e: unknown,
    payload: {
      filePath?: string
      bpm?: number
      beatThisEstimatedDrift128Ms?: number | null
      beatThisWindowCount?: number | null
    }
  ) => {
    const filePath = payload?.filePath
    const bpmValue = payload?.bpm
    if (!filePath || typeof bpmValue !== 'number' || !Number.isFinite(bpmValue)) return
    const normalizedTargetPath = normalizePath(filePath)
    const hasBeatThisEstimatedDrift128Ms = Object.prototype.hasOwnProperty.call(
      payload,
      'beatThisEstimatedDrift128Ms'
    )
    const hasBeatThisWindowCount = Object.prototype.hasOwnProperty.call(
      payload,
      'beatThisWindowCount'
    )

    const applyBpmPatch = (song: ISongInfo): ISongInfo => {
      let touched = false
      const nextSong: ISongInfo = song.bpm === bpmValue ? song : { ...song, bpm: bpmValue }
      if (nextSong !== song) {
        touched = true
      }
      if (hasBeatThisEstimatedDrift128Ms) {
        const nextValue =
          typeof payload?.beatThisEstimatedDrift128Ms === 'number' &&
          Number.isFinite(payload.beatThisEstimatedDrift128Ms)
            ? payload.beatThisEstimatedDrift128Ms
            : undefined
        if (nextSong.beatThisEstimatedDrift128Ms !== nextValue) {
          if (!touched) {
            touched = true
          }
          nextSong.beatThisEstimatedDrift128Ms = nextValue
        }
      }
      if (hasBeatThisWindowCount) {
        const nextValue =
          typeof payload?.beatThisWindowCount === 'number' &&
          Number.isFinite(payload.beatThisWindowCount)
            ? payload.beatThisWindowCount
            : undefined
        if (nextSong.beatThisWindowCount !== nextValue) {
          if (!touched) {
            touched = true
          }
          nextSong.beatThisWindowCount = nextValue
        }
      }
      return touched ? nextSong : song
    }

    if (patchOriginalSongByPath(normalizedTargetPath, applyBpmPatch)) {
      scheduleApplyIfNeeded(
        [
          'bpm',
          hasBeatThisEstimatedDrift128Ms ? 'beatThisEstimatedDrift128Ms' : '',
          hasBeatThisWindowCount ? 'beatThisWindowCount' : ''
        ].filter(Boolean)
      )
    }

    patchSongsAreaSongByPath(normalizedTargetPath, applyBpmPatch)
    patchPlayingSongByPath(normalizedTargetPath, applyBpmPatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyBpmPatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyBpmPatch)
  }

  const onSongGridUpdated = (
    _e: unknown,
    payload: {
      filePath?: string
      bpm?: number
      firstBeatMs?: number
      barBeatOffset?: number
      timeBasisOffsetMs?: number
    }
  ) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return
    const normalizedTargetPath = normalizePath(filePath)

    const hasBpm = typeof payload?.bpm === 'number' && Number.isFinite(payload.bpm)
    const hasFirstBeatMs =
      typeof payload?.firstBeatMs === 'number' && Number.isFinite(payload.firstBeatMs)
    const hasBarBeatOffset =
      typeof payload?.barBeatOffset === 'number' && Number.isFinite(payload.barBeatOffset)
    const hasTimeBasisOffsetMs =
      typeof payload?.timeBasisOffsetMs === 'number' && Number.isFinite(payload.timeBasisOffsetMs)
    if (!hasBpm && !hasFirstBeatMs && !hasBarBeatOffset && !hasTimeBasisOffsetMs) return
    const changedFields = [
      hasBpm ? 'bpm' : '',
      hasFirstBeatMs ? 'firstBeatMs' : '',
      hasBarBeatOffset ? 'barBeatOffset' : '',
      hasTimeBasisOffsetMs ? 'timeBasisOffsetMs' : ''
    ].filter(Boolean)

    const applyGridPatch = (song: ISongInfo): ISongInfo => {
      let touched = false
      const nextSong: ISongInfo = { ...song }
      if (hasBpm && nextSong.bpm !== payload.bpm) {
        nextSong.bpm = payload.bpm
        touched = true
      }
      if (hasFirstBeatMs && nextSong.firstBeatMs !== payload.firstBeatMs) {
        nextSong.firstBeatMs = payload.firstBeatMs
        touched = true
      }
      if (hasBarBeatOffset && nextSong.barBeatOffset !== payload.barBeatOffset) {
        nextSong.barBeatOffset = payload.barBeatOffset
        touched = true
      }
      if (hasTimeBasisOffsetMs && nextSong.timeBasisOffsetMs !== payload.timeBasisOffsetMs) {
        nextSong.timeBasisOffsetMs = payload.timeBasisOffsetMs
        touched = true
      }
      return touched ? nextSong : song
    }

    if (patchOriginalSongByPath(normalizedTargetPath, applyGridPatch)) {
      scheduleApplyIfNeeded(changedFields)
    }

    patchSongsAreaSongByPath(normalizedTargetPath, applyGridPatch)
    patchPlayingSongByPath(normalizedTargetPath, applyGridPatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyGridPatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyGridPatch)
  }

  const onSongHotCuesUpdated = (
    _e: unknown,
    payload: {
      filePath?: string
      hotCues?: ISongHotCue[]
    }
  ) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return
    const normalizedTargetPath = normalizePath(filePath)
    const normalizedHotCues = normalizeSongHotCues(payload?.hotCues)

    const applyHotCuePatch = (song: ISongInfo): ISongInfo => {
      if (areSongHotCuesEqual(song.hotCues, normalizedHotCues)) return song
      return {
        ...song,
        hotCues: normalizedHotCues
      }
    }

    patchOriginalSongByPath(normalizedTargetPath, applyHotCuePatch)
    patchSongsAreaSongByPath(normalizedTargetPath, applyHotCuePatch)
    patchPlayingSongByPath(normalizedTargetPath, applyHotCuePatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyHotCuePatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyHotCuePatch)
  }

  const onSongMemoryCuesUpdated = (
    _e: unknown,
    payload: {
      filePath?: string
      memoryCues?: ISongMemoryCue[]
    }
  ) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return
    const normalizedTargetPath = normalizePath(filePath)
    const normalizedMemoryCues = normalizeSongMemoryCues(payload?.memoryCues)

    const applyMemoryCuePatch = (song: ISongInfo): ISongInfo => {
      if (areSongMemoryCuesEqual(song.memoryCues, normalizedMemoryCues)) return song
      return {
        ...song,
        memoryCues: normalizedMemoryCues
      }
    }

    patchOriginalSongByPath(normalizedTargetPath, applyMemoryCuePatch)
    patchSongsAreaSongByPath(normalizedTargetPath, applyMemoryCuePatch)
    patchPlayingSongByPath(normalizedTargetPath, applyMemoryCuePatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyMemoryCuePatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyMemoryCuePatch)
  }

  const onImportFinished = async (_event: unknown, songListUUID: string, _summary: unknown) => {
    if (songListUUID === songsAreaState.songListUUID) {
      setTimeout(async () => {
        await openSongList()
        // 通知库侧刷新歌单曲目数量徽标
        try {
          emitter.emit('playlistContentChanged', { uuids: [songListUUID] })
        } catch {}
      }, 1000)
      return
    }
    try {
      emitter.emit('playlistContentChanged', { uuids: [songListUUID] })
    } catch {}
  }

  const onAudioConvertDone = async (_event: unknown, payload?: { songListUUID?: string }) => {
    const listUUID = payload?.songListUUID
    if (!listUUID) return
    if (listUUID === songsAreaState.songListUUID) {
      setTimeout(async () => {
        await openSongList()
        try {
          emitter.emit('playlistContentChanged', { uuids: [listUUID] })
        } catch {}
      }, 300)
      return
    }
    try {
      emitter.emit('playlistContentChanged', { uuids: [listUUID] })
    } catch {}
  }

  onMounted(() => {
    emitter.on('songsArea/optimistic-remove', onSongsOptimisticallyRemoved)
    emitter.on('songsArea/optimistic-restore', onSongsOptimisticallyRestored)
    emitter.on('songsRemoved', onSongsRemoved)
    emitter.on('songsMovedByDrag', onSongsMovedByDrag)
    emitter.on('external-playlist/refresh', onExternalPlaylistRefresh)
    window.electron.ipcRenderer.on('song-key-updated', onSongKeyUpdated)
    window.electron.ipcRenderer.on('song-bpm-updated', onSongBpmUpdated)
    window.electron.ipcRenderer.on('song-grid-updated', onSongGridUpdated)
    window.electron.ipcRenderer.on('song-hot-cues-updated', onSongHotCuesUpdated)
    window.electron.ipcRenderer.on('song-memory-cues-updated', onSongMemoryCuesUpdated)
    window.electron.ipcRenderer.on('importFinished', onImportFinished)
    window.electron.ipcRenderer.on('audio:convert:done', onAudioConvertDone)
  })

  onUnmounted(() => {
    emitter.off('songsArea/optimistic-remove', onSongsOptimisticallyRemoved)
    emitter.off('songsArea/optimistic-restore', onSongsOptimisticallyRestored)
    emitter.off('songsRemoved', onSongsRemoved)
    emitter.off('songsMovedByDrag', onSongsMovedByDrag)
    emitter.off('external-playlist/refresh', onExternalPlaylistRefresh)
    window.electron.ipcRenderer.removeListener('song-key-updated', onSongKeyUpdated)
    window.electron.ipcRenderer.removeListener('song-bpm-updated', onSongBpmUpdated)
    window.electron.ipcRenderer.removeListener('song-grid-updated', onSongGridUpdated)
    window.electron.ipcRenderer.removeListener('song-hot-cues-updated', onSongHotCuesUpdated)
    window.electron.ipcRenderer.removeListener('song-memory-cues-updated', onSongMemoryCuesUpdated)
    window.electron.ipcRenderer.removeListener('importFinished', onImportFinished)
    window.electron.ipcRenderer.removeListener('audio:convert:done', onAudioConvertDone)
  })

  // 切换歌单时刷新列表
  watch(
    () => songsAreaState.songListUUID,
    async (newUUID) => {
      songsAreaState.selectedSongFilePath.length = 0
      if (newUUID) {
        if (newUUID === EXTERNAL_PLAYLIST_UUID) {
          const songs = runtime.externalPlaylist.songs || []
          originalSongInfoArr.value = markRaw([...songs])
          applyFiltersAndSorting()
          scheduleSweepCovers()
        } else {
          await openSongList()
        }
      } else {
        songsAreaState.songInfoArr = []
        songsAreaState.totalSongCount = 0
        originalSongInfoArr.value = []
      }
    }
  )

  // 同步 songsArea 与 playingData.playingSongListData
  watch(
    () => runtime.playingData.playingSongListData,
    (newPlayingListData) => {
      const currentSongsAreaListUUID = songsAreaState.songListUUID
      const currentPlayingListUUID = runtime.playingData.playingSongListUUID

      if (currentSongsAreaListUUID && currentSongsAreaListUUID === currentPlayingListUUID) {
        const songsInArea = songsAreaState.songInfoArr
        if (!songsInArea || songsInArea.length === 0) return

        const areaFilePaths = new Set(songsInArea.map((s) => s.filePath))
        const playingListFilePaths = new Set((newPlayingListData || []).map((s) => s.filePath))

        const pathsToRemove: string[] = []
        areaFilePaths.forEach((filePath) => {
          if (!playingListFilePaths.has(filePath)) {
            pathsToRemove.push(filePath)
          }
        })

        if (pathsToRemove.length > 0) {
          originalSongInfoArr.value = originalSongInfoArr.value.filter(
            (item) => !pathsToRemove.includes(item.filePath)
          )
          applyFiltersAndSorting()
          songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
            (path) => !pathsToRemove.includes(path)
          )
        }
      }
    },
    { deep: true }
  )
}
