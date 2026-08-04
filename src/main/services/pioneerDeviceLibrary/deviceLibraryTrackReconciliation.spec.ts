import { describe, expect, it } from 'vitest'
import { reconcileDeviceLibraryPlaylistTracks } from './deviceLibraryTrackReconciliation'
import type { PioneerPlaylistTrackLoadResult, PioneerPlaylistTrackRecordRaw } from './types'

const makeTrack = (
  entryIndex: number,
  trackId: number,
  playlistId = 121,
  filePath = `/Contents/${trackId}.mp3`
): PioneerPlaylistTrackRecordRaw => ({
  playlistId,
  trackId,
  entryIndex,
  title: `Track ${trackId}`,
  artist: '',
  album: '',
  label: '',
  genre: '',
  filePath,
  fileName: `${trackId}.mp3`,
  keyText: '',
  durationSec: 0,
  analyzePath: '',
  comment: '',
  dateAdded: '',
  artworkPath: ''
})

const makeResult = (
  tracks: PioneerPlaylistTrackRecordRaw[],
  overrides: Partial<PioneerPlaylistTrackLoadResult> = {}
): PioneerPlaylistTrackLoadResult => ({
  databasePath: 'F:/PIONEER/rekordbox/export.pdb',
  playlistId: 121,
  playlistName: '无标题列表 (3)',
  trackTotal: tracks.length,
  tracks,
  ...overrides
})

describe('reconcileDeviceLibraryPlaylistTracks', () => {
  it('uses a verified OneLibrary superset to restore missing Device Library entries', () => {
    const deviceLibrary = makeResult([makeTrack(12, 3209), makeTrack(13, 1113)])
    const oneLibrary = makeResult([makeTrack(13, 1113), makeTrack(1, 1083), makeTrack(12, 3209)], {
      databasePath: 'F:/PIONEER/rekordbox/exportLibrary.db'
    })

    const result = reconcileDeviceLibraryPlaylistTracks(deviceLibrary, oneLibrary)

    expect(result.applied).toBe(true)
    expect(result.result.databasePath).toBe(deviceLibrary.databasePath)
    expect(result.result.trackTotal).toBe(3)
    expect(result.result.tracks.map((track) => track.entryIndex)).toEqual([1, 12, 13])
  })

  it('keeps Device Library data when a shared entry points to a different track', () => {
    const deviceLibrary = makeResult([makeTrack(12, 3209)])
    const oneLibrary = makeResult([makeTrack(1, 1083), makeTrack(12, 9999)])

    const result = reconcileDeviceLibraryPlaylistTracks(deviceLibrary, oneLibrary)

    expect(result.applied).toBe(false)
    expect(result.result).toBe(deviceLibrary)
  })

  it('keeps Device Library data when the matching playlist has a different name', () => {
    const deviceLibrary = makeResult([makeTrack(12, 3209)])
    const oneLibrary = makeResult([makeTrack(1, 1083), makeTrack(12, 3209)], {
      playlistName: '另一个歌单'
    })

    const result = reconcileDeviceLibraryPlaylistTracks(deviceLibrary, oneLibrary)

    expect(result.applied).toBe(false)
    expect(result.result).toBe(deviceLibrary)
  })
})
