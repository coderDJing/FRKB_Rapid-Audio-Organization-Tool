import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo } from 'src/types/globals'
import { useSongsAreaColumns } from './useSongsAreaColumns'

vi.mock('@renderer/utils/libraryUtils', () => ({
  default: {
    getLibraryTreeByUUID: () => ({ type: 'songList' }),
    findDirPathByUuid: () => 'library/FilterLibrary/test'
  }
}))

const songs = [
  { filePath: 'same.mp3', title: 'House one', key: 'Am' },
  { filePath: 'relative.mp3', title: 'House two', key: '8B' },
  { filePath: 'adjacent.mp3', title: 'Techno', key: '7A' },
  { filePath: 'other.mp3', title: 'House three', key: '2A' },
  { filePath: 'unknown.mp3', title: 'Unknown', key: '' }
].map((song, index) => ({ ...song, playlistTrackNumber: index + 1 })) as ISongInfo[]

const scopes: ReturnType<typeof effectScope>[] = []
const setup = () => {
  const runtime = useRuntimeStore()
  runtime.mainWindowBrowseMode = 'horizontal'
  runtime.horizontalBrowseDecks.topSong = songs[0]
  runtime.horizontalBrowseDecks.bottomSong = songs[3]
  runtime.horizontalBrowseDecks.leaderDeck = 'top'
  const panes = (['left', 'right'] as const).map((pane) => {
    const state = runtime.songsAreaPanels.panes[pane]
    state.songListUUID = pane
    const original = shallowRef([...songs])
    const scope = effectScope()
    scopes.push(scope)
    const columns = scope.run(() =>
      useSongsAreaColumns({
        runtime,
        songsAreaState: state,
        originalSongInfoArr: original,
        shouldPersistToLocalStorage: () => false
      })
    )!
    columns.applyFiltersAndSorting()
    return { state, original, columns, paths: () => state.songInfoArr.map((song) => song.filePath) }
  })
  return { runtime, left: panes[0], right: panes[1] }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null })
})

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
  vi.unstubAllGlobals()
})

describe('playlist compatible-key filtering', () => {
  it('combines text search and compatibility independently for each pane', async () => {
    const { left, right } = setup()
    left.state.compatibleKeyOnly = true
    left.state.searchQuery = 'House'
    await nextTick()
    expect(left.paths()).toEqual(['same.mp3', 'relative.mp3'])
    expect(right.paths()).toHaveLength(5)
    expect(left.state.totalSongCount).toBe(5)
    left.state.compatibleKeyOnly = false
    await nextTick()
    expect(left.paths()).toEqual(['same.mp3', 'relative.mp3', 'other.mp3'])
  })

  it('updates both open panes on a Master switch and removes only hidden selections', async () => {
    const { runtime, left, right } = setup()
    left.state.compatibleKeyOnly = right.state.compatibleKeyOnly = true
    await nextTick()
    expect(left.paths()).toEqual(['same.mp3', 'relative.mp3', 'adjacent.mp3'])
    left.state.selectedSongFilePath = ['same.mp3']
    runtime.horizontalBrowseDecks.leaderDeck = 'bottom'
    await nextTick()
    expect(left.paths()).toEqual(['other.mp3'])
    expect(right.paths()).toEqual(left.paths())
    expect(left.state.selectedSongFilePath).toEqual([])
    left.state.selectedSongFilePath = ['other.mp3']
    runtime.horizontalBrowseDecks.bottomSong = { ...songs[3], key: '3A' }
    await nextTick()
    expect(left.state.selectedSongFilePath).toEqual(['other.mp3'])
  })

  it('uses the edit deck and suspends filtering in browser mode without losing the choice', async () => {
    const { runtime, left } = setup()
    left.state.compatibleKeyOnly = true
    runtime.horizontalBrowseDecks.leaderDeck = 'bottom'
    runtime.mainWindowBrowseMode = 'edit'
    await nextTick()
    expect(left.paths()).toEqual(['same.mp3', 'relative.mp3', 'adjacent.mp3'])
    runtime.mainWindowBrowseMode = 'browser'
    await nextTick()
    expect(left.paths()).toHaveLength(5)
    expect(left.state.compatibleKeyOnly).toBe(true)
    runtime.mainWindowBrowseMode = 'horizontal'
    await nextTick()
    expect(left.paths()).toEqual(['other.mp3'])
  })

  it('shows no highlighted songs when the Master is removed and resumes when loaded', async () => {
    const { runtime, left } = setup()
    left.state.compatibleKeyOnly = true
    await nextTick()
    runtime.horizontalBrowseDecks.topSong = null
    await nextTick()
    expect(left.paths()).toEqual([])
    runtime.horizontalBrowseDecks.topSong = songs[0]
    await nextTick()
    expect(left.paths()).toHaveLength(3)
  })

  it('retains visible row identities and avoids assignments for an equivalent Master key', async () => {
    const { runtime, left } = setup()
    left.state.compatibleKeyOnly = true
    await nextTick()
    const previous = left.state.songInfoArr
    const selected = left.state.selectedSongFilePath
    runtime.horizontalBrowseDecks.topSong = { ...songs[0], key: '8A' }
    await nextTick()
    expect(left.state.songInfoArr).toBe(previous)
    expect(left.state.selectedSongFilePath).toBe(selected)
    expect(left.columns.shouldApplyFiltersAndSortingForSongChange(['key'])).toBe(true)
    left.original.value = [...songs, { ...songs[0], filePath: 'new.mp3', playlistTrackNumber: 6 }]
    left.columns.applyFiltersAndSorting()
    expect(left.state.songInfoArr[0]).toBe(previous[0])
    expect(left.paths()).toContain('new.mp3')
  })
})
