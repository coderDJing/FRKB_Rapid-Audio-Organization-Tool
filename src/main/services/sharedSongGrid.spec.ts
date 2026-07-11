import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from '../../types/globals'
import { createSongBeatGridMapFromClips } from '../../shared/songBeatGridMap'
import { CURRENT_BEAT_GRID_ALGORITHM_VERSION } from './beatGridAlgorithmVersion'

const mocks = vi.hoisted(() => ({
  findSongListRoot: vi.fn<(directory: string) => Promise<string | null>>(),
  listMixtapeItemsByFilePath: vi.fn<(filePath: string) => []>(),
  loadSongCacheEntry: vi.fn()
}))

vi.mock('../libraryCacheDb', () => ({
  loadSongCacheEntry: mocks.loadSongCacheEntry
}))

vi.mock('../libraryCacheDb/pathResolvers', () => ({
  stripBeatThisDebugInfo: <T>(value: T) => value
}))

vi.mock('../mixtapeDb', () => ({
  listMixtapeItemsByFilePath: mocks.listMixtapeItemsByFilePath
}))

vi.mock('./cacheMaintenance', () => ({
  findSongListRoot: mocks.findSongListRoot
}))

import { loadSharedSongGridDefinition } from './sharedSongGrid'

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

const createDynamicGrid = () => {
  const grid = createSongBeatGridMapFromClips([
    { startSec: 0, anchorSec: 0.125, bpm: 128, barBeatOffset: 0 },
    { startSec: 32, anchorSec: 32.25, bpm: 130, barBeatOffset: 0 }
  ])
  if (!grid) throw new Error('dynamic grid fixture failed')
  return grid
}

describe('loadSharedSongGridDefinition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findSongListRoot.mockResolvedValue('G:/FRKB_database-A/library')
    mocks.listMixtapeItemsByFilePath.mockReturnValue([])
  })

  it('loads a valid dynamic grid without requiring an analysis algorithm version', async () => {
    const beatGridMap = createDynamicGrid()
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

  it('loads a valid dynamic grid with a stale analysis algorithm version', async () => {
    const beatGridMap = createDynamicGrid()
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

  it('loads a valid fixed analysis grid without an algorithm version', async () => {
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 1024,
      mtimeMs: 1000,
      info: createInfo({
        bpm: 128,
        firstBeatMs: 125,
        barBeatOffset: 0,
        beatGridSource: 'analysis'
      })
    })

    await expect(loadSharedSongGridDefinition(FILE_PATH)).resolves.toMatchObject({
      bpm: 128,
      firstBeatMs: 125,
      barBeatOffset: 0
    })
  })

  it('loads a valid fixed analysis grid with a stale algorithm version', async () => {
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 1024,
      mtimeMs: 1000,
      info: createInfo({
        bpm: 128,
        firstBeatMs: 125,
        barBeatOffset: 0,
        beatGridSource: 'analysis',
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION - 1
      })
    })

    await expect(loadSharedSongGridDefinition(FILE_PATH)).resolves.toMatchObject({
      bpm: 128,
      firstBeatMs: 125,
      barBeatOffset: 0,
      beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION - 1
    })
  })
})
