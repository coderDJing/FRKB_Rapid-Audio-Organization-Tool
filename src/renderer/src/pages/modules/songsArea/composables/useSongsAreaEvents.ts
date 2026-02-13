import { onMounted, onUnmounted, watch, markRaw } from 'vue'
import emitter from '@renderer/utils/mitt'
import type { ShallowRef } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import libraryUtils from '@renderer/utils/libraryUtils'

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
    const normalizePath = (p: string | undefined | null) =>
      (p || '').replace(/\//g, '\\').toLowerCase()
    const normalizedSet = new Set<string>(pathsToRemove.map((p: string) => normalizePath(p)))
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
        pathsToRemove.includes(runtime.playingData.playingSong.filePath)
      ) {
        runtime.playingData.playingSong = null
      }
    }

    runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
      (path) => !pathsToRemove.includes(path)
    )

    scheduleSweepCovers()
  }

  const onSongsMovedByDrag = (movedSongPaths: string[]) => {
    if (libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)?.type === 'mixtapeList') {
      return
    }
    if (!Array.isArray(movedSongPaths) || movedSongPaths.length === 0) return

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (song) => !movedSongPaths.includes(song.filePath)
    )
    applyFiltersAndSorting()
    scheduleSweepCovers()

    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
      if (
        runtime.playingData.playingSong &&
        movedSongPaths.includes(runtime.playingData.playingSong.filePath)
      ) {
        runtime.playingData.playingSong = null
      }
    }

    runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
      (path) => !movedSongPaths.includes(path)
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

    let touched = false
    const nextOriginal = originalSongInfoArr.value.map((item) => {
      if (item.filePath !== filePath) return item
      if (item.key === keyText) return item
      touched = true
      return { ...item, key: keyText }
    })
    if (touched) {
      originalSongInfoArr.value = markRaw(nextOriginal)
      scheduleApply()
    }

    if (runtime.playingData.playingSong?.filePath === filePath) {
      runtime.playingData.playingSong = {
        ...runtime.playingData.playingSong,
        key: keyText
      }
    }

    if (runtime.playingData.playingSongListData.length > 0) {
      runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map(
        (item) => (item.filePath === filePath ? { ...item, key: keyText } : item)
      )
    }

    if (runtime.externalPlaylist.songs.length > 0) {
      runtime.externalPlaylist.songs = runtime.externalPlaylist.songs.map((item) =>
        item.filePath === filePath ? { ...item, key: keyText } : item
      )
    }
  }

  const onSongBpmUpdated = (_e: unknown, payload: { filePath?: string; bpm?: number }) => {
    const filePath = payload?.filePath
    const bpmValue = payload?.bpm
    if (!filePath || typeof bpmValue !== 'number' || !Number.isFinite(bpmValue)) return

    let touched = false
    const nextOriginal = originalSongInfoArr.value.map((item) => {
      if (item.filePath !== filePath) return item
      if (item.bpm === bpmValue) return item
      touched = true
      return { ...item, bpm: bpmValue }
    })
    if (touched) {
      originalSongInfoArr.value = markRaw(nextOriginal)
      scheduleApply()
    }

    if (runtime.playingData.playingSong?.filePath === filePath) {
      runtime.playingData.playingSong = {
        ...runtime.playingData.playingSong,
        bpm: bpmValue
      }
    }

    if (runtime.playingData.playingSongListData.length > 0) {
      runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map(
        (item) => (item.filePath === filePath ? { ...item, bpm: bpmValue } : item)
      )
    }

    if (runtime.externalPlaylist.songs.length > 0) {
      runtime.externalPlaylist.songs = runtime.externalPlaylist.songs.map((item) =>
        item.filePath === filePath ? { ...item, bpm: bpmValue } : item
      )
    }
  }

  onMounted(() => {
    emitter.on('songsRemoved', onSongsRemoved)
    emitter.on('songsMovedByDrag', onSongsMovedByDrag)
    emitter.on('external-playlist/refresh', onExternalPlaylistRefresh)
    window.electron.ipcRenderer.on('song-key-updated', onSongKeyUpdated)
    window.electron.ipcRenderer.on('song-bpm-updated', onSongBpmUpdated)
  })

  onUnmounted(() => {
    emitter.off('songsRemoved', onSongsRemoved)
    emitter.off('songsMovedByDrag', onSongsMovedByDrag)
    emitter.off('external-playlist/refresh', onExternalPlaylistRefresh)
    window.electron.ipcRenderer.removeListener('song-key-updated', onSongKeyUpdated)
    window.electron.ipcRenderer.removeListener('song-bpm-updated', onSongBpmUpdated)
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
