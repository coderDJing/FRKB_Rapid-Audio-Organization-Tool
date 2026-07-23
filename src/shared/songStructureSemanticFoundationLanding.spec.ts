import { describe, expect, it } from 'vitest'
import { refineFoundationLandingBuildRanges } from './songStructureSemanticFoundationLanding'
import type { SongStructureSemanticRange } from './songStructureSemanticOutro'
import type { SongStructureSpectralBoundary } from './songStructureSpectralClustering'
import type {
  SongStructureSpectralBarFeature,
  SongStructureSpectralValues
} from './songStructureSpectralFeatures'

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

const createBar = (
  index: number,
  normalized: SongStructureSpectralValues
): SongStructureSpectralBarFeature => ({
  index,
  startSec: index * 2,
  endSec: (index + 1) * 2,
  startBar: index + 1,
  phraseIndex: Math.floor(index / 8),
  hasPeriodicStructurePrior: index % 8 === 0,
  isClipBoundary: false,
  clipIndex: 0,
  values: createValues(
    Object.fromEntries(
      Object.entries(normalized).map(([key, value]) => [key, value * 0.5 + 0.5])
    ) as Partial<SongStructureSpectralValues>
  ),
  normalized,
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
  confidence: 0.65,
  clusterId: 1,
  entryBoundaryScore: 0.4
})

const createBoundary = (index: number, score = 0.5): SongStructureSpectralBoundary => ({
  index,
  score,
  buildRamp: 0
})

const DROP = createValues({
  energy: 0.25,
  low: 0.18,
  mid: 0,
  high: -0.08,
  attackDensity: 0.18,
  density: 0.22
})
const BUILD = createValues({
  energy: 0.05,
  low: -0.34,
  mid: 0.2,
  high: 0.32,
  attackDensity: -0.05,
  density: 0.08
})
const BREAKDOWN = createValues({
  energy: -0.5,
  low: -0.6,
  mid: -0.2,
  high: -0.2,
  attackDensity: -0.45,
  density: -0.5
})

