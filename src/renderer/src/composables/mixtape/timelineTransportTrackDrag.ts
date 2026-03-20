import { ref } from 'vue'
import {
  GRID_BEAT4_LINE_ZOOM,
  GRID_BEAT_LINE_ZOOM,
  LANE_COUNT
} from '@renderer/composables/mixtape/constants'
import {
  resolveBeatSecByBpm,
  resolveGridAnchorSec
} from '@renderer/composables/mixtape/mixxxSyncModel'
import { createMixtapeMasterGrid } from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  isMixtapeGlobalTempoReady,
  mixtapeGlobalTempoEnvelope
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import { resolveSnappedStartSecByVisibleGrid } from '@renderer/composables/mixtape/trackGridSnap'
import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import type { MixtapeTrack, TimelineTrackLayout } from '@renderer/composables/mixtape/types'

export const createTimelineTransportTrackDragModule = (ctx: any) => {
  const {
    tracks,
    normalizedRenderZoom,
    resolveRenderPxPerSec,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackStartSecById,
    resolveTimelineSecByX,
    stopTransportForTrackChange,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    persistTrackStartSec,
    normalizeStartSec,
    clampNumber,
    normalizeBeatOffset
  } = ctx

  const isTrackDragging = ref(false)

  let trackDragState: {
    trackId: string
    startClientX: number
    initialStartSec: number
    previousTrackId: string
    snapshotTracks: MixtapeTrack[]
    lastDebug: Record<string, unknown> | null
  } | null = null

  const resolvePreviousTrackId = (trackId: string) => {
    const ordered = [...tracks.value].sort(
      (a: MixtapeTrack, b: MixtapeTrack) => a.mixOrder - b.mixOrder
    )
    const index = ordered.findIndex((item: MixtapeTrack) => item.id === trackId)
    if (index <= 0) return ''
    return ordered[index - 1]?.id || ''
  }

  const findTrack = (trackId: string) =>
    tracks.value.find((item: MixtapeTrack) => item.id === trackId) || null

  const buildTrackTimingSnapshot = (inputTracks: MixtapeTrack[]) => {
    let cursorSec = 0
    return inputTracks.map((track, index) => {
      const laneIndex = index % LANE_COUNT
      const duration = resolveTrackDurationSeconds(track)
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
      const rawStartSec = Number(track.startSec)
      const startSec =
        Number.isFinite(rawStartSec) && rawStartSec >= 0 ? Math.max(0, rawStartSec) : cursorSec
      const endSec = startSec + safeDuration
      cursorSec = Math.max(cursorSec, endSec)
      return {
        id: track.id,
        laneIndex,
        startSec,
        endSec,
        durationSec: safeDuration
      }
    })
  }

  const resolveTrackDragBounds = (snapshotTracks: MixtapeTrack[], trackId: string) => {
    const timings = buildTrackTimingSnapshot(snapshotTracks)
    const target = timings.find((item) => item.id === trackId)
    if (!target) {
      return {
        minStart: 0,
        maxStart: Number.POSITIVE_INFINITY
      }
    }
    const sameLane = timings.filter((item) => item.laneIndex === target.laneIndex)
    const lanePos = sameLane.findIndex((item) => item.id === trackId)
    if (lanePos < 0) {
      return {
        minStart: 0,
        maxStart: Number.POSITIVE_INFINITY
      }
    }
    const prev = lanePos > 0 ? sameLane[lanePos - 1] : null
    const next = lanePos < sameLane.length - 1 ? sameLane[lanePos + 1] : null

    const minStart = prev ? prev.endSec : 0
    let maxStart = Number.POSITIVE_INFINITY
    if (next) {
      maxStart = Math.max(minStart, next.startSec - target.durationSec)
    }
    return {
      minStart,
      maxStart
    }
  }

  const resolveVisibleGridSnapStepBeats = () => {
    const zoomValue = Number(normalizedRenderZoom.value) || 0
    if (zoomValue >= GRID_BEAT_LINE_ZOOM) return 1
    if (zoomValue >= GRID_BEAT4_LINE_ZOOM) return 4
    return 32
  }

  const buildGlobalTimelineGridSecs = (
    snapshotTracks: MixtapeTrack[],
    options?: { minSec?: number; maxSec?: number }
  ) => {
    if (!isMixtapeGlobalTempoReady()) return [] as number[]
    const fallbackBpm =
      Number(mixtapeGlobalTempoEnvelope.value[0]?.bpm) ||
      snapshotTracks.find((track) => Number(track.bpm) > 0)?.bpm ||
      128
    const grid = createMixtapeMasterGrid({
      points: mixtapeGlobalTempoEnvelope.value,
      fallbackBpm
    })
    const timelineEndSec = buildTrackTimingSnapshot(snapshotTracks).reduce(
      (maxSec, item) => Math.max(maxSec, Number(item.endSec) || 0),
      0
    )
    const maxSec =
      Number.isFinite(Number(options?.maxSec)) && Number(options?.maxSec) > 0
        ? Number(options?.maxSec)
        : timelineEndSec
    const beatBufferSec = (32 * 60) / Math.max(1, fallbackBpm)
    return grid
      .buildVisibleGridLines(Number(normalizedRenderZoom.value) || 0, {
        minSec: Math.max(0, (Number(options?.minSec) || 0) - beatBufferSec),
        maxSec: Math.max(0, maxSec + beatBufferSec)
      })
      .map((line) => Number(line.sec.toFixed(4)))
  }

  const buildTrackVisibleLocalGridSecs = (track: MixtapeTrack, options?: { startSec?: number }) => {
    const projectedTrack =
      typeof options?.startSec === 'number' && Number.isFinite(options.startSec)
        ? ({ ...track, startSec: options.startSec } satisfies MixtapeTrack)
        : track
    const durationSec = resolveTrackDurationSeconds(projectedTrack)
    const sourceDurationSec = resolveTrackSourceDurationSeconds(projectedTrack)
    if (!Number.isFinite(durationSec) || durationSec <= 0) return [] as number[]
    if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) return [] as number[]
    const lines = buildTrackRuntimeTempoSnapshot({
      track: projectedTrack,
      sourceDurationSec,
      durationSec,
      zoom: Number(normalizedRenderZoom.value) || 0
    }).visibleGridLines
    return lines.map((line) => Number(line.sec.toFixed(4)))
  }

  const summarizeGridSecs = (gridSecs: number[]) =>
    gridSecs.slice(0, 8).map((sec) => Number(sec.toFixed(4)))

  const resolveGridNeighborhood = (values: number[], target: number, radius: number = 2) => {
    if (!values.length) return [] as number[]
    let nearestIndex = 0
    let nearestDiff = Math.abs((values[0] || 0) - target)
    for (let index = 1; index < values.length; index += 1) {
      const diff = Math.abs((values[index] || 0) - target)
      if (diff < nearestDiff) {
        nearestIndex = index
        nearestDiff = diff
      }
    }
    const start = Math.max(0, nearestIndex - radius)
    const end = Math.min(values.length, nearestIndex + radius + 1)
    return values.slice(start, end).map((value) => Number(value.toFixed(4)))
  }

  const resolveNearestVisibleGridPair = (payload: {
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    currentLocalGridSecs: number[]
    targetTimelineGridSecs: number[]
  }) => {
    const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
    const minStartSec = Math.max(0, Number(payload.minStartSec) || 0)
    const maxStartSec = Number.isFinite(Number(payload.maxStartSec))
      ? Math.max(minStartSec, Number(payload.maxStartSec))
      : Number.POSITIVE_INFINITY
    if (!payload.currentLocalGridSecs.length || !payload.targetTimelineGridSecs.length) return null
    let best: {
      localSec: number
      targetTimelineSec: number
      snappedStartSec: number
      startDeltaSec: number
      alignErrorSec: number
    } | null = null
    for (const localSec of payload.currentLocalGridSecs) {
      const safeLocalSec = Number(localSec)
      if (!Number.isFinite(safeLocalSec) || safeLocalSec < 0) continue
      const nearestTargets = resolveSnappedStartSecByVisibleGrid({
        rawStartSec,
        minStartSec,
        maxStartSec,
        currentLocalGridSecs: [safeLocalSec],
        targetTimelineGridSecs: payload.targetTimelineGridSecs
      })
      if (typeof nearestTargets !== 'number') continue
      const snappedStartSec = clampNumber(nearestTargets, minStartSec, maxStartSec)
      const snappedTimelineSec = snappedStartSec + safeLocalSec
      let matchedTargetTimelineSec = payload.targetTimelineGridSecs[0] || 0
      let matchedDiffSec = Math.abs(snappedTimelineSec - matchedTargetTimelineSec)
      for (const targetTimelineSec of payload.targetTimelineGridSecs) {
        const diffSec = Math.abs(snappedTimelineSec - targetTimelineSec)
        if (diffSec < matchedDiffSec) {
          matchedTargetTimelineSec = targetTimelineSec
          matchedDiffSec = diffSec
        }
      }
      const startDeltaSec = Math.abs(snappedStartSec - rawStartSec)
      if (
        !best ||
        startDeltaSec < best.startDeltaSec - 0.0001 ||
        (Math.abs(startDeltaSec - best.startDeltaSec) <= 0.0001 &&
          matchedDiffSec < best.alignErrorSec - 0.0001)
      ) {
        best = {
          localSec: safeLocalSec,
          targetTimelineSec: matchedTargetTimelineSec,
          snappedStartSec,
          startDeltaSec: Number(startDeltaSec.toFixed(4)),
          alignErrorSec: Number(matchedDiffSec.toFixed(4))
        }
      }
    }
    return best
  }

  const resolveSnappedStartSecByProjectedGrid = (payload: {
    track: MixtapeTrack
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    targetTimelineGridSecs: number[]
    boundaryCandidates?: number[]
  }) => {
    let candidateStartSec = clampNumber(
      Number(payload.rawStartSec) || 0,
      payload.minStartSec,
      payload.maxStartSec
    )
    let currentLocalGridSecs = buildTrackVisibleLocalGridSecs(payload.track, {
      startSec: candidateStartSec
    })
    let snappedStartSec = resolveSnappedStartSecByVisibleGrid({
      rawStartSec: candidateStartSec,
      minStartSec: payload.minStartSec,
      maxStartSec: payload.maxStartSec,
      currentLocalGridSecs,
      targetTimelineGridSecs: payload.targetTimelineGridSecs,
      boundaryCandidates: payload.boundaryCandidates
    })
    for (let iteration = 0; iteration < 3; iteration += 1) {
      if (typeof snappedStartSec !== 'number') break
      const stabilizedStartSec = clampNumber(
        snappedStartSec,
        payload.minStartSec,
        payload.maxStartSec
      )
      if (Math.abs(stabilizedStartSec - candidateStartSec) <= 0.0001) {
        candidateStartSec = stabilizedStartSec
        currentLocalGridSecs = buildTrackVisibleLocalGridSecs(payload.track, {
          startSec: candidateStartSec
        })
        snappedStartSec = stabilizedStartSec
        break
      }
      candidateStartSec = stabilizedStartSec
      currentLocalGridSecs = buildTrackVisibleLocalGridSecs(payload.track, {
        startSec: candidateStartSec
      })
      snappedStartSec = resolveSnappedStartSecByVisibleGrid({
        rawStartSec: candidateStartSec,
        minStartSec: payload.minStartSec,
        maxStartSec: payload.maxStartSec,
        currentLocalGridSecs,
        targetTimelineGridSecs: payload.targetTimelineGridSecs,
        boundaryCandidates: payload.boundaryCandidates
      })
    }
    return {
      snappedStartSec: typeof snappedStartSec === 'number' ? snappedStartSec : null,
      currentLocalGridSecs,
      candidateStartSec
    }
  }

  const resolveSnappedStartSec = (payload: {
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    snapAnchorSec: number
    currentAnchorRawSec: number
    stepSec: number
    boundaryCandidates?: number[]
  }) => {
    const stepSec = Number(payload.stepSec)
    if (!Number.isFinite(stepSec) || stepSec <= 0) return null
    const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
    const minStartSec = Math.max(0, Number(payload.minStartSec) || 0)
    const maxStartSec = Number.isFinite(Number(payload.maxStartSec))
      ? Math.max(minStartSec, Number(payload.maxStartSec))
      : Number.POSITIVE_INFINITY
    const snapAnchorSec = Number(payload.snapAnchorSec)
    const currentAnchorRawSec = Number(payload.currentAnchorRawSec)
    if (!Number.isFinite(snapAnchorSec) || !Number.isFinite(currentAnchorRawSec)) return null

    const startOffsetSec = rawStartSec - currentAnchorRawSec
    const rawIndex = (currentAnchorRawSec - snapAnchorSec) / stepSec
    if (!Number.isFinite(rawIndex)) return null

    let nearestIndex = Math.round(rawIndex)
    const minIndex = Math.ceil((minStartSec - startOffsetSec - snapAnchorSec) / stepSec)
    const maxIndex = Number.isFinite(maxStartSec)
      ? Math.floor((maxStartSec - startOffsetSec - snapAnchorSec) / stepSec)
      : Number.POSITIVE_INFINITY
    if (minIndex > maxIndex) return null
    nearestIndex = Math.max(minIndex, Math.min(maxIndex, nearestIndex))

    const snappedStartSec = startOffsetSec + snapAnchorSec + nearestIndex * stepSec
    if (!Number.isFinite(snappedStartSec)) return null
    const candidates = [
      clampNumber(snappedStartSec, minStartSec, maxStartSec),
      ...(Array.isArray(payload.boundaryCandidates)
        ? payload.boundaryCandidates
            .map((candidate) => Number(candidate))
            .filter((candidate) => Number.isFinite(candidate))
            .map((candidate) => clampNumber(candidate, minStartSec, maxStartSec))
        : [])
    ]
    let nearestSec = candidates[0]
    let nearestDiff = Math.abs(nearestSec - rawStartSec)
    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const diff = Math.abs(candidate - rawStartSec)
      if (diff < nearestDiff) {
        nearestSec = candidate
        nearestDiff = diff
      }
    }
    return nearestSec
  }

  const handleTrackDragMove = (event: MouseEvent) => {
    if (!trackDragState) return
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const deltaSec = (event.clientX - trackDragState.startClientX) / pxPerSec
    const rawStartSec = Math.max(0, trackDragState.initialStartSec + deltaSec)
    const dragBounds = resolveTrackDragBounds(trackDragState.snapshotTracks, trackDragState.trackId)
    const clampedRawStartSec = clampNumber(rawStartSec, dragBounds.minStart, dragBounds.maxStart)
    let nextStartSec = clampedRawStartSec
    const currentTrackForSnap = findTrack(trackDragState.trackId)
    const snapStepBeats = resolveVisibleGridSnapStepBeats()
    const previousTrack = findTrack(trackDragState.previousTrackId)
    let currentLocalGridSecs = currentTrackForSnap
      ? buildTrackVisibleLocalGridSecs(currentTrackForSnap)
      : []
    let previousTimelineGridSecs: number[] = []
    let snappedByPreviousTrack: number | null = null
    let snappedByFixedGrid: number | null = null
    let selectedVisibleGridPair: ReturnType<typeof resolveNearestVisibleGridPair> = null
    if (previousTrack) {
      const previousStartSec = resolveTrackStartSecById(previousTrack.id)
      previousTimelineGridSecs = isMixtapeGlobalTempoReady()
        ? buildGlobalTimelineGridSecs(trackDragState.snapshotTracks, {
            minSec: dragBounds.minStart,
            maxSec: clampNumber(
              clampedRawStartSec +
                resolveTrackDurationSeconds(currentTrackForSnap || previousTrack),
              dragBounds.minStart,
              Number.isFinite(dragBounds.maxStart)
                ? Math.max(dragBounds.minStart, dragBounds.maxStart)
                : clampedRawStartSec +
                    resolveTrackDurationSeconds(currentTrackForSnap || previousTrack)
            )
          })
        : buildTrackVisibleLocalGridSecs(previousTrack).map((sec) =>
            Number((previousStartSec + sec).toFixed(4))
          )
      if (currentTrackForSnap && isMixtapeGlobalTempoReady()) {
        const projectedSnap = resolveSnappedStartSecByProjectedGrid({
          track: currentTrackForSnap,
          rawStartSec: clampedRawStartSec,
          minStartSec: dragBounds.minStart,
          maxStartSec: dragBounds.maxStart,
          targetTimelineGridSecs: previousTimelineGridSecs,
          boundaryCandidates: [dragBounds.minStart]
        })
        currentLocalGridSecs = projectedSnap.currentLocalGridSecs
        selectedVisibleGridPair = resolveNearestVisibleGridPair({
          rawStartSec: clampedRawStartSec,
          minStartSec: dragBounds.minStart,
          maxStartSec: dragBounds.maxStart,
          currentLocalGridSecs,
          targetTimelineGridSecs: previousTimelineGridSecs
        })
        if (typeof projectedSnap.snappedStartSec === 'number') {
          snappedByPreviousTrack = projectedSnap.snappedStartSec
          nextStartSec = projectedSnap.snappedStartSec
        }
      } else {
        const snappedStartSec = resolveSnappedStartSecByVisibleGrid({
          rawStartSec: clampedRawStartSec,
          minStartSec: dragBounds.minStart,
          maxStartSec: dragBounds.maxStart,
          currentLocalGridSecs,
          targetTimelineGridSecs: previousTimelineGridSecs,
          boundaryCandidates: [dragBounds.minStart]
        })
        selectedVisibleGridPair = resolveNearestVisibleGridPair({
          rawStartSec: clampedRawStartSec,
          minStartSec: dragBounds.minStart,
          maxStartSec: dragBounds.maxStart,
          currentLocalGridSecs,
          targetTimelineGridSecs: previousTimelineGridSecs
        })
        if (typeof snappedStartSec === 'number') {
          snappedByPreviousTrack = snappedStartSec
          nextStartSec = snappedStartSec
        }
      }
    }
    if (currentTrackForSnap && isMixtapeGlobalTempoReady() && !previousTrack) {
      previousTimelineGridSecs = buildGlobalTimelineGridSecs(trackDragState.snapshotTracks, {
        minSec: dragBounds.minStart,
        maxSec: clampedRawStartSec + resolveTrackDurationSeconds(currentTrackForSnap)
      })
      const projectedSnap = resolveSnappedStartSecByProjectedGrid({
        track: currentTrackForSnap,
        rawStartSec: clampedRawStartSec,
        minStartSec: dragBounds.minStart,
        maxStartSec: dragBounds.maxStart,
        targetTimelineGridSecs: previousTimelineGridSecs,
        boundaryCandidates: [dragBounds.minStart]
      })
      currentLocalGridSecs = projectedSnap.currentLocalGridSecs
      selectedVisibleGridPair = resolveNearestVisibleGridPair({
        rawStartSec: clampedRawStartSec,
        minStartSec: dragBounds.minStart,
        maxStartSec: dragBounds.maxStart,
        currentLocalGridSecs,
        targetTimelineGridSecs: previousTimelineGridSecs
      })
      if (typeof projectedSnap.snappedStartSec === 'number') {
        snappedByPreviousTrack = projectedSnap.snappedStartSec
        nextStartSec = projectedSnap.snappedStartSec
      }
    }
    if (currentTrackForSnap && !isMixtapeGlobalTempoReady()) {
      const currentBpm = Number(currentTrackForSnap.bpm)
      if (Number.isFinite(currentBpm) && currentBpm > 0) {
        const beatSec = resolveBeatSecByBpm(currentBpm)
        const snapStepSec = beatSec * snapStepBeats
        const currentFirstBeatSec = resolveTrackFirstBeatSeconds(currentTrackForSnap, currentBpm)
        const currentAnchorRawSec = resolveGridAnchorSec({
          startSec: clampedRawStartSec,
          firstBeatSec: currentFirstBeatSec,
          beatSec,
          barBeatOffset: normalizeBeatOffset(currentTrackForSnap.barBeatOffset, 32)
        })
        const snappedStartSec = resolveSnappedStartSec({
          rawStartSec: clampedRawStartSec,
          minStartSec: dragBounds.minStart,
          maxStartSec: dragBounds.maxStart,
          snapAnchorSec: 0,
          currentAnchorRawSec,
          stepSec: snapStepSec,
          boundaryCandidates: [dragBounds.minStart]
        })
        if (typeof snappedStartSec === 'number') {
          snappedByFixedGrid = snappedStartSec
          nextStartSec = snappedStartSec
        }
      }
    }
    nextStartSec = clampNumber(nextStartSec, dragBounds.minStart, dragBounds.maxStart)
    trackDragState.lastDebug = {
      trackId: trackDragState.trackId,
      previousTrackId: trackDragState.previousTrackId,
      globalTempoReady: isMixtapeGlobalTempoReady(),
      currentTrackBpm: Number(currentTrackForSnap?.bpm) || 0,
      currentTrackOriginalBpm: Number(currentTrackForSnap?.originalBpm) || 0,
      currentTrackGridBaseBpm: Number(currentTrackForSnap?.gridBaseBpm) || 0,
      previousTrackBpm: Number(previousTrack?.bpm) || 0,
      previousTrackOriginalBpm: Number(previousTrack?.originalBpm) || 0,
      previousTrackGridBaseBpm: Number(previousTrack?.gridBaseBpm) || 0,
      rawStartSec,
      clampedRawStartSec,
      nextStartSec,
      dragBounds,
      snappedByPreviousTrack,
      snappedByFixedGrid,
      selectedVisibleGridPair,
      currentTimelineGridNeighborhood:
        selectedVisibleGridPair && currentLocalGridSecs.length
          ? resolveGridNeighborhood(
              currentLocalGridSecs.map((sec) => Number((nextStartSec + sec).toFixed(4))),
              selectedVisibleGridPair.targetTimelineSec
            )
          : [],
      previousTimelineGridNeighborhood:
        selectedVisibleGridPair && previousTimelineGridSecs.length
          ? resolveGridNeighborhood(
              previousTimelineGridSecs,
              selectedVisibleGridPair.targetTimelineSec
            )
          : [],
      currentLocalGridSample: summarizeGridSecs(currentLocalGridSecs),
      previousTimelineGridSample: summarizeGridSecs(previousTimelineGridSecs)
    }

    const targetIndex = tracks.value.findIndex(
      (item: MixtapeTrack) => item.id === trackDragState?.trackId
    )
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const currentStartSec = resolveTrackStartSecById(currentTrack.id)
    const shouldUpdateStart = Math.abs(nextStartSec - currentStartSec) > 0.0001
    if (!shouldUpdateStart) return
    const nextTrack: MixtapeTrack = {
      ...currentTrack,
      startSec: nextStartSec
    }
    const nextTracks = [...tracks.value]
    nextTracks.splice(targetIndex, 1, nextTrack)
    tracks.value = nextTracks
    event.preventDefault()
  }

  const handleTrackDragEnd = () => {
    if (!trackDragState) return
    const targetTrackId = trackDragState.trackId
    const previousTrack =
      trackDragState.snapshotTracks.find((item: MixtapeTrack) => item.id === targetTrackId) || null
    const currentTrack = findTrack(targetTrackId)
    const previousStartSec = normalizeStartSec(previousTrack?.startSec)
    const currentStartSec = normalizeStartSec(currentTrack?.startSec)
    isTrackDragging.value = false
    trackDragState = null
    window.removeEventListener('mousemove', handleTrackDragMove as EventListener)
    window.removeEventListener('mouseup', handleTrackDragEnd as EventListener)
    scheduleFullPreRender()
    scheduleWorkerPreRender()
    if (!currentTrack) return
    const startChanged =
      currentStartSec !== null &&
      (previousStartSec === null || Math.abs(previousStartSec - currentStartSec) > 0.0001)
    if (!startChanged) return
    void persistTrackStartSec([
      {
        itemId: targetTrackId,
        startSec: Number(currentStartSec)
      }
    ])
  }

  const handleTrackDragStart = (item: TimelineTrackLayout, event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    stopTransportForTrackChange()
    const trackId = item?.track?.id || ''
    if (!trackId) return
    const track = findTrack(trackId)
    if (!track) return
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    trackDragState = {
      trackId,
      startClientX: event.clientX,
      initialStartSec: Number.isFinite(Number(item.startSec))
        ? Number(item.startSec)
        : resolveTimelineSecByX(item.startX, pxPerSec),
      previousTrackId: resolvePreviousTrackId(trackId),
      snapshotTracks: tracks.value.map((trackItem: MixtapeTrack) => ({ ...trackItem })),
      lastDebug: null
    }
    isTrackDragging.value = true
    window.addEventListener('mousemove', handleTrackDragMove, { passive: false })
    window.addEventListener('mouseup', handleTrackDragEnd, { passive: true })
  }

  const cleanupTrackDrag = () => {
    isTrackDragging.value = false
    trackDragState = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', handleTrackDragMove as EventListener)
      window.removeEventListener('mouseup', handleTrackDragEnd as EventListener)
    }
  }

  return {
    isTrackDragging,
    handleTrackDragStart,
    cleanupTrackDrag
  }
}
