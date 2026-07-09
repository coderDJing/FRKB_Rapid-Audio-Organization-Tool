import type { Ref } from 'vue'
import {
  PREVIEW_BAR_BEAT_INTERVAL,
  PREVIEW_BPM_MAX,
  PREVIEW_BPM_MIN,
  PREVIEW_BPM_STEP,
  PREVIEW_BPM_TAP_MAX_COUNT,
  PREVIEW_BPM_TAP_MAX_DELTA_MS,
  PREVIEW_BPM_TAP_MIN_DELTA_MS,
  PREVIEW_BPM_TAP_RESET_MS,
  formatPreviewBpm,
  normalizeBeatOffset,
  normalizePreviewBpm,
  parsePreviewBpmInput
} from '@renderer/components/MixtapeBeatAlignDialog.constants'

export type HorizontalBrowseGridToolbarState = {
  disabled: boolean
  bpmInputValue: string
  bpmStep: number
  bpmMin: number
  bpmMax: number
  barLinePicking: boolean
  metronomeEnabled: boolean
  metronomeVolumeLevel: 1 | 2 | 3
  canToggleMetronome: boolean
  gridControlsDisabled: boolean
  showSplitAfterPlayhead: boolean
  showDeleteBoundary: boolean
  gridAdjustScope: 'whole' | 'after'
}

export type HorizontalBrowseGridShiftOptions = {
  preservePlaybackPhase?: boolean
}

type UseHorizontalBrowseGridToolbarParams = {
  canAdjustGrid: Ref<boolean>
  previewLoading: Ref<boolean>
  previewBpm: Ref<number>
  previewBpmInput: Ref<string>
  previewFirstBeatMs: Ref<number>
  previewBarBeatOffset: Ref<number>
  previewTimeBasisOffsetMs: Ref<number>
  bpmTapTimestamps: Ref<number[]>
  previewBarLinePicking: Ref<boolean>
  metronomeEnabled: Ref<boolean>
  metronomeVolumeLevel: Ref<1 | 2 | 3>
  canToggleMetronome: Ref<boolean>
  emitToolbarStateChange: (value: HorizontalBrowseGridToolbarState) => void
  resolveDisplayGridBpm: () => number
  resolveSongFirstBeatMs: () => number
  resolveSongBarBeatOffset: () => number
  resolveSongTimeBasisOffsetMs: () => number
  scheduleDraw: () => void
  schedulePreviewBpmTapReset: () => void
  persistGridDefinition: () => Promise<void>
  schedulePersistGridDefinition: () => void
  resetPreviewBpmTap: () => void
  resetBarLinePicking: () => void
  handleBarLinePickingToggle: () => void
  handleSetBarLineAtPlayhead: () => void
  handleGridShift: (deltaMs: number, options?: HorizontalBrowseGridShiftOptions) => void
  handleMetronomeStateCycle: () => void
  resolveGridControlsDisabled?: () => boolean
  resolveShowSplitAfterPlayhead?: () => boolean
  resolveShowDeleteBoundary?: () => boolean
  resolveGridAdjustScope?: () => 'whole' | 'after'
  handleSelectWholeAdjustment?: () => void
  handleSplitAfterPlayhead?: () => void
  handleDeleteBoundary?: () => void
  applyBpmToActiveGridTarget?: (bpm: number) => boolean
}

