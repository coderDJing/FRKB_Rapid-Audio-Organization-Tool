import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findSongListRootByPath: vi.fn(),
  loadSongCacheTrackFields: vi.fn(),
  loadSongCacheEntry: vi.fn()
}))

vi.mock('../libraryTreeDb', () => ({
  findSongListRootByPath: mocks.findSongListRootByPath
}))

vi.mock('../libraryCacheDb', () => ({
  loadSongCacheTrackFields: mocks.loadSongCacheTrackFields,
  loadSongCacheEntry: mocks.loadSongCacheEntry
}))

import { readCacheFieldsBatch } from './cacheFields'

describe('readCacheFieldsBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('同一歌单只整批读取一次缓存', async () => {
    const listRoot = path.resolve('test-library', 'list-a')
    const first = path.join(listRoot, 'a.mp3')
    const second = path.join(listRoot, 'b.mp3')
    mocks.findSongListRootByPath.mockResolvedValue(listRoot)
    mocks.loadSongCacheTrackFields.mockResolvedValue(
      new Map([
        [first, { trackNumber: 2, addedAtMs: 10 }],
        [second, { trackNumber: 1, addedAtMs: 20 }]
      ])
    )

    const result = await readCacheFieldsBatch([first, second])

    expect(mocks.findSongListRootByPath).toHaveBeenCalledTimes(1)
    expect(mocks.loadSongCacheTrackFields).toHaveBeenCalledTimes(1)
    expect(mocks.loadSongCacheEntry).not.toHaveBeenCalled()
    expect(result.get(first)).toEqual({ trackNumber: 2, addedAtMs: 10 })
    expect(result.get(second)).toEqual({ trackNumber: 1, addedAtMs: 20 })
  })
})
