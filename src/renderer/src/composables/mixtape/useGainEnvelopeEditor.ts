import { computed, ref } from 'vue'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  MIXTAPE_STEM_SEGMENT_PARAMS,
  buildMixEnvelopePolylineByControlPoints,
  clampMixEnvelopeGain,
  mapMixEnvelopeGainToYPercent,
  mapMixEnvelopeYPercentToGain,
  normalizeMixEnvelopePoints,
  sampleMixEnvelopeAtSec
} from '@renderer/composables/mixtape/gainEnvelope'
import {
  GAIN_ENVELOPE_LOCKED_SEC_EPSILON,
  GAIN_ENVELOPE_MAX_POINTS_PER_SEC,
  GAIN_ENVELOPE_MIN_GAP_RATIO,
  GAIN_ENVELOPE_PERSIST_DEBOUNCE_MS,
  GAIN_ENVELOPE_SAME_SEC_EPSILON,
  MIX_PARAM_UNDO_STACK_LIMIT
} from '@renderer/composables/mixtape/gainEnvelopeEditorConstants'
import {
  clampNumber,
  resolveGridAlignedVolumeMuteSegments as resolveGridAlignedVolumeMuteSegmentsByUtils,
  resolveVolumeMuteGrid as resolveVolumeMuteGridByUtils,
  resolveVolumeMutePointerSec,
  resolveVolumeMuteSegmentBySec as resolveVolumeMuteSegmentBySecByUtils,
  resolveVolumeMuteSegmentKey,
  resolveVolumeMuteSegmentMasks as resolveVolumeMuteSegmentMasksByUtils,
  resolveVolumeMuteSegmentsByToggle,
  snapSecToVisibleGrid as snapSecToVisibleGridByUtils
} from '@renderer/composables/mixtape/gainEnvelopeEditorGrid'
import {
  STEM_SEGMENT_ACTIVE_GAIN,
  STEM_SEGMENT_MUTE_THRESHOLD,
  buildStemEnvelopeBySegments
} from '@renderer/composables/mixtape/gainEnvelopeStemSegments'
import type {
  CreateMixtapeGainEnvelopeEditorParams,
  EnvelopeDragState,
  EnvelopePointDot,
  EnvelopeUndoSeed,
  MixSegmentMask,
  MixParamUndoEntry,
  SegmentSelectionState
} from '@renderer/composables/mixtape/gainEnvelopeEditorTypes'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

