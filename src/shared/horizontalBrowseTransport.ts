export const HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT =
  'horizontal-browse-transport:snapshot-updated'

export type HorizontalBrowseDeckKey = 'top' | 'bottom'

export type HorizontalBrowseTransportDeckInput = {
  filePath?: string
  title?: string
  bpm?: number
  firstBeatMs?: number
  timeBasisOffsetMs?: number
  durationSec: number
  currentSec: number
  lastObservedAtMs: number
  playing: boolean
  playbackRate: number
  masterTempoEnabled: boolean
}

export type HorizontalBrowseTransportBeatGridInput = {
  filePath?: string
  bpm?: number
  firstBeatMs?: number
  timeBasisOffsetMs?: number
}

export type HorizontalBrowseTransportStateInput = {
  nowMs?: number
  top: HorizontalBrowseTransportDeckInput
  bottom: HorizontalBrowseTransportDeckInput
}

export type HorizontalBrowseTransportDeckSnapshot = {
  deck: string
  label: string
  loaded: boolean
  decoding: boolean
  playing: boolean
  currentSec: number
  durationSec: number
  playbackRate: number
  masterTempoEnabled: boolean
  bpm: number
  effectiveBpm: number
  renderCurrentSec: number
  syncEnabled: boolean
  syncLock: string
  leader: boolean
  loopActive: boolean
  loopBeatValue: number
  loopStartBeatIndex?: number
  loopStartSec: number
  loopEndSec: number
}

export type HorizontalBrowseTransportOutputSnapshot = {
  crossfaderValue: number
  masterGain: number
  topDeckGain: number
  bottomDeckGain: number
}

export type HorizontalBrowseTransportSnapshot = {
  leaderDeck?: string
  top: HorizontalBrowseTransportDeckSnapshot
  bottom: HorizontalBrowseTransportDeckSnapshot
  output: HorizontalBrowseTransportOutputSnapshot
}

export type HorizontalBrowseTransportVisualizerSnapshot = {
  timeDomainData: number[]
}

export const createEmptyHorizontalBrowseTransportDeckSnapshot = (
  deck: HorizontalBrowseDeckKey
): HorizontalBrowseTransportDeckSnapshot => ({
  deck,
  label: '',
  playing: false,
  currentSec: 0,
  durationSec: 0,
  loaded: false,
  decoding: false,
  playbackRate: 1,
  masterTempoEnabled: true,
  bpm: 0,
  effectiveBpm: 0,
  renderCurrentSec: 0,
  syncEnabled: false,
  syncLock: 'off',
  leader: false,
  loopActive: false,
  loopBeatValue: 8,
  loopStartBeatIndex: undefined,
  loopStartSec: 0,
  loopEndSec: 0
})

export const createEmptyHorizontalBrowseTransportSnapshot =
  (): HorizontalBrowseTransportSnapshot => ({
    leaderDeck: undefined,
    top: createEmptyHorizontalBrowseTransportDeckSnapshot('top'),
    bottom: createEmptyHorizontalBrowseTransportDeckSnapshot('bottom'),
    output: {
      crossfaderValue: 0,
      masterGain: 1,
      topDeckGain: 1,
      bottomDeckGain: 1
    }
  })
