import {
  BEATS_PER_BAR,
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  PHRASE_BARS,
  clamp,
  clamp01,
  normalizeStructureGrid,
  readByteRatio,
  toFixedNumber,
  type SongStructureAnalysis
} from './songStructureCommon'
import type { UnifiedDisplayWaveformDetailData } from './unifiedDisplayWaveform'

type NormalizedStructureGrid = NonNullable<ReturnType<typeof normalizeStructureGrid>>

const summarizeByteRange = (
  values: Uint8Array | undefined,
  startFrame: number,
  endFrame: number
) => {
  if (!values?.length || endFrame <= startFrame) return 0
  const start = clamp(Math.floor(startFrame), 0, values.length - 1)
  const end = clamp(Math.ceil(endFrame), start + 1, values.length)
  let sum = 0
  let peak = 0
  for (let index = start; index < end; index += 1) {
    const value = readByteRatio(values, index)
    sum += value
    peak = Math.max(peak, value)
  }
  return clamp01((sum / Math.max(1, end - start)) * 0.76 + peak * 0.24)
}

const resolveFixedEndBar = (durationSec: number, grid: NormalizedStructureGrid) => {
  const beatSec = 60 / grid.bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return 1
  const firstBeatSec = grid.firstBeatMs / 1000
  const beatIndex = Math.round((Math.max(0, durationSec - beatSec) - firstBeatSec) / beatSec)
  return Math.max(1, Math.floor((beatIndex - grid.barBeatOffset) / BEATS_PER_BAR) + 1)
}

const resolveDynamicEndBar = (durationSec: number, barLines: readonly number[] | undefined) => {
  if (!barLines?.length) return null
  let count = 0
  for (const lineSec of barLines) {
    if (lineSec <= durationSec + 0.0001) count += 1
    else break
  }
  return Math.max(1, count)
}

export const buildWholeSongStructureAnalysis = (
  waveformData: UnifiedDisplayWaveformDetailData,
  durationSec: number,
  grid: NormalizedStructureGrid,
  beatGridSignature?: string,
  barLines?: readonly number[]
): SongStructureAnalysis => {
  const detailRate = Math.max(1, Number(waveformData.detailRate) || 1)
  const endFrame = Math.ceil(durationSec * detailRate)
  const energy = summarizeByteRange(waveformData.height, 0, endFrame)
  const low = summarizeByteRange(waveformData.colorLow, 0, endFrame)
  const high = summarizeByteRange(waveformData.colorHigh, 0, endFrame)
  const endBar =
    resolveDynamicEndBar(durationSec, barLines) ?? resolveFixedEndBar(durationSec, grid)

  return {
    algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
    source: 'algorithmic',
    durationSec: toFixedNumber(durationSec, 3),
    bpm: grid.bpm,
    firstBeatMs: grid.firstBeatMs,
    barBeatOffset: grid.barBeatOffset,
    beatGridSignature,
    phraseBars: PHRASE_BARS,
    sections: [
      {
        startSec: 0,
        endSec: toFixedNumber(durationSec, 3),
        startBar: 1,
        endBar,
        phraseIndex: 0,
        kind: 'groove',
        confidence: 0.35,
        energy: toFixedNumber(energy, 3),
        low: toFixedNumber(low, 3),
        high: toFixedNumber(high, 3),
        novelty: 0
      }
    ]
  }
}
