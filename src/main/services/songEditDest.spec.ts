import { describe, expect, it } from 'vitest'
import { resolveUniqueSongEditVersion } from './songEditDest'

describe('song edit dest versioning', () => {
  it('skips a version that already exists on disk even if the playlist title has no suffix', () => {
    const result = resolveUniqueSongEditVersion({
      baseTitle: 'Song',
      outputExt: 'mp3',
      existingNames: ['Song', 'Song'],
      diskFileNames: ['Song.mp3', 'Song (2).mp3']
    })
    expect(result.versionNumber).toBe(3)
    expect(result.destFileName).toBe('Song (3).mp3')
  })

  it('does not collide with a same-name file of the output extension', () => {
    const result = resolveUniqueSongEditVersion({
      baseTitle: 'Song',
      outputExt: 'wav',
      existingNames: ['Song (2)'],
      diskFileNames: ['Song (3).wav']
    })
    expect(result.destFileName).toBe('Song (4).wav')
  })
})
