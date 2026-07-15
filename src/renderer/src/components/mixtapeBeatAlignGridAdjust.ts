import { computed, ref, type Ref } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { DynamicBeatGridDownbeatLinePickCandidate } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDynamicBeatGridEdit'

type DynamicBeatGridEditController = {
  isDynamic: Readonly<Ref<boolean>>
  hasV2GridMap: Readonly<Ref<boolean>>
  gridControlsDisabled: Readonly<Ref<boolean>>
  selectTargetByPointer: (event: PointerEvent) => boolean
  resolveDownbeatLinePickCandidateByClientX: (
    clientX: number,
    hitRadiusPx: number
  ) => DynamicBeatGridDownbeatLinePickCandidate | null
  applyDownbeatLinePickCandidate: (
    candidate: DynamicBeatGridDownbeatLinePickCandidate | null
  ) => boolean
  setActiveGridDownbeatBeatOffset: (downbeatBeatOffset: number) => boolean
  setActiveGridDownbeatLineAtSec: (sec: number) => boolean
  shiftActiveGrid: (deltaMs: number) => boolean
}

type DownbeatLinePickCandidate = {
  lineX: number
  hit: boolean
  lineSec?: number
  targetSec?: number
  rangeStartSec?: number
  rangeDurationSec?: number
}

type UseMixtapeBeatAlignGridAdjustParams = {
  previewWrapRef: Ref<HTMLDivElement | null>
  previewLoading: Ref<boolean>
  previewMixxxData: Ref<MixxxWaveformData | null>
  canAdjustGrid?: Ref<boolean>
  previewPlaying: Ref<boolean>
  previewDownbeatBeatOffset: Ref<number>
  previewFirstBeatMs: Ref<number>
  previewStartSec: Ref<number>
  bpm: Readonly<Ref<number>>
  firstBeatMs: Readonly<Ref<number>>
  resolvePreviewAnchorSec: () => number
  resolvePreviewDurationSec: () => number
  resolveVisibleDurationSec: () => number
  clampPreviewStart: (value: number) => number
  getPreviewPlaybackSec: () => number
  schedulePreviewDraw: () => void
  applyPlaybackPhaseCompensation?: (deltaMs: number) => void
  downbeatBeatInterval: number
  downbeatLineHitRadiusPx: number
  dynamicGridEdit?: DynamicBeatGridEditController
}

type GridShiftOptions = {
  preservePlaybackPhase?: boolean
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const normalizeBeatOffset = (value: number, interval: number) => {
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1))
  const numeric = Number(value)
  const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 0
  return ((rounded % safeInterval) + safeInterval) % safeInterval
}

const wrapMsInCycle = (valueMs: number, cycleMs: number) => {
  if (!Number.isFinite(cycleMs) || cycleMs <= 0) return 0
  const wrapped = ((valueMs % cycleMs) + cycleMs) % cycleMs
  return wrapped
}

