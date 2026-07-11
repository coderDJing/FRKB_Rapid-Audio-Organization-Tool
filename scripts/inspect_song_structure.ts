import path from 'node:path'
import { SONG_ANALYSIS_NATIVE_LIBAV_BACKEND } from '../src/main/workers/songAnalysisAudioDecoder'
import { buildSongStructureAnalysis } from '../src/shared/songStructure'
import { SONG_STRUCTURE_FEATURE_DEFAULT_FRAME_RATE } from '../src/shared/songStructureFeatureData'
import { buildSpectralSongStructureSections } from '../src/shared/songStructureSpectral'
import { clusterSongStructureSpectralBars } from '../src/shared/songStructureSpectralClustering'
import { buildSongStructureSpectralFeatures } from '../src/shared/songStructureSpectralFeatures'
import { buildSongStructureSemanticDiagnostics } from '../src/shared/songStructureSemanticLabels'
import { buildSongStructureTerminalOutroDiagnostics } from '../src/shared/songStructureSemanticOutro'
import { prepareSongStructureAudio } from './song_structure_audio_runtime'

const args = process.argv.slice(2)
const HELP_TEXT = `歌曲段落分析诊断工具

用法：
  pnpm run inspect:song-structure -- --file <音频路径> --bpm <BPM> --first-beat-ms <毫秒> --bar-beat-offset <偏移> [选项]

必填参数：
  --file <路径>               待分析音频文件
  --bpm <数值>                歌曲 BPM
  --first-beat-ms <数值>      第一拍相对歌曲开头的毫秒位置
  --bar-beat-offset <数值>    32 拍 phrase 网格偏移

选项：
  --summary                   输出精简的最终段落结果
  --diagnostics               附加谱聚类边界、cluster 数量和语义 emission 诊断
  --absolute-bands            使用 Rust Mixxx absolute low/mid/high/all 实验特征
  --feature-rate <8|16|32>    absolute 实验特征帧率，默认 16 Hz
  --help, -h                  显示本帮助

参数同时支持 --name=value 形式。
`

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP_TEXT)
  process.exit(0)
}

const readArg = (name: string) => {
  const direct = args.find((arg) => arg.startsWith(`${name}=`))
  if (direct) return direct.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const filePath = path.resolve(String(readArg('--file') || '').trim())
const bpm = Number(readArg('--bpm'))
const firstBeatMs = Number(readArg('--first-beat-ms'))
const barBeatOffset = Number(readArg('--bar-beat-offset'))
const summaryOnly = args.includes('--summary')
const diagnosticsEnabled = args.includes('--diagnostics')
const absoluteBandsEnabled = args.includes('--absolute-bands')
const featureRate = Number(readArg('--feature-rate') ?? SONG_STRUCTURE_FEATURE_DEFAULT_FRAME_RATE)

if (!String(readArg('--file') || '').trim()) {
  throw new Error('缺少 --file')
}
if (!Number.isFinite(bpm) || bpm <= 0) {
  throw new Error('缺少有效 --bpm')
}
if (!Number.isFinite(firstBeatMs)) {
  throw new Error('缺少有效 --first-beat-ms')
}
if (!Number.isFinite(barBeatOffset)) {
  throw new Error('缺少有效 --bar-beat-offset')
}
if (absoluteBandsEnabled && ![8, 16, 32].includes(featureRate)) {
  throw new Error('--feature-rate 仅支持 8、16、32')
}

const prepared = prepareSongStructureAudio(filePath, {
  absoluteBands: absoluteBandsEnabled,
  featureRate
})
const { decoderBackend, unified, structureFeatureData, structureFeatureBuildMs } = prepared

const structureInput = {
  waveformData: unified,
  structureFeatureData,
  bpm,
  firstBeatMs,
  barBeatOffset
}
const spectralStartedAt = performance.now()
const spectralCandidate = buildSpectralSongStructureSections(structureInput, unified.duration)
const spectralAnalysisMs = performance.now() - spectralStartedAt
const productionStartedAt = performance.now()
const structure = buildSongStructureAnalysis(structureInput)
const productionAnalysisMs = performance.now() - productionStartedAt
if (!structure) throw new Error('段落分析没有生成结果')
const featureStrategy = spectralCandidate
  ? absoluteBandsEnabled
    ? `spectral-v${structure.algorithmVersion}-absolute-${featureRate}hz`
    : `spectral-v${structure.algorithmVersion}-pseudo-color`
  : 'legacy-compatibility'
const decoderStrategy =
  decoderBackend === SONG_ANALYSIS_NATIVE_LIBAV_BACKEND
    ? 'production-native-libav-44k1-stereo'
    : `production-${decoderBackend}`
const strategy = `${featureStrategy}-${decoderStrategy}`

const summarizeFeatureValues = (values: Uint8Array) => {
  const sorted = [...values].sort((left, right) => left - right)
  const readPercentile = (ratio: number) =>
    sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * ratio)))] ?? 0
  let zeroCount = 0
  let saturatedCount = 0
  for (const value of values) {
    if (value === 0) zeroCount += 1
    if (value === 255) saturatedCount += 1
  }
  return {
    zeroPct: Number(((zeroCount / Math.max(1, values.length)) * 100).toFixed(3)),
    saturatedPct: Number(((saturatedCount / Math.max(1, values.length)) * 100).toFixed(3)),
    p10: readPercentile(0.1),
    p50: readPercentile(0.5),
    p90: readPercentile(0.9)
  }
}

