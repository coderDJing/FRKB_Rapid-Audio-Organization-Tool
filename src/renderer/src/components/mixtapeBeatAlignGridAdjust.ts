import { computed, ref, type Ref } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'

type UseMixtapeBeatAlignGridAdjustParams = {
  previewWrapRef: Ref<HTMLDivElement | null>
  previewLoading: Ref<boolean>
  previewMixxxData: Ref<MixxxWaveformData | null>
  previewPlaying: Ref<boolean>
  previewBarBeatOffset: Ref<number>
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
  barBeatInterval: number
  barLineHitRadiusPx: number
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
  const previewBarLinePicking = ref(false)
  const previewBarLineHoverCenterPx = ref(0)
  const previewBarLineHoverHit = ref(false)

  const canAdjustGrid = computed(() => {
    if (params.previewLoading.value) return false
    return !!params.previewMixxxData.value
  })

  const previewBarLineHoverVisible = computed(
    () => previewBarLinePicking.value && previewBarLineHoverHit.value
  )

  const previewBarLineGlowStyle = computed(() => ({
    left: `${Math.round(previewBarLineHoverCenterPx.value)}px`
  }))

  const clearPreviewBarLineHover = () => {
    previewBarLineHoverHit.value = false
  }

  const resetBarLinePicking = () => {
    previewBarLinePicking.value = false
    clearPreviewBarLineHover()
  }

  const resolveBarLinePickCandidateByClientX = (clientX: number) => {
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
      hit: distancePx <= params.barLineHitRadiusPx
    }
  }

  const updatePreviewBarLineHover = (clientX: number) => {
    if (!previewBarLinePicking.value) return
    const candidate = resolveBarLinePickCandidateByClientX(clientX)
    if (!candidate || !candidate.hit) {
      clearPreviewBarLineHover()
      return
    }
    previewBarLineHoverCenterPx.value = candidate.lineX
    previewBarLineHoverHit.value = true
  }

  const applyBarLineDefinitionByClientX = (clientX: number) => {
    const candidate = resolveBarLinePickCandidateByClientX(clientX)
    if (!candidate || !candidate.hit) {
      clearPreviewBarLineHover()
      return false
    }
    params.previewBarBeatOffset.value = normalizeBeatOffset(
      candidate.beatIndex,
      params.barBeatInterval
    )
    resetBarLinePicking()
    params.schedulePreviewDraw()
    return true
  }

  const handleBarLinePickingToggle = () => {
    if (!canAdjustGrid.value) return
    previewBarLinePicking.value = !previewBarLinePicking.value
    clearPreviewBarLineHover()
  }

  const handlePreviewMouseMoveForBarLinePicking = (event: MouseEvent) => {
    if (!previewBarLinePicking.value) return
    updatePreviewBarLineHover(event.clientX)
  }

  const handlePreviewMouseLeaveForBarLinePicking = () => {
    if (!previewBarLinePicking.value) return
    clearPreviewBarLineHover()
  }

  const handlePreviewMouseDownForBarLinePicking = (event: MouseEvent) => {
    if (!previewBarLinePicking.value) return false
    event.preventDefault()
    event.stopPropagation()
    if (!applyBarLineDefinitionByClientX(event.clientX)) {
      updatePreviewBarLineHover(event.clientX)
    }
    return true
  }

  const handleSetBarLineAtPlayhead = () => {
    if (!canAdjustGrid.value) return
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
    const interval = Math.max(1, Math.floor(params.barBeatInterval || 32))
    const cycleMs = beatMs * interval
    const barBeatOffset = normalizeBeatOffset(params.previewBarBeatOffset.value, interval)
    const anchorMs = Math.max(0, anchorSec * 1000)
    const alignedFirstBeatMs = anchorMs - barBeatOffset * beatMs
    params.previewFirstBeatMs.value = wrapMsInCycle(alignedFirstBeatMs, cycleMs)
    params.schedulePreviewDraw()
  }

  const handleGridShift = (delta: number) => {
    if (!canAdjustGrid.value) return
    const bpmValue = Number(params.bpm.value)
    if (!Number.isFinite(bpmValue) || bpmValue <= 0) return
    const beatMs = (60 / bpmValue) * 1000
    if (!Number.isFinite(beatMs) || beatMs <= 0) return
    const cycleMs = beatMs * Math.max(1, Math.floor(params.barBeatInterval || 32))
    const nextFirstBeatMs = Number(params.previewFirstBeatMs.value) + Number(delta)
    params.previewFirstBeatMs.value = wrapMsInCycle(nextFirstBeatMs, cycleMs)
    params.schedulePreviewDraw()
  }

  return {
    canAdjustGrid,
    previewBarLinePicking,
    previewBarLineHoverVisible,
    previewBarLineGlowStyle,
    handleBarLinePickingToggle,
    handlePreviewMouseMoveForBarLinePicking,
    handlePreviewMouseLeaveForBarLinePicking,
    handlePreviewMouseDownForBarLinePicking,
    handleSetBarLineAtPlayhead,
    handleGridShift,
    resetBarLinePicking
  }
}