describe('低频落地与长 Build 精修', () => {
  it('把低频未落地的假 Drop 延长为 Build，并在真实低频落地点开始 Drop', () => {
    const bars = Array.from({ length: 100 }, (_, index) =>
      createBar(index, index < 16 ? DROP : index < 21 ? BREAKDOWN : index < 72 ? BUILD : DROP)
    )
    const ranges = [
      createRange(0, 16, 'groove'),
      createRange(16, 32, 'build'),
      createRange(32, 72, 'drop'),
      createRange(72, 100, 'groove')
    ]

    expect(
      refineFoundationLandingBuildRanges(bars, ranges, [
        createBoundary(16, 0.55),
        createBoundary(21, 0.36),
        createBoundary(72)
      ])
    ).toMatchObject([
      { startIndex: 0, endIndex: 16, kind: 'groove' },
      { startIndex: 16, endIndex: 21, kind: 'breakdown' },
      { startIndex: 21, endIndex: 72, kind: 'build' },
      { startIndex: 72, endIndex: 100, kind: 'drop' }
    ])
  })

  it('支持 Drop 直接进入长 Build，再在低频落地点恢复 Drop', () => {
    const bars = Array.from({ length: 144 }, (_, index) =>
      createBar(index, index >= 97 && index < 120 ? BUILD : DROP)
    )
    const ranges = [
      createRange(0, 112, 'drop'),
      createRange(112, 116, 'breakdown'),
      createRange(116, 144, 'drop')
    ]

    expect(
      refineFoundationLandingBuildRanges(bars, ranges, [
        createBoundary(97, 0.44),
        createBoundary(120, 0.46)
      ])
    ).toMatchObject([
      { startIndex: 0, endIndex: 97, kind: 'drop' },
      { startIndex: 97, endIndex: 120, kind: 'build' },
      { startIndex: 120, endIndex: 144, kind: 'drop' }
    ])
  })

  it('宏观边界偏晚时回溯到低频持续抽离的第一个四拍块', () => {
    const bars = Array.from({ length: 144 }, (_, index) =>
      createBar(index, index >= 96 && index < 120 ? BUILD : DROP)
    )
    const ranges = [
      createRange(0, 112, 'drop'),
      createRange(112, 116, 'breakdown'),
      createRange(116, 144, 'drop')
    ]

    expect(
      refineFoundationLandingBuildRanges(bars, ranges, [
        createBoundary(97, 0.44),
        createBoundary(120, 0.46)
      ])
    ).toMatchObject([
      { startIndex: 0, endIndex: 96, kind: 'drop' },
      { startIndex: 96, endIndex: 120, kind: 'build' },
      { startIndex: 120, endIndex: 144, kind: 'drop' }
    ])
  })

  it('单块瞬时抽离不会把直接 Build 起点错误前移', () => {
    const bars = Array.from({ length: 144 }, (_, index) => {
      if (index === 95 || (index >= 97 && index < 120)) return createBar(index, BUILD)
      return createBar(index, DROP)
    })
    const ranges = [
      createRange(0, 112, 'drop'),
      createRange(112, 116, 'breakdown'),
      createRange(116, 144, 'drop')
    ]

    expect(
      refineFoundationLandingBuildRanges(bars, ranges, [
        createBoundary(97, 0.44),
        createBoundary(120, 0.46)
      ])
    ).toMatchObject([
      { startIndex: 0, endIndex: 97, kind: 'drop' },
      { startIndex: 97, endIndex: 120, kind: 'build' },
      { startIndex: 120, endIndex: 144, kind: 'drop' }
    ])
  })

  it('只有高频和密度上升、低频没有落地时不制造 Drop', () => {
    const highOnly = createValues({
      energy: 0.2,
      low: -0.38,
      mid: 0.28,
      high: 0.55,
      attackDensity: 0.25,
      density: 0.3
    })
    const bars = Array.from({ length: 64 }, (_, index) =>
      createBar(index, index < 32 ? BUILD : highOnly)
    )
    const ranges = [createRange(0, 32, 'build'), createRange(32, 64, 'drop')]

    expect(refineFoundationLandingBuildRanges(bars, ranges, [createBoundary(32, 0.55)])).toEqual(
      ranges
    )
  })

  it('候选 Build 中间已有完整 Drop 时不跨段吞并', () => {
    const bars = Array.from({ length: 144 }, (_, index) => {
      if (index < 72 || (index >= 80 && index < 96) || index >= 120) {
        return createBar(index, DROP)
      }
      return createBar(index, BUILD)
    })
    const ranges = [
      createRange(0, 72, 'drop'),
      createRange(72, 80, 'breakdown'),
      createRange(80, 96, 'drop'),
      createRange(96, 120, 'breakdown'),
      createRange(120, 144, 'drop')
    ]

    expect(
      refineFoundationLandingBuildRanges(bars, ranges, [
        createBoundary(72, 0.44),
        createBoundary(120, 0.46)
      ])
    ).toEqual(ranges)
  })

  it('较早 Build 结束处已有落地和完整 Active 重入时，不把后续低谷一起抹成长 Build', () => {
    const bars = Array.from({ length: 96 }, (_, index) => {
      if (index < 22 || (index >= 38 && index < 46) || index >= 72) {
        return createBar(index, DROP)
      }
      return createBar(index, BUILD)
    })
    const ranges = [
      createRange(0, 22, 'drop'),
      createRange(22, 38, 'build'),
      createRange(38, 46, 'drop'),
      createRange(46, 72, 'breakdown'),
      createRange(72, 96, 'drop')
    ]

    expect(
      refineFoundationLandingBuildRanges(bars, ranges, [
        createBoundary(38, 0.46),
        createBoundary(72, 0.46)
      ])
    ).toEqual(ranges)
  })

  it('直接 Build 回溯不会吞并已经完成的前置 Breakdown', () => {
    const bars = Array.from({ length: 40 }, (_, index) =>
      createBar(index, index >= 16 && index < 28 ? BUILD : DROP)
    )
    const ranges = [
      createRange(0, 16, 'groove'),
      createRange(16, 20, 'breakdown'),
      createRange(20, 28, 'build'),
      createRange(28, 40, 'drop')
    ]

    expect(
      refineFoundationLandingBuildRanges(bars, ranges, [
        createBoundary(16, 0.44),
        createBoundary(28, 0.46)
      ])
    ).toEqual(ranges)
  })
})
