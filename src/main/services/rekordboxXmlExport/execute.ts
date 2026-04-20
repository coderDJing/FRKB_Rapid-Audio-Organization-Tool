import path from 'path'
import fs from 'fs-extra'
import store from '../../store'
import { getLogPath, log } from '../../log'
import { mapRendererPathToFsPath } from '../../utils'
import { markGlobalSongSearchDirty } from '../globalSongSearch'
import { readTrackMetadata } from '../metadataEditor'
import { scanSongListOffMainThread } from '../songListScanWorker'
import type {
  RekordboxXmlExportRequest,
  RekordboxXmlExportResponse
} from '../../../shared/rekordboxXmlExport'
import { stageTrackFiles, rollbackAppliedOperations, resolveUniqueDirectoryPath } from './fileStage'
import { buildRekordboxXml } from './xmlBuilder'
import {
  normalizePlaylistName,
  normalizeXmlFileName,
  sanitizePathSegment,
  validateExportRootDir,
  validateRequestLibrary,
  validateSelectedTrackInputs,
  collectMissingSourcePaths
} from './validate'
import {
  REKORDBOX_XML_EXPORT_CANCELLED,
  RekordboxXmlExportCancelledError,
  RekordboxXmlExportAppliedOperation,
  RekordboxXmlExportJobControl,
  RekordboxXmlExportResolvedTrack,
  RekordboxXmlExportRunOptions
} from './types'

const activeJobControls = new Map<string, RekordboxXmlExportJobControl>()

const buildFailureResponse = (params: {
  errorCode: string
  errorMessage: string
  rolledBack: boolean
  cancelled: boolean
}): RekordboxXmlExportResponse => ({
  ok: false,
  summary: {
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
    rolledBack: params.rolledBack,
    libraryChanged: false,
    cancelled: params.cancelled,
    logPath: getLogPath()
  }
})

const reportProgress = async (
  options: Pick<RekordboxXmlExportRunOptions, 'request' | 'reportProgress'>,
  payload: {
    titleKey: string
    now: number
    total: number
    isInitial?: boolean
    dismiss?: boolean
  }
) => {
  if (typeof options.reportProgress !== 'function') return
  await options.reportProgress({
    id: options.request.jobId,
    titleKey: payload.titleKey,
    now: payload.now,
    total: payload.total,
    isInitial: payload.isInitial,
    dismiss: payload.dismiss,
    cancelable: !payload.dismiss,
    cancelChannel: 'rekordbox-xml-export:cancel',
    cancelPayload: options.request.jobId
  })
}

const resolveSelectedTracks = (request: RekordboxXmlExportRequest) => {
  const validated = validateSelectedTrackInputs(
    request.source.kind === 'selected-tracks' ? request.source.tracks : []
  )
  if (!validated.ok) {
    return validated
  }
  const tracks: RekordboxXmlExportResolvedTrack[] = validated.tracks.map((track) => {
    const fallbackName = path.basename(track.filePath, path.extname(track.filePath))
    return {
      sourcePath: track.filePath,
      displayName: track.displayName || fallbackName,
      artist: typeof track.artist === 'string' ? track.artist : '',
      album: typeof track.album === 'string' ? track.album : '',
      genre: typeof track.genre === 'string' ? track.genre : '',
      label: typeof track.label === 'string' ? track.label : '',
      bitrate: typeof track.bitrate === 'number' ? track.bitrate : undefined,
      duration: typeof track.duration === 'string' ? track.duration : ''
    }
  })
  return {
    ok: true as const,
    tracks
  }
}

const resolvePlaylistTracks = async (request: RekordboxXmlExportRequest) => {
  if (request.source.kind !== 'playlist') {
    return {
      ok: false as const,
      code: 'INVALID_SOURCE',
      message: '导出源类型无效。'
    }
  }
  const rendererPath = String(request.source.songListPath || '').trim()
  if (!rendererPath) {
    return {
      ok: false as const,
      code: 'PLAYLIST_PATH_REQUIRED',
      message: '缺少歌单路径。'
    }
  }
  const absolutePlaylistPath = path.join(store.databaseDir, mapRendererPathToFsPath(rendererPath))
  const result = await scanSongListOffMainThread({
    scanPath: absolutePlaylistPath,
    audioExt: store.settingConfig.audioExt,
    songListUUID: request.source.songListUUID,
    databaseDir: store.databaseDir
  })
  const scanData = Array.isArray(result?.scanData) ? result.scanData : []
  if (scanData.length === 0) {
    return {
      ok: false as const,
      code: 'NO_TRACKS',
      message: '当前歌单里没有可导出的曲目。'
    }
  }
  return {
    ok: true as const,
    tracks: scanData.map((item) => ({
      sourcePath: path.resolve(item.filePath),
      displayName:
        String(item.title || '').trim() ||
        path.basename(item.filePath, path.extname(item.filePath)),
      artist: typeof item.artist === 'string' ? item.artist : '',
      album: typeof item.album === 'string' ? item.album : '',
      genre: typeof item.genre === 'string' ? item.genre : '',
      label: typeof item.label === 'string' ? item.label : '',
      bitrate: typeof item.bitrate === 'number' ? item.bitrate : undefined,
      duration: typeof item.duration === 'string' ? item.duration : ''
    }))
  }
}

