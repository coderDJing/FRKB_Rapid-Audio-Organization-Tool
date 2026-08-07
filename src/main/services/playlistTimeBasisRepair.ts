import path from 'node:path'
import type { ISongInfo } from '../../types/globals'
import { resolveCanonicalSongBeatGridV2 } from '../../shared/songAnalysisCompleteness'
import * as LibraryCacheDb from '../libraryCacheDb'
import { runWithConcurrency } from '../nodeTaskUtils'
import { CURRENT_AUDIO_TIME_BASIS_OFFSET_ALGORITHM_VERSION } from './audioTimeBasisOffset'
import {
  hasCachedAudioTimeBasisOffsetMsOffMainThread,
  resolveAudioTimeBasisOffsetMsOffMainThread
} from './audioTimeBasisOffsetWorker'
import { findSongListRoot } from './cacheMaintenance'
import { emitSongGridUpdated } from './songGridEvents'

export const PLAYLIST_TIME_BASIS_REPAIR_CONCURRENCY = 4

export type PlaylistTimeBasisRepairPlan = {
  candidateCount: number
  cacheHitCount: number
  cacheMissCount: number
  extensionCounts: Record<string, number>
  backgroundScheduled: boolean
  concurrency: number
  executionContext: 'worker-thread'
}

export type PlaylistTimeBasisRepairDiagnostics = PlaylistTimeBasisRepairPlan & {
  queueWaitDurationMs: number
  repairDurationMs: number
  totalDurationMs: number
  resolveDurationTotalMs: number
  resolveDurationMaxMs: number
  resolvedNonZeroCount: number
  cachePersistenceDurationTotalMs: number
  cachePersistenceDurationMaxMs: number
  cachePatchAttemptedCount: number
  cachePatchSucceededCount: number
  cacheRootMissingCount: number
  failedCount: number
  maxActiveCount: number
}

export type PreparedPlaylistTimeBasisRepair = {
  candidates: ISongInfo[]
  plan: PlaylistTimeBasisRepairPlan
}

export type PlaylistTimeBasisRepairDependencies = {
  resolveOffset: (filePath: string) => Promise<number>
  findRoot: (startDir: string) => Promise<string | null>
  patchCacheOffset: (
    listRoot: string,
    filePath: string,
    offsetMs: number,
    algorithmVersion: number
  ) => Promise<boolean>
  emitUpdated: (payload: { filePath: string; timeBasisOffsetMs: number }) => void
  now: () => number
}

type QueuePlaylistTimeBasisRepairOptions = {
  onStarted?: (details: { queueWaitDurationMs: number; concurrency: number }) => void
  dependencies?: PlaylistTimeBasisRepairDependencies
}

const defaultDependencies: PlaylistTimeBasisRepairDependencies = {
  resolveOffset: resolveAudioTimeBasisOffsetMsOffMainThread,
  findRoot: findSongListRoot,
  patchCacheOffset: LibraryCacheDb.updateSongCacheTimeBasisOffset,
  emitUpdated: emitSongGridUpdated,
  now: Date.now
}

let backgroundQueueTail: Promise<void> = Promise.resolve()

const waitForEventLoopTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

const normalizeTimeBasisOffsetMs = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Number(numeric.toFixed(3)) : 0
}

export const shouldRepairPlaylistSongTimeBasis = (song: ISongInfo) => {
  const grid = resolveCanonicalSongBeatGridV2(song)
  if (grid.kind !== 'grid') return false
  const currentOffset = Number(song.timeBasisOffsetMs)
  const missingOffset = !Number.isFinite(currentOffset) || currentOffset < 0
  const offsetAlgorithmVersion = Number(song.timeBasisOffsetAlgorithmVersion)
  const hasCurrentOffsetAlgorithm =
    Number.isFinite(offsetAlgorithmVersion) &&
    offsetAlgorithmVersion >= CURRENT_AUDIO_TIME_BASIS_OFFSET_ALGORITHM_VERSION
  const legacyMp3Zero =
    currentOffset === 0 &&
    !hasCurrentOffsetAlgorithm &&
    song.beatGridAlgorithmVersion === undefined &&
    path.extname(song.filePath).toLowerCase() === '.mp3'
  return missingOffset || legacyMp3Zero
}

export const preparePlaylistTimeBasisRepair = (
  songs: ISongInfo[],
  hasCachedOffset: (filePath: string) => boolean = hasCachedAudioTimeBasisOffsetMsOffMainThread
): PreparedPlaylistTimeBasisRepair => {
  const candidates = songs.filter(shouldRepairPlaylistSongTimeBasis)
  const extensionCounts: Record<string, number> = {}
  let cacheHitCount = 0
  for (const song of candidates) {
    const extension = path.extname(song.filePath).toLowerCase() || '(none)'
    extensionCounts[extension] = (extensionCounts[extension] || 0) + 1
    if (hasCachedOffset(song.filePath)) cacheHitCount += 1
  }
  return {
    candidates,
    plan: {
      candidateCount: candidates.length,
      cacheHitCount,
      cacheMissCount: candidates.length - cacheHitCount,
      extensionCounts,
      backgroundScheduled: candidates.length > 0,
      concurrency: PLAYLIST_TIME_BASIS_REPAIR_CONCURRENCY,
      executionContext: 'worker-thread'
    }
  }
}

