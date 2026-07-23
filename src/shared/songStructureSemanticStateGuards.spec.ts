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
  it('首次持续落地已与 Groove 竞争时结束位置先验造成的 Intro 延伸', () => {
    const segments = [
      createSegment(0, 8, -0.9, { groove: 0.3, breakdown: 0.4, drop: 0.1, outro: 0.1 }),
      createSegment(8, 13, -0.7, { groove: 0.5, breakdown: 0.4, drop: 0.2, outro: 0.1 }, 0.1),
      createSegment(13, 24, -0.55, {
        groove: 0.55,
        breakdown: 0.35,
        drop: 0.25,
        outro: 0.1
      })
    ]
    segments[1]!.entryRise = 0.1

    expect(refineSongStructureSemanticStateKinds(segments, ['intro', 'intro', 'groove'])).toEqual([
      'intro',
      'groove',
      'groove'
    ])
  })

  it('Build 前本地 Groove 明显占优的短段不会被拓扑模板伪装成 Breakdown', () => {
    const segments = [
      createSegment(0, 16, 0.1, { groove: 0.55, breakdown: 0.3, drop: 0.4, outro: 0.1 }),
      createSegment(16, 20, -0.6, { groove: 0.48, breakdown: 0.41, drop: 0.2, outro: 0.15 }, 0.09),
      createSegment(20, 28, -0.5, {
        groove: 0.3,
        breakdown: 0.48,
        drop: 0.2,
        outro: 0.1
      })
    ]

    expect(
      refineSongStructureSemanticStateKinds(segments, ['groove', 'breakdown', 'build'])
    ).toEqual(['groove', 'groove', 'build'])
  })

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

  it('先按本曲宏观活动平台区分较低 Groove 与真正 Breakdown', () => {
    const segments = [
      createSegment(0, 16, 0.3, { groove: 0.5, breakdown: 0.2, drop: 0.62, outro: 0.1 }),
      createSegment(16, 32, 0.05, { groove: 0.4, breakdown: 0.42, drop: 0.32, outro: 0.12 }, 0.24),
      createSegment(32, 40, -0.45, { groove: 0.47, breakdown: 0.46, drop: 0.3, outro: 0.15 }, 0.28),
      createSegment(40, 48, -0.5, {
        groove: 0.3,
        breakdown: 0.55,
        drop: 0.2,
        outro: 0.15
      }),
      createSegment(48, 64, 0.3, { groove: 0.5, breakdown: 0.2, drop: 0.62, outro: 0.1 })
    ]

    expect(
      refineSongStructureSemanticStateKinds(segments, [
        'drop',
        'breakdown',
        'groove',
        'build',
        'drop'
      ])
    ).toEqual(['drop', 'groove', 'breakdown', 'build', 'drop'])
  })
})
