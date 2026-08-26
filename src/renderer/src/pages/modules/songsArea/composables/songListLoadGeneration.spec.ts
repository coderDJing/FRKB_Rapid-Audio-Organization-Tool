import { describe, expect, it } from 'vitest'
import { createSongListLoadGenerationGuard, isSongListViewPending } from './songListLoadGeneration'

describe('song list load generation guard', () => {
  it('rejects an in-flight load after the list membership changes', () => {
    let currentSongListUUID = 'playlist-a'
    const guard = createSongListLoadGenerationGuard(() => currentSongListUUID)
    const staleTicket = guard.begin(currentSongListUUID)

    guard.invalidate()

    expect(guard.isCurrent(staleTicket)).toBe(false)
  })

  it('only accepts the latest load for the same playlist', () => {
    const currentSongListUUID = 'playlist-a'
    const guard = createSongListLoadGenerationGuard(() => currentSongListUUID)
    const firstTicket = guard.begin(currentSongListUUID)
    const secondTicket = guard.begin(currentSongListUUID)

    expect(guard.isCurrent(firstTicket)).toBe(false)
    expect(guard.isCurrent(secondTicket)).toBe(true)
  })

  it('rejects a response after the active playlist changes', () => {
    let currentSongListUUID = 'playlist-a'
    const guard = createSongListLoadGenerationGuard(() => currentSongListUUID)
    const ticket = guard.begin(currentSongListUUID)

    currentSongListUUID = 'playlist-b'

    expect(guard.isCurrent(ticket)).toBe(false)
  })
})

describe('song list view pending', () => {
  it('treats a newly selected playlist as pending before its data is applied', () => {
    expect(isSongListViewPending('playlist-b', 'playlist-a')).toBe(true)
    expect(isSongListViewPending('playlist-b', '')).toBe(true)
  })

  it('is not pending after the current playlist has been applied', () => {
    expect(isSongListViewPending('playlist-a', 'playlist-a')).toBe(false)
  })

  it('is not pending when no playlist is selected', () => {
    expect(isSongListViewPending('', 'playlist-a')).toBe(false)
    expect(isSongListViewPending('', '')).toBe(false)
  })
})
