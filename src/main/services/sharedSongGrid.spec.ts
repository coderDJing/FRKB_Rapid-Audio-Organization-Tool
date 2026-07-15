import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from '../../types/globals'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'
import { CURRENT_BEAT_GRID_ALGORITHM_VERSION } from './beatGridAlgorithmVersion'

const mocks = vi.hoisted(() => ({
  findSongListRoot: vi.fn<(directory: string) => Promise<string | null>>(),
  loadSongCacheEntry: vi.fn(),
  upsertSongCacheEntry: vi.fn(),
  stat: vi.fn()
}))

vi.mock('../libraryCacheDb', () => ({
  loadSongCacheEntry: mocks.loadSongCacheEntry,
  upsertSongCacheEntry: mocks.upsertSongCacheEntry
}))

vi.mock('node:fs/promises', () => ({
  default: { stat: mocks.stat },
  stat: mocks.stat
}))

vi.mock('../libraryCacheDb/pathResolvers', () => ({
  stripBeatThisDebugInfo: <T>(value: T) => value
}))

vi.mock('./cacheMaintenance', () => ({
  findSongListRoot: mocks.findSongListRoot
}))

import { loadSharedSongGridDefinition, persistSharedSongGridDefinition } from './sharedSongGrid'

const FILE_PATH = 'G:/FRKB_database-A/library/FilterLibrary/test-track.mp3'

const createInfo = (overrides: Partial<ISongInfo>): ISongInfo => ({
  filePath: FILE_PATH,
  fileName: 'test-track.mp3',
  fileFormat: 'mp3',
  cover: null,
  title: 'Test Track',
  artist: 'Test Artist',
  album: undefined,
  duration: '5:00',
  genre: 'Techno',
  label: undefined,
  bitrate: 320000,
  container: 'MPEG',
  ...overrides
})

describe('loadSharedSongGridDefinition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findSongListRoot.mockResolvedValue('G:/FRKB_database-A/library')
    mocks.stat.mockResolvedValue({ size: 1024, mtimeMs: 1000 })
  })

  it('loads a valid v2 grid without requiring an analysis algorithm version', async () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 0,
      source: 'manual'
    })
    if (!beatGridMap) throw new Error('v2 grid fixture failed')
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 1024,
      mtimeMs: 1000,
      info: createInfo({ beatGridMap })
    })

    const result = await loadSharedSongGridDefinition(FILE_PATH)

    expect(result).toMatchObject({
      filePath: FILE_PATH,
      beatGridSource: 'manual',
      beatGridMap: { signature: beatGridMap.signature }
    })
    expect(result?.beatGridAlgorithmVersion).toBeUndefined()
  })

  it('loads a valid v2 grid with a stale analysis algorithm version', async () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 0,
      source: 'analysis'
    })
    if (!beatGridMap) throw new Error('v2 grid fixture failed')
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 1024,
      mtimeMs: 1000,
      info: createInfo({
        beatGridMap,
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION - 1
      })
    })

    const result = await loadSharedSongGridDefinition(FILE_PATH)

    expect(result?.beatGridMap?.signature).toBe(beatGridMap.signature)
    expect(result?.beatGridAlgorithmVersion).toBe(CURRENT_BEAT_GRID_ALGORITHM_VERSION - 1)
  })

  it('rejects a root-field-only grid', async () => {
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 1024,
      mtimeMs: 1000,
      info: createInfo({
        bpm: 128,
        firstBeatMs: 125,
        beatGridSource: 'analysis'
      })
    })

    await expect(loadSharedSongGridDefinition(FILE_PATH)).resolves.toBeNull()
  })

  it('rejects a v1 map even if it carries an algorithm version', async () => {
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 1024,
      mtimeMs: 1000,
      info: createInfo({
        bpm: 128,
        firstBeatMs: 125,
        beatGridSource: 'analysis',
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION - 1
      })
    })

    await expect(loadSharedSongGridDefinition(FILE_PATH)).resolves.toBeNull()
  })

  it('persists a v2 map without projecting it back into root grid fields', async () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 2,
      source: 'analysis'
    })
    if (!beatGridMap) throw new Error('v2 grid fixture failed')
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 1024,
      mtimeMs: 1000,
      info: createInfo({
        bpm: 126,
        firstBeatMs: 250,
        beatGridSource: 'manual',
        beatGridStatus: 'no-bpm'
      })
    })

    await expect(
      persistSharedSongGridDefinition({
        filePath: FILE_PATH,
        bpm: 128,
        firstBeatMs: 125,
        beatGridSource: 'analysis',
        beatGridMap
      })
    ).resolves.toMatchObject({ beatGridMap: { version: 2, signature: beatGridMap.signature } })

    const persistedInfo = mocks.upsertSongCacheEntry.mock.calls[0]?.[2]?.info
    expect(persistedInfo).toMatchObject({ beatGridMap })
    expect(persistedInfo).not.toHaveProperty('bpm')
    expect(persistedInfo).not.toHaveProperty('firstBeatMs')
    expect(persistedInfo).not.toHaveProperty('barBeatOffset')
    expect(persistedInfo).not.toHaveProperty('beatGridSource')
    expect(persistedInfo).not.toHaveProperty('beatGridStatus')
  })

  it('rejects root-field-only writes instead of rebuilding a canonical grid', async () => {
    await expect(
      persistSharedSongGridDefinition({
        filePath: FILE_PATH,
        bpm: 128,
        firstBeatMs: 125,
        beatGridSource: 'analysis'
      })
    ).resolves.toBeNull()

    expect(mocks.upsertSongCacheEntry).not.toHaveBeenCalled()
  })
})
