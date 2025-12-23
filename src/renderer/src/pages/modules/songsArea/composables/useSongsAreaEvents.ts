import { onMounted, onUnmounted, watch, markRaw } from 'vue'
import emitter from '@renderer/utils/mitt'
import type { ShallowRef } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'

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

  const normalizePath = (p: string | undefined | null) =>
    (p || '').replace(/\//g, '\\').toLowerCase()

  const onSongsRemoved = (
    payload: { listUUID?: string; paths: string[] } | { paths: string[] }
  ) => {
    const pathsToRemove: string[] = Array.isArray((payload as any).paths)
      ? ((payload as any).paths as string[])
      : []
    const listUUID = (payload as any).listUUID
    const normalizedSet = new Set<string>(pathsToRemove.map((p: string) => normalizePath(p)))
    const hasIntersection = originalSongInfoArr.value.some((s) =>
      normalizedSet.has(normalizePath(s.filePath))
    )
    const currentListUUID = runtime.songsArea.songListUUID

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

  const onSelectionLabelsChanged = (payload: any) => {
    const filePaths: string[] = Array.isArray(payload?.filePaths)
      ? payload.filePaths.filter(Boolean).map(String)
      : []
    const rawLabel = typeof payload?.label === 'string' ? payload.label : ''
    const nextLabel: ISongInfo['selectionLabel'] =
      rawLabel === 'liked' ? 'liked' : rawLabel === 'disliked' ? 'disliked' : undefined

    const normalizedSet = new Set(filePaths.map((p) => normalizePath(p)).filter(Boolean))
    if (normalizedSet.size === 0) return

    const hasIntersection = originalSongInfoArr.value.some((s) =>
      normalizedSet.has(normalizePath(s.filePath))
    )
    if (!hasIntersection) return

    const patch = (song: ISongInfo): ISongInfo => {
      if (!song?.filePath) return song
      if (!normalizedSet.has(normalizePath(song.filePath))) return song
      return { ...song, selectionLabel: nextLabel }
    }

    originalSongInfoArr.value = originalSongInfoArr.value.map(patch)
    runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.map(patch)

    if (
      runtime.playingData.playingSong &&
      normalizedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
    ) {
      runtime.playingData.playingSong = patch(runtime.playingData.playingSong)
    }
    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map(patch)
    }

    applyFiltersAndSorting()
  }

  onMounted(() => {
    emitter.on('songsRemoved', onSongsRemoved)
    emitter.on('songsMovedByDrag', onSongsMovedByDrag)
    emitter.on('external-playlist/refresh', onExternalPlaylistRefresh)
    emitter.on('selectionLabelsChanged', onSelectionLabelsChanged)
  })

  onUnmounted(() => {
    emitter.off('songsRemoved', onSongsRemoved)
    emitter.off('songsMovedByDrag', onSongsMovedByDrag)
    emitter.off('external-playlist/refresh', onExternalPlaylistRefresh)
    emitter.off('selectionLabelsChanged', onSelectionLabelsChanged)
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
