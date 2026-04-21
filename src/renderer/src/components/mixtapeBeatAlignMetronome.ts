import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

type UseMixtapeBeatAlignMetronomeParams = {
  dialogVisible: Readonly<Ref<boolean>>
  previewPlaying: Readonly<Ref<boolean>>
  bpm: Readonly<Ref<number>>
  firstBeatMs: Readonly<Ref<number>>
  playbackRate?: Readonly<Ref<number>>
  resetKey?: Readonly<Ref<unknown>>
  outputMode?: 'internal' | 'external'
  syncExternalState?: (state: { enabled: boolean; volumeLevel: 1 | 2 | 3 }) => void
  resolveAnchorSec: () => number
}

type BeatClock = {
  beatSec: number
  firstBeatSec: number
}

const TICK_FREQUENCY_HZ = 1560
const TICK_END_FREQUENCY_HZ = 1320
const TICK_GAIN_LEVELS = [0.17, 0.32, 0.96] as const
const DEFAULT_METRONOME_VOLUME_LEVEL: 1 | 2 | 3 = 2
const TICK_ATTACK_SEC = 0.002
const TICK_DURATION_SEC = 0.045
const TICK_GAP_SEC = 0.01
const MAX_TICKS_PER_FRAME = 3
const ANCHOR_DIFF_EPSILON = 0.000001
const MAX_CONTINUOUS_FRAME_INTERVAL_SEC = 0.35
const ANCHOR_JUMP_GRACE_SEC = 0.08

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const isFinitePositive = (value: number) => Number.isFinite(value) && value > 0

