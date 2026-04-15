import { ipcMain } from 'electron'
import type { ISongHotCue, ISongMemoryCue } from '../../types/globals'
import {
  normalizeSongHotCueSec,
  normalizeSongHotCues,
  normalizeSongHotCueSlot,
  removeSongHotCue,
  upsertSongHotCue,
  upsertSongHotCueDefinition
} from '../../shared/hotCues'
import { normalizeSongMemoryCues } from '../../shared/memoryCues'
import { upsertMixtapeItemHotCuesByFilePath } from '../mixtapeDb'
import { upsertMixtapeItemMemoryCuesByFilePath } from '../mixtapeDb'
import { emitSongHotCuesUpdated } from '../services/songHotCueEvents'
import { emitSongMemoryCuesUpdated } from '../services/songMemoryCueEvents'
import {
  loadSharedSongHotCueDefinition,
  persistSharedSongHotCueDefinition
} from '../services/sharedSongHotCues'
import { persistSharedSongMemoryCueDefinition } from '../services/sharedSongMemoryCues'

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
      payload?: {
        filePath?: string
        slot?: number
        sec?: number
        durationSec?: number
        isLoop?: boolean
        loopEndSec?: number
      }
    ) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const slot = normalizeSongHotCueSlot(payload?.slot)
      const sec = normalizeSongHotCueSec(payload?.sec, payload?.durationSec)
      if (!filePath || slot === null || sec === null)
        return { filePath, hotCues: [] as ISongHotCue[] }

      const current = await loadSharedSongHotCueDefinition(filePath)
      const hotCues =
        payload?.isLoop &&
        normalizeSongHotCueSec(payload?.loopEndSec, payload?.durationSec) !== null
          ? upsertSongHotCueDefinition(
              current?.hotCues,
              {
                slot,
                sec,
                isLoop: true,
                loopEndSec: payload?.loopEndSec
              },
              payload?.durationSec
            )
          : upsertSongHotCue(current?.hotCues, slot, sec, payload?.durationSec)
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

  ipcMain.handle(
    'song:copy-cue-definitions-by-file-path',
    async (
      _event,
      payload?: {
        entries?: Array<{
          filePath?: string
          hotCues?: ISongHotCue[]
          memoryCues?: ISongMemoryCue[]
        }>
      }
    ) => {
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      let hotCueUpdated = 0
      let memoryCueUpdated = 0

      for (const entry of entries) {
        const filePath = typeof entry?.filePath === 'string' ? entry.filePath.trim() : ''
        if (!filePath) continue

        const hotCues = normalizeSongHotCues(entry?.hotCues)
        if (hotCues.length > 0) {
          const persistedHotCues = await persistSharedSongHotCueDefinition({
            filePath,
            hotCues
          })
          if (persistedHotCues?.hotCues?.length) {
            upsertMixtapeItemHotCuesByFilePath([{ filePath, hotCues: persistedHotCues.hotCues }])
            emitSongHotCuesUpdated(persistedHotCues)
            hotCueUpdated += 1
          }
        }

        const memoryCues = normalizeSongMemoryCues(entry?.memoryCues)
        if (memoryCues.length > 0) {
          const persistedMemoryCues = await persistSharedSongMemoryCueDefinition({
            filePath,
            memoryCues
          })
          if (persistedMemoryCues?.memoryCues?.length) {
            upsertMixtapeItemMemoryCuesByFilePath([
              { filePath, memoryCues: persistedMemoryCues.memoryCues }
            ])
            emitSongMemoryCuesUpdated(persistedMemoryCues)
            memoryCueUpdated += 1
          }
        }
      }

      return {
        hotCueUpdated,
        memoryCueUpdated
      }
    }
  )
}
