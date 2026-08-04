import type { PioneerPlaylistTrackLoadResult, PioneerPlaylistTrackRecordRaw } from './types'

const normalizeText = (value: unknown) => String(value || '').trim()

const normalizeDevicePath = (value: unknown) =>
  normalizeText(value).replace(/\\/g, '/').toLocaleLowerCase()

const isPositiveInteger = (value: unknown) => Number.isInteger(value) && Number(value) > 0

const comparePlaylistEntries = (
  left: PioneerPlaylistTrackRecordRaw,
  right: PioneerPlaylistTrackRecordRaw
) => {
  if (left.entryIndex !== right.entryIndex || left.trackId !== right.trackId) return false

  const leftPath = normalizeDevicePath(left.filePath)
  const rightPath = normalizeDevicePath(right.filePath)
  return !leftPath || !rightPath || leftPath === rightPath
}

const entryKey = (track: PioneerPlaylistTrackRecordRaw) => `${track.entryIndex}:${track.trackId}`

const hasUniqueValidEntries = (tracks: PioneerPlaylistTrackRecordRaw[]) => {
  const keys = new Set<string>()
  for (const track of tracks) {
    if (!isPositiveInteger(track.entryIndex) || !isPositiveInteger(track.trackId)) return false
    const key = entryKey(track)
    if (keys.has(key)) return false
    keys.add(key)
  }
  return true
}

export type DeviceLibraryTrackReconciliation = {
  applied: boolean
  result: PioneerPlaylistTrackLoadResult
}

/**
 * Rekordbox 可能同时导出旧 Device Library PDB 和新版 OneLibrary。
 * 只有 OneLibrary 严格覆盖同一歌单的全部 PDB 有效条目且曲目更多时才接纳，避免把 PDB
 * 页堆中未被引用的残留字节误当成曲目复活。
 */
export const reconcileDeviceLibraryPlaylistTracks = (
  deviceLibrary: PioneerPlaylistTrackLoadResult,
  oneLibrary: PioneerPlaylistTrackLoadResult
): DeviceLibraryTrackReconciliation => {
  const deviceTracks = Array.isArray(deviceLibrary.tracks) ? deviceLibrary.tracks : []
  const oneLibraryTracks = Array.isArray(oneLibrary.tracks) ? oneLibrary.tracks : []
  const devicePlaylistName = normalizeText(deviceLibrary.playlistName)
  const oneLibraryPlaylistName = normalizeText(oneLibrary.playlistName)
  const samePlaylist =
    deviceLibrary.playlistId > 0 &&
    deviceLibrary.playlistId === oneLibrary.playlistId &&
    Boolean(devicePlaylistName) &&
    devicePlaylistName === oneLibraryPlaylistName

  if (
    !samePlaylist ||
    oneLibraryTracks.length <= deviceTracks.length ||
    !deviceTracks.length ||
    !hasUniqueValidEntries(deviceTracks) ||
    !hasUniqueValidEntries(oneLibraryTracks)
  ) {
    return { applied: false, result: deviceLibrary }
  }

  const oneLibraryByEntry = new Map(oneLibraryTracks.map((track) => [entryKey(track), track]))
  if (
    deviceTracks.some((track) => {
      const matchingTrack = oneLibraryByEntry.get(entryKey(track))
      return !matchingTrack || !comparePlaylistEntries(track, matchingTrack)
    })
  ) {
    return { applied: false, result: deviceLibrary }
  }

  const tracks = [...oneLibraryTracks].sort(
    (left, right) => left.entryIndex - right.entryIndex || left.trackId - right.trackId
  )

  return {
    applied: true,
    result: {
      ...deviceLibrary,
      trackTotal: tracks.length,
      tracks
    }
  }
}
