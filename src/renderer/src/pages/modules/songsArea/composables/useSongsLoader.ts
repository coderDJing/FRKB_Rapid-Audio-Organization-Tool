import { ref, nextTick, markRaw, onUnmounted } from 'vue'
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

interface LoadSongListFromDiskOptions {
  forceNotifySongSearchDirty?: boolean
}

interface SongListDiffSummary {
  hasIgnoredOnlyDiffs: boolean
  hasMeaningfulDiffs: boolean
}

export function useSongsLoader(params: UseSongsLoaderParams) {
  const { runtime, originalSongInfoArr, applyFiltersAndSorting } = params

  const loadingShow = ref(false)
  const isRequesting = ref<boolean>(false)
  let lastAppliedSongListUUID = ''
  let backgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null

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
  const normalizeComparableText = (value: unknown) => String(value || '').trim()
  const normalizeComparableFileName = (value: unknown) => {
    const normalized = normalizeComparableText(value)
    if ((runtime.setting?.platform || runtime.platform) === 'win32') {
      return normalized.toLowerCase()
    }
    return normalized
  }
  const normalizeComparableNumber = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const getSongIdentityKey = (song: ISongInfo) =>
    normalizeComparableText(song.mixtapeItemId) || normalizeSongPath(song.filePath)
  const ignoredSongListRefreshDiffFields = new Set(['key', 'bpm'])

  const notifySongSearchDirty = (reason: string) => {
    void window.electron.ipcRenderer.invoke('song-search:mark-dirty', { reason }).catch(() => {})
  }

  const clearBackgroundRefreshTimer = () => {
    if (!backgroundRefreshTimer) return
    clearTimeout(backgroundRefreshTimer)
    backgroundRefreshTimer = null
  }

  const scheduleBackgroundSongListRefresh = (songListPath: string, songListUUID: string) => {
    clearBackgroundRefreshTimer()
    backgroundRefreshTimer = setTimeout(() => {
      backgroundRefreshTimer = null
      if (runtime.songsArea.songListUUID !== songListUUID) return
      void loadSongListFromDisk(songListPath, songListUUID).catch(() => {})
    }, 1500)
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

  const isEquivalentSongInfo = (left: ISongInfo, right: ISongInfo) => {
    return (
      getSongIdentityKey(left) === getSongIdentityKey(right) &&
      normalizeSongPath(left.filePath) === normalizeSongPath(right.filePath) &&
      normalizeComparableFileName(left.fileName) === normalizeComparableFileName(right.fileName) &&
      normalizeComparableText(left.fileFormat).toUpperCase() ===
        normalizeComparableText(right.fileFormat).toUpperCase() &&
      normalizeComparableText(left.title) === normalizeComparableText(right.title) &&
      normalizeComparableText(left.artist) === normalizeComparableText(right.artist) &&
      normalizeComparableText(left.album) === normalizeComparableText(right.album) &&
      normalizeComparableText(left.duration) === normalizeComparableText(right.duration) &&
      normalizeComparableText(left.genre) === normalizeComparableText(right.genre) &&
      normalizeComparableText(left.label) === normalizeComparableText(right.label) &&
      normalizeComparableNumber(left.bitrate) === normalizeComparableNumber(right.bitrate) &&
      normalizeComparableText(left.container).toUpperCase() ===
        normalizeComparableText(right.container).toUpperCase() &&
      normalizeComparableText(left.key) === normalizeComparableText(right.key) &&
      normalizeComparableNumber(left.bpm) === normalizeComparableNumber(right.bpm) &&
      normalizeComparableNumber(left.mixOrder) === normalizeComparableNumber(right.mixOrder) &&
      normalizeComparableText(left.mixtapeItemId) ===
        normalizeComparableText(right.mixtapeItemId) &&
      normalizeComparableNumber(left.deletedAtMs) ===
        normalizeComparableNumber(right.deletedAtMs) &&
      normalizeComparableText(left.originalPlaylistPath) ===
        normalizeComparableText(right.originalPlaylistPath) &&
      normalizeComparableText(left.recycleBinSourceType) ===
        normalizeComparableText(right.recycleBinSourceType)
    )
  }

  const getSongInfoDiffFields = (left: ISongInfo, right: ISongInfo) => {
    const fields: string[] = []
    if (getSongIdentityKey(left) !== getSongIdentityKey(right)) fields.push('__identity__')
    if (normalizeSongPath(left.filePath) !== normalizeSongPath(right.filePath))
      fields.push('filePath')
    if (
      normalizeComparableFileName(left.fileName) !== normalizeComparableFileName(right.fileName)
    ) {
      fields.push('fileName')
    }
    if (
      normalizeComparableText(left.fileFormat).toUpperCase() !==
      normalizeComparableText(right.fileFormat).toUpperCase()
    ) {
      fields.push('fileFormat')
    }
    if (normalizeComparableText(left.title) !== normalizeComparableText(right.title)) {
      fields.push('title')
    }
    if (normalizeComparableText(left.artist) !== normalizeComparableText(right.artist)) {
      fields.push('artist')
    }
    if (normalizeComparableText(left.album) !== normalizeComparableText(right.album)) {
      fields.push('album')
    }
    if (normalizeComparableText(left.duration) !== normalizeComparableText(right.duration)) {
      fields.push('duration')
    }
    if (normalizeComparableText(left.genre) !== normalizeComparableText(right.genre)) {
      fields.push('genre')
    }
    if (normalizeComparableText(left.label) !== normalizeComparableText(right.label)) {
      fields.push('label')
    }
    if (normalizeComparableNumber(left.bitrate) !== normalizeComparableNumber(right.bitrate)) {
      fields.push('bitrate')
    }
    if (
      normalizeComparableText(left.container).toUpperCase() !==
      normalizeComparableText(right.container).toUpperCase()
    ) {
      fields.push('container')
    }
    if (normalizeComparableText(left.key) !== normalizeComparableText(right.key)) {
      fields.push('key')
    }
    if (normalizeComparableNumber(left.bpm) !== normalizeComparableNumber(right.bpm)) {
      fields.push('bpm')
    }
    if (normalizeComparableNumber(left.mixOrder) !== normalizeComparableNumber(right.mixOrder)) {
      fields.push('mixOrder')
    }
    if (
      normalizeComparableText(left.mixtapeItemId) !== normalizeComparableText(right.mixtapeItemId)
    ) {
      fields.push('mixtapeItemId')
    }
    if (
      normalizeComparableNumber(left.deletedAtMs) !== normalizeComparableNumber(right.deletedAtMs)
    ) {
      fields.push('deletedAtMs')
    }
    if (
      normalizeComparableText(left.originalPlaylistPath) !==
      normalizeComparableText(right.originalPlaylistPath)
    ) {
      fields.push('originalPlaylistPath')
    }
    if (
      normalizeComparableText(left.recycleBinSourceType) !==
      normalizeComparableText(right.recycleBinSourceType)
    ) {
      fields.push('recycleBinSourceType')
    }
    return fields
  }

  const isEquivalentSongListSnapshot = (nextData: ISongInfo[], currentData: ISongInfo[]) => {
    if (nextData.length !== currentData.length) return false
    if (nextData.length === 0) return true

    const currentByKey = new Map<string, ISongInfo>()
    for (const song of currentData) {
      const key = getSongIdentityKey(song)
      if (!key || currentByKey.has(key)) return false
      currentByKey.set(key, song)
    }

    let matchedCount = 0
    for (const song of nextData) {
      const key = getSongIdentityKey(song)
      if (!key) return false
      const current = currentByKey.get(key)
      if (!current || !isEquivalentSongInfo(song, current)) return false
      matchedCount += 1
    }

    return matchedCount === currentByKey.size
  }

  const summarizeSongListDiff = (
    nextData: ISongInfo[],
    currentData: ISongInfo[]
  ): SongListDiffSummary => {
    let hasMeaningfulDiffs = false
    let hasIgnoredOnlyDiffs = false

    if (nextData.length !== currentData.length) {
      return {
        hasIgnoredOnlyDiffs: false,
        hasMeaningfulDiffs: true
      }
    }

    const currentByKey = new Map<string, ISongInfo>()
    for (const song of currentData) {
      const key = getSongIdentityKey(song)
      if (!key || currentByKey.has(key)) {
        return {
          hasIgnoredOnlyDiffs: false,
          hasMeaningfulDiffs: true
        }
      }
      currentByKey.set(key, song)
    }

    for (const song of nextData) {
      const key = getSongIdentityKey(song)
      const current = key ? currentByKey.get(key) : undefined
      const fields = !key || !current ? ['__missing__'] : getSongInfoDiffFields(song, current)
      if (!fields.length) continue

      const hasNonIgnoredField = fields.some(
        (field) => !ignoredSongListRefreshDiffFields.has(field)
      )
      if (hasNonIgnoredField) {
        hasMeaningfulDiffs = true
      } else {
        hasIgnoredOnlyDiffs = true
      }
    }

    return {
      hasIgnoredOnlyDiffs,
      hasMeaningfulDiffs
    }
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

  const loadSongListFromDisk = async (
    songListPath: string,
    songListUUID: string,
    options?: LoadSongListFromDiskOptions
  ) => {
    const { scanData, songListUUID: loadedUUID } = await window.electron.ipcRenderer.invoke(
      'scanSongList',
      songListPath,
      songListUUID
    )
    if (loadedUUID !== runtime.songsArea.songListUUID) return false
    const unchanged = isEquivalentSongListSnapshot(scanData, originalSongInfoArr.value)
    if (unchanged) {
      lastAppliedSongListUUID = loadedUUID
      if (options?.forceNotifySongSearchDirty) {
        notifySongSearchDirty('scanSongList')
      }
      return true
    }
    const diffSummary = summarizeSongListDiff(scanData, originalSongInfoArr.value)
    if (!diffSummary.hasMeaningfulDiffs && diffSummary.hasIgnoredOnlyDiffs) {
      lastAppliedSongListUUID = loadedUUID
      if (options?.forceNotifySongSearchDirty) {
        notifySongSearchDirty('scanSongList')
      }
      return true
    }
    await applySongListData(scanData)
    scheduleCoverSweepForCurrentList()
    notifySongSearchDirty('scanSongList')
    return true
  }

  const openSongList = async () => {
    const requestUUID = runtime.songsArea.songListUUID
    clearBackgroundRefreshTimer()
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
        // 后台刷新一次磁盘结果，保证索引与磁盘一致
        scheduleBackgroundSongListRefresh(songListPath, runtime.songsArea.songListUUID)
        return
      }
    } catch {}

    loadingShow.value = false
    const loadingSetTimeout = setTimeout(() => {
      loadingShow.value = true
    }, 100)

    try {
      await loadSongListFromDisk(songListPath, runtime.songsArea.songListUUID, {
        forceNotifySongSearchDirty: true
      })
    } finally {
      isRequesting.value = false
      clearTimeout(loadingSetTimeout)
      loadingShow.value = false
    }
  }

  onUnmounted(() => {
    clearBackgroundRefreshTimer()
  })

  return {
    loadingShow,
    isRequesting,
    renderCount,
    openSongList
  }
}
