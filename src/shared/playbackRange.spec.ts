import { describe, expect, it } from 'vitest'
import { CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION } from './songStructure'
import { resolvePlaybackRangeHandleVisual } from './playbackRange'

const createDropStructure = (durationSec = 60) => ({
  formatVersion: 1,
  algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  source: 'algorithmic',
  durationSec,
  bpm: 128,
  firstBeatMs: 0,
  barBeatOffset: 0,
  phraseBars: 8,
  sections: [
    {
      startSec: 0,
      endSec: 16,
      startBar: 1,
      endBar: 8,
      phraseIndex: 0,
      kind: 'intro',
      confidence: 0.7,
      energy: 0.4,
      low: 0.35,
      high: 0.3,
      novelty: 0.2
    },
    {
      startSec: 16,
      endSec: 48,
      startBar: 9,
      endBar: 24,
      phraseIndex: 1,
      kind: 'drop',
      confidence: 0.82,
      energy: 0.8,
      low: 0.86,
      high: 0.58,
      novelty: 0.72
    }
  ]
})

describe('resolvePlaybackRangeHandleVisual', () => {
  it('hides handles when range playback is disabled', () => {
    const visual = resolvePlaybackRangeHandleVisual(
      {
        enablePlaybackRange: false,
        playbackRangeMode: 'custom',
        startPlayPercent: 20,
        endPlayPercent: 80
      },
      null,
      60
    )
    expect(visual.visible).toBe(false)
    expect(visual.lockedRanges).toEqual([])
  })

  it('shows custom range handles at the configured percents', () => {
    const visual = resolvePlaybackRangeHandleVisual(
      {
        enablePlaybackRange: true,
        playbackRangeMode: 'custom',
        startPlayPercent: 20,
        endPlayPercent: 80
      },
      null,
      60
    )
    expect(visual).toMatchObject({
      visible: true,
      locked: false,
      startPercent: 20,
      endPercent: 80,
      lockedRanges: []
    })
  })

  it('shows locked section-range markers for matching sections', () => {
    const visual = resolvePlaybackRangeHandleVisual(
      {
        enablePlaybackRange: true,
        playbackRangeMode: 'section',
        playbackRangeSectionKinds: ['drop'],
        playbackRangeSectionMatchMode: 'all'
      },
      createDropStructure(80),
      80
    )
    expect(visual.visible).toBe(true)
    expect(visual.locked).toBe(true)
    expect(visual.lockedRanges).toEqual([
      {
        startPercent: 20,
        endPercent: 60
      }
    ])
  })
})