const structureFeatureStats =
  diagnosticsEnabled && structureFeatureData
    ? Object.fromEntries(
        Object.entries(structureFeatureData.bands).map(([key, band]) => [
          key,
          {
            body: summarizeFeatureValues(band.body),
            peak: summarizeFeatureValues(band.peak),
            onset: summarizeFeatureValues(band.onset)
          }
        ])
      )
    : undefined

const spectralDiagnostics = (() => {
  if (!diagnosticsEnabled) return undefined
  const featureSet = buildSongStructureSpectralFeatures(structureInput, unified.duration)
  if (!featureSet) {
    return {
      available: false,
      stage: 'features'
    }
  }
  const clustering = clusterSongStructureSpectralBars(featureSet.bars)
  if (!clustering) {
    return {
      available: false,
      stage: 'clustering',
      barCount: featureSet.bars.length
    }
  }
  const lastBar = featureSet.bars.at(-1)
  const semantic = buildSongStructureSemanticDiagnostics(featureSet.bars, clustering)
  return {
    available: true,
    barCount: featureSet.bars.length,
    clusterCount: clustering.clusterCount,
    boundaries: clustering.boundaries.map((boundary) => {
      const bar = featureSet.bars[boundary.index]
      return {
        index: boundary.index,
        bar: bar?.startBar ?? (lastBar?.startBar ?? featureSet.bars.length) + 1,
        sec: Number((bar?.startSec ?? unified.duration).toFixed(3)),
        score: Number(boundary.score.toFixed(6)),
        buildRamp: Number((boundary.buildRamp ?? 0).toFixed(6))
      }
    }),
    semantic: semantic.map((segment) => {
      const firstBar = featureSet.bars[segment.startIndex]
      const finalBar = featureSet.bars[segment.endIndex - 1]
      return {
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
        startBar: firstBar?.startBar,
        endBar: finalBar?.startBar,
        startSec: firstBar ? Number(firstBar.startSec.toFixed(3)) : undefined,
        endSec: finalBar ? Number(finalBar.endSec.toFixed(3)) : undefined,
        decodedKind: segment.decodedKind,
        guardedKind: segment.guardedKind,
        entryRise: Number(segment.entryRise.toFixed(6)),
        entryTimbre: Number(segment.entryTimbre.toFixed(6)),
        nextRise: Number(segment.nextRise.toFixed(6)),
        relativeReduction: Number(segment.relativeReduction.toFixed(6)),
        activity: Number(segment.activity.toFixed(6)),
        stability: Number(segment.stability.toFixed(6)),
        buildRamp: Number(segment.buildRamp.toFixed(6)),
        emissions: segment.scores
      }
    }),
    terminalOutro: buildSongStructureTerminalOutroDiagnostics(featureSet.bars).map((candidate) => ({
      bar: candidate.index + 1,
      sec: Number((featureSet.bars[candidate.index]?.startSec ?? unified.duration).toFixed(3)),
      normalizedReduction: Number(candidate.normalizedReduction.toFixed(6)),
      foundationDrop: Number(candidate.foundationDrop.toFixed(6)),
      layerDrop: Number(candidate.layerDrop.toFixed(6)),
      rawReduction: Number(candidate.rawReduction.toFixed(6)),
      persistence: Number(candidate.persistence.toFixed(6)),
      hasDecisiveRecovery: candidate.hasDecisiveRecovery
    }))
  }
})()

const output = summaryOnly
  ? {
      filePath,
      durationSec: Number(unified.duration.toFixed(3)),
      strategy,
      decoderBackend,
      structureFeatureBuildMs: Number(structureFeatureBuildMs.toFixed(3)),
      structureFeaturePayloadBytes: prepared.structureFeaturePayloadBytes,
      spectralAnalysisMs: Number(spectralAnalysisMs.toFixed(3)),
      productionAnalysisMs: Number(productionAnalysisMs.toFixed(3)),
      sections: structure.sections.map((section) => ({
        kind: section.kind,
        startSec: section.startSec,
        endSec: section.endSec,
        startBar: section.startBar,
        endBar: section.endBar,
        confidence: section.confidence
      })),
      ...(diagnosticsEnabled ? { spectralDiagnostics } : {}),
      ...(diagnosticsEnabled && structureFeatureStats ? { structureFeatureStats } : {})
    }
  : {
      filePath,
      durationSec: unified.duration,
      bpm,
      firstBeatMs,
      barBeatOffset,
      strategy,
      decoderBackend,
      structureFeatureBuildMs: Number(structureFeatureBuildMs.toFixed(3)),
      structureFeaturePayloadBytes: prepared.structureFeaturePayloadBytes,
      spectralAnalysisMs: Number(spectralAnalysisMs.toFixed(3)),
      productionAnalysisMs: Number(productionAnalysisMs.toFixed(3)),
      structure,
      ...(diagnosticsEnabled ? { spectralDiagnostics } : {}),
      ...(diagnosticsEnabled && structureFeatureStats ? { structureFeatureStats } : {})
    }

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
