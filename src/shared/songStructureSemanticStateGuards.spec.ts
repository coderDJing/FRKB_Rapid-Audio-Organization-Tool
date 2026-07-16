import { describe, expect, it } from 'vitest'
import type { SongStructureSectionKind } from './songStructureCommon'
import { refineSongStructureSemanticStateKinds } from './songStructureSemanticStateGuards'
import type { SongStructureSpectralValues } from './songStructureSpectralFeatures'

const createValues = (activity: number): SongStructureSpectralValues => ({
  energy: activity,
  low: activity,
  mid: activity,
  high: activity,
  attack: activity,
  attackDensity: activity,
  density: activity,
  brightness: activity,
  crest: activity,
  lowShare: activity,
  midShare: activity,
  highShare: activity
})

const createSegment = (
  startIndex: number,
  endIndex: number,
  activity: number,
  scores: { groove: number; breakdown: number; drop: number; outro: number },
  relativeReduction = 0
) => ({
  startIndex,
  endIndex,
  bars: endIndex - startIndex,
  normalized: createValues(activity),
  entryRise: 0,
  entryTimbre: 0,
  relativeReduction,
  scores
})

describe('songStructureSemanticStateGuards', () => {
  it('把首个主段前的早期低能 Breakdown 归入 Intro', () => {
    const segments = [
      createSegment(0, 8, -0.6, { groove: 0.2, breakdown: 0.4, drop: 0.1, outro: 0.1 }),
      createSegment(8, 16, -0.4, { groove: 0.3, breakdown: 0.6, drop: 0.2, outro: 0.1 }),
      createSegment(16, 80, 0.3, { groove: 0.55, breakdown: 0.2, drop: 0.6, outro: 0.1 })
    ]

    expect(refineSongStructureSemanticStateKinds(segments, ['intro', 'breakdown', 'drop'])).toEqual(
      ['intro', 'intro', 'drop']
    )
  })

  it('不会把高活动且语义不支持的周期性抽空保留为 Breakdown', () => {
    const segments = [
      createSegment(0, 16, 0.3, { groove: 0.55, breakdown: 0.2, drop: 0.6, outro: 0.1 }),
      createSegment(16, 24, -0.05, {
        groove: 0.58,
        breakdown: 0.46,
        drop: 0.47,
        outro: 0.34
      }),
      createSegment(24, 40, 0.3, { groove: 0.55, breakdown: 0.2, drop: 0.6, outro: 0.1 })
    ]
    const kinds: SongStructureSectionKind[] = ['drop', 'breakdown', 'drop']

    expect(refineSongStructureSemanticStateKinds(segments, kinds)).toEqual(kinds)
  })
})
