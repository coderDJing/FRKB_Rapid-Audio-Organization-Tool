import type { HorizontalBrowseGridShiftOptions } from '@renderer/components/useHorizontalBrowseGridToolbar'

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

export type HorizontalBrowseWaveformLayout = 'auto' | 'full'
export type HorizontalBrowseWaveformRenderStyle = 'columns' | 'raw-curve'

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
  toggleMetronome: () => void
  cycleMetronomeVolume: () => void
}
