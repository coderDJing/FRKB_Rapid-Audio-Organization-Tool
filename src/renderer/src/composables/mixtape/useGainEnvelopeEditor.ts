import { ref } from 'vue'
import type { Ref } from 'vue'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  buildMixEnvelopePolylineByControlPoints,
  clampMixEnvelopeGain,
  mapMixEnvelopeGainToYPercent,
  mapMixEnvelopeYPercentToGain,
  normalizeMixEnvelopePoints,
  sampleMixEnvelopeAtSec
} from '@renderer/composables/mixtape/gainEnvelope'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import { GRID_BEAT4_LINE_ZOOM, GRID_BEAT_LINE_ZOOM } from '@renderer/composables/mixtape/constants'
import {
  normalizeBeatOffset as normalizeBeatOffsetByMixxx,
  resolveBeatSecByBpm
} from '@renderer/composables/mixtape/mixxxSyncModel'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
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

type VolumeMuteSegmentMask = {
  key: string
  left: number
  width: number
}

type VolumeMuteSelectionState = {
  trackId: string
  stageEl: HTMLElement
  baseSegments: MixtapeMuteSegment[]
  touched: Map<string, MixtapeMuteSegment>
  lastSec: number
}

type CreateMixtapeGainEnvelopeEditorParams = {
  tracks: Ref<MixtapeTrack[]>
  renderZoomLevel: Ref<number>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
  resolveActiveParam: () => MixtapeEnvelopeParamId | null
  isVolumeMuteSelectionMode: () => boolean
  isEditable: () => boolean
}

const GAIN_ENVELOPE_MIN_GAP_RATIO = 0.004
const GAIN_ENVELOPE_PERSIST_DEBOUNCE_MS = 180
const GAIN_ENVELOPE_LOCKED_SEC_EPSILON = 0.0001
const GAIN_ENVELOPE_SAME_SEC_EPSILON = 0.0001
const GAIN_ENVELOPE_MAX_POINTS_PER_SEC = 2
const VOLUME_MUTE_SEGMENT_EPSILON = 0.0001

