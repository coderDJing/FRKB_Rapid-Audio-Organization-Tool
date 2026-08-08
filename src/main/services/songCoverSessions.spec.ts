import { describe, expect, it } from 'vitest'
import { SongCoverSessionRegistry } from './songCoverSessions'

describe('SongCoverSessionRegistry', () => {
  it('marks an older playlist generation stale as soon as a newer one starts', () => {
    const registry = new SongCoverSessionRegistry()
    const oldSession = registry.activate(7, { clientKey: 'pane-a', generation: 1 })
    const newSession = registry.activate(7, { clientKey: 'pane-a', generation: 2 })

    expect(oldSession && registry.isStale(oldSession)).toBe(true)
    expect(newSession && registry.isStale(newSession)).toBe(false)
  })

  it('cancels a generation without affecting another pane', () => {
    const registry = new SongCoverSessionRegistry()
    const paneA = registry.activate(7, { clientKey: 'pane-a', generation: 3 })
    const paneB = registry.activate(7, { clientKey: 'pane-b', generation: 1 })

    registry.cancel(7, { clientKey: 'pane-a', generation: 3 })

    expect(paneA && registry.isStale(paneA)).toBe(true)
    expect(paneB && registry.isStale(paneB)).toBe(false)
  })

  it('clears only sessions belonging to the destroyed renderer', () => {
    const registry = new SongCoverSessionRegistry()
    const firstRenderer = registry.activate(7, { clientKey: 'pane-a', generation: 1 })
    const secondRenderer = registry.activate(8, { clientKey: 'pane-a', generation: 2 })

    registry.clearSender(7)
    registry.activate(7, { clientKey: 'pane-a', generation: 1 })

    expect(firstRenderer && registry.isStale(firstRenderer)).toBe(false)
    expect(secondRenderer && registry.isStale(secondRenderer)).toBe(false)
  })
})
