import { EventEmitter } from 'node:events'
import type { SharedSongGridDefinition } from './sharedSongGrid'

export const songGridEvents = new EventEmitter()

export const emitSongGridUpdated = (payload: SharedSongGridDefinition | null | undefined) => {
  const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
  if (!filePath) return
  songGridEvents.emit('grid-updated', {
    filePath,
    bpm: payload?.bpm,
    firstBeatMs: payload?.firstBeatMs,
    barBeatOffset: payload?.barBeatOffset
  } satisfies SharedSongGridDefinition)
}
