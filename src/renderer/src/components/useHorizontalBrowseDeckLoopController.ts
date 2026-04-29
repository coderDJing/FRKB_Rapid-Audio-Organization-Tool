import type { ISongHotCue, ISongMemoryCue, ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import type { Ref } from 'vue'
import { resolveSongCueTimelineDefinition } from '@shared/songCueTimeBasis'

type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
  durationSec: number
  startBeatIndex: number
  beatValue: number
}

export type HorizontalBrowseStoredCueDefinition = Pick<
  ISongMemoryCue,
  'sec' | 'isLoop' | 'loopEndSec' | 'source'
>

type ToggleDeckLoopStateResult = {
  active: boolean
  shouldStartPlayback: boolean
}

type UseHorizontalBrowseDeckLoopControllerParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  nativeTransport: {
    toggleLoop: (deck: DeckKey) => Promise<unknown>
    stepLoopBeats: (deck: DeckKey, direction: -1 | 1) => Promise<unknown>
    setLoopFromRange: (deck: DeckKey, startSec: number, endSec: number) => Promise<unknown>
    clearLoop: (deck: DeckKey) => Promise<unknown>
  }
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckCuePointRef: (deck: DeckKey) => Ref<number>
}

const LOOP_DEFAULT_BEAT_VALUE = 8

const formatLoopBeatLabel = (value: number) => {
  if (value >= 1) return String(Number.isInteger(value) ? value : Number(value.toFixed(4)))
  const denominator = Math.round(1 / value)
  return `1/${denominator}`
}

export const useHorizontalBrowseDeckLoopController = (
  params: UseHorizontalBrowseDeckLoopControllerParams
) => {
  const resolveDeckLoopRange = (deck: DeckKey): HorizontalBrowseLoopRange | null => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    if (!snapshot.loopActive) return null
    const startBeatIndex = Number(snapshot.loopStartBeatIndex)
    const startSec = Number(snapshot.loopStartSec) || 0
    const endSec = Number(snapshot.loopEndSec) || 0
    const beatValue = Number(snapshot.loopBeatValue) || LOOP_DEFAULT_BEAT_VALUE
    const durationSec = Math.max(0, endSec - startSec)
    if (!Number.isFinite(startBeatIndex) || durationSec <= 0) return null
    return {
      startSec,
      endSec,
      durationSec,
      startBeatIndex,
      beatValue
    }
  }

  const resolveDeckLoopDisabled = (deck: DeckKey) => {
    const song = params.resolveDeckSong(deck)
    const bpm = Number(song?.bpm)
    return !song || !Number.isFinite(bpm) || bpm <= 0
  }

  const resolveDeckLoopBeatLabel = (deck: DeckKey) =>
    formatLoopBeatLabel(
      Number(params.resolveTransportDeckSnapshot(deck).loopBeatValue) || LOOP_DEFAULT_BEAT_VALUE
    )

  const isDeckLoopActive = (deck: DeckKey) =>
    Boolean(params.resolveTransportDeckSnapshot(deck).loopActive)

  const deactivateDeckLoop = async (deck: DeckKey) => {
    await params.nativeTransport.clearLoop(deck)
  }

  const toggleDeckLoopState = async (deck: DeckKey): Promise<ToggleDeckLoopStateResult> => {
    params.touchDeckInteraction(deck)
    if (resolveDeckLoopDisabled(deck)) {
      return { active: false, shouldStartPlayback: false }
    }
    const wasActive = isDeckLoopActive(deck)
    await params.nativeTransport.toggleLoop(deck)
    const nextRange = resolveDeckLoopRange(deck)
    if (nextRange) {
      params.resolveDeckCuePointRef(deck).value = nextRange.startSec
    }
    return {
      active: !wasActive && Boolean(nextRange),
      shouldStartPlayback: !wasActive && !params.resolveDeckPlaying(deck) && Boolean(nextRange)
    }
  }

  const handleDeckLoopStepDown = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (resolveDeckLoopDisabled(deck)) return
    await params.nativeTransport.stepLoopBeats(deck, -1)
    const nextRange = resolveDeckLoopRange(deck)
    if (nextRange) {
      params.resolveDeckCuePointRef(deck).value = nextRange.startSec
    }
  }

  const handleDeckLoopStepUp = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (resolveDeckLoopDisabled(deck)) return
    await params.nativeTransport.stepLoopBeats(deck, 1)
    const nextRange = resolveDeckLoopRange(deck)
    if (nextRange) {
      params.resolveDeckCuePointRef(deck).value = nextRange.startSec
    }
  }

  const handleDeckLoopPlaybackTick = (_deck: DeckKey) => {
    // loop 回环已迁到播放内核，renderer 不再靠 RAF 盯着时间补 seek。
  }

  const syncDeckIntoLoopRangeBeforePlay = async (_deck: DeckKey) => {
    // 播放前的 loop 对齐已迁到内核 set_playing。
  }

  const buildDeckStoredCueDefinition = (
    deck: DeckKey
  ): HorizontalBrowseStoredCueDefinition | null => {
    const cueSec = Number(params.resolveDeckCuePointRef(deck).value)
    if (!Number.isFinite(cueSec) || cueSec < 0) return null
    const loopRange = resolveDeckLoopRange(deck)
    if (loopRange) {
      return {
        sec: loopRange.startSec,
        isLoop: true,
        loopEndSec: loopRange.endSec
      }
    }
    return {
      sec: cueSec,
      isLoop: false,
      loopEndSec: undefined
    }
  }

  const applyDeckStoredCueDefinition = async (
    deck: DeckKey,
    cue:
      | HorizontalBrowseStoredCueDefinition
      | Pick<ISongHotCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
  ) => {
    const timelineCue = resolveSongCueTimelineDefinition(
      cue,
      params.resolveDeckSong(deck)?.timeBasisOffsetMs
    )
    const cueSec = timelineCue?.sec ?? Math.max(0, Number(cue?.sec) || 0)
    params.resolveDeckCuePointRef(deck).value = cueSec
    const loopEndSec = Number(timelineCue?.loopEndSec)
    const isLoop =
      Boolean(timelineCue?.isLoop) && Number.isFinite(loopEndSec) && loopEndSec > cueSec
    if (!isLoop) {
      await params.nativeTransport.clearLoop(deck)
      return null
    }
    await params.nativeTransport.setLoopFromRange(deck, cueSec, loopEndSec)
    const loopRange = resolveDeckLoopRange(deck)
    if (loopRange) {
      params.resolveDeckCuePointRef(deck).value = loopRange.startSec
    }
    return loopRange
  }

  return {
    resolveDeckLoopRange,
    resolveDeckLoopBeatLabel,
    resolveDeckLoopDisabled,
    isDeckLoopActive,
    deactivateDeckLoop,
    toggleDeckLoopState,
    handleDeckLoopStepDown,
    handleDeckLoopStepUp,
    handleDeckLoopPlaybackTick,
    syncDeckIntoLoopRangeBeforePlay,
    buildDeckStoredCueDefinition,
    applyDeckStoredCueDefinition
  }
}
