import { describe, expect, it } from 'vitest'
import { shouldEnqueuePlayingAnalysis } from './playingQueuePolicy'

describe('playing analysis queue policy', () => {
  it('skips creating a new job when playback only promotes queued tracks', () => {
    expect(shouldEnqueuePlayingAnalysis(true, false)).toBe(false)
  })

  it('keeps the current immediate-analysis path for tracks already in queue', () => {
    expect(shouldEnqueuePlayingAnalysis(true, true)).toBe(true)
  })

  it('still enqueues immediately when onlyIfQueued is not set', () => {
    expect(shouldEnqueuePlayingAnalysis(undefined, false)).toBe(true)
    expect(shouldEnqueuePlayingAnalysis(false, false)).toBe(true)
  })
})
