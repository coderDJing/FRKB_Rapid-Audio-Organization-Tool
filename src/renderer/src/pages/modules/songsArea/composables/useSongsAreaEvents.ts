import { onMounted, onUnmounted, watch } from 'vue'
import emitter from '@renderer/utils/mitt'
import type { ShallowRef } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'

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

  const onSongsRemoved = (
    payload: { listUUID?: string; paths: string[] } | { paths: string[] }
  ) => {
    const pathsToRemove = Array.isArray((payload as any).paths) ? (payload as any).paths : []
    const listUUID = (payload as any).listUUID

    console.log('[SongsArea] EVENT_songsRemoved', {
      listUUID,
      removeCount: pathsToRemove.length
    })

    if (!pathsToRemove.length) return
    if (listUUID && listUUID !== runtime.songsArea.songListUUID) return

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (song) => !pathsToRemove.includes(song.filePath)
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

  onMounted(() => {
    emitter.on('songsRemoved', onSongsRemoved)
    emitter.on('songsMovedByDrag', onSongsMovedByDrag)
  })

  onUnmounted(() => {
    emitter.off('songsRemoved', onSongsRemoved)
    emitter.off('songsMovedByDrag', onSongsMovedByDrag)
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

  // 切换歌单时刷新列表
  watch(
    () => runtime.songsArea.songListUUID,
    async (newUUID) => {
      runtime.songsArea.selectedSongFilePath.length = 0
      if (newUUID) {
        await openSongList()
      } else {
        runtime.songsArea.songInfoArr = []
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
