import { describe, expect, it } from 'vitest'
import { resolveSongStructureMacroActivityKinds } from './songStructureSemanticMacroActivity'
import type { SongStructureSpectralValues } from './songStructureSpectralFeatures'

const createValues = (
  overrides: Partial<SongStructureSpectralValues> = {}
): SongStructureSpectralValues => ({
  energy: 0,
  low: 0,
  mid: 0,
  high: 0,
  attack: 0,
  attackDensity: 0,
  density: 0,
  brightness: 0,
  crest: 0,
  lowShare: 0,
  midShare: 0,
  highShare: 0,
  ...overrides
})

const ACTIVE = createValues({
  energy: 0.45,
  low: 0.5,
  attackDensity: 0.42,
  density: 0.46
})
const VALLEY = createValues({
  energy: -0.55,
  low: -0.72,
  attackDensity: -0.62,
  density: -0.58
})

const createSegment = ({
  bars,
  normalized,
  entryRise = 0,
  relativeReduction = 0,
  groove = 0.65,
  breakdown = 0.4,
  drop = 0.45
}: {
  bars: number
  normalized: SongStructureSpectralValues
  entryRise?: number
  relativeReduction?: number
  groove?: number
  breakdown?: number
  drop?: number
}) => ({
  bars,
  normalized,
  entryRise,
  entryTimbre: 0.2,
  relativeReduction,
  scores: { groove, breakdown, drop, outro: 0.1 }
})

describe('songStructureSemanticMacroActivity', () => {
  it('局部鼓点恢复但宏观基础仍在低谷时保持 Breakdown', () => {
    const partialRecovery = createValues({
      energy: -0.25,
      low: -0.5,
      attackDensity: -0.38,
      density: -0.34
    })
    const segments = [
      createSegment({ bars: 16, normalized: ACTIVE, drop: 0.62 }),
      createSegment({
        bars: 10,
        normalized: VALLEY,
        relativeReduction: 0.64,
        breakdown: 0.66
      }),
      createSegment({ bars: 4, normalized: partialRecovery, relativeReduction: 0.28 }),
      createSegment({ bars: 12, normalized: partialRecovery, relativeReduction: 0.62 }),
      createSegment({ bars: 24, normalized: ACTIVE, entryRise: 0.3, drop: 0.64 })
    ]

    expect(
      resolveSongStructureMacroActivityKinds(segments, [
        'drop',
        'breakdown',
        'groove',
        'groove',
        'drop'
      ])
    ).toEqual(['drop', 'breakdown', 'breakdown', 'breakdown', 'drop'])
  })

  it('低谷后形成稳定恢复平台时保留独立 Groove', () => {
    const recoveredPlateau = createValues({
      energy: 0.05,
      low: 0.08,
      attackDensity: 0.02,
      density: 0.08
    })
    const segments = [
      createSegment({ bars: 24, normalized: ACTIVE, drop: 0.62 }),
      createSegment({
        bars: 8,
        normalized: VALLEY,
        relativeReduction: 0.65,
        breakdown: 0.66
      }),
      createSegment({ bars: 15, normalized: recoveredPlateau, relativeReduction: 0.25 }),
      createSegment({ bars: 30, normalized: ACTIVE, entryRise: 0.34, drop: 0.64 })
    ]

    expect(
      resolveSongStructureMacroActivityKinds(segments, ['drop', 'breakdown', 'groove', 'drop'])
    ).toEqual(['drop', 'breakdown', 'groove', 'drop'])
  })
})
