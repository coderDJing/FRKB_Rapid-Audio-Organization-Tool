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
  token: number
  pausePromise: Promise<void> | null
  startAnchorSec: number
  anchorSec: number
  visualPlaybackRate: number
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
  token: 0,
  pausePromise: null,
  startAnchorSec: 0,
  anchorSec: 0,
  visualPlaybackRate: 1,
  cueCommittedDuringDrag: false
})
