import { ref, nextTick, markRaw } from 'vue'
import type { ShallowRef } from 'vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import { mapMixtapeSnapshotToSongInfo } from '@renderer/composables/mixtape/mixtapeSnapshotSongMapper'
import type { ISongInfo } from '../../../../../../types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'

interface UseSongsLoaderParams {
  runtime: ReturnType<typeof useRuntimeStore>
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  applyFiltersAndSorting: () => void
}

export function useSongsLoader(params: UseSongsLoaderParams) {
  const { runtime, originalSongInfoArr, applyFiltersAndSorting } = params

  const loadingShow = ref(false)
  const isRequesting = ref<boolean>(false)

  // 渐进式渲染（当前行数）
  const renderCount = ref(0)

  const isMixtapeListView = () => {
    const node = libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)
    return node?.type === 'mixtapeList'
  }

  const openSongList = async () => {
    isRequesting.value = true
    runtime.songsArea.songInfoArr = []
    runtime.songsArea.totalSongCount = 0
    originalSongInfoArr.value = []
    await nextTick()

    if (runtime.songsArea.songListUUID === EXTERNAL_PLAYLIST_UUID) {
      const songs = runtime.externalPlaylist.songs || []
      originalSongInfoArr.value = markRaw([...songs])
      applyFiltersAndSorting()
      isRequesting.value = false
      loadingShow.value = false
      return
    }
    if (runtime.songsArea.songListUUID === RECYCLE_BIN_UUID) {
      loadingShow.value = false
      const loadingSetTimeout = setTimeout(() => {
        loadingShow.value = true
      }, 100)
      try {
        const { scanData, songListUUID } =
          await window.electron.ipcRenderer.invoke('recycleBin:list')
        if (songListUUID !== runtime.songsArea.songListUUID) return
        originalSongInfoArr.value = markRaw(scanData)
        applyFiltersAndSorting()
      } finally {
        isRequesting.value = false
        clearTimeout(loadingSetTimeout)
        loadingShow.value = false
      }
      return
    }

    if (isMixtapeListView()) {
      loadingShow.value = false
      const loadingSetTimeout = setTimeout(() => {
        loadingShow.value = true
      }, 100)
      try {
        const result = await window.electron.ipcRenderer.invoke('mixtape:list', {
          playlistId: runtime.songsArea.songListUUID
        })
        const rawItems = Array.isArray(result?.items) ? result.items : []
        const songs = rawItems.map((item: any, index: number) =>
          mapMixtapeSnapshotToSongInfo(item, index, {
            buildDisplayPathByUuid: (uuid) => libraryUtils.buildDisplayPathByUuid(uuid)
          })
        )
        originalSongInfoArr.value = markRaw(songs)
        applyFiltersAndSorting()

        if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
          runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
        }

        const totalRows = runtime.songsArea.songInfoArr.length
        const INITIAL_ROWS = 40
        const CHUNK_ROWS = 80
        renderCount.value = Math.min(totalRows, INITIAL_ROWS)
        await nextTick()
        ;(() => {
          const step = () => {
            if (renderCount.value >= totalRows) return
            renderCount.value = Math.min(renderCount.value + CHUNK_ROWS, totalRows)
            requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })()

        await nextTick()
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      } finally {
        isRequesting.value = false
        clearTimeout(loadingSetTimeout)
        loadingShow.value = false
      }
      return
    }

    const songListPath = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)

    loadingShow.value = false
    const loadingSetTimeout = setTimeout(() => {
      loadingShow.value = true
    }, 100)

    try {
      const { scanData, songListUUID } = await window.electron.ipcRenderer.invoke(
        'scanSongList',
        songListPath,
        runtime.songsArea.songListUUID
      )

      if (songListUUID !== runtime.songsArea.songListUUID) return

      // 避免深代理：整表标记为非响应
      originalSongInfoArr.value = markRaw(scanData)

      // 初次加载后应用筛选与排序
      applyFiltersAndSorting()

      // 加载完成后通知歌单计数可能已变化（例如系统中有文件被手动删除）
      try {
        emitter.emit('playlistContentChanged', { uuids: [runtime.songsArea.songListUUID] })
      } catch {}

      // 同步播放列表数据
      if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
        runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
      }

      // 渐进式渲染参数预热
      const totalRows = runtime.songsArea.songInfoArr.length
      const INITIAL_ROWS = 40
      const CHUNK_ROWS = 80
      renderCount.value = Math.min(totalRows, INITIAL_ROWS)
      await nextTick()
      ;(() => {
        const step = () => {
          if (renderCount.value >= totalRows) return
          renderCount.value = Math.min(renderCount.value + CHUNK_ROWS, totalRows)
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })()

      await nextTick()
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

      // 初次加载后，触发一次封面索引清理（不阻塞）
      try {
        const listRootDir = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID) || ''
        const currentPaths = runtime.songsArea.songInfoArr.map((s) => s.filePath)
        setTimeout(() => {
          window.electron.ipcRenderer.invoke('sweepSongListCovers', listRootDir, currentPaths)
        }, 0)
      } catch {}
    } finally {
      isRequesting.value = false
      clearTimeout(loadingSetTimeout)
      loadingShow.value = false
    }
  }

  return {
    loadingShow,
    isRequesting,
    renderCount,
    openSongList
  }
}
