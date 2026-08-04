import openSetDurationDialog from '@renderer/components/setDurationDialog'
import { loadRekordboxPlaylistTracks } from '@renderer/composables/rekordboxDesktop/useRekordboxTrackLoader'
import type { RekordboxSourceKind, RekordboxSourceLibraryType } from '@shared/rekordboxSources'
import type { IPioneerPlaylistTrack, ISongInfo } from 'src/types/globals'

const toSongInfo = (track: IPioneerPlaylistTrack): ISongInfo => ({
  filePath: track.filePath,
  fileName: track.fileName,
  fileFormat: track.fileFormat,
  cover: null,
  title: track.title,
  artist: track.artist || undefined,
  album: track.album || undefined,
  duration: track.duration,
  genre: track.genre || undefined,
  label: track.label || undefined,
  bitrate: track.bitrate,
  container: track.container || undefined,
  key: track.key,
  bpm: track.bpm,
  playlistTrackNumber: track.entryIndex,
  hotCues: Array.isArray(track.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : [],
  memoryCues: Array.isArray(track.memoryCues) ? track.memoryCues.map((cue) => ({ ...cue })) : [],
  fileMissing: track.fileMissing ?? false
})

export const openSetDurationForRekordboxPlaylist = async ({
  sourceKind,
  playlistId,
  sourceRootPath,
  sourceLibraryType
}: {
  sourceKind: RekordboxSourceKind
  playlistId: number
  sourceRootPath?: string
  sourceLibraryType?: RekordboxSourceLibraryType | ''
}) => {
  if (!Number.isInteger(playlistId) || playlistId <= 0) return
  const result = await loadRekordboxPlaylistTracks({
    sourceKind,
    playlistId,
    sourceRootPath,
    sourceLibraryType
  })
  const songs = Array.isArray(result?.tracks) ? result.tracks.map(toSongInfo) : []
  await openSetDurationDialog(songs)
}
