import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapFromClips } from './songBeatGridMap'
import {
  buildSongStructureAnalysis,
  hasCurrentSongStructureAnalysis,
  hasUsableSongStructureAnalysis
} from './songStructure'
import { CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION } from './songStructureCommon'
import { buildSpectralSongStructureSections } from './songStructureSpectral'
import {
  clusterSongStructureSpectralBars,
  resolveSongStructureBuildRampScore,
  SONG_STRUCTURE_BUILD_RAMP_MIN_SCORE
} from './songStructureSpectralClustering'
import {
  buildSongStructureSpectralFeatures,
  type SongStructureSpectralBarFeature
} from './songStructureSpectralFeatures'
import { refineTerminalOutroRanges } from './songStructureSemanticOutro'
import {
  UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
  UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
  type UnifiedDisplayWaveformDetailData
} from './unifiedDisplayWaveform'

type SyntheticSection = {
  startBar: number
  endBar: number
  energy: (progress: number) => number
  low: (progress: number) => number
  mid: (progress: number) => number
  high: (progress: number) => number
  attacks: number[]
}

type SectionTimeRange = {
  startSec: number
  endSec: number
}

const BPM = 120
const BAR_SEC = 2
const DETAIL_RATE = 16

const toByte = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255)))

const constant = (value: number) => () => value

const createSyntheticWaveform = (
  barCount: number,
  sections: readonly SyntheticSection[]
): UnifiedDisplayWaveformDetailData => {
  const duration = barCount * BAR_SEC
  const frameCount = Math.ceil(duration * DETAIL_RATE)
  const height = new Uint8Array(frameCount)
  const attack = new Uint8Array(frameCount)
  const colorLow = new Uint8Array(frameCount)
  const colorMid = new Uint8Array(frameCount)
  const colorHigh = new Uint8Array(frameCount)

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sec = frame / DETAIL_RATE
    const bar = Math.min(barCount - 1, Math.floor(sec / BAR_SEC))
    const section =
      sections.find((candidate) => bar >= candidate.startBar && bar < candidate.endBar) ??
      sections[sections.length - 1]
    if (!section) continue
    const sectionBars = Math.max(1, section.endBar - section.startBar)
    const progress = (bar - section.startBar) / sectionBars
    const phase = ((sec % BAR_SEC) / BAR_SEC) * 16
    const pulseIndex = Math.floor(phase)
    const pulseDistance = Math.abs(phase - pulseIndex - 0.2)
    const isAttack = section.attacks.includes(pulseIndex) && pulseDistance < 0.34
    const deterministicMotion = Math.sin((frame * 17 + bar * 13) * 0.037) * 0.012

    height[frame] = toByte(section.energy(progress) + deterministicMotion)
    attack[frame] = toByte(isAttack ? 0.42 + section.high(progress) * 0.28 : 0.012)
    colorLow[frame] = toByte(section.low(progress))
    colorMid[frame] = toByte(section.mid(progress))
    colorHigh[frame] = toByte(section.high(progress))
  }

  const body = new Uint8Array(Math.ceil(frameCount / 4))
  for (let index = 0; index < body.length; index += 1) {
    body[index] = height[Math.min(height.length - 1, index * 4)] ?? 0
  }
  const overviewHeight = new Uint8Array(Math.ceil(duration * 4))
  for (let index = 0; index < overviewHeight.length; index += 1) {
    overviewHeight[index] =
      height[
        Math.min(height.length - 1, Math.floor((index / overviewHeight.length) * frameCount))
      ] ?? 0
  }

  return {
    version: UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
    parameterVersion: UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
    duration,
    sampleRate: 44100,
    detailRate: DETAIL_RATE,
    overviewRate: 4,
    bodyRateDivisor: 4,
    height,
    attack,
    colorIndex: new Uint8Array(frameCount),
    colorLow,
    colorMid,
    colorHigh,
    colorRed: new Uint8Array(frameCount),
    colorGreen: new Uint8Array(frameCount),
    colorBlue: new Uint8Array(frameCount),
    body,
    overviewHeight
  }
}