export const runPreparedPlaylistTimeBasisRepair = async (
  prepared: PreparedPlaylistTimeBasisRepair,
  queuedAtMs: number,
  dependencies: PlaylistTimeBasisRepairDependencies = defaultDependencies
): Promise<PlaylistTimeBasisRepairDiagnostics> => {
  const startedAtMs = dependencies.now()
  let activeCount = 0
  let maxActiveCount = 0
  let resolveDurationTotalMs = 0
  let resolveDurationMaxMs = 0
  let resolvedNonZeroCount = 0
  let cachePersistenceDurationTotalMs = 0
  let cachePersistenceDurationMaxMs = 0
  let cachePatchAttemptedCount = 0
  let cachePatchSucceededCount = 0
  let cacheRootMissingCount = 0
  const rootByDirectory = new Map<string, Promise<string | null>>()

  const tasks = prepared.candidates.map((song) => async () => {
    activeCount += 1
    maxActiveCount = Math.max(maxActiveCount, activeCount)
    try {
      const resolveStartedAtMs = dependencies.now()
      const timeBasisOffsetMs = normalizeTimeBasisOffsetMs(
        await dependencies.resolveOffset(song.filePath)
      )
      const resolveDurationMs = dependencies.now() - resolveStartedAtMs
      resolveDurationTotalMs += resolveDurationMs
      resolveDurationMaxMs = Math.max(resolveDurationMaxMs, resolveDurationMs)
      if (timeBasisOffsetMs > 0) resolvedNonZeroCount += 1

      const persistenceStartedAtMs = dependencies.now()
      const songDirectory = path.dirname(song.filePath)
      let rootPromise = rootByDirectory.get(songDirectory)
      if (!rootPromise) {
        rootPromise = dependencies.findRoot(songDirectory)
        rootByDirectory.set(songDirectory, rootPromise)
      }
      const listRoot = await rootPromise
      if (!listRoot) {
        cacheRootMissingCount += 1
      } else {
        cachePatchAttemptedCount += 1
        const patched = await dependencies.patchCacheOffset(
          listRoot,
          song.filePath,
          timeBasisOffsetMs,
          CURRENT_AUDIO_TIME_BASIS_OFFSET_ALGORITHM_VERSION
        )
        if (patched) cachePatchSucceededCount += 1
      }
      const persistenceDurationMs = dependencies.now() - persistenceStartedAtMs
      cachePersistenceDurationTotalMs += persistenceDurationMs
      cachePersistenceDurationMaxMs = Math.max(cachePersistenceDurationMaxMs, persistenceDurationMs)

      if (Number(song.timeBasisOffsetMs) !== timeBasisOffsetMs) {
        dependencies.emitUpdated({ filePath: song.filePath, timeBasisOffsetMs })
      }
      return timeBasisOffsetMs
    } finally {
      activeCount -= 1
    }
  })

  const result = await runWithConcurrency(tasks, {
    concurrency: PLAYLIST_TIME_BASIS_REPAIR_CONCURRENCY,
    yieldEvery: 1
  })
  const completedAtMs = dependencies.now()
  return {
    ...prepared.plan,
    queueWaitDurationMs: Math.max(0, startedAtMs - queuedAtMs),
    repairDurationMs: Math.max(0, completedAtMs - startedAtMs),
    totalDurationMs: Math.max(0, completedAtMs - queuedAtMs),
    resolveDurationTotalMs,
    resolveDurationMaxMs,
    resolvedNonZeroCount,
    cachePersistenceDurationTotalMs,
    cachePersistenceDurationMaxMs,
    cachePatchAttemptedCount,
    cachePatchSucceededCount,
    cacheRootMissingCount,
    failedCount: result.failed,
    maxActiveCount
  }
}

export const queuePlaylistTimeBasisRepair = (
  prepared: PreparedPlaylistTimeBasisRepair,
  options: QueuePlaylistTimeBasisRepairOptions = {}
) => {
  if (prepared.candidates.length === 0) {
    return { plan: prepared.plan, completion: null }
  }

  const dependencies = options.dependencies || defaultDependencies
  const queuedAtMs = dependencies.now()
  const completion = backgroundQueueTail.then(async () => {
    await waitForEventLoopTurn()
    options.onStarted?.({
      queueWaitDurationMs: Math.max(0, dependencies.now() - queuedAtMs),
      concurrency: PLAYLIST_TIME_BASIS_REPAIR_CONCURRENCY
    })
    return await runPreparedPlaylistTimeBasisRepair(prepared, queuedAtMs, dependencies)
  })
  backgroundQueueTail = completion.then(
    () => undefined,
    () => undefined
  )
  return { plan: prepared.plan, completion }
}
