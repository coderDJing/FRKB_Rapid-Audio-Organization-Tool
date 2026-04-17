import { ipcMain } from 'electron'
import type { ISongMemoryCue } from '../../types/globals'
import {
  normalizeSongMemoryCueSec,
  removeSongMemoryCue,
  upsertSongMemoryCue,
  upsertSongMemoryCueDefinition
} from '../../shared/memoryCues'
import { upsertMixtapeItemMemoryCuesByFilePath } from '../mixtapeDb'
import { emitSongMemoryCuesUpdated } from '../services/songMemoryCueEvents'
import {
  loadSharedSongMemoryCueDefinition,
  persistSharedSongMemoryCueDefinition
} from '../services/sharedSongMemoryCues'

export function registerMemoryCueHandlers() {
  ipcMain.handle('song:get-memory-cues', async (_event, payload?: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return []
    const result = await loadSharedSongMemoryCueDefinition(filePath)
    return result?.memoryCues || []
  })

  ipcMain.handle(
    'song:add-memory-cue',
    async (
      _event,
      payload?: {
        filePath?: string
        sec?: number
        durationSec?: number
        isLoop?: boolean
        loopEndSec?: number
      }
    ) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const sec = normalizeSongMemoryCueSec(payload?.sec, payload?.durationSec)
      if (!filePath || sec === null) return { filePath, memoryCues: [] as ISongMemoryCue[] }

      const current = await loadSharedSongMemoryCueDefinition(filePath)
      const memoryCues =
        payload?.isLoop &&
        normalizeSongMemoryCueSec(payload?.loopEndSec, payload?.durationSec) !== null
          ? upsertSongMemoryCueDefinition(
              current?.memoryCues,
              {
                sec,
                isLoop: true,
                loopEndSec: payload?.loopEndSec
              },
              payload?.durationSec
            )
          : upsertSongMemoryCue(current?.memoryCues, sec, payload?.durationSec)
      const persisted = (await persistSharedSongMemoryCueDefinition({
        filePath,
        memoryCues
      })) || { filePath, memoryCues }

      upsertMixtapeItemMemoryCuesByFilePath([{ filePath, memoryCues: persisted.memoryCues }])
      emitSongMemoryCuesUpdated(persisted)
      return persisted
    }
  )

  ipcMain.handle(
    'song:delete-memory-cue',
    async (_event, payload?: { filePath?: string; sec?: number; durationSec?: number }) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const sec = normalizeSongMemoryCueSec(payload?.sec, payload?.durationSec)
      if (!filePath || sec === null) return { filePath, memoryCues: [] as ISongMemoryCue[] }

      const current = await loadSharedSongMemoryCueDefinition(filePath)
      const memoryCues = removeSongMemoryCue(current?.memoryCues, sec, payload?.durationSec)
      const persisted = (await persistSharedSongMemoryCueDefinition({
        filePath,
        memoryCues
      })) || { filePath, memoryCues }

      upsertMixtapeItemMemoryCuesByFilePath([{ filePath, memoryCues: persisted.memoryCues }])
      emitSongMemoryCuesUpdated(persisted)
      return persisted
    }
  )
}
