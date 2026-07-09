import { normalizeStructureGrid, type BuildSongStructureInput } from './songStructureCommon'

export const diagnoseSongStructureAnalysisFailure = (input: BuildSongStructureInput): string => {
  const waveformData = input.waveformData
  const grid = normalizeStructureGrid(input)
  if (!waveformData) return 'missing waveform data'
  if (!grid) return `invalid grid input (hasDynamicGrid=${input.beatGridMap ? 'true' : 'false'})`

  const durationSec = Math.max(0, Number(waveformData.duration) || 0)
  const detailFrames = waveformData.height?.length || 0
  if (durationSec <= 0) return 'invalid waveform duration'
  if (detailFrames <= 0) return 'missing waveform frames'
  return 'structure builder returned empty result'
}
