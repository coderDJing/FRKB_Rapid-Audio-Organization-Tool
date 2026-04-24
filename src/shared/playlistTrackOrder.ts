export const normalizePlaylistTrackNumber = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.floor(numeric)
  return rounded > 0 ? rounded : undefined
}

export const sortByPlaylistTrackNumber = <T extends { playlistTrackNumber?: unknown }>(
  tracks: readonly T[]
) =>
  tracks
    .map((track, index) => ({
      track,
      index,
      playlistTrackNumber: normalizePlaylistTrackNumber(track.playlistTrackNumber)
    }))
    .sort((left, right) => {
      if (
        left.playlistTrackNumber !== undefined &&
        right.playlistTrackNumber !== undefined &&
        left.playlistTrackNumber !== right.playlistTrackNumber
      ) {
        return left.playlistTrackNumber - right.playlistTrackNumber
      }
      if (left.playlistTrackNumber !== undefined && right.playlistTrackNumber === undefined) {
        return -1
      }
      if (left.playlistTrackNumber === undefined && right.playlistTrackNumber !== undefined) {
        return 1
      }
      return left.index - right.index
    })
    .map((item) => item.track)