export const createMixtapeGainEnvelopeEditor = (params: CreateMixtapeGainEnvelopeEditorParams) => {
  const stemSegmentParamSet = new Set<MixtapeEnvelopeParamId>(MIXTAPE_STEM_SEGMENT_PARAMS)
  const segmentModeParamSet = new Set<MixtapeEnvelopeParamId>([
    ...MIXTAPE_STEM_SEGMENT_PARAMS,
    'volume'
  ])
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
  const segmentSelectionState = ref<SegmentSelectionState | null>(null)
  const undoStack = ref<MixParamUndoEntry[]>([])
  const canUndoMixParam = computed(() => undoStack.value.length > 0)
  const envelopeUndoSeed = ref<EnvelopeUndoSeed | null>(null)
  let isApplyingUndo = false
  let mixEnvelopePersistTimer: ReturnType<typeof setTimeout> | null = null
  let volumeMutePersistTimer: ReturnType<typeof setTimeout> | null = null

  const resolveCurrentParam = () => params.resolveActiveParam()
  const isStemSegmentParam = (param: MixtapeEnvelopeParamId) => stemSegmentParamSet.has(param)
  const isSegmentModeParam = (param: MixtapeEnvelopeParamId) => segmentModeParamSet.has(param)
  const resolveRenderZoom = () => Number(params.renderZoomLevel.value) || 0
  const resolveTrackFirstBeatSec = (track: MixtapeTrack) =>
    Math.max(0, Number(params.resolveTrackFirstBeatSeconds(track)) || 0)

  const resolveVolumeMuteGrid = (track: MixtapeTrack, durationSec: number) =>
    resolveVolumeMuteGridByUtils({
      track,
      durationSec,
      zoom: resolveRenderZoom(),
      firstBeatSec: resolveTrackFirstBeatSec(track)
    })

  const resolveGridAlignedVolumeMuteSegments = (
    track: MixtapeTrack,
    durationSec: number,
    value: unknown
  ) =>
    resolveGridAlignedVolumeMuteSegmentsByUtils({
      track,
      durationSec,
      value,
      zoom: resolveRenderZoom(),
      firstBeatSec: resolveTrackFirstBeatSec(track)
    })

  const resolveVolumeMuteSegmentBySec = (payload: {
    track: MixtapeTrack
    durationSec: number
    sec: number
  }) =>
    resolveVolumeMuteSegmentBySecByUtils({
      ...payload,
      zoom: resolveRenderZoom(),
      firstBeatSec: resolveTrackFirstBeatSec(payload.track)
    })

  const snapSecToVisibleGrid = (payload: {
    track: MixtapeTrack
    sec: number
    durationSec: number
    minSec?: number
    maxSec?: number
  }) =>
    snapSecToVisibleGridByUtils({
      ...payload,
      zoom: resolveRenderZoom(),
      firstBeatSec: resolveTrackFirstBeatSec(payload.track)
    })

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

  const resolveTrackStemSegmentState = (trackId: string, param: MixtapeEnvelopeParamId) => {
    const envelopeState = resolveTrackEnvelopeState(trackId, param)
    const { track, durationSec, points } = envelopeState
    if (!track || !durationSec) {
      return {
        track: null,
        durationSec: 0,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    if (!isStemSegmentParam(param)) {
      return {
        track,
        durationSec,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    const grid = resolveVolumeMuteGrid(track, durationSec)
    if (!grid) {
      return {
        track,
        durationSec,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    const epsilon = 0.0001
    const maxSelectableSec = Math.max(0, durationSec - epsilon)
    const startIndex = Math.floor((0 - grid.baseSec) / grid.stepSec)
    const endIndex = Math.floor((maxSelectableSec - grid.baseSec) / grid.stepSec)
    const mutedSegments: MixtapeMuteSegment[] = []
    for (let index = startIndex; index <= endIndex; index += 1) {
      const centerSec = grid.baseSec + (index + 0.5) * grid.stepSec
      const segment = resolveVolumeMuteSegmentBySec({
        track,
        durationSec,
        sec: centerSec
      })
      if (!segment) continue
      const sampleSec = Number(((segment.startSec + segment.endSec) / 2).toFixed(4))
      const gain = sampleMixEnvelopeAtSec(param, points, sampleSec, STEM_SEGMENT_ACTIVE_GAIN)
      if (gain > STEM_SEGMENT_MUTE_THRESHOLD) continue
      mutedSegments.push(segment)
    }
    const segments = resolveGridAlignedVolumeMuteSegments(track, durationSec, mutedSegments)
    return {
      track,
      durationSec,
      segments
    }
  }

  const cloneGainPoints = (points: MixtapeGainPoint[]) =>
    points.map((point) => ({
      sec: Number(point.sec),
      gain: Number(point.gain)
    }))

  const cloneMuteSegments = (segments: MixtapeMuteSegment[]) =>
    segments.map((segment) => ({
      startSec: Number(segment.startSec),
      endSec: Number(segment.endSec)
    }))

  const pushUndoEntry = (entry: MixParamUndoEntry) => {
    if (isApplyingUndo) return
    undoStack.value.push(entry)
    if (undoStack.value.length > MIX_PARAM_UNDO_STACK_LIMIT) {
      undoStack.value.splice(0, undoStack.value.length - MIX_PARAM_UNDO_STACK_LIMIT)
    }
  }

  const pushExternalUndoStep = (undo: (() => boolean) | null | undefined) => {
    if (typeof undo !== 'function') return
    pushUndoEntry({
      type: 'external',
      undo
    })
  }

  const beginEnvelopeUndoSeed = (param: MixtapeEnvelopeParamId, trackId: string) => {
    if (isApplyingUndo || envelopeUndoSeed.value) return
    const { track, points } = resolveTrackEnvelopeState(trackId, param)
    if (!track || points.length < 2) return
    envelopeUndoSeed.value = {
      trackId: track.id,
      param,
      points: cloneGainPoints(points)
    }
  }

  const commitEnvelopeUndoSeed = () => {
    const seed = envelopeUndoSeed.value
    envelopeUndoSeed.value = null
    if (!seed || isApplyingUndo) return
    const { track, points } = resolveTrackEnvelopeState(seed.trackId, seed.param)
    if (!track || points.length < 2) return
    if (JSON.stringify(seed.points) === JSON.stringify(points)) return
    pushUndoEntry({
      type: 'envelope',
      trackId: seed.trackId,
      param: seed.param,
      points: cloneGainPoints(seed.points)
    })
  }

  const pushSegmentUndoEntry = (
    trackId: string,
    param: MixtapeEnvelopeParamId,
    baseSegments: MixtapeMuteSegment[]
  ) => {
    if (isApplyingUndo) return
    const segmentState =
      param === 'volume'
        ? resolveTrackVolumeMuteState(trackId)
        : resolveTrackStemSegmentState(trackId, param)
    const { track, segments } = segmentState
    if (!track) return
    const normalizedBase = cloneMuteSegments(baseSegments)
    if (JSON.stringify(normalizedBase) === JSON.stringify(segments)) return
    pushUndoEntry({
      type: 'segment',
      trackId: track.id,
      param,
      segments: normalizedBase
    })
  }

  const resolveActiveEnvelopePolyline = (item: TimelineTrackLayout) => {
    const param = resolveCurrentParam()
    if (!param) return ''
    if (isStemSegmentParam(param)) return ''
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
    if (isStemSegmentParam(param)) return []
    const { durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!durationSec || points.length < 2) return []
    return points.map((point, index) => ({
      index,
      x: Number(((point.sec / durationSec) * 100).toFixed(3)),
      y: Number(mapMixEnvelopeGainToYPercent(param, point.gain).toFixed(3)),
      isBoundary: index === 0 || index === points.length - 1
    }))
  }

  const resolveActiveSegmentMasks = (item: TimelineTrackLayout): MixSegmentMask[] => {
    const param = resolveCurrentParam()
    if (!param || !isSegmentModeParam(param)) return []
    const { durationSec, segments } =
      param === 'volume'
        ? resolveTrackVolumeMuteState(item.track.id)
        : resolveTrackStemSegmentState(item.track.id, param)
    return resolveVolumeMuteSegmentMasksByUtils(durationSec, segments)
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

  const updateTrackStemSegmentEnvelope = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    nextSegments: MixtapeMuteSegment[]
  ) => {
    if (!isStemSegmentParam(param)) return
    const {
      track,
      durationSec,
      segments: currentSegments
    } = resolveTrackStemSegmentState(trackId, param)
    if (!track || !durationSec) return
    const normalizedSegments = resolveGridAlignedVolumeMuteSegments(
      track,
      durationSec,
      nextSegments
    )
    const currentSignature = JSON.stringify(currentSegments)
    const nextSignature = JSON.stringify(normalizedSegments)
    if (currentSignature === nextSignature) return
    const nextEnvelope = buildStemEnvelopeBySegments(param, durationSec, normalizedSegments)
    updateTrackMixEnvelope(param, track.id, nextEnvelope)
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

  function stopSegmentSelection() {
    segmentSelectionState.value = null
    window.removeEventListener('mousemove', handleSegmentSelectionMove)
    window.removeEventListener('mouseup', handleSegmentSelectionEnd)
  }

  const resolveTrackSegmentState = (trackId: string, param: MixtapeEnvelopeParamId) =>
    param === 'volume'
      ? resolveTrackVolumeMuteState(trackId)
      : resolveTrackStemSegmentState(trackId, param)

  const updateTrackSegmentByParam = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    nextSegments: MixtapeMuteSegment[],
    options?: {
      persist?: boolean
      forcePersist?: boolean
    }
  ) => {
    if (param === 'volume') {
      updateTrackVolumeMuteSegments(trackId, nextSegments, options)
      return
    }
    updateTrackStemSegmentEnvelope(param, trackId, nextSegments)
  }

  function applySegmentSelectionToggle(state: SegmentSelectionState) {
    if (!state.touched.size) return
    const { track } = resolveTrackSegmentState(state.trackId, state.param)
    if (!track) return
    const nextSegments = resolveVolumeMuteSegmentsByToggle(state.baseSegments, state.touched)
    updateTrackSegmentByParam(state.param, track.id, nextSegments, {
      forcePersist: true
    })
  }

  function handleSegmentSelectionMove(event: MouseEvent) {
    const state = segmentSelectionState.value
    if (!state) return
    event.preventDefault()
    const { track, durationSec } = resolveTrackSegmentState(state.trackId, state.param)
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
      updateTrackSegmentByParam(state.param, track.id, nextSegments, {
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
    updateTrackSegmentByParam(state.param, track.id, nextSegments, {
      persist: false
    })
    state.lastSec = pointerSec
  }

  function handleSegmentSelectionEnd() {
    const state = segmentSelectionState.value
    if (!state) return
    const baseSegments = cloneMuteSegments(state.baseSegments)
    stopSegmentSelection()
    applySegmentSelectionToggle(state)
    pushSegmentUndoEntry(state.trackId, state.param, baseSegments)
    if (state.param === 'volume') {
      void flushPendingVolumeMutePersist()
    } else {
      void flushPendingMixEnvelopePersist()
    }
  }

  function startSegmentSelection(
    param: MixtapeEnvelopeParamId,
    trackId: string,
    stageEl: HTMLElement,
    seed: MixtapeMuteSegment
  ) {
    stopSegmentSelection()
    const { track, segments } = resolveTrackSegmentState(trackId, param)
    if (!track) return
    const touched = new Map<string, MixtapeMuteSegment>()
    touched.set(resolveVolumeMuteSegmentKey(seed), seed)
    const nextSegments = resolveVolumeMuteSegmentsByToggle(segments, touched)
    updateTrackSegmentByParam(param, track.id, nextSegments, {
      persist: false
    })
    segmentSelectionState.value = {
      param,
      trackId,
      stageEl,
      baseSegments: segments.map((segment) => ({ ...segment })),
      touched,
      lastSec: Number(((seed.startSec + seed.endSec) / 2).toFixed(4))
    }
    window.addEventListener('mousemove', handleSegmentSelectionMove)
    window.addEventListener('mouseup', handleSegmentSelectionEnd)
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
    commitEnvelopeUndoSeed()
    void flushPendingMixEnvelopePersist()
  }

  function startEnvelopePointDrag(
    param: MixtapeEnvelopeParamId,
    trackId: string,
    pointIndex: number,
    stageEl: HTMLElement
  ) {
    beginEnvelopeUndoSeed(param, trackId)
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
    if (isStemSegmentParam(param)) return
    if (param === 'volume' && params.isSegmentSelectionMode()) return
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
    if (isSegmentModeParam(param) && params.isSegmentSelectionMode()) {
      const { track, durationSec } = resolveTrackSegmentState(item.track.id, param)
      if (!track || !durationSec) return
      const pointerSec = resolveVolumeMutePointerSec(stageEl, event, durationSec)
      if (typeof pointerSec !== 'number') return
      const segment = resolveVolumeMuteSegmentBySec({
        track,
        durationSec,
        sec: pointerSec
      })
      if (!segment) return
      startSegmentSelection(param, track.id, stageEl, segment)
      return
    }
    if (isStemSegmentParam(param)) return
    beginEnvelopeUndoSeed(param, item.track.id)
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
    if (isStemSegmentParam(param)) return
    beginEnvelopeUndoSeed(param, item.track.id)
    removeTrackEnvelopePoint(param, item.track.id, pointIndex)
    commitEnvelopeUndoSeed()
  }

  const handleEnvelopePointContextMenu = (_item: TimelineTrackLayout, _pointIndex: number) => {}

  const restoreEnvelopeUndoEntry = (entry: Extract<MixParamUndoEntry, { type: 'envelope' }>) => {
    const { track, durationSec, points } = resolveTrackEnvelopeState(entry.trackId, entry.param)
    if (!track || !durationSec) return false
    const normalized = normalizeMixEnvelopePoints(entry.param, entry.points, durationSec)
    if (normalized.length < 2) return false
    if (JSON.stringify(points) === JSON.stringify(normalized)) return false
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[entry.param]
    params.tracks.value = params.tracks.value.map((item) =>
      item.id === track.id
        ? ({
            ...item,
            [envelopeField]: normalized
          } as MixtapeTrack)
        : item
    )
    scheduleMixEnvelopePersist(entry.param, track.id, normalized)
    void flushPendingMixEnvelopePersist()
    return true
  }

  const restoreSegmentUndoEntry = (entry: Extract<MixParamUndoEntry, { type: 'segment' }>) => {
    const { track, durationSec, segments } = resolveTrackSegmentState(entry.trackId, entry.param)
    if (!track || !durationSec) return false
    const normalized = resolveGridAlignedVolumeMuteSegments(track, durationSec, entry.segments)
    if (JSON.stringify(segments) === JSON.stringify(normalized)) return false
    if (entry.param === 'volume') {
      params.tracks.value = params.tracks.value.map((item) =>
        item.id === track.id
          ? ({
              ...item,
              volumeMuteSegments: normalized
            } as MixtapeTrack)
          : item
      )
      scheduleVolumeMuteSegmentsPersist(track.id, normalized)
      void flushPendingVolumeMutePersist()
      return true
    }
    const nextEnvelope = buildStemEnvelopeBySegments(entry.param, durationSec, normalized)
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[entry.param]
    params.tracks.value = params.tracks.value.map((item) =>
      item.id === track.id
        ? ({
            ...item,
            [envelopeField]: nextEnvelope
          } as MixtapeTrack)
        : item
    )
    scheduleMixEnvelopePersist(entry.param, track.id, nextEnvelope)
    void flushPendingMixEnvelopePersist()
    return true
  }

  const undoLastMixParamChange = () => {
    stopEnvelopePointDrag()
    stopSegmentSelection()
    envelopeUndoSeed.value = null
    while (undoStack.value.length > 0) {
      const entry = undoStack.value.pop()
      if (!entry) break
      isApplyingUndo = true
      try {
        if (entry.type === 'envelope') {
          if (restoreEnvelopeUndoEntry(entry)) return true
        } else if (entry.type === 'segment') {
          if (restoreSegmentUndoEntry(entry)) return true
        } else if (entry.undo()) {
          return true
        }
      } finally {
        isApplyingUndo = false
      }
    }
    return false
  }

  const cleanupGainEnvelopeEditor = () => {
    stopEnvelopePointDrag()
    stopSegmentSelection()
    envelopeUndoSeed.value = null
    undoStack.value = []
    void flushPendingMixEnvelopePersist()
    void flushPendingVolumeMutePersist()
  }

  return {
    resolveActiveEnvelopePolyline,
    resolveActiveEnvelopePointDots,
    resolveActiveSegmentMasks,
    handleEnvelopePointMouseDown,
    handleEnvelopeStageMouseDown,
    handleEnvelopePointDoubleClick,
    handleEnvelopePointContextMenu,
    canUndoMixParam,
    pushExternalUndoStep,
    undoLastMixParamChange,
    cleanupGainEnvelopeEditor
  }
}
