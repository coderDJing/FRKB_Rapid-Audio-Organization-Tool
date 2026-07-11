import { createRequire } from 'node:module'
import {
  decodeSongAnalysisAudio,
  type SongAnalysisAudioDecoderBinding
} from '../src/main/workers/songAnalysisAudioDecoder'
import { COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE } from '../src/shared/compactVisualWaveform'
import { buildSongStructureAnalysis } from '../src/shared/songStructure'
import {
  SONG_STRUCTURE_FEATURE_DEFAULT_FRAME_RATE,
  buildSongStructureFeatureDataFromMixxx,
  getSongStructureFeaturePayloadBytes
} from '../src/shared/songStructureFeatureData'
import type { SongStructureAnalysis } from '../src/shared/songStructureCommon'
import {
  UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE,
  buildUnifiedDisplayWaveformDetailFromMixxx
} from '../src/shared/unifiedDisplayWaveform'
import { computeRawWaveform } from '../src/main/workers/rawWaveformBuilder'
import type { MixxxWaveformData } from '../src/main/waveformCodec'
import {
  resolveSongStructureGridInput,
  type SongStructureTruthGrid
} from './song_structure_truth_common'

type RustBinding = SongAnalysisAudioDecoderBinding & {
  computeMixxxWaveformWithRate: (
    pcmData: Buffer,
    sampleRate: number,
    channels: number,
    targetRate: number
  ) => MixxxWaveformData
}

export type SongStructureAudioPreparationOptions = {
  absoluteBands?: boolean
  featureRate?: number
}

export const prepareSongStructureAudio = (
  filePath: string,
  options: SongStructureAudioPreparationOptions = {}
) => {
  const featureRate = options.featureRate ?? SONG_STRUCTURE_FEATURE_DEFAULT_FRAME_RATE
  if (options.absoluteBands && ![8, 16, 32].includes(featureRate)) {
    throw new Error('absolute 结构特征帧率仅支持 8、16、32 Hz')
  }

  const require = createRequire(import.meta.url)
  const rust = require('rust_package') as RustBinding
  const decoded = decodeSongAnalysisAudio(rust, filePath)

  const waveform = rust.computeMixxxWaveformWithRate(
    decoded.pcmData,
    decoded.sampleRate,
    decoded.channels,
    UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE
  )
  const rawWaveform = computeRawWaveform(
    decoded.pcmData,
    decoded.sampleRate,
    decoded.channels,
    COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE
  )
  const unified = buildUnifiedDisplayWaveformDetailFromMixxx(waveform, rawWaveform)
  if (!unified) throw new Error('统一波形构建失败')

  const structureFeatureStartedAt = performance.now()
  const structureFeatureData = options.absoluteBands
    ? buildSongStructureFeatureDataFromMixxx(waveform, featureRate)
    : null
  const structureFeatureBuildMs = performance.now() - structureFeatureStartedAt
  if (options.absoluteBands && !structureFeatureData) {
    throw new Error('absolute 结构特征构建失败')
  }

  return {
    waveform,
    unified,
    decoderBackend: decoded.decoderBackend ?? 'rust-default',
    structureFeatureData,
    structureFeatureBuildMs,
    structureFeaturePayloadBytes: structureFeatureData
      ? getSongStructureFeaturePayloadBytes(structureFeatureData)
      : 0
  }
}

export const analyzeSongStructureAudio = (
  filePath: string,
  grid: SongStructureTruthGrid,
  options: SongStructureAudioPreparationOptions = {}
): {
  structure: SongStructureAnalysis
  analysisMs: number
  durationSec: number
  decoderBackend: string
  structureFeatureBuildMs: number
  structureFeaturePayloadBytes: number
} => {
  const prepared = prepareSongStructureAudio(filePath, options)
  const structureInput = {
    waveformData: prepared.unified,
    structureFeatureData: prepared.structureFeatureData,
    ...resolveSongStructureGridInput(grid, prepared.unified.duration)
  }
  const startedAt = performance.now()
  const structure = buildSongStructureAnalysis(structureInput)
  const analysisMs = performance.now() - startedAt
  if (!structure) throw new Error('生产段落算法没有生成结果')
  return {
    structure,
    analysisMs,
    durationSec: prepared.unified.duration,
    decoderBackend: prepared.decoderBackend,
    structureFeatureBuildMs: prepared.structureFeatureBuildMs,
    structureFeaturePayloadBytes: prepared.structureFeaturePayloadBytes
  }
}
