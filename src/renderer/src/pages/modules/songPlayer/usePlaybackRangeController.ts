import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  clampPlaybackRangePercent,
  findCrossedPlaybackSectionRange,
  findCurrentOrUpcomingPlaybackSectionRange,
  findNextPlaybackSectionRange,
  isPlaybackSectionRangeMode,
  normalizePlaybackRangeMode,
  normalizePlaybackRangeSectionKinds,
  normalizePlaybackRangeSectionMatchMode,
  resolveCustomPlaybackRangeEndSec,
  resolveInitialPlaybackRangeStartSec,
  resolvePlaybackSectionRangeResolution,
  type PlaybackSectionRange
} from '@shared/playbackRange'
import { WebAudioPlayer } from './webAudioPlayer'

type PlaybackRangeControllerOptions = {
  runtime: ReturnType<typeof useRuntimeStore>
  audioPlayer: Ref<WebAudioPlayer | null>
  playerCurrentSeconds: Ref<number>
  playerWaveformDurationSec: ComputedRef<number>
  rangeStopTolerance: number
  getPreviousTime: () => number
  setPreviousTime: (value: number) => void
  isManualSeekActive: () => boolean
  clearManualSeekActive: () => void
  nextSong: () => void
  setSetting: () => void | Promise<void>
}

