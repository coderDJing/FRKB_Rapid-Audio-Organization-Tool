import { ipcMain } from 'electron'
import { FIXED_MIXTAPE_STEM_MODE } from '../../shared/mixtapeStemMode'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { log } from '../log'
import { resolveMainWorkerPath } from '../workerPath'
import {
  clearTrackCache as svcClearTrackCache,
  findSongListRoot
} from '../services/cacheMaintenance'
import store from '../store'
import { getLibrary, mapRendererPathToFsPath } from '../utils'
import * as LibraryCacheDb from '../libraryCacheDb'
import type { MixxxWaveformData } from '../waveformCache'
import type { MixtapeRawWaveformData } from '../libraryCacheDb/mixtapeRawWaveformCache'
import type { StemWaveformDataLite } from '../stemWaveformCache'
import { queueMixtapeWaveforms } from '../services/mixtapeWaveformQueue'
import { requestMixtapeRawWaveform } from '../services/mixtapeRawWaveformQueue'
import { ensureMixtapeWaveformHires } from '../services/mixtapeWaveformHiresQueue'
import { decodeAudioShared } from '../services/audioDecodePool'
import { ensureMixtapeStemWaveformBundle } from '../services/mixtapeStemWaveformService'

type MixtapeRawWaveformStreamWorkerPayload = {
  jobId?: number
  filePath?: string
  progress?: {
    type?: string
    startFrame?: number
    frames?: number
    totalFrames?: number
    duration?: number
    sampleRate?: number
    rate?: number
    minLeft?: Uint8Array | Buffer
    maxLeft?: Uint8Array | Buffer
    minRight?: Uint8Array | Buffer
    maxRight?: Uint8Array | Buffer
  }
  result?: {
    rawWaveformData?: MixtapeRawWaveformData
  }
  error?: string
}

type RawWaveformStreamRequest = {
  requestId: string
  filePath: string
  sender: Electron.WebContents
  listRoot: string
  stat: { size: number; mtimeMs: number } | null
  targetRate?: number
  startSec: number
  songDurationSec: number
  chunkFrames: number
  expectedDurationSec: number
  bootstrapDurationSec: number
  priorityHint: number
  enqueuedAt: number
  worker?: Worker
  streamStartedAt?: number
  firstChunkAt?: number
  chunkCount: number
}

type CachedRawWaveformContinuation = {
  sender: Electron.WebContents
  requestId: string
  filePath: string
  startFrameOffset: number
  songDurationSec: number
  cached: MixtapeRawWaveformData
  nextStartFrame: number
  followupFramesPerChunk: number
  totalFrames: number
  priorityHint: number
  startedAt: number
  chunkCount: number
  sending: boolean
}

type LiveRawWaveformBufferedChunk = {
  startFrame: number
  frames: number
  totalFrames: number
  duration: number
  sampleRate: number
  rate: number
  minLeft: Uint8Array | Buffer
  maxLeft: Uint8Array | Buffer
  minRight: Uint8Array | Buffer
  maxRight: Uint8Array | Buffer
}

type LiveRawWaveformContinuation = {
  sender: Electron.WebContents
  requestId: string
  filePath: string
  startSec: number
  priorityHint: number
  startedAt: number
  chunkCount: number
  queue: LiveRawWaveformBufferedChunk[]
  continueCredits: number
  donePayload: Record<string, unknown> | null
}

