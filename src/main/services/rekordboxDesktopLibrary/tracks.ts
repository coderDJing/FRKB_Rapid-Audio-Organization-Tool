import type { IPioneerPlaylistTrack } from '../../../types/globals'
import { enrichPioneerTracksWithCueData } from '../pioneerDeviceLibrary/cues'
import { requireRekordboxDesktopLibraryProbe } from './detect'
import { runRekordboxDesktopHelper } from './helper'
import { getLogPath, log } from '../../log'
import type {
  RekordboxDesktopHelperError,
  RekordboxDesktopHelperRemovePlaylistTracksPayload,
  RekordboxDesktopHelperTrackRecord,
  RekordboxDesktopHelperTracksPayload,
  RekordboxDesktopLibraryTrackLoadResult
} from './types'
import type {
  RekordboxDesktopRemovePlaylistTracksRequest,
  RekordboxDesktopRemovePlaylistTracksResponse
} from '../../../shared/rekordboxDesktopPlaylist'

const normalizeTrack = (
  track: RekordboxDesktopHelperTrackRecord | null | undefined
): IPioneerPlaylistTrack | null => {
  const rowKey = String(track?.rowKey || '').trim()
  const filePath = String(track?.filePath || '').trim()
  const playlistId = Number(track?.playlistId) || 0
  const trackId = Number(track?.trackId) || 0
  const entryIndex = Number(track?.entryIndex) || 0
  if (!rowKey || !filePath || !playlistId || !trackId) return null

  return {
    rowKey,
    playlistId,
    playlistName: String(track?.playlistName || '').trim(),
    trackId,
    entryIndex,
    title: String(track?.title || '').trim(),
    artist: String(track?.artist || '').trim(),
    album: String(track?.album || '').trim(),
    label: String(track?.label || '').trim(),
    genre: String(track?.genre || '').trim(),
    filePath,
    fileName: String(track?.fileName || '').trim(),
    fileFormat: String(track?.fileFormat || '').trim(),
    container: String(track?.container || '').trim(),
    duration: String(track?.duration || '').trim(),
    durationSec: Number(track?.durationSec) || 0,
    bpm: Number(track?.bpm) || undefined,
    key: String(track?.key || '').trim() || undefined,
    bitrate: Number(track?.bitrate) || undefined,
    sampleRate: Number(track?.sampleRate) || undefined,
    sampleDepth: Number(track?.sampleDepth) || undefined,
    trackNumber: Number(track?.trackNumber) || undefined,
    discNumber: Number(track?.discNumber) || undefined,
    year: Number(track?.year) || undefined,
    analyzePath: String(track?.analyzePath || '').trim() || undefined,
    comment: String(track?.comment || '').trim() || undefined,
    dateAdded: String(track?.dateAdded || '').trim() || undefined,
    artworkPath: String(track?.artworkPath || '').trim() || undefined,
    coverPath: String(track?.coverPath || '').trim() || undefined
  }
}

export async function loadRekordboxDesktopPlaylistTracks(
  playlistId: number
): Promise<RekordboxDesktopLibraryTrackLoadResult> {
  const probe = await requireRekordboxDesktopLibraryProbe()
  const safePlaylistId = Number(playlistId) || 0
  if (safePlaylistId <= 0) {
    throw new Error('playlistId 无效')
  }

  const payload = await runRekordboxDesktopHelper<
    RekordboxDesktopHelperTracksPayload,
    {
      dbPath: string
      dbDir: string
      playlistId: number
    }
  >('load-playlist-tracks', {
    dbPath: probe.dbPath,
    dbDir: probe.dbDir,
    playlistId: safePlaylistId
  })

  const tracks = Array.isArray(payload?.tracks)
    ? payload.tracks
        .map((track) => normalizeTrack(track))
        .filter((track): track is IPioneerPlaylistTrack => Boolean(track))
    : []

  const tracksWithCues = await enrichPioneerTracksWithCueData(probe.sourceRootPath, tracks)

  return {
    probe,
    playlistId: Number(payload?.playlistId) || safePlaylistId,
    playlistName: String(payload?.playlistName || '').trim(),
    trackTotal: Number(payload?.trackTotal) || tracksWithCues.length,
    tracks: tracksWithCues
  }
}

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) {
    const message = String(error.message || '').trim()
    return message || fallback
  }
  return String(error || fallback)
}

const getErrorCode = (error: unknown, fallback: string) => {
  const code = (error as RekordboxDesktopHelperError | null)?.code
  return typeof code === 'string' && code.trim() ? code.trim() : fallback
}

const buildRemoveTracksFailureResponse = (
  errorCode: string,
  errorMessage: string,
  details?: Record<string, unknown>
): RekordboxDesktopRemovePlaylistTracksResponse => {
  log.error('[rekordbox-desktop-playlist] remove playlist tracks failed', {
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

export async function removeRekordboxDesktopPlaylistTracks(
  request: RekordboxDesktopRemovePlaylistTracksRequest
): Promise<RekordboxDesktopRemovePlaylistTracksResponse> {
  const playlistId = Math.max(0, Number(request.playlistId) || 0)
  const rowKeys = Array.isArray(request.rowKeys)
    ? request.rowKeys.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  if (playlistId <= 0) {
    return buildRemoveTracksFailureResponse(
      'INVALID_PLAYLIST_ID',
      '目标 Rekordbox 播放列表无效。',
      { playlistId, rowKeys }
    )
  }
  if (rowKeys.length === 0) {
    return buildRemoveTracksFailureResponse(
      'PLAYLIST_TRACK_REMOVE_FAILED',
      '没有可移除的播放列表曲目。',
      { playlistId }
    )
  }

  let probe: Awaited<ReturnType<typeof requireRekordboxDesktopLibraryProbe>>
  try {
    probe = await requireRekordboxDesktopLibraryProbe()
  } catch (error) {
    return buildRemoveTracksFailureResponse(
      getErrorCode(error, 'REKORDBOX_DB_OPEN_FAILED'),
      getErrorMessage(error, '未检测到可写入的 Rekordbox 本机库。'),
      { playlistId, rowKeys }
    )
  }

  try {
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperRemovePlaylistTracksPayload,
      {
        dbPath: string
        dbDir: string
        playlistId: number
        rowKeys: string[]
      }
    >('remove-playlist-tracks', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      playlistId,
      rowKeys
    })

    return {
      ok: true,
      summary: {
        playlistId: Number(payload?.playlistId) || playlistId,
        requestedCount: Number(payload?.requestedCount) || rowKeys.length,
        removedCount: Number(payload?.removedCount) || 0,
        skippedCount: Number(payload?.skippedCount) || 0
      }
    }
  } catch (error) {
    return buildRemoveTracksFailureResponse(
      getErrorCode(error, 'PLAYLIST_TRACK_REMOVE_FAILED'),
      getErrorMessage(error, '从 Rekordbox 播放列表移除曲目失败。'),
      { playlistId, rowKeys, error }
    )
  }
}
