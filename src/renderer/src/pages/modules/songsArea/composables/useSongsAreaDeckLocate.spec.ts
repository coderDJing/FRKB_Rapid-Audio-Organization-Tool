// Run: pnpm exec vitest run src/renderer/src/pages/modules/songsArea/composables/useSongsAreaDeckLocate.spec.ts
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo, ISongsAreaColumn } from 'src/types/globals'
import { useGlobalSearchFocus } from './useGlobalSearchFocus'
import { useSongsAreaDeckLocate } from './useSongsAreaDeckLocate'

const lifecycle = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }))
vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onUnmounted: (cleanup: () => void) => lifecycle.cleanups.push(cleanup)
}))

const scopes: ReturnType<typeof effectScope>[] = []
const song = (filePath: string, setItemId?: string) => ({ filePath, setItemId }) as ISongInfo
const setup = (songs: ISongInfo[], pane: 'left' | 'right' = 'left') => {
  const runtime = useRuntimeStore()
  runtime.mainWindowBrowseMode = 'horizontal'
  runtime.platform = 'win32'
  runtime.songsAreaPanels.splitEnabled = true
  const state = runtime.songsAreaPanels.panes[pane]
  state.songListUUID = pane
  state.songInfoArr = [...songs]
  const original = shallowRef(songs)
  const view = ref('list')
  const columns = ref<ISongsAreaColumn[]>([])
  const scroll = vi.fn()
  const play = vi.fn()
  const flash = vi.fn()
  const apply = vi.fn(() => {
    state.songInfoArr = [...original.value]
  })
  const getRowKey = (item: ISongInfo) => item.setItemId || item.filePath
  const scope = effectScope()
  scopes.push(scope)
  const locate = scope.run(() => {
    const { focusSong } = useGlobalSearchFocus({
      runtime,
      pane,
      songsAreaState: state,
      originalSongInfoArr: original,
      columnData: columns,
      applyFiltersAndSorting: apply,
      getRowKey,
      scrollToIndex: scroll,
      songDblClick: play,
      onFocusHit: flash
    })
    return useSongsAreaDeckLocate({
      runtime,
      songsAreaState: state,
      originalSongInfoArr: original,
      viewState: view,
      getRowKey,
      focusSong
    })
  })!
  return { runtime, state, original, view, columns, scroll, play, flash, apply, ...locate }
}

const settle = async () => {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  lifecycle.cleanups.splice(0).forEach((cleanup) => cleanup())
  scopes.splice(0).forEach((scope) => scope.stop())
})

