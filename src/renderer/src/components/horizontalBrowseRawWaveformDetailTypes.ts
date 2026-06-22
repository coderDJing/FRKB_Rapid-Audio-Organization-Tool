import type { HorizontalBrowseGridShiftOptions } from '@renderer/components/useHorizontalBrowseGridToolbar'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type { HorizontalBrowseGridToolbarState } from '@renderer/components/useHorizontalBrowseGridToolbar'
import type { HorizontalBrowseScrubPreviewPayload } from '@renderer/components/useHorizontalBrowseWaveformScrubPreview'
import type { HorizontalBrowseWaveformPresentationState } from '@renderer/components/horizontalBrowseWaveformPresentationCoordinator'

export type HorizontalBrowseSharedZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}

export type HorizontalBrowseDragSessionEndPayload = {
  anchorSec: number
  committed: boolean
}

export type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
}

export type HorizontalBrowseDetailZoomChangePayload = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down'
  anchorSec?: number
  viewportStartSec?: number
  visibleDurationSec?: number
  timeScale?: number
}

export type HorizontalBrowseWaveformLayout = 'auto' | 'full'
export type HorizontalBrowseWaveformRenderStyle = 'columns' | 'raw-curve'

export type HorizontalBrowseRawWaveformDetailProps = {
  song: ISongInfo | null
  direction: 'up' | 'down'
  sharedZoomState?: HorizontalBrowseSharedZoomState
  currentSeconds?: number
  playing?: boolean
  playbackActive?: boolean
  playbackRate?: number
  visualPlaybackRate?: number
  waveformGain?: number
  playbackSyncRevision?: number
  gridBpm?: number
  loopRange?: HorizontalBrowseLoopRange | null
  cueSeconds?: number
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
  seekTargetSeconds?: number
  seekRevision?: number
  linkedDragActive?: boolean
  linkedDragAnchorSec?: number | null
  linkedGridActive?: boolean
  linkedGridVisualPending?: boolean
  presentationState?: HorizontalBrowseWaveformPresentationState
  maxZoom?: number
  waveformLayout?: HorizontalBrowseWaveformLayout
  waveformRenderStyle?: HorizontalBrowseWaveformRenderStyle
  allowNegativeTimeline?: boolean
}

export type HorizontalBrowseRawWaveformDetailEmit = {
  (event: 'toolbar-state-change', value: HorizontalBrowseGridToolbarState): void
  (event: 'zoom-change', value: HorizontalBrowseDetailZoomChangePayload): void
  (event: 'drag-session-start'): void
  (event: 'drag-session-preview', value: HorizontalBrowseScrubPreviewPayload): void
  (event: 'drag-session-end', value: HorizontalBrowseDragSessionEndPayload): void
  (event: 'edit-waveform-loading-change', value: boolean): void
}

export type HorizontalBrowseRawWaveformDetailExpose = {
  toggleBarLinePicking: () => void
  setBarLineAtPlayhead: () => void
  shiftGridSmallLeft: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridLargeLeft: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallRight: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridLargeRight: (options?: HorizontalBrowseGridShiftOptions) => void
  updateBpmInput: (value: string) => void
  blurBpmInput: () => void
  tapBpm: () => void
  cycleMetronomeState: () => void
  prepareStableFrameForAnchor: (
    seconds: number,
    options?: { timeoutMs?: number }
  ) => Promise<boolean>
  commitLinkedGridVisualTransaction: () => boolean
}
