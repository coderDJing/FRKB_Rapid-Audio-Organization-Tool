import { markRaw, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'
import { getRekordboxCoverThumbChannel } from '@renderer/utils/rekordboxExternalSource'
import {
  createCoverDisplayWorkerClient,
  type CoverDisplayWorkerResult
} from './coverDisplayWorkerClient'
import { resolveCoverPathIdentity } from './coverPathIdentity'

interface UseCoverThumbnailsOptions {
  songs: Ref<ISongInfo[] | undefined>
  visibleSongsWithIndex: Ref<Array<{ song: ISongInfo; idx: number }>>
  startIndex: Ref<number>
  endIndex: Ref<number>
  actualStartIndex: Ref<number>
  actualEndIndex: Ref<number>
  visibleCount: Ref<number>
  songListRootDir?: Ref<string | undefined>
  sessionIdentity?: Ref<string | undefined>
  platform?: Ref<string | undefined>
  enabled?: Ref<boolean>
}

type PioneerCoverResponse = {
  format?: string
  data?: Uint8Array | { data: number[] } | number[]
  dataUrl?: string
}

type CoverThumbResponse = PioneerCoverResponse & {
  cacheStatus?: 'hit' | 'miss' | 'disabled'
  sourceBytes?: number
  outputBytes?: number
  resized?: boolean
  needsDisplayCache?: boolean
  imageHash?: string
  legacyExt?: string
}

type QueuePriority = 'visible' | 'prefetch'

type QueueTask = {
  filePath: string
  generation: number
  priority: QueuePriority
  queuedAtMs: number
  run: () => void
  resolve: (value: string | null) => void
}

type InflightCover = {
  generation: number
  promise: Promise<string | null>
  task?: QueueTask
}

type RunningCoverCounts = {
  visible: number
  prefetch: number
}

type CoverSessionStats = {
  generation: number
  identity: string
  startedAtMs: number
  requestedCount: number
  completedCount: number
  staleCount: number
  failedCount: number
  cacheHitCount: number
  cacheMissCount: number
  resizedCount: number
  sourceBytes: number
  outputBytes: number
  maxRequestDurationMs: number
  maxQueueWaitDurationMs: number
  imageErrorCount: number
  diagnosticLogged: boolean
}

export function useCoverThumbnails({
  songs,
  visibleSongsWithIndex,
  startIndex,
  endIndex,
  actualStartIndex,
  actualEndIndex,
  visibleCount,
  songListRootDir,
  sessionIdentity,
  platform,
  enabled
}: UseCoverThumbnailsOptions) {
  const coverUrlCache = markRaw(new Map<string, string | null>())
  const inflight = markRaw(new Map<string, InflightCover>())
  const pendingVisibleQueue: QueueTask[] = []
  const pendingPrefetchQueue: QueueTask[] = []
  const runningByGeneration = new Map<number, RunningCoverCounts>()
  let displayWorker = createCoverDisplayWorkerClient()
  const displayConversionCache = new Map<string, CoverDisplayWorkerResult>()
  const displayConversionInflight = new Map<string, Promise<CoverDisplayWorkerResult>>()
  const coversTick = ref(0)
  const clientKey = `song-list-covers-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  let generation = 0
  let stats: CoverSessionStats | null = null
  let disposed = false
  const MAX_CONCURRENCY = 6
  const MAX_PREFETCH_CONCURRENCY = 2

  const formatCoverDiagnosticMessage = (
    message: string,
    details: Record<string, unknown>
  ): string => {
    try {
      return `${message} ${JSON.stringify(details)}`
    } catch {
      return message
    }
  }

  const writeCoverDiagnosticEvent = (message: string, details: Record<string, unknown>) => {
    try {
      window.electron.ipcRenderer.send('outputLog', {
        level: 'info',
        source: 'renderer',
        scope: 'cover-load-diagnostic',
        message: formatCoverDiagnosticMessage(message, details),
        details
      })
    } catch {}
  }

  const resolveCoverCacheKey = (value: string | undefined | null) => {
    return resolveCoverPathIdentity(value, platform?.value)
  }
  const normalizeFilePath = (value: string | undefined | null) => resolveCoverCacheKey(value)

  const revokeCoverUrl = (url: string | null | undefined) => {
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url)
  }

  const resolveSongs = () => songs.value ?? []
  const resolveRootDir = () => (songListRootDir ? songListRootDir.value : undefined)
  const isEnabled = () => (enabled ? enabled.value !== false : true)
  const resolveSessionIdentity = () =>
    String(sessionIdentity?.value || `${resolveRootDir() || ''}:${resolveSongs().length}`)
  const resolveSongByFilePath = (filePath: string) => {
    const cacheKey = resolveCoverCacheKey(filePath)
    return resolveSongs().find((song) => resolveCoverCacheKey(song?.filePath) === cacheKey) || null
  }
  const isCurrentGeneration = (taskGeneration: number) => !disposed && taskGeneration === generation

  const cacheCoverUrl = (filePath: string, url: string | null, taskGeneration: number) => {
    if (!isCurrentGeneration(taskGeneration)) {
      revokeCoverUrl(url)
      return false
    }
    coverUrlCache.set(resolveCoverCacheKey(filePath), url)
    coversTick.value++
    return true
  }

  const toUint8Array = (data: PioneerCoverResponse['data']): Uint8Array | null => {
    if (!data) return null
    if (data instanceof Uint8Array) return data
    if (Array.isArray(data)) return new Uint8Array(data)
    return new Uint8Array(data.data || [])
  }

  const persistDisplayCache = (
    filePath: string,
    response: CoverThumbResponse,
    converted: CoverDisplayWorkerResult,
    taskGeneration: number
  ) => {
    if (!isCurrentGeneration(taskGeneration)) return
    void window.electron.ipcRenderer
      .invoke('persistSongCoverDisplayCache', {
        filePath,
        listRootDir: String(resolveRootDir() || '').trim(),
        imageHash: String(response.imageHash || '').trim(),
        legacyExt: response.legacyExt,
        format: converted.format,
        data: converted.data,
        requestContext: { clientKey, generation: taskGeneration }
      })
      .catch(() => {})
  }

  const scheduleDisplayCache = (
    filePath: string,
    response: CoverThumbResponse,
    taskGeneration: number
  ) => {
    const raw = toUint8Array(response.data)
    const imageHash = String(response.imageHash || '').trim()
    const listRootDir = String(resolveRootDir() || '').trim()
    if (!response.needsDisplayCache || !raw?.length || !imageHash || !listRootDir) return

    const conversionKey = `${listRootDir}:${imageHash}`
    const converted = displayConversionCache.get(conversionKey)
    if (converted) {
      persistDisplayCache(filePath, response, converted, taskGeneration)
      return
    }

    let conversionTask = displayConversionInflight.get(conversionKey)
    if (!conversionTask) {
      conversionTask = displayWorker
        .resize(raw, response.format || 'image/jpeg', 256)
        .then((result) => {
          displayConversionCache.set(conversionKey, result)
          if (stats?.generation === taskGeneration && result.resized) {
            stats.resizedCount += 1
          }
          persistDisplayCache(filePath, response, result, taskGeneration)
          return result
        })
        .finally(() => displayConversionInflight.delete(conversionKey))
      displayConversionInflight.set(conversionKey, conversionTask)
      void conversionTask.catch(() => {})
      return
    }
    void conversionTask
      .then((result) => persistDisplayCache(filePath, response, result, taskGeneration))
      .catch(() => {})
  }

  const prepareDisplayResponse = (
    filePath: string,
    response: CoverThumbResponse,
    taskGeneration: number
  ): CoverThumbResponse => {
    if (!response.needsDisplayCache) return response
    const raw = toUint8Array(response.data)
    const imageHash = String(response.imageHash || '').trim()
    const listRootDir = String(resolveRootDir() || '').trim()
    if (!raw?.length || !imageHash || !listRootDir) return response

    const conversionKey = `${listRootDir}:${imageHash}`
    const converted = displayConversionCache.get(conversionKey)
    if (!converted) {
      scheduleDisplayCache(filePath, response, taskGeneration)
      return response
    }
    persistDisplayCache(filePath, response, converted, taskGeneration)
    return {
      ...response,
      format: converted.format,
      data: converted.data,
      sourceBytes: converted.sourceBytes,
      outputBytes: converted.outputBytes,
      resized: converted.resized,
      needsDisplayCache: false
    }
  }

  const writeDiagnostic = (
    reason: string,
    snapshot: CoverSessionStats | null,
    resetContext?: { nextIdentity: string; coverCacheEntryCount: number }
  ): boolean => {
    if (!snapshot || snapshot.diagnosticLogged) return false
    const elapsedMs = Date.now() - snapshot.startedAtMs
    const lifecycleClearedCovers =
      (reason === 'session-changed' || reason === 'unmounted') &&
      Number(resetContext?.coverCacheEntryCount || 0) > 0
    if (
      snapshot.maxRequestDurationMs < 500 &&
      snapshot.maxQueueWaitDurationMs < 500 &&
      snapshot.staleCount === 0 &&
      snapshot.failedCount === 0 &&
      snapshot.imageErrorCount === 0 &&
      !lifecycleClearedCovers
    ) {
      return false
    }
    try {
      const details = {
        reason,
        clientKey,
        generation: snapshot.generation,
        identity: snapshot.identity,
        nextIdentity: resetContext?.nextIdentity,
        coverCacheEntryCount: resetContext?.coverCacheEntryCount,
        elapsedMs,
        requestedCount: snapshot.requestedCount,
        completedCount: snapshot.completedCount,
        staleCount: snapshot.staleCount,
        failedCount: snapshot.failedCount,
        imageErrorCount: snapshot.imageErrorCount,
        cacheHitCount: snapshot.cacheHitCount,
        cacheMissCount: snapshot.cacheMissCount,
        resizedCount: snapshot.resizedCount,
        sourceBytes: snapshot.sourceBytes,
        outputBytes: snapshot.outputBytes,
        maxRequestDurationMs: snapshot.maxRequestDurationMs,
        maxQueueWaitDurationMs: snapshot.maxQueueWaitDurationMs
      }
      window.electron.ipcRenderer.send('outputLog', {
        level: 'info',
        source: 'renderer',
        scope: 'cover-load-diagnostic',
        message: formatCoverDiagnosticMessage('cover session completed', details),
        details
      })
      snapshot.diagnosticLogged = true
      return true
    } catch {
      return false
    }
  }

  const cancelMainSession = (cancelledGeneration: number) => {
    if (cancelledGeneration <= 0) return
    try {
      window.electron.ipcRenderer.send('cancelSongCoverSession', {
        clientKey,
        generation: cancelledGeneration
      })
    } catch {}
  }

  const clearQueues = () => {
    for (const queue of [pendingVisibleQueue, pendingPrefetchQueue]) {
      for (const task of queue) task.resolve(null)
      queue.length = 0
    }
  }

  const resetSession = (reason: string) => {
    const hadPreviousSession = stats !== null
    const previousGeneration = generation
    const previousRunning = runningByGeneration.get(previousGeneration)
    const nextIdentity = resolveSessionIdentity()
    if (stats?.generation === previousGeneration) {
      stats.staleCount +=
        (previousRunning?.visible || 0) +
        (previousRunning?.prefetch || 0) +
        pendingVisibleQueue.length +
        pendingPrefetchQueue.length
    }
    writeDiagnostic(reason, stats, {
      nextIdentity,
      coverCacheEntryCount: coverUrlCache.size
    })
    generation += 1
    cancelMainSession(previousGeneration)
    clearQueues()
    for (const url of coverUrlCache.values()) revokeCoverUrl(url)
    coverUrlCache.clear()
    inflight.clear()
    displayConversionCache.clear()
    displayConversionInflight.clear()
    displayWorker.dispose()
    displayWorker = createCoverDisplayWorkerClient()
    stats = {
      generation,
      identity: nextIdentity,
      startedAtMs: Date.now(),
      requestedCount: 0,
      completedCount: 0,
      staleCount: 0,
      failedCount: 0,
      cacheHitCount: 0,
      cacheMissCount: 0,
      resizedCount: 0,
      sourceBytes: 0,
      outputBytes: 0,
      maxRequestDurationMs: 0,
      maxQueueWaitDurationMs: 0,
      imageErrorCount: 0,
      diagnosticLogged: false
    }
    writeCoverDiagnosticEvent('cover session started', {
      reason: hadPreviousSession ? reason : 'initial',
      clientKey,
      generation,
      identity: nextIdentity,
      enabled: isEnabled(),
      platform: platform?.value || '',
      songCount: resolveSongs().length,
      songListRootDir: String(resolveRootDir() || '').trim()
    })
    coversTick.value++
  }

  function pump() {
    if (disposed) return
    const running = runningByGeneration.get(generation) || { visible: 0, prefetch: 0 }
    while (running.visible + running.prefetch < MAX_CONCURRENCY) {
      const task =
        pendingVisibleQueue.shift() ||
        (running.prefetch < MAX_PREFETCH_CONCURRENCY ? pendingPrefetchQueue.shift() : undefined)
      if (!task) break
      if (!isCurrentGeneration(task.generation)) {
        task.resolve(null)
        continue
      }
      running[task.priority] += 1
      runningByGeneration.set(task.generation, running)
      task.run()
    }
  }

  function onImgError(filePath: string) {
    if (disposed) return
    const cacheKey = resolveCoverCacheKey(filePath)
    const failedUrl = coverUrlCache.get(cacheKey)
    if (stats?.generation === generation) {
      stats.imageErrorCount += 1
      if (stats.imageErrorCount === 1) {
        writeCoverDiagnosticEvent('cover image element failed', {
          clientKey,
          generation,
          identity: stats.identity,
          filePath,
          urlKind: failedUrl?.startsWith('blob:') ? 'blob' : failedUrl ? 'other' : 'missing',
          coverCacheEntryCount: coverUrlCache.size,
          songCount: resolveSongs().length
        })
      }
    }
    revokeCoverUrl(failedUrl)
    cacheCoverUrl(filePath, null, generation)
  }

  function getCoverUrl(filePath: string): string | null | undefined {
    return coverUrlCache.get(resolveCoverCacheKey(filePath))
  }

  function fetchCoverUrl(
    filePath: string,
    priority: QueuePriority = 'visible'
  ): Promise<string | null> {
    if (disposed || !isEnabled()) return Promise.resolve(null)
    if (!filePath) return Promise.resolve(null)
    const taskGeneration = generation
    const cacheKey = resolveCoverCacheKey(filePath)
    const cached = coverUrlCache.get(cacheKey)
    if (cached !== undefined) return Promise.resolve(cached)
    const existing = inflight.get(cacheKey)
    if (existing?.generation === taskGeneration) {
      if (priority === 'visible' && existing.task?.priority === 'prefetch') {
        const pendingIndex = pendingPrefetchQueue.indexOf(existing.task)
        if (pendingIndex >= 0) {
          pendingPrefetchQueue.splice(pendingIndex, 1)
          existing.task.priority = 'visible'
          pendingVisibleQueue.push(existing.task)
          pump()
        }
      }
      return existing.promise
    }

    let queuedTask: QueueTask | undefined
    const promise = new Promise<string | null>((resolve) => {
      const run = async () => {
        const runningPriority = queuedTask?.priority || priority
        const requestStartedAtMs = Date.now()
        if (stats?.generation === taskGeneration) stats.requestedCount += 1
        try {
          if (!isCurrentGeneration(taskGeneration)) {
            if (stats?.generation === taskGeneration) stats.staleCount += 1
            resolve(null)
            return
          }
          const song = resolveSongByFilePath(filePath)
          const requestFilePath = String(song?.filePath || filePath).trim()
          const pioneerCoverPath = String(song?.pioneerCoverPath || '').trim()
          const sourceKind =
            song?.externalSourceKind === 'desktop' || song?.externalSourceKind === 'usb'
              ? song.externalSourceKind
              : 'usb'
          const rawResp: CoverThumbResponse | null = pioneerCoverPath
            ? ((await window.electron.ipcRenderer.invoke(
                getRekordboxCoverThumbChannel(sourceKind),
                pioneerCoverPath
              )) as CoverThumbResponse | null)
            : ((await window.electron.ipcRenderer.invoke(
                'getSongCoverThumb',
                requestFilePath,
                48,
                resolveRootDir(),
                { clientKey, generation: taskGeneration }
              )) as CoverThumbResponse | null)

          if (!isCurrentGeneration(taskGeneration)) {
            if (stats?.generation === taskGeneration) stats.staleCount += 1
            resolve(null)
            return
          }
          const resp = rawResp
            ? prepareDisplayResponse(requestFilePath, rawResp, taskGeneration)
            : null
          if (!isCurrentGeneration(taskGeneration)) {
            if (stats?.generation === taskGeneration) stats.staleCount += 1
            resolve(null)
            return
          }
          if (stats?.generation === taskGeneration) {
            stats.maxQueueWaitDurationMs = Math.max(
              stats.maxQueueWaitDurationMs,
              requestStartedAtMs - (queuedTask?.queuedAtMs || requestStartedAtMs)
            )
            stats.completedCount += 1
            if (resp?.cacheStatus === 'hit') stats.cacheHitCount += 1
            if (resp?.cacheStatus === 'miss') stats.cacheMissCount += 1
            if (resp?.resized) stats.resizedCount += 1
            stats.sourceBytes += Number(resp?.sourceBytes || 0)
            stats.outputBytes += Number(resp?.outputBytes || 0)
          }
          if (resp?.dataUrl) {
            resolve(cacheCoverUrl(filePath, resp.dataUrl, taskGeneration) ? resp.dataUrl : null)
            return
          }
          if (resp?.data) {
            const raw = toUint8Array(resp.data)
            if (!raw?.length) {
              cacheCoverUrl(filePath, null, taskGeneration)
              resolve(null)
              return
            }
            const blobBytes = new Uint8Array(raw.byteLength)
            blobBytes.set(raw)
            const blob = new Blob([blobBytes.buffer], {
              type: resp.format || 'image/jpeg'
            })
            const url = URL.createObjectURL(blob)
            resolve(cacheCoverUrl(filePath, url, taskGeneration) ? url : null)
            return
          }
          cacheCoverUrl(filePath, null, taskGeneration)
          resolve(null)
        } catch {
          if (stats?.generation === taskGeneration) stats.failedCount += 1
          cacheCoverUrl(filePath, null, taskGeneration)
          resolve(null)
        } finally {
          if (stats?.generation === taskGeneration) {
            stats.maxRequestDurationMs = Math.max(
              stats.maxRequestDurationMs,
              Date.now() - requestStartedAtMs
            )
          }
          const activeInflight = inflight.get(cacheKey)
          if (activeInflight?.generation === taskGeneration) inflight.delete(cacheKey)
          const running = runningByGeneration.get(taskGeneration)
          if (running) {
            running[runningPriority] = Math.max(0, running[runningPriority] - 1)
            if (running.visible + running.prefetch > 0) {
              runningByGeneration.set(taskGeneration, running)
            } else {
              runningByGeneration.delete(taskGeneration)
            }
          }
          pump()
          const currentRunning = runningByGeneration.get(generation)
          if (
            taskGeneration === generation &&
            !currentRunning &&
            pendingVisibleQueue.length === 0 &&
            pendingPrefetchQueue.length === 0
          ) {
            writeDiagnostic('queue-idle', stats)
          }
        }
      }

      queuedTask = {
        filePath,
        generation: taskGeneration,
        priority,
        queuedAtMs: Date.now(),
        run,
        resolve
      }
      if (priority === 'visible') pendingVisibleQueue.push(queuedTask)
      else pendingPrefetchQueue.push(queuedTask)
      pump()
    })

    inflight.set(cacheKey, { generation: taskGeneration, promise, task: queuedTask })
    return promise
  }

  function clearPendingByPath(filePath?: string) {
    if (!filePath) return
    for (const queue of [pendingVisibleQueue, pendingPrefetchQueue]) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const task = queue[i]
        if (resolveCoverCacheKey(task.filePath) === resolveCoverCacheKey(filePath)) {
          queue.splice(i, 1)
          task.resolve(null)
        }
      }
    }
  }

  function handleSongMetadataUpdated(payload: { filePath?: string; oldFilePath?: string }) {
    if (disposed) return
    const newPath = payload?.filePath
    if (payload?.oldFilePath) {
      const oldCacheKey = resolveCoverCacheKey(payload.oldFilePath)
      revokeCoverUrl(coverUrlCache.get(oldCacheKey))
      coverUrlCache.delete(oldCacheKey)
      inflight.delete(oldCacheKey)
      clearPendingByPath(payload.oldFilePath)
    }
    if (!newPath) return
    const newCacheKey = resolveCoverCacheKey(newPath)
    revokeCoverUrl(coverUrlCache.get(newCacheKey))
    coverUrlCache.delete(newCacheKey)
    inflight.delete(newCacheKey)
    clearPendingByPath(newPath)
    coversTick.value++
    void fetchCoverUrl(newPath)
  }

  function primePrefetchWindow() {
    if (disposed || !isEnabled()) return
    const arr = resolveSongs()
    const actualStart = Math.max(0, actualStartIndex.value)
    const actualEnd = Math.min(arr.length, actualEndIndex.value)
    for (let i = actualStart; i < actualEnd; i += 1) {
      const fp = arr[i]?.filePath
      if (fp && !coverUrlCache.has(resolveCoverCacheKey(fp))) void fetchCoverUrl(fp, 'visible')
    }
    const start = Math.max(0, startIndex.value - visibleCount.value)
    const end = Math.min(arr.length, endIndex.value + visibleCount.value)
    for (let i = start; i < end; i += 1) {
      if (i >= actualStart && i < actualEnd) continue
      const fp = arr[i]?.filePath
      if (fp && !coverUrlCache.has(resolveCoverCacheKey(fp))) void fetchCoverUrl(fp, 'prefetch')
    }
  }

  const stopSessionWatch = watch(
    () =>
      `${resolveSessionIdentity()}|${isEnabled() ? 'enabled' : 'disabled'}|${platform?.value || ''}`,
    () => {
      resetSession('session-changed')
      if (isEnabled()) primePrefetchWindow()
    },
    { immediate: true }
  )

  const stopVisibleWatch = watch(
    () =>
      visibleSongsWithIndex.value
        .map((item: { song: ISongInfo; idx: number }) => item.song?.filePath || '')
        .join('|'),
    () => {
      primePrefetchWindow()
    },
    { immediate: true }
  )

  const stopSongsReferenceWatch = watch(
    () => resolveSongs(),
    (nextSongs, previousSongs) => {
      if (nextSongs === previousSongs) return
      const previousPaths = (previousSongs || [])
        .map((song) => String(song?.filePath || '').trim())
        .filter(Boolean)
      const nextPaths = (nextSongs || [])
        .map((song) => String(song?.filePath || '').trim())
        .filter(Boolean)
      if (previousPaths.length === 0 && coverUrlCache.size === 0) return

      const previousExact = new Set(previousPaths)
      const previousByNormalized = new Map<string, string>()
      for (const filePath of previousPaths) {
        const normalized = normalizeFilePath(filePath)
        if (normalized && !previousByNormalized.has(normalized)) {
          previousByNormalized.set(normalized, filePath)
        }
      }
      const cachedExact = new Set(coverUrlCache.keys())
      const cachedNormalized = new Set([...cachedExact].map(normalizeFilePath))
      let exactPathOverlapCount = 0
      let normalizedPathOverlapCount = 0
      let nextExactCoverCacheHitCount = 0
      let nextNormalizedCoverCacheHitCount = 0
      const pathRepresentationSamples: Array<{ previous: string; next: string }> = []

      for (const filePath of nextPaths) {
        if (previousExact.has(filePath)) exactPathOverlapCount += 1
        const normalized = normalizeFilePath(filePath)
        const previousPath = previousByNormalized.get(normalized)
        if (previousPath) {
          normalizedPathOverlapCount += 1
          if (previousPath !== filePath && pathRepresentationSamples.length < 3) {
            pathRepresentationSamples.push({ previous: previousPath, next: filePath })
          }
        }
        if (cachedExact.has(filePath)) nextExactCoverCacheHitCount += 1
        if (cachedNormalized.has(normalized)) nextNormalizedCoverCacheHitCount += 1
      }

      writeCoverDiagnosticEvent('cover song data replaced', {
        clientKey,
        generation,
        identity: resolveSessionIdentity(),
        previousSongCount: previousPaths.length,
        nextSongCount: nextPaths.length,
        exactPathOverlapCount,
        normalizedPathOverlapCount,
        pathRepresentationChangedCount: Math.max(
          0,
          normalizedPathOverlapCount - exactPathOverlapCount
        ),
        coverCacheEntryCount: coverUrlCache.size,
        nextExactCoverCacheHitCount,
        nextNormalizedCoverCacheHitCount,
        pathRepresentationSamples
      })
    }
  )

  const stopRangeWatch = watch(
    () =>
      [
        startIndex.value,
        endIndex.value,
        actualStartIndex.value,
        actualEndIndex.value,
        resolveSongs().length
      ] as const,
    () => primePrefetchWindow(),
    { deep: false }
  )

  onMounted(() => {
    if (isEnabled()) primePrefetchWindow()
    emitter.on('songMetadataUpdated', handleSongMetadataUpdated)
  })

  onUnmounted(() => {
    writeCoverDiagnosticEvent('cover rows unmounted', {
      clientKey,
      generation,
      identity: stats?.identity || resolveSessionIdentity(),
      songCount: resolveSongs().length,
      coverCacheEntryCount: coverUrlCache.size,
      requestedCount: stats?.requestedCount || 0,
      completedCount: stats?.completedCount || 0,
      imageErrorCount: stats?.imageErrorCount || 0
    })
    writeDiagnostic('unmounted', stats, {
      nextIdentity: resolveSessionIdentity(),
      coverCacheEntryCount: coverUrlCache.size
    })
    cancelMainSession(generation)
    disposed = true
    emitter.off('songMetadataUpdated', handleSongMetadataUpdated)
    stopVisibleWatch()
    stopSongsReferenceWatch()
    stopRangeWatch()
    stopSessionWatch()
    for (const url of coverUrlCache.values()) revokeCoverUrl(url)
    clearQueues()
    coverUrlCache.clear()
    inflight.clear()
    displayConversionCache.clear()
    displayConversionInflight.clear()
    displayWorker.dispose()
    runningByGeneration.clear()
  })

  return {
    coversTick,
    getCoverUrl,
    fetchCoverUrl,
    onImgError
  }
}
