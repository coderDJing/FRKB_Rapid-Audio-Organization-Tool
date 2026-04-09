import { onMounted, onUnmounted, watch, markRaw } from 'vue'
import emitter from '@renderer/utils/mitt'
import type { ShallowRef } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import libraryUtils from '@renderer/utils/libraryUtils'

const normalizePath = (p: string | undefined | null) => (p || '').replace(/\//g, '\\').toLowerCase()

interface UseSongsAreaEventsParams {
  runtime: ReturnType<typeof useRuntimeStore>
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  applyFiltersAndSorting: () => void
  openSongList: () => Promise<void>
  scheduleSweepCovers: () => void
}

export function useSongsAreaEvents(params: UseSongsAreaEventsParams) {
  const {
    runtime,
    originalSongInfoArr,
    applyFiltersAndSorting,
    openSongList,
    scheduleSweepCovers
  } = params

  const onSongsOptimisticallyRemoved = (payload: { listUUID?: string; paths?: string[] }) => {
    const listUUID = payload?.listUUID
    const currentListUUID = runtime.songsArea.songListUUID
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
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }

    runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
      (path) => !normalizedSet.has(normalizePath(path))
    )
    scheduleSweepCovers()
  }

  const onSongsOptimisticallyRestored = (payload: {
    listUUID?: string
    items?: Array<{ song: ISongInfo; index: number }>
  }) => {
    const listUUID = payload?.listUUID
    const currentListUUID = runtime.songsArea.songListUUID
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
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }

    scheduleSweepCovers()
  }

  const onSongsRemoved = (payload: { listUUID?: string; paths?: string[]; itemIds?: string[] }) => {
    const listUUID = payload?.listUUID
    const itemIds: string[] = Array.isArray(payload?.itemIds) ? payload.itemIds : []
    const currentListUUID = runtime.songsArea.songListUUID
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
        runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
        if (
          runtime.playingData.playingSong &&
          idSet.has(runtime.playingData.playingSong.mixtapeItemId || '')
        ) {
          runtime.playingData.playingSong = null
        }
      }

      runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
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

    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
      if (
        runtime.playingData.playingSong &&
        normalizedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
      ) {
        runtime.playingData.playingSong = null
      }
    }

    runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
      (path) => !normalizedSet.has(normalizePath(path))
    )

    scheduleSweepCovers()
  }

  const onSongsMovedByDrag = (movedSongPaths: string[]) => {
    if (libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)?.type === 'mixtapeList') {
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

    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
      if (
        runtime.playingData.playingSong &&
        normalizedMovedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
      ) {
        runtime.playingData.playingSong = null
      }
    }

    runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
      (path) => !normalizedMovedSet.has(normalizePath(path))
    )
  }

  const onExternalPlaylistRefresh = () => {
    if (runtime.songsArea.songListUUID !== EXTERNAL_PLAYLIST_UUID) return
    const songs = runtime.externalPlaylist.songs || []
    originalSongInfoArr.value = markRaw([...songs])
    applyFiltersAndSorting()
    scheduleSweepCovers()
  }

  let keyUpdateScheduled = false
  const scheduleApply = () => {
    if (keyUpdateScheduled) return
    keyUpdateScheduled = true
    requestAnimationFrame(() => {
      keyUpdateScheduled = false
      applyFiltersAndSorting()
    })
  }

  const onSongKeyUpdated = (_e: unknown, payload: { filePath?: string; keyText?: string }) => {
    const filePath = payload?.filePath
    const keyText = payload?.keyText
    if (!filePath || typeof keyText !== 'string') return
    console.info('[songs-ui] song-key-updated', { filePath, keyText })
    const normalizedTargetPath = normalizePath(filePath)

    let touched = false
    const nextOriginal = originalSongInfoArr.value.map((item) => {
      if (normalizePath(item.filePath) !== normalizedTargetPath) return item
      if (item.key === keyText) return item
      touched = true
      return { ...item, key: keyText }
    })
    if (touched) {
      originalSongInfoArr.value = markRaw(nextOriginal)
      scheduleApply()
    }

    if (runtime.songsArea.songInfoArr.length > 0) {
      runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.map((item) =>
        normalizePath(item.filePath) === normalizedTargetPath ? { ...item, key: keyText } : item
      )
      console.info('[songs-ui] patched runtime songInfoArr key', {
        filePath,
        keyText
      })
    }

    const currentPlayingSongForKey = runtime.playingData.playingSong
    if (
      currentPlayingSongForKey &&
      normalizePath(currentPlayingSongForKey.filePath) === normalizedTargetPath
    ) {
      runtime.playingData.playingSong = {
        ...currentPlayingSongForKey,
        key: keyText
      }
    }

    if (runtime.playingData.playingSongListData.length > 0) {
      runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map(
        (item) =>
          normalizePath(item.filePath) === normalizedTargetPath ? { ...item, key: keyText } : item
      )
    }

    if (runtime.externalPlaylist.songs.length > 0) {
      runtime.externalPlaylist.songs = runtime.externalPlaylist.songs.map((item) =>
        normalizePath(item.filePath) === normalizedTargetPath ? { ...item, key: keyText } : item
      )
    }
  }

  const onSongBpmUpdated = (_e: unknown, payload: { filePath?: string; bpm?: number }) => {
    const filePath = payload?.filePath
    const bpmValue = payload?.bpm
    if (!filePath || typeof bpmValue !== 'number' || !Number.isFinite(bpmValue)) return
    console.info('[songs-ui] song-bpm-updated', { filePath, bpm: bpmValue })
    const normalizedTargetPath = normalizePath(filePath)

    let touched = false
    const nextOriginal = originalSongInfoArr.value.map((item) => {
      if (normalizePath(item.filePath) !== normalizedTargetPath) return item
      if (item.bpm === bpmValue) return item
      touched = true
      return { ...item, bpm: bpmValue }
    })
    if (touched) {
      originalSongInfoArr.value = markRaw(nextOriginal)
      scheduleApply()
    }

    if (runtime.songsArea.songInfoArr.length > 0) {
      runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.map((item) =>
        normalizePath(item.filePath) === normalizedTargetPath ? { ...item, bpm: bpmValue } : item
      )
      console.info('[songs-ui] patched runtime songInfoArr bpm', {
        filePath,
        bpm: bpmValue
      })
    }

    const currentPlayingSongForBpm = runtime.playingData.playingSong
    if (
      currentPlayingSongForBpm &&
      normalizePath(currentPlayingSongForBpm.filePath) === normalizedTargetPath
    ) {
      runtime.playingData.playingSong = {
        ...currentPlayingSongForBpm,
        bpm: bpmValue
      }
    }

    if (runtime.playingData.playingSongListData.length > 0) {
      runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map(
        (item) =>
          normalizePath(item.filePath) === normalizedTargetPath ? { ...item, bpm: bpmValue } : item
      )
    }

    if (runtime.externalPlaylist.songs.length > 0) {
      runtime.externalPlaylist.songs = runtime.externalPlaylist.songs.map((item) =>
        normalizePath(item.filePath) === normalizedTargetPath ? { ...item, bpm: bpmValue } : item
      )
    }
  }

  const onSongGridUpdated = (
    _e: unknown,
    payload: {
      filePath?: string
      bpm?: number
      firstBeatMs?: number
      barBeatOffset?: number
    }
  ) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return
    console.info('[songs-ui] song-grid-updated', payload)
    const normalizedTargetPath = normalizePath(filePath)

    const hasBpm = typeof payload?.bpm === 'number' && Number.isFinite(payload.bpm)
    const hasFirstBeatMs =
      typeof payload?.firstBeatMs === 'number' && Number.isFinite(payload.firstBeatMs)
    const hasBarBeatOffset =
      typeof payload?.barBeatOffset === 'number' && Number.isFinite(payload.barBeatOffset)
    if (!hasBpm && !hasFirstBeatMs && !hasBarBeatOffset) return

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
      return touched ? nextSong : song
    }

    let touched = false
    const nextOriginal = originalSongInfoArr.value.map((item) => {
      if (normalizePath(item.filePath) !== normalizedTargetPath) return item
      const nextItem = applyGridPatch(item)
      if (nextItem !== item) touched = true
      return nextItem
    })
    if (touched) {
      originalSongInfoArr.value = markRaw(nextOriginal)
      scheduleApply()
    }

    if (runtime.songsArea.songInfoArr.length > 0) {
      runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.map((item) =>
        normalizePath(item.filePath) === normalizedTargetPath ? applyGridPatch(item) : item
      )
      console.info('[songs-ui] patched runtime songInfoArr grid', payload)
    }

    const currentPlayingSongForGrid = runtime.playingData.playingSong
    if (
      currentPlayingSongForGrid &&
      normalizePath(currentPlayingSongForGrid.filePath) === normalizedTargetPath
    ) {
      runtime.playingData.playingSong = applyGridPatch(currentPlayingSongForGrid)
    }

    if (runtime.playingData.playingSongListData.length > 0) {
      runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map(
        (item) =>
          normalizePath(item.filePath) === normalizedTargetPath ? applyGridPatch(item) : item
      )
    }

    if (runtime.externalPlaylist.songs.length > 0) {
      runtime.externalPlaylist.songs = runtime.externalPlaylist.songs.map((item) =>
        normalizePath(item.filePath) === normalizedTargetPath ? applyGridPatch(item) : item
      )
    }
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
  })

  // 导入完成后重新打开歌单
  window.electron.ipcRenderer.on('importFinished', async (event, songListUUID, _summary) => {
    if (songListUUID === runtime.songsArea.songListUUID) {
      setTimeout(async () => {
        await openSongList()
        // 通知库侧刷新歌单曲目数量徽标
        try {
          emitter.emit('playlistContentChanged', { uuids: [songListUUID] })
        } catch {}
      }, 1000)
    } else {
      // 非当前打开歌单：也通知刷新数量（避免徽标不变）
      try {
        emitter.emit('playlistContentChanged', { uuids: [songListUUID] })
      } catch {}
    }
  })

  // 转换完成后重新打开歌单
  window.electron.ipcRenderer.on('audio:convert:done', async (_e, payload) => {
    const listUUID = payload?.songListUUID
    if (!listUUID) return
    if (listUUID === runtime.songsArea.songListUUID) {
      setTimeout(async () => {
        await openSongList()
        try {
          emitter.emit('playlistContentChanged', { uuids: [listUUID] })
        } catch {}
      }, 300)
    } else {
      try {
        emitter.emit('playlistContentChanged', { uuids: [listUUID] })
      } catch {}
    }
  })

  // 切换歌单时刷新列表
  watch(
    () => runtime.songsArea.songListUUID,
    async (newUUID) => {
      runtime.songsArea.selectedSongFilePath.length = 0
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
        runtime.songsArea.songInfoArr = []
        runtime.songsArea.totalSongCount = 0
        originalSongInfoArr.value = []
      }
    }
  )

  // 同步 songsArea 与 playingData.playingSongListData
  watch(
    () => runtime.playingData.playingSongListData,
    (newPlayingListData) => {
      const currentSongsAreaListUUID = runtime.songsArea.songListUUID
      const currentPlayingListUUID = runtime.playingData.playingSongListUUID

      if (currentSongsAreaListUUID && currentSongsAreaListUUID === currentPlayingListUUID) {
        const songsInArea = runtime.songsArea.songInfoArr
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
          runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
            (path) => !pathsToRemove.includes(path)
          )
        }
      }
    },
    { deep: true }
  )
}