export function registerCacheHandlers() {
  const rawWaveformStreamRequests = new Map<string, RawWaveformStreamRequest>()
  const cachedRawWaveformContinuations = new Map<string, CachedRawWaveformContinuation>()
  const liveRawWaveformContinuations = new Map<string, LiveRawWaveformContinuation>()
  let nextRawWaveformStreamJobId = 0
  const MAX_ACTIVE_RAW_WAVEFORM_STREAMS = 1
  const resolveRequestedRawRate = (value: unknown) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return parsed
  }

  const resolveMixtapeRawWaveformWorkerPath = () =>
    resolveMainWorkerPath(__dirname, 'mixtapeRawWaveformWorker.js')

  const teardownRawWaveformStreamWorker = (worker?: Worker) => {
    if (!worker) return
    try {
      worker.removeAllListeners()
    } catch {}
    try {
      void worker.terminate()
    } catch {}
  }

  const resolveRawWaveformStreamPriorityHint = (value: unknown) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return 0
    return Math.floor(parsed)
  }

  const isHigherPriorityRawWaveformStreamRequest = (
    candidate: RawWaveformStreamRequest,
    current: RawWaveformStreamRequest
  ) =>
    candidate.priorityHint > current.priorityHint ||
    (candidate.priorityHint === current.priorityHint && candidate.enqueuedAt > current.enqueuedAt)

  const listActiveRawWaveformStreamRequests = () =>
    Array.from(rawWaveformStreamRequests.values()).filter((request) => request.worker)

  const listPendingRawWaveformStreamRequests = () =>
    Array.from(rawWaveformStreamRequests.values()).filter((request) => !request.worker)

  const getHighestPriorityPendingRawWaveformStreamRequest = () => {
    const pending = listPendingRawWaveformStreamRequests()
    if (pending.length === 0) return null
    pending.sort((left, right) =>
      isHigherPriorityRawWaveformStreamRequest(left, right)
        ? -1
        : isHigherPriorityRawWaveformStreamRequest(right, left)
          ? 1
          : 0
    )
    return pending[0] || null
  }

  const getLowestPriorityActiveRawWaveformStreamRequest = () => {
    const active = listActiveRawWaveformStreamRequests()
    if (active.length === 0) return null
    active.sort((left, right) =>
      isHigherPriorityRawWaveformStreamRequest(left, right)
        ? -1
        : isHigherPriorityRawWaveformStreamRequest(right, left)
          ? 1
          : 0
    )
    return active[active.length - 1] || null
  }

  const clearRawWaveformStreamRequest = (
    requestId: string,
    options: { keepQueued?: boolean } = {}
  ) => {
    cachedRawWaveformContinuations.delete(requestId)
    liveRawWaveformContinuations.delete(requestId)
    const request = rawWaveformStreamRequests.get(requestId)
    if (!request) return
    const worker = request.worker
    request.worker = undefined
    request.streamStartedAt = undefined
    request.firstChunkAt = undefined
    request.chunkCount = 0
    if (!options.keepQueued) {
      rawWaveformStreamRequests.delete(requestId)
    }
    teardownRawWaveformStreamWorker(worker)
  }

  const resolveRendererListRoot = (value: unknown) => {
    const listRootRaw = typeof value === 'string' ? value.trim() : ''
    if (!listRootRaw) return ''
    let input = listRootRaw
    if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
    if (path.isAbsolute(input)) return input
    if (!store.databaseDir) return ''
    const mapped = mapRendererPathToFsPath(input)
    return path.join(store.databaseDir, mapped)
  }

  const resolveRequestedWaveformRate = (value: unknown) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return parsed
  }

  const isRawWaveformRateSufficient = (
    data: MixtapeRawWaveformData | null | undefined,
    requestedRate?: number
  ) => {
    if (!data) return false
    if (!requestedRate) return true
    const cachedRate = Number(data?.rate)
    if (!Number.isFinite(cachedRate) || cachedRate <= 0) return false
    const sampleRate = Number(data?.sampleRate)
    const cappedSampleRate =
      Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : requestedRate
    const requiredRate = Math.max(1, Math.min(requestedRate, cappedSampleRate))
    return cachedRate >= requiredRate
  }

  const sendCachedRawWaveformStream = async (params: {
    sender: Electron.WebContents
    requestId: string
    filePath: string
    cached: MixtapeRawWaveformData
    startSec: number
    chunkFrames: number
    bootstrapDurationSec: number
    priorityHint: number
  }) => {
    const { sender, requestId, filePath, cached, priorityHint } = params
    const fullFrames = Math.max(0, Number(cached.frames) || 0)
    const requestedChunkFrames = Math.max(256, Math.floor(Number(params.chunkFrames) || 16384))
    const requestedBootstrapDurationSec = Math.max(0, Number(params.bootstrapDurationSec) || 0)
    const rate = Math.max(1, Number(cached.rate) || 1)
    const startFrameOffset = Math.max(
      0,
      Math.min(fullFrames, Math.floor(Math.max(0, Number(params.startSec) || 0) * rate))
    )
    const totalFrames = Math.max(0, fullFrames - startFrameOffset)
    if (!totalFrames) return
    const requestedBootstrapFrames = requestedBootstrapDurationSec
      ? Math.ceil(requestedBootstrapDurationSec * rate)
      : 0
    const bootstrapFrames = Math.min(
      totalFrames,
      Math.max(requestedChunkFrames, requestedBootstrapFrames)
    )
    const remainingFrames = Math.max(0, totalFrames - bootstrapFrames)
    const followupFramesPerChunk = Math.max(4096, requestedChunkFrames)
    const startedAt = Date.now()
    let chunkCount = 0

    const sliceBuffer = (buffer: Buffer, startFrame: number, frames: number) =>
      buffer.subarray(startFrame * 4, (startFrame + frames) * 4)

    if (sender.isDestroyed()) return
    try {
      sender.send('mixtape-waveform-raw:stream-chunk', {
        requestId,
        filePath,
        startFrame: 0,
        frames: bootstrapFrames,
        totalFrames,
        duration: Number(cached.duration) || 0,
        startSec: Math.max(0, Number(params.startSec) || 0),
        sampleRate: Number(cached.sampleRate) || 0,
        rate: Number(cached.rate) || 0,
        minLeft: sliceBuffer(cached.minLeft, startFrameOffset, bootstrapFrames),
        maxLeft: sliceBuffer(cached.maxLeft, startFrameOffset, bootstrapFrames),
        minRight: sliceBuffer(cached.minRight, startFrameOffset, bootstrapFrames),
        maxRight: sliceBuffer(cached.maxRight, startFrameOffset, bootstrapFrames)
      })
    } catch {
      return
    }
    chunkCount += 1

    if (bootstrapFrames < totalFrames) {
      cachedRawWaveformContinuations.set(requestId, {
        sender,
        requestId,
        filePath,
        startFrameOffset,
        songDurationSec: Number(cached.duration) || 0,
        cached,
        nextStartFrame: bootstrapFrames,
        followupFramesPerChunk,
        totalFrames,
        priorityHint,
        startedAt,
        chunkCount,
        sending: false
      })
      return
    }

    if (sender.isDestroyed()) return
    try {
      sender.send('mixtape-waveform-raw:stream-done', {
        requestId,
        filePath,
        fromCache: true,
        streamed: true,
        duration: Number(cached.duration) || 0,
        startSec: Math.max(0, Number(params.startSec) || 0),
        totalFrames
      })
    } catch {}
  }

  const continueCachedRawWaveformStream = async (requestId: string) => {
    const continuation = cachedRawWaveformContinuations.get(requestId)
    if (!continuation || continuation.sending) return
    continuation.sending = true

    const sliceBuffer = (buffer: Buffer, startFrame: number, frames: number) =>
      buffer.subarray(startFrame * 4, (startFrame + frames) * 4)

    try {
      if (continuation.sender.isDestroyed()) {
        cachedRawWaveformContinuations.delete(requestId)
        return
      }
      const startFrame = continuation.nextStartFrame
      const frames = Math.min(
        continuation.followupFramesPerChunk,
        continuation.totalFrames - startFrame
      )
      if (frames <= 0) {
        cachedRawWaveformContinuations.delete(requestId)
        return
      }
      try {
        continuation.sender.send('mixtape-waveform-raw:stream-chunk', {
          requestId: continuation.requestId,
          filePath: continuation.filePath,
          startFrame,
          frames,
          totalFrames: continuation.totalFrames,
          duration: continuation.songDurationSec,
          startSec:
            continuation.startFrameOffset / Math.max(1, Number(continuation.cached.rate) || 1),
          sampleRate: Number(continuation.cached.sampleRate) || 0,
          rate: Number(continuation.cached.rate) || 0,
          minLeft: sliceBuffer(
            continuation.cached.minLeft,
            continuation.startFrameOffset + startFrame,
            frames
          ),
          maxLeft: sliceBuffer(
            continuation.cached.maxLeft,
            continuation.startFrameOffset + startFrame,
            frames
          ),
          minRight: sliceBuffer(
            continuation.cached.minRight,
            continuation.startFrameOffset + startFrame,
            frames
          ),
          maxRight: sliceBuffer(
            continuation.cached.maxRight,
            continuation.startFrameOffset + startFrame,
            frames
          )
        })
      } catch {
        cachedRawWaveformContinuations.delete(requestId)
        return
      }
      continuation.chunkCount += 1
      continuation.nextStartFrame += frames

      if (continuation.nextStartFrame < continuation.totalFrames) {
        continuation.sending = false
        return
      }

      if (!continuation.sender.isDestroyed()) {
        try {
          continuation.sender.send('mixtape-waveform-raw:stream-done', {
            requestId: continuation.requestId,
            filePath: continuation.filePath,
            fromCache: true,
            streamed: true,
            duration: continuation.songDurationSec,
            startSec:
              continuation.startFrameOffset / Math.max(1, Number(continuation.cached.rate) || 1),
            totalFrames: continuation.totalFrames
          })
        } catch {}
      }
    } finally {
      if (continuation.nextStartFrame >= continuation.totalFrames) {
        cachedRawWaveformContinuations.delete(requestId)
      } else {
        continuation.sending = false
      }
    }
  }

  const sendLiveRawWaveformChunk = (
    continuation: LiveRawWaveformContinuation,
    chunk: LiveRawWaveformBufferedChunk
  ) => {
    if (continuation.sender.isDestroyed()) return false
    try {
      continuation.sender.send('mixtape-waveform-raw:stream-chunk', {
        requestId: continuation.requestId,
        filePath: continuation.filePath,
        startFrame: chunk.startFrame,
        frames: chunk.frames,
        totalFrames: chunk.totalFrames,
        duration: chunk.duration,
        startSec: continuation.startSec,
        sampleRate: chunk.sampleRate,
        rate: chunk.rate,
        minLeft: chunk.minLeft,
        maxLeft: chunk.maxLeft,
        minRight: chunk.minRight,
        maxRight: chunk.maxRight
      })
      continuation.chunkCount += 1
      return true
    } catch {
      return false
    }
  }

  const flushLiveRawWaveformContinuation = (requestId: string) => {
    const continuation = liveRawWaveformContinuations.get(requestId)
    if (!continuation) return
    while (continuation.continueCredits > 0 && continuation.queue.length > 0) {
      const nextChunk = continuation.queue.shift()
      if (!nextChunk) break
      if (!sendLiveRawWaveformChunk(continuation, nextChunk)) {
        liveRawWaveformContinuations.delete(requestId)
        return
      }
      continuation.continueCredits -= 1
    }
    if (continuation.queue.length > 0 || !continuation.donePayload) return
    if (continuation.sender.isDestroyed()) {
      liveRawWaveformContinuations.delete(requestId)
      return
    }
    try {
      continuation.sender.send('mixtape-waveform-raw:stream-done', {
        requestId: continuation.requestId,
        filePath: continuation.filePath,
        ...continuation.donePayload
      })
    } catch {}
    liveRawWaveformContinuations.delete(requestId)
  }

  const continueLiveRawWaveformStream = async (requestId: string) => {
    const continuation = liveRawWaveformContinuations.get(requestId)
    if (!continuation) return
    continuation.continueCredits += 1
    flushLiveRawWaveformContinuation(requestId)
  }

  const drainRawWaveformStreamQueue = () => {
    while (listActiveRawWaveformStreamRequests().length < MAX_ACTIVE_RAW_WAVEFORM_STREAMS) {
      const nextRequest = getHighestPriorityPendingRawWaveformStreamRequest()
      if (!nextRequest) break
      if (nextRequest.sender.isDestroyed()) {
        clearRawWaveformStreamRequest(nextRequest.requestId)
        continue
      }

      const workerPath = resolveMixtapeRawWaveformWorkerPath()
      const worker = new Worker(workerPath)
      nextRequest.worker = worker
      nextRequest.streamStartedAt = Date.now()
      nextRequest.firstChunkAt = undefined
      nextRequest.chunkCount = 0
      const jobId = ++nextRawWaveformStreamJobId

      const finishRawWaveformStreamRequest = (payloadDone: Record<string, unknown>) => {
        const activeRequest = rawWaveformStreamRequests.get(nextRequest.requestId)
        if (!activeRequest || activeRequest.worker !== worker) return
        const liveContinuation = liveRawWaveformContinuations.get(nextRequest.requestId)
        rawWaveformStreamRequests.delete(nextRequest.requestId)
        teardownRawWaveformStreamWorker(worker)
        if (liveContinuation) {
          liveContinuation.donePayload = payloadDone
          flushLiveRawWaveformContinuation(nextRequest.requestId)
        } else if (!nextRequest.sender.isDestroyed()) {
          try {
            nextRequest.sender.send('mixtape-waveform-raw:stream-done', {
              requestId: nextRequest.requestId,
              filePath: nextRequest.filePath,
              ...payloadDone
            })
          } catch {}
        }
        drainRawWaveformStreamQueue()
      }

      worker.on('message', async (message: MixtapeRawWaveformStreamWorkerPayload) => {
        const activeRequest = rawWaveformStreamRequests.get(nextRequest.requestId)
        if (!activeRequest || activeRequest.worker !== worker) return
        const progress = message?.progress
        if (progress?.type === 'chunk') {
          const bufferedChunk: LiveRawWaveformBufferedChunk = {
            startFrame: Number(progress.startFrame) || 0,
            frames: Number(progress.frames) || 0,
            totalFrames: Number(progress.totalFrames) || 0,
            duration: Number(progress.duration) || 0,
            sampleRate: Number(progress.sampleRate) || 0,
            rate: Number(progress.rate) || 0,
            minLeft: progress.minLeft || Buffer.alloc(0),
            maxLeft: progress.maxLeft || Buffer.alloc(0),
            minRight: progress.minRight || Buffer.alloc(0),
            maxRight: progress.maxRight || Buffer.alloc(0)
          }
          if (nextRequest.firstChunkAt === undefined) {
            nextRequest.firstChunkAt = Date.now()
            if (!nextRequest.sender.isDestroyed()) {
              try {
                nextRequest.sender.send('mixtape-waveform-raw:stream-chunk', {
                  requestId: nextRequest.requestId,
                  filePath: nextRequest.filePath,
                  startFrame: bufferedChunk.startFrame,
                  frames: bufferedChunk.frames,
                  totalFrames: bufferedChunk.totalFrames,
                  duration: bufferedChunk.duration,
                  startSec: nextRequest.startSec,
                  sampleRate: bufferedChunk.sampleRate,
                  rate: bufferedChunk.rate,
                  minLeft: bufferedChunk.minLeft,
                  maxLeft: bufferedChunk.maxLeft,
                  minRight: bufferedChunk.minRight,
                  maxRight: bufferedChunk.maxRight
                })
              } catch {}
            }
            nextRequest.chunkCount += 1
            return
          }

          const continuation =
            liveRawWaveformContinuations.get(nextRequest.requestId) ||
            ({
              sender: nextRequest.sender,
              requestId: nextRequest.requestId,
              filePath: nextRequest.filePath,
              startSec: nextRequest.startSec,
              priorityHint: nextRequest.priorityHint,
              startedAt: nextRequest.streamStartedAt || Date.now(),
              chunkCount: nextRequest.chunkCount,
              queue: [],
              continueCredits: 0,
              donePayload: null
            } satisfies LiveRawWaveformContinuation)
          continuation.priorityHint = nextRequest.priorityHint
          continuation.queue.push(bufferedChunk)
          liveRawWaveformContinuations.set(nextRequest.requestId, continuation)
          flushLiveRawWaveformContinuation(nextRequest.requestId)
          return
        }

        if (message?.result?.rawWaveformData) {
          if (nextRequest.listRoot && nextRequest.stat) {
            await LibraryCacheDb.upsertMixtapeRawWaveformCacheEntry(
              nextRequest.listRoot,
              nextRequest.filePath,
              { size: nextRequest.stat.size, mtimeMs: nextRequest.stat.mtimeMs },
              message.result.rawWaveformData
            ).catch(() => {})
          }
          finishRawWaveformStreamRequest({
            streamed: true,
            fromCache: false,
            duration: Number(message.result.rawWaveformData.duration) || 0,
            startSec: nextRequest.startSec,
            totalFrames: Number(message.result.rawWaveformData.frames) || 0,
            sampleRate: Number(message.result.rawWaveformData.sampleRate) || 0,
            rate: Number(message.result.rawWaveformData.rate) || 0
          })
          return
        }

        if (message?.error) {
          finishRawWaveformStreamRequest({ error: String(message.error) })
        }
      })

      worker.once('error', (error) => {
        const activeRequest = rawWaveformStreamRequests.get(nextRequest.requestId)
        if (!activeRequest || activeRequest.worker !== worker) return
        finishRawWaveformStreamRequest({
          error: error instanceof Error ? error.message : String(error || 'unknown error')
        })
      })

      worker.once('exit', (code) => {
        const activeRequest = rawWaveformStreamRequests.get(nextRequest.requestId)
        if (!activeRequest || activeRequest.worker !== worker) return
        if (code === 0) return
        finishRawWaveformStreamRequest({ error: `stream worker exited with code ${code}` })
      })

      worker.postMessage({
        jobId,
        filePath: nextRequest.filePath,
        targetRate: nextRequest.targetRate,
        startSec: nextRequest.startSec,
        songDurationSec: nextRequest.songDurationSec,
        streamChunks: true,
        chunkFrames: nextRequest.chunkFrames,
        expectedDurationSec: nextRequest.expectedDurationSec
      })
    }
  }

  const rebalanceRawWaveformStreamQueue = () => {
    const highestPending = getHighestPriorityPendingRawWaveformStreamRequest()
    const lowestActive = getLowestPriorityActiveRawWaveformStreamRequest()
    if (
      highestPending &&
      lowestActive &&
      isHigherPriorityRawWaveformStreamRequest(highestPending, lowestActive)
    ) {
      clearRawWaveformStreamRequest(lowestActive.requestId, { keepQueued: true })
    }
    drainRawWaveformStreamQueue()
  }

  ipcMain.handle('track:cache:clear', async (_e, filePath: string) => {
    await svcClearTrackCache(filePath)
  })

  ipcMain.handle('getLibrary', async () => {
    return await getLibrary()
  })

  ipcMain.handle(
    'waveform-cache:batch',
    async (
      _e,
      payload: {
        listRoot?: string
        filePaths?: string[]
      }
    ) => {
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) {
        return { items: [] as Array<{ filePath: string; data: MixxxWaveformData | null }> }
      }

      const items: Array<{ filePath: string; data: MixxxWaveformData | null }> = []
      const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
      let resolvedListRoot = ''
      if (listRootRaw) {
        let input = listRootRaw
        if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
        if (path.isAbsolute(input)) {
          resolvedListRoot = input
        } else if (store.databaseDir) {
          const mapped = mapRendererPathToFsPath(input)
          resolvedListRoot = path.join(store.databaseDir, mapped)
        }
      }
      for (const filePath of normalizedPaths) {
        let listRoot = resolvedListRoot
        if (!listRoot) {
          listRoot = (await findSongListRoot(path.dirname(filePath))) || ''
        }
        if (!listRoot) {
          items.push({ filePath, data: null })
          continue
        }
        try {
          const fsStat = await fs.stat(filePath)
          const data = await LibraryCacheDb.loadWaveformCacheData(listRoot, filePath, {
            size: fsStat.size,
            mtimeMs: fsStat.mtimeMs
          })
          items.push({ filePath, data: data ?? null })
        } catch {
          await LibraryCacheDb.removeSongCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
          items.push({ filePath, data: null })
        }
      }

      return { items }
    }
  )

  ipcMain.handle(
    'mixtape-waveform-cache:batch',
    async (
      _e,
      payload: {
        listRoot?: string
        filePaths?: string[]
      }
    ) => {
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) {
        return { items: [] as Array<{ filePath: string; data: MixxxWaveformData | null }> }
      }

      const items: Array<{ filePath: string; data: MixxxWaveformData | null }> = []
      const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
      let resolvedListRoot = ''
      if (listRootRaw) {
        let input = listRootRaw
        if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
        if (path.isAbsolute(input)) {
          resolvedListRoot = input
        } else if (store.databaseDir) {
          const mapped = mapRendererPathToFsPath(input)
          resolvedListRoot = path.join(store.databaseDir, mapped)
        }
      }
      for (const filePath of normalizedPaths) {
        let listRoot = resolvedListRoot
        if (!listRoot) {
          listRoot = (await findSongListRoot(path.dirname(filePath))) || ''
        }
        if (!listRoot) {
          items.push({ filePath, data: null })
          continue
        }
        try {
          const fsStat = await fs.stat(filePath)
          const data = await LibraryCacheDb.loadMixtapeWaveformCacheData(listRoot, filePath, {
            size: fsStat.size,
            mtimeMs: fsStat.mtimeMs
          })
          items.push({ filePath, data: data ?? null })
        } catch {
          await LibraryCacheDb.removeMixtapeWaveformCacheEntry(listRoot, filePath)
          items.push({ filePath, data: null })
        }
      }

      return { items }
    }
  )

  ipcMain.handle(
    'mixtape-stem-waveform-cache:batch',
    async (
      _e,
      payload: {
        items?: Array<{
          listRoot?: string
          sourceFilePath?: string
          stemMode?: typeof FIXED_MIXTAPE_STEM_MODE
          stemModel?: string
          stemVersion?: string
          stemPaths?: {
            vocalPath?: string
            instPath?: string
            bassPath?: string
            drumsPath?: string
          }
        }>
      }
    ) => {
      const requests = Array.isArray(payload?.items) ? payload.items : []
      if (!requests.length) {
        return {
          items: [] as Array<{
            sourceFilePath: string
            stems: Array<{ stemId: string; filePath: string; data: StemWaveformDataLite | null }>
          }>
        }
      }

      const items: Array<{
        sourceFilePath: string
        stems: Array<{ stemId: string; filePath: string; data: StemWaveformDataLite | null }>
      }> = []
      for (const request of requests) {
        const sourceFilePath =
          typeof request?.sourceFilePath === 'string' ? request.sourceFilePath.trim() : ''
        if (!sourceFilePath) {
          items.push({ sourceFilePath: '', stems: [] })
          continue
        }
        const stemMode = FIXED_MIXTAPE_STEM_MODE
        try {
          const result = await ensureMixtapeStemWaveformBundle({
            listRoot: typeof request?.listRoot === 'string' ? request.listRoot.trim() : '',
            sourceFilePath,
            stemMode,
            stemModel: request?.stemModel,
            stemVersion: request?.stemVersion,
            stemPaths: {
              vocalPath: request?.stemPaths?.vocalPath,
              instPath: request?.stemPaths?.instPath,
              bassPath: request?.stemPaths?.bassPath,
              drumsPath: request?.stemPaths?.drumsPath
            }
          })
          if (!result) {
            items.push({ sourceFilePath, stems: [] })
            continue
          }
          items.push({
            sourceFilePath: result.sourceFilePath,
            stems: result.stems.map((stem) => ({
              stemId: stem.stemId,
              filePath: stem.filePath,
              data: stem.data ?? null
            }))
          })
        } catch {
          items.push({ sourceFilePath, stems: [] })
        }
      }

      return { items }
    }
  )

  ipcMain.handle(
    'mixtape-waveform-raw:batch',
    async (
      _e,
      payload: {
        filePaths?: string[]
        listRootByFilePath?: Record<string, string>
        targetRate?: number
        preferSharedDecode?: boolean
        cacheOnly?: boolean
      }
    ) => {
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) {
        return { items: [] as Array<{ filePath: string; data: MixtapeRawWaveformData | null }> }
      }

      const targetRate = resolveRequestedRawRate(payload?.targetRate)
      const preferSharedDecode = Boolean(payload?.preferSharedDecode)
      const cacheOnly = Boolean(payload?.cacheOnly)
      const inputListRootByFilePath =
        payload?.listRootByFilePath && typeof payload.listRootByFilePath === 'object'
          ? payload.listRootByFilePath
          : {}
      const listRootByExactFilePath = new Map<string, string>()
      const listRootByNormalizedFilePath = new Map<string, string>()
      for (const [rawFilePath, rawListRoot] of Object.entries(inputListRootByFilePath)) {
        const filePath = typeof rawFilePath === 'string' ? rawFilePath.trim() : ''
        if (!filePath) continue
        const listRoot = resolveRendererListRoot(rawListRoot)
        if (!listRoot) continue
        listRootByExactFilePath.set(filePath, listRoot)
        listRootByNormalizedFilePath.set(path.normalize(filePath), listRoot)
      }
      const items: Array<{ filePath: string; data: MixtapeRawWaveformData | null }> = []
      for (const filePath of normalizedPaths) {
        try {
          let listRoot =
            listRootByExactFilePath.get(filePath) ||
            listRootByNormalizedFilePath.get(path.normalize(filePath)) ||
            ''
          if (!listRoot) {
            listRoot = (await findSongListRoot(path.dirname(filePath))) || ''
          }
          let stat = await fs.stat(filePath).catch(() => null)
          let cached: MixtapeRawWaveformData | null | undefined = null
          if (listRoot && stat) {
            cached = await LibraryCacheDb.loadMixtapeRawWaveformCacheData(listRoot, filePath, {
              size: stat.size,
              mtimeMs: stat.mtimeMs
            })
          }
          if (isRawWaveformRateSufficient(cached, targetRate)) {
            items.push({ filePath, data: cached ?? null })
            continue
          }
          if (cacheOnly) {
            items.push({ filePath, data: null })
            continue
          }

          let data: MixtapeRawWaveformData | null = null
          let computedWaveform: MixxxWaveformData | null = null
          if (preferSharedDecode) {
            let needWaveformForShare = true
            if (listRoot && stat) {
              const waveformCached = await LibraryCacheDb.loadMixtapeWaveformCacheData(
                listRoot,
                filePath,
                {
                  size: stat.size,
                  mtimeMs: stat.mtimeMs
                }
              )
              needWaveformForShare = !Boolean(waveformCached)
            }
            const decoded = await decodeAudioShared(filePath, {
              analyzeKey: false,
              needWaveform: needWaveformForShare,
              needRawWaveform: true,
              rawTargetRate: targetRate,
              fileStat: stat ? { size: stat.size, mtimeMs: stat.mtimeMs } : null,
              traceLabel: 'mixtape-raw-waveform-shared',
              priority: 'low'
            })
            data = decoded.rawWaveformData ?? null
            computedWaveform = needWaveformForShare ? (decoded.mixxxWaveformData ?? null) : null
          } else {
            data = await requestMixtapeRawWaveform(filePath, targetRate)
          }

          if (data && listRoot && stat) {
            await LibraryCacheDb.upsertMixtapeRawWaveformCacheEntry(
              listRoot,
              filePath,
              { size: stat.size, mtimeMs: stat.mtimeMs },
              data
            )
          }
          if (computedWaveform && listRoot && stat) {
            await LibraryCacheDb.upsertMixtapeWaveformCacheEntry(
              listRoot,
              filePath,
              { size: stat.size, mtimeMs: stat.mtimeMs },
              computedWaveform
            )
          }
          items.push({ filePath, data: data ?? null })
        } catch {
          items.push({ filePath, data: null })
        }
      }

      return { items }
    }
  )

  ipcMain.on(
    'mixtape-waveform-raw:stream',
    async (
      event,
      payload: {
        requestId?: string
        filePath?: string
        listRoot?: string
        targetRate?: number
        startSec?: number
        songDurationSec?: number
        chunkFrames?: number
        expectedDurationSec?: number
        bootstrapDurationSec?: number
        priorityHint?: number
      }
    ) => {
      const requestId = String(payload?.requestId || '').trim()
      const filePath = String(payload?.filePath || '').trim()
      if (!requestId || !filePath) return

      clearRawWaveformStreamRequest(requestId)

      const targetRate = resolveRequestedRawRate(payload?.targetRate)
      const startSec = Math.max(0, Number(payload?.startSec) || 0)
      const songDurationSec = Math.max(0, Number(payload?.songDurationSec) || 0)
      const chunkFrames = Math.max(2048, Math.floor(Number(payload?.chunkFrames) || 16384))
      const expectedDurationSec = Math.max(0, Number(payload?.expectedDurationSec) || 0)
      const bootstrapDurationSec = Math.max(0, Number(payload?.bootstrapDurationSec) || 0)
      const priorityHint = resolveRawWaveformStreamPriorityHint(payload?.priorityHint)
      let listRoot = resolveRendererListRoot(payload?.listRoot)
      if (!listRoot) {
        listRoot = (await findSongListRoot(path.dirname(filePath))) || ''
      }
      const stat = await fs.stat(filePath).catch(() => null)
      if (listRoot && stat) {
        const cached = await LibraryCacheDb.loadMixtapeRawWaveformCacheData(listRoot, filePath, {
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
        if (isRawWaveformRateSufficient(cached, targetRate)) {
          void sendCachedRawWaveformStream({
            sender: event.sender,
            requestId,
            filePath,
            cached: cached as MixtapeRawWaveformData,
            startSec,
            chunkFrames,
            bootstrapDurationSec,
            priorityHint
          })
          return
        }
      }

      rawWaveformStreamRequests.set(requestId, {
        requestId,
        filePath,
        sender: event.sender,
        listRoot,
        stat: stat ? { size: stat.size, mtimeMs: stat.mtimeMs } : null,
        targetRate,
        startSec,
        songDurationSec,
        chunkFrames,
        expectedDurationSec,
        bootstrapDurationSec,
        priorityHint,
        enqueuedAt: Date.now(),
        chunkCount: 0
      })
      rebalanceRawWaveformStreamQueue()
    }
  )

  ipcMain.on(
    'mixtape-waveform-raw:update-priority',
    (_event, payload: { requestId?: string; priorityHint?: number }) => {
      const requestId = String(payload?.requestId || '').trim()
      if (!requestId) return
      const request = rawWaveformStreamRequests.get(requestId)
      if (!request) return
      request.priorityHint = resolveRawWaveformStreamPriorityHint(payload?.priorityHint)
      if (!request.worker) {
        request.enqueuedAt = Date.now()
      }
      rebalanceRawWaveformStreamQueue()
    }
  )

  ipcMain.on('mixtape-waveform-raw:continue-stream', (_event, payload: { requestId?: string }) => {
    const requestId = String(payload?.requestId || '').trim()
    if (!requestId) return
    void continueCachedRawWaveformStream(requestId)
    void continueLiveRawWaveformStream(requestId)
  })

  ipcMain.on('mixtape-waveform-raw:cancel-stream', (_event, payload: { requestId?: string }) => {
    const requestId = String(payload?.requestId || '').trim()
    if (!requestId) return
    clearRawWaveformStreamRequest(requestId)
    drainRawWaveformStreamQueue()
  })

  ipcMain.handle(
    'mixtape-waveform-hires:batch',
    async (
      _e,
      payload: {
        filePaths?: string[]
        targetRate?: number
      }
    ) => {
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) {
        return { items: [] as Array<{ filePath: string; data: MixxxWaveformData | null }> }
      }

      const targetRate = resolveRequestedWaveformRate(payload?.targetRate)
      const items: Array<{ filePath: string; data: MixxxWaveformData | null }> = []
      for (const filePath of normalizedPaths) {
        try {
          const result = await ensureMixtapeWaveformHires(filePath, {
            targetRate
          })
          const data = result?.data ?? null
          items.push({ filePath, data: data ?? null })
        } catch {
          items.push({ filePath, data: null })
        }
      }

      return { items }
    }
  )

  ipcMain.on(
    'mixtape-waveform:queue-visible',
    (_e, payload: { listRoot?: string; filePaths?: string[] }) => {
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) return
      const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
      let resolvedListRoot = ''
      if (listRootRaw) {
        let input = listRootRaw
        if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
        if (path.isAbsolute(input)) {
          resolvedListRoot = input
        } else if (store.databaseDir) {
          const mapped = mapRendererPathToFsPath(input)
          resolvedListRoot = path.join(store.databaseDir, mapped)
        }
      }
      queueMixtapeWaveforms(normalizedPaths, resolvedListRoot || undefined)
    }
  )
}