const buildInput = (waveformData: UnifiedDisplayWaveformDetailData) => ({
  waveformData,
  bpm: BPM,
  firstBeatMs: 0,
  barBeatOffset: 0
})

const analyze = (waveformData: UnifiedDisplayWaveformDetailData) =>
  buildSongStructureAnalysis(buildInput(waveformData))

const analyzeSpectral = (waveformData: UnifiedDisplayWaveformDetailData) =>
  buildSpectralSongStructureSections(
    {
      waveformData,
      bpm: BPM,
      firstBeatMs: 0,
      barBeatOffset: 0
    },
    waveformData.duration
  )

const hasSectionBoundaryNearBar = (
  sections: readonly SectionTimeRange[],
  targetBar: number,
  toleranceBars = 1
) =>
  sections
    .slice(0, -1)
    .some((section) => Math.abs(section.endSec / BAR_SEC - targetBar) <= toleranceBars)

const hasSectionBoundaryNearSec = (
  sections: readonly SectionTimeRange[],
  targetSec: number,
  toleranceSec: number
) => sections.slice(0, -1).some((section) => Math.abs(section.endSec - targetSec) <= toleranceSec)

const sectionsOverlappingBarRange = (
  sections: NonNullable<ReturnType<typeof analyze>>['sections'],
  startBar: number,
  endBar: number
) => sections.filter((section) => section.startBar - 1 < endBar && section.endBar > startBar)

