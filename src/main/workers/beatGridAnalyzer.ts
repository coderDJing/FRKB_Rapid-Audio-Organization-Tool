import {
  resolveConfiguredBeatGridAnalyzerProvider,
  type BeatGridAnalyzerProvider
} from '../services/beatGridAlgorithmVersion'
import { analyzeBeatGridWithBeatThisSlidingWindowsFromPcm } from './beatThisAnalyzer'
import { analyzeBeatGridWithClassicFromPcm } from './classicBeatGridAnalyzer'
import type { BeatGridAnalyzeParams, BeatGridAnalyzeResult } from './beatGridAnalyzerTypes'

export const resolveBeatGridAnalyzerProvider = (): BeatGridAnalyzerProvider =>
  resolveConfiguredBeatGridAnalyzerProvider()

export const analyzeBeatGridFromPcm = async (
  params: BeatGridAnalyzeParams
): Promise<BeatGridAnalyzeResult> => {
  const provider = params.analyzerProvider ?? resolveBeatGridAnalyzerProvider()
  if (provider === 'classic') {
    return analyzeBeatGridWithClassicFromPcm(params)
  }
  return analyzeBeatGridWithBeatThisSlidingWindowsFromPcm(params)
}
