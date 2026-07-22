import { describe, expect, it } from 'vitest'
import { canPlayHtmlAudio } from './webAudioPlayer.shared'

describe('canPlayHtmlAudio', () => {
  it.each(['track.aif', 'track.aiff'])('routes %s through PCM playback', (filePath) => {
    expect(canPlayHtmlAudio(filePath)).toBe(false)
  })
})
