import { nextTick, onUnmounted, ref, watch, type Ref, type ShallowRef } from 'vue'
import emitter from '@renderer/utils/mitt'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'

type FocusSongPayload = {
  songListUUID?: string
  filePath?: string
  autoPlay?: boolean
  flash?: boolean
}

interface UseGlobalSearchFocusParams {
  runtime: ReturnType<typeof useRuntimeStore>
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  columnData: Ref<ISongsAreaColumn[]>
  applyFiltersAndSorting: () => void
  getRowKey: (song: ISongInfo) => string
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void
  songDblClick: (song: ISongInfo) => Promise<void> | void
  onFocusHit?: (rowKey: string) => void
}

const FOCUS_RETRY_INTERVAL_MS = 120
const FOCUS_RETRY_TIMEOUT_MS = 12000
const FOCUS_STABILIZE_MS = 1500

const normalizeSongPath = (value: string | undefined | null) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function useGlobalSearchFocus(params: UseGlobalSearchFocusParams) {
  const {
    runtime,
    originalSongInfoArr,
    columnData,
    applyFiltersAndSorting,
    getRowKey,
    scrollToIndex,
    songDblClick,
    onFocusHit
  } = params

  const pendingFocusPayload = ref<FocusSongPayload | null>(null)
  let focusRetryTimer: ReturnType<typeof setInterval> | null = null
  let focusRetryDeadline = 0
  let focusApplying = false
  let focusAttemptSeq = 0
  let focusHasHit = false
  let focusAutoPlayed = false
  let focusStabilizeUntil = 0

  const trace = (event: string, data?: Record<string, unknown>) => {
    try {
      const suffix = data ? ` ${safeStringify(data)}` : ''
      window.electron.ipcRenderer.send('outputLog', `[gss-focus] ${event}${suffix}`)
    } catch {}
  }

  const findVisibleSongIndexByPath = (targetPath: string) =>
    runtime.songsArea.songInfoArr.findIndex(
      (song) => normalizeSongPath(song.filePath) === targetPath
    )

  const hasSongInOriginalByPath = (targetPath: string) =>
    originalSongInfoArr.value.some((song) => normalizeSongPath(song.filePath) === targetPath)

  const clearColumnFiltersForGlobalLocate = () => {
    const hasActiveFilter = columnData.value.some(
      (col) =>
        Boolean(col.filterActive) ||
        Boolean(String(col.filterValue || '').trim()) ||
        Boolean(String(col.filterExcludeValue || '').trim()) ||
        Boolean(col.filterOp) ||
        Boolean(String(col.filterDuration || '').trim()) ||
        Boolean(String(col.filterNumber || '').trim())
    )
    if (!hasActiveFilter) return false

    columnData.value = columnData.value.map((col) => ({
      ...col,
      filterActive: false,
      filterValue: undefined,
      filterExcludeValue: undefined,
      filterOp: undefined,
      filterDuration: undefined,
      filterNumber: undefined
    }))
    applyFiltersAndSorting()
    trace('clear-filters', {
      listUUID: runtime.songsArea.songListUUID,
      visibleCount: runtime.songsArea.songInfoArr.length,
      originalCount: originalSongInfoArr.value.length
    })
    return true
  }

  const applyFocusSongPayload = async (payload: FocusSongPayload, attemptNo: number) => {
    const targetPath = normalizeSongPath(payload?.filePath)
    const targetListUUID = String(payload?.songListUUID || '')
    if (!targetPath) {
      trace('skip-empty-path', { attemptNo })
      return false
    }
    if (targetListUUID && targetListUUID !== runtime.songsArea.songListUUID) {
      if (attemptNo <= 2 || attemptNo % 8 === 0) {
        trace('waiting-list-switch', {
          attemptNo,
          targetListUUID,
          currentListUUID: runtime.songsArea.songListUUID
        })
      }
      return false
    }
    let targetIndex = findVisibleSongIndexByPath(targetPath)
    if (targetIndex < 0 && hasSongInOriginalByPath(targetPath)) {
      const didClearFilters = clearColumnFiltersForGlobalLocate()
      if (didClearFilters) {
        await nextTick()
        targetIndex = findVisibleSongIndexByPath(targetPath)
      }
    }
    if (targetIndex < 0) {
      if (attemptNo <= 2 || attemptNo % 8 === 0) {
        trace('waiting-song-visible', {
          attemptNo,
          targetPath,
          listUUID: runtime.songsArea.songListUUID,
          visibleCount: runtime.songsArea.songInfoArr.length,
          originalCount: originalSongInfoArr.value.length
        })
      }
      return false
    }
    const targetSong = runtime.songsArea.songInfoArr[targetIndex]
    const rowKey = getRowKey(targetSong)
    runtime.songsArea.selectedSongFilePath = [rowKey]
    await nextTick()
    scrollToIndex(targetIndex)
    if (payload.autoPlay && !focusAutoPlayed) {
      focusAutoPlayed = true
      await songDblClick(targetSong)
    }
    if (!focusHasHit) {
      focusHasHit = true
      focusStabilizeUntil = Date.now() + FOCUS_STABILIZE_MS
      trace('focus-hit', {
        attemptNo,
        targetIndex,
        rowKey,
        autoPlay: payload.autoPlay === true,
        flash: payload.flash === true
      })
    }
    if (Date.now() < focusStabilizeUntil) {
      return false
    }
    if (payload.flash) {
      onFocusHit?.(rowKey)
    }
    trace('focus-stable', {
      attemptNo,
      targetIndex,
      rowKey,
      flash: payload.flash === true
    })
    return true
  }

  const stopFocusRetryLoop = () => {
    if (focusRetryTimer) {
      clearInterval(focusRetryTimer)
      focusRetryTimer = null
    }
  }

  const runPendingFocusAttempt = () => {
    const payload = pendingFocusPayload.value
    if (!payload) {
      stopFocusRetryLoop()
      return
    }
    if (Date.now() > focusRetryDeadline) {
      if (focusHasHit) {
        trace('focus-stabilize-timeout', {
          targetListUUID: payload.songListUUID || '',
          targetPath: payload.filePath || '',
          currentListUUID: runtime.songsArea.songListUUID
        })
      } else {
        trace('focus-timeout', {
          targetListUUID: payload.songListUUID || '',
          targetPath: payload.filePath || '',
          currentListUUID: runtime.songsArea.songListUUID,
          visibleCount: runtime.songsArea.songInfoArr.length,
          originalCount: originalSongInfoArr.value.length
        })
      }
      pendingFocusPayload.value = null
      stopFocusRetryLoop()
      return
    }
    if (focusApplying) return

    focusApplying = true
    focusAttemptSeq += 1
    const attemptNo = focusAttemptSeq
    void applyFocusSongPayload(payload, attemptNo)
      .then((done) => {
        if (done && pendingFocusPayload.value === payload) {
          pendingFocusPayload.value = null
          stopFocusRetryLoop()
        }
      })
      .finally(() => {
        focusApplying = false
      })
  }

  const ensureFocusRetryLoop = () => {
    focusRetryDeadline = Date.now() + FOCUS_RETRY_TIMEOUT_MS
    if (focusRetryTimer) return
    focusRetryTimer = setInterval(runPendingFocusAttempt, FOCUS_RETRY_INTERVAL_MS)
  }

  const handleFocusSongRequest = (payload?: FocusSongPayload) => {
    if (!payload) return
    focusAttemptSeq = 0
    focusHasHit = false
    focusAutoPlayed = false
    focusStabilizeUntil = 0
    pendingFocusPayload.value = payload
    trace('focus-request', {
      targetListUUID: payload.songListUUID || '',
      targetPath: payload.filePath || '',
      autoPlay: payload.autoPlay === true,
      currentListUUID: runtime.songsArea.songListUUID
    })
    ensureFocusRetryLoop()
    runPendingFocusAttempt()
  }

  emitter.on('songsArea/focus-song', handleFocusSongRequest)

  watch(
    () => [
      runtime.songsArea.songListUUID,
      runtime.songsArea.songInfoArr.length,
      runtime.songsArea.songInfoArr
    ],
    () => {
      runPendingFocusAttempt()
    },
    { flush: 'post' }
  )

  onUnmounted(() => {
    emitter.off('songsArea/focus-song', handleFocusSongRequest)
    stopFocusRetryLoop()
  })
}
