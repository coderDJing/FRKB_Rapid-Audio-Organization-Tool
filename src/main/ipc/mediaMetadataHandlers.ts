import { ipcMain } from 'electron'
import { log } from '../log'
import {
  getSongCover as svcGetSongCover,
  getSongCoverThumb as svcGetSongCoverThumb,
  sweepSongListCovers as svcSweepSongListCovers
} from '../services/covers'
import {
  readTrackMetadata as svcReadTrackMetadata,
  updateTrackMetadata as svcUpdateTrackMetadata
} from '../services/metadataEditor'
import { autoFillTrackMetadata } from '../services/metadataAutoFill'
import {
  searchMusicBrainz,
  fetchMusicBrainzSuggestion,
  cancelMusicBrainzRequests
} from '../services/musicBrainz'
import {
  matchTrackWithAcoustId,
  cancelAcoustIdRequests,
  validateAcoustIdClientKeyValue
} from '../services/acoustId'
import {
  IMusicBrainzSearchPayload,
  IMusicBrainzSuggestionParams,
  IMusicBrainzAcoustIdPayload,
  ITrackMetadataUpdatePayload,
  IMetadataAutoFillRequest
} from '../../types/globals'

export function registerMediaMetadataHandlers() {
  ipcMain.handle('getSongCover', async (_e, filePath: string) => {
    return await svcGetSongCover(filePath)
  })

  ipcMain.handle(
    'getSongCoverThumb',
    async (_e, filePath: string, size: number = 48, listRootDir?: string | null) => {
      return await svcGetSongCoverThumb(filePath, size, listRootDir)
    }
  )

  ipcMain.handle(
    'sweepSongListCovers',
    async (_e, listRootDir: string, currentFilePaths: string[]) => {
      return await svcSweepSongListCovers(listRootDir, currentFilePaths)
    }
  )

  ipcMain.handle('audio:metadata:get', async (_e, filePath: string) => {
    return await svcReadTrackMetadata(filePath)
  })

  ipcMain.handle('audio:metadata:update', async (_e, payload: ITrackMetadataUpdatePayload) => {
    try {
      const result = await svcUpdateTrackMetadata(payload)
      return {
        success: true,
        songInfo: result.songInfo,
        detail: result.detail,
        renamedFrom: result.renamedFrom
      }
    } catch (error: any) {
      log.error('更新音频元数据失败', {
        filePath: payload?.filePath,
        error: error?.message || error,
        stderr: error?.stderr,
        exitCode: error?.exitCode
      })
      return {
        success: false,
        message: error?.message || 'metadata-update-failed',
        errorCode: error?.code || error?.message || 'metadata-update-failed',
        errorDetail: error?.stderr || ''
      }
    }
  })

  ipcMain.handle('metadata:autoFill', async (_e, payload: IMetadataAutoFillRequest) => {
    return await autoFillTrackMetadata(
      payload && Array.isArray(payload.filePaths) ? payload : { filePaths: [] }
    )
  })

  ipcMain.handle('musicbrainz:search', async (_e, payload: IMusicBrainzSearchPayload) => {
    return await searchMusicBrainz(payload)
  })

  ipcMain.handle('musicbrainz:suggest', async (_e, payload: IMusicBrainzSuggestionParams) => {
    return await fetchMusicBrainzSuggestion(payload)
  })

  ipcMain.handle('musicbrainz:cancelRequests', async () => {
    cancelMusicBrainzRequests()
  })

  ipcMain.handle('musicbrainz:acoustidMatch', async (_e, payload: IMusicBrainzAcoustIdPayload) => {
    return await matchTrackWithAcoustId(payload)
  })

  ipcMain.handle('acoustid:validateClientKey', async (_e, clientKey: string) => {
    await validateAcoustIdClientKeyValue(typeof clientKey === 'string' ? clientKey : '')
  })

  ipcMain.handle('acoustid:cancelRequests', async () => {
    cancelAcoustIdRequests()
  })
}
