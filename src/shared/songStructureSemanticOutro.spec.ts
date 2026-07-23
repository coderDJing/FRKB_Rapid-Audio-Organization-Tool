import { describe, expect, it } from 'vitest'
import type { SongStructureSemanticRange } from './songStructureSemanticOutro'
import { refineTerminalOutroRanges } from './songStructureSemanticOutro'
import {
  SONG_STRUCTURE_SPECTRAL_VALUE_KEYS,
  type SongStructureSpectralBarFeature,
  type SongStructureSpectralValues
} from './songStructureSpectralFeatures'

const createValues = (
  overrides: Partial<SongStructureSpectralValues>
): SongStructureSpectralValues =>
  ({
    ...Object.fromEntries(SONG_STRUCTURE_SPECTRAL_VALUE_KEYS.map((key) => [key, 0])),
    ...overrides
  }) as SongStructureSpectralValues

const createBar = (
  index: number,
  normalized: Partial<SongStructureSpectralValues>,
  values: Partial<SongStructureSpectralValues>
): SongStructureSpectralBarFeature => ({
  index,
  startSec: index * 2,
  endSec: (index + 1) * 2,
  startBar: index + 1,
  phraseIndex: index,
  hasPeriodicStructurePrior: false,
  isClipBoundary: false,
  clipIndex: 0,
  normalized: createValues(normalized),
  values: createValues(values),
  pulseAttack: [],
  pulseHigh: [],
  localVector: [],
  recurrenceVector: []
})

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
  entryBoundaryScore: 0
})

const ACTIVE_NORMALIZED = {
  energy: 0.4,
  low: 0.4,
  mid: 0.4,
  high: 0.4,
  attackDensity: 0.4,
  density: 0.4
}
const ACTIVE_RAW = {
  energy: 0.7,
  low: 0.7,
  mid: 0.7,
  high: 0.7,
  attackDensity: 0.7,
  density: 0.7
}

describe('songStructureSemanticOutro', () => {
  it('识别低频基础仍在但上层编排持续退出的渐进 Outro', () => {
    const bars = Array.from({ length: 64 }, (_, index) =>
      createBar(index, ACTIVE_NORMALIZED, ACTIVE_RAW)
    )
    for (let index = 52; index < bars.length; index += 1) {
      bars[index] = createBar(
        index,
        {
          energy: 0.35,
          low: 0.38,
          mid: 0,
          high: -0.1,
          attackDensity: 0.35,
          density: 0.35
        },
        {
          energy: 0.68,
          low: 0.68,
          mid: 0.58,
          high: 0.55,
          attackDensity: 0.68,
          density: 0.68
        }
      )
    }

    const firstPass = refineTerminalOutroRanges(
      bars,
      [createRange(0, 60, 'drop'), createRange(60, 64, 'outro')],
      []
    )
    const secondPass = refineTerminalOutroRanges(bars, firstPass, [])

    expect(secondPass.at(-1)?.kind).toBe('outro')
    expect(secondPass.at(-1)?.startIndex).toBe(52)
  })

  it('广泛基础降能但没有细层退出形状时保留已有 Outro 边界', () => {
    const bars = Array.from({ length: 64 }, (_, index) =>
      createBar(index, ACTIVE_NORMALIZED, ACTIVE_RAW)
    )
    for (let index = 52; index < bars.length; index += 1) {
      bars[index] = createBar(
        index,
        {
          energy: 0.24,
          low: 0.24,
          mid: 0.24,
          high: 0.24,
          attackDensity: 0.24,
          density: 0.24
        },
        {
          energy: 0.62,
          low: 0.62,
          mid: 0.62,
          high: 0.62,
          attackDensity: 0.62,
          density: 0.62
        }
      )
    }

    const result = refineTerminalOutroRanges(
      bars,
      [createRange(0, 60, 'drop'), createRange(60, 64, 'outro')],
      []
    )

    expect(result.at(-1)?.startIndex).toBe(60)
  })

  it('后续块才发生主坍缩时不会把四块确认窗口的最左端当成 Outro 起点', () => {
    const bars = Array.from({ length: 64 }, (_, index) =>
      createBar(index, ACTIVE_NORMALIZED, ACTIVE_RAW)
    )
    for (let index = 52; index < 55; index += 1) {
      bars[index] = createBar(
        index,
        {
          energy: 0.32,
          low: 0.32,
          mid: 0.32,
          high: 0.32,
          attackDensity: 0.32,
          density: 0.32
        },
        {
          energy: 0.66,
          low: 0.66,
          mid: 0.66,
          high: 0.66,
          attackDensity: 0.66,
          density: 0.66
        }
      )
    }
    for (let index = 55; index < bars.length; index += 1) {
      bars[index] = createBar(
        index,
        {
          energy: -0.4,
          low: -0.4,
          mid: -0.4,
          high: -0.4,
          attackDensity: -0.4,
          density: -0.4
        },
        {
          energy: 0.3,
          low: 0.3,
          mid: 0.3,
          high: 0.3,
          attackDensity: 0.3,
          density: 0.3
        }
      )
    }

    const result = refineTerminalOutroRanges(
      bars,
      [createRange(0, 60, 'drop'), createRange(60, 64, 'outro')],
      []
    )

    expect(result.at(-1)?.startIndex).toBe(55)
  })

  it('主坍缩前的单块短降随后恢复时不把瞬时低点当成 Outro 起点', () => {
    const bars = Array.from({ length: 64 }, (_, index) =>
      createBar(index, ACTIVE_NORMALIZED, ACTIVE_RAW)
    )
    bars[52] = createBar(
      52,
      {
        energy: 0.1,
        low: 0.1,
        mid: 0.1,
        high: 0.1,
        attackDensity: 0.1,
        density: 0.1
      },
      {
        energy: 0.55,
        low: 0.55,
        mid: 0.55,
        high: 0.55,
        attackDensity: 0.55,
        density: 0.55
      }
    )
    for (let index = 55; index < bars.length; index += 1) {
      bars[index] = createBar(
        index,
        {
          energy: -0.4,
          low: -0.4,
          mid: -0.4,
          high: -0.4,
          attackDensity: -0.4,
          density: -0.4
        },
        {
          energy: 0.3,
          low: 0.3,
          mid: 0.3,
          high: 0.3,
          attackDensity: 0.3,
          density: 0.3
        }
      )
    }

    const result = refineTerminalOutroRanges(
      bars,
      [createRange(0, 60, 'drop'), createRange(60, 64, 'outro')],
      []
    )

    expect(result.at(-1)?.startIndex).toBe(55)
  })
})
