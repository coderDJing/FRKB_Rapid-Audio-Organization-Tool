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