describe('dual-deck song location', () => {
  it('locates either loaded deck while paused without starting playback or changing libraries', async () => {
    const top = song('top.mp3')
    const bottom = song('bottom.mp3')
    const ctx = setup([song('other.mp3'), top, bottom])
    ctx.runtime.horizontalBrowseDecks.topSong = top
    ctx.runtime.horizontalBrowseDecks.bottomSong = bottom
    expect(ctx.deckLocateTargets.value.map((target) => target.deck)).toEqual(['top', 'bottom'])
    ctx.locateDeckSong('bottom')
    await settle()
    expect(ctx.scroll).toHaveBeenLastCalledWith(2)
    expect(ctx.flash).toHaveBeenLastCalledWith('bottom.mp3')
    expect(ctx.state.selectedSongFilePath).toEqual(['bottom.mp3'])
    ctx.locateDeckSong('top')
    await settle()
    expect(ctx.scroll).toHaveBeenLastCalledWith(1)
    expect(ctx.play).not.toHaveBeenCalled()
    expect(ctx.runtime.libraryAreaSelected).toBe('FilterLibrary')
    expect(ctx.runtime.horizontalBrowseDecks.topSong?.filePath).toBe('top.mp3')
  })

  it('clears search, key and column filters only when they hide the requested row', async () => {
    const target = song('target.mp3')
    const ctx = setup([target])
    ctx.runtime.horizontalBrowseDecks.topSong = target
    ctx.state.searchQuery = 'hidden'
    ctx.state.compatibleKeyOnly = true
    ctx.columns.value = [
      { key: 'title', filterActive: true, filterValue: 'hidden' } as ISongsAreaColumn
    ]
    ctx.state.songInfoArr = []
    expect(ctx.deckLocateTargets.value).toHaveLength(1)
    ctx.locateDeckSong('top')
    await settle()
    expect(ctx.state.searchQuery).toBe('')
    expect(ctx.state.compatibleKeyOnly).toBe(false)
    expect(ctx.columns.value[0].filterActive).toBe(false)
    expect(ctx.state.selectedSongFilePath).toEqual(['target.mp3'])
    expect(ctx.scroll).toHaveBeenLastCalledWith(0)
    expect(ctx.flash).toHaveBeenCalledOnce()
  })

  it('preserves active filters when the target is already visible', async () => {
    const target = song('target.mp3')
    const ctx = setup([target])
    ctx.runtime.horizontalBrowseDecks.topSong = target
    ctx.state.searchQuery = 'target'
    ctx.state.compatibleKeyOnly = true
    ctx.locateDeckSong('top')
    await settle()
    expect(ctx.state.searchQuery).toBe('target')
    expect(ctx.state.compatibleKeyOnly).toBe(true)
    expect(ctx.apply).not.toHaveBeenCalled()
  })

  it('finds the exact SET entry even when another occurrence of that file is visible', async () => {
    const first = song('repeat.mp3', 'entry-1')
    const loaded = song('repeat.mp3', 'entry-2')
    const ctx = setup([first, song('other.mp3', 'other'), loaded])
    ctx.runtime.horizontalBrowseDecks.bottomSong = loaded
    ctx.state.songInfoArr = [first]
    ctx.state.searchQuery = 'filtered'
    ctx.locateDeckSong('bottom')
    await settle()
    expect(ctx.state.selectedSongFilePath).toEqual(['entry-2'])
    expect(ctx.scroll).toHaveBeenLastCalledWith(2)
    expect(ctx.flash).toHaveBeenLastCalledWith('entry-2')
  })

  it('independently locates a Filter playlist and an exact SET entry in the other pane', async () => {
    const top = song('top.mp3')
    const bottom = song('bottom.mp3', 'set-entry-2')
    const left = setup([song('filter-other.mp3'), top])
    const right = setup(
      [song('bottom.mp3', 'set-entry-1'), song('set-other.mp3', 'other'), bottom],
      'right'
    )
    left.runtime.horizontalBrowseDecks.topSong = top
    left.runtime.horizontalBrowseDecks.bottomSong = bottom
    left.state.selectedSongFilePath = ['top.mp3']
    expect(left.deckLocateTargets.value.map((target) => target.deck)).toEqual(['top'])
    expect(right.deckLocateTargets.value.map((target) => target.deck)).toEqual(['bottom'])
    right.locateDeckSong('bottom')
    await settle()
    expect(right.scroll).toHaveBeenCalledWith(2)
    expect(right.state.selectedSongFilePath).toEqual(['set-entry-2'])
    expect(left.scroll).not.toHaveBeenCalled()
    expect(left.state.selectedSongFilePath).toEqual(['top.mp3'])
    left.runtime.libraryAreaSelected = 'SetLibrary'
    left.locateDeckSong('top')
    await settle()
    expect(left.scroll).toHaveBeenCalledWith(1)
    expect(right.state.selectedSongFilePath).toEqual(['set-entry-2'])
    expect(left.runtime.libraryAreaSelected).toBe('SetLibrary')
  })

  it('hides targets when ejected, loading, or outside dual-deck mode', () => {
    const target = song('target.mp3')
    const ctx = setup([target])
    ctx.runtime.horizontalBrowseDecks.topSong = target
    for (const mode of ['browser', 'edit'] as const) {
      ctx.runtime.mainWindowBrowseMode = mode
      expect(ctx.deckLocateTargets.value).toEqual([])
    }
    ctx.runtime.mainWindowBrowseMode = 'horizontal'
    ctx.view.value = 'loading'
    expect(ctx.deckLocateTargets.value).toEqual([])
    ctx.view.value = 'list'
    expect(ctx.deckLocateTargets.value).toHaveLength(1)
    ctx.runtime.horizontalBrowseDecks.topSong = null
    expect(ctx.deckLocateTargets.value).toEqual([])
    ctx.locateDeckSong('top')
    expect(ctx.scroll).not.toHaveBeenCalled()
  })

  it('matches Windows file paths across slash and case differences', async () => {
    const target = song('D:/Music/Track.mp3')
    const ctx = setup([target])
    ctx.runtime.horizontalBrowseDecks.topSong = song('d:\\music\\TRACK.mp3')
    ctx.locateDeckSong('top')
    await settle()
    expect(ctx.state.selectedSongFilePath).toEqual(['D:/Music/Track.mp3'])
    expect(ctx.scroll).toHaveBeenCalledWith(0)
  })
})