const resolveSourceTracks = async (request: RekordboxXmlExportRequest) => {
  if (request.source.kind === 'selected-tracks') {
    return resolveSelectedTracks(request)
  }
  return await resolvePlaylistTracks(request)
}

const enrichTracksWithMetadata = async (tracks: RekordboxXmlExportResolvedTrack[]) => {
  return await Promise.all(
    tracks.map(async (track) => {
      try {
        const detail = await readTrackMetadata(track.sourcePath)
        if (!detail) return track
        const title = String(detail.title || '').trim()
        const artist = String(detail.artist || '').trim()
        const composer = String(detail.composer || '').trim()
        const album = String(detail.album || '').trim()
        const genre = String(detail.genre || '').trim()
        const label = String(detail.label || '').trim()
        const comment = String(detail.comment || '').trim()
        const year = String(detail.year || '').trim()
        const trackNumber =
          typeof detail.trackNo === 'number' && Number.isFinite(detail.trackNo) ? detail.trackNo : 0
        const discNumber =
          typeof detail.discNo === 'number' && Number.isFinite(detail.discNo) ? detail.discNo : 0
        const duration =
          typeof detail.durationSeconds === 'number' && Number.isFinite(detail.durationSeconds)
            ? `${String(Math.floor(detail.durationSeconds / 60)).padStart(2, '0')}:${String(
                detail.durationSeconds % 60
              ).padStart(2, '0')}`
            : track.duration
        return {
          ...track,
          displayName: title || track.displayName,
          artist: artist || track.artist,
          composer: composer || track.composer,
          album: album || track.album,
          genre: genre || track.genre,
          label: label || track.label,
          comment: comment || track.comment,
          year: year || track.year,
          trackNumber: trackNumber || track.trackNumber,
          discNumber: discNumber || track.discNumber,
          duration
        }
      } catch {
        return track
      }
    })
  )
}

export const requestCancelRekordboxXmlExport = (jobId: string) => {
  const control = activeJobControls.get(String(jobId || '').trim())
  if (!control) return false
  control.cancelled = true
  return true
}

