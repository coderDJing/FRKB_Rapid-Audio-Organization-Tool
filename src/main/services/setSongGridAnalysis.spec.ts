import { describe, expect, it } from 'vitest'
import type { ISongInfo } from '../../types/globals'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'
import { hasUsableCoreSongAnalysis } from '../../shared/songAnalysisCompleteness'
import { mergeSetSongGridAnalysis } from './setSongGridAnalysis'

const grid = createSongBeatGridMapV2FromFixedGrid({
  bpm: 128,
  firstBeatMs: 100,
  downbeatBeatOffset: 0,
  source: 'manual'
})!
const scannedSong = (): ISongInfo => ({
  filePath: 'D:/music/track.mp3',
  fileName: 'track.mp3',
  fileFormat: 'MP3',
  cover: null,
  title: 'Track',
  artist: 'Artist',
  album: undefined,
  genre: undefined,
  label: undefined,
  duration: '03:00',
  bitrate: 320,
  container: 'MPEG',
  key: '8A',
  energyScore: 70
})

describe('SET grid hydration from verified source cache', () => {
  it('restores the canonical grid that a file-array metadata scan cannot read', () => {
    const scanned = scannedSong()
    const restored = mergeSetSongGridAnalysis(scanned, {
      beatGridMap: grid,
      timeBasisOffsetMs: 25,
      beatGridAlgorithmVersion: 2
    })
    expect(restored.beatGridMap?.signature).toBe(grid.signature)
    expect(restored.timeBasisOffsetMs).toBe(25)
    expect(hasUsableCoreSongAnalysis(restored)).toBe(true)
    expect(scanned.beatGridMap).toBeUndefined()
  })

  it('preserves a valid no-bpm result instead of showing pending analysis', () => {
    const restored = mergeSetSongGridAnalysis(scannedSong(), { beatGridStatus: 'no-bpm' })
    expect(restored.beatGridStatus).toBe('no-bpm')
    expect(hasUsableCoreSongAnalysis(restored, { includeStructure: true })).toBe(true)
  })

  it('keeps an already valid target grid', () => {
    const target = { ...scannedSong(), beatGridMap: grid }
    expect(mergeSetSongGridAnalysis(target, { beatGridStatus: 'no-bpm' })).toBe(target)
  })

  it('does not invent a grid from a legacy scalar bpm or a grid-free snapshot', () => {
    const target = scannedSong()
    expect(mergeSetSongGridAnalysis(target, { bpm: 128, firstBeatMs: 100 })).toBe(target)
    expect(mergeSetSongGridAnalysis(target, { key: '8A', energyScore: 70 })).toBe(target)
    expect(hasUsableCoreSongAnalysis(target)).toBe(false)
  })
})
