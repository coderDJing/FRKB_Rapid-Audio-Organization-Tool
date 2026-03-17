import { computed, ref, type Ref } from 'vue'
import type {
  MixtapeBpmPoint,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'
import {
  cloneTrackBpmPoints,
  hasMeaningfulBpmEnvelopeTrack,
  isRedundantFlatEnvelopeTrack,
  normalizeTrackBpmEnvelopePoints,
  resolveTrackBpmEnvelopeBaseValue,
  resolveTrackBpmEnvelopeClampRange
} from '@renderer/composables/mixtape/trackTempoModel'
import {
  buildTrackBpmEnvelopePolylineByControlPoints,
  mapTrackBpmToYPercent,
  mapTrackBpmYPercentToValue,
  resolveTrackBpmEnvelopeVisualRange
} from '@renderer/composables/mixtape/trackTempoVisual'
import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import {
  createMixtapePhaseSyncTrackState,
  rebuildTrackPointsBySourceAnchors,
  syncTargetTrackBpmSegmentToSourcePhase,
  type MixtapePhaseSyncTrackState
} from '@renderer/composables/mixtape/mixtapePhaseSync'

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

type MixtapeBpmResyncTrigger = 'track-position' | 'bpm-edit'

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
const buildGridLineSignature = (lines: MixtapeTrack['phaseSyncGridLines']) =>
  JSON.stringify(lines ?? [])
const buildGridRangeSignature = (track: {
  phaseSyncGridRangeStartSec?: number
  phaseSyncGridRangeEndSec?: number
}) =>
  JSON.stringify([
    Number.isFinite(Number(track.phaseSyncGridRangeStartSec))
      ? Number(track.phaseSyncGridRangeStartSec)
      : null,
    Number.isFinite(Number(track.phaseSyncGridRangeEndSec))
      ? Number(track.phaseSyncGridRangeEndSec)
      : null
  ])

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

  const buildWorkingTrackTimelineStates = (inputTracks: MixtapeTrack[]) => {
    let cursorSec = 0
    return inputTracks.map((track) => {
      const durationSec = Math.max(0, Number(params.resolveTrackDurationSeconds(track)) || 0)
      const rawStartSec = Number(track.startSec)
      const startSec =
        Number.isFinite(rawStartSec) && rawStartSec >= 0 ? Math.max(0, rawStartSec) : cursorSec
      cursorSec = Math.max(cursorSec, startSec + durationSec)
      return {
        track,
        startSec,
        durationSec
      }
    })
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
            : undefined,
        allowOffGrid: point.allowOffGrid === true ? true : undefined
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

  const buildPhaseSyncState = (paramsInput: {
    track: MixtapeTrack
    points: MixtapeBpmPoint[]
    durationSec: number
    startSec: number
  }) => {
    const { track, points, durationSec, startSec } = paramsInput
    const sourceDurationSec = Math.max(
      0,
      Number(params.resolveTrackSourceDurationSeconds(track)) || 0
    )
    return createMixtapePhaseSyncTrackState({
      track,
      startSec,
      snapshot: buildTrackRuntimeTempoSnapshot({
        track,
        sourceDurationSec,
        durationSec,
        rawPoints: points
      })
    }) satisfies MixtapePhaseSyncTrackState
  }

  const buildTempoSnapshotForState = (paramsInput: {
    track: MixtapeTrack
    points: MixtapeBpmPoint[]
    durationSec: number
  }) =>
    buildTrackRuntimeTempoSnapshot({
      track: paramsInput.track,
      sourceDurationSec: Math.max(
        0,
        Number(params.resolveTrackSourceDurationSeconds(paramsInput.track)) || 0
      ),
      durationSec: paramsInput.durationSec,
      rawPoints: paramsInput.points,
      zoom: Number(params.renderZoomLevel.value) || 0
    })

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
    const sourceDurationSec = Math.max(
      0,
      Number(params.resolveTrackSourceDurationSeconds(sourceState.track)) || 0
    )
    const normalizedSource = rebuildTrackPointsBySourceAnchors({
      track: sourceState.track,
      previousPoints: sourceState.points,
      previousDurationSec: sourceState.durationSec,
      nextPoints,
      sourceDurationSec
    })
    const sourcePointsChanged =
      buildSignature(sourceState.points) !== buildSignature(normalizedSource)
    if (sourcePointsChanged) {
      params.tracks.value = params.tracks.value.map((track) => {
        if (track.id !== sourceState.track!.id) return track
        if (options?.persist !== false) {
          schedulePersist(track.id, normalizedSource)
        }
        return {
          ...track,
          bpmEnvelope: normalizedSource,
          phaseSyncGridLines: undefined,
          phaseSyncGridRangeStartSec: undefined,
          phaseSyncGridRangeEndSec: undefined
        } satisfies MixtapeTrack
      })
    }
    const changedTrackIds = sourcePointsChanged ? [sourceState.track.id] : []
    if (options?.syncOverlaps !== false) {
      const resyncedTrackIds = resyncTrackBpmOverlaps('bpm-edit')
      for (const changedTrackId of resyncedTrackIds) {
        if (!changedTrackIds.includes(changedTrackId)) {
          changedTrackIds.push(changedTrackId)
        }
      }
    }
    return changedTrackIds
  }

  const resyncTrackBpmOverlaps = (trigger: MixtapeBpmResyncTrigger = 'bpm-edit') => {
    if (dragState.value) return [] as string[]
    const workingTracks: MixtapeTrack[] = params.tracks.value.map((track) => ({
      ...track,
      phaseSyncGridLines: undefined,
      phaseSyncGridRangeStartSec: undefined,
      phaseSyncGridRangeEndSec: undefined
    }))
    const changedTrackIds = new Set<string>()
    const persistEnvelopePoints = new Map<string, MixtapeBpmPoint[]>()
    const sortByTimeline = (input: ReturnType<typeof buildWorkingTrackTimelineStates>) =>
      [...input].sort((left, right) => {
        if (Math.abs(left.startSec - right.startSec) > BPM_POINT_SEC_EPSILON) {
          return left.startSec - right.startSec
        }
        if (left.track.mixOrder !== right.track.mixOrder) {
          return left.track.mixOrder - right.track.mixOrder
        }
        return String(left.track.id).localeCompare(String(right.track.id))
      })

    const orderedStates = sortByTimeline(buildWorkingTrackTimelineStates(workingTracks))
    for (let sourceIndex = 0; sourceIndex < orderedStates.length; sourceIndex += 1) {
      const sourceState = orderedStates[sourceIndex]
      if (!sourceState?.track || sourceState.durationSec <= BPM_POINT_SEC_EPSILON) continue
      const sourceTrack = workingTracks.find((track) => track.id === sourceState.track.id)
      if (!sourceTrack) continue
      const sourceDurationSec = Math.max(
        0,
        Number(params.resolveTrackDurationSeconds(sourceTrack)) || 0
      )
      if (sourceDurationSec <= BPM_POINT_SEC_EPSILON) continue
      const sourceFallbackBpm = resolveTrackBpmEnvelopeBaseValue(sourceTrack)
      const sourcePoints = normalizeTrackBpmEnvelopePoints(
        sourceTrack.bpmEnvelope,
        sourceDurationSec,
        sourceFallbackBpm
      )
      const sourceRangeStart = sourceState.startSec
      const sourceRangeEnd = sourceRangeStart + sourceDurationSec

      for (
        let targetIndex = sourceIndex + 1;
        targetIndex < orderedStates.length;
        targetIndex += 1
      ) {
        const targetState = orderedStates[targetIndex]
        if (!targetState?.track || targetState.track.id === sourceTrack.id) continue
        const targetTrack = workingTracks.find((track) => track.id === targetState.track.id)
        if (!targetTrack) continue
        const sourceHasExplicitEnvelope = hasMeaningfulBpmEnvelopeTrack(sourceTrack)
        const clearedRedundantFlatEnvelope =
          !sourceHasExplicitEnvelope && isRedundantFlatEnvelopeTrack(targetTrack)
        if (clearedRedundantFlatEnvelope) {
          targetTrack.bpmEnvelope = undefined
        }
        const targetDurationSec = Math.max(
          0,
          Number(params.resolveTrackDurationSeconds(targetTrack)) || 0
        )
        if (targetDurationSec <= BPM_POINT_SEC_EPSILON) continue
        const overlapStartSec = Math.max(sourceRangeStart, targetState.startSec)
        const overlapEndSec = Math.min(sourceRangeEnd, targetState.startSec + targetDurationSec)
        if (overlapEndSec - overlapStartSec <= BPM_POINT_SEC_EPSILON) continue
        const targetFallbackBpm = resolveTrackBpmEnvelopeBaseValue(targetTrack)
        const targetPoints = normalizeTrackBpmEnvelopePoints(
          targetTrack.bpmEnvelope,
          targetDurationSec,
          targetFallbackBpm
        )
        const triggerAllowsEnvelopeMutation = trigger === 'bpm-edit'
        const mutateEnvelope = triggerAllowsEnvelopeMutation && sourceHasExplicitEnvelope
        const sourcePhaseState = buildPhaseSyncState({
          track: sourceTrack,
          points: sourcePoints,
          durationSec: sourceDurationSec,
          startSec: sourceRangeStart
        })
        const targetPhaseState = buildPhaseSyncState({
          track: targetTrack,
          points: targetPoints,
          durationSec: targetDurationSec,
          startSec: targetState.startSec
        })
        const syncResult = syncTargetTrackBpmSegmentToSourcePhase({
          sourceState: sourcePhaseState,
          targetState: targetPhaseState,
          overlapStartSec,
          overlapEndSec,
          mutateEnvelope
        })
        if (!syncResult) continue
        const {
          nextPoints: rebuiltTargetPoints,
          phaseSyncGridLines,
          phaseSyncGridRangeStartSec,
          phaseSyncGridRangeEndSec
        } = syncResult
        if (
          buildSignature(rebuiltTargetPoints) === buildSignature(targetPoints) &&
          buildGridLineSignature(phaseSyncGridLines) ===
            buildGridLineSignature(targetTrack.phaseSyncGridLines) &&
          buildGridRangeSignature({
            phaseSyncGridRangeStartSec,
            phaseSyncGridRangeEndSec
          }) === buildGridRangeSignature(targetTrack)
        ) {
          continue
        }
        if (mutateEnvelope) {
          targetTrack.bpmEnvelope = rebuiltTargetPoints
          persistEnvelopePoints.set(targetTrack.id, rebuiltTargetPoints)
        } else if (isRedundantFlatEnvelopeTrack(targetTrack)) {
          targetTrack.bpmEnvelope = undefined
        }
        if (clearedRedundantFlatEnvelope) {
          persistEnvelopePoints.set(targetTrack.id, [])
        }
        targetTrack.phaseSyncGridLines = phaseSyncGridLines
        targetTrack.phaseSyncGridRangeStartSec = phaseSyncGridRangeStartSec
        targetTrack.phaseSyncGridRangeEndSec = phaseSyncGridRangeEndSec
        changedTrackIds.add(targetTrack.id)
      }
    }

    if (!changedTrackIds.size) return [] as string[]
    params.tracks.value = params.tracks.value.map((track) => {
      const nextTrack = workingTracks.find((item) => item.id === track.id)
      return nextTrack ? nextTrack : track
    })
    for (const trackId of changedTrackIds) {
      if (!persistEnvelopePoints.has(trackId)) continue
      schedulePersist(trackId, persistEnvelopePoints.get(trackId) || [])
    }
    params.onEnvelopeCommitted?.()
    return Array.from(changedTrackIds)
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
    const tempoSnapshot = buildTempoSnapshotForState({
      track,
      points,
      durationSec
    })
    const baseBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const bpmRange = resolveTrackBpmEnvelopeVisualRange({
      track,
      tracks: params.tracks.value,
      resolveDurationSec: params.resolveTrackDurationSeconds
    })
    return buildTrackBpmEnvelopePolylineByControlPoints({
      points: tempoSnapshot.timeMap.renderPoints,
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
    const tempoSnapshot = buildTempoSnapshotForState({
      track,
      points,
      durationSec
    })
    const renderPoints = tempoSnapshot.timeMap.renderPoints
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
    const tempoSnapshot = buildTempoSnapshotForState({
      track,
      points,
      durationSec
    })
    const baseBpm = resolveTrackBpmEnvelopeBaseValue(track)
    const nearestGridLine = tempoSnapshot.timeMap.resolveNearestGridLine(
      rawSec,
      Number(params.renderZoomLevel.value) || 0
    )
    const snappedSec = tempoSnapshot.timeMap.snapLocalSec(
      rawSec,
      Number(params.renderZoomLevel.value) || 0
    )
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
      sourceSec: pointer.sourceSec,
      allowOffGrid: undefined
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
    resyncTrackBpmOverlaps,
    cleanupTrackBpmEnvelopeEditor
  }
}
