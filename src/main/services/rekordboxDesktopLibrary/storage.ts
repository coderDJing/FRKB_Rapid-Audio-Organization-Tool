import fs from 'fs-extra'
import path from 'path'
import { getLogPath, log } from '../../log'
import { moveOrCopyItemWithCheckIsExist } from '../../utils'
import type {
  RekordboxDesktopCopyTracksToStorageRequest,
  RekordboxDesktopCopyTracksToStorageResponse,
  RekordboxDesktopPlaylistTrackInput
} from '../../../shared/rekordboxDesktopPlaylist'

type ProgressPayload = {
  id: string
  titleKey: string
  now: number
  total: number
  isInitial?: boolean
  dismiss?: boolean
}

type CopyTracksOptions = {
  jobId: string
  reportProgress?: (payload: ProgressPayload) => void | Promise<void>
}

const buildFailureResponse = (
  errorCode: string,
  errorMessage: string,
  details?: Record<string, unknown>
): RekordboxDesktopCopyTracksToStorageResponse => {
  log.error('[rekordbox-desktop-playlist] copy tracks to storage failed', {
    errorCode,
    errorMessage,
    ...details
  })
  return {
    ok: false,
    summary: {
      errorCode,
      errorMessage,
      logPath: getLogPath()
    }
  }
}

const reportProgress = async (options: CopyTracksOptions, payload: Omit<ProgressPayload, 'id'>) => {
  if (typeof options.reportProgress !== 'function') return
  await options.reportProgress({
    id: options.jobId,
    ...payload
  })
}

export async function copyTracksToRekordboxDesktopStorage(
  request: RekordboxDesktopCopyTracksToStorageRequest,
  options: CopyTracksOptions
): Promise<RekordboxDesktopCopyTracksToStorageResponse> {
  const targetRootDir = String(request.targetRootDir || '').trim()
  const tracks = Array.isArray(request.tracks)
    ? request.tracks.filter(
        (item): item is RekordboxDesktopPlaylistTrackInput =>
          !!item && typeof item.filePath === 'string' && item.filePath.trim().length > 0
      )
    : []

  if (!targetRootDir) {
    return buildFailureResponse('TRACK_FILE_MISSING', '缺少 Rekordbox 歌曲存放目录。')
  }
  if (tracks.length === 0) {
    return buildFailureResponse('NO_TRACKS', '没有可复制到 Rekordbox 目录的曲目。')
  }

  const copiedPaths: string[] = []
  try {
    await fs.ensureDir(targetRootDir)
    await reportProgress(options, {
      titleKey: 'tracks.copyingTracks',
      now: 0,
      total: tracks.length,
      isInitial: true
    })

    const copiedTracks: RekordboxDesktopPlaylistTrackInput[] = []
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index]
      const sourcePath = path.resolve(track.filePath)
      const fileName = path.basename(sourcePath)
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error(`源文件不存在：${sourcePath}`)
      }
      const copiedPath = await moveOrCopyItemWithCheckIsExist(
        sourcePath,
        path.join(targetRootDir, fileName),
        false
      )
      copiedPaths.push(copiedPath)
      copiedTracks.push({
        ...track,
        filePath: copiedPath
      })
      await reportProgress(options, {
        titleKey: 'tracks.copyingTracks',
        now: index + 1,
        total: tracks.length
      })
    }

    return {
      ok: true,
      summary: {
        targetRootDir,
        trackCount: copiedTracks.length,
        sourceFilePaths: tracks.map((item) => path.resolve(item.filePath)),
        copiedTracks
      }
    }
  } catch (error) {
    for (const copiedPath of copiedPaths) {
      try {
        await fs.remove(copiedPath)
      } catch {}
    }
    return buildFailureResponse(
      'TRACK_IMPORT_FAILED',
      error instanceof Error ? error.message : String(error || '复制歌曲到 Rekordbox 目录失败。'),
      {
        targetRootDir,
        copiedPaths
      }
    )
  }
}

export async function cleanupCopiedTracks(filePaths: string[]) {
  const normalized = Array.isArray(filePaths)
    ? Array.from(
        new Set(filePaths.filter((item) => typeof item === 'string' && item.trim().length > 0))
      )
    : []
  for (const filePath of normalized) {
    try {
      await fs.remove(filePath)
    } catch {}
  }
}