export const useHorizontalBrowseGridToolbar = (params: UseHorizontalBrowseGridToolbarParams) => {
  const emitToolbarState = () => {
    params.emitToolbarStateChange({
      disabled: !params.canAdjustGrid.value || params.previewLoading.value,
      bpmInputValue: params.previewBpmInput.value,
      bpmStep: PREVIEW_BPM_STEP,
      bpmMin: PREVIEW_BPM_MIN,
      bpmMax: PREVIEW_BPM_MAX,
      barLinePicking: params.previewBarLinePicking.value,
      metronomeEnabled: params.metronomeEnabled.value,
      metronomeVolumeLevel: params.metronomeVolumeLevel.value,
      canToggleMetronome: params.canToggleMetronome.value,
      gridControlsDisabled: params.resolveGridControlsDisabled?.() === true,
      showSplitAfterPlayhead: params.resolveShowSplitAfterPlayhead?.() === true,
      showDeleteBoundary: params.resolveShowDeleteBoundary?.() === true,
      gridAdjustScope: params.resolveGridAdjustScope?.() === 'after' ? 'after' : 'whole'
    })
  }

  const syncGridStateFromSong = () => {
    params.previewBpm.value = params.resolveDisplayGridBpm()
    params.previewBpmInput.value =
      params.previewBpm.value > 0 ? formatPreviewBpm(params.previewBpm.value) : ''
    params.previewFirstBeatMs.value = Math.max(0, params.resolveSongFirstBeatMs())
    params.previewBarBeatOffset.value = normalizeBeatOffset(
      params.resolveSongBarBeatOffset(),
      PREVIEW_BAR_BEAT_INTERVAL
    )
    params.previewTimeBasisOffsetMs.value = Math.max(
      0,
      Number(params.resolveSongTimeBasisOffsetMs()) || 0
    )
    params.resetPreviewBpmTap()
    params.resetBarLinePicking()
    emitToolbarState()
  }

  const handlePreviewBpmInputUpdate = (value: string) => {
    if (params.resolveGridControlsDisabled?.() === true) return
    const parsed = parsePreviewBpmInput(value)
    if (parsed === null) {
      params.previewBpmInput.value = formatPreviewBpm(params.previewBpm.value)
      emitToolbarState()
      return
    }
    if (!params.applyBpmToActiveGridTarget?.(parsed)) {
      params.previewBpm.value = parsed
      params.previewBpmInput.value = formatPreviewBpm(parsed)
    }
    params.resetPreviewBpmTap()
    emitToolbarState()
    params.scheduleDraw()
    params.schedulePersistGridDefinition()
  }

  const handlePreviewBpmInputBlur = () => {
    if (params.resolveGridControlsDisabled?.() === true) return
    params.previewBpmInput.value = formatPreviewBpm(params.previewBpm.value)
    emitToolbarState()
    void params.persistGridDefinition()
  }

  const handlePreviewBpmTap = () => {
    if (!params.canAdjustGrid.value || params.previewLoading.value) return
    if (params.resolveGridControlsDisabled?.() === true) return
    const now = Date.now()
    const lastTap = params.bpmTapTimestamps.value[params.bpmTapTimestamps.value.length - 1]
    if (lastTap && now - lastTap > PREVIEW_BPM_TAP_RESET_MS) {
      params.bpmTapTimestamps.value = []
    }
    params.bpmTapTimestamps.value.push(now)
    if (params.bpmTapTimestamps.value.length > PREVIEW_BPM_TAP_MAX_COUNT) {
      params.bpmTapTimestamps.value =
        params.bpmTapTimestamps.value.slice(-PREVIEW_BPM_TAP_MAX_COUNT)
    }
    params.schedulePreviewBpmTapReset()

    if (params.bpmTapTimestamps.value.length < 2) return
    const deltas: number[] = []
    for (let index = 1; index < params.bpmTapTimestamps.value.length; index += 1) {
      const delta = params.bpmTapTimestamps.value[index] - params.bpmTapTimestamps.value[index - 1]
      if (delta > PREVIEW_BPM_TAP_MIN_DELTA_MS && delta < PREVIEW_BPM_TAP_MAX_DELTA_MS) {
        deltas.push(delta)
      }
    }
    if (!deltas.length) return
    const avgMs = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
    if (!Number.isFinite(avgMs) || avgMs <= 0) return
    const nextBpm = normalizePreviewBpm(60000 / avgMs)
    if (!params.applyBpmToActiveGridTarget?.(nextBpm)) {
      params.previewBpm.value = nextBpm
      params.previewBpmInput.value = formatPreviewBpm(params.previewBpm.value)
    }
    emitToolbarState()
    params.scheduleDraw()
    params.schedulePersistGridDefinition()
  }

  const toggleBarLinePicking = () => {
    params.handleBarLinePickingToggle()
    emitToolbarState()
  }

  const setBarLineAtPlayhead = () => {
    if (params.resolveGridControlsDisabled?.() === true) return
    params.handleSetBarLineAtPlayhead()
    emitToolbarState()
    params.schedulePersistGridDefinition()
  }

  const shiftGrid = (deltaMs: number, options?: HorizontalBrowseGridShiftOptions) => {
    if (params.resolveGridControlsDisabled?.() === true) return
    params.handleGridShift(deltaMs, options)
    emitToolbarState()
    params.schedulePersistGridDefinition()
  }

  const cycleMetronomeState = () => {
    if (!params.canToggleMetronome.value) return
    params.handleMetronomeStateCycle()
    emitToolbarState()
  }

  const splitAfterPlayhead = () => {
    params.handleSplitAfterPlayhead?.()
    emitToolbarState()
  }

  const selectWholeAdjustment = () => {
    params.handleSelectWholeAdjustment?.()
    emitToolbarState()
  }

  const deleteBoundary = () => {
    params.handleDeleteBoundary?.()
    emitToolbarState()
  }

  return {
    emitToolbarState,
    syncGridStateFromSong,
    handlePreviewBpmInputUpdate,
    handlePreviewBpmInputBlur,
    handlePreviewBpmTap,
    toggleBarLinePicking,
    setBarLineAtPlayhead,
    shiftGrid,
    cycleMetronomeState,
    selectWholeAdjustment,
    splitAfterPlayhead,
    deleteBoundary
  }
}
