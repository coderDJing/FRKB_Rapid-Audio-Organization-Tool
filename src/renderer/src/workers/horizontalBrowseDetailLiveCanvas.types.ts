import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'

export type HorizontalBrowseDetailLiveCanvasRawSlot = 'live' | 'retained'
export type HorizontalBrowseDetailLiveCanvasDirection = 'up' | 'down'

export type HorizontalBrowseDetailLiveCanvasLoopRange = {
  startSec: number
  endSec: number
}

export type HorizontalBrowseDetailLiveCanvasRawMeta = {
  duration: number
  sampleRate: number
  rate: number
  frames: number
  startSec: number
  loadedFrames?: number
}

export type HorizontalBrowseDetailLiveCanvasRawChunk = HorizontalBrowseDetailLiveCanvasRawMeta & {
  startFrame: number
  chunkFrames: number
  minLeft: Float32Array
  maxLeft: Float32Array
  minRight: Float32Array
  maxRight: Float32Array
}

export type HorizontalBrowseDetailLiveCanvasRenderRequest = {
  renderToken: number
  width: number
  height: number
  pixelRatio: number
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
  timeBasisOffsetMs: number
  rangeStartSec: number
  rangeDurationSec: number
  maxSamplesPerPixel: number
  showDetailHighlights: boolean
  showCenterLine: boolean
  showBackground: boolean
  showBeatGrid: boolean
  allowScrollReuse: boolean
  phaseAwareScrollReuse: boolean
  waveformLayout: 'top-half' | 'bottom-half'
  preferRawPeaksOnly: boolean
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
  playbackDurationSec: number
  dirtyStartSec?: number
  dirtyEndSec?: number
}

export type HorizontalBrowseDetailLiveCanvasWorkerIncoming =
  | {
      type: 'attachCanvas'
      payload: {
        waveformCanvas: OffscreenCanvas
        overlayCanvas: OffscreenCanvas
      }
    }
  | {
      type: 'clear'
    }
  | {
      type: 'clearRaw'
    }
  | {
      type: 'resetRaw'
      payload: HorizontalBrowseDetailLiveCanvasRawMeta & {
        retainCurrent?: boolean
      }
    }
  | {
      type: 'ensureRawCapacity'
      payload: HorizontalBrowseDetailLiveCanvasRawMeta
    }
  | {
      type: 'applyRawChunk'
      payload: HorizontalBrowseDetailLiveCanvasRawChunk
    }
  | {
      type: 'replaceRaw'
      payload: {
        data: RawWaveformData | null
      }
    }
  | {
      type: 'updateRawMeta'
      payload: Partial<HorizontalBrowseDetailLiveCanvasRawMeta>
    }
  | {
      type: 'render'
      payload: HorizontalBrowseDetailLiveCanvasRenderRequest
    }

export type HorizontalBrowseDetailLiveCanvasWorkerOutgoing = {
  type: 'rendered'
  payload: {
    renderToken: number
    rangeStartSec: number
    rangeDurationSec: number
    ready: boolean
  }
}
