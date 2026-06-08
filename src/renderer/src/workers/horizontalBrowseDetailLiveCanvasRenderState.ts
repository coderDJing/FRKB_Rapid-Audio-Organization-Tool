import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'

export type CanvasMetrics = {
  cssWidth: number
  cssHeight: number
  pixelRatio: number
  scaledWidth: number
  scaledHeight: number
  scaleX: number
  scaleY: number
  resized: boolean
}

export type FrameState = {
  width: number
  height: number
  firstBeatMs: number
  timeBasisOffsetMs: number
  rangeStartSec: number
  rangeDurationSec: number
  rawData: RawWaveformData | null
  rawRevision: number
  maxSamplesPerPixel: number
  showDetailHighlights: boolean
  showCenterLine: boolean
  showBackground: boolean
  waveformLayout: 'full' | 'top-half' | 'bottom-half'
  waveformRenderStyle: 'columns' | 'raw-curve'
  preferRawPeaksOnly: boolean
  themeVariant: 'light' | 'dark'
  waveformGain: number
  playbackSyncRevision: number
}

export type PlaybackAnimationState = {
  token: number
  request: HorizontalBrowseDetailLiveCanvasRenderRequest
  baseSeconds: number
  startedAtMs: number
  lastRenderedAtMs: number
  scrollReuseSuppressedFrames: number
}

export type WorkerAnimationFrameScope = typeof globalThis & {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
}
