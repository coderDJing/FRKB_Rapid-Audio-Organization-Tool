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
  let lastAppliedSongListUUID = ''

  // 渐进式渲染（当前行数）
  const renderCount = ref(0)

  const isMixtapeListView = () => {
    const node = libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)
    return node?.type === 'mixtapeList'
  }
  const isMixtapeListUUID = (songListUUID: string) =>
    libraryUtils.getLibraryTreeByUUID(songListUUID)?.type === 'mixtapeList'
  const normalizeSongPath = (value: string | undefined | null) =>
    String(value || '')
      .replace(/\//g, '\\')
      .toLowerCase()

  const notifySongSearchDirty = (reason: string) => {
    void window.electron.ipcRenderer.invoke('song-search:mark-dirty', { reason }).catch(() => {})
  }

  const safeStringify = (value: unknown) => {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  const traceGlobalSongSearch = (event: string, payload?: Record<string, unknown>) => {
    try {
      const suffix = payload ? ` ${safeStringify(payload)}` : ''
      window.electron.ipcRenderer.send('outputLog', `[gss-loader] ${event}${suffix}`)
    } catch {}
  }

  const hydrateRenderCount = async () => {
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
  }

  const scheduleCoverSweepForCurrentList = () => {
    try {
      const listRootDir = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID) || ''
      const currentPaths = runtime.songsArea.songInfoArr.map((s) => s.filePath)
      setTimeout(() => {
        window.electron.ipcRenderer.invoke('sweepSongListCovers', listRootDir, currentPaths)
      }, 0)
    } catch {}
  }

  const syncSelectedKeysAfterReload = (scanData: ISongInfo[], songListUUID: string) => {
    const currentSelection = runtime.songsArea.selectedSongFilePath.filter(Boolean)
    if (!currentSelection.length) return

    if (isMixtapeListUUID(songListUUID)) {
      const validIds = new Set(
        scanData
          .map((song) => song.mixtapeItemId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
      runtime.songsArea.selectedSongFilePath = currentSelection.filter((key) => validIds.has(key))
      return
    }

    const filePathMap = new Map<string, string>()
    for (const song of scanData) {
      const filePath = song.filePath
      if (!filePath) continue
      filePathMap.set(normalizeSongPath(filePath), filePath)
    }

    const nextSelection: string[] = []
    const seen = new Set<string>()
    for (const key of currentSelection) {
      const nextKey = filePathMap.get(normalizeSongPath(key))
      if (!nextKey || seen.has(nextKey)) continue
      seen.add(nextKey)
      nextSelection.push(nextKey)
    }
    runtime.songsArea.selectedSongFilePath = nextSelection
  }

  const applySongListData = async (
    scanData: ISongInfo[],
    songListUUID = runtime.songsArea.songListUUID
  ) => {
    originalSongInfoArr.value = markRaw(scanData)
    applyFiltersAndSorting()
    syncSelectedKeysAfterReload(scanData, songListUUID)
    lastAppliedSongListUUID = songListUUID
    try {
      emitter.emit('playlistContentChanged', { uuids: [songListUUID] })
    } catch {}
    if (runtime.playingData.playingSongListUUID === songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }
    await hydrateRenderCount()
  }

  const loadSongListFromDisk = async (songListPath: string, songListUUID: string) => {
    const { scanData, songListUUID: loadedUUID } = await window.electron.ipcRenderer.invoke(
      'scanSongList',
      songListPath,
      songListUUID
    )
    if (loadedUUID !== runtime.songsArea.songListUUID) return false
    await applySongListData(scanData)
    scheduleCoverSweepForCurrentList()
    notifySongSearchDirty('scanSongList')
    return true
  }

  const openSongList = async () => {
    const requestStartedAt = Date.now()
    const requestUUID = runtime.songsArea.songListUUID
    traceGlobalSongSearch('open-start', {
      songListUUID: requestUUID,
      libraryAreaSelected: runtime.libraryAreaSelected
    })
    isRequesting.value = true
    const shouldResetVisibleList = lastAppliedSongListUUID !== requestUUID
    if (shouldResetVisibleList) {
      runtime.songsArea.songInfoArr = []
      runtime.songsArea.totalSongCount = 0
      originalSongInfoArr.value = []
      renderCount.value = 0
      await nextTick()
    }

    if (runtime.songsArea.songListUUID === EXTERNAL_PLAYLIST_UUID) {
      const songs = runtime.externalPlaylist.songs || []
      originalSongInfoArr.value = markRaw([...songs])
      applyFiltersAndSorting()
      syncSelectedKeysAfterReload(runtime.songsArea.songInfoArr, requestUUID)
      lastAppliedSongListUUID = requestUUID
      isRequesting.value = false
      loadingShow.value = false
      traceGlobalSongSearch('open-external-hit', {
        songListUUID: requestUUID,
        costMs: Date.now() - requestStartedAt
      })
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
        syncSelectedKeysAfterReload(scanData, songListUUID)
        lastAppliedSongListUUID = songListUUID
      } finally {
        isRequesting.value = false
        clearTimeout(loadingSetTimeout)
        loadingShow.value = false
        traceGlobalSongSearch('open-recycle-finish', {
          songListUUID: requestUUID,
          costMs: Date.now() - requestStartedAt
        })
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
        syncSelectedKeysAfterReload(songs, requestUUID)
        lastAppliedSongListUUID = requestUUID

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
        traceGlobalSongSearch('open-mixtape-finish', {
          songListUUID: requestUUID,
          costMs: Date.now() - requestStartedAt
        })
      }
      return
    }

    const songListPath = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)

    // 先走主进程内存索引快照，保证首屏秒开
    try {
      const fastPayload = await window.electron.ipcRenderer.invoke(
        'song-search:playlist-fast-load',
        {
          songListUUID: runtime.songsArea.songListUUID
        }
      )
      const hit = Boolean(fastPayload?.hit)
      if (hit) {
        const fastItems = Array.isArray(fastPayload?.items) ? fastPayload.items : []
        await applySongListData(fastItems)
        isRequesting.value = false
        loadingShow.value = false
        traceGlobalSongSearch('open-fast-hit', {
          songListUUID: requestUUID,
          itemCount: fastItems.length,
          costMs: Date.now() - requestStartedAt
        })
        // 后台刷新一次磁盘结果，保证索引与磁盘一致
        void loadSongListFromDisk(songListPath, runtime.songsArea.songListUUID).catch(() => {})
        return
      }
      traceGlobalSongSearch('open-fast-miss', {
        songListUUID: requestUUID,
        costMs: Date.now() - requestStartedAt
      })
    } catch {}

    loadingShow.value = false
    const loadingSetTimeout = setTimeout(() => {
      loadingShow.value = true
    }, 100)

    try {
      await loadSongListFromDisk(songListPath, runtime.songsArea.songListUUID)
    } finally {
      isRequesting.value = false
      clearTimeout(loadingSetTimeout)
      loadingShow.value = false
      traceGlobalSongSearch('open-disk-finish', {
        songListUUID: requestUUID,
        costMs: Date.now() - requestStartedAt
      })
    }
  }

  return {
    loadingShow,
    isRequesting,
    renderCount,
    openSongList
  }
}
