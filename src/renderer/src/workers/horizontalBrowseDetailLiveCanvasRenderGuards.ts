import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'

type RenderMissFrameState = {
  width: number
  height: number
  firstBeatMs: number
  timeBasisOffsetMs: number
  rangeStartSec: number
  rangeDurationSec: number
  rawData: RawWaveformData | null
  showDetailHighlights: boolean
  showCenterLine: boolean
  showBackground: boolean
  waveformLayout: 'full' | 'top-half' | 'bottom-half'
  waveformRenderStyle: 'columns' | 'raw-curve'
  preferRawPeaksOnly: boolean
  themeVariant: 'light' | 'dark'
  playbackSyncRevision: number
}

const PLAYBACK_SYNC_TOLERANCE_SEC = 0.02
const MISSING_RAW_FRAME_PRESERVE_MAX_DELTA_SEC = 0.35
const MISSING_RAW_FRAME_PRESERVE_MAX_VISIBLE_RATIO = 0.035

export const canPreserveHorizontalBrowseWaveformAfterRenderMiss = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  state: RenderMissFrameState,
  previousFrame: RenderMissFrameState | null
) => {
  if (request.playbackActive !== true || !previousFrame || !state.rawData) return false
  return (
    previousFrame.width === state.width &&
    previousFrame.height === state.height &&
    (request.phaseAwareScrollReuse === true || previousFrame.firstBeatMs === state.firstBeatMs) &&
    previousFrame.timeBasisOffsetMs === state.timeBasisOffsetMs &&
    previousFrame.rangeDurationSec === state.rangeDurationSec &&
    previousFrame.rawData === state.rawData &&
    previousFrame.showDetailHighlights === state.showDetailHighlights &&
    previousFrame.showCenterLine === state.showCenterLine &&
    previousFrame.showBackground === state.showBackground &&
    previousFrame.waveformLayout === state.waveformLayout &&
    previousFrame.waveformRenderStyle === state.waveformRenderStyle &&
    previousFrame.preferRawPeaksOnly === state.preferRawPeaksOnly &&
    previousFrame.themeVariant === state.themeVariant
  )
}

export const canPreservePlaybackFrameOnMissingRaw = (
  state: RenderMissFrameState,
  previousFrame: RenderMissFrameState | null
) => {
  if (!previousFrame || state.rawData) return false
  const maxRangeDeltaSec = Math.min(
    MISSING_RAW_FRAME_PRESERVE_MAX_DELTA_SEC,
    Math.max(
      PLAYBACK_SYNC_TOLERANCE_SEC,
      state.rangeDurationSec * MISSING_RAW_FRAME_PRESERVE_MAX_VISIBLE_RATIO
    )
  )
  return (
    previousFrame.width === state.width &&
    previousFrame.height === state.height &&
    previousFrame.firstBeatMs === state.firstBeatMs &&
    previousFrame.timeBasisOffsetMs === state.timeBasisOffsetMs &&
    previousFrame.rangeDurationSec === state.rangeDurationSec &&
    Math.abs(previousFrame.rangeStartSec - state.rangeStartSec) <= maxRangeDeltaSec &&
    previousFrame.showDetailHighlights === state.showDetailHighlights &&
    previousFrame.showCenterLine === state.showCenterLine &&
    previousFrame.showBackground === state.showBackground &&
    previousFrame.waveformLayout === state.waveformLayout &&
    previousFrame.waveformRenderStyle === state.waveformRenderStyle &&
    previousFrame.preferRawPeaksOnly === state.preferRawPeaksOnly &&
    previousFrame.themeVariant === state.themeVariant &&
    previousFrame.playbackSyncRevision === state.playbackSyncRevision
  )
}
