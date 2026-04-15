import { EventEmitter } from 'node:events'
import type { ISongHotCue } from '../../types/globals'
import { normalizeSongHotCues } from '../../shared/hotCues'

export type SongHotCuesUpdatedPayload = {
  filePath: string
  hotCues: ISongHotCue[]
}

export const songHotCueEvents = new EventEmitter()

export const emitSongHotCuesUpdated = (
  payload: Partial<SongHotCuesUpdatedPayload> | null | undefined
) => {
  const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
  if (!filePath) return
  songHotCueEvents.emit('hot-cues-updated', {
    filePath,
    hotCues: normalizeSongHotCues(payload?.hotCues)
  } satisfies SongHotCuesUpdatedPayload)
}
