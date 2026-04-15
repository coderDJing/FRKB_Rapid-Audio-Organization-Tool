import type { IPioneerPlaylistTrack } from '../../../types/globals'
import { enrichPioneerTracksWithCueData } from '../pioneerDeviceLibrary/cues'
import { requireRekordboxDesktopLibraryProbe } from './detect'
import { runRekordboxDesktopHelper } from './helper'
import type {
  RekordboxDesktopHelperTrackRecord,
  RekordboxDesktopHelperTracksPayload,
  RekordboxDesktopLibraryTrackLoadResult
} from './types'

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
