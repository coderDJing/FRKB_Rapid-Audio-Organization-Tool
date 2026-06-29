import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'

type HorizontalBrowseDetailLiveCanvasRawSlot = 'live'
type HorizontalBrowseDetailLiveCanvasDirection = 'up' | 'down'
type HorizontalBrowseDetailLiveCanvasWaveformRenderStyle = 'columns' | 'raw-curve'

export type HorizontalBrowseDetailLiveCanvasLoopRange = {
  startSec: number
  endSec: number
}

export type HorizontalBrowseDetailLiveCanvasRenderedDiagnostics = {
  readySource: 'rendered' | 'preserved' | 'not-ready'
  request: {
    width: number
    height: number
    pixelRatio: number
    renderTargetIndex?: number
    renderSourceIndex?: number
    renderViewportOnly: boolean
    stableWaveformSource: boolean
    waveformLayout: 'full' | 'top-half' | 'bottom-half'
    waveformRenderStyle: HorizontalBrowseDetailLiveCanvasWaveformRenderStyle
    rawSlotPresent: boolean
    playbackActive: boolean
  }
  metrics: {
    present: boolean
    cssWidth?: number
    cssHeight?: number
    scaledWidth?: number
    scaledHeight?: number
    pixelRatio?: number
    resized?: boolean
  }
  rawData: {
    present: boolean
    startSec?: number
    durationSec?: number
    rate?: number
    frames?: number
    loadedFrames?: number
  }
  canvas: {
    present: boolean
    width?: number
    height?: number
  }
  previousFramePresent: boolean
  holdMissingPlaybackRaw: boolean
  shouldPreserve: boolean
  pixelSample: {
    sampled: boolean
    reason?: 'not-ready' | 'playback-active' | 'missing-context' | 'read-failed'
    sampleColumns?: number
    sampledPixels?: number
    nonTransparentPixels?: number
    nonTransparentRatio?: number
    nonZeroRgbPixels?: number
    maxAlpha?: number
    maxRgb?: number
  }
}

export type HorizontalBrowseDetailLiveCanvasRenderRequest = {
  renderToken: number
  renderPriority?: 'normal' | 'immediate'
  renderTargetIndex?: number
  renderSourceIndex?: number
  renderViewportOnly?: boolean
  width: number
  height: number
  pixelRatio: number
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
  timeBasisOffsetMs: number
  rangeStartSec: number
  rangeDurationSec: number
  viewportWidth?: number
  viewportRangeStartSec?: number
  viewportRangeDurationSec?: number
  maxSamplesPerPixel: number
  showDetailHighlights: boolean
  showCenterLine: boolean
  showBackground: boolean
  showBeatGrid: boolean
  allowScrollReuse: boolean
  phaseAwareScrollReuse: boolean
  presentationOffsetMode?: 'free' | 'device-pixel' | 'none'
  stableWaveformSource?: boolean
  waveformLayout: 'full' | 'top-half' | 'bottom-half'
  waveformRenderStyle: HorizontalBrowseDetailLiveCanvasWaveformRenderStyle
  preferRawPeaksOnly: boolean
  showTimelinePlaceholder: boolean
  themeVariant: 'light' | 'dark'
  rawSlot: HorizontalBrowseDetailLiveCanvasRawSlot | null
  direction: HorizontalBrowseDetailLiveCanvasDirection
  cueSeconds: number | null
  hotCues: ISongHotCue[]
  memoryCues: ISongMemoryCue[]
  loopRange: HorizontalBrowseDetailLiveCanvasLoopRange | null
  cueAccentColor: string
  playbackActive: boolean
  playbackSeconds: number
  playbackSyncRevision: number
  playbackRate: number
  playbackRenderClockEpochMs?: number | null
  playbackDurationSec: number
  waveformGain: number
}

export type HorizontalBrowseDetailLiveCanvasWorkerIncoming =
  | {
      type: 'attachCanvas'
      payload: {
        waveformCanvas: OffscreenCanvas
        overlayCanvas: OffscreenCanvas
        waveformCanvases?: OffscreenCanvas[]
        overlayCanvases?: OffscreenCanvas[]
      }
    }
  | {
      type: 'clear'
    }
  | {
      type: 'clearRaw'
    }
  | {
      type: 'stopPlayback'
    }
  | {
      type: 'replaceRaw'
      payload: {
        data: RawWaveformData | null
      }
    }
  | {
      type: 'render'
      payload: HorizontalBrowseDetailLiveCanvasRenderRequest
    }

export type HorizontalBrowseDetailLiveCanvasWorkerOutgoing =
  | {
      type: 'rendered'
      payload: {
        renderToken: number
        rangeStartSec: number
        rangeDurationSec: number
        ready: boolean
        renderViewportOnly?: boolean
        renderTargetIndex?: number
        stableWaveformSource?: boolean
        notReadyReason?: 'missing-metrics' | 'missing-raw-data' | 'render-full-frame-failed'
        diagnostics?: HorizontalBrowseDetailLiveCanvasRenderedDiagnostics
      }
    }
  | {
      type: 'presentation'
      payload: {
        renderToken: number
        offsetCssPx: number
      }
    }
