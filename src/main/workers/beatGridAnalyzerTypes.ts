import type { BeatGridAnalyzerProvider } from '../services/beatGridAlgorithmVersion'

export type BeatGridAnalyzeParams = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  sourceFilePath?: string
  analyzerProvider?: BeatGridAnalyzerProvider
  windowSec?: number
  maxScanSec?: number
}

export type BeatGridAnalyzeResult = {
  analyzerProvider: BeatGridAnalyzerProvider
  bpm: number
  firstBeatMs: number
  rawBpm?: number
  barBeatOffset: number
  beatCount: number
  downbeatCount: number
  durationSec: number
  beatIntervalSec: number
  beatCoverageScore: number
  beatStabilityScore: number
  downbeatCoverageScore: number
  downbeatStabilityScore: number
  qualityScore: number
  rawFirstBeatMs?: number
  anchorCorrectionMs?: number
  anchorConfidenceScore?: number
  anchorMatchedBeatCount?: number
  anchorStrategy?: string
  beatThisEstimatedDrift128Ms?: number
  beatThisWindowCount?: number
  windowStartSec?: number
  windowDurationSec?: number
  windowIndex?: number
}