export async function runRekordboxXmlExportJob(
  options: RekordboxXmlExportRunOptions
): Promise<RekordboxXmlExportResponse> {
  const { request, control } = options
  let appliedOperations: RekordboxXmlExportAppliedOperation[] = []
  let exportDirPath = ''
  let xmlPath = ''
  activeJobControls.set(request.jobId, control)

  const throwIfCancelled = () => {
    if (control.cancelled) {
      throw new RekordboxXmlExportCancelledError()
    }
  }

  try {
    const libraryValidation = validateRequestLibrary(request)
    if (!libraryValidation.ok) {
      return buildFailureResponse({
        errorCode: libraryValidation.code,
        errorMessage: libraryValidation.message,
        rolledBack: true,
        cancelled: false
      })
    }

    const rootValidation = await validateExportRootDir(request.targetRootDir, store.databaseDir)
    if (!rootValidation.ok) {
      return buildFailureResponse({
        errorCode: rootValidation.code,
        errorMessage: rootValidation.message,
        rolledBack: true,
        cancelled: false
      })
    }

    const sourceTracksResult = await resolveSourceTracks(request)
    if (!sourceTracksResult.ok) {
      return buildFailureResponse({
        errorCode: sourceTracksResult.code,
        errorMessage: sourceTracksResult.message,
        rolledBack: true,
        cancelled: false
      })
    }

    const sourceTracks = await enrichTracksWithMetadata(sourceTracksResult.tracks)
    const missingPaths = await collectMissingSourcePaths(
      sourceTracks.map((track) => track.sourcePath)
    )
    if (missingPaths.length > 0) {
      return buildFailureResponse({
        errorCode: 'SOURCE_FILE_MISSING',
        errorMessage: `存在缺失文件，已阻止导出。缺失数量：${missingPaths.length}`,
        rolledBack: true,
        cancelled: false
      })
    }

    const totalSteps = sourceTracks.length + 1
    const fallbackDirBase =
      request.source.kind === 'playlist'
        ? request.source.playlistName || request.xmlPlaylistName
        : request.xmlPlaylistName
    const normalizedExportDirName = sanitizePathSegment(
      request.exportDirName,
      fallbackDirBase || 'FRKB Rekordbox Export'
    )
    const normalizedXmlFileName = normalizeXmlFileName(request.xmlFileName, normalizedExportDirName)
    const normalizedPlaylistName = normalizePlaylistName(
      request.xmlPlaylistName,
      request.source.kind === 'playlist' ? request.source.playlistName : 'FRKB Export'
    )

    await reportProgress(options, {
      titleKey: 'rekordboxXmlExport.preparing',
      now: 0,
      total: totalSteps,
      isInitial: true
    })

    throwIfCancelled()
    await fs.ensureDir(rootValidation.resolvedTarget)
    exportDirPath = await resolveUniqueDirectoryPath(
      rootValidation.resolvedTarget,
      normalizedExportDirName
    )
    await fs.ensureDir(exportDirPath)

    const stageResult = await stageTrackFiles({
      tracks: sourceTracks,
      exportDirPath,
      mode: request.mode,
      stagedTracks: [],
      appliedOperations,
      throwIfCancelled,
      onTrackDone: async (done, total) => {
        await reportProgress(options, {
          titleKey:
            request.mode === 'move'
              ? 'rekordboxXmlExport.movingTracks'
              : 'rekordboxXmlExport.copyingTracks',
          now: done,
          total: total + 1
        })
      }
    })
    const stagedTracks = stageResult.stagedTracks
    appliedOperations = stageResult.appliedOperations

    throwIfCancelled()
    await reportProgress(options, {
      titleKey: 'rekordboxXmlExport.buildingXml',
      now: sourceTracks.length,
      total: totalSteps
    })

    const xmlContent = buildRekordboxXml({
      playlistName: normalizedPlaylistName,
      tracks: stagedTracks
    })
    xmlPath = path.join(exportDirPath, normalizedXmlFileName)
    await fs.writeFile(xmlPath, xmlContent, 'utf8')

    await reportProgress(options, {
      titleKey: 'rekordboxXmlExport.buildingXml',
      now: totalSteps,
      total: totalSteps
    })

    if (request.mode === 'move') {
      markGlobalSongSearchDirty('rekordbox-xml-export-move')
    }

    return {
      ok: true,
      summary: {
        mode: request.mode,
        trackCount: stagedTracks.length,
        exportDirPath,
        xmlPath,
        playlistName: normalizedPlaylistName,
        sourceFilePaths: stagedTracks.map((track) => track.sourcePath),
        exportedFilePaths: stagedTracks.map((track) => track.outputPath)
      }
    }
  } catch (error) {
    const isCancelled =
      error instanceof RekordboxXmlExportCancelledError ||
      (error as { code?: unknown } | null)?.code === REKORDBOX_XML_EXPORT_CANCELLED
    let rolledBack = true
    const rollbackErrors: string[] = []

    if (xmlPath) {
      try {
        await fs.remove(xmlPath)
      } catch (removeError) {
        const removeMessage =
          removeError instanceof Error
            ? removeError.message
            : String(removeError || 'unknown error')
        rollbackErrors.push(`remove_xml:${xmlPath}: ${removeMessage}`)
        rolledBack = false
      }
    }

    if (appliedOperations.length > 0) {
      const rollbackResult = await rollbackAppliedOperations(appliedOperations)
      rolledBack = rolledBack && rollbackResult.rolledBack
      rollbackErrors.push(...rollbackResult.errors)
    }

    if (exportDirPath) {
      try {
        await fs.remove(exportDirPath)
      } catch (removeDirError) {
        const removeDirMessage =
          removeDirError instanceof Error
            ? removeDirError.message
            : String(removeDirError || 'unknown error')
        rollbackErrors.push(`remove_dir:${exportDirPath}: ${removeDirMessage}`)
        rolledBack = false
      }
    }

    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : isCancelled
          ? '用户取消了导出。'
          : '导出失败。'

    log.error('[rekordbox-xml-export] export failed', error)

    return buildFailureResponse({
      errorCode: isCancelled ? REKORDBOX_XML_EXPORT_CANCELLED : 'EXPORT_FAILED',
      errorMessage: message,
      rolledBack,
      cancelled: isCancelled
    })
  } finally {
    await reportProgress(options, {
      titleKey: 'rekordboxXmlExport.preparing',
      now: 0,
      total: 0,
      dismiss: true
    })
    activeJobControls.delete(request.jobId)
  }
}
