import { describe, expect, it } from 'vitest'
import {
  createSongBeatGridMapV2FromClips,
  createSongBeatGridMapV2FromFixedGrid
} from './songBeatGridMapV2'
import { buildSongStructureAnalysis } from './songStructure'
import {
  buildSongStructureAnalysisV23,
  buildSongStructureV23SpectralCandidate
} from './songStructureV23'
import { buildSongStructureV23SpectralFeatures } from './songStructureSpectralFeatures'
import {
  UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
  UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
  type UnifiedDisplayWaveformDetailData
} from './unifiedDisplayWaveform'

const BPM = 120
const DOWNBEAT_SEC = 2
const DETAIL_RATE = 16

const toByte = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255)))

const createWaveform = (downbeatCount = 64): UnifiedDisplayWaveformDetailData => {
  const duration = downbeatCount * DOWNBEAT_SEC
  const frameCount = duration * DETAIL_RATE
  const height = new Uint8Array(frameCount)
  const attack = new Uint8Array(frameCount)
  const colorLow = new Uint8Array(frameCount)
  const colorMid = new Uint8Array(frameCount)
  const colorHigh = new Uint8Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sec = frame / DETAIL_RATE
    const downbeat = Math.min(downbeatCount - 1, Math.floor(sec / DOWNBEAT_SEC))
    const phase = (sec % DOWNBEAT_SEC) / DOWNBEAT_SEC
    const isPulse = phase < 0.08 || Math.abs(phase - 0.5) < 0.08
    const isIntro = downbeat < 16
    const isBreakdown = downbeat >= 32 && downbeat < 40
    const isBuild = downbeat >= 40 && downbeat < 48
    const isDrop = downbeat >= 48
    const buildProgress = isBuild ? (downbeat - 40) / 8 : 0
    const energy = isIntro ? 0.28 : isBreakdown ? 0.24 : isBuild ? 0.3 + buildProgress * 0.28 : 0.58
    const low = isIntro
      ? 0.22
      : isBreakdown
        ? 0.12
        : isBuild
          ? 0.18 + buildProgress * 0.2
          : isDrop
            ? 0.66
            : 0.52
    const high = isIntro ? 0.12 : isBreakdown ? 0.28 : isBuild ? 0.3 + buildProgress * 0.3 : 0.24
    height[frame] = toByte(energy)
    attack[frame] = toByte(isPulse ? (isBuild ? 0.3 + buildProgress * 0.45 : 0.46) : 0.01)
    colorLow[frame] = toByte(low)
    colorMid[frame] = toByte(isBreakdown || isBuild ? 0.44 : 0.3)
    colorHigh[frame] = toByte(high)
  }
  const body = new Uint8Array(Math.ceil(frameCount / 4))
  for (let index = 0; index < body.length; index += 1) {
    body[index] = height[Math.min(height.length - 1, index * 4)] ?? 0
  }
  const overviewHeight = new Uint8Array(Math.ceil(duration * 4))
  for (let index = 0; index < overviewHeight.length; index += 1) {
    overviewHeight[index] = height[Math.min(height.length - 1, index * 4)] ?? 0
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

describe('songStructure v23 native downbeat grid', () => {
  it('returns format v2 sections without legacy phrase or bar fields', () => {
    const waveformData = createWaveform()
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: BPM,
      firstBeatMs: 0,
      downbeatBeatOffset: 0
    })
    expect(beatGridMap).not.toBeNull()
    const result = buildSongStructureAnalysisV23({ waveformData, beatGridMap })
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      formatVersion: 2,
      algorithmVersion: 27,
      beatGridSignature: beatGridMap?.signature
    })
    expect(result?.sections.length).toBeGreaterThan(1)
    const candidate = buildSongStructureV23SpectralCandidate(
      { waveformData, beatGridMap },
      waveformData.duration
    )
    expect(candidate).not.toBeNull()
    for (const section of result?.sections ?? []) {
      expect(section.startDownbeatOrdinal).toBeGreaterThanOrEqual(0)
      expect(section.endDownbeatOrdinal).toBeGreaterThan(section.startDownbeatOrdinal)
      expect(section).not.toHaveProperty('startBar')
      expect(section).not.toHaveProperty('endBar')
      expect(section).not.toHaveProperty('phraseIndex')
    }
  })

  it('uses every downbeat as a feature boundary without recreating phrase boundaries', () => {
    const waveformData = createWaveform()
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: BPM,
      firstBeatMs: 0,
      downbeatBeatOffset: 0
    })
    const featureSet = buildSongStructureV23SpectralFeatures(
      { waveformData, beatGridMap },
      waveformData.duration
    )
    expect(featureSet?.bars).toHaveLength(64)
    expect(featureSet?.bars.every((feature) => !feature.hasPeriodicStructurePrior)).toBe(true)
  })

  it('keeps a dynamic clip boundary as a soft prior on the nearest downbeat', () => {
    const waveformData = createWaveform()
    const beatGridMap = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0, bpm: BPM, downbeatBeatOffset: 0 },
        { startSec: 64, anchorSec: 64.25, bpm: BPM, downbeatBeatOffset: 0 }
      ],
      'manual',
      { durationSec: waveformData.duration, allowSingleClip: true }
    )
    const featureSet = buildSongStructureV23SpectralFeatures(
      { waveformData, beatGridMap },
      waveformData.duration
    )
    expect(featureSet?.bars.some((feature) => feature.isClipBoundary)).toBe(true)
    expect(featureSet?.bars.every((feature) => !feature.hasPeriodicStructurePrior)).toBe(true)
  })

  it('keeps both frozen v22 and native v23 deterministic for identical input', () => {
    const waveformData = createWaveform()
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: BPM,
      firstBeatMs: 0,
      downbeatBeatOffset: 0
    })
    const v22Input = { waveformData, bpm: BPM, firstBeatMs: 0, barBeatOffset: 0 }
    const v23Input = { waveformData, beatGridMap }
    expect(buildSongStructureAnalysis(v22Input)).toEqual(buildSongStructureAnalysis(v22Input))
    expect(buildSongStructureAnalysisV23(v23Input)).toEqual(buildSongStructureAnalysisV23(v23Input))
  })
})
