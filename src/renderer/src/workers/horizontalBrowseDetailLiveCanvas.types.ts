import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'
import type { SongBeatGridMap } from '@shared/songBeatGridMap'

type HorizontalBrowseDetailLiveCanvasRawSlot = 'live'
type HorizontalBrowseDetailLiveCanvasDirection = 'up' | 'down'
type HorizontalBrowseDetailLiveCanvasWaveformRenderStyle = 'columns' | 'raw-curve'

export type HorizontalBrowseDetailLiveCanvasLoopRange = {
  startSec: number
  endSec: number
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
  beatGridMap?: SongBeatGridMap | null
  beatGridEditMode?: boolean
  beatGridVisibleFromSec?: number | null
  beatGridSelectedBoundarySec?: number | null
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
      }
    }
  | {
      type: 'presentation'
      payload: {
        renderToken: number
        offsetCssPx: number
      }
    }
