import { describe, expect, it } from 'vitest'
import { refineSongStructureSemanticBoundaryAlignment } from './songStructureSemanticBoundaryAlignment'
import type { SongStructureSemanticRange } from './songStructureSemanticOutro'
import {
  SONG_STRUCTURE_SPECTRAL_VALUE_KEYS,
  type SongStructureSpectralBarFeature,
  type SongStructureSpectralValues
} from './songStructureSpectralFeatures'

const createValues = (
  overrides: Partial<SongStructureSpectralValues> = {}
): SongStructureSpectralValues =>
  ({
    ...Object.fromEntries(SONG_STRUCTURE_SPECTRAL_VALUE_KEYS.map((key) => [key, 0])),
    ...overrides
  }) as SongStructureSpectralValues

const createBar = (
  index: number,
  normalized: Partial<SongStructureSpectralValues>
): SongStructureSpectralBarFeature => {
  const values = createValues(normalized)
  return {
    index,
    startSec: index * 2,
    endSec: (index + 1) * 2,
    startBar: index + 1,
    phraseIndex: index,
    hasPeriodicStructurePrior: true,
    isClipBoundary: false,
    clipIndex: 0,
    values,
    normalized: values,
    pulseAttack: [],
    pulseHigh: [],
    localVector: [],
    recurrenceVector: []
  }
}

const createRange = (
  startIndex: number,
  endIndex: number,
  kind: SongStructureSemanticRange['kind']
): SongStructureSemanticRange => ({
  startIndex,
  endIndex,
  kind,
  confidence: 0.7,
  clusterId: 0,
  entryBoundaryScore: 0.6
})

describe('songStructureSemanticBoundaryAlignment', () => {
  it('把 Build 前的孤立抽空块留给旧段落', () => {
    const bars = Array.from({ length: 12 }, (_, index) =>
      createBar(index, index < 4 ? { energy: 0.2, low: 0.25, mid: 0.1, high: 0.05 } : {})
    )
    bars[3] = createBar(3, { energy: 0.05, low: 0.1, mid: -0.1, high: -0.1 })
    bars[4] = createBar(4, { energy: -0.9, low: -0.7, mid: -0.8, high: -0.9 })
    bars[5] = createBar(5, { energy: -0.65, low: -0.6, mid: -0.3, high: -0.45 })
    bars[6] = createBar(6, { energy: -0.4, low: -0.55, mid: 0.05, high: -0.1 })
    bars[7] = createBar(7, { energy: -0.2, low: -0.5, mid: 0.25, high: 0.15 })

    const result = refineSongStructureSemanticBoundaryAlignment(bars, [
      createRange(0, 4, 'groove'),
      createRange(4, 12, 'build')
    ])

    expect(
      result.map(({ startIndex, endIndex, kind }) => ({ startIndex, endIndex, kind }))
    ).toEqual([
      { startIndex: 0, endIndex: 5, kind: 'groove' },
      { startIndex: 5, endIndex: 12, kind: 'build' }
    ])
  })

  it('把只有高频冲击但低频基础未落地的块留给 Build', () => {
    const bars = Array.from({ length: 14 }, (_, index) =>
      createBar(index, index < 8 ? { energy: -0.4, low: -0.5, high: 0.25 } : {})
    )
    bars[8] = createBar(8, {
      energy: 0.3,
      low: -0.35,
      mid: 0.95,
      high: 1,
      attackDensity: -0.4,
      density: 0.1
    })
    for (let index = 9; index < bars.length; index += 1) {
      bars[index] = createBar(index, {
        energy: 0.3,
        low: 0.3,
        mid: 0.45,
        high: 0.5,
        attackDensity: 0.25,
        density: 0.3
      })
    }

    const result = refineSongStructureSemanticBoundaryAlignment(bars, [
      createRange(0, 8, 'build'),
      createRange(8, 14, 'drop')
    ])

    expect(result[0]?.endIndex).toBe(9)
    expect(result[1]?.startIndex).toBe(9)
  })

  it('候选块已经低频落地时保留立即开始的 Drop', () => {
    const bars = Array.from({ length: 14 }, (_, index) =>
      createBar(
        index,
        index < 8
          ? { energy: -0.4, low: -0.5, high: 0.3, attackDensity: -0.6, density: -0.3 }
          : { energy: 0.35, low: 0.32, high: 0.45, attackDensity: 0.3, density: 0.35 }
      )
    )

    const result = refineSongStructureSemanticBoundaryAlignment(bars, [
      createRange(0, 8, 'build'),
      createRange(8, 14, 'drop')
    ])

    expect(result[0]?.endIndex).toBe(8)
    expect(result[1]?.startIndex).toBe(8)
  })

  it('候选块本身已具备持续张力时保留 Build 起点', () => {
    const bars = Array.from({ length: 12 }, (_, index) =>
      createBar(
        index,
        index < 4
          ? { energy: 0.2, low: 0.25, mid: 0.1, high: 0.05 }
          : { energy: -0.4, low: -0.55, mid: 0.3, high: 0.4 }
      )
    )

    const result = refineSongStructureSemanticBoundaryAlignment(bars, [
      createRange(0, 4, 'groove'),
      createRange(4, 12, 'build')
    ])

    expect(result[0]?.endIndex).toBe(4)
    expect(result[1]?.startIndex).toBe(4)
  })

  it('确认低活动平台后回溯到保留低频但先抽离高频层的 Breakdown 起点', () => {
    const bars = Array.from({ length: 16 }, (_, index) =>
      createBar(
        index,
        index < 7
          ? { energy: 0.2, low: 0.2, mid: 0.2, high: 0.3, attackDensity: 0.2, density: 0.2 }
          : { energy: -0.5, low: -0.5, mid: -0.5, high: -0.8, attackDensity: -0.5, density: -0.5 }
      )
    )
    bars[7] = createBar(7, {
      energy: 0.15,
      low: 0.2,
      mid: 0.1,
      high: -0.6,
      attackDensity: 0.1,
      density: 0.1
    })

    const result = refineSongStructureSemanticBoundaryAlignment(bars, [
      createRange(0, 8, 'groove'),
      createRange(8, 16, 'breakdown')
    ])

    expect(result[0]?.endIndex).toBe(7)
    expect(result[1]?.startIndex).toBe(7)
  })

  it('低频和总能量已经在候选前一块坍塌时不提前 Breakdown 边界', () => {
    const bars = Array.from({ length: 16 }, (_, index) =>
      createBar(
        index,
        index < 7
          ? { energy: 0.2, low: 0.2, mid: 0.2, high: 0.3, attackDensity: 0.2, density: 0.2 }
          : { energy: -0.5, low: -0.5, mid: -0.5, high: -0.6, attackDensity: -0.5, density: -0.5 }
      )
    )
    bars[7] = createBar(7, {
      energy: -0.4,
      low: -0.45,
      mid: -0.2,
      high: 0.2,
      attackDensity: -0.3,
      density: -0.4
    })

    const result = refineSongStructureSemanticBoundaryAlignment(bars, [
      createRange(0, 8, 'drop'),
      createRange(8, 16, 'breakdown')
    ])

    expect(result[0]?.endIndex).toBe(8)
    expect(result[1]?.startIndex).toBe(8)
  })
})
