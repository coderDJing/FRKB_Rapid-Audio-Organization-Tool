import { describe, expect, it } from 'vitest'
import type {
  SongStructureSpectralBarFeature,
  SongStructureSpectralValues
} from './songStructureSpectralFeatures'
import {
  resolveSongStructureDiscriminativeBoundaryEvidence,
  resolveSongStructureSoftMotifRepetition
} from './songStructureStructuralEvidence'

const createValues = (overrides: Partial<SongStructureSpectralValues> = {}) => ({
  energy: 0.55,
  low: 0.58,
  mid: 0.42,
  high: 0.28,
  attack: 0.48,
  attackDensity: 0.5,
  density: 0.56,
  brightness: 0.34,
  crest: 0.3,
  lowShare: 0.46,
  midShare: 0.34,
  highShare: 0.2,
  ...overrides
})

const createBar = (
  index: number,
  overrides: Partial<SongStructureSpectralValues> = {},
  motif = 0
): SongStructureSpectralBarFeature => {
  const values = createValues(overrides)
  return {
    index,
    startSec: index * 2,
    endSec: (index + 1) * 2,
    startBar: index + 1,
    phraseIndex: 0,
    hasPeriodicStructurePrior: false,
    isClipBoundary: false,
    clipIndex: 0,
    values,
    normalized: { ...values },
    pulseAttack: [],
    pulseHigh: [],
    localVector: [...Object.values(values), motif],
    recurrenceVector: [values.low, values.mid, values.attackDensity, values.density, motif]
  }
}

describe('songStructureStructuralEvidence', () => {
  it('持续多变量编曲变化产生强边界，单个四拍毛刺不会得到同等分数', () => {
    const sustained = Array.from({ length: 24 }, (_, index) =>
      createBar(
        index,
        index >= 12
          ? {
              mid: 0.72,
              attackDensity: 0.75,
              density: 0.4,
              crest: 0.62,
              midShare: 0.56,
              lowShare: 0.28
            }
          : {},
        index >= 12 ? 0.9 : 0.1
      )
    )
    const glitch = Array.from({ length: 24 }, (_, index) =>
      createBar(
        index,
        index === 12
          ? {
              mid: 0.72,
              attackDensity: 0.75,
              density: 0.4,
              crest: 0.62,
              midShare: 0.56,
              lowShare: 0.28
            }
          : {},
        index === 12 ? 0.9 : 0.1
      )
    )

    const sustainedEvidence = resolveSongStructureDiscriminativeBoundaryEvidence(sustained, 12)
    const glitchEvidence = resolveSongStructureDiscriminativeBoundaryEvidence(glitch, 12)

    expect(sustainedEvidence.persistence).toBeGreaterThan(0.7)
    expect(sustainedEvidence.score).toBeGreaterThan(glitchEvidence.score + 0.18)
  })

  it('编曲略有变化的远端重复段仍得到软 motif 重复证据', () => {
    const bars = [
      ...Array.from({ length: 8 }, (_, index) => createBar(index, {}, 0.15)),
      ...Array.from({ length: 8 }, (_, index) =>
        createBar(index + 8, { low: 0.24, density: 0.3 }, 0.75)
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        createBar(index + 16, { high: 0.34, attackDensity: 0.58 }, 0.18)
      )
    ]
    const repetition = resolveSongStructureSoftMotifRepetition(bars, [
      { startIndex: 0, endIndex: 8, clusterId: 1 },
      { startIndex: 8, endIndex: 16, clusterId: 2 },
      { startIndex: 16, endIndex: 24, clusterId: 3 }
    ])

    expect(repetition[0]).toBeGreaterThan(0.45)
    expect(repetition[2]).toBeGreaterThan(0.45)
    expect(repetition[1]).toBeLessThan(repetition[0]!)
  })
})
