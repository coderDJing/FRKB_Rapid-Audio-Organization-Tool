import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { log } from '../log'
import store from '../store'
import {
  getSongCover as svcGetSongCover,
  getSongCoverThumb as svcGetSongCoverThumb,
  sweepSongListCovers as svcSweepSongListCovers
} from '../services/covers'
import {
  readTrackMetadata as svcReadTrackMetadata,
  updateTrackMetadata as svcUpdateTrackMetadata
} from '../services/metadataEditor'
import {
  migrateSelectionSongIdCacheByMoves,
  resolveSelectionSongIds
} from '../services/selectionSongIdResolver'
import { autoFillTrackMetadata, cancelMetadataAutoFill } from '../services/metadataAutoFill'
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
  bumpSelectionSampleChangeCount,
  deleteSelectionPredictionCache,
  getSelectionLabel
} from 'rust_package'
import { notifySelectionSamplesChanged } from './selectionPredictionHandlers'
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

      // 本地精选预测：可编辑元数据发生变化时，清理缓存并计入重训阈值（仅对样本 liked/disliked）
      if (result?.didUpdateEditableMetadata && store.databaseDir) {
        try {
          const labelDbPath = path.join(store.databaseDir, 'selection_labels.db')
          if (!(await fs.pathExists(labelDbPath))) {
            return {
              success: true,
              songInfo: result.songInfo,
              detail: result.detail,
              renamedFrom: result.renamedFrom
            }
          }

          const filePath =
            typeof result?.songInfo?.filePath === 'string' && result.songInfo.filePath
              ? result.songInfo.filePath
              : typeof result?.detail?.filePath === 'string' && result.detail.filePath
                ? result.detail.filePath
                : ''

          if (filePath) {
            const renamedFrom =
              typeof result?.renamedFrom === 'string' && result.renamedFrom.trim()
                ? result.renamedFrom.trim()
                : ''
            if (renamedFrom && renamedFrom !== filePath) {
              try {
                await migrateSelectionSongIdCacheByMoves(
                  [{ fromPath: renamedFrom, toPath: filePath }],
                  {
                    dbDir: store.databaseDir
                  }
                )
              } catch {}
            }
            const { items } = await resolveSelectionSongIds([filePath], {
              dbDir: store.databaseDir
            })
            const songId = items?.[0]?.songId
            if (typeof songId === 'string' && songId) {
              const featureStorePath = path.join(store.databaseDir, 'features.db')
              try {
                if (await fs.pathExists(featureStorePath)) {
                  deleteSelectionPredictionCache(featureStorePath, [songId])
                }
              } catch {}

              try {
                const label = getSelectionLabel(store.databaseDir, songId)
                if (label === 'liked' || label === 'disliked') {
                  const newCount = bumpSelectionSampleChangeCount(store.databaseDir, 1)
                  notifySelectionSamplesChanged(store.databaseDir, {
                    sampleChangeCount: newCount,
                    reason: 'metadata_changed'
                  })
                }
              } catch {}
            }
          }
        } catch (error) {
          log.warn('[selection] 元数据更新钩子失败', error)
        }
      }

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
  ipcMain.handle('metadata:autoFill:cancel', async (_e, progressId: string) => {
    cancelMetadataAutoFill(typeof progressId === 'string' ? progressId : '')
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