describe('MSAF 风格歌曲结构分析', () => {
  it('能够从典型 EDM 结构中恢复多个语义区段', () => {
    const waveform = createSyntheticWaveform(96, [
      {
        startBar: 0,
        endBar: 16,
        energy: constant(0.46),
        low: constant(0.52),
        mid: constant(0.32),
        high: constant(0.22),
        attacks: [0, 4, 8, 12]
      },
      {
        startBar: 16,
        endBar: 32,
        energy: constant(0.62),
        low: constant(0.78),
        mid: constant(0.46),
        high: constant(0.34),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 32,
        endBar: 40,
        energy: constant(0.43),
        low: constant(0.2),
        mid: constant(0.56),
        high: constant(0.4),
        attacks: [4, 12]
      },
      {
        startBar: 40,
        endBar: 48,
        energy: (progress) => 0.46 + progress * 0.17,
        low: (progress) => 0.24 + progress * 0.28,
        mid: (progress) => 0.5 + progress * 0.18,
        high: (progress) => 0.42 + progress * 0.26,
        attacks: [0, 2, 4, 6, 8, 10, 12, 14, 15]
      },
      {
        startBar: 48,
        endBar: 72,
        energy: constant(0.72),
        low: constant(0.88),
        mid: constant(0.68),
        high: constant(0.56),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 72,
        endBar: 96,
        energy: (progress) => 0.62 - progress * 0.1,
        low: (progress) => 0.74 - progress * 0.12,
        mid: (progress) => 0.42 - progress * 0.12,
        high: (progress) => 0.3 - progress * 0.08,
        attacks: [0, 4, 8, 12]
      }
    ])

    const result = analyze(waveform)
    const spectral = analyzeSpectral(waveform)
    expect(waveform.duration).toBe(192)
    expect(spectral).not.toBeNull()
    expect(result?.algorithmVersion).toBe(CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION)
    expect(result?.sections).toEqual(spectral?.sections)
    expect(result?.sections.length).toBeGreaterThanOrEqual(4)
    expect(result?.sections.some((section) => section.kind === 'intro')).toBe(true)
    const buildSection = result?.sections.find((section) => section.kind === 'build')
    expect(buildSection).toBeDefined()
    expect(
      Math.abs((buildSection?.startSec ?? Number.NEGATIVE_INFINITY) / BAR_SEC - 40)
    ).toBeLessThanOrEqual(1)
    expect(result?.sections.some((section) => section.kind === 'drop')).toBe(true)
    expect(result?.sections.some((section) => section.kind === 'outro')).toBe(true)
  })

  it('总能量平缓时仍能利用纹理和节奏型变化产生边界', () => {
    const waveform = createSyntheticWaveform(80, [
      {
        startBar: 0,
        endBar: 16,
        energy: constant(0.64),
        low: constant(0.72),
        mid: constant(0.28),
        high: constant(0.18),
        attacks: [0, 4, 8, 12]
      },
      {
        startBar: 16,
        endBar: 32,
        energy: constant(0.64),
        low: constant(0.7),
        mid: constant(0.52),
        high: constant(0.36),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 32,
        endBar: 48,
        energy: constant(0.64),
        low: constant(0.68),
        mid: constant(0.34),
        high: constant(0.62),
        attacks: [0, 3, 4, 7, 8, 11, 12, 15]
      },
      {
        startBar: 48,
        endBar: 64,
        energy: constant(0.64),
        low: constant(0.71),
        mid: constant(0.58),
        high: constant(0.3),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 64,
        endBar: 80,
        energy: constant(0.64),
        low: constant(0.7),
        mid: constant(0.3),
        high: constant(0.2),
        attacks: [0, 4, 8, 12]
      }
    ])
    const result = analyze(waveform)
    const spectral = analyzeSpectral(waveform)
    const featureSet = buildSongStructureSpectralFeatures(buildInput(waveform), waveform.duration)
    const clustering = featureSet ? clusterSongStructureSpectralBars(featureSet.bars) : null

    expect(spectral).not.toBeNull()
    expect(clustering).not.toBeNull()
    expect(result?.sections).toEqual(spectral?.sections)
    expect(result?.sections.length).toBeGreaterThanOrEqual(3)
    expect(result?.sections.every((section) => section.kind === 'groove')).toBe(false)
    expect(
      [32, 48].some((targetBar) =>
        (clustering?.boundaries ?? []).some((boundary) => Math.abs(boundary.index - targetBar) <= 1)
      )
    ).toBe(true)
    expect(result?.sections[0]?.startSec).toBe(0)
    expect(result?.sections.at(-1)?.endSec).toBe(waveform.duration)
  })

  it('Breakdown 后直接重击进入 Drop 时不会凭空插入 Build', () => {
    const waveform = createSyntheticWaveform(96, [
      {
        startBar: 0,
        endBar: 16,
        energy: constant(0.45),
        low: constant(0.48),
        mid: constant(0.35),
        high: constant(0.22),
        attacks: [0, 4, 8, 12]
      },
      {
        startBar: 16,
        endBar: 40,
        energy: constant(0.66),
        low: constant(0.78),
        mid: constant(0.52),
        high: constant(0.36),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 40,
        endBar: 56,
        energy: constant(0.38),
        low: constant(0.18),
        mid: constant(0.56),
        high: constant(0.42),
        attacks: [4, 12]
      },
      {
        startBar: 56,
        endBar: 80,
        energy: constant(0.76),
        low: constant(0.9),
        mid: constant(0.68),
        high: constant(0.55),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 80,
        endBar: 96,
        energy: (progress) => 0.62 - progress * 0.12,
        low: (progress) => 0.72 - progress * 0.14,
        mid: (progress) => 0.4 - progress * 0.1,
        high: (progress) => 0.3 - progress * 0.08,
        attacks: [0, 4, 8, 12]
      }
    ])
    const result = analyze(waveform)
    const dropSection = result?.sections.find((section) => section.kind === 'drop')

    expect(result?.sections.some((section) => section.kind === 'breakdown')).toBe(true)
    expect(dropSection).toBeDefined()
    expect(
      Math.abs((dropSection?.startSec ?? Number.NEGATIVE_INFINITY) / BAR_SEC - 56)
    ).toBeLessThanOrEqual(1)
    expect(result?.sections.some((section) => section.kind === 'build')).toBe(false)
  })

  it('4 小节短 Breakdown 后直接进入 Drop 时不会把重击入口误算成 Build ramp', () => {
    const waveform = createSyntheticWaveform(84, [
      {
        startBar: 0,
        endBar: 16,
        energy: constant(0.45),
        low: constant(0.48),
        mid: constant(0.35),
        high: constant(0.22),
        attacks: [0, 4, 8, 12]
      },
      {
        startBar: 16,
        endBar: 40,
        energy: constant(0.66),
        low: constant(0.78),
        mid: constant(0.52),
        high: constant(0.36),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 40,
        endBar: 44,
        energy: constant(0.38),
        low: constant(0.18),
        mid: constant(0.56),
        high: constant(0.42),
        attacks: [1]
      },
      {
        startBar: 44,
        endBar: 68,
        energy: constant(0.78),
        low: constant(0.92),
        mid: constant(0.7),
        high: constant(0.57),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 68,
        endBar: 84,
        energy: (progress) => 0.62 - progress * 0.12,
        low: (progress) => 0.72 - progress * 0.14,
        mid: (progress) => 0.4 - progress * 0.1,
        high: (progress) => 0.3 - progress * 0.08,
        attacks: [0, 4, 8, 12]
      }
    ])
    const result = analyze(waveform)
    const breakdownSection = result?.sections.find((section) => section.kind === 'breakdown')
    const dropSection = result?.sections.find((section) => section.kind === 'drop')

    expect(breakdownSection).toBeDefined()
    expect(dropSection).toBeDefined()
    expect(
      Math.abs((dropSection?.startSec ?? Number.NEGATIVE_INFINITY) / BAR_SEC - 44)
    ).toBeLessThanOrEqual(1)
    expect(result?.sections.some((section) => section.kind === 'build')).toBe(false)
  })

  it('强结构边界偏离全曲大节相位时仍会在网格线上切分', () => {
    const waveform = createSyntheticWaveform(96, [
      {
        startBar: 0,
        endBar: 32,
        energy: constant(0.66),
        low: constant(0.78),
        mid: constant(0.48),
        high: constant(0.3),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 32,
        endBar: 38,
        energy: constant(0.36),
        low: constant(0.16),
        mid: constant(0.52),
        high: constant(0.42),
        attacks: [4, 12]
      },
      {
        startBar: 38,
        endBar: 46,
        energy: (progress) => 0.42 + progress * 0.2,
        low: (progress) => 0.18 + progress * 0.18,
        mid: (progress) => 0.5 + progress * 0.22,
        high: (progress) => 0.4 + progress * 0.28,
        attacks: [0, 2, 4, 6, 8, 10, 12, 14, 15]
      },
      {
        startBar: 46,
        endBar: 72,
        energy: constant(0.78),
        low: constant(0.91),
        mid: constant(0.68),
        high: constant(0.56),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 72,
        endBar: 96,
        energy: (progress) => 0.62 - progress * 0.14,
        low: (progress) => 0.72 - progress * 0.16,
        mid: (progress) => 0.4 - progress * 0.12,
        high: (progress) => 0.3 - progress * 0.1,
        attacks: [0, 4, 8, 12]
      }
    ])
    const featureSet = buildSongStructureSpectralFeatures(buildInput(waveform), waveform.duration)
    const clustering = featureSet ? clusterSongStructureSpectralBars(featureSet.bars) : null
    const result = analyze(waveform)

    expect(featureSet?.bars[46]?.hasPeriodicStructurePrior).toBe(false)
    expect(
      (clustering?.boundaries ?? []).some((boundary) => Math.abs(boundary.index - 46) <= 1)
    ).toBe(true)
    expect(hasSectionBoundaryNearBar(result?.sections ?? [], 46, 1)).toBe(true)
  })

  it('Drop 内部换纹理时仍保持为一个连续 Drop', () => {
    const waveform = createSyntheticWaveform(104, [
      {
        startBar: 0,
        endBar: 16,
        energy: constant(0.45),
        low: constant(0.48),
        mid: constant(0.34),
        high: constant(0.22),
        attacks: [0, 4, 8, 12]
      },
      {
        startBar: 16,
        endBar: 32,
        energy: constant(0.65),
        low: constant(0.78),
        mid: constant(0.5),
        high: constant(0.34),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 32,
        endBar: 48,
        energy: constant(0.38),
        low: constant(0.18),
        mid: constant(0.52),
        high: constant(0.4),
        attacks: [4, 12]
      },
      {
        startBar: 48,
        endBar: 64,
        energy: constant(0.76),
        low: constant(0.9),
        mid: constant(0.68),
        high: constant(0.54),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 64,
        endBar: 72,
        energy: constant(0.75),
        low: constant(0.88),
        mid: constant(0.42),
        high: constant(0.72),
        attacks: [0, 3, 4, 7, 8, 11, 12, 15]
      },
      {
        startBar: 72,
        endBar: 88,
        energy: constant(0.77),
        low: constant(0.91),
        mid: constant(0.7),
        high: constant(0.55),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 88,
        endBar: 104,
        energy: (progress) => 0.58 - progress * 0.12,
        low: (progress) => 0.65 - progress * 0.15,
        mid: (progress) => 0.38 - progress * 0.12,
        high: (progress) => 0.28 - progress * 0.08,
        attacks: [0, 4, 8, 12]
      }
    ])
    const result = analyze(waveform)
    const featureSet = buildSongStructureSpectralFeatures(buildInput(waveform), waveform.duration)
    const clustering = featureSet ? clusterSongStructureSpectralBars(featureSet.bars) : null
    const dropBody = sectionsOverlappingBarRange(result?.sections ?? [], 50, 86)

    expect(
      (clustering?.boundaries ?? []).some((boundary) =>
        [64, 72].some((target) => Math.abs(boundary.index - target) <= 1)
      )
    ).toBe(true)
    expect(dropBody).toHaveLength(1)
    expect(dropBody[0]?.kind).toBe('drop')
  })

  it('Breakdown 中短暂恢复鼓点时不会插入 Groove', () => {
    const waveform = createSyntheticWaveform(88, [
      {
        startBar: 0,
        endBar: 16,
        energy: constant(0.45),
        low: constant(0.48),
        mid: constant(0.34),
        high: constant(0.22),
        attacks: [0, 4, 8, 12]
      },
      {
        startBar: 16,
        endBar: 32,
        energy: constant(0.68),
        low: constant(0.8),
        mid: constant(0.54),
        high: constant(0.38),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 32,
        endBar: 40,
        energy: constant(0.36),
        low: constant(0.16),
        mid: constant(0.5),
        high: constant(0.4),
        attacks: [4, 12]
      },
      {
        startBar: 40,
        endBar: 44,
        energy: constant(0.42),
        low: constant(0.24),
        mid: constant(0.54),
        high: constant(0.44),
        attacks: [0, 4, 8, 12]
      },
      {
        startBar: 44,
        endBar: 48,
        energy: constant(0.35),
        low: constant(0.15),
        mid: constant(0.49),
        high: constant(0.39),
        attacks: [4, 12]
      },
      {
        startBar: 48,
        endBar: 72,
        energy: constant(0.78),
        low: constant(0.92),
        mid: constant(0.7),
        high: constant(0.56),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 72,
        endBar: 88,
        energy: (progress) => 0.58 - progress * 0.12,
        low: (progress) => 0.66 - progress * 0.14,
        mid: (progress) => 0.38 - progress * 0.1,
        high: (progress) => 0.28 - progress * 0.08,
        attacks: [0, 4, 8, 12]
      }
    ])
    const result = analyze(waveform)
    const breakdownBody = sectionsOverlappingBarRange(result?.sections ?? [], 33, 47)

    expect(breakdownBody).toHaveLength(1)
    expect(breakdownBody[0]?.kind).toBe('breakdown')
    const dropSection = result?.sections.find(
      (section) => section.kind === 'drop' && section.startSec / BAR_SEC >= 40
    )
    expect(
      Math.abs((dropSection?.startSec ?? Number.NEGATIVE_INFINITY) / BAR_SEC - 48)
    ).toBeLessThanOrEqual(1)
  })

  it('最后 Drop 的短抽空会等待重入，持续减层后才进入 Outro', () => {
    const waveform = createSyntheticWaveform(100, [
      {
        startBar: 0,
        endBar: 16,
        energy: constant(0.45),
        low: constant(0.48),
        mid: constant(0.34),
        high: constant(0.22),
        attacks: [0, 4, 8, 12]
      },
      {
        startBar: 16,
        endBar: 32,
        energy: constant(0.66),
        low: constant(0.78),
        mid: constant(0.52),
        high: constant(0.36),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 32,
        endBar: 48,
        energy: constant(0.37),
        low: constant(0.17),
        mid: constant(0.52),
        high: constant(0.4),
        attacks: [4, 12]
      },
      {
        startBar: 48,
        endBar: 64,
        energy: constant(0.78),
        low: constant(0.92),
        mid: constant(0.7),
        high: constant(0.56),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 64,
        endBar: 68,
        energy: constant(0.42),
        low: constant(0.28),
        mid: constant(0.46),
        high: constant(0.38),
        attacks: [4, 12]
      },
      {
        startBar: 68,
        endBar: 84,
        energy: constant(0.79),
        low: constant(0.93),
        mid: constant(0.71),
        high: constant(0.57),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 84,
        endBar: 100,
        energy: (progress) => 0.58 - progress * 0.14,
        low: (progress) => 0.66 - progress * 0.18,
        mid: (progress) => 0.4 - progress * 0.14,
        high: (progress) => 0.3 - progress * 0.1,
        attacks: [0, 4, 8, 12]
      }
    ])
    const result = analyze(waveform)
    const dropBody = sectionsOverlappingBarRange(result?.sections ?? [], 50, 82)
    const outroSection = result?.sections.at(-1)

    expect(dropBody).toHaveLength(1)
    expect(dropBody[0]?.kind).toBe('drop')
    expect(outroSection?.kind).toBe('outro')
    expect(
      Math.abs((outroSection?.startSec ?? Number.NEGATIVE_INFINITY) / BAR_SEC - 84)
    ).toBeLessThanOrEqual(1)
  })

  it('Breakdown 后经过中等活跃过渡仍能在后续强重入处确认 Drop', () => {
    const waveform = createSyntheticWaveform(96, [
      {
        startBar: 0,
        endBar: 16,
        energy: constant(0.44),
        low: constant(0.46),
        mid: constant(0.34),
        high: constant(0.22),
        attacks: [0, 4, 8, 12]
      },
      {
        startBar: 16,
        endBar: 32,
        energy: constant(0.68),
        low: constant(0.8),
        mid: constant(0.54),
        high: constant(0.38),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 32,
        endBar: 40,
        energy: constant(0.32),
        low: constant(0.14),
        mid: constant(0.48),
        high: constant(0.38),
        attacks: [4, 12]
      },
      {
        startBar: 40,
        endBar: 56,
        energy: constant(0.43),
        low: constant(0.35),
        mid: constant(0.46),
        high: constant(0.36),
        attacks: [4, 12]
      },
      {
        startBar: 56,
        endBar: 80,
        energy: constant(0.8),
        low: constant(0.94),
        mid: constant(0.72),
        high: constant(0.58),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 80,
        endBar: 96,
        energy: (progress) => 0.58 - progress * 0.14,
        low: (progress) => 0.66 - progress * 0.18,
        mid: (progress) => 0.4 - progress * 0.14,
        high: (progress) => 0.3 - progress * 0.1,
        attacks: [0, 4, 8, 12]
      }
    ])
    const result = analyze(waveform)
    const transition = sectionsOverlappingBarRange(result?.sections ?? [], 42, 54)
    const dropSection = result?.sections.find(
      (section) => section.kind === 'drop' && section.startSec / BAR_SEC >= 48
    )

    expect(transition.every((section) => section.kind !== 'drop')).toBe(true)
    expect(dropSection).toBeDefined()
    expect(
      Math.abs((dropSection?.startSec ?? Number.NEGATIVE_INFINITY) / BAR_SEC - 56)
    ).toBeLessThanOrEqual(1)
  })

  it('已有 Outro 过早时会收回活跃前段并推迟到真实终局减层', () => {
    const createValues = (active: boolean) => ({
      energy: active ? 0.65 : -0.55,
      low: active ? 0.7 : -0.6,
      mid: active ? 0.55 : -0.45,
      high: active ? 0.45 : -0.4,
      attack: active ? 0.5 : -0.45,
      attackDensity: active ? 0.6 : -0.55,
      density: active ? 0.65 : -0.58,
      brightness: active ? 0.3 : -0.2,
      crest: 0,
      lowShare: 0,
      midShare: 0,
      highShare: 0
    })
    const bars: SongStructureSpectralBarFeature[] = Array.from({ length: 48 }, (_, index) => {
      const active = index < 40
      const normalized = createValues(active)
      return {
        index,
        startSec: index * BAR_SEC,
        endSec: (index + 1) * BAR_SEC,
        startBar: index + 1,
        phraseIndex: Math.floor(index / 8),
        hasPeriodicStructurePrior: index % 8 === 0,
        isClipBoundary: false,
        clipIndex: 0,
        normalized,
        values: Object.fromEntries(
          Object.entries(normalized).map(([key, value]) => [key, value * 0.35 + 0.5])
        ) as typeof normalized,
        pulseAttack: [],
        pulseHigh: [],
        localVector: [],
        recurrenceVector: []
      }
    })
    const ranges = refineTerminalOutroRanges(
      bars,
      [
        {
          startIndex: 0,
          endIndex: 16,
          kind: 'drop',
          confidence: 0.7,
          clusterId: 1,
          entryBoundaryScore: 0.4
        },
        {
          startIndex: 16,
          endIndex: 48,
          kind: 'outro',
          confidence: 0.7,
          clusterId: 2,
          entryBoundaryScore: 0.4
        }
      ],
      []
    )

    expect(ranges).toMatchObject([
      { startIndex: 0, endIndex: 40, kind: 'drop' },
      { startIndex: 40, endIndex: 48, kind: 'outro' }
    ])
  })

  it('区段中点的一次阶跃不算持续 Build ramp', () => {
    const waveform = createSyntheticWaveform(64, [
      {
        startBar: 0,
        endBar: 32,
        energy: constant(0.66),
        low: constant(0.78),
        mid: constant(0.52),
        high: constant(0.36),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 32,
        endBar: 44,
        energy: constant(0.38),
        low: constant(0.18),
        mid: constant(0.42),
        high: constant(0.3),
        attacks: [4, 12]
      },
      {
        startBar: 44,
        endBar: 64,
        energy: constant(0.78),
        low: constant(0.92),
        mid: constant(0.7),
        high: constant(0.57),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      }
    ])
    const featureSet = buildSongStructureSpectralFeatures(
      {
        waveformData: waveform,
        bpm: BPM,
        firstBeatMs: 0,
        barBeatOffset: 0
      },
      waveform.duration
    )

    expect(featureSet).not.toBeNull()
    expect(resolveSongStructureBuildRampScore(featureSet?.bars ?? [], 40, 48)).toBeLessThan(
      SONG_STRUCTURE_BUILD_RAMP_MIN_SCORE
    )
  })

  it('没有真实结构变化时不会为了满足模板强行制造 Drop 或同标签伪边界', () => {
    const waveform = createSyntheticWaveform(80, [
      {
        startBar: 0,
        endBar: 80,
        energy: constant(0.63),
        low: constant(0.72),
        mid: constant(0.46),
        high: constant(0.31),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      }
    ])
    const result = analyze(waveform)

    expect(result?.sections).toHaveLength(1)
    expect(result?.sections.every((section) => section.kind === 'groove')).toBe(true)
    expect(result?.sections[0]?.startSec).toBe(0)
    expect(result?.sections.at(-1)?.endSec).toBe(waveform.duration)
  })

  it('极短首拍偏移不会在结构时间轴头部留下缺口', () => {
    const waveform = createSyntheticWaveform(32, [
      {
        startBar: 0,
        endBar: 32,
        energy: constant(0.6),
        low: constant(0.7),
        mid: constant(0.45),
        high: constant(0.3),
        attacks: [0, 4, 8, 12]
      }
    ])
    const featureSet = buildSongStructureSpectralFeatures(
      {
        waveformData: waveform,
        bpm: BPM,
        firstBeatMs: 10,
        barBeatOffset: 0
      },
      waveform.duration
    )

    expect(featureSet?.bars[0]?.startSec).toBe(0)
    expect(featureSet?.bars.at(-1)?.endSec).toBe(waveform.duration)
  })

  it('动态 clip 弱候选在附近存在真实局部变化时会保留结构边界', () => {
    const waveform = createSyntheticWaveform(64, [
      {
        startBar: 0,
        endBar: 32,
        energy: constant(0.66),
        low: constant(0.78),
        mid: constant(0.46),
        high: constant(0.3),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      },
      {
        startBar: 32,
        endBar: 48,
        energy: constant(0.42),
        low: constant(0.22),
        mid: constant(0.56),
        high: constant(0.45),
        attacks: [4, 12]
      },
      {
        startBar: 48,
        endBar: 64,
        energy: constant(0.72),
        low: constant(0.86),
        mid: constant(0.64),
        high: constant(0.5),
        attacks: [0, 2, 4, 6, 8, 10, 12, 14]
      }
    ])
    const clipBoundarySec = 65.1
    const beatGridMap = createSongBeatGridMapFromClips([
      {
        startSec: 0,
        anchorSec: 0,
        bpm: BPM,
        barBeatOffset: 0
      },
      {
        startSec: clipBoundarySec,
        anchorSec: 64.4,
        bpm: BPM,
        barBeatOffset: 0
      }
    ])
    const result = buildSongStructureAnalysis({
      waveformData: waveform,
      bpm: BPM,
      firstBeatMs: 0,
      barBeatOffset: 0,
      beatGridMap
    })

    expect(result).not.toBeNull()
    expect(hasSectionBoundaryNearSec(result?.sections ?? [], clipBoundarySec, BAR_SEC * 2)).toBe(
      true
    )
  })

  it('动态网格 signature 改变后会拒绝旧结构结果', () => {
    const waveform = createSyntheticWaveform(48, [
      {
        startBar: 0,
        endBar: 48,
        energy: constant(0.61),
        low: constant(0.7),
        mid: constant(0.48),
        high: constant(0.32),
        attacks: [0, 4, 8, 12]
      }
    ])
    const originalGrid = createSongBeatGridMapFromClips([
      { startSec: 0, anchorSec: 0, bpm: BPM, barBeatOffset: 0 },
      { startSec: 64, anchorSec: 64, bpm: BPM, barBeatOffset: 0 }
    ])
    const changedGrid = createSongBeatGridMapFromClips([
      { startSec: 0, anchorSec: 0, bpm: BPM, barBeatOffset: 0 },
      { startSec: 64, anchorSec: 64.25, bpm: BPM, barBeatOffset: 0 }
    ])
    const songStructure = buildSongStructureAnalysis({
      waveformData: waveform,
      bpm: BPM,
      firstBeatMs: 0,
      barBeatOffset: 0,
      beatGridMap: originalGrid
    })

    expect(songStructure).not.toBeNull()
    expect(hasUsableSongStructureAnalysis({ beatGridMap: originalGrid, songStructure })).toBe(true)
    expect(hasCurrentSongStructureAnalysis({ beatGridMap: originalGrid, songStructure })).toBe(
      false
    )
    expect(hasCurrentSongStructureAnalysis({ beatGridMap: changedGrid, songStructure })).toBe(false)
  })

  it('动态 clip 边界不会凭空增加一个逻辑 bar', () => {
    const waveform = createSyntheticWaveform(48, [
      {
        startBar: 0,
        endBar: 48,
        energy: constant(0.61),
        low: constant(0.7),
        mid: constant(0.48),
        high: constant(0.32),
        attacks: [0, 4, 8, 12]
      }
    ])
    const beatGridMap = createSongBeatGridMapFromClips([
      {
        startSec: 0,
        anchorSec: 0,
        bpm: BPM,
        barBeatOffset: 0
      },
      {
        startSec: 65.1,
        anchorSec: 64.4,
        bpm: BPM,
        barBeatOffset: 0
      }
    ])
    const featureSet = buildSongStructureSpectralFeatures(
      {
        waveformData: waveform,
        bpm: BPM,
        firstBeatMs: 0,
        barBeatOffset: 0,
        beatGridMap
      },
      waveform.duration
    )

    expect(featureSet).not.toBeNull()
    expect(featureSet?.bars.some((bar) => Math.abs(bar.startSec - 65.1) < 0.001)).toBe(false)
    expect(featureSet?.bars[0]?.startSec).toBe(0)
    expect(featureSet?.bars.at(-1)?.endSec).toBe(waveform.duration)
  })
})
