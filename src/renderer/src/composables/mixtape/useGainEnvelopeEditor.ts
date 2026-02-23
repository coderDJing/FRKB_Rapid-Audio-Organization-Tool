import { ref } from 'vue'
import type { Ref } from 'vue'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  buildMixEnvelopePolylineByControlPoints,
  clampMixEnvelopeGain,
  mapMixEnvelopeGainToYPercent,
  mapMixEnvelopeYPercentToGain,
  normalizeMixEnvelopePoints
} from '@renderer/composables/mixtape/gainEnvelope'
import { GRID_BEAT4_LINE_ZOOM, GRID_BEAT_LINE_ZOOM } from '@renderer/composables/mixtape/constants'
import {
  normalizeBeatOffset as normalizeBeatOffsetByMixxx,
  resolveBeatSecByBpm
} from '@renderer/composables/mixtape/mixxxSyncModel'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

type EnvelopePointDot = {
  index: number
  x: number
  y: number
  isBoundary: boolean
}

type EnvelopeDragState = {
  param: MixtapeEnvelopeParamId
  trackId: string
  pointIndex: number
  stageEl: HTMLElement
}

type CreateMixtapeGainEnvelopeEditorParams = {
  tracks: Ref<MixtapeTrack[]>
  renderZoomLevel: Ref<number>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
  resolveActiveParam: () => MixtapeEnvelopeParamId | null
  isEditable: () => boolean
}

const GAIN_ENVELOPE_MIN_GAP_RATIO = 0.004
const GAIN_ENVELOPE_PERSIST_DEBOUNCE_MS = 180

