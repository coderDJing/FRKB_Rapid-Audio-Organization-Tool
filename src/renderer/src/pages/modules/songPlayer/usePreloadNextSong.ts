import { ref, onUnmounted } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { canPlayHtmlAudio, toPreviewUrl } from './webAudioPlayer'

type PreloadCacheEntry = {
  filePath: string
  status: 'loading' | 'ready' | 'error'
  requestId: number
  offset: number
  audio?: HTMLAudioElement | null
  bpm?: number | string | null
  updatedAt: number
}

type PreloadTask = {
  filePath: string
  offset: number
  bpm?: number | null
}

type PlaybackCache = {
  filePath: string
  audio: HTMLAudioElement | null
  bpm: number | string | null
  storedAt: number
}

type PreloadHit =
  | {
      source: 'next'
      filePath: string
      audio: HTMLAudioElement
      bpm: number | string | null
    }
  | {
      source: 'previous'
      filePath: string
      audio: HTMLAudioElement
      bpm: number | string | null
    }

const PRELOAD_OFFSETS = [1, 2]
const HISTORY_WINDOW = 1
const PRELOAD_DELAY = 3000

const releaseAudioElement = (audio?: HTMLAudioElement | null) => {
  if (!audio) return false
  try {
    audio.pause()
  } catch (_) {}
  try {
    audio.src = ''
    audio.load()
  } catch (_) {}
  if (audio.parentNode) {
    try {
      audio.parentNode.removeChild(audio)
    } catch (_) {}
  }
  return true
}

const createPreloadAudio = (filePath: string) => {
  if (!canPlayHtmlAudio(filePath)) {
    return null
  }
  const audio = document.createElement('audio')
  audio.preload = 'auto'
  audio.autoplay = false
  audio.muted = false
  audio.src = toPreviewUrl(filePath)
  return audio
}

