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
  canAdjustMetronomeVolume: boolean
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
  canAdjustMetronomeVolume: Ref<boolean>
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
  handleGridShift: (deltaMs: number) => void
  handleMetronomeToggle: () => void
  handleMetronomeVolumeCycle: () => void
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
      canAdjustMetronomeVolume: params.canAdjustMetronomeVolume.value
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
    const parsed = parsePreviewBpmInput(value)
    if (parsed === null) {
      params.previewBpmInput.value = formatPreviewBpm(params.previewBpm.value)
      emitToolbarState()
      return
    }
    params.previewBpm.value = parsed
    params.previewBpmInput.value = formatPreviewBpm(parsed)
    params.resetPreviewBpmTap()
    emitToolbarState()
    params.scheduleDraw()
    params.schedulePersistGridDefinition()
  }

  const handlePreviewBpmInputBlur = () => {
    params.previewBpmInput.value = formatPreviewBpm(params.previewBpm.value)
    emitToolbarState()
    void params.persistGridDefinition()
  }

  const handlePreviewBpmTap = () => {
    if (!params.canAdjustGrid.value || params.previewLoading.value) return
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
    params.previewBpm.value = normalizePreviewBpm(60000 / avgMs)
    params.previewBpmInput.value = formatPreviewBpm(params.previewBpm.value)
    emitToolbarState()
    params.scheduleDraw()
    params.schedulePersistGridDefinition()
  }

  const toggleBarLinePicking = () => {
    params.handleBarLinePickingToggle()
    emitToolbarState()
  }

  const setBarLineAtPlayhead = () => {
    params.handleSetBarLineAtPlayhead()
    emitToolbarState()
    params.schedulePersistGridDefinition()
  }

  const shiftGrid = (deltaMs: number) => {
    params.handleGridShift(deltaMs)
    emitToolbarState()
    params.schedulePersistGridDefinition()
  }

  const toggleMetronome = () => {
    if (!params.canToggleMetronome.value) return
    params.handleMetronomeToggle()
    emitToolbarState()
  }

  const cycleMetronomeVolume = () => {
    if (!params.canAdjustMetronomeVolume.value) return
    params.handleMetronomeVolumeCycle()
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
    toggleMetronome,
    cycleMetronomeVolume
  }
}