export const createMixtapeGainEnvelopeEditor = (params: CreateMixtapeGainEnvelopeEditorParams) => {
  const pendingMixEnvelopePersist = new Map<
    string,
    {
      param: MixtapeEnvelopeParamId
      trackId: string
      gainEnvelope: Array<{ sec: number; gain: number }>
    }
  >()
  const envelopeDragState = ref<EnvelopeDragState | null>(null)
  let mixEnvelopePersistTimer: ReturnType<typeof setTimeout> | null = null

  const clampNumber = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value))

  const resolveCurrentParam = () => params.resolveActiveParam()

  const resolveTrackEnvelopeState = (trackId: string, param: MixtapeEnvelopeParamId) => {
    const safeTrackId = String(trackId || '').trim()
    const track = params.tracks.value.find((item) => item.id === safeTrackId) || null
    if (!track) {
      return {
        track: null,
        durationSec: 0,
        points: [] as MixtapeGainPoint[]
      }
    }
    const rawDurationSec = params.resolveTrackDurationSeconds(track)
    const durationSec =
      Number.isFinite(rawDurationSec) && rawDurationSec > 0 ? Math.max(0, rawDurationSec) : 0
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
    const points = normalizeMixEnvelopePoints(param, (track as any)?.[envelopeField], durationSec)
    return {
      track,
      durationSec,
      points
    }
  }

  const resolveActiveEnvelopePolyline = (item: TimelineTrackLayout) => {
    const param = resolveCurrentParam()
    if (!param) return ''
    const { track, durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!track || !durationSec || points.length < 2) return ''
    return buildMixEnvelopePolylineByControlPoints({
      param,
      points,
      durationSec
    })
  }

  const resolveActiveEnvelopePointDots = (item: TimelineTrackLayout): EnvelopePointDot[] => {
    const param = resolveCurrentParam()
    if (!param) return []
    const { durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!durationSec || points.length < 2) return []
    return points.map((point, index) => ({
      index,
      x: Number(((point.sec / durationSec) * 100).toFixed(3)),
      y: Number(mapMixEnvelopeGainToYPercent(param, point.gain).toFixed(3)),
      isBoundary: index === 0 || index === points.length - 1
    }))
  }

  const resolveGridSnapModes = () => {
    const zoom = Number(params.renderZoomLevel.value) || 0
    const snapBeat = zoom >= GRID_BEAT_LINE_ZOOM
    const snapBeat4 = zoom >= GRID_BEAT4_LINE_ZOOM
    return {
      snapBar: true,
      snapBeat4,
      snapBeat
    }
  }

  const resolveNearestGridSec = (payload: {
    targetSec: number
    minSec: number
    maxSec: number
    baseSec: number
    stepSec: number
  }) => {
    const targetSec = Number(payload.targetSec)
    const minSec = Number(payload.minSec)
    const maxSec = Number(payload.maxSec)
    const baseSec = Number(payload.baseSec)
    const stepSec = Number(payload.stepSec)
    if (!Number.isFinite(targetSec) || !Number.isFinite(minSec) || !Number.isFinite(maxSec))
      return null
    if (maxSec < minSec) return null
    if (!Number.isFinite(baseSec) || !Number.isFinite(stepSec) || stepSec <= 0) return null
    const minN = Math.ceil((minSec - baseSec) / stepSec)
    const maxN = Math.floor((maxSec - baseSec) / stepSec)
    if (minN > maxN) return null
    const approxN = Math.round((targetSec - baseSec) / stepSec)
    const safeN = Math.max(minN, Math.min(maxN, approxN))
    return baseSec + safeN * stepSec
  }

  const snapSecToVisibleGrid = (payload: {
    track: MixtapeTrack
    sec: number
    durationSec: number
    minSec?: number
    maxSec?: number
  }) => {
    const durationSec = Math.max(0, Number(payload.durationSec) || 0)
    const minSec = clampNumber(Number(payload.minSec) || 0, 0, durationSec)
    const maxSec = clampNumber(
      Number.isFinite(Number(payload.maxSec)) ? Number(payload.maxSec) : durationSec,
      minSec,
      durationSec
    )
    const safeSec = clampNumber(Number(payload.sec) || 0, minSec, maxSec)
    const track = payload.track
    const beatSec = resolveBeatSecByBpm(Number(track.bpm))
    if (!beatSec) return safeSec
    const firstBeatSec = Math.max(0, Number(params.resolveTrackFirstBeatSeconds(track)) || 0)
    const barOffset = normalizeBeatOffsetByMixxx(track.barBeatOffset, 32)
    const barBaseSec = firstBeatSec + barOffset * beatSec
    const { snapBar, snapBeat4, snapBeat } = resolveGridSnapModes()
    const candidates: number[] = []
    if (snapBar) {
      const barSec = resolveNearestGridSec({
        targetSec: safeSec,
        minSec,
        maxSec,
        baseSec: barBaseSec,
        stepSec: beatSec * 32
      })
      if (typeof barSec === 'number' && Number.isFinite(barSec)) candidates.push(barSec)
    }
    if (snapBeat4) {
      const beat4Sec = resolveNearestGridSec({
        targetSec: safeSec,
        minSec,
        maxSec,
        baseSec: barBaseSec,
        stepSec: beatSec * 4
      })
      if (typeof beat4Sec === 'number' && Number.isFinite(beat4Sec)) candidates.push(beat4Sec)
    }
    if (snapBeat) {
      const beatSecPoint = resolveNearestGridSec({
        targetSec: safeSec,
        minSec,
        maxSec,
        baseSec: firstBeatSec,
        stepSec: beatSec
      })
      if (typeof beatSecPoint === 'number' && Number.isFinite(beatSecPoint))
        candidates.push(beatSecPoint)
    }
    if (!candidates.length) return null
    let nearest = candidates[0]
    let minDiff = Math.abs(nearest - safeSec)
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i]
      const diff = Math.abs(candidate - safeSec)
      if (diff < minDiff) {
        minDiff = diff
        nearest = candidate
      }
    }
    return clampNumber(nearest, minSec, maxSec)
  }

  const clearMixEnvelopePersistTimer = () => {
    if (!mixEnvelopePersistTimer) return
    clearTimeout(mixEnvelopePersistTimer)
    mixEnvelopePersistTimer = null
  }

  const flushPendingMixEnvelopePersist = async () => {
    clearMixEnvelopePersistTimer()
    if (!pendingMixEnvelopePersist.size || !window?.electron?.ipcRenderer?.invoke) return
    const grouped = new Map<
      MixtapeEnvelopeParamId,
      Array<{ itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> }>
    >()
    for (const item of pendingMixEnvelopePersist.values()) {
      if (!grouped.has(item.param)) grouped.set(item.param, [])
      const list = grouped.get(item.param)
      if (!list) continue
      list.push({
        itemId: item.trackId,
        gainEnvelope: item.gainEnvelope
      })
    }
    pendingMixEnvelopePersist.clear()
    for (const [param, entries] of grouped.entries()) {
      const normalizedEntries = entries.filter(
        (item) =>
          item.itemId.trim().length > 0 &&
          Array.isArray(item.gainEnvelope) &&
          item.gainEnvelope.length >= 2
      )
      if (!normalizedEntries.length) continue
      try {
        await window.electron.ipcRenderer.invoke('mixtape:update-mix-envelope', {
          param,
          entries: normalizedEntries
        })
      } catch (error) {
        console.error('[mixtape] manual mix envelope persist failed', {
          param,
          count: normalizedEntries.length,
          error
        })
      }
    }
  }

  const scheduleMixEnvelopePersist = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    points: MixtapeGainPoint[]
  ) => {
    const safeTrackId = String(trackId || '').trim()
    if (!safeTrackId || !Array.isArray(points) || points.length < 2) return
    pendingMixEnvelopePersist.set(`${param}:${safeTrackId}`, {
      param,
      trackId: safeTrackId,
      gainEnvelope: points.map((point) => ({
        sec: Number(point.sec),
        gain: Number(point.gain)
      }))
    })
    clearMixEnvelopePersistTimer()
    mixEnvelopePersistTimer = setTimeout(() => {
      mixEnvelopePersistTimer = null
      void flushPendingMixEnvelopePersist()
    }, GAIN_ENVELOPE_PERSIST_DEBOUNCE_MS)
  }

  const updateTrackMixEnvelope = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    nextPoints: MixtapeGainPoint[]
  ) => {
    const { track, durationSec, points: currentPoints } = resolveTrackEnvelopeState(trackId, param)
    if (!track || !durationSec) return
    const normalized = normalizeMixEnvelopePoints(param, nextPoints, durationSec)
    if (normalized.length < 2) return
    const currentSignature = JSON.stringify(currentPoints)
    const nextSignature = JSON.stringify(normalized)
    if (currentSignature !== nextSignature) {
      const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
      params.tracks.value = params.tracks.value.map((item) =>
        item.id === track.id
          ? ({
              ...item,
              [envelopeField]: normalized
            } as MixtapeTrack)
          : item
      )
    }
    scheduleMixEnvelopePersist(param, track.id, normalized)
  }

  const resolveEnvelopePointer = (
    param: MixtapeEnvelopeParamId,
    stageEl: HTMLElement,
    event: MouseEvent,
    durationSec: number
  ) => {
    const rect = stageEl.getBoundingClientRect()
    if (!rect.width || !rect.height || !durationSec) return null
    const xRatio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1)
    const yRatio = clampNumber((event.clientY - rect.top) / rect.height, 0, 1)
    return {
      sec: Number((xRatio * durationSec).toFixed(4)),
      gain: Number(mapMixEnvelopeYPercentToGain(param, yRatio * 100).toFixed(6))
    }
  }

  const resolveEnvelopeMinGapSec = (durationSec: number) =>
    Math.max(0.01, durationSec * GAIN_ENVELOPE_MIN_GAP_RATIO)

  function stopEnvelopePointDrag() {
    envelopeDragState.value = null
    window.removeEventListener('mousemove', handleEnvelopePointDragMove)
    window.removeEventListener('mouseup', handleEnvelopePointDragEnd)
  }

  function handleEnvelopePointDragMove(event: MouseEvent) {
    const state = envelopeDragState.value
    if (!state) return
    event.preventDefault()
    const { track, durationSec, points } = resolveTrackEnvelopeState(state.trackId, state.param)
    if (!track || !durationSec || points.length < 2) return
    if (state.pointIndex < 0 || state.pointIndex >= points.length) return
    const pointer = resolveEnvelopePointer(state.param, state.stageEl, event, durationSec)
    if (!pointer) return

    const minGapSec = resolveEnvelopeMinGapSec(durationSec)
    let nextSec = pointer.sec
    if (state.pointIndex === 0) {
      nextSec = 0
    } else if (state.pointIndex === points.length - 1) {
      nextSec = durationSec
    } else {
      const prevSec = points[state.pointIndex - 1]?.sec ?? 0
      const nextSecLimit = points[state.pointIndex + 1]?.sec ?? durationSec
      const minAllowedSec = prevSec + minGapSec
      const maxAllowedSec = nextSecLimit - minGapSec
      const snapped = snapSecToVisibleGrid({
        track,
        sec: nextSec,
        durationSec,
        minSec: minAllowedSec,
        maxSec: maxAllowedSec
      })
      if (typeof snapped !== 'number') return
      nextSec = snapped
    }

    const nextPoints = points.map((point, index) =>
      index === state.pointIndex
        ? {
            sec: Number(nextSec.toFixed(4)),
            gain: Number(clampMixEnvelopeGain(state.param, pointer.gain).toFixed(6))
          }
        : point
    )
    updateTrackMixEnvelope(state.param, track.id, nextPoints)
  }

  function handleEnvelopePointDragEnd() {
    if (!envelopeDragState.value) return
    stopEnvelopePointDrag()
    void flushPendingMixEnvelopePersist()
  }

  function startEnvelopePointDrag(
    param: MixtapeEnvelopeParamId,
    trackId: string,
    pointIndex: number,
    stageEl: HTMLElement
  ) {
    stopEnvelopePointDrag()
    envelopeDragState.value = {
      param,
      trackId,
      pointIndex,
      stageEl
    }
    window.addEventListener('mousemove', handleEnvelopePointDragMove)
    window.addEventListener('mouseup', handleEnvelopePointDragEnd)
  }

  const handleEnvelopePointMouseDown = (
    item: TimelineTrackLayout,
    pointIndex: number,
    event: MouseEvent
  ) => {
    const param = resolveCurrentParam()
    if (!params.isEditable() || !param || event.button !== 0) return
    const currentTarget = event.currentTarget as HTMLElement | null
    const stageEl = currentTarget?.closest('.lane-track__envelope-points') as HTMLElement | null
    if (!stageEl) return
    startEnvelopePointDrag(param, item.track.id, pointIndex, stageEl)
  }

  const handleEnvelopeStageMouseDown = (item: TimelineTrackLayout, event: MouseEvent) => {
    const param = resolveCurrentParam()
    if (!params.isEditable() || !param || event.button !== 0) return
    const stageEl = event.currentTarget as HTMLElement | null
    if (!stageEl) return
    const { track, durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!track || !durationSec || points.length < 2) return
    const pointer = resolveEnvelopePointer(param, stageEl, event, durationSec)
    if (!pointer) return

    const minGapSec = resolveEnvelopeMinGapSec(durationSec)
    const safeSec =
      snapSecToVisibleGrid({
        track,
        sec: pointer.sec,
        durationSec
      }) ?? clampNumber(pointer.sec, 0, durationSec)
    const safeGain = clampMixEnvelopeGain(param, pointer.gain)
    const nextPoints = points.map((point) => ({ ...point }))
    let targetPointIndex = 0

    if (safeSec <= minGapSec) {
      targetPointIndex = 0
      nextPoints[0] = {
        ...nextPoints[0],
        sec: 0,
        gain: Number(safeGain.toFixed(6))
      }
    } else if (safeSec >= durationSec - minGapSec) {
      targetPointIndex = nextPoints.length - 1
      nextPoints[targetPointIndex] = {
        ...nextPoints[targetPointIndex],
        sec: Number(durationSec.toFixed(4)),
        gain: Number(safeGain.toFixed(6))
      }
    } else {
      let insertIndex = nextPoints.findIndex((point) => point.sec > safeSec)
      if (insertIndex < 0) insertIndex = nextPoints.length - 1
      const prevPoint = nextPoints[Math.max(0, insertIndex - 1)]
      const nextPoint = nextPoints[insertIndex]
      const nearPrev = !!prevPoint && Math.abs(safeSec - prevPoint.sec) <= minGapSec
      const nearNext = !!nextPoint && Math.abs(nextPoint.sec - safeSec) <= minGapSec
      if (nearPrev) {
        targetPointIndex = Math.max(0, insertIndex - 1)
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: Number(safeGain.toFixed(6))
        }
      } else if (nearNext) {
        targetPointIndex = insertIndex
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: Number(safeGain.toFixed(6))
        }
      } else {
        targetPointIndex = insertIndex
        nextPoints.splice(insertIndex, 0, {
          sec: Number(safeSec.toFixed(4)),
          gain: Number(safeGain.toFixed(6))
        })
      }
    }

    updateTrackMixEnvelope(param, track.id, nextPoints)
    startEnvelopePointDrag(param, track.id, targetPointIndex, stageEl)
  }

  const removeTrackEnvelopePoint = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    pointIndex: number
  ) => {
    const { track, points } = resolveTrackEnvelopeState(trackId, param)
    if (!track || points.length <= 2) return
    if (pointIndex <= 0 || pointIndex >= points.length - 1) return
    const nextPoints = points.filter((_, index) => index !== pointIndex)
    updateTrackMixEnvelope(param, track.id, nextPoints)
  }

  const handleEnvelopePointDoubleClick = (item: TimelineTrackLayout, pointIndex: number) => {
    const param = resolveCurrentParam()
    if (!params.isEditable() || !param) return
    removeTrackEnvelopePoint(param, item.track.id, pointIndex)
  }

  const handleEnvelopePointContextMenu = (item: TimelineTrackLayout, pointIndex: number) => {
    const param = resolveCurrentParam()
    if (!params.isEditable() || !param) return
    removeTrackEnvelopePoint(param, item.track.id, pointIndex)
  }

  const cleanupGainEnvelopeEditor = () => {
    stopEnvelopePointDrag()
    void flushPendingMixEnvelopePersist()
  }

  return {
    resolveActiveEnvelopePolyline,
    resolveActiveEnvelopePointDots,
    handleEnvelopePointMouseDown,
    handleEnvelopeStageMouseDown,
    handleEnvelopePointDoubleClick,
    handleEnvelopePointContextMenu,
    cleanupGainEnvelopeEditor
  }
}