export function usePreloadNextSong(params: { runtime: ReturnType<typeof useRuntimeStore> }) {
  const { runtime } = params

  const currentPreloadRequestId = ref(0)
  let preloadTimerId: any = null

  const preloadQueue: PreloadTask[] = []
  const preloadCache = new Map<string, PreloadCacheEntry>()
  const staleRequestIds = new Set<number>()

  const currentPlayback = ref<PlaybackCache | null>(null)
  const previousPlaybackList = ref<PlaybackCache[]>([])

  let activeRequest: { filePath: string; requestId: number } | null = null

  const resolveBpmFromList = (filePath: string): number | null => {
    const list = runtime.playingData.playingSongListData
    if (!Array.isArray(list) || list.length === 0) return null
    const match = list.find((item) => item.filePath === filePath)
    const bpmValue = match?.bpm
    return typeof bpmValue === 'number' && Number.isFinite(bpmValue) && bpmValue > 0
      ? bpmValue
      : null
  }

  const cancelPreloadTimer = (reason?: string) => {
    void reason
    if (preloadTimerId !== null) {
      clearTimeout(preloadTimerId)
      preloadTimerId = null
    }
  }

  const markActiveRequestStale = () => {
    if (activeRequest) {
      staleRequestIds.add(activeRequest.requestId)
      activeRequest = null
    }
  }

  const releasePreloadAudio = (reason: string, entry?: PreloadCacheEntry | null) => {
    void reason
    if (!entry?.audio) return false
    const released = releaseAudioElement(entry.audio)
    entry.audio = null
    return released
  }

  const releasePlaybackAudio = (reason: string, entry?: PlaybackCache | null) => {
    void reason
    if (!entry?.audio) return false
    const released = releaseAudioElement(entry.audio)
    entry.audio = null
    return released
  }

  const releasePlaybackCollection = (reason: string, entries: PlaybackCache[]) => {
    entries.forEach((entry) => {
      releasePlaybackAudio(reason, entry)
    })
  }

  const clearNextCaches = () => {
    preloadQueue.splice(0, preloadQueue.length)
    preloadCache.forEach((entry) => {
      if (entry.status === 'loading') {
        staleRequestIds.add(entry.requestId)
      }
      releasePreloadAudio('clearNextCaches', entry)
    })
    preloadCache.clear()
    markActiveRequestStale()
  }

  const clearAllCaches = () => {
    clearNextCaches()
    if (currentPlayback.value) {
      releasePlaybackAudio('clearAllCaches', currentPlayback.value)
      currentPlayback.value = null
    }
    if (previousPlaybackList.value.length) {
      releasePlaybackCollection('clearAllCaches', previousPlaybackList.value)
      previousPlaybackList.value = []
    }
  }

  const rememberPlayback = (
    filePath: string,
    audio: HTMLAudioElement,
    bpm: number | string | null
  ) => {
    const currentEntry = currentPlayback.value
    if (currentEntry && currentEntry.filePath === filePath && currentEntry.audio === audio) {
      currentPlayback.value = {
        ...currentEntry,
        bpm,
        storedAt: Date.now()
      }
      return
    }

    const wrapped: PlaybackCache = {
      filePath,
      audio,
      bpm,
      storedAt: Date.now()
    }
    if (!currentPlayback.value) {
      currentPlayback.value = wrapped
      return
    }

    if (currentPlayback.value.filePath === filePath) {
      currentPlayback.value = wrapped
      return
    }

    const prevList = previousPlaybackList.value.filter((item) => item.filePath !== filePath)
    prevList.unshift(currentPlayback.value)
    const trimmed = prevList.slice(0, HISTORY_WINDOW)
    const droppedHistory = prevList.slice(HISTORY_WINDOW)
    previousPlaybackList.value = trimmed
    currentPlayback.value = wrapped
    if (droppedHistory.length > 0) {
      releasePlaybackCollection('history-window', droppedHistory)
    }
  }

  const forgetCachesForFile = (filePath: string) => {
    preloadQueue.splice(
      0,
      preloadQueue.length,
      ...preloadQueue.filter((task) => task.filePath !== filePath)
    )
    const entry = preloadCache.get(filePath)
    if (entry && entry.status === 'loading') {
      staleRequestIds.add(entry.requestId)
    }
    if (entry) {
      releasePreloadAudio('forgetCachesForFile', entry)
    }
    preloadCache.delete(filePath)
    const removedHistoryEntries = previousPlaybackList.value.filter(
      (item) => item.filePath === filePath
    )
    if (removedHistoryEntries.length) {
      releasePlaybackCollection('forgetCachesForFile', removedHistoryEntries)
    }
    previousPlaybackList.value = previousPlaybackList.value.filter(
      (item) => item.filePath !== filePath
    )

    if (currentPlayback.value?.filePath === filePath) {
      releasePlaybackAudio('forgetCachesForFile', currentPlayback.value)
      currentPlayback.value = null
    }
  }

  const takePreloadedData = (filePath: string): PreloadHit | null => {
    if (!canPlayHtmlAudio(filePath)) {
      forgetCachesForFile(filePath)
      return null
    }
    const cacheEntry = preloadCache.get(filePath)
    if (cacheEntry && cacheEntry.status === 'ready' && cacheEntry.audio) {
      const audio = cacheEntry.audio
      preloadCache.delete(filePath)
      const latestBpm = resolveBpmFromList(filePath)
      return {
        source: 'next',
        filePath,
        audio,
        bpm: latestBpm ?? cacheEntry.bpm ?? null
      }
    }

    const previousIndex = previousPlaybackList.value.findIndex((item) => item.filePath === filePath)
    if (previousIndex !== -1) {
      const matched = previousPlaybackList.value[previousIndex]
      if (!matched.audio) {
        return null
      }
      const latestBpm = resolveBpmFromList(filePath)
      return {
        source: 'previous',
        filePath,
        audio: matched.audio,
        bpm: latestBpm ?? matched.bpm ?? null
      }
    }

    return null
  }

  const enqueuePreloadTargets = (targets: PreloadTask[]) => {
    for (const target of targets) {
      if (preloadCache.has(target.filePath)) {
        const exist = preloadCache.get(target.filePath)!
        exist.offset = target.offset
        if (typeof target.bpm === 'number' && Number.isFinite(target.bpm) && target.bpm > 0) {
          exist.bpm = target.bpm
        }
        continue
      }
      if (preloadQueue.some((task) => task.filePath === target.filePath)) continue
      preloadQueue.push(target)
    }
  }

  const processQueue = () => {
    if (activeRequest) return
    if (preloadQueue.length === 0) return

    preloadQueue.sort((a, b) => a.offset - b.offset)
    const task = preloadQueue.shift()
    if (!task) return

    const requestId = currentPreloadRequestId.value + 1
    currentPreloadRequestId.value = requestId

    const entry: PreloadCacheEntry = {
      filePath: task.filePath,
      status: 'loading',
      requestId,
      offset: task.offset,
      bpm: task.bpm ?? null,
      updatedAt: Date.now()
    }

    if (!canPlayHtmlAudio(task.filePath)) {
      preloadCache.delete(task.filePath)
      processQueue()
      return
    }

    const audio = createPreloadAudio(task.filePath)
    if (!audio) {
      preloadCache.delete(task.filePath)
      processQueue()
      return
    }
    entry.audio = audio
    preloadCache.set(task.filePath, entry)
    activeRequest = { filePath: task.filePath, requestId }

    const finalize = (status: 'ready' | 'error') => {
      if (staleRequestIds.has(requestId)) {
        staleRequestIds.delete(requestId)
        releasePreloadAudio('stale', entry)
        if (activeRequest?.requestId === requestId) {
          activeRequest = null
        }
        processQueue()
        return
      }

      const latest = preloadCache.get(task.filePath)
      if (!latest || latest.requestId !== requestId) {
        releasePreloadAudio('mismatch', entry)
        if (activeRequest?.requestId === requestId) {
          activeRequest = null
        }
        processQueue()
        return
      }
      if (latest.status !== 'loading') {
        if (activeRequest?.requestId === requestId) {
          activeRequest = null
        }
        processQueue()
        return
      }

      if (status === 'ready') {
        latest.status = 'ready'
        latest.audio = audio
        latest.bpm = latest.bpm ?? resolveBpmFromList(task.filePath)
        latest.updatedAt = Date.now()
      } else {
        latest.status = 'error'
        latest.updatedAt = Date.now()
        releasePreloadAudio('decode:error', latest)
        preloadCache.delete(task.filePath)
      }

      if (activeRequest?.requestId === requestId) {
        activeRequest = null
      }
      processQueue()
    }

    audio.addEventListener('loadedmetadata', () => finalize('ready'), { once: true })
    audio.addEventListener('error', () => finalize('error'), { once: true })

    try {
      audio.load()
      if (audio.readyState >= 1) {
        finalize('ready')
      }
    } catch (_) {
      finalize('error')
    }
  }

  const refreshPreloadWindow = () => {
    const currentSong = runtime.playingData.playingSong
    if (!currentSong) {
      clearNextCaches()
      return
    }

    const list = runtime.playingData.playingSongListData
    if (!Array.isArray(list) || list.length === 0) {
      clearNextCaches()
      return
    }

    const currentIndex = list.findIndex((item) => item.filePath === currentSong.filePath)
    if (currentIndex === -1) {
      clearNextCaches()
      return
    }

    const targets: PreloadTask[] = []
    for (const offset of PRELOAD_OFFSETS) {
      const nextItem = list[currentIndex + offset]
      if (nextItem?.filePath && canPlayHtmlAudio(nextItem.filePath)) {
        const bpmValue =
          typeof nextItem.bpm === 'number' && Number.isFinite(nextItem.bpm) && nextItem.bpm > 0
            ? nextItem.bpm
            : null
        targets.push({ filePath: nextItem.filePath, offset, bpm: bpmValue })
      } else if (nextItem?.filePath) {
        forgetCachesForFile(nextItem.filePath)
      }
    }

    const allowed = new Set(targets.map((item) => item.filePath))

    for (let i = preloadQueue.length - 1; i >= 0; i--) {
      if (!allowed.has(preloadQueue[i].filePath)) {
        preloadQueue.splice(i, 1)
      }
    }

    const removedEntries: PreloadCacheEntry[] = []
    preloadCache.forEach((entry, filePath) => {
      if (allowed.has(filePath)) return
      if (entry.status === 'loading') {
        staleRequestIds.add(entry.requestId)
      }
      removedEntries.push(entry)
    })
    removedEntries.forEach((entry) => {
      preloadCache.delete(entry.filePath)
      releasePreloadAudio('refreshPreloadWindow', entry)
    })
    enqueuePreloadTargets(targets)
    processQueue()
  }

  const schedulePreloadAfterPlay = () => {
    cancelPreloadTimer()
    preloadTimerId = setTimeout(() => {
      const timerId = preloadTimerId
      refreshPreloadWindow()
      if (preloadTimerId === timerId) preloadTimerId = null
    }, PRELOAD_DELAY)
  }

  onUnmounted(() => {
    cancelPreloadTimer()
    clearAllCaches()
  })

  return {
    currentPreloadRequestId,
    schedulePreloadAfterPlay,
    cancelPreloadTimer,
    refreshPreloadWindow,
    clearNextCaches,
    clearAllCaches,
    takePreloadedData,
    rememberPlayback,
    forgetCachesForFile,
    getPreviousCachedFilePath: () => previousPlaybackList.value[0]?.filePath ?? null,
    getCurrentCachedFilePath: () => currentPlayback.value?.filePath ?? null
  }
}
