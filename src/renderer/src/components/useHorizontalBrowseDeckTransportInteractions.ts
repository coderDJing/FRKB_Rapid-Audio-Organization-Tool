import { reactive, watch, type Ref } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import {
  beginHorizontalBrowseDeckAction,
  resolveHorizontalBrowseDeckActionElapsedMs
} from '@renderer/components/horizontalBrowseInteractionTimeline'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/components/horizontalBrowseInteractionTrace'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'

type DeckKey = HorizontalBrowseDeckKey

type DeckWaveformDragEndPayload = {
  anchorSec: number
  committed: boolean
}

type DeckCuePreviewState = {
  active: boolean
  pointerId: number | null
  cueSeconds: number
  syncEnabledBefore: boolean
  syncLockBefore: string
  token: number
}

type DeckWaveformDragState = {
  active: boolean
  wasPlaying: boolean
  syncEnabledBefore: boolean
  token: number
}

type DeckLoopState = {
  active: boolean
  beatValue: number
  startBeatIndex: number | null
  requestToken: number
  seekPending: boolean
}

type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
  durationSec: number
  startBeatIndex: number
  beatValue: number
}

type DeckTransportStateOverride = Partial<{
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
}>

type UseHorizontalBrowseDeckTransportInteractionsParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
  nativeTransport: {
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
    seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
    beatsync: (deck: DeckKey) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
  }
  syncDeckRenderState: () => void
  commitDeckStateToNative: (
    deck: DeckKey,
    override?: DeckTransportStateOverride
  ) => Promise<unknown>
  commitDeckStatesToNative: (
    overrides?: Partial<Record<DeckKey, DeckTransportStateOverride>>
  ) => Promise<unknown>
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckGridBpm: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckRenderCurrentSeconds: (deck: DeckKey) => number
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckLoaded: (deck: DeckKey) => boolean
  resolveDeckDecoding: (deck: DeckKey) => boolean
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckCuePointRef: (deck: DeckKey) => Ref<number>
  resolveDeckCuePlacementSec: (deck: DeckKey) => number
}

const CUE_POINT_TRIGGER_EPSILON_SEC = 0.05
const BAR_JUMP_BEATS = 4
const LOOP_END_EPSILON_SEC = 0.0005
const LOOP_POSITION_EPSILON_SEC = 0.0001
const LOOP_BEAT_INDEX_EPSILON = 1e-6
const LOOP_BEAT_VALUES = [
  1 / 64,
  1 / 32,
  1 / 16,
  1 / 8,
  1 / 4,
  1 / 2,
  1,
  2,
  4,
  8,
  16,
  32,
  64,
  128,
  256,
  512
] as const
const LOOP_DEFAULT_BEAT_VALUE = 8

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const createDefaultDeckCuePreviewState = (): DeckCuePreviewState => ({
  active: false,
  pointerId: null,
  cueSeconds: 0,
  syncEnabledBefore: false,
  syncLockBefore: 'off',
  token: 0
})

const createDefaultDeckWaveformDragState = (): DeckWaveformDragState => ({
  active: false,
  wasPlaying: false,
  syncEnabledBefore: false,
  token: 0
})

const createDefaultDeckLoopState = (): DeckLoopState => ({
  active: false,
  beatValue: LOOP_DEFAULT_BEAT_VALUE,
  startBeatIndex: null,
  requestToken: 0,
  seekPending: false
})

const formatLoopBeatLabel = (value: number) => {
  if (value >= 1) return String(Number.isInteger(value) ? value : Number(value.toFixed(4)))
  const denominator = Math.round(1 / value)
  return `1/${denominator}`
}

const resolveLoopBeatValueIndex = (value: number) => {
  const target = Number(value)
  const exactIndex = LOOP_BEAT_VALUES.findIndex((candidate) => Math.abs(candidate - target) <= 1e-9)
  if (exactIndex >= 0) return exactIndex
  return LOOP_BEAT_VALUES.findIndex((candidate) => candidate >= target)
}

