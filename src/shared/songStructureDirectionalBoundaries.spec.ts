import { describe, expect, it } from 'vitest'
import {
  buildSongStructureDirectionalBoundaries,
  resolveSongStructureLandingSwitchTieMargin
} from './songStructureDirectionalBoundaries'
import type {
  SongStructureSpectralBarFeature,
  SongStructureSpectralValues
} from './songStructureSpectralFeatures'

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
  overrides: Partial<SongStructureSpectralValues> = {}
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
    localVector: Object.values(values),
    recurrenceVector: []
  }
}

const build = (bars: SongStructureSpectralBarFeature[]) =>
  buildSongStructureDirectionalBoundaries(bars, {
    boundaries: [
      { index: 0, score: 0 },
      { index: bars.length, score: 0 }
    ],
    clusterIds: bars.map(() => 0),
    clusterCount: 1
  })

describe('songStructureDirectionalBoundaries', () => {
  it('landing 与 switch 接近时使用有上限的相对容差，避免低分候选阈值悬崖', () => {
    expect(resolveSongStructureLandingSwitchTieMargin(0.1026)).toBeCloseTo(0.012312, 6)
    expect(resolveSongStructureLandingSwitchTieMargin(0.5)).toBe(0.02)
  })

  it('忽略单个 downbeat 的音色毛刺，但保留持续音色切换', () => {
    const bars = Array.from({ length: 28 }, (_, index) => createBar(index))
    bars[8] = createBar(8, {
      brightness: 0.82,
      high: 0.72,
      lowShare: 0.18,
      highShare: 0.62
    })
    for (let index = 18; index < bars.length; index += 1) {
      bars[index] = createBar(index, {
        brightness: 0.68,
        high: 0.56,
        lowShare: 0.26,
        highShare: 0.5
      })
    }

    const result = build(bars)
    const indexes = result.boundaries.map((boundary) => boundary.index)

    expect(indexes.some((index) => Math.abs(index - 8) <= 1)).toBe(false)
    expect(indexes).toContain(18)
  })

  it('强下降后的持续恢复在音色分接近时仍归类为 landing', () => {
    const bars = Array.from({ length: 24 }, (_, index) =>
      createBar(
        index,
        index >= 8 && index < 14
          ? {
              energy: 0.25,
              low: 0.2,
              attackDensity: 0.18,
              density: 0.22,
              brightness: 0.52,
              lowShare: 0.24,
              highShare: 0.48
            }
          : {}
      )
    )

    const result = build(bars)
    const recovery = result.events.find((event) => event.index === 14)

    expect(recovery?.kind).toBe('landing')
    expect(result.boundaries.some((boundary) => boundary.index === 14)).toBe(true)
  })

  it('多步持续下降选择稳定低谷入口，而不是第一步瞬时下降', () => {
    const bars = Array.from({ length: 24 }, (_, index) => {
      if (index < 8) return createBar(index, { energy: 0.82, low: 0.86, density: 0.8 })
      if (index < 10) return createBar(index, { energy: 0.58, low: 0.62, density: 0.56 })
      return createBar(index, { energy: 0.34, low: 0.36, density: 0.32 })
    })

    const result = build(bars)
    const indexes = result.boundaries.map((boundary) => boundary.index)

    expect(indexes).toContain(10)
    expect(indexes).not.toContain(8)
  })
})
