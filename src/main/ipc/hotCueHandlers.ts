import { ipcMain } from 'electron'
import type { ISongHotCue } from '../../types/globals'
import {
  normalizeSongHotCueSec,
  normalizeSongHotCueSlot,
  removeSongHotCue,
  upsertSongHotCue
} from '../../shared/hotCues'
import { upsertMixtapeItemHotCuesByFilePath } from '../mixtapeDb'
import { emitSongHotCuesUpdated } from '../services/songHotCueEvents'
import {
  loadSharedSongHotCueDefinition,
  persistSharedSongHotCueDefinition
} from '../services/sharedSongHotCues'

export function registerHotCueHandlers() {
  ipcMain.handle('song:get-hot-cues', async (_event, payload?: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return []
    const result = await loadSharedSongHotCueDefinition(filePath)
    return result?.hotCues || []
  })

  ipcMain.handle(
    'song:set-hot-cue',
    async (
      _event,
      payload?: { filePath?: string; slot?: number; sec?: number; durationSec?: number }
    ) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const slot = normalizeSongHotCueSlot(payload?.slot)
      const sec = normalizeSongHotCueSec(payload?.sec, payload?.durationSec)
      if (!filePath || slot === null || sec === null)
        return { filePath, hotCues: [] as ISongHotCue[] }

      const current = await loadSharedSongHotCueDefinition(filePath)
      const hotCues = upsertSongHotCue(current?.hotCues, slot, sec, payload?.durationSec)
      const persisted = (await persistSharedSongHotCueDefinition({
        filePath,
        hotCues
      })) || { filePath, hotCues }

      upsertMixtapeItemHotCuesByFilePath([{ filePath, hotCues: persisted.hotCues }])
      emitSongHotCuesUpdated(persisted)
      return persisted
    }
  )

  ipcMain.handle(
    'song:delete-hot-cue',
    async (_event, payload?: { filePath?: string; slot?: number; durationSec?: number }) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const slot = normalizeSongHotCueSlot(payload?.slot)
      if (!filePath || slot === null) return { filePath, hotCues: [] as ISongHotCue[] }

      const current = await loadSharedSongHotCueDefinition(filePath)
      const hotCues = removeSongHotCue(current?.hotCues, slot, payload?.durationSec)
      const persisted = (await persistSharedSongHotCueDefinition({
        filePath,
        hotCues
      })) || { filePath, hotCues }

      upsertMixtapeItemHotCuesByFilePath([{ filePath, hotCues: persisted.hotCues }])
      emitSongHotCuesUpdated(persisted)
      return persisted
    }
  )
}
