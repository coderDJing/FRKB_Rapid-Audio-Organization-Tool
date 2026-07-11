import { describe, expect, it } from 'vitest'
import { refineContextualBuildRanges } from './songStructureSemanticBuild'
import { refineInactiveDropValleyRanges } from './songStructureSemanticInactiveValley'
import { repairOversizedActiveRanges } from './songStructureSemanticLabels'
import type { SongStructureSpectralBoundary } from './songStructureSpectralClustering'
import {
  refineTerminalOutroRanges,
  type SongStructureSemanticRange
} from './songStructureSemanticOutro'
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

const toRawValues = (normalized: SongStructureSpectralValues) =>
  createValues(
    Object.fromEntries(
      Object.entries(normalized).map(([key, value]) => [
        key,
        Math.max(0, Math.min(1, value * 0.5 + 0.5))
      ])
    ) as Partial<SongStructureSpectralValues>
  )

const createBar = (
  index: number,
  normalized: SongStructureSpectralValues
): SongStructureSpectralBarFeature => ({
  index,
  startSec: index * 2,
  endSec: (index + 1) * 2,
  startBar: index + 1,
  phraseIndex: Math.floor(index / 8),
  isPhraseBoundary: index % 8 === 0,
  isClipBoundary: false,
  clipIndex: 0,
  values: toRawValues(normalized),
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
  confidence: 0.7,
  clusterId: 1,
  entryBoundaryScore: 0.4
})

const createBreakdownValues = () =>
  createValues({
    energy: -0.5,
    low: -0.82,
    mid: 0.05,
    high: 0.02,
    attackDensity: -0.78,
    density: -0.58
  })

const createDropValues = () =>
  createValues({
    energy: 0.34,
    low: 0.42,
    mid: 0.12,
    high: 0.1,
    attackDensity: 0.32,
    density: 0.36
  })

const createInactiveValleyValues = () =>
  createValues({
    energy: -0.34,
    low: -0.48,
    mid: -0.04,
    high: 0.02,
    attackDensity: -0.38,
    density: -0.3
  })

const createPartialFoundationRecoveryValues = () =>
  createValues({
    energy: -0.08,
    low: -0.18,
    mid: 0.04,
    high: 0.08,
    attackDensity: -0.14,
    density: -0.08
  })

const createBuildEpisodeValues = (index: number, startIndex: number) => {
  const progress = Math.max(0, Math.min(1, (index - startIndex) / 12))
  if (index >= startIndex + 12) {
    return createValues({
      energy: -0.78,
      low: -1,
      mid: 0.68,
      high: 0.9,
      attackDensity: -1,
      density: -0.62
    })
  }
  return createValues({
    energy: -0.48 + progress * 0.48,
    low: -0.82 + progress * 0.2,
    mid: 0.08 + progress * 0.65,
    high: 0.04 + progress * 0.82,
    attackDensity: -0.76 + progress * 0.72,
    density: -0.56 + progress * 0.52
  })
}

const createShortBuildEpisodeValues = (index: number, startIndex: number) => {
  const progress = Math.max(0, Math.min(1, (index - startIndex) / 7))
  return createValues({
    energy: -0.48 + progress * 0.42,
    low: -0.82 + progress * 0.12,
    mid: 0.08 + progress * 0.68,
    high: 0.04 + progress * 0.86,
    attackDensity: -0.76 + progress * 0.7,
    density: -0.56 + progress * 0.58
  })
}

