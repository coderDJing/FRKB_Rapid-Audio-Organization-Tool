import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { HorizontalBrowseDetailLiveCanvasLoopRange } from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'

type HorizontalBrowseLoopRangeInput = {
  startSec?: number | null
  endSec?: number | null
}

export const hasHorizontalBrowseDrawableRawFrames = (rawData: RawWaveformData | null) => {
  if (!rawData) return false
  return Math.max(0, Math.floor(Number(rawData.loadedFrames ?? rawData.frames) || 0)) > 0
}

export const resolveHorizontalBrowseWorkerLoopRange = (
  loopRange: HorizontalBrowseLoopRangeInput | null | undefined
): HorizontalBrowseDetailLiveCanvasLoopRange | null => {
  if (!loopRange) return null
  const startSec = Math.max(0, Number(loopRange.startSec) || 0)
  const endSec = Math.max(startSec, Number(loopRange.endSec ?? loopRange.startSec) || startSec)
  return {
    startSec,
    endSec
  }
}
