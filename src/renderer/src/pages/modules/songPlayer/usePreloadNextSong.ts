import { ref, onUnmounted } from 'vue'
import * as realtimeBpm from 'realtime-bpm-analyzer'
import { useRuntimeStore } from '@renderer/stores/runtime'

type PcmPayload = {
  pcmData: Float32Array
  sampleRate: number
  channels: number
  totalFrames: number
}

type PreloadCacheEntry = {
  filePath: string
  status: 'loading' | 'ready' | 'error'
  requestId: number
  offset: number
  payload?: PcmPayload
  bpm?: number | string | null
  updatedAt: number
}

type PreloadTask = {
  filePath: string
  offset: number
}

type PlaybackCache = {
  filePath: string
  payload: PcmPayload
  bpm: number | string | null
  storedAt: number
}

type PreloadHit =
  | {
      source: 'next'
      filePath: string
      payload: PcmPayload
      bpm: number | string | null
    }
  | {
      source: 'previous'
      filePath: string
      payload: PcmPayload
      bpm: number | string | null
    }

const PRELOAD_OFFSETS = [1, 2, 3]
const PRELOAD_DELAY = 3000

export function usePreloadNextSong(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioContext: AudioContext
}) {
  const { runtime, audioContext } = params

  const currentPreloadRequestId = ref(0)
  let preloadTimerId: any = null

  const preloadQueue: PreloadTask[] = []
  const preloadCache = new Map<string, PreloadCacheEntry>()
  const staleRequestIds = new Set<number>()

  const currentPlayback = ref<PlaybackCache | null>(null)
  const previousPlaybackList = ref<PlaybackCache[]>([])

  let activeRequest: { filePath: string; requestId: number } | null = null

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

  const clearNextCaches = () => {
    preloadQueue.splice(0, preloadQueue.length)
    preloadCache.forEach((entry) => {
      if (entry.status === 'loading') {
        staleRequestIds.add(entry.requestId)
      }
    })
    preloadCache.clear()
    markActiveRequestStale()
  }

  const clearAllCaches = () => {
    clearNextCaches()
    currentPlayback.value = null
    previousPlaybackList.value = []
  }

  const rememberPlayback = (filePath: string, payload: PcmPayload, bpm: number | string | null) => {
    const wrapped: PlaybackCache = {
      filePath,
      payload,
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
    previousPlaybackList.value = prevList.slice(0, 3)
    currentPlayback.value = wrapped
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
    preloadCache.delete(filePath)
    previousPlaybackList.value = previousPlaybackList.value.filter(
      (item) => item.filePath !== filePath
    )

    if (currentPlayback.value?.filePath === filePath) {
      currentPlayback.value = null
    }
  }

  const takePreloadedData = (filePath: string): PreloadHit | null => {
    const cacheEntry = preloadCache.get(filePath)
    if (cacheEntry && cacheEntry.status === 'ready' && cacheEntry.payload) {
      preloadCache.delete(filePath)
      return {
        source: 'next',
        filePath,
        payload: cacheEntry.payload,
        bpm: cacheEntry.bpm ?? null
      }
    }

    const previousIndex = previousPlaybackList.value.findIndex((item) => item.filePath === filePath)
    if (previousIndex !== -1) {
      const matched = previousPlaybackList.value[previousIndex]
      return {
        source: 'previous',
        filePath,
        payload: matched.payload,
        bpm: matched.bpm ?? null
      }
    }

    return null
  }

  const enqueuePreloadTargets = (targets: PreloadTask[]) => {
    for (const target of targets) {
      if (preloadCache.has(target.filePath)) {
        const exist = preloadCache.get(target.filePath)!
        exist.offset = target.offset
        continue
      }
      if (preloadQueue.some((task) => task.filePath === target.filePath)) continue
      preloadQueue.push(target)
    }
  }

  const processQueue = () => {
    if (activeRequest) return
    if (preloadQueue.length === 0) return

    // 保证串行顺序：下一首优先，其次下下首，下下下首
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
      updatedAt: Date.now()
    }
    preloadCache.set(task.filePath, entry)
    activeRequest = { filePath: task.filePath, requestId }

    window.electron.ipcRenderer.send('readNextSongFile', task.filePath, requestId)
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
      if (nextItem?.filePath) {
        targets.push({ filePath: nextItem.filePath, offset })
      }
    }

    const allowed = new Set(targets.map((item) => item.filePath))

    // 清理队列中不再需要的任务
    for (let i = preloadQueue.length - 1; i >= 0; i--) {
      if (!allowed.has(preloadQueue[i].filePath)) {
        preloadQueue.splice(i, 1)
      }
    }

    // 清理缓存中不再需要的曲目
    preloadCache.forEach((entry, filePath) => {
      if (allowed.has(filePath)) return
      if (entry.status === 'loading') {
        staleRequestIds.add(entry.requestId)
      }
      preloadCache.delete(filePath)
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

  const onReadedNextSongFile = async (
    event: any,
    pcmData: PcmPayload,
    filePath: string,
    requestId?: number
  ) => {
    void event
    if (!requestId) return
    if (staleRequestIds.has(requestId)) {
      staleRequestIds.delete(requestId)
      if (activeRequest?.requestId === requestId) {
        activeRequest = null
        processQueue()
      }
      return
    }

    const entry = preloadCache.get(filePath)
    if (!entry || entry.requestId !== requestId) {
      if (activeRequest?.requestId === requestId) {
        activeRequest = null
        processQueue()
      }
      return
    }

    try {
      const audioBuffer = audioContext.createBuffer(
        pcmData.channels,
        pcmData.totalFrames,
        pcmData.sampleRate
      )

      for (let ch = 0; ch < pcmData.channels; ch++) {
        const channelData = audioBuffer.getChannelData(ch)
        for (let i = 0; i < pcmData.totalFrames; i++) {
          channelData[i] = pcmData.pcmData[i * pcmData.channels + ch]
        }
      }

      const topCandidates = await realtimeBpm.analyzeFullBuffer(audioBuffer)
      entry.bpm = topCandidates[0]?.tempo ?? 'N/A'
      entry.payload = pcmData
      entry.status = 'ready'
      entry.updatedAt = Date.now()
    } catch (error) {
      console.warn('[preload] 计算 BPM 失败', error)
      entry.status = 'ready'
      entry.payload = pcmData
      entry.bpm = 'N/A'
      entry.updatedAt = Date.now()
    } finally {
      if (activeRequest?.requestId === requestId) {
        activeRequest = null
      }
      processQueue()
    }
  }

  const onReadNextSongFileError = (
    event: any,
    filePath: string,
    errorMessage: string,
    requestId?: number
  ) => {
    void event
    console.warn('[preload] 预加载失败', filePath, errorMessage)
    if (!requestId) return
    if (staleRequestIds.has(requestId)) {
      staleRequestIds.delete(requestId)
      if (activeRequest?.requestId === requestId) {
        activeRequest = null
        processQueue()
      }
      return
    }

    const entry = preloadCache.get(filePath)
    if (entry && entry.requestId === requestId) {
      entry.status = 'error'
      entry.updatedAt = Date.now()
      preloadCache.delete(filePath)
    }

    if (activeRequest?.requestId === requestId) {
      activeRequest = null
      processQueue()
    }
  }

  window.electron.ipcRenderer.on('readedNextSongFile', onReadedNextSongFile)
  window.electron.ipcRenderer.on('readNextSongFileError', onReadNextSongFileError)

  onUnmounted(() => {
    cancelPreloadTimer()
    window.electron.ipcRenderer.removeListener('readedNextSongFile', onReadedNextSongFile)
    window.electron.ipcRenderer.removeListener('readNextSongFileError', onReadNextSongFileError)
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