export const useMixtapeBeatAlignMetronome = (params: UseMixtapeBeatAlignMetronomeParams) => {
  const metronomeEnabled = ref(false)
  const metronomeVolumeLevel = ref<1 | 2 | 3>(DEFAULT_METRONOME_VOLUME_LEVEL)
  const metronomeSupported = computed(() => {
    const bpmValue = Number(params.bpm.value)
    return isFinitePositive(bpmValue)
  })

  let metronomeRaf = 0
  let lastAnchorSec: number | null = null
  let lastFrameAtMs: number | null = null
  let audioCtx: AudioContext | null = null

  const usesInternalAudio = () => params.outputMode !== 'external'

  const syncExternalMetronomeState = (enabled = metronomeEnabled.value) => {
    if (usesInternalAudio()) return
    params.syncExternalState?.({
      enabled: enabled && params.dialogVisible.value && metronomeSupported.value,
      volumeLevel: metronomeVolumeLevel.value
    })
  }

  const resolvePlaybackRate = () => {
    const rate = Number(params.playbackRate?.value)
    return isFinitePositive(rate) ? rate : 1
  }

  const resolveBeatClock = (): BeatClock | null => {
    const bpmValue = Number(params.bpm.value)
    if (!isFinitePositive(bpmValue)) return null
    const beatSec = 60 / bpmValue
    if (!isFinitePositive(beatSec)) return null
    const firstBeatSec = (Number(params.firstBeatMs.value) || 0) / 1000
    return {
      beatSec,
      firstBeatSec
    }
  }

  const ensureAudioContext = () => {
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx
    try {
      audioCtx = new AudioContext()
      return audioCtx
    } catch {
      return null
    }
  }

  const ensureAudioContextResumed = async () => {
    const ctx = ensureAudioContext()
    if (!ctx) return
    if (ctx.state !== 'suspended') return
    try {
      await ctx.resume()
    } catch {}
  }

  const playTick = (delaySec: number = 0) => {
    if (!usesInternalAudio()) return
    const ctx = ensureAudioContext()
    if (!ctx) return
    const now = ctx.currentTime + Math.max(0, delaySec)
    const oscillator = ctx.createOscillator()
    const gainNode = ctx.createGain()
    oscillator.type = 'square'
    oscillator.frequency.setValueAtTime(TICK_FREQUENCY_HZ, now)
    oscillator.frequency.exponentialRampToValueAtTime(
      TICK_END_FREQUENCY_HZ,
      now + TICK_DURATION_SEC
    )
    const gainLevel = clampNumber(
      Number(metronomeVolumeLevel.value) || 1,
      1,
      TICK_GAIN_LEVELS.length
    )
    const gainValue = TICK_GAIN_LEVELS[gainLevel - 1] || TICK_GAIN_LEVELS[0]
    gainNode.gain.setValueAtTime(0.0001, now)
    gainNode.gain.exponentialRampToValueAtTime(gainValue, now + TICK_ATTACK_SEC)
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + TICK_DURATION_SEC)
    oscillator.connect(gainNode)
    gainNode.connect(ctx.destination)
    oscillator.start(now)
    oscillator.stop(now + TICK_DURATION_SEC + 0.01)
    oscillator.onended = () => {
      try {
        oscillator.disconnect()
      } catch {}
      try {
        gainNode.disconnect()
      } catch {}
    }
  }

  const shouldResetForAnchorJump = (
    fromSec: number,
    toSec: number,
    nowMs: number,
    clock: BeatClock
  ) => {
    if (toSec < fromSec - ANCHOR_DIFF_EPSILON) return true
    if (lastFrameAtMs === null) return false
    const elapsedSec = Math.max(0, (nowMs - lastFrameAtMs) / 1000)
    if (elapsedSec > MAX_CONTINUOUS_FRAME_INTERVAL_SEC) return true
    const expectedDeltaSec = elapsedSec * resolvePlaybackRate()
    const maxContinuousDeltaSec = Math.max(
      expectedDeltaSec * 2 + ANCHOR_JUMP_GRACE_SEC,
      expectedDeltaSec + clock.beatSec * 0.35,
      ANCHOR_JUMP_GRACE_SEC
    )
    return toSec - fromSec > maxContinuousDeltaSec
  }

  const emitTicksBetween = (fromSec: number, toSec: number, clock: BeatClock) => {
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) return
    if (Math.abs(toSec - fromSec) <= ANCHOR_DIFF_EPSILON) return
    if (toSec < fromSec) return

    const { firstBeatSec, beatSec } = clock
    let playedCount = 0

    const startIndex = Math.floor((fromSec - firstBeatSec) / beatSec) + 1
    const endIndex = Math.floor((toSec - firstBeatSec) / beatSec)
    for (let i = startIndex; i <= endIndex; i += 1) {
      if (playedCount >= MAX_TICKS_PER_FRAME) break
      const beatTimeSec = firstBeatSec + i * beatSec
      if (beatTimeSec < 0) continue
      playTick(playedCount * TICK_GAP_SEC)
      playedCount += 1
    }
  }

  const resolveAnchorSec = () => {
    const anchorSec = Number(params.resolveAnchorSec())
    if (!Number.isFinite(anchorSec)) return null
    return anchorSec
  }

  const stopMetronomeLoop = () => {
    if (!metronomeRaf) return
    cancelAnimationFrame(metronomeRaf)
    metronomeRaf = 0
  }

  const runMetronomeLoop = () => {
    if (!metronomeEnabled.value || !params.dialogVisible.value) {
      metronomeRaf = 0
      return
    }
    const nowMs = performance.now()
    const anchorSec = resolveAnchorSec()
    if (anchorSec !== null) {
      if (!params.previewPlaying.value) {
        lastAnchorSec = anchorSec
        lastFrameAtMs = nowMs
      } else if (lastAnchorSec === null) {
        lastAnchorSec = anchorSec
        lastFrameAtMs = nowMs
      } else {
        const clock = resolveBeatClock()
        if (clock && !shouldResetForAnchorJump(lastAnchorSec, anchorSec, nowMs, clock)) {
          emitTicksBetween(lastAnchorSec, anchorSec, clock)
        }
        lastAnchorSec = anchorSec
        lastFrameAtMs = nowMs
      }
    }
    metronomeRaf = requestAnimationFrame(runMetronomeLoop)
  }

  const startMetronomeLoop = () => {
    if (!usesInternalAudio()) return
    if (metronomeRaf) return
    lastAnchorSec = resolveAnchorSec()
    lastFrameAtMs = performance.now()
    metronomeRaf = requestAnimationFrame(runMetronomeLoop)
  }

  const setMetronomeEnabled = (value: boolean) => {
    const next = Boolean(value)
    if (metronomeEnabled.value === next) return
    if (next && !metronomeSupported.value) return
    metronomeEnabled.value = next
    if (next) {
      if (usesInternalAudio()) {
        void ensureAudioContextResumed()
      }
    }
    syncExternalMetronomeState(next)
  }

  const toggleMetronome = () => {
    setMetronomeEnabled(!metronomeEnabled.value)
  }

  const setMetronomeVolumeLevel = (level: number) => {
    const clamped = clampNumber(
      Number(level) || DEFAULT_METRONOME_VOLUME_LEVEL,
      1,
      TICK_GAIN_LEVELS.length
    )
    metronomeVolumeLevel.value = clamped as 1 | 2 | 3
    syncExternalMetronomeState()
  }

  const cleanupMetronome = () => {
    syncExternalMetronomeState(false)
    stopMetronomeLoop()
    lastAnchorSec = null
    lastFrameAtMs = null
    if (audioCtx && audioCtx.state !== 'closed') {
      try {
        void audioCtx.close()
      } catch {}
    }
    audioCtx = null
  }

  watch(
    () => [metronomeEnabled.value, params.dialogVisible.value] as const,
    ([enabled, visible]) => {
      syncExternalMetronomeState(enabled && visible)
      if (!usesInternalAudio()) {
        stopMetronomeLoop()
        lastAnchorSec = null
        lastFrameAtMs = null
        return
      }
      if (enabled && visible) {
        startMetronomeLoop()
        return
      }
      stopMetronomeLoop()
      lastAnchorSec = null
      lastFrameAtMs = null
    },
    { immediate: true }
  )

  watch(
    () => [params.bpm.value, params.firstBeatMs.value] as const,
    () => {
      lastAnchorSec = resolveAnchorSec()
      lastFrameAtMs = performance.now()
    }
  )

  watch(
    () => params.resetKey?.value,
    () => {
      lastAnchorSec = resolveAnchorSec()
      lastFrameAtMs = performance.now()
    }
  )

  watch(
    () => metronomeSupported.value,
    (supported) => {
      if (supported) return
      setMetronomeEnabled(false)
    }
  )

  onBeforeUnmount(() => {
    cleanupMetronome()
  })

  return {
    metronomeEnabled,
    metronomeVolumeLevel,
    metronomeSupported,
    toggleMetronome,
    setMetronomeVolumeLevel,
    setMetronomeEnabled,
    cleanupMetronome
  }
}
