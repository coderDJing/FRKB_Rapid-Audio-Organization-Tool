import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'

type RenderMissFrameState = {
  width: number
  height: number
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
  timeBasisOffsetMs: number
  rangeDurationSec: number
  rawData: RawWaveformData | null
  showDetailHighlights: boolean
  showCenterLine: boolean
  showBackground: boolean
  showBeatGrid: boolean
  waveformLayout: 'full' | 'top-half' | 'bottom-half'
  waveformRenderStyle: 'columns' | 'raw-curve'
  preferRawPeaksOnly: boolean
  themeVariant: 'light' | 'dark'
}

export const canPreserveHorizontalBrowseWaveformAfterRenderMiss = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  state: RenderMissFrameState,
  previousFrame: RenderMissFrameState | null
) => {
  if (request.playbackActive !== true || !previousFrame || !state.rawData) return false
  return (
    previousFrame.width === state.width &&
    previousFrame.height === state.height &&
    previousFrame.bpm === state.bpm &&
    (request.phaseAwareScrollReuse === true || previousFrame.firstBeatMs === state.firstBeatMs) &&
    previousFrame.barBeatOffset === state.barBeatOffset &&
    previousFrame.timeBasisOffsetMs === state.timeBasisOffsetMs &&
    previousFrame.rangeDurationSec === state.rangeDurationSec &&
    previousFrame.rawData === state.rawData &&
    previousFrame.showDetailHighlights === state.showDetailHighlights &&
    previousFrame.showCenterLine === state.showCenterLine &&
    previousFrame.showBackground === state.showBackground &&
    previousFrame.showBeatGrid === state.showBeatGrid &&
    previousFrame.waveformLayout === state.waveformLayout &&
    previousFrame.waveformRenderStyle === state.waveformRenderStyle &&
    previousFrame.preferRawPeaksOnly === state.preferRawPeaksOnly &&
    previousFrame.themeVariant === state.themeVariant
  )
}
