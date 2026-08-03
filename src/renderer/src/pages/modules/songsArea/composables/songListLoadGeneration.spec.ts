import { describe, expect, it } from 'vitest'
import { createSongListLoadGenerationGuard } from './songListLoadGeneration'

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
