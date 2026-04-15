import { EventEmitter } from 'node:events'
import type { ISongMemoryCue } from '../../types/globals'
import { normalizeSongMemoryCues } from '../../shared/memoryCues'

export type SongMemoryCuesUpdatedPayload = {
  filePath: string
  memoryCues: ISongMemoryCue[]
}

export const songMemoryCueEvents = new EventEmitter()

export const emitSongMemoryCuesUpdated = (
  payload: Partial<SongMemoryCuesUpdatedPayload> | null | undefined
) => {
  const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
  if (!filePath) return
  songMemoryCueEvents.emit('memory-cues-updated', {
    filePath,
    memoryCues: normalizeSongMemoryCues(payload?.memoryCues)
  } satisfies SongMemoryCuesUpdatedPayload)
}