export function usePlaybackRangeController(options: PlaybackRangeControllerOptions) {
  const {
    runtime,
    audioPlayer,
    playerCurrentSeconds,
    playerWaveformDurationSec,
    rangeStopTolerance
  } = options
  const sectionRangeFallbackFilePath = ref<string | null>(null)
  const queuedSectionAnalysisFilePath = ref('')
  const ignoreRangeEndsBeforeSec = ref<number | null>(null)

  const playbackSectionRangeResolution = computed(() =>
    resolvePlaybackSectionRangeResolution(
      runtime.setting,
      runtime.playingData.playingSong?.songStructure,
      playerWaveformDurationSec.value
    )
  )

  const playbackSectionHandleRange = computed(() => {
    const resolution = playbackSectionRangeResolution.value
    if (resolution.status !== 'ready') return null
    return findCurrentOrUpcomingPlaybackSectionRange(
      resolution.ranges,
      playerCurrentSeconds.value,
      rangeStopTolerance
    )
  })

  const sectionSecondsToPercent = (seconds: number) => {
    const duration = playerWaveformDurationSec.value
    if (duration <= 0) return 0
    return Math.min(Math.max((seconds / duration) * 100, 0), 100)
  }

  const playbackRangeLockedRanges = computed(() => {
    if (!isPlaybackSectionRangeMode(runtime.setting)) return []
    const resolution = playbackSectionRangeResolution.value
    if (resolution.status !== 'ready') return []
    return resolution.ranges
      .map((range) => ({
        startPercent: sectionSecondsToPercent(range.startSec),
        endPercent: sectionSecondsToPercent(range.endSec)
      }))
      .filter((range) => range.endPercent > range.startPercent)
  })

  const playbackRangeHandlesLocked = computed(() => isPlaybackSectionRangeMode(runtime.setting))

  const playbackRangeHandlesVisible = computed(() => {
    if (runtime.setting.enablePlaybackRange !== true) return false
    if (!playbackRangeHandlesLocked.value) return true
    return playbackRangeLockedRanges.value.length > 0
  })

  const playbackRangeHandleStartPercent = computed({
    get: () => {
      const sectionRange = playbackSectionHandleRange.value
      if (playbackRangeHandlesLocked.value && sectionRange) {
        return sectionSecondsToPercent(sectionRange.startSec)
      }
      return runtime.setting.startPlayPercent
    },
    set: (value: number) => {
      if (playbackRangeHandlesLocked.value) return
      runtime.setting.startPlayPercent = value
    }
  })

  const playbackRangeHandleEndPercent = computed({
    get: () => {
      const sectionRange = playbackSectionHandleRange.value
      if (playbackRangeHandlesLocked.value && sectionRange) {
        return sectionSecondsToPercent(sectionRange.endSec)
      }
      return runtime.setting.endPlayPercent
    },
    set: (value: number) => {
      if (playbackRangeHandlesLocked.value) return
      runtime.setting.endPlayPercent = value
    }
  })

  const finishRangePlayback = (player: WebAudioPlayer) => {
    if (options.isManualSeekActive()) {
      options.clearManualSeekActive()
      return
    }
    if (runtime.setting.autoPlayNextSong) {
      options.nextSong()
    } else {
      player.pause()
    }
  }

  const shouldIgnorePassedRangeEnd = (endSec: number, currentTime: number) => {
    const ignoreBefore = ignoreRangeEndsBeforeSec.value
    if (ignoreBefore === null) return false
    if (currentTime < ignoreBefore - rangeStopTolerance) {
      ignoreRangeEndsBeforeSec.value = null
      return false
    }
    return endSec <= ignoreBefore + rangeStopTolerance
  }

  const handlePlaybackRangeTimeUpdate = (player: WebAudioPlayer, currentTime: number) => {
    if (runtime.setting.enablePlaybackRange !== true) return
    if (isPlaybackSectionRangeMode(runtime.setting)) {
      const resolution = playbackSectionRangeResolution.value
      if (resolution.status !== 'ready') return
      const crossedRange = findCrossedPlaybackSectionRange(
        resolution.ranges,
        options.getPreviousTime(),
        currentTime,
        rangeStopTolerance
      )
      if (!crossedRange || !player.isPlaying()) return
      if (shouldIgnorePassedRangeEnd(crossedRange.endSec, currentTime)) return
      if (options.isManualSeekActive()) {
        options.clearManualSeekActive()
        return
      }
      const nextRange = findNextPlaybackSectionRange(
        resolution.ranges,
        crossedRange.endSec,
        rangeStopTolerance
      )
      if (nextRange) {
        options.setPreviousTime(nextRange.startSec)
        playerCurrentSeconds.value = nextRange.startSec
        player.play(nextRange.startSec)
        return
      }
      finishRangePlayback(player)
      return
    }

    const duration = player.getDuration()
    if (duration <= 0) return
    const endTime = resolveCustomPlaybackRangeEndSec(runtime.setting, duration)
    if (shouldIgnorePassedRangeEnd(endTime, currentTime)) return
    const effectiveEnd = Math.max(endTime - rangeStopTolerance, 0)
    const crossedEnd =
      currentTime >= effectiveEnd && options.getPreviousTime() < effectiveEnd && player.isPlaying()
    if (crossedEnd) {
      finishRangePlayback(player)
    }
  }

  const handlePlaybackRangeDragEnd = () => {
    if (playbackRangeHandlesLocked.value) return
    void options.setSetting()
  }

  const resolvePlaybackRangeStartSec = (durationSec: number) =>
    resolveInitialPlaybackRangeStartSec(
      runtime.setting,
      runtime.playingData.playingSong?.songStructure,
      durationSec
    )

  const resolveCustomPlaybackRange = (durationSec: number): PlaybackSectionRange | null => {
    if (durationSec <= 0) return null
    const startSec =
      (durationSec * clampPlaybackRangePercent(runtime.setting.startPlayPercent, 0)) / 100
    const endSec =
      (durationSec * clampPlaybackRangePercent(runtime.setting.endPlayPercent, 100)) / 100
    if (endSec <= startSec) return null
    return {
      startSec,
      endSec,
      kinds: []
    }
  }

  const resolveActivePlaybackRanges = (player: WebAudioPlayer) => {
    if (runtime.setting.enablePlaybackRange !== true) {
      return { status: 'disabled' as const, ranges: [] as PlaybackSectionRange[] }
    }
    if (isPlaybackSectionRangeMode(runtime.setting)) {
      const resolution = playbackSectionRangeResolution.value
      return { status: resolution.status, ranges: resolution.ranges }
    }

    const duration = player.getDuration() || playerWaveformDurationSec.value
    const range = resolveCustomPlaybackRange(duration)
    return {
      status: range ? ('ready' as const) : ('no-match' as const),
      ranges: range ? [range] : []
    }
  }

  const applyPlaybackRangeActivation = () => {
    const player = audioPlayer.value
    if (!player || runtime.setting.enablePlaybackRange !== true) return
    if (!runtime.playingData.playingSong?.filePath) return

    const currentTime = Math.max(0, player.getCurrentTime())
    const activeRanges = resolveActivePlaybackRanges(player)
    options.setPreviousTime(currentTime)

    if (activeRanges.status === 'unanalysed') {
      queueCurrentSongSectionAnalysis()
      return
    }
    if (activeRanges.status !== 'ready') {
      ignoreRangeEndsBeforeSec.value = null
      return
    }

    const targetRange = findCurrentOrUpcomingPlaybackSectionRange(
      activeRanges.ranges,
      currentTime,
      rangeStopTolerance
    )
    if (!targetRange) {
      ignoreRangeEndsBeforeSec.value = currentTime
      return
    }

    ignoreRangeEndsBeforeSec.value = null
    if (currentTime >= targetRange.startSec - rangeStopTolerance) return

    options.setPreviousTime(targetRange.startSec)
    playerCurrentSeconds.value = targetRange.startSec
    player.play(targetRange.startSec)
  }

  const queueCurrentSongSectionAnalysis = () => {
    const filePath = runtime.playingData.playingSong?.filePath
    if (!filePath || queuedSectionAnalysisFilePath.value === filePath) return
    queuedSectionAnalysisFilePath.value = filePath
    try {
      window.electron.ipcRenderer.send('key-analysis:queue-playing', {
        filePath,
        focusSlot: 'main-player'
      })
    } catch {}
  }

  const handleLateSectionRangeReady = () => {
    const player = audioPlayer.value
    if (!player || !player.isPlaying()) return
    const resolution = playbackSectionRangeResolution.value
    if (resolution.status !== 'ready') return
    const currentTime = Math.max(0, player.getCurrentTime())
    const targetRange = findCurrentOrUpcomingPlaybackSectionRange(
      resolution.ranges,
      currentTime,
      rangeStopTolerance
    )
    if (!targetRange) return
    if (currentTime >= targetRange.startSec - rangeStopTolerance) return
    options.setPreviousTime(targetRange.startSec)
    playerCurrentSeconds.value = targetRange.startSec
    player.play(targetRange.startSec)
  }

  watch(
    () => runtime.playingData.playingSong?.filePath,
    () => {
      sectionRangeFallbackFilePath.value = null
      ignoreRangeEndsBeforeSec.value = null
    }
  )

  watch(
    () => ({
      filePath: runtime.playingData.playingSong?.filePath || '',
      enabled: runtime.setting.enablePlaybackRange === true,
      mode: normalizePlaybackRangeMode(runtime.setting.playbackRangeMode),
      sectionKinds: normalizePlaybackRangeSectionKinds(
        runtime.setting.playbackRangeSectionKinds
      ).join('|'),
      sectionMatchMode: normalizePlaybackRangeSectionMatchMode(
        runtime.setting.playbackRangeSectionMatchMode
      )
    }),
    (state, previousState) => {
      if (!state.enabled) {
        ignoreRangeEndsBeforeSec.value = null
        return
      }
      if (!state.filePath || !previousState) return

      const becameEnabled = !previousState.enabled && state.enabled
      const modeChanged = previousState.enabled && previousState.mode !== state.mode
      const sectionSelectionChanged =
        previousState.enabled &&
        state.mode === 'section' &&
        (previousState.sectionKinds !== state.sectionKinds ||
          previousState.sectionMatchMode !== state.sectionMatchMode)

      if (becameEnabled || modeChanged || sectionSelectionChanged) {
        applyPlaybackRangeActivation()
      }
    }
  )

  watch(
    () => {
      const resolution = playbackSectionRangeResolution.value
      return {
        filePath: runtime.playingData.playingSong?.filePath || '',
        sectionMode: isPlaybackSectionRangeMode(runtime.setting),
        status: resolution.status,
        ranges: resolution.ranges
          .map((range) => `${range.startSec.toFixed(3)}-${range.endSec.toFixed(3)}`)
          .join('|')
      }
    },
    (state) => {
      if (!state.filePath || !state.sectionMode) {
        sectionRangeFallbackFilePath.value = null
        return
      }
      if (state.status === 'unanalysed') {
        sectionRangeFallbackFilePath.value = state.filePath
        queueCurrentSongSectionAnalysis()
        return
      }
      if (state.status === 'ready' && sectionRangeFallbackFilePath.value === state.filePath) {
        sectionRangeFallbackFilePath.value = null
        handleLateSectionRangeReady()
        return
      }
      if (state.status === 'no-match') {
        sectionRangeFallbackFilePath.value = null
      }
    },
    { immediate: true }
  )

  return {
    playbackRangeHandlesLocked,
    playbackRangeHandlesVisible,
    playbackRangeLockedRanges,
    playbackRangeHandleStartPercent,
    playbackRangeHandleEndPercent,
    handlePlaybackRangeTimeUpdate,
    handlePlaybackRangeDragEnd,
    resolvePlaybackRangeStartSec
  }
}