export const createMixtapeGainEnvelopeEditor = (params: CreateMixtapeGainEnvelopeEditorParams) => {
  const pendingMixEnvelopePersist = new Map<
    string,
    {
      param: MixtapeEnvelopeParamId
      trackId: string
      gainEnvelope: Array<{ sec: number; gain: number }>
    }
  >()
  const pendingVolumeMutePersist = new Map<string, Array<{ startSec: number; endSec: number }>>()
  const envelopeDragState = ref<EnvelopeDragState | null>(null)
  const volumeMuteSelectionState = ref<VolumeMuteSelectionState | null>(null)
  let mixEnvelopePersistTimer: ReturnType<typeof setTimeout> | null = null
  let volumeMutePersistTimer: ReturnType<typeof setTimeout> | null = null

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

  const resolveTrackVolumeMuteState = (trackId: string) => {
    const safeTrackId = String(trackId || '').trim()
    const track = params.tracks.value.find((item) => item.id === safeTrackId) || null
    if (!track) {
      return {
        track: null,
        durationSec: 0,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    const rawDurationSec = params.resolveTrackDurationSeconds(track)
    const durationSec =
      Number.isFinite(rawDurationSec) && rawDurationSec > 0 ? Math.max(0, rawDurationSec) : 0
    const segments = resolveGridAlignedVolumeMuteSegments(
      track,
      durationSec,
      track.volumeMuteSegments
    )
    return {
      track,
      durationSec,
      segments
    }
  }

  const resolveVolumeMuteSegmentKey = (segment: MixtapeMuteSegment) =>
    `${Number(segment.startSec).toFixed(4)}:${Number(segment.endSec).toFixed(4)}`

  const resolveVolumeMuteStepBeats = () => {
    const zoom = Number(params.renderZoomLevel.value) || 0
    if (zoom >= GRID_BEAT_LINE_ZOOM) return 1
    if (zoom >= GRID_BEAT4_LINE_ZOOM) return 4
    return 32
  }

  const resolveVolumeMuteGrid = (track: MixtapeTrack, durationSec: number) => {
    const beatSec = resolveBeatSecByBpm(Number(track.bpm))
    if (!beatSec) return null
    const stepBeats = resolveVolumeMuteStepBeats()
    const firstBeatSec = Math.max(0, Number(params.resolveTrackFirstBeatSeconds(track)) || 0)
    const barOffset = normalizeBeatOffsetByMixxx(track.barBeatOffset, 32)
    const baseSec = stepBeats === 1 ? firstBeatSec : firstBeatSec + barOffset * beatSec
    const stepSec = beatSec * stepBeats
    if (!Number.isFinite(stepSec) || stepSec <= 0) return null
    return {
      durationSec: Math.max(0, Number(durationSec) || 0),
      baseSec,
      stepSec
    }
  }

  const resolveGridAlignedVolumeMuteSegments = (
    track: MixtapeTrack,
    durationSec: number,
    value: unknown
  ) => {
    const normalized = normalizeVolumeMuteSegments(value, durationSec)
    if (!normalized.length) return [] as MixtapeMuteSegment[]
    const grid = resolveVolumeMuteGrid(track, durationSec)
    if (!grid) return normalized
    const segmentMap = new Map<string, MixtapeMuteSegment>()
    for (const segment of normalized) {
      const safeStart = clampNumber(Number(segment.startSec) || 0, 0, grid.durationSec)
      const safeEnd = clampNumber(Number(segment.endSec) || 0, 0, grid.durationSec)
      if (safeEnd - safeStart <= VOLUME_MUTE_SEGMENT_EPSILON) continue
      const startIndex = Math.floor((safeStart - grid.baseSec) / grid.stepSec)
      const endIndex = Math.floor(
        (Math.max(safeStart, safeEnd - VOLUME_MUTE_SEGMENT_EPSILON) - grid.baseSec) / grid.stepSec
      )
      for (let index = startIndex; index <= endIndex; index += 1) {
        const rawStartSec = grid.baseSec + index * grid.stepSec
        const rawEndSec = rawStartSec + grid.stepSec
        const segmentStartSec = clampNumber(rawStartSec, 0, grid.durationSec)
        const segmentEndSec = clampNumber(rawEndSec, 0, grid.durationSec)
        if (segmentEndSec - segmentStartSec <= VOLUME_MUTE_SEGMENT_EPSILON) continue
        const alignedSegment: MixtapeMuteSegment = {
          startSec: Number(segmentStartSec.toFixed(4)),
          endSec: Number(segmentEndSec.toFixed(4))
        }
        segmentMap.set(resolveVolumeMuteSegmentKey(alignedSegment), alignedSegment)
      }
    }
    return normalizeVolumeMuteSegments(Array.from(segmentMap.values()), durationSec)
  }

  const resolveVolumeMutePointerSec = (
    stageEl: HTMLElement,
    event: MouseEvent,
    durationSec: number
  ) => {
    const rect = stageEl.getBoundingClientRect()
    if (!rect.width || !durationSec) return null
    const xRatio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1)
    return Number((xRatio * durationSec).toFixed(4))
  }

  const resolveVolumeMuteSegmentBySec = (payload: {
    track: MixtapeTrack
    durationSec: number
    sec: number
  }): MixtapeMuteSegment | null => {
    const grid = resolveVolumeMuteGrid(payload.track, payload.durationSec)
    if (!grid) return null
    const maxSelectableSec = Math.max(0, grid.durationSec - VOLUME_MUTE_SEGMENT_EPSILON)
    const safeSec = clampNumber(Number(payload.sec) || 0, 0, maxSelectableSec)
    const index = Math.floor((safeSec - grid.baseSec) / grid.stepSec)
    const startSec = grid.baseSec + index * grid.stepSec
    const endSec = startSec + grid.stepSec
    const safeStartSec = clampNumber(startSec, 0, grid.durationSec)
    const safeEndSec = clampNumber(endSec, 0, grid.durationSec)
    if (safeEndSec - safeStartSec <= VOLUME_MUTE_SEGMENT_EPSILON) return null
    return {
      startSec: Number(safeStartSec.toFixed(4)),
      endSec: Number(safeEndSec.toFixed(4))
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

  const resolveVolumeMuteSegmentMasks = (item: TimelineTrackLayout): VolumeMuteSegmentMask[] => {
    const { durationSec, segments } = resolveTrackVolumeMuteState(item.track.id)
    if (!durationSec || !segments.length) return []
    return segments
      .map((segment) => {
        const startRatio = clampNumber(segment.startSec / durationSec, 0, 1)
        const endRatio = clampNumber(segment.endSec / durationSec, 0, 1)
        const widthRatio = Math.max(0, endRatio - startRatio)
        if (widthRatio <= 0.0001) return null
        return {
          key: resolveVolumeMuteSegmentKey(segment),
          left: Number((startRatio * 100).toFixed(4)),
          width: Number((widthRatio * 100).toFixed(4))
        }
      })
      .filter((segment): segment is VolumeMuteSegmentMask => segment !== null)
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
    if (!beatSec) return null
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

  const clearVolumeMutePersistTimer = () => {
    if (!volumeMutePersistTimer) return
    clearTimeout(volumeMutePersistTimer)
    volumeMutePersistTimer = null
  }

  const flushPendingVolumeMutePersist = async () => {
    clearVolumeMutePersistTimer()
    if (!pendingVolumeMutePersist.size || !window?.electron?.ipcRenderer?.invoke) return
    const entries = Array.from(pendingVolumeMutePersist.entries()).map(([trackId, segments]) => ({
      itemId: trackId,
      segments
    }))
    pendingVolumeMutePersist.clear()
    if (!entries.length) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-volume-mute-segments', {
        entries
      })
    } catch (error) {
      console.error('[mixtape] volume mute segments persist failed', {
        count: entries.length,
        error
      })
    }
  }

  const scheduleVolumeMuteSegmentsPersist = (trackId: string, segments: MixtapeMuteSegment[]) => {
    const safeTrackId = String(trackId || '').trim()
    if (!safeTrackId) return
    pendingVolumeMutePersist.set(
      safeTrackId,
      segments.map((segment) => ({
        startSec: Number(segment.startSec),
        endSec: Number(segment.endSec)
      }))
    )
    clearVolumeMutePersistTimer()
    volumeMutePersistTimer = setTimeout(() => {
      volumeMutePersistTimer = null
      void flushPendingVolumeMutePersist()
    }, GAIN_ENVELOPE_PERSIST_DEBOUNCE_MS)
  }

  const updateTrackVolumeMuteSegments = (
    trackId: string,
    nextSegments: MixtapeMuteSegment[],
    options?: {
      persist?: boolean
      forcePersist?: boolean
    }
  ) => {
    const { track, durationSec, segments: currentSegments } = resolveTrackVolumeMuteState(trackId)
    if (!track || !durationSec) return
    const normalized = resolveGridAlignedVolumeMuteSegments(track, durationSec, nextSegments)
    const shouldPersist = options?.persist !== false
    const forcePersist = options?.forcePersist === true
    const currentSignature = JSON.stringify(currentSegments)
    const nextSignature = JSON.stringify(normalized)
    if (currentSignature !== nextSignature) {
      params.tracks.value = params.tracks.value.map((item) =>
        item.id === track.id
          ? ({
              ...item,
              volumeMuteSegments: normalized
            } as MixtapeTrack)
          : item
      )
    } else if (!forcePersist) {
      return
    }
    if (shouldPersist) {
      scheduleVolumeMuteSegmentsPersist(track.id, normalized)
    }
  }

  const resolveVolumeMuteSegmentsByToggle = (
    baseSegments: MixtapeMuteSegment[],
    touched: Map<string, MixtapeMuteSegment>
  ) => {
    const nextMap = new Map(
      baseSegments.map((segment) => [resolveVolumeMuteSegmentKey(segment), segment])
    )
    for (const [key, segment] of touched.entries()) {
      if (nextMap.has(key)) {
        nextMap.delete(key)
      } else {
        nextMap.set(key, segment)
      }
    }
    return Array.from(nextMap.values())
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

  function stopVolumeMuteSelection() {
    volumeMuteSelectionState.value = null
    window.removeEventListener('mousemove', handleVolumeMuteSelectionMove)
    window.removeEventListener('mouseup', handleVolumeMuteSelectionEnd)
  }

  function applyVolumeMuteSelectionToggle(state: VolumeMuteSelectionState) {
    if (!state.touched.size) return
    const { track } = resolveTrackVolumeMuteState(state.trackId)
    if (!track) return
    const nextSegments = resolveVolumeMuteSegmentsByToggle(state.baseSegments, state.touched)
    updateTrackVolumeMuteSegments(track.id, nextSegments, {
      forcePersist: true
    })
  }

  function handleVolumeMuteSelectionMove(event: MouseEvent) {
    const state = volumeMuteSelectionState.value
    if (!state) return
    event.preventDefault()
    const { track, durationSec } = resolveTrackVolumeMuteState(state.trackId)
    if (!track || !durationSec) return
    const grid = resolveVolumeMuteGrid(track, durationSec)
    if (!grid) return
    const pointerSec = resolveVolumeMutePointerSec(state.stageEl, event, durationSec)
    if (typeof pointerSec !== 'number') return
    const previousSegment = resolveVolumeMuteSegmentBySec({
      track,
      durationSec,
      sec: state.lastSec
    })
    const currentSegment = resolveVolumeMuteSegmentBySec({
      track,
      durationSec,
      sec: pointerSec
    })
    if (!currentSegment) return
    if (!previousSegment) {
      state.touched.set(resolveVolumeMuteSegmentKey(currentSegment), currentSegment)
      const nextSegments = resolveVolumeMuteSegmentsByToggle(state.baseSegments, state.touched)
      updateTrackVolumeMuteSegments(track.id, nextSegments, {
        persist: false
      })
      state.lastSec = pointerSec
      return
    }
    const toIndex = Math.round((currentSegment.startSec - grid.baseSec) / grid.stepSec)
    const fromIndex = Math.round((previousSegment.startSec - grid.baseSec) / grid.stepSec)
    const minIndex = Math.min(fromIndex, toIndex)
    const maxIndex = Math.max(fromIndex, toIndex)
    for (let index = minIndex; index <= maxIndex; index += 1) {
      const sec = grid.baseSec + (index + 0.5) * grid.stepSec
      const segment = resolveVolumeMuteSegmentBySec({
        track,
        durationSec,
        sec
      })
      if (!segment) continue
      state.touched.set(resolveVolumeMuteSegmentKey(segment), segment)
    }
    const nextSegments = resolveVolumeMuteSegmentsByToggle(state.baseSegments, state.touched)
    updateTrackVolumeMuteSegments(track.id, nextSegments, {
      persist: false
    })
    state.lastSec = pointerSec
  }

  function handleVolumeMuteSelectionEnd() {
    const state = volumeMuteSelectionState.value
    if (!state) return
    stopVolumeMuteSelection()
    applyVolumeMuteSelectionToggle(state)
    void flushPendingVolumeMutePersist()
  }

  function startVolumeMuteSelection(
    trackId: string,
    stageEl: HTMLElement,
    seed: MixtapeMuteSegment
  ) {
    stopVolumeMuteSelection()
    const { track, segments } = resolveTrackVolumeMuteState(trackId)
    if (!track) return
    const touched = new Map<string, MixtapeMuteSegment>()
    touched.set(resolveVolumeMuteSegmentKey(seed), seed)
    const nextSegments = resolveVolumeMuteSegmentsByToggle(segments, touched)
    updateTrackVolumeMuteSegments(track.id, nextSegments, {
      persist: false
    })
    volumeMuteSelectionState.value = {
      trackId,
      stageEl,
      baseSegments: segments.map((segment) => ({ ...segment })),
      touched,
      lastSec: Number(((seed.startSec + seed.endSec) / 2).toFixed(4))
    }
    window.addEventListener('mousemove', handleVolumeMuteSelectionMove)
    window.addEventListener('mouseup', handleVolumeMuteSelectionEnd)
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
      const currentSec = points[state.pointIndex]?.sec ?? pointer.sec
      const prevPointSec = points[state.pointIndex - 1]?.sec
      const nextPointSec = points[state.pointIndex + 1]?.sec
      const sameSecWithPrev =
        typeof prevPointSec === 'number' &&
        Math.abs(currentSec - prevPointSec) <= GAIN_ENVELOPE_SAME_SEC_EPSILON
      const sameSecWithNext =
        typeof nextPointSec === 'number' &&
        Math.abs(nextPointSec - currentSec) <= GAIN_ENVELOPE_SAME_SEC_EPSILON
      if (sameSecWithPrev || sameSecWithNext) {
        nextSec = currentSec
      } else {
        const prevSec = points[state.pointIndex - 1]?.sec ?? 0
        const nextSecLimit = points[state.pointIndex + 1]?.sec ?? durationSec
        const minAllowedSec = prevSec + minGapSec
        const maxAllowedSec = nextSecLimit - minGapSec
        if (maxAllowedSec - minAllowedSec <= GAIN_ENVELOPE_LOCKED_SEC_EPSILON) {
          nextSec = clampNumber(points[state.pointIndex]?.sec ?? pointer.sec, prevSec, nextSecLimit)
        } else {
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
      }
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
    if (param === 'volume' && params.isVolumeMuteSelectionMode()) return
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
    if (param === 'volume' && params.isVolumeMuteSelectionMode()) {
      const { track, durationSec } = resolveTrackVolumeMuteState(item.track.id)
      if (!track || !durationSec) return
      const pointerSec = resolveVolumeMutePointerSec(stageEl, event, durationSec)
      if (typeof pointerSec !== 'number') return
      const segment = resolveVolumeMuteSegmentBySec({
        track,
        durationSec,
        sec: pointerSec
      })
      if (!segment) return
      startVolumeMuteSelection(track.id, stageEl, segment)
      return
    }
    const { track, durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!track || !durationSec || points.length < 2) return
    const pointer = resolveEnvelopePointer(param, stageEl, event, durationSec)
    if (!pointer) return

    const minGapSec = resolveEnvelopeMinGapSec(durationSec)
    const safeSec = snapSecToVisibleGrid({
      track,
      sec: pointer.sec,
      durationSec
    })
    if (typeof safeSec !== 'number') return
    const safeGain = clampMixEnvelopeGain(param, pointer.gain)
    const safeSecRounded = Number(safeSec.toFixed(4))
    const safeGainRounded = Number(safeGain.toFixed(6))
    const nextPoints = points.map((point) => ({ ...point }))
    let targetPointIndex = 0
    const instantJumpMode = event.shiftKey
    const resolveSameSecBucket = (insertIndexInput: number) => {
      let insertIndex = insertIndexInput
      if (insertIndex < 0) insertIndex = nextPoints.length
      let sameSecStart = insertIndex - 1
      while (
        sameSecStart >= 0 &&
        Math.abs(nextPoints[sameSecStart].sec - safeSecRounded) <= GAIN_ENVELOPE_SAME_SEC_EPSILON
      ) {
        sameSecStart -= 1
      }
      sameSecStart += 1
      let sameSecEnd = insertIndex
      while (
        sameSecEnd < nextPoints.length &&
        Math.abs(nextPoints[sameSecEnd].sec - safeSecRounded) <= GAIN_ENVELOPE_SAME_SEC_EPSILON
      ) {
        sameSecEnd += 1
      }
      sameSecEnd -= 1
      const sameSecCount = sameSecEnd >= sameSecStart ? sameSecEnd - sameSecStart + 1 : 0
      return {
        insertIndex,
        sameSecStart,
        sameSecCount
      }
    }

    if (instantJumpMode && safeSec > minGapSec && safeSec < durationSec - minGapSec) {
      const bucket = resolveSameSecBucket(
        nextPoints.findIndex((point) => point.sec > safeSecRounded)
      )
      if (bucket.sameSecCount >= GAIN_ENVELOPE_MAX_POINTS_PER_SEC) {
        targetPointIndex = bucket.sameSecStart + GAIN_ENVELOPE_MAX_POINTS_PER_SEC - 1
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: safeGainRounded
        }
      } else if (bucket.sameSecCount === 1) {
        targetPointIndex = bucket.sameSecStart + 1
        nextPoints.splice(targetPointIndex, 0, {
          sec: safeSecRounded,
          gain: safeGainRounded
        })
      } else {
        const jumpStartGain = clampMixEnvelopeGain(
          param,
          sampleMixEnvelopeAtSec(param, points, safeSecRounded, safeGain)
        )
        nextPoints.splice(
          bucket.insertIndex,
          0,
          {
            sec: safeSecRounded,
            gain: Number(jumpStartGain.toFixed(6))
          },
          {
            sec: safeSecRounded,
            gain: safeGainRounded
          }
        )
        targetPointIndex = bucket.insertIndex + 1
      }
    } else if (safeSec <= minGapSec) {
      targetPointIndex = 0
      nextPoints[0] = {
        ...nextPoints[0],
        sec: 0,
        gain: safeGainRounded
      }
    } else if (safeSec >= durationSec - minGapSec) {
      targetPointIndex = nextPoints.length - 1
      nextPoints[targetPointIndex] = {
        ...nextPoints[targetPointIndex],
        sec: Number(durationSec.toFixed(4)),
        gain: safeGainRounded
      }
    } else {
      const bucket = resolveSameSecBucket(
        nextPoints.findIndex((point) => point.sec > safeSecRounded)
      )
      if (bucket.sameSecCount === 1) {
        targetPointIndex = bucket.sameSecStart + 1
        nextPoints.splice(targetPointIndex, 0, {
          sec: safeSecRounded,
          gain: safeGainRounded
        })
        updateTrackMixEnvelope(param, track.id, nextPoints)
        startEnvelopePointDrag(param, track.id, targetPointIndex, stageEl)
        return
      }
      if (bucket.sameSecCount >= GAIN_ENVELOPE_MAX_POINTS_PER_SEC) {
        targetPointIndex = bucket.sameSecStart + GAIN_ENVELOPE_MAX_POINTS_PER_SEC - 1
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: safeGainRounded
        }
        updateTrackMixEnvelope(param, track.id, nextPoints)
        startEnvelopePointDrag(param, track.id, targetPointIndex, stageEl)
        return
      }
      let insertIndex = bucket.insertIndex
      if (insertIndex < 0) insertIndex = nextPoints.length - 1
      const prevPoint = nextPoints[Math.max(0, insertIndex - 1)]
      const nextPoint = nextPoints[insertIndex]
      const nearPrev = !!prevPoint && Math.abs(safeSecRounded - prevPoint.sec) <= minGapSec
      const nearNext = !!nextPoint && Math.abs(nextPoint.sec - safeSecRounded) <= minGapSec
      if (nearPrev) {
        targetPointIndex = Math.max(0, insertIndex - 1)
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: safeGainRounded
        }
      } else if (nearNext) {
        targetPointIndex = insertIndex
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: safeGainRounded
        }
      } else {
        targetPointIndex = insertIndex
        nextPoints.splice(insertIndex, 0, {
          sec: safeSecRounded,
          gain: safeGainRounded
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

  const handleEnvelopePointContextMenu = (_item: TimelineTrackLayout, _pointIndex: number) => {}

  const cleanupGainEnvelopeEditor = () => {
    stopEnvelopePointDrag()
    stopVolumeMuteSelection()
    void flushPendingMixEnvelopePersist()
    void flushPendingVolumeMutePersist()
  }

  return {
    resolveActiveEnvelopePolyline,
    resolveActiveEnvelopePointDots,
    resolveVolumeMuteSegmentMasks,
    handleEnvelopePointMouseDown,
    handleEnvelopeStageMouseDown,
    handleEnvelopePointDoubleClick,
    handleEnvelopePointContextMenu,
    cleanupGainEnvelopeEditor
  }
}
