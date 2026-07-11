import { describe, expect, it } from 'vitest'
import { resolveSongStructureTimelineFirstBeatMs } from './songStructureCommon'

describe('resolveSongStructureTimelineFirstBeatMs', () => {
  it('converts a freshly analyzed audio-coordinate first beat to timeline coordinates', () => {
    expect(resolveSongStructureTimelineFirstBeatMs(100, undefined, 25.057)).toBe(125.057)
  })

  it('keeps an already cached timeline-coordinate first beat unchanged', () => {
    expect(resolveSongStructureTimelineFirstBeatMs(undefined, 125.057, 25.057)).toBe(125.057)
  })

  it('does not apply a negative or invalid offset', () => {
    expect(resolveSongStructureTimelineFirstBeatMs(100, undefined, -25)).toBe(100)
    expect(resolveSongStructureTimelineFirstBeatMs(100, undefined, 'invalid')).toBe(100)
  })

  it('returns undefined when neither first-beat source is usable', () => {
    expect(resolveSongStructureTimelineFirstBeatMs(undefined, undefined, 25.057)).toBeUndefined()
  })
})
