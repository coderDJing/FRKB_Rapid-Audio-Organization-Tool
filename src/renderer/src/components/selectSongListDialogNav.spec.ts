import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IDir } from 'src/types/globals'

const createLocalStorageStub = () => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear()
  }
}

const playlist = (uuid: string, dirName: string): IDir =>
  ({ uuid, dirName, type: 'songList', children: [] }) as IDir

const folder = (uuid: string, dirName: string, children: IDir[]): IDir =>
  ({ uuid, dirName, type: 'dir', children }) as IDir

describe('collectDialogSongLists sort order', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.stubGlobal('localStorage', createLocalStorageStub())
    vi.doMock('@renderer/utils/libraryUtils', () => ({
      default: { findDirPathByUuid: (uuid: string) => `library/${uuid}` }
    }))
  })

  it('walks each folder in display sort order for keyboard navigation', async () => {
    const { collectDialogSongLists } = await import('./selectSongListDialogNav')
    const root: IDir = {
      uuid: 'lib',
      dirName: 'FilterLibrary',
      type: 'library',
      children: [
        folder('f-z', 'Zebra', [playlist('z1', 'Zulu')]),
        playlist('a', 'Alpha'),
        playlist('m', 'Mike')
      ]
    }

    expect(
      collectDialogSongLists(root, 'FilterLibrary', 'nameAsc').map((item) => item.uuid)
    ).toEqual(['a', 'm', 'z1'])
    expect(
      collectDialogSongLists(root, 'FilterLibrary', 'nameDesc').map((item) => item.uuid)
    ).toEqual(['z1', 'm', 'a'])
    expect(collectDialogSongLists(root, 'FilterLibrary').map((item) => item.uuid)).toEqual([
      'z1',
      'a',
      'm'
    ])
  })

  it('keeps recently used in recency order even when all playlists are name-sorted', async () => {
    const { buildVisibleCombinedNavList } = await import('./selectSongListDialogNav')
    const recent = [playlist('m', 'Mike'), playlist('a', 'Alpha')]
    const allSorted = [playlist('a', 'Alpha'), playlist('m', 'Mike'), playlist('z1', 'Zulu')]

    expect(buildVisibleCombinedNavList(recent, allSorted, '').map((item) => item.uuid)).toEqual([
      'm',
      'a',
      'a',
      'm',
      'z1'
    ])
    expect(buildVisibleCombinedNavList(recent, allSorted, '').map((item) => item.area)).toEqual([
      'recent',
      'recent',
      'tree',
      'tree',
      'tree'
    ])
  })
})
