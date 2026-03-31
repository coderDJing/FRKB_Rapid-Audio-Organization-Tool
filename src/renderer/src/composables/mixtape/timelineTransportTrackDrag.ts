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
  mixtapeGlobalTempoEnvelope,
  mixtapeGlobalTempoPhaseOffsetSec
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import { resolveSnappedStartSecByVisibleGrid } from '@renderer/composables/mixtape/trackGridSnap'
import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import {
  BPM_POINT_SEC_EPSILON,
  roundTrackTempoSec,
  resolveTrackGridSourceBpm
} from '@renderer/composables/mixtape/trackTempoModel'
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
    options?: { minSec?: number; maxSec?: number; fullDetail?: boolean }
  ) => {
    if (!isMixtapeGlobalTempoReady()) return [] as number[]
    const fallbackBpm =
      Number(mixtapeGlobalTempoEnvelope.value[0]?.bpm) ||
      snapshotTracks.find((track) => Number(track.bpm) > 0)?.bpm ||
      128
    const grid = createMixtapeMasterGrid({
      points: mixtapeGlobalTempoEnvelope.value,
      phaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value,
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
      .buildVisibleGridLines(
        options?.fullDetail ? Number.POSITIVE_INFINITY : Number(normalizedRenderZoom.value) || 0,
        {
          minSec: Math.max(0, (Number(options?.minSec) || 0) - beatBufferSec),
          maxSec: Math.max(0, maxSec + beatBufferSec)
        }
      )
      .map((line) => Number(line.sec.toFixed(4)))
  }

  const buildTrackVisibleLocalGridSecs = (
    track: MixtapeTrack,
    options?: { startSec?: number; fullDetail?: boolean }
  ) => {
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
      zoom: options?.fullDetail ? Number.POSITIVE_INFINITY : Number(normalizedRenderZoom.value) || 0
    }).visibleGridLines
    return lines.map((line) => Number(line.sec.toFixed(4)))
  }

  const resolveStrictVisibleGridSnappedStartSec = (payload: {
    track: MixtapeTrack
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    snapshotTracks: MixtapeTrack[]
  }) => {
    if (!isMixtapeGlobalTempoReady()) return null
    const intervalBeats = resolveVisibleGridSnapStepBeats()
    if (![1, 4, 32].includes(intervalBeats)) return null
    const gridSourceBpm = resolveTrackGridSourceBpm(payload.track)
    const beatSourceSec = resolveBeatSecByBpm(gridSourceBpm)
    if (!Number.isFinite(beatSourceSec) || beatSourceSec <= BPM_POINT_SEC_EPSILON) return null
    const sourceDurationSec = Math.max(
      0,
      Number(resolveTrackSourceDurationSeconds(payload.track)) || 0
    )
    const sourceDurationBeats = sourceDurationSec / beatSourceSec
    const firstBeatSourceSec = Math.max(0, Number(payload.track.firstBeatMs) || 0) / 1000
    const firstBeatSourceBeats = firstBeatSourceSec / beatSourceSec
    const barBeatOffset = normalizeBeatOffset(payload.track.barBeatOffset, 32)
    let phaseOffsetBeats = firstBeatSourceBeats
    let hasVisibleFamily = true
    if (intervalBeats === 32) {
      phaseOffsetBeats = firstBeatSourceBeats + barBeatOffset
      hasVisibleFamily = phaseOffsetBeats <= sourceDurationBeats + BPM_POINT_SEC_EPSILON
    } else if (intervalBeats === 4) {
      phaseOffsetBeats = firstBeatSourceBeats + (barBeatOffset % 4)
      hasVisibleFamily = phaseOffsetBeats <= sourceDurationBeats + BPM_POINT_SEC_EPSILON
    }
    if (!hasVisibleFamily) return null
    const fallbackBpm =
      Number(mixtapeGlobalTempoEnvelope.value[0]?.bpm) ||
      payload.snapshotTracks.find((track) => Number(track.bpm) > 0)?.bpm ||
      128
    const masterGrid = createMixtapeMasterGrid({
      points: mixtapeGlobalTempoEnvelope.value,
      phaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value,
      fallbackBpm
    })
    const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
    const minStartSec = Math.max(0, Number(payload.minStartSec) || 0)
    const maxStartSec = Number.isFinite(Number(payload.maxStartSec))
      ? Math.max(minStartSec, Number(payload.maxStartSec))
      : Number.POSITIVE_INFINITY
    const rawStartBeat = masterGrid.mapSecToBeats(rawStartSec)
    const minStartBeat = masterGrid.mapSecToBeats(minStartSec)
    const maxStartBeat = Number.isFinite(maxStartSec)
      ? masterGrid.mapSecToBeats(maxStartSec)
      : Number.POSITIVE_INFINITY
    const minFamilyIndex = Math.ceil(
      (minStartBeat + phaseOffsetBeats - BPM_POINT_SEC_EPSILON) / intervalBeats
    )
    const maxFamilyIndex = Number.isFinite(maxStartBeat)
      ? Math.floor((maxStartBeat + phaseOffsetBeats + BPM_POINT_SEC_EPSILON) / intervalBeats)
      : Number.POSITIVE_INFINITY
    if (minFamilyIndex > maxFamilyIndex) return null
    const approxFamilyIndex = Math.round((rawStartBeat + phaseOffsetBeats) / intervalBeats)
    const boundedFamilyIndex = Number.isFinite(maxFamilyIndex)
      ? clampNumber(approxFamilyIndex, minFamilyIndex, maxFamilyIndex)
      : Math.max(minFamilyIndex, approxFamilyIndex)
    const familyCandidates = new Set<number>([boundedFamilyIndex])
    if (boundedFamilyIndex - 1 >= minFamilyIndex) familyCandidates.add(boundedFamilyIndex - 1)
    if (!Number.isFinite(maxFamilyIndex) || boundedFamilyIndex + 1 <= maxFamilyIndex) {
      familyCandidates.add(boundedFamilyIndex + 1)
    }
    if (Number.isFinite(maxFamilyIndex)) {
      familyCandidates.add(minFamilyIndex)
      familyCandidates.add(maxFamilyIndex)
    }
    let bestStartSec: number | null = null
    let bestDiffSec = Number.POSITIVE_INFINITY
    for (const familyIndex of familyCandidates) {
      if (familyIndex < minFamilyIndex) continue
      if (Number.isFinite(maxFamilyIndex) && familyIndex > maxFamilyIndex) continue
      const startBeat = familyIndex * intervalBeats - phaseOffsetBeats
      if (!Number.isFinite(startBeat)) continue
      const candidateStartSec = roundTrackTempoSec(masterGrid.mapBeatsToSec(startBeat))
      if (candidateStartSec < minStartSec - BPM_POINT_SEC_EPSILON) continue
      if (Number.isFinite(maxStartSec) && candidateStartSec > maxStartSec + BPM_POINT_SEC_EPSILON) {
        continue
      }
      const diffSec = Math.abs(candidateStartSec - rawStartSec)
      if (diffSec < bestDiffSec - BPM_POINT_SEC_EPSILON) {
        bestStartSec = candidateStartSec
        bestDiffSec = diffSec
      }
    }
    return bestStartSec
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
        const strictSnappedStartSec = resolveStrictVisibleGridSnappedStartSec({
          track: currentTrackForSnap,
          rawStartSec: clampedRawStartSec,
          minStartSec: dragBounds.minStart,
          maxStartSec: dragBounds.maxStart,
          snapshotTracks: trackDragState.snapshotTracks
        })
        const projectedSnap =
          typeof strictSnappedStartSec === 'number'
            ? {
                snappedStartSec: strictSnappedStartSec,
                currentLocalGridSecs: buildTrackVisibleLocalGridSecs(currentTrackForSnap, {
                  startSec: strictSnappedStartSec
                }),
                candidateStartSec: strictSnappedStartSec
              }
            : resolveSnappedStartSecByProjectedGrid({
                track: currentTrackForSnap,
                rawStartSec: clampedRawStartSec,
                minStartSec: dragBounds.minStart,
                maxStartSec: dragBounds.maxStart,
                targetTimelineGridSecs: previousTimelineGridSecs,
                boundaryCandidates: [dragBounds.minStart]
              })
        currentLocalGridSecs = projectedSnap.currentLocalGridSecs
        if (typeof projectedSnap.snappedStartSec === 'number') {
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
        if (typeof snappedStartSec === 'number') {
          nextStartSec = snappedStartSec
        }
      }
    }
    if (currentTrackForSnap && isMixtapeGlobalTempoReady() && !previousTrack) {
      previousTimelineGridSecs = buildGlobalTimelineGridSecs(trackDragState.snapshotTracks, {
        minSec: dragBounds.minStart,
        maxSec: clampedRawStartSec + resolveTrackDurationSeconds(currentTrackForSnap)
      })
      const strictSnappedStartSec = resolveStrictVisibleGridSnappedStartSec({
        track: currentTrackForSnap,
        rawStartSec: clampedRawStartSec,
        minStartSec: dragBounds.minStart,
        maxStartSec: dragBounds.maxStart,
        snapshotTracks: trackDragState.snapshotTracks
      })
      const projectedSnap =
        typeof strictSnappedStartSec === 'number'
          ? {
              snappedStartSec: strictSnappedStartSec,
              currentLocalGridSecs: buildTrackVisibleLocalGridSecs(currentTrackForSnap, {
                startSec: strictSnappedStartSec
              }),
              candidateStartSec: strictSnappedStartSec
            }
          : resolveSnappedStartSecByProjectedGrid({
              track: currentTrackForSnap,
              rawStartSec: clampedRawStartSec,
              minStartSec: dragBounds.minStart,
              maxStartSec: dragBounds.maxStart,
              targetTimelineGridSecs: previousTimelineGridSecs,
              boundaryCandidates: [dragBounds.minStart]
            })
      currentLocalGridSecs = projectedSnap.currentLocalGridSecs
      if (typeof projectedSnap.snappedStartSec === 'number') {
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
          nextStartSec = snappedStartSec
        }
      }
    }
    nextStartSec = clampNumber(nextStartSec, dragBounds.minStart, dragBounds.maxStart)

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
      snapshotTracks: tracks.value.map((trackItem: MixtapeTrack) => ({ ...trackItem }))
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
