import { ref, nextTick, markRaw, onUnmounted } from 'vue'
import type { ShallowRef } from 'vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import { mapMixtapeSnapshotToSongInfo } from '@renderer/composables/mixtape/mixtapeSnapshotSongMapper'
import type { ISongInfo } from '../../../../../../types/globals'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { areSongHotCuesEqual } from '@shared/hotCues'
import { areSongMemoryCuesEqual } from '@shared/memoryCues'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { t } from '@renderer/utils/translate'
import { normalizeSongStructureAnalysis } from '@shared/songStructure'
import { normalizeSongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import {
  createSongListLoadGenerationGuard,
  type SongListLoadTicket
} from './songListLoadGeneration'

interface UseSongsLoaderParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  applyFiltersAndSorting: () => void | Promise<void>
}

interface LoadSongListFromDiskOptions {
  forceNotifySongSearchDirty?: boolean
  diagnosticSource?: string
}

export interface OpenSongListOptions {
  waitForFreshAnalysisFields?: boolean
}

interface SongListDiffSummary {
  hasIgnoredOnlyDiffs: boolean
  hasMeaningfulDiffs: boolean
}

type SongListScanResult = {
  scanData?: ISongInfo[]
  songListUUID?: string
  missingWaveformFilePaths?: unknown
  playlistTrackNumbering?: {
    initialized?: boolean
    repaired?: boolean
  } | null
}

let songListScanDiagnosticSequence = 0

const createSongListScanTraceId = () => {
  songListScanDiagnosticSequence += 1
  return `renderer-${Date.now().toString(36)}-${songListScanDiagnosticSequence.toString(36)}`
}

const writeSongListScanError = (message: string, details: Record<string, unknown>) => {
  try {
    window.electron.ipcRenderer.send('outputLog', {
      level: 'error',
      source: 'renderer',
      scope: 'playlist-scan-diagnostic',
      message: `${message} ${JSON.stringify(details)}`
    })
  } catch {}
}