export const useHorizontalBrowseDeckTransportInteractions = (
  params: UseHorizontalBrowseDeckTransportInteractionsParams
) => {
  type DeckStoredCueDefinition = Pick<ISongMemoryCue, 'sec' | 'isLoop' | 'loopEndSec'>

  const deckCuePreviewState = reactive<Record<DeckKey, DeckCuePreviewState>>({
    top: createDefaultDeckCuePreviewState(),
    bottom: createDefaultDeckCuePreviewState()
  })
  const deckWaveformDragState = reactive<Record<DeckKey, DeckWaveformDragState>>({
    top: createDefaultDeckWaveformDragState(),
    bottom: createDefaultDeckWaveformDragState()
  })
  const deckPendingPlayOnLoad = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  const deckPendingCuePreviewOnLoad = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  const suppressDeckCueClick = reactive<Record<DeckKey, boolean>>({ top: false, bottom: false })
  const deckLoopState = reactive<Record<DeckKey, DeckLoopState>>({
    top: createDefaultDeckLoopState(),
    bottom: createDefaultDeckLoopState()
  })

  const resolveDeckLoopGridSnapshot = (deck: DeckKey) => {
    const bpm = Number(params.resolveDeckGridBpm(deck))
    if (!Number.isFinite(bpm) || bpm <= 0) return null
    const beatSec = 60 / bpm
    if (!Number.isFinite(beatSec) || beatSec <= 0) return null
    const durationSec = Number(params.resolveDeckDurationSeconds(deck))
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null
    const firstBeatMs = Number(params.resolveDeckSong(deck)?.firstBeatMs) || 0
    return {
      beatSec,
      firstBeatSec: Math.max(0, firstBeatMs) / 1000,
      durationSec
    }
  }

  const resolveDeckLoopRange = (deck: DeckKey): HorizontalBrowseLoopRange | null => {
    const loopState = deckLoopState[deck]
    if (!loopState.active || loopState.startBeatIndex === null) return null
    const grid = resolveDeckLoopGridSnapshot(deck)
    if (!grid) return null

    const rawStartSec = grid.firstBeatSec + loopState.startBeatIndex * grid.beatSec
    const rawEndSec = rawStartSec + loopState.beatValue * grid.beatSec
    const clampedStartSec = rawEndSec <= 0 ? 0 : clampNumber(rawStartSec, 0, grid.durationSec)
    const clampedEndSec =
      rawEndSec <= 0
        ? clampNumber(loopState.beatValue * grid.beatSec, 0, grid.durationSec)
        : clampNumber(rawEndSec, clampedStartSec, grid.durationSec)
    const durationSec = Math.max(0, clampedEndSec - clampedStartSec)
    if (!Number.isFinite(durationSec) || durationSec <= LOOP_POSITION_EPSILON_SEC) return null

    return {
      startSec: clampedStartSec,
      endSec: clampedEndSec,
      durationSec,
      startBeatIndex: loopState.startBeatIndex,
      beatValue: loopState.beatValue
    }
  }

  const resolveDeckLoopAnchorSeconds = (deck: DeckKey) =>
    params.resolveDeckPlaying(deck)
      ? params.resolveDeckRenderCurrentSeconds(deck)
      : params.resolveDeckCurrentSeconds(deck)

  const resolveDeckLoopStartBeatIndex = (deck: DeckKey, anchorSec: number) => {
    const grid = resolveDeckLoopGridSnapshot(deck)
    if (!grid) return null
    const beatsFromFirst = (anchorSec - grid.firstBeatSec) / grid.beatSec
    if (!Number.isFinite(beatsFromFirst)) return null
    return Math.floor(beatsFromFirst + LOOP_BEAT_INDEX_EPSILON)
  }

  const resolveDeckLoopDisabled = (deck: DeckKey) =>
    !params.resolveDeckSong(deck) || resolveDeckLoopGridSnapshot(deck) === null

  const resolveDeckLoopBeatLabel = (deck: DeckKey) =>
    formatLoopBeatLabel(deckLoopState[deck].beatValue)
  const isDeckLoopActive = (deck: DeckKey) => deckLoopState[deck].active

  const queueDeckLoopSeek = (deck: DeckKey, targetSec: number) => {
    const loopState = deckLoopState[deck]
    const token = loopState.requestToken + 1
    loopState.requestToken = token
    loopState.seekPending = true
    void params.nativeTransport
      .seek(deck, Math.max(0, targetSec))
      .then(() => {
        if (deckLoopState[deck].requestToken !== token) return
        deckLoopState[deck].seekPending = false
        params.syncDeckRenderState()
      })
      .catch(() => {
        if (deckLoopState[deck].requestToken !== token) return
        deckLoopState[deck].seekPending = false
      })
  }

  const deactivateDeckLoop = (deck: DeckKey) => {
    const loopState = deckLoopState[deck]
    loopState.active = false
    loopState.startBeatIndex = null
    loopState.requestToken += 1
    loopState.seekPending = false
  }

  const maybeRestartDeckLoopAfterBeatChange = (deck: DeckKey) => {
    const loopRange = resolveDeckLoopRange(deck)
    if (!loopRange) {
      deactivateDeckLoop(deck)
      return
    }
    params.resolveDeckCuePointRef(deck).value = loopRange.startSec
    const currentSec = resolveDeckLoopAnchorSeconds(deck)
    const hasReachedLaterHalf =
      params.resolveDeckPlaying(deck) &&
      currentSec >= loopRange.startSec + loopRange.durationSec * 0.5 - LOOP_POSITION_EPSILON_SEC
    if (
      currentSec < loopRange.startSec + LOOP_POSITION_EPSILON_SEC ||
      currentSec >= loopRange.endSec - LOOP_END_EPSILON_SEC ||
      hasReachedLaterHalf
    ) {
      queueDeckLoopSeek(deck, loopRange.startSec)
    }
  }

  const stepDeckLoopBeats = (deck: DeckKey, direction: -1 | 1) => {
    params.touchDeckInteraction(deck)
    if (resolveDeckLoopDisabled(deck)) return
    const loopState = deckLoopState[deck]
    const currentIndex = Math.max(0, resolveLoopBeatValueIndex(loopState.beatValue))
    const nextIndex = clampNumber(currentIndex + direction, 0, LOOP_BEAT_VALUES.length - 1)
    const nextBeatValue = LOOP_BEAT_VALUES[nextIndex]
    if (Math.abs(nextBeatValue - loopState.beatValue) <= 1e-9) return
    loopState.beatValue = nextBeatValue
    if (!loopState.active) return
    maybeRestartDeckLoopAfterBeatChange(deck)
  }

  const handleDeckLoopStepDown = (deck: DeckKey) => stepDeckLoopBeats(deck, -1)
  const handleDeckLoopStepUp = (deck: DeckKey) => stepDeckLoopBeats(deck, 1)

  const handleDeckLoopToggle = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (deckLoopState[deck].active) {
      deactivateDeckLoop(deck)
      return
    }
    if (resolveDeckLoopDisabled(deck)) return
    const anchorSec = resolveDeckLoopAnchorSeconds(deck)
    const startBeatIndex = resolveDeckLoopStartBeatIndex(deck, anchorSec)
    if (startBeatIndex === null) return
    const loopState = deckLoopState[deck]
    loopState.active = true
    loopState.startBeatIndex = startBeatIndex
    loopState.requestToken += 1
    loopState.seekPending = false
    const loopRange = resolveDeckLoopRange(deck)
    if (!loopRange) {
      deactivateDeckLoop(deck)
      return
    }
    params.resolveDeckCuePointRef(deck).value = loopRange.startSec
    if (
      anchorSec < loopRange.startSec + LOOP_POSITION_EPSILON_SEC ||
      anchorSec >= loopRange.endSec - LOOP_END_EPSILON_SEC
    ) {
      queueDeckLoopSeek(deck, loopRange.startSec)
    }
  }

  const syncDeckIntoLoopRangeBeforePlay = async (deck: DeckKey) => {
    const loopRange = resolveDeckLoopRange(deck)
    if (!loopRange) return
    const currentSec = resolveDeckLoopAnchorSeconds(deck)
    if (
      currentSec >= loopRange.startSec + LOOP_POSITION_EPSILON_SEC &&
      currentSec < loopRange.endSec - LOOP_END_EPSILON_SEC
    ) {
      return
    }
    await params.nativeTransport.seek(deck, loopRange.startSec)
  }

  const handleDeckLoopPlaybackTick = (deck: DeckKey) => {
    const loopState = deckLoopState[deck]
    if (!loopState.active || loopState.seekPending || !params.resolveDeckPlaying(deck)) return
    const loopRange = resolveDeckLoopRange(deck)
    if (!loopRange) {
      deactivateDeckLoop(deck)
      return
    }
    const currentSec = params.resolveDeckRenderCurrentSeconds(deck)
    if (
      currentSec >= loopRange.endSec - LOOP_END_EPSILON_SEC ||
      currentSec < loopRange.startSec - LOOP_POSITION_EPSILON_SEC
    ) {
      queueDeckLoopSeek(deck, loopRange.startSec)
    }
  }

  const handleDeckRawWaveformDragStart = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const dragState = deckWaveformDragState[deck]
    if (dragState.active) return

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    dragState.active = true
    dragState.wasPlaying = snapshot.playing
    dragState.syncEnabledBefore = snapshot.syncEnabled
    dragState.token += 1

    if (!dragState.wasPlaying) return

    const token = dragState.token
    void params.nativeTransport
      .setPlaying(deck, false)
      .then(() => {
        if (!deckWaveformDragState[deck].active || deckWaveformDragState[deck].token !== token)
          return
        params.syncDeckRenderState()
      })
      .catch(() => {})
  }

  const handleDeckRawWaveformDragEnd = (deck: DeckKey, payload: DeckWaveformDragEndPayload) => {
    params.touchDeckInteraction(deck)
    const dragState = deckWaveformDragState[deck]
    const shouldResume = dragState.wasPlaying
    const syncEnabledBefore = dragState.syncEnabledBefore

    dragState.active = false
    dragState.wasPlaying = false
    dragState.syncEnabledBefore = false
    dragState.token += 1

    if (!payload?.committed) return

    const token = dragState.token
    const targetSec = Math.max(0, Number(payload.anchorSec) || 0)
    void (async () => {
      await params.nativeTransport.seek(deck, targetSec)
      if (deckWaveformDragState[deck].token !== token) return
      if (shouldResume) {
        if (syncEnabledBefore && !deckLoopState[deck].active) {
          await params.nativeTransport.beatsync(deck)
          if (deckWaveformDragState[deck].token !== token) return
        }
        await params.nativeTransport.setPlaying(deck, true)
        if (deckWaveformDragState[deck].token !== token) return
      }
      params.syncDeckRenderState()
    })().catch(() => {})
  }

  const handleDeckPlayheadSeek = (deck: DeckKey, seconds: number) => {
    params.touchDeckInteraction(deck)
    traceDeckAction(deck, 'seek:intent', {
      source: 'overview-or-playhead',
      seconds
    })
    params.notifyDeckSeekIntent(deck, seconds)
    void params.nativeTransport.seek(deck, seconds).then(() => {
      params.syncDeckRenderState()
    })
  }

  const seekDeckToSeconds = (deck: DeckKey, seconds: number) => {
    params.touchDeckInteraction(deck)
    const durationSeconds = params.resolveDeckDurationSeconds(deck)
    const nextSeconds = clampNumber(
      Number(seconds) || 0,
      0,
      durationSeconds > 0 ? durationSeconds : Number.MAX_SAFE_INTEGER
    )
    traceDeckAction(deck, 'seek:intent', {
      source: 'transport',
      seconds: nextSeconds
    })
    params.notifyDeckSeekIntent(deck, nextSeconds)
    void (async () => {
      await params.nativeTransport.seek(deck, nextSeconds)
      if (
        params.resolveDeckPlaying(deck) &&
        params.resolveTransportDeckSnapshot(deck).syncEnabled &&
        !deckLoopState[deck].active
      ) {
        await params.nativeTransport.beatsync(deck)
      }
      params.syncDeckRenderState()
    })().catch(() => {})
  }

  const handleDeckBarJump = (deck: DeckKey, direction: -1 | 1) => {
    const gridBpm = Number(params.resolveDeckGridBpm(deck))
    if (!Number.isFinite(gridBpm) || gridBpm <= 0) return
    const deltaSeconds = (60 / gridBpm) * BAR_JUMP_BEATS * direction
    seekDeckToSeconds(deck, params.resolveDeckCurrentSeconds(deck) + deltaSeconds)
  }

  const handleDeckSeekPercent = (deck: DeckKey, percent: number) => {
    const safePercent = clampNumber(Number(percent) || 0, 0, 1)
    if (safePercent === 0) {
      seekDeckToSeconds(deck, 0)
      return
    }
    const durationSeconds = params.resolveDeckDurationSeconds(deck)
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return
    seekDeckToSeconds(deck, durationSeconds * safePercent)
  }

  const isDeckStoppedAtCuePoint = (deck: DeckKey) => {
    if (params.resolveDeckPlaying(deck) || !params.resolveDeckSong(deck)) return false
    const cueSeconds = params.resolveDeckCuePointRef(deck).value
    return (
      Math.abs(params.resolveDeckCurrentSeconds(deck) - cueSeconds) <= CUE_POINT_TRIGGER_EPSILON_SEC
    )
  }

  const handleDeckBackCue = async (
    deck: DeckKey,
    cueSeconds = params.resolveDeckCuePointRef(deck).value
  ) => {
    params.touchDeckInteraction(deck)
    await params.nativeTransport.setPlaying(deck, false)
    await params.nativeTransport.seek(deck, cueSeconds)
    params.syncDeckRenderState()
  }

  const handleDeckSetCueFromCurrentPosition = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const cueRef = params.resolveDeckCuePointRef(deck)
    const nextCuePoint = params.resolveDeckCuePlacementSec(deck)
    cueRef.value = nextCuePoint
    await params.nativeTransport.seek(deck, nextCuePoint)
    params.syncDeckRenderState()
  }

  const buildDeckStoredCueDefinition = (deck: DeckKey): DeckStoredCueDefinition | null => {
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

  const resolveDeckStoredLoopState = (deck: DeckKey, startSec: number, endSec: number) => {
    const grid = resolveDeckLoopGridSnapshot(deck)
    if (!grid) return null
    const durationSec = endSec - startSec
    if (!Number.isFinite(durationSec) || durationSec <= LOOP_POSITION_EPSILON_SEC) return null
    const startBeatIndex = Math.round((startSec - grid.firstBeatSec) / grid.beatSec)
    if (!Number.isFinite(startBeatIndex)) return null
    let beatValue = durationSec / grid.beatSec
    if (!Number.isFinite(beatValue) || beatValue <= 0) return null
    const nearest = LOOP_BEAT_VALUES.reduce((best, candidate) =>
      Math.abs(candidate - beatValue) < Math.abs(best - beatValue) ? candidate : best
    )
    beatValue = nearest
    return {
      startBeatIndex,
      beatValue
    }
  }

  const applyDeckStoredCueDefinition = (
    deck: DeckKey,
    cue: DeckStoredCueDefinition | Pick<ISongHotCue, 'sec' | 'isLoop' | 'loopEndSec'>
  ) => {
    const cueSec = Math.max(0, Number(cue?.sec) || 0)
    params.resolveDeckCuePointRef(deck).value = cueSec
    const loopEndSec = Number(cue?.loopEndSec)
    const isLoop =
      Boolean(cue?.isLoop) &&
      Number.isFinite(loopEndSec) &&
      loopEndSec > cueSec + LOOP_POSITION_EPSILON_SEC
    if (!isLoop) {
      deactivateDeckLoop(deck)
      return null
    }
    const loopState = resolveDeckStoredLoopState(deck, cueSec, loopEndSec)
    if (!loopState) {
      deactivateDeckLoop(deck)
      return null
    }
    deckLoopState[deck].active = true
    deckLoopState[deck].startBeatIndex = loopState.startBeatIndex
    deckLoopState[deck].beatValue = loopState.beatValue
    deckLoopState[deck].requestToken += 1
    deckLoopState[deck].seekPending = false
    return resolveDeckLoopRange(deck)
  }

  const handleDeckMemoryCueRecall = async (
    deck: DeckKey,
    cue: Pick<ISongMemoryCue, 'sec' | 'isLoop' | 'loopEndSec'>
  ) => {
    params.touchDeckInteraction(deck)
    applyDeckStoredCueDefinition(deck, cue)
    await params.nativeTransport.setPlaying(deck, false)
    await params.nativeTransport.seek(deck, Math.max(0, Number(cue?.sec) || 0))
    params.syncDeckRenderState()
  }

  const handleDeckHotCueRecall = async (
    deck: DeckKey,
    cue: Pick<ISongHotCue, 'sec' | 'isLoop' | 'loopEndSec'>
  ) => {
    params.touchDeckInteraction(deck)
    const loopRange = applyDeckStoredCueDefinition(deck, cue)
    await params.nativeTransport.seek(deck, Math.max(0, Number(cue?.sec) || 0))
    if (params.resolveTransportDeckSnapshot(deck).syncEnabled && !loopRange) {
      await params.commitDeckStatesToNative()
      await params.nativeTransport.beatsync(deck)
    }
    await params.nativeTransport.setPlaying(deck, true)
    params.syncDeckRenderState()
  }

  const startDeckCuePreview = (deck: DeckKey, pointerId: number) => {
    params.touchDeckInteraction(deck)
    const cuePreviewState = deckCuePreviewState[deck]
    if (cuePreviewState.active) return

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    cuePreviewState.active = true
    cuePreviewState.pointerId = pointerId
    cuePreviewState.cueSeconds = params.resolveDeckCuePointRef(deck).value
    cuePreviewState.syncEnabledBefore = snapshot.syncEnabled
    cuePreviewState.syncLockBefore = snapshot.syncLock
    cuePreviewState.token += 1

    const token = cuePreviewState.token
    const syncEnabledBefore = cuePreviewState.syncEnabledBefore
    void (async () => {
      const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
      const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:cue-preview:${deck}`)
      beginHorizontalBrowseDeckAction(deck, 'cue-preview', filePath)
      traceDeckAction(deck, 'cue-preview:start')
      try {
        if (syncEnabledBefore) {
          await params.nativeTransport.setSyncEnabled(deck, false)
        }
        const latestState = deckCuePreviewState[deck]
        if (!latestState.active || latestState.token !== token) return
        await params.nativeTransport.setPlaying(deck, true)
        if (deckCuePreviewState[deck].token !== token) return
        traceDeckAction(deck, 'cue-preview:playing', {
          sinceCuePreviewMs: resolveHorizontalBrowseDeckActionElapsedMs(
            deck,
            'cue-preview',
            filePath
          )
        })
        params.syncDeckRenderState()
      } finally {
        finishTiming()
      }
    })()
  }

  const stopDeckCuePreview = (deck: DeckKey, pointerId?: number) => {
    const cuePreviewState = deckCuePreviewState[deck]
    if (!cuePreviewState.active) return
    if (typeof pointerId === 'number' && cuePreviewState.pointerId !== pointerId) return
    params.touchDeckInteraction(deck)

    const cueSeconds = cuePreviewState.cueSeconds
    const syncEnabledBefore = cuePreviewState.syncEnabledBefore
    cuePreviewState.active = false
    cuePreviewState.pointerId = null
    cuePreviewState.cueSeconds = 0
    cuePreviewState.syncEnabledBefore = false
    cuePreviewState.syncLockBefore = 'off'
    cuePreviewState.token += 1

    void (async () => {
      const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
      const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:cue-stop:${deck}`)
      beginHorizontalBrowseDeckAction(deck, 'cue-stop', filePath)
      beginHorizontalBrowseDeckAction(deck, 'seek', filePath)
      traceDeckAction(deck, 'cue-stop:start')
      try {
        await params.nativeTransport.setPlaying(deck, false).catch(() => {})
        traceDeckAction(deck, 'cue-stop:paused', {
          sinceCueStopMs: resolveHorizontalBrowseDeckActionElapsedMs(deck, 'cue-stop', filePath)
        })
        await params.nativeTransport.seek(deck, cueSeconds).catch(() => {})
        traceDeckAction(deck, 'cue-stop:seeked', {
          sinceSeekMs: resolveHorizontalBrowseDeckActionElapsedMs(deck, 'seek', filePath),
          cueSeconds
        })
        if (syncEnabledBefore) {
          await params.nativeTransport.setSyncEnabled(deck, true).catch(() => {})
        }
        params.syncDeckRenderState()
      } finally {
        finishTiming()
      }
    })()
  }

  const stopAllDeckCuePreview = () => {
    stopDeckCuePreview('top')
    stopDeckCuePreview('bottom')
    suppressDeckCueClick.top = false
    suppressDeckCueClick.bottom = false
  }

  const clearDeckCueClickSuppressSoon = () =>
    requestAnimationFrame(() => {
      suppressDeckCueClick.top = false
      suppressDeckCueClick.bottom = false
    })

  const canDeckExecuteImmediateTransportAction = (deck: DeckKey) =>
    Boolean(String(params.resolveDeckSong(deck)?.filePath || '').trim())

  const traceDeckAction = (deck: DeckKey, stage: string, payload?: Record<string, unknown>) => {
    const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
    sendHorizontalBrowseInteractionTrace(stage, {
      deck,
      filePath,
      ...payload
    })
  }

  const handleWindowDeckCuePointerUp = (event: PointerEvent) => {
    stopDeckCuePreview('top', event.pointerId)
    stopDeckCuePreview('bottom', event.pointerId)
    deckPendingCuePreviewOnLoad.top = false
    deckPendingCuePreviewOnLoad.bottom = false
    clearDeckCueClickSuppressSoon()
  }

  const handleDeckCuePointerDown = (deck: DeckKey, event: PointerEvent) => {
    if (event.button !== 0) return
    params.touchDeckInteraction(deck)
    suppressDeckCueClick[deck] = true
    event.preventDefault()

    if (params.resolveDeckPlaying(deck)) {
      void handleDeckBackCue(deck)
      return
    }
    if (!params.resolveDeckLoaded(deck)) {
      if (!canDeckExecuteImmediateTransportAction(deck)) return
      deckPendingCuePreviewOnLoad[deck] = false
      startDeckCuePreview(deck, event.pointerId)
      return
    }
    if (isDeckStoppedAtCuePoint(deck)) {
      startDeckCuePreview(deck, event.pointerId)
      return
    }
    void handleDeckSetCueFromCurrentPosition(deck)
  }

  const handleDeckCueClick = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (suppressDeckCueClick[deck]) {
      suppressDeckCueClick[deck] = false
      return
    }
    if (params.resolveDeckPlaying(deck)) {
      void handleDeckBackCue(deck)
      return
    }
    if (isDeckStoppedAtCuePoint(deck)) return
    void handleDeckSetCueFromCurrentPosition(deck)
  }

  const handleDeckCueHotkeyDown = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (params.resolveDeckPlaying(deck)) {
      void handleDeckBackCue(deck)
      return false
    }
    if (!params.resolveDeckLoaded(deck)) {
      if (!canDeckExecuteImmediateTransportAction(deck)) return false
      deckPendingCuePreviewOnLoad[deck] = false
      startDeckCuePreview(deck, -1)
      return true
    }
    if (!isDeckStoppedAtCuePoint(deck)) {
      void handleDeckSetCueFromCurrentPosition(deck)
      return false
    }
    startDeckCuePreview(deck, -1)
    return true
  }

  const handleDeckCueHotkeyUp = (deck: DeckKey) => {
    stopDeckCuePreview(deck)
  }

  const handleDeckPlayPauseToggle = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const nextPlaying = !params.resolveDeckPlaying(deck)
    void (async () => {
      const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
      const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:play-toggle:${deck}`)
      if (nextPlaying) {
        beginHorizontalBrowseDeckAction(deck, 'play-toggle', filePath)
        traceDeckAction(deck, 'play-toggle:start')
      }
      try {
        if (nextPlaying && !params.resolveDeckLoaded(deck)) {
          if (!canDeckExecuteImmediateTransportAction(deck)) return
          deckPendingPlayOnLoad[deck] = false
        } else {
          deckPendingPlayOnLoad[deck] = false
        }
        if (nextPlaying) {
          await syncDeckIntoLoopRangeBeforePlay(deck)
          if (
            params.resolveTransportDeckSnapshot(deck).syncEnabled &&
            !deckLoopState[deck].active
          ) {
            await params.commitDeckStatesToNative()
            await params.nativeTransport.beatsync(deck)
          }
        }
        await params.nativeTransport.setPlaying(deck, nextPlaying)
        if (nextPlaying) {
          traceDeckAction(deck, 'play-toggle:done', {
            sincePlayToggleMs: resolveHorizontalBrowseDeckActionElapsedMs(
              deck,
              'play-toggle',
              filePath
            )
          })
        }
        params.syncDeckRenderState()
      } finally {
        finishTiming()
      }
    })()
  }

  const maybeResumePendingPlay = (deck: DeckKey, loaded: boolean, decoding: boolean) => {
    if (!deckPendingPlayOnLoad[deck] || !loaded) return
    deckPendingPlayOnLoad[deck] = false
    void decoding
    void handleDeckPlayPauseToggle(deck)
  }

  const maybeResumePendingCuePreview = (deck: DeckKey, loaded: boolean) => {
    if (!deckPendingCuePreviewOnLoad[deck] || !loaded) return
    deckPendingCuePreviewOnLoad[deck] = false
    if (!isDeckStoppedAtCuePoint(deck)) {
      void handleDeckSetCueFromCurrentPosition(deck)
      return
    }
    startDeckCuePreview(deck, -1)
  }

  watch(
    () =>
      [
        params.resolveDeckLoaded('top'),
        params.resolveDeckDecoding('top'),
        params.resolveDeckLoaded('bottom'),
        params.resolveDeckDecoding('bottom')
      ] as const,
    ([topLoaded, topDecoding, bottomLoaded, bottomDecoding]) => {
      maybeResumePendingPlay('top', topLoaded, topDecoding)
      maybeResumePendingPlay('bottom', bottomLoaded, bottomDecoding)
      maybeResumePendingCuePreview('top', topLoaded)
      maybeResumePendingCuePreview('bottom', bottomLoaded)
    }
  )

  watch(
    () =>
      [
        params.resolveDeckSong('top')?.filePath ?? '',
        params.resolveDeckSong('bottom')?.filePath ?? ''
      ] as const,
    ([topFilePath, bottomFilePath], [previousTopFilePath, previousBottomFilePath]) => {
      if (topFilePath !== previousTopFilePath) {
        deactivateDeckLoop('top')
        if (!topFilePath) {
          deckPendingPlayOnLoad.top = false
          deckPendingCuePreviewOnLoad.top = false
        }
      }
      if (bottomFilePath !== previousBottomFilePath) {
        deactivateDeckLoop('bottom')
        if (!bottomFilePath) {
          deckPendingPlayOnLoad.bottom = false
          deckPendingCuePreviewOnLoad.bottom = false
        }
      }
    }
  )

  return {
    deckPendingPlayOnLoad,
    deckPendingCuePreviewOnLoad,
    suppressDeckCueClick,
    isDeckWaveformDragging: (deck: DeckKey) => deckWaveformDragState[deck].active,
    resolveDeckCuePreviewRuntimeState: (deck: DeckKey) => deckCuePreviewState[deck],
    resolveDeckLoopRange,
    resolveDeckLoopBeatLabel,
    resolveDeckLoopDisabled,
    isDeckLoopActive,
    handleDeckLoopToggle,
    handleDeckLoopStepDown,
    handleDeckLoopStepUp,
    handleDeckLoopPlaybackTick,
    handleDeckRawWaveformDragStart,
    handleDeckRawWaveformDragEnd,
    handleDeckPlayheadSeek,
    handleDeckBarJump,
    handleDeckSeekPercent,
    handleDeckBackCue,
    handleDeckSetCueFromCurrentPosition,
    buildDeckStoredCueDefinition,
    handleDeckMemoryCueRecall,
    handleDeckHotCueRecall,
    stopAllDeckCuePreview,
    handleWindowDeckCuePointerUp,
    handleDeckCuePointerDown,
    handleDeckCueClick,
    handleDeckCueHotkeyDown,
    handleDeckCueHotkeyUp,
    handleDeckPlayPauseToggle
  }
}
