import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'

const cloneRawData = (rawData: RawWaveformData): RawWaveformData => ({
  duration: Math.max(0, Number(rawData.duration) || 0),
  sampleRate: Math.max(0, Number(rawData.sampleRate) || 0),
  rate: Math.max(0, Number(rawData.rate) || 0),
  frames: Math.max(0, Number(rawData.frames) || 0),
  startSec: Math.max(0, Number(rawData.startSec) || 0),
  loadedFrames: Math.max(0, Number(rawData.loadedFrames ?? rawData.frames) || 0),
  minLeft: rawData.minLeft,
  maxLeft: rawData.maxLeft,
  minRight: rawData.minRight,
  maxRight: rawData.maxRight,
  meanLeft: rawData.meanLeft,
  meanRight: rawData.meanRight,
  rmsLeft: rawData.rmsLeft,
  rmsRight: rawData.rmsRight,
  compactColorIndex: rawData.compactColorIndex,
  compactColorLow: rawData.compactColorLow,
  compactColorMid: rawData.compactColorMid,
  compactColorHigh: rawData.compactColorHigh,
  compactColorRed: rawData.compactColorRed,
  compactColorGreen: rawData.compactColorGreen,
  compactColorBlue: rawData.compactColorBlue,
  compactColorRateDivisor: rawData.compactColorRateDivisor,
  compactColorStartFrame: rawData.compactColorStartFrame
})

export const createHorizontalBrowseDetailLiveCanvasRawStore = (
  invalidateFrameState: () => void
) => {
  let liveRawData: RawWaveformData | null = null
  let liveRawRevision = 0

  const replace = (rawData: RawWaveformData | null) => {
    liveRawData = rawData ? cloneRawData(rawData) : null
    liveRawRevision += 1
    invalidateFrameState()
  }

  const resolveForRender = (rawSlot: HorizontalBrowseDetailLiveCanvasRenderRequest['rawSlot']) =>
    rawSlot === 'live' ? liveRawData : null

  const resolveRevisionForRender = (rawData: RawWaveformData | null) =>
    rawData && rawData === liveRawData ? liveRawRevision : 0

  const clear = () => {
    liveRawData = null
    liveRawRevision = 0
  }

  return {
    clear,
    replace,
    resolveForRender,
    resolveRevisionForRender
  }
}