export const useMixtapeBeatAlignGridAdjust = (params: UseMixtapeBeatAlignGridAdjustParams) => {
  const previewDownbeatLinePicking = ref(false)
  const previewDownbeatLineHoverCenterPx = ref(0)
  const previewDownbeatLineHoverHit = ref(false)

  const canAdjustGrid = computed(() => {
    if (params.canAdjustGrid) return params.canAdjustGrid.value
    if (params.previewLoading.value) return false
    return !!params.previewMixxxData.value
  })

  const canAdjustClipGrid = () =>
    canAdjustGrid.value && params.dynamicGridEdit?.gridControlsDisabled.value !== true

  const previewDownbeatLineHoverVisible = computed(
    () => previewDownbeatLinePicking.value && previewDownbeatLineHoverHit.value
  )

  const previewDownbeatLineGlowStyle = computed(() => ({
    left: `${Math.round(previewDownbeatLineHoverCenterPx.value)}px`
  }))

  const clearPreviewDownbeatLineHover = () => {
    previewDownbeatLineHoverHit.value = false
  }

  const resetDownbeatLinePicking = () => {
    previewDownbeatLinePicking.value = false
    clearPreviewDownbeatLineHover()
  }

  const resolveDownbeatLinePickCandidateByClientX = (clientX: number) => {
    if (params.dynamicGridEdit?.hasV2GridMap.value === true) {
      return params.dynamicGridEdit.resolveDownbeatLinePickCandidateByClientX(
        clientX,
        params.downbeatLineHitRadiusPx
      )
    }
    const wrap = params.previewWrapRef.value
    if (!wrap) return null
    const bpmValue = Number(params.bpm.value)
    if (!Number.isFinite(bpmValue) || bpmValue <= 0) return null
    const beatSec = 60 / bpmValue
    if (!Number.isFinite(beatSec) || beatSec <= 0) return null

    const rect = wrap.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || rect.width <= 0) return null
    const localX = clampNumber(clientX - rect.left, 0, rect.width)
    const ratio = localX / rect.width
    const totalDuration = params.resolvePreviewDurationSec()
    const visibleDuration = totalDuration > 0 ? params.resolveVisibleDurationSec() : 0
    const rangeDurationSec = Math.max(0.001, visibleDuration || totalDuration || 0)
    if (!Number.isFinite(rangeDurationSec) || rangeDurationSec <= 0) return null
    const rangeStartSec =
      totalDuration > 0 ? params.clampPreviewStart(params.previewStartSec.value) : 0
    const targetSec = rangeStartSec + ratio * rangeDurationSec
    const firstBeatSec = (Number(params.firstBeatMs.value) || 0) / 1000
    const beatIndex = Math.round((targetSec - firstBeatSec) / beatSec)
    if (!Number.isFinite(beatIndex)) return null
    const beatTimeSec = firstBeatSec + beatIndex * beatSec
    const lineRatio = (beatTimeSec - rangeStartSec) / rangeDurationSec
    const lineX = clampNumber(lineRatio * rect.width, 0, rect.width)
    const distancePx = Math.abs(localX - lineX)
    return {
      beatIndex,
      lineX,
      hit: distancePx <= params.downbeatLineHitRadiusPx
    }
  }

  const updatePreviewDownbeatLineHover = (clientX: number) => {
    if (!previewDownbeatLinePicking.value) return
    const candidate: DownbeatLinePickCandidate | null =
      resolveDownbeatLinePickCandidateByClientX(clientX)
    if (!candidate || !candidate.hit) {
      clearPreviewDownbeatLineHover()
      return
    }
    previewDownbeatLineHoverCenterPx.value = candidate.lineX
    previewDownbeatLineHoverHit.value = true
  }

  const applyDownbeatLineDefinitionByClientX = (clientX: number) => {
    if (params.dynamicGridEdit?.hasV2GridMap.value === true) {
      const candidate = params.dynamicGridEdit.resolveDownbeatLinePickCandidateByClientX(
        clientX,
        params.downbeatLineHitRadiusPx
      )
      if (!candidate || !candidate.hit) {
        clearPreviewDownbeatLineHover()
        return false
      }
      if (!canAdjustClipGrid()) return false
      const applied = params.dynamicGridEdit.applyDownbeatLinePickCandidate(candidate)
      if (!applied) return false
      resetDownbeatLinePicking()
      return true
    }
    const candidate = resolveDownbeatLinePickCandidateByClientX(clientX)
    if (!candidate || !candidate.hit) {
      clearPreviewDownbeatLineHover()
      return false
    }
    params.previewDownbeatBeatOffset.value = normalizeBeatOffset(
      candidate.beatIndex,
      params.downbeatBeatInterval
    )
    resetDownbeatLinePicking()
    params.schedulePreviewDraw()
    return true
  }

  const handleDownbeatLinePickingToggle = () => {
    if (!canAdjustClipGrid()) return
    previewDownbeatLinePicking.value = !previewDownbeatLinePicking.value
    clearPreviewDownbeatLineHover()
  }

  const handlePreviewMouseMoveForDownbeatLinePicking = (event: MouseEvent) => {
    if (!previewDownbeatLinePicking.value) return
    updatePreviewDownbeatLineHover(event.clientX)
  }

  const handlePreviewMouseLeaveForDownbeatLinePicking = () => {
    if (!previewDownbeatLinePicking.value) return
    clearPreviewDownbeatLineHover()
  }

  const handlePreviewMouseDownForDownbeatLinePicking = (event: PointerEvent) => {
    if (!previewDownbeatLinePicking.value) {
      if (params.dynamicGridEdit?.selectTargetByPointer(event) === true) {
        event.preventDefault()
        event.stopPropagation()
        return true
      }
      return false
    }
    event.preventDefault()
    event.stopPropagation()
    if (!applyDownbeatLineDefinitionByClientX(event.clientX)) {
      updatePreviewDownbeatLineHover(event.clientX)
    }
    return true
  }

  const handleSetDownbeatLineAtPlayhead = () => {
    if (!canAdjustClipGrid()) return
    const bpmValue = Number(params.bpm.value)
    if (!Number.isFinite(bpmValue) || bpmValue <= 0) return
    const beatMs = (60 / bpmValue) * 1000
    if (!Number.isFinite(beatMs) || beatMs <= 0) return
    const playbackSec = Number(params.getPreviewPlaybackSec())
    const candidateSec = params.previewPlaying.value
      ? playbackSec
      : params.resolvePreviewAnchorSec()
    const anchorSec = Number.isFinite(candidateSec)
      ? candidateSec
      : params.resolvePreviewAnchorSec()
    if (params.dynamicGridEdit?.hasV2GridMap.value === true) {
      params.dynamicGridEdit.setActiveGridDownbeatLineAtSec(anchorSec)
      return
    }
    const interval = Math.max(1, Math.floor(params.downbeatBeatInterval || 4))
    const cycleMs = beatMs * interval
    const downbeatBeatOffset = normalizeBeatOffset(params.previewDownbeatBeatOffset.value, interval)
    const anchorMs = Math.max(0, anchorSec * 1000)
    const alignedFirstBeatMs = anchorMs - downbeatBeatOffset * beatMs
    params.previewFirstBeatMs.value = wrapMsInCycle(alignedFirstBeatMs, cycleMs)
    params.schedulePreviewDraw()
  }

  const handleGridShift = (delta: number, options: GridShiftOptions = {}) => {
    if (!canAdjustClipGrid()) return
    if (params.dynamicGridEdit?.hasV2GridMap.value === true) {
      params.dynamicGridEdit.shiftActiveGrid(delta)
      return
    }
    const bpmValue = Number(params.bpm.value)
    if (!Number.isFinite(bpmValue) || bpmValue <= 0) return
    const beatMs = (60 / bpmValue) * 1000
    if (!Number.isFinite(beatMs) || beatMs <= 0) return
    const cycleMs = beatMs * Math.max(1, Math.floor(params.downbeatBeatInterval || 4))
    const nextFirstBeatMs = Number(params.previewFirstBeatMs.value) + Number(delta)
    params.previewFirstBeatMs.value = wrapMsInCycle(nextFirstBeatMs, cycleMs)
    if (options.preservePlaybackPhase === true) {
      params.applyPlaybackPhaseCompensation?.(delta)
    }
    params.schedulePreviewDraw()
  }

  return {
    canAdjustGrid,
    previewDownbeatLinePicking,
    previewDownbeatLineHoverVisible,
    previewDownbeatLineGlowStyle,
    handleDownbeatLinePickingToggle,
    handlePreviewMouseMoveForDownbeatLinePicking,
    handlePreviewMouseLeaveForDownbeatLinePicking,
    handlePreviewMouseDownForDownbeatLinePicking,
    handleSetDownbeatLineAtPlayhead,
    handleGridShift,
    resetDownbeatLinePicking
  }
}