describe('歌曲结构语义范围精修', () => {
  it('超过整曲一半的单个 Drop 会按内部谱边界重新切分，而不是改名返回', () => {
    const bars = Array.from({ length: 64 }, (_, index) => createBar(index, createDropValues()))
    const ranges = [createRange(0, 33, 'drop'), createRange(33, 64, 'outro')]
    const boundaries: SongStructureSpectralBoundary[] = [{ index: 16, score: 0.8 }]

    expect(repairOversizedActiveRanges(bars, boundaries, ranges)).toMatchObject([
      { startIndex: 0, endIndex: 16, kind: 'drop' },
      { startIndex: 16, endIndex: 33, kind: 'drop' },
      { startIndex: 33, endIndex: 64, kind: 'outro' }
    ])
  })

  it('超过整曲一半的单个 Groove 同样会被重新切分', () => {
    const bars = Array.from({ length: 64 }, (_, index) => createBar(index, createDropValues()))
    const ranges = [createRange(0, 33, 'groove'), createRange(33, 64, 'outro')]
    const boundaries: SongStructureSpectralBoundary[] = [{ index: 16, score: 0.8 }]

    expect(repairOversizedActiveRanges(bars, boundaries, ranges)).toMatchObject([
      { startIndex: 0, endIndex: 16, kind: 'groove' },
      { startIndex: 16, endIndex: 33, kind: 'groove' },
      { startIndex: 33, endIndex: 64, kind: 'outro' }
    ])
  })

  it('能从连续 Drop 中找出被初始 Groove 标签掩盖的长低谷', () => {
    const bars = Array.from({ length: 64 }, (_, index) => {
      if (index < 16 || index >= 40) return createBar(index, createDropValues())
      if (index < 24) return createBar(index, createInactiveValleyValues())
      return createBar(index, createPartialFoundationRecoveryValues())
    })
    const ranges = [createRange(0, 64, 'drop')]

    expect(refineInactiveDropValleyRanges(bars, ranges)).toMatchObject([
      { startIndex: 0, endIndex: 16, kind: 'drop' },
      { startIndex: 16, endIndex: 40, kind: 'breakdown' },
      { startIndex: 40, endIndex: 64, kind: 'drop' }
    ])
  })

  it('能从超长 Groove 中恢复低谷后的 Drop 宏观状态', () => {
    const bars = Array.from({ length: 80 }, (_, index) => {
      if (index < 16 || index >= 48) return createBar(index, createDropValues())
      if (index < 32) return createBar(index, createInactiveValleyValues())
      return createBar(index, createPartialFoundationRecoveryValues())
    })
    const ranges = [createRange(0, 80, 'groove')]

    expect(refineInactiveDropValleyRanges(bars, ranges)).toMatchObject([
      { startIndex: 0, endIndex: 16, kind: 'groove' },
      { startIndex: 16, endIndex: 48, kind: 'breakdown' },
      { startIndex: 48, endIndex: 80, kind: 'drop' }
    ])
  })

  it('Drop 内只有一次 4-bar 抽空时不会切出 Breakdown', () => {
    const bars = Array.from({ length: 48 }, (_, index) =>
      createBar(
        index,
        index >= 16 && index < 20 ? createInactiveValleyValues() : createDropValues()
      )
    )
    const ranges = [createRange(0, 48, 'drop')]

    expect(refineInactiveDropValleyRanges(bars, ranges)).toEqual(ranges)
  })

  it('能从长 Breakdown 后半段补出固定 16-bar Build', () => {
    const bars = Array.from({ length: 72 }, (_, index) => {
      if (index < 16) return createBar(index, createDropValues())
      if (index < 24) return createBar(index, createBreakdownValues())
      if (index < 40) return createBar(index, createBuildEpisodeValues(index, 24))
      return createBar(index, createDropValues())
    })
    const ranges = [
      createRange(0, 16, 'groove'),
      createRange(16, 40, 'breakdown'),
      createRange(40, 72, 'drop')
    ]

    expect(refineContextualBuildRanges(bars, ranges, [40])).toMatchObject([
      { startIndex: 0, endIndex: 16, kind: 'groove' },
      { startIndex: 16, endIndex: 24, kind: 'breakdown' },
      { startIndex: 24, endIndex: 40, kind: 'build' },
      { startIndex: 40, endIndex: 72, kind: 'drop' }
    ])
  })

  it('16-bar 上升证据不足时能识别最后 8-bar Build', () => {
    const bars = Array.from({ length: 72 }, (_, index) => {
      if (index < 16) return createBar(index, createDropValues())
      if (index < 24) return createBar(index, createBreakdownValues())
      if (index < 32) return createBar(index, createPartialFoundationRecoveryValues())
      if (index < 40) return createBar(index, createShortBuildEpisodeValues(index, 32))
      return createBar(index, createDropValues())
    })
    const ranges = [
      createRange(0, 16, 'groove'),
      createRange(16, 40, 'breakdown'),
      createRange(40, 72, 'drop')
    ]

    expect(refineContextualBuildRanges(bars, ranges, [40])).toMatchObject([
      { startIndex: 0, endIndex: 16, kind: 'groove' },
      { startIndex: 16, endIndex: 32, kind: 'breakdown' },
      { startIndex: 32, endIndex: 40, kind: 'build' },
      { startIndex: 40, endIndex: 72, kind: 'drop' }
    ])
  })

  it('能把被前一个 Drop 状态吞掉的 Build 与真正重入点重新切开', () => {
    const bars = Array.from({ length: 80 }, (_, index) => {
      if (index < 16) return createBar(index, createDropValues())
      if (index < 32) return createBar(index, createBreakdownValues())
      if (index < 48) return createBar(index, createBuildEpisodeValues(index, 32))
      return createBar(index, createDropValues())
    })
    const ranges = [
      createRange(0, 16, 'groove'),
      createRange(16, 32, 'breakdown'),
      createRange(32, 80, 'drop')
    ]

    expect(refineContextualBuildRanges(bars, ranges, [32, 48])).toMatchObject([
      { startIndex: 0, endIndex: 16, kind: 'groove' },
      { startIndex: 16, endIndex: 32, kind: 'breakdown' },
      { startIndex: 32, endIndex: 48, kind: 'build' },
      { startIndex: 48, endIndex: 80, kind: 'drop' }
    ])
  })

  it('Breakdown 后突然重击时不会凭空制造 Build', () => {
    const bars = Array.from({ length: 64 }, (_, index) =>
      createBar(index, index < 40 ? createBreakdownValues() : createDropValues())
    )
    const ranges = [createRange(0, 40, 'breakdown'), createRange(40, 64, 'drop')]

    expect(refineContextualBuildRanges(bars, ranges, [40])).toEqual(ranges)
  })

  it('Breakdown 后的中等活跃 Groove 过渡不会被硬改成 Build', () => {
    const transition = createValues({
      energy: -0.08,
      low: -0.14,
      mid: -0.1,
      high: -0.08,
      attackDensity: -0.28,
      density: -0.12
    })
    const bars = Array.from({ length: 72 }, (_, index) => {
      if (index < 24) return createBar(index, createBreakdownValues())
      if (index < 40) return createBar(index, transition)
      return createBar(index, createDropValues())
    })
    const ranges = [
      createRange(0, 24, 'breakdown'),
      createRange(24, 40, 'groove'),
      createRange(40, 72, 'drop')
    ]

    expect(refineContextualBuildRanges(bars, ranges, [40])).toEqual(ranges)
  })

  it('终局低档平台中的周期重音不会阻止 Outro 向前修正', () => {
    const active = createValues({
      energy: 0.42,
      low: 0.44,
      mid: 0.3,
      high: 0.2,
      attackDensity: 0.34,
      density: 0.42
    })
    const terminalAccent = createValues({
      energy: 0.08,
      low: 0.08,
      mid: -0.12,
      high: -0.14,
      attackDensity: 0.1,
      density: 0.02
    })
    const terminalLow = createValues({
      energy: -0.18,
      low: -0.22,
      mid: -0.18,
      high: -0.2,
      attackDensity: -0.16,
      density: -0.2
    })
    const bars = Array.from({ length: 64 }, (_, index) =>
      createBar(index, index < 40 ? active : index % 8 < 4 ? terminalAccent : terminalLow)
    )
    const ranges = [createRange(0, 60, 'drop'), createRange(60, 64, 'outro')]

    expect(refineTerminalOutroRanges(bars, ranges, [48, 56])).toMatchObject([
      { startIndex: 0, endIndex: 40, kind: 'drop' },
      { startIndex: 40, endIndex: 64, kind: 'outro' }
    ])
  })

  it('较弱的终局释放需由下一 phrase 继续下降后再确认 Outro', () => {
    const active = createValues({
      energy: 0.42,
      low: 0.44,
      mid: 0.3,
      high: 0.2,
      attackDensity: 0.34,
      density: 0.42
    })
    const firstRelease = createValues({
      energy: 0.3,
      low: 0.3,
      mid: 0.18,
      high: 0.12,
      attackDensity: 0.25,
      density: 0.28
    })
    const confirmedRelease = createValues({
      energy: 0.18,
      low: 0.18,
      mid: 0.06,
      high: 0,
      attackDensity: 0.13,
      density: 0.16
    })
    const bars = Array.from({ length: 64 }, (_, index) =>
      createBar(index, index < 40 ? active : index < 48 ? firstRelease : confirmedRelease)
    )
    const ranges = [createRange(0, 60, 'drop'), createRange(60, 64, 'outro')]

    expect(refineTerminalOutroRanges(bars, ranges, [])).toMatchObject([
      { startIndex: 0, endIndex: 48, kind: 'drop' },
      { startIndex: 48, endIndex: 64, kind: 'outro' }
    ])
  })
})
