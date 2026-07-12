import { ipcMain } from 'electron'
import {
  getMixtapeProjectBpmEnvelope,
  upsertMixtapeProjectBpmEnvelope
} from '../mixtapeProjectTempoDb'

export function registerMixtapeProjectTempoHandlers() {
  ipcMain.handle(
    'mixtape:project:get-bpm-envelope',
    async (_e, payload?: { playlistId?: string }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      return getMixtapeProjectBpmEnvelope(playlistId)
    }
  )

  ipcMain.handle(
    'mixtape:project:set-bpm-envelope',
    async (
      _e,
      payload?: {
        playlistId?: string
        bpmEnvelope?: Array<{ sec?: number; bpm?: number }>
        bpmEnvelopeDurationSec?: number
        gridPhaseOffsetSec?: number
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      return upsertMixtapeProjectBpmEnvelope(playlistId, {
        bpmEnvelope: Array.isArray(payload?.bpmEnvelope)
          ? payload.bpmEnvelope.map((point) => ({
              sec: Number(point?.sec),
              bpm: Number(point?.bpm)
            }))
          : [],
        bpmEnvelopeDurationSec: Number(payload?.bpmEnvelopeDurationSec),
        gridPhaseOffsetSec: Number(payload?.gridPhaseOffsetSec)
      })
    }
  )
}
