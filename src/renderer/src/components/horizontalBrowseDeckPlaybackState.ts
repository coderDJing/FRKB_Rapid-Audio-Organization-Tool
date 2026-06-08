export type DeckWaveformDragEndPayload = {
  anchorSec: number
  committed: boolean
}

export type DeckWaveformScrubPreviewPayload = {
  anchorSec: number
  playbackRate: number
}

export type DeckWaveformDragState = {
  active: boolean
  wasPlaying: boolean
  syncEnabledBefore: boolean
  token: number
  pausePromise: Promise<void> | null
  startAnchorSec: number
  anchorSec: number
  cueCommittedDuringDrag: boolean
}

export type DeckSeekRequest = {
  token: number
  seconds: number
  source: string
  alignToLeader: boolean
}

export type DeckScrubPreviewRequest = {
  token: number
  active: boolean
  anchorSec: number
  playbackRate: number
}

export const createDefaultDeckWaveformDragState = (): DeckWaveformDragState => ({
  active: false,
  wasPlaying: false,
  syncEnabledBefore: false,
  token: 0,
  pausePromise: null,
  startAnchorSec: 0,
  anchorSec: 0,
  cueCommittedDuringDrag: false
})
