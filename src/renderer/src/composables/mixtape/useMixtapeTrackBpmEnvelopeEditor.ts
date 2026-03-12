import { computed, ref, type Ref } from 'vue'
import type {
  MixtapeBpmPoint,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'
import {
  buildTrackBpmEnvelopePolylineByControlPoints,
  cloneTrackBpmPoints,
  mapTrackBpmToYPercent,
  mapTrackBpmYPercentToValue,
  normalizeTrackBpmEnvelopePoints,
  rebuildTrackBpmEnvelopePointsFromSourceAnchors,
  resolveTrackBpmEnvelopeBaseValue,
  resolveTrackBpmEnvelopeClampRange,
  resolveNearestTrackVisibleGridLine,
  resolveTrackBpmEnvelopeRenderablePoints,
  resolveTrackBpmEnvelopeVisualRange,
  resolveTrackGridSourceBpm,
  resolveTrackLocalSecAtSourceTime,
  resolveTrackSourceTimeAtLocalSec,
  snapTrackLocalSecToBeatGrid,
  sampleTrackBpmEnvelopeAtSec
} from '@renderer/composables/mixtape/trackBpmEnvelope'

type BpmEnvelopePointDot = {
  index: number
  x: number
  y: number
  bpm: number
  label: string
  labelPlacement: 'above' | 'below'
  labelAlign: 'center' | 'left' | 'right'
  isBoundary: boolean
}

type TrackBpmEnvelopeSnapshot = {
  trackId: string
  points: MixtapeBpmPoint[]
}

type BpmEnvelopeDragState = {
  trackId: string
  pointIndex: number
  stageEl: HTMLElement
  draftPoints: MixtapeBpmPoint[]
  draftDurationSec: number
  startSec: number
  beforeSnapshots: TrackBpmEnvelopeSnapshot[]
}

type PendingBpmPersistEntry = {
  points: MixtapeBpmPoint[]
  durationSec: number
}

type CreateMixtapeTrackBpmEnvelopeEditorParams = {
  tracks: Ref<MixtapeTrack[]>
  laneTracks: Ref<TimelineTrackLayout[][]>
  renderZoomLevel: Ref<number>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
  pushExternalUndoStep: (undo: (() => boolean) | null | undefined) => void
  isEditable: () => boolean
  onEnvelopePreviewChanged?: () => void
  onEnvelopeCommitted?: () => void
}

const BPM_POINT_SEC_EPSILON = 0.0001
const BPM_PERSIST_DEBOUNCE_MS = 220

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const buildSignature = (points: MixtapeBpmPoint[]) => JSON.stringify(points)

export const createMixtapeTrackBpmEnvelopeEditor = (
  params: CreateMixtapeTrackBpmEnvelopeEditorParams
) => {
  const dragState = ref<BpmEnvelopeDragState | null>(null)
  const pendingPersist = new Map<string, PendingBpmPersistEntry>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  const resolveTrackStartSec = (trackId: string) => {
    for (const lane of params.laneTracks.value) {
      const item = lane.find((candidate) => candidate.track.id === trackId)
      if (!item) continue
      const startSec = Number(item.startSec)
      if (Number.isFinite(startSec) && startSec >= 0) return startSec
    }
    const track = params.tracks.value.find((item) => item.id === trackId)
    const startSec = Number(track?.startSec)
    if (Number.isFinite(startSec) && startSec >= 0) return startSec
    return 0
  }

  const resolveTrackState = (trackId: string, options?: { includeDraft?: boolean }) => {
    const activeDragState = dragState.value
    const includeDraft = options?.includeDraft !== false
    if (includeDraft && activeDragState && activeDragState.trackId === trackId) {
      const track = params.tracks.value.find((item) => item.id === trackId) || null
      if (!track) {
        return {
          track: null,
          durationSec: 0,
          startSec: 0,
          points: [] as MixtapeBpmPoint[]
        }
      }
      return {
        track,
        durationSec: activeDragState.draftDurationSec,
        startSec: activeDragState.startSec,
        points: cloneTrackBpmPoints(activeDragState.draftPoints)
      }
    }
    const track = params.tracks.value.find((item) => item.id === trackId) || null
    if (!track) {
      return {
        track: null,
        durationSec: 0,
        startSec: 0,
        points: [] as MixtapeBpmPoint[]
      }
    }
    const durationSec = Math.max(0, Number(params.resolveTrackDurationSeconds(track)) || 0)
    const startSec = resolveTrackStartSec(trackId)
    const baseBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const points = normalizeTrackBpmEnvelopePoints(track.bpmEnvelope, durationSec, baseBpm)
    return {
      track,
      durationSec,
      startSec,
      points
    }
  }

  const clearPersistTimer = () => {
    if (!persistTimer) return
    clearTimeout(persistTimer)
    persistTimer = null
  }

  const flushPendingPersist = async () => {
    clearPersistTimer()
    if (!pendingPersist.size || !window?.electron?.ipcRenderer?.invoke) return
    const entries = Array.from(pendingPersist.entries()).map(([trackId, entry]) => ({
      itemId: trackId,
      bpmEnvelope: entry.points.map((point) => ({
        sec: Number(point.sec),
        bpm: Number(point.bpm),
        sourceSec:
          Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0
            ? Number(Number(point.sourceSec).toFixed(4))
            : undefined
      })),
      bpmEnvelopeDurationSec: Number(entry.durationSec)
    }))
    pendingPersist.clear()
    if (!entries.length) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-bpm-envelope', {
        entries
      })
    } catch (error) {
      console.error('[mixtape] bpm envelope persist failed', {
        count: entries.length,
        error
      })
    }
  }

  const schedulePersist = (trackId: string, points: MixtapeBpmPoint[]) => {
    const durationSec = Math.max(
      0,
      ...points.map((point) => (Number.isFinite(Number(point.sec)) ? Number(point.sec) : 0))
    )
    pendingPersist.set(trackId, {
      points: cloneTrackBpmPoints(points),
      durationSec: Number(durationSec.toFixed(4))
    })
    clearPersistTimer()
    persistTimer = setTimeout(() => {
      persistTimer = null
      void flushPendingPersist()
    }, BPM_PERSIST_DEBOUNCE_MS)
  }

  const buildMappedSourceSegment = (paramsInput: {
    sourcePoints: MixtapeBpmPoint[]
    sourceStartSec: number
    targetStartSec: number
    overlapStartSec: number
    overlapEndSec: number
    sourceFallbackBpm: number
  }) => {
    const {
      sourcePoints,
      sourceStartSec,
      targetStartSec,
      overlapStartSec,
      overlapEndSec,
      sourceFallbackBpm
    } = paramsInput
    const sourceLocalStart = overlapStartSec - sourceStartSec
    const sourceLocalEnd = overlapEndSec - sourceStartSec
    const mapped: MixtapeBpmPoint[] = [
      {
        sec: Number((overlapStartSec - targetStartSec).toFixed(4)),
        bpm: sampleTrackBpmEnvelopeAtSec(sourcePoints, sourceLocalStart, sourceFallbackBpm)
      }
    ]
    for (const point of sourcePoints) {
      if (point.sec <= sourceLocalStart + BPM_POINT_SEC_EPSILON) continue
      if (point.sec >= sourceLocalEnd - BPM_POINT_SEC_EPSILON) continue
      mapped.push({
        sec: Number((sourceStartSec + point.sec - targetStartSec).toFixed(4)),
        bpm: point.bpm
      })
    }
    mapped.push({
      sec: Number((overlapEndSec - targetStartSec).toFixed(4)),
      bpm: sampleTrackBpmEnvelopeAtSec(sourcePoints, sourceLocalEnd, sourceFallbackBpm)
    })
    return mapped
  }

  const replaceTrackSegment = (paramsInput: {
    track: MixtapeTrack
    currentPoints: MixtapeBpmPoint[]
    replacementPoints: MixtapeBpmPoint[]
    segmentStartSec: number
    segmentEndSec: number
    durationSec: number
  }) => {
    const { track, currentPoints, replacementPoints, segmentStartSec, segmentEndSec, durationSec } =
      paramsInput
    const fallbackBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const safeStartSec = clampNumber(segmentStartSec, 0, durationSec)
    const safeEndSec = clampNumber(segmentEndSec, safeStartSec, durationSec)
    const beforeValue = sampleTrackBpmEnvelopeAtSec(
      currentPoints,
      Math.max(0, safeStartSec - BPM_POINT_SEC_EPSILON),
      fallbackBpm
    )
    const afterValue = sampleTrackBpmEnvelopeAtSec(
      currentPoints,
      Math.min(durationSec, safeEndSec + BPM_POINT_SEC_EPSILON),
      fallbackBpm
    )
    const nextPoints: MixtapeBpmPoint[] = []
    for (const point of currentPoints) {
      if (point.sec < safeStartSec - BPM_POINT_SEC_EPSILON) {
        nextPoints.push(point)
      }
    }
    if (safeStartSec > BPM_POINT_SEC_EPSILON) {
      nextPoints.push({
        sec: Number(safeStartSec.toFixed(4)),
        bpm: beforeValue
      })
    }
    nextPoints.push(...replacementPoints)
    if (safeEndSec < durationSec - BPM_POINT_SEC_EPSILON) {
      nextPoints.push({
        sec: Number(safeEndSec.toFixed(4)),
        bpm: afterValue
      })
    }
    for (const point of currentPoints) {
      if (point.sec > safeEndSec + BPM_POINT_SEC_EPSILON) {
        nextPoints.push(point)
      }
    }
    return normalizeTrackBpmEnvelopePoints(nextPoints, durationSec, fallbackBpm)
  }

  const captureSnapshots = (trackIds: string[]) =>
    trackIds
      .map((trackId) => {
        const { track, points } = resolveTrackState(trackId)
        if (!track) return null
        return {
          trackId: track.id,
          points: cloneTrackBpmPoints(points)
        } satisfies TrackBpmEnvelopeSnapshot
      })
      .filter(Boolean) as TrackBpmEnvelopeSnapshot[]

  const rebuildTrackPointsBySourceAnchors = (paramsInput: {
    track: MixtapeTrack
    previousPoints: MixtapeBpmPoint[]
    previousDurationSec: number
    nextPoints: MixtapeBpmPoint[]
  }) => {
    const { track, previousPoints, previousDurationSec, nextPoints } = paramsInput
    const fallbackBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const normalizedNextPoints = normalizeTrackBpmEnvelopePoints(
      nextPoints,
      previousDurationSec,
      fallbackBpm
    )
    const sourceDurationSec = Math.max(
      0,
      Number(params.resolveTrackSourceDurationSeconds(track)) || 0
    )
    if (
      sourceDurationSec <= BPM_POINT_SEC_EPSILON ||
      previousPoints.length < 2 ||
      normalizedNextPoints.length < 2
    ) {
      return normalizedNextPoints
    }
    const originalBpm = Number(track.originalBpm) || Number(track.bpm) || 0
    const sourceAnchorsSec = normalizedNextPoints.map((point, index) => {
      if (Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0) {
        return Number(Number(point.sourceSec).toFixed(4))
      }
      if (index <= 0) return 0
      if (index >= normalizedNextPoints.length - 1) return Number(sourceDurationSec.toFixed(4))
      return Number(
        resolveTrackSourceTimeAtLocalSec({
          points: previousPoints,
          localSec: point.sec,
          durationSec: previousDurationSec,
          sourceDurationSec,
          originalBpm,
          fallbackBpm
        }).toFixed(4)
      )
    })
    const rebuiltPoints = rebuildTrackBpmEnvelopePointsFromSourceAnchors({
      sourceAnchorsSec,
      bpms: normalizedNextPoints.map((point) => point.bpm),
      sourceDurationSec,
      originalBpm,
      fallbackBpm
    })
    const rebuiltDurationSec =
      rebuiltPoints[rebuiltPoints.length - 1]?.sec ?? Number(previousDurationSec.toFixed(4))
    const refinedPoints = rebuiltPoints.map((point, index) => {
      if (index === 0) {
        return {
          sec: 0,
          bpm: point.bpm,
          sourceSec: 0
        }
      }
      if (index === rebuiltPoints.length - 1) {
        return {
          sec: Number(rebuiltDurationSec.toFixed(4)),
          bpm: point.bpm,
          sourceSec: Number(sourceDurationSec.toFixed(4))
        }
      }
      return {
        sec: resolveTrackLocalSecAtSourceTime({
          points: rebuiltPoints,
          sourceSec: sourceAnchorsSec[index] ?? 0,
          durationSec: rebuiltDurationSec,
          sourceDurationSec,
          originalBpm,
          fallbackBpm
        }),
        bpm: point.bpm,
        sourceSec: sourceAnchorsSec[index]
      }
    })
    return normalizeTrackBpmEnvelopePoints(refinedPoints, rebuiltDurationSec, fallbackBpm)
  }

  const applyTrackBpmEnvelopeChange = (
    trackId: string,
    nextPoints: MixtapeBpmPoint[],
    options?: {
      persist?: boolean
      syncOverlaps?: boolean
    }
  ) => {
    const sourceState = resolveTrackState(trackId)
    if (!sourceState.track || !sourceState.durationSec) return [] as string[]
    const normalizedSource = rebuildTrackPointsBySourceAnchors({
      track: sourceState.track,
      previousPoints: sourceState.points,
      previousDurationSec: sourceState.durationSec,
      nextPoints
    })
    const updates = new Map<string, MixtapeBpmPoint[]>()
    updates.set(sourceState.track.id, normalizedSource)
    if (options?.syncOverlaps !== false) {
      const sourceRangeStart = sourceState.startSec
      const sourceRangeEnd =
        sourceState.startSec +
        (normalizedSource[normalizedSource.length - 1]?.sec ?? sourceState.durationSec)
      for (const targetTrack of params.tracks.value) {
        if (targetTrack.id === sourceState.track.id) continue
        const targetState = resolveTrackState(targetTrack.id)
        if (!targetState.track || !targetState.durationSec) continue
        const overlapStartSec = Math.max(sourceRangeStart, targetState.startSec)
        const overlapEndSec = Math.min(
          sourceRangeEnd,
          targetState.startSec + targetState.durationSec
        )
        if (overlapEndSec - overlapStartSec <= BPM_POINT_SEC_EPSILON) continue
        const replacementPoints = buildMappedSourceSegment({
          sourcePoints: normalizedSource,
          sourceStartSec: sourceState.startSec,
          targetStartSec: targetState.startSec,
          overlapStartSec,
          overlapEndSec,
          sourceFallbackBpm: resolveTrackBpmEnvelopeBaseValue(sourceState.track)
        })
        const nextTargetPoints = replaceTrackSegment({
          track: targetState.track,
          currentPoints: targetState.points,
          replacementPoints,
          segmentStartSec: overlapStartSec - targetState.startSec,
          segmentEndSec: overlapEndSec - targetState.startSec,
          durationSec: targetState.durationSec
        })
        const rebuiltTargetPoints = rebuildTrackPointsBySourceAnchors({
          track: targetState.track,
          previousPoints: targetState.points,
          previousDurationSec: targetState.durationSec,
          nextPoints: nextTargetPoints
        })
        if (buildSignature(rebuiltTargetPoints) === buildSignature(targetState.points)) continue
        updates.set(targetState.track.id, rebuiltTargetPoints)
      }
    }
    const changedTrackIds: string[] = []
    if (!updates.size) return changedTrackIds
    params.tracks.value = params.tracks.value.map((track) => {
      const nextTrackPoints = updates.get(track.id)
      if (!nextTrackPoints) return track
      const currentState = resolveTrackState(track.id)
      if (buildSignature(currentState.points) === buildSignature(nextTrackPoints)) return track
      changedTrackIds.push(track.id)
      if (options?.persist !== false) {
        schedulePersist(track.id, nextTrackPoints)
      }
      return {
        ...track,
        bpmEnvelope: nextTrackPoints
      } satisfies MixtapeTrack
    })
    return changedTrackIds
  }

  const restoreSnapshots = (snapshots: TrackBpmEnvelopeSnapshot[]) => {
    if (!snapshots.length) return false
    const snapshotMap = new Map(
      snapshots.map((item) => [item.trackId, cloneTrackBpmPoints(item.points)] as const)
    )
    let changed = false
    params.tracks.value = params.tracks.value.map((track) => {
      const nextPoints = snapshotMap.get(track.id)
      if (!nextPoints) return track
      const currentState = resolveTrackState(track.id)
      if (buildSignature(currentState.points) === buildSignature(nextPoints)) return track
      changed = true
      schedulePersist(track.id, nextPoints)
      return {
        ...track,
        bpmEnvelope: nextPoints
      } satisfies MixtapeTrack
    })
    if (changed) {
      void flushPendingPersist()
    }
    return changed
  }

  const pushUndoSnapshots = (beforeSnapshots: TrackBpmEnvelopeSnapshot[]) => {
    if (!beforeSnapshots.length) return
    params.pushExternalUndoStep(() => restoreSnapshots(beforeSnapshots))
  }

  const syncDragDraftFromTrackState = (trackId: string) => {
    const currentDragState = dragState.value
    if (!currentDragState || currentDragState.trackId !== trackId) return
    const track = params.tracks.value.find((item) => item.id === trackId) || null
    if (!track) return
    const durationSec = Math.max(0, Number(params.resolveTrackDurationSeconds(track)) || 0)
    const baseBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const points = normalizeTrackBpmEnvelopePoints(track.bpmEnvelope, durationSec, baseBpm)
    dragState.value = {
      ...currentDragState,
      draftPoints: cloneTrackBpmPoints(points),
      draftDurationSec: durationSec
    }
  }

  const applyPreviewTrackBpmEnvelopeChange = (trackId: string, nextPoints: MixtapeBpmPoint[]) => {
    const changedTrackIds = applyTrackBpmEnvelopeChange(trackId, nextPoints, {
      persist: false,
      syncOverlaps: false
    })
    syncDragDraftFromTrackState(trackId)
    if (changedTrackIds.length) {
      params.onEnvelopePreviewChanged?.()
    }
  }

  const resolveActiveBpmEnvelopePolyline = (item: TimelineTrackLayout) => {
    const { track, durationSec, points } = resolveTrackState(item.track.id, {
      includeDraft: false
    })
    if (!track || !durationSec || points.length < 2) return ''
    const renderPoints = resolveTrackBpmEnvelopeRenderablePoints({
      track,
      points,
      durationSec,
      sourceDurationSec: params.resolveTrackSourceDurationSeconds(track)
    })
    const baseBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const bpmRange = resolveTrackBpmEnvelopeVisualRange({
      track,
      tracks: params.tracks.value,
      resolveDurationSec: params.resolveTrackDurationSeconds
    })
    return buildTrackBpmEnvelopePolylineByControlPoints({
      points: renderPoints,
      durationSec,
      baseBpm,
      minBpm: bpmRange.minBpm,
      maxBpm: bpmRange.maxBpm
    })
  }

  const resolveActiveBpmEnvelopePointDots = (item: TimelineTrackLayout): BpmEnvelopePointDot[] => {
    const { track, durationSec, points } = resolveTrackState(item.track.id, {
      includeDraft: false
    })
    if (!track || !durationSec || points.length < 2) return []
    const renderPoints = resolveTrackBpmEnvelopeRenderablePoints({
      track,
      points,
      durationSec,
      sourceDurationSec: params.resolveTrackSourceDurationSeconds(track)
    })
    const baseBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const bpmRange = resolveTrackBpmEnvelopeVisualRange({
      track,
      tracks: params.tracks.value,
      resolveDurationSec: params.resolveTrackDurationSeconds
    })
    return renderPoints.map((point, index) => ({
      index,
      x: Number((clampNumber(point.sec / durationSec, 0, 1) * 100).toFixed(6)),
      y: Number(
        mapTrackBpmToYPercent(point.bpm, baseBpm, bpmRange.minBpm, bpmRange.maxBpm).toFixed(3)
      ),
      bpm: point.bpm,
      label: String(Math.round(point.bpm)),
      labelPlacement:
        mapTrackBpmToYPercent(point.bpm, baseBpm, bpmRange.minBpm, bpmRange.maxBpm) <= 14
          ? 'below'
          : 'above',
      labelAlign:
        point.sec / durationSec <= 0.08
          ? 'left'
          : point.sec / durationSec >= 0.92
            ? 'right'
            : 'center',
      isBoundary: index === 0 || index === points.length - 1
    }))
  }

  const resolvePointer = (
    track: MixtapeTrack,
    points: MixtapeBpmPoint[],
    stageEl: HTMLElement,
    event: MouseEvent,
    durationSec: number
  ) => {
    const rect = stageEl.getBoundingClientRect()
    if (!rect.width || !rect.height || !durationSec) return null
    const xRatio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1)
    const yRatio = clampNumber((event.clientY - rect.top) / rect.height, 0, 1)
    const rawSec = xRatio * durationSec
    const baseBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const sourceDurationSec = Math.max(
      0,
      Number(params.resolveTrackSourceDurationSeconds(track)) || 0
    )
    const nearestGridLine = resolveNearestTrackVisibleGridLine({
      points,
      localSec: rawSec,
      durationSec,
      sourceDurationSec,
      firstBeatSourceSec: Math.max(0, Number(track.firstBeatMs) || 0) / 1000,
      beatSourceSec: 60 / Math.max(1, resolveTrackGridSourceBpm(track)),
      barBeatOffset: Number(track.barBeatOffset) || 0,
      zoom: Number(params.renderZoomLevel.value) || 0,
      originalBpm: Number(track.originalBpm) || Number(track.bpm) || 0,
      fallbackBpm: baseBpm
    })
    const snappedSec = snapTrackLocalSecToBeatGrid({
      points,
      localSec: rawSec,
      durationSec,
      sourceDurationSec,
      firstBeatSourceSec: Math.max(0, Number(track.firstBeatMs) || 0) / 1000,
      beatSourceSec: 60 / Math.max(1, resolveTrackGridSourceBpm(track)),
      barBeatOffset: Number(track.barBeatOffset) || 0,
      zoom: Number(params.renderZoomLevel.value) || 0,
      originalBpm: Number(track.originalBpm) || Number(track.bpm) || 0,
      fallbackBpm: baseBpm
    })
    const bpmRange = resolveTrackBpmEnvelopeVisualRange({
      track,
      tracks: params.tracks.value,
      resolveDurationSec: params.resolveTrackDurationSeconds
    })
    const bpmClampRange = resolveTrackBpmEnvelopeClampRange(baseBpm)
    return {
      sec: Number((typeof snappedSec === 'number' ? snappedSec : rawSec).toFixed(4)),
      sourceSec:
        nearestGridLine && Number.isFinite(Number(nearestGridLine.sourceSec))
          ? Number(nearestGridLine.sourceSec.toFixed(4))
          : undefined,
      bpm: clampNumber(
        mapTrackBpmYPercentToValue(yRatio * 100, baseBpm, bpmRange.minBpm, bpmRange.maxBpm),
        bpmClampRange.minBpm,
        bpmClampRange.maxBpm
      )
    }
  }

  const stopDrag = () => {
    dragState.value = null
    window.removeEventListener('mousemove', handleDragMove)
    window.removeEventListener('mouseup', handleDragEnd)
  }

  const handleDragMove = (event: MouseEvent) => {
    const currentState = dragState.value
    if (!currentState) return
    event.preventDefault()
    const trackState = resolveTrackState(currentState.trackId)
    if (!trackState.track || !trackState.durationSec) return
    const pointer = resolvePointer(
      trackState.track,
      trackState.points,
      currentState.stageEl,
      event,
      trackState.durationSec
    )
    if (!pointer) return
    const nextPoints = cloneTrackBpmPoints(trackState.points)
    const targetPoint = nextPoints[currentState.pointIndex]
    if (!targetPoint) return
    targetPoint.bpm = pointer.bpm
    dragState.value = {
      ...currentState,
      draftPoints: nextPoints
    }
    applyPreviewTrackBpmEnvelopeChange(currentState.trackId, nextPoints)
  }

  const handleDragEnd = () => {
    const currentState = dragState.value
    stopDrag()
    if (!currentState) return
    if (currentState.draftPoints.length > 0) {
      void applyTrackBpmEnvelopeChange(currentState.trackId, currentState.draftPoints, {
        persist: true,
        syncOverlaps: true
      })
    }
    pushUndoSnapshots(currentState.beforeSnapshots)
    void flushPendingPersist()
    params.onEnvelopeCommitted?.()
  }

  const startDrag = (trackId: string, pointIndex: number, stageEl: HTMLElement) => {
    const trackState = resolveTrackState(trackId)
    dragState.value = {
      trackId,
      pointIndex,
      stageEl,
      draftPoints: cloneTrackBpmPoints(trackState.points),
      draftDurationSec: trackState.durationSec,
      startSec: trackState.startSec,
      beforeSnapshots: captureSnapshots(params.tracks.value.map((track) => track.id))
    }
    window.addEventListener('mousemove', handleDragMove)
    window.addEventListener('mouseup', handleDragEnd)
  }

  const handleBpmEnvelopePointMouseDown = (
    item: TimelineTrackLayout,
    pointIndex: number,
    event: MouseEvent
  ) => {
    if (!params.isEditable() || event.button !== 0) return
    const stageEl = (event.currentTarget as HTMLElement | null)?.closest(
      '.lane-track__envelope-points'
    ) as HTMLElement | null
    if (!stageEl) return
    startDrag(item.track.id, pointIndex, stageEl)
  }

  const handleBpmEnvelopeStageMouseDown = (item: TimelineTrackLayout, event: MouseEvent) => {
    if (!params.isEditable() || event.button !== 0) return
    const trackState = resolveTrackState(item.track.id)
    if (!trackState.track || !trackState.durationSec) return
    const stageEl = event.currentTarget as HTMLElement | null
    if (!stageEl) return
    const pointer = resolvePointer(
      trackState.track,
      trackState.points,
      stageEl,
      event,
      trackState.durationSec
    )
    if (!pointer) return
    const beforeSnapshots = captureSnapshots(params.tracks.value.map((track) => track.id))
    const nextPoints = cloneTrackBpmPoints(trackState.points)
    nextPoints.push({
      sec: pointer.sec,
      bpm: pointer.bpm,
      sourceSec: pointer.sourceSec
    })
    const normalizedDraftPoints = normalizeTrackBpmEnvelopePoints(
      nextPoints,
      trackState.durationSec,
      resolveTrackBpmEnvelopeBaseValue(trackState.track)
    )
    if (!normalizedDraftPoints.length) return
    const pointIndex = normalizedDraftPoints.findIndex(
      (point) =>
        Math.abs(point.sec - pointer.sec) <= BPM_POINT_SEC_EPSILON &&
        Math.abs(point.bpm - pointer.bpm) <= BPM_POINT_SEC_EPSILON
    )
    dragState.value = {
      trackId: trackState.track.id,
      pointIndex: pointIndex >= 0 ? pointIndex : Math.max(0, normalizedDraftPoints.length - 2),
      stageEl,
      draftPoints: normalizedDraftPoints,
      draftDurationSec: trackState.durationSec,
      startSec: trackState.startSec,
      beforeSnapshots
    }
    applyPreviewTrackBpmEnvelopeChange(trackState.track.id, normalizedDraftPoints)
    window.addEventListener('mousemove', handleDragMove)
    window.addEventListener('mouseup', handleDragEnd)
  }

  const handleBpmEnvelopePointDoubleClick = (item: TimelineTrackLayout, pointIndex: number) => {
    const trackState = resolveTrackState(item.track.id)
    if (!trackState.track || pointIndex <= 0 || pointIndex >= trackState.points.length - 1) return
    const beforeSnapshots = captureSnapshots(params.tracks.value.map((track) => track.id))
    const nextPoints = trackState.points.filter((_, index) => index !== pointIndex)
    const changedTrackIds = applyTrackBpmEnvelopeChange(trackState.track.id, nextPoints, {
      persist: true
    })
    if (!changedTrackIds.length) return
    pushUndoSnapshots(beforeSnapshots)
    void flushPendingPersist()
    params.onEnvelopeCommitted?.()
  }

  const handleBpmEnvelopePointContextMenu = (_item: TimelineTrackLayout, _pointIndex: number) => {}

  const cleanupTrackBpmEnvelopeEditor = () => {
    stopDrag()
    void flushPendingPersist()
  }

  return {
    resolveActiveBpmEnvelopePolyline,
    resolveActiveBpmEnvelopePointDots,
    handleBpmEnvelopePointMouseDown,
    handleBpmEnvelopeStageMouseDown,
    handleBpmEnvelopePointDoubleClick,
    handleBpmEnvelopePointContextMenu,
    cleanupTrackBpmEnvelopeEditor
  }
}