export function useSongsLoader(params: UseSongsLoaderParams) {
  const { runtime, songsAreaState, originalSongInfoArr, applyFiltersAndSorting } = params

  const loadingShow = ref(false)
  const isRequesting = ref<boolean>(false)
  const loadGenerationGuard = createSongListLoadGenerationGuard(() => songsAreaState.songListUUID)
  const hydrateFromPaneSnapshot = () => {
    if (originalSongInfoArr.value.length > 0) return false
    if (!songsAreaState.songListUUID || songsAreaState.songInfoArr.length === 0) return false
    originalSongInfoArr.value = markRaw([...songsAreaState.songInfoArr])
    return true
  }
  let lastAppliedSongListUUID = hydrateFromPaneSnapshot() ? songsAreaState.songListUUID : ''
  let backgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null
  const playlistTrackNumberTipStorageKey = 'playlistTrackNumberInitHintShown'

  // 渐进式渲染（当前行数）
  const renderCount = ref(0)

  const isMixtapeListUUID = (songListUUID: string) =>
    libraryUtils.getLibraryTreeByUUID(songListUUID)?.type === 'mixtapeList'
  const isSetListUUID = (songListUUID: string) =>
    libraryUtils.getLibraryTreeByUUID(songListUUID)?.type === 'setList'
  const normalizeSongPath = (value: string | undefined | null) =>
    String(value || '')
      .replace(/\//g, '\\')
      .toLowerCase()
  const normalizeMissingWaveformFilePaths = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const pathsByKey = new Map<string, string>()
    for (const item of value) {
      const filePath = typeof item === 'string' ? item.trim() : ''
      const key = normalizeSongPath(filePath)
      if (!filePath || !key || pathsByKey.has(key)) continue
      pathsByKey.set(key, filePath)
    }
    return [...pathsByKey.values()]
  }
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
  const normalizeComparableSongStructure = (value: unknown) => {
    const structure = normalizeSongStructureAnalysis(value)
    return structure ? JSON.stringify(structure) : ''
  }
  const normalizeComparableBeatGridMap = (value: unknown) => {
    const map = normalizeSongBeatGridMapV2(value, { allowSingleClip: true })
    return map ? map.signature : ''
  }
  const getSongIdentityKey = (song: ISongInfo) =>
    normalizeComparableText(song.mixtapeItemId) ||
    normalizeComparableText(song.setItemId) ||
    normalizeSongPath(song.filePath)
  const ignoredSongListRefreshDiffFields = new Set([
    'key',
    'bpm',
    'beatGridMap',
    'beatGridStatus',
    'energyScore',
    'energyAlgorithmVersion',
    'songStructure'
  ])
  const SONG_LIST_COMPARISON_YIELD_EVERY = 160

  const yieldToRenderer = () =>
    new Promise<void>((resolve) => {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve())
        return
      }
      setTimeout(resolve, 0)
    })

  const yieldAfterSongListItems = async (index: number, total: number) => {
    if (total < SONG_LIST_COMPARISON_YIELD_EVERY * 2) return
    if (index > 0 && index % SONG_LIST_COMPARISON_YIELD_EVERY === 0) {
      await yieldToRenderer()
    }
  }

  const notifySongSearchDirty = (reason: string) => {
    void window.electron.ipcRenderer.invoke('song-search:mark-dirty', { reason }).catch(() => {})
  }

  const clearBackgroundRefreshTimer = () => {
    if (!backgroundRefreshTimer) return
    clearTimeout(backgroundRefreshTimer)
    backgroundRefreshTimer = null
  }

  const invalidatePendingSongListLoads = () => {
    loadGenerationGuard.invalidate()
    clearBackgroundRefreshTimer()
    isRequesting.value = false
    loadingShow.value = false
  }

  const maybeShowPlaylistTrackNumberInitHint = (
    songListUUID: string,
    payload?: { initialized?: boolean } | null
  ) => {
    if (!payload?.initialized || !songListUUID) return
    try {
      const raw = localStorage.getItem(playlistTrackNumberTipStorageKey)
      const parsed = raw ? JSON.parse(raw) : {}
      const shownMap =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, boolean>)
          : {}
      if (shownMap[songListUUID]) return
      shownMap[songListUUID] = true
      localStorage.setItem(playlistTrackNumberTipStorageKey, JSON.stringify(shownMap))
    } catch {}
    try {
      emitter.emit('songsArea/clipboardHint', {
        message: t('tracks.playlistTrackNumbersInitializedHint')
      })
    } catch {}
  }

  const scheduleBackgroundSongListRefresh = (songListPath: string, ticket: SongListLoadTicket) => {
    clearBackgroundRefreshTimer()
    backgroundRefreshTimer = setTimeout(() => {
      backgroundRefreshTimer = null
      if (!loadGenerationGuard.isCurrent(ticket)) return
      void loadSongListFromDisk(songListPath, ticket, {
        diagnosticSource: 'background-refresh'
      }).catch(() => {})
    }, 1500)
  }

  const hydrateRenderCount = async (ticket?: SongListLoadTicket) => {
    const isCurrent = () => !ticket || loadGenerationGuard.isCurrent(ticket)
    if (!isCurrent()) return
    const totalRows = songsAreaState.songInfoArr.length
    const INITIAL_ROWS = 40
    const CHUNK_ROWS = 80
    renderCount.value = Math.min(totalRows, INITIAL_ROWS)
    await nextTick()
    if (!isCurrent()) return
    ;(() => {
      const step = () => {
        if (!isCurrent()) return
        if (renderCount.value >= totalRows) return
        renderCount.value = Math.min(renderCount.value + CHUNK_ROWS, totalRows)
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })()
    await nextTick()
    if (!isCurrent()) return
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  }

  const syncSelectedKeysAfterReload = (scanData: ISongInfo[], songListUUID: string) => {
    const currentSelection = songsAreaState.selectedSongFilePath.filter(Boolean)
    if (!currentSelection.length) return

    if (isMixtapeListUUID(songListUUID)) {
      const validIds = new Set(
        scanData
          .map((song) => song.mixtapeItemId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
      songsAreaState.selectedSongFilePath = currentSelection.filter((key) => validIds.has(key))
      return
    }
    if (isSetListUUID(songListUUID)) {
      const validIds = new Set(
        scanData
          .map((song) => song.setItemId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
      songsAreaState.selectedSongFilePath = currentSelection.filter((key) => validIds.has(key))
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
    songsAreaState.selectedSongFilePath = nextSelection
  }

  const syncPlayingStateAfterReload = (scanData: ISongInfo[], songListUUID: string) => {
    if (runtime.playingData.playingSongListUUID !== songListUUID) return

    runtime.playingData.playingSongListData = songsAreaState.songInfoArr

    const currentPlayingSong = runtime.playingData.playingSong
    if (!currentPlayingSong) return

    const playingMixtapeItemId = normalizeComparableText(currentPlayingSong.mixtapeItemId)
    const playingSetItemId = normalizeComparableText(currentPlayingSong.setItemId)
    const normalizedPlayingPath = normalizeSongPath(currentPlayingSong.filePath)
    const songCandidates =
      songsAreaState.songInfoArr.length > 0 ? songsAreaState.songInfoArr : scanData

    const matchedSong = songCandidates.find((song) => {
      const songMixtapeItemId = normalizeComparableText(song.mixtapeItemId)
      if (playingMixtapeItemId && songMixtapeItemId) {
        return songMixtapeItemId === playingMixtapeItemId
      }
      const songSetItemId = normalizeComparableText(song.setItemId)
      if (playingSetItemId && songSetItemId) {
        return songSetItemId === playingSetItemId
      }
      return (
        normalizedPlayingPath !== '' && normalizeSongPath(song.filePath) === normalizedPlayingPath
      )
    })

    if (!matchedSong) return

    runtime.playingData.playingSong = {
      ...currentPlayingSong,
      ...matchedSong
    }
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
      normalizeComparableBeatGridMap(left.beatGridMap) ===
        normalizeComparableBeatGridMap(right.beatGridMap) &&
      normalizeComparableText(left.beatGridStatus) ===
        normalizeComparableText(right.beatGridStatus) &&
      normalizeComparableNumber(left.energyScore) ===
        normalizeComparableNumber(right.energyScore) &&
      normalizeComparableNumber(left.energyAlgorithmVersion) ===
        normalizeComparableNumber(right.energyAlgorithmVersion) &&
      normalizeComparableSongStructure(left.songStructure) ===
        normalizeComparableSongStructure(right.songStructure) &&
      areSongHotCuesEqual(left.hotCues, right.hotCues) &&
      areSongMemoryCuesEqual(left.memoryCues, right.memoryCues) &&
      normalizeComparableNumber(left.mixOrder) === normalizeComparableNumber(right.mixOrder) &&
      normalizeComparableText(left.mixtapeItemId) ===
        normalizeComparableText(right.mixtapeItemId) &&
      normalizeComparableText(left.setItemId) === normalizeComparableText(right.setItemId) &&
      normalizeComparableNumber(left.deletedAtMs) ===
        normalizeComparableNumber(right.deletedAtMs) &&
      normalizeComparableText(left.originalPlaylistPath) ===
        normalizeComparableText(right.originalPlaylistPath) &&
      normalizeComparableText(left.recycleBinSourceType) ===
        normalizeComparableText(right.recycleBinSourceType) &&
      normalizeComparableNumber(left.playlistTrackNumber) ===
        normalizeComparableNumber(right.playlistTrackNumber)
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
    if (
      normalizeComparableBeatGridMap(left.beatGridMap) !==
      normalizeComparableBeatGridMap(right.beatGridMap)
    ) {
      fields.push('beatGridMap')
    }
    if (
      normalizeComparableText(left.beatGridStatus) !== normalizeComparableText(right.beatGridStatus)
    ) {
      fields.push('beatGridStatus')
    }
    if (
      normalizeComparableNumber(left.energyScore) !== normalizeComparableNumber(right.energyScore)
    ) {
      fields.push('energyScore')
    }
    if (
      normalizeComparableNumber(left.energyAlgorithmVersion) !==
      normalizeComparableNumber(right.energyAlgorithmVersion)
    ) {
      fields.push('energyAlgorithmVersion')
    }
    if (
      normalizeComparableSongStructure(left.songStructure) !==
      normalizeComparableSongStructure(right.songStructure)
    ) {
      fields.push('songStructure')
    }
    if (!areSongHotCuesEqual(left.hotCues, right.hotCues)) {
      fields.push('hotCues')
    }
    if (!areSongMemoryCuesEqual(left.memoryCues, right.memoryCues)) {
      fields.push('memoryCues')
    }
    if (normalizeComparableNumber(left.mixOrder) !== normalizeComparableNumber(right.mixOrder)) {
      fields.push('mixOrder')
    }
    if (
      normalizeComparableText(left.mixtapeItemId) !== normalizeComparableText(right.mixtapeItemId)
    ) {
      fields.push('mixtapeItemId')
    }
    if (normalizeComparableText(left.setItemId) !== normalizeComparableText(right.setItemId)) {
      fields.push('setItemId')
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
    if (
      normalizeComparableNumber(left.playlistTrackNumber) !==
      normalizeComparableNumber(right.playlistTrackNumber)
    ) {
      fields.push('playlistTrackNumber')
    }
    return fields
  }

  const isEquivalentSongListSnapshot = async (nextData: ISongInfo[], currentData: ISongInfo[]) => {
    if (nextData.length !== currentData.length) return false
    if (nextData.length === 0) return true

    const currentByKey = new Map<string, ISongInfo>()
    for (const [index, song] of currentData.entries()) {
      const key = getSongIdentityKey(song)
      if (!key || currentByKey.has(key)) return false
      currentByKey.set(key, song)
      await yieldAfterSongListItems(index + 1, currentData.length)
    }

    let matchedCount = 0
    for (const [index, song] of nextData.entries()) {
      const key = getSongIdentityKey(song)
      if (!key) return false
      const current = currentByKey.get(key)
      if (!current || !isEquivalentSongInfo(song, current)) return false
      matchedCount += 1
      await yieldAfterSongListItems(index + 1, nextData.length)
    }

    return matchedCount === currentByKey.size
  }

  const summarizeSongListDiff = async (
    nextData: ISongInfo[],
    currentData: ISongInfo[]
  ): Promise<SongListDiffSummary> => {
    let hasMeaningfulDiffs = false
    let hasIgnoredOnlyDiffs = false

    if (nextData.length !== currentData.length) {
      return {
        hasIgnoredOnlyDiffs: false,
        hasMeaningfulDiffs: true
      }
    }

    const currentByKey = new Map<string, ISongInfo>()
    for (const [index, song] of currentData.entries()) {
      const key = getSongIdentityKey(song)
      if (!key || currentByKey.has(key)) {
        return {
          hasIgnoredOnlyDiffs: false,
          hasMeaningfulDiffs: true
        }
      }
      currentByKey.set(key, song)
      await yieldAfterSongListItems(index + 1, currentData.length)
    }

    for (const [index, song] of nextData.entries()) {
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
      await yieldAfterSongListItems(index + 1, nextData.length)
    }

    return {
      hasIgnoredOnlyDiffs,
      hasMeaningfulDiffs
    }
  }

  const applySongListData = async (scanData: ISongInfo[], ticket: SongListLoadTicket) => {
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    originalSongInfoArr.value = markRaw(scanData)
    await applyFiltersAndSorting()
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    syncSelectedKeysAfterReload(scanData, ticket.songListUUID)
    syncPlayingStateAfterReload(scanData, ticket.songListUUID)
    lastAppliedSongListUUID = ticket.songListUUID
    try {
      emitter.emit('playlistContentChanged', { uuids: [ticket.songListUUID] })
    } catch {}
    await hydrateRenderCount(ticket)
    return loadGenerationGuard.isCurrent(ticket)
  }

  const loadSongListFromDisk = async (
    songListPath: string,
    ticket: SongListLoadTicket,
    options?: LoadSongListFromDiskOptions
  ) => {
    const traceId = createSongListScanTraceId()
    const diagnosticSource = options?.diagnosticSource || 'disk-load'
    const rendererStartedAtMs = Date.now()
    let result: SongListScanResult
    try {
      result = (await window.electron.ipcRenderer.invoke(
        'scanSongList',
        songListPath,
        ticket.songListUUID,
        {
          traceId,
          source: diagnosticSource
        }
      )) as SongListScanResult
    } catch (error) {
      writeSongListScanError('request failed', {
        traceId,
        diagnosticSource,
        songListUUID: ticket.songListUUID,
        rendererDurationMs: Date.now() - rendererStartedAtMs,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    const scanData = Array.isArray(result?.scanData) ? result.scanData : []
    const loadedUUID = String(result?.songListUUID || '')
    if (loadedUUID !== ticket.songListUUID) return false
    songsAreaState.missingWaveformFilePaths = normalizeMissingWaveformFilePaths(
      result?.missingWaveformFilePaths
    )
    maybeShowPlaylistTrackNumberInitHint(loadedUUID, result?.playlistTrackNumbering || null)
    const unchanged = await isEquivalentSongListSnapshot(scanData, originalSongInfoArr.value)
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    if (unchanged) {
      lastAppliedSongListUUID = loadedUUID
      if (options?.forceNotifySongSearchDirty) {
        notifySongSearchDirty('scanSongList')
      }
      return true
    }
    const diffSummary = await summarizeSongListDiff(scanData, originalSongInfoArr.value)
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    if (!diffSummary.hasMeaningfulDiffs && diffSummary.hasIgnoredOnlyDiffs) {
      if (!(await applySongListData(scanData, ticket))) return false
      lastAppliedSongListUUID = loadedUUID
      notifySongSearchDirty('scanSongList-analysis-fields')
      if (options?.forceNotifySongSearchDirty) {
        notifySongSearchDirty('scanSongList')
      }
      return true
    }
    if (!(await applySongListData(scanData, ticket))) return false
    notifySongSearchDirty('scanSongList')
    return true
  }

  const openSongList = async (options: OpenSongListOptions = {}) => {
    const requestUUID = songsAreaState.songListUUID
    const ticket = loadGenerationGuard.begin(requestUUID)
    clearBackgroundRefreshTimer()
    isRequesting.value = true
    const shouldResetVisibleList = lastAppliedSongListUUID !== requestUUID
    if (shouldResetVisibleList) {
      songsAreaState.songInfoArr = []
      songsAreaState.missingWaveformFilePaths = []
      songsAreaState.totalSongCount = 0
      originalSongInfoArr.value = []
      renderCount.value = 0
      await nextTick()
      if (!loadGenerationGuard.isCurrent(ticket)) return
    }

    if (requestUUID === EXTERNAL_PLAYLIST_UUID) {
      const songs = runtime.externalPlaylist.songs || []
      songsAreaState.missingWaveformFilePaths = []
      originalSongInfoArr.value = markRaw([...songs])
      applyFiltersAndSorting()
      syncSelectedKeysAfterReload(songsAreaState.songInfoArr, requestUUID)
      syncPlayingStateAfterReload(songsAreaState.songInfoArr, requestUUID)
      lastAppliedSongListUUID = requestUUID
      if (loadGenerationGuard.isCurrent(ticket)) {
        isRequesting.value = false
        loadingShow.value = false
      }
      return
    }
    if (requestUUID === RECYCLE_BIN_UUID) {
      songsAreaState.missingWaveformFilePaths = []
      loadingShow.value = false
      const loadingSetTimeout = setTimeout(() => {
        if (loadGenerationGuard.isCurrent(ticket)) loadingShow.value = true
      }, 100)
      try {
        const { scanData, songListUUID } =
          await window.electron.ipcRenderer.invoke('recycleBin:list')
        if (!loadGenerationGuard.isCurrent(ticket) || songListUUID !== requestUUID) return
        originalSongInfoArr.value = markRaw(scanData)
        applyFiltersAndSorting()
        syncSelectedKeysAfterReload(scanData, songListUUID)
        syncPlayingStateAfterReload(scanData, songListUUID)
        lastAppliedSongListUUID = songListUUID
      } finally {
        clearTimeout(loadingSetTimeout)
        if (loadGenerationGuard.isCurrent(ticket)) {
          isRequesting.value = false
          loadingShow.value = false
        }
      }
      return
    }
    if (requestUUID === RECORDING_LIBRARY_UUID) {
      songsAreaState.missingWaveformFilePaths = []
      loadingShow.value = false
      const loadingSetTimeout = setTimeout(() => {
        if (loadGenerationGuard.isCurrent(ticket)) loadingShow.value = true
      }, 100)
      try {
        const { scanData, songListUUID } =
          await window.electron.ipcRenderer.invoke('recordingLibrary:list')
        if (!loadGenerationGuard.isCurrent(ticket) || songListUUID !== requestUUID) return
        originalSongInfoArr.value = markRaw(scanData)
        applyFiltersAndSorting()
        syncSelectedKeysAfterReload(scanData, songListUUID)
        syncPlayingStateAfterReload(scanData, songListUUID)
        lastAppliedSongListUUID = songListUUID
      } finally {
        clearTimeout(loadingSetTimeout)
        if (loadGenerationGuard.isCurrent(ticket)) {
          isRequesting.value = false
          loadingShow.value = false
        }
      }
      return
    }

    if (isMixtapeListUUID(requestUUID)) {
      songsAreaState.missingWaveformFilePaths = []
      loadingShow.value = false
      const loadingSetTimeout = setTimeout(() => {
        if (loadGenerationGuard.isCurrent(ticket)) loadingShow.value = true
      }, 100)
      try {
        const result = await window.electron.ipcRenderer.invoke('mixtape:list', {
          playlistId: requestUUID
        })
        if (!loadGenerationGuard.isCurrent(ticket)) return
        const rawItems = Array.isArray(result?.items)
          ? (result.items as Array<Record<string, unknown>>)
          : []
        const songs = rawItems.map((item, index: number) =>
          mapMixtapeSnapshotToSongInfo(item, index, {
            buildDisplayPathByUuid: (uuid) => libraryUtils.buildDisplayPathByUuid(uuid)
          })
        )
        originalSongInfoArr.value = markRaw(songs)
        applyFiltersAndSorting()
        syncSelectedKeysAfterReload(songs, requestUUID)
        syncPlayingStateAfterReload(songs, requestUUID)
        lastAppliedSongListUUID = requestUUID
        await hydrateRenderCount(ticket)
      } finally {
        clearTimeout(loadingSetTimeout)
        if (loadGenerationGuard.isCurrent(ticket)) {
          isRequesting.value = false
          loadingShow.value = false
        }
      }
      return
    }

    if (isSetListUUID(requestUUID)) {
      songsAreaState.missingWaveformFilePaths = []
      loadingShow.value = false
      const loadingSetTimeout = setTimeout(() => {
        if (loadGenerationGuard.isCurrent(ticket)) loadingShow.value = true
      }, 100)
      try {
        const { scanData, songListUUID } = await window.electron.ipcRenderer.invoke(
          'setList:load-items',
          requestUUID
        )
        if (!loadGenerationGuard.isCurrent(ticket) || songListUUID !== requestUUID) return
        const songs = Array.isArray(scanData) ? scanData : []
        originalSongInfoArr.value = markRaw(songs)
        applyFiltersAndSorting()
        syncSelectedKeysAfterReload(songs, songListUUID)
        syncPlayingStateAfterReload(songs, songListUUID)
        lastAppliedSongListUUID = songListUUID
        await hydrateRenderCount(ticket)
      } finally {
        clearTimeout(loadingSetTimeout)
        if (loadGenerationGuard.isCurrent(ticket)) {
          isRequesting.value = false
          loadingShow.value = false
        }
      }
      return
    }

    const songListPath = libraryUtils.findDirPathByUuid(requestUUID)

    // 先走主进程内存索引快照，保证首屏秒开
    try {
      const fastPayload = await window.electron.ipcRenderer.invoke(
        'song-search:playlist-fast-load',
        {
          songListUUID: requestUUID
        }
      )
      if (!loadGenerationGuard.isCurrent(ticket)) return
      const hit = Boolean(fastPayload?.hit)
      if (hit) {
        const fastItems = Array.isArray(fastPayload?.items) ? fastPayload.items : []
        if (!(await applySongListData(fastItems, ticket))) return
        if (loadGenerationGuard.isCurrent(ticket)) {
          isRequesting.value = false
          loadingShow.value = false
        }
        if (options.waitForFreshAnalysisFields === true) {
          await loadSongListFromDisk(songListPath, ticket, {
            diagnosticSource: 'fresh-analysis'
          })
          return
        }
        // 内存快照只负责立即展示；磁盘校验放到后台，不能拿一次慢盘遍历卡住窗口。
        scheduleBackgroundSongListRefresh(songListPath, ticket)
        return
      }
    } catch {}

    loadingShow.value = false
    const loadingSetTimeout = setTimeout(() => {
      if (loadGenerationGuard.isCurrent(ticket)) loadingShow.value = true
    }, 100)

    try {
      await loadSongListFromDisk(songListPath, ticket, {
        forceNotifySongSearchDirty: true,
        diagnosticSource: 'foreground-open'
      })
    } finally {
      clearTimeout(loadingSetTimeout)
      if (loadGenerationGuard.isCurrent(ticket)) {
        isRequesting.value = false
        loadingShow.value = false
      }
    }
  }

  onUnmounted(() => {
    clearBackgroundRefreshTimer()
  })

  return {
    loadingShow,
    isRequesting,
    renderCount,
    openSongList,
    invalidatePendingSongListLoads
  }
}
