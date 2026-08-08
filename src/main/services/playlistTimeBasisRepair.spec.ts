import { describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from '../../types/globals'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'

vi.mock('../libraryCacheDb', () => ({
  updateSongCacheTimeBasisOffset: vi.fn()
}))
vi.mock('./audioTimeBasisOffset', () => ({
  CURRENT_AUDIO_TIME_BASIS_OFFSET_ALGORITHM_VERSION: 1,
  hasCachedAudioTimeBasisOffsetMsForFile: vi.fn(() => false),
  resolveAudioTimeBasisOffsetMsForFile: vi.fn(async () => 0)
}))
vi.mock('./audioTimeBasisOffsetWorker', () => ({
  hasCachedAudioTimeBasisOffsetMsOffMainThread: vi.fn(() => false),
  resolveAudioTimeBasisOffsetMsOffMainThread: vi.fn(async () => 0)
}))
vi.mock('./cacheMaintenance', () => ({
  findSongListRoot: vi.fn(async () => null)
}))
vi.mock('./songGridEvents', () => ({
  emitSongGridBatchUpdated: vi.fn()
}))

import {
  PLAYLIST_TIME_BASIS_REPAIR_CONCURRENCY,
  preparePlaylistTimeBasisRepair,
  queuePlaylistTimeBasisRepair,
  runPreparedPlaylistTimeBasisRepair,
  type PlaylistTimeBasisRepairDependencies
} from './playlistTimeBasisRepair'

const createGrid = () => {
  const grid = createSongBeatGridMapV2FromFixedGrid({
    bpm: 132,
    firstBeatMs: 120,
    downbeatBeatOffset: 0,
    source: 'analysis'
  })
  if (!grid) throw new Error('grid fixture creation failed')
  return grid
}

const createSong = (index: number, overrides: Partial<ISongInfo> = {}): ISongInfo => ({
  filePath: `D:/music/playlist/track-${index}.mp3`,
  fileName: `track-${index}.mp3`,
  fileFormat: 'MP3',
  cover: null,
  title: `Track ${index}`,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: 'MPEG',
  beatGridMap: createGrid(),
  ...overrides
})

const createDependencies = (
  overrides: Partial<PlaylistTimeBasisRepairDependencies> = {}
): PlaylistTimeBasisRepairDependencies => ({
  resolveOffset: async () => 25.057,
  findRoot: async () => 'D:/music/playlist',
  patchCacheOffset: async () => true,
  emitUpdatedBatch: () => {},
  now: Date.now,
  ...overrides
})

describe('preparePlaylistTimeBasisRepair', () => {
  it('只选择缺失时间基或旧版 MP3 零偏移网格', () => {
    const missingOffset = createSong(1)
    const legacyMp3Zero = createSong(2, { timeBasisOffsetMs: 0 })
    const confirmedMp3Zero = createSong(6, {
      timeBasisOffsetMs: 0,
      timeBasisOffsetAlgorithmVersion: 1
    })
    const currentMp3Zero = createSong(3, {
      timeBasisOffsetMs: 0,
      beatGridAlgorithmVersion: 12
    })
    const legacyFlacZero = createSong(4, {
      filePath: 'D:/music/playlist/track-4.flac',
      fileName: 'track-4.flac',
      fileFormat: 'FLAC',
      timeBasisOffsetMs: 0
    })
    const withoutGrid = createSong(5, { beatGridMap: undefined })

    const prepared = preparePlaylistTimeBasisRepair(
      [missingOffset, legacyMp3Zero, confirmedMp3Zero, currentMp3Zero, legacyFlacZero, withoutGrid],
      (filePath) => filePath === missingOffset.filePath
    )

    expect(prepared.candidates.map((song) => song.filePath)).toEqual([
      missingOffset.filePath,
      legacyMp3Zero.filePath
    ])
    expect(prepared.plan).toEqual({
      candidateCount: 2,
      cacheHitCount: 1,
      cacheMissCount: 1,
      extensionCounts: { '.mp3': 2 },
      backgroundScheduled: true,
      concurrency: PLAYLIST_TIME_BASIS_REPAIR_CONCURRENCY,
      executionContext: 'worker-thread'
    })
  })
})

describe('runPreparedPlaylistTimeBasisRepair', () => {
  it('全批次最多并发四个探测，并复用同目录歌单根查询', async () => {
    const songs = Array.from({ length: 12 }, (_, index) => createSong(index + 1))
    const prepared = preparePlaylistTimeBasisRepair(songs, () => false)
    let activeResolveCount = 0
    let maxResolveCount = 0
    let rootLookupCount = 0
    const patchedPaths: string[] = []
    const emittedBatches: Array<Array<{ filePath: string; timeBasisOffsetMs: number }>> = []
    const dependencies = createDependencies({
      resolveOffset: async () => {
        activeResolveCount += 1
        maxResolveCount = Math.max(maxResolveCount, activeResolveCount)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        activeResolveCount -= 1
        return 25.057
      },
      findRoot: async () => {
        rootLookupCount += 1
        return 'D:/music/playlist'
      },
      patchCacheOffset: async (_listRoot, filePath) => {
        patchedPaths.push(filePath)
        return true
      },
      emitUpdatedBatch: (payloads) => emittedBatches.push(payloads)
    })

    const diagnostics = await runPreparedPlaylistTimeBasisRepair(prepared, Date.now(), dependencies)

    expect(maxResolveCount).toBe(PLAYLIST_TIME_BASIS_REPAIR_CONCURRENCY)
    expect(diagnostics.maxActiveCount).toBe(PLAYLIST_TIME_BASIS_REPAIR_CONCURRENCY)
    expect(diagnostics.failedCount).toBe(0)
    expect(diagnostics.cachePatchAttemptedCount).toBe(12)
    expect(diagnostics.cachePatchSucceededCount).toBe(12)
    expect(rootLookupCount).toBe(1)
    expect(patchedPaths).toHaveLength(12)
    expect(emittedBatches).toHaveLength(1)
    expect(emittedBatches[0]).toHaveLength(12)
    expect(diagnostics.rendererBatchUpdateCount).toBe(12)
  })

  it('入队后立即返回，完成 Promise 等待后台探测结束', async () => {
    const prepared = preparePlaylistTimeBasisRepair([createSong(1)], () => false)
    let probeStarted = false
    let releaseProbe: (value: number) => void = () => {}
    const probePromise = new Promise<number>((resolve) => {
      releaseProbe = resolve
    })
    const dependencies = createDependencies({
      resolveOffset: () => {
        probeStarted = true
        return probePromise
      }
    })
    let notifyStarted: () => void = () => {}
    const startedPromise = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })

    const job = queuePlaylistTimeBasisRepair(prepared, {
      dependencies,
      onStarted: notifyStarted
    })
    expect(job.completion).not.toBeNull()
    expect(probeStarted).toBe(false)
    await startedPromise
    await Promise.resolve()
    expect(probeStarted).toBe(true)
    let completed = false
    void job.completion?.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)

    releaseProbe(50.114)
    await job.completion
    expect(completed).toBe(true)
  })
})
