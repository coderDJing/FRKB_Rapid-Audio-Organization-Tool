import { describe, expect, it } from 'vitest'
import { resolveCoverPathIdentity } from './coverPathIdentity'

describe('resolveCoverPathIdentity', () => {
  it('treats Windows path casing and separators as the same identity', () => {
    const cachedPath = 'C:\\Users\\tester\\FRKB_Data\\library\\filterlibrary\\songlist3\\track.mp3'
    const scannedPath = 'C:/Users/tester/FRKB_Data/library/FilterLibrary/songlist3/Track.mp3'

    expect(resolveCoverPathIdentity(cachedPath, 'win32')).toBe(
      resolveCoverPathIdentity(scannedPath, 'win32')
    )
  })

  it('preserves path casing on non-Windows platforms', () => {
    expect(resolveCoverPathIdentity('/Music/Track.mp3', 'darwin')).not.toBe(
      resolveCoverPathIdentity('/Music/track.mp3', 'darwin')
    )
  })

  it('trims surrounding whitespace', () => {
    expect(resolveCoverPathIdentity('  C:\\Music\\Track.mp3  ', 'win32')).toBe(
      'c:\\music\\track.mp3'
    )
  })
})
